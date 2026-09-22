import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { beforeAll, beforeEach, expect, test } from "vitest";

import { sha256Hex } from "../../worker/security/crypto";

declare const __RT22_D1_MIGRATIONS__: {
  name: string;
  queries: string[];
}[];

const TOKEN = "event-summary-session-token";
const EVENT_A = { id: "summary-event-a", publicId: "a".repeat(22) };
const EVENT_B = { id: "summary-event-b", publicId: "b".repeat(22) };

beforeAll(async () => {
  await applyD1Migrations(env.DB, __RT22_D1_MIGRATIONS__, "task_8_summary_migrations");
});

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM admin_sessions"),
    env.DB.prepare("DELETE FROM vouchers"),
    env.DB.prepare("DELETE FROM team_sessions"),
    env.DB.prepare("DELETE FROM sponsors"),
    env.DB.prepare("DELETE FROM events"),
  ]);
  await seedSummaryFixtures();
});

test("authenticated event summary is read-only, event-scoped, private, and exposes only redeemed count", async () => {
  const before = await databaseState();

  const response = await SELF.fetch("https://example.com/api/team/event-summary", {
    headers: { Cookie: `rt22_team_session=${TOKEN}` },
  });

  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get("Vary")).toBe("Cookie");
  await expect(response.json()).resolves.toEqual({ summary: { redeemedCount: 2 } });
  expect(await databaseState()).toEqual(before);
});

test("event summary rejects missing sessions and non-GET methods", async () => {
  const unauthorized = await SELF.fetch("https://example.com/api/team/event-summary");
  expect(unauthorized.status).toBe(401);
  expect(unauthorized.headers.get("Set-Cookie")).toContain("Max-Age=0");

  const wrongMethod = await SELF.fetch("https://example.com/api/team/event-summary", {
    method: "POST",
    headers: { Cookie: `rt22_team_session=${TOKEN}` },
  });
  expect(wrongMethod.status).toBe(405);
  expect(wrongMethod.headers.get("Allow")).toBe("GET");
  expect(wrongMethod.headers.get("Cache-Control")).toBe("no-store");
  expect(wrongMethod.headers.get("Vary")).toBe("Cookie");
});

async function seedSummaryFixtures(): Promise<void> {
  const now = new Date();
  const future = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
  await env.DB.batch([
    eventStatement(EVENT_A.id, EVENT_A.publicId, "RT22 Sommerfest"),
    eventStatement(EVENT_B.id, EVENT_B.publicId, "Anderes Event"),
    sponsorStatement("summary-sponsor-a", EVENT_A.id, "Sponsor A", "a".repeat(32)),
    sponsorStatement("summary-sponsor-b", EVENT_B.id, "Sponsor B", "b".repeat(32)),
    voucherTypeStatement("summary-type-a", EVENT_A.id, "summary-sponsor-a", "1 Bier"),
    voucherTypeStatement("summary-type-b", EVENT_B.id, "summary-sponsor-b", "1 Bier"),
    voucherStatement("voucher-a-1", "c".repeat(22), EVENT_A.id, "summary-sponsor-a", "summary-type-a", "ABCD-2345", now.toISOString()),
    voucherStatement("voucher-a-2", "d".repeat(22), EVENT_A.id, "summary-sponsor-a", "summary-type-a", "EFGH-6789", now.toISOString()),
    voucherStatement("voucher-a-3", "e".repeat(22), EVENT_A.id, "summary-sponsor-a", "summary-type-a", "JKLM-2345", null),
    voucherStatement("voucher-b-1", "f".repeat(22), EVENT_B.id, "summary-sponsor-b", "summary-type-b", "NPQR-6789", now.toISOString()),
    env.DB
      .prepare(
        `INSERT INTO team_sessions (
           id, event_id, display_name, token_hash, session_version,
           created_at, last_seen_at, expires_at, revoked_at
         ) VALUES (?1, ?2, ?3, ?4, 1, ?5, ?5, ?6, NULL)`,
      )
      .bind(
        "summary-session",
        EVENT_A.id,
        "Mara",
        await sha256Hex(TOKEN),
        now.toISOString(),
        future,
      ),
  ]);
}

function eventStatement(id: string, publicId: string, name: string): D1PreparedStatement {
  return env.DB
    .prepare(
      `INSERT INTO events (
         id, public_id, name, event_date, team_pin_salt, team_pin_hash, created_at
       ) VALUES (?1, ?2, ?3, '2026-08-20', 'salt', 'hash', ?4)`,
    )
    .bind(id, publicId, name, new Date().toISOString());
}

function sponsorStatement(
  id: string,
  eventId: string,
  name: string,
  accessId: string,
): D1PreparedStatement {
  return env.DB
    .prepare(
      `INSERT INTO sponsors (id, event_id, name, access_id, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
    )
    .bind(id, eventId, name, accessId, new Date().toISOString());
}

function voucherTypeStatement(
  id: string,
  eventId: string,
  sponsorId: string,
  name: string,
): D1PreparedStatement {
  return env.DB
    .prepare(
      `INSERT INTO voucher_types (id, event_id, sponsor_id, name, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
    )
    .bind(id, eventId, sponsorId, name, new Date().toISOString());
}

function voucherStatement(
  id: string,
  publicId: string,
  eventId: string,
  sponsorId: string,
  voucherTypeId: string,
  displayCode: string,
  redeemedAt: string | null,
): D1PreparedStatement {
  return env.DB
    .prepare(
      `INSERT INTO vouchers (
         id, public_id, event_id, sponsor_id, voucher_type_id, display_code,
         redeemed_at, redeemed_by_session_id, created_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, ?8)`,
    )
    .bind(id, publicId, eventId, sponsorId, voucherTypeId, displayCode, redeemedAt, new Date().toISOString());
}

async function databaseState(): Promise<Record<string, unknown[]>> {
  const state: Record<string, unknown[]> = {};
  for (const table of ["events", "sponsors", "vouchers", "team_sessions", "admin_sessions"]) {
    state[table] = (
      await env.DB.prepare(`SELECT * FROM ${table} ORDER BY id`).all()
    ).results;
  }
  return state;
}
