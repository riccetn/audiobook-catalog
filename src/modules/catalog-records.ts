// The catalog as the records IndexedDB keeps (CatalogDatabase): a record per book, edition, series,
// author, narrator and publisher, each under an id that never changes, pointing at each other by id; a
// record per person and book they are credited on; the "Not duplicates" marks and the exclusions. Next to
// what they hold, records carry derived fields (sort keys, counts) that exist only so an index can sort or
// filter without reading other records. They are written from the catalog on every save and never read
// back, so they can't drift from the values they come from.
//
// The pages work on the whole catalog in memory (Catalog), which knows its entries by these ids too; this
// class turns it into records and back. It gives an id to whatever has none, and the classes keep theirs
// (Book.id, Edition.id, Catalog.nameIds), so the next save finds the same records.
import {Text} from './text.js';
import {Book} from './book.js';
import {Edition} from './edition.js';
import {Series} from './series.js';
import {Contributor} from './contributor.js';
import {Exclusions} from './exclusions.js';
import {Catalog} from './catalog.js';
import {ExternalCatalog} from './external-catalog.js';
import {Isbn} from './isbn.js';
import type {ContributorKind} from './contributor.js';
import type {NamedKind} from './catalog.js';
import type {SeriesStatus} from './series.js';
import type {Mark} from './duplicates.js';

/**
 * A book. `authorIds`, `seriesId` and `editionIds` point at records of their own; `position` keeps the
 * catalog's order. The rest after `position` is derived.
 */
export interface BookRecord {
	id: string;
	title: string;
	authorIds: string[];
	seriesId?: string;
	/** "3", "2.5", or a box set's range "4-6" */
	number?: string;
	genres: string[];
	read: string[];
	/** its own ids by external catalog ({"hardcover": "77"}) */
	external?: Record<string, string>;
	/** in the book's order */
	editionIds: string[];
	position: number;
	sortTitle: string;
	/** the title as matching compares titles (Text.norm) */
	titleKey: string;
	/** the first author as matching compares them (Book.firstAuthor) */
	firstAuthorKey: string;
	/** the series as matching compares series (Series.norm) */
	seriesKey?: string;
	/** with a series: 1 for a box set */
	isCollection?: 0 | 1;
	/** with a series: its number, or the first of a range (unnumbered: UNNUMBERED) */
	numberKey?: number;
	/** with a series: the last number of a range, else numberKey */
	numberEnd?: number;
	lastRead?: string;
	/** the words of its title and authors, for search */
	words: string[];
	/** its own external ids, "hardcover 77", to find it by one */
	externalKeys: string[];
	/** the years it was read in ("2024"), or ["undated"] with no date read, for the read filter */
	readYears: string[];
	/** what the catalog's search looks in (CatalogRecords.searchText) */
	search: string;
	/** outside a series, so the standalone books can be listed by title */
	standalone?: 1;
}
/**
 * An edition, which a box set's titles share: `bookIds` lists them all. The rest after `description` is derived.
 */
export interface EditionRecord {
	id: string;
	bookIds: string[];
	/** the title it was released under, when that is not the book's (a box set's: the set's) */
	title?: string;
	/** its ids by external catalog ({"audible.com": "B0…", "goodreads": "4242"}) */
	external: Record<string, string>;
	isbn?: string;
	narratorIds: string[];
	publisherId?: string;
	released?: string;
	minutes?: number;
	description?: string;
	/** the key of its cover by catalog ({"audiobookdb": "<the image's hash>"}) */
	covers?: Record<string, string>;
	/** "asin B0…" (whichever site), "goodreads 12345", "hardcover 678", "isbn 978…", for matching imports */
	idKeys: string[];
}
/**
 * A series: an entry of its own, whether or not a book names it. The rest after `external` is derived from its books.
 */
export interface SeriesRecord {
	id: string;
	name: string;
	total?: number | 'many';
	status?: SeriesStatus;
	note?: string;
	/** its ids by external catalog */
	external?: Record<string, string>;
	sortName: string;
	bookCount: number;
	/** how many of its titles there are (Series.owned) */
	owned: number;
	/** the numbers up to its total that no book has, when the total is a count */
	missing?: number[];
	lastRead?: string;
	/** its external ids, "goodreads 123" */
	externalKeys: string[];
	/** the authors of its books, for the series overview */
	authorIds: string[];
}
export type CreditKind = 'author' | 'narrator' | 'publisher';
/**
 * An author, narrator or publisher: an entry of their own, whether or not a book names them. `sortName`, `bookCount` and `externalKeys` are derived.
 * (Before ids were kept by external catalog, a record kept the addresses of their pages as `audible`,
 * `goodreads` and `hardcover`; toCatalog() still reads them.)
 */
export interface ContributorRecord {
	id: string;
	kind: CreditKind;
	name: string;
	bio?: string;
	url?: string;
	/** their ids by external catalog */
	external?: Record<string, string>;
	/** other pages about them */
	links?: string[];
	sortName: string;
	bookCount: number;
	/** how many series their books are in */
	seriesCount: number;
	/** their external ids, "audible.com B0…" */
	externalKeys: string[];
	/** a narrator's or publisher's: the authors of most of their books, at most three */
	topAuthorIds?: string[];
	/** a narrator's or publisher's: how many authors their books have */
	authorCount?: number;
}
/** Someone credited on a book (derived: rewritten from the books on every save). */
export interface CreditRecord {
	contributorId: string;
	bookId: string;
	kind: CreditKind;
	sortTitle: string;
	seriesId?: string;
	numberKey?: number;
}
/** a mark of the duplicates page, as Catalog.marks holds it */
export type MarkRecord = Mark;
/** an entry of the exclusions list, and its place in it */
export type ExclusionRecord = {entry: string; position: number};
/** Every record of a catalog, by the store it goes in. */
export interface RecordSet {
	books: BookRecord[];
	editions: EditionRecord[];
	series: SeriesRecord[];
	contributors: ContributorRecord[];
	credits: CreditRecord[];
	marks: MarkRecord[];
	exclusions: ExclusionRecord[];
}
export type StoreName = keyof RecordSet;
/** An index: its name, key path and options. */
export type IndexSpec = [string, string | string[], IDBIndexParameters?];
export type StoreSpec = {keyPath: string | string[]; indexes: IndexSpec[]};
/** what was saved: each record as text, by its key as text */
export type Snapshot = Map<StoreName, Map<string, string>>;
/**
 * What a save writes: the records to put and the keys to delete, by store (credits are worked out by the
 * save). `snapshot` is the records after it, for the save after that.
 */
export type Changes = {
	put: Partial<Record<StoreName, object[]>>;
	delete: Partial<Record<StoreName, IDBValidKey[]>>;
	count: number;
	snapshot: Snapshot;
};
/** the id a series or person is stored under, by name */
export type IdOf = (kind: NamedKind, name: string) => string;

const CONTRIBUTOR_KIND: Record<CreditKind, ContributorKind> = {
	author: 'authors',
	narrator: 'narrators',
	publisher: 'publishers',
};
/** external ids as an index finds them: "hardcover 77" */
const externalKeys: (ids: Record<string, string>) => string[] = ids =>
	Object.entries(ExternalCatalog.order(ids) || {}).map(([catalog, id]) => catalog + ' ' + id);
const latest: (list: string[]) => string | undefined = list =>
	list.length ? [...list].sort()[list.length - 1] : undefined;

/** Turns a catalog into records and back; every method is static. */
export class CatalogRecords {
	// The stores and their indexes (CatalogDatabase makes them). Every index that sorts ends with the
	// record's key, so records that sort alike still have an order a page can continue from.
	static STORES: Record<StoreName, StoreSpec> = {
		books: {
			keyPath: 'id',
			indexes: [
				['byTitle', ['sortTitle', 'id']],
				['bySeries', ['seriesId', 'isCollection', 'numberKey', 'numberEnd', 'sortTitle', 'id']],
				['byLastRead', ['lastRead', 'id']],
				['byAuthorTitle', ['firstAuthorKey', 'titleKey']],
				['byAuthorSeries', ['firstAuthorKey', 'seriesKey', 'number']],
				['genres', 'genres', {multiEntry: true}],
				['words', 'words', {multiEntry: true}],
				['externalKeys', 'externalKeys', {multiEntry: true}],
				['byPosition', ['position', 'id']],
				['editionIds', 'editionIds', {multiEntry: true}],
				['readYears', 'readYears', {multiEntry: true}],
				['search', 'search'],
				['standalone', ['standalone', 'sortTitle', 'id']],
			],
		},
		editions: {
			keyPath: 'id',
			indexes: [
				['bookIds', 'bookIds', {multiEntry: true}],
				['idKeys', 'idKeys', {multiEntry: true}],
				['narratorIds', 'narratorIds', {multiEntry: true}],
				['publisherId', 'publisherId'],
			],
		},
		series: {
			keyPath: 'id',
			indexes: [
				['name', 'name', {unique: true}],
				['byName', ['sortName', 'id']],
				['byStatus', ['status', 'sortName', 'id']],
				['externalKeys', 'externalKeys', {multiEntry: true}],
			],
		},
		contributors: {
			keyPath: 'id',
			indexes: [
				['kindName', ['kind', 'name'], {unique: true}],
				['byName', ['kind', 'sortName', 'id']],
				['externalKeys', 'externalKeys', {multiEntry: true}],
			],
		},
		credits: {
			keyPath: ['contributorId', 'bookId'],
			indexes: [
				['byTitle', ['contributorId', 'sortTitle', 'bookId']],
				['bySeries', ['contributorId', 'seriesId', 'numberKey', 'bookId']],
				['bookId', 'bookId'],
			],
		},
		marks: {keyPath: 'id', indexes: [['bookIds', 'bookIds', {multiEntry: true}]]},
		exclusions: {keyPath: 'entry', indexes: [['byPosition', ['position', 'entry']]]},
	};
	static STORE_NAMES: StoreName[] = ['books', 'editions', 'series', 'contributors', 'credits', 'marks', 'exclusions'];
	// The derived fields of each store's records (see fromCatalog), which a save works out again from the
	// rest; credits are derived as a whole. Two tabs changed the same thing only when they changed a
	// record's other fields.
	static DERIVED: Record<StoreName, string[] | null> = {
		books: [
			'position',
			'sortTitle',
			'titleKey',
			'firstAuthorKey',
			'words',
			'externalKeys',
			'seriesKey',
			'isCollection',
			'numberKey',
			'numberEnd',
			'lastRead',
			'readYears',
			'search',
			'standalone',
		],
		editions: ['bookIds', 'idKeys'],
		series: ['sortName', 'bookCount', 'owned', 'missing', 'lastRead', 'externalKeys', 'authorIds'],
		contributors: ['sortName', 'bookCount', 'seriesCount', 'externalKeys', 'topAuthorIds', 'authorCount'],
		credits: null,
		marks: [],
		exclusions: ['position'],
	};
	// The numberKey of a book in a series without a number, so it sorts after the numbered ones.
	static UNNUMBERED = Number.MAX_SAFE_INTEGER;
	// The position of a book (or an exclusion) a page adds without knowing the others': the save puts it after them.
	static NEW_POSITION = -1;
	// What the read filter's "No date read" finds in readYears.
	static UNDATED = 'undated';
	// The info a series' or person's record holds, beside its name.
	static INFO: Record<'series' | 'contributors', string[]> = {
		series: ['total', 'status', 'note', 'external'],
		contributors: ['bio', 'url', 'external', 'links'],
	};

	/** @returns a new id */
	static newId(): string {
		return crypto.randomUUID();
	}

	/**
	 * A text as lists sort it: Text.norm(), without a leading "the", "a" or "an".
	 */
	static sortKey(text: unknown): string {
		return Text.norm(text).replace(/^(the|an?) (?=.)/, '');
	}

	/**
	 * What in the catalog a record has no place for: values the classes kept aside (`extra`) because they
	 * are not what their key holds, or are under a key they don't know. Each is a line like
	 * "book #3 ('Title'): 'r', 'x'". Empty when everything can be stored.
	 */
	static unstorable(catalog: Catalog): string[] {
		const out: string[] = [];
		const note: (label: string, extra: Record<string, unknown>) => void = (label, extra) => {
			const keys = Object.keys(extra);
			if (keys.length) out.push(`${label}: ${keys.map(k => Text.repr(k)).join(', ')}`);
		};
		catalog.books.forEach((b, i) => {
			const label = `book #${i} (${Text.repr(b.title || '?')})`;
			note(label, b.extra);
			b.editions.forEach((ed, j) => note(`${label} edition #${j + 1}`, ed.extra));
		});
		for (const s of catalog.series.values()) note(`series info ${Text.repr(s.name)}`, s.extra);
		for (const kind of Contributor.KINDS)
			for (const c of catalog[kind].values()) note(`${kind} ${Text.repr(c.name)}`, c.extra);
		return out;
	}

	/**
	 * Give an id to whatever in the catalog has none (Catalog.assignIds).
	 */
	static assignIds(catalog: Catalog, newId: () => string = CatalogRecords.newId) {
		catalog.assignIds(newId);
	}

	/**
	 * The records of a catalog. Gives ids first (assignIds), so the catalog keeps them for the next save.
	 * A page that holds only some of the catalog passes `positionOf`, the place each book has among all of
	 * them (NEW_POSITION for one it adds); otherwise a book's place is its place in catalog.books. Derived
	 * fields that depend on records it may not hold (a series' counts) are worked out again by the save.
	 */
	static fromCatalog(
		catalog: Catalog,
		newId: () => string = CatalogRecords.newId,
		positionOf?: (b: Book, index: number) => number,
	): RecordSet {
		CatalogRecords.assignIds(catalog, newId);
		const ids = catalog.nameIds;
		const idOf: IdOf = (kind, name) => ids[kind].get(name) as string;

		const books = catalog.books.map((b, i) =>
			CatalogRecords.bookRecord(b, idOf, positionOf ? positionOf(b, i) : i),
		);

		const editions: Map<string, EditionRecord> = new Map();
		catalog.books.forEach((b, i) => {
			for (const ed of b.editions) {
				const had = editions.get(ed.id as string);
				if (had) {
					if (!had.bookIds.includes(books[i].id)) had.bookIds.push(books[i].id);
					continue;
				}
				editions.set(ed.id as string, CatalogRecords.editionRecord(ed, [books[i].id], idOf));
			}
		});
		const editionsOf: (rec: BookRecord) => EditionRecord[] = rec =>
			rec.editionIds.map(id => editions.get(id) as EditionRecord);

		const seriesBooks: Map<string, BookRecord[]> = new Map();
		for (const rec of books)
			if (rec.seriesId) seriesBooks.set(rec.seriesId, [...(seriesBooks.get(rec.seriesId) || []), rec]);
		const series = [...ids.series].map(([name, id]) =>
			CatalogRecords.seriesRecord(id, name, catalog.series.get(id), seriesBooks.get(id) || []),
		);

		const credits = books.flatMap(rec => CatalogRecords.creditsOf(rec, editionsOf(rec)));
		const creditedBooks: Map<string, BookRecord[]> = new Map();
		const byId = new Map(books.map(rec => [rec.id, rec]));
		for (const c of credits)
			creditedBooks.set(c.contributorId, [
				...(creditedBooks.get(c.contributorId) || []),
				byId.get(c.bookId) as BookRecord,
			]);
		const authorNames: Map<string, string> = new Map([...ids.authors].map(([name, id]) => [id, name]));
		const contributors = Contributor.KINDS.flatMap(kind =>
			[...ids[kind]].map(([name, id]) =>
				CatalogRecords.contributorRecord(
					Contributor.ONE[kind],
					id,
					name,
					catalog[kind].get(id),
					creditedBooks.get(id) || [],
					x => authorNames.get(x) || '',
				),
			),
		);

		return {
			books,
			editions: [...editions.values()],
			series,
			contributors,
			credits,
			marks: [...catalog.marks.values()].map(m => ({...m})),
			exclusions: catalog.exclusions.entries.map((entry, position) => ({entry, position})),
		};
	}

	/**
	 * What the catalog's search looks in for a book: its title, authors, series, genres, its editions' titles, ids,
	 * narrators, publisher, description and ISBN, and its own ids, in lower case; then, after a \u0001, its
	 * ISBNs (13 digits), which a search for an ISBN typed any way finds (searchMatches).
	 */
	static searchText(b: Book): string {
		const hay = [
			b.title,
			...b.authors,
			b.series,
			...b.genres,
			...b.editions.flatMap(ed => [
				ed.title,
				...ed.externalList().map(([, id]) => id),
				Text.namesText(ed.narrators),
				ed.publisher,
				ed.description,
				ed.isbn,
			]),
			...Object.values(b.external),
		]
			.filter(x => typeof x === 'string')
			.join(' ')
			.toLowerCase();
		return hay + '\u0001' + b.isbns().join(' ');
	}

	/**
	 * Whether a book's searchText holds what was typed: as text, or as the ISBN it is however it is written.
	 * @param text the book's searchText
	 * @param q what was typed, trimmed
	 */
	static searchMatches(text: string, q: string): boolean {
		const at = text.indexOf('\u0001');
		const hay = at < 0 ? text : text.slice(0, at),
			isbns = at < 0 ? '' : text.slice(at + 1);
		if (hay.includes(q.toLowerCase())) return true;
		const isbn = Isbn.parse(q);
		return !!isbn && isbns.split(' ').includes(isbn);
	}

	/**
	 * A book's record, with its derived fields.
	 */
	static bookRecord(b: Book, idOf: IdOf, position: number): BookRecord {
		const years = [...new Set(b.read.map(d => d.slice(0, 4)))];
		const rec: BookRecord = {
			id: b.id as string,
			title: b.title,
			authorIds: [...new Set(b.authors)].map(name => idOf('authors', name)),
			genres: [...b.genres],
			read: [...b.read],
			editionIds: b.editions.map(ed => ed.id as string),
			position,
			sortTitle: CatalogRecords.sortKey(b.title),
			titleKey: Text.norm(b.title),
			firstAuthorKey: b.authorKey(),
			words: [
				...new Set(
					Text.norm([b.title, ...b.authors].join(' '))
						.split(' ')
						.filter(Boolean),
				),
			],
			externalKeys: externalKeys(b.external),
			readYears: years.length ? years : [CatalogRecords.UNDATED],
			search: CatalogRecords.searchText(b),
		};
		if (b.series) {
			rec.seriesId = idOf('series', b.series);
			rec.seriesKey = Series.norm(b.series);
			const range = Series.range(b.number),
				first = parseFloat(b.number || '');
			rec.isCollection = b.isCollection() ? 1 : 0;
			rec.numberKey = range ? range[0] : Number.isFinite(first) ? first : CatalogRecords.UNNUMBERED;
			rec.numberEnd = range ? range[1] : rec.numberKey;
		} else rec.standalone = 1;
		if (b.number) rec.number = b.number;
		if (Object.keys(b.external).length) rec.external = ExternalCatalog.order(b.external) as Record<string, string>;
		const lastRead = latest(b.read);
		if (lastRead) rec.lastRead = lastRead;
		return rec;
	}

	/**
	 * An edition's record.
	 * @param bookIds the books it is on
	 */
	static editionRecord(ed: Edition, bookIds: string[], idOf: IdOf): EditionRecord {
		const rec: EditionRecord = {
			id: ed.id as string,
			bookIds,
			external: (ExternalCatalog.order(ed.external) || {}) as Record<string, string>,
			narratorIds: [...new Set(ed.narrators)].map(name => idOf('narrators', name)),
			idKeys: ed.idAndIsbnKeys(),
		};
		if (ed.title) rec.title = ed.title;
		if (ed.isbn) rec.isbn = ed.isbn;
		if (ed.publisher) rec.publisherId = idOf('publishers', ed.publisher);
		if (ed.released) rec.released = ed.released;
		if (ed.minutes !== undefined) rec.minutes = ed.minutes;
		if (ed.description) rec.description = ed.description;
		if (Object.keys(ed.covers).length) rec.covers = {...ed.covers};
		return rec;
	}

	/**
	 * A series' record, with what is derived from its books.
	 * @param books the books in it
	 */
	static seriesRecord(id: string, name: string, info: Series | undefined, books: BookRecord[]): SeriesRecord {
		// what Series counts by: the books' numbers (a range for a box set)
		const own = books.map(rec => new Book({title: rec.title, series: name, number: rec.number}));
		const rec: SeriesRecord = {
			id,
			name,
			sortName: CatalogRecords.sortKey(name),
			bookCount: books.length,
			owned: Series.owned(own),
			externalKeys: externalKeys(info ? info.external : {}),
			authorIds: [...new Set(books.flatMap(b => b.authorIds))],
		};
		if (info) {
			if (info.total !== undefined) rec.total = info.total;
			if (info.status !== undefined) rec.status = info.status;
			if (info.note !== undefined) rec.note = info.note;
			if (Object.keys(info.external).length)
				rec.external = ExternalCatalog.order(info.external) as Record<string, string>;
		}
		const missing = Series.missingNumbers(own, rec.total);
		if (missing) rec.missing = missing;
		const lastRead = latest(books.flatMap(b => b.read));
		if (lastRead) rec.lastRead = lastRead;
		return rec;
	}

	/**
	 * A series' record as it is stored (`rec`, its own fields), with what is derived worked out again from its books.
	 */
	static rederiveSeries(rec: SeriesRecord, books: BookRecord[]): SeriesRecord {
		const info = new Series(rec.name, {
			total: rec.total,
			status: rec.status,
			note: rec.note,
			external: rec.external,
		});
		return CatalogRecords.seriesRecord(
			rec.id,
			rec.name,
			CatalogRecords.hasInfo('series', rec) ? info : undefined,
			books,
		);
	}

	/**
	 * Whether a series' or person's record holds info (anything beside its name).
	 */
	static hasInfo(store: 'series' | 'contributors', rec: Record<string, any>): boolean {
		return CatalogRecords.INFO[store].some(k => rec[k] !== undefined);
	}

	/**
	 * An author's, narrator's or publisher's record, with what is derived from the books they are credited on.
	 * @param books the books they are credited on
	 * @param authorName the name of an author, to put authors with as many books in order
	 */
	static contributorRecord(
		kind: CreditKind,
		id: string,
		name: string,
		info: Contributor | undefined,
		books: BookRecord[],
		authorName: (authorId: string) => string,
	): ContributorRecord {
		const rec: ContributorRecord = {
			id,
			kind,
			name,
			sortName: CatalogRecords.sortKey(name),
			bookCount: books.length,
			seriesCount: new Set(books.map(b => b.seriesId).filter(Boolean)).size,
			externalKeys: externalKeys(info ? info.external : {}),
		};
		if (kind !== 'author') {
			const count: Map<string, number> = new Map();
			for (const b of books) for (const a of b.authorIds) count.set(a, (count.get(a) || 0) + 1);
			rec.topAuthorIds = [...count]
				.sort((x, y) => y[1] - x[1] || authorName(x[0]).localeCompare(authorName(y[0])))
				.slice(0, 3)
				.map(([a]) => a);
			rec.authorCount = count.size;
		}
		if (info) {
			if (info.bio !== undefined) rec.bio = info.bio;
			if (info.url !== undefined) rec.url = info.url;
			if (Object.keys(info.external).length)
				rec.external = ExternalCatalog.order(info.external) as Record<string, string>;
			if (info.links.length) rec.links = [...info.links];
		}
		return rec;
	}

	/**
	 * A person's record as it is stored (`rec`), with what is derived worked out again from their books.
	 */
	static rederiveContributor(
		rec: ContributorRecord,
		books: BookRecord[],
		authorName: (authorId: string) => string,
	): ContributorRecord {
		const info = CatalogRecords.hasInfo('contributors', rec)
			? Contributor.fromJSON(
					rec.name,
					Object.fromEntries(
						Object.entries({bio: rec.bio, url: rec.url, ext: rec.external, links: rec.links}).filter(
							([, v]) => v !== undefined,
						),
					),
				)
			: undefined;
		return CatalogRecords.contributorRecord(rec.kind, rec.id, rec.name, info, books, authorName);
	}

	/**
	 * Who a book credits: its authors, and its editions' narrators and publishers, each once.
	 * @param editions its editions
	 */
	static creditsOf(rec: BookRecord, editions: EditionRecord[]): CreditRecord[] {
		const kinds: [CreditKind, string[]][] = [
			['author', rec.authorIds],
			['narrator', editions.flatMap(ed => ed.narratorIds)],
			['publisher', editions.map(ed => ed.publisherId).filter(Boolean) as string[]],
		];
		return kinds.flatMap(([kind, ids]) =>
			[...new Set(ids)].map(contributorId => {
				const credit: CreditRecord = {contributorId, bookId: rec.id, kind, sortTitle: rec.sortTitle};
				if (rec.seriesId) {
					credit.seriesId = rec.seriesId;
					credit.numberKey = rec.numberKey;
				}
				return credit;
			}),
		);
	}

	/**
	 * The book a record and its editions' records make, with the names `nameOf` gives for the ids they point at.
	 * @param editions by id; must hold the book's
	 * @param nameOf throws when it knows no name for the id
	 */
	static bookOf(
		rec: BookRecord,
		editions: Map<string, EditionRecord>,
		nameOf: (id: string, what: string) => string,
	): Book {
		// a record from before ids were kept by external catalog has `hardcoverId`
		const hardcoverId = (rec as {hardcoverId?: string}).hardcoverId;
		return new Book({
			id: rec.id,
			title: rec.title,
			authors: rec.authorIds.map(id => nameOf(id, 'author')),
			series: rec.seriesId === undefined ? undefined : nameOf(rec.seriesId, 'series'),
			number: rec.number,
			genres: rec.genres,
			read: rec.read,
			external: rec.external || (hardcoverId ? {hardcover: hardcoverId} : {}),
			editions: rec.editionIds.map(id => {
				const ed = editions.get(id);
				if (!ed) throw new Error(`no edition is stored under ${id}`);
				return new Edition({
					id: ed.id,
					title: ed.title,
					external: CatalogRecords.editionExternal(ed),
					isbn: ed.isbn,
					narrators: ed.narratorIds.map(n => nameOf(n, 'narrator')),
					publisher: ed.publisherId === undefined ? undefined : nameOf(ed.publisherId, 'publisher'),
					released: ed.released,
					minutes: ed.minutes,
					description: ed.description,
					covers: ed.covers,
				});
			}),
		});
	}

	/**
	 * The catalog the records make. Throws when they don't fit together (a book lists an edition, author
	 * or series there is no record of).
	 */
	static toCatalog(records: RecordSet): Catalog {
		const catalog = new Catalog();
		/** id -> name, of series and people */
		const names: Map<string, string> = new Map();
		/** the info by name, as a backup lists it */
		const byName: <T extends {name: string}>(list: T[]) => T[] = list =>
			[...list].sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
		for (const s of byName(records.series)) {
			names.set(s.id, s.name);
			catalog.nameIds.series.set(s.name, s.id);
			// a record from before authors and publishers kept their own site has the series' (Catalog.moveSeriesSites)
			const {url} = s as SeriesRecord & {url?: string};
			if (CatalogRecords.hasInfo('series', s) || url !== undefined) {
				const info = new Series(s.name, {total: s.total, status: s.status, note: s.note, external: s.external});
				if (url !== undefined) info.extra.url = url;
				catalog.series.set(s.id, info);
			}
		}
		for (const c of byName(records.contributors)) {
			const kind = CONTRIBUTOR_KIND[c.kind];
			names.set(c.id, c.name);
			catalog.nameIds[kind].set(c.name, c.id);
			// a record from before ids were kept by external catalog has its pages' addresses (fixLinks)
			const {bio, url, external, links, audible, goodreads, hardcover} = c as ContributorRecord & {
				audible?: string;
				goodreads?: string;
				hardcover?: string;
			};
			const stored = Object.fromEntries(
				Object.entries({bio, url, ext: external, links, audible, goodreads, hardcover}).filter(
					([, v]) => v !== undefined,
				),
			);
			const entry = Contributor.fromJSON(c.name, Contributor.fixLinks(stored, kind));
			if (Object.keys(entry.toJSON()).length) catalog[kind].set(c.id, entry);
		}
		const nameOf: (id: string, what: string) => string = (id, what) => {
			const name = names.get(id);
			if (name === undefined) throw new Error(`no ${what} is stored under ${id}`);
			return name;
		};
		const editions = new Map(records.editions.map(ed => [ed.id, ed]));
		catalog.books = [...records.books]
			.sort((x, y) => x.position - y.position)
			.map(rec => CatalogRecords.bookOf(rec, editions, nameOf));
		catalog.exclusions = Exclusions.parse(
			[...records.exclusions]
				.sort((x, y) => x.position - y.position)
				.map(x => x.entry)
				.join('\n'),
		);
		for (const m of records.marks) catalog.marks.set(m.id, {...m});
		// a mark whose book is gone, or has other editions now, is put right
		catalog.resolveMarks();
		return catalog;
	}

	/**
	 * Whether records are in an older shape than fromCatalog() writes (from before ids were kept by external
	 * catalog, or a series kept a site), so the page saves them again at once and their indexes find them.
	 */
	static outdated(records: RecordSet): boolean {
		return (
			[...records.books, ...records.series, ...records.contributors].some(
				rec => !Array.isArray(rec.externalKeys),
			) ||
			records.editions.some(ed => !ed.external) ||
			records.series.some(rec => 'url' in rec)
		);
	}

	/**
	 * An edition record's external ids; a record from before they were kept by external catalog has its
	 * ASINs by site (`asins`), `goodreadsId` and `hardcoverId`.
	 */
	static editionExternal(
		ed: EditionRecord & {asins?: Record<string, string>; goodreadsId?: string; hardcoverId?: string},
	): Record<string, string> {
		if (ed.external) return ed.external;
		return {
			...(ed.asins || {}),
			...(ed.goodreadsId ? {goodreads: ed.goodreadsId} : {}),
			...(ed.hardcoverId ? {hardcover: ed.hardcoverId} : {}),
		};
	}

	/**
	 * The key a record is stored under in `store`.
	 */
	static keyOf(store: StoreName, rec: Record<string, any>): IDBValidKey {
		const path = CatalogRecords.STORES[store].keyPath;
		return Array.isArray(path) ? path.map(k => rec[k]) : rec[path];
	}

	/**
	 * Every record as text, by store and key, to tell what the next save changes: what the record holds
	 * and its position, not what is derived (the save works that out), and no credits (all derived).
	 */
	static snapshot(records: RecordSet): Snapshot {
		const out: Snapshot = new Map();
		for (const store of CatalogRecords.STORE_NAMES) {
			if (!CatalogRecords.DERIVED[store]) continue;
			out.set(
				store,
				new Map(
					(records[store] as Record<string, any>[]).map(rec => [
						JSON.stringify(CatalogRecords.keyOf(store, rec)),
						CatalogRecords.ownText(store, rec),
					]),
				),
			);
		}
		return out;
	}

	/**
	 * A record's own values (and its position), as text in the order of their names.
	 */
	static ownText(store: StoreName, rec: Record<string, any>): string {
		const own = CatalogRecords.ownFields(store, rec);
		return JSON.stringify(
			Object.keys(own)
				.sort()
				.map(k => [k, own[k]]),
		);
	}

	/**
	 * A record without its derived fields (what ownText() holds, as a record).
	 */
	static ownFields<T extends Record<string, any>>(store: StoreName, rec: T): Partial<T> {
		const derived = (CatalogRecords.DERIVED[store] || []).filter(k => k !== 'position');
		return Object.fromEntries(Object.entries(rec).filter(([k]) => !derived.includes(k))) as Partial<T>;
	}

	/**
	 * Take in what another tab saved: `base` is the records as this page last read or wrote them, `mine` the
	 * records it has now and `theirs` the records stored now. A record only one side changed (added, edited
	 * or removed) is taken from that side; one both changed alike is kept; one both changed differently is a
	 * conflict, named in `conflicts` (an entry as the page shows it), and then the records are of no use.
	 * With `whole` (the page holds the whole catalog), books and exclusions keep this page's order, with the
	 * other tab's new ones after them; otherwise each keeps the position it has. Derived fields and credits
	 * are left as they come: toCatalog() doesn't read them, and the next save works them out again.
	 * With `prefer` (syncing devices, when told which to keep), a conflict is still named, but takes that side's record.
	 */
	static merge(
		base: Snapshot,
		mine: RecordSet,
		theirs: RecordSet,
		whole: boolean = true,
		prefer?: 'mine' | 'theirs',
	): {records: RecordSet; conflicts: string[]} {
		const conflicts: string[] = [];
		const records: Record<string, any> = {credits: theirs.credits};
		/** the first of these books, by title */
		const titleOf: (ids: string[] | undefined) => string = ids => {
			const rec = [...mine.books, ...theirs.books].find(b => (ids || []).includes(b.id));
			return rec ? `"${rec.title}"` : 'a book';
		};
		const label: (store: StoreName, rec: Record<string, any>) => string = (store, rec) =>
			store === 'books'
				? `"${rec.title}"`
				: store === 'editions'
					? `an edition of ${titleOf(rec.bookIds)}`
					: store === 'series'
						? `the series ${rec.name}`
						: store === 'contributors'
							? rec.name
							: store === 'marks'
								? `a mark on ${titleOf(rec.bookIds)}`
								: rec.entry;
		for (const store of CatalogRecords.STORE_NAMES) {
			const derived = CatalogRecords.DERIVED[store];
			if (!derived) continue;
			/** a record's own values, as text */
			const own: (rec: Record<string, any> | undefined) => string | undefined = rec =>
				rec &&
				JSON.stringify(
					Object.entries(rec)
						.filter(([k]) => !derived.includes(k))
						.sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)),
				);
			const byKey: (list: Record<string, any>[]) => Map<string, Record<string, any>> = list =>
				new Map(list.map(rec => [JSON.stringify(CatalogRecords.keyOf(store, rec)), rec]));
			const was = base.get(store) || new Map();
			const my = byKey(mine[store] as Record<string, any>[]),
				their = byKey(theirs[store] as Record<string, any>[]);
			const out: Record<string, any>[] = [];
			for (const key of new Set([...my.keys(), ...their.keys(), ...was.keys()])) {
				const before = was.has(key)
					? JSON.stringify(
							(JSON.parse(was.get(key) as string) as [string, unknown][]).filter(
								([k]) => k !== 'position',
							),
						)
					: undefined;
				const m = own(my.get(key)),
					t = own(their.get(key));
				let pick = their.get(key);
				if (m !== before && t !== m) {
					if (t === before) pick = my.get(key);
					else {
						conflicts.push(label(store, (my.get(key) || their.get(key)) as Record<string, any>));
						if (prefer === 'mine') pick = my.get(key);
					}
				}
				if (pick) out.push(pick);
			}
			if (derived.includes('position') && whole) {
				const rank = (rec: Record<string, any>): number => {
					const key = JSON.stringify(CatalogRecords.keyOf(store, rec)),
						m = my.get(key),
						t = their.get(key);
					return m ? m.position : my.size + (t ? t.position : 0);
				};
				out.sort((x, y) => rank(x) - rank(y));
				records[store] = out.map((rec, position) => ({...rec, position}));
			} else records[store] = out;
		}
		return {records: records as RecordSet, conflicts};
	}

	/**
	 * What a save writes to turn the records saved (`before`, a snapshot) into `records`: the records that
	 * are new or changed, and the keys of those that are gone.
	 */
	static changes(before: Snapshot, records: RecordSet): Changes {
		const after = CatalogRecords.snapshot(records);
		const out: Changes = {put: {}, delete: {}, count: 0, snapshot: after};
		for (const store of CatalogRecords.STORE_NAMES) {
			if (!CatalogRecords.DERIVED[store]) continue;
			const was = before.get(store) || new Map(),
				now = after.get(store) as Map<string, string>;
			const put = (records[store] as Record<string, any>[]).filter(rec => {
				const key = JSON.stringify(CatalogRecords.keyOf(store, rec));
				return was.get(key) !== now.get(key);
			});
			const gone = [...was.keys()].filter(key => !now.has(key)).map(key => JSON.parse(key) as IDBValidKey);
			if (put.length) out.put[store] = put;
			if (gone.length) out.delete[store] = gone;
			out.count += put.length + gone.length;
		}
		return out;
	}
}
