import { zipSync, strToU8 } from "fflate";
import { QRCodeSVG } from "qrcode.react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";

import type { AdminQrExportData, AdminQrExportVoucher } from "./types";

export type { AdminQrExportData, AdminQrExportVoucher };

const QR_SIZE = 256;
const QR_ERROR_CORRECTION = "M" as const;
const QR_QUIET_ZONE_MODULES = 4;
const QR_LABEL_GAP = 16;
const QR_LABEL_HEIGHT = 32;
const QR_LABEL_FONT_SIZE = 18;
const SVG_HEIGHT = QR_SIZE + QR_LABEL_GAP + QR_LABEL_HEIGHT;

export function canonicalVoucherUrl(publicId: string, applicationOrigin: string): string {
  return new URL(`/v/${encodeURIComponent(publicId)}`, new URL(applicationOrigin).origin).toString();
}

export function createVoucherQrSvg(payload: string, manualCode: string): string {
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    flushSync(() => {
      root.render(
        <QRCodeSVG
          value={payload}
          size={QR_SIZE}
          level={QR_ERROR_CORRECTION}
          boostLevel={false}
          marginSize={QR_QUIET_ZONE_MODULES}
          xmlns="http://www.w3.org/2000/svg"
          role="img"
          aria-label="Gutschein QR-Code"
          data-qr-payload={payload}
          title={payload}
        />,
      );
    });
    const svg = container.querySelector("svg")?.outerHTML;
    if (!svg) {
      throw new Error("QR SVG rendering failed");
    }
    const svgElement = container.querySelector("svg");
    const viewBox = svgElement?.getAttribute("viewBox")?.split(/\s+/).map(Number);
    if (!svgElement || !viewBox || viewBox.length !== 4 || viewBox.some((value) => !Number.isFinite(value))) {
      throw new Error("QR SVG viewBox is invalid");
    }

    const [viewBoxX, viewBoxY, viewBoxWidth, viewBoxHeight] = viewBox;
    const pixelsPerViewBoxUnit = QR_SIZE / viewBoxWidth;
    const labelSpace = (QR_LABEL_GAP + QR_LABEL_HEIGHT) / pixelsPerViewBoxUnit;
    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.setAttribute("x", String(viewBoxX + viewBoxWidth / 2));
    label.setAttribute(
      "y",
      String(viewBoxY + viewBoxHeight + (QR_LABEL_GAP + QR_LABEL_FONT_SIZE) / pixelsPerViewBoxUnit),
    );
    label.setAttribute("text-anchor", "middle");
    label.setAttribute("font-family", "Arial, Helvetica, sans-serif");
    label.setAttribute("font-size", String(QR_LABEL_FONT_SIZE / pixelsPerViewBoxUnit));
    label.setAttribute("font-weight", "700");
    label.setAttribute("fill", "#000000");
    label.textContent = `Code: ${manualCode}`;

    svgElement.setAttribute("height", String(SVG_HEIGHT));
    svgElement.setAttribute(
      "viewBox",
      `${viewBoxX} ${viewBoxY} ${viewBoxWidth} ${viewBoxHeight + labelSpace}`,
    );
    svgElement.append(label);
    return `${svgElement.outerHTML}\n`;
  } finally {
    root.unmount();
  }
}

export function createManifestCsv(
  sponsorName: string,
  voucherTypeName: string,
  vouchers: AdminQrExportVoucher[],
): string {
  const lines = ["file_name,sponsor,voucher_type,manual_code,status"];
  for (const voucher of sortVouchers(vouchers)) {
    lines.push(
      [
        `${voucher.displayCode}.svg`,
        sponsorName,
        voucherTypeName,
        voucher.displayCode,
        voucher.status,
      ]
        .map(csvField)
        .join(","),
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}

export function createQrPackage(data: AdminQrExportData, applicationOrigin: string): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  const seenFiles = new Set<string>();

  for (const voucher of sortVouchers(data.vouchers)) {
    if (!isManualCode(voucher.displayCode)) {
      throw new RangeError("QR export contains an invalid manual code");
    }
    const fileName = `${voucher.displayCode}.svg`;
    if (seenFiles.has(fileName)) {
      throw new RangeError("QR export contains duplicate manual codes");
    }
    seenFiles.add(fileName);
    const payload = canonicalVoucherUrl(voucher.publicId, applicationOrigin);
    entries[`qr/${fileName}`] = strToU8(createVoucherQrSvg(payload, voucher.displayCode));
  }

  entries["manifest.csv"] = strToU8(
    createManifestCsv(data.sponsorName, data.voucherTypeName, data.vouchers),
  );
  return zipSync(entries);
}

export function qrPackageFilename(sponsorName: string, voucherTypeName: string): string {
  const readableName = sanitizeFilenamePart(sponsorName);
  const readableType = sanitizeFilenamePart(voucherTypeName);
  return `Vouchers-${readableName || "Sponsor"}-${readableType || "Gutscheine"}-Gutscheine.zip`;
}

function sanitizeFilenamePart(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-")
    .slice(0, 80);
}

function sortVouchers(vouchers: AdminQrExportVoucher[]): AdminQrExportVoucher[] {
  return [...vouchers].sort((left, right) =>
    left.displayCode < right.displayCode ? -1 : left.displayCode > right.displayCode ? 1 : 0,
  );
}

function csvField(value: string): string {
  const neutralized = hasFormulaPrefix(value) ? `'${value}` : value;
  return `"${neutralized.replaceAll('"', '""')}"`;
}

function hasFormulaPrefix(value: string): boolean {
  const firstCharacter = value[0];
  const firstCodePoint = firstCharacter?.codePointAt(0);
  const firstTrimmedCharacter = value.trimStart()[0];
  return (
    firstCodePoint !== undefined &&
    (firstCodePoint <= 0x1f ||
      firstCodePoint === 0x7f ||
      "=+-@".includes(firstTrimmedCharacter ?? ""))
  );
}

function isManualCode(value: string): boolean {
  return /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/.test(value);
}
