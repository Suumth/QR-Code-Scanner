import { expect, test } from "vitest";

import {
  derivePin,
  generateDisplayCode,
  generateOpaqueId,
  isValidTeamPin,
  sha256Hex,
  verifyPin,
} from "../../worker/security/crypto";
import { createSessionCookie } from "../../worker/security/cookies";

test("generates URL-safe opaque identifiers with the requested entropy", () => {
  const first = generateOpaqueId(24);
  const second = generateOpaqueId(24);

  expect(first).toMatch(/^[A-Za-z0-9_-]{32}$/);
  expect(second).toMatch(/^[A-Za-z0-9_-]{32}$/);
  expect(first).not.toBe(second);
});

test("rejects an opaque identifier request without entropy", () => {
  expect(() => generateOpaqueId(0)).toThrow("positive integer");
});

test("hashes a session bearer deterministically without retaining its value", async () => {
  await expect(sha256Hex("team-session-bearer")).resolves.toBe(
    "f3c8e89b8ce69160305390a974201087941f0fb6cb67855601ade4ad56755151",
  );
});

test("generates manual voucher codes in the unambiguous XXXX-XXXX format", () => {
  expect(generateDisplayCode()).toMatch(
    /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/,
  );
});

test("derives the documented PBKDF2-SHA-256 team PIN hash", async () => {
  const salt = "event-specific-salt";
  const expected = "d838c8fa320116d2c1079cf9e5d7284a637ac5a258e1cdcf96fcbb304cbd19bd";

  await expect(derivePin("123456", salt)).resolves.toBe(expected);
});

test("uses the PIN salt and verifies only the correct six-digit team PIN", async () => {
  const salt = "event-specific-salt";
  const expected = "d838c8fa320116d2c1079cf9e5d7284a637ac5a258e1cdcf96fcbb304cbd19bd";

  expect(isValidTeamPin("123456")).toBe(true);
  expect(await derivePin("123456", "other-event-salt")).not.toBe(expected);
  expect(await verifyPin("123456", salt, expected)).toBe(true);
  expect(await verifyPin("654321", salt, expected)).toBe(false);
});

test("rejects malformed team PINs before deriving them", async () => {
  expect(isValidTeamPin("12345")).toBe(false);
  expect(isValidTeamPin("1234567")).toBe(false);
  expect(isValidTeamPin("12AB56")).toBe(false);
  await expect(derivePin("12AB56", "event-specific-salt")).rejects.toThrow(
    "exactly six decimal digits",
  );
});

test("creates an explicit, strict, secure session cookie", () => {
  const cookie = createSessionCookie({
    name: "rt22_team_session",
    value: "opaque-session-token",
    expiresAt: new Date("2026-08-20T12:00:00.000Z"),
  });

  expect(cookie).toContain("rt22_team_session=opaque-session-token");
  expect(cookie).toContain("HttpOnly");
  expect(cookie).toContain("Secure");
  expect(cookie).toContain("SameSite=Strict");
  expect(cookie).toContain("Path=/");
  expect(cookie).toContain("Expires=Thu, 20 Aug 2026 12:00:00 GMT");
});
