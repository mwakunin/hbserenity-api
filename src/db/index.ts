import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import env from "@/env";

// schema.ts re-exports the Better-Auth-owned tables, so this is the whole model.
import * as schema from "./schema";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Whether the DSN points at a database on this machine, which is the only case
 * where running without TLS is acceptable.
 *
 * Compares the parsed *hostname* rather than searching the whole connection
 * string: a substring test silently disables TLS for a remote host whenever
 * "localhost" appears anywhere else in the URL — in a password, a query
 * parameter, or a hostname like `localhost.example.com`.
 *
 * An unparseable DSN is treated as remote. Failing closed keeps a malformed
 * production URL from quietly downgrading to plaintext.
 */
function isLocalDatabase(connectionString: string): boolean {
  try {
    return LOCAL_HOSTS.has(new URL(connectionString).hostname);
  }
  catch {
    return false;
  }
}

// One driver serves both local Docker Postgres and Neon — Neon speaks the
// standard wire protocol over TCP, so there's no environment branching here.
export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  // Neon (and most managed Postgres) require TLS; local Docker doesn't offer it.
  ssl: isLocalDatabase(env.DATABASE_URL) ? false : { rejectUnauthorized: true },
});

const db = drizzle({
  client: pool,
  casing: "snake_case",
  schema,
});

export default db;
