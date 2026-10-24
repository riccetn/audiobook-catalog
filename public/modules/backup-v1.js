// Backups from before version 2, which have no `version`: the catalog by name ({books, seriesInfo, authors,
// narrators, publishers, excluded, notDuplicates, ids}, as Catalog.toJSON() writes it), a plain list of books
// from before series info was exported, and the data/ files a catalog kept before it lived in the browser.
// Backup.read() hands such a backup here; what this reads becomes a Backup.
import {Text} from './text.js';
import {Book} from './book.js';
import {Series} from './series.js';
import {Contributor} from './contributor.js';
import {Exclusions} from './exclusions.js';
import {Duplicates} from './duplicates.js';
/** @import {NameIds, NamedKind} from './catalog.js' */
/** @import {Unchecked} from './text.js' */
/** @import {ContributorKind} from './contributor.js' */
/** @import {BackupInit} from './backup.js' */

/**
 * Stored books as Books, saying which one could not be read.
 * @param {Unchecked[]} list stored books, in the current format
 * @returns {Book[]}
 */
function readBooks(list){
	return list.map((b, i) => {
		try{ return Book.fromJSON(b); }
		catch(exc){ throw new Error(`book #${i}: ${Text.errorText(exc)}`, {cause: exc}); }
	});
}

/** Reads version 1 backups and the old data/ files; every method is static. */
export class BackupV1 {
	/**
	 * The parts of a version 1 backup: {books: [...], seriesInfo: {...}, authors: {...}, narrators: {...},
	 * publishers: {...}, excluded: [...], notDuplicates: [...], ids: {...}}, or a plain array of books from
	 * before series info was exported. The books are brought to the current format (Book.fixBooks). Series
	 * info, author, narrator and publisher info, the exclusions list entries and the "Not duplicates" marks
	 * are null when the backup predates them, so callers leave theirs alone. Throws when it is neither, or a
	 * part of it is not what it should be.
	 * @param {Unchecked} data
	 * @returns {BackupInit}
	 */
	static read(data){
		if(Array.isArray(data)) return {books: readBooks(Book.fixBooks(data))};
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
			const parts = {
				nameIds: BackupV1.readIds(data.ids),
				books: readBooks(Book.fixBooks(data.books)),
				series: info === undefined ? null : new Map(Object.entries(info).map(([name, entry]) => [name, Series.fromJSON(name, entry)])),
				authors: people('authors'), narrators: people('narrators'), publishers: people('publishers'),
				excluded: excluded === undefined ? null : excluded,
				notDuplicates: notDuplicates === undefined ? null : notDuplicates,
			};
			// a series' site, from before authors and publishers kept their own, goes to them
			if(parts.series) Series.moveSites(parts.series, parts.books, parts, (_kind, name) => name);
			return parts;
		}
		throw new Error('expected a list of books or {books, seriesInfo, excluded}');
	}

	/**
	 * The ids of series and people by name, as a version 1 backup keeps them (`ids`: {series: {name: id}, authors: ...});
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
	 * The backup the files Restore was given make, for Backup.read(): a backup on its own, or the data files a
	 * catalog kept before it lived in the browser, picked together and told apart by name (books.json,
	 * series-info.json, authors.json (and narrators.json, publishers.json), excluded.txt, not-duplicates.txt;
	 * a file renamed with a date, say, still counts), as a version 1 backup (a version 1 backup among them is
	 * their base). `files` are [{name, text}]. Throws when there are no books among them.
	 * @param {{name: string, text: string}[]} files
	 * @returns {Unchecked}
	 */
	static fromFiles(files){
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
			else if(Text.isObject(json) && (Array.isArray(json.books) || json.version !== undefined)) backup = json;
			else throw new Error(`${name}: not one of the catalog's files`);
		}
		// a backup of a later version is whole: the old files have nothing to add to it
		if(backup && backup.version !== undefined && !Object.keys(picked).length) return backup;
		const all = {...backup, ...picked};
		if(!Array.isArray(all.books)) throw new Error('no books.json or backup among the files');
		return all;
	}
}
