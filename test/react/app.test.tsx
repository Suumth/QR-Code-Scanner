import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import App from "../../src/App";

beforeEach(() => {
  window.history.replaceState({}, "", "/");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
});

test("home entry shows one eligible event directly without a redundant selector", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          events: [
            { publicId: "e".repeat(22), name: "RT22 Sommerfest", eventDate: "2026-08-22" },
          ],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ error: "Unauthorized" }, 401)),
  );

  render(<App />);

  expect(await screen.findByRole("heading", { name: "Team anmelden" })).toBeInTheDocument();
  expect(screen.getByText("RT22 Sommerfest")).toBeInTheDocument();
  expect(screen.getByText("2026-08-22")).toBeInTheDocument();
  expect(screen.queryByRole("combobox", { name: "Event auswählen" })).not.toBeInTheDocument();
});

test("home entry uses an accessible selector for multiple events with the first preferred", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          events: [
            { publicId: "a".repeat(22), name: "Alpha", eventDate: "2026-08-21" },
            { publicId: "b".repeat(22), name: "Beta", eventDate: "2026-08-22" },
          ],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ error: "Unauthorized" }, 401)),
  );

  render(<App />);

  expect(await screen.findByRole("combobox", { name: "Event auswählen" })).toHaveValue(
    "a".repeat(22),
  );
  expect(screen.getByRole("option", { name: /Alpha/ })).toBeInTheDocument();
  expect(screen.getByRole("option", { name: /Beta/ })).toBeInTheDocument();
});

test("home entry explains when no eligible event exists", async () => {
  stubFetch(jsonResponse({ events: [] }));

  render(<App />);

  expect(await screen.findByRole("status")).toHaveTextContent(
    "Aktuell ist kein Event verfügbar.",
  );
});

test("home event discovery network failure is recoverable", async () => {
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockRejectedValue(new TypeError("offline")));

  render(<App />);

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Events konnten nicht geladen werden.",
  );
  expect(screen.getByRole("button", { name: "Erneut laden" })).toBeInTheDocument();
});

test.each([
  [401, "Name oder PIN stimmen nicht."],
  [429, "Zu viele Anmeldeversuche. Bitte kurz warten."],
])("home login surfaces a %s response without entering the scanner", async (status, message) => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          events: [{ publicId: "e".repeat(22), name: "RT22", eventDate: "2026-08-22" }],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ error: "Unauthorized" }, 401))
      .mockResolvedValueOnce(jsonResponse({ error: "Login failed" }, status)),
  );

  render(<App />);
  await fillHomeLogin();

  expect(await screen.findByRole("alert")).toHaveTextContent(message);
  expect(screen.queryByRole("heading", { name: "Gutschein scannen" })).not.toBeInTheDocument();
});

test("home login network failure stays fail-closed", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          events: [{ publicId: "e".repeat(22), name: "RT22", eventDate: "2026-08-22" }],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ error: "Unauthorized" }, 401))
      .mockRejectedValueOnce(new TypeError("offline")),
  );

  render(<App />);
  await fillHomeLogin();

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Keine Verbindung. Bitte erneut versuchen.",
  );
  expect(screen.queryByRole("heading", { name: "Gutschein scannen" })).not.toBeInTheDocument();
});

async function fillHomeLogin(): Promise<void> {
  fireEvent.change(await screen.findByRole("textbox", { name: "Dein Name" }), {
    target: { value: "Mara" },
  });
  fireEvent.change(screen.getByLabelText("Event-PIN"), { target: { value: "246810" } });
  fireEvent.click(screen.getByRole("button", { name: "Anmelden" }));
}

function stubFetch(response: Response): void {
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(response));
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
