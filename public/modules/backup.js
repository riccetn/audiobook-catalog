// A backup of the catalog. Export writes version 2 (write()): the records IndexedDB keeps, by store and uid,
// without their derived fields. Version 1, which has no `version`, is the catalog by name ({books, seriesInfo,
// authors, narrators, publishers, excluded, notDuplicates, ids}, as Catalog.toJSON() writes it), which
// BackupV1 reads (also the old data/ files picked together, and backups from before some parts existed).
// Reading either, and merging one made on another device into this catalog.
import {Text} from './text.js';
import {Edition} from './edition.js';
import {Book} from './book.js';
import {Series} from './series.js';
import {Contributor} from './contributor.js';
import {Exclusions} from './exclusions.js';
import {Duplicates} from './duplicates.js';
import {BackupV1} from './backup-v1.js';
import {CatalogRecords} from './catalog-records.js';
import {ExternalCatalog} from './external-catalog.js';
import {Cover} from './cover.js';
import {Catalog} from './catalog.js';
/** @import {NameIds, NamedKind} from './catalog.js' */
/** @import {Mark} from './duplicates.js' */
/** @import {RecordSet, StoreName} from './catalog-records.js' */
/** @import {Unchecked} from './text.js' */
/** @import {ContributorKind} from './contributor.js' */

/**
 * What mergeInto() made of a backup and this catalog.
 * @typedef {object} BackupMerge
 * @property {Book[]} books
 * @property {Map<string, Series>} series by name
 * @property {Map<string, Contributor>} authors
 * @property {Map<string, Contributor>} narrators
 * @property {Map<string, Contributor>} publishers
 * @property {string[]} excluded entries new to the exclusions list
 * @property {string[]} notDuplicates marks new to this catalog
 * @property {Book[]} added
 * @property {Book[]} updated
 * @property {Book[]} removed
 * @property {Book[]} skipped
 * @property {{mine: Book, theirs: Book}[]} conflicts
 * @property {{kind: NamedKind, from: string, to: string}[]} renamed series and people the backup has under the same id as
 *   ours but another name, which take the backup's name (when it is preferred); the merged books have it already
 * @property {string[]} infoAdded
 * @property {string[]} infoChanged
 * @property {string[]} infoKept
 * @property {string[]} authorsAdded
 * @property {string[]} authorsChanged
 * @property {string[]} authorsKept
 * @property {string[]} narratorsAdded
 * @property {string[]} narratorsChanged
 * @property {string[]} narratorsKept
 * @property {string[]} publishersAdded
 * @property {string[]} publishersChanged
 * @property {string[]} publishersKept
 */

/**
 * The parts of a backup; what a backup from before a part existed lacks is null, so the catalog keeps its own.
 * @typedef {object} BackupInit
 * @property {Book[]} books
 * @property {Map<string, Series> | null} [series]
 * @property {Map<string, Contributor> | null} [authors]
 * @property {Map<string, Contributor> | null} [narrators]
 * @property {Map<string, Contributor> | null} [publishers]
 * @property {string[] | null} [excluded] the exclusions list's entries
 * @property {string[] | null} [notDuplicates] the "Not duplicates" marks, as text
 * @property {Mark[] | null} [marks] the marks as the catalog keeps them, by the ids of their books, from a version 2 backup
 * @property {NameIds | null} [nameIds] the ids of series and people by name (`ids`), from a backup that has them
 */
/**
 * A version 2 backup, as write() gives it: a field per store, each the store's records by their uid, without
 * the uid; the exclusions, which have none, are a sorted list of their entries.
 * @typedef {{version: number, exclusions: string[]} & Record<BackupStore, Record<string, Record<string, unknown>>>} BackupJSON
 */
/** @typedef {Exclude<StoreName, 'credits' | 'exclusions'>} BackupStore the stores whose records a backup keeps by uid */

/** @type {(v: unknown) => boolean} */
const isText = v => typeof v === 'string' && !!v.trim();
/** @type {(v: unknown) => boolean} */
const isTextList = v => Array.isArray(v) && v.every(isText);
// What each field of a version 2 backup's records must be, and what to call it when it isn't. The records
// are stored as they are, so a value that is none of these is refused rather than kept aside.
/** @type {Record<string, [(v: unknown) => boolean, string]>} */
const SHAPES = {
	title: [isText, 'a text'],
	number: [isText, 'a text'],
	isbn: [isText, 'a text'],
	released: [isText, 'a text'],
	description: [isText, 'a text'],
	note: [v => typeof v === 'string', 'a text'],
	bio: [v => typeof v === 'string', 'a text'],
	url: [isText, 'a text'],
	key: [isText, 'a text'],
	name: [isText, 'a name'],
	seriesId: [isText, 'an id'],
	publisherId: [isText, 'an id'],
	authorIds: [isTextList, 'a list of ids'],
	editionIds: [isTextList, 'a list of ids'],
	narratorIds: [isTextList, 'a list of ids'],
	bookIds: [isTextList, 'a list of ids'],
	genres: [isTextList, 'a list of texts'],
	read: [isTextList, 'a list of dates'],
	links: [isTextList, 'a list of addresses'],
	external: [v => ExternalCatalog.isIds(v) || (Text.isObject(v) && !Object.keys(v).length), 'ids by catalog'],
	covers: [Cover.isKeys, 'keys by catalog'],
	minutes: [v => typeof v === 'number', 'a number'],
	total: [v => typeof v === 'number' || v === 'many', 'a number or "many"'],
	status: [v => Series.STATUSES.includes(/** @type {any} */ (v)), Series.STATUSES.join(' or ')],
};
// The kinds a store's records may have.
/** @type {Partial<Record<BackupStore, string[]>>} */
const KINDS = {contributors: ['author', 'narrator', 'publisher'], marks: ['notDuplicates', 'keepSeparate', 'text']};
// The lists a record always has, which a backup written by hand may leave out.
/** @type {Partial<Record<BackupStore, string[]>>} */
const LISTS = {books: ['authorIds', 'genres', 'read', 'editionIds'], editions: ['narratorIds']};

/** A version 2 backup that isn't one: its message says what is wrong, for Restore and Merge to show. */
export class UnreadableBackup extends Error {}

/** A backup the page can't read because a newer version of it wrote it. */
export class NewerBackup extends Error {
	/** @param {number} version */
	constructor(version) {
		super(
			`the backup is version ${version}, newer than this page reads (${Backup.VERSION}): reload the page to update it`,
		);
		this.version = version;
	}
}

/** A backup of the catalog. */
export class Backup {
	// The version write() writes. A backup without `version` is version 1, the catalog by name; a version
	// after 2 adds a step that brings a version 2 backup up to it, so every older one still reads.
	static VERSION = 2;
	// What a version 2 backup keeps of each store's records, in this order, beside the uid the record is
	// under. The rest of a record is derived (CatalogRecords.DERIVED) and is worked out again when it is
	// saved; a book's position is its place in the backup. The exclusions are a list of their entries, sorted.
	// Credits are derived as a whole, and meta is this browser's own (its revision, the Duplicates count).
	/** @type {Record<BackupStore, string[]>} */
	static FIELDS = {
		books: ['title', 'authorIds', 'seriesId', 'number', 'genres', 'read', 'external', 'editionIds'],
		editions: ['external', 'isbn', 'narratorIds', 'publisherId', 'released', 'minutes', 'description', 'covers'],
		series: ['name', 'total', 'status', 'note', 'external'],
		contributors: ['kind', 'name', 'bio', 'url', 'external', 'links'],
		marks: ['kind', 'bookIds', 'editionIds', 'key'],
	};
	/** @type {BackupStore[]} */
	static STORES = ['books', 'editions', 'series', 'contributors', 'marks'];

	/** @param {BackupInit} init */
	constructor({
		books,
		series = null,
		authors = null,
		narrators = null,
		publishers = null,
		excluded = null,
		notDuplicates = null,
		marks = null,
		nameIds = null,
	}) {
		this.books = books;
		this.series = series;
		this.authors = authors;
		this.narrators = narrators;
		this.publishers = publishers;
		this.excluded = excluded;
		this.notDuplicates = notDuplicates;
		this.marks = marks;
		this.nameIds = nameIds;
	}

	/**
	 * The catalog as Export writes it: version 2, the records IndexedDB keeps (CatalogRecords.fromCatalog),
	 * each store's by its key, with only the fields in FIELDS. Gives an id to whatever in the catalog has none.
	 * @param {Catalog} catalog
	 * @returns {BackupJSON}
	 */
	static write(catalog) {
		const records = CatalogRecords.fromCatalog(catalog);
		const out = /** @type {BackupJSON} */ ({version: Backup.VERSION});
		for (const store of Backup.STORES) {
			const fields = Backup.FIELDS[store];
			out[store] = Object.fromEntries(
				/** @type {Record<string, any>[]} */ (records[store]).map(rec => [
					rec.id,
					Object.fromEntries(fields.filter(f => rec[f] !== undefined).map(f => [f, rec[f]])),
				]),
			);
		}
		out.exclusions = records.exclusions.map(x => x.entry).sort();
		return out;
	}

	/**
	 * Read a backup exported from the page: version 2 (write(), readRecords()), or one without a `version`,
	 * from before (BackupV1.read() says what it takes; what a backup predates is null, so callers leave theirs
	 * alone). A backup of a version after this page's throws NewerBackup. Throws when it is none of these, or
	 * a part of it is not what it should be.
	 * @param {Unchecked} data
	 * @returns {Backup}
	 */
	static read(data) {
		// a backup without a version is from before version 2 (BackupV1, which goes when this line does)
		if (!(Text.isObject(data) && 'version' in data)) return new Backup(BackupV1.read(data));
		const {version} = data;
		if (!Number.isInteger(version) || version < 2) throw new Error('version is not a version number');
		if (version > Backup.VERSION) throw new NewerBackup(version);
		try {
			return Backup.readRecords(data);
		} catch (exc) {
			throw new UnreadableBackup(Text.errorText(exc), {cause: exc});
		}
	}

	/**
	 * Read a version 2 backup (write()): its records are put together as the stored ones are (CatalogRecords.toCatalog).
	 * Throws when a record is not an object, has a field FIELDS doesn't list or one that is not what SHAPES says,
	 * or when they don't fit together (a book lists an edition, author or series the backup has no record of, two series have one name).
	 * @param {Record<string, unknown>} data
	 * @returns {Backup}
	 */
	static readRecords(data) {
		/** @type {Record<string, Record<string, unknown>[]>} */
		const records = {credits: []};
		for (const store of Backup.STORES) {
			const part = data[store] === undefined ? {} : data[store];
			if (!Text.isObject(part)) throw new Error(`${store} is not an object`);
			const fields = Backup.FIELDS[store];
			records[store] = Object.entries(part).map(([id, value], position) => {
				if (!Text.isObject(value)) throw new Error(`${store} ${Text.repr(id)} is not an object`);
				/** @type {Record<string, unknown>} */
				const rec = {id};
				for (const list of LISTS[store] || []) rec[list] = [];
				for (const [field, v] of Object.entries(value)) {
					if (!fields.includes(field))
						throw new Error(`${store} ${Text.repr(id)} has a field no backup has: ${Text.repr(field)}`);
					const shape = SHAPES[field];
					if (shape && !shape[0](v))
						throw new Error(`${store} ${Text.repr(id)}: ${field} is not ${shape[1]}`);
					rec[field] = v;
				}
				const kinds = KINDS[store];
				if (kinds && !kinds.includes(/** @type {string} */ (rec.kind)))
					throw new Error(
						`${store} ${Text.repr(id)}: kind is not ${kinds.slice(0, -1).join(', ')} or ${kinds[kinds.length - 1]}`,
					);
				if (store === 'books') rec.position = position;
				return rec;
			});
		}
		const exclusions = data.exclusions === undefined ? [] : data.exclusions;
		if (!isTextList(exclusions)) throw new Error('exclusions is not a list of texts');
		records.exclusions = /** @type {string[]} */ (exclusions).map((entry, position) => ({entry, position}));
		for (const [store, nameOf] of /** @type {const} */ ([
			['series', (/** @type {Record<string, unknown>} */ r) => r.name],
			['contributors', (/** @type {Record<string, unknown>} */ r) => `${r.kind} ${r.name}`],
		])) {
			const seen = new Set();
			for (const rec of records[store]) {
				if (typeof rec.name !== 'string') throw new Error(`${store} ${Text.repr(rec.id)} has no name`);
				if (seen.has(nameOf(rec))) throw new Error(`two ${store} are named ${Text.repr(rec.name)}`);
				seen.add(nameOf(rec));
			}
		}
		const catalog = CatalogRecords.toCatalog(/** @type {RecordSet} */ (/** @type {unknown} */ (records)));
		return new Backup({
			books: catalog.books,
			series: catalog.infoByName('series'),
			authors: catalog.infoByName('authors'),
			narrators: catalog.infoByName('narrators'),
			publishers: catalog.infoByName('publishers'),
			nameIds: catalog.nameIds,
			excluded: catalog.exclusions.entries,
			notDuplicates: catalog.markTexts(),
			marks: [...catalog.marks.values()],
		});
	}

	/**
	 * What Restore was given, as read() reads it: a backup is one file; several are the data files a catalog
	 * kept before it lived in the browser, picked together, which only a backup from before version 2 has
	 * (read() hands them to BackupV1). `files` are [{name, text}].
	 * @param {{name: string, text: string}[]} files
	 * @returns {Backup}
	 */
	static readFiles(files) {
		return Backup.read(files.length === 1 ? JSON.parse(files[0].text) : files);
	}

	/**
	 * Merge this backup, made on another device, into `catalog`, when both have changed since they were
	 * last the same (there is no common ancestor to compare with, so this works from what each side has):
	 * - a book only the backup has is added, unless the catalog excludes it (it was removed here);
	 * - a book only the catalog has stays, unless the backup newly excludes it (it was removed there);
	 * - a book both have (found as imports find books) keeps the union of their genres, dates read and
	 *   editions; where title, author or series differ, `prefer` ('mine', the default, or 'backup') wins,
	 *   and the book is listed in `conflicts`;
	 * - series info and author, narrator and publisher info both have keep the preferred side's; the backup's excluded books, and
	 *   its "Not duplicates" marks, are added to the catalog's.
	 * Changes nothing it is given. Returns {books, series, authors, narrators, publishers, excluded (entries new
	 * to the catalog's exclusions), notDuplicates (marks new to the catalog), added, updated, removed, skipped,
	 * conflicts: [{mine, theirs}], infoAdded, infoChanged, infoKept, and the same for authors: authorsAdded,
	 * authorsChanged, authorsKept, for narrators (narratorsAdded, ...) and for publishers (publishersAdded, ...)}.
	 * @param {Catalog} catalog
	 * @param {'mine' | 'backup'} [prefer]
	 * @returns {BackupMerge}
	 */
	mergeInto(catalog, prefer) {
		const takeBackup = prefer === 'backup';
		const books = catalog.books;
		const out = books.map(b => b.clone());
		const theirBooks = this.books.map(b => b.clone());
		/** @type {Record<NamedKind, Map<string, Series | Contributor>>} */
		const theirInfo = {
			series: new Map(this.series || []),
			authors: new Map(this.authors || []),
			narrators: new Map(this.narrators || []),
			publishers: new Map(this.publishers || []),
		};
		/** @type {Record<NamedKind, Map<string, Series | Contributor>>} */
		const ourInfo = {
			series: catalog.infoByName('series'),
			authors: catalog.infoByName('authors'),
			narrators: catalog.infoByName('narrators'),
			publishers: catalog.infoByName('publishers'),
		};
		/** @type {BackupMerge['renamed']} */
		const renamed = [];
		// A series or person the backup has under one of our ids is ours, renamed on one side: the preferred
		// side's name goes on the books and info of both, so they come together (unless that name is another's).
		/** @type {(books: Book[], info: Map<string, Series | Contributor>, kind: NamedKind, from: string, to: string) => void} */
		const rename = (list, info, kind, from, to) => {
			new Catalog({books: list}).renameEntry(kind, from, to); // renames on these books, which it holds
			const entry = info.get(from);
			info.delete(from);
			// a copy under the new name, as the entry is the catalog's or the backup's
			const copy = (/** @type {unknown} */ x) => JSON.parse(JSON.stringify(x));
			if (entry)
				info.set(
					to,
					kind === 'series' ? Series.fromJSON(to, copy(entry)) : Contributor.fromJSON(to, copy(entry)),
				);
		};
		for (const kind of Catalog.NAMED_KINDS) {
			for (const [theirName, id] of this.nameIds ? this.nameIds[kind] : []) {
				const ourName = catalog.nameOf(kind, id);
				if (ourName === undefined || ourName === theirName) continue;
				if (takeBackup) {
					if (catalog.nameIds[kind].has(theirName)) continue;
					rename(out, ourInfo[kind], kind, ourName, theirName);
					renamed.push({kind, from: ourName, to: theirName});
				} else if (!(/** @type {NameIds} */ (this.nameIds)[kind].has(ourName)))
					rename(theirBooks, theirInfo[kind], kind, theirName, ourName);
			}
		}
		/** @type {Omit<BackupMerge, 'books' | 'series' | 'authors' | 'narrators' | 'publishers'>} */
		const result = {
			renamed,
			added: [],
			updated: [],
			removed: [],
			skipped: [],
			conflicts: [],
			infoAdded: [],
			infoChanged: [],
			infoKept: [],
			authorsAdded: [],
			authorsChanged: [],
			authorsKept: [],
			narratorsAdded: [],
			narratorsChanged: [],
			narratorsKept: [],
			publishersAdded: [],
			publishersChanged: [],
			publishersKept: [],
			excluded: [],
			notDuplicates: [],
		};

		const ours = catalog.exclusions.clone();
		const theirsOnly = new Exclusions();
		result.excluded = (this.excluded || []).map(e => ours.add(e)).filter(e => typeof e === 'string');
		result.excluded.forEach(e => theirsOnly.add(e));
		const oursMarks = new Set(catalog.markTexts());
		result.notDuplicates = Duplicates.parseMarks((this.notDuplicates || []).join('\n')).filter(
			k => !oursMarks.has(k),
		);

		// Each key leads to every book that has it: a box set's titles share their edition's ASIN.
		/** @type {Map<string, number[]>} */
		const index = new Map();
		const indexBook = (/** @type {number} */ i) =>
			out[i].keys().forEach(k => {
				const list = index.get(k);
				if (!list) index.set(k, [i]);
				else if (!list.includes(i)) list.push(i);
			});
		out.forEach((b, i) => indexBook(i));
		/** @type {Set<number>} */
		const matched = new Set();
		const label = (/** @type {Book} */ b) => JSON.stringify([b.title, b.authors, b.series || '', b.number || '']);
		// A book of the backup is one of ours by the id it is stored under (a backup of this catalog, or of
		// one restored from it), else by its title first, then its place in a series, then its ids (which a
		// box set's titles share), and each of ours matches one book of the backup at most.
		const byId = new Map(out.map((b, i) => [b.id, i]));
		const findOurs = (/** @type {Book} */ book) => {
			const same = book.id === undefined ? undefined : byId.get(book.id);
			if (same !== undefined && !matched.has(same)) return same;
			const rank = (/** @type {string} */ k) =>
				k.startsWith('["title"') ? 0 : k.startsWith('["series"') ? 1 : 2;
			for (const k of book.lookupKeys().sort((x, y) => rank(x) - rank(y))) {
				const i = (index.get(k) || []).find(x => !matched.has(x));
				if (i !== undefined) return i;
			}
		};

		for (const theirs of theirBooks) {
			const i = findOurs(theirs);
			if (i === undefined) {
				if (catalog.exclusions.covers(theirs)) {
					result.skipped.push(theirs);
					continue;
				}
				out.push(theirs.clone());
				result.added.push(out[out.length - 1]);
				indexBook(out.length - 1);
				continue;
			}
			matched.add(i);
			const mine = out[i];
			if (label(mine) !== label(theirs)) result.conflicts.push({mine: mine.clone(), theirs});
			const merged = Book.merge(takeBackup ? [theirs, mine] : [mine, theirs]);
			merged.id = mine.id; // still our book, whichever side's values won
			// an edition without ids that both sides have is still one edition
			const seen = new Set();
			merged.editions = merged.editions.filter(x => {
				const k = JSON.stringify(Edition.KEYS.map(f => x.value(f)));
				return !seen.has(k) && !!seen.add(k);
			});
			if (merged.text() === mine.text()) continue;
			out[i] = merged;
			if (!result.updated.includes(merged)) result.updated.push(merged);
			indexBook(i);
		}

		const kept = out.filter((b, i) => {
			const gone = i < books.length && !matched.has(i) && theirsOnly.covers(b);
			if (gone) result.removed.push(b);
			return !gone;
		});

		// entries only the backup has are added; where both differ, the preferred side's is kept
		/**
		 * @template V
		 * @param {Map<string, V>} ours
		 * @param {Map<string, V> | null} theirs
		 * @param {string[]} added
		 * @param {string[]} changed
		 * @param {string[]} keptOurs
		 * @returns {Map<string, V>}
		 */
		const mergeEntries = (ours, theirs, added, changed, keptOurs) => {
			const out = new Map(ours);
			for (const [name, entry] of theirs || []) {
				if (!out.has(name)) {
					out.set(name, entry);
					added.push(name);
				} else if (JSON.stringify(out.get(name)) !== JSON.stringify(entry)) {
					if (takeBackup) {
						out.set(name, entry);
						changed.push(name);
					} else keptOurs.push(name);
				}
			}
			return out;
		};
		const series = /** @type {Map<string, Series>} */ (
			mergeEntries(
				ourInfo.series,
				this.series && theirInfo.series,
				result.infoAdded,
				result.infoChanged,
				result.infoKept,
			)
		);
		/** @type {(kind: ContributorKind, added: string[], changed: string[], keptOurs: string[]) => Map<string, Contributor>} */
		const people = (kind, added, changed, keptOurs) =>
			/** @type {Map<string, Contributor>} */ (
				mergeEntries(ourInfo[kind], this[kind] && theirInfo[kind], added, changed, keptOurs)
			);
		const authors = people('authors', result.authorsAdded, result.authorsChanged, result.authorsKept);
		const narrators = people('narrators', result.narratorsAdded, result.narratorsChanged, result.narratorsKept);
		const publishers = people(
			'publishers',
			result.publishersAdded,
			result.publishersChanged,
			result.publishersKept,
		);
		return {...result, books: kept, series, authors, narrators, publishers};
	}
}
