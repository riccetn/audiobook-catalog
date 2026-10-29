// Syncing the catalog between devices through your server (server/sync.ts, `/sync`), which keeps one copy
// of it: a version 3 backup (Backup.write), compressed and encrypted here with a passphrase, so the server (and
// Cloudflare) hold only text they can't read. Each device keeps the copy it last synced (its `base`), and a sync
// takes in what changed in the copy since then the way a save takes in another tab's (CatalogRecords.merge):
// a record only one side changed comes from that side, and one both changed differently is a conflict, named,
// which the user settles by keeping this device's or the synced one. The page then saves the result and sends
// it as the next copy (store.ts, syncCatalog). Only web APIs (WebCrypto, CompressionStream), so it runs in Node too.
import {Backup, NewerBackup} from './backup.js';
import {CatalogRecords} from './catalog-records.js';
import {Text} from './text.js';
import type {BackupJSON} from './backup.js';
import type {RecordSet} from './catalog-records.js';

/**
 * The key a passphrase gives with a salt, and the salt, so the copy sent after one read is sealed with the same
 * key (a new IV each time) without working it out twice; that takes a moment on purpose.
 */
export type SyncKey = {key: CryptoKey; salt: Uint8Array<ArrayBuffer>; iterations: number};
/**
 * What a sync makes of the three copies: the records to keep, the entries both sides changed, and how many
 * records it takes from the synced copy (`taken`) and changes in it (`sent`).
 */
export type SyncResult = {records: RecordSet; conflicts: string[]; taken: number; sent: number};
/**
 * Whose version a sync keeps of what both sides changed: this device's or the synced copy's; or `replace`, the
 * synced copy in place of this device's catalog.
 */
export type SyncPrefer = 'mine' | 'theirs' | 'replace';

/** The synced copy is not one this passphrase opens: another passphrase, or not this app's. */
export class WrongPassphrase extends Error {}
/** The synced copy and this device's catalog weren't made from one catalog: they name a series or person under other ids. */
export class UnrelatedCatalogs extends Error {}

export class CatalogSync {
	// What the sealed text says it is, so another app's text isn't taken for a catalog.
	static FORMAT = 'audiobook-catalog-sync';
	// PBKDF2 with SHA-256, as many rounds as OWASP advises, so a passphrase can't be guessed quickly from the copy.
	static ITERATIONS = 600_000;

	/**
	 * The key `passphrase` gives with `salt` (a new one when left out).
	 */
	static async keyFor(
		passphrase: string,
		salt: Uint8Array<ArrayBuffer> = crypto.getRandomValues(new Uint8Array(16)),
		iterations: number = CatalogSync.ITERATIONS,
	): Promise<SyncKey> {
		const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, [
			'deriveKey',
		]);
		const key = await crypto.subtle.deriveKey(
			{name: 'PBKDF2', hash: 'SHA-256', salt, iterations},
			material,
			{name: 'AES-GCM', length: 256},
			false,
			['encrypt', 'decrypt'],
		);
		return {key, salt, iterations};
	}

	/**
	 * The catalog's backup, compressed and encrypted with `key` (AES-GCM, a new IV), as the text the server keeps.
	 * `copy` names the synced copy, the same from the first sync on, so a device can tell a copy made again (the
	 * server's database emptied, say) from the one it synced before.
	 */
	static async seal(backup: BackupJSON, key: SyncKey, copy: string): Promise<string> {
		const iv = crypto.getRandomValues(new Uint8Array(12));
		const plain = await CatalogSync.squeeze(new TextEncoder().encode(JSON.stringify(backup)), true);
		const sealed = new Uint8Array(await crypto.subtle.encrypt({name: 'AES-GCM', iv}, key.key, plain));
		return JSON.stringify({
			format: CatalogSync.FORMAT,
			version: 1,
			copy,
			kdf: {name: 'PBKDF2', hash: 'SHA-256', iterations: key.iterations, salt: toBase64(key.salt)},
			iv: toBase64(iv),
			data: toBase64(sealed),
		});
	}

	/**
	 * The backup in a text seal() made, and the key that opened it. Throws WrongPassphrase when the passphrase
	 * doesn't open it (or it isn't this app's), and NewerBackup when a newer version of the app made it.
	 */
	static async open(text: string, passphrase: string): Promise<{backup: BackupJSON; key: SyncKey; copy: string}> {
		let sealed: any;
		try {
			sealed = JSON.parse(text);
		} catch {
			sealed = null;
		}
		if (!Text.isObject(sealed) || sealed.format !== CatalogSync.FORMAT || !Text.isObject(sealed.kdf))
			throw new WrongPassphrase('the synced copy is not a catalog this app synced');
		if (sealed.version !== 1) throw new NewerBackup(sealed.version);
		const key = await CatalogSync.keyFor(passphrase, fromBase64(sealed.kdf.salt), sealed.kdf.iterations);
		let plain: Uint8Array<ArrayBuffer>;
		try {
			plain = new Uint8Array(
				await crypto.subtle.decrypt(
					{name: 'AES-GCM', iv: fromBase64(sealed.iv)},
					key.key,
					fromBase64(sealed.data),
				),
			);
		} catch {
			throw new WrongPassphrase('the passphrase does not open the synced copy');
		}
		const backup = JSON.parse(new TextDecoder().decode(await CatalogSync.squeeze(plain, false)));
		if (!Text.isObject(backup) || !Number.isInteger(backup.version) || backup.version < 2)
			throw new WrongPassphrase('the synced copy is not a catalog this app synced');
		if (backup.version > Backup.VERSION) throw new NewerBackup(backup.version);
		return {
			backup: backup as BackupJSON,
			key,
			copy: typeof sealed.copy === 'string' ? sealed.copy : '',
		};
	}

	/**
	 * Gzip `bytes` (`pack`), or undo it.
	 */
	static async squeeze(bytes: Uint8Array, pack: boolean): Promise<Uint8Array<ArrayBuffer>> {
		const stream = pack ? new CompressionStream('gzip') : new DecompressionStream('gzip');
		const writer = stream.writable.getWriter();
		writer.write(bytes as Uint8Array<ArrayBuffer>);
		writer.close();
		const parts: Uint8Array[] = [];
		const reader = stream.readable.getReader();
		for (;;) {
			const {done, value} = await reader.read();
			if (done) break;
			parts.push(value);
		}
		const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
		let at = 0;
		for (const p of parts) {
			out.set(p, at);
			at += p.length;
		}
		return out;
	}

	/**
	 * This device's catalog (`mine`) with what changed in the synced copy (`theirs`) since this device last
	 * synced (`base`); each a backup, null for none (`base` before the first sync, `theirs` before any device
	 * synced). With `prefer`, a record both changed is that side's (and still named in `conflicts`); without it
	 * the result is of no use while there are conflicts. Throws UnrelatedCatalogs when the two name one series
	 * or person under other ids (they weren't made from one catalog, see docs/server.md); `replace` then
	 * takes the synced copy in place of this device's catalog, keeping this one's exclusions too.
	 */
	static combine(
		base: BackupJSON | null,
		mine: BackupJSON,
		theirs: BackupJSON | null,
		prefer?: SyncPrefer,
	): SyncResult {
		const my = Backup.records(mine);
		const their = theirs ? Backup.records(theirs) : CatalogSync.noRecords();
		const before = base ? CatalogRecords.snapshot(Backup.records(base)) : new Map();
		let merged: {records: RecordSet; conflicts: string[]};
		if (prefer === 'replace') {
			// but the exclusions, which are only ever added to
			const entries = new Set(their.exclusions.map(x => x.entry));
			const kept = my.exclusions.filter(x => !entries.has(x.entry));
			const exclusions = [...their.exclusions, ...kept].map((x, position) => ({...x, position}));
			merged = {records: {...their, exclusions}, conflicts: []};
		} else {
			merged = CatalogRecords.merge(before, my, their, true, prefer);
			try {
				Backup.checkNames(merged.records);
			} catch (e) {
				throw new UnrelatedCatalogs(Text.errorText(e), {cause: e});
			}
		}
		const {records, conflicts} = merged;
		return {
			records,
			conflicts,
			taken: CatalogRecords.changes(CatalogRecords.snapshot(my), records).count,
			sent: CatalogRecords.changes(CatalogRecords.snapshot(their), records).count,
		};
	}

	/** @returns an empty catalog's records */
	static noRecords(): RecordSet {
		return {books: [], editions: [], series: [], contributors: [], credits: [], marks: [], exclusions: []};
	}
}

function toBase64(bytes: Uint8Array): string {
	let text = '';
	// a few thousand at a time, as String.fromCharCode takes its arguments on the stack
	for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
	return btoa(text);
}

function fromBase64(text: unknown): Uint8Array<ArrayBuffer> {
	if (typeof text !== 'string') throw new WrongPassphrase('the synced copy is not a catalog this app synced');
	try {
		return Uint8Array.from(atob(text), c => c.charCodeAt(0));
	} catch {
		throw new WrongPassphrase('the synced copy is not a catalog this app synced');
	}
}
