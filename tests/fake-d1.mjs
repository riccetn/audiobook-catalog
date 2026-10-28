// A stand-in for the Cloudflare D1 database the catalog proxy keeps the synced copy in (SYNC_DB), knowing only
// the statements the Worker runs (SYNC_SQL), so the tests run the real Worker's sync in Node.
import {SYNC_SQL} from '../proxy/worker.js';

/** A D1 binding holding the one sync row in `row` (null until the first copy). */
export function fakeD1() {
	const db = {
		row: /** @type {{revision: number, data: string, saved_at: string} | null} */ (null),
		tables: 0,
		prepare(sql) {
			let values = [];
			const statement = {
				bind(...given) {
					values = given;
					return statement;
				},
				async run() {
					if (sql === SYNC_SQL.table) {
						db.tables++;
						return {meta: {changes: 0}};
					}
					if (sql === SYNC_SQL.first) {
						if (db.row) return {meta: {changes: 0}};
						db.row = {revision: 1, data: values[0], saved_at: values[1]};
						return {meta: {changes: 1}};
					}
					if (sql === SYNC_SQL.replace) {
						if (!db.row || db.row.revision !== values[2]) return {meta: {changes: 0}};
						db.row = {revision: db.row.revision + 1, data: values[0], saved_at: values[1]};
						return {meta: {changes: 1}};
					}
					throw new Error(`the Worker ran SQL the fake doesn't know: ${sql}`);
				},
				async first() {
					if (sql !== SYNC_SQL.read) throw new Error(`the Worker asked SQL the fake doesn't know: ${sql}`);
					return db.row ? {...db.row} : null;
				},
			};
			return statement;
		},
	};
	return db;
}
