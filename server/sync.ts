// Syncing devices (`/sync`): the server keeps one copy of your catalog, in a database the Worker has bound as
// SYNC_DB (Cloudflare D1) or the local server opens (SQLite, sqlite-d1.ts). It is encrypted in the page with your
// passphrase before it is sent, so the server only ever holds text it can't read, and replaced only by a page that
// read the copy now kept (its revision), so two devices syncing at once can't write over each other.
// It has nothing to do with the catalog proxy beyond being served beside it, with the same key.
import {jsonResponse} from './responses.ts';

/**
 * The part of a D1 binding the sync uses: a statement prepared, its values bound, and run (`run` says how many rows
 * it changed) or asked for its first row. Cloudflare's D1 is one; `sqliteD1` makes one of a SQLite database.
 */
export type D1Database = {prepare: (sql: string) => D1Statement};
export type D1Statement = {
	bind: (...values: unknown[]) => D1Statement;
	run: () => Promise<{meta: {changes: number}}>;
	first: () => Promise<Record<string, unknown> | null>;
};

// The synced copy is one row of D1, which holds at most 2,000,000 bytes a row; the page compresses the catalog
// before encrypting it, so this is a catalog of many thousands of books.
export const MAX_SYNC = 1_900_000;
// The one table the sync keeps, made on the first sync, with the one row of the copy (id 1). A write names the
// revision it read: the first copy goes in only while there is none, and a later one only over that revision.
// Plain SQLite, which D1 is too, so the local server runs the same statements.
export const SYNC_SQL = {
	table: 'CREATE TABLE IF NOT EXISTS sync (id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL, data TEXT NOT NULL, saved_at TEXT NOT NULL)',
	read: 'SELECT revision, data, saved_at FROM sync WHERE id = 1',
	first: 'INSERT INTO sync (id, revision, data, saved_at) VALUES (1, 1, ?1, ?2) ON CONFLICT (id) DO NOTHING',
	replace: 'UPDATE sync SET revision = revision + 1, data = ?1, saved_at = ?2 WHERE id = 1 AND revision = ?3',
};

/**
 * The synced copy: GET gives `{revision, data, savedAt}` (revision 0 and data null while there is none), and POST
 * of `{revision, data}` keeps `data` (the page's encrypted text) as the next revision when `revision` is the one
 * kept now; else it answers 409 with the revision kept, for the page to sync again.
 * @param request already let in by the server
 * @param cors the CORS headers for the page asking
 */
export async function handleSync(
	request: Request,
	db: D1Database | undefined,
	cors: Record<string, string>,
): Promise<Response> {
	if (!db)
		return jsonResponse(501, {error: 'Sync is not set up on this server: bind a D1 database as SYNC_DB.'}, cors);
	await db.prepare(SYNC_SQL.table).run();
	const kept: () => Promise<{revision: number; data: string | null; savedAt: string | null}> = async () => {
		const row = await db.prepare(SYNC_SQL.read).first();
		return row
			? {revision: Number(row.revision), data: String(row.data), savedAt: String(row.saved_at)}
			: {revision: 0, data: null, savedAt: null};
	};
	if (request.method === 'GET') return jsonResponse(200, await kept(), cors);
	const text = await request.text();
	if (text.length > MAX_SYNC + 1000) return jsonResponse(413, {error: 'The catalog is too big to sync.'}, cors);
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		body = null;
	}
	const {revision, data} = (body || {}) as {revision?: unknown; data?: unknown};
	if (!Number.isInteger(revision) || (revision as number) < 0 || typeof data !== 'string' || !data)
		return jsonResponse(400, {error: 'Send {revision, data}.'}, cors);
	if (data.length > MAX_SYNC) return jsonResponse(413, {error: 'The catalog is too big to sync.'}, cors);
	const at = new Date().toISOString();
	const done = revision
		? await db.prepare(SYNC_SQL.replace).bind(data, at, revision).run()
		: await db.prepare(SYNC_SQL.first).bind(data, at).run();
	if (!done.meta.changes) {
		const now = await kept();
		return jsonResponse(409, {error: 'Another device synced first.', revision: now.revision}, cors);
	}
	return jsonResponse(200, {revision: (revision as number) + 1, savedAt: at}, cors);
}
