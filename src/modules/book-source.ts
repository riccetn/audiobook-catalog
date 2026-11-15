// What every external catalog the Edit page's *Fill in from another catalog* asks shares (CatalogLookup asks
// them): what it reads out of a pasted address (read), which pasted ids it can look up (answers), the lookup
// (lookup), and what it needs to be asked (a key, the catalog proxy). CatalogLookup knows only this class, so
// a catalog is added by writing its source and listing it in CatalogConnectors.SOURCES. Nothing here changes
// the catalog; the requests are passed in, so the tests run it offline.
// A source may also know series, authors, narrators and publishers (ENTRIES): EntryLookup asks it for one by its
// id there (entry), or for those a name and its books point to (findEntries), to fill in what the catalog keeps
// about them.
import {Text, PhraseError} from './text.js';
import {CatalogClient} from './catalog-client.js';
import type {Unchecked, Phrase} from './text.js';
import type {Book} from './book.js';
import {ExternalCatalog} from './external-catalog.js';

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
export type Found = {book: Book; sources: string[]; notes: Phrase[]};
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

/** A series, or someone credited: what the catalog keeps info about beside its books. */
export type EntryKind = 'series' | 'author' | 'narrator' | 'publisher';
/**
 * What is kept about a series or a person, as far as a catalog can fill it in: a person's bio and site, a series'
 * books released so far and whether it is complete, the ids in external catalogs and links to other pages.
 */
export interface EntryInfo {
	bio?: string;
	url?: string;
	/** a count, or 'many' for a series kept as too long to count (no catalog answers that) */
	total?: number | 'many';
	status?: 'ongoing' | 'complete';
	external: Record<string, string>;
	links: string[];
}
/** Whom a source is asked about: the name the catalog has, and the books of theirs it has. */
export type EntryQuery = {kind: EntryKind; name: string; books: Book[]};
/**
 * A series or person as a catalog has it: `catalog` and `id` name its page there, `name` is what the catalog
 * calls it, `about` what tells it from others of its name, and `info` what it gives (with its own id). `by` says
 * how it was found: by an id the entry has ('id'), on one of its books ('books'), both of which are sure, or by
 * its name alone ('name'), which may be someone else of that name.
 */
export type EntryAnswer = {
	catalog: string;
	source: string;
	id: string;
	name: string;
	about: Phrase | null;
	by: 'id' | 'books' | 'name';
	info: EntryInfo;
};

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
	/** The kinds of series and people it can be asked about (entry, findEntries); none by default. */
	static ENTRIES = [] as readonly EntryKind[];
	/** How many of a name's namesakes findEntries gives at most, as each is one to tell apart. */
	static NAMESAKES = 3;

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
	get needsText(): Phrase | null {
		return BookSource.needing(this.kind);
	}

	/**
	 * What to save to ask a source of `kind` ('save your server'); null when it needs nothing.
	 */
	static needing(kind: typeof BookSource): Phrase | null {
		return kind.NEEDS === 'proxy'
			? Text.phrase('save your server')
			: kind.NEEDS === 'key'
				? Text.phrase('save your {catalog} {key}', {
						catalog: kind.LABEL,
						key: Text.phrase(kind.CLIENT.KEY_NAME),
					})
				: null;
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
		throw new PhraseError("{catalog} can't be searched by title", {catalog: this.label});
	}

	// ------------------------------------------------------------------ series and people
	/**
	 * The series or person with `id` in this catalog, with what it gives about them; null when the catalog has
	 * none, or has nothing to say of one. Throws with a short reason when it can't be asked.
	 * @param _id as the catalog's entries keep it (ExternalCatalog)
	 */
	async entry(_kind: EntryKind, _id: string): Promise<EntryAnswer | null> {
		return null;
	}

	/**
	 * The series or people this catalog has for a name the catalog has no id of here: the one its books there
	 * name (found by the ids the books and their editions have in this catalog, `by` 'books'), else those of
	 * that name (`by` 'name', NAMESAKES at most). Throws with a short reason when it can't be asked.
	 */
	async findEntries(_query: EntryQuery): Promise<EntryAnswer[]> {
		return [];
	}

	/**
	 * An answer of this source: the entry `id` here, with `info` (its own id is added to the ids; ids no catalog
	 * takes for this kind are left out, and so are empty values).
	 */
	answerOf(
		kind: EntryKind,
		id: string,
		name: string,
		by: EntryAnswer['by'],
		info: Partial<EntryInfo> = {},
		about: Phrase | null = null,
		catalog: string = this.kind.CATALOG,
	): EntryAnswer {
		const external: Record<string, string> = {};
		for (const [key, value] of Object.entries({[catalog]: id, ...info.external}))
			if (ExternalCatalog.isId(key, kind, value)) external[key] = value;
		// a link that is their page in a catalog is kept as their id there, as the catalog's entries keep it
		const links: string[] = [];
		for (const link of Text.tidyLinks(info.links || []) as string[]) {
			const page = ExternalCatalog.fromAddress(link, kind);
			if (!page) links.push(link);
			else external[page.catalog] ??= page.id;
		}
		const out: EntryInfo = {external, links};
		const bio = BookSource.paragraphs(info.bio);
		if (bio) out.bio = bio;
		const [url] = Text.tidyLinks([info.url || '']) as string[];
		if (url) out.url = url;
		if (typeof info.total === 'number' && Number.isInteger(info.total) && info.total > 0) out.total = info.total;
		if (info.status) out.status = info.status;
		return {catalog, source: this.label, id, name: Text.tidy(name), about, by, info: out};
	}

	/** Whether a catalog calls someone or a series what the catalog here does (spelling and case aside). */
	static sameName(theirs: unknown, mine: string): boolean {
		return typeof theirs === 'string' && Boolean(Text.norm(mine)) && Text.norm(theirs) === Text.norm(mine);
	}

	/** A text of several paragraphs as a bio keeps it: tidy lines, a blank line between paragraphs; '' when none. */
	static paragraphs(text: unknown): string {
		return typeof text === 'string'
			? text
					.split(/\r\n|\r|\n/)
					.map(Text.tidy)
					.join('\n')
					.replace(/\n{3,}/g, '\n\n')
					.trim()
			: '';
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
			throw new PhraseError(
				'this browser could not reach {catalog} (offline?)',
				{catalog: this.label},
				{cause: e},
			);
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
			throw new PhraseError("{catalog} can't be read from a web page; {needs} on the Import & export page", {
				catalog: this.label,
				needs: this.needsText || '',
			});
		let res;
		try {
			res = await proxy(route);
		} catch (e) {
			throw new PhraseError(
				'this browser could not reach your server (offline, or check it on the Import & export page)',
				{},
				{cause: e},
			);
		}
		if (res.status === 401)
			throw new PhraseError('your server refused its key (check it on the Import & export page)');
		return BookSource.answer(this.label, res, list);
	}

	/**
	 * @param list a list is wanted (a search's), not one thing
	 * @returns what `res` holds, null for a 404; throws with a short reason otherwise
	 */
	static async answer(
		source: string,
		res: Awaited<ReturnType<Get>>,
		list: boolean = false,
	): Promise<Unchecked | null> {
		if (res.status === 404) return null;
		if (!res.ok) throw new PhraseError('{catalog} answered {status}', {catalog: source, status: res.status});
		const json = await res.json().catch(() => null);
		if (list ? !Array.isArray(json) : !Text.isObject(json))
			throw new PhraseError("{catalog} sent an answer this app can't read", {catalog: source});
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
