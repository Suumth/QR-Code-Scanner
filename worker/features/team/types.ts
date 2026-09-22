export type TeamEnv = Pick<Env, "DB" | "TEAM_LOGIN_RATE_LIMITER">;

export interface PublicTeamEvent {
  publicId: string;
  name: string;
  eventDate: string;
}

export interface TeamEventCredentials {
  id: string;
  publicId: string;
  name: string;
  eventDate: string;
  teamPinSalt: string;
  teamPinHash: string;
  teamSessionVersion: number;
}

export interface NewTeamSession {
  id: string;
  eventId: string;
  displayName: string;
  tokenHash: string;
  sessionVersion: number;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  revokedAt: null;
}

export interface ActiveTeamSession extends NewTeamSession {
  event: {
    id: string;
    publicId: string;
    name: string;
    eventDate: string;
  };
}

export interface SafeTeamSession {
  displayName: string;
  expiresAt: string;
  lastSeenAt: string;
  event: ActiveTeamSession["event"];
}
