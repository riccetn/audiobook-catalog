// What every client of an external catalog's API shares: the fetch and pause it is given (so the tests give it
// fakes), the wait between requests, and your key for that catalog. A key (Hardcover calls its key a token) is
// kept in this browser only, never in a backup; store.js reads and saves it by the client class's KEY_STORAGE,
// and the Import & export page shows its field by the class's KEY_NAME and KEY_HELP, so no page names a catalog.
import {Text} from './text.js';

/** @typedef {(text: string, done?: number, total?: number) => void} Step reports a run's progress */
/**
 * Asks a catalog: `address` is its API's address, or for a catalog asked through the catalog proxy the route
 * (`audiobookdb/<path>`). Through the proxy, `init.key` is your key for the catalog, and `init.body` makes it a POST.
 * @typedef {(address: string, init?: {method?: string, body?: string, headers?: Record<string, string>, key?: string}) => Promise<Response>} CatalogFetch
 */
/** @typedef {(ms: number) => Promise<unknown>} Pause waits `ms` milliseconds */
/**
 * A client class, as the pages make one (store.js catalogClient): its constructor and what it says of its catalog.
 * @template {CatalogClient} [C=CatalogClient]
 * @typedef {(new (get: CatalogFetch, key: string, pause: Pause, gap?: number) => C) & Omit<typeof CatalogClient, 'prototype'>} ClientClass
 */

/** Asks one external catalog's API, one request at a time; a subclass says how (ask) and what it asks. */
export class CatalogClient {
	/** Its catalog's key in ExternalCatalog ('hardcover'); also the prefix of its fields on Import & export. */
	static CATALOG = '';
	/** Its catalog's name, as the page says it ('Hardcover'). */
	static LABEL = '';
	/** The ids the catalog gives books, series and people. */
	static ID = /^$/;
	/** What the catalog calls your key ('API token' on Hardcover). */
	static KEY_NAME = 'API key';
	/** Where this browser keeps your key (localStorage). */
	static KEY_STORAGE = '';
	/** What the page says where no key is saved: where to make one, and what it is for. */
	static KEY_HELP = '';
	/** Whether nothing can be asked without your key (else only your shelves need it). */
	static KEY_NEEDED = true;
	/** Whether the catalog is asked through the catalog proxy, as its API doesn't answer web pages. */
	static VIA_PROXY = false;
	/** Milliseconds between requests, as the catalog allows. */
	static PAUSE_MS = 1000;

	/**
	 * A key as it was pasted, tidied the way the catalog takes it; '' when there is none.
	 * @param {unknown} key
	 * @returns {string}
	 */
	static cleanKey(key) {
		return Text.tidy(String(key || ''));
	}

	/**
	 * A client that asks through `get`, with `key` (your key, '' for none), calling `pause(gap)` between requests.
	 * @param {CatalogFetch} get
	 * @param {string} key
	 * @param {Pause} pause
	 * @param {number} [gap] milliseconds between requests; the class's PAUSE_MS when left out
	 */
	constructor(get, key, pause, gap) {
		const of = this.kind;
		this.get = get;
		this.key = of.cleanKey(key);
		this.pause = pause;
		this.gap = gap === undefined ? of.PAUSE_MS : gap;
		this.asked = 0;
	}

	/** @returns {typeof CatalogClient} the client's class, with what it says of its catalog */
	get kind() {
		return /** @type {typeof CatalogClient} */ (this.constructor);
	}

	/** @returns {string} its catalog's name, as the page says it */
	get label() {
		return this.kind.LABEL;
	}

	/** Wait between one request and the next (not before the first). */
	async waitTurn() {
		if (this.asked++) await this.pause(this.gap);
	}

	/**
	 * Step `step` through `items`, asking `ask` of each, with how far it has got.
	 * @template T, U
	 * @param {T[]} items
	 * @param {string} text
	 * @param {Step} step
	 * @param {(item: T) => Promise<U>} ask
	 * @returns {Promise<U[]>}
	 */
	static async each(items, text, step, ask) {
		/** @type {U[]} */
		const out = [];
		for (let i = 0; i < items.length; i++) {
			step(text, i, items.length);
			out.push(await ask(items[i]));
		}
		return out;
	}
}
