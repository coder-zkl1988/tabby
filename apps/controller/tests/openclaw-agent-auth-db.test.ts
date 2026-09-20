import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  discardUnownedAgentDatabase,
  isAgentDatabasePath,
  readAgentAuthStore,
  writeAgentAuthStore,
} from "../src/runtime/openclaw-agent-auth-db.js";

/**
 * Pins the controller's side of the OpenClaw auth-profile SQLite contract. If
 * an OpenClaw upgrade changes the table/column names or the `store_json`
 * shape, these assertions must be revisited before bumping the bundled runtime.
 *
 * The database itself is OpenClaw's to create. Until 2026.8.x the controller
 * created it when absent and OpenClaw adopted the partial file; 2026.9 rejects
 * a database with no schema ownership metadata and doctor will not repair one,
 * so these tests simulate OpenClaw having created it first.
 */
describe("openclaw-agent-auth-db", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "nexu-agent-auth-db-"));
    dbPath = path.join(
      tmpDir,
      "agents",
      "bot-1",
      "agent",
      "openclaw-agent.sqlite",
    );
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Stand in for OpenClaw having created the agent database. */
  function createOpenclawOwnedDatabase(): void {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    new DatabaseSync(dbPath).close();
  }

  it("identifies agent database paths", () => {
    expect(isAgentDatabasePath(dbPath)).toBe(true);
    expect(isAgentDatabasePath(path.join(tmpDir, "auth-profiles.json"))).toBe(
      false,
    );
  });

  it("returns null when the database does not exist", () => {
    expect(readAgentAuthStore(dbPath)).toBeNull();
  });

  it("round-trips the secrets store", () => {
    createOpenclawOwnedDatabase();
    const cell = {
      version: 1,
      profiles: {
        "anthropic:default": {
          type: "oauth",
          provider: "anthropic",
          access: "acc",
          refresh: "ref",
          expires: 123,
          email: "user@example.com",
        },
        "openai:default": { type: "api_key", provider: "openai", key: "sk-x" },
      },
    };
    writeAgentAuthStore(dbPath, cell);
    expect(readAgentAuthStore(dbPath)).toEqual(cell);
  });

  it("upserts the primary row instead of appending", () => {
    createOpenclawOwnedDatabase();
    writeAgentAuthStore(dbPath, { version: 1, profiles: { a: { v: 1 } } });
    writeAgentAuthStore(dbPath, { version: 1, profiles: { b: { v: 2 } } });

    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const count = db
        .prepare("SELECT COUNT(*) AS n FROM auth_profile_store")
        .get() as { n: number };
      expect(count.n).toBe(1);
    } finally {
      db.close();
    }
    expect(readAgentAuthStore(dbPath)).toEqual({
      version: 1,
      profiles: { b: { v: 2 } },
    });
  });

  it("persists the exact OpenClaw contract: table, columns, primary row key, store_json shape", () => {
    createOpenclawOwnedDatabase();
    writeAgentAuthStore(dbPath, {
      version: 1,
      profiles: { a: { type: "api_key" } },
    });

    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const columns = (
        db.prepare("PRAGMA table_info(auth_profile_store)").all() as Array<{
          name: string;
          type: string;
          pk: number;
        }>
      ).map((c) => ({ name: c.name, type: c.type, pk: c.pk }));
      expect(columns).toEqual([
        { name: "store_key", type: "TEXT", pk: 1 },
        { name: "store_json", type: "TEXT", pk: 0 },
        { name: "updated_at", type: "INTEGER", pk: 0 },
      ]);

      const row = db
        .prepare(
          "SELECT store_key, store_json, updated_at FROM auth_profile_store",
        )
        .get() as { store_key: string; store_json: string; updated_at: number };
      expect(row.store_key).toBe("primary");
      expect(JSON.parse(row.store_json)).toEqual({
        version: 1,
        profiles: { a: { type: "api_key" } },
      });
      expect(typeof row.updated_at).toBe("number");
    } finally {
      db.close();
    }
  });

  // A database the controller creates has no schema ownership metadata, which
  // since 2026.9 blocks gateway startup ("uses schema version 0") and cannot be
  // repaired — doctor skips it with "has no schema ownership metadata". So the
  // seed has to wait for OpenClaw rather than creating the file itself.
  it("refuses to create the database and reports that it skipped", () => {
    expect(writeAgentAuthStore(dbPath, { version: 1, profiles: {} })).toBe(
      false,
    );
    expect(existsSync(dbPath)).toBe(false);
  });

  describe("discardUnownedAgentDatabase", () => {
    function createDatabase(sql: string[]): void {
      mkdirSync(path.dirname(dbPath), { recursive: true });
      const db = new DatabaseSync(dbPath);
      try {
        for (const statement of sql) {
          db.exec(statement);
        }
      } finally {
        db.close();
      }
    }

    it("reports absent when there is no database", () => {
      expect(discardUnownedAgentDatabase(dbPath)).toBe("absent");
    });

    // The exact shape older controllers left behind: the auth row and nothing
    // else. OpenClaw cannot adopt it and doctor cannot repair it.
    it("discards a controller-shaped database", () => {
      createDatabase([
        "CREATE TABLE auth_profile_store (store_key TEXT PRIMARY KEY, store_json TEXT NOT NULL, updated_at INTEGER NOT NULL);",
      ]);
      expect(discardUnownedAgentDatabase(dbPath)).toBe("discarded");
      expect(existsSync(dbPath)).toBe(false);
    });

    it("keeps a database OpenClaw owns, whatever its schema version", () => {
      createDatabase([
        "CREATE TABLE schema_meta (meta_key TEXT PRIMARY KEY, role TEXT NOT NULL, schema_version INTEGER NOT NULL);",
        "INSERT INTO schema_meta (meta_key, role, schema_version) VALUES ('primary', 'agent', 3);",
      ]);
      expect(discardUnownedAgentDatabase(dbPath)).toBe("owned");
      expect(existsSync(dbPath)).toBe(true);
    });

    // Not a shape this controller produces. Deleting it would throw away
    // conversations on a guess, so it is surfaced instead.
    it("keeps an unowned database that carries OpenClaw data", () => {
      createDatabase([
        "CREATE TABLE session_nodes (session_key TEXT PRIMARY KEY);",
      ]);
      expect(discardUnownedAgentDatabase(dbPath)).toBe("unowned-with-data");
      expect(existsSync(dbPath)).toBe(true);
    });
  });

  it("reports that it wrote once OpenClaw owns the database", () => {
    createOpenclawOwnedDatabase();
    expect(writeAgentAuthStore(dbPath, { version: 1, profiles: {} })).toBe(
      true,
    );
  });
});
