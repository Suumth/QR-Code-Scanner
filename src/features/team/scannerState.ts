export type VoucherLocator =
  | { kind: "publicId"; publicId: string }
  | { kind: "displayCode"; displayCode: string };

export interface VoucherDetails {
  publicId: string;
  displayCode: string;
  redeemedAt: string | null;
  event: {
    name: string;
    eventDate: string;
  };
  sponsor: {
    name: string;
  };
  voucherType: {
    name: string;
  };
}

export type AvailableVoucher = VoucherDetails & { redeemedAt: null };
export type RedeemedVoucher = VoucherDetails & { redeemedAt: string };

export type InspectResult =
  | { status: "available"; voucher: AvailableVoucher }
  | { status: "already_redeemed"; voucher: RedeemedVoucher }
  | { status: "invalid" };

export type RedeemResult =
  | { status: "redeemed"; voucher: RedeemedVoucher }
  | { status: "already_redeemed"; voucher: RedeemedVoucher }
  | { status: "invalid" };

export type CameraFailureReason = "denied" | "unsupported" | "failed";

export type ScannerState =
  | { status: "scanning" }
  | { status: "inspecting"; locator: VoucherLocator }
  | { status: "valid"; locator: VoucherLocator; voucher: AvailableVoucher }
  | { status: "redeeming"; locator: VoucherLocator; voucher: AvailableVoucher }
  | { status: "success"; voucher: RedeemedVoucher }
  | { status: "alreadyRedeemed"; voucher: RedeemedVoucher }
  | { status: "invalid" }
  | {
      status: "networkError";
      operation: "inspect" | "redeem";
      locator: VoucherLocator;
      voucher?: AvailableVoucher;
    }
  | { status: "cameraUnavailable"; reason: CameraFailureReason };

export type ScannerAction =
  | { type: "inspectionStarted"; locator: VoucherLocator }
  | { type: "inspectionResolved"; result: InspectResult }
  | { type: "redemptionConfirmed" }
  | { type: "redemptionResolved"; result: RedeemResult }
  | { type: "requestFailed"; operation: "inspect" | "redeem" }
  | { type: "cameraFailed"; reason: CameraFailureReason }
  | { type: "invalidDetected" }
  | { type: "nextVoucher" };

export const initialScannerState: ScannerState = { status: "scanning" };

const PUBLIC_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const DISPLAY_CODE_PATTERN = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/;

export function scannerReducer(state: ScannerState, action: ScannerAction): ScannerState {
  switch (action.type) {
    case "inspectionStarted":
      return state.status === "scanning" ||
        state.status === "cameraUnavailable" ||
        state.status === "networkError"
        ? { status: "inspecting", locator: action.locator }
        : state;
    case "inspectionResolved":
      if (state.status !== "inspecting") {
        return state;
      }
      switch (action.result.status) {
        case "available":
          return { status: "valid", locator: state.locator, voucher: action.result.voucher };
        case "already_redeemed":
          return { status: "alreadyRedeemed", voucher: action.result.voucher };
        case "invalid":
          return { status: "invalid" };
      }
      return state;
    case "redemptionConfirmed":
      return state.status === "valid"
        ? {
            status: "redeeming",
            locator: state.locator,
            voucher: state.voucher,
          }
        : state;
    case "redemptionResolved":
      if (state.status !== "redeeming") {
        return state;
      }
      switch (action.result.status) {
        case "redeemed":
          return { status: "success", voucher: action.result.voucher };
        case "already_redeemed":
          return { status: "alreadyRedeemed", voucher: action.result.voucher };
        case "invalid":
          return { status: "invalid" };
      }
      return state;
    case "requestFailed":
      if (action.operation === "inspect" && state.status === "inspecting") {
        return {
          status: "networkError",
          operation: "inspect",
          locator: state.locator,
        };
      }
      if (action.operation === "redeem" && state.status === "redeeming") {
        return {
          status: "networkError",
          operation: "redeem",
          locator: state.locator,
          voucher: state.voucher,
        };
      }
      return state;
    case "cameraFailed":
      return state.status === "scanning"
        ? { status: "cameraUnavailable", reason: action.reason }
        : state;
    case "invalidDetected":
      return state.status === "scanning" ? { status: "invalid" } : state;
    case "nextVoucher":
      return initialScannerState;
  }
}

export function parseScannedVoucherPayload(
  payload: string,
  applicationOrigin: string,
): VoucherLocator | null {
  try {
    const expectedOrigin = new URL(applicationOrigin).origin;
    const url = new URL(payload, expectedOrigin);
    if (url.origin !== expectedOrigin || url.search !== "" || url.hash !== "") {
      return null;
    }
    const match = /^\/v\/([^/]+)\/?$/.exec(url.pathname);
    const publicId = match?.[1];
    return publicId && PUBLIC_ID_PATTERN.test(publicId)
      ? { kind: "publicId", publicId }
      : null;
  } catch {
    return null;
  }
}

export function manualCodeLocator(input: string): VoucherLocator | null {
  if (input.length > 24) {
    return null;
  }
  const compact = input.toUpperCase().replace(/[\s-]/g, "");
  return DISPLAY_CODE_PATTERN.test(compact)
    ? {
        kind: "displayCode",
        displayCode: `${compact.slice(0, 4)}-${compact.slice(4)}`,
      }
    : null;
}

export function formatManualCodeDraft(input: string): string {
  const compact = input
    .toUpperCase()
    .replace(/[^ABCDEFGHJKLMNPQRSTUVWXYZ23456789]/g, "")
    .slice(0, 8);
  return compact.length > 4 ? `${compact.slice(0, 4)}-${compact.slice(4)}` : compact;
}
