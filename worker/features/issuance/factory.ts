import { generateDisplayCode, generateOpaqueId } from "../../security/crypto";
import type { NewVoucher, SafeSponsor } from "./types";

const MAX_BATCH_IDENTIFIER_ATTEMPTS_PER_VOUCHER = 10;

export function createSponsor(eventId: string, name: string, createdAt: string): SafeSponsor {
  return {
    id: generateOpaqueId(16),
    eventId,
    name,
    accessId: generateOpaqueId(24),
    createdAt,
  };
}

export function createVoucherBatch(
  eventId: string,
  sponsorId: string,
  voucherTypeId: string,
  count: number,
  createdAt: string,
): NewVoucher[] {
  const vouchers: NewVoucher[] = [];
  const ids = new Set<string>();
  const publicIds = new Set<string>();
  const displayCodes = new Set<string>();
  let attempts = 0;

  while (vouchers.length < count) {
    if (attempts >= count * MAX_BATCH_IDENTIFIER_ATTEMPTS_PER_VOUCHER) {
      throw new Error("Unable to generate a unique voucher batch");
    }
    attempts += 1;

    const voucher: NewVoucher = {
      id: generateOpaqueId(16),
      publicId: generateOpaqueId(16),
      eventId,
      sponsorId,
      voucherTypeId,
      displayCode: generateDisplayCode(),
      createdAt,
    };
    if (ids.has(voucher.id) || publicIds.has(voucher.publicId) || displayCodes.has(voucher.displayCode)) {
      continue;
    }

    ids.add(voucher.id);
    publicIds.add(voucher.publicId);
    displayCodes.add(voucher.displayCode);
    vouchers.push(voucher);
  }

  return vouchers;
}
