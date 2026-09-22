import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { beforeAll, beforeEach, expect, test } from "vitest";

declare const __RT22_D1_MIGRATIONS__: {
  name: string;
  queries: string[];
}[];

const SPONSOR_A_ACCESS_ID = "A".repeat(32);
const SPONSOR_B_ACCESS_ID = "B".repeat(32);
const VOUCHER_A_AVAILABLE_ID = "a".repeat(22);
const VOUCHER_A_REDEEMED_ID = "r".repeat(22);
const VOUCHER_B_ID = "b".repeat(22);
const VOUCHER_TYPE_A_BEER_ID = "voucher-type-a-beer";
const VOUCHER_TYPE_A_FOOD_ID = "voucher-type-a-food";
const VOUCHER_TYPE_A_EMPTY_ID = "voucher-type-a-empty";
const VOUCHER_TYPE_B_ID = "voucher-type-b";

beforeAll(async () => {
  await applyD1Migrations(env.DB, __RT22_D1_MIGRATIONS__, "task_5_migrations");
});

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM admin_sessions"),
    env.DB.prepare("DELETE FROM events"),
  ]);
  await seedSponsorFixtures();
});

test("an invalid sponsor access locator safe-fails without exposing sponsor data", async () => {
  for (const accessId of ["short", "not%20an%20opaque%20identifier", "x".repeat(512)]) {
    const response = await SELF.fetch(`https://example.com/api/sponsor/${accessId}`);

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ error: "Sponsor not found" });
  }
});

test("a sponsor read returns only its own safe event summary, totals, and vouchers", async () => {
  const before = await voucherState();
  const response = await SELF.fetch(`https://example.com/api/sponsor/${SPONSOR_A_ACCESS_ID}`);

  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  await expect(response.json()).resolves.toEqual({
    event: {
      name: "RT22 Sommerfest",
      eventDate: "2026-08-19",
    },
    sponsor: {
      name: "Sponsor A",
    },
    totals: {
      total: 2,
      available: 1,
      redeemed: 1,
    },
    voucherTypes: [
      {
        name: "1 Bier",
        totals: { total: 1, available: 1, redeemed: 0 },
        vouchers: [{ publicId: VOUCHER_A_AVAILABLE_ID, displayCode: "AAAA-2222", status: "available", voucherType: { name: "1 Bier" } }],
      },
      {
        name: "1 Essen",
        totals: { total: 1, available: 0, redeemed: 1 },
        vouchers: [{ publicId: VOUCHER_A_REDEEMED_ID, displayCode: "RRRR-8888", status: "redeemed", voucherType: { name: "1 Essen" } }],
      },
    ],
  });
  expect(await voucherState()).toEqual(before);
});

test("same-event Sponsor A and Sponsor B cannot enumerate one another", async () => {
  const cases = [
    {
      accessId: SPONSOR_A_ACCESS_ID,
      ownName: "Sponsor A",
      otherName: "Sponsor B",
      otherCode: "BBBB-3333",
      otherPublicId: VOUCHER_B_ID,
      otherInternalId: "sponsor-internal-b",
    },
    {
      accessId: SPONSOR_B_ACCESS_ID,
      ownName: "Sponsor B",
      otherName: "Sponsor A",
      otherCode: "AAAA-2222",
      otherPublicId: VOUCHER_A_AVAILABLE_ID,
      otherInternalId: "sponsor-internal-a",
    },
  ];

  for (const isolationCase of cases) {
    const response = await SELF.fetch(
      `https://example.com/api/sponsor/${isolationCase.accessId}`,
    );
    const body = (await response.json()) as {
      event: { name: string };
      sponsor: { name: string };
    };
    const payload = JSON.stringify(body);

    expect(response.status).toBe(200);
    expect(body.event.name).toBe("RT22 Sommerfest");
    expect(body.sponsor.name).toBe(isolationCase.ownName);
    expect(payload).not.toContain(isolationCase.otherName);
    expect(payload).not.toContain(isolationCase.otherCode);
    expect(payload).not.toContain(isolationCase.otherPublicId);
    expect(payload).not.toContain(isolationCase.otherInternalId);
  }
});

test("the sponsor endpoint is read-only and returns an exact Allow header", async () => {
  for (const method of ["POST", "PUT", "DELETE"]) {
    const response = await SELF.fetch(`https://example.com/api/sponsor/${SPONSOR_A_ACCESS_ID}`, {
      method,
    });

    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  }
});

test("a public voucher locator exposes presentation status but never a redeem authority", async () => {
  const response = await SELF.fetch(`https://example.com/api/voucher/${VOUCHER_A_REDEEMED_ID}`);

  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  const body = await response.json();
  expect(body).toEqual({
    event: {
      name: "RT22 Sommerfest",
      eventDate: "2026-08-19",
    },
    sponsor: {
      name: "Sponsor A",
    },
    voucher: {
      publicId: VOUCHER_A_REDEEMED_ID,
      displayCode: "RRRR-8888",
      status: "redeemed",
      voucherType: { name: "1 Essen" },
    },
  });
  expect(body).not.toHaveProperty("redeem");
  expect(JSON.stringify(body)).not.toContain("redeemed_by_session_id");
  expect(JSON.stringify(body)).not.toContain("sponsor-internal-a");
});

test("invalid public voucher locators safe-fail and the endpoint is GET-only", async () => {
  const invalid = await SELF.fetch("https://example.com/api/voucher/not-a-valid-id");
  expect(invalid.status).toBe(404);
  expect(invalid.headers.get("Cache-Control")).toBe("no-store");
  await expect(invalid.json()).resolves.toEqual({ error: "Voucher not found" });

  const mutationAttempt = await SELF.fetch(
    `https://example.com/api/voucher/${VOUCHER_A_AVAILABLE_ID}`,
    { method: "POST" },
  );
  expect(mutationAttempt.status).toBe(405);
  expect(mutationAttempt.headers.get("Allow")).toBe("GET");
  expect(mutationAttempt.headers.get("Cache-Control")).toBe("no-store");
  expect(await voucherState()).toEqual([
    { id: "voucher-a-available", redeemed_at: null },
    { id: "voucher-a-redeemed", redeemed_at: "2026-08-19T18:00:00.000Z" },
    { id: "voucher-b", redeemed_at: null },
  ]);
});

async function seedSponsorFixtures(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO events (
        id, public_id, name, event_date, team_pin_salt, team_pin_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      "event-internal-a",
      "event-public-a",
      "RT22 Sommerfest",
      "2026-08-19",
      "pin-salt-a",
      "pin-hash-a",
      "2026-01-01T00:00:00.000Z",
    ),
    env.DB.prepare(
      "INSERT INTO sponsors (id, event_id, name, access_id, created_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(
      "sponsor-internal-a",
      "event-internal-a",
      "Sponsor A",
      SPONSOR_A_ACCESS_ID,
      "2026-01-03T00:00:00.000Z",
    ),
    env.DB.prepare(
      "INSERT INTO sponsors (id, event_id, name, access_id, created_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(
      "sponsor-internal-b",
      "event-internal-a",
      "Sponsor B",
      SPONSOR_B_ACCESS_ID,
      "2026-01-04T00:00:00.000Z",
    ),
    env.DB.prepare(
      "INSERT INTO voucher_types (id, event_id, sponsor_id, name, created_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(
      VOUCHER_TYPE_A_BEER_ID,
      "event-internal-a",
      "sponsor-internal-a",
      "1 Bier",
      "2026-01-04T10:00:00.000Z",
    ),
    env.DB.prepare(
      "INSERT INTO voucher_types (id, event_id, sponsor_id, name, created_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(
      VOUCHER_TYPE_A_FOOD_ID,
      "event-internal-a",
      "sponsor-internal-a",
      "1 Essen",
      "2026-01-04T10:01:00.000Z",
    ),
    env.DB.prepare(
      "INSERT INTO voucher_types (id, event_id, sponsor_id, name, created_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(
      VOUCHER_TYPE_A_EMPTY_ID,
      "event-internal-a",
      "sponsor-internal-a",
      "2 Getränke",
      "2026-01-04T10:01:30.000Z",
    ),
    env.DB.prepare(
      "INSERT INTO voucher_types (id, event_id, sponsor_id, name, created_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(
      VOUCHER_TYPE_B_ID,
      "event-internal-a",
      "sponsor-internal-b",
      "1 Bier",
      "2026-01-04T10:02:00.000Z",
    ),
    env.DB.prepare(
      `INSERT INTO vouchers (
        id, public_id, event_id, sponsor_id, voucher_type_id, display_code, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      "voucher-a-available",
      VOUCHER_A_AVAILABLE_ID,
      "event-internal-a",
      "sponsor-internal-a",
      VOUCHER_TYPE_A_BEER_ID,
      "AAAA-2222",
      "2026-01-05T00:00:00.000Z",
    ),
    env.DB.prepare(
      `INSERT INTO vouchers (
        id, public_id, event_id, sponsor_id, voucher_type_id, display_code, redeemed_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      "voucher-a-redeemed",
      VOUCHER_A_REDEEMED_ID,
      "event-internal-a",
      "sponsor-internal-a",
      VOUCHER_TYPE_A_FOOD_ID,
      "RRRR-8888",
      "2026-08-19T18:00:00.000Z",
      "2026-01-06T00:00:00.000Z",
    ),
    env.DB.prepare(
      `INSERT INTO vouchers (
        id, public_id, event_id, sponsor_id, voucher_type_id, display_code, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      "voucher-b",
      VOUCHER_B_ID,
      "event-internal-a",
      "sponsor-internal-b",
      VOUCHER_TYPE_B_ID,
      "BBBB-3333",
      "2026-01-07T00:00:00.000Z",
    ),
  ]);
}

async function voucherState(): Promise<Array<{ id: string; redeemed_at: string | null }>> {
  const rows = await env.DB.prepare(
    "SELECT id, redeemed_at FROM vouchers ORDER BY id",
  ).all<{ id: string; redeemed_at: string | null }>();
  return rows.results;
}
