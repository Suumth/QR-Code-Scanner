import type { NewVoucher, SafeSponsor } from "./types";

export interface VoucherBatchTotals {
  totalSponsorCount: number;
  totalVoucherTypeCount: number;
}

interface SponsorRow {
  id: string;
  event_id: string;
  name: string;
  access_id: string;
  created_at: string;
}

export async function findSponsor(database: D1Database, id: string): Promise<SafeSponsor | null> {
  const row = await database
    .prepare("SELECT id, event_id, name, access_id, created_at FROM sponsors WHERE id = ?")
    .bind(id)
    .first<SponsorRow>();

  return row ? mapSponsor(row) : null;
}

export async function insertSponsor(database: D1Database, sponsor: SafeSponsor): Promise<void> {
  await database
    .prepare("INSERT INTO sponsors (id, event_id, name, access_id, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(sponsor.id, sponsor.eventId, sponsor.name, sponsor.accessId, sponsor.createdAt)
    .run();
}

export async function insertVoucherBatch(
  database: D1Database,
  vouchers: NewVoucher[],
): Promise<VoucherBatchTotals> {
  if (vouchers.length === 0) {
    throw new RangeError("Voucher batch must not be empty");
  }

  const results = await database.batch<{ count: number }>([
    database
      .prepare(
        `INSERT INTO vouchers (
          id, public_id, event_id, sponsor_id, voucher_type_id, display_code, redeemed_at, redeemed_by_session_id, created_at
        )
        SELECT
          json_extract(value, '$.id'),
          json_extract(value, '$.publicId'),
          json_extract(value, '$.eventId'),
          json_extract(value, '$.sponsorId'),
          json_extract(value, '$.voucherTypeId'),
          json_extract(value, '$.displayCode'),
          NULL,
          NULL,
          json_extract(value, '$.createdAt')
        FROM json_each(?1)`,
      )
      .bind(JSON.stringify(vouchers)),
    database
      .prepare("SELECT COUNT(*) AS count FROM vouchers WHERE sponsor_id = ?1")
      .bind(vouchers[0].sponsorId),
    database
      .prepare("SELECT COUNT(*) AS count FROM vouchers WHERE voucher_type_id = ?1")
      .bind(vouchers[0].voucherTypeId),
  ]);

  return {
    totalSponsorCount: results[1]?.results[0]?.count ?? 0,
    totalVoucherTypeCount: results[2]?.results[0]?.count ?? 0,
  };
}

export function isIssuanceUniqueConstraint(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed: (?:sponsors\.(?:id|access_id)|vouchers\.(?:id|public_id|display_code))/.test(error.message);
}

function mapSponsor(row: SponsorRow): SafeSponsor {
  return {
    id: row.id,
    eventId: row.event_id,
    name: row.name,
    accessId: row.access_id,
    createdAt: row.created_at,
  };
}
