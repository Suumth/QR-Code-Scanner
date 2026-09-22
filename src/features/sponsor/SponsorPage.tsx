import { useCallback, useEffect, useState } from "react";
import { loadSponsorSnapshot } from "./api";
import { TicketIcon } from "./icons";
import type { SponsorSnapshot } from "./types";
import { VoucherHeader } from "./VoucherHeader";
import { VoucherPresentation } from "./VoucherPresentation";

interface SponsorPageProps {
  accessId: string;
}

type LoadState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; snapshot: SponsorSnapshot };

export function SponsorPage({ accessId }: SponsorPageProps) {
  const [attempt, setAttempt] = useState(0);
  const [loadState, setLoadState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoadState({ status: "loading" });
    void loadSponsorSnapshot(accessId, controller.signal)
      .then((snapshot) => {
        if (active) {
          setLoadState({ status: "ready", snapshot });
        }
      })
      .catch((error: unknown) => {
        if (active && !isAbortError(error)) {
          setLoadState({ status: "error" });
        }
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [accessId, attempt]);

  const retry = useCallback(() => {
    setAttempt((current) => current + 1);
  }, []);

  if (loadState.status === "loading") {
    return <PageStatus message="Gutscheine werden geladen …" />;
  }
  if (loadState.status === "error") {
    return (
      <PageStatus message="Die Gutscheine konnten nicht geladen werden." error onRetry={retry} />
    );
  }

  return <SponsorExperience snapshot={loadState.snapshot} />;
}

function SponsorExperience({ snapshot }: { snapshot: SponsorSnapshot }) {
  const [selection, setSelection] = useState<
    { typeIndex: number; voucherIndex: number } | null
  >(null);
  const hasVouchers = snapshot.voucherTypes.some(
    (voucherType) => voucherType.vouchers.length > 0,
  );
  const selectedType = selection === null ? null : snapshot.voucherTypes[selection.typeIndex];
  const selectedVouchers = selectedType?.vouchers ?? [];
  const selectedVoucher = selection === null ? null : selectedVouchers[selection.voucherIndex];

  return (
    <main
      className={
        selection === null ? "voucher-shell" : "voucher-shell voucher-shell--detail"
      }
    >
      <VoucherHeader event={snapshot.event} sponsor={snapshot.sponsor} />
      {selection === null ? (
        <SponsorOverview
          snapshot={snapshot}
          onOpenType={(typeIndex, voucherIndex) => setSelection({ typeIndex, voucherIndex })}
          hasVouchers={hasVouchers}
        />
      ) : selectedVoucher && selectedType ? (
        <VoucherPresentation
          voucher={selectedVoucher}
          position={selection.voucherIndex + 1}
          total={selectedVouchers.length}
          onPrevious={() =>
            setSelection((current) =>
              current
                ? { ...current, voucherIndex: Math.max(0, current.voucherIndex - 1) }
                : current,
            )
          }
          onNext={() =>
            setSelection((current) =>
              current
                ? {
                    ...current,
                    voucherIndex: Math.min(selectedVouchers.length - 1, current.voucherIndex + 1),
                  }
                : current,
            )
          }
          previousDisabled={selection.voucherIndex === 0}
          nextDisabled={selection.voucherIndex === selectedVouchers.length - 1}
        />
      ) : (
        <SponsorOverview
          snapshot={snapshot}
          onOpenType={(typeIndex, voucherIndex) => setSelection({ typeIndex, voucherIndex })}
          hasVouchers={hasVouchers}
        />
      )}
    </main>
  );
}

interface SponsorOverviewProps {
  snapshot: SponsorSnapshot;
  onOpenType: (typeIndex: number, voucherIndex: number) => void;
  hasVouchers: boolean;
}

function SponsorOverview({
  snapshot,
  onOpenType,
  hasVouchers,
}: SponsorOverviewProps) {
  return (
    <section className="voucher-overview" aria-label="Gutscheinübersicht">
      <div
        className="voucher-total"
        aria-label={countLabel(snapshot.totals.total, "insgesamt")}
      >
        <strong>{snapshot.totals.total}</strong>
        <span>Gutscheine</span>
      </div>
      <div className="voucher-counts">
        <div aria-label={countLabel(snapshot.totals.available, "verfügbar")}>
          <strong>{snapshot.totals.available}</strong>
          <span>verfügbar</span>
        </div>
        <div aria-label={countLabel(snapshot.totals.redeemed, "eingelöst")}>
          <strong>{snapshot.totals.redeemed}</strong>
          <span>eingelöst</span>
        </div>
      </div>
      {snapshot.voucherTypes.length > 0 ? (
        <div className="voucher-type-groups" aria-label="Gutscheinarten">
          {snapshot.voucherTypes.map((voucherType, index) => (
            <section
              className="voucher-type-group"
              key={`${voucherType.name}-${index}`}
              aria-labelledby={`voucher-type-${index}`}
            >
              <h3 id={`voucher-type-${index}`}>{voucherType.name}</h3>
              <p>
                {voucherType.totals.total} insgesamt · {voucherType.totals.available} verfügbar · {" "}
                {voucherType.totals.redeemed} eingelöst
              </p>
              <button
                className="voucher-primary-action voucher-type-action"
                type="button"
                aria-label={`${voucherType.totals.available > 0 ? "Nächsten verfügbaren Gutschein anzeigen" : "Gutscheine anzeigen"} (${voucherType.name})`}
                onClick={() =>
                  onOpenType(
                    index,
                    Math.max(
                      0,
                      voucherType.vouchers.findIndex((voucher) => voucher.status === "available"),
                    ),
                  )
                }
              >
                <TicketIcon className="voucher-ticket-icon" />
                <span>
                  {voucherType.totals.available > 0
                    ? "Nächsten verfügbaren Gutschein anzeigen"
                    : "Gutscheine anzeigen"}
                </span>
              </button>
            </section>
          ))}
        </div>
      ) : null}
      {hasVouchers ? null : (
        <button className="voucher-primary-action" type="button" disabled>
          <TicketIcon className="voucher-ticket-icon" />
          <span>Keine Gutscheine vorhanden</span>
        </button>
      )}
    </section>
  );
}

interface PageStatusProps {
  message: string;
  error?: boolean;
  onRetry?: () => void;
}

function PageStatus({ message, error = false, onRetry }: PageStatusProps) {
  return (
    <main className="voucher-shell voucher-shell--status">
      <div className="voucher-logo voucher-logo--text" aria-label="Event Voucher">QR</div>
      <p role={error ? "alert" : "status"}>{message}</p>
      {onRetry ? (
        <button className="voucher-retry" type="button" onClick={onRetry}>
          Erneut versuchen
        </button>
      ) : null}
    </main>
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function countLabel(count: number, status: string): string {
  return `${count} ${count === 1 ? "Gutschein" : "Gutscheine"} ${status}`;
}
