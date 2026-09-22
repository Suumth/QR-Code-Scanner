const DISPLAY_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
// 100k SHA-256 rounds keeps the team PIN derivation costly while remaining
// practical for Workers' short-lived request execution model.
const PBKDF2_ITERATIONS = 100_000;
const PIN_HASH_LENGTH_BITS = 256;

const textEncoder = new TextEncoder();

interface WorkerSubtleCrypto extends SubtleCrypto {
  timingSafeEqual(a: ArrayBuffer | ArrayBufferView, b: ArrayBuffer | ArrayBufferView): boolean;
}

export function generateOpaqueId(bytes: number): string {
  if (!Number.isInteger(bytes) || bytes <= 0) {
    throw new RangeError("Opaque identifier byte length must be a positive integer");
  }

  const value = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = "";

  for (const byte of value) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export async function sha256Hex(value: string): Promise<string> {
  return bytesToHex(await crypto.subtle.digest("SHA-256", textEncoder.encode(value)));
}

export function generateDisplayCode(): string {
  const randomValues = crypto.getRandomValues(new Uint8Array(8));
  const characters = Array.from(
    randomValues,
    (value) => DISPLAY_CODE_ALPHABET[value % DISPLAY_CODE_ALPHABET.length],
  );

  return `${characters.slice(0, 4).join("")}-${characters.slice(4).join("")}`;
}

export function isValidTeamPin(pin: string): boolean {
  return /^\d{6}$/.test(pin);
}

export async function derivePin(pin: string, salt: string): Promise<string> {
  if (!isValidTeamPin(pin)) {
    throw new RangeError("Team PIN must contain exactly six decimal digits");
  }

  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(pin),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const derived = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: textEncoder.encode(salt),
      iterations: PBKDF2_ITERATIONS,
    },
    key,
    PIN_HASH_LENGTH_BITS,
  );

  return bytesToHex(derived);
}

export async function verifyPin(pin: string, salt: string, expected: string): Promise<boolean> {
  if (!isValidTeamPin(pin) || !/^[0-9a-f]{64}$/.test(expected)) {
    return false;
  }

  const actual = await derivePin(pin, salt);
  return (crypto.subtle as WorkerSubtleCrypto).timingSafeEqual(
    hexToBytes(actual),
    hexToBytes(expected),
  );
}

function bytesToHex(value: ArrayBuffer): string {
  return Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(value: string): Uint8Array {
  return Uint8Array.from({ length: value.length / 2 }, (_, index) =>
    Number.parseInt(value.slice(index * 2, index * 2 + 2), 16),
  );
}
