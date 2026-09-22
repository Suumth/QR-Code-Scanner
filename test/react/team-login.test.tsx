import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import App from "../../src/App";
import { qrCamera } from "../../src/features/team/camera";
import { scannerApi } from "../../src/features/team/scannerApi";
import { TeamLoginPage } from "../../src/features/team/TeamLoginPage";

const EVENT_PUBLIC_ID = "e".repeat(22);
const sessionResponse = {
  session: {
    displayName: "Mara",
    expiresAt: "2026-08-21T08:00:00.000Z",
    lastSeenAt: "2026-08-20T16:00:00.000Z",
    event: {
      id: "event-internal-id",
      publicId: EVENT_PUBLIC_ID,
      name: "RT22 Sommerfest",
      eventDate: "2026-08-20",
    },
  },
} as const;

beforeEach(() => {
  window.history.replaceState({}, "", `/team/${EVENT_PUBLIC_ID}`);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
});

test("an unauthenticated mobile team route shows a semantic German login form", async () => {
  stubFetch(jsonResponse({ error: "Unauthorized" }, 401));

  render(<App />);

  expect(await screen.findByRole("heading", { name: "Team anmelden" })).toBeInTheDocument();
  const name = screen.getByRole("textbox", { name: "Dein Name" });
  const pin = screen.getByLabelText("Event-PIN");
  expect(name).toHaveAttribute("autocomplete", "name");
  expect(name).toHaveAttribute("maxlength", "80");
  expect(pin).toHaveAttribute("inputmode", "numeric");
  expect(pin).toHaveAttribute("autocomplete", "one-time-code");
  expect(pin).toHaveAttribute("maxlength", "6");
  expect(pin).toHaveAttribute("pattern", "[0-9]{6}");
  expect(screen.getByRole("button", { name: "Anmelden" })).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Einsatzbereit" })).not.toBeInTheDocument();
});

test("successful login renders the scanner only after an authenticated session bootstrap", async () => {
  let resolveBootstrap: ((response: Response) => void) | undefined;
  const authenticatedBootstrap = new Promise<Response>((resolve) => {
    resolveBootstrap = resolve;
  });
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(jsonResponse({ error: "Unauthorized" }, 401))
    .mockResolvedValueOnce(new Response(null, { status: 204 }))
    .mockReturnValueOnce(authenticatedBootstrap);
  vi.stubGlobal("fetch", fetchMock);

  render(<App />);
  fireEvent.change(await screen.findByRole("textbox", { name: "Dein Name" }), {
    target: { value: "Mara" },
  });
  fireEvent.change(screen.getByLabelText("Event-PIN"), { target: { value: "246810" } });
  fireEvent.click(screen.getByRole("button", { name: "Anmelden" }));

  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  expect(screen.queryByRole("heading", { name: "Gutschein scannen" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Sitzung wird geprüft …" })).toBeDisabled();

  resolveBootstrap?.(jsonResponse(sessionResponse));
  expect(
    await screen.findByRole("heading", { name: "Kamera nicht verfügbar" }),
  ).toBeInTheDocument();
  expect(screen.getByText("RT22 Sommerfest")).toBeInTheDocument();
  expect(screen.getByText("Angemeldet als Mara")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Abmelden" })).toBeInTheDocument();
  expect(fetchMock).toHaveBeenNthCalledWith(
    2,
    `/api/team/${EVENT_PUBLIC_ID}/login`,
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ displayName: "Mara", pin: "246810" }),
    }),
  );
  expect(fetchMock).toHaveBeenNthCalledWith(
    3,
    "/api/team/session",
    expect.objectContaining({ cache: "no-store" }),
  );
});

test("home login uses the existing selected-event login endpoint and reaches the scanner", async () => {
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      jsonResponse({
        events: [
          { publicId: EVENT_PUBLIC_ID, name: "RT22 Sommerfest", eventDate: "2026-08-20" },
        ],
      }),
    )
    .mockResolvedValueOnce(jsonResponse({ error: "Unauthorized" }, 401))
    .mockResolvedValueOnce(new Response(null, { status: 204 }))
    .mockResolvedValueOnce(jsonResponse(sessionResponse));
  vi.stubGlobal("fetch", fetchMock);

  window.history.replaceState({}, "", "/");
  render(<App />);
  await submitLogin();

  expect(await screen.findByRole("heading", { name: "Kamera nicht verfügbar" })).toBeInTheDocument();
  expect(fetchMock).toHaveBeenNthCalledWith(
    3,
    `/api/team/${EVENT_PUBLIC_ID}/login`,
    expect.objectContaining({ method: "POST" }),
  );
  expect(fetchMock.mock.calls[2]?.[0]).not.toContain("/api/team/events/login");
});

test("wrong credentials stay on login and never render a ready state", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ error: "Unauthorized" }, 401))
      .mockResolvedValueOnce(jsonResponse({ error: "Invalid credentials" }, 401)),
  );

  render(<App />);
  await submitLogin();

  expect(await screen.findByRole("alert")).toHaveTextContent("Name oder PIN stimmen nicht.");
  expect(screen.queryByRole("heading", { name: "Gutschein scannen" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Anmelden" })).toBeEnabled();
});

test("a login network failure stays on login and never renders a ready state", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ error: "Unauthorized" }, 401))
      .mockRejectedValueOnce(new TypeError("network unavailable")),
  );

  render(<App />);
  await submitLogin();

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Keine Verbindung. Bitte erneut versuchen.",
  );
  expect(screen.queryByRole("heading", { name: "Gutschein scannen" })).not.toBeInTheDocument();
});

test("a network failure after the login response never implies an authenticated ready state", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ error: "Unauthorized" }, 401))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockRejectedValueOnce(new TypeError("bootstrap network unavailable")),
  );

  render(<App />);
  await submitLogin();

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Sitzung konnte nicht bestätigt werden.",
  );
  expect(screen.queryByRole("heading", { name: "Einsatzbereit" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Erneut prüfen" })).toBeInTheDocument();
});

test("an existing authenticated cookie bootstraps directly into the scanner", async () => {
  stubFetch(jsonResponse(sessionResponse));

  render(<App />);

  expect(
    await screen.findByRole("heading", { name: "Kamera nicht verfügbar" }),
  ).toBeInTheDocument();
  expect(screen.getByText("Angemeldet als Mara")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Anmelden" })).not.toBeInTheDocument();
});

test("an accepted unbroken display name can wrap instead of being clipped on mobile", async () => {
  const displayName = "M".repeat(80);
  stubFetch(
    jsonResponse({
      session: { ...sessionResponse.session, displayName },
    }),
  );

  render(<App />);

  const member = await screen.findByText(`Angemeldet als ${displayName}`);
  expect(getComputedStyle(member).overflowWrap).toBe("anywhere");
});

test("a session for another event never authenticates this event-specific team route", async () => {
  stubFetch(
    jsonResponse({
      session: {
        ...sessionResponse.session,
        event: { ...sessionResponse.session.event, publicId: "x".repeat(22) },
      },
    }),
  );

  render(<App />);

  expect(await screen.findByRole("heading", { name: "Team anmelden" })).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Gutschein scannen" })).not.toBeInTheDocument();
  expect(screen.queryByText("Angemeldet als Mara")).not.toBeInTheDocument();
});

test("an initial bootstrap network error is recoverable and never falls through to login or ready", async () => {
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockRejectedValue(new TypeError("offline")));

  render(<App />);

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Sitzung konnte nicht geprüft werden.",
  );
  expect(screen.getByRole("button", { name: "Erneut prüfen" })).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Team anmelden" })).not.toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Gutschein scannen" })).not.toBeInTheDocument();
});

test("logout immediately unmounts the scanner, stops its camera, and aborts its summary", async () => {
  const logout = deferred<Response>();
  vi.stubGlobal(
    "fetch",
    vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(sessionResponse))
      .mockReturnValueOnce(logout.promise),
  );
  const stopCamera = vi.fn();
  vi.spyOn(qrCamera, "start").mockResolvedValue({ stop: stopCamera });
  let summarySignal: AbortSignal | undefined;
  vi.spyOn(scannerApi, "eventSummary").mockImplementation((signal) => {
    summarySignal = signal;
    return new Promise(() => undefined);
  });
  const redeem = vi.spyOn(scannerApi, "redeem");

  render(<TeamLoginPage eventPublicId={EVENT_PUBLIC_ID} />);

  expect(await screen.findByRole("heading", { name: "Gutschein scannen" })).toBeInTheDocument();
  await waitFor(() => expect(summarySignal).toBeDefined());
  fireEvent.click(screen.getByRole("button", { name: "Abmelden" }));

  expect(screen.getByRole("status")).toHaveTextContent("Abmeldung läuft …");
  expect(screen.queryByRole("heading", { name: "Gutschein scannen" })).not.toBeInTheDocument();
  expect(screen.queryByRole("textbox", { name: "Gutscheincode" })).not.toBeInTheDocument();
  expect(stopCamera).toHaveBeenCalledTimes(1);
  expect(summarySignal?.aborted).toBe(true);
  expect(redeem).not.toHaveBeenCalled();
});

test("logout aborts an in-flight inspection", async () => {
  const logout = deferred<Response>();
  stubAuthenticatedThenLogout(logout.promise);
  vi.spyOn(qrCamera, "start").mockResolvedValue({ stop: vi.fn() });
  vi.spyOn(scannerApi, "eventSummary").mockResolvedValue({ redeemedCount: 0 });
  let inspectSignal: AbortSignal | undefined;
  vi.spyOn(scannerApi, "inspect").mockImplementation((_locator, signal) => {
    inspectSignal = signal;
    return new Promise(() => undefined);
  });

  render(<TeamLoginPage eventPublicId={EVENT_PUBLIC_ID} />);
  await submitManualCode();
  expect(await screen.findByRole("heading", { name: "Gutschein wird geprüft …" })).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Abmelden" }));

  expect(screen.getByRole("status")).toHaveTextContent("Abmeldung läuft …");
  expect(inspectSignal?.aborted).toBe(true);
});

test("logout aborts an in-flight redemption and ignores its late success", async () => {
  const logout = deferred<Response>();
  const redemption = deferred<Awaited<ReturnType<typeof scannerApi.redeem>>>();
  stubAuthenticatedThenLogout(logout.promise);
  vi.spyOn(qrCamera, "start").mockResolvedValue({ stop: vi.fn() });
  vi.spyOn(scannerApi, "eventSummary").mockResolvedValue({ redeemedCount: 0 });
  vi.spyOn(scannerApi, "inspect").mockResolvedValue(scannerAvailable);
  let redeemSignal: AbortSignal | undefined;
  vi.spyOn(scannerApi, "redeem").mockImplementation((_locator, signal) => {
    redeemSignal = signal;
    return redemption.promise;
  });

  render(<TeamLoginPage eventPublicId={EVENT_PUBLIC_ID} />);
  await submitManualCode();
  fireEvent.click(await screen.findByRole("button", { name: "Jetzt einlösen" }));
  expect(
    await screen.findByRole("heading", { name: "Einlösung wird bestätigt …" }),
  ).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Abmelden" }));
  expect(screen.getByRole("status")).toHaveTextContent("Abmeldung läuft …");
  expect(redeemSignal?.aborted).toBe(true);

  await act(async () => {
    redemption.resolve(scannerRedeemed);
  });
  expect(screen.queryByRole("heading", { name: "Eingelöst" })).not.toBeInTheDocument();
});

test("no new redemption can begin while logout is pending", async () => {
  const logout = deferred<Response>();
  stubAuthenticatedThenLogout(logout.promise);
  vi.spyOn(qrCamera, "start").mockResolvedValue({ stop: vi.fn() });
  vi.spyOn(scannerApi, "eventSummary").mockResolvedValue({ redeemedCount: 0 });
  vi.spyOn(scannerApi, "inspect").mockResolvedValue(scannerAvailable);
  const redeem = vi.spyOn(scannerApi, "redeem").mockResolvedValue(scannerRedeemed);

  render(<TeamLoginPage eventPublicId={EVENT_PUBLIC_ID} />);
  await submitManualCode();
  const redeemButton = await screen.findByRole("button", { name: "Jetzt einlösen" });

  fireEvent.click(screen.getByRole("button", { name: "Abmelden" }));
  expect(screen.queryByRole("button", { name: "Jetzt einlösen" })).not.toBeInTheDocument();
  fireEvent.click(redeemButton);
  expect(redeem).not.toHaveBeenCalled();
});

test("a failed logout restores a fresh scanner only after GET confirms the same active session", async () => {
  const logout = deferred<Response>();
  const refreshedSessionResponse = {
    session: {
      ...sessionResponse.session,
      displayName: "Mara frisch bestätigt",
      lastSeenAt: "2026-08-20T16:05:00.000Z",
    },
  } as const;
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(jsonResponse(sessionResponse))
    .mockReturnValueOnce(logout.promise)
    .mockResolvedValueOnce(jsonResponse(refreshedSessionResponse));
  vi.stubGlobal("fetch", fetchMock);
  const originalCameraStop = vi.fn();
  const freshCameraStop = vi.fn();
  const startCamera = vi
    .spyOn(qrCamera, "start")
    .mockResolvedValueOnce({ stop: originalCameraStop })
    .mockResolvedValueOnce({ stop: freshCameraStop });
  vi.spyOn(scannerApi, "eventSummary").mockResolvedValue({ redeemedCount: 0 });

  render(<TeamLoginPage eventPublicId={EVENT_PUBLIC_ID} />);
  expect(await screen.findByRole("heading", { name: "Gutschein scannen" })).toBeInTheDocument();
  expect(startCamera).toHaveBeenCalledTimes(1);

  fireEvent.click(screen.getByRole("button", { name: "Abmelden" }));
  expect(screen.getByRole("status")).toHaveTextContent("Abmeldung läuft …");
  expect(originalCameraStop).toHaveBeenCalledTimes(1);
  expect(startCamera).toHaveBeenCalledTimes(1);

  await act(async () => {
    logout.reject(new TypeError("network unavailable"));
  });
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Abmelden nicht möglich. Bitte Verbindung prüfen.",
  );
  expect(screen.getByText("Angemeldet als Mara frisch bestätigt")).toBeInTheDocument();
  await waitFor(() => expect(startCamera).toHaveBeenCalledTimes(2));
  expect(freshCameraStop).not.toHaveBeenCalled();
  expect(fetchMock).toHaveBeenNthCalledWith(
    3,
    "/api/team/session",
    expect.objectContaining({ cache: "no-store", credentials: "same-origin" }),
  );
  const logoutSignal = fetchMock.mock.calls[1]?.[1]?.signal;
  const recoverySignal = fetchMock.mock.calls[2]?.[1]?.signal;
  expect(recoverySignal).toBeInstanceOf(AbortSignal);
  expect(recoverySignal).not.toBe(logoutSignal);
});

test.each([
  ["missing session", jsonResponse({ error: "Unauthorized" }, 401)],
  [
    "wrong-event session",
    jsonResponse({
      session: {
        ...sessionResponse.session,
        event: { ...sessionResponse.session.event, publicId: "x".repeat(22) },
      },
    }),
  ],
])("an ambiguous logout with %s goes to login without restoring the scanner", async (_case, recoveryResponse) => {
  const logout = deferred<Response>();
  vi.stubGlobal(
    "fetch",
    vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(sessionResponse))
      .mockReturnValueOnce(logout.promise)
      .mockResolvedValueOnce(recoveryResponse),
  );
  vi.spyOn(qrCamera, "start").mockResolvedValue({ stop: vi.fn() });
  vi.spyOn(scannerApi, "eventSummary").mockResolvedValue({ redeemedCount: 0 });

  render(<TeamLoginPage eventPublicId={EVENT_PUBLIC_ID} />);
  expect(await screen.findByRole("heading", { name: "Gutschein scannen" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Abmelden" }));

  await act(async () => {
    logout.reject(new TypeError("logout response lost"));
  });

  expect(await screen.findByRole("heading", { name: "Team anmelden" })).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Gutschein scannen" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Jetzt einlösen" })).not.toBeInTheDocument();
});

test("an unverifiable logout stays fail-closed and retries status without restoring stale scanner state", async () => {
  const logout = deferred<Response>();
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(jsonResponse(sessionResponse))
    .mockReturnValueOnce(logout.promise)
    .mockRejectedValueOnce(new TypeError("session recovery offline"))
    .mockResolvedValueOnce(jsonResponse(sessionResponse));
  vi.stubGlobal("fetch", fetchMock);
  const startCamera = vi.spyOn(qrCamera, "start").mockResolvedValue({ stop: vi.fn() });
  vi.spyOn(scannerApi, "eventSummary").mockResolvedValue({ redeemedCount: 0 });

  render(<TeamLoginPage eventPublicId={EVENT_PUBLIC_ID} />);
  expect(await screen.findByRole("heading", { name: "Gutschein scannen" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Abmelden" }));

  await act(async () => {
    logout.reject(new TypeError("logout response lost"));
  });

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Abmeldung konnte nicht bestätigt werden.",
  );
  expect(screen.getByRole("button", { name: "Status erneut prüfen" })).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Gutschein scannen" })).not.toBeInTheDocument();
  expect(startCamera).toHaveBeenCalledTimes(1);

  fireEvent.click(screen.getByRole("button", { name: "Status erneut prüfen" }));
  expect(await screen.findByRole("heading", { name: "Gutschein scannen" })).toBeInTheDocument();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Abmelden nicht möglich. Bitte Verbindung prüfen.",
  );
  expect(startCamera).toHaveBeenCalledTimes(2);
  expect(fetchMock).toHaveBeenCalledTimes(4);
});

async function submitLogin(): Promise<void> {
  fireEvent.change(await screen.findByRole("textbox", { name: "Dein Name" }), {
    target: { value: "Mara" },
  });
  fireEvent.change(screen.getByLabelText("Event-PIN"), { target: { value: "246810" } });
  fireEvent.click(screen.getByRole("button", { name: "Anmelden" }));
}

async function submitManualCode(): Promise<void> {
  fireEvent.change(await screen.findByRole("textbox", { name: "Gutscheincode" }), {
    target: { value: "ABCD-2345" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Code prüfen" }));
}

function stubAuthenticatedThenLogout(logout: Promise<Response>): void {
  vi.stubGlobal(
    "fetch",
    vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(sessionResponse))
      .mockReturnValueOnce(logout),
  );
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

const scannerAvailable = {
  status: "available",
  voucher: {
    publicId: "a".repeat(22),
    displayCode: "ABCD-2345",
    redeemedAt: null,
    event: { name: "RT22 Sommerfest", eventDate: "2026-08-20" },
    sponsor: { name: "Muster Sponsor" },
    voucherType: { name: "1 Bier" },
  },
} as const;

const scannerRedeemed = {
  status: "redeemed",
  voucher: {
    ...scannerAvailable.voucher,
    redeemedAt: "2026-08-20T18:00:00.000Z",
  },
} as const;

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}
