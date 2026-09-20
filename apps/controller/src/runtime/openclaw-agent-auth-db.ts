import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

/**
 * SQLite-backed auth profile persistence matching the OpenClaw runtime
 * contract (OpenClaw >= 2026.6.5).
 *
 * OpenClaw stores per-agent auth profiles in `<agentDir>/openclaw-agent.sqlite`,
 * table `auth_profile_store`, single row keyed `'primary'`, with the entire
 * secrets store JSON in `store_json`. The runtime reads ONLY from SQLite; the
 * legacy `auth-profiles.json` file is no longer read at runtime. See
 * `specs/design-docs/2026-04-14-openclaw-registry-cache-invalidation.md` for the
 * companion restart-on-change rule.
 *
 * Database creation: the controller must NOT create this file. It used to, to
 * pre-seed credentials before OpenClaw booted, and OpenClaw adopted the partial
 * database because its schema guard tolerated a missing `schema_meta` row and a
 * zero `user_version`. OpenClaw 2026.9 removed that tolerance: a database
 * without schema ownership metadata (`schema_meta` with role `agent` and
 * version 19) now fails the runtime guard, so the gateway refuses to start
 * ("uses schema version 0 ... run openclaw doctor --fix"), and doctor in turn
 * refuses to migrate it ("has no schema ownership metadata"). A pre-created
 * database is therefore a dead end that no repair path can recover.
 *
 * Writing only into a database OpenClaw already owns costs the pre-boot seed:
 * credentials land on the first write after the runtime has created the file,
 * which the provider/OAuth mutation path already performs (syncAll + restart).
 * The contract (table/column names + `store_json` shape) is pinned by
 * `openclaw-agent-auth-db.test.ts` so an upstream format change is caught.
 */

const PRIMARY_ROW_KEY = "primary";

/** Matches OpenClaw's per-agent SQLite busy timeout (writes use BEGIN IMMEDIATE). */
const SQLITE_BUSY_TIMEOUT_MS = 5000;

/**
 * OpenClaw's exact `auth_profile_store` DDL. Replicated so a controller-created
 * database is byte-compatible with what OpenClaw's `ensureAgentSchema` expects
 * (its `CREATE TABLE IF NOT EXISTS` then becomes a no-op for this table).
 */
const AUTH_PROFILE_STORE_DDL = `CREATE TABLE IF NOT EXISTS auth_profile_store (
  store_key TEXT NOT NULL PRIMARY KEY,
  store_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);`;

export interface AgentAuthStoreCell {
  version: number;
  profiles: Record<string, unknown>;
}

function parseStoreJson(
  raw: string | null | undefined,
): AgentAuthStoreCell | null {
  if (!raw) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  return {
    version: typeof record.version === "number" ? record.version : 1,
    profiles:
      typeof record.profiles === "object" &&
      record.profiles !== null &&
      !Array.isArray(record.profiles)
        ? (record.profiles as Record<string, unknown>)
        : {},
  };
}

/**
 * Read the `auth_profile_store` primary row from an agent database.
 * Returns null when the database does not exist or holds no store row.
 */
export function readAgentAuthStore(
  databasePath: string,
): AgentAuthStoreCell | null {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(databasePath, { readOnly: true });
  } catch {
    // Database file does not exist (read-only open cannot create it).
    return null;
  }
  try {
    const row = db
      .prepare("SELECT store_json FROM auth_profile_store WHERE store_key = ?")
      .get(PRIMARY_ROW_KEY) as { store_json?: string } | undefined;
    return parseStoreJson(row?.store_json);
  } catch {
    // Missing table (database created by OpenClaw but auth schema not yet
    // materialized) is treated as "no store" rather than a hard failure.
    return null;
  } finally {
    db.close();
  }
}

/**
 * Upsert the `auth_profile_store` primary row in an agent database, creating the
 * database and table if absent so credentials can be seeded before OpenClaw
 * boots. Leaves OpenClaw's `auth_profile_state` and other tables untouched.
 *
 * Callers MUST restart the OpenClaw runtime after a write to a database it is
 * already using: the runtime caches the auth store in memory and does not watch
 * the SQLite file.
 */
export function writeAgentAuthStore(
  databasePath: string,
  cell: AgentAuthStoreCell,
): boolean {
  // Never bring this database into existence — see the note above. An absent
  // file means OpenClaw has not created the agent yet; the caller retries on a
  // later write rather than poisoning the agent permanently.
  if (!existsSync(databasePath)) {
    return false;
  }

  const db = new DatabaseSync(databasePath);
  try {
    db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};`);
    db.exec(AUTH_PROFILE_STORE_DDL);
    db.exec("BEGIN IMMEDIATE;");
    try {
      db.prepare(
        `INSERT INTO auth_profile_store (store_key, store_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(store_key) DO UPDATE SET
           store_json = excluded.store_json,
           updated_at = excluded.updated_at`,
      ).run(PRIMARY_ROW_KEY, JSON.stringify(cell), Date.now());
      db.exec("COMMIT;");
    } catch (error) {
      db.exec("ROLLBACK;");
      throw error;
    }
  } finally {
    db.close();
  }
  return true;
}

/** Derive the OpenClaw agent SQLite path that sits beside an `agent/` dir. */
export function isAgentDatabasePath(filePath: string): boolean {
  return filePath.endsWith("openclaw-agent.sqlite");
}
