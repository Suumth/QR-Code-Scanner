import { useEffect, useState } from "react";
import { loadPublicVoucherSnapshot } from "./api";
import type { PublicVoucherSnapshot } from "./types";
import { VoucherHeader } from "./VoucherHeader";
import { VoucherPresentation } from "./VoucherPresentation";

interface PublicVoucherPageProps {
  publicId: string;
}

type LoadState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; snapshot: PublicVoucherSnapshot };

export function PublicVoucherPage({ publicId }: PublicVoucherPageProps) {
  const [loadState, setLoadState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    void loadPublicVoucherSnapshot(publicId, controller.signal)
      .then((snapshot) => {
        if (active) {
          setLoadState({ status: "ready", snapshot });
        }
      })
      .catch((error: unknown) => {
        if (active && !(error instanceof DOMException && error.name === "AbortError")) {
          setLoadState({ status: "error" });
        }
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [publicId]);

  if (loadState.status !== "ready") {
    return (
      <main className="voucher-shell voucher-shell--status">
        <div className="voucher-logo voucher-logo--text" aria-label="Event Voucher">QR</div>
        <p role={loadState.status === "error" ? "alert" : "status"}>
          {loadState.status === "error"
            ? "Der Gutschein konnte nicht geladen werden."
            : "Gutschein wird geladen …"}
        </p>
      </main>
    );
  }

  return (
    <main className="voucher-shell voucher-shell--detail">
      <VoucherHeader event={loadState.snapshot.event} sponsor={loadState.snapshot.sponsor} />
      <VoucherPresentation voucher={loadState.snapshot.voucher} showQr={false} />
      <p className="voucher-readonly-note">Nur das Event-Team kann Gutscheine einlösen.</p>
    </main>
  );
}
