import { QRCodeSVG } from "qrcode.react";
import { ArrowIcon, StatusIcon } from "./icons";
import type { VoucherSummary } from "./types";

interface VoucherPresentationProps {
  voucher: VoucherSummary;
  position?: number;
  total?: number;
  onPrevious?: () => void;
  onNext?: () => void;
  previousDisabled?: boolean;
  nextDisabled?: boolean;
  showQr?: boolean;
}

export function VoucherPresentation({
  voucher,
  position,
  total,
  onPrevious,
  onNext,
  previousDisabled,
  nextDisabled,
  showQr = true,
}: VoucherPresentationProps) {
  const qrPayload = `${window.location.origin}/v/${voucher.publicId}`;
  const isAvailable = voucher.status === "available";

  return (
    <section className="voucher-detail" aria-label="Gutschein">
      {showQr ? (
        <div
          className="voucher-qr"
          role="img"
          aria-label="Gutschein QR-Code"
          data-qr-payload={qrPayload}
        >
          <QRCodeSVG
            value={qrPayload}
            size={288}
            level="M"
            marginSize={4}
            title="Gutschein QR-Code"
          />
        </div>
      ) : null}

      <h2 className="voucher-type-name">{voucher.voucherType.name}</h2>
      <p className="voucher-code-label">Code</p>
      <p className="voucher-code">{voucher.displayCode}</p>
      <p
        className={`voucher-status voucher-status--${voucher.status}`}
        role="status"
        aria-live="polite"
      >
        <StatusIcon className="voucher-status-icon" />
        {isAvailable ? "Verfügbar" : "Bereits eingelöst"}
      </p>

      {position !== undefined && total !== undefined ? (
        <>
          <p className="voucher-position" aria-label={`Gutschein ${position} von ${total}`}>
            {position} von {total}
          </p>
          <nav className="voucher-navigation" aria-label="Gutscheinnavigation">
            <button type="button" onClick={onPrevious} disabled={previousDisabled}>
              <ArrowIcon className="voucher-arrow voucher-arrow--back" />
              Zurück
            </button>
            <button type="button" onClick={onNext} disabled={nextDisabled}>
              Weiter
              <ArrowIcon className="voucher-arrow" />
            </button>
          </nav>
        </>
      ) : null}
    </section>
  );
}
