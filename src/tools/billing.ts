import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveAccount } from "@/services/accounts";
import * as billing from "@/services/billing";
import {
  COLLECTION_LIMIT,
  collectionEnvelope,
  DEFAULT_COLLECTION_LIMIT,
} from "@/utils/collection";
import { defineRead } from "@/utils/define-read";

/**
 * Customer Billing tools.
 *
 * This service is absent from every other Microsoft Advertising MCP server,
 * so these answer questions nothing else can: what was actually billed, what
 * spending agreements exist, and where the invoices are.
 */
export function registerBillingTools(server: McpServer): void {
  defineRead(server, {
    name: "get_monthly_spend",
    title: "Monthly account spend",
    uriTemplate: "msads://account/{accountId}/spend",
    uriVars: { accountId: "account_id" },
    priority: 0.75,
    description:
      "Actual billed spend for an ad account in a given calendar month, in the account's currency.\n\n" +
      "This is the billing system's number, not the reporting system's. It can differ from report Spend: " +
      "reports show delivery, billing shows what was charged after invalid-traffic credits and adjustments. " +
      "Use this one for finance questions and reports for performance questions.",
    inputSchema: {
      account_id: z
        .string()
        .optional()
        .describe("Ad account id. Defaults to MSADS_ACCOUNT_ID."),
      year: z.number().int().min(2000).max(2100).describe("Calendar year."),
      month: z.number().int().min(1).max(12).describe("Calendar month, 1–12."),
    },
    handler: async (args) => {
      const year = Number(args.year);
      const month = Number(args.month);
      const scope = await resolveAccount({
        accountId: args.account_id as string | undefined,
      });
      const spend = await billing.getAccountMonthlySpend(scope.accountId, year, month);
      return {
        account_id: scope.accountId,
        year,
        month,
        amount: spend.Amount,
        currency: spend.CurrencyCode,
      };
    },
  });

  defineRead(server, {
    name: "list_insertion_orders",
    title: "Insertion orders",
    priority: 0.6,
    description:
      "Insertion orders on an account — the prepaid or invoiced spending agreements that cap and fund delivery, " +
      "with their budget, balance, and start/end dates.\n\n" +
      "Worth checking when campaigns stop delivering for no apparent reason: an exhausted or expired insertion order halts spend regardless of campaign budgets.",
    inputSchema: {
      account_id: z
        .string()
        .optional()
        .describe("Ad account id. Defaults to MSADS_ACCOUNT_ID."),
      page_index: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Zero-based page. Default 0."),
      page_size: z
        .number()
        .int()
        .min(1)
        .max(billing.INSERTION_ORDER_PAGE_MAX)
        .optional()
        .describe("Default and maximum 100 — Customer Billing rejects more."),
    },
    handler: async (args) => {
      const scope = await resolveAccount({
        accountId: args.account_id as string | undefined,
      });
      const pageIndex = Number(args.page_index ?? 0);
      const pageSize = Number(args.page_size ?? billing.INSERTION_ORDER_PAGE_MAX);
      const orders = await billing.searchInsertionOrders(
        [{ Field: "AccountId", Operator: "Equals", Value: scope.accountId }],
        pageIndex,
        pageSize,
      );
      return {
        account_id: scope.accountId,
        page_index: pageIndex,
        ...collectionEnvelope("insertion_orders", orders, {
          limit: pageSize,
          truncated: orders.length === pageSize,
          guidance: `Request page_index ${pageIndex + 1} to continue.`,
        }),
      };
    },
  });

  defineRead(server, {
    name: "list_billing_documents",
    title: "Billing documents",
    priority: 0.55,
    description:
      "Invoice metadata for one or more accounts over a date range — document ids, amounts, and dates. " +
      "Use the returned ids to locate the actual invoices in the Microsoft Advertising UI.",
    inputSchema: {
      account_ids: z
        .array(z.string())
        .max(1000)
        .optional()
        .describe("Ad account ids. Defaults to MSADS_ACCOUNT_ID."),
      start_date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .describe("YYYY-MM-DD."),
      end_date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .describe("YYYY-MM-DD."),
      limit: COLLECTION_LIMIT,
    },
    handler: async (args) => {
      const accountIds = Array.isArray(args.account_ids)
        ? args.account_ids.map(String)
        : [(await resolveAccount({})).accountId];
      const docs = await billing.getBillingDocumentsInfo(
        accountIds,
        String(args.start_date),
        String(args.end_date),
      );
      return {
        account_ids: accountIds,
        ...collectionEnvelope("billing_documents", docs, {
          limit: Number(args.limit ?? DEFAULT_COLLECTION_LIMIT),
        }),
      };
    },
  });
}
