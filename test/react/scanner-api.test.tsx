import { afterEach, expect, test, vi } from "vitest";

import { createScannerApi, ScannerApiError } from "../../src/features/team/scannerApi";

const PUBLIC_ID = "a".repeat(22);
const locator = { kind: "publicId", publicId: PUBLIC_ID } as const;
const redeemedPayload = {
  status: "redeemed",
  voucher: {
    publicId: PUBLIC_ID,
    displayCode: "ABCD-2345",
    redeemedAt: "2026-08-20T18:00:00.000Z",
    event: { name: "RT22 Sommerfest", eventDate: "2026-08-20" },
    sponsor: { name: "Muster Sponsor" },
    voucherType: { name: "1 Bier" },
  },
} as const;

afterEach(() => {
  vi.useRealTimers();
});

test("inspect and redeem use the same locator body on their distinct explicit endpoints", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    requests.push({ url: String(input), init });
    return jsonResponse(
      String(input).endsWith("/inspect")
        ? {
            status: "available",
            voucher: { ...redeemedPayload.voucher, redeemedAt: null },
          }
        : redeemedPayload,
    );
  });
  const api = createScannerApi({ fetcher });
  const signal = new AbortController().signal;

  await api.inspect(locator, signal);
  await api.redeem(locator, signal);

  expect(requests.map(({ url }) => url)).toEqual([
    "/api/team/vouchers/inspect",
    "/api/team/vouchers/redeem",
  ]);
  expect(requests.map(({ init }) => init?.method)).toEqual(["POST", "POST"]);
  expect(requests.map(({ init }) => init?.body)).toEqual([
    JSON.stringify({ publicId: PUBLIC_ID }),
    JSON.stringify({ publicId: PUBLIC_ID }),
  ]);
});

test("redeem accepts success only from a validated status=redeemed response", async () => {
  const api = createScannerApi({ fetcher: vi.fn(async () => jsonResponse(redeemedPayload)) });

  await expect(api.redeem(locator, new AbortController().signal)).resolves.toEqual(
    redeemedPayload,
  );
});

test.each([
  ["HTTP error", async () => jsonResponse({ error: "failed" }, 500)],
  ["thrown network error", async () => Promise.reject(new TypeError("network lost"))],
  ["invalid JSON", async () => new Response("{" , { status: 200 })],
  ["ambiguous body", async () => jsonResponse({ ok: true })],
  [
    "wrong status",
    async () => jsonResponse({ status: "available", voucher: redeemedPayload.voucher }),
  ],
  [
    "redeemed without timestamp",
    async () =>
      jsonResponse({
        status: "redeemed",
        voucher: { ...redeemedPayload.voucher, redeemedAt: null },
      }),
  ],
  [
    "voucher without type",
    async () =>
      jsonResponse({
        status: "redeemed",
        voucher: { ...redeemedPayload.voucher, voucherType: undefined },
      }),
  ],
])("%s can never be interpreted as redemption success", async (_name, responseFactory) => {
  const api = createScannerApi({ fetcher: vi.fn(responseFactory) });
  await expect(api.redeem(locator, new AbortController().signal)).rejects.toBeInstanceOf(
    ScannerApiError,
  );
});

test("an external abort rejects instead of accepting a late successful response", async () => {
  let resolveResponse: ((response: Response) => void) | undefined;
  const pending = new Promise<Response>((resolve) => {
    resolveResponse = resolve;
  });
  const api = createScannerApi({ fetcher: vi.fn(() => pending) });
  const controller = new AbortController();
  const request = api.redeem(locator, controller.signal);

  controller.abort();
  resolveResponse?.(jsonResponse(redeemedPayload));

  await expect(request).rejects.toMatchObject({ name: "AbortError" });
});

test("a timed-out redeem aborts and rejects without returning success", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn<typeof fetch>((_input, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
        once: true,
      });
    }),
  );
  const api = createScannerApi({ fetcher, timeoutMs: 25 });
  const request = api.redeem(locator, new AbortController().signal);
  const rejection = expect(request).rejects.toMatchObject({ name: "TimeoutError" });

  await vi.advanceTimersByTimeAsync(26);

  await rejection;
});

test("event summary accepts only a non-negative integer aggregate", async () => {
  const valid = createScannerApi({
    fetcher: vi.fn(async () => jsonResponse({ summary: { redeemedCount: 7 } })),
  });
  await expect(valid.eventSummary(new AbortController().signal)).resolves.toEqual({
    redeemedCount: 7,
  });

  for (const redeemedCount of [-1, 1.5, "7", null]) {
    const invalid = createScannerApi({
      fetcher: vi.fn(async () => jsonResponse({ summary: { redeemedCount } })),
    });
    await expect(invalid.eventSummary(new AbortController().signal)).rejects.toBeInstanceOf(
      ScannerApiError,
    );
  }
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
