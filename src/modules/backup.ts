// A backup of the catalog. Export writes version 3 (write()): the records IndexedDB keeps, by store and uid,
// without their derived fields (version 2 is the same without editions' titles, so it reads as it is). Version 1, which has no `version`, is the catalog by name ({books, seriesInfo,
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
import type {NameIds, NamedKind} from './catalog.js';
import type {Mark} from './duplicates.js';
import type {RecordSet, StoreName} from './catalog-records.js';
import type {Unchecked} from './text.js';
import type {ContributorKind} from './contributor.js';

/** What mergeInto() made of a backup and this catalog. */
export interface BackupMerge {
	books: Book[];
	/** by name */
	series: Map<string, Series>;
	authors: Map<string, Contributor>;
	narrators: Map<string, Contributor>;
	publishers: Map<string, Contributor>;
	/** entries new to the exclusions list */
	excluded: string[];
	/** marks new to this catalog */
	notDuplicates: string[];
	added: Book[];
	updated: Book[];
	removed: Book[];
	skipped: Book[];
	conflicts: {mine: Book; theirs: Book}[];
	/**
	 * series and people the backup has under the same id as
	 *   ours but another name, which take the backup's name (when it is preferred); the merged books have it already
	 */
	renamed: {kind: NamedKind; from: string; to: string}[];
	infoAdded: string[];
	infoChanged: string[];
	infoKept: string[];
	authorsAdded: string[];
	authorsChanged: string[];
	authorsKept: string[];
	narratorsAdded: string[];
	narratorsChanged: string[];
	narratorsKept: string[];
	publishersAdded: string[];
	publishersChanged: string[];
	publishersKept: string[];
}

/**
 * The parts of a backup; what a backup from before a part existed lacks is null, so the catalog keeps its own.
 */
export interface BackupInit {
	books: Book[];
	series?: Map<string, Series> | null;
	authors?: Map<string, Contributor> | null;
	narrators?: Map<string, Contributor> | null;
	publishers?: Map<string, Contributor> | null;
	/** the exclusions list's entries */
	excluded?: string[] | null;
	/** the "Not duplicates" marks, as text */
	notDuplicates?: string[] | null;
	/** the marks as the catalog keeps them, by the ids of their books, from a version 2 or 3 backup */
	marks?: Mark[] | null;
	/** the ids of series and people by name (`ids`), from a backup that has them */
	nameIds?: NameIds | null;
}
/**
 * A version 3 backup, as write() gives it: a field per store, each the store's records by their uid, without
 * the uid; the exclusions, which have none, are a sorted list of their entries.
 */
export type BackupJSON = {version: number; exclusions: string[]} & Record<
	BackupStore,
	Record<string, Record<string, unknown>>
>;
/** the stores whose records a backup keeps by uid */
export type BackupStore = Exclude<StoreName, 'credits' | 'exclusions'>;

const isText: (v: unknown) => boolean = v => typeof v === 'string' && !!v.trim();
const isTextList: (v: unknown) => boolean = v => Array.isArray(v) && v.every(isText);
// What each field of a version 2 or 3 backup's records must be, and what to call it when it isn't. The records
// are stored as they are, so a value that is none of these is refused rather than kept aside.
const SHAPES: Record<string, [(v: unknown) => boolean, string]> = {
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
	status: [v => Series.STATUSES.includes(v as any), Series.STATUSES.join(' or ')],
};
// The kinds a store's records may have.
const KINDS: Partial<Record<BackupStore, string[]>> = {
	contributors: ['author', 'narrator', 'publisher'],
	marks: ['notDuplicates', 'keepSeparate', 'text'],
};
// The lists a record always has, which a backup written by hand may leave out.
const LISTS: Partial<Record<BackupStore, string[]>> = {
	books: ['authorIds', 'genres', 'read', 'editionIds'],
	editions: ['narratorIds'],
};

/** A version 2 or 3 backup that isn't one: its message says what is wrong, for Restore and Merge to show. */
export class UnreadableBackup extends Error {}

/** A backup the page can't read because a newer version of it wrote it. */
export class NewerBackup extends Error {
	version: number;

	constructor(version: number) {
		super(
			`the backup is version ${version}, newer than this page reads (${Backup.VERSION}): reload the page to update it`,
		);
		this.version = version;
	}
}

/** A backup of the catalog. */
export class Backup {
	// The version write() writes. A backup without `version` is version 1, the catalog by name. Version 3
	// added an edition's title, which a page reading version 2 refuses as a field no backup has, so it says
	// the backup is newer instead (NewerBackup); version 2 needs no step, as it is version 3 without titles.
	// A later version adds a step that brings an older backup up to it, so every older one still reads.
	static VERSION = 3;
	// What a backup keeps of each store's records, in this order, beside the uid the record is
	// under. The rest of a record is derived (CatalogRecords.DERIVED) and is worked out again when it is
	// saved; a book's position is its place in the backup. The exclusions are a list of their entries, sorted.
	// Credits are derived as a whole, and meta is this browser's own (its revision, the Duplicates count).
	static FIELDS: Record<BackupStore, string[]> = {
		books: ['title', 'authorIds', 'seriesId', 'number', 'genres', 'read', 'external', 'editionIds'],
		editions: [
			'title',
			'external',
			'isbn',
			'narratorIds',
			'publisherId',
			'released',
			'minutes',
			'description',
			'covers',
		],
		series: ['name', 'total', 'status', 'note', 'external'],
		contributors: ['kind', 'name', 'bio', 'url', 'external', 'links'],
		marks: ['kind', 'bookIds', 'editionIds', 'key'],
	};
	static STORES: BackupStore[] = ['books', 'editions', 'series', 'contributors', 'marks'];

	books: Book[];
	series: Map<string, Series> | null;
	authors: Map<string, Contributor> | null;
	narrators: Map<string, Contributor> | null;
	publishers: Map<string, Contributor> | null;
	excluded: string[] | null;
	notDuplicates: string[] | null;
	marks: Mark[] | null;
	nameIds: NameIds | null;

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
	}: BackupInit) {
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
	 * The catalog as Export writes it: version 3, the records IndexedDB keeps (CatalogRecords.fromCatalog),
	 * each store's by its key, with only the fields in FIELDS. Gives an id to whatever in the catalog has none.
	 */
	static write(catalog: Catalog): BackupJSON {
		const records = CatalogRecords.fromCatalog(catalog);
		const out = {version: Backup.VERSION} as BackupJSON;
		for (const store of Backup.STORES) {
			const fields = Backup.FIELDS[store];
			out[store] = Object.fromEntries(
				(records[store] as Record<string, any>[]).map(rec => [
					rec.id,
					Object.fromEntries(fields.filter(f => rec[f] !== undefined).map(f => [f, rec[f]])),
				]),
			);
		}
		out.exclusions = records.exclusions.map(x => x.entry).sort();
		return out;
	}

	/**
	 * A catalog from the way it is stored, or a backup (read() says what it takes). Throws when it is not a catalog.
	 */
	static toCatalog(data: Unchecked): Catalog {
		return Catalog.fromBackup(Backup.read(data));
	}

	/**
	 * Read a backup exported from the page: version 2 or 3 (write(), readRecords()), or one without a `version`,
	 * from before (BackupV1.read() says what it takes; what a backup predates is null, so callers leave theirs
	 * alone). A backup of a version after this page's throws NewerBackup. Throws when it is none of these, or
	 * a part of it is not what it should be.
	 */
	static read(data: Unchecked): Backup {
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
	 * Read a version 2 or 3 backup (write()): its records are put together as the stored ones are (CatalogRecords.toCatalog).
	 * Throws when a record is not an object, has a field FIELDS doesn't list or one that is not what SHAPES says,
	 * or when they don't fit together (a book lists an edition, author or series the backup has no record of, two series have one name).
	 */
	static readRecords(data: Record<string, unknown>): Backup {
		const catalog = CatalogRecords.toCatalog(Backup.records(data));
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
	 * A version 2 or 3 backup's records, as IndexedDB keeps them (no derived fields or credits; a book's
	 * position is its place in the backup), checked as readRecords() says. What syncing compares (CatalogSync).
	 */
	static records(data: Record<string, unknown>): RecordSet {
		const records: Record<string, Record<string, unknown>[]> = {credits: []};
		for (const store of Backup.STORES) {
			const part = data[store] === undefined ? {} : data[store];
			if (!Text.isObject(part)) throw new Error(`${store} is not an object`);
			const fields = Backup.FIELDS[store];
			records[store] = Object.entries(part).map(([id, value], position) => {
				if (!Text.isObject(value)) throw new Error(`${store} ${Text.repr(id)} is not an object`);
				const rec: Record<string, unknown> = {id};
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
				if (kinds && !kinds.includes(rec.kind as string))
					throw new Error(
						`${store} ${Text.repr(id)}: kind is not ${kinds.slice(0, -1).join(', ')} or ${kinds[kinds.length - 1]}`,
					);
				if (store === 'books') rec.position = position;
				return rec;
			});
		}
		const exclusions = data.exclusions === undefined ? [] : data.exclusions;
		if (!isTextList(exclusions)) throw new Error('exclusions is not a list of texts');
		records.exclusions = (exclusions as string[]).map((entry, position) => ({entry, position}));
		Backup.checkNames(records as unknown as RecordSet);
		return records as unknown as RecordSet;
	}

	/**
	 * Throws when two series, or two people of a kind, have one name (or one has none): records that can't be put together.
	 */
	static checkNames(records: RecordSet) {
		for (const [store, nameOf] of [
			['series', (r: Record<string, unknown>) => r.name],
			['contributors', (r: Record<string, unknown>) => `${r.kind} ${r.name}`],
		] as const) {
			const seen = new Set();
			for (const rec of records[store] as unknown as Record<string, unknown>[]) {
				if (typeof rec.name !== 'string') throw new Error(`${store} ${Text.repr(rec.id)} has no name`);
				if (seen.has(nameOf(rec))) throw new Error(`two ${store} are named ${Text.repr(rec.name)}`);
				seen.add(nameOf(rec));
			}
		}
	}

	/**
	 * What Restore was given, as read() reads it: a backup is one file; several are the data files a catalog
	 * kept before it lived in the browser, picked together, which only a backup from before version 2 has
	 * (read() hands them to BackupV1). `files` are [{name, text}].
	 */
	static readFiles(files: {name: string; text: string}[]): Backup {
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
	 */
	mergeInto(catalog: Catalog, prefer?: 'mine' | 'backup'): BackupMerge {
		const takeBackup = prefer === 'backup';
		const books = catalog.books;
		const out = books.map(b => b.clone());
		const theirBooks = this.books.map(b => b.clone());
		const theirInfo: Record<NamedKind, Map<string, Series | Contributor>> = {
			series: new Map(this.series || []),
			authors: new Map(this.authors || []),
			narrators: new Map(this.narrators || []),
			publishers: new Map(this.publishers || []),
		};
		const ourInfo: Record<NamedKind, Map<string, Series | Contributor>> = {
			series: catalog.infoByName('series'),
			authors: catalog.infoByName('authors'),
			narrators: catalog.infoByName('narrators'),
			publishers: catalog.infoByName('publishers'),
		};
		const renamed: BackupMerge['renamed'] = [];
		// A series or person the backup has under one of our ids is ours, renamed on one side: the preferred
		// side's name goes on the books and info of both, so they come together (unless that name is another's).
		const rename: (
			books: Book[],
			info: Map<string, Series | Contributor>,
			kind: NamedKind,
			from: string,
			to: string,
		) => void = (list, info, kind, from, to) => {
			new Catalog({books: list}).renameEntry(kind, from, to); // renames on these books, which it holds
			const entry = info.get(from);
			info.delete(from);
			// a copy under the new name, as the entry is the catalog's or the backup's
			const copy = (x: unknown) => JSON.parse(JSON.stringify(x));
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
				} else if (!(this.nameIds as NameIds)[kind].has(ourName))
					rename(theirBooks, theirInfo[kind], kind, theirName, ourName);
			}
		}
		const result: Omit<BackupMerge, 'books' | 'series' | 'authors' | 'narrators' | 'publishers'> = {
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
		const index: Map<string, number[]> = new Map();
		// a box set's edition is on each of its titles, and its title is the set's (Book.alternativeTitles)
		const shared = Book.sharedEditionTest(out);
		const theirsShared = Book.sharedEditionTest(theirBooks);
		const indexBook = (i: number) =>
			out[i].keys(shared).forEach(k => {
				const list = index.get(k);
				if (!list) index.set(k, [i]);
				else if (!list.includes(i)) list.push(i);
			});
		out.forEach((b, i) => indexBook(i));
		const matched: Set<number> = new Set();
		const label = (b: Book) => JSON.stringify([b.title, b.authors, b.series || '', b.number || '']);
		// A book of the backup is one of ours by the id it is stored under (a backup of this catalog, or of
		// one restored from it), else by its title first, then its place in a series, then its ids (which a
		// box set's titles share), and each of ours matches one book of the backup at most.
		const byId = new Map(out.map((b, i) => [b.id, i]));
		const findOurs = (book: Book) => {
			const same = book.id === undefined ? undefined : byId.get(book.id);
			if (same !== undefined && !matched.has(same)) return same;
			const rank = (k: string) => (k.startsWith('["title"') ? 0 : k.startsWith('["series"') ? 1 : 2);
			for (const k of book.lookupKeys(theirsShared).sort((x, y) => rank(x) - rank(y))) {
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
		const mergeEntries = <V>(
			ours: Map<string, V>,
			theirs: Map<string, V> | null,
			added: string[],
			changed: string[],
			keptOurs: string[],
		): Map<string, V> => {
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
		const series = mergeEntries(
			ourInfo.series,
			this.series && theirInfo.series,
			result.infoAdded,
			result.infoChanged,
			result.infoKept,
		) as Map<string, Series>;
		const people: (
			kind: ContributorKind,
			added: string[],
			changed: string[],
			keptOurs: string[],
		) => Map<string, Contributor> = (kind, added, changed, keptOurs) =>
			mergeEntries(ourInfo[kind], this[kind] && theirInfo[kind], added, changed, keptOurs) as Map<
				string,
				Contributor
			>;
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
