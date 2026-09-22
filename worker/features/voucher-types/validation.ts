export function parseVoucherTypeName(value: unknown): string | null {
  if (!isRecord(value) || typeof value.name !== "string") {
    return null;
  }

  const name = value.name.trim();
  if (name.length < 1 || name.length > 80 || /\p{Cc}/u.test(name)) {
    return null;
  }

  return name;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
