// The catalog itself: the books, the series info, the author info, the exclusions list and the "Not
// duplicates" marks, and what is done to them as a whole. It is stored (in localStorage and in backups) as
// {books, seriesInfo, authors, excluded, notDuplicates}; toJSON() writes that and fromJSON() reads it.
import {Book} from './book.js';
import {Series} from './series.js';
import {Author} from './author.js';
import {Edition} from './edition.js';
import {Exclusions} from './exclusions.js';
import {Validator} from './validator.js';
import {Merger} from './merger.js';
import {Duplicates} from './duplicates.js';
import {Backup} from './backup.js';
/** @import {Unchecked} from './text.js' */
/** @import {Problems} from './validator.js' */
/** @import {MergeReport, MergeOptions} from './merger.js' */

/**
 * The parts of a catalog; each may be left out.
 * @typedef {object} CatalogInit
 * @property {Book[]} [books]
 * @property {Map<string, Series>} [series] series name (as the books' `series` have it) -> its info
 * @property {Map<string, Author>} [authors] author name (as the books' `authors` have it) -> their info
 * @property {Exclusions} [exclusions] the books imports must never re-add
 * @property {Set<string>} [notDuplicates] the "Not duplicates" (and "Keep separate") marks of the duplicates page
 */

/** The catalog. */
export class Catalog {
	/** @param {CatalogInit} [init] */
	constructor({books = [], series = new Map(), authors = new Map(), exclusions = new Exclusions(), notDuplicates = new Set()} = {}){
		this.books = books;
		this.series = series;
		this.authors = authors;
		this.exclusions = exclusions;
		this.notDuplicates = notDuplicates;
	}

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
			exclusions: Exclusions.parse((backup.excluded || []).join('\n')), notDuplicates: new Set(backup.notDuplicates || [])});
	}

	/** @returns {{books: Book[], seriesInfo: Record<string, Series>, authors: Record<string, Author>, excluded: string[], notDuplicates: string[]}} the catalog as a backup holds it */
	toJSON(){
		return {books: this.books, seriesInfo: Object.fromEntries(this.series), authors: Object.fromEntries(this.authors),
			excluded: this.exclusions.entries, notDuplicates: [...this.notDuplicates]};
	}

	/** @returns {Catalog} a copy, sharing nothing with this one */
	clone(){
		/** @type {(x: unknown) => unknown} */
		const copy = x => JSON.parse(JSON.stringify(x));
		return new Catalog({books: this.books.map(b => b.clone()),
			series: new Map([...this.series].map(([name, s]) => [name, Series.fromJSON(name, copy(s))])),
			authors: new Map([...this.authors].map(([name, a]) => [name, Author.fromJSON(name, copy(a))])),
			exclusions: this.exclusions.clone(), notDuplicates: new Set(this.notDuplicates)});
	}

	/**
	 * Take every part of `other` (Restore, a merge applied).
	 * @param {Catalog} other
	 */
	replaceWith(other){
		this.books = other.books;
		this.series = other.series;
		this.authors = other.authors;
		this.exclusions = other.exclusions;
		this.notDuplicates = other.notDuplicates;
	}

	// ------------------------------------------------------------------ the Check
	/**
	 * What is wrong with the books and series info (Validator.validate), and with the author info when
	 * `authors` (Validator.validateAuthors).
	 * @param {{authors?: boolean}} [opts]
	 * @returns {Problems}
	 */
	validate({authors = false} = {}){
		const json = JSON.parse(JSON.stringify(this));
		const problems = Validator.validate(json.books, json.seriesInfo);
		if(authors){
			const people = Validator.validateAuthors(json.books, json.authors);
			problems.errors.push(...people.errors);
			problems.warnings.push(...people.warnings);
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
		const own = this.books.filter(b => b.authors.includes(name));
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
	 * Every author of the books, as [{name, books (how many), series (how many)}], by name.
	 * @returns {{name: string, books: number, series: number}[]}
	 */
	authorList(){
		/** @type {Map<string, {name: string, books: number, series: Set<string>}>} */
		const seen = new Map();
		for(const b of this.books){
			for(const name of new Set(b.authors)){
				let entry = seen.get(name);
				if(!entry) seen.set(name, entry = {name, books: 0, series: new Set()});
				entry.books++;
				if(b.series) entry.series.add(b.series);
			}
		}
		return [...seen.values()].map(x => ({...x, series: x.series.size})).sort((x, y) => x.name.localeCompare(y.name));
	}
}
