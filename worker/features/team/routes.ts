import { withPrivateResponseHeaders } from "../../http/admin-response";
import { readBoundedJsonObject } from "../../http/json";
import { derivePin, generateOpaqueId, verifyPin } from "../../security/crypto";
import { getAdminSession } from "../admin/auth";
import type { AdminEnv } from "../admin/types";
import { handleTeamVoucherRequest } from "../vouchers/routes";
import {
  clearTeamSessionCookie,
  createTeamSession,
  getTeamSession,
  revokeCurrentTeamSession,
  safeTeamSession,
} from "./auth";
import {
  countRedeemedVouchersForEvent,
  findTeamEventByPublicId,
  formatBerlinDate,
  listPublicTeamEvents,
  revokeAllTeamSessionsByVersion,
  rotateTeamPin,
} from "./repository";
import type { TeamEnv } from "./types";
import { parseTeamLoginInput, parseTeamPin } from "./validation";

const EVENT_PUBLIC_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;

export async function handleTeamRequest(
  request: Request,
  env: TeamEnv,
): Promise<Response | null> {
  const pathname = new URL(request.url).pathname;
  const voucherResponse = await handleTeamVoucherRequest(request, env);
  if (voucherResponse) {
    return voucherResponse;
  }

  if (pathname === "/api/team/events") {
    return withPrivateResponseHeaders(
      request.method === "GET" ? await publicEvents(env) : methodNotAllowed("GET"),
      false,
    );
  }

  const loginMatch = /^\/api\/team\/([^/]+)\/login$/.exec(pathname);
  if (loginMatch) {
    return withPrivateResponseHeaders(
      request.method === "POST"
        ? await login(request, env, loginMatch[1])
        : methodNotAllowed("POST"),
      false,
    );
  }

  if (pathname === "/api/team/logout") {
    return withPrivateResponseHeaders(
      request.method === "POST" ? await logout(request, env) : methodNotAllowed("POST"),
      true,
    );
  }

  if (pathname === "/api/team/session") {
    return withPrivateResponseHeaders(
      request.method === "GET" ? await sessionBootstrap(request, env) : methodNotAllowed("GET"),
      true,
    );
  }

  if (pathname === "/api/team/event-summary") {
    return withPrivateResponseHeaders(
      request.method === "GET"
        ? await eventSummary(request, env)
        : methodNotAllowed("GET"),
      true,
    );
  }

  return null;
}

export async function handleTeamAdminRequest(
  request: Request,
  env: AdminEnv,
): Promise<Response | null> {
  const pathname = new URL(request.url).pathname;
  const changePinMatch = /^\/api\/admin\/events\/([^/]+)\/team-pin$/.exec(pathname);
  if (changePinMatch) {
    return request.method === "POST"
      ? changeTeamPin(request, env, changePinMatch[1])
      : methodNotAllowed("POST");
  }

  const revokeMatch = /^\/api\/admin\/events\/([^/]+)\/revoke-team-sessions$/.exec(pathname);
  if (revokeMatch) {
    return request.method === "POST"
      ? revokeAllTeamSessions(request, env, revokeMatch[1])
      : methodNotAllowed("POST");
  }

  return null;
}

async function login(request: Request, env: TeamEnv, eventPublicId: string): Promise<Response> {
  const body = await readBoundedJsonObject(request);
  if ("error" in body) {
    return jsonReadError(body.error);
  }
  const input = parseTeamLoginInput(body.value);
  if (!input) {
    return error("Invalid login", 400);
  }
  if (!EVENT_PUBLIC_ID_PATTERN.test(eventPublicId)) {
    return error("Invalid credentials", 401);
  }

  // The binding has no non-consuming peek/refund operation. Checking before
  // PBKDF2 makes the limit effective against brute force; successful logins
  // therefore count too. The event-scoped 30/minute limit preserves many
  // concurrent devices without relying on shared mobile-network IPs.
  const rateLimit = await env.TEAM_LOGIN_RATE_LIMITER.limit({
    key: `team-login:${eventPublicId}`,
  });
  if (!rateLimit.success) {
    return error("Too many login attempts", 429);
  }

  const event = await findTeamEventByPublicId(env.DB, eventPublicId);
  if (!event || !(await verifyPin(input.pin, event.teamPinSalt, event.teamPinHash))) {
    return error("Invalid credentials", 401);
  }

  const session = await createTeamSession(env, event, input.displayName, new Date());
  return new Response(null, { status: 204, headers: { "Set-Cookie": session.cookie } });
}

async function publicEvents(env: TeamEnv): Promise<Response> {
  return Response.json({ events: await listPublicTeamEvents(env.DB, formatBerlinDate(new Date())) });
}

async function logout(request: Request, env: TeamEnv): Promise<Response> {
  const session = await getTeamSession(request, env, new Date());
  if (!session) {
    return unauthorized();
  }
  await revokeCurrentTeamSession(env, session, new Date());
  return new Response(null, {
    status: 204,
    headers: { "Set-Cookie": clearTeamSessionCookie() },
  });
}

async function sessionBootstrap(request: Request, env: TeamEnv): Promise<Response> {
  const now = new Date();
  const session = await getTeamSession(request, env, now);
  if (!session) {
    return unauthorized();
  }
  return Response.json({ session: safeTeamSession(session) });
}

async function eventSummary(request: Request, env: TeamEnv): Promise<Response> {
  const session = await getTeamSession(request, env, new Date());
  if (!session) {
    return unauthorized();
  }
  return Response.json({
    summary: {
      redeemedCount: await countRedeemedVouchersForEvent(env.DB, session.eventId),
    },
  });
}

async function changeTeamPin(request: Request, env: AdminEnv, eventId: string): Promise<Response> {
  if (!(await getAdminSession(request, env, new Date()))) {
    return error("Unauthorized", 401);
  }
  const body = await readBoundedJsonObject(request);
  if ("error" in body) {
    return jsonReadError(body.error);
  }
  const pin = parseTeamPin(body.value);
  if (!pin) {
    return error("Invalid team PIN", 400);
  }

  const salt = generateOpaqueId(24);
  const changed = await rotateTeamPin(env.DB, eventId, salt, await derivePin(pin, salt));
  return changed ? new Response(null, { status: 204 }) : error("Event not found", 404);
}

async function revokeAllTeamSessions(
  request: Request,
  env: AdminEnv,
  eventId: string,
): Promise<Response> {
  if (!(await getAdminSession(request, env, new Date()))) {
    return error("Unauthorized", 401);
  }
  const changed = await revokeAllTeamSessionsByVersion(env.DB, eventId);
  return changed ? new Response(null, { status: 204 }) : error("Event not found", 404);
}

function unauthorized(): Response {
  return Response.json(
    { error: "Unauthorized" },
    { status: 401, headers: { "Set-Cookie": clearTeamSessionCookie() } },
  );
}

function error(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

function methodNotAllowed(allow: string): Response {
  return new Response(null, { status: 405, headers: { Allow: allow } });
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
