import { clearSessionCookie, createSessionCookie, readCookie } from "../../security/cookies";
import { generateOpaqueId, sha256Hex } from "../../security/crypto";
import { findActiveAdminSession, insertAdminSession } from "./repository";
import type { AdminEnv, AdminSession } from "./types";

export const ADMIN_COOKIE_NAME = "rt22_admin_session";
const ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_ADMIN_PASSWORD_LENGTH = 256;

interface WorkerSubtleCrypto extends SubtleCrypto {
  timingSafeEqual(a: ArrayBuffer | ArrayBufferView, b: ArrayBuffer | ArrayBufferView): boolean;
}

export async function verifyAdminPassword(candidate: string, expected: string | undefined): Promise<boolean> {
  if (
    !expected ||
    candidate.length > MAX_ADMIN_PASSWORD_LENGTH ||
    expected.length > MAX_ADMIN_PASSWORD_LENGTH
  ) {
    return false;
  }

  const [candidateHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(candidate)),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(expected)),
  ]);

  return (crypto.subtle as WorkerSubtleCrypto).timingSafeEqual(candidateHash, expectedHash);
}

export async function createAdminSession(env: AdminEnv, now: Date): Promise<{ cookie: string }> {
  const token = generateOpaqueId(24);
  const expiresAt = new Date(now.getTime() + ADMIN_SESSION_TTL_MS);
  const session: AdminSession = {
    id: generateOpaqueId(16),
    tokenHash: await sha256Hex(token),
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    revokedAt: null,
  };

  await insertAdminSession(env.DB, session);
  return { cookie: createSessionCookie({ name: ADMIN_COOKIE_NAME, value: token, expiresAt }) };
}

export async function getAdminSession(request: Request, env: AdminEnv, now: Date): Promise<AdminSession | null> {
  const token = readCookie(request.headers.get("Cookie"), ADMIN_COOKIE_NAME);
  if (!token) {
    return null;
  }

  return findActiveAdminSession(env.DB, await sha256Hex(token), now.toISOString());
}

export function clearAdminSessionCookie(): string {
  return clearSessionCookie(ADMIN_COOKIE_NAME);
}
