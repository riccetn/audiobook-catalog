// The catalogs outside this one that books, editions, series, people and places have ids in: each Audible and
// Amazon site, Goodreads, Hardcover, AudiobookDB, Open Library, ISFDB, BookBrainz and Wikidata. The catalog keeps only the ids, under the catalog's key
// (`{"audible.com": "B0…", "goodreads": "4242"}`); each catalog's definition says how to make the address
// of an id and how to read the id back out of an address, for each kind of thing it has pages for.
import {Text} from './text.js';
import type {Phrase} from './text.js';

export type ExternalKind = 'book' | 'edition' | 'series' | 'author' | 'narrator' | 'publisher' | 'place';
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
	/** another word an edition's text names it by ("gr 4242", from before catalogs were named in full) */
	alias?: string;
	/**
	 * a book's id here names the book whatever its editions, so an import finds a book by it (Hardcover's), and a
	 *   book of another id found by a shared edition is a box set
	 */
	matchesBooks?: boolean;
	/**
	 * the kinds whose id its client can be asked for (CatalogClient.lookupId) when a page's address doesn't hold it:
	 *   a book's page by its name, a series or person kept by the fallback id
	 */
	lookups?: ExternalKind[];
	/** where its covers are */
	cover?: CoverDefinition;
	/** the field a stored record kept its id under before ids were kept by catalog (database version 1): `goodreadsId` */
	oldField?: string;
}
export type CoverSize = 'small' | 'large';
/** Where a catalog's covers are; in an address {id}, {isbn} or {key} is replaced, URL-encoded, and {size} by `sizes`. */
export interface CoverDefinition {
	/** the address of the cover of an edition's id there */
	byId?: string;
	/** the address of the cover of an ISBN */
	byIsbn?: string;
	/** the address of a cover an edition keeps the key of (`img`), as its address can't be worked out from an id */
	byKey?: string;
	/** what such a key is (a regular expression) */
	key?: string;
	/** what the catalog's answers have before the key in an image's address */
	keyAt?: string;
	/** what {size} is for a card's cover and for the details' */
	sizes: Record<CoverSize, string>;
}
/** a form field's catalogs, and the one a bare id is of */
export type CatalogGroup = {
	key: string;
	name: string;
	default: string;
	/** the short mark its icon shows when its site's icon can't be loaded */
	mark: string;
	/** the mark's color */
	color: string;
	/** its icon's address, when its site's `/favicon.ico` is broken */
	favicon?: string;
	/**
	 * a stored author, narrator or publisher once kept the address of its page there under the group's key
	 *   (Contributor.fixLinks reads the id out of it)
	 */
	oldLink?: boolean;
};
/**
 * What the ids of a family of catalogs (CatalogDefinition.family) are called and can do; a family without a
 * definition of its own has only a name, its catalog's and "id".
 */
export interface FamilyDefinition {
	key: string;
	/** one of its ids in a sentence ("ASIN", "Goodreads id"), which is also what an edition's text writes before them */
	idName: string;
	/**
	 * its ids are the same edition's on several sites, so an edition shows them as one part, each after its site:
	 *   `default` the site a bare id is of, `site` what a site's key looks like (also one not listed), `id` a bare id as typed
	 */
	sites?: {default: string; site: RegExp; id: string};
	/**
	 * its edition ids keep books out of imports (the exclusions list): `name` what an entry writes before the id
	 *   ('' for the id alone), `also` other words read for it, `id` what an id is, `edition` what it is after
	 *   "Edition" when that is stricter, `upper` kept in capitals
	 */
	exclusion?: {name: string; also?: string[]; id: string; edition?: string; upper?: boolean};
	/** what a "Keep separate" mark's text writes before one of its ids (its key, when left out) */
	mark?: string;
	/** the field a stored edition kept its ids under, by site, before ids were kept by catalog (database version 1): `asins` */
	oldField?: string;
}
export type ExternalId = {catalog: string; id: string};

// Patterns: an address is written as the page would link it, and reading one is forgiving: http or https,
// "www." or "m." or neither, and whatever follows the id (a "?ref=…", a "#…") may be there or not.
// In a pattern, "*" is any text within one part of the path and "**/" any number of parts.
const ASIN = '[A-Za-z0-9]{10}',
	// an edition's ASIN as typed: up to ten letters and digits (hand-made catalogs kept shorter ones), at least
	// one a digit, so a word ("none", "audible") is none; a stored one may be any letters and digits (ANY_ASIN)
	EDITION_ASIN = '(?=[A-Za-z]*[0-9])[A-Za-z0-9]{1,10}',
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

// An ASIN's cover is Amazon's image of it (an audiobook's square cover), whichever site the ASIN is on. The images are
// asked from media-amazon.com: Firefox's tracking protection lists it as content, blocked only when protection is
// strict, while the older hosts (images-na.ssl-images-amazon.com) are listed as analytics. M and L are 160 and 500
// pixels tall: a card's cover sharp on a phone's screen, and the details' at its larger size.
const AMAZON_COVER: CoverDefinition = {
	byId: 'https://m.media-amazon.com/images/P/{id}.01.{size}.jpg',
	sizes: {small: 'MZZZZZZZ', large: 'LZZZZZZZ'},
};

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
				id: EDITION_ASIN,
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
		cover: AMAZON_COVER,
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
				id: EDITION_ASIN,
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
		cover: AMAZON_COVER,
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
			'Goodreads: a book (its work, all its editions), an edition (what Goodreads calls a book), a series, an author (narrators are listed as authors), a place (a setting of a book)',
		alias: 'gr',
		oldField: 'goodreadsId',
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
			// a place is one of Goodreads' places
			place: {
				id: NUMBER,
				url: 'https://www.goodreads.com/places/{id}',
				also: ['https://www.goodreads.com/places/{id}-*'],
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
		matchesBooks: true,
		lookups: ['book', 'series', 'author', 'narrator', 'publisher'],
		oldField: 'hardcoverId',
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
		// AudiobookDB keeps each image under the hash of its content; the key alone is no image, its sizes (192 and
		// 768 pixels) are below it.
		cover: {
			byKey: 'https://cdn.audiobookdb.org/{key}/{size}.jpg',
			key: '[0-9a-f]{64}',
			keyAt: 'https://cdn.audiobookdb.org/',
			sizes: {small: 'small', large: 'large'},
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
		// Open Library answers "not found" rather than a blank image (default=false); M and L are 180 and 500 pixels tall.
		cover: {
			byId: 'https://covers.openlibrary.org/b/olid/{id}-{size}.jpg?default=false',
			byIsbn: 'https://covers.openlibrary.org/b/isbn/{isbn}-{size}.jpg?default=false',
			sizes: {small: 'M', large: 'L'},
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
		description: 'Wikidata: the item (Q…) of a book, a series, an author, a narrator, a publisher or a place',
		kinds: {
			book: WIKIDATA_ITEM,
			series: WIKIDATA_ITEM,
			author: WIKIDATA_ITEM,
			narrator: WIKIDATA_ITEM,
			publisher: WIKIDATA_ITEM,
			place: WIKIDATA_ITEM,
		},
	},
];

const GROUPS: CatalogGroup[] = [
	{key: 'audible', name: 'Audible', default: 'audible.com', mark: 'Au', color: '#c8650a', oldLink: true},
	{key: 'amazon', name: 'Amazon', default: 'amazon.com', mark: 'Am', color: '#232f3e'},
	{key: 'goodreads', name: 'Goodreads', default: 'goodreads', mark: 'Gr', color: '#6b4f2a', oldLink: true},
	{
		key: 'hardcover',
		name: 'Hardcover',
		default: 'hardcover',
		mark: 'Hc',
		color: '#4f46b5',
		favicon: 'https://assets.hardcover.app/static/favicon.ico',
		oldLink: true,
	},
	{key: 'audiobookdb', name: 'AudiobookDB', default: 'audiobookdb', mark: 'AD', color: '#1f7a6d'},
	{key: 'openlibrary', name: 'Open Library', default: 'openlibrary', mark: 'OL', color: '#3a6ea5'},
	{key: 'isfdb', name: 'ISFDB', default: 'isfdb', mark: 'IS', color: '#6b6b6b'},
	{key: 'bookbrainz', name: 'BookBrainz', default: 'bookbrainz', mark: 'BB', color: '#6b6b6b'},
	{key: 'wikidata', name: 'Wikidata', default: 'wikidata', mark: 'WD', color: '#6b6b6b'},
];

const BY_KEY: Map<string, CatalogDefinition> = new Map(DEFINITIONS.map(def => [def.key, def]));
// An Audible or Amazon site's address, as an ASIN's site is kept: a site not listed is still an ASIN's.
const ASIN_SITE = /^(?:audible|amazon)\.(?:[a-z]{2,3}|com?\.[a-z]{2})$/;

// The families whose ids do more than name a page. An ASIN is the same edition on every Audible and Amazon site, and
// alone on a line of the exclusions list (stored ones may be shorter than Amazon's ten, kept in capitals); a
// Goodreads or Hardcover edition id needs its catalog's name before it there, to tell it from an ASIN.
const FAMILIES: FamilyDefinition[] = [
	{
		key: 'asin',
		idName: 'ASIN',
		sites: {default: 'audible.com', site: ASIN_SITE, id: EDITION_ASIN},
		exclusion: {name: '', id: ANY_ASIN, edition: ASIN, upper: true},
		mark: 'id',
		oldField: 'asins',
	},
	{key: 'goodreads', idName: 'Goodreads id', exclusion: {name: 'Goodreads', also: ['gr'], id: NUMBER}, mark: 'gr'},
	{key: 'hardcover', idName: 'Hardcover id', exclusion: {name: 'Hardcover', id: NUMBER}, mark: 'hc'},
];
const FAMILY_BY_KEY: Map<string, FamilyDefinition> = new Map(FAMILIES.map(f => [f.key, f]));

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

/**
 * Whether an id is one as the catalog gives them (a kind's own pattern, or its fallback), not merely one
 * kept from before (`stored`).
 */
function typedOf(pattern: KindPattern, id: string): boolean {
	return [pattern, pattern.fallback].some(of => of && new RegExp(`^(?:${of.id})$`, of.upper ? 'i' : '').test(id));
}

/** each catalog's and kind's patterns, compiled once */
const COMPILED: Map<string, {re: RegExp; query: boolean}[]> = new Map();

/** The external catalogs; every method is static. */
export class ExternalCatalog {
	static ALL: CatalogDefinition[] = DEFINITIONS;
	static GROUPS = GROUPS;
	static KINDS: ExternalKind[] = ['book', 'edition', 'series', 'author', 'narrator', 'publisher', 'place'];
	static AUDIBLE_STORES = AUDIBLE_STORES;
	static AUDIBLE_SITE = 'audible.com';
	static AMAZON_SITE = 'amazon.com';
	static ASIN_SITE = ASIN_SITE;
	// The sites an edition may have an ASIN field for (each Audible store's, and Amazon's).
	// In order: each Audible store's site and its Amazon twin, then
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

	// ------------------------------------------------------------------ what a catalog's ids can do
	// What the rest of the app asks a catalog instead of naming it: whether its ids are one edition's on several
	// sites, keep books out of imports, match books, have covers, can be looked up.

	/** The families whose ids are one edition's on several sites (ASINs), in the usual order. */
	static SITE_FAMILIES: FamilyDefinition[] = FAMILIES.filter(f => f.sites);
	/** The families whose edition ids the exclusions list keeps, in the usual order. */
	static EXCLUDING: FamilyDefinition[] = FAMILIES.filter(f => f.exclusion);
	/** The catalogs a book's own id finds the book by in an import (CatalogDefinition.matchesBooks). */
	static BOOK_MATCHING: string[] = DEFINITIONS.filter(def => def.matchesBooks).map(def => def.key);

	/**
	 * What a family's ids are called and can do: its definition, or for a family without one only its name
	 * ("Open Library id").
	 * @param family a family's key (ExternalCatalog.family)
	 */
	static familyOf(family: string): FamilyDefinition {
		return FAMILY_BY_KEY.get(family) || {key: family, idName: `${ExternalCatalog.name(family)} id`};
	}

	/**
	 * What one of a family's ids is called in a sentence: "ASIN", "Goodreads id".
	 */
	static idName(family: string): string {
		return ExternalCatalog.familyOf(family).idName;
	}

	/**
	 * The family of a catalog whose ids are one edition's on several sites (any Audible or Amazon site's: ASINs);
	 * null for a catalog with ids of its own.
	 */
	static siteFamily(key: string): FamilyDefinition | null {
		const family = FAMILY_BY_KEY.get(ExternalCatalog.family(key));
		return family && family.sites ? family : null;
	}

	/**
	 * The exclusions list's entry for an edition's id of a family ("Goodreads 4242", an ASIN alone); null when the
	 * family's ids keep nothing out, or it is no id of the family.
	 */
	static exclusionEntry(family: string, id: string): string | null {
		const of = FAMILY_BY_KEY.get(family)?.exclusion,
			value = id.trim();
		if (!of || !new RegExp(`^(?:${of.id})$`).test(value)) return null;
		return of.name ? `${of.name} ${value}` : value;
	}

	/**
	 * What a "Keep separate" mark's text writes before an id of a family.
	 */
	static markPrefix(family: string): string {
		return FAMILY_BY_KEY.get(family)?.mark || family;
	}

	/**
	 * Whether the catalog's client can be asked for the id of a kind of thing when a page's address doesn't hold
	 * it (CatalogClient.lookupId); a group's key stands for its default catalog.
	 */
	static looksUp(key: string, kind: ExternalKind): boolean {
		const def = BY_KEY.get(key) || BY_KEY.get(GROUPS.find(g => g.key === key)?.default || '');
		return !!def && !!def.lookups && def.lookups.includes(kind);
	}

	/**
	 * Where a catalog's covers are; a site this app doesn't list has its family's (an ASIN's cover is the same
	 * on any site). null when it has none.
	 */
	static coverOf(key: string): CoverDefinition | null {
		const def = BY_KEY.get(key) || BY_KEY.get(ExternalCatalog.siteFamily(key)?.sites?.default || '');
		return (def && def.cover) || null;
	}

	/** The groups a stored person once kept the address of its page in, under the group's key (CatalogGroup.oldLink). */
	static OLD_LINKS: string[] = GROUPS.filter(g => g.oldLink).map(g => g.key);

	/**
	 * The external ids of a stored record from before they were kept by catalog (database version 1), read from
	 * the fields they had then: a family's ids by site (`asins`), then each catalog's own (`goodreadsId`).
	 */
	static oldIds(record: object): Record<string, string> {
		const had = record as Record<string, unknown>;
		const ids: Record<string, string> = {};
		for (const family of FAMILIES) {
			const bySite = family.oldField ? had[family.oldField] : undefined;
			if (Text.isObject(bySite))
				for (const [site, id] of Object.entries(bySite)) if (typeof id === 'string') ids[site] = id;
		}
		for (const def of DEFINITIONS) {
			const id = def.oldField ? had[def.oldField] : undefined;
			if (typeof id === 'string' && id) ids[def.key] = id;
		}
		return ids;
	}

	/**
	 * The catalog an edition's text names by `label`: its name ("open library"), or its other word ("gr"),
	 * whatever the case. null when it is none; a site of a family named as one (SITE_FAMILIES) is none either.
	 */
	static byLabel(label: string): CatalogDefinition | null {
		const text = label.toLowerCase().replace(/\s+/g, ' ');
		return (
			DEFINITIONS.find(
				def =>
					!ExternalCatalog.siteFamily(def.key) &&
					(text === def.alias || text.startsWith(def.name.toLowerCase())),
			) || null
		);
	}

	/**
	 * The address of a catalog's site (`https://www.audible.co.uk`), from its pages' addresses; a group's key
	 * (`audible`) is its default site's. null when it has none.
	 */
	static home(key: string): string | null {
		const def = BY_KEY.get(key) || BY_KEY.get(GROUPS.find(g => g.key === key)?.default || '');
		const pattern = def && Object.values(def.kinds).find(Boolean);
		return pattern ? new URL(pattern.url.replace(/\{id\}/g, 'x')).origin : null;
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
		// typed, it must be an id as the catalog gives them, not merely one a stored entry may keep (a short ASIN)
		return pattern && typedOf(pattern, id) ? {catalog: key, id} : null;
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
	 * The id under one catalog ("hardcover", "audible.com") of an entry's ids, or null.
	 */
	static idIn(ids: Record<string, string>, catalog: string): string | null {
		const v = Object.hasOwn(ids, catalog) ? ids[catalog] : null;
		return typeof v === 'string' && v ? v : null;
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
	 * An entry's ids tidied (tidy()), keeping only the ids that are texts with something in them; none when `ids` is
	 * not an object.
	 */
	static tidyIds(ids: unknown): Record<string, string> {
		if (!Text.isObject(ids)) return {};
		const out: Record<string, string> = {};
		for (const [k, v] of Object.entries(ExternalCatalog.tidy(ids))) if (typeof v === 'string' && v) out[k] = v;
		return out;
	}

	/**
	 * Tidy, in place, what a stored book and a stored edition both hold: the texts under `textKeys`, the ids (tidy())
	 * and the links (Text.tidyLinks(); none left is no `links`). A value that is not what its key holds is kept as it
	 * is, for the Check.
	 */
	static tidyStored(rec: Record<string, any>, textKeys: string[]) {
		for (const key of textKeys) {
			if (typeof rec[key] === 'string') rec[key] = Text.tidy(rec[key]);
		}
		if (Text.isObject(rec.ext)) rec.ext = ExternalCatalog.tidy(rec.ext);
		if (Array.isArray(rec.links)) {
			rec.links = Text.tidyLinks(rec.links);
			if (!rec.links.length) delete rec.links;
		}
	}

	/**
	 * What is wrong with stored ids of a kind of thing, as lines for the Check: not an object, a catalog this
	 * app doesn't know (a warning), an id that isn't one.
	 */
	static problems(ids: unknown, kind: ExternalKind): {errors: Phrase[]; warnings: Phrase[]} {
		const errors: Phrase[] = [];
		const warnings: Phrase[] = [];
		const P = Text.phrase;
		if (!Text.isObject(ids) || !Object.keys(ids).length) {
			errors.push(
				P(`'ext' must map external catalogs to ids, e.g. {example}`, {
					example: '{"audible.com": "B0...", "goodreads": "4242"}',
				}),
			);
			return {errors, warnings};
		}
		for (const [k, v] of Object.entries(ids)) {
			if (typeof v !== 'string' || !v.trim()) {
				errors.push(P('the id on {key} must be a non-empty string', {key: Text.repr(k)}));
				continue;
			}
			const def = BY_KEY.get(k);
			if (!def && !(ASIN_SITE.test(k) && kind === 'edition'))
				warnings.push(P('{key} is not an external catalog this app knows', {key: Text.repr(k)}));
			else if (def && !def.kinds[kind])
				errors.push(P('{catalog} has no {kind} pages, so no {kind} id', {catalog: def.name, kind}));
			else if (!ExternalCatalog.isId(k, kind, v.trim()))
				errors.push(
					P(
						/^[aeiou]/.test(kind)
							? "{id} is not {catalog}'s id of an {kind}"
							: "{id} is not {catalog}'s id of a {kind}",
						{
							id: Text.repr(v),
							catalog: ExternalCatalog.name(k),
							kind,
						},
					),
				);
		}
		return {errors, warnings};
	}
}
