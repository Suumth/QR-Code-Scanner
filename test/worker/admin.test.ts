import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { beforeAll, beforeEach, expect, test } from "vitest";

import { handleAdminRequest } from "../../worker/features/admin/routes";
import { withAdminResponseHeaders } from "../../worker/http/admin-response";
import { sha256Hex } from "../../worker/security/crypto";

declare const __RT22_D1_MIGRATIONS__: {
  name: string;
  queries: string[];
}[];

const ADMIN_PASSWORD = crypto.randomUUID();
const WORKER_ADMIN_PASSWORD = "vitest-only-admin-password";
const loginRateLimiter = { limit: async () => ({ success: true }) };

beforeAll(async () => {
  await applyD1Migrations(env.DB, __RT22_D1_MIGRATIONS__, "task_3_migrations");
});

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM admin_sessions"),
    env.DB.prepare("DELETE FROM events"),
  ]);
});

test("admin event endpoints reject a request without an authenticated session", async () => {
  const response = await SELF.fetch("https://example.com/api/admin/events");

  expect(response.status).toBe(401);
  await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
});

test("admin event detail rejects a request without an authenticated session", async () => {
  const response = await SELF.fetch("https://example.com/api/admin/events/event-internal-id");

  expect(response.status).toBe(401);
  await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
});

test("admin login rejects an incorrect password without revealing credential details", async () => {
  const response = await handleAdminRequest(
    jsonRequest("/api/admin/login", { password: "not-the-password" }),
    testEnv(),
  );

  expect(response?.status).toBe(401);
  expect(response?.headers.get("Cache-Control")).toBe("no-store");
  await expect(response?.json()).resolves.toEqual({ error: "Invalid credentials" });
  await expect(env.DB.prepare("SELECT id FROM admin_sessions").all()).resolves.toMatchObject({
    results: [],
  });
});

test("admin login persists only a bearer hash and sends a strict secure cookie", async () => {
  const response = await handleAdminRequest(
    jsonRequest("/api/admin/login", { password: ADMIN_PASSWORD }),
    testEnv(),
  );

  expect(response?.status).toBe(204);
  expect(response?.headers.get("Cache-Control")).toBe("no-store");
  const cookie = response?.headers.get("Set-Cookie");
  expect(cookie).toMatch(/^rt22_admin_session=[A-Za-z0-9_-]{32}; Path=\/; HttpOnly; SameSite=Strict; Expires=/);
  expect(cookie).toContain("Secure");

  const token = cookie?.match(/^rt22_admin_session=([^;]+)/)?.[1];
  const session = await env.DB.prepare("SELECT token_hash, expires_at, revoked_at FROM admin_sessions").first<{
    token_hash: string;
    expires_at: string;
    revoked_at: string | null;
  }>();
  expect(session).toMatchObject({ revoked_at: null });
  expect(session?.token_hash).toBe(await sha256Hex(token ?? ""));
  expect(session?.token_hash).not.toBe(token);
  expect(new Date(session?.expires_at ?? "invalid").getTime()).toBeGreaterThan(Date.now());
});

test("admin login rejects a wrong content type without creating a session", async () => {
  const response = await handleAdminRequest(
    new Request("https://example.com/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ password: ADMIN_PASSWORD }),
    }),
    testEnv(),
  );

  expect(response?.status).toBe(415);
  await expect(response?.json()).resolves.toEqual({ error: "Unsupported media type" });
  await expect(env.DB.prepare("SELECT id FROM admin_sessions").all()).resolves.toMatchObject({
    results: [],
  });
});

test("admin login rejects an oversized declared JSON body without creating a session", async () => {
  const response = await handleAdminRequest(
    new Request("https://example.com/api/admin/login", {
      method: "POST",
      headers: { "Content-Length": "4097", "Content-Type": "application/json" },
      body: JSON.stringify({ password: ADMIN_PASSWORD }),
    }),
    testEnv(),
  );

  expect(response?.status).toBe(413);
  await expect(response?.json()).resolves.toEqual({ error: "Payload too large" });
  await expect(env.DB.prepare("SELECT id FROM admin_sessions").all()).resolves.toMatchObject({
    results: [],
  });
});

test("admin login rejects an oversized streamed JSON body without creating a session", async () => {
  let cancelled = false;
  const response = await handleAdminRequest(
    new Request("https://example.com/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(4097));
        },
        cancel() {
          cancelled = true;
        },
      }),
    }),
    testEnv(),
  );

  expect(response?.status).toBe(413);
  expect(cancelled).toBe(true);
  await expect(response?.json()).resolves.toEqual({ error: "Payload too large" });
  await expect(env.DB.prepare("SELECT id FROM admin_sessions").all()).resolves.toMatchObject({
    results: [],
  });
});

test("admin login rejects an oversized stream despite a small declared Content-Length", async () => {
  let cancelled = false;
  const response = await handleAdminRequest(
    new Request("https://example.com/api/admin/login", {
      method: "POST",
      headers: { "Content-Length": "1", "Content-Type": "application/json" },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(4097));
        },
        cancel() {
          cancelled = true;
        },
      }),
    }),
    testEnv(),
  );

  expect(response?.status).toBe(413);
  expect(cancelled).toBe(true);
  await expect(response?.json()).resolves.toEqual({ error: "Payload too large" });
  await expect(env.DB.prepare("SELECT id FROM admin_sessions").all()).resolves.toMatchObject({
    results: [],
  });
});

test("admin login rejects malformed JSON without creating a session", async () => {
  const response = await handleAdminRequest(
    new Request("https://example.com/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    }),
    testEnv(),
  );

  expect(response?.status).toBe(400);
  await expect(response?.json()).resolves.toEqual({ error: "Malformed JSON" });
  await expect(env.DB.prepare("SELECT id FROM admin_sessions").all()).resolves.toMatchObject({
    results: [],
  });
});

test("admin login rejects an overlong submitted password against a valid configured secret", async () => {
  const overlongPassword = "p".repeat(257);
  const response = await handleAdminRequest(
    jsonRequest("/api/admin/login", { password: overlongPassword }),
    testEnv(loginRateLimiter, ADMIN_PASSWORD),
  );

  expect(response?.status).toBe(401);
  await expect(response?.json()).resolves.toEqual({ error: "Invalid credentials" });
  await expect(env.DB.prepare("SELECT id FROM admin_sessions").all()).resolves.toMatchObject({
    results: [],
  });
});

test("admin login rejects an overlong configured secret with a normal submitted password", async () => {
  const response = await handleAdminRequest(
    jsonRequest("/api/admin/login", { password: ADMIN_PASSWORD }),
    testEnv(loginRateLimiter, "p".repeat(257)),
  );

  expect(response?.status).toBe(401);
  await expect(response?.json()).resolves.toEqual({ error: "Invalid credentials" });
  await expect(env.DB.prepare("SELECT id FROM admin_sessions").all()).resolves.toMatchObject({
    results: [],
  });
});

test("admin login fails closed when the configured password is empty", async () => {
  const response = await handleAdminRequest(
    jsonRequest("/api/admin/login", { password: ADMIN_PASSWORD }),
    testEnv(loginRateLimiter, ""),
  );

  expect(response?.status).toBe(401);
  await expect(response?.json()).resolves.toEqual({ error: "Invalid credentials" });
  await expect(env.DB.prepare("SELECT id FROM admin_sessions").all()).resolves.toMatchObject({
    results: [],
  });
});

test("expired and revoked admin sessions cannot access the event list", async () => {
  const expiredToken = "expired-admin-token";
  const revokedToken = "revoked-admin-token";
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO admin_sessions (id, token_hash, created_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?)",
    ).bind("expired", await sha256Hex(expiredToken), "2026-08-19T10:00:00.000Z", "2026-08-19T10:01:00.000Z", null),
    env.DB.prepare(
      "INSERT INTO admin_sessions (id, token_hash, created_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?)",
    ).bind("revoked", await sha256Hex(revokedToken), "2026-08-19T10:00:00.000Z", "2099-08-19T10:01:00.000Z", "2026-08-19T10:02:00.000Z"),
  ]);

  for (const token of [expiredToken, revokedToken]) {
    const response = await handleAdminRequest(
      new Request("https://example.com/api/admin/events", {
        headers: { Cookie: `rt22_admin_session=${token}` },
      }),
      testEnv(),
    );

    expect(response?.status).toBe(401);
  }
});

test("an unknown admin session cannot access the event list", async () => {
  const response = await handleAdminRequest(
    new Request("https://example.com/api/admin/events", {
      headers: { Cookie: "rt22_admin_session=unknown-admin-token" },
    }),
    testEnv(),
  );

  expect(response?.status).toBe(401);
  await expect(response?.json()).resolves.toEqual({ error: "Unauthorized" });
});

test("admin logout revokes the server session and clears its cookie", async () => {
  const login = await loginAdmin();
  const response = await handleAdminRequest(
    new Request("https://example.com/api/admin/logout", {
      method: "POST",
      headers: { Cookie: login.cookie },
    }),
    testEnv(),
  );

  expect(response?.status).toBe(204);
  expect(response?.headers.get("Cache-Control")).toBe("no-store");
  expect(response?.headers.get("Vary")).toBe("Cookie");
  expect(response?.headers.get("Set-Cookie")).toContain("rt22_admin_session=");
  expect(response?.headers.get("Set-Cookie")).toContain("Max-Age=0");
  const session = await env.DB.prepare("SELECT revoked_at FROM admin_sessions").first<{
    revoked_at: string | null;
  }>();
  expect(session?.revoked_at).not.toBeNull();
});

test("admin logout rejects an unknown session while clearing its cookie", async () => {
  const response = await handleAdminRequest(
    new Request("https://example.com/api/admin/logout", {
      method: "POST",
      headers: { Cookie: "rt22_admin_session=unknown-admin-token" },
    }),
    testEnv(),
  );

  expect(response?.status).toBe(401);
  expect(response?.headers.get("Set-Cookie")).toContain("Max-Age=0");
  await expect(response?.json()).resolves.toEqual({ error: "Unauthorized" });
});

test("an authenticated admin can create an event with a salted derived PIN", async () => {
  const login = await loginAdmin();
  const response = await handleAdminRequest(
    jsonRequest(
      "/api/admin/events",
      { name: "RT22 Sommerfest", eventDate: "2026-09-12", teamPin: "123456" },
      login.cookie,
    ),
    testEnv(),
  );

  expect(response?.status).toBe(201);
  expect(response?.headers.get("Cache-Control")).toBe("no-store");
  expect(response?.headers.get("Vary")).toBe("Cookie");
  await expect(response?.json()).resolves.toEqual({
    event: expect.objectContaining({
      id: expect.any(String),
      publicId: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
      name: "RT22 Sommerfest",
      eventDate: "2026-09-12",
      createdAt: expect.any(String),
    }),
  });
  const event = await env.DB.prepare(
    "SELECT public_id, team_pin_salt, team_pin_hash FROM events",
  ).first<{ public_id: string; team_pin_salt: string; team_pin_hash: string }>();
  expect(event?.public_id).toMatch(/^[A-Za-z0-9_-]{22}$/);
  expect(event?.team_pin_salt).toMatch(/^[A-Za-z0-9_-]{32}$/);
  expect(event?.team_pin_hash).toMatch(/^[0-9a-f]{64}$/);
  expect(`${event?.team_pin_salt}:${event?.team_pin_hash}`).not.toContain("123456");
});

test("event creation uses the bounded JSON reader", async () => {
  const login = await loginAdmin();
  const response = await handleAdminRequest(
    new Request("https://example.com/api/admin/events", {
      method: "POST",
      headers: { "Content-Type": "text/plain", Cookie: login.cookie },
      body: JSON.stringify({ name: "Event", eventDate: "2026-09-12", teamPin: "123456" }),
    }),
    testEnv(),
  );

  expect(response?.status).toBe(415);
  expect(response?.headers.get("Cache-Control")).toBe("no-store");
  expect(response?.headers.get("Vary")).toBe("Cookie");
  await expect(response?.json()).resolves.toEqual({ error: "Unsupported media type" });
  await expect(env.DB.prepare("SELECT id FROM events").all()).resolves.toMatchObject({ results: [] });
});

test("event creation rejects blank names, non-canonical dates, and non-six-digit PINs", async () => {
  const login = await loginAdmin();
  const invalidEvents = [
    { name: " ", eventDate: "2026-09-12", teamPin: "123456" },
    { name: "x".repeat(121), eventDate: "2026-09-12", teamPin: "123456" },
    { name: "Event", eventDate: "2026-02-29", teamPin: "123456" },
    { name: "Event", eventDate: "2026-9-12", teamPin: "123456" },
    { name: "Event", eventDate: "2026-09-12", teamPin: "12345a" },
  ];

  for (const body of invalidEvents) {
    const response = await handleAdminRequest(
      jsonRequest("/api/admin/events", body, login.cookie),
      testEnv(),
    );
    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toEqual({ error: "Invalid event" });
  }
  await expect(env.DB.prepare("SELECT id FROM events").all()).resolves.toMatchObject({ results: [] });
});

test("event list and internal-ID detail expose safe fields to an authenticated admin", async () => {
  const login = await loginAdmin();
  const create = await handleAdminRequest(
    jsonRequest(
      "/api/admin/events",
      { name: "RT22 Winterfest", eventDate: "2026-12-01", teamPin: "654321" },
      login.cookie,
    ),
    testEnv(),
  );
  const created = (await create?.json()) as { event: { id: string } };

  const list = await handleAdminRequest(
    new Request("https://example.com/api/admin/events", { headers: { Cookie: login.cookie } }),
    testEnv(),
  );
  expect(list?.status).toBe(200);
  expect(list?.headers.get("Cache-Control")).toBe("no-store");
  expect(list?.headers.get("Vary")).toBe("Cookie");
  await expect(list?.json()).resolves.toEqual({
    events: [
      expect.objectContaining({ id: created.event.id, name: "RT22 Winterfest" }),
    ],
  });

  const detail = await handleAdminRequest(
    new Request(`https://example.com/api/admin/events/${created.event.id}`, {
      headers: { Cookie: login.cookie },
    }),
    testEnv(),
  );
  expect(detail?.status).toBe(200);
  expect(detail?.headers.get("Cache-Control")).toBe("no-store");
  expect(detail?.headers.get("Vary")).toBe("Cookie");
  const detailBody = (await detail?.json()) as { event: Record<string, unknown> };
  expect(detailBody.event).toMatchObject({ id: created.event.id, name: "RT22 Winterfest" });
  expect(detailBody.event).not.toHaveProperty("teamPin");
  expect(detailBody.event).not.toHaveProperty("teamPinHash");
  expect(detailBody.event).not.toHaveProperty("teamPinSalt");
});

test("event detail reports a missing internal ID without leaking other event data", async () => {
  const login = await loginAdmin();
  const response = await handleAdminRequest(
    new Request("https://example.com/api/admin/events/no-such-internal-id", {
      headers: { Cookie: login.cookie },
    }),
    testEnv(),
  );

  expect(response?.status).toBe(404);
  await expect(response?.json()).resolves.toEqual({ error: "Event not found" });
});

test("admin login rejects requests throttled before credential verification", async () => {
  const response = await handleAdminRequest(
    jsonRequest("/api/admin/login", { password: ADMIN_PASSWORD }),
    testEnv({ limit: async () => ({ success: false }) }),
  );

  expect(response?.status).toBe(429);
  await expect(response?.json()).resolves.toEqual({ error: "Too many login attempts" });
  await expect(env.DB.prepare("SELECT id FROM admin_sessions").all()).resolves.toMatchObject({
    results: [],
  });
});

test("admin routes return method-specific Allow headers", async () => {
  const login = await loginAdmin();
  const cases = [
    [new Request("https://example.com/api/admin/login"), "POST"],
    [new Request("https://example.com/api/admin/logout"), "POST"],
    [new Request("https://example.com/api/admin/events", { method: "PUT", headers: { Cookie: login.cookie } }), "GET, POST"],
    [new Request("https://example.com/api/admin/events/event-id", { method: "POST" }), "GET"],
  ] as const;

  for (const [request, allow] of cases) {
    const response = await handleAdminRequest(request, testEnv());
    expect(response?.status).toBe(405);
    expect(response?.headers.get("Allow")).toBe(allow);
    expect(response?.headers.get("Cache-Control")).toBe("no-store");
  }
});

test("admin response headers merge Cookie into an existing Vary value", () => {
  const response = withAdminResponseHeaders(
    new Response("ok", { headers: { Vary: "Accept-Encoding" } }),
    true,
  );

  expect(response.headers.get("Vary")).toBe("Accept-Encoding, Cookie");
  expect(response.headers.get("Cache-Control")).toBe("no-store");
});

test("production Worker entry supports the complete admin event flow", async () => {
  const login = await SELF.fetch("https://example.com/api/admin/login", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ password: WORKER_ADMIN_PASSWORD }),
  });

  expect(login.status).toBe(204);
  expect(login.headers.get("Cache-Control")).toBe("no-store");
  const cookie = login.headers.get("Set-Cookie")?.split(";")[0];
  expect(cookie).toMatch(/^rt22_admin_session=[A-Za-z0-9_-]{32}$/);
  const token = cookie?.split("=")[1] ?? "";
  const session = await env.DB.prepare("SELECT token_hash FROM admin_sessions").first<{ token_hash: string }>();
  expect(session?.token_hash).toBe(await sha256Hex(token));

  const create = await SELF.fetch("https://example.com/api/admin/events", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie ?? "" },
    body: JSON.stringify({ name: "Worker event", eventDate: "2026-10-10", teamPin: "123456" }),
  });
  expect(create.status).toBe(201);
  expect(create.headers.get("Cache-Control")).toBe("no-store");
  expect(create.headers.get("Vary")).toBe("Cookie");
  const created = (await create.json()) as {
    event: { id: string; publicId: string; name: string; eventDate: string };
  };
  expect(created.event).toMatchObject({ name: "Worker event", eventDate: "2026-10-10" });

  const list = await SELF.fetch("https://example.com/api/admin/events", {
    headers: { Cookie: cookie ?? "" },
  });
  expect(list.status).toBe(200);
  expect(list.headers.get("Vary")).toBe("Cookie");
  const listed = (await list.json()) as {
    events: Array<{ id: string; publicId: string; name: string; eventDate: string }>;
  };
  expect(listed.events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: created.event.id,
        publicId: created.event.publicId,
        name: "Worker event",
        eventDate: "2026-10-10",
      }),
    ]),
  );

  const detail = await SELF.fetch(`https://example.com/api/admin/events/${created.event.id}`, {
    headers: { Cookie: cookie ?? "" },
  });
  expect(detail.status).toBe(200);
  const detailed = (await detail.json()) as { event: Record<string, unknown> };
  expect(detailed.event).toMatchObject({
    id: created.event.id,
    publicId: created.event.publicId,
    name: "Worker event",
    eventDate: "2026-10-10",
  });
  expect(detailed.event).not.toHaveProperty("teamPin");
  expect(detailed.event).not.toHaveProperty("teamPinHash");
  expect(detailed.event).not.toHaveProperty("teamPinSalt");

  const logout = await SELF.fetch("https://example.com/api/admin/logout", {
    method: "POST",
    headers: { Cookie: cookie ?? "" },
  });
  expect(logout.status).toBe(204);
  expect(logout.headers.get("Cache-Control")).toBe("no-store");
  expect(logout.headers.get("Vary")).toBe("Cookie");
  const revokedSession = await env.DB.prepare("SELECT revoked_at FROM admin_sessions").first<{
    revoked_at: string | null;
  }>();
  expect(revokedSession?.revoked_at).not.toBeNull();

  const revoked = await SELF.fetch("https://example.com/api/admin/events", {
    headers: { Cookie: cookie ?? "" },
  });
  expect(revoked.status).toBe(401);
  expect(revoked.headers.get("Cache-Control")).toBe("no-store");
  expect(revoked.headers.get("Vary")).toBe("Cookie");
  await expect(revoked.json()).resolves.toEqual({ error: "Unauthorized" });
});

function testEnv(rateLimiter = loginRateLimiter, adminPassword: string | undefined = ADMIN_PASSWORD) {
  return {
    DB: env.DB,
    ADMIN_PASSWORD: adminPassword,
    ADMIN_LOGIN_RATE_LIMITER: rateLimiter,
  };
}

function jsonRequest(path: string, body: unknown, cookie?: string): Request {
  return new Request(`https://example.com${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function loginAdmin(): Promise<{ cookie: string }> {
  const response = await handleAdminRequest(
    jsonRequest("/api/admin/login", { password: ADMIN_PASSWORD }),
    testEnv(),
  );
  const cookie = response?.headers.get("Set-Cookie")?.split(";")[0];

  if (response?.status !== 204 || !cookie) {
    throw new Error("Test admin login did not create a session");
  }

  return { cookie };
}
