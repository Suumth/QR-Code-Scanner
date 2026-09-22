export type AdminQrExportVoucherStatus = "available" | "redeemed";

export interface AdminQrExportVoucher {
  publicId: string;
  displayCode: string;
  status: AdminQrExportVoucherStatus;
}

export interface AdminQrExportReadModel {
  sponsorName: string;
  voucherTypeName: string;
  vouchers: AdminQrExportVoucher[];
}

export const MAX_ADMIN_QR_EXPORT_VOUCHERS = 5_000;

interface SponsorRow {
  sponsor_name: string;
  voucher_type_name: string;
}

interface VoucherRow {
  public_id: string;
  display_code: string;
  redeemed_at: string | null;
}

export async function listAdminQrExportRows(
  database: D1Database,
  eventId: string,
  sponsorId: string,
  voucherTypeId: string,
): Promise<AdminQrExportReadModel | "too_many" | null> {
  const sponsor = await database
    .prepare(
      `SELECT
         sponsors.name AS sponsor_name,
         voucher_types.name AS voucher_type_name
       FROM sponsors
       INNER JOIN voucher_types
         ON voucher_types.sponsor_id = sponsors.id
        AND voucher_types.event_id = sponsors.event_id
        AND voucher_types.id = ?3
       WHERE sponsors.id = ?1 AND sponsors.event_id = ?2`,
    )
    .bind(sponsorId, eventId, voucherTypeId)
    .first<SponsorRow>();

  if (!sponsor) {
    return null;
  }

  const rows = await database
    .prepare(
      `SELECT public_id, display_code, redeemed_at
       FROM vouchers
       WHERE event_id = ?1 AND sponsor_id = ?2 AND voucher_type_id = ?3
       ORDER BY display_code ASC
       LIMIT ?4`,
    )
    .bind(eventId, sponsorId, voucherTypeId, MAX_ADMIN_QR_EXPORT_VOUCHERS + 1)
    .all<VoucherRow>();

  if (rows.results.length > MAX_ADMIN_QR_EXPORT_VOUCHERS) {
    return "too_many";
  }

  return {
    sponsorName: sponsor.sponsor_name,
    voucherTypeName: sponsor.voucher_type_name,
    vouchers: rows.results.map((row) => ({
      publicId: row.public_id,
      displayCode: row.display_code,
      status: row.redeemed_at === null ? "available" : "redeemed",
    })),
  };
}
