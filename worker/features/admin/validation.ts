import { isValidTeamPin } from "../../security/crypto";

const MAX_EVENT_NAME_LENGTH = 120;

export interface CreateEventInput {
  name: string;
  eventDate: string;
  teamPin: string;
}

export function parseCreateEventInput(value: unknown): CreateEventInput | null {
  if (!isRecord(value)) {
    return null;
  }

  const name = typeof value.name === "string" ? value.name.trim() : "";
  const eventDate = typeof value.eventDate === "string" ? value.eventDate : "";
  const teamPin = typeof value.teamPin === "string" ? value.teamPin : "";

  if (!name || name.length > MAX_EVENT_NAME_LENGTH || !isCanonicalDate(eventDate) || !isValidTeamPin(teamPin)) {
    return null;
  }

  return { name, eventDate, teamPin };
}

function isCanonicalDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return false;
  }

  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));

  return (
    date.getUTCFullYear() === Number(year) &&
    date.getUTCMonth() === Number(month) - 1 &&
    date.getUTCDate() === Number(day)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
