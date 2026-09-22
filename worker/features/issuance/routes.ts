import { getAdminSession } from "../admin/auth";
import { findEvent } from "../admin/repository";
import type { AdminEnv } from "../admin/types";
import { createSponsor, createVoucherBatch } from "./factory";
import { findSponsor, insertSponsor, insertVoucherBatch, isIssuanceUniqueConstraint } from "./repository";
import { parseSponsorName, parseVoucherCount } from "./validation";
import { readBoundedJsonObject } from "../../http/json";
import { findVoucherTypeForScope } from "../voucher-types/repository";

const MAX_UNIQUE_CONSTRAINT_RETRIES = 3;

export async function handleIssuanceRequest(request: Request, env: AdminEnv): Promise<Response | null> {
  const url = new URL(request.url);
  const sponsorMatch = /^\/api\/admin\/events\/([^/]+)\/sponsors$/.exec(url.pathname);
  if (sponsorMatch) {
    return request.method === "POST"
      ? createSponsorRoute(request, env, sponsorMatch[1])
      : methodNotAllowed();
  }

  const voucherMatch = /^\/api\/admin\/events\/([^/]+)\/sponsors\/([^/]+)\/voucher-types\/([^/]+)\/vouchers$/.exec(url.pathname);
  if (voucherMatch) {
    return request.method === "POST"
      ? createVouchersRoute(request, env, voucherMatch[1], voucherMatch[2], voucherMatch[3])
      : methodNotAllowed();
  }

  return null;
}

async function createSponsorRoute(request: Request, env: AdminEnv, eventId: string): Promise<Response> {
  if (!(await getAdminSession(request, env, new Date()))) {
    return error("Unauthorized", 401);
  }

  const body = await readBoundedJsonObject(request);
  if ("error" in body) {
    return jsonReadError(body.error);
  }
  const name = parseSponsorName(body.value);
  if (!name) {
    return error("Invalid sponsor", 400);
  }
  if (!(await findEvent(env.DB, eventId))) {
    return error("Event not found", 404);
  }

  const createdAt = new Date().toISOString();
  for (let attempt = 0; attempt < MAX_UNIQUE_CONSTRAINT_RETRIES; attempt += 1) {
    const sponsor = createSponsor(eventId, name, createdAt);
    try {
      await insertSponsor(env.DB, sponsor);
      return Response.json({ sponsor, sponsorUrl: sponsorUrl(request, sponsor.accessId) }, { status: 201 });
    } catch (caught) {
      if (!isIssuanceUniqueConstraint(caught)) {
        throw caught;
      }
    }
  }

  return error("Sponsor identifier conflict", 409);
}

async function createVouchersRoute(
  request: Request,
  env: AdminEnv,
  eventId: string,
  sponsorId: string,
  voucherTypeId: string,
): Promise<Response> {
  if (!(await getAdminSession(request, env, new Date()))) {
    return error("Unauthorized", 401);
  }

  const body = await readBoundedJsonObject(request);
  if ("error" in body) {
    return jsonReadError(body.error);
  }
  const count = parseVoucherCount(body.value);
  if (count === null) {
    return error("Invalid voucher count", 400);
  }

  const sponsor = await findSponsor(env.DB, sponsorId);
  if (!sponsor || sponsor.eventId !== eventId) {
    return error("Sponsor not found", 404);
  }
  const voucherType = await findVoucherTypeForScope(env.DB, eventId, sponsorId, voucherTypeId);
  if (!voucherType) {
    return error("Voucher type not found", 404);
  }

  for (let attempt = 0; attempt < MAX_UNIQUE_CONSTRAINT_RETRIES; attempt += 1) {
    try {
      const totals = await insertVoucherBatch(
        env.DB,
        createVoucherBatch(sponsor.eventId, sponsor.id, voucherType.id, count, new Date().toISOString()),
      );
      return Response.json(
        {
          issuedCount: count,
          totalSponsorCount: totals.totalSponsorCount,
          totalVoucherTypeCount: totals.totalVoucherTypeCount,
          voucherType,
          sponsor,
          sponsorUrl: sponsorUrl(request, sponsor.accessId),
        },
        { status: 201 },
      );
    } catch (caught) {
      if (!isIssuanceUniqueConstraint(caught)) {
        throw caught;
      }
    }
  }

  return error("Voucher identifier conflict", 409);
}

function sponsorUrl(request: Request, accessId: string): string {
  return new URL(`/s/${accessId}`, request.url).toString();
}

function error(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

function methodNotAllowed(): Response {
  return new Response(null, { status: 405, headers: { Allow: "POST" } });
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
