import { strFromU8, unzipSync } from "fflate";
import { describe, expect, test } from "vitest";

import {
  canonicalVoucherUrl,
  createManifestCsv,
  createQrPackage,
  createVoucherQrSvg,
  qrPackageFilename,
  type AdminQrExportVoucher,
} from "../../src/features/admin/qr-export";

const vouchers: AdminQrExportVoucher[] = [
  { publicId: "public-z", displayCode: "WXYZ-2345", status: "redeemed" },
  { publicId: "public-a", displayCode: "ABCD-EFGH", status: "available" },
];

describe("sponsor QR export artifacts", () => {
  test("maps every voucher to the canonical same-origin URL", () => {
    expect(canonicalVoucherUrl("public-a", "https://rt22.example")).toBe(
      "https://rt22.example/v/public-a",
    );
  });

  test("renders the existing manual code below the unchanged QR payload", () => {
    const payload = canonicalVoucherUrl("public-a", "https://rt22.example");
    const svg = createVoucherQrSvg(payload, "ABCD-EFGH");

    expect(svg).toMatch(/^<svg[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    expect(svg.match(/<svg\b/g)).toHaveLength(1);
    expect(svg.match(/<path\b/g)).toHaveLength(2);
    expect(svg).toContain('role="img"');
    expect(svg).toContain('data-qr-payload="https://rt22.example/v/public-a"');
    expect(svg).toContain('width="256"');
    expect(svg).toContain('height="304"');
    const viewBox = svg.match(/viewBox="([^"]+)"/)?.[1].split(/\s+/).map(Number);
    expect(viewBox).toHaveLength(4);
    if (!viewBox) {
      throw new Error("SVG viewBox is missing");
    }
    expect(viewBox.slice(0, 2)).toEqual([0, 0]);
    expect(viewBox[3]).toBeGreaterThan(viewBox[2]);
    expect(256 / 304).toBeCloseTo(viewBox[2] / viewBox[3], 10);
    expect(svg).toContain("<text");
    expect(svg).toContain('text-anchor="middle"');
    expect(svg).toContain("Code: ABCD-EFGH");
    expect(svg.indexOf("<text")).toBeGreaterThan(svg.lastIndexOf("<path"));
    const textElement = svg.match(/<text\b([^>]*)>([^<]*)<\/text>/);
    if (!textElement) {
      throw new Error("SVG label is missing");
    }
    const labelX = Number(textElement[1].match(/\bx="([^"]+)"/)?.[1]);
    const labelY = Number(textElement[1].match(/\by="([^"]+)"/)?.[1]);
    expect(labelX).toBeCloseTo(viewBox[2] / 2, 10);
    expect(labelY).toBeGreaterThan(viewBox[2]);
    expect(labelY).toBeLessThan(viewBox[3]);
    expect(svg).not.toContain("Code: WXYZ-2345");
    expect(svg).not.toContain("<image");
    expect(svg).not.toContain("@font-face");
    expect(svg).not.toContain("data:");
  });

  test("serializes a stable escaped manifest and neutralizes spreadsheet formulas", () => {
    expect(createManifestCsv("=Firma, \"XY\"\r\n", "1 Bier", vouchers)).toBe(
      "file_name,sponsor,voucher_type,manual_code,status\r\n" +
        '"ABCD-EFGH.svg","\'=Firma, ""XY""\r\n","1 Bier","ABCD-EFGH","available"\r\n' +
        '"WXYZ-2345.svg","\'=Firma, ""XY""\r\n","1 Bier","WXYZ-2345","redeemed"\r\n',
    );
  });

  test("creates only the expected QR entries and manifest in deterministic order", () => {
    const packageBytes = createQrPackage(
      { sponsorName: "Firma XY", voucherTypeName: "1 Bier", vouchers },
      "https://rt22.example",
    );
    const entries = unzipSync(packageBytes);

    expect(Object.keys(entries)).toEqual([
      "qr/ABCD-EFGH.svg",
      "qr/WXYZ-2345.svg",
      "manifest.csv",
    ]);
    expect(strFromU8(entries["manifest.csv"])).toContain(
      '"ABCD-EFGH.svg","Firma XY","1 Bier","ABCD-EFGH","available"',
    );
    expect(strFromU8(entries["qr/ABCD-EFGH.svg"])).toContain(
      "https://rt22.example/v/public-a",
    );
    expect(strFromU8(entries["qr/ABCD-EFGH.svg"])).toContain("Code: ABCD-EFGH");
    expect(strFromU8(entries["qr/ABCD-EFGH.svg"])).not.toContain("Code: WXYZ-2345");
    expect(strFromU8(entries["qr/WXYZ-2345.svg"])).toContain(
      "https://rt22.example/v/public-z",
    );
    expect(strFromU8(entries["qr/WXYZ-2345.svg"])).toContain("Code: WXYZ-2345");
  });

  test("handles an empty artifact set and sanitizes desktop filenames", () => {
    const entries = unzipSync(
      createQrPackage({ sponsorName: "Firma / ..: XY?", voucherTypeName: "1 Bier", vouchers: [] }, "https://rt22.example"),
    );

    expect(Object.keys(entries)).toEqual(["manifest.csv"]);
    expect(strFromU8(entries["manifest.csv"])).toBe(
      "file_name,sponsor,voucher_type,manual_code,status\r\n",
    );
    expect(qrPackageFilename("Firma / ..: XY?", "1 Bier")).toBe("Vouchers-Firma-XY-1-Bier-Gutscheine.zip");
  });

  test("rejects duplicate or traversal-shaped manual-code filenames", () => {
    expect(() =>
      createQrPackage(
        {
          sponsorName: "Firma XY",
          voucherTypeName: "1 Bier",
          vouchers: [vouchers[0], { ...vouchers[1], displayCode: "../../evil" }],
        },
        "https://rt22.example",
      ),
    ).toThrow("invalid manual code");
    expect(() =>
      createQrPackage(
        { sponsorName: "Firma XY", voucherTypeName: "1 Bier", vouchers: [vouchers[0], vouchers[0]] },
        "https://rt22.example",
      ),
    ).toThrow("duplicate manual codes");
  });
});
