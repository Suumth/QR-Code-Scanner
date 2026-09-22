import type { AdminSession, SafeEvent } from "./types";

interface AdminSessionRow {
  id: string;
  token_hash: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
}

interface EventRow {
  id: string;
  public_id: string;
  name: string;
  event_date: string;
  created_at: string;
}

export async function insertAdminSession(database: D1Database, session: AdminSession): Promise<void> {
  await database
    .prepare("INSERT INTO admin_sessions (id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(session.id, session.tokenHash, session.createdAt, session.expiresAt)
    .run();
}

export async function findActiveAdminSession(
  database: D1Database,
  tokenHash: string,
  now: string,
): Promise<AdminSession | null> {
  const row = await database
    .prepare(
      `SELECT id, token_hash, created_at, expires_at, revoked_at
       FROM admin_sessions
       WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?`,
    )
    .bind(tokenHash, now)
    .first<AdminSessionRow>();

  return row ? mapSession(row) : null;
}

export async function revokeAdminSession(database: D1Database, id: string, now: string): Promise<void> {
  await database
    .prepare("UPDATE admin_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
    .bind(now, id)
    .run();
}

export async function insertEvent(
  database: D1Database,
  event: SafeEvent & { teamPinSalt: string; teamPinHash: string },
): Promise<void> {
  await database
    .prepare(
      `INSERT INTO events (
        id, public_id, name, event_date, team_pin_salt, team_pin_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      event.id,
      event.publicId,
      event.name,
      event.eventDate,
      event.teamPinSalt,
      event.teamPinHash,
      event.createdAt,
    )
    .run();
}

export async function listEvents(database: D1Database): Promise<SafeEvent[]> {
  const rows = await database
    .prepare("SELECT id, public_id, name, event_date, created_at FROM events ORDER BY event_date, created_at")
    .all<EventRow>();

  return rows.results.map(mapEvent);
}

export async function findEvent(database: D1Database, id: string): Promise<SafeEvent | null> {
  const row = await database
    .prepare("SELECT id, public_id, name, event_date, created_at FROM events WHERE id = ?")
    .bind(id)
    .first<EventRow>();

  return row ? mapEvent(row) : null;
}

function mapSession(row: AdminSessionRow): AdminSession {
  return {
    id: row.id,
    tokenHash: row.token_hash,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}

function mapEvent(row: EventRow): SafeEvent {
  return {
    id: row.id,
    publicId: row.public_id,
    name: row.name,
    eventDate: row.event_date,
    createdAt: row.created_at,
  };
}
