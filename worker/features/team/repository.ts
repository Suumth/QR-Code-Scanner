import type {
  ActiveTeamSession,
  NewTeamSession,
  PublicTeamEvent,
  TeamEventCredentials,
} from "./types";

interface PublicTeamEventRow {
  public_id: string;
  name: string;
  event_date: string;
}

interface TeamEventRow {
  id: string;
  public_id: string;
  name: string;
  event_date: string;
  team_pin_salt: string;
  team_pin_hash: string;
  team_session_version: number;
}

interface ActiveTeamSessionRow {
  id: string;
  event_id: string;
  display_name: string;
  token_hash: string;
  session_version: number;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  event_public_id: string;
  event_name: string;
  event_date: string;
}

export async function findTeamEventByPublicId(
  database: D1Database,
  publicId: string,
): Promise<TeamEventCredentials | null> {
  const row = await database
    .prepare(
      `SELECT id, public_id, name, event_date, team_pin_salt, team_pin_hash,
              team_session_version
       FROM events
       WHERE public_id = ?1`,
    )
    .bind(publicId)
    .first<TeamEventRow>();

  return row ? mapEvent(row) : null;
}

export async function listPublicTeamEvents(
  database: D1Database,
  minimumEventDate: string,
): Promise<PublicTeamEvent[]> {
  const rows = await database
    .prepare(
      `SELECT public_id, name, event_date
       FROM events
       WHERE event_date >= ?1
       ORDER BY event_date ASC, name COLLATE NOCASE ASC, public_id ASC`,
    )
    .bind(minimumEventDate)
    .all<PublicTeamEventRow>();

  return rows.results.map((row) => ({
    publicId: row.public_id,
    name: row.name,
    eventDate: row.event_date,
  }));
}

export function formatBerlinDate(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = new Map(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${values.get("year")}-${values.get("month")}-${values.get("day")}`;
}

export async function insertTeamSession(
  database: D1Database,
  session: NewTeamSession,
): Promise<void> {
  await database
    .prepare(
      `INSERT INTO team_sessions (
        id, event_id, display_name, token_hash, session_version,
        created_at, last_seen_at, expires_at, revoked_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL)`,
    )
    .bind(
      session.id,
      session.eventId,
      session.displayName,
      session.tokenHash,
      session.sessionVersion,
      session.createdAt,
      session.lastSeenAt,
      session.expiresAt,
    )
    .run();
}

export async function findActiveTeamSession(
  database: D1Database,
  tokenHash: string,
  now: string,
): Promise<ActiveTeamSession | null> {
  const row = await database
    .prepare(
      `SELECT
         team_sessions.id,
         team_sessions.event_id,
         team_sessions.display_name,
         team_sessions.token_hash,
         team_sessions.session_version,
         team_sessions.created_at,
         team_sessions.last_seen_at,
         team_sessions.expires_at,
         events.public_id AS event_public_id,
         events.name AS event_name,
         events.event_date AS event_date
       FROM team_sessions
       INNER JOIN events ON events.id = team_sessions.event_id
       WHERE team_sessions.token_hash = ?1
         AND team_sessions.revoked_at IS NULL
         AND team_sessions.expires_at > ?2
         AND team_sessions.session_version = events.team_session_version`,
    )
    .bind(tokenHash, now)
    .first<ActiveTeamSessionRow>();

  return row ? mapActiveSession(row) : null;
}

export async function revokeTeamSession(
  database: D1Database,
  sessionId: string,
  now: string,
): Promise<void> {
  await database
    .prepare("UPDATE team_sessions SET revoked_at = ?1 WHERE id = ?2 AND revoked_at IS NULL")
    .bind(now, sessionId)
    .run();
}

export async function revokeAllTeamSessionsByVersion(
  database: D1Database,
  eventId: string,
): Promise<boolean> {
  const result = await database
    .prepare(
      `UPDATE events
       SET team_session_version = team_session_version + 1
       WHERE id = ?1`,
    )
    .bind(eventId)
    .run();
  return result.meta.changes === 1;
}

export async function rotateTeamPin(
  database: D1Database,
  eventId: string,
  salt: string,
  hash: string,
): Promise<boolean> {
  const result = await database
    .prepare(
      `UPDATE events
       SET team_pin_salt = ?1,
           team_pin_hash = ?2,
           team_session_version = team_session_version + 1
       WHERE id = ?3`,
    )
    .bind(salt, hash, eventId)
    .run();
  return result.meta.changes === 1;
}

export async function countRedeemedVouchersForEvent(
  database: D1Database,
  eventId: string,
): Promise<number> {
  const row = await database
    .prepare(
      `SELECT COUNT(*) AS redeemed_count
       FROM vouchers
       WHERE event_id = ?1
         AND redeemed_at IS NOT NULL`,
    )
    .bind(eventId)
    .first<{ redeemed_count: number }>();
  return row?.redeemed_count ?? 0;
}

function mapEvent(row: TeamEventRow): TeamEventCredentials {
  return {
    id: row.id,
    publicId: row.public_id,
    name: row.name,
    eventDate: row.event_date,
    teamPinSalt: row.team_pin_salt,
    teamPinHash: row.team_pin_hash,
    teamSessionVersion: row.team_session_version,
  };
}

function mapActiveSession(row: ActiveTeamSessionRow): ActiveTeamSession {
  return {
    id: row.id,
    eventId: row.event_id,
    displayName: row.display_name,
    tokenHash: row.token_hash,
    sessionVersion: row.session_version,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
    revokedAt: null,
    event: {
      id: row.event_id,
      publicId: row.event_public_id,
      name: row.event_name,
      eventDate: row.event_date,
    },
  };
}
