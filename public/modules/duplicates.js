// Books that look like one title entered twice, and books whose editions look like one edition recorded
// twice. Pairs you said are different books ("Not duplicates"), and books whose editions you said are
// different ("Keep separate"), are remembered as marks so they are not offered again. A mark points at the
// books (and editions) by the ids they are stored under, so it holds when a book is retitled; backups
// write it as text (pairKey(), editionsKey()), which holds across catalogs, and a text mark is kept as it
// is until it matches books (Catalog.resolveMarks).
import {Text} from './text.js';
import {Edition} from './edition.js';
import {Book} from './book.js';
import {Series} from './series.js';

// The prefix an edition's id has in a "Keep separate" mark, by its family (ExternalCatalog.family).
/** @type {Record<string, string>} */
const MARK_PREFIX = {asin: 'id', goodreads: 'gr', hardcover: 'hc'};

/**
 * A mark of the duplicates page: two books that are "Not duplicates", a book whose editions are to be kept
 * separate ("Keep separate") with the editions it had when they were marked, or a mark as its text (from a
 * backup, or one whose books are not known), under `id` (pairMark(), keepMark(), textMark() make them).
 * @typedef {object} Mark
 * @property {string} id
 * @property {'notDuplicates' | 'keepSeparate' | 'text'} kind
 * @property {string[]} [bookIds]
 * @property {string[]} [editionIds] keepSeparate: the editions the book had when they were marked
 * @property {string} [key] keepSeparate and text: the mark's text (editionsKey() for keepSeparate)
 */

/** Finds duplicates among books. */
export class Duplicates {
	/**
	 * @param {Book[]} books
	 * @param {Map<string, Mark>} [marks] the marks by their id: pairs that are different books, and books whose editions are different
	 */
	constructor(books, marks){
		this.books = books;
		this.marks = marks || new Map();
	}

	/**
	 * Books that look like one title entered twice, as groups of indexes into the books, e.g. [[3, 17]].
	 * Two books pair up the way an import would match them, minus the ids: the same first author, series
	 * and number (spelling-insensitive), or the same author and title, forgiving Audible's long titles.
	 * Sharing an ASIN or Goodreads id pairs nothing by itself, since a box set's titles share one edition.
	 * @returns {number[][]}
	 */
	groups(){
		const books = this.books;
		const isId = (/** @type {string} */ k) => /^\["(ext|book)"/.test(k);
		/** @type {Map<string, number[]>} */
		const byKey = new Map();
		books.forEach((b, i) => {
			for(const k of b.keys().filter(k => !isId(k))){
				const list = byKey.get(k);
				if(list) list.push(i); else byKey.set(k, [i]);
			}
		});
		const parent = books.map((b, i) => i);
		/** @type {(i: number) => number} */
		const root = i => parent[i] === i ? i : (parent[i] = root(parent[i]));
		books.forEach((b, i) => {
			for(const k of b.lookupKeys().filter(k => !isId(k))){
				for(const j of byKey.get(k) || []){
					if(j !== i && !this.markedNotSame(b, books[j])) parent[root(j)] = root(i);
				}
			}
		});
		/** @type {Map<number, number[]>} */
		const groups = new Map();
		books.forEach((b, i) => {
			const r = root(i);
			const group = groups.get(r);
			if(group) group.push(i); else groups.set(r, [i]);
		});
		return [...groups.values()].filter(g => g.length > 1);
	}

	/**
	 * Books whose editions look like one edition recorded twice (see Edition.joinable), as indexes into the
	 * books; a book with an edition that another book shares (a box set) is left out, and so is a book
	 * whose editions were marked as different.
	 * @returns {number[]}
	 */
	splitEditions(){
		const books = this.books;
		const shared = Book.sharedEditionTest(books);
		return books.map((b, i) => i).filter(i => {
			const editions = books[i].editions;
			return Edition.joinable(editions) && !editions.some(shared) && !this.markedSeparate(books[i]);
		});
	}

	/**
	 * Whether the pair x, y is marked as different books: by their ids, or by a mark's text.
	 * @param {Book} x
	 * @param {Book} y
	 * @returns {boolean}
	 */
	markedNotSame(x, y){
		const marks = this.marks;
		return (x.id !== undefined && y.id !== undefined && marks.has(Duplicates.pairMark(x, y).id)) ||
			marks.has(Duplicates.textMark(Duplicates.pairKey(x, y)).id) || marks.has(Duplicates.textMark(Duplicates.pairKey(x, y, Text.asciiNorm)).id);
	}

	/**
	 * Whether the editions of `b` are marked as different editions: the ones it has now, by their ids or by a mark's text.
	 * @param {Book} b
	 * @returns {boolean}
	 */
	markedSeparate(b){
		const own = Duplicates.keepMark(b);
		return (own.kind === 'keepSeparate' && this.marks.has(own.id)) || this.marks.has(Duplicates.textMark(Duplicates.editionsKey(b)).id);
	}

	/**
	 * The mark "x and y are different books", by their ids (as text when either has none yet).
	 * @param {Book} x
	 * @param {Book} y
	 * @returns {Mark}
	 */
	static pairMark(x, y){
		if(x.id === undefined || y.id === undefined) return Duplicates.textMark(Duplicates.pairKey(x, y));
		const bookIds = [x.id, y.id].sort();
		return {id: `pair ${bookIds.join(' ')}`, kind: 'notDuplicates', bookIds};
	}

	/**
	 * The mark "the editions `b` has are different editions", by the ids of the book and its editions (as
	 * text when any has none yet).
	 * @param {Book} b
	 * @returns {Mark}
	 */
	static keepMark(b){
		const key = Duplicates.editionsKey(b);
		if(b.id === undefined || b.editions.some(ed => ed.id === undefined)) return Duplicates.textMark(key);
		const editionIds = b.editions.map(ed => /** @type {string} */ (ed.id)).sort();
		return {id: `keep ${b.id} ${editionIds.join(' ')}`, kind: 'keepSeparate', bookIds: [b.id], editionIds, key};
	}

	/**
	 * A mark as its text: a pairKey() or an editionsKey(), or anything a backup has.
	 * @param {string} key
	 * @returns {Mark}
	 */
	static textMark(key){ return {id: `text ${key}`, kind: 'text', key}; }

	/**
	 * Key for "these two books are different books", so a pair you dismissed is not offered again.
	 * Built from what identifies a title (not from list positions, which change), in either order.
	 * With `normalize` Text.asciiNorm, the key as marks made before norm() knew other scripts have it.
	 * @param {Book} x
	 * @param {Book} y
	 * @param {(text: unknown) => string} [normalize]
	 * @returns {string}
	 */
	static pairKey(x, y, normalize){
		return [Duplicates.bookKey(x, normalize), Duplicates.bookKey(y, normalize)].sort().join(' ');
	}

	/**
	 * One book's half of a pairKey(): what identifies its title.
	 * @param {Book} b
	 * @param {(text: unknown) => string} [normalize]
	 * @returns {string}
	 */
	static bookKey(b, normalize){
		const n = normalize || Text.norm;
		return Text.key(n(b.title), n(Book.firstName(b.authors)), Series.key(n(b.series)), String(b.number || '').trim());
	}

	/**
	 * The two halves (bookKey()s) of a pairKey(), or null when `mark` is not one.
	 * @param {string} mark
	 * @returns {[string, string] | null}
	 */
	static pairHalves(mark){
		// each half is a JSON list of texts, so the pair splits where "] [" ends one list and starts the other
		for(let at = mark.indexOf('] ['); at >= 0; at = mark.indexOf('] [', at + 1)){
			const x = mark.slice(0, at + 1), y = mark.slice(at + 2);
			try{ if(Array.isArray(JSON.parse(x)) && Array.isArray(JSON.parse(y))) return [x, y]; }catch(e){}
		}
		return null;
	}

	/**
	 * Key for "these editions of a book are different editions": the ids they carry, in any order. An ASIN
	 * is written "id B0...", whatever its site, as it was when editions kept one ASIN, and Goodreads' and
	 * Hardcover's ids "gr …" and "hc …", as they were before ids were kept by external catalog, so marks made then hold.
	 * @param {Book} book
	 * @returns {string}
	 */
	static editionsKey(book){
		const ids = book.editions.flatMap(ed => [
			...ed.idKeys().map(k => k.replace(/^\S+/, family => MARK_PREFIX[family] || family)),
			...ed.isbns().map(x => 'isbn ' + x),
		]);
		return Text.key('editions', ...[...new Set(ids)].sort());
	}

	/**
	 * The marks of the not-duplicates list from its text: one pairKey() or editionsKey() per line. Lines
	 * starting with '#' are comments.
	 * @param {unknown} text
	 * @returns {string[]}
	 */
	static parseMarks(text){
		return [...new Set(String(text || '').split(/\r\n|\r|\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#')))];
	}
}
