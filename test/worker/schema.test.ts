import { applyD1Migrations, env } from "cloudflare:test";
import { expect, test } from "vitest";

declare const __RT22_D1_MIGRATIONS__: {
  name: string;
  queries: string[];
}[];

test("applies the voucher schema with its relational and event-day indexes", async () => {
  await applyD1Migrations(env.DB, __RT22_D1_MIGRATIONS__.slice(0, 1), "task_2_migrations");
  await seedLegacyApplicationRows();
  await applyD1Migrations(env.DB, __RT22_D1_MIGRATIONS__, "task_2_migrations");

  const tables = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
  ).all<{ name: string }>();
  const d1InfrastructureTables = new Set(["_cf_METADATA", "sqlite_sequence", "task_2_migrations"]);
  const tableNames = tables.results
    .map(({ name }) => name)
    .filter((name) => !d1InfrastructureTables.has(name));

  expect(tableNames).toEqual([
    "admin_sessions",
    "events",
    "sponsors",
    "team_sessions",
    "voucher_types",
    "vouchers",
  ]);

  await expectColumns("events", [
    "id",
    "public_id",
    "name",
    "event_date",
    "team_pin_salt",
    "team_pin_hash",
    "team_session_version",
    "created_at",
  ]);
  await expectColumns("sponsors", ["id", "event_id", "name", "access_id", "created_at"]);
  await expectColumns("voucher_types", ["id", "event_id", "sponsor_id", "name", "created_at"]);
  await expectColumns("vouchers", [
    "id",
    "public_id",
    "event_id",
    "sponsor_id",
    "voucher_type_id",
    "display_code",
    "redeemed_at",
    "redeemed_by_session_id",
    "created_at",
  ]);
  await expectColumns("team_sessions", [
    "id",
    "event_id",
    "display_name",
    "token_hash",
    "session_version",
    "created_at",
    "last_seen_at",
    "expires_at",
    "revoked_at",
  ]);
  await expectColumns("admin_sessions", [
    "id",
    "token_hash",
    "created_at",
    "expires_at",
    "revoked_at",
  ]);
  await expectRequiredColumns("events", [
    "public_id",
    "name",
    "event_date",
    "team_pin_salt",
    "team_pin_hash",
    "team_session_version",
    "created_at",
  ]);
  await expectRequiredColumns("sponsors", ["event_id", "name", "access_id", "created_at"]);
  await expectRequiredColumns("voucher_types", ["event_id", "sponsor_id", "name", "created_at"]);
  await expectRequiredColumns("vouchers", [
    "public_id",
    "event_id",
    "sponsor_id",
    "voucher_type_id",
    "display_code",
    "created_at",
  ]);
  await expectRequiredColumns("team_sessions", [
    "event_id",
    "display_name",
    "token_hash",
    "session_version",
    "created_at",
    "last_seen_at",
    "expires_at",
  ]);
  await expectRequiredColumns("admin_sessions", ["token_hash", "created_at", "expires_at"]);
  await expectColumnDefault("events", "team_session_version", "1");

  const voucherColumns = await env.DB.prepare("PRAGMA table_info(vouchers)").all<{
    name: string;
    notnull: number;
  }>();
  expect(voucherColumns.results.find(({ name }) => name === "redeemed_at")?.notnull).toBe(0);
  expect(voucherColumns.results.find(({ name }) => name === "redeemed_by_session_id")?.notnull).toBe(
    0,
  );
  expect(voucherColumns.results.map(({ name }) => name)).not.toContain("token");

  await expectForeignKeys("sponsors", ["event_id"]);
  await expectForeignKeys("voucher_types", ["event_id", "sponsor_id"]);
  await expectForeignKeys("vouchers", ["event_id", "sponsor_id"]);
  await expectForeignKeyTarget("vouchers", "voucher_type_id", "voucher_types");
  await expectForeignKeys("team_sessions", ["event_id"]);
  await expectIndex("voucher_types", ["event_id"]);
  await expectIndex("voucher_types", ["sponsor_id"]);
  await expectIndex("voucher_types", ["sponsor_id", "name"]);
  await expectIndex("events", ["event_date"]);
  await expectIndex("sponsors", ["event_id"]);
  await expectIndex("vouchers", ["event_id"]);
  await expectIndex("vouchers", ["sponsor_id"]);
  await expectIndex("vouchers", ["voucher_type_id"]);
  await expectIndex("vouchers", ["event_id", "redeemed_at"]);
  await expectIndex("team_sessions", ["event_id"]);
  await expectIndex("team_sessions", ["event_id", "expires_at", "revoked_at"]);
  await expectIndex("admin_sessions", ["expires_at", "revoked_at"]);

  const applicationRows = await env.DB.prepare(
    `SELECT
      (SELECT COUNT(*) FROM events) AS events,
      (SELECT COUNT(*) FROM sponsors) AS sponsors,
      (SELECT COUNT(*) FROM voucher_types) AS voucher_types,
      (SELECT COUNT(*) FROM vouchers) AS vouchers,
      (SELECT COUNT(*) FROM team_sessions) AS team_sessions,
      (SELECT COUNT(*) FROM admin_sessions) AS admin_sessions`,
  ).first<Record<string, number>>();
  expect(applicationRows).toEqual({
    events: 0,
    sponsors: 0,
    voucher_types: 0,
    vouchers: 0,
    team_sessions: 0,
    admin_sessions: 0,
  });

  const appliedMigrations = await env.DB.prepare(
    'SELECT name FROM task_2_migrations ORDER BY name',
  ).all<{ name: string }>();
  expect(appliedMigrations.results.map(({ name }) => name)).toEqual([
    "0001_initial.sql",
    "0002_voucher_types_clean_break.sql",
  ]);

  await assertUniquenessAndCascadeBehavior();
});

async function seedLegacyApplicationRows(): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO events (
      id, public_id, name, event_date, team_pin_salt, team_pin_hash, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind("legacy-event", "legacy-event-public", "Legacy", "2026-08-20", "salt", "hash", "now")
    .run();
  await env.DB.prepare(
    "INSERT INTO sponsors (id, event_id, name, access_id, created_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind("legacy-sponsor", "legacy-event", "Legacy Sponsor", "legacy-access", "now")
    .run();
  await env.DB.prepare(
    `INSERT INTO vouchers (
      id, public_id, event_id, sponsor_id, display_code, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind("legacy-voucher", "legacy-voucher-public", "legacy-event", "legacy-sponsor", "ABCD-EFGH", "now")
    .run();
  await env.DB.prepare(
    `INSERT INTO team_sessions (
      id, event_id, display_name, token_hash, session_version, created_at, last_seen_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind("legacy-team-session", "legacy-event", "Legacy Team", "legacy-team-token-hash", 1, "now", "now", "later")
    .run();
  await env.DB.prepare(
    "INSERT INTO admin_sessions (id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?)",
  )
    .bind("legacy-admin-session", "legacy-admin-token-hash", "now", "later")
    .run();
}

async function expectColumns(table: string, expectedColumns: string[]): Promise<void> {
  const columns = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();

  expect(columns.results.map(({ name }) => name)).toEqual(expectedColumns);
}

async function expectRequiredColumns(table: string, requiredColumns: string[]): Promise<void> {
  const columns = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{
    name: string;
    notnull: number;
  }>();

  for (const column of requiredColumns) {
    expect(columns.results.find(({ name }) => name === column)?.notnull).toBe(1);
  }
}

async function expectColumnDefault(table: string, column: string, expectedDefault: string): Promise<void> {
  const columns = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{
    name: string;
    dflt_value: string | null;
  }>();

  expect(columns.results.find(({ name }) => name === column)?.dflt_value).toBe(expectedDefault);
}

async function expectForeignKeys(table: string, expectedColumns: string[]): Promise<void> {
  const foreignKeys = await env.DB.prepare(`PRAGMA foreign_key_list(${table})`).all<{
    from: string;
    on_delete: string;
  }>();

  expect(foreignKeys.results).toEqual(
    expect.arrayContaining(
      expectedColumns.map((from) => expect.objectContaining({ from, on_delete: "CASCADE" })),
    ),
  );
}

async function expectForeignKeyTarget(table: string, column: string, target: string): Promise<void> {
  const foreignKeys = await env.DB.prepare(`PRAGMA foreign_key_list(${table})`).all<{
    from: string;
    table: string;
  }>();

  expect(foreignKeys.results).toEqual(
    expect.arrayContaining([expect.objectContaining({ from: column, table: target })]),
  );
}

async function expectIndex(table: string, expectedColumns: string[]): Promise<void> {
  const indexes = await env.DB.prepare(`PRAGMA index_list(${table})`).all<{ name: string }>();

  for (const { name } of indexes.results) {
    const columns = await env.DB.prepare(`PRAGMA index_info(${name})`).all<{
      name: string;
      seqno: number;
    }>();
    const columnNames = columns.results
      .sort((left, right) => left.seqno - right.seqno)
      .map(({ name: columnName }) => columnName);

    if (columnNames.join(",") === expectedColumns.join(",")) {
      return;
    }
  }

  throw new Error(`Missing ${table} index on (${expectedColumns.join(", ")})`);
}

async function assertUniquenessAndCascadeBehavior(): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO events (
      id, public_id, name, event_date, team_pin_salt, team_pin_hash, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind("event-1", "event-public-id", "RT22 Sommerfest", "2026-08-20", "salt", "hash", "now")
    .run();
  await expect(
    env.DB.prepare(
      `INSERT INTO events (
        id, public_id, name, event_date, team_pin_salt, team_pin_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind("event-2", "event-public-id", "Duplicate", "2026-08-21", "salt", "hash", "now")
      .run(),
  ).rejects.toThrow();

  await env.DB.prepare(
    "INSERT INTO sponsors (id, event_id, name, access_id, created_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind("sponsor-1", "event-1", "Sponsor A", "sponsor-access-id", "now")
    .run();
  await expect(
    env.DB.prepare(
      "INSERT INTO sponsors (id, event_id, name, access_id, created_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind("sponsor-2", "event-1", "Sponsor B", "sponsor-access-id", "now")
      .run(),
  ).rejects.toThrow();

  await env.DB.prepare(
    "INSERT INTO voucher_types (id, event_id, sponsor_id, name, created_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind("voucher-type-1", "event-1", "sponsor-1", "1 Bier", "now")
    .run();

  await env.DB.prepare(
    `INSERT INTO vouchers (
      id, public_id, event_id, sponsor_id, voucher_type_id, display_code, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind("voucher-1", "voucher-public-id", "event-1", "sponsor-1", "voucher-type-1", "ABCD-EFGH", "now")
    .run();
  await expect(
    env.DB.prepare(
      `INSERT INTO vouchers (
        id, public_id, event_id, sponsor_id, voucher_type_id, display_code, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind("voucher-2", "voucher-public-id", "event-1", "sponsor-1", "voucher-type-1", "JKLM-NPQR", "now")
      .run(),
  ).rejects.toThrow();
  await expect(
    env.DB.prepare(
      `INSERT INTO vouchers (
        id, public_id, event_id, sponsor_id, voucher_type_id, display_code, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind("voucher-2", "voucher-public-id-2", "event-1", "sponsor-1", "voucher-type-1", "ABCD-EFGH", "now")
      .run(),
  ).rejects.toThrow();

  const sponsorVoucherBeforeDeletion = await env.DB.prepare("SELECT id FROM vouchers WHERE id = ?")
    .bind("voucher-1")
    .first<{ id: string }>();

  expect(sponsorVoucherBeforeDeletion).toEqual({ id: "voucher-1" });
  await env.DB.prepare("DELETE FROM sponsors WHERE id = ?").bind("sponsor-1").run();
  const sponsorVoucherAfterDeletion = await env.DB.prepare("SELECT id FROM vouchers WHERE id = ?")
    .bind("voucher-1")
    .first<{ id: string }>();

  expect(sponsorVoucherAfterDeletion).toBeNull();

  await env.DB.prepare(
    "INSERT INTO sponsors (id, event_id, name, access_id, created_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind("sponsor-1", "event-1", "Sponsor A", "sponsor-access-id", "now")
    .run();
  await env.DB.prepare(
    "INSERT INTO voucher_types (id, event_id, sponsor_id, name, created_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind("voucher-type-1", "event-1", "sponsor-1", "1 Bier", "now")
    .run();
  await env.DB.prepare(
    `INSERT INTO vouchers (
      id, public_id, event_id, sponsor_id, voucher_type_id, display_code, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind("voucher-1", "voucher-public-id", "event-1", "sponsor-1", "voucher-type-1", "ABCD-EFGH", "now")
    .run();

  await env.DB.prepare(
    `INSERT INTO team_sessions (
      id, event_id, display_name, token_hash, session_version, created_at, last_seen_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind("team-session-1", "event-1", "Alex", "team-token-hash", 1, "now", "now", "later")
    .run();
  await expect(
    env.DB.prepare(
      `INSERT INTO team_sessions (
        id, event_id, display_name, token_hash, session_version, created_at, last_seen_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind("team-session-2", "event-1", "Sam", "team-token-hash", 1, "now", "now", "later")
      .run(),
  ).rejects.toThrow();

  await env.DB.prepare(
    "INSERT INTO admin_sessions (id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?)",
  )
    .bind("admin-session-1", "admin-token-hash", "now", "later")
    .run();
  await expect(
    env.DB.prepare(
      "INSERT INTO admin_sessions (id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?)",
    )
      .bind("admin-session-2", "admin-token-hash", "now", "later")
      .run(),
  ).rejects.toThrow();

  await env.DB.prepare("DELETE FROM events WHERE id = ?").bind("event-1").run();
  const dependents = await env.DB.prepare(
    `SELECT
      (SELECT COUNT(*) FROM sponsors) AS sponsors,
      (SELECT COUNT(*) FROM vouchers) AS vouchers,
      (SELECT COUNT(*) FROM team_sessions) AS team_sessions`,
  ).first<{ sponsors: number; vouchers: number; team_sessions: number }>();

  expect(dependents).toEqual({ sponsors: 0, vouchers: 0, team_sessions: 0 });
}
