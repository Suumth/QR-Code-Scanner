import type { AdminVoucherExportRow } from "./dashboard-repository";

const CSV_HEADERS = [
  "event",
  "sponsor",
  "voucher_type",
  "voucher display code",
  "status",
  "redeemed timestamp",
  "redeemed-by display name",
] as const;

export function createVoucherCsv(rows: AdminVoucherExportRow[]): string {
  const lines = [CSV_HEADERS.map(csvField).join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.eventName,
        row.sponsorName,
        row.voucherTypeName,
        row.displayCode,
        row.redeemedAt === null ? "available" : "redeemed",
        row.redeemedAt ?? "",
        row.redeemedByDisplayName ?? "",
      ]
        .map(csvField)
        .join(","),
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}

export function voucherCsvFilename(eventDate: string): string {
  const safeDate = /^\d{4}-\d{2}-\d{2}$/.test(eventDate) ? eventDate : "event";
  return `event-vouchers-${safeDate}.csv`;
}

function csvField(value: string): string {
  const neutralized = hasFormulaPrefix(value) ? `'${value}` : value;
  return `"${neutralized.replaceAll('"', '""')}"`;
}

function hasFormulaPrefix(value: string): boolean {
  const firstCharacter = value[0];
  const firstCodePoint = firstCharacter?.codePointAt(0);
  return (
    firstCodePoint !== undefined &&
    (firstCodePoint <= 0x1f || firstCodePoint === 0x7f || "=+-@".includes(firstCharacter))
  );
}
