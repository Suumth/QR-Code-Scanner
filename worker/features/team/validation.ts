import { isValidTeamPin } from "../../security/crypto";

const MAX_TEAM_DISPLAY_NAME_LENGTH = 80;

export interface TeamLoginInput {
  displayName: string;
  pin: string;
}

export function parseTeamLoginInput(value: unknown): TeamLoginInput | null {
  if (!isRecord(value)) {
    return null;
  }

  const displayName = typeof value.displayName === "string" ? value.displayName.trim() : "";
  const pin = typeof value.pin === "string" ? value.pin : "";
  if (
    !displayName ||
    displayName.length > MAX_TEAM_DISPLAY_NAME_LENGTH ||
    hasUnsafeDisplayNameCharacter(displayName) ||
    !isValidTeamPin(pin)
  ) {
    return null;
  }

  return { displayName, pin };
}

export function parseTeamPin(value: unknown): string | null {
  if (!isRecord(value) || typeof value.teamPin !== "string" || !isValidTeamPin(value.teamPin)) {
    return null;
  }
  return value.teamPin;
}

function hasUnsafeDisplayNameCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
