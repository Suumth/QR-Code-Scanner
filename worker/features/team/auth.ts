import { clearSessionCookie, createSessionCookie, readCookie } from "../../security/cookies";
import { generateOpaqueId, sha256Hex } from "../../security/crypto";
import {
  findActiveTeamSession,
  insertTeamSession,
  revokeTeamSession,
} from "./repository";
import type {
  ActiveTeamSession,
  NewTeamSession,
  SafeTeamSession,
  TeamEnv,
  TeamEventCredentials,
} from "./types";

export const TEAM_COOKIE_NAME = "rt22_team_session";
const TEAM_SESSION_TTL_MS = 16 * 60 * 60 * 1000;

export async function createTeamSession(
  env: TeamEnv,
  event: TeamEventCredentials,
  displayName: string,
  now: Date,
): Promise<{ cookie: string }> {
  const token = generateOpaqueId(24);
  const expiresAt = new Date(now.getTime() + TEAM_SESSION_TTL_MS);
  const session: NewTeamSession = {
    id: generateOpaqueId(16),
    eventId: event.id,
    displayName,
    tokenHash: await sha256Hex(token),
    sessionVersion: event.teamSessionVersion,
    createdAt: now.toISOString(),
    lastSeenAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    revokedAt: null,
  };
  await insertTeamSession(env.DB, session);

  return {
    cookie: createSessionCookie({
      name: TEAM_COOKIE_NAME,
      value: token,
      expiresAt,
    }),
  };
}

/**
 * Resolves a currently active session without mutating D1. Voucher inspection
 * can reuse this guard and remain provably read-only.
 */
export async function getTeamSession(
  request: Request,
  env: Pick<TeamEnv, "DB">,
  now: Date,
): Promise<ActiveTeamSession | null> {
  const token = readCookie(request.headers.get("Cookie"), TEAM_COOKIE_NAME);
  if (!token) {
    return null;
  }
  return findActiveTeamSession(env.DB, await sha256Hex(token), now.toISOString());
}

export async function revokeCurrentTeamSession(
  env: Pick<TeamEnv, "DB">,
  session: ActiveTeamSession,
  now: Date,
): Promise<void> {
  await revokeTeamSession(env.DB, session.id, now.toISOString());
}

export function safeTeamSession(session: ActiveTeamSession): SafeTeamSession {
  return {
    displayName: session.displayName,
    expiresAt: session.expiresAt,
    lastSeenAt: session.lastSeenAt,
    event: session.event,
  };
}

export function clearTeamSessionCookie(): string {
  return clearSessionCookie(TEAM_COOKIE_NAME);
}
