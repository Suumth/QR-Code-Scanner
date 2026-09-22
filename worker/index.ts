import { handleAdminRequest } from "./features/admin/routes";
import { handleSponsorRequest } from "./features/sponsors/routes";
import { handleTeamRequest } from "./features/team/routes";

type WorkerEnv = Env & { ADMIN_PASSWORD?: string };

export default {
  async fetch(request: Request, env: WorkerEnv) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return Response.json({ ok: true });
    }

    const teamResponse = await handleTeamRequest(request, env);
    if (teamResponse) {
      return teamResponse;
    }

    const sponsorResponse = await handleSponsorRequest(request, env);
    if (sponsorResponse) {
      return sponsorResponse;
    }

    const adminResponse = await handleAdminRequest(request, env);
    if (adminResponse) {
      return adminResponse;
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
