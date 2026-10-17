// A backup of the catalog, as Export writes it: {books, seriesInfo, authors, narrators, publishers, excluded, notDuplicates}.
// Reading one (also the old data/ files picked together, and backups from before some parts existed),
// and merging one made on another device into this catalog.
import {Text} from './text.js';
import {Edition} from './edition.js';
import {Book} from './book.js';
import {Series} from './series.js';
import {Contributor} from './contributor.js';
import {Exclusions} from './exclusions.js';
import {Duplicates} from './duplicates.js';
/** @import {Catalog, NameIds, NamedKind} from './catalog.js' */
/** @import {Unchecked} from './text.js' */
/** @import {ContributorKind} from './contributor.js' */

/**
 * What mergeInto() made of a backup and this catalog.
 * @typedef {object} BackupMerge
 * @property {Book[]} books
 * @property {Map<string, Series>} series
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
 * @property {string[] | null} [notDuplicates] the "Not duplicates" marks
 * @property {NameIds | null} [nameIds] the ids of series and people by name (`ids`), from a backup that has them
 */

/**
 * Stored books as Books, saying which one could not be read.
 * @param {Unchecked[]} list stored books, in the current format
 * @returns {Book[]}
 */
function readBooks(list){
	return list.map((b, i) => {
		try{ return Book.fromJSON(b); }
		catch(exc){ throw new Error(`book #${i}: ${Text.errorText(exc)}`); }
	});
}

/** A backup of the catalog. */
export class Backup {
	/** @param {BackupInit} init */
	constructor({books, series = null, authors = null, narrators = null, publishers = null, excluded = null, notDuplicates = null, nameIds = null}){
		this.books = books;
		this.series = series;
		this.authors = authors;
		this.narrators = narrators;
		this.publishers = publishers;
		this.excluded = excluded;
		this.notDuplicates = notDuplicates;
		this.nameIds = nameIds;
	}

	/**
	 * Read a backup exported from the page: {books: [...], seriesInfo: {...}, authors: {...}, narrators: {...},
	 * publishers: {...}, excluded: [...], notDuplicates: [...]}, or a plain array of books from before series info
	 * was exported. The books are brought to the current format (Book.fixBooks). Series info, author, narrator
	 * and publisher info, the exclusions list entries and
	 * the "Not duplicates" marks are null when the backup predates them, so callers leave theirs alone.
	 * Throws when it is neither, or a part of it is not what it should be.
	 * @param {Unchecked} data
	 * @returns {Backup}
	 */
	static read(data){
		if(Array.isArray(data)) return new Backup({books: readBooks(Book.fixBooks(data))});
		if(data && typeof data === 'object' && Array.isArray(data.books)){
			const {seriesInfo: info, excluded, notDuplicates} = data;
			if(info !== undefined && !Text.isObject(info)) throw new Error('seriesInfo is not an object');
			for(const kind of Contributor.KINDS) if(data[kind] !== undefined && !Text.isObject(data[kind])) throw new Error(`${kind} is not an object`);
			/** @type {(kind: ContributorKind) => Map<string, Contributor> | null} */
			const people = kind => data[kind] === undefined ? null
				: new Map(Object.entries(data[kind]).map(([name, entry]) => [name, Contributor.fromJSON(name, Contributor.fixLinks(entry, kind))]));
			for(const [name, list] of [['excluded', excluded], ['notDuplicates', notDuplicates]]){
				if(list !== undefined && !(Array.isArray(list) && list.every(x => typeof x === 'string'))){
					throw new Error(`${name} is not a list of strings`);
				}
			}
			return new Backup({
				nameIds: Backup.readIds(data.ids),
				books: readBooks(Book.fixBooks(data.books)),
				series: info === undefined ? null : new Map(Object.entries(info).map(([name, entry]) => [name, Series.fromJSON(name, entry)])),
				authors: people('authors'), narrators: people('narrators'), publishers: people('publishers'),
				excluded: excluded === undefined ? null : excluded,
				notDuplicates: notDuplicates === undefined ? null : notDuplicates,
			});
		}
		throw new Error('expected a list of books or {books, seriesInfo, excluded}');
	}

	/**
	 * The ids of series and people by name, as a backup keeps them (`ids`: {series: {name: id}, authors: ...});
	 * null when it has none. Throws when they are not that.
	 * @param {unknown} ids
	 * @returns {NameIds | null}
	 */
	static readIds(ids){
		if(ids === undefined) return null;
		if(!Text.isObject(ids)) throw new Error('ids is not an object');
		/** @type {NameIds} */
		const out = {series: new Map(), authors: new Map(), narrators: new Map(), publishers: new Map()};
		for(const kind of /** @type {NamedKind[]} */ (['series', ...Contributor.KINDS])){
			const named = ids[kind];
			if(named === undefined) continue;
			if(!Text.isObject(named) || !Object.values(named).every(v => typeof v === 'string' && v.trim())) throw new Error(`ids.${kind} must map names to ids`);
			out[kind] = new Map(/** @type {[string, string][]} */ (Object.entries(named)));
		}
		return out;
	}

	/**
	 * What Restore was given, as read() reads a backup: either a backup, or the data files a catalog
	 * kept before it lived in the browser, picked together and told apart by name (books.json,
	 * series-info.json, authors.json (and narrators.json, publishers.json), excluded.txt, not-duplicates.txt; a file renamed with a date, say, still
	 * counts). `files` are [{name, text}]. Throws when there are no books among them.
	 * @param {{name: string, text: string}[]} files
	 * @returns {Backup}
	 */
	static readFiles(files){
		let backup = null;
		/** @type {Record<string, unknown>} */
		const picked = {};
		for(const {name, text} of files){
			const base = String(name).toLowerCase().replace(/^.*[\\/]/, '');
			if(base.endsWith('.txt')){
				if(base.includes('not-duplicates')) picked.notDuplicates = Duplicates.parseMarks(text);
				else if(base.includes('excluded')) picked.excluded = Exclusions.parse(text).entries;
				else throw new Error(`${name}: not one of the catalog's files`);
				continue;
			}
			const json = JSON.parse(text);
			if(base.startsWith('series-info')) picked.seriesInfo = json;
			else if(base.startsWith('authors')) picked.authors = json;
			else if(base.startsWith('narrators')) picked.narrators = json;
			else if(base.startsWith('publishers')) picked.publishers = json;
			else if(Array.isArray(json)) picked.books = json;
			else if(Text.isObject(json) && Array.isArray(json.books)) backup = json;
			else throw new Error(`${name}: not one of the catalog's files`);
		}
		const all = {...backup, ...picked};
		if(!Array.isArray(all.books)) throw new Error('no books.json or backup among the files');
		return Backup.read(all);
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
	mergeInto(catalog, prefer){
		const takeBackup = prefer === 'backup';
		const books = catalog.books;
		const out = books.map(b => b.clone());
		/** @type {Omit<BackupMerge, 'books' | 'series' | 'authors' | 'narrators' | 'publishers'>} */
		const result = {added: [], updated: [], removed: [], skipped: [], conflicts: [], infoAdded: [], infoChanged: [], infoKept: [],
			authorsAdded: [], authorsChanged: [], authorsKept: [], narratorsAdded: [], narratorsChanged: [], narratorsKept: [],
			publishersAdded: [], publishersChanged: [], publishersKept: [], excluded: [], notDuplicates: []};

		const ours = catalog.exclusions.clone();
		const theirsOnly = new Exclusions();
		result.excluded = (this.excluded || []).map(e => ours.add(e)).filter(e => typeof e === 'string');
		result.excluded.forEach(e => theirsOnly.add(e));
		result.notDuplicates = Duplicates.parseMarks((this.notDuplicates || []).join('\n')).filter(k => !catalog.notDuplicates.has(k));

		// Each key leads to every book that has it: a box set's titles share their edition's ASIN.
		/** @type {Map<string, number[]>} */
		const index = new Map();
		const indexBook = (/** @type {number} */ i) => out[i].keys().forEach(k => {
			const list = index.get(k);
			if(!list) index.set(k, [i]); else if(!list.includes(i)) list.push(i);
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
			if(same !== undefined && !matched.has(same)) return same;
			const rank = (/** @type {string} */ k) => k.startsWith('["title"') ? 0 : k.startsWith('["series"') ? 1 : 2;
			for(const k of book.lookupKeys().sort((x, y) => rank(x) - rank(y))){
				const i = (index.get(k) || []).find(x => !matched.has(x));
				if(i !== undefined) return i;
			}
		};

		for(const theirs of this.books){
			const i = findOurs(theirs);
			if(i === undefined){
				if(catalog.exclusions.covers(theirs)){ result.skipped.push(theirs); continue; }
				out.push(theirs.clone());
				result.added.push(out[out.length - 1]);
				indexBook(out.length - 1);
				continue;
			}
			matched.add(i);
			const mine = out[i];
			if(label(mine) !== label(theirs)) result.conflicts.push({mine: mine.clone(), theirs});
			const merged = Book.merge(takeBackup ? [theirs, mine] : [mine, theirs]);
			merged.id = mine.id;   // still our book, whichever side's values won
			// an edition without ids that both sides have is still one edition
			const seen = new Set();
			merged.editions = merged.editions.filter(x => { const k = JSON.stringify(Edition.KEYS.map(f => x.value(f))); return !seen.has(k) && !!seen.add(k); });
			if(merged.text() === mine.text()) continue;
			out[i] = merged;
			if(!result.updated.includes(merged)) result.updated.push(merged);
			indexBook(i);
		}

		const kept = out.filter((b, i) => {
			const gone = i < books.length && !matched.has(i) && theirsOnly.covers(b);
			if(gone) result.removed.push(b);
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
			for(const [name, entry] of theirs || []){
				if(!out.has(name)){ out.set(name, entry); added.push(name); }
				else if(JSON.stringify(out.get(name)) !== JSON.stringify(entry)){
					if(takeBackup){ out.set(name, entry); changed.push(name); }
					else keptOurs.push(name);
				}
			}
			return out;
		};
		const series = mergeEntries(catalog.series, this.series, result.infoAdded, result.infoChanged, result.infoKept);
		const authors = mergeEntries(catalog.authors, this.authors, result.authorsAdded, result.authorsChanged, result.authorsKept);
		const narrators = mergeEntries(catalog.narrators, this.narrators, result.narratorsAdded, result.narratorsChanged, result.narratorsKept);
		const publishers = mergeEntries(catalog.publishers, this.publishers, result.publishersAdded, result.publishersChanged, result.publishersKept);
		return {...result, books: kept, series, authors, narrators, publishers};
	}
}
