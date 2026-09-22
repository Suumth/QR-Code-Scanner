export interface AdminEnv {
  DB: D1Database;
  ADMIN_PASSWORD?: string;
  ADMIN_LOGIN_RATE_LIMITER: {
    limit(options: { key: string }): Promise<{ success: boolean }>;
  };
}

export interface AdminSession {
  id: string;
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

export interface SafeEvent {
  id: string;
  publicId: string;
  name: string;
  eventDate: string;
  createdAt: string;
}
