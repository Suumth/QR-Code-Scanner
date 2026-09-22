import { derivePin, generateOpaqueId } from "../../security/crypto";
import { withAdminResponseHeaders } from "../../http/admin-response";
import { readBoundedJsonObject } from "../../http/json";
import { clearAdminSessionCookie, createAdminSession, getAdminSession, verifyAdminPassword } from "./auth";
import { findEvent, insertEvent, listEvents, revokeAdminSession } from "./repository";
import type { AdminEnv, SafeEvent } from "./types";
import { parseCreateEventInput } from "./validation";
import { handleIssuanceRequest } from "../issuance/routes";
import { handleVoucherTypeRequest } from "../voucher-types/routes";
import { handleTeamAdminRequest } from "../team/routes";
import {
  MAX_ADMIN_CSV_EXPORT_ROWS,
  decodeAdminSponsorCursor,
  getAdminEventSummary,
  listAdminSponsorSummaries,
  listAdminTeamSessions,
  listAdminVoucherExportRows,
} from "./dashboard-repository";
import { createVoucherCsv, voucherCsvFilename } from "./csv";
import {
  listAdminQrExportRows,
  MAX_ADMIN_QR_EXPORT_VOUCHERS,
} from "./qr-export-repository";

const ADMIN_LOGIN_RATE_LIMIT_KEY = "admin-login";

export async function handleAdminRequest(request: Request, env: AdminEnv): Promise<Response | null> {
  const url = new URL(request.url);

  if (url.pathname === "/api/admin/login") {
    return withAdminResponseHeaders(
      request.method === "POST" ? await login(request, env) : methodNotAllowed("POST"),
      false,
    );
  }
  if (url.pathname === "/api/admin/logout") {
    return withAdminResponseHeaders(
      request.method === "POST" ? await logout(request, env) : methodNotAllowed("POST"),
      true,
    );
  }
  if (url.pathname === "/api/admin/events") {
    return withAdminResponseHeaders(await events(request, env), true);
  }

  const qrExportMatch = /^\/api\/admin\/events\/([^/]+)\/sponsors\/([^/]+)\/voucher-types\/([^/]+)\/qr-export$/.exec(
    url.pathname,
  );
  if (qrExportMatch) {
    return withAdminResponseHeaders(
      request.method === "GET"
        ? await exportSponsorQrAssets(request, env, qrExportMatch[1], qrExportMatch[2], qrExportMatch[3])
        : methodNotAllowed("GET"),
      true,
    );
  }

  const sponsorPageMatch = /^\/api\/admin\/events\/([^/]+)\/sponsors$/.exec(url.pathname);
  if (sponsorPageMatch && request.method !== "POST") {
    return withAdminResponseHeaders(
      request.method === "GET"
        ? await eventSponsors(request, env, sponsorPageMatch[1], url)
        : methodNotAllowed("GET, POST"),
      true,
    );
  }

  const voucherTypeResponse = await handleVoucherTypeRequest(request, env);
  if (voucherTypeResponse) {
    return withAdminResponseHeaders(voucherTypeResponse, true);
  }

  const issuanceResponse = await handleIssuanceRequest(request, env);
  if (issuanceResponse) {
    return withAdminResponseHeaders(issuanceResponse, true);
  }

  const teamAdminResponse = await handleTeamAdminRequest(request, env);
  if (teamAdminResponse) {
    return withAdminResponseHeaders(teamAdminResponse, true);
  }

  const exportMatch = /^\/api\/admin\/events\/([^/]+)\/export\.csv$/.exec(url.pathname);
  if (exportMatch) {
    return withAdminResponseHeaders(
      request.method === "GET"
        ? await exportEventCsv(request, env, exportMatch[1])
        : methodNotAllowed("GET"),
      true,
    );
  }

  const detailMatch = /^\/api\/admin\/events\/([^/]+)$/.exec(url.pathname);
  return detailMatch
    ? withAdminResponseHeaders(await eventDetail(request, env, detailMatch[1]), true)
    : null;
}

async function login(request: Request, env: AdminEnv): Promise<Response> {
  const rateLimit = await env.ADMIN_LOGIN_RATE_LIMITER.limit({ key: ADMIN_LOGIN_RATE_LIMIT_KEY });
  if (!rateLimit.success) {
    return error("Too many login attempts", 429);
  }

  const body = await readBoundedJsonObject(request);
  if ("error" in body) {
    return jsonReadError(body.error);
  }

  const password = typeof body.value.password === "string" ? body.value.password : "";
  if (!(await verifyAdminPassword(password, env.ADMIN_PASSWORD))) {
    return error("Invalid credentials", 401);
  }

  const session = await createAdminSession(env, new Date());
  return new Response(null, { status: 204, headers: { "Set-Cookie": session.cookie } });
}

async function logout(request: Request, env: AdminEnv): Promise<Response> {
  const session = await getAdminSession(request, env, new Date());
  if (!session) {
    return Response.json(
      { error: "Unauthorized" },
      { status: 401, headers: { "Set-Cookie": clearAdminSessionCookie() } },
    );
  }

  await revokeAdminSession(env.DB, session.id, new Date().toISOString());
  return new Response(null, {
    status: 204,
    headers: { "Set-Cookie": clearAdminSessionCookie() },
  });
}

async function events(request: Request, env: AdminEnv): Promise<Response> {
  const session = await getAdminSession(request, env, new Date());
  if (!session) {
    return error("Unauthorized", 401);
  }
  if (request.method === "GET") {
    return Response.json({ events: await listEvents(env.DB) });
  }
  if (request.method !== "POST") {
    return methodNotAllowed("GET, POST");
  }

  const body = await readBoundedJsonObject(request);
  if ("error" in body) {
    return jsonReadError(body.error);
  }

  const input = parseCreateEventInput(body.value);
  if (!input) {
    return error("Invalid event", 400);
  }

  const event: SafeEvent & { teamPinSalt: string; teamPinHash: string } = {
    id: generateOpaqueId(16),
    publicId: generateOpaqueId(16),
    name: input.name,
    eventDate: input.eventDate,
    teamPinSalt: generateOpaqueId(24),
    teamPinHash: "",
    createdAt: new Date().toISOString(),
  };
  event.teamPinHash = await derivePin(input.teamPin, event.teamPinSalt);
  await insertEvent(env.DB, event);

  return Response.json({ event: safeEvent(event) }, { status: 201 });
}

async function eventDetail(request: Request, env: AdminEnv, eventId: string): Promise<Response> {
  if (request.method !== "GET") {
    return methodNotAllowed("GET");
  }

  const session = await getAdminSession(request, env, new Date());
  if (!session) {
    return error("Unauthorized", 401);
  }

  const event = await findEvent(env.DB, eventId);
  if (!event) {
    return error("Event not found", 404);
  }

  const now = new Date().toISOString();
  const [summary, sponsorPage, teamSessions] = await Promise.all([
    getAdminEventSummary(env.DB, eventId),
    listAdminSponsorSummaries(env.DB, eventId),
    listAdminTeamSessions(env.DB, eventId, now),
  ]);
  return Response.json({
    event,
    summary,
    sponsors: sponsorPage.sponsors,
    sponsorsNextCursor: sponsorPage.nextCursor,
    teamSessions,
  });
}

async function eventSponsors(
  request: Request,
  env: AdminEnv,
  eventId: string,
  url: URL,
): Promise<Response> {
  if (!(await getAdminSession(request, env, new Date()))) {
    return error("Unauthorized", 401);
  }
  if (!(await findEvent(env.DB, eventId))) {
    return error("Event not found", 404);
  }

  const cursors = url.searchParams.getAll("cursor");
  const afterRowId = cursors.length === 0 ? 0 : decodeAdminSponsorCursor(cursors[0]);
  if (cursors.length > 1 || afterRowId === null) {
    return error("Invalid sponsor cursor", 400);
  }
  const page = await listAdminSponsorSummaries(env.DB, eventId, afterRowId);
  return Response.json(page);
}

async function exportEventCsv(request: Request, env: AdminEnv, eventId: string): Promise<Response> {
  if (!(await getAdminSession(request, env, new Date()))) {
    return error("Unauthorized", 401);
  }

  const event = await findEvent(env.DB, eventId);
  if (!event) {
    return error("Event not found", 404);
  }
  const rows = await listAdminVoucherExportRows(env.DB, eventId);
  if (rows === null) {
    return error(`CSV export is limited to ${MAX_ADMIN_CSV_EXPORT_ROWS} vouchers`, 413);
  }
  const csv = createVoucherCsv(rows);
  const filename = voucherCsvFilename(event.eventDate);
  return new Response(csv, {
    headers: {
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Type": "text/csv; charset=utf-8",
    },
  });
}

async function exportSponsorQrAssets(
  request: Request,
  env: AdminEnv,
  eventId: string,
  sponsorId: string,
  voucherTypeId: string,
): Promise<Response> {
  if (!(await getAdminSession(request, env, new Date()))) {
    return error("Unauthorized", 401);
  }

  const result = await listAdminQrExportRows(env.DB, eventId, sponsorId, voucherTypeId);
  if (result === null) {
    return error("Sponsor not found", 404);
  }
  if (result === "too_many") {
    return error(`QR export is limited to ${MAX_ADMIN_QR_EXPORT_VOUCHERS} vouchers`, 413);
  }

  return Response.json(result);
}

function safeEvent(event: SafeEvent): SafeEvent {
  return {
    id: event.id,
    publicId: event.publicId,
    name: event.name,
    eventDate: event.eventDate,
    createdAt: event.createdAt,
  };
}

function error(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

function jsonReadError(errorCode: "malformed" | "too_large" | "unsupported_media_type"): Response {
  switch (errorCode) {
    case "unsupported_media_type":
      return error("Unsupported media type", 415);
    case "too_large":
      return error("Payload too large", 413);
    case "malformed":
      return error("Malformed JSON", 400);
  }
}

function methodNotAllowed(allow: string): Response {
  return new Response(null, { status: 405, headers: { Allow: allow } });
}
