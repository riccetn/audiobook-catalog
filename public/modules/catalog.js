// The catalog itself: the books, the series info, the author info, the exclusions list and the "Not
// duplicates" marks, and what is done to them as a whole. Inside, an entry is known by the id it is stored
// under: a book by Book.id, a series or person by their id in nameIds (the books name them, so a name leads
// to its id), and their info and the marks by those ids. It is stored (in backups) by name, as
// {books, seriesInfo, authors, narrators, publishers, excluded, notDuplicates, ids}; toJSON() writes that and fromJSON() reads it.
import {Book} from './book.js';
import {Series} from './series.js';
import {Contributor} from './contributor.js';
import {Edition} from './edition.js';
import {Exclusions} from './exclusions.js';
import {Validator} from './validator.js';
import {Merger} from './merger.js';
import {Duplicates} from './duplicates.js';
import {Backup} from './backup.js';
import {Text} from './text.js';
/** @import {Unchecked} from './text.js' */
/** @import {Problems} from './validator.js' */
/** @import {MergeReport, MergeOptions} from './merger.js' */
/** @import {ContributorKind} from './contributor.js' */
/** @import {Mark} from './duplicates.js' */

/** @typedef {'series' | ContributorKind} NamedKind what is known by its name on the books: a series, or an author, narrator or publisher */
/**
 * The ids that series, authors, narrators and publishers are stored under, by name (as the books write it),
 * whether or not there is info about them. A name keeps its id while any book has it, and a series keeps
 * its id when it is renamed (Catalog.renameSeries).
 * @typedef {Record<NamedKind, Map<string, string>>} NameIds
 */
// An edition's values without its id, for "is this copy the same edition?".
/** @type {(ed: Edition) => string} */
const editionValues = ed => JSON.stringify(Edition.KEYS.map(k => ed.value(k)));
/** @type {(ed: Edition) => string[]} */
const editionIdKeys = ed => [...new Set([...ed.idKeys(), ...ed.isbns().map(x => 'isbn ' + x)])];

/**
 * The parts of a catalog; each may be left out. The info is given by name, as a backup has it; the
 * catalog keeps it by the id each name is stored under (from `nameIds`, else a new one).
 * @typedef {object} CatalogInit
 * @property {Book[]} [books]
 * @property {Map<string, Series>} [series] series name (as the books' `series` have it) -> its info
 * @property {Map<string, Contributor>} [authors] author name (as the books' `authors` have it) -> their info
 * @property {Map<string, Contributor>} [narrators] narrator name (as the editions' `narrators` have it) -> their info
 * @property {Map<string, Contributor>} [publishers] publisher name (as the editions' `publisher` has it) -> its info
 * @property {Exclusions} [exclusions] the books imports must never re-add
 * @property {Iterable<string>} [notDuplicates] "Not duplicates" (and "Keep separate") marks of the duplicates page, as text (Duplicates.textMark)
 * @property {NameIds} [nameIds]
 */

/** The catalog. */
export class Catalog {
	/** @type {NamedKind[]} */
	static NAMED_KINDS = ['series', ...Contributor.KINDS];

	/** @returns {string} a new id */
	static newId(){ return crypto.randomUUID(); }

	/** @param {CatalogInit} [init] */
	constructor({books = [], series = new Map(), authors = new Map(), narrators = new Map(), publishers = new Map(), exclusions = new Exclusions(), notDuplicates = [],
		nameIds = Catalog.emptyNameIds()} = {}){
		this.books = books;
		this.nameIds = Catalog.copyNameIds(nameIds);
		/** @type {Map<string, Series>} series info, by the id of the series */
		this.series = new Map();
		/** @type {Map<string, Contributor>} author info, by the author's id */
		this.authors = new Map();
		/** @type {Map<string, Contributor>} narrator info, by the narrator's id */
		this.narrators = new Map();
		/** @type {Map<string, Contributor>} publisher info, by the publisher's id */
		this.publishers = new Map();
		for(const [name, info] of series) this.series.set(this.idFor('series', name), info);
		for(const [kind, byName] of /** @type {[ContributorKind, Map<string, Contributor>][]} */ ([['authors', authors], ['narrators', narrators], ['publishers', publishers]])){
			for(const [name, info] of byName) this[kind].set(this.idFor(kind, name), info);
		}
		this.exclusions = exclusions;
		/** @type {Map<string, Mark>} the duplicates page's marks, by their id */
		this.marks = new Map();
		for(const text of notDuplicates){ const mark = Duplicates.textMark(text); this.marks.set(mark.id, mark); }
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
			exclusions: Exclusions.parse((backup.excluded || []).join('\n')), notDuplicates: backup.notDuplicates || [],
			nameIds: backup.nameIds || Catalog.emptyNameIds()});
	}

	/**
	 * The catalog as a backup holds it, by name; `ids` (the ids of series and people by name) only when there are any.
	 * @returns {{books: Book[], seriesInfo: Record<string, Series>, authors: Record<string, Contributor>, narrators: Record<string, Contributor>,
	 *   publishers: Record<string, Contributor>, excluded: string[], notDuplicates: string[], ids?: Record<NamedKind, Record<string, string>>}}
	 */
	toJSON(){
		const json = {books: this.books, seriesInfo: Object.fromEntries(this.infoByName('series')), authors: Object.fromEntries(this.infoByName('authors')),
			narrators: Object.fromEntries(this.infoByName('narrators')), publishers: Object.fromEntries(this.infoByName('publishers')),
			excluded: this.exclusions.entries, notDuplicates: this.markTexts()};
		if(!Catalog.NAMED_KINDS.some(kind => this.nameIds[kind].size)) return json;
		const ids = /** @type {Record<NamedKind, Record<string, string>>} */ (Object.fromEntries(Catalog.NAMED_KINDS.map(kind => [kind, Object.fromEntries(this.nameIds[kind])])));
		return {...json, ids};
	}

	/** @returns {Catalog} a copy, sharing nothing with this one */
	clone(){
		/** @type {(x: unknown) => unknown} */
		const copy = x => JSON.parse(JSON.stringify(x));
		const out = new Catalog({books: this.books.map(b => b.clone()), exclusions: this.exclusions.clone(), nameIds: this.nameIds});
		for(const [id, s] of this.series) out.series.set(id, Series.fromJSON(s.name, copy(s)));
		for(const kind of Contributor.KINDS) for(const [id, c] of this[kind]) out[kind].set(id, Contributor.fromJSON(c.name, copy(c)));
		for(const [id, mark] of this.marks) out.marks.set(id, /** @type {Mark} */ (copy(mark)));
		return out;
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
		this.marks = other.marks;
		this.nameIds = other.nameIds;
	}

	// ------------------------------------------------------------------ ids
	/**
	 * Give an id to every book, edition, series and person in the catalog that has none, and a new one to
	 * any that shares its id with another (a book restored twice, say). A box set's edition is one record:
	 * its copies on its titles keep (or get) one id while they are the same edition, and a copy that differs
	 * gets one of its own. Ids of names no book has, and with no info, are dropped. The marks then point at
	 * the books they are about (resolveMarks).
	 * @param {() => string} [newId]
	 */
	assignIds(newId = Catalog.newId){
		const bookIds = new Set();
		for(const b of this.books){
			if(!b.id || bookIds.has(b.id)) b.id = newId();
			bookIds.add(b.id);
		}
		/** @type {Map<string, string>} edition id -> the values of the first edition seen with it */
		const valuesOf = new Map();
		/** @type {Map<string, string>} values of an edition with an identifier -> its id, to find a copy's */
		const idOf = new Map();
		for(const b of this.books){
			const own = new Set();
			for(const ed of b.editions){
				const values = editionValues(ed), shareable = editionIdKeys(ed).length > 0;
				let id = ed.id;
				if(id && (own.has(id) || (valuesOf.has(id) && valuesOf.get(id) !== values))) id = undefined;
				if(!id && shareable) id = idOf.get(values);
				if(!id || own.has(id)) id = newId();
				ed.id = id;
				own.add(id);
				if(!valuesOf.has(id)) valuesOf.set(id, values);
				if(shareable && !idOf.has(values)) idOf.set(values, id);
			}
		}
		for(const kind of Catalog.NAMED_KINDS){
			const ids = this.nameIds[kind], info = this.infoMap(kind);
			const names = this.namesOf(kind);
			// info is kept by id, so its name keeps that id whatever the books do
			for(const [id, entry] of [...info]){
				const named = ids.get(entry.name);
				if(named === undefined) ids.set(entry.name, id);
				else if(named !== id && !info.has(named)){ info.delete(id); info.set(named, entry); }
			}
			const seen = new Set();
			for(const name of [...ids.keys()]) if(!names.has(name)) ids.delete(name);
			for(const name of names){
				let id = ids.get(name);
				if(!id || seen.has(id)){
					const had = id;
					ids.set(name, id = newId());
					const entry = had === undefined ? undefined : info.get(had);
					if(entry && entry.name === name){ info.delete(/** @type {string} */ (had)); info.set(id, entry); }
				}
				seen.add(id);
			}
		}
		this.resolveMarks();
	}

	/**
	 * The names of a kind the catalog has: on its books, or with info.
	 * @param {NamedKind} kind
	 * @returns {Set<string>}
	 */
	namesOf(kind){
		/** @type {(b: Book) => string[]} */
		const onBook = kind === 'series' ? b => b.series ? [b.series] : [] : kind === 'authors' ? Catalog.authorsOf
			: kind === 'narrators' ? Catalog.narratorsOf : Catalog.publishersOf;
		return new Set([...this.books.flatMap(onBook), ...[...this.infoMap(kind).values()].map(x => x.name)]);
	}

	/**
	 * The info of a kind, by id (the series' or the people's).
	 * @param {NamedKind} kind
	 * @returns {Map<string, Series | Contributor>}
	 */
	infoMap(kind){ return /** @type {Map<string, Series | Contributor>} */ (this[kind]); }

	/**
	 * The id `name` is stored under, giving it one when it has none yet (a series or person just typed in).
	 * @param {NamedKind} kind
	 * @param {string} name
	 * @returns {string}
	 */
	idFor(kind, name){
		const ids = this.nameIds[kind];
		let id = ids.get(name);
		if(id === undefined) ids.set(name, id = Catalog.newId());
		return id;
	}

	/**
	 * The name stored under `id`; undefined when no series or person of the kind has it.
	 * @param {NamedKind} kind
	 * @param {string} id
	 * @returns {string | undefined}
	 */
	nameOf(kind, id){
		for(const [name, x] of this.nameIds[kind]) if(x === id) return name;
		return undefined;
	}

	/**
	 * The series info of the series `name`, if it has some.
	 * @param {string} name
	 * @returns {Series | undefined}
	 */
	seriesInfo(name){
		const id = this.nameIds.series.get(name);
		return id === undefined ? undefined : this.series.get(id);
	}

	/**
	 * Every entry of a kind's info by its name, as a backup has it.
	 * @template {NamedKind} K
	 * @param {K} kind
	 * @returns {Map<string, K extends 'series' ? Series : Contributor>}
	 */
	infoByName(kind){
		return new Map([...this.infoMap(kind)].map(([id, info]) => [this.nameOf(kind, id) ?? info.name,
			/** @type {K extends 'series' ? Series : Contributor} */ (info)]));
	}

	/**
	 * Replace a kind's info with `byName` (Restore, a merge applied); each name keeps the id it has.
	 * @param {NamedKind} kind
	 * @param {Map<string, Series | Contributor>} byName
	 */
	replaceInfo(kind, byName){
		const info = this.infoMap(kind);
		info.clear();
		for(const [name, entry] of byName) info.set(this.idFor(kind, name), entry);
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
	 * Save `book` in place of the book stored under `id` (or add it, when `id` is null; it gets an id of its
	 * own) and keep the editions it shares with other books in step: a copy that was identical to the edition
	 * before the edit gets the edit, and an edition that shares an ASIN or Goodreads id with one on another
	 * book (a box set being linked up) takes what that one has and passes it on. Returns how many other books changed.
	 * @param {string | null} id
	 * @param {Book} book
	 * @returns {number}
	 */
	saveBook(id, book){
		const books = this.books;
		const index = id === null ? -1 : books.findIndex(b => b.id === id);
		if(id !== null && index < 0) throw new Error(`no book is stored under ${id}`);
		if(id === null && book.id === undefined) book.id = Catalog.newId();
		const old = index < 0 ? [] : books[index].editions;
		const neu = book.editions;
		const others = books.map((b, k) => k).filter(k => k !== index);
		/** @type {(x: Edition, ed: Edition) => boolean} */
		const linked = (x, ed) => x.sharesId(ed) && !x.conflictsWith(ed);
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
		if(index < 0) books.push(book); else books[index] = book;
		return changed.size;
	}

	/**
	 * The book stored under `id`, if there is one.
	 * @param {string | null | undefined} id
	 * @returns {Book | undefined}
	 */
	book(id){ return id === null || id === undefined ? undefined : this.books.find(b => b.id === id); }

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
	duplicates(){ return new Duplicates(this.books, this.marks); }

	/**
	 * Add entries to the exclusions list (an ASIN, "ISBN 978...", "Goodreads 12345" or "Title | Author"); returns how many were new.
	 * @param {string[]} entries
	 * @returns {number}
	 */
	addExclusions(entries){ return this.exclusions.addAll(entries); }

	/**
	 * Mark each two of `books` as different books ("Not duplicates"); returns how many marks were new.
	 * @param {Book[]} books
	 * @returns {number}
	 */
	markNotDuplicates(books){
		return this.addMarks(books.flatMap((x, k) => books.slice(k + 1).map(y => Duplicates.pairMark(x, y))));
	}

	/**
	 * Mark the editions `book` has as different editions ("Keep separate"); returns 1 when that is new.
	 * @param {Book} book
	 * @returns {number}
	 */
	markKeepSeparate(book){ return this.addMarks([Duplicates.keepMark(book)]); }

	/**
	 * Add marks as a backup writes them (Duplicates.pairKey(), editionsKey()), pointing them at the books
	 * they are about where they match (resolveMarks); returns how many were new.
	 * @param {string[]} texts
	 * @returns {number}
	 */
	addMarkTexts(texts){
		const had = new Set(this.markTexts());
		const count = this.addMarks(texts.filter(t => !had.has(t)).map(Duplicates.textMark));
		this.resolveMarks();
		return count;
	}

	/**
	 * @param {Mark[]} marks
	 * @returns {number} how many were new
	 */
	addMarks(marks){
		const before = this.marks.size;
		for(const mark of marks) if(!this.marks.has(mark.id)) this.marks.set(mark.id, mark);
		return this.marks.size - before;
	}

	/**
	 * The marks as text, as a backup has them: a pair by what identifies its titles (Duplicates.pairKey()), a
	 * book's editions by their ids in external catalogs (Duplicates.editionsKey()), so they hold in another catalog too.
	 * @returns {string[]}
	 */
	markTexts(){
		const byId = new Map(this.books.map(b => [b.id, b]));
		/** @type {Set<string>} */
		const out = new Set();
		for(const m of this.marks.values()){
			const [x, y] = (m.bookIds || []).map(id => byId.get(id));
			if(m.kind === 'notDuplicates'){ if(x && y) out.add(Duplicates.pairKey(x, y)); }
			else if(m.kind === 'keepSeparate'){
				// the book's editions now, if they are still the ones marked; else the mark as it was
				const key = x && Duplicates.keepMark(x).id === m.id ? Duplicates.editionsKey(x) : m.key;
				if(key) out.add(key);
			}
			else if(m.key) out.add(m.key);
		}
		return [...out];
	}

	/**
	 * Point the marks at the books (and editions) they are about, so they still hold when a book is retitled
	 * or an edition's ids change: a mark as text that matches books by what identifies them becomes one by
	 * their ids. A "Keep separate" mark whose book has other editions now goes back to its text, and a pair
	 * mark of a book that is gone goes.
	 */
	resolveMarks(){
		/** @type {Map<string, string[]>} */
		const byHalf = new Map();
		/** @type {Map<string, Book[]>} */
		const byEditions = new Map();
		const known = new Set();
		for(const b of this.books){
			if(b.id === undefined) continue;
			known.add(b.id);
			for(const key of new Set([Duplicates.bookKey(b), Duplicates.bookKey(b, Text.asciiNorm)])) byHalf.set(key, [...(byHalf.get(key) || []), b.id]);
			const key = Duplicates.editionsKey(b);
			byEditions.set(key, [...(byEditions.get(key) || []), b]);
		}
		/** @type {Map<string, Mark>} */
		const out = new Map();
		/** @type {(mark: Mark) => void} */
		const put = mark => { if(!out.has(mark.id)) out.set(mark.id, mark); };
		for(const m of this.marks.values()){
			if(m.kind === 'notDuplicates'){
				if((m.bookIds || []).every(id => known.has(id))) put(m);
				continue;
			}
			if(m.kind === 'keepSeparate'){
				const b = this.book((m.bookIds || [])[0]);
				if(b && Duplicates.keepMark(b).id === m.id) put(m);
				else if(m.key) put(Duplicates.textMark(m.key));
				continue;
			}
			const text = m.key || '';
			const halves = Duplicates.pairHalves(text);
			const [x, y] = halves ? halves.map(h => byHalf.get(h) || []) : [[], []];
			const owners = byEditions.get(text) || [];
			if(x.length === 1 && y.length === 1 && x[0] !== y[0]){
				const bookIds = [x[0], y[0]].sort();
				put({id: `pair ${bookIds.join(' ')}`, kind: 'notDuplicates', bookIds});
			}
			else if(owners.length === 1 && Duplicates.keepMark(owners[0]).kind === 'keepSeparate'){
				put({...Duplicates.keepMark(owners[0]), key: text});
			}
			else put(m);
		}
		this.marks = out;
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
		const info = this.seriesInfo(name);
		return info ? info.missing(this.seriesBooks(name)) : null;
	}

	/**
	 * Rename a series on every book in it, and its info (which replaces any the new name had); returns how
	 * many books changed. The series keeps its id, unless it joins one that has its own.
	 * @param {string} name
	 * @param {string} newName
	 * @returns {number}
	 */
	renameSeries(name, newName){
		let count = 0;
		for(const b of this.books) if(b.series === name){ b.series = newName; count++; }
		const ids = this.nameIds.series, id = ids.get(name), joined = ids.get(newName);
		ids.delete(name);
		const info = id === undefined ? undefined : this.series.get(id);
		if(id !== undefined) this.series.delete(id);
		const target = joined ?? id;
		if(joined === undefined && id !== undefined) ids.set(newName, id);
		if(info && target !== undefined){
			info.name = newName;
			this.series.set(target, info);
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
