export interface TeamSessionSnapshot {
  displayName: string;
  expiresAt: string;
  lastSeenAt: string;
  event: {
    id: string;
    publicId: string;
    name: string;
    eventDate: string;
  };
}

export type TeamLoginFailure = "credentials" | "invalid" | "limited" | "network";

export class TeamLoginError extends Error {
  constructor(readonly failure: Exclude<TeamLoginFailure, "network">) {
    super(failure);
    this.name = "TeamLoginError";
  }
}
