import { expect, test } from "vitest";

import {
  initialScannerState,
  manualCodeLocator,
  parseScannedVoucherPayload,
  scannerReducer,
  type AvailableVoucher,
  type ScannerAction,
} from "../../src/features/team/scannerState";

const PUBLIC_ID = "a".repeat(22);
const locator = { kind: "publicId", publicId: PUBLIC_ID } as const;
const voucher: AvailableVoucher = {
  publicId: PUBLIC_ID,
  displayCode: "ABCD-2345",
  redeemedAt: null,
  event: { name: "RT22 Sommerfest", eventDate: "2026-08-20" },
  sponsor: { name: "Muster Sponsor" },
  voucherType: { name: "1 Bier" },
};

test("scan -> inspect -> valid remains read-only until an explicit confirmation", () => {
  const inspecting = scannerReducer(initialScannerState, {
    type: "inspectionStarted",
    locator,
  });
  expect(inspecting).toEqual({ status: "inspecting", locator });

  const valid = scannerReducer(inspecting, {
    type: "inspectionResolved",
    result: { status: "available", voucher },
  });
  expect(valid).toEqual({ status: "valid", locator, voucher });

  expect(
    scannerReducer(valid, {
      type: "redemptionResolved",
      result: {
        status: "redeemed",
        voucher: { ...voucher, redeemedAt: "2026-08-20T18:00:00.000Z" },
      },
    }),
  ).toEqual(valid);

  expect(scannerReducer(valid, { type: "redemptionConfirmed" })).toEqual({
    status: "redeeming",
    locator,
    voucher,
  });
});

test("only a validated redeemed result can enter success", () => {
  const valid = {
    status: "valid",
    locator,
    voucher,
  } as const;
  const redeeming = scannerReducer(valid, { type: "redemptionConfirmed" });
  const redeemedVoucher = {
    ...voucher,
    redeemedAt: "2026-08-20T18:00:00.000Z",
  };

  expect(
    scannerReducer(redeeming, {
      type: "redemptionResolved",
      result: { status: "redeemed", voucher: redeemedVoucher },
    }),
  ).toEqual({ status: "success", voucher: redeemedVoucher });

  const nonSuccessActions: ScannerAction[] = [
    { type: "requestFailed", operation: "redeem" as const },
    {
      type: "redemptionResolved" as const,
      result: { status: "already_redeemed" as const, voucher: redeemedVoucher },
    },
    { type: "redemptionResolved" as const, result: { status: "invalid" as const } },
  ];
  for (const action of nonSuccessActions) {
    expect(scannerReducer(redeeming, action).status).not.toBe("success");
  }
});

test("invalid, already-redeemed, network, camera-unavailable, and next states are explicit", () => {
  const inspecting = scannerReducer(initialScannerState, {
    type: "inspectionStarted",
    locator,
  });
  const redeemedVoucher = {
    ...voucher,
    redeemedAt: "2026-08-20T18:00:00.000Z",
  };

  expect(
    scannerReducer(inspecting, {
      type: "inspectionResolved",
      result: { status: "already_redeemed", voucher: redeemedVoucher },
    }).status,
  ).toBe("alreadyRedeemed");
  expect(
    scannerReducer(inspecting, {
      type: "inspectionResolved",
      result: { status: "invalid" },
    }).status,
  ).toBe("invalid");
  const network = scannerReducer(inspecting, {
    type: "requestFailed",
    operation: "inspect",
  });
  expect(network).toEqual({ status: "networkError", operation: "inspect", locator });
  expect(scannerReducer(network, { type: "nextVoucher" })).toEqual(initialScannerState);
  expect(
    scannerReducer(initialScannerState, {
      type: "cameraFailed",
      reason: "denied",
    }),
  ).toEqual({ status: "cameraUnavailable", reason: "denied" });
  expect(
    scannerReducer(initialScannerState, { type: "invalidDetected" }).status,
  ).toBe("invalid");
});

test("QR payload parsing accepts only an exact same-origin public voucher route", () => {
  const origin = "https://vouchers.rt22.de";
  expect(parseScannedVoucherPayload(`${origin}/v/${PUBLIC_ID}`, origin)).toEqual(locator);
  expect(parseScannedVoucherPayload(`/v/${PUBLIC_ID}`, origin)).toEqual(locator);

  for (const payload of [
    `https://evil.example/v/${PUBLIC_ID}`,
    `${origin}/v/${PUBLIC_ID}/extra`,
    `${origin}/v/${PUBLIC_ID}?redeem=1`,
    `${origin}/v/${PUBLIC_ID}#fragment`,
    `${origin}/s/${PUBLIC_ID}`,
    `${origin}/v/short`,
    "not a URL",
  ]) {
    expect(parseScannedVoucherPayload(payload, origin)).toBeNull();
  }
});

test("manual codes normalize to the same voucher-locator contract", () => {
  expect(manualCodeLocator("abcd 2345")).toEqual({
    kind: "displayCode",
    displayCode: "ABCD-2345",
  });
  expect(manualCodeLocator("ABCD-2345")).toEqual({
    kind: "displayCode",
    displayCode: "ABCD-2345",
  });
  expect(manualCodeLocator("ABCI-2345")).toBeNull();
  expect(manualCodeLocator("ABC-2345")).toBeNull();
});
