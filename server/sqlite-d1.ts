// A SQLite database (node:sqlite's DatabaseSync) seen as the part of a D1 binding the sync uses (sync.ts), so the
// local server (serve.mjs) and the tests run the same statements Cloudflare's D1 runs.

/** What it needs of node:sqlite's DatabaseSync. */
export type SqliteDatabase = {
	prepare: (sql: string) => {
		run: (...values: unknown[]) => {changes: number | bigint};
		get: (...values: unknown[]) => unknown;
	};
};
import type {D1Database, D1Statement} from './sync.ts';

export function sqliteD1(database: SqliteDatabase): D1Database {
	const statement = (sql: string, values: unknown[]): D1Statement => ({
		bind: (...given) => statement(sql, given),
		run: async () => ({meta: {changes: Number(database.prepare(sql).run(...values).changes)}}),
		first: async () => (database.prepare(sql).get(...values) as Record<string, unknown> | undefined) ?? null,
	});
	return {prepare: sql => statement(sql, [])};
}
