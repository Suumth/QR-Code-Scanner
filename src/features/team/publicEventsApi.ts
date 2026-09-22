export interface PublicTeamEvent {
  publicId: string;
  name: string;
  eventDate: string;
}

const EVENT_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export async function loadPublicTeamEvents(signal: AbortSignal): Promise<PublicTeamEvent[]> {
  const response = await fetch("/api/team/events", {
    cache: "no-store",
    credentials: "same-origin",
    headers: { Accept: "application/json" },
    signal,
  });
  if (!response.ok) {
    throw new Error(`Public event request failed with status ${response.status}`);
  }

  const payload: unknown = await response.json();
  if (!isRecord(payload) || !Array.isArray(payload.events)) {
    throw new Error("Invalid public event response");
  }

  return payload.events.map(parsePublicTeamEvent);
}

function parsePublicTeamEvent(value: unknown): PublicTeamEvent {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.publicId) ||
    !isNonEmptyString(value.name) ||
    typeof value.eventDate !== "string" ||
    !EVENT_DATE_PATTERN.test(value.eventDate)
  ) {
    throw new Error("Invalid public event response");
  }

  return {
    publicId: value.publicId,
    name: value.name,
    eventDate: value.eventDate,
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
