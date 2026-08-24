import { msadsFetch } from "@/services/msads-api";
import { MsAdsError } from "@/utils/errors";

/**
 * Customer Billing — invoices, insertion orders, and monthly spend.
 *
 * No existing Microsoft Advertising MCP server implements any of this, the
 * official one included. It is the difference between "how did the campaign
 * perform" and "what are we actually being billed", which is the question an
 * agency or finance workflow starts from.
 *
 * Like Customer Management, this service must NOT receive the CustomerId /
 * CustomerAccountId headers.
 */

export interface MonthlySpend {
  Amount?: number;
  CurrencyCode?: string;
}

/**
 * Spend for one calendar month. `monthYear` must be the first day of the
 * month; the API ignores the day component but rejects a malformed date.
 */
export async function getAccountMonthlySpend(
  accountId: string,
  year: number,
  month: number,
): Promise<MonthlySpend> {
  // MonthYear is a dateTime, so it takes an ISO STRING — not the { Day, Month,
  // Year } object used by ReportTime. Microsoft splits these by XSD type:
  // `Date` fields take the object, `dateTime` fields take a string. Sending the
  // object here is rejected as "Invalid JSON ... Path: $.MonthYear".
  const iso = `${year}-${String(month).padStart(2, "0")}-01T00:00:00`;
  const res = await msadsFetch<{ AccountMonthlySpend?: MonthlySpend; Amount?: number }>(
    "CustomerBilling",
    "AccountMonthlySpend/Query",
    { body: { AccountId: accountId, MonthYear: iso }, retry: "safe" },
  );
  // The response is sometimes flattened to a bare { Amount } rather than nested.
  return (
    res.AccountMonthlySpend ?? (res.Amount !== undefined ? { Amount: res.Amount } : {})
  );
}

export interface BillingPredicate {
  Field: string;
  Operator: string;
  Value: string;
}

/**
 * Customer Billing rejects PageInfo.Size above 100 with error 3032, unlike
 * Campaign Management's 1000. Verified by bisection against the live API on
 * 2026-08-21; Microsoft documents no limit at all.
 */
export const INSERTION_ORDER_PAGE_MAX = 100;

/** Insertion orders — the prepaid/invoiced spending agreements on an account. */
export async function searchInsertionOrders(
  predicates: BillingPredicate[],
  pageIndex = 0,
  pageSize = INSERTION_ORDER_PAGE_MAX,
): Promise<Record<string, unknown>[]> {
  const res = await msadsFetch<{ InsertionOrders?: Record<string, unknown>[] }>(
    "CustomerBilling",
    "InsertionOrders/Search",
    {
      body: {
        Predicates: predicates,
        PageInfo: {
          Index: pageIndex,
          Size: Math.min(pageSize, INSERTION_ORDER_PAGE_MAX),
        },
      },
      retry: "safe",
    },
  );
  return res.InsertionOrders ?? [];
}

/** Convert a validated calendar date to Customer Billing's UTC dateTime form. */
export function toBillingDateTime(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new MsAdsError({ message: `Invalid date "${value}". Expected YYYY-MM-DD.` });
  }
  const instant = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(instant.getTime()) || instant.toISOString().slice(0, 10) !== value) {
    throw new MsAdsError({
      message: `Invalid date "${value}". It is not a real calendar date.`,
    });
  }
  return `${value}T00:00:00Z`;
}

/** Invoice metadata for a date range. */
export async function getBillingDocumentsInfo(
  accountIds: string[],
  startDate: string,
  endDate: string,
): Promise<Record<string, unknown>[]> {
  const startDateTime = toBillingDateTime(startDate);
  const endDateTime = toBillingDateTime(endDate);
  if (startDateTime > endDateTime) {
    throw new MsAdsError({
      message: `start_date (${startDate}) is after end_date (${endDate}).`,
    });
  }

  const res = await msadsFetch<{ BillingDocumentsInfo?: Record<string, unknown>[] }>(
    "CustomerBilling",
    "BillingDocumentsInfo/Query",
    {
      body: {
        AccountIds: accountIds,
        StartDate: startDateTime,
        EndDate: endDateTime,
        ReturnInvoiceNumber: true,
      },
      retry: "safe",
    },
  );
  return res.BillingDocumentsInfo ?? [];
}
