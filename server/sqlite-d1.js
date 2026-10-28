// A SQLite database (node:sqlite's DatabaseSync) seen as the part of a D1 binding the sync uses (sync.js), so the
// local server (serve.mjs) and the tests run the same statements Cloudflare's D1 runs.

/**
 * What it needs of node:sqlite's DatabaseSync.
 * @typedef {{prepare: (sql: string) => {run: (...values: unknown[]) => {changes: number | bigint}, get: (...values: unknown[]) => unknown}}} SqliteDatabase
 */
/** @import {D1Database, D1Statement} from './sync.js' */

/**
 * @param {SqliteDatabase} database
 * @returns {D1Database}
 */
export function sqliteD1(database) {
	/**
	 * @param {string} sql
	 * @param {unknown[]} values
	 * @returns {D1Statement}
	 */
	const statement = (sql, values) => ({
		bind: (...given) => statement(sql, given),
		run: async () => ({meta: {changes: Number(database.prepare(sql).run(...values).changes)}}),
		first: async () =>
			/** @type {Record<string, unknown> | undefined} */ (database.prepare(sql).get(...values)) ?? null,
	});
	return {prepare: sql => statement(sql, [])};
}
