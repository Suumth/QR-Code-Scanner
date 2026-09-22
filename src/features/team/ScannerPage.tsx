import { useCallback, useEffect, useRef, useState } from "react";

import { CameraUnavailableError, qrCamera, type CameraController, type QrCamera } from "./camera";
import { ManualCodeForm } from "./ManualCodeForm";
import { ScannerHeader } from "./ScannerHeader";
import { ScannerResult } from "./ScannerResult";
import { scannerApi, ScannerApiError, type ScannerApi } from "./scannerApi";
import {
  initialScannerState,
  parseScannedVoucherPayload,
  scannerReducer,
  type ScannerAction,
  type ScannerState,
  type VoucherLocator,
} from "./scannerState";
import type { TeamSessionSnapshot } from "./types";

interface ScannerPageProps {
  session: TeamSessionSnapshot;
  onLogout: () => void;
  onSessionExpired: () => void;
  logoutFailed?: boolean;
  camera?: QrCamera;
  api?: ScannerApi;
}

export function ScannerPage({
  session,
  onLogout,
  onSessionExpired,
  logoutFailed = false,
  camera = qrCamera,
  api = scannerApi,
}: ScannerPageProps) {
  const [state, setState] = useState<ScannerState>(initialScannerState);
  const stateRef = useRef<ScannerState>(initialScannerState);
  const [online, setOnline] = useState(readOnlineState);
  const onlineRef = useRef(online);
  const [redeemedCount, setRedeemedCount] = useState<number | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const unavailableHeadingRef = useRef<HTMLHeadingElement>(null);
  const actionController = useRef<AbortController | null>(null);
  const actionEpoch = useRef(0);
  const summaryController = useRef<AbortController | null>(null);
  const summaryEpoch = useRef(0);

  const commit = useCallback((action: ScannerAction) => {
    const next = scannerReducer(stateRef.current, action);
    stateRef.current = next;
    setState(next);
  }, []);

  const cancelAction = useCallback(() => {
    actionEpoch.current += 1;
    actionController.current?.abort();
    actionController.current = null;
  }, []);

  const expireSession = useCallback(() => {
    cancelAction();
    summaryEpoch.current += 1;
    summaryController.current?.abort();
    onSessionExpired();
  }, [cancelAction, onSessionExpired]);

  const refreshSummary = useCallback(
    async (notifyUnauthorized: boolean) => {
      summaryEpoch.current += 1;
      const epoch = summaryEpoch.current;
      summaryController.current?.abort();
      const controller = new AbortController();
      summaryController.current = controller;
      try {
        const summary = await api.eventSummary(controller.signal);
        if (summaryEpoch.current === epoch) {
          setRedeemedCount(summary.redeemedCount);
        }
      } catch (error) {
        if (
          summaryEpoch.current === epoch &&
          notifyUnauthorized &&
          error instanceof ScannerApiError &&
          error.failure === "unauthorized"
        ) {
          expireSession();
        }
      }
    },
    [api, expireSession],
  );

  useEffect(() => {
    void refreshSummary(true);
    return () => {
      summaryEpoch.current += 1;
      summaryController.current?.abort();
    };
  }, [refreshSummary]);

  useEffect(() => {
    if (state.status === "cameraUnavailable") {
      unavailableHeadingRef.current?.focus({ preventScroll: true });
    }
  }, [state.status]);

  const inspectLocator = useCallback(
    async (locator: VoucherLocator) => {
      const current = stateRef.current;
      if (
        current.status !== "scanning" &&
        current.status !== "cameraUnavailable" &&
        current.status !== "networkError"
      ) {
        return;
      }

      cancelAction();
      const epoch = actionEpoch.current;
      commit({ type: "inspectionStarted", locator });
      if (!onlineRef.current) {
        commit({ type: "requestFailed", operation: "inspect" });
        return;
      }

      const controller = new AbortController();
      actionController.current = controller;
      try {
        const result = await api.inspect(locator, controller.signal);
        if (actionEpoch.current !== epoch) {
          return;
        }
        if (!onlineRef.current) {
          commit({ type: "requestFailed", operation: "inspect" });
          return;
        }
        commit({ type: "inspectionResolved", result });
      } catch (error) {
        if (actionEpoch.current !== epoch) {
          return;
        }
        if (error instanceof ScannerApiError && error.failure === "unauthorized") {
          expireSession();
          return;
        }
        commit({ type: "requestFailed", operation: "inspect" });
      } finally {
        if (actionEpoch.current === epoch) {
          actionController.current = null;
        }
      }
    },
    [api, cancelAction, commit, expireSession],
  );

  const confirmRedemption = useCallback(async () => {
    const current = stateRef.current;
    if (current.status !== "valid") {
      return;
    }

    cancelAction();
    const epoch = actionEpoch.current;
    commit({ type: "redemptionConfirmed" });
    if (!onlineRef.current) {
      commit({ type: "requestFailed", operation: "redeem" });
      return;
    }

    const controller = new AbortController();
    actionController.current = controller;
    try {
      const result = await api.redeem(current.locator, controller.signal);
      if (actionEpoch.current !== epoch) {
        return;
      }
      if (!onlineRef.current) {
        commit({ type: "requestFailed", operation: "redeem" });
        return;
      }
      commit({ type: "redemptionResolved", result });
      if (result.status === "redeemed") {
        void refreshSummary(false);
      }
    } catch (error) {
      if (actionEpoch.current !== epoch) {
        return;
      }
      if (error instanceof ScannerApiError && error.failure === "unauthorized") {
        expireSession();
        return;
      }
      commit({ type: "requestFailed", operation: "redeem" });
    } finally {
      if (actionEpoch.current === epoch) {
        actionController.current = null;
      }
    }
  }, [api, cancelAction, commit, expireSession, refreshSummary]);

  useEffect(() => {
    function handleOnline(): void {
      onlineRef.current = true;
      setOnline(true);
    }

    function handleOffline(): void {
      onlineRef.current = false;
      setOnline(false);
      const current = stateRef.current;
      if (current.status === "inspecting" || current.status === "redeeming") {
        const operation = current.status === "redeeming" ? "redeem" : "inspect";
        cancelAction();
        commit({ type: "requestFailed", operation });
      }
    }

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, [cancelAction, commit]);

  useEffect(() => {
    if (state.status !== "scanning" || !videoRef.current) {
      return;
    }
    let active = true;
    let controller: CameraController | null = null;
    const video = videoRef.current;

    void camera
      .start(
        video,
        (payload) => {
          if (!active || stateRef.current.status !== "scanning") {
            return;
          }
          const locator = parseScannedVoucherPayload(payload, window.location.origin);
          if (!locator) {
            commit({ type: "invalidDetected" });
            return;
          }
          void inspectLocator(locator);
        },
        (reason) => {
          if (active && stateRef.current.status === "scanning") {
            commit({ type: "cameraFailed", reason });
          }
        },
      )
      .then((startedController) => {
        if (active && stateRef.current.status === "scanning") {
          controller = startedController;
        } else {
          startedController.stop();
        }
      })
      .catch((error: unknown) => {
        if (active && stateRef.current.status === "scanning") {
          commit({
            type: "cameraFailed",
            reason: error instanceof CameraUnavailableError ? error.reason : "failed",
          });
        }
      });

    return () => {
      active = false;
      controller?.stop();
    };
  }, [camera, commit, inspectLocator, state.status]);

  useEffect(
    () => () => {
      cancelAction();
    },
    [cancelAction],
  );

  function nextVoucher(): void {
    cancelAction();
    commit({ type: "nextVoucher" });
  }

  function retryRequest(): void {
    const current = stateRef.current;
    if (current.status === "networkError") {
      void inspectLocator(current.locator);
    }
  }

  return (
    <main className={`team-shell scanner-shell scanner-shell--${state.status}`}>
      <ScannerHeader online={online} onLogout={onLogout} />
      <div
        className="scanner-result-live-announcement"
        role="status"
        aria-label="Scanner-Ergebnis"
        aria-live="polite"
        aria-atomic="true"
      >
        {validResultAnnouncement(state)}
      </div>
      <div className="scanner-content">
        <div className="scanner-context">
          <strong>{session.event.name}</strong>
          <span>Angemeldet als {session.displayName}</span>
        </div>

        {state.status === "scanning" || state.status === "cameraUnavailable" ? (
          <section className="scanner-live" aria-labelledby="scanner-live-title">
            <div
              className="scanner-live-heading"
              role={state.status === "cameraUnavailable" ? "status" : undefined}
              aria-live={state.status === "cameraUnavailable" ? "polite" : undefined}
              aria-atomic={state.status === "cameraUnavailable" ? "true" : undefined}
            >
              <h1
                id="scanner-live-title"
                ref={state.status === "cameraUnavailable" ? unavailableHeadingRef : undefined}
                tabIndex={state.status === "cameraUnavailable" ? -1 : undefined}
              >
                {state.status === "scanning" ? "Gutschein scannen" : "Kamera nicht verfügbar"}
              </h1>
              <p>
                {state.status === "scanning"
                  ? "QR-Code in den Rahmen halten."
                  : cameraMessage(state.reason)}
              </p>
            </div>

            {state.status === "scanning" ? (
              <div className="scanner-camera-frame">
                <video ref={videoRef} aria-label="Kamera-Vorschau" />
                <span className="scanner-corner scanner-corner--top-left" aria-hidden="true" />
                <span className="scanner-corner scanner-corner--top-right" aria-hidden="true" />
                <span className="scanner-corner scanner-corner--bottom-left" aria-hidden="true" />
                <span className="scanner-corner scanner-corner--bottom-right" aria-hidden="true" />
              </div>
            ) : (
              <div className="scanner-camera-unavailable">
                <CameraOffIcon />
                <button className="scanner-camera-retry" type="button" onClick={nextVoucher}>
                  Kamera erneut versuchen
                </button>
              </div>
            )}

            <ManualCodeForm onSubmit={(locator) => void inspectLocator(locator)} />
          </section>
        ) : (
          <ScannerResult
            state={state}
            onRedeem={() => void confirmRedemption()}
            onNext={nextVoucher}
            onRetry={retryRequest}
          />
        )}

        {logoutFailed ? (
          <p className="scanner-logout-error" role="alert">
            Abmelden nicht möglich. Bitte Verbindung prüfen.
          </p>
        ) : null}
      </div>
      <footer className="scanner-summary" aria-live="polite">
        Heute eingelöst: {redeemedCount ?? "—"}
      </footer>
    </main>
  );
}

function validResultAnnouncement(state: ScannerState): string {
  if (state.status !== "valid") {
    return "";
  }
  return `Gutschein gültig. ${state.voucher.voucherType.name}. ${state.voucher.sponsor.name}. Code ${state.voucher.displayCode}.`;
}

function readOnlineState(): boolean {
  return typeof navigator === "undefined" ? false : navigator.onLine;
}

function cameraMessage(reason: "denied" | "unsupported" | "failed"): string {
  switch (reason) {
    case "denied":
      return "Kamerazugriff wurde nicht erlaubt.";
    case "unsupported":
      return "Dieser Browser unterstützt keinen Kamerazugriff.";
    case "failed":
      return "Die Kamera konnte nicht gestartet werden.";
  }
}

function CameraOffIcon() {
  return (
    <svg className="scanner-camera-off-icon" viewBox="0 0 64 64" aria-hidden="true">
      <rect x="10" y="18" width="36" height="28" rx="5" />
      <path d="m46 27 9-6v22l-9-6M12 10l40 44" />
    </svg>
  );
}
