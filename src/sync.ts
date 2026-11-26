// Syncing devices, which only Import & export does. With sync set up on your server (a D1 database, or make serve's
// SQLite file; docs/server.md), the server keeps one copy of the catalog, encrypted with a passphrase that is kept in
// this browser only, like the server's key (never in a backup, never sent). Syncing takes in what other devices
// changed since this browser last synced, saves it, and sends the result as the next copy (CatalogSync). What this
// browser last synced is kept in IndexedDB (meta `sync`, through store.ts's syncedCopies()).
import {Catalog} from './modules/catalog.js';
import {CatalogRecords} from './modules/catalog-records.js';
import {Backup} from './modules/backup.js';
import {CatalogSync} from './modules/catalog-sync.js';
import type {SyncPrefer} from './modules/catalog-sync.js';
import {CATALOG, syncedCopies, savesDone, takeInSynced, wholeCatalog} from './store.js';
import {spell} from './dom.js';
import {fetchFromServer} from './connections.js';

const SYNC_STORAGE_KEY = 'audiobook-catalog-sync-passphrase';

/** @returns the sync passphrase saved in this browser, or '' */
export function savedPassphrase(): string {
	try {
		return localStorage.getItem(SYNC_STORAGE_KEY) || '';
	} catch {
		return '';
	}
}

/**
 * Save the sync passphrase in this browser, or remove the saved one. Throws when the browser keeps nothing.
 * @param passphrase the passphrase to save; '' removes it
 */
export function savePassphrase(passphrase: string): void {
	if (passphrase) localStorage.setItem(SYNC_STORAGE_KEY, passphrase);
	else localStorage.removeItem(SYNC_STORAGE_KEY);
}

/** @returns when this browser last synced, and the copy's revision then */
export async function lastSync(): Promise<{revision: number; at: string} | null> {
	try {
		const base = await syncedCopies().syncBase();
		return base ? {revision: base.revision, at: base.at} : null;
	} catch {
		return null;
	}
}

/**
 * What a sync did: how many records it took in from the other devices, whether it sent a new copy, and the
 * entries both this browser and another device changed (then nothing was done, unless told which to keep).
 */
export type SyncOutcome = {taken: number; sent: boolean; conflicts: string[]};

/**
 * The server's answer to a sync request, or a plain error saying what is wrong.
 */
async function syncAnswer(res: Response): Promise<{revision: number; data?: string | null}> {
	if (res.status === 401) throw new Error(spell('your server refused the key'));
	if (res.status === 501) throw new Error(spell('sync is not set up on your server (see Your server in the docs)'));
	if (res.status === 404) throw new Error(spell('your server is from before sync: deploy it again'));
	if (res.status === 413) throw new Error(spell('the catalog is too big to sync'));
	if (!res.ok) throw new Error(spell('your server answered {status}', {status: res.status}));
	return (await res.json()) as {revision: number; data?: string | null};
}

/**
 * Sync this browser's catalog with the copy on your server: take in what other devices changed since this
 * browser last synced, save it here, and send the result. When both changed one entry, nothing is changed and
 * the outcome names them, unless `prefer` says whose to keep. Throws a plain error (or CatalogSync's
 * WrongPassphrase, UnrelatedCatalogs, or NewerBackup) when it can't.
 */
export async function syncCatalog(prefer?: SyncPrefer): Promise<SyncOutcome> {
	const copies = syncedCopies();
	const passphrase = savedPassphrase();
	if (!passphrase) throw new Error(spell('save a sync passphrase first'));
	await wholeCatalog();
	// another device may send its copy between this browser's reading and sending: then it reads again
	for (let tries = 1; tries <= 3; tries++) {
		const got = await syncAnswer(await fetchFromServer('sync'));
		const base = await copies.syncBase();
		const opened = got.data ? await CatalogSync.open(got.data, passphrase) : null;
		// what this browser synced last is of use only while the copy is that one, at that revision or later
		const known = base && opened && opened.copy === base.copy && got.revision >= base.revision ? base.backup : null;
		await savesDone();
		const mine = Backup.write(CATALOG);
		const result = CatalogSync.combine(known, mine, opened ? opened.backup : null, prefer);
		if (result.conflicts.length && !prefer) return {taken: 0, sent: false, conflicts: result.conflicts};
		if (result.taken) await takeInSynced(CatalogRecords.toCatalog(result.records), prefer === 'replace');
		const copy = opened ? opened.copy || Catalog.newId() : Catalog.newId();
		if (opened && !result.sent) {
			await copies.keepSyncBase({
				revision: got.revision,
				copy,
				backup: opened.backup,
				at: new Date().toISOString(),
			});
			return {taken: result.taken, sent: false, conflicts: result.conflicts};
		}
		const now = Backup.write(CATALOG);
		const key = opened ? opened.key : await CatalogSync.keyFor(passphrase);
		const body = JSON.stringify({revision: got.revision, data: await CatalogSync.seal(now, key, copy)});
		const res = await fetchFromServer('sync', undefined, {body});
		if (res.status === 409) continue;
		const sent = await syncAnswer(res);
		await copies.keepSyncBase({revision: sent.revision, copy, backup: now, at: new Date().toISOString()});
		return {taken: result.taken, sent: true, conflicts: result.conflicts};
	}
	throw new Error(spell('other devices kept syncing meanwhile; try again'));
}
