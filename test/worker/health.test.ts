import { SELF } from "cloudflare:test";
import { expect, test } from "vitest";

test("GET /api/health returns an ok JSON response", async () => {
  const response = await SELF.fetch("https://example.com/api/health");

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ ok: true });
});
