import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { getTeamSession } from "../../worker/features/team/auth";
import { handleTeamRequest } from "../../worker/features/team/routes";
import { derivePin, generateOpaqueId, sha256Hex } from "../../worker/security/crypto";

declare const __RT22_D1_MIGRATIONS__: {
  name: string;
  queries: string[];
}[];

const TEAM_PIN = "246810";

beforeAll(async () => {
  await applyD1Migrations(env.DB, __RT22_D1_MIGRATIONS__, "task_6_migrations");
});

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM admin_sessions"),
    env.DB.prepare("DELETE FROM events"),
  ]);
});

test("a correct event PIN creates a hash-only team session and a strict secure cookie", async () => {
  const event = await seedEvent();
  const response = await login(event.publicId, { displayName: "  Frida 🌟  ", pin: TEAM_PIN });

  expect(response.status).toBe(204);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  const setCookie = response.headers.get("Set-Cookie");
  expect(setCookie).toMatch(
    /^rt22_team_session=[A-Za-z0-9_-]{32}; Path=\/; HttpOnly; SameSite=Strict; Expires=/,
  );
  expect(setCookie).toContain("Secure");

  const token = cookieToken(setCookie);
  const stored = await env.DB.prepare(
    `SELECT id, event_id, display_name, token_hash, session_version,
            created_at, last_seen_at, expires_at, revoked_at
     FROM team_sessions`,
  ).first<{
    id: string;
    event_id: string;
    display_name: string;
    token_hash: string;
    session_version: number;
    created_at: string;
    last_seen_at: string;
    expires_at: string;
    revoked_at: string | null;
  }>();

  expect(stored).toMatchObject({
    event_id: event.id,
    display_name: "Frida 🌟",
    token_hash: await sha256Hex(token),
    session_version: 1,
    revoked_at: null,
  });
  expect(stored?.token_hash).not.toBe(token);
  expect(JSON.stringify(stored)).not.toContain(token);
  expect(new Date(stored?.expires_at ?? "invalid").getTime()).toBeGreaterThan(Date.now());
});

test("wrong PIN and an unknown event fail identically without creating a session", async () => {
  const event = await seedEvent();

  for (const [publicId, pin] of [
    [event.publicId, "135791"],
    [generateOpaqueId(16), TEAM_PIN],
  ] as const) {
    const response = await login(publicId, { displayName: "Frida", pin });
    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ error: "Invalid credentials" });
  }

  await expect(env.DB.prepare("SELECT id FROM team_sessions").all()).resolves.toMatchObject({
    results: [],
  });
});

test("team login rejects unsafe names and non-six-digit PINs", async () => {
  const event = await seedEvent();
  const invalidBodies = [
    { displayName: " ", pin: TEAM_PIN },
    { displayName: "x".repeat(81), pin: TEAM_PIN },
    { displayName: "Frida\nAdmin", pin: TEAM_PIN },
    { displayName: 7, pin: TEAM_PIN },
    { displayName: "Frida", pin: "12345" },
    { displayName: "Frida", pin: "12345a" },
    { displayName: "Frida", pin: 246810 },
  ];

  for (const body of invalidBodies) {
    const response = await login(event.publicId, body);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid login" });
  }

  await expect(env.DB.prepare("SELECT id FROM team_sessions").all()).resolves.toMatchObject({
    results: [],
  });
});

test("team login accepts only bounded application JSON", async () => {
  const event = await seedEvent();

  const wrongType = await SELF.fetch(`https://example.com/api/team/${event.publicId}/login`, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify({ displayName: "Frida", pin: TEAM_PIN }),
  });
  expect(wrongType.status).toBe(415);
  await expect(wrongType.json()).resolves.toEqual({ error: "Unsupported media type" });

  const malformed = await SELF.fetch(`https://example.com/api/team/${event.publicId}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{",
  });
  expect(malformed.status).toBe(400);
  await expect(malformed.json()).resolves.toEqual({ error: "Malformed JSON" });

  const oversized = await SELF.fetch(`https://example.com/api/team/${event.publicId}/login`, {
    method: "POST",
    headers: { "Content-Length": "1", "Content-Type": "application/json" },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(4097));
      },
    }),
  });
  expect(oversized.status).toBe(413);
  await expect(oversized.json()).resolves.toEqual({ error: "Payload too large" });

  await expect(env.DB.prepare("SELECT id FROM team_sessions").all()).resolves.toMatchObject({
    results: [],
  });
});

test("two devices receive independent sessions that remain valid simultaneously", async () => {
  const event = await seedEvent();
  const [aliceLogin, bobLogin] = await Promise.all([
    login(event.publicId, { displayName: "Alice", pin: TEAM_PIN }),
    login(event.publicId, { displayName: "Bob", pin: TEAM_PIN }),
  ]);
  const aliceCookie = requestCookie(aliceLogin);
  const bobCookie = requestCookie(bobLogin);

  expect(aliceLogin.status).toBe(204);
  expect(bobLogin.status).toBe(204);
  expect(aliceCookie).not.toBe(bobCookie);

  const [aliceSession, bobSession] = await Promise.all([
    getSession(aliceCookie),
    getSession(bobCookie),
  ]);
  expect(aliceSession.status).toBe(200);
  expect(bobSession.status).toBe(200);
  await expect(aliceSession.json()).resolves.toEqual({
    session: {
      displayName: "Alice",
      expiresAt: expect.any(String),
      lastSeenAt: expect.any(String),
      event: {
        id: event.id,
        publicId: event.publicId,
        name: event.name,
        eventDate: event.eventDate,
      },
    },
  });
  await expect(bobSession.json()).resolves.toMatchObject({
    session: { displayName: "Bob", event: { id: event.id } },
  });
  await expect(
    env.DB.prepare("SELECT COUNT(DISTINCT token_hash) AS count FROM team_sessions").first<{
      count: number;
    }>(),
  ).resolves.toEqual({ count: 2 });
});

test("session bootstrap is private, read-only, and exposes no auth material", async () => {
  const event = await seedEvent();
  const loggedIn = await login(event.publicId, { displayName: "Mara", pin: TEAM_PIN });
  const cookie = requestCookie(loggedIn);
  const oldLastSeen = "2020-01-01T00:00:00.000Z";
  await env.DB.prepare("UPDATE team_sessions SET last_seen_at = ?1").bind(oldLastSeen).run();
  const before = (await env.DB.prepare("SELECT * FROM team_sessions ORDER BY id").all()).results;

  const response = await getSession(cookie);
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get("Vary")).toBe("Cookie");
  const body = (await response.json()) as { session: Record<string, unknown> };
  expect(body.session).not.toHaveProperty("token");
  expect(body.session).not.toHaveProperty("tokenHash");
  expect(body.session).not.toHaveProperty("sessionVersion");
  expect(body.session).not.toHaveProperty("teamPin");
  expect(body.session).not.toHaveProperty("teamPinHash");
  expect(body.session).not.toHaveProperty("teamPinSalt");
  expect(body.session).toMatchObject({ lastSeenAt: oldLastSeen });
  await expect(
    env.DB.prepare("SELECT * FROM team_sessions ORDER BY id").all(),
  ).resolves.toMatchObject({ results: before });
});

test("the reusable team-session guard is read-only for downstream voucher inspection", async () => {
  const event = await seedEvent();
  const loggedIn = await login(event.publicId, { displayName: "Read only", pin: TEAM_PIN });
  const cookie = requestCookie(loggedIn);
  const oldLastSeen = "2020-01-01T00:00:00.000Z";
  await env.DB.prepare("UPDATE team_sessions SET last_seen_at = ?1").bind(oldLastSeen).run();

  const resolved = await getTeamSession(
    new Request("https://example.com/api/team/vouchers/inspect", {
      headers: { Cookie: cookie },
    }),
    env,
    new Date(),
  );

  expect(resolved).toMatchObject({ displayName: "Read only", lastSeenAt: oldLastSeen });
  await expect(
    env.DB.prepare("SELECT last_seen_at FROM team_sessions").first<{ last_seen_at: string }>(),
  ).resolves.toEqual({ last_seen_at: oldLastSeen });
});

test("the event-scoped limiter rejects login before credentials create a session", async () => {
  const event = await seedEvent();
  const response = await handleTeamRequest(
    new Request(`https://example.com/api/team/${event.publicId}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "Limited", pin: TEAM_PIN }),
    }),
    {
      DB: env.DB,
      TEAM_LOGIN_RATE_LIMITER: {
        limit: async ({ key }) => ({ success: key !== `team-login:${event.publicId}` }),
      },
    },
  );

  expect(response?.status).toBe(429);
  expect(response?.headers.get("Cache-Control")).toBe("no-store");
  await expect(response?.json()).resolves.toEqual({ error: "Too many login attempts" });
  await expect(env.DB.prepare("SELECT id FROM team_sessions").all()).resolves.toMatchObject({
    results: [],
  });
});

test("expired, revoked, unknown, and version-mismatched sessions are rejected and cleared", async () => {
  const event = await seedEvent();
  const now = new Date();
  const fixtures = [
    {
      token: "expired-team-token",
      expiresAt: new Date(now.getTime() - 1_000).toISOString(),
      revokedAt: null,
      version: 1,
    },
    {
      token: "revoked-team-token",
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      revokedAt: now.toISOString(),
      version: 1,
    },
    {
      token: "old-version-team-token",
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      revokedAt: null,
      version: 0,
    },
  ];
  for (const fixture of fixtures) {
    await seedSession(event.id, fixture);
  }

  for (const token of [...fixtures.map(({ token }) => token), "unknown-team-token"]) {
    const response = await getSession(`rt22_team_session=${token}`);
    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Vary")).toBe("Cookie");
    expect(response.headers.get("Set-Cookie")).toContain("rt22_team_session=");
    expect(response.headers.get("Set-Cookie")).toContain("Max-Age=0");
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
  }
});

test("team logout revokes only the authenticated session and clears its cookie", async () => {
  const event = await seedEvent();
  const [first, second] = await Promise.all([
    login(event.publicId, { displayName: "First", pin: TEAM_PIN }),
    login(event.publicId, { displayName: "Second", pin: TEAM_PIN }),
  ]);
  const firstCookie = requestCookie(first);
  const secondCookie = requestCookie(second);

  const logout = await SELF.fetch("https://example.com/api/team/logout", {
    method: "POST",
    headers: { Cookie: firstCookie },
  });
  expect(logout.status).toBe(204);
  expect(logout.headers.get("Cache-Control")).toBe("no-store");
  expect(logout.headers.get("Vary")).toBe("Cookie");
  expect(logout.headers.get("Set-Cookie")).toContain("Max-Age=0");
  expect((await getSession(firstCookie)).status).toBe(401);
  expect((await getSession(secondCookie)).status).toBe(200);

  const rows = await env.DB.prepare(
    "SELECT display_name, revoked_at FROM team_sessions ORDER BY display_name",
  ).all<{ display_name: string; revoked_at: string | null }>();
  expect(rows.results).toEqual([
    { display_name: "First", revoked_at: expect.any(String) },
    { display_name: "Second", revoked_at: null },
  ]);
});

describe("admin team controls", () => {
  test("reject unauthenticated PIN changes and revocation without mutating the event", async () => {
    const event = await seedEvent();
    const before = await storedEventSecurity(event.id);

    const changePin = await postJson(`/api/admin/events/${event.id}/team-pin`, {
      teamPin: "654321",
    });
    const revoke = await postJson(`/api/admin/events/${event.id}/revoke-team-sessions`, {});

    for (const response of [changePin, revoke]) {
      expect(response.status).toBe(401);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(response.headers.get("Vary")).toBe("Cookie");
      await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
    }
    expect(await storedEventSecurity(event.id)).toEqual(before);
  });

  test("revoke-all increments the event version and invalidates every existing device session", async () => {
    const event = await seedEvent();
    const adminCookie = await seedAdminSession();
    const [first, second] = await Promise.all([
      login(event.publicId, { displayName: "First", pin: TEAM_PIN }),
      login(event.publicId, { displayName: "Second", pin: TEAM_PIN }),
    ]);

    const response = await postJson(
      `/api/admin/events/${event.id}/revoke-team-sessions`,
      {},
      adminCookie,
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Vary")).toBe("Cookie");
    expect(await storedEventSecurity(event.id)).toMatchObject({ team_session_version: 2 });
    expect((await getSession(requestCookie(first))).status).toBe(401);
    expect((await getSession(requestCookie(second))).status).toBe(401);
  });

  test("changing the PIN rotates salt and hash, increments version, and accepts only the new PIN", async () => {
    const event = await seedEvent();
    const adminCookie = await seedAdminSession();
    const oldLogin = await login(event.publicId, { displayName: "Old device", pin: TEAM_PIN });
    const before = await storedEventSecurity(event.id);

    const response = await postJson(
      `/api/admin/events/${event.id}/team-pin`,
      { teamPin: "654321" },
      adminCookie,
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Vary")).toBe("Cookie");

    const after = await storedEventSecurity(event.id);
    expect(after.team_session_version).toBe(2);
    expect(after.team_pin_salt).not.toBe(before.team_pin_salt);
    expect(after.team_pin_hash).not.toBe(before.team_pin_hash);
    expect(after.team_pin_salt).not.toBe("654321");
    expect(after.team_pin_hash).not.toBe("654321");
    expect(after.team_pin_hash).toBe(await derivePin("654321", after.team_pin_salt));
    expect((await getSession(requestCookie(oldLogin))).status).toBe(401);
    expect((await login(event.publicId, { displayName: "Old PIN", pin: TEAM_PIN })).status).toBe(
      401,
    );
    expect(
      (await login(event.publicId, { displayName: "New PIN", pin: "654321" })).status,
    ).toBe(204);
  });

  test("PIN control validates bounded JSON and both controls safe-fail for a missing event", async () => {
    const event = await seedEvent();
    const adminCookie = await seedAdminSession();
    const before = await storedEventSecurity(event.id);

    const invalid = await postJson(
      `/api/admin/events/${event.id}/team-pin`,
      { teamPin: "12345a" },
      adminCookie,
    );
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toEqual({ error: "Invalid team PIN" });

    const wrongType = await SELF.fetch(
      `https://example.com/api/admin/events/${event.id}/team-pin`,
      {
        method: "POST",
        headers: { "Content-Type": "text/plain", Cookie: adminCookie },
        body: JSON.stringify({ teamPin: "654321" }),
      },
    );
    expect(wrongType.status).toBe(415);
    await expect(wrongType.json()).resolves.toEqual({ error: "Unsupported media type" });

    for (const path of ["team-pin", "revoke-team-sessions"]) {
      const response = await postJson(
        `/api/admin/events/missing-event/${path}`,
        path === "team-pin" ? { teamPin: "654321" } : {},
        adminCookie,
      );
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: "Event not found" });
    }
    expect(await storedEventSecurity(event.id)).toEqual(before);
  });
});

test("team and admin team-control routes return exact method-specific Allow headers", async () => {
  const event = await seedEvent();
  const cases = [
    [new Request(`https://example.com/api/team/${event.publicId}/login`), "POST"],
    [new Request("https://example.com/api/team/logout"), "POST"],
    [new Request("https://example.com/api/team/session", { method: "POST" }), "GET"],
    [new Request(`https://example.com/api/admin/events/${event.id}/team-pin`), "POST"],
    [
      new Request(`https://example.com/api/admin/events/${event.id}/revoke-team-sessions`),
      "POST",
    ],
  ] as const;

  for (const [request, allow] of cases) {
    const response = await SELF.fetch(request);
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe(allow);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  }
});

test("public team event discovery exposes only eligible events in deterministic Berlin-date order", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-20T22:30:00.000Z"));

  await seedPublicEvent({
    id: "internal-past",
    publicId: "p".repeat(22),
    name: "Past",
    eventDate: "2026-08-20",
  });
  await seedPublicEvent({
    id: "internal-beta",
    publicId: "b".repeat(22),
    name: "Beta",
    eventDate: "2026-08-21",
  });
  await seedPublicEvent({
    id: "internal-alpha-z",
    publicId: "z".repeat(22),
    name: "Alpha",
    eventDate: "2026-08-21",
  });
  await seedPublicEvent({
    id: "internal-alpha-a",
    publicId: "a".repeat(22),
    name: "Alpha",
    eventDate: "2026-08-21",
  });
  await seedPublicEvent({
    id: "internal-future",
    publicId: "f".repeat(22),
    name: "Future",
    eventDate: "2026-08-22",
  });

  const response = await SELF.fetch("https://example.com/api/team/events");

  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get("Vary")).toBeNull();
  await expect(response.json()).resolves.toEqual({
    events: [
      { publicId: "a".repeat(22), name: "Alpha", eventDate: "2026-08-21" },
      { publicId: "z".repeat(22), name: "Alpha", eventDate: "2026-08-21" },
      { publicId: "b".repeat(22), name: "Beta", eventDate: "2026-08-21" },
      { publicId: "f".repeat(22), name: "Future", eventDate: "2026-08-22" },
    ],
  });

  const sessionRows = await env.DB.prepare("SELECT id FROM team_sessions").all();
  expect(sessionRows.results).toEqual([]);
});

test("public team event discovery uses GET only", async () => {
  const response = await SELF.fetch("https://example.com/api/team/events", {
    method: "POST",
  });

  expect(response.status).toBe(405);
  expect(response.headers.get("Allow")).toBe("GET");
  expect(response.headers.get("Cache-Control")).toBe("no-store");
});

afterEach(() => {
  vi.useRealTimers();
});

interface SeededEvent {
  id: string;
  publicId: string;
  name: string;
  eventDate: string;
}

async function seedEvent(pin = TEAM_PIN): Promise<SeededEvent> {
  const event = {
    id: generateOpaqueId(16),
    publicId: generateOpaqueId(16),
    name: "RT22 Sommerfest",
    eventDate: "2026-08-20",
  };
  const salt = generateOpaqueId(24);
  await env.DB.prepare(
    `INSERT INTO events (
      id, public_id, name, event_date, team_pin_salt, team_pin_hash, created_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  )
    .bind(
      event.id,
      event.publicId,
      event.name,
      event.eventDate,
      salt,
      await derivePin(pin, salt),
      new Date().toISOString(),
    )
    .run();
  return event;
}

async function seedPublicEvent(event: SeededEvent): Promise<void> {
  const salt = generateOpaqueId(24);
  await env.DB.prepare(
    `INSERT INTO events (
      id, public_id, name, event_date, team_pin_salt, team_pin_hash, created_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  )
    .bind(
      event.id,
      event.publicId,
      event.name,
      event.eventDate,
      salt,
      await derivePin(TEAM_PIN, salt),
      new Date().toISOString(),
    )
    .run();
}

async function seedSession(
  eventId: string,
  fixture: { token: string; expiresAt: string; revokedAt: string | null; version: number },
): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO team_sessions (
      id, event_id, display_name, token_hash, session_version,
      created_at, last_seen_at, expires_at, revoked_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7, ?8)`,
  )
    .bind(
      generateOpaqueId(16),
      eventId,
      fixture.token,
      await sha256Hex(fixture.token),
      fixture.version,
      now,
      fixture.expiresAt,
      fixture.revokedAt,
    )
    .run();
}

async function seedAdminSession(): Promise<string> {
  const token = generateOpaqueId(24);
  const now = new Date();
  await env.DB.prepare(
    `INSERT INTO admin_sessions (id, token_hash, created_at, expires_at, revoked_at)
     VALUES (?1, ?2, ?3, ?4, NULL)`,
  )
    .bind(
      generateOpaqueId(16),
      await sha256Hex(token),
      now.toISOString(),
      new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    )
    .run();
  return `rt22_admin_session=${token}`;
}

async function storedEventSecurity(eventId: string): Promise<{
  team_pin_salt: string;
  team_pin_hash: string;
  team_session_version: number;
}> {
  const row = await env.DB.prepare(
    "SELECT team_pin_salt, team_pin_hash, team_session_version FROM events WHERE id = ?1",
  )
    .bind(eventId)
    .first<{
      team_pin_salt: string;
      team_pin_hash: string;
      team_session_version: number;
    }>();
  if (!row) {
    throw new Error("Expected seeded event");
  }
  return row;
}

function login(eventPublicId: string, body: unknown): Promise<Response> {
  return postJson(`/api/team/${eventPublicId}/login`, body);
}

function getSession(cookie: string): Promise<Response> {
  return SELF.fetch("https://example.com/api/team/session", { headers: { Cookie: cookie } });
}

function postJson(path: string, body: unknown, cookie?: string): Promise<Response> {
  return SELF.fetch(`https://example.com${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

function requestCookie(response: Response): string {
  const cookie = response.headers.get("Set-Cookie")?.split(";", 1)[0];
  if (!cookie) {
    throw new Error("Expected a team session cookie");
  }
  return cookie;
}

function cookieToken(setCookie: string | null): string {
  const token = setCookie?.match(/^rt22_team_session=([^;]+)/)?.[1];
  if (!token) {
    throw new Error("Expected a team session token");
  }
  return token;
}
