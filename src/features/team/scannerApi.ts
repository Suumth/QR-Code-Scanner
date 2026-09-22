import type {
  AvailableVoucher,
  InspectResult,
  RedeemedVoucher,
  RedeemResult,
  VoucherDetails,
  VoucherLocator,
} from "./scannerState";

export interface EventSummary {
  redeemedCount: number;
}

export interface ScannerApi {
  inspect(locator: VoucherLocator, signal: AbortSignal): Promise<InspectResult>;
  redeem(locator: VoucherLocator, signal: AbortSignal): Promise<RedeemResult>;
  eventSummary(signal: AbortSignal): Promise<EventSummary>;
}

export type ScannerApiFailure = "unauthorized" | "network" | "invalid_response";

export class ScannerApiError extends Error {
  constructor(readonly failure: ScannerApiFailure) {
    super(failure);
    this.name = "ScannerApiError";
  }
}

interface ScannerApiOptions {
  fetcher?: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 8_000;
const PUBLIC_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const DISPLAY_CODE_PATTERN = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/;

export function createScannerApi({
  fetcher = (input, init) => globalThis.fetch(input, init),
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: ScannerApiOptions = {}): ScannerApi {
  return {
    async inspect(locator, signal) {
      const payload = await requestJson(
        fetcher,
        "/api/team/vouchers/inspect",
        voucherRequest(locator, signal),
        signal,
        timeoutMs,
      );
      const result = parseInspectResult(payload);
      if (!result) {
        throw new ScannerApiError("invalid_response");
      }
      return result;
    },

    async redeem(locator, signal) {
      const payload = await requestJson(
        fetcher,
        "/api/team/vouchers/redeem",
        voucherRequest(locator, signal),
        signal,
        timeoutMs,
      );
      const result = parseRedeemResult(payload);
      if (!result) {
        throw new ScannerApiError("invalid_response");
      }
      return result;
    },

    async eventSummary(signal) {
      const payload = await requestJson(
        fetcher,
        "/api/team/event-summary",
        {
          cache: "no-store",
          credentials: "same-origin",
          headers: { Accept: "application/json" },
          signal,
        },
        signal,
        timeoutMs,
      );
      if (
        !isRecord(payload) ||
        !isRecord(payload.summary) ||
        !Number.isInteger(payload.summary.redeemedCount) ||
        (payload.summary.redeemedCount as number) < 0
      ) {
        throw new ScannerApiError("invalid_response");
      }
      return { redeemedCount: payload.summary.redeemedCount as number };
    },
  };
}

export const scannerApi = createScannerApi();

function voucherRequest(locator: VoucherLocator, signal: AbortSignal): RequestInit {
  return {
    method: "POST",
    cache: "no-store",
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(
      locator.kind === "publicId"
        ? { publicId: locator.publicId }
        : { displayCode: locator.displayCode },
    ),
    signal,
  };
}

async function requestJson(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit,
  externalSignal: AbortSignal,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const abortFromExternal = () => {
    controller.abort(
      externalSignal.reason ?? new DOMException("Request aborted", "AbortError"),
    );
  };
  if (externalSignal.aborted) {
    abortFromExternal();
  } else {
    externalSignal.addEventListener("abort", abortFromExternal, { once: true });
  }
  const timeout = setTimeout(() => {
    controller.abort(new DOMException("Request timed out", "TimeoutError"));
  }, timeoutMs);

  try {
    let response: Response;
    try {
      response = await fetcher(url, { ...init, signal: controller.signal });
    } catch {
      if (controller.signal.aborted) {
        throw controller.signal.reason;
      }
      throw new ScannerApiError("network");
    }

    if (controller.signal.aborted) {
      throw controller.signal.reason;
    }
    if (response.status === 401) {
      throw new ScannerApiError("unauthorized");
    }
    if (!response.ok) {
      throw new ScannerApiError("network");
    }

    try {
      const payload: unknown = await response.json();
      if (controller.signal.aborted) {
        throw controller.signal.reason;
      }
      return payload;
    } catch (error) {
      if (controller.signal.aborted) {
        throw controller.signal.reason;
      }
      if (error instanceof ScannerApiError) {
        throw error;
      }
      throw new ScannerApiError("invalid_response");
    }
  } finally {
    clearTimeout(timeout);
    externalSignal.removeEventListener("abort", abortFromExternal);
  }
}

function parseInspectResult(value: unknown): InspectResult | null {
  if (!isRecord(value) || typeof value.status !== "string") {
    return null;
  }
  if (value.status === "invalid") {
    return { status: "invalid" };
  }
  if (value.status === "available") {
    const voucher = parseVoucher(value.voucher);
    return voucher?.redeemedAt === null
      ? { status: "available", voucher: voucher as AvailableVoucher }
      : null;
  }
  if (value.status === "already_redeemed") {
    const voucher = parseVoucher(value.voucher);
    return typeof voucher?.redeemedAt === "string"
      ? { status: "already_redeemed", voucher: voucher as RedeemedVoucher }
      : null;
  }
  return null;
}

function parseRedeemResult(value: unknown): RedeemResult | null {
  if (!isRecord(value) || typeof value.status !== "string") {
    return null;
  }
  if (value.status === "invalid") {
    return { status: "invalid" };
  }
  if (value.status === "redeemed" || value.status === "already_redeemed") {
    const voucher = parseVoucher(value.voucher);
    if (typeof voucher?.redeemedAt !== "string") {
      return null;
    }
    return value.status === "redeemed"
      ? { status: "redeemed", voucher: voucher as RedeemedVoucher }
      : { status: "already_redeemed", voucher: voucher as RedeemedVoucher };
  }
  return null;
}

function parseVoucher(value: unknown): VoucherDetails | null {
  if (
    !isRecord(value) ||
    typeof value.publicId !== "string" ||
    !PUBLIC_ID_PATTERN.test(value.publicId) ||
    typeof value.displayCode !== "string" ||
    !DISPLAY_CODE_PATTERN.test(value.displayCode) ||
    (value.redeemedAt !== null && typeof value.redeemedAt !== "string") ||
    !isRecord(value.event) ||
    typeof value.event.name !== "string" ||
    typeof value.event.eventDate !== "string" ||
    !isRecord(value.sponsor) ||
    typeof value.sponsor.name !== "string" ||
    !isRecord(value.voucherType) ||
    typeof value.voucherType.name !== "string" ||
    value.voucherType.name.length === 0
  ) {
    return null;
  }
  return {
    publicId: value.publicId,
    displayCode: value.displayCode,
    redeemedAt: value.redeemedAt,
    event: {
      name: value.event.name,
      eventDate: value.event.eventDate,
    },
    sponsor: { name: value.sponsor.name },
    voucherType: { name: value.voucherType.name },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
