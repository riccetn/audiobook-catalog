// The catalogs outside this one that books, editions, series and people have ids in: each Audible and
// Amazon site, Goodreads, Hardcover, AudiobookDB, Open Library, ISFDB, BookBrainz and Wikidata. The catalog keeps only the ids, under the catalog's key
// (`{"audible.com": "B0…", "goodreads": "4242"}`); each catalog's definition says how to make the address
// of an id and how to read the id back out of an address, for each kind of thing it has pages for.
import {Text} from './text.js';

export type ExternalKind = 'book' | 'edition' | 'series' | 'author' | 'narrator' | 'publisher';
/** How a catalog names one kind of thing. */
export interface KindPattern {
	/** a regular expression an id must match (an ASIN, a number, a slug, a name) */
	id: string;
	/** the address of an id: {id} is replaced by it, URL-encoded */
	url: string;
	/** other addresses that name the same id, tried before `url` */
	also?: string[];
	/** its ids are kept in capitals (ASINs) */
	upper?: boolean;
	/**
	 * what a kept id may be, when that is more than `id` allows (an ASIN of a
	 *   hand-made catalog may be shorter than ten letters and digits; an address only ever has ten)
	 */
	stored?: string;
	/**
	 * another id the catalog's pages may be kept under, when the usual one
	 *   can't be had: Hardcover's author is kept by its number, or by the name in its address while Hardcover
	 *   can't be asked for the number. An id is the usual one's when it matches both
	 */
	fallback?: KindPattern;
}
/** An external catalog. Its definition is plain data, so it could be stored like any other entry. */
export interface CatalogDefinition {
	/** what entries keep its ids under: "audible.co.uk", "goodreads" */
	key: string;
	/** what the page calls it */
	name: string;
	/** the catalogs one form field stands for ("audible" for every Audible site) */
	group: string;
	/**
	 * catalogs whose ids name the same thing: every Audible and Amazon site is "asin",
	 *   as an ASIN is the same edition whichever site has it
	 */
	family: string;
	description: string;
	kinds: Partial<Record<ExternalKind, KindPattern>>;
}
/** a form field's catalogs, and the one a bare id is of */
export type CatalogGroup = {key: string; name: string; default: string};
export type ExternalId = {catalog: string; id: string};

// Patterns: an address is written as the page would link it, and reading one is forgiving: http or https,
// "www." or "m." or neither, and whatever follows the id (a "?ref=…", a "#…") may be there or not.
// In a pattern, "*" is any text within one part of the path and "**/" any number of parts.
const ASIN = '[A-Za-z0-9]{10}',
	ANY_ASIN = '[A-Za-z0-9]+';
const NUMBER = '\\d+';
const SLUG = '[A-Za-z0-9][A-Za-z0-9-]*';
const NAME = '.+';
// AudiobookDB's ids are twelve letters and digits, and their case matters ("37kLciJjQmfe")
const AUDIOBOOKDB_ID = '[A-Za-z0-9]{12}';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** an Open Library id: OL, a number and the letter of its kind (W, M or A) */
const OPEN_LIBRARY: (letter: string) => string = letter => `OL\\d+${letter}`;
/** a Wikidata item, whatever it is */
const WIKIDATA_ITEM: KindPattern = {
	id: 'Q\\d+',
	upper: true,
	url: 'https://www.wikidata.org/wiki/{id}',
	also: ['https://www.wikidata.org/entity/{id}'],
};

// Audible's stores and their sites; an Amazon site per store, and a few without one.
const AUDIBLE_STORES: Record<string, string> = {
	us: 'audible.com',
	uk: 'audible.co.uk',
	de: 'audible.de',
	fr: 'audible.fr',
	it: 'audible.it',
	es: 'audible.es',
	ca: 'audible.ca',
	au: 'audible.com.au',
	in: 'audible.in',
	jp: 'audible.co.jp',
};
const AMAZON_SITES = [
	...Object.values(AUDIBLE_STORES).map(site => site.replace(/^audible\./, 'amazon.')),
	'amazon.se',
	'amazon.nl',
	'amazon.pl',
	'amazon.com.br',
	'amazon.com.mx',
];

function audible(site: string): CatalogDefinition {
	const at = `https://www.${site}`;
	return {
		key: site,
		name: site,
		group: 'audible',
		family: 'asin',
		description: `Audible's store at ${site}: an edition's, series' or author's ASIN; narrators and publishers by name (Audible searches for them)`,
		kinds: {
			edition: {
				id: ASIN,
				upper: true,
				stored: ANY_ASIN,
				url: `${at}/pd/{id}`,
				also: [`${at}/**/pd/**/{id}`, `${at}/**/dp/**/{id}`, `${at}/**/product/**/{id}`],
			},
			series: {id: ASIN, upper: true, url: `${at}/series/{id}`, also: [`${at}/series/*/{id}`]},
			author: {id: ASIN, upper: true, url: `${at}/author/{id}`, also: [`${at}/author/*/{id}`]},
			narrator: {id: NAME, url: `${at}/search?searchNarrator={id}`},
			publisher: {id: NAME, url: `${at}/search?searchProvider={id}`},
		},
	};
}

function amazon(site: string): CatalogDefinition {
	const at = `https://www.${site}`;
	return {
		key: site,
		name: site,
		group: 'amazon',
		family: 'asin',
		description: `Amazon's store at ${site}: an edition's or author's ASIN`,
		kinds: {
			edition: {
				id: ASIN,
				upper: true,
				stored: ANY_ASIN,
				url: `${at}/dp/{id}`,
				also: [`${at}/**/dp/**/{id}`, `${at}/**/product/**/{id}`],
			},
			author: {
				id: ASIN,
				upper: true,
				url: `${at}/stores/author/{id}`,
				also: [`${at}/stores/*/author/{id}`, `${at}/**/e/{id}`],
			},
		},
	};
}

/**
 * A Hardcover page by its number (hardcover.app/id/author/12, which Hardcover sends on to the page's
 * address), or by the name in that address (hardcover.app/authors/ann-vale) as a fallback.
 * @param model what Hardcover calls it in an address by id
 * @param path the start of its page's address
 */
function hardcoverById(model: string, path: string): KindPattern {
	return {
		id: NUMBER,
		url: `https://hardcover.app/id/${model}/{id}`,
		also: [`https://hardcover.app/id/${model.replace(/s?$/, 's')}/{id}`],
		fallback: {id: SLUG, url: `https://hardcover.app/${path}/{id}`},
	};
}

const DEFINITIONS: CatalogDefinition[] = [
	...Object.values(AUDIBLE_STORES).map(audible),
	...AMAZON_SITES.map(amazon),
	{
		key: 'goodreads',
		name: 'Goodreads',
		group: 'goodreads',
		family: 'goodreads',
		description:
			'Goodreads: a book (its work, all its editions), an edition (what Goodreads calls a book), a series, an author (narrators are listed as authors)',
		kinds: {
			book: {
				id: NUMBER,
				url: 'https://www.goodreads.com/work/editions/{id}',
				also: [
					'https://www.goodreads.com/work/editions/{id}-*',
					'https://www.goodreads.com/work/editions/{id}.*',
				],
			},
			edition: {
				id: NUMBER,
				url: 'https://www.goodreads.com/book/show/{id}',
				also: ['https://www.goodreads.com/book/show/{id}-*', 'https://www.goodreads.com/book/show/{id}.*'],
			},
			series: {
				id: NUMBER,
				url: 'https://www.goodreads.com/series/{id}',
				also: [
					'https://www.goodreads.com/series/{id}-*',
					'https://www.goodreads.com/series/show/{id}',
					'https://www.goodreads.com/series/show/{id}-*',
				],
			},
			author: {
				id: NUMBER,
				url: 'https://www.goodreads.com/author/show/{id}',
				also: ['https://www.goodreads.com/author/show/{id}-*', 'https://www.goodreads.com/author/show/{id}.*'],
			},
			narrator: {
				id: NUMBER,
				url: 'https://www.goodreads.com/author/show/{id}',
				also: ['https://www.goodreads.com/author/show/{id}-*', 'https://www.goodreads.com/author/show/{id}.*'],
			},
		},
	},
	{
		key: 'hardcover',
		name: 'Hardcover',
		group: 'hardcover',
		family: 'hardcover',
		description:
			"Hardcover: a book, edition, series, author, narrator or publisher by its number (its address by id keeps working when it is renamed); a series or person by the name in its address while Hardcover can't be asked for the number",
		kinds: {
			book: {
				id: NUMBER,
				url: 'https://hardcover.app/id/book/{id}',
				also: ['https://hardcover.app/id/books/{id}'],
			},
			edition: {
				id: NUMBER,
				url: 'https://hardcover.app/id/edition/{id}',
				also: ['https://hardcover.app/id/editions/{id}', 'https://hardcover.app/books/*/editions/{id}'],
			},
			series: hardcoverById('series', 'series'),
			author: hardcoverById('author', 'authors'),
			narrator: hardcoverById('author', 'authors'),
			publisher: hardcoverById('publisher', 'publishers'),
		},
	},
	// AudiobookDB's API sends no CORS headers, so a page can only link to it.
	{
		key: 'audiobookdb',
		name: 'AudiobookDB',
		group: 'audiobookdb',
		family: 'audiobookdb',
		description:
			'AudiobookDB, a community catalog of audiobooks: a book, an edition (what AudiobookDB calls a release), a series, an author or narrator (both are people there), a publisher, each by its id',
		kinds: {
			book: {id: AUDIOBOOKDB_ID, url: 'https://audiobookdb.org/books/{id}'},
			edition: {id: AUDIOBOOKDB_ID, url: 'https://audiobookdb.org/releases/{id}'},
			series: {id: AUDIOBOOKDB_ID, url: 'https://audiobookdb.org/series/{id}'},
			author: {id: AUDIOBOOKDB_ID, url: 'https://audiobookdb.org/people/{id}'},
			narrator: {id: AUDIOBOOKDB_ID, url: 'https://audiobookdb.org/people/{id}'},
			publisher: {id: AUDIOBOOKDB_ID, url: 'https://audiobookdb.org/publishers/{id}'},
		},
	},
	// The open catalogs: their data is free to use, and they have APIs a later lookup could use.
	{
		key: 'openlibrary',
		name: 'Open Library',
		group: 'openlibrary',
		family: 'openlibrary',
		description:
			"Open Library, the Internet Archive's open catalog: a book's work (OL…W), an edition (OL…M), an author (OL…A)",
		kinds: {
			book: {id: OPEN_LIBRARY('W'), upper: true, url: 'https://openlibrary.org/works/{id}'},
			edition: {id: OPEN_LIBRARY('M'), upper: true, url: 'https://openlibrary.org/books/{id}'},
			author: {id: OPEN_LIBRARY('A'), upper: true, url: 'https://openlibrary.org/authors/{id}'},
		},
	},
	{
		key: 'isfdb',
		name: 'ISFDB',
		group: 'isfdb',
		family: 'isfdb',
		description:
			'The Internet Speculative Fiction Database: a book (a title), an edition (a publication), a series, an author, a publisher, each by its number',
		kinds: {
			book: {id: NUMBER, url: 'https://www.isfdb.org/cgi-bin/title.cgi?{id}'},
			edition: {id: NUMBER, url: 'https://www.isfdb.org/cgi-bin/pl.cgi?{id}'},
			series: {id: NUMBER, url: 'https://www.isfdb.org/cgi-bin/pe.cgi?{id}'},
			author: {id: NUMBER, url: 'https://www.isfdb.org/cgi-bin/ea.cgi?{id}'},
			publisher: {id: NUMBER, url: 'https://www.isfdb.org/cgi-bin/publisher.cgi?{id}'},
		},
	},
	{
		key: 'bookbrainz',
		name: 'BookBrainz',
		group: 'bookbrainz',
		family: 'bookbrainz',
		description:
			"BookBrainz, MetaBrainz's open book database: a book (a work), an edition, a series, an author or narrator, a publisher, each by its id (a UUID)",
		kinds: {
			book: {id: UUID, url: 'https://bookbrainz.org/work/{id}'},
			edition: {id: UUID, url: 'https://bookbrainz.org/edition/{id}'},
			series: {id: UUID, url: 'https://bookbrainz.org/series/{id}'},
			author: {id: UUID, url: 'https://bookbrainz.org/author/{id}'},
			narrator: {id: UUID, url: 'https://bookbrainz.org/author/{id}'},
			publisher: {id: UUID, url: 'https://bookbrainz.org/publisher/{id}'},
		},
	},
	// Wikidata's items don't say what they are in their address, and few audiobook editions have one, so
	// it gives no edition ids: an item pasted in an edition's field would be taken for the book's.
	{
		key: 'wikidata',
		name: 'Wikidata',
		group: 'wikidata',
		family: 'wikidata',
		description: 'Wikidata: the item (Q…) of a book, a series, an author, a narrator or a publisher',
		kinds: {
			book: WIKIDATA_ITEM,
			series: WIKIDATA_ITEM,
			author: WIKIDATA_ITEM,
			narrator: WIKIDATA_ITEM,
			publisher: WIKIDATA_ITEM,
		},
	},
];

const GROUPS: CatalogGroup[] = [
	{key: 'audible', name: 'Audible', default: 'audible.com'},
	{key: 'amazon', name: 'Amazon', default: 'amazon.com'},
	{key: 'goodreads', name: 'Goodreads', default: 'goodreads'},
	{key: 'hardcover', name: 'Hardcover', default: 'hardcover'},
	{key: 'audiobookdb', name: 'AudiobookDB', default: 'audiobookdb'},
	{key: 'openlibrary', name: 'Open Library', default: 'openlibrary'},
	{key: 'isfdb', name: 'ISFDB', default: 'isfdb'},
	{key: 'bookbrainz', name: 'BookBrainz', default: 'bookbrainz'},
	{key: 'wikidata', name: 'Wikidata', default: 'wikidata'},
];

const BY_KEY: Map<string, CatalogDefinition> = new Map(DEFINITIONS.map(def => [def.key, def]));
// An Audible or Amazon site's address, as an ASIN's site is kept: a site not listed is still an ASIN's.
const ASIN_SITE = /^(?:audible|amazon)\.(?:[a-z]{2,3}|com?\.[a-z]{2})$/;

/**
 * A pattern as a regular expression that reads an address, with the id as its first group.
 * @param id the id's own pattern
 */
function compile(pattern: string, id: string): {re: RegExp; query: boolean} {
	const m = /^https?:\/\/(?:www\.)?([^/?#]+)(\/[^?#]*)?(?:\?(.*))?$/.exec(pattern);
	if (!m) throw new Error(`not an address pattern: ${pattern}`);
	const [, host, path = '', query] = m;
	const pathRe: (part: string) => string = part =>
		part
			.split(/(\*\*\/|\*|\{id\})/)
			.map(t =>
				t === '**/' ? '(?:[^/?#]+/)*' : t === '*' ? '[^/?#]*' : t === '{id}' ? `(${id})` : Text.escapeRegExp(t),
			)
			.join('');
	let re = '^(?:https?://)?(?:www\\.|m\\.)?' + Text.escapeRegExp(host) + pathRe(path);
	if (query === undefined) re += '(?=[/?#]|$)';
	// the whole query is the id (ISFDB's "title.cgi?194342", often written with a "=" after it)
	else if (query === '{id}') return {re: new RegExp(re + `\\?(${id})=?(?:[&#].*)?$`, 'i'), query: false};
	else {
		// a search's id is one of its parameters, wherever it is among them
		const [name] = query.split('=');
		re += `/?\\?(?:[^#]*&)?${Text.escapeRegExp(name)}=([^&#]+)`;
	}
	return {re: new RegExp(re + '(?:[/?#&].*)?$', 'i'), query: query !== undefined};
}

/**
 * The pattern (a kind's own, or its fallback) an id is kept under; null when it is neither's.
 */
function patternOf(pattern: KindPattern, id: string): KindPattern | null {
	for (const of of [pattern, pattern.fallback]) {
		if (of && new RegExp(`^(?:${of.stored || of.id})$`, of.upper ? 'i' : '').test(id)) return of;
	}
	return null;
}

/** each catalog's and kind's patterns, compiled once */
const COMPILED: Map<string, {re: RegExp; query: boolean}[]> = new Map();

/** The external catalogs; every method is static. */
export class ExternalCatalog {
	static ALL: CatalogDefinition[] = DEFINITIONS;
	static GROUPS = GROUPS;
	static KINDS: ExternalKind[] = ['book', 'edition', 'series', 'author', 'narrator', 'publisher'];
	static AUDIBLE_STORES = AUDIBLE_STORES;
	static AUDIBLE_SITE = 'audible.com';
	static AMAZON_SITE = 'amazon.com';
	static ASIN_SITE = ASIN_SITE;
	// The sites an edition may have an ASIN field for (each Audible store's, and Amazon's).
	// The sites the book form offers an ASIN field for: each Audible store's site and its Amazon twin, then
	// the Amazon sites without an Audible store.
	static ASIN_SITES = [
		...new Set([
			...Object.values(AUDIBLE_STORES).flatMap(site => [site, site.replace(/^audible\./, 'amazon.')]),
			...AMAZON_SITES,
		]),
	];

	static get(key: string): CatalogDefinition | null {
		return BY_KEY.get(key) || null;
	}

	/**
	 * The catalog's name as the page shows it; the key itself for one this app doesn't know.
	 */
	static name(key: string): string {
		const def = BY_KEY.get(key);
		return def ? def.name : key;
	}

	/**
	 * The family of a catalog's ids: an ASIN is "asin" on every Audible and Amazon site (also one not
	 * listed), and other catalogs are their own.
	 */
	static family(key: string): string {
		const def = BY_KEY.get(key);
		return def ? def.family : ASIN_SITE.test(key) ? 'asin' : key;
	}

	/**
	 * @returns the form field the catalog's ids go in
	 */
	static groupOf(key: string): CatalogGroup | null {
		const def = BY_KEY.get(key),
			group = def ? def.group : ASIN_SITE.test(key) ? key.split('.')[0] : null;
		return GROUPS.find(g => g.key === group) || null;
	}

	/**
	 * The keys of a group's catalogs ("audible": every Audible site), in the usual order.
	 */
	static keysOf(group: string): string[] {
		return DEFINITIONS.filter(def => def.group === group).map(def => def.key);
	}

	/**
	 * The catalogs that have pages for a kind of thing, in the usual order.
	 */
	static forKind(kind: ExternalKind): CatalogDefinition[] {
		return DEFINITIONS.filter(def => def.kinds[kind]);
	}

	/**
	 * The groups with a catalog that has pages for a kind of thing (a form's fields for it).
	 */
	static groupsFor(kind: ExternalKind): CatalogGroup[] {
		return GROUPS.filter(g => DEFINITIONS.some(def => def.group === g.key && def.kinds[kind]));
	}

	/**
	 * Whether an id is one the catalog can have for this kind of thing.
	 */
	static isId(key: string, kind: ExternalKind, id: unknown): boolean {
		const def = BY_KEY.get(key),
			pattern = def && def.kinds[kind];
		if (!pattern)
			return (
				ASIN_SITE.test(key) &&
				kind === 'edition' &&
				typeof id === 'string' &&
				new RegExp(`^${ANY_ASIN}$`).test(id)
			);
		return typeof id === 'string' && patternOf(pattern, id) !== null;
	}

	/**
	 * Whether an id is the catalog's fallback for this kind of thing (a Hardcover author kept by the name in
	 * its address, not its number), which is worth looking up for the usual one.
	 */
	static isFallbackId(key: string, kind: ExternalKind, id: unknown): boolean {
		const def = BY_KEY.get(key),
			pattern = def && def.kinds[kind];
		return !!pattern && typeof id === 'string' && patternOf(pattern, id) === pattern.fallback;
	}

	/**
	 * The address of an id; null when the catalog has no pages for that kind (or is not one this app knows).
	 */
	static url(key: string, kind: ExternalKind, id: string): string | null {
		const def = BY_KEY.get(key),
			pattern = def && def.kinds[kind];
		if (!pattern || !id) return null;
		// a fallback id's page is its own (Hardcover's by name); anything else is put in the usual address
		return (patternOf(pattern, id) || pattern).url.replace('{id}', encodeURIComponent(id));
	}

	/**
	 * The catalog whose site an address is on (its group's key: 'audible' for any Audible site), whatever
	 * page it is; null when it is not an address on one of them.
	 */
	static siteOf(text: unknown): string | null {
		const m = /^(?:https?:\/\/)?(?:www\.|m\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?:[/?#]|$)/i.exec(
			String(text || '').trim(),
		);
		if (!m) return null;
		const host = m[1].toLowerCase();
		for (const def of DEFINITIONS) {
			const urls = Object.values(def.kinds).flatMap(p => (p ? [p.url] : []));
			if (urls.some(u => new URL(u.replace(/\{id\}/g, 'x')).hostname.replace(/^www\./, '') === host))
				return def.group;
		}
		return null;
	}

	/**
	 * The id an address names, and its catalog: {catalog: 'goodreads', id: '4242'} for
	 * goodreads.com/book/show/4242-the-salt-road as an edition. With `keys`, only those catalogs are tried.
	 * null when no catalog's patterns read it.
	 */
	static fromAddress(text: unknown, kind: ExternalKind, keys?: string[]): ExternalId | null {
		const value = String(text || '').trim();
		if (!/^(?:https?:\/\/)?(?:www\.|m\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+[/?]/i.test(value)) return null;
		for (const def of DEFINITIONS) {
			const pattern = def.kinds[kind];
			if (!pattern || (keys && !keys.includes(def.key))) continue;
			const cacheKey = def.key + ' ' + kind;
			let compiled = COMPILED.get(cacheKey);
			// the usual id's addresses first, then the fallback's
			if (!compiled)
				COMPILED.set(
					cacheKey,
					(compiled = [pattern, ...(pattern.fallback ? [pattern.fallback] : [])].flatMap(of =>
						[...(of.also || []), of.url].map(p => compile(p, of.id)),
					)),
				);
			for (const {re, query} of compiled) {
				const m = re.exec(value);
				if (!m) continue;
				let id = m[1];
				if (query) {
					try {
						id = decodeURIComponent(id.replace(/\+/g, ' '));
					} catch {
						continue;
					}
					id = Text.tidy(id);
				}
				if (pattern.upper) id = id.toUpperCase();
				if (id && ExternalCatalog.isId(def.key, kind, id)) return {catalog: def.key, id};
			}
		}
		return null;
	}

	/**
	 * What a form field for a group of catalogs holds, read: the address of a page on one of them, or a
	 * bare id, which is the group's default catalog's ({catalog: 'audible.com', id: 'B0…'}). null when it is
	 * neither (an address on another site, an id that isn't one).
	 * @param group the group's key ("audible"), or a catalog's key for that catalog alone
	 */
	static readId(text: unknown, kind: ExternalKind, group: string): ExternalId | null {
		const value = Text.tidy(String(text || ''));
		const g = GROUPS.find(x => x.key === group);
		const keys = g ? ExternalCatalog.keysOf(g.key) : [group];
		const found = ExternalCatalog.fromAddress(value, kind, keys);
		if (found) return found;
		// an address the patterns can't read is not an id, even where a name is (an Audible narrator's)
		if (/^(?:https?:\/\/|(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\/)/i.test(value)) return null;
		const key = g ? g.default : group,
			def = BY_KEY.get(key),
			pattern = def && def.kinds[kind];
		const id = pattern && pattern.upper ? value.toUpperCase() : value;
		return ExternalCatalog.isId(key, kind, id) ? {catalog: key, id} : null;
	}

	/**
	 * What a group's form field shows for the ids of an entry: the id on the group's default catalog, else
	 * the address of the one it has (so the site is not lost), else ''.
	 */
	static fieldText(ids: Record<string, string>, kind: ExternalKind, group: string): string {
		const g = GROUPS.find(x => x.key === group);
		if (!g) return ids[group] || '';
		if (ids[g.default]) return ids[g.default];
		const key = Object.keys(ids).find(k => {
			const of = ExternalCatalog.groupOf(k);
			return of && of.key === g.key;
		});
		return key ? ExternalCatalog.url(key, kind, ids[key]) || ids[key] : '';
	}

	/**
	 * Ids by catalog in the usual order (the catalogs as ALL lists them, then any other by key), as a
	 * stored entry keeps them; null when there are none. Values that are not text are kept, for the Check.
	 */
	static order(ids: Record<string, unknown>): Record<string, any> | null {
		const keys = Object.keys(ids).filter(k => k && ids[k] !== undefined);
		const at = (k: string) => {
			const i = DEFINITIONS.findIndex(def => def.key === k);
			return i < 0 ? DEFINITIONS.length : i;
		};
		keys.sort((x, y) => at(x) - at(y) || (x < y ? -1 : x > y ? 1 : 0));
		return keys.length ? Object.fromEntries(keys.map(k => [k, ids[k]])) : null;
	}

	/**
	 * Whether stored ids are what an entry keeps: an object of catalog -> non-empty text.
	 */
	static isIds(v: unknown): v is Record<string, string> {
		return (
			Text.isObject(v) &&
			Object.keys(v).length > 0 &&
			Object.entries(v).every(([k, x]) => k && typeof x === 'string' && x.trim() !== '')
		);
	}

	/**
	 * Stored ids tidied: catalog keys in lower case, ids without stray spacing (ASINs in capitals), in the usual order.
	 */
	static tidy(ids: Record<string, unknown>): Record<string, unknown> {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(ids)) {
			const key = Text.tidy(k).toLowerCase();
			out[key] = typeof v === 'string' ? Text.tidy(v) : v;
		}
		return ExternalCatalog.order(out) || {};
	}

	/**
	 * What is wrong with stored ids of a kind of thing, as lines for the Check: not an object, a catalog this
	 * app doesn't know (a warning), an id that isn't one.
	 */
	static problems(ids: unknown, kind: ExternalKind): {errors: string[]; warnings: string[]} {
		const errors: string[] = [];
		const warnings: string[] = [];
		if (!Text.isObject(ids) || !Object.keys(ids).length) {
			errors.push(`'ext' must map external catalogs to ids, e.g. {"audible.com": "B0...", "goodreads": "4242"}`);
			return {errors, warnings};
		}
		for (const [k, v] of Object.entries(ids)) {
			if (typeof v !== 'string' || !v.trim()) {
				errors.push(`the id on ${Text.repr(k)} must be a non-empty string`);
				continue;
			}
			const def = BY_KEY.get(k);
			if (!def && !(ASIN_SITE.test(k) && kind === 'edition'))
				warnings.push(`${Text.repr(k)} is not an external catalog this app knows`);
			else if (def && !def.kinds[kind]) errors.push(`${def.name} has no ${kind} pages, so no ${kind} id`);
			else if (!ExternalCatalog.isId(k, kind, v.trim()))
				errors.push(
					`${Text.repr(v)} is not ${ExternalCatalog.name(k)}'s id of ${/^[aeiou]/.test(kind) ? 'an' : 'a'} ${kind}`,
				);
		}
		return {errors, warnings};
	}
}
