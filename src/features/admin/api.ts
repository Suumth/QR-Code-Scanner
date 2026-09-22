import {
  AdminApiError,
  type AdminEvent,
  type AdminEventDetail,
  type AdminQrExportData,
  type AdminQrExportVoucher,
  type AdminSponsor,
  type AdminSponsorPage,
  type AdminSummary,
  type AdminTeamSession,
  type AdminTeamSessionStatus,
  type AdminVoucherType,
  type CreateEventInput,
} from "./types";

export async function loadAdminEvents(signal: AbortSignal): Promise<AdminEvent[] | null> {
  const response = await fetch("/api/admin/events", requestOptions(signal));
  if (response.status === 401) {
    return null;
  }
  await requireOk(response, "Events konnten nicht geladen werden");
  const payload: unknown = await response.json();
  if (!isRecord(payload) || !Array.isArray(payload.events)) {
    throw new Error("Invalid admin event list response");
  }
  const events = payload.events.map(parseEvent);
  if (events.some((item) => item === null)) {
    throw new Error("Invalid admin event list response");
  }
  return events as AdminEvent[];
}

export async function loadAdminEvent(eventId: string, signal: AbortSignal): Promise<AdminEventDetail> {
  const response = await fetch(`/api/admin/events/${encodeURIComponent(eventId)}`, requestOptions(signal));
  await requireOk(response, "Event konnte nicht geladen werden");
  const payload: unknown = await response.json();
  if (!isRecord(payload)) {
    throw new Error("Invalid admin event response");
  }
  const event = parseEvent(payload.event);
  const summary = parseSummary(payload.summary);
  const sponsors = Array.isArray(payload.sponsors) ? payload.sponsors.map(parseSponsor) : [];
  const sponsorsNextCursor = parseNextCursor(payload.sponsorsNextCursor);
  const teamSessions = Array.isArray(payload.teamSessions)
    ? payload.teamSessions.map(parseTeamSession)
    : [];
  if (
    !event ||
    !summary ||
    !Array.isArray(payload.sponsors) ||
    sponsors.some((item) => item === null) ||
    sponsorsNextCursor === undefined ||
    !Array.isArray(payload.teamSessions) ||
    teamSessions.some((item) => item === null)
  ) {
    throw new Error("Invalid admin event response");
  }
  return {
    event,
    summary,
    sponsors: sponsors as AdminSponsor[],
    sponsorsNextCursor,
    teamSessions: teamSessions as AdminTeamSession[],
  };
}

export async function loadAdminSponsorPage(
  eventId: string,
  cursor: string,
  signal: AbortSignal,
): Promise<AdminSponsorPage> {
  const response = await fetch(
    `/api/admin/events/${encodeURIComponent(eventId)}/sponsors?cursor=${encodeURIComponent(cursor)}`,
    requestOptions(signal),
  );
  await requireOk(response, "Sponsoren konnten nicht geladen werden");
  const payload: unknown = await response.json();
  if (!isRecord(payload) || !Array.isArray(payload.sponsors)) {
    throw new Error("Invalid admin sponsor page response");
  }
  const sponsors = payload.sponsors.map(parseSponsor);
  const nextCursor = parseNextCursor(payload.nextCursor);
  if (sponsors.some((item) => item === null) || nextCursor === undefined) {
    throw new Error("Invalid admin sponsor page response");
  }
  return { sponsors: sponsors as AdminSponsor[], nextCursor };
}

export async function loginAdmin(password: string, signal: AbortSignal): Promise<void> {
  const response = await postJson("/api/admin/login", { password }, signal);
  if (response.status !== 204) {
    await requireOk(response, "Anmeldung fehlgeschlagen");
  }
}

export async function logoutAdmin(signal: AbortSignal): Promise<void> {
  const response = await fetch("/api/admin/logout", {
    method: "POST",
    credentials: "same-origin",
    headers: { Accept: "application/json" },
    signal,
  });
  if (response.status !== 204 && response.status !== 401) {
    throw new AdminApiError(response.status, "Abmeldung fehlgeschlagen");
  }
}

export async function createAdminEvent(input: CreateEventInput, signal: AbortSignal): Promise<AdminEvent> {
  const response = await postJson("/api/admin/events", input, signal);
  await requireOk(response, "Event konnte nicht erstellt werden");
  const payload: unknown = await response.json();
  const event = isRecord(payload) ? parseEvent(payload.event) : null;
  if (!event) {
    throw new Error("Invalid create event response");
  }
  return event;
}

export async function createAdminSponsor(
  eventId: string,
  name: string,
  signal: AbortSignal,
): Promise<void> {
  const response = await postJson(
    `/api/admin/events/${encodeURIComponent(eventId)}/sponsors`,
    { name },
    signal,
  );
  await requireOk(response, "Sponsor konnte nicht angelegt werden");
}

export async function createAdminVoucherType(
  eventId: string,
  sponsorId: string,
  name: string,
  signal: AbortSignal,
): Promise<void> {
  const response = await postJson(
    `/api/admin/events/${encodeURIComponent(eventId)}/sponsors/${encodeURIComponent(sponsorId)}/voucher-types`,
    { name },
    signal,
  );
  await requireOk(response, "Gutscheinart konnte nicht angelegt werden");
}

export async function issueAdminVouchers(
  eventId: string,
  sponsorId: string,
  voucherTypeId: string,
  count: number,
  signal: AbortSignal,
): Promise<void> {
  const response = await postJson(
    `/api/admin/events/${encodeURIComponent(eventId)}/sponsors/${encodeURIComponent(sponsorId)}/voucher-types/${encodeURIComponent(voucherTypeId)}/vouchers`,
    { count },
    signal,
  );
  await requireOk(response, "Gutscheine konnten nicht erstellt werden");
}

export async function changeAdminTeamPin(
  eventId: string,
  teamPin: string,
  signal: AbortSignal,
): Promise<void> {
  const response = await postJson(
    `/api/admin/events/${encodeURIComponent(eventId)}/team-pin`,
    { teamPin },
    signal,
  );
  if (response.status !== 204) {
    await requireOk(response, "Team-PIN konnte nicht geändert werden");
  }
}

export async function revokeAdminTeamSessions(eventId: string, signal: AbortSignal): Promise<void> {
  const response = await postJson(
    `/api/admin/events/${encodeURIComponent(eventId)}/revoke-team-sessions`,
    {},
    signal,
  );
  if (response.status !== 204) {
    await requireOk(response, "Team-Sitzungen konnten nicht widerrufen werden");
  }
}

export async function loadAdminCsv(eventId: string, signal: AbortSignal): Promise<Blob> {
  const response = await fetch(
    `/api/admin/events/${encodeURIComponent(eventId)}/export.csv`,
    requestOptions(signal, "text/csv"),
  );
  await requireOk(response, "CSV konnte nicht exportiert werden");
  if (!response.headers.get("Content-Type")?.toLowerCase().startsWith("text/csv")) {
    throw new Error("Invalid CSV response");
  }
  return response.blob();
}

export async function loadAdminQrExport(
  eventId: string,
  sponsorId: string,
  voucherTypeId: string,
  signal: AbortSignal,
): Promise<AdminQrExportData> {
  const response = await fetch(
    `/api/admin/events/${encodeURIComponent(eventId)}/sponsors/${encodeURIComponent(sponsorId)}/voucher-types/${encodeURIComponent(voucherTypeId)}/qr-export`,
    requestOptions(signal),
  );
  await requireOk(response, "QR-Paket konnte nicht geladen werden");
  const payload: unknown = await response.json();
  if (!isQrExportData(payload)) {
    throw new Error("Invalid admin QR export response");
  }
  return payload;
}

function requestOptions(signal: AbortSignal, accept = "application/json"): RequestInit {
  return {
    cache: "no-store",
    credentials: "same-origin",
    headers: { Accept: accept },
    signal,
  };
}

function postJson(path: string, body: unknown, signal: AbortSignal): Promise<Response> {
  return fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
}

async function requireOk(response: Response, fallbackMessage: string): Promise<void> {
  if (response.ok) {
    return;
  }
  throw new AdminApiError(response.status, fallbackMessage);
}

function parseEvent(value: unknown): AdminEvent | null {
  return isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.publicId === "string" &&
    typeof value.name === "string" &&
    typeof value.eventDate === "string" &&
    typeof value.createdAt === "string"
    ? {
        id: value.id,
        publicId: value.publicId,
        name: value.name,
        eventDate: value.eventDate,
        createdAt: value.createdAt,
      }
    : null;
}

function parseSummary(value: unknown): AdminSummary | null {
  return isRecord(value) &&
    isCount(value.issuedCount) &&
    isCount(value.availableCount) &&
    isCount(value.redeemedCount)
    ? {
        issuedCount: value.issuedCount,
        availableCount: value.availableCount,
        redeemedCount: value.redeemedCount,
      }
    : null;
}

function parseSponsor(value: unknown): AdminSponsor | null {
  const summary = parseSummary(value);
  const voucherTypes = isRecord(value) && Array.isArray(value.voucherTypes)
    ? value.voucherTypes.map(parseVoucherType)
    : null;
  return summary &&
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.accessId === "string" &&
    typeof value.createdAt === "string" &&
    voucherTypes !== null &&
    voucherTypes.every((item) => item !== null)
    ? {
        id: value.id,
        name: value.name,
        accessId: value.accessId,
        createdAt: value.createdAt,
        ...summary,
        voucherTypes: voucherTypes as AdminVoucherType[],
      }
    : null;
}

function parseVoucherType(value: unknown): AdminVoucherType | null {
  const summary = parseSummary(value);
  return summary &&
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string"
    ? { id: value.id, name: value.name, ...summary }
    : null;
}

function parseNextCursor(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }
  return typeof value === "string" && value.length > 0 && value.length <= 128
    ? value
    : undefined;
}

function parseTeamSession(value: unknown): AdminTeamSession | null {
  if (
    !isRecord(value) ||
    typeof value.displayName !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.lastSeenAt !== "string" ||
    typeof value.expiresAt !== "string" ||
    (value.revokedAt !== null && typeof value.revokedAt !== "string") ||
    !isSessionStatus(value.status)
  ) {
    return null;
  }
  return {
    displayName: value.displayName,
    createdAt: value.createdAt,
    lastSeenAt: value.lastSeenAt,
    expiresAt: value.expiresAt,
    revokedAt: value.revokedAt,
    status: value.status,
  };
}

function isQrExportData(value: unknown): value is AdminQrExportData {
  return (
    isRecord(value) &&
    typeof value.sponsorName === "string" &&
    typeof value.voucherTypeName === "string" &&
    Array.isArray(value.vouchers) &&
    value.vouchers.every(isQrExportVoucher)
  );
}

function isQrExportVoucher(value: unknown): value is AdminQrExportVoucher {
  return (
    isRecord(value) &&
    typeof value.publicId === "string" &&
    typeof value.displayCode === "string" &&
    (value.status === "available" || value.status === "redeemed")
  );
}

function isSessionStatus(value: unknown): value is AdminTeamSessionStatus {
  return value === "active" || value === "revoked" || value === "expired" || value === "superseded";
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
