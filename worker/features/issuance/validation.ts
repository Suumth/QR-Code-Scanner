const MAX_SPONSOR_NAME_LENGTH = 120;
const MAX_VOUCHERS_PER_REQUEST = 500;

export function parseSponsorName(value: unknown): string | null {
  if (!isRecord(value) || typeof value.name !== "string") {
    return null;
  }

  const name = value.name.trim();
  return name && name.length <= MAX_SPONSOR_NAME_LENGTH ? name : null;
}

export function parseVoucherCount(value: unknown): number | null {
  if (!isRecord(value) || !Number.isInteger(value.count)) {
    return null;
  }

  const count = value.count as number;
  return count >= 1 && count <= MAX_VOUCHERS_PER_REQUEST ? count : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
