import { withPrivateResponseHeaders } from "../../http/admin-response";
import { readBoundedJsonObject } from "../../http/json";
import { clearTeamSessionCookie, getTeamSession } from "../team/auth";
import type { TeamEnv } from "../team/types";
import { inspectVoucher } from "./inspect-repository";
import { redeemVoucher } from "./redeem-repository";
import { parseVoucherLocator } from "./validation";

export async function handleTeamVoucherRequest(
  request: Request,
  env: TeamEnv,
): Promise<Response | null> {
  const pathname = new URL(request.url).pathname;
  let action: "inspect" | "redeem";
  if (pathname === "/api/team/vouchers/inspect") {
    action = "inspect";
  } else if (pathname === "/api/team/vouchers/redeem") {
    action = "redeem";
  } else {
    return null;
  }

  let response: Response;
  if (request.method !== "POST") {
    response = methodNotAllowed();
  } else {
    try {
      response = await voucherAction(request, env, action);
    } catch {
      response = error("Voucher request failed", 500);
    }
  }
  return withPrivateResponseHeaders(response, true);
}

async function voucherAction(
  request: Request,
  env: TeamEnv,
  action: "inspect" | "redeem",
): Promise<Response> {
  const session = await getTeamSession(request, env, new Date());
  if (!session) {
    return unauthorized();
  }

  const body = await readBoundedJsonObject(request);
  if ("error" in body) {
    return jsonReadError(body.error);
  }
  const locator = parseVoucherLocator(body.value);
  if (!locator) {
    return error("Invalid voucher locator", 400);
  }

  const result =
    action === "inspect"
      ? await inspectVoucher(env.DB, session.eventId, locator)
      : await redeemVoucher(
          env.DB,
          session.eventId,
          session.id,
          locator,
          new Date().toISOString(),
        );
  return Response.json(result);
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

function methodNotAllowed(): Response {
  return new Response(null, { status: 405, headers: { Allow: "POST" } });
}

function jsonReadError(
  errorCode: "malformed" | "too_large" | "unsupported_media_type",
): Response {
  switch (errorCode) {
    case "unsupported_media_type":
      return error("Unsupported media type", 415);
    case "too_large":
      return error("Payload too large", 413);
    case "malformed":
      return error("Malformed JSON", 400);
  }
}
