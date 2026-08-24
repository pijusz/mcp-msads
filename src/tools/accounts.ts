import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  findAccountsOrCustomers,
  getAccountsInfo,
  getUser,
  searchAccounts,
} from "@/services/accounts";
import {
  COLLECTION_LIMIT,
  collectionEnvelope,
  DEFAULT_COLLECTION_LIMIT,
  MAX_COLLECTION_LIMIT,
} from "@/utils/collection";
import { defineRead } from "@/utils/define-read";

export function registerAccountTools(server: McpServer): void {
  defineRead(server, {
    name: "list_accounts",
    title: "Microsoft Advertising accounts",
    uriTemplate: "msads://accounts",
    priority: 0.95,
    description:
      "List every Microsoft Advertising ad account this login can reach, each paired with the manager (customer) account that owns it. " +
      "Start here: almost every other tool needs an account_id, and the account_id/customer_id pairing is what makes calls succeed. " +
      "Note the numeric `Id` is the API identifier; `Number` (e.g. X1234567) is display-only and is never accepted by the API. " +
      "Optional `filter` does a prefix match on account name, account number, or customer name.",
    inputSchema: {
      filter: z
        .string()
        .optional()
        .describe("Prefix match on account name / number / customer name."),
      limit: COLLECTION_LIMIT,
    },
    handler: async (args) => {
      const filter = typeof args.filter === "string" ? args.filter : "";
      const limit = Number(args.limit ?? DEFAULT_COLLECTION_LIMIT);
      const accounts = await findAccountsOrCustomers(
        filter,
        Math.min(limit + 1, MAX_COLLECTION_LIMIT),
      );
      return collectionEnvelope(
        "accounts",
        accounts.map((a) => ({
          account_id: String(a.Id),
          account_name: a.Name,
          account_number: a.Number,
          customer_id: a.CustomerId ? String(a.CustomerId) : undefined,
          customer_name: a.CustomerName,
          status: a.AccountLifeCycleStatus,
          ...(a.PauseReason ? { pause_reason: a.PauseReason } : {}),
        })),
        {
          limit,
          // The API itself caps this search at 5,000, so a full page cannot
          // prove that no additional accounts exist.
          truncated: accounts.length > limit || accounts.length === MAX_COLLECTION_LIMIT,
          guidance: "Tighten filter to a more specific account or customer prefix.",
        },
      );
    },
  });

  defineRead(server, {
    name: "get_current_user",
    title: "Authenticated user",
    uriTemplate: "msads://user",
    priority: 0.7,
    description:
      "Identity of the authenticated Microsoft Advertising user, including the customer roles and account ids they can access. " +
      "Useful for confirming which credentials are in play and what they can reach.",
    inputSchema: { limit: COLLECTION_LIMIT },
    handler: async (args) => {
      const user = await getUser();
      return {
        user_id: String(user.Id),
        user_name: user.UserName,
        name: [user.Name?.FirstName, user.Name?.LastName].filter(Boolean).join(" "),
        email: user.ContactInfo?.Email,
        ...collectionEnvelope(
          "customer_roles",
          (user.CustomerRoles ?? []).map((r) => ({
            customer_id: r.CustomerId ? String(r.CustomerId) : undefined,
            role_id: r.RoleId,
            ...(r.AccountIds
              ? {
                  account_ids: r.AccountIds.slice(0, MAX_COLLECTION_LIMIT).map(String),
                  account_ids_showing: Math.min(
                    r.AccountIds.length,
                    MAX_COLLECTION_LIMIT,
                  ),
                  account_ids_truncated: r.AccountIds.length > MAX_COLLECTION_LIMIT,
                }
              : {}),
            ...(r.LinkedAccountIds
              ? {
                  linked_account_ids: r.LinkedAccountIds.slice(
                    0,
                    MAX_COLLECTION_LIMIT,
                  ).map(String),
                  linked_account_ids_showing: Math.min(
                    r.LinkedAccountIds.length,
                    MAX_COLLECTION_LIMIT,
                  ),
                  linked_account_ids_truncated:
                    r.LinkedAccountIds.length > MAX_COLLECTION_LIMIT,
                }
              : {}),
          })),
          { limit: Number(args.limit ?? DEFAULT_COLLECTION_LIMIT) },
        ),
      };
    },
  });

  defineRead(server, {
    name: "get_account_hierarchy",
    title: "Account hierarchy",
    uriTemplate: "msads://customer/{customerId}/accounts",
    uriVars: { customerId: "customer_id" },
    priority: 0.8,
    description:
      "Accounts under one manager (customer) account. Lighter than list_accounts when you already know the customer_id. " +
      "Set only_parent_accounts to list just the top level of a nested hierarchy.",
    inputSchema: {
      customer_id: z
        .string()
        .optional()
        .describe("Manager account id. Defaults to MSADS_CUSTOMER_ID."),
      only_parent_accounts: z.boolean().optional(),
      limit: COLLECTION_LIMIT,
    },
    handler: async (args) => {
      const accounts = await getAccountsInfo(
        args.customer_id ? String(args.customer_id) : undefined,
        args.only_parent_accounts === true,
      );
      return collectionEnvelope(
        "accounts",
        accounts.map((a) => ({
          account_id: String(a.Id),
          account_name: a.Name,
          account_number: a.Number,
          status: a.AccountLifeCycleStatus,
        })),
        { limit: Number(args.limit ?? DEFAULT_COLLECTION_LIMIT) },
      );
    },
  });

  defineRead(server, {
    name: "get_account",
    title: "Account details",
    uriTemplate: "msads://account/{accountId}",
    uriVars: { accountId: "account_id" },
    priority: 0.8,
    description:
      "Full detail for one ad account — currency, time zone, language, account mode, financial status, and the parent customer id. " +
      "Currency matters when reading spend from reports: all monetary report values are in the account's own currency.",
    inputSchema: {
      account_id: z.string().describe("Numeric ad account id."),
    },
    handler: async (args) => {
      const id = String(args.account_id);
      const accounts = await searchAccounts([
        { Field: "AccountId", Operator: "Equals", Value: id },
      ]);
      const account = accounts[0];
      if (!account) {
        return {
          found: false,
          account_id: id,
          hint: "This account is not reachable by the signed-in user. Run list_accounts to see which are. A mismatched account/customer pair is the usual cause of error 106.",
        };
      }
      return {
        found: true,
        account_id: String(account.Id),
        account_name: account.Name,
        account_number: account.Number,
        customer_id: account.ParentCustomerId
          ? String(account.ParentCustomerId)
          : undefined,
        currency: account.CurrencyCode,
        time_zone: account.TimeZone,
        language: account.Language,
        account_mode: account.AccountMode,
        status: account.AccountLifeCycleStatus,
        financial_status: account.AccountFinancialStatus,
      };
    },
  });
}
