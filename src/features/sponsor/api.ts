import type {
  PublicVoucherSnapshot,
  SponsorSnapshot,
  SponsorVoucherType,
  VoucherSummary,
} from "./types";

export async function loadSponsorSnapshot(
  accessId: string,
  signal: AbortSignal,
): Promise<SponsorSnapshot> {
  const payload = await getJson(`/api/sponsor/${encodeURIComponent(accessId)}`, signal);
  if (!isSponsorSnapshot(payload)) {
    throw new Error("Invalid sponsor response");
  }
  return payload;
}

export async function loadPublicVoucherSnapshot(
  publicId: string,
  signal: AbortSignal,
): Promise<PublicVoucherSnapshot> {
  const payload = await getJson(`/api/voucher/${encodeURIComponent(publicId)}`, signal);
  if (!isPublicVoucherSnapshot(payload)) {
    throw new Error("Invalid voucher response");
  }
  return payload;
}

async function getJson(path: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(path, {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal,
  });
  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}`);
  }
  return response.json();
}

function isSponsorSnapshot(value: unknown): value is SponsorSnapshot {
  if (!isRecord(value) || !isEvent(value.event) || !isSponsor(value.sponsor)) {
    return false;
  }
  if (!isRecord(value.totals) || !Array.isArray(value.voucherTypes)) {
    return false;
  }
  const { total, available, redeemed } = value.totals;
  const voucherTypes = value.voucherTypes.filter(isSponsorVoucherType);
  const typeTotals = voucherTypes.reduce(
    (totals, voucherType) => ({
      total: totals.total + voucherType.totals.total,
      available: totals.available + voucherType.totals.available,
      redeemed: totals.redeemed + voucherType.totals.redeemed,
    }),
    { total: 0, available: 0, redeemed: 0 },
  );
  return (
    isCount(total) &&
    isCount(available) &&
    isCount(redeemed) &&
    total === available + redeemed &&
    voucherTypes.length === value.voucherTypes.length &&
    typeTotals.total === total &&
    typeTotals.available === available &&
    typeTotals.redeemed === redeemed
  );
}

function isPublicVoucherSnapshot(value: unknown): value is PublicVoucherSnapshot {
  return (
    isRecord(value) &&
    isEvent(value.event) &&
    isSponsor(value.sponsor) &&
    isVoucher(value.voucher)
  );
}

function isEvent(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.eventDate === "string"
  );
}

function isSponsor(value: unknown): boolean {
  return isRecord(value) && typeof value.name === "string";
}

function isVoucher(value: unknown): value is VoucherSummary {
  return (
    isRecord(value) &&
    typeof value.publicId === "string" &&
    typeof value.displayCode === "string" &&
    (value.status === "available" || value.status === "redeemed") &&
    isVoucherTypeSummary(value.voucherType)
  );
}

function isSponsorVoucherType(value: unknown): value is SponsorVoucherType {
  if (
    !isRecord(value) ||
    typeof value.name !== "string" ||
    value.name.length === 0 ||
    !isRecord(value.totals) ||
    !Array.isArray(value.vouchers)
  ) {
    return false;
  }
  const { total, available, redeemed } = value.totals;
  return (
    isCount(total) &&
    isCount(available) &&
    isCount(redeemed) &&
    total === available + redeemed &&
    value.vouchers.length === total &&
    value.vouchers.every(
      (voucher) => isVoucher(voucher) && voucher.voucherType.name === value.name,
    )
  );
}

function isVoucherTypeSummary(value: unknown): boolean {
  return isRecord(value) && typeof value.name === "string" && value.name.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
