// The catalog itself: the books, the series info, the author info, the exclusions list and the "Not
// duplicates" marks, and what is done to them as a whole. It is stored (in localStorage and in backups) as
// {books, seriesInfo, authors, narrators, publishers, excluded, notDuplicates}; toJSON() writes that and fromJSON() reads it.
import {Book} from './book.js';
import {Series} from './series.js';
import {Contributor} from './contributor.js';
import {Edition} from './edition.js';
import {Exclusions} from './exclusions.js';
import {Validator} from './validator.js';
import {Merger} from './merger.js';
import {Duplicates} from './duplicates.js';
import {Backup} from './backup.js';
/** @import {Unchecked} from './text.js' */
/** @import {Problems} from './validator.js' */
/** @import {MergeReport, MergeOptions} from './merger.js' */
/** @import {ContributorKind} from './contributor.js' */

/** @typedef {'series' | ContributorKind} NamedKind what is known by its name on the books: a series, or an author, narrator or publisher */
/**
 * The ids that series, authors, narrators and publishers are stored under, by name (as the books write it),
 * whether or not there is info about them. A name keeps its id while any book has it, and a series keeps
 * its id when it is renamed (Catalog.renameSeries).
 * @typedef {Record<NamedKind, Map<string, string>>} NameIds
 */

/**
 * The parts of a catalog; each may be left out.
 * @typedef {object} CatalogInit
 * @property {Book[]} [books]
 * @property {Map<string, Series>} [series] series name (as the books' `series` have it) -> its info
 * @property {Map<string, Contributor>} [authors] author name (as the books' `authors` have it) -> their info
 * @property {Map<string, Contributor>} [narrators] narrator name (as the editions' `narrators` have it) -> their info
 * @property {Map<string, Contributor>} [publishers] publisher name (as the editions' `publisher` has it) -> its info
 * @property {Exclusions} [exclusions] the books imports must never re-add
 * @property {Set<string>} [notDuplicates] the "Not duplicates" (and "Keep separate") marks of the duplicates page
 * @property {NameIds} [nameIds]
 */

/** The catalog. */
export class Catalog {
	/** @type {NamedKind[]} */
	static NAMED_KINDS = ['series', ...Contributor.KINDS];

	/** @param {CatalogInit} [init] */
	constructor({books = [], series = new Map(), authors = new Map(), narrators = new Map(), publishers = new Map(), exclusions = new Exclusions(), notDuplicates = new Set(),
		nameIds = Catalog.emptyNameIds()} = {}){
		this.books = books;
		this.series = series;
		this.authors = authors;
		this.narrators = narrators;
		this.publishers = publishers;
		this.exclusions = exclusions;
		this.notDuplicates = notDuplicates;
		this.nameIds = nameIds;
	}

	/** @returns {NameIds} no ids yet */
	static emptyNameIds(){ return {series: new Map(), authors: new Map(), narrators: new Map(), publishers: new Map()}; }

	/**
	 * A catalog from the way it is stored, or a backup (Backup.read() says what it takes). Throws when it is
	 * not a catalog.
	 * @param {Unchecked} data
	 * @returns {Catalog}
	 */
	static fromJSON(data){ return Catalog.fromBackup(Backup.read(data)); }

	/**
	 * A catalog made of a backup; what the backup lacks is empty.
	 * @param {Backup} backup
	 * @returns {Catalog}
	 */
	static fromBackup(backup){
		return new Catalog({books: backup.books, series: backup.series || new Map(), authors: backup.authors || new Map(),
			narrators: backup.narrators || new Map(), publishers: backup.publishers || new Map(),
			exclusions: Exclusions.parse((backup.excluded || []).join('\n')), notDuplicates: new Set(backup.notDuplicates || []),
			nameIds: backup.nameIds || Catalog.emptyNameIds()});
	}

	/**
	 * The catalog as a backup holds it; `ids` (the ids of series and people by name) only when there are any.
	 * @returns {{books: Book[], seriesInfo: Record<string, Series>, authors: Record<string, Contributor>, narrators: Record<string, Contributor>,
	 *   publishers: Record<string, Contributor>, excluded: string[], notDuplicates: string[], ids?: Record<NamedKind, Record<string, string>>}}
	 */
	toJSON(){
		const json = {books: this.books, seriesInfo: Object.fromEntries(this.series), authors: Object.fromEntries(this.authors),
			narrators: Object.fromEntries(this.narrators), publishers: Object.fromEntries(this.publishers),
			excluded: this.exclusions.entries, notDuplicates: [...this.notDuplicates]};
		if(!Catalog.NAMED_KINDS.some(kind => this.nameIds[kind].size)) return json;
		const ids = /** @type {Record<NamedKind, Record<string, string>>} */ (Object.fromEntries(Catalog.NAMED_KINDS.map(kind => [kind, Object.fromEntries(this.nameIds[kind])])));
		return {...json, ids};
	}

	/** @returns {Catalog} a copy, sharing nothing with this one */
	clone(){
		/** @type {(x: unknown) => unknown} */
		const copy = x => JSON.parse(JSON.stringify(x));
		const copyInfo = (/** @type {Map<string, Contributor>} */ info) => new Map([...info].map(([name, c]) => [name, Contributor.fromJSON(name, copy(c))]));
		return new Catalog({books: this.books.map(b => b.clone()),
			series: new Map([...this.series].map(([name, s]) => [name, Series.fromJSON(name, copy(s))])),
			authors: copyInfo(this.authors), narrators: copyInfo(this.narrators), publishers: copyInfo(this.publishers),
			exclusions: this.exclusions.clone(), notDuplicates: new Set(this.notDuplicates), nameIds: Catalog.copyNameIds(this.nameIds)});
	}

	/**
	 * @param {NameIds} ids
	 * @returns {NameIds} a copy
	 */
	static copyNameIds(ids){
		const out = Catalog.emptyNameIds();
		for(const kind of Catalog.NAMED_KINDS) out[kind] = new Map(ids[kind]);
		return out;
	}

	/**
	 * Take every part of `other` (Restore, a merge applied).
	 * @param {Catalog} other
	 */
	replaceWith(other){
		this.books = other.books;
		this.series = other.series;
		this.authors = other.authors;
		this.narrators = other.narrators;
		this.publishers = other.publishers;
		this.exclusions = other.exclusions;
		this.notDuplicates = other.notDuplicates;
		this.nameIds = other.nameIds;
	}

	// ------------------------------------------------------------------ the Check
	/**
	 * What is wrong with the books and series info (Validator.validate), and with the author, narrator and
	 * publisher info when `contributors` (Validator.validateContributors).
	 * @param {{contributors?: boolean}} [opts]
	 * @returns {Problems}
	 */
	validate({contributors = false} = {}){
		const json = JSON.parse(JSON.stringify(this));
		const problems = Validator.validate(json.books, json.seriesInfo);
		if(contributors){
			for(const kind of Contributor.KINDS){
				const found = Validator.validateContributors(json.books, kind, json[kind]);
				problems.errors.push(...found.errors);
				problems.warnings.push(...found.warnings);
			}
		}
		return problems;
	}

	// ------------------------------------------------------------------ books
	/**
	 * Put `book` at `index` (or add it, when `index` is null) and keep the editions it shares with other
	 * books in step: a copy that was identical to the edition before the edit gets the edit, and an
	 * edition that shares an ASIN or Goodreads id with one on another book (a box set being linked up)
	 * takes what that one has and passes it on. Returns how many other books changed.
	 * @param {number | null} index
	 * @param {Book} book
	 * @returns {number}
	 */
	saveBook(index, book){
		const books = this.books;
		const old = index === null ? [] : books[index].editions;
		const neu = book.editions;
		const others = books.map((b, k) => k).filter(k => k !== index);
		/** @type {(x: Edition, ed: Edition) => boolean} */
		const linked = (x, ed) => Edition.IDS.some(f => x.sharesId(ed, f)) && !x.conflictsWith(ed);
		const befores = neu.map((ed, j) => old.find(x => x.sameAs(ed)) || (old.length === neu.length ? old[j] : undefined));
		/** @type {(x: Edition, y: Edition | undefined) => boolean} */
		const same = (x, y) => y !== undefined && JSON.stringify(x) === JSON.stringify(y);
		neu.forEach((ed, j) => {
			for(const k of others) for(const x of books[k].editions) if(!same(x, befores[j]) && linked(x, ed)) ed.fillFrom(x);
		});
		const changed = new Set();
		neu.forEach((ed, j) => {
			for(const k of others){
				books[k].editions = books[k].editions.map(x => {
					if(!(same(x, befores[j]) || linked(x, ed)) || same(x, ed)) return x;
					changed.add(k);
					return ed.clone();
				});
			}
		});
		if(index === null) books.push(book); else books[index] = book;
		return changed.size;
	}

	/**
	 * Add books the way imports do (see Merger.merge), never adding one the exclusions list covers.
	 * @param {Book[]} incoming
	 * @param {MergeOptions} [opts]
	 * @returns {MergeReport}
	 */
	merge(incoming, opts){ return new Merger(this.books, this.exclusions, opts).merge(incoming); }

	/**
	 * Keep each box set both as its own book and as its titles (see Merger.boxSets).
	 * @returns {MergeReport}
	 */
	addBoxSets(){ return Merger.boxSets(this.books, this.exclusions); }

	/** @returns {Duplicates} the duplicates among the books, but for those marked "Not duplicates" */
	duplicates(){ return new Duplicates(this.books, this.notDuplicates); }

	/**
	 * Add entries to the exclusions list (an ASIN, "ISBN 978...", "Goodreads 12345" or "Title | Author"); returns how many were new.
	 * @param {string[]} entries
	 * @returns {number}
	 */
	addExclusions(entries){ return this.exclusions.addAll(entries); }

	/**
	 * Add "Not duplicates" marks; returns how many were new.
	 * @param {string[]} marks
	 * @returns {number}
	 */
	addNotDuplicates(marks){
		const before = this.notDuplicates.size;
		marks.forEach(m => this.notDuplicates.add(m));
		return this.notDuplicates.size - before;
	}

	// ------------------------------------------------------------------ series and authors
	/**
	 * The books of a series, as they are listed.
	 * @param {string} name
	 * @returns {Book[]}
	 */
	seriesBooks(name){ return this.books.filter(b => b.series === name); }

	/**
	 * The series numbers you don't own yet, from the series info's released total; null when that is unknown.
	 * @param {string} name
	 * @returns {number[] | null}
	 */
	missing(name){
		const info = this.series.get(name);
		return info ? info.missing(this.seriesBooks(name)) : null;
	}

	/**
	 * Rename a series on every book in it, and its info (which replaces any the new name had); returns how many books changed.
	 * @param {string} name
	 * @param {string} newName
	 * @returns {number}
	 */
	renameSeries(name, newName){
		let count = 0;
		for(const b of this.books) if(b.series === name){ b.series = newName; count++; }
		// the series keeps its id, unless it joins one that has its own
		const ids = this.nameIds.series, id = ids.get(name);
		ids.delete(name);
		if(id !== undefined && !ids.has(newName)) ids.set(newName, id);
		const info = this.series.get(name);
		if(info){
			this.series.delete(name);
			info.name = newName;
			this.series.set(newName, info);
		}
		return count;
	}

	/**
	 * What `name` wrote (alone or with others), from the books: {series: [{name, books}], titles} with each
	 * series' books in series order and the books outside a series by title.
	 * @param {string} name
	 * @returns {{series: {name: string, books: Book[]}[], titles: Book[]}}
	 */
	authorWorks(name){
		return this.creditedWorks(Catalog.authorsOf, name);
	}

	/**
	 * Every author of the books, as [{name, books (how many), series (how many)}], by name.
	 * @returns {{name: string, books: number, series: number}[]}
	 */
	authorList(){
		return this.creditedList(Catalog.authorsOf);
	}

	/**
	 * The books `name` narrates (any edition of them), as authorWorks() gives an author's.
	 * @param {string} name
	 * @returns {{series: {name: string, books: Book[]}[], titles: Book[]}}
	 */
	narratorWorks(name){
		return this.creditedWorks(Catalog.narratorsOf, name);
	}

	/**
	 * Every narrator of the books' editions, as authorList() gives the authors.
	 * @returns {{name: string, books: number, series: number}[]}
	 */
	narratorList(){
		return this.creditedList(Catalog.narratorsOf);
	}

	/**
	 * The books `name` publishes (any edition of them), as authorWorks() gives an author's.
	 * @param {string} name
	 * @returns {{series: {name: string, books: Book[]}[], titles: Book[]}}
	 */
	publisherWorks(name){
		return this.creditedWorks(Catalog.publishersOf, name);
	}

	/**
	 * Every publisher of the books' editions, as authorList() gives the authors.
	 * @returns {{name: string, books: number, series: number}[]}
	 */
	publisherList(){
		return this.creditedList(Catalog.publishersOf);
	}

	/** @param {Book} b @returns {string[]} its authors */
	static authorsOf(b){ return b.authors; }
	/** @param {Book} b @returns {string[]} the narrators of all its editions, each once */
	static narratorsOf(b){ return [...new Set(b.editions.flatMap(ed => ed.narrators))]; }
	/** @param {Book} b @returns {string[]} the publishers of all its editions, each once */
	static publishersOf(b){ return [...new Set(b.editions.map(ed => ed.publisher || '').filter(Boolean))]; }

	/**
	 * The books `namesOf` credits to `name`: {series: [{name, books}], titles} with each series' books in
	 * series order and the books outside a series by title.
	 * @param {(b: Book) => string[]} namesOf
	 * @param {string} name
	 * @returns {{series: {name: string, books: Book[]}[], titles: Book[]}}
	 */
	creditedWorks(namesOf, name){
		const own = this.books.filter(b => namesOf(b).includes(name));
		/** @type {Map<string, Book[]>} */
		const bySeries = new Map();
		for(const b of own){
			if(!b.series) continue;
			const list = bySeries.get(b.series);
			if(list) list.push(b); else bySeries.set(b.series, [b]);
		}
		const series = [...bySeries].sort((x, y) => x[0].localeCompare(y[0])).map(([s, list]) => ({name: s, books: list.sort(Book.bySeriesNumber)}));
		const titles = own.filter(b => !b.series).sort((x, y) => x.title.localeCompare(y.title));
		return {series, titles};
	}

	/**
	 * Everyone `namesOf` credits on the books, as [{name, books (how many), series (how many)}], by name.
	 * @param {(b: Book) => string[]} namesOf
	 * @returns {{name: string, books: number, series: number}[]}
	 */
	creditedList(namesOf){
		/** @type {Map<string, {name: string, books: number, series: Set<string>}>} */
		const seen = new Map();
		for(const b of this.books){
			for(const name of new Set(namesOf(b))){
				let entry = seen.get(name);
				if(!entry) seen.set(name, entry = {name, books: 0, series: new Set()});
				entry.books++;
				if(b.series) entry.series.add(b.series);
			}
		}
		return [...seen.values()].map(x => ({...x, series: x.series.size})).sort((x, y) => x.name.localeCompare(y.name));
	}
}
