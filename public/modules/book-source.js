// What every external catalog the book form's *Fill in from another catalog* asks shares (CatalogLookup asks
// them): what it reads out of a pasted address (read), which pasted ids it can look up (answers), the lookup
// (lookup), and what it needs to be asked (a key, the catalog proxy). CatalogLookup knows only this class, so
// a catalog is added by writing its source and listing it in CatalogConnectors.SOURCES. Nothing here changes
// the catalog; the requests are passed in, so the tests run it offline.
import {Text} from './text.js';
import {CatalogClient} from './catalog-client.js';
/** @import {Unchecked} from './text.js' */
/** @import {Book} from './book.js' */

/** @typedef {(url: string) => Promise<{ok: boolean, status: number, json: () => Promise<unknown>}>} Get a fetch of an address */
/**
 * What was pasted: an ISBN, or an id in an external catalog of a book or an edition (`slug` for a Hardcover
 * book's page, whose id only Hardcover knows).
 * @typedef {{catalog: string, kind: 'book' | 'edition' | 'isbn', id: string, slug?: string}} Pasted
 */
/**
 * What a lookup found: the book (with one edition at most), the catalogs that gave it, and what could not be
 * asked and why.
 * @typedef {{book: Book, sources: string[], notes: string[]}} Found
 */
/**
 * What a lookup asks through: `get` for catalogs that answer web pages, `clients` (those of catalogs whose key is
 * saved: Hardcover's with your token), and `proxy`, the catalog proxy given a route
 * (`audible/audible.com/catalog/products/B0…`), null when none is saved.
 * @typedef {{get: Get, clients: CatalogClient[], proxy: Get | null}} LookupContext
 */
/**
 * How a source answers a pasted id: `own` (an id of its own catalog), `also` (asked beside the others),
 * `fallback` (asked only when no other has it); null when it can't.
 * @typedef {'own' | 'also' | 'fallback' | null} Answers
 */

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
	static NAMES = /** @type {string[]} */ ([]);
	/** What it needs to be asked: nothing (''), the catalog proxy ('proxy'), or your key for it ('key', with CLIENT's KEY_NAME). */
	static NEEDS = /** @type {'' | 'proxy' | 'key'} */ ('');
	/** The client class of its catalog, for its key's name. */
	static CLIENT = CatalogClient;
	/** Whether it is asked for what the others lack (narrators, length), by the found edition's ASIN or ISBN. */
	static FILLS_IN = false;
	/** Whether a typed title (no address or id) is searched on it. */
	static SEARCHES = false;

	/** @param {LookupContext} context */
	constructor(context) {
		this.context = context;
	}

	/** @returns {typeof BookSource} the source's class, with what it says of its catalog */
	get kind() {
		return /** @type {typeof BookSource} */ (this.constructor);
	}

	/** @returns {string} its catalog's name, as the page says it */
	get label() {
		return this.kind.LABEL;
	}

	/** @returns {CatalogClient | null} the client of its catalog, when its key is saved */
	get client() {
		return this.context.clients.find(c => c instanceof this.kind.CLIENT) || null;
	}

	/** @returns {boolean} whether it can be asked: what it needs is saved */
	get available() {
		const needs = this.kind.NEEDS;
		return needs === 'proxy' ? Boolean(this.context.proxy) : needs === 'key' ? Boolean(this.client) : true;
	}

	/** @returns {string} what to save to ask it ('save a catalog proxy') */
	get needsText() {
		return BookSource.needing(this.kind);
	}

	/**
	 * What to save to ask a source of `kind` ('save a catalog proxy'); '' when it needs nothing.
	 * @param {typeof BookSource} kind
	 * @returns {string}
	 */
	static needing(kind) {
		return kind.NEEDS === 'proxy'
			? 'save a catalog proxy'
			: kind.NEEDS === 'key'
				? `save your ${kind.LABEL} ${kind.CLIENT.KEY_NAME}`
				: '';
	}

	/**
	 * What an address or bare id of its own catalog names that ExternalCatalog doesn't read (a bare id, a
	 * page only the catalog can turn into an id); null when it is none of them.
	 * @param {string} _value tidied
	 * @returns {Pasted | null}
	 */
	static read(_value) {
		return null;
	}

	/**
	 * How it answers `pasted` (see Answers): by default, its own catalog's ids.
	 * @param {Pasted} pasted
	 * @returns {Answers}
	 */
	answers(pasted) {
		return pasted.catalog === this.kind.CATALOG ? 'own' : null;
	}

	/**
	 * The book `pasted` names on this catalog. An id of its own it doesn't have throws, with a short reason;
	 * another catalog's id (an ISBN, an ASIN) it doesn't have is null.
	 * @param {Pasted} _pasted
	 * @param {Found} _found notes what it couldn't fill in
	 * @returns {Promise<Book | null>}
	 */
	async lookup(_pasted, _found) {
		throw new Error(`${this.label}: lookup is not written`);
	}

	/**
	 * The id of the book titled `title` (by one of `authors`, when given), for a source that SEARCHES.
	 * Throws, with a short reason, when there is none or there are several.
	 * @param {string} _title
	 * @param {string[]} _authors
	 * @returns {Promise<string>}
	 */
	async search(_title, _authors) {
		throw new Error(`${this.label} can't be searched by title`);
	}

	// ------------------------------------------------------------------ asking
	/**
	 * An answer of a catalog that answers web pages, at `url`.
	 * @param {string} url
	 * @returns {Promise<Unchecked | null>} the answer, null for a 404; throws with a short reason otherwise
	 */
	async json(url) {
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
	 * @param {string} route
	 * @param {boolean} [list] a list is wanted (a search's), not a book
	 * @returns {Promise<Unchecked | null>}
	 */
	async proxied(route, list = false) {
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
				'this browser could not reach the catalog proxy (offline, or check it on the Import & export page)',
				{cause: e},
			);
		}
		if (res.status === 401)
			throw new Error('the catalog proxy refused its key (check it on the Import & export page)');
		return BookSource.answer(this.label, res, list);
	}

	/**
	 * @param {string} source
	 * @param {Awaited<ReturnType<Get>>} res
	 * @param {boolean} [list] a list is wanted (a search's), not a book
	 * @returns {Promise<Unchecked | null>} what `res` holds, null for a 404; throws with a short reason otherwise
	 */
	static async answer(source, res, list = false) {
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
	 * @param {unknown} x
	 * @returns {string}
	 */
	static text(x) {
		return typeof x === 'string' ? Text.tidy(x) : '';
	}

	/**
	 * A date as catalogs write it ("1988", "October 1, 1988", "1 Oct 1988", "Oct 1988", "1988-10-01") in the
	 * catalog's form (YYYY-MM-DD, YYYY-MM or YYYY); null when it is none of them.
	 * @param {unknown} text
	 * @returns {string | null}
	 */
	static date(text) {
		const value = Text.tidy(String(text || ''))
			.replace(/[.,]/g, ' ')
			.replace(/\s+/g, ' ')
			.trim();
		const iso = Text.parseDate(value.replace(/T.*$/, ''));
		if (iso) return iso;
		const month = (/** @type {string} */ name) => {
			const i = MONTHS.findIndex(m => name.length >= 3 && m.startsWith(name.toLowerCase()));
			return i < 0 ? null : i + 1;
		};
		/** @type {(y: string, mo: number | null, d?: string) => string | null} */
		const make = (y, mo, d) => (mo ? Text.parseDate(d ? `${y}-${mo}-${d}` : `${y}-${mo}`) : null);
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
