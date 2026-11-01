import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { getEnv } from "./env";

export type DB = Database.Database;

const g = globalThis as unknown as { __ddDb?: DB };

function schemaCandidates(): string[] {
  return [
    path.resolve(process.cwd(), "db", "schema.sql"),
    path.resolve(process.cwd(), "..", "db", "schema.sql"),
  ];
}

export function loadSchemaSql(): string {
  for (const candidate of schemaCandidates()) {
    try {
      return fs.readFileSync(candidate, "utf8");
    } catch {
      continue;
    }
  }
  throw new Error(
    `db/schema.sql not found (looked in: ${schemaCandidates().join(", ")}). Run commands from the project root.`,
  );
}

export function applySchema(db: DB): void {
  db.exec(loadSchemaSql());
}

function openDatabase(file: string): DB {
  if (file !== ":memory:") {
    const dir = path.dirname(path.resolve(file));
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      throw new Error(`Cannot create database directory ${dir}: ${(err as Error).message}`);
    }
  }
  let db: DB;
  try {
    db = new Database(file);
  } catch (err) {
    throw new Error(`Cannot open SQLite database at ${file}: ${(err as Error).message}`);
  }
  if (file !== ":memory:") db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  applySchema(db);
  return db;
}

/** Process-wide singleton; stored on globalThis so Next.js HMR reuses it. */
export function getDb(): DB {
  if (g.__ddDb && g.__ddDb.open) return g.__ddDb;
  g.__ddDb = openDatabase(getEnv().DATABASE_PATH);
  return g.__ddDb;
}

export function closeDb(): void {
  if (g.__ddDb && g.__ddDb.open) g.__ddDb.close();
  g.__ddDb = undefined;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Runs fn inside a single SQLite transaction. */
export function tx<T>(fn: (db: DB) => T): T {
  const db = getDb();
  return db.transaction(() => fn(db))();
}

export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (text === null || text === undefined || text === "") return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "SQLITE_CONSTRAINT_UNIQUE" || code === "SQLITE_CONSTRAINT_PRIMARYKEY";
}