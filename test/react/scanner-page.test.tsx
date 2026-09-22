import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { CameraUnavailableError, type QrCamera } from "../../src/features/team/camera";
import { ScannerPage } from "../../src/features/team/ScannerPage";
import { createScannerApi } from "../../src/features/team/scannerApi";
import type { TeamSessionSnapshot } from "../../src/features/team/types";

const PUBLIC_ID = "a".repeat(22);
const QR_PAYLOAD = `${window.location.origin}/v/${PUBLIC_ID}`;
const session: TeamSessionSnapshot = {
  displayName: "Mara",
  expiresAt: "2026-08-21T08:00:00.000Z",
  lastSeenAt: "2026-08-20T16:00:00.000Z",
  event: {
    id: "event-internal-id",
    publicId: "e".repeat(22),
    name: "RT22 Sommerfest",
    eventDate: "2026-08-20",
  },
};
const available = {
  status: "available",
  voucher: {
    publicId: PUBLIC_ID,
    displayCode: "ABCD-2345",
    redeemedAt: null,
    event: { name: session.event.name, eventDate: session.event.eventDate },
    sponsor: { name: "Muster Sponsor" },
    voucherType: { name: "1 Essen" },
  },
} as const;
const redeemed = {
  status: "redeemed",
  voucher: {
    ...available.voucher,
    redeemedAt: "2026-08-20T18:00:00.000Z",
  },
} as const;

beforeEach(() => {
  setOnline(true);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("a camera scan inspects once, stays read-only while valid, and redeems only after explicit confirmation", async () => {
  const camera = cameraHarness();
  let summaryCalls = 0;
  const requests: Array<{ url: string; body?: string }> = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    requests.push({ url, body: init?.body?.toString() });
    if (url.endsWith("event-summary")) {
      summaryCalls += 1;
      return jsonResponse({ summary: { redeemedCount: summaryCalls === 1 ? 6 : 7 } });
    }
    if (url.endsWith("inspect")) {
      return jsonResponse(available);
    }
    return jsonResponse(redeemed);
  });

  renderScanner(camera.camera, fetcher);
  const resultAnnouncement = screen.getByRole("status", { name: "Scanner-Ergebnis" });
  expect(resultAnnouncement).toBeEmptyDOMElement();
  await camera.detect(QR_PAYLOAD);
  await camera.detect(QR_PAYLOAD);

  const availableHeading = await screen.findByRole("heading", { name: "Gutschein gültig" });
  expect(availableHeading).toHaveFocus();
  expect(availableHeading.closest('[role="status"]')).toBeNull();
  expect(screen.getByRole("status", { name: "Scanner-Ergebnis" })).toBe(resultAnnouncement);
  expect(resultAnnouncement).toHaveAttribute("aria-live", "polite");
  expect(resultAnnouncement).toHaveTextContent(
    "Gutschein gültig. 1 Essen. Muster Sponsor. Code ABCD-2345.",
  );
  expect(screen.getByText("Muster Sponsor")).toBeInTheDocument();
  expect(screen.getByText("1 Essen")).toBeInTheDocument();
  expect(screen.queryByText("1 Getränk", { exact: true })).not.toBeInTheDocument();
  expect(screen.getByText("ABCD-2345")).toBeInTheDocument();
  expect(requests.filter(({ url }) => url.endsWith("inspect"))).toHaveLength(1);
  expect(requests.filter(({ url }) => url.endsWith("redeem"))).toHaveLength(0);

  fireEvent.click(screen.getByRole("button", { name: "Jetzt einlösen" }));

  expect(await screen.findByRole("heading", { name: "Eingelöst" })).toBeInTheDocument();
  expect(screen.getByText("1 Essen · Muster Sponsor")).toBeInTheDocument();
  expect(screen.queryByText("1 Getränk", { exact: true })).not.toBeInTheDocument();
  expect(requests.filter(({ url }) => url.endsWith("redeem"))).toHaveLength(1);
  await waitFor(() => expect(screen.getByText("Heute eingelöst: 7")).toBeInTheDocument());
});

test("manual input uses the exact inspect then explicit redeem API path without a camera", async () => {
  const camera: QrCamera = {
    start: vi.fn(async () => Promise.reject(new CameraUnavailableError("unsupported"))),
  };
  const requests: Array<{ url: string; body?: string }> = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    requests.push({ url, body: init?.body?.toString() });
    if (url.endsWith("event-summary")) {
      return jsonResponse({ summary: { redeemedCount: 0 } });
    }
    return jsonResponse(url.endsWith("inspect") ? available : redeemed);
  });

  renderScanner(camera, fetcher);
  const resultAnnouncement = screen.getByRole("status", { name: "Scanner-Ergebnis" });
  expect(resultAnnouncement).toBeEmptyDOMElement();
  expect(
    await screen.findByRole("heading", { name: "Kamera nicht verfügbar" }),
  ).toBeInTheDocument();
  fireEvent.change(screen.getByRole("textbox", { name: "Gutscheincode" }), {
    target: { value: "abcd 2345" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Code prüfen" }));

  const availableHeading = await screen.findByRole("heading", { name: "Gutschein gültig" });
  expect(availableHeading).toHaveFocus();
  expect(availableHeading.closest('[role="status"]')).toBeNull();
  expect(screen.getByRole("status", { name: "Scanner-Ergebnis" })).toBe(resultAnnouncement);
  expect(resultAnnouncement).toHaveTextContent(
    "Gutschein gültig. 1 Essen. Muster Sponsor. Code ABCD-2345.",
  );
  expect(requests.find(({ url }) => url.endsWith("inspect"))?.body).toBe(
    JSON.stringify({ displayCode: "ABCD-2345" }),
  );
  expect(screen.getByText("1 Essen")).toBeInTheDocument();
  expect(screen.queryByText("1 Getränk", { exact: true })).not.toBeInTheDocument();
  expect(requests.some(({ url }) => url.endsWith("redeem"))).toBe(false);

  fireEvent.click(screen.getByRole("button", { name: "Jetzt einlösen" }));
  expect(await screen.findByRole("heading", { name: "Eingelöst" })).toBeInTheDocument();
  expect(requests.find(({ url }) => url.endsWith("redeem"))?.body).toBe(
    JSON.stringify({ displayCode: "ABCD-2345" }),
  );
});

test.each([
  ["already_redeemed", "Bereits eingelöst"],
  ["invalid", "Gutschein ungültig"],
] as const)("inspection maps %s truthfully", async (status, heading) => {
  const camera = cameraHarness();
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url.endsWith("event-summary")) {
      return jsonResponse({ summary: { redeemedCount: 4 } });
    }
    return jsonResponse(
      status === "already_redeemed"
        ? { status, voucher: redeemed.voucher }
        : { status },
    );
  });

  renderScanner(camera.camera, fetcher);
  await camera.detect(QR_PAYLOAD);

  expect(await screen.findByRole("heading", { name: heading })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Jetzt einlösen" })).not.toBeInTheDocument();
  if (status === "already_redeemed") {
    expect(screen.getByText("1 Essen · ABCD-2345 · Muster Sponsor")).toBeInTheDocument();
    expect(screen.queryByText("1 Getränk", { exact: true })).not.toBeInTheDocument();
  }
});

test("an offline event during redeem wins over a late success response", async () => {
  const camera = cameraHarness();
  let resolveRedeem: ((response: Response) => void) | undefined;
  const pendingRedeem = new Promise<Response>((resolve) => {
    resolveRedeem = resolve;
  });
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url.endsWith("event-summary")) {
      return jsonResponse({ summary: { redeemedCount: 4 } });
    }
    if (url.endsWith("inspect")) {
      return jsonResponse(available);
    }
    return pendingRedeem;
  });

  renderScanner(camera.camera, fetcher);
  await camera.detect(QR_PAYLOAD);
  fireEvent.click(await screen.findByRole("button", { name: "Jetzt einlösen" }));
  setOnline(false);
  window.dispatchEvent(new Event("offline"));
  resolveRedeem?.(jsonResponse(redeemed));

  expect(await screen.findByRole("heading", { name: "Verbindung unterbrochen" })).toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("Einlösung nicht bestätigt");
  expect(screen.getByText("1 Essen · Muster Sponsor")).toBeInTheDocument();
  expect(screen.getByText("ABCD-2345")).toBeInTheDocument();
  expect(screen.queryByText("1 Getränk", { exact: true })).not.toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Eingelöst" })).not.toBeInTheDocument();
  expect(screen.getByText("Offline")).toBeInTheDocument();
});

test("an ambiguous redeem failure offers a safe status recheck and never manufactures success", async () => {
  const camera = cameraHarness();
  let inspectCalls = 0;
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url.endsWith("event-summary")) {
      return jsonResponse({ summary: { redeemedCount: 4 } });
    }
    if (url.endsWith("inspect")) {
      inspectCalls += 1;
      return jsonResponse(
        inspectCalls === 1
          ? available
          : { status: "already_redeemed", voucher: redeemed.voucher },
      );
    }
    throw new TypeError("response lost");
  });

  renderScanner(camera.camera, fetcher);
  await camera.detect(QR_PAYLOAD);
  fireEvent.click(await screen.findByRole("button", { name: "Jetzt einlösen" }));

  expect(await screen.findByRole("heading", { name: "Verbindung unterbrochen" })).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Eingelöst" })).not.toBeInTheDocument();
  expect(screen.getByText("1 Essen · Muster Sponsor")).toBeInTheDocument();
  expect(screen.getByText("ABCD-2345")).toBeInTheDocument();
  expect(screen.queryByText("1 Getränk", { exact: true })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Status erneut prüfen" }));
  expect(await screen.findByRole("heading", { name: "Bereits eingelöst" })).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Eingelöst" })).not.toBeInTheDocument();
});

test("online/offline is live browser state, camera denial keeps manual entry prominent, and logout remains available", async () => {
  setOnline(false);
  const onLogout = vi.fn();
  const camera: QrCamera = {
    start: vi.fn(async () => Promise.reject(new CameraUnavailableError("denied"))),
  };
  render(
    <ScannerPage
      session={session}
      camera={camera}
      api={createScannerApi({
        fetcher: vi.fn(async () => jsonResponse({ summary: { redeemedCount: 0 } })),
      })}
      onLogout={onLogout}
      onSessionExpired={vi.fn()}
    />,
  );

  expect(screen.getByText("Offline")).toBeInTheDocument();
  expect(await screen.findByText("Kamerazugriff wurde nicht erlaubt.")).toBeInTheDocument();
  const unavailableHeading = screen.getByRole("heading", { name: "Kamera nicht verfügbar" });
  await waitFor(() => expect(unavailableHeading).toHaveFocus());
  const cameraAnnouncement = unavailableHeading.closest('[role="status"]');
  expect(cameraAnnouncement).toHaveAttribute("aria-live", "polite");
  expect(cameraAnnouncement).toHaveTextContent("Kamerazugriff wurde nicht erlaubt.");
  expect(document.body).not.toHaveFocus();
  expect(screen.getByRole("textbox", { name: "Gutscheincode" })).toBeEnabled();
  setOnline(true);
  window.dispatchEvent(new Event("online"));
  expect(await screen.findByText("Online")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Abmelden" }));
  expect(onLogout).toHaveBeenCalledTimes(1);
});

test("next voucher immediately resets the result and restarts the camera", async () => {
  const camera = cameraHarness();
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url.endsWith("event-summary")) {
      return jsonResponse({ summary: { redeemedCount: 1 } });
    }
    return jsonResponse(url.endsWith("inspect") ? available : redeemed);
  });

  renderScanner(camera.camera, fetcher);
  await camera.detect(QR_PAYLOAD);
  fireEvent.click(await screen.findByRole("button", { name: "Jetzt einlösen" }));
  fireEvent.click(await screen.findByRole("button", { name: "Nächster Gutschein" }));

  expect(await screen.findByRole("heading", { name: "Gutschein scannen" })).toBeInTheDocument();
  await waitFor(() => expect(camera.startCount()).toBe(2));
});

test("a fatal asynchronous camera callback leaves no dead scanning state", async () => {
  const camera = cameraHarness();
  const fetcher = vi.fn<typeof fetch>(async (input) =>
    String(input).endsWith("event-summary")
      ? jsonResponse({ summary: { redeemedCount: 0 } })
      : jsonResponse(available),
  );

  renderScanner(camera.camera, fetcher);
  expect(await screen.findByRole("heading", { name: "Gutschein scannen" })).toBeInTheDocument();
  await camera.fail();

  const unavailableHeading = await screen.findByRole("heading", {
    name: "Kamera nicht verfügbar",
  });
  await waitFor(() => expect(unavailableHeading).toHaveFocus());
  expect(screen.getByRole("textbox", { name: "Gutscheincode" })).toBeEnabled();
});

function renderScanner(camera: QrCamera, fetcher: typeof fetch) {
  return render(
    <ScannerPage
      session={session}
      camera={camera}
      api={createScannerApi({ fetcher })}
      onLogout={vi.fn()}
      onSessionExpired={vi.fn()}
    />,
  );
}

function cameraHarness(): {
  camera: QrCamera;
  detect: (value: string) => Promise<void>;
  fail: () => Promise<void>;
  startCount: () => number;
} {
  let onDetected: ((value: string) => void) | undefined;
  let onFailure: ((reason: "failed") => void) | undefined;
  let starts = 0;
  const camera = {
    start: vi.fn(async (
      _video: HTMLVideoElement,
      callback: (value: string) => void,
      failure?: (reason: "failed") => void,
    ) => {
      starts += 1;
      onDetected = callback;
      onFailure = failure;
      return { stop: vi.fn() };
    }),
  } as unknown as QrCamera;
  return {
    camera,
    detect: async (value) => {
      await waitFor(() => expect(onDetected).toBeTypeOf("function"));
      onDetected?.(value);
    },
    fail: async () => {
      await waitFor(() => expect(starts).toBeGreaterThan(0));
      onFailure?.("failed");
    },
    startCount: () => starts,
  };
}

function setOnline(value: boolean): void {
  vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(value);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
