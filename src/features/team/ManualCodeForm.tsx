import { useState, type FormEvent } from "react";

import { formatManualCodeDraft, manualCodeLocator, type VoucherLocator } from "./scannerState";

export function ManualCodeForm({
  onSubmit,
  disabled = false,
}: {
  onSubmit: (locator: VoucherLocator) => void;
  disabled?: boolean;
}) {
  const [code, setCode] = useState("");
  const [error, setError] = useState(false);

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const locator = manualCodeLocator(code);
    if (!locator) {
      setError(true);
      return;
    }
    setError(false);
    onSubmit(locator);
  }

  return (
    <form className="scanner-manual" onSubmit={submit} noValidate>
      <div className="scanner-manual-heading">
        <KeyboardIcon />
        <div>
          <h2>Code manuell eingeben</h2>
          <p id="manual-code-help">Falls die Kamera nicht verfügbar ist.</p>
        </div>
      </div>
      <label htmlFor="voucher-manual-code">Gutscheincode</label>
      <div className="scanner-manual-controls">
        <input
          id="voucher-manual-code"
          name="displayCode"
          type="text"
          inputMode="text"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={9}
          pattern="[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}"
          placeholder="XXXX-XXXX"
          aria-describedby={error ? "manual-code-help manual-code-error" : "manual-code-help"}
          aria-invalid={error}
          value={code}
          disabled={disabled}
          onChange={(event) => {
            setCode(formatManualCodeDraft(event.target.value));
            setError(false);
          }}
        />
        <button type="submit" disabled={disabled}>
          Code prüfen
        </button>
      </div>
      {error ? (
        <p id="manual-code-error" className="scanner-inline-error" role="alert">
          Bitte einen achtstelligen Code im Format XXXX-XXXX eingeben.
        </p>
      ) : null}
    </form>
  );
}

function KeyboardIcon() {
  return (
    <svg className="scanner-keyboard-icon" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="2.5" y="5" width="19" height="14" rx="2" />
      <path d="M6 9h.01M9.5 9h.01M13 9h.01M16.5 9h.01M6 12.5h.01M9.5 12.5h.01M13 12.5h.01M16.5 12.5h.01M7 16h10" />
    </svg>
  );
}
