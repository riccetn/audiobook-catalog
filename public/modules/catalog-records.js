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
/** @import {ContributorKind} from './contributor.js' */
/** @import {NamedKind} from './catalog.js' */
/** @import {SeriesStatus} from './series.js' */
/** @import {Mark} from './duplicates.js' */

/**
 * A book. `authorIds`, `seriesId` and `editionIds` point at records of their own; `position` keeps the
 * catalog's order. The rest after `position` is derived.
 * @typedef {object} BookRecord
 * @property {string} id
 * @property {string} title
 * @property {string[]} authorIds
 * @property {string} [seriesId]
 * @property {string} [number] "3", "2.5", or a box set's range "4-6"
 * @property {string[]} genres
 * @property {string[]} read
 * @property {Record<string, string>} [external] its own ids by external catalog ({"hardcover": "77"})
 * @property {string[]} editionIds in the book's order
 * @property {number} position
 * @property {string} sortTitle
 * @property {string} titleKey the title as matching compares titles (Text.norm)
 * @property {string} firstAuthorKey the first author as matching compares them (Book.firstAuthor)
 * @property {string} [seriesKey] the series as matching compares series (Series.norm)
 * @property {0 | 1} [isCollection] with a series: 1 for a box set
 * @property {number} [numberKey] with a series: its number, or the first of a range (unnumbered: UNNUMBERED)
 * @property {number} [numberEnd] with a series: the last number of a range, else numberKey
 * @property {string} [lastRead]
 * @property {string[]} words the words of its title and authors, for search
 * @property {string[]} externalKeys its own external ids, "hardcover 77", to find it by one
 * @property {string[]} readYears the years it was read in ("2024"), or ["undated"] with no date read, for the read filter
 * @property {string} search what the catalog's search looks in (CatalogRecords.searchText)
 * @property {1} [standalone] outside a series, so the standalone books can be listed by title
 */
/**
 * An edition, which a box set's titles share: `bookIds` lists them all. The rest after `description` is derived.
 * @typedef {object} EditionRecord
 * @property {string} id
 * @property {string[]} bookIds
 * @property {Record<string, string>} external its ids by external catalog ({"audible.com": "B0…", "goodreads": "4242"})
 * @property {string} [isbn]
 * @property {string[]} narratorIds
 * @property {string} [publisherId]
 * @property {string} [released]
 * @property {number} [minutes]
 * @property {string} [description]
 * @property {string[]} idKeys "asin B0…" (whichever site), "goodreads 12345", "hardcover 678", "isbn 978…", for matching imports
 */
/**
 * A series: an entry of its own, whether or not a book names it. The rest after `external` is derived from its books.
 * @typedef {object} SeriesRecord
 * @property {string} id
 * @property {string} name
 * @property {number | 'many'} [total]
 * @property {SeriesStatus} [status]
 * @property {string} [note]
 * @property {string} [url]
 * @property {Record<string, string>} [external] its ids by external catalog
 * @property {string} sortName
 * @property {number} bookCount
 * @property {number} owned how many of its titles there are (Series.owned)
 * @property {number[]} [missing] the numbers up to its total that no book has, when the total is a count
 * @property {string} [lastRead]
 * @property {string[]} externalKeys its external ids, "goodreads 123"
 * @property {string[]} authorIds the authors of its books, for the series overview
 */
/** @typedef {'author' | 'narrator' | 'publisher'} CreditKind */
/**
 * An author, narrator or publisher: an entry of their own, whether or not a book names them. `sortName`, `bookCount` and `externalKeys` are derived.
 * (Before ids were kept by external catalog, a record kept the addresses of their pages as `audible`,
 * `goodreads` and `hardcover`; toCatalog() still reads them.)
 * @typedef {object} ContributorRecord
 * @property {string} id
 * @property {CreditKind} kind
 * @property {string} name
 * @property {string} [bio]
 * @property {string} [url]
 * @property {Record<string, string>} [external] their ids by external catalog
 * @property {string[]} [links] other pages about them
 * @property {string} sortName
 * @property {number} bookCount
 * @property {number} seriesCount how many series their books are in
 * @property {string[]} externalKeys their external ids, "audible.com B0…"
 * @property {string[]} [topAuthorIds] a narrator's or publisher's: the authors of most of their books, at most three
 * @property {number} [authorCount] a narrator's or publisher's: how many authors their books have
 */
/**
 * Someone credited on a book (derived: rewritten from the books on every save).
 * @typedef {object} CreditRecord
 * @property {string} contributorId
 * @property {string} bookId
 * @property {CreditKind} kind
 * @property {string} sortTitle
 * @property {string} [seriesId]
 * @property {number} [numberKey]
 */
/** @typedef {Mark} MarkRecord a mark of the duplicates page, as Catalog.marks holds it */
/** @typedef {{entry: string, position: number}} ExclusionRecord an entry of the exclusions list, and its place in it */
/**
 * Every record of a catalog, by the store it goes in.
 * @typedef {object} RecordSet
 * @property {BookRecord[]} books
 * @property {EditionRecord[]} editions
 * @property {SeriesRecord[]} series
 * @property {ContributorRecord[]} contributors
 * @property {CreditRecord[]} credits
 * @property {MarkRecord[]} marks
 * @property {ExclusionRecord[]} exclusions
 */
/** @typedef {keyof RecordSet} StoreName */
/**
 * An index: its name, key path and options.
 * @typedef {[string, string | string[], IDBIndexParameters?]} IndexSpec
 */
/** @typedef {{keyPath: string | string[], indexes: IndexSpec[]}} StoreSpec */
/** @typedef {Map<StoreName, Map<string, string>>} Snapshot what was saved: each record as text, by its key as text */
/**
 * What a save writes: the records to put and the keys to delete, by store (credits are worked out by the
 * save). `snapshot` is the records after it, for the save after that.
 * @typedef {{put: Partial<Record<StoreName, object[]>>, delete: Partial<Record<StoreName, IDBValidKey[]>>, count: number, snapshot: Snapshot}} Changes
 */
/** @typedef {(kind: NamedKind, name: string) => string} IdOf the id a series or person is stored under, by name */

/** @type {Record<ContributorKind, CreditKind>} */
const CREDIT_KIND = {authors: 'author', narrators: 'narrator', publishers: 'publisher'};
/** @type {Record<CreditKind, ContributorKind>} */
const CONTRIBUTOR_KIND = {author: 'authors', narrator: 'narrators', publisher: 'publishers'};
/** @type {(ed: Edition) => string[]} */
const editionIdKeys = ed => [...new Set([...ed.idKeys(), ...ed.isbns().map(x => 'isbn ' + x)])];
/** @type {(ids: Record<string, string>) => string[]} external ids as an index finds them: "hardcover 77" */
const externalKeys = ids => Object.entries(ExternalCatalog.order(ids) || {}).map(([catalog, id]) => catalog + ' ' + id);
/** @type {(list: string[]) => string | undefined} */
const latest = list => list.length ? [...list].sort()[list.length - 1] : undefined;

/** Turns a catalog into records and back; every method is static. */
export class CatalogRecords {
	// The stores and their indexes (CatalogDatabase makes them). Every index that sorts ends with the
	// record's key, so records that sort alike still have an order a page can continue from.
	/** @type {Record<StoreName, StoreSpec>} */
	static STORES = {
		books: {keyPath: 'id', indexes: [
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
		]},
		editions: {keyPath: 'id', indexes: [
			['bookIds', 'bookIds', {multiEntry: true}],
			['idKeys', 'idKeys', {multiEntry: true}],
			['narratorIds', 'narratorIds', {multiEntry: true}],
			['publisherId', 'publisherId'],
		]},
		series: {keyPath: 'id', indexes: [
			['name', 'name', {unique: true}],
			['byName', ['sortName', 'id']],
			['byStatus', ['status', 'sortName', 'id']],
			['externalKeys', 'externalKeys', {multiEntry: true}],
		]},
		contributors: {keyPath: 'id', indexes: [
			['kindName', ['kind', 'name'], {unique: true}],
			['byName', ['kind', 'sortName', 'id']],
			['externalKeys', 'externalKeys', {multiEntry: true}],
		]},
		credits: {keyPath: ['contributorId', 'bookId'], indexes: [
			['byTitle', ['contributorId', 'sortTitle', 'bookId']],
			['bySeries', ['contributorId', 'seriesId', 'numberKey', 'bookId']],
			['bookId', 'bookId'],
		]},
		marks: {keyPath: 'id', indexes: [
			['bookIds', 'bookIds', {multiEntry: true}],
		]},
		exclusions: {keyPath: 'entry', indexes: [
			['byPosition', ['position', 'entry']],
		]},
	};
	/** @type {StoreName[]} */
	static STORE_NAMES = ['books', 'editions', 'series', 'contributors', 'credits', 'marks', 'exclusions'];
	// The derived fields of each store's records (see fromCatalog), which a save works out again from the
	// rest; credits are derived as a whole. Two tabs changed the same thing only when they changed a
	// record's other fields.
	/** @type {Record<StoreName, string[] | null>} */
	static DERIVED = {
		books: ['position', 'sortTitle', 'titleKey', 'firstAuthorKey', 'words', 'externalKeys', 'seriesKey', 'isCollection', 'numberKey', 'numberEnd', 'lastRead',
			'readYears', 'search', 'standalone'],
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
	/** @type {Record<'series' | 'contributors', string[]>} */
	static INFO = {series: ['total', 'status', 'note', 'url', 'external'], contributors: ['bio', 'url', 'external', 'links']};

	/** @returns {string} a new id */
	static newId(){ return crypto.randomUUID(); }

	/**
	 * A text as lists sort it: Text.norm(), without a leading "the", "a" or "an".
	 * @param {unknown} text
	 * @returns {string}
	 */
	static sortKey(text){ return Text.norm(text).replace(/^(the|an?) (?=.)/, ''); }

	/**
	 * What in the catalog a record has no place for: values the classes kept aside (`extra`) because they
	 * are not what their key holds, or are under a key they don't know. Each is a line like
	 * "book #3 ('Title'): 'r', 'x'". Empty when everything can be stored.
	 * @param {Catalog} catalog
	 * @returns {string[]}
	 */
	static unstorable(catalog){
		/** @type {string[]} */
		const out = [];
		/** @type {(label: string, extra: Record<string, unknown>) => void} */
		const note = (label, extra) => { const keys = Object.keys(extra); if(keys.length) out.push(`${label}: ${keys.map(k => Text.repr(k)).join(', ')}`); };
		catalog.books.forEach((b, i) => {
			const label = `book #${i} (${Text.repr(b.title || '?')})`;
			note(label, b.extra);
			b.editions.forEach((ed, j) => note(`${label} edition #${j + 1}`, ed.extra));
		});
		for(const s of catalog.series.values()) note(`series info ${Text.repr(s.name)}`, s.extra);
		for(const kind of Contributor.KINDS) for(const c of catalog[kind].values()) note(`${kind} ${Text.repr(c.name)}`, c.extra);
		return out;
	}

	/**
	 * Give an id to whatever in the catalog has none (Catalog.assignIds).
	 * @param {Catalog} catalog
	 * @param {() => string} [newId]
	 */
	static assignIds(catalog, newId = CatalogRecords.newId){ catalog.assignIds(newId); }

	/**
	 * The records of a catalog. Gives ids first (assignIds), so the catalog keeps them for the next save.
	 * A page that holds only some of the catalog passes `positionOf`, the place each book has among all of
	 * them (NEW_POSITION for one it adds); otherwise a book's place is its place in catalog.books. Derived
	 * fields that depend on records it may not hold (a series' counts) are worked out again by the save.
	 * @param {Catalog} catalog
	 * @param {() => string} [newId]
	 * @param {(b: Book, index: number) => number} [positionOf]
	 * @returns {RecordSet}
	 */
	static fromCatalog(catalog, newId = CatalogRecords.newId, positionOf){
		CatalogRecords.assignIds(catalog, newId);
		const ids = catalog.nameIds;
		/** @type {IdOf} */
		const idOf = (kind, name) => /** @type {string} */ (ids[kind].get(name));

		const books = catalog.books.map((b, i) => CatalogRecords.bookRecord(b, idOf, positionOf ? positionOf(b, i) : i));

		/** @type {Map<string, EditionRecord>} */
		const editions = new Map();
		catalog.books.forEach((b, i) => {
			for(const ed of b.editions){
				const had = editions.get(/** @type {string} */ (ed.id));
				if(had){ if(!had.bookIds.includes(books[i].id)) had.bookIds.push(books[i].id); continue; }
				editions.set(/** @type {string} */ (ed.id), CatalogRecords.editionRecord(ed, [books[i].id], idOf));
			}
		});
		/** @type {(rec: BookRecord) => EditionRecord[]} */
		const editionsOf = rec => rec.editionIds.map(id => /** @type {EditionRecord} */ (editions.get(id)));

		/** @type {Map<string, BookRecord[]>} */
		const seriesBooks = new Map();
		for(const rec of books) if(rec.seriesId) seriesBooks.set(rec.seriesId, [...(seriesBooks.get(rec.seriesId) || []), rec]);
		const series = [...ids.series].map(([name, id]) => CatalogRecords.seriesRecord(id, name, catalog.series.get(id), seriesBooks.get(id) || []));

		const credits = books.flatMap(rec => CatalogRecords.creditsOf(rec, editionsOf(rec)));
		/** @type {Map<string, BookRecord[]>} */
		const creditedBooks = new Map();
		const byId = new Map(books.map(rec => [rec.id, rec]));
		for(const c of credits) creditedBooks.set(c.contributorId, [...(creditedBooks.get(c.contributorId) || []), /** @type {BookRecord} */ (byId.get(c.bookId))]);
		/** @type {Map<string, string>} */
		const authorNames = new Map([...ids.authors].map(([name, id]) => [id, name]));
		const contributors = Contributor.KINDS.flatMap(kind => [...ids[kind]].map(([name, id]) =>
			CatalogRecords.contributorRecord(CREDIT_KIND[kind], id, name, catalog[kind].get(id), creditedBooks.get(id) || [], x => authorNames.get(x) || '')));

		return {books, editions: [...editions.values()], series, contributors, credits, marks: [...catalog.marks.values()].map(m => ({...m})),
			exclusions: catalog.exclusions.entries.map((entry, position) => ({entry, position}))};
	}

	/**
	 * What the catalog's search looks in for a book: its title, authors, series, genres, its editions' ids,
	 * narrators, publisher, description and ISBN, and its own ids, in lower case; then, after a \u0001, its
	 * ISBNs (13 digits), which a search for an ISBN typed any way finds (searchMatches).
	 * @param {Book} b
	 * @returns {string}
	 */
	static searchText(b){
		const hay = [b.title, ...b.authors, b.series, ...b.genres, ...b.editions.flatMap(ed => [...ed.externalList().map(([, id]) => id),
			Text.namesText(ed.narrators), ed.publisher, ed.description, ed.isbn]), ...Object.values(b.external)]
			.filter(x => typeof x === 'string').join(' ').toLowerCase();
		return hay + '\u0001' + b.isbns().join(' ');
	}

	/**
	 * Whether a book's searchText holds what was typed: as text, or as the ISBN it is however it is written.
	 * @param {string} text the book's searchText
	 * @param {string} q what was typed, trimmed
	 * @returns {boolean}
	 */
	static searchMatches(text, q){
		const at = text.indexOf('\u0001');
		const hay = at < 0 ? text : text.slice(0, at), isbns = at < 0 ? '' : text.slice(at + 1);
		if(hay.includes(q.toLowerCase())) return true;
		const isbn = Isbn.parse(q);
		return !!isbn && isbns.split(' ').includes(isbn);
	}

	/**
	 * A book's record, with its derived fields.
	 * @param {Book} b
	 * @param {IdOf} idOf
	 * @param {number} position
	 * @returns {BookRecord}
	 */
	static bookRecord(b, idOf, position){
		const years = [...new Set(b.read.map(d => d.slice(0, 4)))];
		/** @type {BookRecord} */
		const rec = {id: /** @type {string} */ (b.id), title: b.title, authorIds: [...new Set(b.authors)].map(name => idOf('authors', name)),
			genres: [...b.genres], read: [...b.read], editionIds: b.editions.map(ed => /** @type {string} */ (ed.id)), position,
			sortTitle: CatalogRecords.sortKey(b.title), titleKey: Text.norm(b.title), firstAuthorKey: b.authorKey(),
			words: [...new Set(Text.norm([b.title, ...b.authors].join(' ')).split(' ').filter(Boolean))], externalKeys: externalKeys(b.external),
			readYears: years.length ? years : [CatalogRecords.UNDATED], search: CatalogRecords.searchText(b)};
		if(b.series){
			rec.seriesId = idOf('series', b.series);
			rec.seriesKey = Series.norm(b.series);
			const range = Series.range(b.number), first = parseFloat(b.number || '');
			rec.isCollection = b.isCollection() ? 1 : 0;
			rec.numberKey = range ? range[0] : Number.isFinite(first) ? first : CatalogRecords.UNNUMBERED;
			rec.numberEnd = range ? range[1] : rec.numberKey;
		}
		else rec.standalone = 1;
		if(b.number) rec.number = b.number;
		if(Object.keys(b.external).length) rec.external = /** @type {Record<string, string>} */ (ExternalCatalog.order(b.external));
		const lastRead = latest(b.read);
		if(lastRead) rec.lastRead = lastRead;
		return rec;
	}

	/**
	 * An edition's record.
	 * @param {Edition} ed
	 * @param {string[]} bookIds the books it is on
	 * @param {IdOf} idOf
	 * @returns {EditionRecord}
	 */
	static editionRecord(ed, bookIds, idOf){
		/** @type {EditionRecord} */
		const rec = {id: /** @type {string} */ (ed.id), bookIds, external: /** @type {Record<string, string>} */ (ExternalCatalog.order(ed.external) || {}),
			narratorIds: [...new Set(ed.narrators)].map(name => idOf('narrators', name)), idKeys: editionIdKeys(ed)};
		if(ed.isbn) rec.isbn = ed.isbn;
		if(ed.publisher) rec.publisherId = idOf('publishers', ed.publisher);
		if(ed.released) rec.released = ed.released;
		if(ed.minutes !== undefined) rec.minutes = ed.minutes;
		if(ed.description) rec.description = ed.description;
		return rec;
	}

	/**
	 * A series' record, with what is derived from its books.
	 * @param {string} id
	 * @param {string} name
	 * @param {Series | undefined} info
	 * @param {BookRecord[]} books the books in it
	 * @returns {SeriesRecord}
	 */
	static seriesRecord(id, name, info, books){
		// what Series counts by: the books' numbers (a range for a box set)
		const own = books.map(rec => new Book({title: rec.title, series: name, number: rec.number}));
		/** @type {SeriesRecord} */
		const rec = {id, name, sortName: CatalogRecords.sortKey(name), bookCount: books.length, owned: Series.owned(own), externalKeys: externalKeys(info ? info.external : {}),
			authorIds: [...new Set(books.flatMap(b => b.authorIds))]};
		if(info){
			if(info.total !== undefined) rec.total = info.total;
			if(info.status !== undefined) rec.status = info.status;
			if(info.note !== undefined) rec.note = info.note;
			if(info.url !== undefined) rec.url = info.url;
			if(Object.keys(info.external).length) rec.external = /** @type {Record<string, string>} */ (ExternalCatalog.order(info.external));
		}
		const missing = Series.missingNumbers(own, rec.total);
		if(missing) rec.missing = missing;
		const lastRead = latest(books.flatMap(b => b.read));
		if(lastRead) rec.lastRead = lastRead;
		return rec;
	}

	/**
	 * A series' record as it is stored (`rec`, its own fields), with what is derived worked out again from its books.
	 * @param {SeriesRecord} rec
	 * @param {BookRecord[]} books
	 * @returns {SeriesRecord}
	 */
	static rederiveSeries(rec, books){
		const info = new Series(rec.name, {total: rec.total, status: rec.status, note: rec.note, url: rec.url, external: rec.external});
		return CatalogRecords.seriesRecord(rec.id, rec.name, CatalogRecords.hasInfo('series', rec) ? info : undefined, books);
	}

	/**
	 * Whether a series' or person's record holds info (anything beside its name).
	 * @param {'series' | 'contributors'} store
	 * @param {Record<string, any>} rec
	 * @returns {boolean}
	 */
	static hasInfo(store, rec){ return CatalogRecords.INFO[store].some(k => rec[k] !== undefined); }

	/**
	 * An author's, narrator's or publisher's record, with what is derived from the books they are credited on.
	 * @param {CreditKind} kind
	 * @param {string} id
	 * @param {string} name
	 * @param {Contributor | undefined} info
	 * @param {BookRecord[]} books the books they are credited on
	 * @param {(authorId: string) => string} authorName the name of an author, to put authors with as many books in order
	 * @returns {ContributorRecord}
	 */
	static contributorRecord(kind, id, name, info, books, authorName){
		/** @type {ContributorRecord} */
		const rec = {id, kind, name, sortName: CatalogRecords.sortKey(name), bookCount: books.length,
			seriesCount: new Set(books.map(b => b.seriesId).filter(Boolean)).size, externalKeys: externalKeys(info ? info.external : {})};
		if(kind !== 'author'){
			/** @type {Map<string, number>} */
			const count = new Map();
			for(const b of books) for(const a of b.authorIds) count.set(a, (count.get(a) || 0) + 1);
			rec.topAuthorIds = [...count].sort((x, y) => y[1] - x[1] || authorName(x[0]).localeCompare(authorName(y[0]))).slice(0, 3).map(([a]) => a);
			rec.authorCount = count.size;
		}
		if(info){
			if(info.bio !== undefined) rec.bio = info.bio;
			if(info.url !== undefined) rec.url = info.url;
			if(Object.keys(info.external).length) rec.external = /** @type {Record<string, string>} */ (ExternalCatalog.order(info.external));
			if(info.links.length) rec.links = [...info.links];
		}
		return rec;
	}

	/**
	 * A person's record as it is stored (`rec`), with what is derived worked out again from their books.
	 * @param {ContributorRecord} rec
	 * @param {BookRecord[]} books
	 * @param {(authorId: string) => string} authorName
	 * @returns {ContributorRecord}
	 */
	static rederiveContributor(rec, books, authorName){
		const info = CatalogRecords.hasInfo('contributors', rec)
			? Contributor.fromJSON(rec.name, Object.fromEntries(Object.entries({bio: rec.bio, url: rec.url, ext: rec.external, links: rec.links}).filter(([, v]) => v !== undefined)))
			: undefined;
		return CatalogRecords.contributorRecord(rec.kind, rec.id, rec.name, info, books, authorName);
	}

	/**
	 * Who a book credits: its authors, and its editions' narrators and publishers, each once.
	 * @param {BookRecord} rec
	 * @param {EditionRecord[]} editions its editions
	 * @returns {CreditRecord[]}
	 */
	static creditsOf(rec, editions){
		/** @type {[CreditKind, string[]][]} */
		const kinds = [['author', rec.authorIds], ['narrator', editions.flatMap(ed => ed.narratorIds)],
			['publisher', /** @type {string[]} */ (editions.map(ed => ed.publisherId).filter(Boolean))]];
		return kinds.flatMap(([kind, ids]) => [...new Set(ids)].map(contributorId => {
			/** @type {CreditRecord} */
			const credit = {contributorId, bookId: rec.id, kind, sortTitle: rec.sortTitle};
			if(rec.seriesId){ credit.seriesId = rec.seriesId; credit.numberKey = rec.numberKey; }
			return credit;
		}));
	}

	/**
	 * The book a record and its editions' records make, with the names `nameOf` gives for the ids they point at.
	 * @param {BookRecord} rec
	 * @param {Map<string, EditionRecord>} editions by id; must hold the book's
	 * @param {(id: string, what: string) => string} nameOf throws when it knows no name for the id
	 * @returns {Book}
	 */
	static bookOf(rec, editions, nameOf){
		return new Book({
			id: rec.id, title: rec.title, authors: rec.authorIds.map(id => nameOf(id, 'author')),
			series: rec.seriesId === undefined ? undefined : nameOf(rec.seriesId, 'series'), number: rec.number,
			genres: rec.genres, read: rec.read,
			// a record from before ids were kept by external catalog has `hardcoverId`
			external: rec.external || (/** @type {{hardcoverId?: string}} */ (rec).hardcoverId ? {hardcover: /** @type {string} */ (/** @type {{hardcoverId?: string}} */ (rec).hardcoverId)} : {}),
			editions: rec.editionIds.map(id => {
				const ed = editions.get(id);
				if(!ed) throw new Error(`no edition is stored under ${id}`);
				return new Edition({id: ed.id, external: CatalogRecords.editionExternal(ed), isbn: ed.isbn,
					narrators: ed.narratorIds.map(n => nameOf(n, 'narrator')), publisher: ed.publisherId === undefined ? undefined : nameOf(ed.publisherId, 'publisher'),
					released: ed.released, minutes: ed.minutes, description: ed.description});
			}),
		});
	}

	/**
	 * The catalog the records make. Throws when they don't fit together (a book lists an edition, author
	 * or series there is no record of).
	 * @param {RecordSet} records
	 * @returns {Catalog}
	 */
	static toCatalog(records){
		const catalog = new Catalog();
		/** @type {Map<string, string>} id -> name, of series and people */
		const names = new Map();
		/** @type {<T extends {name: string}>(list: T[]) => T[]} the info by name, as a backup lists it */
		const byName = list => [...list].sort((x, y) => x.name < y.name ? -1 : x.name > y.name ? 1 : 0);
		for(const s of byName(records.series)){
			names.set(s.id, s.name);
			catalog.nameIds.series.set(s.name, s.id);
			if(s.total !== undefined || s.status !== undefined || s.note !== undefined || s.url !== undefined || s.external !== undefined){
				catalog.series.set(s.id, new Series(s.name, {total: s.total, status: s.status, note: s.note, url: s.url, external: s.external}));
			}
		}
		for(const c of byName(records.contributors)){
			const kind = CONTRIBUTOR_KIND[c.kind];
			names.set(c.id, c.name);
			catalog.nameIds[kind].set(c.name, c.id);
			// a record from before ids were kept by external catalog has its pages' addresses (fixLinks)
			const {bio, url, external, links, audible, goodreads, hardcover} = /** @type {ContributorRecord & {audible?: string, goodreads?: string, hardcover?: string}} */ (c);
			const stored = Object.fromEntries(Object.entries({bio, url, ext: external, links, audible, goodreads, hardcover}).filter(([, v]) => v !== undefined));
			const entry = Contributor.fromJSON(c.name, Contributor.fixLinks(stored, kind));
			if(Object.keys(entry.toJSON()).length) catalog[kind].set(c.id, entry);
		}
		/** @type {(id: string, what: string) => string} */
		const nameOf = (id, what) => {
			const name = names.get(id);
			if(name === undefined) throw new Error(`no ${what} is stored under ${id}`);
			return name;
		};
		const editions = new Map(records.editions.map(ed => [ed.id, ed]));
		catalog.books = [...records.books].sort((x, y) => x.position - y.position).map(rec => CatalogRecords.bookOf(rec, editions, nameOf));
		catalog.exclusions = Exclusions.parse([...records.exclusions].sort((x, y) => x.position - y.position).map(x => x.entry).join('\n'));
		for(const m of records.marks) catalog.marks.set(m.id, {...m});
		// a mark whose book is gone, or has other editions now, is put right
		catalog.resolveMarks();
		return catalog;
	}

	/**
	 * Whether records are in an older shape than fromCatalog() writes (from before ids were kept by external
	 * catalog), so the page saves them again at once and their indexes find them.
	 * @param {RecordSet} records
	 * @returns {boolean}
	 */
	static outdated(records){
		return [...records.books, ...records.series, ...records.contributors].some(rec => !Array.isArray(rec.externalKeys)) ||
			records.editions.some(ed => !ed.external);
	}

	/**
	 * An edition record's external ids; a record from before they were kept by external catalog has its
	 * ASINs by site (`asins`), `goodreadsId` and `hardcoverId`.
	 * @param {EditionRecord & {asins?: Record<string, string>, goodreadsId?: string, hardcoverId?: string}} ed
	 * @returns {Record<string, string>}
	 */
	static editionExternal(ed){
		if(ed.external) return ed.external;
		return {...ed.asins || {}, ...ed.goodreadsId ? {goodreads: ed.goodreadsId} : {}, ...ed.hardcoverId ? {hardcover: ed.hardcoverId} : {}};
	}

	/**
	 * The key a record is stored under in `store`.
	 * @param {StoreName} store
	 * @param {Record<string, any>} rec
	 * @returns {IDBValidKey}
	 */
	static keyOf(store, rec){
		const path = CatalogRecords.STORES[store].keyPath;
		return Array.isArray(path) ? path.map(k => rec[k]) : rec[path];
	}

	/**
	 * Every record as text, by store and key, to tell what the next save changes: what the record holds
	 * and its position, not what is derived (the save works that out), and no credits (all derived).
	 * @param {RecordSet} records
	 * @returns {Snapshot}
	 */
	static snapshot(records){
		/** @type {Snapshot} */
		const out = new Map();
		for(const store of CatalogRecords.STORE_NAMES){
			if(!CatalogRecords.DERIVED[store]) continue;
			out.set(store, new Map(/** @type {Record<string, any>[]} */ (records[store]).map(rec => [JSON.stringify(CatalogRecords.keyOf(store, rec)), CatalogRecords.ownText(store, rec)])));
		}
		return out;
	}

	/**
	 * A record's own values (and its position), as text in the order of their names.
	 * @param {StoreName} store
	 * @param {Record<string, any>} rec
	 * @returns {string}
	 */
	static ownText(store, rec){
		const derived = (CatalogRecords.DERIVED[store] || []).filter(k => k !== 'position');
		return JSON.stringify(Object.keys(rec).filter(k => !derived.includes(k)).sort().map(k => [k, rec[k]]));
	}

	/**
	 * A record without its derived fields (what ownText() holds, as a record).
	 * @template {Record<string, any>} T
	 * @param {StoreName} store
	 * @param {T} rec
	 * @returns {Partial<T>}
	 */
	static ownFields(store, rec){
		const derived = (CatalogRecords.DERIVED[store] || []).filter(k => k !== 'position');
		return /** @type {Partial<T>} */ (Object.fromEntries(Object.entries(rec).filter(([k]) => !derived.includes(k))));
	}

	/**
	 * Take in what another tab saved: `base` is the records as this page last read or wrote them, `mine` the
	 * records it has now and `theirs` the records stored now. A record only one side changed (added, edited
	 * or removed) is taken from that side; one both changed alike is kept; one both changed differently is a
	 * conflict, named in `conflicts` (an entry as the page shows it), and then the records are of no use.
	 * With `whole` (the page holds the whole catalog), books and exclusions keep this page's order, with the
	 * other tab's new ones after them; otherwise each keeps the position it has. Derived fields and credits
	 * are left as they come: toCatalog() doesn't read them, and the next save works them out again.
	 * @param {Snapshot} base
	 * @param {RecordSet} mine
	 * @param {RecordSet} theirs
	 * @param {boolean} [whole]
	 * @returns {{records: RecordSet, conflicts: string[]}}
	 */
	static merge(base, mine, theirs, whole = true){
		/** @type {string[]} */
		const conflicts = [];
		/** @type {Record<string, any>} */
		const records = {credits: theirs.credits};
		/** @type {(ids: string[] | undefined) => string} the first of these books, by title */
		const titleOf = ids => {
			const rec = [...mine.books, ...theirs.books].find(b => (ids || []).includes(b.id));
			return rec ? `"${rec.title}"` : 'a book';
		};
		/** @type {(store: StoreName, rec: Record<string, any>) => string} */
		const label = (store, rec) => store === 'books' ? `"${rec.title}"` : store === 'editions' ? `an edition of ${titleOf(rec.bookIds)}`
			: store === 'series' ? `the series ${rec.name}` : store === 'contributors' ? rec.name
			: store === 'marks' ? `a mark on ${titleOf(rec.bookIds)}` : rec.entry;
		for(const store of CatalogRecords.STORE_NAMES){
			const derived = CatalogRecords.DERIVED[store];
			if(!derived) continue;
			/** @type {(rec: Record<string, any> | undefined) => string | undefined} a record's own values, as text */
			const own = rec => rec && JSON.stringify(Object.entries(rec).filter(([k]) => !derived.includes(k)).sort(([x], [y]) => x < y ? -1 : x > y ? 1 : 0));
			/** @type {(list: Record<string, any>[]) => Map<string, Record<string, any>>} */
			const byKey = list => new Map(list.map(rec => [JSON.stringify(CatalogRecords.keyOf(store, rec)), rec]));
			const was = base.get(store) || new Map();
			const my = byKey(/** @type {Record<string, any>[]} */ (mine[store])), their = byKey(/** @type {Record<string, any>[]} */ (theirs[store]));
			/** @type {Record<string, any>[]} */
			const out = [];
			for(const key of new Set([...my.keys(), ...their.keys(), ...was.keys()])){
				const before = was.has(key) ? JSON.stringify(/** @type {[string, unknown][]} */ (JSON.parse(/** @type {string} */ (was.get(key)))).filter(([k]) => k !== 'position')) : undefined;
				const m = own(my.get(key)), t = own(their.get(key));
				let pick = their.get(key);
				if(m !== before && t !== m){
					if(t === before) pick = my.get(key);
					else conflicts.push(label(store, /** @type {Record<string, any>} */ (my.get(key) || their.get(key))));
				}
				if(pick) out.push(pick);
			}
			if(derived.includes('position') && whole){
				const rank = /** @type {(rec: Record<string, any>) => number} */ (rec => {
					const key = JSON.stringify(CatalogRecords.keyOf(store, rec)), m = my.get(key), t = their.get(key);
					return m ? m.position : my.size + (t ? t.position : 0);
				});
				out.sort((x, y) => rank(x) - rank(y));
				records[store] = out.map((rec, position) => ({...rec, position}));
			}
			else records[store] = out;
		}
		return {records: /** @type {RecordSet} */ (records), conflicts};
	}

	/**
	 * What a save writes to turn the records saved (`before`, a snapshot) into `records`: the records that
	 * are new or changed, and the keys of those that are gone.
	 * @param {Snapshot} before
	 * @param {RecordSet} records
	 * @returns {Changes}
	 */
	static changes(before, records){
		const after = CatalogRecords.snapshot(records);
		/** @type {Changes} */
		const out = {put: {}, delete: {}, count: 0, snapshot: after};
		for(const store of CatalogRecords.STORE_NAMES){
			if(!CatalogRecords.DERIVED[store]) continue;
			const was = before.get(store) || new Map(), now = /** @type {Map<string, string>} */ (after.get(store));
			const put = /** @type {Record<string, any>[]} */ (records[store]).filter(rec => {
				const key = JSON.stringify(CatalogRecords.keyOf(store, rec));
				return was.get(key) !== now.get(key);
			});
			const gone = [...was.keys()].filter(key => !now.has(key)).map(key => /** @type {IDBValidKey} */ (JSON.parse(key)));
			if(put.length) out.put[store] = put;
			if(gone.length) out.delete[store] = gone;
			out.count += put.length + gone.length;
		}
		return out;
	}
}
