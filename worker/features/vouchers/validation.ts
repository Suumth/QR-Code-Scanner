import type { VoucherLocator } from "./types";

const PUBLIC_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const DISPLAY_CODE_CHARACTERS = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/;
const MAX_MANUAL_INPUT_LENGTH = 24;

export function parseVoucherLocator(value: unknown): VoucherLocator | null {
  if (!isRecord(value)) {
    return null;
  }

  const hasPublicId = Object.prototype.hasOwnProperty.call(value, "publicId");
  const hasDisplayCode = Object.prototype.hasOwnProperty.call(value, "displayCode");
  if (Number(hasPublicId) + Number(hasDisplayCode) !== 1) {
    return null;
  }

  if (hasPublicId) {
    if (typeof value.publicId !== "string") {
      return null;
    }
    const publicId = value.publicId.trim();
    return PUBLIC_ID_PATTERN.test(publicId) ? { kind: "public_id", value: publicId } : null;
  }

  if (
    typeof value.displayCode !== "string" ||
    value.displayCode.length > MAX_MANUAL_INPUT_LENGTH
  ) {
    return null;
  }
  const compactCode = value.displayCode.toUpperCase().replace(/[\s-]/g, "");
  if (!DISPLAY_CODE_CHARACTERS.test(compactCode)) {
    return null;
  }
  return {
    kind: "display_code",
    value: `${compactCode.slice(0, 4)}-${compactCode.slice(4)}`,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
