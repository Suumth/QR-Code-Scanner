import { TeamLoginError, type TeamSessionSnapshot } from "./types";

export async function loadTeamSession(signal: AbortSignal): Promise<TeamSessionSnapshot | null> {
  const response = await fetch("/api/team/session", {
    cache: "no-store",
    credentials: "same-origin",
    headers: { Accept: "application/json" },
    signal,
  });
  if (response.status === 401) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Session request failed with status ${response.status}`);
  }

  const payload: unknown = await response.json();
  if (!isRecord(payload) || !isTeamSession(payload.session)) {
    throw new Error("Invalid team session response");
  }
  return payload.session;
}

export async function loginTeam(
  eventPublicId: string,
  input: { displayName: string; pin: string },
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch(`/api/team/${encodeURIComponent(eventPublicId)}/login`, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
    signal,
  });
  if (response.status === 204) {
    return;
  }
  if (response.status === 401) {
    throw new TeamLoginError("credentials");
  }
  if (response.status === 400) {
    throw new TeamLoginError("invalid");
  }
  if (response.status === 429) {
    throw new TeamLoginError("limited");
  }
  throw new Error(`Login request failed with status ${response.status}`);
}

export async function logoutTeam(signal: AbortSignal): Promise<void> {
  const response = await fetch("/api/team/logout", {
    method: "POST",
    credentials: "same-origin",
    headers: { Accept: "application/json" },
    signal,
  });
  if (response.status !== 204 && response.status !== 401) {
    throw new Error(`Logout request failed with status ${response.status}`);
  }
}

function isTeamSession(value: unknown): value is TeamSessionSnapshot {
  return (
    isRecord(value) &&
    typeof value.displayName === "string" &&
    typeof value.expiresAt === "string" &&
    typeof value.lastSeenAt === "string" &&
    isRecord(value.event) &&
    typeof value.event.id === "string" &&
    typeof value.event.publicId === "string" &&
    typeof value.event.name === "string" &&
    typeof value.event.eventDate === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
