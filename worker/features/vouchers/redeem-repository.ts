import type {
  RedeemVoucherResult,
  TeamVoucherDetails,
  TeamVoucherRow,
  VoucherLocator,
} from "./types";

export async function redeemVoucher(
  database: D1Database,
  eventId: string,
  sessionId: string,
  locator: VoucherLocator,
  redeemedAt: string,
): Promise<RedeemVoucherResult> {
  const locatorColumn =
    locator.kind === "public_id" ? "public_id" : "display_code";
  // D1 executes a batch sequentially and rolls it back as a unit on failure.
  // The voucher transition stays first. SQLite's changes() in the immediately
  // following statement is therefore 1 only for the elected winner, so a
  // losing retry cannot advance any session heartbeat.
  const [transition, , snapshot] = await database.batch<TeamVoucherRow>([
    database
      .prepare(
        `UPDATE vouchers
         SET redeemed_at = ?1,
             redeemed_by_session_id = ?2
         WHERE event_id = ?3
           AND ${locatorColumn} = ?4
           AND redeemed_at IS NULL`,
      )
      .bind(redeemedAt, sessionId, eventId, locator.value),
    database
      .prepare(
        `UPDATE team_sessions
         SET last_seen_at = MAX(last_seen_at, ?1)
         WHERE id = ?2
           AND event_id = ?3
           AND changes() = 1`,
      )
      .bind(redeemedAt, sessionId, eventId),
    voucherAfterTransitionStatement(database, eventId, locator),
  ]);

  const row = snapshot?.results[0] ?? null;
  if (!row) {
    return { status: "invalid" };
  }

  const voucher = mapVoucherDetails(row);
  if (transition.meta.changes === 1 && voucher.redeemedAt !== null) {
    return { status: "redeemed", voucher: { ...voucher, redeemedAt: voucher.redeemedAt } };
  }
  return voucher.redeemedAt === null
    ? { status: "invalid" }
    : {
        status: "already_redeemed",
        voucher: { ...voucher, redeemedAt: voucher.redeemedAt },
      };
}

function voucherAfterTransitionStatement(
  database: D1Database,
  eventId: string,
  locator: VoucherLocator,
): D1PreparedStatement {
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
    .bind(eventId, locator.value);
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
