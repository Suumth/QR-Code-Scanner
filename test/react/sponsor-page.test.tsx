import { readFileSync } from "node:fs";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import App from "../../src/App";

const appStyles = readFileSync("src/app.css", "utf8");

const ACCESS_ID = "A".repeat(32);
const sponsorResponse = {
  event: {
    name: "RT22 Sommerfest",
    eventDate: "2026-08-19",
  },
  sponsor: {
    name: "Muster Sponsor",
  },
  totals: {
    total: 3,
    available: 2,
    redeemed: 1,
  },
  voucherTypes: [
    {
      name: "1 Bier",
      totals: { total: 2, available: 1, redeemed: 1 },
      vouchers: [
        {
          publicId: "r".repeat(22),
          displayCode: "RRRR-8888",
          status: "redeemed",
          voucherType: { name: "1 Bier" },
        },
        {
          publicId: "a".repeat(22),
          displayCode: "AAAA-2222",
          status: "available",
          voucherType: { name: "1 Bier" },
        },
      ],
    },
    {
      name: "1 Essen",
      totals: { total: 1, available: 1, redeemed: 0 },
      vouchers: [
        {
          publicId: "b".repeat(22),
          displayCode: "BBBB-3333",
          status: "available",
          voucherType: { name: "1 Essen" },
        },
      ],
    },
  ],
} as const;

beforeEach(() => {
  window.history.replaceState({}, "", `/s/${ACCESS_ID}`);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
});

test("the mobile sponsor overview shows event, sponsor, totals, and the primary next-voucher action", async () => {
  stubJsonResponse(sponsorResponse);
  render(<App />);

  expect(await screen.findByRole("heading", { name: "RT22 Sommerfest" })).toBeInTheDocument();
  expect(screen.getByText("19. August 2026")).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Muster Sponsor" })).toBeInTheDocument();
  expect(screen.getByLabelText("3 Gutscheine insgesamt")).toBeInTheDocument();
  expect(screen.getByLabelText("2 Gutscheine verfügbar")).toBeInTheDocument();
  expect(screen.getByLabelText("1 Gutschein eingelöst")).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "1 Bier" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "1 Essen" })).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Nächsten verfügbaren Gutschein anzeigen (1 Bier)" }),
  ).toBeEnabled();
  expect(
    screen.getByRole("button", { name: "Nächsten verfügbaren Gutschein anzeigen (1 Essen)" }),
  ).toBeEnabled();
  expect(screen.queryByLabelText("Gutschein QR-Code")).not.toBeInTheDocument();
});

test("the primary action opens the first available voucher with a same-origin QR payload", async () => {
  stubJsonResponse(sponsorResponse);
  render(<App />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Nächsten verfügbaren Gutschein anzeigen (1 Bier)" }),
  );

  expect(screen.getByRole("heading", { name: "1 Bier" })).toBeInTheDocument();
  expect(screen.getByText("AAAA-2222")).toBeInTheDocument();
  expect(screen.getByText("1 Bier")).toBeInTheDocument();
  expect(screen.queryByText("1 Getränk", { exact: true })).not.toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("Verfügbar");
  expect(screen.getByLabelText("Gutschein QR-Code")).toHaveAttribute(
    "data-qr-payload",
    `${window.location.origin}/v/${"a".repeat(22)}`,
  );
  expect(screen.getByText("2 von 2")).toBeInTheDocument();
});

test("the rendered QR preserves a four-module quiet zone on every side", async () => {
  stubJsonResponse(sponsorResponse);
  render(<App />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Nächsten verfügbaren Gutschein anzeigen (1 Bier)" }),
  );

  const qr = screen.getByLabelText("Gutschein QR-Code").querySelector("svg");
  expect(qr).not.toBeNull();
  const viewBox = qr?.getAttribute("viewBox")?.split(/\s+/).map(Number) ?? [];
  expect(viewBox.slice(0, 2)).toEqual([0, 0]);
  expect(viewBox[2]).toBe(viewBox[3]);
  const qrSize = viewBox[2] ?? 0;
  const moduleCount = qrSize - 8;
  expect(moduleCount).toBeGreaterThanOrEqual(21);
  expect((moduleCount - 21) % 4).toBe(0);

  const foregroundPath = qr?.querySelectorAll("path")[1]?.getAttribute("d") ?? "";
  const segments = [
    ...foregroundPath.matchAll(/M(\d+)[ ,](\d+)\s?h(\d+)v1H(\d+)z/g),
  ];
  expect(segments.length).toBeGreaterThan(100);
  expect(segments.map((segment) => segment[0]).join("")).toBe(foregroundPath);
  expect(Math.min(...segments.map((segment) => Number(segment[1])))).toBe(4);
  expect(Math.min(...segments.map((segment) => Number(segment[2])))).toBe(4);
  for (const segment of segments) {
    const startX = Number(segment[1]);
    const y = Number(segment[2]);
    const length = Number(segment[3]);
    expect(Number(segment[4])).toBe(startX);
    expect(startX).toBeGreaterThanOrEqual(4);
    expect(y).toBeGreaterThanOrEqual(4);
    expect(startX + length).toBeLessThanOrEqual(qrSize - 4);
    expect(y + 1).toBeLessThanOrEqual(qrSize - 4);
  }
});

test("previous and next navigation shows redeemed vouchers clearly and keeps one voucher visible", async () => {
  stubJsonResponse(sponsorResponse);
  render(<App />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Nächsten verfügbaren Gutschein anzeigen (1 Bier)" }),
  );

  fireEvent.click(screen.getByRole("button", { name: "Zurück" }));
  expect(screen.getByText("RRRR-8888")).toBeInTheDocument();
  expect(screen.getByText("1 Bier")).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("Bereits eingelöst");
  expect(screen.queryByText("AAAA-2222")).not.toBeInTheDocument();
  expect(screen.getByText("1 von 2")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Weiter" }));
  expect(screen.getByRole("button", { name: "Weiter" })).toBeDisabled();
  expect(screen.getByText("AAAA-2222")).toBeInTheDocument();
  expect(screen.queryByText("BBBB-3333")).not.toBeInTheDocument();
});

test("each voucher type action opens only that type", async () => {
  stubJsonResponse(sponsorResponse);
  render(<App />);

  fireEvent.click(
    await screen.findByRole("button", {
      name: "Nächsten verfügbaren Gutschein anzeigen (1 Essen)",
    }),
  );

  expect(screen.getByText("BBBB-3333")).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "1 Essen" })).toBeInTheDocument();
  expect(screen.queryByText("1 Getränk", { exact: true })).not.toBeInTheDocument();
  expect(screen.getByText("1 von 1")).toBeInTheDocument();
  expect(screen.queryByText("AAAA-2222")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Weiter" })).toBeDisabled();
});

test("a sponsor with zero vouchers gets a truthful disabled empty action", async () => {
  stubJsonResponse({
    ...sponsorResponse,
    totals: { total: 0, available: 0, redeemed: 0 },
    voucherTypes: [],
  });
  render(<App />);

  expect(
    await screen.findByRole("button", { name: "Keine Gutscheine vorhanden" }),
  ).toBeDisabled();
});

test("an all-redeemed sponsor can open and navigate voucher history", async () => {
  stubJsonResponse({
    ...sponsorResponse,
    totals: { total: 2, available: 0, redeemed: 2 },
    voucherTypes: [
      {
        name: "1 Bier",
        totals: { total: 2, available: 0, redeemed: 2 },
        vouchers: [
          sponsorResponse.voucherTypes[0].vouchers[0],
          {
            publicId: "z".repeat(22),
            displayCode: "ZZZZ-9999",
            status: "redeemed",
            voucherType: { name: "1 Bier" },
          },
        ],
      },
    ],
  });
  render(<App />);

  const showHistory = await screen.findByRole("button", { name: "Gutscheine anzeigen (1 Bier)" });
  expect(showHistory).toBeEnabled();
  fireEvent.click(showHistory);
  expect(screen.getByText("RRRR-8888")).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("Bereits eingelöst");
  expect(screen.getByRole("button", { name: "Weiter" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Weiter" }));
  expect(screen.getByText("ZZZZ-9999")).toBeInTheDocument();
  expect(screen.queryByText("RRRR-8888")).not.toBeInTheDocument();
});

test("voucher count labels use correct singular and plural German", async () => {
  stubJsonResponse({
    ...sponsorResponse,
    totals: { total: 3, available: 1, redeemed: 2 },
    voucherTypes: [
      {
        name: "1 Bier",
        totals: { total: 3, available: 1, redeemed: 2 },
        vouchers: [
          sponsorResponse.voucherTypes[0].vouchers[0],
          sponsorResponse.voucherTypes[0].vouchers[0],
          sponsorResponse.voucherTypes[0].vouchers[1],
        ],
      },
    ],
  });
  render(<App />);

  expect(await screen.findByLabelText("3 Gutscheine insgesamt")).toBeInTheDocument();
  expect(screen.getByLabelText("1 Gutschein verfügbar")).toBeInTheDocument();
  expect(screen.getByLabelText("2 Gutscheine eingelöst")).toBeInTheDocument();
});

test("valid 120-character event and sponsor names remain available to the page", async () => {
  const longEventName = "E".repeat(120);
  const longSponsorName = "S".repeat(120);
  stubJsonResponse({
    ...sponsorResponse,
    event: { ...sponsorResponse.event, name: longEventName },
    sponsor: { name: longSponsorName },
  });
  render(<App />);

  const eventHeading = await screen.findByRole("heading", { name: longEventName });
  const sponsorHeading = screen.getByRole("heading", { name: longSponsorName });
  expect(eventHeading).toBeInTheDocument();
  expect(sponsorHeading).toBeInTheDocument();
  expect(appStyles).toMatch(
    /\.voucher-header\s*{[^}]*min-width:\s*0;[^}]*max-width:\s*100%;/s,
  );
  expect(appStyles).toMatch(
    /\.voucher-event\s*{[^}]*min-width:\s*0;[^}]*max-width:\s*100%;/s,
  );
  expect(appStyles).toMatch(
    /\.voucher-event h1\s*{[^}]*max-width:\s*100%;[^}]*overflow-wrap:\s*anywhere;/s,
  );
  expect(appStyles).toMatch(
    /\.voucher-header h2\s*{[^}]*max-width:\s*100%;[^}]*overflow-wrap:\s*anywhere;/s,
  );
  expect(
    screen.getByRole("button", { name: "Nächsten verfügbaren Gutschein anzeigen (1 Bier)" }),
  ).toBeEnabled();
});

test("the public voucher route presents status without any redeem control", async () => {
  const publicId = "r".repeat(22);
  window.history.replaceState({}, "", `/v/${publicId}`);
  stubJsonResponse({
    event: sponsorResponse.event,
    sponsor: sponsorResponse.sponsor,
    voucher: sponsorResponse.voucherTypes[1].vouchers[0],
  });
  render(<App />);

  expect(await screen.findByRole("heading", { name: "1 Essen" })).toBeInTheDocument();
  expect(screen.getByText("BBBB-3333")).toBeInTheDocument();
  expect(screen.getByText("1 Essen")).toBeInTheDocument();
  expect(screen.queryByText("1 Getränk", { exact: true })).not.toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("Verfügbar");
  expect(screen.queryByRole("button", { name: /einlösen/i })).not.toBeInTheDocument();
  expect(screen.getByText("Nur das Event-Team kann Gutscheine einlösen.")).toBeInTheDocument();
});

test("a failed sponsor request shows a recoverable error instead of stale voucher content", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network unavailable")));
  render(<App />);

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Die Gutscheine konnten nicht geladen werden.",
  );
  expect(screen.getByRole("button", { name: "Erneut versuchen" })).toBeInTheDocument();

  await waitFor(() => {
    expect(screen.queryByText("AAAA-2222")).not.toBeInTheDocument();
  });
});

function stubJsonResponse(body: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
}
