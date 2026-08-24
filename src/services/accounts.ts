import { getEnv } from "@/config/env";
import { cached, tokenKey } from "@/services/cache";
import { msadsFetch } from "@/services/msads-api";
import { MsAdsError } from "@/utils/errors";

/**
 * Customer Management: identity and the account hierarchy.
 *
 * Every account-scoped call needs a `CustomerId` (manager account) and a
 * `CustomerAccountId` (ad account) pair. Getting that pair wrong is the single
 * most common cause of error 106, because the API cannot tell you *which* of
 * the two was wrong. This module discovers the real pairs once and lets the
 * rest of the server resolve a bare account id into the correct pair.
 *
 * Note this service must NOT receive the CustomerId / CustomerAccountId
 * headers — `msads-api.ts` enforces that per service.
 */

/** Hierarchy changes rarely; a 10-minute TTL keeps startup cheap. */
const HIERARCHY_TTL_MS = 10 * 60_000;

export interface User {
  Id: string;
  Name?: { FirstName?: string; LastName?: string };
  UserName?: string;
  ContactInfo?: { Email?: string };
  CustomerRoles?: Array<{
    RoleId?: number;
    CustomerId?: string;
    AccountIds?: string[];
    LinkedAccountIds?: string[];
  }>;
}

/**
 * Normalized account summary.
 *
 * The API returns two DIFFERENT shapes for what is conceptually the same
 * record, and the field names do not overlap:
 *
 *   GetAccountsInfo             -> AccountInfo:                Id, Name, Number
 *   FindAccountsOrCustomersInfo -> AccountInfoWithCustomerData: AccountId,
 *                                  AccountName, AccountNumber, CustomerId
 *
 * Treating them as one shape silently yields `undefined` ids, so both are
 * normalized to this at the boundary.
 */
export interface AccountInfo {
  Id: string;
  Name?: string;
  /** Display-only identifier shown in the web UI. Never valid in a request. */
  Number?: string;
  AccountLifeCycleStatus?: string;
  PauseReason?: string;
  CustomerId?: string;
  CustomerName?: string;
}

/** Raw shape returned by FindAccountsOrCustomersInfo. */
interface AccountInfoWithCustomerData {
  AccountId?: string;
  AccountName?: string;
  AccountNumber?: string;
  CustomerId?: string;
  CustomerName?: string;
  AccountLifeCycleStatus?: string;
  PauseReason?: string | null;
}

export function normalizeAccountWithCustomer(
  raw: AccountInfoWithCustomerData,
): AccountInfo {
  return {
    Id: String(raw.AccountId ?? ""),
    ...(raw.AccountName !== undefined ? { Name: raw.AccountName } : {}),
    ...(raw.AccountNumber !== undefined ? { Number: raw.AccountNumber } : {}),
    ...(raw.CustomerId !== undefined ? { CustomerId: String(raw.CustomerId) } : {}),
    ...(raw.CustomerName !== undefined ? { CustomerName: raw.CustomerName } : {}),
    ...(raw.AccountLifeCycleStatus !== undefined
      ? { AccountLifeCycleStatus: raw.AccountLifeCycleStatus }
      : {}),
    ...(raw.PauseReason ? { PauseReason: raw.PauseReason } : {}),
  };
}

export interface AdvertiserAccount extends AccountInfo {
  ParentCustomerId?: string;
  CurrencyCode?: string;
  TimeZone?: string;
  Language?: string;
  AccountMode?: string;
  AccountFinancialStatus?: string;
}

/** `GetUser` with a null id returns the authenticated user. */
export async function getUser(userId?: string): Promise<User> {
  const res = await msadsFetch<{ User?: User }>("CustomerManagement", "User/Query", {
    body: { UserId: userId ?? null },
    retry: "safe",
  });
  if (!res.User) {
    throw new MsAdsError({ message: "GetUser returned no user." });
  }
  return res.User;
}

/**
 * `FindAccountsOrCustomersInfo` — the best discovery primitive in the API.
 * An empty filter returns every account the user can reach *with* its owning
 * customer id, which is exactly the pairing we need, in one call.
 */
export async function findAccountsOrCustomers(
  filter = "",
  topN = 5000,
): Promise<AccountInfo[]> {
  const res = await msadsFetch<{
    AccountInfoWithCustomerData?: AccountInfoWithCustomerData[];
  }>("CustomerManagement", "AccountsOrCustomersInfo/Find", {
    body: { Filter: filter, TopN: Math.min(Math.max(topN, 1), 5000) },
    retry: "safe",
  });
  return (res.AccountInfoWithCustomerData ?? []).map(normalizeAccountWithCustomer);
}

/** `GetAccountsInfo` — lighter, but only within one customer. */
export async function getAccountsInfo(
  customerId?: string,
  onlyParentAccounts = false,
): Promise<AccountInfo[]> {
  const res = await msadsFetch<{ AccountsInfo?: AccountInfo[] }>(
    "CustomerManagement",
    "AccountsInfo/Query",
    {
      body: { CustomerId: customerId ?? null, OnlyParentAccounts: onlyParentAccounts },
      retry: "safe",
    },
  );
  return res.AccountsInfo ?? [];
}

export interface AccountPredicate {
  Field: string;
  Operator: string;
  Value: string;
}

/** `SearchAccounts` — full account objects, one predicate required. */
export async function searchAccounts(
  predicates: AccountPredicate[],
  pageIndex = 0,
  pageSize = 100,
): Promise<AdvertiserAccount[]> {
  const res = await msadsFetch<{ Accounts?: AdvertiserAccount[] }>(
    "CustomerManagement",
    "Accounts/Search",
    {
      body: {
        Predicates: predicates,
        PageInfo: { Index: pageIndex, Size: Math.min(pageSize, 1000) },
      },
      retry: "safe",
    },
  );
  return res.Accounts ?? [];
}

/** Every reachable {account, customer} pair, memoized per credential. */
export async function accountDirectory(): Promise<AccountInfo[]> {
  const env = getEnv();
  const key = tokenKey(
    `${env.MSADS_REFRESH_TOKEN}:${env.MSADS_ENVIRONMENT}`,
    "account-directory",
  );
  return cached(key, HIERARCHY_TTL_MS, () => findAccountsOrCustomers());
}

export interface ResolvedAccount {
  accountId: string;
  customerId?: string;
  accountName?: string;
}

/**
 * Turn whatever the caller supplied into the id pair the API headers need.
 *
 * Resolution order:
 *   1. Both explicitly given — trust them, no API call.
 *   2. Account id given, customer id missing — look the customer up. This is
 *      the case that otherwise produces a mystifying 106.
 *   3. Neither given — fall back to the configured defaults.
 *
 * A lookup failure is not fatal: we return the account id alone and let the
 * API decide, so a transient Customer Management outage cannot block every
 * other tool.
 */
export async function resolveAccount(args: {
  accountId?: string | undefined;
  customerId?: string | undefined;
  /** Tolerated so tool handlers can pass their raw args object. */
  account_id?: unknown;
  customer_id?: unknown;
}): Promise<ResolvedAccount> {
  args = {
    accountId: args.accountId ?? (args.account_id as string | undefined),
    customerId: args.customerId ?? (args.customer_id as string | undefined),
  };
  const env = getEnv();
  const accountId = String(args.accountId ?? env.MSADS_ACCOUNT_ID ?? "").trim();
  const customerId = String(args.customerId ?? env.MSADS_CUSTOMER_ID ?? "").trim();

  if (!accountId) {
    throw new MsAdsError({
      message:
        "No ad account specified. Pass account_id, or set MSADS_ACCOUNT_ID. " +
        "Use the list_accounts tool to see the accounts this login can reach.",
    });
  }
  if (/^[A-Za-z]/.test(accountId)) {
    throw new MsAdsError({
      message:
        `"${accountId}" looks like an account *number* (the identifier shown in the ` +
        "Microsoft Advertising UI). The API needs the numeric account id — run list_accounts to find it.",
    });
  }

  if (customerId) return { accountId, customerId };

  try {
    const directory = await accountDirectory();
    const match = directory.find((a) => String(a.Id) === accountId);
    if (match?.CustomerId) {
      return {
        accountId,
        customerId: String(match.CustomerId),
        ...(match.Name !== undefined ? { accountName: match.Name } : {}),
      };
    }
  } catch {
    // Fall through — better to attempt the call than to fail closed.
  }
  return { accountId };
}
