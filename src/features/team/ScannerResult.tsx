import { useEffect, useRef } from "react";

import type { ScannerState } from "./scannerState";

type ResultState = Exclude<
  ScannerState,
  { status: "scanning" } | { status: "cameraUnavailable" }
>;

export function ScannerResult({
  state,
  onRedeem,
  onNext,
  onRetry,
}: {
  state: ResultState;
  onRedeem: () => void;
  onNext: () => void;
  onRetry: () => void;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const shouldFocus = state.status === "valid";

  useEffect(() => {
    if (shouldFocus) {
      headingRef.current?.focus({ preventScroll: true });
    }
  }, [shouldFocus]);

  if (state.status === "inspecting") {
    return <PendingState title="Gutschein wird geprüft …" />;
  }

  if (state.status === "redeeming") {
    return <PendingState title="Einlösung wird bestätigt …" />;
  }

  if (state.status === "valid") {
    return (
      <section className="scanner-result scanner-result--valid" aria-labelledby="scanner-result-title">
        <StatusIcon kind="success" />
        <h1 id="scanner-result-title" ref={headingRef} tabIndex={-1}>
          Gutschein gültig
        </h1>
        <div className="scanner-voucher-facts">
          <p className="scanner-sponsor">{state.voucher.sponsor.name}</p>
          <p className="scanner-voucher-type">{state.voucher.voucherType.name}</p>
          <p className="scanner-result-code">{state.voucher.displayCode}</p>
          <p className="scanner-event-name">{state.voucher.event.name}</p>
        </div>
        <button className="scanner-action scanner-action--redeem" type="button" onClick={onRedeem}>
          Jetzt einlösen
        </button>
        <button className="scanner-action scanner-action--secondary" type="button" onClick={onNext}>
          Abbrechen
        </button>
      </section>
    );
  }

  if (state.status === "success") {
    return (
      <section className="scanner-result scanner-result--success" aria-labelledby="scanner-result-title" role="status" aria-live="assertive">
        <h1 id="scanner-result-title">Eingelöst</h1>
        <StatusIcon kind="success" large />
        <p className="scanner-result-summary">
          {state.voucher.voucherType.name} · {state.voucher.sponsor.name}
        </p>
        <button className="scanner-action scanner-action--next" type="button" onClick={onNext}>
          Nächster Gutschein
        </button>
      </section>
    );
  }

  if (state.status === "alreadyRedeemed") {
    return (
      <section className="scanner-result scanner-result--error" aria-labelledby="scanner-result-title" role="alert">
        <StatusIcon kind="error" />
        <h1 id="scanner-result-title">Bereits eingelöst</h1>
        <p className="scanner-result-summary">
          {state.voucher.voucherType.name} · {state.voucher.displayCode} · {state.voucher.sponsor.name}
        </p>
        <p>Dieser Gutschein wurde schon eingelöst.</p>
        <button className="scanner-action scanner-action--secondary" type="button" onClick={onNext}>
          Nächster Gutschein
        </button>
      </section>
    );
  }

  if (state.status === "invalid") {
    return (
      <section className="scanner-result scanner-result--error" aria-labelledby="scanner-result-title" role="alert">
        <StatusIcon kind="error" />
        <h1 id="scanner-result-title">Gutschein ungültig</h1>
        <p>Der QR-Code oder Gutscheincode gehört nicht zu diesem Event.</p>
        <button className="scanner-action scanner-action--secondary" type="button" onClick={onNext}>
          Nächster Gutschein
        </button>
      </section>
    );
  }

  return (
    <section className="scanner-result scanner-result--network" aria-labelledby="scanner-result-title">
      <StatusIcon kind="network" />
      <h1 id="scanner-result-title">Verbindung unterbrochen</h1>
      <p role="alert">
        {state.operation === "redeem"
          ? "Einlösung nicht bestätigt. Es wird kein Erfolg angezeigt. Bitte den Status sicher erneut prüfen."
          : "Prüfung nicht bestätigt. Es wird kein Erfolg angezeigt. Bitte Verbindung prüfen."}
      </p>
      {state.operation === "redeem" && state.voucher ? (
        <div className="scanner-network-voucher-context">
          <p className="scanner-network-voucher-summary">
            {state.voucher.voucherType.name} · {state.voucher.sponsor.name}
          </p>
          <p className="scanner-network-voucher-code">{state.voucher.displayCode}</p>
        </div>
      ) : null}
      <button className="scanner-action scanner-action--retry" type="button" onClick={onRetry}>
        {state.operation === "redeem" ? "Status erneut prüfen" : "Erneut prüfen"}
      </button>
      <button className="scanner-action scanner-action--secondary" type="button" onClick={onNext}>
        Nächster Gutschein
      </button>
    </section>
  );
}

function PendingState({ title }: { title: string }) {
  return (
    <section className="scanner-result scanner-result--pending" aria-labelledby="scanner-result-title" aria-live="polite">
      <span className="scanner-spinner" aria-hidden="true" />
      <h1 id="scanner-result-title">{title}</h1>
      <p>Bitte kurz warten.</p>
    </section>
  );
}

function StatusIcon({
  kind,
  large = false,
}: {
  kind: "success" | "error" | "network";
  large?: boolean;
}) {
  return (
    <svg
      className={`scanner-status-icon scanner-status-icon--${kind}${large ? " scanner-status-icon--large" : ""}`}
      viewBox="0 0 96 96"
      aria-hidden="true"
    >
      <circle cx="48" cy="48" r="40" />
      {kind === "success" ? (
        <path d="m29 49 13 13 27-30" />
      ) : kind === "error" ? (
        <path d="m34 34 28 28m0-28L34 62" />
      ) : (
        <path d="M31 58a24 24 0 0 1 34-32M65 38a24 24 0 0 1-34 32M66 24v14H52M30 72V58h14" />
      )}
    </svg>
  );
}
