import { MsAdsError } from "@/utils/errors";

/** Microsoft's `Date` is an object, not a string. */
export interface MsDate {
  Day: number;
  Month: number;
  Year: number;
}

/** Convert `YYYY-MM-DD` into the API's date object. */
export function toMsDate(iso: string): MsDate {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!m) {
    throw new MsAdsError({
      message: `Invalid date "${iso}". Use YYYY-MM-DD.`,
    });
  }
  const [, year, month, day] = m;
  const date = {
    Year: Number(year),
    Month: Number(month),
    Day: Number(day),
  };
  // Reject 2026-02-31 and friends before the API does, with a clearer message.
  const probe = new Date(Date.UTC(date.Year, date.Month - 1, date.Day));
  if (
    probe.getUTCFullYear() !== date.Year ||
    probe.getUTCMonth() !== date.Month - 1 ||
    probe.getUTCDate() !== date.Day
  ) {
    throw new MsAdsError({ message: `"${iso}" is not a real calendar date.` });
  }
  return date;
}
