import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import App from "../../src/App";

const event = {
  id: "event-a",
  publicId: "p".repeat(22),
  name: "RT22 Sommerfest",
  eventDate: "2026-08-20",
  createdAt: "2026-08-19T10:00:00.000Z",
};

const emptyDetail = {
  event,
  summary: { issuedCount: 0, availableCount: 0, redeemedCount: 0 },
  sponsors: [],
  sponsorsNextCursor: null,
  teamSessions: [],
};

const populatedDetail = {
  event,
  summary: { issuedCount: 12, availableCount: 8, redeemedCount: 4 },
  sponsors: [
    {
      id: "sponsor-a",
      name: "Muster Sponsor",
      accessId: "a".repeat(32),
      createdAt: "2026-08-19T11:00:00.000Z",
      issuedCount: 12,
      availableCount: 8,
      redeemedCount: 4,
      voucherTypes: [
        {
          id: "voucher-type-a",
          name: "1 Bier",
          issuedCount: 12,
          availableCount: 8,
          redeemedCount: 4,
        },
      ],
    },
  ],
  sponsorsNextCursor: null,
  teamSessions: [
    {
      displayName: "Anna",
      createdAt: "2026-08-20T12:00:00.000Z",
      lastSeenAt: "2026-08-20T14:32:00.000Z",
      expiresAt: "2026-08-21T04:00:00.000Z",
      revokedAt: null,
      status: "active",
    },
  ],
};

beforeEach(() => {
  window.history.replaceState({}, "", "/admin");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
});

test("an unauthenticated admin route presents login and confirms the session before showing data", async () => {
  const fetchMock = stubFetch(
    jsonResponse({ error: "Unauthorized" }, 401),
    new Response(null, { status: 204 }),
    jsonResponse({ events: [event] }),
    jsonResponse(populatedDetail),
  );

  render(<App />);

  expect(await screen.findByRole("heading", { name: "Administration" })).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Admin-Passwort"), {
    target: { value: "correct horse battery staple" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Anmelden" }));

  expect(await screen.findByRole("heading", { name: "RT22 Sommerfest" })).toBeInTheDocument();
  expect(fetchMock).toHaveBeenNthCalledWith(
    2,
    "/api/admin/login",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ password: "correct horse battery staple" }),
    }),
  );
  expect(fetchMock).toHaveBeenNthCalledWith(
    3,
    "/api/admin/events",
    expect.objectContaining({ cache: "no-store", credentials: "same-origin" }),
  );
});

test("an accepted login clears the password before dashboard bootstrap recovery", async () => {
  stubFetch(
    jsonResponse({ error: "Unauthorized" }, 401),
    new Response(null, { status: 204 }),
    new TypeError("dashboard unavailable"),
    jsonResponse({ error: "Unauthorized" }, 401),
  );

  render(<App />);
  const passwordInput = await screen.findByLabelText("Admin-Passwort");
  fireEvent.change(passwordInput, { target: { value: "do-not-retain-me" } });
  fireEvent.click(screen.getByRole("button", { name: "Anmelden" }));

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Sitzung konnte nicht bestätigt werden.",
  );
  fireEvent.click(screen.getByRole("button", { name: "Erneut prüfen" }));

  expect(await screen.findByRole("heading", { name: "Administration" })).toBeInTheDocument();
  expect(screen.getByLabelText("Admin-Passwort")).toHaveValue("");
});

test("the selected event dashboard renders exact totals, sponsor links, and safe team sessions", async () => {
  stubAuthenticated(populatedDetail);

  render(<App />);

  expect(await screen.findByRole("heading", { name: "RT22 Sommerfest" })).toBeInTheDocument();
  expect(screen.getByRole("region", { name: "Gutschein-Übersicht" })).toHaveTextContent(
    "12Ausgegeben8Verfügbar4Eingelöst",
  );
  expect(screen.getByRole("table", { name: "Sponsoren" })).toHaveTextContent(
    "Muster Sponsor1284",
  );
  expect(screen.getByDisplayValue(`http://localhost:3000/s/${"a".repeat(32)}`)).toHaveAttribute(
    "readonly",
  );
  const sessions = screen.getByRole("table", { name: "Team-Sitzungen" });
  expect(sessions).toHaveTextContent("Anna");
  expect(sessions).toHaveTextContent("Aktiv");
  expect(screen.getByRole("link", { name: "Team-Anmeldung öffnen" })).toHaveAttribute(
    "href",
    `/team/${event.publicId}`,
  );
  expect(
    getComputedStyle(
      screen.getByRole("button", { name: "Gutscheine für Muster Sponsor – 1 Bier erstellen" }),
    ).whiteSpace,
  ).toBe("nowrap");
  expect(screen.getByRole("button", { name: "CSV exportieren" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Abmelden" })).toBeInTheDocument();
});

test("an admin can select another event without retaining stale event details", async () => {
  const secondEvent = { ...event, id: "event-b", publicId: "q".repeat(22), name: "Winterfest" };
  const secondDetail = { ...emptyDetail, event: secondEvent };
  const fetchMock = stubFetch(
    jsonResponse({ events: [event, secondEvent] }),
    jsonResponse(emptyDetail),
    jsonResponse(secondDetail),
  );

  render(<App />);
  expect(await screen.findByRole("heading", { name: "RT22 Sommerfest" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /Winterfest/ }));

  await waitFor(() => {
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "/api/admin/events/event-b",
      expect.objectContaining({ cache: "no-store" }),
    );
  });
  expect(screen.getByRole("heading", { name: "Winterfest" })).toBeInTheDocument();
});

test("a failed event-detail request fails closed and offers an explicit retry", async () => {
  const secondEvent = { ...event, id: "event-b", publicId: "q".repeat(22), name: "Winterfest" };
  const secondDetail = { ...emptyDetail, event: secondEvent };
  const fetchMock = stubFetch(
    jsonResponse({ events: [event, secondEvent] }),
    jsonResponse(emptyDetail),
    new TypeError("network unavailable"),
    jsonResponse(secondDetail),
  );

  render(<App />);
  expect(await screen.findByRole("heading", { name: event.name })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /Winterfest/ }));

  expect(await screen.findByRole("alert")).toHaveTextContent("Event konnte nicht geladen werden.");
  expect(screen.queryByRole("region", { name: "Gutschein-Übersicht" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Eventdaten erneut laden" }));

  expect(await screen.findByRole("region", { name: "Gutschein-Übersicht" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Winterfest" })).toBeInTheDocument();
  expect(fetchMock).toHaveBeenNthCalledWith(
    4,
    "/api/admin/events/event-b",
    expect.objectContaining({ cache: "no-store" }),
  );
});

test("creating and selecting a new event clears pending actions from the previous event", async () => {
  const secondEvent = { ...event, id: "event-b", publicId: "q".repeat(22), name: "Winterfest" };
  const secondDetail = { ...emptyDetail, event: secondEvent };
  const fetchMock = stubFetch(
    jsonResponse({ events: [event] }),
    jsonResponse(populatedDetail),
    jsonResponse({ event: secondEvent }, 201),
    jsonResponse({ events: [event, secondEvent] }),
    jsonResponse(secondDetail),
  );

  render(<App />);
  expect(await screen.findByRole("heading", { name: event.name })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "PIN ändern" }));
  fireEvent.change(screen.getByLabelText("Neue sechsstellige Team-PIN"), {
    target: { value: "654321" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Alle Sitzungen widerrufen" }));
  expect(screen.getByRole("button", { name: "Widerruf bestätigen" })).toBeInTheDocument();

  fireEvent.click(screen.getByText("Neues Event erstellen"));
  fireEvent.change(screen.getByLabelText("Eventname"), { target: { value: secondEvent.name } });
  fireEvent.change(screen.getByLabelText("Eventdatum"), { target: { value: secondEvent.eventDate } });
  fireEvent.change(screen.getByLabelText("Sechsstellige Team-PIN"), {
    target: { value: "246810" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Event erstellen" }));

  expect(await screen.findByText("Noch keine Team-Sitzungen vorhanden.")).toBeInTheDocument();
  expect(screen.queryByLabelText("Neue sechsstellige Team-PIN")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Widerruf bestätigen" })).not.toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(5);
});

test("creating an event refreshes and selects the server-confirmed event", async () => {
  const fetchMock = stubFetch(
    jsonResponse({ events: [] }),
    jsonResponse({ event }, 201),
    jsonResponse({ events: [event] }),
    jsonResponse(emptyDetail),
  );

  render(<App />);
  expect(await screen.findByRole("heading", { name: "Noch kein Event" })).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Eventname"), { target: { value: event.name } });
  fireEvent.change(screen.getByLabelText("Eventdatum"), { target: { value: event.eventDate } });
  fireEvent.change(screen.getByLabelText("Sechsstellige Team-PIN"), {
    target: { value: "246810" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Event erstellen" }));

  expect(await screen.findByRole("status")).toHaveTextContent("Event wurde erstellt.");
  expect(screen.getByRole("heading", { name: event.name })).toBeInTheDocument();
  expect(fetchMock).toHaveBeenNthCalledWith(
    2,
    "/api/admin/events",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ name: event.name, eventDate: event.eventDate, teamPin: "246810" }),
    }),
  );
});

test("sponsor creation, private-link copy, and voucher issuance use confirmed server data", async () => {
  const copied = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: copied },
  });
  const sponsor = populatedDetail.sponsors[0];
  const voucherType = sponsor.voucherTypes[0];
  if (!voucherType) {
    throw new Error("Expected voucher type fixture");
  }
  const fetchMock = stubFetch(
    jsonResponse({ events: [event] }),
    jsonResponse(emptyDetail),
    jsonResponse({ sponsor, sponsorUrl: `http://localhost:3000/s/${sponsor.accessId}` }, 201),
    jsonResponse({
      ...emptyDetail,
      sponsors: [
        {
          ...sponsor,
          issuedCount: 0,
          availableCount: 0,
          redeemedCount: 0,
          voucherTypes: [],
        },
      ],
    }),
    jsonResponse({ voucherType: { ...voucherType, name: "1 Bier" } }, 201),
    jsonResponse({
      ...emptyDetail,
      sponsors: [
        {
          ...sponsor,
          issuedCount: 0,
          availableCount: 0,
          redeemedCount: 0,
          voucherTypes: [{ ...voucherType, issuedCount: 0, availableCount: 0, redeemedCount: 0 }],
        },
      ],
    }),
    jsonResponse({ issuedCount: 12, totalSponsorCount: 12, sponsor }, 201),
    jsonResponse(populatedDetail),
  );

  render(<App />);
  expect(await screen.findByRole("heading", { name: event.name })).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Sponsorname"), { target: { value: sponsor.name } });
  fireEvent.click(screen.getByRole("button", { name: "Sponsor hinzufügen" }));

  expect(await screen.findByRole("status")).toHaveTextContent("Sponsor wurde angelegt.");
  fireEvent.click(screen.getByRole("button", { name: `Link für ${sponsor.name} kopieren` }));
  await waitFor(() =>
    expect(copied).toHaveBeenCalledWith(`http://localhost:3000/s/${sponsor.accessId}`),
  );
  expect(screen.getByRole("status")).toHaveTextContent("Sponsor-Link wurde kopiert.");

  fireEvent.click(screen.getByRole("button", { name: "Gutscheinart hinzufügen" }));
  fireEvent.change(screen.getByLabelText(`Neue Gutscheinart für ${sponsor.name}`), {
    target: { value: "1 Bier" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Gutscheinart anlegen" }));

  expect(await screen.findByRole("status")).toHaveTextContent("Gutscheinart wurde angelegt.");
  fireEvent.click(
    screen.getByRole("button", { name: `Gutscheine für ${sponsor.name} – 1 Bier erstellen` }),
  );
  fireEvent.change(screen.getByLabelText(`Anzahl Gutscheine für ${sponsor.name} – 1 Bier`), {
    target: { value: "12" },
  });
  fireEvent.click(screen.getByRole("button", { name: "12 Gutscheine für 1 Bier erstellen" }));

  expect(await screen.findByRole("status")).toHaveTextContent("12 Gutscheine wurden erstellt.");
  expect(screen.getByRole("table", { name: "Sponsoren" })).toHaveTextContent("1284");
  expect(fetchMock).toHaveBeenNthCalledWith(
    7,
    "/api/admin/events/event-a/sponsors/sponsor-a/voucher-types/voucher-type-a/vouchers",
    expect.objectContaining({ method: "POST", body: JSON.stringify({ count: 12 }) }),
  );
});

test("a clipboard failure is announced and keeps the private sponsor link manually available", async () => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn().mockRejectedValue(new DOMException("denied", "NotAllowedError")) },
  });
  stubAuthenticated(populatedDetail);

  render(<App />);
  const manualLink = await screen.findByLabelText("Sponsor-Link für Muster Sponsor");
  fireEvent.click(screen.getByRole("button", { name: "Link für Muster Sponsor kopieren" }));

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Link konnte nicht kopiert werden. Er bleibt im Feld sichtbar.",
  );
  expect(manualLink).toHaveValue(`http://localhost:3000/s/${"a".repeat(32)}`);
  expect(manualLink).toHaveAttribute("readonly");
});

test("an admin can load the next bounded sponsor page and recover the later private link", async () => {
  const laterSponsor = {
    ...populatedDetail.sponsors[0],
    id: "sponsor-501",
    name: "Sponsor Nummer 501",
    accessId: "z".repeat(32),
    createdAt: "2026-08-20T15:00:00.000Z",
    issuedCount: 0,
    availableCount: 0,
    redeemedCount: 0,
  };
  const fetchMock = stubFetch(
    jsonResponse({ events: [event] }),
    jsonResponse({ ...populatedDetail, sponsorsNextCursor: "page-500" }),
    jsonResponse({
      sponsors: [populatedDetail.sponsors[0], laterSponsor],
      nextCursor: null,
    }),
  );

  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Weitere Sponsoren laden" }));

  expect(await screen.findByLabelText("Sponsor-Link für Sponsor Nummer 501")).toHaveValue(
    `http://localhost:3000/s/${"z".repeat(32)}`,
  );
  expect(screen.getAllByLabelText("Sponsor-Link für Muster Sponsor")).toHaveLength(1);
  expect(screen.queryByRole("button", { name: "Weitere Sponsoren laden" })).not.toBeInTheDocument();
  expect(fetchMock).toHaveBeenNthCalledWith(
    3,
    "/api/admin/events/event-a/sponsors?cursor=page-500",
    expect.objectContaining({ cache: "no-store", credentials: "same-origin" }),
  );
});

test("a delayed sponsor page cannot append into a newly selected event", async () => {
  const sponsorPage = deferred<Response>();
  const secondEvent = { ...event, id: "event-b", publicId: "q".repeat(22), name: "Winterfest" };
  const secondDetail = { ...emptyDetail, event: secondEvent };
  const fetchMock = stubFetch(
    jsonResponse({ events: [event, secondEvent] }),
    jsonResponse({ ...populatedDetail, sponsorsNextCursor: "page-500" }),
    sponsorPage.promise,
    jsonResponse(secondDetail),
  );

  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Weitere Sponsoren laden" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  fireEvent.click(screen.getByRole("button", { name: /Winterfest/ }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
  expect(await screen.findByRole("heading", { name: secondEvent.name })).toBeInTheDocument();

  await act(async () => {
    sponsorPage.resolve(jsonResponse({ sponsors: populatedDetail.sponsors, nextCursor: null }));
  });

  expect(screen.getByRole("heading", { name: secondEvent.name })).toBeInTheDocument();
  expect(screen.queryByLabelText("Sponsor-Link für Muster Sponsor")).not.toBeInTheDocument();
});

test.each(["resolve", "reject"] as const)(
  "a deferred clipboard %s cannot restore a previously selected event",
  async (settlement) => {
    const clipboardWrite = deferred<void>();
    const writeText = vi.fn(() => clipboardWrite.promise);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const secondEvent = { ...event, id: "event-b", publicId: "q".repeat(22), name: "Winterfest" };
    const secondDetail = { ...emptyDetail, event: secondEvent };
    const fetchMock = stubFetch(
      jsonResponse({ events: [event, secondEvent] }),
      jsonResponse(populatedDetail),
      jsonResponse(secondDetail),
    );

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Link für Muster Sponsor kopieren" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: /Winterfest/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(await screen.findByRole("heading", { name: secondEvent.name })).toBeInTheDocument();

    await act(async () => {
      if (settlement === "resolve") {
        clipboardWrite.resolve(undefined);
      } else {
        clipboardWrite.reject(new DOMException("denied", "NotAllowedError"));
      }
    });

    expect(screen.getByRole("heading", { name: secondEvent.name })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: event.name })).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue(`http://localhost:3000/s/${"a".repeat(32)}`)).not.toBeInTheDocument();
    expect(screen.queryByText("Sponsor-Link wurde kopiert.")).not.toBeInTheDocument();
    expect(screen.queryByText("Link konnte nicht kopiert werden. Er bleibt im Feld sichtbar.")).not.toBeInTheDocument();
  },
);

test.each(["resolve", "reject"] as const)(
  "a deferred clipboard %s cannot restore private data after confirmed logout",
  async (settlement) => {
    const clipboardWrite = deferred<void>();
    const writeText = vi.fn(() => clipboardWrite.promise);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    stubAuthenticated(populatedDetail, new Response(null, { status: 204 }));

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Link für Muster Sponsor kopieren" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Abmelden" }));
    expect(await screen.findByRole("heading", { name: "Administration" })).toBeInTheDocument();

    await act(async () => {
      if (settlement === "resolve") {
        clipboardWrite.resolve(undefined);
      } else {
        clipboardWrite.reject(new DOMException("denied", "NotAllowedError"));
      }
    });

    expect(screen.getByRole("heading", { name: "Administration" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: event.name })).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue(`http://localhost:3000/s/${"a".repeat(32)}`)).not.toBeInTheDocument();
  },
);

test("PIN rotation and revoke-all require explicit actions and refresh session status", async () => {
  const fetchMock = stubFetch(
    jsonResponse({ events: [event] }),
    jsonResponse(populatedDetail),
    new Response(null, { status: 204 }),
    jsonResponse(populatedDetail),
    new Response(null, { status: 204 }),
    jsonResponse({
      ...populatedDetail,
      teamSessions: populatedDetail.teamSessions.map((session) => ({
        ...session,
        status: "superseded",
      })),
    }),
  );

  render(<App />);
  expect(await screen.findByRole("heading", { name: event.name })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "PIN ändern" }));
  fireEvent.change(screen.getByLabelText("Neue sechsstellige Team-PIN"), {
    target: { value: "654321" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Neue PIN speichern" }));
  expect(await screen.findByRole("status")).toHaveTextContent("Team-PIN wurde geändert.");

  fireEvent.click(screen.getByRole("button", { name: "Alle Sitzungen widerrufen" }));
  expect(screen.getByText("Wirklich alle Team-Sitzungen widerrufen?")).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(4);
  fireEvent.click(screen.getByRole("button", { name: "Widerruf bestätigen" }));

  expect(await screen.findByRole("status")).toHaveTextContent(
    "Alle Team-Sitzungen wurden widerrufen.",
  );
  expect(fetchMock).toHaveBeenNthCalledWith(
    3,
    "/api/admin/events/event-a/team-pin",
    expect.objectContaining({ method: "POST", body: JSON.stringify({ teamPin: "654321" }) }),
  );
  expect(fetchMock).toHaveBeenNthCalledWith(
    5,
    "/api/admin/events/event-a/revoke-team-sessions",
    expect.objectContaining({ method: "POST" }),
  );
});

test("CSV export downloads only after an authenticated successful response", async () => {
  stubAuthenticated(populatedDetail, new Response("csv-data", {
    status: 200,
    headers: { "Content-Type": "text/csv; charset=utf-8" },
  }));
  const createObjectUrl = vi.fn(() => "blob:admin-csv");
  const revokeObjectUrl = vi.fn();
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectUrl });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectUrl });
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "CSV exportieren" }));

  expect(await screen.findByRole("status")).toHaveTextContent("CSV wurde heruntergeladen.");
  expect(createObjectUrl).toHaveBeenCalledWith(expect.any(Blob));
  expect(click).toHaveBeenCalledTimes(1);
  expect(revokeObjectUrl).toHaveBeenCalledWith("blob:admin-csv");
});

test("an admin can download the selected sponsor QR package with an explicit busy state", async () => {
  const exportResponse = deferred<Response>();
  const fetchMock = stubAuthenticated(populatedDetail, exportResponse.promise);
  const createObjectUrl = vi.fn(() => "blob:admin-qr");
  const revokeObjectUrl = vi.fn();
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectUrl });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectUrl });
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

  render(<App />);
  const downloadButton = await screen.findByRole("button", {
    name: "QR-Paket herunterladen (1 Bier, 12)",
  });
  expect(downloadButton).toHaveTextContent("QR-Paket herunterladen (12)");
  expect(downloadButton).not.toHaveTextContent("1 Bier");
  fireEvent.click(downloadButton);

  expect(
    await screen.findByRole("button", { name: "QR-Paket wird erstellt (1 Bier, 12)" }),
  ).toBeDisabled();
  expect(fetchMock).toHaveBeenNthCalledWith(
    3,
    "/api/admin/events/event-a/sponsors/sponsor-a/voucher-types/voucher-type-a/qr-export",
    expect.objectContaining({ cache: "no-store", credentials: "same-origin" }),
  );

  await act(async () => {
    exportResponse.resolve(
      jsonResponse({
        sponsorName: "Muster Sponsor",
        voucherTypeName: "1 Bier",
        vouchers: [{ publicId: "public-a", displayCode: "ABCD-EFGH", status: "available" }],
      }),
    );
  });

  expect(await screen.findByRole("status")).toHaveTextContent("QR-Paket wurde heruntergeladen.");
  expect(createObjectUrl).toHaveBeenCalledWith(expect.any(Blob));
  expect(click).toHaveBeenCalledTimes(1);
  expect(revokeObjectUrl).toHaveBeenCalledWith("blob:admin-qr");
});

test("a sponsor without issued vouchers has no misleading QR package action", async () => {
  const emptySponsorDetail = {
    ...emptyDetail,
    sponsors: [{
      ...populatedDetail.sponsors[0],
      issuedCount: 0,
      availableCount: 0,
      redeemedCount: 0,
      voucherTypes: [
        {
          ...populatedDetail.sponsors[0].voucherTypes[0],
          issuedCount: 0,
          availableCount: 0,
          redeemedCount: 0,
        },
      ],
    }],
  };
  stubAuthenticated(emptySponsorDetail);

  render(<App />);

  expect(await screen.findByText("Muster Sponsor")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /QR-Paket/ })).not.toBeInTheDocument();
});

test("a QR package network failure is announced without a successful download", async () => {
  const fetchMock = stubAuthenticated(populatedDetail, new TypeError("network unavailable"));
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

  render(<App />);
  fireEvent.click(
    await screen.findByRole("button", { name: "QR-Paket herunterladen (1 Bier, 12)" }),
  );

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "QR-Paket konnte nicht heruntergeladen werden.",
  );
  expect(screen.queryByText("QR-Paket wurde heruntergeladen.")).not.toBeInTheDocument();
  expect(click).not.toHaveBeenCalled();
  expect(fetchMock).toHaveBeenNthCalledWith(
    3,
    "/api/admin/events/event-a/sponsors/sponsor-a/voucher-types/voucher-type-a/qr-export",
    expect.any(Object),
  );
});

test("network and authentication failures never show a successful admin action", async () => {
  const fetchMock = stubFetch(
    jsonResponse({ events: [event] }),
    jsonResponse(emptyDetail),
    new TypeError("network unavailable"),
    jsonResponse({ error: "Unauthorized" }, 401),
  );

  render(<App />);
  expect(await screen.findByRole("heading", { name: event.name })).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Sponsorname"), { target: { value: "Netzwerk Sponsor" } });
  fireEvent.click(screen.getByRole("button", { name: "Sponsor hinzufügen" }));

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Sponsor konnte nicht angelegt werden.",
  );
  expect(screen.queryByText("Sponsor wurde angelegt.")).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "CSV exportieren" }));
  expect(await screen.findByRole("heading", { name: "Administration" })).toBeInTheDocument();
  expect(screen.queryByText("CSV wurde heruntergeladen.")).not.toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(4);
});

test("pending logout immediately unmounts every private admin value", async () => {
  const logoutResponse = deferred<Response>();
  stubFetch(
    jsonResponse({ events: [event] }),
    jsonResponse(populatedDetail),
    logoutResponse.promise,
  );

  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Abmelden" }));

  expect(screen.getByRole("status")).toHaveTextContent("Abmeldung läuft …");
  expect(screen.queryByRole("heading", { name: event.name })).not.toBeInTheDocument();
  expect(screen.queryByRole("table", { name: "Sponsoren" })).not.toBeInTheDocument();
  expect(screen.queryByDisplayValue(`http://localhost:3000/s/${"a".repeat(32)}`)).not.toBeInTheDocument();
});

test("a committed logout with a lost response confirms 401 before showing login", async () => {
  const logoutResponse = deferred<Response>();
  const fetchMock = stubFetch(
    jsonResponse({ events: [event] }),
    jsonResponse(populatedDetail),
    logoutResponse.promise,
    jsonResponse({ error: "Unauthorized" }, 401),
  );

  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Abmelden" }));
  await act(async () => logoutResponse.reject(new TypeError("logout response lost")));

  expect(await screen.findByRole("heading", { name: "Administration" })).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: event.name })).not.toBeInTheDocument();
  expect(screen.queryByDisplayValue(`http://localhost:3000/s/${"a".repeat(32)}`)).not.toBeInTheDocument();
  expect(fetchMock).toHaveBeenNthCalledWith(
    4,
    "/api/admin/events",
    expect.objectContaining({ cache: "no-store", credentials: "same-origin" }),
  );
});

test("an unexpected logout 200 is ambiguous and requires a fresh authenticated read", async () => {
  const fetchMock = stubFetch(
    jsonResponse({ events: [event] }),
    jsonResponse(populatedDetail),
    new Response(null, { status: 200 }),
    jsonResponse({ events: [event] }),
    jsonResponse(populatedDetail),
  );

  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Abmelden" }));

  expect(await screen.findByRole("heading", { name: event.name })).toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Abmelden nicht möglich. Bitte Verbindung prüfen.",
  );
  expect(fetchMock).toHaveBeenNthCalledWith(
    4,
    "/api/admin/events",
    expect.objectContaining({ cache: "no-store", credentials: "same-origin" }),
  );
});

test("a failed logout restores only a freshly authenticated dashboard", async () => {
  const logoutResponse = deferred<Response>();
  const freshEvent = { ...event, name: "Frisch bestätigtes Event" };
  const freshDetail = {
    ...populatedDetail,
    event: freshEvent,
    sponsors: [
      {
        ...populatedDetail.sponsors[0],
        name: "Frisch bestätigter Sponsor",
        accessId: "f".repeat(32),
      },
    ],
  };
  stubFetch(
    jsonResponse({ events: [event] }),
    jsonResponse(populatedDetail),
    logoutResponse.promise,
    jsonResponse({ events: [freshEvent] }),
    jsonResponse(freshDetail),
  );

  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Abmelden" }));
  await act(async () => logoutResponse.reject(new TypeError("logout request failed")));

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Abmelden nicht möglich. Bitte Verbindung prüfen.",
  );
  expect(screen.getByRole("heading", { name: freshEvent.name })).toBeInTheDocument();
  expect(screen.getByDisplayValue(`http://localhost:3000/s/${"f".repeat(32)}`)).toBeInTheDocument();
  expect(screen.queryByDisplayValue(`http://localhost:3000/s/${"a".repeat(32)}`)).not.toBeInTheDocument();
});

test("an unverifiable logout remains data-free until an explicit status retry", async () => {
  const logoutResponse = deferred<Response>();
  const fetchMock = stubFetch(
    jsonResponse({ events: [event] }),
    jsonResponse(populatedDetail),
    logoutResponse.promise,
    new TypeError("recovery unavailable"),
    jsonResponse({ events: [event] }),
    jsonResponse(populatedDetail),
  );

  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Abmelden" }));
  await act(async () => logoutResponse.reject(new TypeError("logout response lost")));

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Abmeldung konnte nicht bestätigt werden.",
  );
  expect(screen.getByRole("button", { name: "Status erneut prüfen" })).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: event.name })).not.toBeInTheDocument();
  expect(screen.queryByDisplayValue(`http://localhost:3000/s/${"a".repeat(32)}`)).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Status erneut prüfen" }));
  expect(await screen.findByRole("heading", { name: event.name })).toBeInTheDocument();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Abmelden nicht möglich. Bitte Verbindung prüfen.",
  );
  expect(fetchMock).toHaveBeenCalledTimes(6);
});

test("logout returns to the login surface after the server confirms it", async () => {
  stubAuthenticated(populatedDetail, new Response(null, { status: 204 }));

  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Abmelden" }));

  expect(await screen.findByRole("heading", { name: "Administration" })).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: event.name })).not.toBeInTheDocument();
});

test("long event, sponsor, and session names remain wrap-safe", async () => {
  const longName = "L".repeat(80);
  stubAuthenticated({
    ...populatedDetail,
    event: { ...event, name: longName },
    sponsors: [{ ...populatedDetail.sponsors[0], name: longName }],
    teamSessions: [{ ...populatedDetail.teamSessions[0], displayName: longName }],
  });

  render(<App />);

  const matches = await screen.findAllByText(longName);
  expect(matches.length).toBeGreaterThanOrEqual(3);
  for (const match of matches) {
    expect(getComputedStyle(match).overflowWrap).toBe("anywhere");
  }
});

function stubAuthenticated(
  detail: unknown,
  ...extra: Array<Response | Error | Promise<Response>>
): ReturnType<typeof stubFetch> {
  return stubFetch(jsonResponse({ events: [event] }), jsonResponse(detail), ...extra);
}

function stubFetch(...responses: Array<Response | Error | Promise<Response>>): ReturnType<typeof vi.fn<typeof fetch>> {
  const fetchMock = vi.fn<typeof fetch>();
  for (const response of responses) {
    if (response instanceof Promise) {
      fetchMock.mockReturnValueOnce(response);
    } else if (response instanceof Error) {
      fetchMock.mockRejectedValueOnce(response);
    } else {
      fetchMock.mockResolvedValueOnce(response);
    }
  }
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
} {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
