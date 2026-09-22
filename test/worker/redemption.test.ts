import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";

import { sha256Hex } from "../../worker/security/crypto";

declare const __RT22_D1_MIGRATIONS__: {
  name: string;
  queries: string[];
}[];

const EVENT_A = {
  id: "event-internal-a",
  publicId: "event-public-a",
  name: "RT22 Sommerfest",
  eventDate: "2026-08-20",
};
const EVENT_B = {
  id: "event-internal-b",
  publicId: "event-public-b",
  name: "Anderes RT Event",
  eventDate: "2026-08-21",
};
const SPONSOR_A = { id: "sponsor-internal-a", name: "Heidelberg Brewery" };
const SPONSOR_B = { id: "sponsor-internal-b", name: "Sponsor B" };
const AVAILABLE_PUBLIC_ID = "aaaaaaaaaaaaaaaaaaaaaa";
const REDEEMED_PUBLIC_ID = "rrrrrrrrrrrrrrrrrrrrrr";
const OTHER_EVENT_PUBLIC_ID = "bbbbbbbbbbbbbbbbbbbbbb";
const AVAILABLE_CODE = "ABCD-2345";
const REDEEMED_CODE = "WXYZ-6789";
const OTHER_EVENT_CODE = "BBBB-3333";
const EXISTING_REDEEMED_AT = "2026-08-20T17:30:00.000Z";
const SESSION_A_ONE = {
  id: "session-internal-a-one",
  token: "session-token-a-one",
  displayName: "Ada",
};
const SESSION_A_TWO = {
  id: "session-internal-a-two",
  token: "session-token-a-two",
  displayName: "Bea",
};
const SESSION_B = {
  id: "session-internal-b",
  token: "session-token-b",
  displayName: "Berta",
};
const VOUCHER_TYPE_A_ID = "voucher-type-a";
const VOUCHER_TYPE_A_NAME = "1 Bier";

beforeAll(async () => {
  await applyD1Migrations(env.DB, __RT22_D1_MIGRATIONS__, "task_7_migrations");
});

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM admin_sessions"),
    env.DB.prepare("DELETE FROM vouchers"),
    env.DB.prepare("DELETE FROM team_sessions"),
    env.DB.prepare("DELETE FROM sponsors"),
    env.DB.prepare("DELETE FROM events"),
  ]);
  await seedFixtures();
});

describe("read-only voucher inspection", () => {
  test("an active same-event session sees an available voucher without changing any D1 state", async () => {
    const before = await completeDatabaseState();

    const response = await voucherRequest("inspect", { publicId: AVAILABLE_PUBLIC_ID });

    expect(response.status).toBe(200);
    expectPrivateResponse(response);
    await expect(response.json()).resolves.toEqual({
      status: "available",
      voucher: {
        publicId: AVAILABLE_PUBLIC_ID,
        displayCode: AVAILABLE_CODE,
        redeemedAt: null,
        event: {
          name: EVENT_A.name,
          eventDate: EVENT_A.eventDate,
        },
        sponsor: {
          name: SPONSOR_A.name,
        },
        voucherType: { name: VOUCHER_TYPE_A_NAME },
      },
    });
    expect(await completeDatabaseState()).toEqual(before);
  });

  test("an active same-event session sees an already-redeemed voucher without changing any D1 state", async () => {
    const before = await completeDatabaseState();

    const response = await voucherRequest("inspect", { publicId: REDEEMED_PUBLIC_ID });

    expect(response.status).toBe(200);
    expectPrivateResponse(response);
    const body = await response.json();
    expect(body).toEqual({
      status: "already_redeemed",
      voucher: {
        publicId: REDEEMED_PUBLIC_ID,
        displayCode: REDEEMED_CODE,
        redeemedAt: EXISTING_REDEEMED_AT,
        event: {
          name: EVENT_A.name,
          eventDate: EVENT_A.eventDate,
        },
        sponsor: {
          name: SPONSOR_A.name,
        },
        voucherType: { name: VOUCHER_TYPE_A_NAME },
      },
    });
    expect(JSON.stringify(body)).not.toContain(SESSION_A_TWO.id);
    expect(await completeDatabaseState()).toEqual(before);
  });

  test("an unknown or other-event locator safe-fails identically without changing any D1 state", async () => {
    const before = await completeDatabaseState();

    for (const body of [
      { publicId: "zzzzzzzzzzzzzzzzzzzzzz" },
      { publicId: OTHER_EVENT_PUBLIC_ID },
      { displayCode: OTHER_EVENT_CODE },
    ]) {
      const response = await voucherRequest("inspect", body);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ status: "invalid" });
    }

    expect(await completeDatabaseState()).toEqual(before);
  });
});

describe("authenticated atomic voucher redemption", () => {
  test("the first confirmation succeeds, stores the exact response timestamp and session id, then a retry is already redeemed", async () => {
    const earliestPossibleTimestamp = Date.now();
    const lastSeenBefore = await storedSessionLastSeen(SESSION_A_ONE.id);

    const first = await voucherRequest("redeem", { publicId: AVAILABLE_PUBLIC_ID });

    const latestPossibleTimestamp = Date.now();
    expect(first.status).toBe(200);
    expectPrivateResponse(first);
    const firstBody = (await first.json()) as {
      status: string;
      voucher: { redeemedAt: string };
    };
    expect(firstBody).toEqual({
      status: "redeemed",
      voucher: {
        publicId: AVAILABLE_PUBLIC_ID,
        displayCode: AVAILABLE_CODE,
        redeemedAt: expect.any(String),
        event: {
          name: EVENT_A.name,
          eventDate: EVENT_A.eventDate,
        },
        sponsor: {
          name: SPONSOR_A.name,
        },
        voucherType: { name: VOUCHER_TYPE_A_NAME },
      },
    });
    const redeemedAtMs = new Date(firstBody.voucher.redeemedAt).getTime();
    expect(redeemedAtMs).toBeGreaterThanOrEqual(earliestPossibleTimestamp);
    expect(redeemedAtMs).toBeLessThanOrEqual(latestPossibleTimestamp);
    expect(JSON.stringify(firstBody)).not.toContain(SESSION_A_ONE.id);

    const stored = await storedVoucher(AVAILABLE_PUBLIC_ID);
    expect(stored).toEqual({
      id: "voucher-available-a",
      redeemed_at: firstBody.voucher.redeemedAt,
      redeemed_by_session_id: SESSION_A_ONE.id,
    });
    expect(await storedSessionLastSeen(SESSION_A_ONE.id)).toBe(firstBody.voucher.redeemedAt);
    expect(await storedSessionLastSeen(SESSION_A_ONE.id)).not.toBe(lastSeenBefore);

    const adminCookie = await seedAdminSession("redemption-admin-token");
    const adminDetail = await SELF.fetch(
      `https://example.com/api/admin/events/${EVENT_A.id}`,
      { headers: { Cookie: adminCookie } },
    );
    expect(adminDetail.status).toBe(200);
    const adminBody = (await adminDetail.json()) as {
      teamSessions: Array<{ displayName: string; lastSeenAt: string }>;
    };
    expect(
      adminBody.teamSessions.find(({ displayName }) => displayName === SESSION_A_ONE.displayName),
    ).toMatchObject({ lastSeenAt: firstBody.voucher.redeemedAt });

    const retryAfterPossiblyLostResponse = await voucherRequest("redeem", {
      publicId: AVAILABLE_PUBLIC_ID,
    });
    expect(retryAfterPossiblyLostResponse.status).toBe(200);
    await expect(retryAfterPossiblyLostResponse.json()).resolves.toEqual({
      status: "already_redeemed",
      voucher: {
        publicId: AVAILABLE_PUBLIC_ID,
        displayCode: AVAILABLE_CODE,
        redeemedAt: firstBody.voucher.redeemedAt,
        event: {
          name: EVENT_A.name,
          eventDate: EVENT_A.eventDate,
        },
        sponsor: {
          name: SPONSOR_A.name,
        },
        voucherType: { name: VOUCHER_TYPE_A_NAME },
      },
    });
    expect(await storedVoucher(AVAILABLE_PUBLIC_ID)).toEqual(stored);
    expect(await storedSessionLastSeen(SESSION_A_ONE.id)).toBe(firstBody.voucher.redeemedAt);
  });

  test("manual entry normalization reaches the same one-time transition as the public id", async () => {
    const first = await voucherRequest("redeem", { displayCode: "  abcd 2345  " });

    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      status: string;
      voucher: { redeemedAt: string };
    };
    expect(firstBody).toMatchObject({
      status: "redeemed",
      voucher: {
        publicId: AVAILABLE_PUBLIC_ID,
        displayCode: AVAILABLE_CODE,
        redeemedAt: expect.any(String),
      },
    });

    const secondViaQrIdentifier = await voucherRequest("redeem", {
      publicId: AVAILABLE_PUBLIC_ID,
    });
    await expect(secondViaQrIdentifier.json()).resolves.toMatchObject({
      status: "already_redeemed",
      voucher: {
        publicId: AVAILABLE_PUBLIC_ID,
        displayCode: AVAILABLE_CODE,
        redeemedAt: firstBody.voucher.redeemedAt,
      },
    });
    expect(await storedVoucher(AVAILABLE_PUBLIC_ID)).toMatchObject({
      redeemed_at: firstBody.voucher.redeemedAt,
      redeemed_by_session_id: SESSION_A_ONE.id,
    });
  });

  test("an event A session cannot redeem an event B voucher and learns no event B details", async () => {
    const before = await completeDatabaseState();

    for (const body of [
      { publicId: OTHER_EVENT_PUBLIC_ID },
      { displayCode: OTHER_EVENT_CODE },
    ]) {
      const response = await voucherRequest("redeem", body);
      expect(response.status).toBe(200);
      const payload = await response.json();
      expect(payload).toEqual({ status: "invalid" });
      expect(JSON.stringify(payload)).not.toContain(EVENT_B.name);
      expect(JSON.stringify(payload)).not.toContain(SPONSOR_B.name);
    }

    expect(await completeDatabaseState()).toEqual(before);
  });

  test("twenty repeated four-way races across two devices produce exactly one API and stored winner each", async () => {
    for (let iteration = 0; iteration < 20; iteration += 1) {
      const suffix = iteration.toString().padStart(2, "0");
      const voucherId = `race-voucher-${suffix}`;
      const publicId = `racevoucherpublicid0${suffix}`;
      const displayCode = `RACE-222${"23456789ABCDEFGHJKLM"[iteration]}`;
      await seedVoucher({
        id: voucherId,
        publicId,
        eventId: EVENT_A.id,
        sponsorId: SPONSOR_A.id,
        displayCode,
      });
      const lastSeenBefore = new Map([
        [SESSION_A_ONE.id, await storedSessionLastSeen(SESSION_A_ONE.id)],
        [SESSION_A_TWO.id, await storedSessionLastSeen(SESSION_A_TWO.id)],
      ]);

      const attempts = await Promise.all([
        voucherRequest("redeem", { publicId }, teamCookie(SESSION_A_ONE.token)),
        voucherRequest("redeem", { publicId }, teamCookie(SESSION_A_TWO.token)),
        voucherRequest("redeem", { displayCode }, teamCookie(SESSION_A_ONE.token)),
        voucherRequest("redeem", { displayCode }, teamCookie(SESSION_A_TWO.token)),
      ]);
      expect(attempts.map((response) => response.status)).toEqual([200, 200, 200, 200]);
      const bodies = (await Promise.all(attempts.map((response) => response.json()))) as Array<{
        status: string;
        voucher?: { redeemedAt: string };
      }>;

      expect(bodies.map(({ status }) => status).sort()).toEqual([
        "already_redeemed",
        "already_redeemed",
        "already_redeemed",
        "redeemed",
      ]);
      expect(new Set(bodies.map(({ voucher }) => voucher?.redeemedAt))).toHaveLength(1);

      const winnerIndex = bodies.findIndex(({ status }) => status === "redeemed");
      const expectedWinningSession = [
        SESSION_A_ONE.id,
        SESSION_A_TWO.id,
        SESSION_A_ONE.id,
        SESSION_A_TWO.id,
      ][winnerIndex];
      if (!expectedWinningSession) {
        throw new Error("Expected exactly one winning team session");
      }
      const row = await storedVoucher(publicId);
      expect(row.redeemed_at).toBe(bodies[winnerIndex].voucher?.redeemedAt);
      expect(row.redeemed_by_session_id).toBe(expectedWinningSession);
      const winningTimestamp = bodies[winnerIndex].voucher?.redeemedAt;
      expect(await storedSessionLastSeen(expectedWinningSession)).toBe(
        [lastSeenBefore.get(expectedWinningSession), winningTimestamp].sort().at(-1),
      );
      const losingSession =
        expectedWinningSession === SESSION_A_ONE.id ? SESSION_A_TWO.id : SESSION_A_ONE.id;
      expect(await storedSessionLastSeen(losingSession)).toBe(lastSeenBefore.get(losingSession));
      await expect(
        env.DB.prepare(
          `SELECT COUNT(*) AS count
           FROM vouchers
           WHERE id = ?1
             AND redeemed_at IS NOT NULL
             AND redeemed_by_session_id IS NOT NULL`,
        )
          .bind(voucherId)
          .first<{ count: number }>(),
      ).resolves.toEqual({ count: 1 });
    }
  });
});

describe("voucher route boundaries", () => {
  test("public locators grant no authority and inactive sessions cannot inspect or redeem", async () => {
    const before = await completeDatabaseState();

    for (const action of ["inspect", "redeem"] as const) {
      const unauthenticated = await voucherRequest(
        action,
        { publicId: AVAILABLE_PUBLIC_ID },
        "",
      );
      expect(unauthenticated.status).toBe(401);
      expectPrivateResponse(unauthenticated);
      expect(unauthenticated.headers.get("Set-Cookie")).toContain("Max-Age=0");
      await expect(unauthenticated.json()).resolves.toEqual({ error: "Unauthorized" });

      for (const token of ["revoked-session-token", "expired-session-token"]) {
        const response = await voucherRequest(
          action,
          { publicId: AVAILABLE_PUBLIC_ID },
          teamCookie(token),
        );
        expect(response.status).toBe(401);
        await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
      }
    }

    expect(await completeDatabaseState()).toEqual(before);
  });

  test("both routes accept only exactly one valid locator in bounded application JSON", async () => {
    const invalidBodies = [
      {},
      [],
      { publicId: AVAILABLE_PUBLIC_ID, displayCode: AVAILABLE_CODE },
      { publicId: "short" },
      { displayCode: "ABCI-1234" },
      { displayCode: 12345678 },
    ];

    for (const action of ["inspect", "redeem"] as const) {
      for (const body of invalidBodies) {
        const response = await voucherRequest(action, body);
        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toEqual({ error: "Invalid voucher locator" });
      }

      const wrongType = await SELF.fetch(teamVoucherUrl(action), {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
          Cookie: teamCookie(SESSION_A_ONE.token),
        },
        body: JSON.stringify({ publicId: AVAILABLE_PUBLIC_ID }),
      });
      expect(wrongType.status).toBe(415);
      await expect(wrongType.json()).resolves.toEqual({ error: "Unsupported media type" });

      const malformed = await SELF.fetch(teamVoucherUrl(action), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: teamCookie(SESSION_A_ONE.token),
        },
        body: "{",
      });
      expect(malformed.status).toBe(400);
      await expect(malformed.json()).resolves.toEqual({ error: "Malformed JSON" });

      const oversized = await SELF.fetch(teamVoucherUrl(action), {
        method: "POST",
        headers: {
          "Content-Length": "1",
          "Content-Type": "application/json",
          Cookie: teamCookie(SESSION_A_ONE.token),
        },
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(4097));
          },
        }),
      });
      expect(oversized.status).toBe(413);
      await expect(oversized.json()).resolves.toEqual({ error: "Payload too large" });
    }
  });

  test("inspect and redeem are exactly POST-only, private, and non-mutating when rejected", async () => {
    const before = await completeDatabaseState();

    for (const action of ["inspect", "redeem"] as const) {
      for (const method of ["GET", "PUT", "DELETE"]) {
        const response = await SELF.fetch(teamVoucherUrl(action), {
          method,
          headers: { Cookie: teamCookie(SESSION_A_ONE.token) },
        });
        expect(response.status).toBe(405);
        expect(response.headers.get("Allow")).toBe("POST");
        expectPrivateResponse(response);
      }
    }

    expect(await completeDatabaseState()).toEqual(before);
  });

  test("a D1 redemption failure returns only a generic non-success response", async () => {
    await env.DB.prepare(
      `CREATE TRIGGER redemption_test_failure
       BEFORE UPDATE OF redeemed_at ON vouchers
       BEGIN
         SELECT RAISE(ABORT, 'private-database-failure-detail');
       END`,
    ).run();

    try {
      const response = await voucherRequest("redeem", { publicId: AVAILABLE_PUBLIC_ID });
      expect(response.status).toBe(500);
      expectPrivateResponse(response);
      const body = await response.json();
      expect(body).toEqual({ error: "Voucher request failed" });
      expect(JSON.stringify(body)).not.toContain("private-database-failure-detail");
      expect(await storedVoucher(AVAILABLE_PUBLIC_ID)).toEqual({
        id: "voucher-available-a",
        redeemed_at: null,
        redeemed_by_session_id: null,
      });
    } finally {
      await env.DB.prepare("DROP TRIGGER IF EXISTS redemption_test_failure").run();
    }
  });
});

async function seedFixtures(): Promise<void> {
  await seedEvent(EVENT_A);
  await seedEvent(EVENT_B);
  await seedSponsor(SPONSOR_A.id, EVENT_A.id, SPONSOR_A.name, "access-a");
  await seedSponsor(SPONSOR_B.id, EVENT_B.id, SPONSOR_B.name, "access-b");
  await env.DB.prepare(
    "INSERT INTO voucher_types (id, event_id, sponsor_id, name, created_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(VOUCHER_TYPE_A_ID, EVENT_A.id, SPONSOR_A.id, VOUCHER_TYPE_A_NAME, "2026-01-03T12:00:00.000Z")
    .run();
  await seedSession(SESSION_A_ONE, EVENT_A.id);
  await seedSession(SESSION_A_TWO, EVENT_A.id);
  await seedSession(SESSION_B, EVENT_B.id);
  await seedInactiveSession("revoked-session-token", EVENT_A.id, {
    revokedAt: "2026-08-20T12:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
  });
  await seedInactiveSession("expired-session-token", EVENT_A.id, {
    revokedAt: null,
    expiresAt: "2020-01-01T00:00:00.000Z",
  });
  await seedVoucher({
    id: "voucher-available-a",
    publicId: AVAILABLE_PUBLIC_ID,
    eventId: EVENT_A.id,
    sponsorId: SPONSOR_A.id,
    displayCode: AVAILABLE_CODE,
  });
  await seedVoucher({
    id: "voucher-redeemed-a",
    publicId: REDEEMED_PUBLIC_ID,
    eventId: EVENT_A.id,
    sponsorId: SPONSOR_A.id,
    displayCode: REDEEMED_CODE,
    redeemedAt: EXISTING_REDEEMED_AT,
    redeemedBySessionId: SESSION_A_TWO.id,
  });
  await seedVoucher({
    id: "voucher-event-b",
    publicId: OTHER_EVENT_PUBLIC_ID,
    eventId: EVENT_B.id,
    sponsorId: SPONSOR_B.id,
    displayCode: OTHER_EVENT_CODE,
  });
}

async function seedEvent(event: typeof EVENT_A): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO events (
       id, public_id, name, event_date, team_pin_salt, team_pin_hash,
       team_session_version, created_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7)`,
  )
    .bind(
      event.id,
      event.publicId,
      event.name,
      event.eventDate,
      `salt-${event.id}`,
      `hash-${event.id}`,
      "2026-01-01T00:00:00.000Z",
    )
    .run();
}

async function seedSponsor(
  id: string,
  eventId: string,
  name: string,
  accessId: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO sponsors (id, event_id, name, access_id, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5)`,
  )
    .bind(id, eventId, name, accessId, "2026-01-02T00:00:00.000Z")
    .run();
}

async function seedSession(
  session: typeof SESSION_A_ONE,
  eventId: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO team_sessions (
       id, event_id, display_name, token_hash, session_version,
       created_at, last_seen_at, expires_at, revoked_at
     ) VALUES (?1, ?2, ?3, ?4, 1, ?5, ?5, ?6, NULL)`,
  )
    .bind(
      session.id,
      eventId,
      session.displayName,
      await sha256Hex(session.token),
      "2026-01-03T00:00:00.000Z",
      "2099-01-01T00:00:00.000Z",
    )
    .run();
}

async function seedInactiveSession(
  token: string,
  eventId: string,
  state: { revokedAt: string | null; expiresAt: string },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO team_sessions (
       id, event_id, display_name, token_hash, session_version,
       created_at, last_seen_at, expires_at, revoked_at
     ) VALUES (?1, ?2, ?3, ?4, 1, ?5, ?5, ?6, ?7)`,
  )
    .bind(
      `inactive-${token}`,
      eventId,
      "Inactive",
      await sha256Hex(token),
      "2026-01-03T00:00:00.000Z",
      state.expiresAt,
      state.revokedAt,
    )
    .run();
}

async function seedVoucher(voucher: {
  id: string;
  publicId: string;
  eventId: string;
  sponsorId: string;
  voucherTypeId?: string;
  displayCode: string;
  redeemedAt?: string;
  redeemedBySessionId?: string;
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO vouchers (
       id, public_id, event_id, sponsor_id, voucher_type_id, display_code,
       redeemed_at, redeemed_by_session_id, created_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  )
    .bind(
      voucher.id,
      voucher.publicId,
      voucher.eventId,
      voucher.sponsorId,
      voucher.voucherTypeId ?? VOUCHER_TYPE_A_ID,
      voucher.displayCode,
      voucher.redeemedAt ?? null,
      voucher.redeemedBySessionId ?? null,
      "2026-01-04T00:00:00.000Z",
    )
    .run();
}

function voucherRequest(
  action: "inspect" | "redeem",
  body: unknown,
  cookie = teamCookie(SESSION_A_ONE.token),
): Promise<Response> {
  return SELF.fetch(teamVoucherUrl(action), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

function teamVoucherUrl(action: "inspect" | "redeem"): string {
  return `https://example.com/api/team/vouchers/${action}`;
}

function teamCookie(token: string): string {
  return `rt22_team_session=${token}`;
}

function expectPrivateResponse(response: Response): void {
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get("Vary")).toBe("Cookie");
}

async function storedVoucher(publicId: string): Promise<{
  id: string;
  redeemed_at: string | null;
  redeemed_by_session_id: string | null;
}> {
  const row = await env.DB.prepare(
    `SELECT id, redeemed_at, redeemed_by_session_id
     FROM vouchers
     WHERE public_id = ?1`,
  )
    .bind(publicId)
    .first<{
      id: string;
      redeemed_at: string | null;
      redeemed_by_session_id: string | null;
    }>();
  if (!row) {
    throw new Error(`Expected voucher ${publicId}`);
  }
  return row;
}

async function storedSessionLastSeen(sessionId: string): Promise<string> {
  const row = await env.DB.prepare(
    "SELECT last_seen_at FROM team_sessions WHERE id = ?1",
  )
    .bind(sessionId)
    .first<{ last_seen_at: string }>();
  if (!row) {
    throw new Error(`Expected team session ${sessionId}`);
  }
  return row.last_seen_at;
}

async function seedAdminSession(token: string): Promise<string> {
  await env.DB.prepare(
    `INSERT INTO admin_sessions (id, token_hash, created_at, expires_at, revoked_at)
     VALUES (?1, ?2, ?3, ?4, NULL)`,
  )
    .bind(
      `admin-${token}`,
      await sha256Hex(token),
      "2026-08-20T09:00:00.000Z",
      "2099-08-20T17:00:00.000Z",
    )
    .run();
  return `rt22_admin_session=${token}`;
}

async function completeDatabaseState(): Promise<Record<string, unknown[]>> {
  const [events, sponsors, vouchers, teamSessions, adminSessions] = await env.DB.batch([
    env.DB.prepare("SELECT * FROM events ORDER BY id"),
    env.DB.prepare("SELECT * FROM sponsors ORDER BY id"),
    env.DB.prepare("SELECT * FROM vouchers ORDER BY id"),
    env.DB.prepare("SELECT * FROM team_sessions ORDER BY id"),
    env.DB.prepare("SELECT * FROM admin_sessions ORDER BY id"),
  ]);
  return {
    events: events.results,
    sponsors: sponsors.results,
    vouchers: vouchers.results,
    teamSessions: teamSessions.results,
    adminSessions: adminSessions.results,
  };
}
