import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";

import { generateOpaqueId, sha256Hex } from "../../worker/security/crypto";
import { MAX_ADMIN_CSV_EXPORT_ROWS } from "../../worker/features/admin/dashboard-repository";
import { MAX_ADMIN_QR_EXPORT_VOUCHERS } from "../../worker/features/admin/qr-export-repository";

declare const __RT22_D1_MIGRATIONS__: {
  name: string;
  queries: string[];
}[];

const ADMIN_PASSWORD = "vitest-only-admin-password";

beforeAll(async () => {
  await applyD1Migrations(env.DB, __RT22_D1_MIGRATIONS__, "task_9_migrations");
});

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM vouchers"),
    env.DB.prepare("DELETE FROM sponsors"),
    env.DB.prepare("DELETE FROM team_sessions"),
    env.DB.prepare("DELETE FROM admin_sessions"),
    env.DB.prepare("DELETE FROM events"),
  ]);
});

describe("authenticated admin event detail", () => {
  test("returns isolated event totals and per-sponsor counts including a zero-voucher sponsor", async () => {
    const event = await seedEvent("Sommerfest");
    const otherEvent = await seedEvent("Nicht dieses Event");
    const activeSession = await seedTeamSession(event, {
      displayName: "Anna",
      token: "active-team-token",
    });
    const firstSponsor = await seedSponsor(event.id, "Muster Sponsor", "2026-08-20T10:00:00.000Z");
    const emptySponsor = await seedSponsor(event.id, "Noch ohne Gutscheine", "2026-08-20T10:01:00.000Z");
    const otherSponsor = await seedSponsor(otherEvent.id, "Fremder Sponsor", "2026-08-20T10:02:00.000Z");
    const beerType = await seedVoucherType(event.id, firstSponsor.id, "1 Bier", "2026-08-20T10:03:00.000Z");
    const foodType = await seedVoucherType(event.id, firstSponsor.id, "1 Essen", "2026-08-20T10:04:00.000Z");

    await Promise.all([
      seedVoucher(event.id, firstSponsor.id, "ABCD-EFGH", "voucher-public-a", {
        voucherTypeId: beerType.id,
        redeemedAt: "2026-08-20T12:00:00.000Z",
        redeemedBySessionId: activeSession.id,
      }),
      seedVoucher(event.id, firstSponsor.id, "IJKL-MNPQ", "voucher-public-b", { voucherTypeId: beerType.id }),
      seedVoucher(event.id, firstSponsor.id, "QRST-UVWX", "voucher-public-c", { voucherTypeId: foodType.id }),
      seedVoucher(otherEvent.id, otherSponsor.id, "YZ23-4567", "other-voucher-public"),
      seedVoucher(otherEvent.id, firstSponsor.id, "CROS-SPON", "cross-event-sponsor-public"),
    ]);
    const cookie = await loginAdmin();
    const before = await databaseSnapshot();

    const response = await SELF.fetch(`https://example.com/api/admin/events/${event.id}`, {
      headers: { Cookie: cookie },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Vary")).toBe("Cookie");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({
      event: {
        id: event.id,
        publicId: event.publicId,
        name: "Sommerfest",
        eventDate: event.eventDate,
        createdAt: event.createdAt,
      },
      summary: { issuedCount: 3, redeemedCount: 1, availableCount: 2 },
      sponsors: [
        {
          id: firstSponsor.id,
          name: "Muster Sponsor",
          accessId: firstSponsor.accessId,
          createdAt: firstSponsor.createdAt,
          issuedCount: 3,
          redeemedCount: 1,
          availableCount: 2,
          voucherTypes: [
            {
              id: beerType.id,
              name: "1 Bier",
              issuedCount: 2,
              redeemedCount: 1,
              availableCount: 1,
            },
            {
              id: foodType.id,
              name: "1 Essen",
              issuedCount: 1,
              redeemedCount: 0,
              availableCount: 1,
            },
          ],
        },
        {
          id: emptySponsor.id,
          name: "Noch ohne Gutscheine",
          accessId: emptySponsor.accessId,
          createdAt: emptySponsor.createdAt,
          issuedCount: 0,
          redeemedCount: 0,
          availableCount: 0,
          voucherTypes: [],
        },
      ],
      sponsorsNextCursor: null,
      teamSessions: [
        {
          displayName: "Anna",
          createdAt: activeSession.createdAt,
          lastSeenAt: activeSession.lastSeenAt,
          expiresAt: activeSession.expiresAt,
          revokedAt: null,
          status: "active",
        },
      ],
    });
    expect(JSON.stringify(body)).not.toContain(otherSponsor.id);
    expect(JSON.stringify(body)).not.toContain("other-voucher-public");
    expect(JSON.stringify(body)).not.toContain("cross-event-sponsor-public");
    expect(JSON.stringify(body)).not.toContain("active-team-token");
    expect(JSON.stringify(body)).not.toContain(await sha256Hex("active-team-token"));
    expect(await databaseSnapshot()).toEqual(before);
  });

  test("paginates 501 sponsors without losing a private link or crossing event scope", async () => {
    const event = await seedEvent("Large sponsor event");
    const otherEvent = await seedEvent("Other sponsor event");
    await seedBulkSponsors(event.id, 501, "event");
    await seedBulkSponsors(otherEvent.id, 2, "other");
    const { cookie, token } = await seedAdminCookie("pagination-admin-token");
    const before = await databaseSnapshot();

    const initial = await SELF.fetch(`https://example.com/api/admin/events/${event.id}`, {
      headers: { Cookie: cookie },
    });
    expect(initial.status).toBe(200);
    const initialBody = (await initial.json()) as {
      sponsors: Array<Record<string, unknown>>;
      sponsorsNextCursor: string | null;
    };
    expect(initialBody.sponsors).toHaveLength(500);
    expect(initialBody.sponsors[0]).toEqual({
      id: "event-sponsor-id-000",
      name: "event sponsor 000",
      accessId: "event-sponsor-access-000",
      createdAt: "2026-08-20T10:00:00.000Z",
      issuedCount: 0,
      redeemedCount: 0,
      availableCount: 0,
      voucherTypes: [],
    });
    expect(initialBody.sponsors.at(-1)?.id).toBe("event-sponsor-id-499");
    expect(initialBody.sponsorsNextCursor).toEqual(expect.any(String));
    expect(JSON.stringify(initialBody)).not.toContain("event-sponsor-access-500");

    const pagePath = `https://example.com/api/admin/events/${event.id}/sponsors?cursor=${encodeURIComponent(initialBody.sponsorsNextCursor ?? "")}`;
    const page = await SELF.fetch(pagePath, { headers: { Cookie: cookie } });
    expect(page.status).toBe(200);
    expect(page.headers.get("Cache-Control")).toBe("no-store");
    expect(page.headers.get("Vary")).toBe("Cookie");
    const pageBody = (await page.json()) as Record<string, unknown>;
    expect(pageBody).toEqual({
      sponsors: [
        {
          id: "event-sponsor-id-500",
          name: "event sponsor 500",
          accessId: "event-sponsor-access-500",
          createdAt: "2026-08-20T10:00:00.000Z",
          issuedCount: 0,
          redeemedCount: 0,
          availableCount: 0,
          voucherTypes: [],
        },
      ],
      nextCursor: null,
    });
    const serialized = JSON.stringify(pageBody);
    expect(serialized).not.toContain("other-sponsor-id");
    expect(serialized).not.toContain("other-sponsor-access");
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain(await sha256Hex(token));

    const invalid = await SELF.fetch(
      `https://example.com/api/admin/events/${event.id}/sponsors?cursor=not-a-cursor`,
      { headers: { Cookie: cookie } },
    );
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toEqual({ error: "Invalid sponsor cursor" });

    const wrongMethod = await SELF.fetch(
      `https://example.com/api/admin/events/${event.id}/sponsors`,
      { method: "DELETE", headers: { Cookie: cookie } },
    );
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("Allow")).toBe("GET, POST");
    expect(await databaseSnapshot()).toEqual(before);
  });

  test("lists only the selected event's sessions with safe status and timestamps", async () => {
    const event = await seedEvent("Session Event");
    const otherEvent = await seedEvent("Other Session Event");
    const active = await seedTeamSession(event, {
      displayName: "Aktiv",
      token: "active-secret",
      lastSeenAt: "2026-08-20T14:00:00.000Z",
    });
    const revoked = await seedTeamSession(event, {
      displayName: "Widerrufen",
      token: "revoked-secret",
      lastSeenAt: "2026-08-20T13:00:00.000Z",
      revokedAt: "2026-08-20T13:30:00.000Z",
    });
    const expired = await seedTeamSession(event, {
      displayName: "Abgelaufen",
      token: "expired-secret",
      lastSeenAt: "2026-08-20T12:00:00.000Z",
      expiresAt: "2020-08-20T12:30:00.000Z",
    });
    const superseded = await seedTeamSession(event, {
      displayName: "Alte PIN",
      token: "superseded-secret",
      lastSeenAt: "2026-08-20T11:00:00.000Z",
      sessionVersion: 0,
    });
    await seedTeamSession(otherEvent, {
      displayName: "Fremde Sitzung",
      token: "other-event-secret",
    });
    const cookie = await loginAdmin();

    const response = await SELF.fetch(`https://example.com/api/admin/events/${event.id}`, {
      headers: { Cookie: cookie },
    });
    const payload = (await response.json()) as { teamSessions: unknown[] };

    expect(response.status).toBe(200);
    expect(payload.teamSessions).toEqual([
      safeSession(active, "active"),
      safeSession(revoked, "revoked"),
      safeSession(expired, "expired"),
      safeSession(superseded, "superseded"),
    ]);
    const serialized = JSON.stringify(payload);
    for (const forbidden of [
      active.id,
      revoked.id,
      expired.id,
      superseded.id,
      "active-secret",
      "revoked-secret",
      "other-event-secret",
      await sha256Hex("active-secret"),
      "teamPinHash",
      "teamPinSalt",
      "sessionVersion",
      "Fremde Sitzung",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  test("safe-fails for missing and unauthenticated event details", async () => {
    const event = await seedEvent("Private Event");

    const unauthorized = await SELF.fetch(`https://example.com/api/admin/events/${event.id}`);
    expect(unauthorized.status).toBe(401);
    await expect(unauthorized.json()).resolves.toEqual({ error: "Unauthorized" });

    const cookie = await loginAdmin();
    const missing = await SELF.fetch("https://example.com/api/admin/events/missing-event", {
      headers: { Cookie: cookie },
    });
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toEqual({ error: "Event not found" });
  });
});

describe("authenticated voucher CSV export", () => {
  test("exports exact safe event-scoped fields with RFC4180 escaping and formula neutralization", async () => {
    const event = await seedEvent('=RT22, "Sommer"');
    const otherEvent = await seedEvent("Other export event");
    const plusSponsor = await seedSponsor(event.id, "+Partner, GmbH", "2026-08-20T10:00:00.000Z");
    const minusSponsor = await seedSponsor(event.id, "-Förderer", "2026-08-20T10:01:00.000Z");
    const otherSponsor = await seedSponsor(otherEvent.id, "Other CSV Sponsor", "2026-08-20T10:02:00.000Z");
    const beerType = await seedVoucherType(event.id, plusSponsor.id, "1 Bier", "2026-08-20T10:03:00.000Z");
    const foodType = await seedVoucherType(event.id, minusSponsor.id, "1 Essen", "2026-08-20T10:04:00.000Z");
    const atSession = await seedTeamSession(event, {
      displayName: '@Anna "Boss"',
      token: "csv-session-token-a",
    });
    const whitespaceSession = await seedTeamSession(event, {
      displayName: "\tBen",
      token: "csv-session-token-b",
    });
    const otherSession = await seedTeamSession(otherEvent, {
      displayName: "Other event operator",
      token: "csv-other-event-session-token",
    });

    await seedVoucher(event.id, plusSponsor.id, "ABCD-EFGH", "csv-public-a", {
      voucherTypeId: beerType.id,
      createdAt: "2026-08-20T10:02:00.000Z",
      redeemedAt: "2026-08-20T12:00:00.000Z",
      redeemedBySessionId: atSession.id,
    });
    await seedVoucher(event.id, plusSponsor.id, "IJKL-MNPQ", "csv-public-b", {
      voucherTypeId: beerType.id,
      createdAt: "2026-08-20T10:03:00.000Z",
    });
    await seedVoucher(event.id, minusSponsor.id, "QRST-UVWX", "csv-public-c", {
      voucherTypeId: foodType.id,
      createdAt: "2026-08-20T10:04:00.000Z",
      redeemedAt: "2026-08-20T12:05:00.000Z",
      redeemedBySessionId: whitespaceSession.id,
    });
    await seedVoucher(otherEvent.id, otherSponsor.id, "YZ23-4567", "other-csv-public", {
      redeemedAt: "2026-08-20T12:10:00.000Z",
    });
    await seedVoucher(event.id, otherSponsor.id, "CROS-EVNT", "cross-event-csv-public", {
      redeemedAt: "2026-08-20T12:15:00.000Z",
      redeemedBySessionId: otherSession.id,
    });
    const cookie = await loginAdmin();
    const before = await databaseSnapshot();

    const response = await SELF.fetch(
      `https://example.com/api/admin/events/${event.id}/export.csv`,
      { headers: { Cookie: cookie } },
    );
    const csv = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("Content-Disposition")).toBe(
      `attachment; filename="event-vouchers-${event.eventDate}.csv"`,
    );
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Vary")).toBe("Cookie");
    expect(csv).toBe(
        '"event","sponsor","voucher_type","voucher display code","status","redeemed timestamp","redeemed-by display name"\r\n' +
        '"\'=RT22, ""Sommer""","\'+Partner, GmbH","1 Bier","ABCD-EFGH","redeemed","2026-08-20T12:00:00.000Z","\'@Anna ""Boss"""\r\n' +
        '"\'=RT22, ""Sommer""","\'+Partner, GmbH","1 Bier","IJKL-MNPQ","available","",""\r\n' +
        '"\'=RT22, ""Sommer""","\'-Förderer","1 Essen","QRST-UVWX","redeemed","2026-08-20T12:05:00.000Z","\'\tBen"\r\n' +
        '"\'=RT22, ""Sommer""","","","CROS-EVNT","redeemed","2026-08-20T12:15:00.000Z",""\r\n',
    );
    expect(csv.split("\r\n")).toHaveLength(6);
    for (const forbidden of [
      plusSponsor.accessId,
      minusSponsor.accessId,
      "csv-public-a",
      "csv-public-b",
      "csv-public-c",
      "other-csv-public",
      "cross-event-csv-public",
      atSession.id,
      whitespaceSession.id,
      otherSession.id,
      "csv-session-token-a",
      await sha256Hex("csv-session-token-a"),
      event.teamPinSalt,
      event.teamPinHash,
      ADMIN_PASSWORD,
      "Other export event",
      "Other CSV Sponsor",
      "Other event operator",
    ]) {
      expect(csv).not.toContain(forbidden);
    }
    expect(await databaseSnapshot()).toEqual(before);
  });

  test("requires authentication, permits GET only, and rejects an oversized export without partial CSV", async () => {
    const event = await seedEvent("CSV access event");
    const path = `https://example.com/api/admin/events/${event.id}/export.csv`;

    const unauthorized = await SELF.fetch(path);
    expect(unauthorized.status).toBe(401);
    await expect(unauthorized.json()).resolves.toEqual({ error: "Unauthorized" });

    const cookie = await loginAdmin();
    const missing = await SELF.fetch(
      "https://example.com/api/admin/events/missing-event/export.csv",
      { headers: { Cookie: cookie } },
    );
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toEqual({ error: "Event not found" });

    const post = await SELF.fetch(path, { method: "POST", headers: { Cookie: cookie } });
    expect(post.status).toBe(405);
    expect(post.headers.get("Allow")).toBe("GET");
    expect(post.headers.get("Cache-Control")).toBe("no-store");
    expect(post.headers.get("Vary")).toBe("Cookie");

    const sponsor = await seedSponsor(event.id, "Bounded sponsor", "2026-08-20T10:00:00.000Z");
    await seedBulkVouchers(event.id, sponsor.id, MAX_ADMIN_CSV_EXPORT_ROWS);

    const atLimit = await SELF.fetch(path, { headers: { Cookie: cookie } });
    expect(atLimit.status).toBe(200);
    expect((await atLimit.text()).split("\r\n")).toHaveLength(MAX_ADMIN_CSV_EXPORT_ROWS + 2);

    const otherEvent = await seedEvent("Other bounded event");
    const otherSponsor = await seedSponsor(
      otherEvent.id,
      "Must never leak",
      "2026-08-20T10:01:00.000Z",
    );
    const otherSession = await seedTeamSession(otherEvent, {
      displayName: "Other bounded operator",
      token: "other-bounded-session-token",
    });
    await seedVoucher(event.id, otherSponsor.id, "OVER-LIMT", "over-csv-export-limit", {
      redeemedAt: "2026-08-20T12:30:00.000Z",
      redeemedBySessionId: otherSession.id,
    });
    const overLimit = await SELF.fetch(path, { headers: { Cookie: cookie } });
    expect(overLimit.status).toBe(413);
    expect(overLimit.headers.get("Content-Type")).toContain("application/json");
    expect(overLimit.headers.get("Cache-Control")).toBe("no-store");
    expect(overLimit.headers.get("Vary")).toBe("Cookie");
    await expect(overLimit.json()).resolves.toEqual({
      error: `CSV export is limited to ${MAX_ADMIN_CSV_EXPORT_ROWS} vouchers`,
    });
  });
});

describe("authenticated sponsor QR asset export", () => {
  test("exports only the selected sponsor's stable voucher read model", async () => {
    const event = await seedEvent("QR event");
    const otherEvent = await seedEvent("Other QR event");
    const sponsor = await seedSponsor(event.id, "Firma, \"XY\"", "2026-08-20T10:00:00.000Z");
    const otherSponsor = await seedSponsor(event.id, "Other sponsor", "2026-08-20T10:01:00.000Z");
    const foreignSponsor = await seedSponsor(otherEvent.id, "Foreign sponsor", "2026-08-20T10:02:00.000Z");
    const beerType = await seedVoucherType(event.id, sponsor.id, "1 Bier", "2026-08-20T10:03:00.000Z");
    const foodType = await seedVoucherType(event.id, sponsor.id, "1 Essen", "2026-08-20T10:04:00.000Z");
    await seedVoucher(event.id, sponsor.id, "WXYZ-2345", "qr-public-z", {
      voucherTypeId: beerType.id,
      redeemedAt: "2026-08-20T12:00:00.000Z",
    });
    await seedVoucher(event.id, sponsor.id, "ABCD-EFGH", "qr-public-a", { voucherTypeId: beerType.id });
    await seedVoucher(event.id, sponsor.id, "YZ23-4567", "qr-food-public", { voucherTypeId: foodType.id });
    await seedVoucher(event.id, otherSponsor.id, "IJKL-MNPQ", "other-sponsor-public");
    await seedVoucher(otherEvent.id, foreignSponsor.id, "QRST-UVWX", "other-event-public");
    const { cookie } = await seedAdminCookie("qr-export-admin-a");
    const before = await databaseSnapshot();
    const path = `https://example.com/api/admin/events/${event.id}/sponsors/${sponsor.id}/voucher-types/${beerType.id}/qr-export`;

    const unauthorized = await SELF.fetch(path);
    expect(unauthorized.status).toBe(401);

    const response = await SELF.fetch(path, { headers: { Cookie: cookie } });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Vary")).toBe("Cookie");
    await expect(response.json()).resolves.toEqual({
      sponsorName: 'Firma, "XY"',
      voucherTypeName: "1 Bier",
      vouchers: [
        { publicId: "qr-public-a", displayCode: "ABCD-EFGH", status: "available" },
        { publicId: "qr-public-z", displayCode: "WXYZ-2345", status: "redeemed" },
      ],
    });
    const serialized = await (await SELF.fetch(path, { headers: { Cookie: cookie } })).text();
    expect(serialized).not.toContain(sponsor.accessId);
    expect(serialized).not.toContain(sponsor.id);
    expect(serialized).not.toContain(event.id);
    expect(serialized).not.toContain(otherEvent.id);
    expect(serialized).not.toContain(otherSponsor.id);
    expect(serialized).not.toContain("other-sponsor-public");
    expect(serialized).not.toContain("other-event-public");
    expect(await databaseSnapshot()).toEqual(before);
  });

  test("returns an empty read model, preserves identity on re-export, and rejects cross-event selection", async () => {
    const event = await seedEvent("Empty QR event");
    const otherEvent = await seedEvent("Other empty QR event");
    const emptySponsor = await seedSponsor(event.id, "Empty sponsor", "2026-08-20T10:00:00.000Z");
    const foreignSponsor = await seedSponsor(otherEvent.id, "Foreign sponsor", "2026-08-20T10:01:00.000Z");
    const populatedSponsor = await seedSponsor(event.id, "Populated sponsor", "2026-08-20T10:02:00.000Z");
    const emptyType = await seedVoucherType(event.id, emptySponsor.id, "1 Bier", "2026-08-20T10:03:00.000Z");
    const populatedType = await seedVoucherType(event.id, populatedSponsor.id, "1 Bier", "2026-08-20T10:04:00.000Z");
    await seedVoucher(event.id, populatedSponsor.id, "ABCD-EFGH", "populated-public-a", { voucherTypeId: populatedType.id });
    const { cookie } = await seedAdminCookie("qr-export-admin-b");
    const emptyPath = `https://example.com/api/admin/events/${event.id}/sponsors/${emptySponsor.id}/voucher-types/${emptyType.id}/qr-export`;
    const empty = await SELF.fetch(emptyPath, { headers: { Cookie: cookie } });
    expect(empty.status).toBe(200);
    await expect(empty.json()).resolves.toEqual({ sponsorName: "Empty sponsor", voucherTypeName: "1 Bier", vouchers: [] });
    const path = `https://example.com/api/admin/events/${event.id}/sponsors/${populatedSponsor.id}/voucher-types/${populatedType.id}/qr-export`;
    const first = await SELF.fetch(path, { headers: { Cookie: cookie } });
    const firstBody = await first.json();
    const second = await SELF.fetch(path, { headers: { Cookie: cookie } });

    expect(first.status).toBe(200);
    expect(firstBody).toEqual({
      sponsorName: "Populated sponsor",
      voucherTypeName: "1 Bier",
      vouchers: [{ publicId: "populated-public-a", displayCode: "ABCD-EFGH", status: "available" }],
    });
    expect(await second.json()).toEqual(firstBody);

    await seedVoucher(event.id, populatedSponsor.id, "WXYZ-2345", "populated-public-z", { voucherTypeId: populatedType.id });
    const afterAdditionalIssuance = await SELF.fetch(path, { headers: { Cookie: cookie } });
    await expect(afterAdditionalIssuance.json()).resolves.toEqual({
      sponsorName: "Populated sponsor",
      voucherTypeName: "1 Bier",
      vouchers: [
        { publicId: "populated-public-a", displayCode: "ABCD-EFGH", status: "available" },
        { publicId: "populated-public-z", displayCode: "WXYZ-2345", status: "available" },
      ],
    });

    const zero = await SELF.fetch(
      `https://example.com/api/admin/events/${event.id}/sponsors/${foreignSponsor.id}/voucher-types/${populatedType.id}/qr-export`,
      { headers: { Cookie: cookie } },
    );
    expect(zero.status).toBe(404);
    const wrongMethod = await SELF.fetch(path, { method: "POST", headers: { Cookie: cookie } });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("Allow")).toBe("GET");
    expect(MAX_ADMIN_QR_EXPORT_VOUCHERS).toBeGreaterThanOrEqual(500);
  });
});

interface SeededEvent {
  id: string;
  publicId: string;
  name: string;
  eventDate: string;
  createdAt: string;
  teamPinSalt: string;
  teamPinHash: string;
  teamSessionVersion: number;
}

interface SeededSponsor {
  id: string;
  accessId: string;
  createdAt: string;
}

interface SeededVoucherType {
  id: string;
  name: string;
  createdAt: string;
}

interface SeededTeamSession {
  id: string;
  displayName: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

async function seedEvent(name: string): Promise<SeededEvent> {
  const event: SeededEvent = {
    id: generateOpaqueId(16),
    publicId: generateOpaqueId(16),
    name,
    eventDate: "2026-08-20",
    createdAt: "2026-08-20T09:00:00.000Z",
    teamPinSalt: `pin-salt-${generateOpaqueId(8)}`,
    teamPinHash: `pin-hash-${generateOpaqueId(8)}`,
    teamSessionVersion: 1,
  };
  await env.DB.prepare(
    `INSERT INTO events (
      id, public_id, name, event_date, team_pin_salt, team_pin_hash,
      team_session_version, created_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  )
    .bind(
      event.id,
      event.publicId,
      event.name,
      event.eventDate,
      event.teamPinSalt,
      event.teamPinHash,
      event.teamSessionVersion,
      event.createdAt,
    )
    .run();
  return event;
}

async function seedSponsor(
  eventId: string,
  name: string,
  createdAt: string,
): Promise<SeededSponsor> {
  const sponsor = {
    id: generateOpaqueId(16),
    accessId: generateOpaqueId(24),
    createdAt,
  };
  await env.DB.prepare(
    `INSERT INTO sponsors (id, event_id, name, access_id, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5)`,
  )
    .bind(sponsor.id, eventId, name, sponsor.accessId, sponsor.createdAt)
    .run();
  return sponsor;
}

async function seedVoucherType(
  eventId: string,
  sponsorId: string,
  name: string,
  createdAt: string,
): Promise<SeededVoucherType> {
  const voucherType = { id: generateOpaqueId(16), name, createdAt };
  await env.DB.prepare(
    `INSERT INTO voucher_types (id, event_id, sponsor_id, name, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5)`,
  )
    .bind(voucherType.id, eventId, sponsorId, voucherType.name, voucherType.createdAt)
    .run();
  return voucherType;
}

async function seedVoucher(
  eventId: string,
  sponsorId: string,
  displayCode: string,
  publicId: string,
  overrides: {
    createdAt?: string;
    voucherTypeId?: string;
    redeemedAt?: string;
    redeemedBySessionId?: string;
  } = {},
): Promise<void> {
  const voucherTypeId = overrides.voucherTypeId ?? (await ensureDefaultVoucherType(eventId, sponsorId)).id;
  await env.DB.prepare(
    `INSERT INTO vouchers (
      id, public_id, event_id, sponsor_id, voucher_type_id, display_code,
      redeemed_at, redeemed_by_session_id, created_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  )
    .bind(
      generateOpaqueId(16),
      publicId,
      eventId,
      sponsorId,
      voucherTypeId,
      displayCode,
      overrides.redeemedAt ?? null,
      overrides.redeemedBySessionId ?? null,
      overrides.createdAt ?? "2026-08-20T10:00:00.000Z",
    )
    .run();
}

async function ensureDefaultVoucherType(eventId: string, sponsorId: string): Promise<SeededVoucherType> {
  const existing = await env.DB.prepare(
    `SELECT id, name, created_at FROM voucher_types
     WHERE sponsor_id = ?1 ORDER BY created_at, id LIMIT 1`,
  )
    .bind(sponsorId)
    .first<{ id: string; name: string; created_at: string }>();
  if (existing) {
    return { id: existing.id, name: existing.name, createdAt: existing.created_at };
  }
  return seedVoucherType(eventId, sponsorId, "1 Bier", "2026-08-20T09:59:00.000Z");
}

async function seedBulkVouchers(eventId: string, sponsorId: string, count: number): Promise<void> {
  const voucherType = await ensureDefaultVoucherType(eventId, sponsorId);
  await env.DB.prepare(
    `WITH digits(value) AS (
       VALUES (0), (1), (2), (3), (4), (5), (6), (7), (8), (9)
     ), sequence(value) AS (
       SELECT
         ones.value + tens.value * 10 + hundreds.value * 100 + thousands.value * 1000
       FROM digits AS ones
       CROSS JOIN digits AS tens
       CROSS JOIN digits AS hundreds
       CROSS JOIN digits AS thousands
     )
     INSERT INTO vouchers (
       id, public_id, event_id, sponsor_id, voucher_type_id, display_code,
       redeemed_at, redeemed_by_session_id, created_at
     )
     SELECT
       'bulk-voucher-id-' || printf('%04d', value),
       'bulk-voucher-public-' || printf('%04d', value),
       ?1,
       ?2,
       ?4,
       'BULK-' || printf('%04d', value),
       NULL,
       NULL,
       '2026-08-20T10:00:00.000Z'
     FROM sequence
     WHERE value < ?3`,
  )
    .bind(eventId, sponsorId, count, voucherType.id)
    .run();
}

async function seedBulkSponsors(eventId: string, count: number, prefix: string): Promise<void> {
  await env.DB.prepare(
    `WITH digits(value) AS (
       VALUES (0), (1), (2), (3), (4), (5), (6), (7), (8), (9)
     ), sequence(value) AS (
       SELECT ones.value + tens.value * 10 + hundreds.value * 100
       FROM digits AS ones
       CROSS JOIN digits AS tens
       CROSS JOIN digits AS hundreds
     )
     INSERT INTO sponsors (id, event_id, name, access_id, created_at)
     SELECT
       ?3 || '-sponsor-id-' || printf('%03d', value),
       ?1,
       ?3 || ' sponsor ' || printf('%03d', value),
       ?3 || '-sponsor-access-' || printf('%03d', value),
       '2026-08-20T10:00:00.000Z'
     FROM sequence
     WHERE value < ?2
     ORDER BY value`,
  )
    .bind(eventId, count, prefix)
    .run();
}

async function seedTeamSession(
  event: SeededEvent,
  options: {
    displayName: string;
    token: string;
    createdAt?: string;
    lastSeenAt?: string;
    expiresAt?: string;
    revokedAt?: string | null;
    sessionVersion?: number;
  },
): Promise<SeededTeamSession> {
  const session = {
    id: generateOpaqueId(16),
    displayName: options.displayName,
    createdAt: options.createdAt ?? "2026-08-20T10:30:00.000Z",
    lastSeenAt: options.lastSeenAt ?? "2026-08-20T10:30:00.000Z",
    expiresAt: options.expiresAt ?? "2099-08-20T23:00:00.000Z",
    revokedAt: options.revokedAt ?? null,
  };
  await env.DB.prepare(
    `INSERT INTO team_sessions (
      id, event_id, display_name, token_hash, session_version,
      created_at, last_seen_at, expires_at, revoked_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  )
    .bind(
      session.id,
      event.id,
      session.displayName,
      await sha256Hex(options.token),
      options.sessionVersion ?? event.teamSessionVersion,
      session.createdAt,
      session.lastSeenAt,
      session.expiresAt,
      session.revokedAt,
    )
    .run();
  return session;
}

function safeSession(session: SeededTeamSession, status: string): Record<string, unknown> {
  return {
    displayName: session.displayName,
    createdAt: session.createdAt,
    lastSeenAt: session.lastSeenAt,
    expiresAt: session.expiresAt,
    revokedAt: session.revokedAt,
    status,
  };
}

async function loginAdmin(): Promise<string> {
  const response = await SELF.fetch("https://example.com/api/admin/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: ADMIN_PASSWORD }),
  });
  expect(response.status).toBe(204);
  const cookie = response.headers.get("Set-Cookie")?.split(";", 1)[0];
  if (!cookie) {
    throw new Error("Expected admin session cookie");
  }
  return cookie;
}

async function seedAdminCookie(token: string): Promise<{ cookie: string; token: string }> {
  await env.DB.prepare(
    `INSERT INTO admin_sessions (id, token_hash, created_at, expires_at, revoked_at)
     VALUES (?1, ?2, ?3, ?4, NULL)`,
  )
    .bind(
      `admin-session-${generateOpaqueId(8)}`,
      await sha256Hex(token),
      "2026-08-20T09:00:00.000Z",
      "2099-08-20T17:00:00.000Z",
    )
    .run();
  return { cookie: `rt22_admin_session=${token}`, token };
}

async function databaseSnapshot(): Promise<Record<string, unknown[]>> {
  const snapshot: Record<string, unknown[]> = {};
  for (const table of ["events", "sponsors", "vouchers", "team_sessions", "admin_sessions"] as const) {
    snapshot[table] = (
      await env.DB.prepare(`SELECT * FROM ${table} ORDER BY id`).all()
    ).results;
  }
  return snapshot;
}
