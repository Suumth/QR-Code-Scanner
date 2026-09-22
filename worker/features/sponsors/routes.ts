import { findPublicVoucherSnapshot, findSponsorSnapshot } from "./repository";
import { isSponsorAccessId, isVoucherPublicId } from "./validation";

interface SponsorEnv {
  DB: D1Database;
}

export async function handleSponsorRequest(
  request: Request,
  env: SponsorEnv,
): Promise<Response | null> {
  const pathname = new URL(request.url).pathname;
  const sponsorMatch = /^\/api\/sponsor\/([^/]+)$/.exec(pathname);
  if (sponsorMatch) {
    return noStore(
      request.method === "GET"
        ? await sponsorDetail(env.DB, sponsorMatch[1])
        : methodNotAllowed(),
    );
  }

  const voucherMatch = /^\/api\/voucher\/([^/]+)$/.exec(pathname);
  if (voucherMatch) {
    return noStore(
      request.method === "GET"
        ? await voucherDetail(env.DB, voucherMatch[1])
        : methodNotAllowed(),
    );
  }

  return null;
}

async function sponsorDetail(database: D1Database, accessId: string): Promise<Response> {
  if (!isSponsorAccessId(accessId)) {
    return error("Sponsor not found");
  }

  const snapshot = await findSponsorSnapshot(database, accessId);
  return snapshot ? Response.json(snapshot) : error("Sponsor not found");
}

async function voucherDetail(database: D1Database, publicId: string): Promise<Response> {
  if (!isVoucherPublicId(publicId)) {
    return error("Voucher not found");
  }

  const snapshot = await findPublicVoucherSnapshot(database, publicId);
  return snapshot ? Response.json(snapshot) : error("Voucher not found");
}

function error(message: string): Response {
  return Response.json({ error: message }, { status: 404 });
}

function methodNotAllowed(): Response {
  return new Response(null, { status: 405, headers: { Allow: "GET" } });
}

function noStore(response: Response): Response {
  response.headers.set("Cache-Control", "no-store");
  return response;
}
