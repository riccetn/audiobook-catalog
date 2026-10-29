// What every external catalog the book form's *Fill in from another catalog* asks shares (CatalogLookup asks
// them): what it reads out of a pasted address (read), which pasted ids it can look up (answers), the lookup
// (lookup), and what it needs to be asked (a key, the catalog proxy). CatalogLookup knows only this class, so
// a catalog is added by writing its source and listing it in CatalogConnectors.SOURCES. Nothing here changes
// the catalog; the requests are passed in, so the tests run it offline.
import {Text} from './text.js';
import {CatalogClient} from './catalog-client.js';
import type {Unchecked} from './text.js';
import type {Book} from './book.js';

/** a fetch of an address */
export type Get = (url: string) => Promise<{ok: boolean; status: number; json: () => Promise<unknown>}>;
/**
 * What was pasted: an ISBN, or an id in an external catalog of a book or an edition (`slug` for a Hardcover
 * book's page, whose id only Hardcover knows).
 */
export type Pasted = {catalog: string; kind: 'book' | 'edition' | 'isbn'; id: string; slug?: string};
/**
 * What a lookup found: the book (with one edition at most), the catalogs that gave it, and what could not be
 * asked and why.
 */
export type Found = {book: Book; sources: string[]; notes: string[]};
/**
 * What a lookup asks through: `get` for catalogs that answer web pages, `clients` (those of catalogs whose key is
 * saved: Hardcover's with your token), and `proxy`, the catalog proxy given a route
 * (`audible/audible.com/catalog/products/B0…`), null when none is saved.
 */
export type LookupContext = {get: Get; clients: CatalogClient[]; proxy: Get | null};
/**
 * How a source answers a pasted id: `own` (an id of its own catalog), `also` (asked beside the others),
 * `fallback` (asked only when no other has it); null when it can't.
 */
export type Answers = 'own' | 'also' | 'fallback' | null;

const MONTHS = [
	'january',
	'february',
	'march',
	'april',
	'may',
	'june',
	'july',
	'august',
	'september',
	'october',
	'november',
	'december',
];

/** One external catalog that books can be looked up in; a subclass says which and how. */
export class BookSource {
	/** Its catalog's key in ExternalCatalog ('openlibrary'). */
	static CATALOG = '';
	/** Its catalog's name, as the page says it ('Open Library'). */
	static LABEL = '';
	/** The catalogs whose addresses it reads, as the page names them (Audible reads Amazon's too). */
	static NAMES = [] as string[];
	/** What it needs to be asked: nothing (''), the catalog proxy ('proxy'), or your key for it ('key', with CLIENT's KEY_NAME). */
	static NEEDS = '' as '' | 'proxy' | 'key';
	/** The client class of its catalog, for its key's name. */
	static CLIENT = CatalogClient;
	/** Whether it is asked for what the others lack (narrators, length), by the found edition's ASIN or ISBN. */
	static FILLS_IN = false;
	/** Whether a typed title (no address or id) is searched on it. */
	static SEARCHES = false;

	context: LookupContext;

	constructor(context: LookupContext) {
		this.context = context;
	}

	/** @returns the source's class, with what it says of its catalog */
	get kind(): typeof BookSource {
		return this.constructor as typeof BookSource;
	}

	/** @returns its catalog's name, as the page says it */
	get label(): string {
		return this.kind.LABEL;
	}

	/** @returns the client of its catalog, when its key is saved */
	get client(): CatalogClient | null {
		return this.context.clients.find(c => c instanceof this.kind.CLIENT) || null;
	}

	/** @returns whether it can be asked: what it needs is saved */
	get available(): boolean {
		const needs = this.kind.NEEDS;
		return needs === 'proxy' ? Boolean(this.context.proxy) : needs === 'key' ? Boolean(this.client) : true;
	}

	/** @returns what to save to ask it ('save your server') */
	get needsText(): string {
		return BookSource.needing(this.kind);
	}

	/**
	 * What to save to ask a source of `kind` ('save your server'); '' when it needs nothing.
	 */
	static needing(kind: typeof BookSource): string {
		return kind.NEEDS === 'proxy'
			? 'save your server'
			: kind.NEEDS === 'key'
				? `save your ${kind.LABEL} ${kind.CLIENT.KEY_NAME}`
				: '';
	}

	/**
	 * What an address or bare id of its own catalog names that ExternalCatalog doesn't read (a bare id, a
	 * page only the catalog can turn into an id); null when it is none of them.
	 * @param _value tidied
	 */
	static read(_value: string): Pasted | null {
		return null;
	}

	/**
	 * How it answers `pasted` (see Answers): by default, its own catalog's ids.
	 */
	answers(pasted: Pasted): Answers {
		return pasted.catalog === this.kind.CATALOG ? 'own' : null;
	}

	/**
	 * The book `pasted` names on this catalog. An id of its own it doesn't have throws, with a short reason;
	 * another catalog's id (an ISBN, an ASIN) it doesn't have is null.
	 * @param _found notes what it couldn't fill in
	 */
	async lookup(_pasted: Pasted, _found: Found): Promise<Book | null> {
		throw new Error(`${this.label}: lookup is not written`);
	}

	/**
	 * The id of the book titled `title` (by one of `authors`, when given), for a source that SEARCHES.
	 * Throws, with a short reason, when there is none or there are several.
	 */
	async search(_title: string, _authors: string[]): Promise<string> {
		throw new Error(`${this.label} can't be searched by title`);
	}

	// ------------------------------------------------------------------ asking
	/**
	 * An answer of a catalog that answers web pages, at `url`.
	 * @returns the answer, null for a 404; throws with a short reason otherwise
	 */
	async json(url: string): Promise<Unchecked | null> {
		let res;
		try {
			res = await this.context.get(url);
		} catch (e) {
			throw new Error(`this browser could not reach ${this.label} (offline?)`, {cause: e});
		}
		return BookSource.answer(this.label, res);
	}

	/**
	 * An answer through the catalog proxy (`route` is the catalog and the path in its API); null for a 404.
	 * @param list a list is wanted (a search's), not a book
	 */
	async proxied(route: string, list: boolean = false): Promise<Unchecked | null> {
		const proxy = this.context.proxy;
		if (!proxy)
			throw new Error(
				`${this.label} can't be read from a web page; ${this.needsText} on the Import & export page`,
			);
		let res;
		try {
			res = await proxy(route);
		} catch (e) {
			throw new Error(
				'this browser could not reach your server (offline, or check it on the Import & export page)',
				{cause: e},
			);
		}
		if (res.status === 401) throw new Error('your server refused its key (check it on the Import & export page)');
		return BookSource.answer(this.label, res, list);
	}

	/**
	 * @param list a list is wanted (a search's), not a book
	 * @returns what `res` holds, null for a 404; throws with a short reason otherwise
	 */
	static async answer(
		source: string,
		res: Awaited<ReturnType<Get>>,
		list: boolean = false,
	): Promise<Unchecked | null> {
		if (res.status === 404) return null;
		if (!res.ok) throw new Error(`${source} answered ${res.status}`);
		const json = await res.json().catch(() => null);
		if (list ? !Array.isArray(json) : !Text.isObject(json))
			throw new Error(`${source} sent something that isn't ${list ? 'a list of books' : 'a book'}`);
		return json;
	}

	// ------------------------------------------------------------------ reading answers
	/**
	 * A value read from a catalog's answer as text, tidied; '' when it isn't text.
	 */
	static text(x: unknown): string {
		return typeof x === 'string' ? Text.tidy(x) : '';
	}

	/**
	 * A date as catalogs write it ("1988", "October 1, 1988", "1 Oct 1988", "Oct 1988", "1988-10-01") in the
	 * catalog's form (YYYY-MM-DD, YYYY-MM or YYYY); null when it is none of them.
	 */
	static date(text: unknown): string | null {
		const value = Text.tidy(String(text || ''))
			.replace(/[.,]/g, ' ')
			.replace(/\s+/g, ' ')
			.trim();
		const iso = Text.parseDate(value.replace(/T.*$/, ''));
		if (iso) return iso;
		const month = (name: string) => {
			const i = MONTHS.findIndex(m => name.length >= 3 && m.startsWith(name.toLowerCase()));
			return i < 0 ? null : i + 1;
		};
		const make: (y: string, mo: number | null, d?: string) => string | null = (y, mo, d) =>
			mo ? Text.parseDate(d ? `${y}-${mo}-${d}` : `${y}-${mo}`) : null;
		let m = /^([a-z]+) (\d{1,2}) (\d{4})$/i.exec(value);
		if (m && month(m[1])) return make(m[3], month(m[1]), m[2]);
		m = /^(\d{1,2}) ([a-z]+) (\d{4})$/i.exec(value);
		if (m && month(m[2])) return make(m[3], month(m[2]), m[1]);
		m = /^([a-z]+) (\d{4})$/i.exec(value);
		if (m && month(m[1])) return make(m[2], month(m[1]));
		// a season, or words around the year
		m = /^(?:[a-z]+ )*(\d{4})$/i.exec(value);
		return m ? m[1] : null;
	}
}
