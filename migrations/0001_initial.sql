CREATE TABLE events (
  id TEXT PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  event_date TEXT NOT NULL,
  team_pin_salt TEXT NOT NULL,
  team_pin_hash TEXT NOT NULL,
  team_session_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE sponsors (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  access_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE vouchers (
  id TEXT PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  sponsor_id TEXT NOT NULL REFERENCES sponsors(id) ON DELETE CASCADE,
  display_code TEXT NOT NULL UNIQUE,
  redeemed_at TEXT NULL,
  redeemed_by_session_id TEXT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE team_sessions (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  session_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT NULL
);

CREATE TABLE admin_sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT NULL
);

CREATE INDEX idx_events_event_date ON events(event_date);
CREATE INDEX idx_sponsors_event_id ON sponsors(event_id);
CREATE INDEX idx_vouchers_event_id ON vouchers(event_id);
CREATE INDEX idx_vouchers_sponsor_id ON vouchers(sponsor_id);
CREATE INDEX idx_vouchers_event_redeemed_at ON vouchers(event_id, redeemed_at);
CREATE INDEX idx_team_sessions_event_id ON team_sessions(event_id);
CREATE INDEX idx_team_sessions_event_active ON team_sessions(event_id, expires_at, revoked_at);
CREATE INDEX idx_admin_sessions_active ON admin_sessions(expires_at, revoked_at);
