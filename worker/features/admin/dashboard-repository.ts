export interface AdminEventSummary {
  issuedCount: number;
  redeemedCount: number;
  availableCount: number;
}

export interface AdminSponsorSummary extends AdminEventSummary {
  id: string;
  name: string;
  accessId: string;
  createdAt: string;
  voucherTypes: AdminVoucherTypeSummary[];
}

export interface AdminVoucherTypeSummary extends AdminEventSummary {
  id: string;
  name: string;
}

export interface AdminSponsorPage {
  sponsors: AdminSponsorSummary[];
  nextCursor: string | null;
}

export type AdminTeamSessionStatus = "active" | "revoked" | "expired" | "superseded";

export interface AdminTeamSessionSummary {
  displayName: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  revokedAt: string | null;
  status: AdminTeamSessionStatus;
}

export interface AdminVoucherExportRow {
  eventName: string;
  sponsorName: string;
  voucherTypeName: string;
  displayCode: string;
  redeemedAt: string | null;
  redeemedByDisplayName: string | null;
}

// A worst-case row contains both 120-character admin names plus an 80-character
// team display name. Keeping one query/result and its CSV representation below
// this bound leaves substantial headroom inside Workers' 128 MB isolate limit.
export const MAX_ADMIN_CSV_EXPORT_ROWS = 5_000;

interface CountRow {
  issued_count: number;
  redeemed_count: number;
}

interface SponsorCountRow extends CountRow {
  id: string;
  name: string;
  access_id: string;
  created_at: string;
  cursor_row_id: number;
}

interface VoucherTypeCountRow extends CountRow {
  id: string;
  sponsor_id: string;
  name: string;
}

interface TeamSessionRow {
  display_name: string;
  session_version: number;
  event_session_version: number;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  revoked_at: string | null;
}

interface VoucherExportRow {
  event_name: string;
  sponsor_name: string | null;
  voucher_type_name: string | null;
  display_code: string;
  redeemed_at: string | null;
  redeemed_by_display_name: string | null;
}

export const MAX_ADMIN_SPONSORS_PER_PAGE = 500;
const MAX_ADMIN_TEAM_SESSIONS = 500;

export async function getAdminEventSummary(
  database: D1Database,
  eventId: string,
): Promise<AdminEventSummary> {
  const row = await database
    .prepare(
      `SELECT
         COUNT(*) AS issued_count,
         COALESCE(SUM(CASE WHEN redeemed_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS redeemed_count
       FROM vouchers
       WHERE event_id = ?1`,
    )
    .bind(eventId)
    .first<CountRow>();
  return counts(row?.issued_count ?? 0, row?.redeemed_count ?? 0);
}

export async function listAdminSponsorSummaries(
  database: D1Database,
  eventId: string,
  afterRowId = 0,
): Promise<AdminSponsorPage> {
  const rows = await database
    .prepare(
      `WITH sponsor_page AS (
         SELECT
           rowid AS cursor_row_id,
           id,
           event_id,
           name,
           access_id,
           created_at
         FROM sponsors
         WHERE event_id = ?1
           AND rowid > ?2
         ORDER BY rowid
         LIMIT ?3
       )
       SELECT
         sponsor_page.cursor_row_id,
         sponsor_page.id,
         sponsor_page.name,
         sponsor_page.access_id,
         sponsor_page.created_at,
         COUNT(vouchers.id) AS issued_count,
         COALESCE(SUM(CASE WHEN vouchers.redeemed_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS redeemed_count
       FROM sponsor_page
       LEFT JOIN vouchers
         ON vouchers.sponsor_id = sponsor_page.id
        AND vouchers.event_id = sponsor_page.event_id
       GROUP BY
         sponsor_page.cursor_row_id,
         sponsor_page.id,
         sponsor_page.name,
         sponsor_page.access_id,
         sponsor_page.created_at
       ORDER BY sponsor_page.cursor_row_id`,
    )
    .bind(eventId, afterRowId, MAX_ADMIN_SPONSORS_PER_PAGE + 1)
    .all<SponsorCountRow>();

  const pageRows = rows.results.slice(0, MAX_ADMIN_SPONSORS_PER_PAGE);
  const voucherTypesBySponsor = await listVoucherTypeSummaries(
    database,
    eventId,
    pageRows.map((row) => row.id),
  );
  return {
    sponsors: pageRows.map((row) => ({
      id: row.id,
      name: row.name,
      accessId: row.access_id,
      createdAt: row.created_at,
      ...counts(row.issued_count, row.redeemed_count),
      voucherTypes: voucherTypesBySponsor.get(row.id) ?? [],
    })),
    nextCursor:
      rows.results.length > MAX_ADMIN_SPONSORS_PER_PAGE
        ? encodeAdminSponsorCursor(pageRows.at(-1)?.cursor_row_id ?? 0)
        : null,
  };
}

export function decodeAdminSponsorCursor(value: string): number | null {
  if (!/^s_[0-9a-z]+$/.test(value) || value.length > 24) {
    return null;
  }
  const rowId = Number.parseInt(value.slice(2), 36);
  return Number.isSafeInteger(rowId) && rowId > 0 ? rowId : null;
}

function encodeAdminSponsorCursor(rowId: number): string {
  return `s_${rowId.toString(36)}`;
}

export async function listAdminTeamSessions(
  database: D1Database,
  eventId: string,
  now: string,
): Promise<AdminTeamSessionSummary[]> {
  const rows = await database
    .prepare(
      `SELECT
         team_sessions.display_name,
         team_sessions.session_version,
         events.team_session_version AS event_session_version,
         team_sessions.created_at,
         team_sessions.last_seen_at,
         team_sessions.expires_at,
         team_sessions.revoked_at
       FROM team_sessions
       INNER JOIN events ON events.id = team_sessions.event_id
       WHERE team_sessions.event_id = ?1
       ORDER BY team_sessions.last_seen_at DESC, team_sessions.created_at DESC
       LIMIT ?2`,
    )
    .bind(eventId, MAX_ADMIN_TEAM_SESSIONS)
    .all<TeamSessionRow>();

  return rows.results.map((row) => ({
    displayName: row.display_name,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    status: sessionStatus(row, now),
  }));
}

export async function listAdminVoucherExportRows(
  database: D1Database,
  eventId: string,
): Promise<AdminVoucherExportRow[] | null> {
  const rows = await database
    .prepare(
      `SELECT
         events.name AS event_name,
         sponsors.name AS sponsor_name,
         voucher_types.name AS voucher_type_name,
         vouchers.display_code,
         vouchers.redeemed_at,
         team_sessions.display_name AS redeemed_by_display_name
       FROM vouchers
       INNER JOIN events ON events.id = vouchers.event_id
       LEFT JOIN sponsors
         ON sponsors.id = vouchers.sponsor_id
        AND sponsors.event_id = vouchers.event_id
       LEFT JOIN team_sessions
         ON team_sessions.id = vouchers.redeemed_by_session_id
        AND team_sessions.event_id = vouchers.event_id
       LEFT JOIN voucher_types
         ON voucher_types.id = vouchers.voucher_type_id
        AND voucher_types.event_id = vouchers.event_id
        AND voucher_types.sponsor_id = vouchers.sponsor_id
       WHERE vouchers.event_id = ?1
       LIMIT ?2`,
    )
    .bind(eventId, MAX_ADMIN_CSV_EXPORT_ROWS + 1)
    .all<VoucherExportRow>();

  if (rows.results.length > MAX_ADMIN_CSV_EXPORT_ROWS) {
    return null;
  }

  return rows.results.map((row) => ({
    eventName: row.event_name,
    sponsorName: row.sponsor_name ?? "",
    voucherTypeName: row.voucher_type_name ?? "",
    displayCode: row.display_code,
    redeemedAt: row.redeemed_at,
    redeemedByDisplayName: row.redeemed_by_display_name,
  }));
}

async function listVoucherTypeSummaries(
  database: D1Database,
  eventId: string,
  sponsorIds: string[],
): Promise<Map<string, AdminVoucherTypeSummary[]>> {
  if (sponsorIds.length === 0) {
    return new Map();
  }

  const chunks: string[][] = [];
  for (let index = 0; index < sponsorIds.length; index += 90) {
    chunks.push(sponsorIds.slice(index, index + 90));
  }
  const chunkRows = await Promise.all(
    chunks.map(async (chunk) => {
      const placeholders = chunk.map((_, index) => `?${index + 2}`).join(", ");
      return database
        .prepare(
          `SELECT
             voucher_types.id,
             voucher_types.sponsor_id,
             voucher_types.name,
             COUNT(vouchers.id) AS issued_count,
             COALESCE(SUM(CASE WHEN vouchers.redeemed_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS redeemed_count
           FROM voucher_types
           LEFT JOIN vouchers
             ON vouchers.voucher_type_id = voucher_types.id
            AND vouchers.event_id = voucher_types.event_id
            AND vouchers.sponsor_id = voucher_types.sponsor_id
           WHERE voucher_types.event_id = ?1
             AND voucher_types.sponsor_id IN (${placeholders})
           GROUP BY voucher_types.id, voucher_types.sponsor_id, voucher_types.name, voucher_types.created_at
           ORDER BY voucher_types.created_at, voucher_types.id`,
        )
        .bind(eventId, ...chunk)
        .all<VoucherTypeCountRow>();
    }),
  );

  const grouped = new Map<string, AdminVoucherTypeSummary[]>();
  for (const row of chunkRows.flatMap(({ results }) => results)) {
    const summaries = grouped.get(row.sponsor_id) ?? [];
    summaries.push({
      id: row.id,
      name: row.name,
      ...counts(row.issued_count, row.redeemed_count),
    });
    grouped.set(row.sponsor_id, summaries);
  }
  return grouped;
}

function counts(issuedCount: number, redeemedCount: number): AdminEventSummary {
  return {
    issuedCount,
    redeemedCount,
    availableCount: issuedCount - redeemedCount,
  };
}

function sessionStatus(row: TeamSessionRow, now: string): AdminTeamSessionStatus {
  if (row.revoked_at !== null) {
    return "revoked";
  }
  if (row.expires_at <= now) {
    return "expired";
  }
  if (row.session_version !== row.event_session_version) {
    return "superseded";
  }
  return "active";
}
