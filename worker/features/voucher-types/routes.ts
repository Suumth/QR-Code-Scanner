import { readBoundedJsonObject } from "../../http/json";
import { generateOpaqueId } from "../../security/crypto";
import { getAdminSession } from "../admin/auth";
import { findEvent } from "../admin/repository";
import type { AdminEnv } from "../admin/types";
import { findSponsor } from "../issuance/repository";
import {
  insertVoucherType,
  isVoucherTypeUniqueConstraint,
} from "./repository";
import type { VoucherType } from "./types";
import { parseVoucherTypeName } from "./validation";

export async function handleVoucherTypeRequest(request: Request, env: AdminEnv): Promise<Response | null> {
  const match = /^\/api\/admin\/events\/([^/]+)\/sponsors\/([^/]+)\/voucher-types$/.exec(
    new URL(request.url).pathname,
  );
  if (!match) {
    return null;
  }

  return request.method === "POST"
    ? createVoucherTypeRoute(request, env, match[1], match[2])
    : methodNotAllowed();
}

async function createVoucherTypeRoute(
  request: Request,
  env: AdminEnv,
  eventId: string,
  sponsorId: string,
): Promise<Response> {
  if (!(await getAdminSession(request, env, new Date()))) {
    return error("Unauthorized", 401);
  }

  const body = await readBoundedJsonObject(request);
  if ("error" in body) {
    return jsonReadError(body.error);
  }
  const name = parseVoucherTypeName(body.value);
  if (!name) {
    return error("Invalid voucher type name", 400);
  }

  if (!(await findEvent(env.DB, eventId))) {
    return error("Event not found", 404);
  }
  const sponsor = await findSponsor(env.DB, sponsorId);
  if (!sponsor || sponsor.eventId !== eventId) {
    return error("Sponsor not found", 404);
  }

  const voucherType: VoucherType = {
    id: generateOpaqueId(16),
    eventId,
    sponsorId,
    name,
    createdAt: new Date().toISOString(),
  };
  try {
    await insertVoucherType(env.DB, voucherType);
  } catch (caught) {
    if (isVoucherTypeUniqueConstraint(caught)) {
      return error("Voucher type already exists", 409);
    }
    throw caught;
  }

  return Response.json({ voucherType }, { status: 201 });
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
