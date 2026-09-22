import type { VoucherType } from "./types";

interface VoucherTypeRow {
  id: string;
  event_id: string;
  sponsor_id: string;
  name: string;
  created_at: string;
}

export async function findVoucherType(database: D1Database, id: string): Promise<VoucherType | null> {
  const row = await database
    .prepare(
      `SELECT id, event_id, sponsor_id, name, created_at
       FROM voucher_types
       WHERE id = ?1`,
    )
    .bind(id)
    .first<VoucherTypeRow>();

  return row ? mapVoucherType(row) : null;
}

export async function findVoucherTypeForScope(
  database: D1Database,
  eventId: string,
  sponsorId: string,
  id: string,
): Promise<VoucherType | null> {
  const row = await database
    .prepare(
      `SELECT id, event_id, sponsor_id, name, created_at
       FROM voucher_types
       WHERE id = ?1 AND event_id = ?2 AND sponsor_id = ?3`,
    )
    .bind(id, eventId, sponsorId)
    .first<VoucherTypeRow>();

  return row ? mapVoucherType(row) : null;
}

export async function listVoucherTypesForSponsor(
  database: D1Database,
  eventId: string,
  sponsorId: string,
): Promise<VoucherType[]> {
  const rows = await database
    .prepare(
      `SELECT id, event_id, sponsor_id, name, created_at
       FROM voucher_types
       WHERE event_id = ?1 AND sponsor_id = ?2
       ORDER BY created_at, id`,
    )
    .bind(eventId, sponsorId)
    .all<VoucherTypeRow>();

  return rows.results.map(mapVoucherType);
}

export async function insertVoucherType(database: D1Database, voucherType: VoucherType): Promise<void> {
  await database
    .prepare(
      `INSERT INTO voucher_types (id, event_id, sponsor_id, name, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(
      voucherType.id,
      voucherType.eventId,
      voucherType.sponsorId,
      voucherType.name,
      voucherType.createdAt,
    )
    .run();
}

export function isVoucherTypeUniqueConstraint(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed: voucher_types\.sponsor_id, voucher_types\.name/.test(error.message);
}

function mapVoucherType(row: VoucherTypeRow): VoucherType {
  return {
    id: row.id,
    eventId: row.event_id,
    sponsorId: row.sponsor_id,
    name: row.name,
    createdAt: row.created_at,
  };
}
