// What reaches beyond this browser: your keys for the catalogs and their clients, Hardcover asked from the page, and
// your server (its catalog proxy and the sync's copy).
import {Text} from './modules/text.js';
import {ExternalCatalog} from './modules/external-catalog.js';
import {spell} from './dom.js';
import type {Unchecked} from './modules/text.js';
import type {CatalogClient, ClientClass, CatalogFetch} from './modules/catalog-client.js';

// ------------------------------------------------------------ the catalogs' keys and clients
// Your key for a catalog (Hardcover's token, AudiobookDB's API key) is kept in this browser only (never in a
// backup), under its client class's KEY_STORAGE, and saved on Import & export. A catalog whose API answers web
// pages (Hardcover) is asked from the page itself; one that doesn't (AudiobookDB) through your server's catalog
// proxy, which passes the key on only with the requests that need it and never keeps it.

/**
 * Your key for the catalog of `Client`, as saved in this browser; '' for none.
 */
export function savedKey(Client: typeof CatalogClient): string {
	try {
		return Client.cleanKey(localStorage.getItem(Client.KEY_STORAGE));
	} catch {
		return '';
	}
}

/**
 * Keep `key` (tidied the way its catalog takes it) as your key for the catalog of `Client` in this browser, or
 * forget the one kept when it is ''. Throws when the browser refuses to store it.
 */
export function saveKey(Client: typeof CatalogClient, key: string) {
	const clean = Client.cleanKey(key);
	if (clean) localStorage.setItem(Client.KEY_STORAGE, clean);
	else localStorage.removeItem(Client.KEY_STORAGE);
}

/**
 * Asks a catalog that answers web pages from this page, saying plainly when the browser can't reach it at all.
 * @param label the catalog's name
 */
function fetchDirect(label: string): CatalogFetch {
	return async (url, opts) => {
		try {
			return await fetch(url, opts);
		} catch (e) {
			throw new Error(
				spell(
					'this browser could not reach {catalog} (offline, or {catalog} refused a request from a web page)',
					{
						catalog: label,
					},
				),
				{cause: e},
			);
		}
	};
}

/**
 * A client of `Client`'s catalog asking from this page (or through the saved server's catalog proxy, for a
 * catalog asked through it), with `key` (your key; the one saved in this browser when left out).
 */
export function catalogClient<C extends CatalogClient>(Client: ClientClass<C>, key: string = savedKey(Client)): C {
	const pause = (ms: number) => new Promise(done => setTimeout(done, ms));
	const server = savedServer();
	const get: CatalogFetch = Client.VIA_PROXY
		? (route, init) => fetchViaProxy(route, server, init)
		: fetchDirect(Client.LABEL);
	return new Client(get, key, pause);
}

/**
 * A client of each catalog of `Clients` (CatalogConnectors.CLIENTS) whose key is saved in this browser.
 */
export function keyedClients(Clients: readonly ClientClass[]): CatalogClient[] {
	return Clients.filter(Client => savedKey(Client)).map(Client => catalogClient(Client));
}

// ------------------------------------------------------------ Hardcover from the page
/**
 * The Hardcover book that `text` names: its id, or the address of the book's or one of its editions'
 * pages on hardcover.app (HardcoverClient.bookId), as {id, title}. An address without the book's id
 * is looked up on Hardcover with the token saved in this browser. Throws with a short reason.
 */
export async function lookupHardcoverBook(text: string): Promise<{id: string; title?: string}> {
	const {HardcoverClient} = await import('./modules/hardcover-client.js');
	const url = HardcoverClient.parseUrl(text);
	if (!url || url.book) return HardcoverClient.bookId(null, text);
	const token = savedKey(HardcoverClient);
	if (!token)
		throw new Error(
			spell('to look it up on Hardcover, save your Hardcover API token on the Import & export page first'),
		);
	return HardcoverClient.bookId(catalogClient(HardcoverClient, token), text);
}

/** why the field can't be saved, or what to say about it */
export type HardcoverFieldLookup = {error: string; note: string};
/** the lookup, and the name it looks up */
export type HardcoverFieldLookupOnItsWay = Promise<HardcoverFieldLookup> & {slug?: string};
/** each field's lookup on its way, so a Save waits for it */
const HARDCOVER_FIELD_LOOKUPS: WeakMap<Element, HardcoverFieldLookupOnItsWay> = new WeakMap();

/**
 * Hardcover keeps a series, author, narrator or publisher by its number, which its links by id keep working
 * with when it is renamed, but its pages' addresses (what gets pasted) have a name in them. When the Hardcover
 * field externalFields() made holds such an address (or the name alone), this asks Hardcover for the number
 * (with the token saved in this browser) and puts it in the field. When Hardcover can't be asked (no token,
 * offline, refused), the name is kept: its page's address still works until Hardcover renames it.
 * Resolves to {error} when Hardcover has no such page, else {note} (what was found, or why the name was kept);
 * null when there is nothing to look up (a number, or nothing), so a form can save at once.
 */
export function lookupHardcoverField(
	prefix: string,
	kind: 'series' | 'author' | 'narrator' | 'publisher',
): Promise<HardcoverFieldLookup> | null {
	const field = document.getElementById(prefix + 'hardcover');
	const text = field ? Text.tidy((field as HTMLInputElement).value) : '';
	const found = text ? ExternalCatalog.readId(text, kind, 'hardcover') : null;
	if (!field || !found || !ExternalCatalog.isFallbackId('hardcover', kind, found.id)) return null;
	const onItsWay = HARDCOVER_FIELD_LOOKUPS.get(field);
	const slug = found.id;
	// the same name, as an address or alone (leaving the field turns its address into the name)
	if (onItsWay && onItsWay.slug === slug) return onItsWay;
	const address = ExternalCatalog.url('hardcover', kind, slug);
	const kept = (note: string) => ({error: '', note});
	const lookup: HardcoverFieldLookupOnItsWay = (async () => {
		const {HardcoverClient} = await import('./modules/hardcover-client.js');
		const token = savedKey(HardcoverClient);
		if (!token)
			return kept(
				spell(
					"Kept Hardcover's {kind} by the name in its address, as no Hardcover API token is saved on the Import & export page to look up its number.",
					{kind: spell(kind)},
				),
			);
		let row: {id: string; name: string} | null;
		try {
			row = await HardcoverClient.idBySlug(catalogClient(HardcoverClient, token), kind, slug);
		} catch (err) {
			return kept(
				spell(
					"Kept Hardcover's {kind} by the name in its address, as Hardcover couldn't be asked for its number ({error}).",
					{kind: spell(kind), error: Text.errorPhrase(err)},
				),
			);
		}
		if (!row)
			return {
				error: spell('Hardcover has no {kind} at {address}.', {kind: spell(kind), address: address ?? slug}),
				note: '',
			};
		const now = ExternalCatalog.readId((field as HTMLInputElement).value, kind, 'hardcover');
		if (now && now.id === slug) (field as HTMLInputElement).value = row.id;
		return {
			error: '',
			note: spell('Found on Hardcover: {name} ({kind} {id}).', {
				name: row.name || slug,
				kind: spell(kind),
				id: row.id,
			}),
		};
	})();
	lookup.slug = slug;
	HARDCOVER_FIELD_LOOKUPS.set(field, lookup);
	lookup.finally(() => {
		if (HARDCOVER_FIELD_LOOKUPS.get(field) === lookup) HARDCOVER_FIELD_LOOKUPS.delete(field);
	});
	return lookup;
}

// ------------------------------------------------------------ your server
// The app's optional server (server/worker.ts: a Cloudflare Worker, or make serve on this computer), when its
// address and key are saved on Import & export, does two things: its catalog proxy asks the catalogs whose APIs
// don't answer web pages (AudiobookDB, Audible, BookBrainz, ISFDB), and it keeps the copy devices sync with.
// Like the Hardcover token they are kept in this browser only (never in a backup); without them those catalogs
// are not asked. Hardcover is never asked through it, so the token never leaves for anywhere but Hardcover.
// The storage key is the one from when the server was only the proxy, so a server saved then is still found.
export const SERVER_STORAGE_KEY = 'audiobook-catalog-proxy';
const SERVER_KEY_HEADER = 'X-Server-Key';
const CATALOG_KEY_HEADER = 'X-Catalog-Key'; // your key for a catalog, which the proxy passes on only where it is needed

/** the server's address (no slash at the end) and its key */
export type ServerSettings = {url: string; key: string};

/** @returns the server saved in this browser, or null */
export function savedServer(): ServerSettings | null {
	try {
		const v = JSON.parse(localStorage.getItem(SERVER_STORAGE_KEY) || 'null') as Unchecked;
		const url = v && typeof v.url === 'string' ? serverAddress(v.url) : '';
		return url && typeof v.key === 'string' && v.key ? {url, key: v.key} : null;
	} catch {
		return null;
	}
}

/**
 * The server address typed, tidied (no slash at the end), or '' when it isn't one: https, or http only on this
 * computer (make serve), with no query or password in it.
 */
export function serverAddress(text: string): string {
	let url;
	try {
		url = new URL(text.trim());
	} catch {
		return '';
	}
	const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
	if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) return '';
	if (url.search || url.hash || url.username || url.password) return '';
	return (url.origin + url.pathname).replace(/\/+$/, '');
}

/**
 * Asks the server: `path` is its route (`ping`, `sync`, `proxy/audiobookdb/…`). With `init.key` (your key for a
 * catalog, AudiobookDB's) it goes along for the proxy to pass on, and with `init.body` it is a POST of that JSON.
 * Throws plainly when no server is saved or the browser can't reach it.
 * @param server the saved one when left out
 */
export async function fetchFromServer(
	path: string,
	server: ServerSettings | null = savedServer(),
	init: {body?: string; key?: string} = {},
): Promise<Response> {
	if (!server) throw new Error(spell('save your server on the Import & export page'));
	const headers: Record<string, string> = {[SERVER_KEY_HEADER]: server.key};
	if (init.key) headers[CATALOG_KEY_HEADER] = init.key;
	if (init.body !== undefined) headers['Content-Type'] = 'application/json';
	const ask = init.body !== undefined ? {method: 'POST', body: init.body, headers} : {headers};
	try {
		return await fetch(`${server.url}/${path.replace(/^\/+/, '')}`, ask);
	} catch (e) {
		throw new Error(
			spell(
				'this browser could not reach your server (check its address, and that it allows this page in ALLOWED_ORIGINS)',
			),
			{cause: e},
		);
	}
}

/**
 * Asks a catalog through the server's catalog proxy: `route` is the catalog and the path in its API
 * (`audiobookdb/audiobooks/external/audible/B0…`); `init` as for fetchFromServer.
 * @param server the saved one when left out
 */
export function fetchViaProxy(
	route: string,
	server: ServerSettings | null = savedServer(),
	init: {body?: string; key?: string} = {},
): Promise<Response> {
	return fetchFromServer(`proxy/${route.replace(/^\/+/, '')}`, server, init);
}
