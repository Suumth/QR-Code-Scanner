import type {
  InspectVoucherResult,
  TeamVoucherDetails,
  TeamVoucherRow,
  VoucherLocator,
} from "./types";

export async function inspectVoucher(
  database: D1Database,
  eventId: string,
  locator: VoucherLocator,
): Promise<InspectVoucherResult> {
  const row = await findVoucherForEvent(database, eventId, locator);
  if (!row) {
    return { status: "invalid" };
  }

  const voucher = mapVoucherDetails(row);
  return voucher.redeemedAt === null
    ? { status: "available", voucher: { ...voucher, redeemedAt: null } }
    : {
        status: "already_redeemed",
        voucher: { ...voucher, redeemedAt: voucher.redeemedAt },
      };
}

async function findVoucherForEvent(
  database: D1Database,
  eventId: string,
  locator: VoucherLocator,
): Promise<TeamVoucherRow | null> {
  const locatorColumn =
    locator.kind === "public_id" ? "vouchers.public_id" : "vouchers.display_code";
  return database
    .prepare(
      `SELECT
         vouchers.public_id,
         vouchers.display_code,
         vouchers.redeemed_at,
         events.name AS event_name,
         events.event_date AS event_date,
         sponsors.name AS sponsor_name,
         voucher_types.name AS voucher_type_name
       FROM vouchers
       INNER JOIN events ON events.id = vouchers.event_id
       INNER JOIN sponsors ON sponsors.id = vouchers.sponsor_id
       INNER JOIN voucher_types
         ON voucher_types.id = vouchers.voucher_type_id
        AND voucher_types.event_id = vouchers.event_id
        AND voucher_types.sponsor_id = vouchers.sponsor_id
       WHERE vouchers.event_id = ?1
         AND ${locatorColumn} = ?2`,
    )
    .bind(eventId, locator.value)
    .first<TeamVoucherRow>();
}

function mapVoucherDetails(row: TeamVoucherRow): TeamVoucherDetails {
  return {
    publicId: row.public_id,
    displayCode: row.display_code,
    redeemedAt: row.redeemed_at,
    event: {
      name: row.event_name,
      eventDate: row.event_date,
    },
    sponsor: {
      name: row.sponsor_name,
    },
    voucherType: {
      name: row.voucher_type_name,
    },
  };
}
