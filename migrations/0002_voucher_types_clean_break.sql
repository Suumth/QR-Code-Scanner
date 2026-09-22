DELETE FROM admin_sessions;
DELETE FROM team_sessions;
DELETE FROM vouchers;
DELETE FROM sponsors;
DELETE FROM events;

CREATE TABLE voucher_types (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  sponsor_id TEXT NOT NULL REFERENCES sponsors(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

ALTER TABLE vouchers RENAME TO vouchers_legacy_empty;

CREATE TABLE vouchers (
  id TEXT PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  sponsor_id TEXT NOT NULL REFERENCES sponsors(id) ON DELETE CASCADE,
  voucher_type_id TEXT NOT NULL REFERENCES voucher_types(id),
  display_code TEXT NOT NULL UNIQUE,
  redeemed_at TEXT NULL,
  redeemed_by_session_id TEXT NULL,
  created_at TEXT NOT NULL
);

DROP TABLE vouchers_legacy_empty;

CREATE INDEX idx_voucher_types_event_id ON voucher_types(event_id);
CREATE INDEX idx_voucher_types_sponsor_id ON voucher_types(sponsor_id);
CREATE UNIQUE INDEX idx_voucher_types_sponsor_name_nocase
  ON voucher_types(sponsor_id, name COLLATE NOCASE);
CREATE INDEX idx_vouchers_event_id ON vouchers(event_id);
CREATE INDEX idx_vouchers_sponsor_id ON vouchers(sponsor_id);
CREATE INDEX idx_vouchers_voucher_type_id ON vouchers(voucher_type_id);
CREATE INDEX idx_vouchers_event_redeemed_at ON vouchers(event_id, redeemed_at);
