export interface SessionCookieOptions {
  name: string;
  value: string;
  expiresAt: Date;
  secure?: boolean;
}

export function createSessionCookie({
  name,
  value,
  expiresAt,
  secure = true,
}: SessionCookieOptions): string {
  const attributes = [
    `${name}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Expires=${expiresAt.toUTCString()}`,
  ];

  if (secure) {
    attributes.push("Secure");
  }

  return attributes.join("; ");
}

export function clearSessionCookie(name: string): string {
  return `${name}=; Path=/; HttpOnly; SameSite=Strict; Secure; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0`;
}

export function readCookie(header: string | null, name: string): string | null {
  if (!header) {
    return null;
  }

  for (const part of header.split(";")) {
    const [key, value] = part.trim().split("=", 2);
    if (key === name && value) {
      return value;
    }
  }

  return null;
}
