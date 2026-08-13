import pg from "pg";
import { env } from "../config/env.js";

// BIGINT (oid 20) arrives as a string by default, because it can exceed Number's safe
// range. Our ids never will, and `participantId` is a JSON number in the frozen Android
// contract — so parse int8 as a number. Revisit only if a table passes 2^53 rows.
pg.types.setTypeParser(20, (value: string) => Number(value));

// The pool is lazy: `new Pool()` opens no socket, so importing this module (and
// booting the server) never requires DATABASE_URL to be set. Same property the
// Prisma client had before it was removed.
// `-c timezone=UTC` pins every connection's session timezone. It is what makes NOW(),
// and any timestamptz -> timestamp assignment, land in UTC regardless of how the host
// machine is configured — the database stores UTC and only the browser converts.
export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  options: "-c timezone=UTC",
});

export type QueryParams = readonly unknown[];

/** Runs a statement and returns every row. Always pass values as $1, $2 — never inline them. */
export async function query<T>(text: string, params?: QueryParams): Promise<T[]> {
  const result = await pool.query(text, params as unknown[]);
  return result.rows as T[];
}

/** Runs a statement expected to match at most one row. */
export async function queryOne<T>(text: string, params?: QueryParams): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

/** Number of rows the statement affected — for UPDATE/DELETE without RETURNING. */
export async function execute(text: string, params?: QueryParams): Promise<number> {
  const result = await pool.query(text, params as unknown[]);
  return result.rowCount ?? 0;
}

export interface Transaction {
  query<T>(text: string, params?: QueryParams): Promise<T[]>;
  queryOne<T>(text: string, params?: QueryParams): Promise<T | null>;
}

/**
 * Runs `fn` inside BEGIN/COMMIT on a single connection, rolling back on any throw.
 * The callback gets a Transaction, not the raw client, so query files look the same
 * whether or not they are running in a transaction.
 */
export async function withTransaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const tx: Transaction = {
      async query<R>(text: string, params?: QueryParams): Promise<R[]> {
        const result = await client.query(text, params as unknown[]);
        return result.rows as R[];
      },
      async queryOne<R>(text: string, params?: QueryParams): Promise<R | null> {
        const rows = await tx.query<R>(text, params);
        return rows[0] ?? null;
      },
    };
    const out = await fn(tx);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}
