export function ScannerHeader({
  online,
  onLogout,
}: {
  online: boolean;
  onLogout: () => void;
}) {
  return (
    <header className="scanner-header">
      <div className="scanner-logo" aria-label="Event Voucher">QR</div>
      <div className="scanner-header-actions">
        <span
          className={online ? "scanner-network scanner-network--online" : "scanner-network"}
          role="status"
          aria-live="polite"
        >
          <span aria-hidden="true" />
          {online ? "Online" : "Offline"}
        </span>
        <button type="button" onClick={onLogout}>
          Abmelden
        </button>
      </div>
    </header>
  );
}
