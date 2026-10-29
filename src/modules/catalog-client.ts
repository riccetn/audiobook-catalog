// What every client of an external catalog's API shares: the fetch and pause it is given (so the tests give it
// fakes), the wait between requests, and your key for that catalog. A key (Hardcover calls its key a token) is
// kept in this browser only, never in a backup; store.ts reads and saves it by the client class's KEY_STORAGE,
// and the Import & export page shows its field by the class's KEY_NAME and KEY_HELP, so no page names a catalog.
import {Text} from './text.js';

/** reports a run's progress */
export type Step = (text: string, done?: number, total?: number) => void;
/**
 * Asks a catalog: `address` is its API's address, or for a catalog asked through the catalog proxy the route
 * (`audiobookdb/<path>`). Through the proxy, `init.key` is your key for the catalog, and `init.body` makes it a POST.
 */
export type CatalogFetch = (
	address: string,
	init?: {method?: string; body?: string; headers?: Record<string, string>; key?: string},
) => Promise<Response>;
/** waits `ms` milliseconds */
export type Pause = (ms: number) => Promise<unknown>;
/**
 * A client class, as the pages make one (store.ts catalogClient): its constructor and what it says of its catalog.
 */
export type ClientClass<C extends CatalogClient = CatalogClient> = (new (
	get: CatalogFetch,
	key: string,
	pause: Pause,
	gap?: number,
) => C) &
	Omit<typeof CatalogClient, 'prototype'>;

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
	 */
	static cleanKey(key: unknown): string {
		return Text.tidy(String(key || ''));
	}

	get: CatalogFetch;
	key: string;
	pause: Pause;
	gap: number;
	asked: number;

	/**
	 * A client that asks through `get`, with `key` (your key, '' for none), calling `pause(gap)` between requests.
	 * @param gap milliseconds between requests; the class's PAUSE_MS when left out
	 */
	constructor(get: CatalogFetch, key: string, pause: Pause, gap?: number) {
		const of = this.kind;
		this.get = get;
		this.key = of.cleanKey(key);
		this.pause = pause;
		this.gap = gap === undefined ? of.PAUSE_MS : gap;
		this.asked = 0;
	}

	/** @returns the client's class, with what it says of its catalog */
	get kind(): typeof CatalogClient {
		return this.constructor as typeof CatalogClient;
	}

	/** @returns its catalog's name, as the page says it */
	get label(): string {
		return this.kind.LABEL;
	}

	/** Wait between one request and the next (not before the first). */
	async waitTurn() {
		if (this.asked++) await this.pause(this.gap);
	}

	/**
	 * Step `step` through `items`, asking `ask` of each, with how far it has got.
	 */
	static async each<T, U>(items: T[], text: string, step: Step, ask: (item: T) => Promise<U>): Promise<U[]> {
		const out: U[] = [];
		for (let i = 0; i < items.length; i++) {
			step(text, i, items.length);
			out.push(await ask(items[i]));
		}
		return out;
	}
}
