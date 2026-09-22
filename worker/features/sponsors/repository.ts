import type {
  PublicVoucherSnapshot,
  PublicVoucherSummary,
  PublicVoucherTypeGroup,
  SponsorSnapshot,
} from "./types";

interface SponsorRow {
  sponsor_id: string;
  sponsor_name: string;
  event_name: string;
  event_date: string;
}

interface VoucherRow {
  id: string;
  public_id: string;
  display_code: string;
  redeemed_at: string | null;
  voucher_type_id: string;
  voucher_type_name: string;
  voucher_type_created_at: string;
}

interface PublicVoucherRow extends VoucherRow {
  sponsor_name: string;
  event_name: string;
  event_date: string;
}

export async function findSponsorSnapshot(
  database: D1Database,
  accessId: string,
): Promise<SponsorSnapshot | null> {
  const sponsor = await database
    .prepare(
      `SELECT
         sponsors.id AS sponsor_id,
         sponsors.name AS sponsor_name,
         events.name AS event_name,
         events.event_date AS event_date
       FROM sponsors
       INNER JOIN events ON events.id = sponsors.event_id
       WHERE sponsors.access_id = ?1`,
    )
    .bind(accessId)
    .first<SponsorRow>();

  if (!sponsor) {
    return null;
  }

  const voucherRows = await database
    .prepare(
      `SELECT
         vouchers.id,
         vouchers.public_id,
         vouchers.display_code,
         vouchers.redeemed_at,
         voucher_types.id AS voucher_type_id,
         voucher_types.name AS voucher_type_name,
         voucher_types.created_at AS voucher_type_created_at
       FROM vouchers
       INNER JOIN sponsors ON sponsors.id = vouchers.sponsor_id
        AND sponsors.event_id = vouchers.event_id
       INNER JOIN voucher_types
         ON voucher_types.id = vouchers.voucher_type_id
        AND voucher_types.event_id = sponsors.event_id
        AND voucher_types.sponsor_id = sponsors.id
       WHERE vouchers.sponsor_id = ?1
       ORDER BY voucher_type_created_at, voucher_type_id, vouchers.created_at, vouchers.id`,
    )
    .bind(sponsor.sponsor_id)
    .all<VoucherRow>();
  const vouchers = voucherRows.results.map(mapVoucher);
  const redeemed = vouchers.reduce(
    (total, voucher) => total + (voucher.status === "redeemed" ? 1 : 0),
    0,
  );

  const voucherTypes = groupVouchers(vouchers);

  return {
    event: {
      name: sponsor.event_name,
      eventDate: sponsor.event_date,
    },
    sponsor: {
      name: sponsor.sponsor_name,
    },
    totals: {
      total: vouchers.length,
      available: vouchers.length - redeemed,
      redeemed,
    },
    voucherTypes,
  };
}

export async function findPublicVoucherSnapshot(
  database: D1Database,
  publicId: string,
): Promise<PublicVoucherSnapshot | null> {
  const row = await database
    .prepare(
      `SELECT
         vouchers.public_id,
         vouchers.display_code,
         vouchers.redeemed_at,
         voucher_types.name AS voucher_type_name,
         sponsors.name AS sponsor_name,
         events.name AS event_name,
         events.event_date AS event_date
       FROM vouchers
       INNER JOIN sponsors ON sponsors.id = vouchers.sponsor_id
       INNER JOIN events ON events.id = vouchers.event_id
       INNER JOIN voucher_types
         ON voucher_types.id = vouchers.voucher_type_id
        AND voucher_types.event_id = vouchers.event_id
        AND voucher_types.sponsor_id = vouchers.sponsor_id
       WHERE vouchers.public_id = ?1`,
    )
    .bind(publicId)
    .first<PublicVoucherRow>();

  return row
    ? {
        event: {
          name: row.event_name,
          eventDate: row.event_date,
        },
        sponsor: {
          name: row.sponsor_name,
        },
        voucher: mapVoucher(row),
      }
    : null;
}

function mapVoucher(row: VoucherRow): PublicVoucherSummary {
  return {
    publicId: row.public_id,
    displayCode: row.display_code,
    status: row.redeemed_at === null ? "available" : "redeemed",
    voucherType: { name: row.voucher_type_name },
  };
}

function groupVouchers(vouchers: PublicVoucherSummary[]): PublicVoucherTypeGroup[] {
  const groups = new Map<string, PublicVoucherSummary[]>();
  for (const voucher of vouchers) {
    const typeName = voucher.voucherType.name;
    const group = groups.get(typeName) ?? [];
    group.push(voucher);
    groups.set(typeName, group);
  }

  return [...groups].map(([name, typeVouchers]) => {
    const redeemed = typeVouchers.filter((voucher) => voucher.status === "redeemed").length;
    return {
      name,
      totals: {
        total: typeVouchers.length,
        available: typeVouchers.length - redeemed,
        redeemed,
      },
      vouchers: typeVouchers,
    };
  });
}
