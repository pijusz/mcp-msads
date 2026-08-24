import { describe, expect, test } from "bun:test";
import { normalizeAccountWithCustomer } from "@/services/accounts";

/**
 * The shape of a live FindAccountsOrCustomersInfo response, with the
 * identifiers replaced by synthetic ones.
 *
 * The API returns two different shapes for the same concept and the field
 * names do not overlap: GetAccountsInfo gives Id/Name/Number, while this
 * operation gives AccountId/AccountName/AccountNumber. Conflating them yields
 * `undefined` ids with no error anywhere — the account simply cannot be found.
 */
const LIVE_RESPONSE = {
  CustomerId: "987654321",
  CustomerName: "Example Customer",
  AccountId: "123456789",
  AccountName: "Example Account",
  AccountNumber: "X00000X0",
  AccountLifeCycleStatus: "Pending",
  PauseReason: null,
};

describe("normalizeAccountWithCustomer", () => {
  test("maps the live response onto the normalized shape", () => {
    expect(normalizeAccountWithCustomer(LIVE_RESPONSE)).toEqual({
      Id: "123456789",
      Name: "Example Account",
      Number: "X00000X0",
      CustomerId: "987654321",
      CustomerName: "Example Customer",
      AccountLifeCycleStatus: "Pending",
    });
  });

  test("puts the account id in Id, which is what lookups match on", () => {
    // The regression this guards: reading `Id` off the raw response gives
    // undefined, so resolveAccount finds nothing and every account-scoped
    // call goes out without a CustomerId header.
    expect(normalizeAccountWithCustomer(LIVE_RESPONSE).Id).toBe("123456789");
  });

  test("keeps the account number distinct from the account id", () => {
    // The account number is display-only; the API never accepts it.
    const n = normalizeAccountWithCustomer(LIVE_RESPONSE);
    expect(n.Number).toBe("X00000X0");
    expect(n.Id).not.toBe(n.Number);
  });

  test("drops a null PauseReason rather than surfacing it", () => {
    expect(normalizeAccountWithCustomer(LIVE_RESPONSE)).not.toHaveProperty("PauseReason");
  });

  test("keeps a real PauseReason", () => {
    expect(
      normalizeAccountWithCustomer({ ...LIVE_RESPONSE, PauseReason: "CreditCardExpired" })
        .PauseReason,
    ).toBe("CreditCardExpired");
  });

  test("coerces ids to strings, since they are 64-bit on the wire", () => {
    const n = normalizeAccountWithCustomer({
      AccountId: 123456789 as unknown as string,
      CustomerId: 987654321 as unknown as string,
    });
    expect(n.Id).toBe("123456789");
    expect(n.CustomerId).toBe("987654321");
  });

  test("survives a response missing every optional field", () => {
    expect(normalizeAccountWithCustomer({ AccountId: "1" })).toEqual({ Id: "1" });
  });
});
