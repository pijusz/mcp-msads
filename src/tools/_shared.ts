import { z } from "zod";
import { resolveAccount } from "@/services/accounts";

/**
 * Shared pieces every account-scoped tool file needs.
 *
 * Centralized because eight copies had already drifted — two described
 * `customer_id` differently from the other six, and two files hand-rolled the
 * same two arguments instead of reusing them. A constant and a one-line
 * function hide nothing, so this costs no readability.
 */

/** Prefix on every mutation description, so clients render the prompt clearly. */
export const WRITE = "⚠️ WRITE OPERATION — ";

/**
 * Account arguments exposed on tool schemas.
 *
 * `customer_id` is deliberately NOT here. It appeared in 64 of 74 schemas
 * purely to say "resolved automatically", where setting it wrong is the main
 * cause of error 106 — the exact failure `resolveAccount` exists to prevent.
 * It remains settable via MSADS_CUSTOMER_ID and on the raw escape-hatch tools.
 */
export const ACCOUNT_ARGS = {
  account_id: z
    .string()
    .optional()
    .describe("Ad account id. Defaults to MSADS_ACCOUNT_ID."),
};

/** Resolve the account/customer pair every account-scoped call needs. */
export function ids(args: {
  account_id?: unknown;
  customer_id?: unknown;
}): ReturnType<typeof resolveAccount> {
  return resolveAccount({
    accountId: args.account_id as string | undefined,
    customerId: args.customer_id as string | undefined,
  });
}
