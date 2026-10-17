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
 * A series any book names, or that has info. The rest after `external` is derived from its books.
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
 */
/** @typedef {'author' | 'narrator' | 'publisher'} CreditKind */
/**
 * An author, narrator or publisher any book names, or that has info. `sortName`, `bookCount` and `externalKeys` are derived.
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
 * @property {string[]} externalKeys their external ids, "audible.com B0…"
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
 * What a save writes: the records to put and the keys to delete, by store.
 * `snapshot` is the records after it, for the save after that.
 * @typedef {{put: Partial<Record<StoreName, object[]>>, delete: Partial<Record<StoreName, IDBValidKey[]>>, count: number, snapshot: Snapshot}} Changes
 */

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
		exclusions: {keyPath: 'entry', indexes: []},
	};
	/** @type {StoreName[]} */
	static STORE_NAMES = ['books', 'editions', 'series', 'contributors', 'credits', 'marks', 'exclusions'];
	// The derived fields of each store's records (see fromCatalog), which a save works out again from the
	// rest; credits are derived as a whole. Two tabs changed the same thing only when they changed a
	// record's other fields.
	/** @type {Record<StoreName, string[] | null>} */
	static DERIVED = {
		books: ['position', 'sortTitle', 'titleKey', 'firstAuthorKey', 'words', 'externalKeys', 'seriesKey', 'isCollection', 'numberKey', 'numberEnd', 'lastRead'],
		editions: ['bookIds', 'idKeys'],
		series: ['sortName', 'bookCount', 'owned', 'missing', 'lastRead', 'externalKeys'],
		contributors: ['sortName', 'bookCount', 'externalKeys'],
		credits: null,
		marks: [],
		exclusions: ['position'],
	};
	// The numberKey of a book in a series without a number, so it sorts after the numbered ones.
	static UNNUMBERED = Number.MAX_SAFE_INTEGER;

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
	 * @param {Catalog} catalog
	 * @param {() => string} [newId]
	 * @returns {RecordSet}
	 */
	static fromCatalog(catalog, newId = CatalogRecords.newId){
		CatalogRecords.assignIds(catalog, newId);
		const ids = catalog.nameIds;
		/** @type {(kind: NamedKind, name: string) => string} */
		const idOf = (kind, name) => /** @type {string} */ (ids[kind].get(name));

		/** @type {BookRecord[]} */
		const books = catalog.books.map((b, position) => {
			/** @type {BookRecord} */
			const rec = {id: /** @type {string} */ (b.id), title: b.title, authorIds: [...new Set(b.authors)].map(name => idOf('authors', name)),
				genres: [...b.genres], read: [...b.read], editionIds: b.editions.map(ed => /** @type {string} */ (ed.id)), position,
				sortTitle: CatalogRecords.sortKey(b.title), titleKey: Text.norm(b.title), firstAuthorKey: b.authorKey(),
				words: [...new Set(Text.norm([b.title, ...b.authors].join(' ')).split(' ').filter(Boolean))], externalKeys: externalKeys(b.external)};
			if(b.series){
				rec.seriesId = idOf('series', b.series);
				rec.seriesKey = Series.norm(b.series);
				const range = Series.range(b.number), first = parseFloat(b.number || '');
				rec.isCollection = b.isCollection() ? 1 : 0;
				rec.numberKey = range ? range[0] : Number.isFinite(first) ? first : CatalogRecords.UNNUMBERED;
				rec.numberEnd = range ? range[1] : rec.numberKey;
			}
			if(b.number) rec.number = b.number;
			if(Object.keys(b.external).length) rec.external = /** @type {Record<string, string>} */ (ExternalCatalog.order(b.external));
			const lastRead = latest(b.read);
			if(lastRead) rec.lastRead = lastRead;
			return rec;
		});

		/** @type {Map<string, EditionRecord>} */
		const editions = new Map();
		catalog.books.forEach((b, i) => {
			for(const ed of b.editions){
				const id = /** @type {string} */ (ed.id);
				const had = editions.get(id);
				if(had){ if(!had.bookIds.includes(books[i].id)) had.bookIds.push(books[i].id); continue; }
				/** @type {EditionRecord} */
				const rec = {id, bookIds: [books[i].id], external: /** @type {Record<string, string>} */ (ExternalCatalog.order(ed.external) || {}), narratorIds: [...new Set(ed.narrators)].map(name => idOf('narrators', name)),
					idKeys: editionIdKeys(ed)};
				if(ed.isbn) rec.isbn = ed.isbn;
				if(ed.publisher) rec.publisherId = idOf('publishers', ed.publisher);
				if(ed.released) rec.released = ed.released;
				if(ed.minutes !== undefined) rec.minutes = ed.minutes;
				if(ed.description) rec.description = ed.description;
				editions.set(id, rec);
			}
		});

		/** @type {Map<string, Book[]>} */
		const seriesBooks = new Map();
		for(const b of catalog.books) if(b.series) seriesBooks.set(b.series, [...(seriesBooks.get(b.series) || []), b]);
		/** @type {SeriesRecord[]} */
		const series = [...ids.series].map(([name, id]) => {
			const own = seriesBooks.get(name) || [];
			const info = catalog.series.get(id);
			/** @type {SeriesRecord} */
			const rec = {id, name, sortName: CatalogRecords.sortKey(name), bookCount: own.length, owned: Series.owned(own), externalKeys: externalKeys(info ? info.external : {})};
			if(info){
				if(info.total !== undefined) rec.total = info.total;
				if(info.status !== undefined) rec.status = info.status;
				if(info.note !== undefined) rec.note = info.note;
				if(info.url !== undefined) rec.url = info.url;
				if(Object.keys(info.external).length) rec.external = /** @type {Record<string, string>} */ (ExternalCatalog.order(info.external));
			}
			const missing = Series.missingNumbers(own, rec.total);
			if(missing) rec.missing = missing;
			const lastRead = latest(own.flatMap(b => b.read));
			if(lastRead) rec.lastRead = lastRead;
			return rec;
		});

		/** @type {CreditRecord[]} */
		const credits = [];
		/** @type {Map<string, number>} */
		const bookCount = new Map();
		catalog.books.forEach((b, i) => {
			const rec = books[i];
			for(const kind of Contributor.KINDS){
				const names = kind === 'authors' ? Catalog.authorsOf(b) : kind === 'narrators' ? Catalog.narratorsOf(b) : Catalog.publishersOf(b);
				for(const name of new Set(names)){
					const contributorId = idOf(kind, name);
					/** @type {CreditRecord} */
					const credit = {contributorId, bookId: rec.id, kind: CREDIT_KIND[kind], sortTitle: rec.sortTitle};
					if(rec.seriesId){ credit.seriesId = rec.seriesId; credit.numberKey = rec.numberKey; }
					credits.push(credit);
					bookCount.set(contributorId, (bookCount.get(contributorId) || 0) + 1);
				}
			}
		});
		/** @type {ContributorRecord[]} */
		const contributors = Contributor.KINDS.flatMap(kind => [...ids[kind]].map(([name, id]) => {
			const info = catalog[kind].get(id);
			/** @type {ContributorRecord} */
			const rec = {id, kind: CREDIT_KIND[kind], name, sortName: CatalogRecords.sortKey(name), bookCount: bookCount.get(id) || 0,
				externalKeys: externalKeys(info ? info.external : {})};
			if(info){
				if(info.bio !== undefined) rec.bio = info.bio;
				if(info.url !== undefined) rec.url = info.url;
				if(Object.keys(info.external).length) rec.external = /** @type {Record<string, string>} */ (ExternalCatalog.order(info.external));
				if(info.links.length) rec.links = [...info.links];
			}
			return rec;
		}));

		return {books, editions: [...editions.values()], series, contributors, credits, marks: [...catalog.marks.values()].map(m => ({...m})),
			exclusions: catalog.exclusions.entries.map((entry, position) => ({entry, position}))};
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
		catalog.books = [...records.books].sort((x, y) => x.position - y.position).map(rec => new Book({
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
		}));
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
	 * Every record as text, by store and key, to tell what the next save changes.
	 * @param {RecordSet} records
	 * @returns {Snapshot}
	 */
	static snapshot(records){
		/** @type {Snapshot} */
		const out = new Map();
		for(const store of CatalogRecords.STORE_NAMES){
			out.set(store, new Map(/** @type {Record<string, any>[]} */ (records[store]).map(rec => [JSON.stringify(CatalogRecords.keyOf(store, rec)), JSON.stringify(rec)])));
		}
		return out;
	}

	/**
	 * Take in what another tab saved: `base` is the records as this page last read or wrote them, `mine` the
	 * records it has now and `theirs` the records stored now. A record only one side changed (added, edited
	 * or removed) is taken from that side; one both changed alike is kept; one both changed differently is a
	 * conflict, named in `conflicts` (an entry as the page shows it), and then the records are of no use.
	 * Books and exclusions keep this page's order, with the other tab's new ones after them. Derived fields
	 * and credits are left as they come: toCatalog() doesn't read them, and the next save writes them again.
	 * @param {Snapshot} base
	 * @param {RecordSet} mine
	 * @param {RecordSet} theirs
	 * @returns {{records: RecordSet, conflicts: string[]}}
	 */
	static merge(base, mine, theirs){
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
				const before = was.has(key) ? own(JSON.parse(/** @type {string} */ (was.get(key)))) : undefined;
				const m = own(my.get(key)), t = own(their.get(key));
				let pick = their.get(key);
				if(m !== before && t !== m){
					if(t === before) pick = my.get(key);
					else conflicts.push(label(store, /** @type {Record<string, any>} */ (my.get(key) || their.get(key))));
				}
				if(pick) out.push(pick);
			}
			if(derived.includes('position')){
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
