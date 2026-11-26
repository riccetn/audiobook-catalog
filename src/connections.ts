// What reaches beyond this browser: your keys for the catalogs and their clients, the ids a catalog is asked for
// from a form, and your server (its catalog proxy and the sync's copy).
import {Text} from './modules/text.js';
import {ExternalCatalog} from './modules/external-catalog.js';
import type {ExternalKind} from './modules/external-catalog.js';
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

// ------------------------------------------------------------ ids looked up on a catalog
// A catalog whose definition lists a kind in `lookups` (ExternalCatalog.looksUp) can be asked for the id of a page
// whose address doesn't hold it. Its client class is found by the catalog's key, and loaded only then.

/**
 * The client class of the catalog a form field stands for (its group's key), or null when the app asks it nothing.
 */
async function clientOf(group: string): Promise<ClientClass | null> {
	const {CatalogConnectors} = await import('./modules/catalog-connectors.js');
	return CatalogConnectors.client(group);
}

/**
 * The book that `text` names on a catalog (`group`, its form field's): the address of the book's page there, or of
 * one of its editions', which holds no id of the book. Looked up on the catalog with the key saved in this browser,
 * as {id, name (the book's title there)}. Throws with a short reason.
 */
export async function lookupBookId(group: string, text: string): Promise<{id: string; name?: string}> {
	const Client = await clientOf(group);
	const catalog = Client ? Client.LABEL : ExternalCatalog.groupOf(group)?.name || group;
	const key = Client && Client.KEY_STORAGE ? savedKey(Client) : '';
	if (!Client || (Client.KEY_NEEDED && !key))
		throw new Error(
			Client
				? spell('to look it up on {catalog}, save your {catalog} {key} on the Import & export page first', {
						catalog,
						key: spell(Client.KEY_NAME),
					})
				: spell("{catalog} can't be asked for it", {catalog}),
		);
	const found = await Client.lookupId(catalogClient(Client, key), 'book', text);
	if (!found) throw new Error(spell('{catalog} has no such book', {catalog}));
	return found;
}

/** why the field can't be saved, or what to say about it */
export type FieldLookup = {error: string; note: string};
/** the lookup, and the name it looks up */
type FieldLookupOnItsWay = Promise<FieldLookup> & {slug?: string};
/** each field's lookup on its way, so a Save waits for it */
const FIELD_LOOKUPS: WeakMap<Element, FieldLookupOnItsWay> = new WeakMap();

/**
 * A catalog may keep a series, author, narrator or publisher by an id its links keep working with when it is
 * renamed (Hardcover's number), while its pages' addresses (what gets pasted) have a name in them, which is kept as
 * a fallback id. When the catalog's field externalFields() made holds such an address (or the name alone), this
 * asks the catalog for the id (with the key saved in this browser) and puts it in the field. When the catalog
 * can't be asked (no key, offline, refused), the name is kept: its page's address still works until it is renamed.
 * Resolves to {error} when the catalog has no such page, else {note} (what was found, or why the name was kept);
 * null when there is nothing to look up (the usual id, or nothing), so a form can save at once.
 * @param group the field's group of catalogs
 */
export function lookupIdField(prefix: string, kind: ExternalKind, group: string): Promise<FieldLookup> | null {
	if (!ExternalCatalog.looksUp(group, kind)) return null;
	const field = document.getElementById(prefix + group);
	const text = field ? Text.tidy((field as HTMLInputElement).value) : '';
	const found = text ? ExternalCatalog.readId(text, kind, group) : null;
	if (!field || !found || !ExternalCatalog.isFallbackId(found.catalog, kind, found.id)) return null;
	const onItsWay = FIELD_LOOKUPS.get(field);
	const slug = found.id;
	// the same name, as an address or alone (leaving the field turns its address into the name)
	if (onItsWay && onItsWay.slug === slug) return onItsWay;
	const address = ExternalCatalog.url(found.catalog, kind, slug);
	const kept = (note: string) => ({error: '', note});
	const lookup: FieldLookupOnItsWay = (async () => {
		const Client = await clientOf(group);
		const catalog = Client ? Client.LABEL : ExternalCatalog.name(found.catalog);
		const key = Client && Client.KEY_STORAGE ? savedKey(Client) : '';
		if (!Client || (Client.KEY_NEEDED && !key))
			return kept(
				spell(
					"Kept {catalog}'s {kind} by the name in its address, as no {catalog} {key} is saved on the Import & export page to look up its id.",
					{catalog, kind: spell(kind), key: spell(Client ? Client.KEY_NAME : 'key')},
				),
			);
		let row: {id: string; name?: string} | null;
		try {
			row = await Client.lookupId(catalogClient(Client, key), kind, slug);
		} catch (err) {
			return kept(
				spell(
					"Kept {catalog}'s {kind} by the name in its address, as {catalog} couldn't be asked for its id ({error}).",
					{catalog, kind: spell(kind), error: Text.errorPhrase(err)},
				),
			);
		}
		if (!row)
			return {
				error: spell('{catalog} has no {kind} at {address}.', {
					catalog,
					kind: spell(kind),
					address: address ?? slug,
				}),
				note: '',
			};
		const now = ExternalCatalog.readId((field as HTMLInputElement).value, kind, group);
		if (now && now.id === slug) (field as HTMLInputElement).value = row.id;
		return {
			error: '',
			note: spell('Found on {catalog}: {name} ({kind} {id}).', {
				catalog,
				name: row.name || slug,
				kind: spell(kind),
				id: row.id,
			}),
		};
	})();
	lookup.slug = slug;
	FIELD_LOOKUPS.set(field, lookup);
	lookup.finally(() => {
		if (FIELD_LOOKUPS.get(field) === lookup) FIELD_LOOKUPS.delete(field);
	});
	return lookup;
}

/**
 * lookupIdField() for every catalog field of a form that may need it: the first error, else the notes together;
 * null when no field has anything to look up.
 */
export function lookupIdFields(prefix: string, kind: ExternalKind): Promise<FieldLookup> | null {
	const lookups = ExternalCatalog.groupsFor(kind)
		.map(g => lookupIdField(prefix, kind, g.key))
		.filter((lookup): lookup is Promise<FieldLookup> => lookup !== null);
	if (!lookups.length) return null;
	return Promise.all(lookups).then(found => ({
		error: found.find(x => x.error)?.error || '',
		note: found
			.map(x => x.note)
			.filter(Boolean)
			.join(' '),
	}));
}

// ------------------------------------------------------------ your server
// The app's optional server (server/worker.ts: a Cloudflare Worker, or make serve on this computer), when its
// address and key are saved on Import & export, does two things: its catalog proxy asks the catalogs whose APIs
// don't answer web pages (AudiobookDB, Audible, BookBrainz, ISFDB), and it keeps the copy devices sync with.
// Like the Hardcover token they are kept in this browser only (never in a backup); without them those catalogs
// are not asked. Hardcover is never asked through it, so the token never leaves for anywhere but Hardcover.
// The storage key is the one from when the server was only the proxy, so a server saved then is still found.
const SERVER_STORAGE_KEY = 'audiobook-catalog-proxy';
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
 * Keeps the server in this browser in the shape savedServer() reads, its address tidied, or with null removes the
 * saved one. A server savedServer() wouldn't read (an address that isn't one, no key) is not written.
 * Throws when the browser refuses to store it.
 * @returns whether a server is saved now
 */
export function saveServer(server: ServerSettings | null): boolean {
	if (!server) {
		localStorage.removeItem(SERVER_STORAGE_KEY);
		return false;
	}
	const url = serverAddress(server.url),
		key = server.key.trim();
	if (!url || !key) return false;
	localStorage.setItem(SERVER_STORAGE_KEY, JSON.stringify({url, key}));
	return true;
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
