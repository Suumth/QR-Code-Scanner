import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";

import { handleAdminRequest } from "../../worker/features/admin/routes";
import { createVoucherBatch } from "../../worker/features/issuance/factory";
import { insertVoucherBatch } from "../../worker/features/issuance/repository";
import type { NewVoucher } from "../../worker/features/issuance/types";

declare const __RT22_D1_MIGRATIONS__: {
  name: string;
  queries: string[];
}[];

const ADMIN_PASSWORD = crypto.randomUUID();
const loginRateLimiter = { limit: async () => ({ success: true }) };

beforeAll(async () => {
  await applyD1Migrations(env.DB, __RT22_D1_MIGRATIONS__, "task_4_migrations");
});

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM admin_sessions"),
    env.DB.prepare("DELETE FROM events"),
  ]);
});

test("production Worker entry rejects unauthenticated sponsor issuance", async () => {
  const response = await SELF.fetch("https://example.com/api/admin/events/event-id/sponsors", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Heidelberg Brewery" }),
  });

  expect(response.status).toBe(401);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get("Vary")).toBe("Cookie");
  await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
});

test("sponsor issuance rejects invalid input and does not create rows", async () => {
  const login = await loginAdmin();
  const event = await createEvent(login.cookie);
  const invalidBodies = [{ name: " " }, { name: "x".repeat(121) }, {}, { name: 7 }];

  for (const body of invalidBodies) {
    const response = await handleAdminRequest(
      jsonRequest(`/api/admin/events/${event.id}/sponsors`, body, login.cookie),
      testEnv(),
    );

    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toEqual({ error: "Invalid sponsor" });
  }

  await expect(env.DB.prepare("SELECT id FROM sponsors").all()).resolves.toMatchObject({ results: [] });
});

test("sponsor issuance accepts only bounded application JSON", async () => {
  const login = await loginAdmin();
  const event = await createEvent(login.cookie);
  const response = await handleAdminRequest(
    new Request(`https://example.com/api/admin/events/${event.id}/sponsors`, {
      method: "POST",
      headers: { "Content-Type": "text/plain", Cookie: login.cookie },
      body: JSON.stringify({ name: "Heidelberg Brewery" }),
    }),
    testEnv(),
  );

  expect(response?.status).toBe(415);
  await expect(response?.json()).resolves.toEqual({ error: "Unsupported media type" });
  await expect(env.DB.prepare("SELECT id FROM sponsors").all()).resolves.toMatchObject({ results: [] });
});

test("sponsor issuance requires an existing event and returns a reconstructable same-origin URL", async () => {
  const login = await loginAdmin();
  const response = await handleAdminRequest(
    jsonRequest("/api/admin/events/missing-event/sponsors", { name: "Heidelberg Brewery" }, login.cookie),
    testEnv(),
  );

  expect(response?.status).toBe(404);
  await expect(response?.json()).resolves.toEqual({ error: "Event not found" });

  const event = await createEvent(login.cookie);
  const created = await createSponsor(event.id, login.cookie);
  expect(created.sponsor).toEqual({
    id: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
    eventId: event.id,
    name: "Heidelberg Brewery",
    accessId: expect.stringMatching(/^[A-Za-z0-9_-]{32}$/),
    createdAt: expect.any(String),
  });
  expect(created.sponsorUrl).toBe(`https://example.com/s/${created.sponsor.accessId}`);

  const stored = await env.DB.prepare(
    "SELECT event_id, name, access_id FROM sponsors WHERE id = ?",
  ).bind(created.sponsor.id).first<{ event_id: string; name: string; access_id: string }>();
  expect(stored).toEqual({
    event_id: event.id,
    name: "Heidelberg Brewery",
    access_id: created.sponsor.accessId,
  });

  const another = await handleAdminRequest(
    jsonRequest(`/api/admin/events/${event.id}/sponsors`, { name: "Another Sponsor" }, login.cookie),
    testEnv(),
  );
  const anotherBody = (await another?.json()) as { sponsor: { accessId: string } };
  expect(another?.status).toBe(201);
  expect(anotherBody.sponsor.accessId).not.toBe(created.sponsor.accessId);
});

test("voucher type creation trims names, rejects invalid and duplicate names, and scopes names to sponsors", async () => {
  const login = await loginAdmin();
  const event = await createEvent(login.cookie);
  const sponsorA = await createSponsor(event.id, login.cookie);
  const sponsorB = await createSponsor(event.id, login.cookie);

  const created = await createVoucherType(event.id, sponsorA.sponsor.id, "  1 Bier  ", login.cookie);
  expect(created.voucherType).toMatchObject({
    id: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
    eventId: event.id,
    sponsorId: sponsorA.sponsor.id,
    name: "1 Bier",
    createdAt: expect.any(String),
  });

  const duplicate = await handleAdminRequest(
    jsonRequest(
      `/api/admin/events/${event.id}/sponsors/${sponsorA.sponsor.id}/voucher-types`,
      { name: "1 bier" },
      login.cookie,
    ),
    testEnv(),
  );
  expect(duplicate?.status).toBe(409);
  await expect(duplicate?.json()).resolves.toEqual({ error: "Voucher type already exists" });

  const sameNameForAnotherSponsor = await createVoucherType(
    event.id,
    sponsorB.sponsor.id,
    "1 Bier",
    login.cookie,
  );
  expect(sameNameForAnotherSponsor.voucherType.name).toBe("1 Bier");

  for (const name of [" ", "x".repeat(81), "line\nbreak", 123]) {
    const response = await handleAdminRequest(
      jsonRequest(
        `/api/admin/events/${event.id}/sponsors/${sponsorA.sponsor.id}/voucher-types`,
        { name },
        login.cookie,
      ),
      testEnv(),
    );
    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toEqual({ error: "Invalid voucher type name" });
  }

  const otherEvent = await createEvent(login.cookie);
  const wrongScope = await handleAdminRequest(
    jsonRequest(
      `/api/admin/events/${otherEvent.id}/sponsors/${sponsorA.sponsor.id}/voucher-types`,
      { name: "1 Bier" },
      login.cookie,
    ),
    testEnv(),
  );
  expect(wrongScope?.status).toBe(404);
  await expect(wrongScope?.json()).resolves.toEqual({ error: "Sponsor not found" });
});

test("typed issuance stores every voucher under one type and accumulates additional vouchers", async () => {
  const login = await loginAdmin();
  const event = await createEvent(login.cookie);
  const sponsor = await createSponsor(event.id, login.cookie);
  const type = await createVoucherType(event.id, sponsor.sponsor.id, "1 Bier", login.cookie);

  const first = await issueVouchers(event.id, sponsor.sponsor.id, type.voucherType.id, 3, login.cookie);
  expect(first).toMatchObject({ issuedCount: 3, totalVoucherTypeCount: 3, totalSponsorCount: 3 });

  const second = await issueVouchers(event.id, sponsor.sponsor.id, type.voucherType.id, 2, login.cookie);
  expect(second).toMatchObject({ issuedCount: 2, totalVoucherTypeCount: 5, totalSponsorCount: 5 });

  const rows = await env.DB.prepare(
    "SELECT voucher_type_id FROM vouchers WHERE event_id = ? AND sponsor_id = ? ORDER BY id",
  )
    .bind(event.id, sponsor.sponsor.id)
    .all<{ voucher_type_id: string }>();
  expect(rows.results).toHaveLength(5);
  expect(rows.results.every(({ voucher_type_id }) => voucher_type_id === type.voucherType.id)).toBe(true);
  await expect(env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'issuance_batches'").all()).resolves.toMatchObject({ results: [] });
});

test("typed issuance rejects a voucher type from another sponsor or event and unauthenticated writes", async () => {
  const login = await loginAdmin();
  const eventA = await createEvent(login.cookie);
  const sponsorA = await createSponsor(eventA.id, login.cookie);
  const typeA = await createVoucherType(eventA.id, sponsorA.sponsor.id, "1 Bier", login.cookie);
  const eventB = await createEvent(login.cookie);
  const sponsorB = await createSponsor(eventB.id, login.cookie);

  const crossScope = await handleAdminRequest(
    jsonRequest(
      `/api/admin/events/${eventB.id}/sponsors/${sponsorB.sponsor.id}/voucher-types/${typeA.voucherType.id}/vouchers`,
      { count: 1 },
      login.cookie,
    ),
    testEnv(),
  );
  expect(crossScope?.status).toBe(404);
  await expect(crossScope?.json()).resolves.toEqual({ error: "Voucher type not found" });

  const unauthenticated = await handleAdminRequest(
    jsonRequest(
      `/api/admin/events/${eventA.id}/sponsors/${sponsorA.sponsor.id}/voucher-types`,
      { name: "1 Essen" },
    ),
    testEnv(),
  );
  expect(unauthenticated?.status).toBe(401);
  await expect(unauthenticated?.json()).resolves.toEqual({ error: "Unauthorized" });
});

test("voucher issuance validates sponsor ownership and the inclusive 1 through 500 count range", async () => {
  const login = await loginAdmin();
  const event = await createEvent(login.cookie);
  const sponsor = await createSponsor(event.id, login.cookie);
  const type = await createVoucherType(event.id, sponsor.sponsor.id, "1 Bier", login.cookie);
  const invalidCounts = [0, 501, 1.5, "3", null, undefined];

  for (const count of invalidCounts) {
    const response = await handleAdminRequest(
      jsonRequest(`/api/admin/events/${event.id}/sponsors/${sponsor.sponsor.id}/voucher-types/${type.voucherType.id}/vouchers`, { count }, login.cookie),
      testEnv(),
    );
    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toEqual({ error: "Invalid voucher count" });
  }

  const missing = await handleAdminRequest(
    jsonRequest(`/api/admin/events/${event.id}/sponsors/not-a-sponsor/voucher-types/${type.voucherType.id}/vouchers`, { count: 1 }, login.cookie),
    testEnv(),
  );
  expect(missing?.status).toBe(404);
  await expect(missing?.json()).resolves.toEqual({ error: "Sponsor not found" });
  await expect(env.DB.prepare("SELECT id FROM vouchers").all()).resolves.toMatchObject({ results: [] });
});

test("voucher batch creates unique opaque public identifiers and manual codes atomically", async () => {
  const login = await loginAdmin();
  const event = await createEvent(login.cookie);
  const createdSponsor = await createSponsor(event.id, login.cookie);
  const type = await createVoucherType(event.id, createdSponsor.sponsor.id, "1 Bier", login.cookie);
  const response = await handleAdminRequest(
    jsonRequest(`/api/admin/events/${event.id}/sponsors/${createdSponsor.sponsor.id}/voucher-types/${type.voucherType.id}/vouchers`, { count: 12 }, login.cookie),
    testEnv(),
  );

  expect(response?.status).toBe(201);
  expect(response?.headers.get("Cache-Control")).toBe("no-store");
  expect(response?.headers.get("Vary")).toBe("Cookie");
  const body = (await response?.json()) as {
    issuedCount: number;
    totalSponsorCount: number;
    sponsor: { id: string; eventId: string; accessId: string };
    sponsorUrl: string;
  };
  expect(body).toEqual({
    issuedCount: 12,
    totalVoucherTypeCount: 12,
    totalSponsorCount: 12,
    voucherType: expect.objectContaining({ id: type.voucherType.id, name: "1 Bier" }),
    sponsor: expect.objectContaining({
      id: createdSponsor.sponsor.id,
      eventId: event.id,
      accessId: createdSponsor.sponsor.accessId,
    }),
    sponsorUrl: `https://example.com/s/${createdSponsor.sponsor.accessId}`,
  });
  expect(body.sponsor).not.toHaveProperty("teamPin");
  expect(body.sponsor).not.toHaveProperty("teamPinHash");
  expect(body.sponsor).not.toHaveProperty("session");

  const vouchers = await env.DB.prepare(
    "SELECT public_id, display_code, event_id, sponsor_id, voucher_type_id, redeemed_at, redeemed_by_session_id FROM vouchers ORDER BY id",
  ).all<{
    public_id: string;
    display_code: string;
    event_id: string;
    sponsor_id: string;
    voucher_type_id: string;
    redeemed_at: string | null;
    redeemed_by_session_id: string | null;
  }>();
  expect(vouchers.results).toHaveLength(12);
  expect(new Set(vouchers.results.map((voucher) => voucher.public_id)).size).toBe(12);
  expect(new Set(vouchers.results.map((voucher) => voucher.display_code)).size).toBe(12);
  for (const voucher of vouchers.results) {
    expect(voucher).toMatchObject({
      event_id: event.id,
      sponsor_id: createdSponsor.sponsor.id,
      voucher_type_id: type.voucherType.id,
      redeemed_at: null,
      redeemed_by_session_id: null,
    });
    expect(voucher.public_id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(voucher.display_code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/);
  }

  const nextBatch = await handleAdminRequest(
    jsonRequest(`/api/admin/events/${event.id}/sponsors/${createdSponsor.sponsor.id}/voucher-types/${type.voucherType.id}/vouchers`, { count: 3 }, login.cookie),
    testEnv(),
  );
  expect(nextBatch?.status).toBe(201);
  await expect(nextBatch?.json()).resolves.toMatchObject({ issuedCount: 3, totalVoucherTypeCount: 15, totalSponsorCount: 15 });
});

test("voucher issuance accepts the inclusive 500-voucher upper limit", async () => {
  const login = await loginAdmin();
  const event = await createEvent(login.cookie);
  const sponsor = await createSponsor(event.id, login.cookie);
  const type = await createVoucherType(event.id, sponsor.sponsor.id, "1 Bier", login.cookie);
  const response = await handleAdminRequest(
    jsonRequest(`/api/admin/events/${event.id}/sponsors/${sponsor.sponsor.id}/voucher-types/${type.voucherType.id}/vouchers`, { count: 500 }, login.cookie),
    testEnv(),
  );

  expect(response?.status).toBe(201);
  await expect(response?.json()).resolves.toMatchObject({ issuedCount: 500, totalVoucherTypeCount: 500, totalSponsorCount: 500 });
  await expect(
    env.DB.prepare("SELECT COUNT(*) AS count FROM vouchers WHERE sponsor_id = ?").bind(sponsor.sponsor.id).first<{ count: number }>(),
  ).resolves.toEqual({ count: 500 });
});

test("a failed D1 voucher batch rolls back every statement", async () => {
  const login = await loginAdmin();
  const event = await createEvent(login.cookie);
  const sponsor = await createSponsor(event.id, login.cookie);
  const type = await createVoucherType(event.id, sponsor.sponsor.id, "1 Bier", login.cookie);

  await expect(
    insertVoucherBatch(env.DB, [
      {
        id: "batch-rollback-one",
        publicId: "batch-rollback-public-one",
        eventId: event.id,
        sponsorId: sponsor.sponsor.id,
        voucherTypeId: type.voucherType.id,
        displayCode: "ABCD-EFGH",
        createdAt: "2026-10-10T00:00:00.000Z",
      },
      {
        id: "batch-rollback-two",
        publicId: "batch-rollback-public-two",
        eventId: event.id,
        sponsorId: sponsor.sponsor.id,
        voucherTypeId: type.voucherType.id,
        displayCode: "ABCD-EFGH",
        createdAt: "2026-10-10T00:00:00.000Z",
      },
    ]),
  ).rejects.toThrow();

  await expect(
    env.DB.prepare("SELECT id FROM vouchers WHERE id LIKE 'batch-rollback-%'").all(),
  ).resolves.toMatchObject({ results: [] });
});

test("bulk voucher insertion uses a fixed three-statement D1 batch for 500 vouchers", async () => {
  const queries: string[] = [];
  const bindings: unknown[][] = [];
  const database = {
    prepare: vi.fn((query: string) => {
      queries.push(query);
      return {
        bind: (...values: unknown[]) => {
          bindings.push(values);
          return {};
        },
      };
    }),
    batch: vi.fn().mockResolvedValue([{ results: [] }, { results: [{ count: 500 }] }, { results: [{ count: 500 }] }]),
  } as unknown as D1Database;
  const vouchers = Array.from({ length: 500 }, (_, index): NewVoucher => ({
    id: `internal-${index}`,
    publicId: `public-${index}`,
    eventId: "event",
    sponsorId: "sponsor",
    voucherTypeId: "type",
    displayCode: `ABCD-${String(index).padStart(4, "0")}`,
    createdAt: "2026-10-10T00:00:00.000Z",
  }));

  await expect(insertVoucherBatch(database, vouchers)).resolves.toEqual({ totalSponsorCount: 500, totalVoucherTypeCount: 500 });
  expect(database.prepare).toHaveBeenCalledTimes(3);
  expect(database.batch).toHaveBeenCalledTimes(1);
  expect(queries[0]).toContain("json_each(?1)");
  expect(queries.every((query) => query.length < 100_000)).toBe(true);
  expect(bindings[0]).toHaveLength(1);
  expect(JSON.parse(bindings[0][0] as string)).toHaveLength(500);
  expect(new TextEncoder().encode(bindings[0][0] as string).byteLength).toBeLessThan(2 * 1024 * 1024);
  expect(bindings[1]).toEqual(["sponsor"]);
  expect(bindings[2]).toEqual(["type"]);
});

test("voucher batch generation stops safely if entropy repeatedly collides", () => {
  const randomValues = vi.spyOn(crypto, "getRandomValues").mockImplementation((values) => {
    if (values) {
      new Uint8Array(values.buffer, values.byteOffset, values.byteLength).fill(0);
    }
    return values;
  });

  try {
    expect(() => createVoucherBatch("event", "sponsor", "type", 2, "2026-10-10T00:00:00.000Z")).toThrow(
      "Unable to generate a unique voucher batch",
    );
  } finally {
    randomValues.mockRestore();
  }
}, 100);

test("issuance routes reject unsupported methods and sponsor access locators cannot authorize writes", async () => {
  const login = await loginAdmin();
  const event = await createEvent(login.cookie);
  const sponsor = await createSponsor(event.id, login.cookie);
  const type = await createVoucherType(event.id, sponsor.sponsor.id, "1 Bier", login.cookie);
  const cases = [
    [new Request(`https://example.com/api/admin/events/${event.id}/sponsors`, { method: "PUT", headers: { Cookie: login.cookie } }), "GET, POST"],
    [new Request(`https://example.com/api/admin/events/${event.id}/sponsors/${sponsor.sponsor.id}/voucher-types/${type.voucherType.id}/vouchers`, { method: "PUT", headers: { Cookie: login.cookie } }), "POST"],
  ] as const;

  for (const [request, allow] of cases) {
    const response = await handleAdminRequest(request, testEnv());
    expect(response?.status).toBe(405);
    expect(response?.headers.get("Allow")).toBe(allow);
    expect(response?.headers.get("Cache-Control")).toBe("no-store");
    expect(response?.headers.get("Vary")).toBe("Cookie");
  }

  const locatorAttempt = await handleAdminRequest(
    jsonRequest(`/api/admin/events/${event.id}/sponsors/${sponsor.sponsor.id}/voucher-types/${type.voucherType.id}/vouchers`, { count: 1 }, `sponsor_access=${sponsor.sponsor.accessId}`),
    testEnv(),
  );
  expect(locatorAttempt?.status).toBe(401);
  await expect(locatorAttempt?.json()).resolves.toEqual({ error: "Unauthorized" });
  await expect(env.DB.prepare("SELECT id FROM vouchers").all()).resolves.toMatchObject({ results: [] });
});

test("production Worker entry issues a sponsor and voucher batch after real admin login", async () => {
  const login = await SELF.fetch("https://example.com/api/admin/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "vitest-only-admin-password" }),
  });
  expect(login.status).toBe(204);
  const cookie = login.headers.get("Set-Cookie")?.split(";")[0];

  const event = await SELF.fetch("https://example.com/api/admin/events", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie ?? "" },
    body: JSON.stringify({ name: "SELF issuance event", eventDate: "2026-11-11", teamPin: "123456" }),
  });
  expect(event.status).toBe(201);
  const eventBody = (await event.json()) as { event: { id: string } };

  const sponsor = await SELF.fetch(`https://example.com/api/admin/events/${eventBody.event.id}/sponsors`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie ?? "" },
    body: JSON.stringify({ name: "SELF Sponsor" }),
  });
  expect(sponsor.status).toBe(201);
  const sponsorBody = (await sponsor.json()) as { sponsor: { id: string; accessId: string }; sponsorUrl: string };
  expect(sponsorBody.sponsorUrl).toBe(`https://example.com/s/${sponsorBody.sponsor.accessId}`);

  const voucherType = await SELF.fetch(`https://example.com/api/admin/events/${eventBody.event.id}/sponsors/${sponsorBody.sponsor.id}/voucher-types`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie ?? "" },
    body: JSON.stringify({ name: "1 Bier" }),
  });
  expect(voucherType.status).toBe(201);
  const voucherTypeBody = (await voucherType.json()) as { voucherType: { id: string } };

  const vouchers = await SELF.fetch(`https://example.com/api/admin/events/${eventBody.event.id}/sponsors/${sponsorBody.sponsor.id}/voucher-types/${voucherTypeBody.voucherType.id}/vouchers`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie ?? "" },
    body: JSON.stringify({ count: 2 }),
  });
  expect(vouchers.status).toBe(201);
  await expect(vouchers.json()).resolves.toMatchObject({ issuedCount: 2, totalSponsorCount: 2 });
  await expect(env.DB.prepare("SELECT id FROM vouchers WHERE sponsor_id = ?").bind(sponsorBody.sponsor.id).all()).resolves.toMatchObject({
    results: [{ id: expect.any(String) }, { id: expect.any(String) }],
  });
});

async function createEvent(cookie: string): Promise<{ id: string }> {
  const response = await handleAdminRequest(
    jsonRequest("/api/admin/events", { name: "Voucher event", eventDate: "2026-10-10", teamPin: "123456" }, cookie),
    testEnv(),
  );
  if (response?.status !== 201) {
    throw new Error("Test event creation failed");
  }
  return ((await response.json()) as { event: { id: string } }).event;
}

async function createSponsor(
  eventId: string,
  cookie: string,
): Promise<{ sponsor: { id: string; eventId: string; name: string; accessId: string; createdAt: string }; sponsorUrl: string }> {
  const response = await handleAdminRequest(
    jsonRequest(`/api/admin/events/${eventId}/sponsors`, { name: "Heidelberg Brewery" }, cookie),
    testEnv(),
  );
  if (response?.status !== 201) {
    throw new Error("Test sponsor creation failed");
  }
  return (await response.json()) as {
    sponsor: { id: string; eventId: string; name: string; accessId: string; createdAt: string };
    sponsorUrl: string;
  };
}

async function createVoucherType(
  eventId: string,
  sponsorId: string,
  name: string,
  cookie: string,
): Promise<{ voucherType: { id: string; eventId: string; sponsorId: string; name: string; createdAt: string } }> {
  const response = await handleAdminRequest(
    jsonRequest(`/api/admin/events/${eventId}/sponsors/${sponsorId}/voucher-types`, { name }, cookie),
    testEnv(),
  );
  if (response?.status !== 201) {
    throw new Error(`Test voucher type creation failed with ${response?.status}`);
  }
  return (await response.json()) as {
    voucherType: { id: string; eventId: string; sponsorId: string; name: string; createdAt: string };
  };
}

async function issueVouchers(
  eventId: string,
  sponsorId: string,
  voucherTypeId: string,
  count: number,
  cookie: string,
): Promise<{ issuedCount: number; totalVoucherTypeCount: number; totalSponsorCount: number }> {
  const response = await handleAdminRequest(
    jsonRequest(
      `/api/admin/events/${eventId}/sponsors/${sponsorId}/voucher-types/${voucherTypeId}/vouchers`,
      { count },
      cookie,
    ),
    testEnv(),
  );
  if (response?.status !== 201) {
    throw new Error(`Test voucher issuance failed with ${response?.status}`);
  }
  return (await response.json()) as {
    issuedCount: number;
    totalVoucherTypeCount: number;
    totalSponsorCount: number;
  };
}

function testEnv() {
  return {
    DB: env.DB,
    ADMIN_PASSWORD,
    ADMIN_LOGIN_RATE_LIMITER: loginRateLimiter,
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
