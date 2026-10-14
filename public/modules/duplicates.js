// Books that look like one title entered twice, and books whose editions look like one edition recorded
// twice. Pairs you said are different books ("Not duplicates"), and books whose editions you said are
// different ("Keep separate"), are remembered as marks (pairKey(), editionsKey()) so they are not offered again.
import {Text} from './text.js';
import {Edition} from './edition.js';
import {Book} from './book.js';
import {Series} from './series.js';

/** Finds duplicates among books. */
export class Duplicates {
	/**
	 * @param {Book[]} books
	 * @param {Set<string>} [marks] pairKey()s of pairs that are different books, and editionsKey()s of books whose editions are different
	 */
	constructor(books, marks){
		this.books = books;
		this.marks = marks || new Set();
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
		const isId = (/** @type {string} */ k) => /^\["(asin|gr|hc|hcb)"/.test(k);
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
			return Edition.joinable(editions) && !editions.some(shared) && !this.marks.has(Duplicates.editionsKey(books[i]));
		});
	}

	/**
	 * Whether the pair x, y is marked as different books, under its key now or as marked before.
	 * @param {Book} x
	 * @param {Book} y
	 * @returns {boolean}
	 */
	markedNotSame(x, y){
		return this.marks.has(Duplicates.pairKey(x, y)) || this.marks.has(Duplicates.pairKey(x, y, Text.asciiNorm));
	}

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
		const n = normalize || Text.norm;
		const id = (/** @type {Book} */ b) => Text.key(n(b.title), n(Book.firstName(b.authors)), Series.key(n(b.series)), String(b.number || '').trim());
		return [id(x), id(y)].sort().join(' ');
	}

	/**
	 * Key for "these editions of a book are different editions": the ids they carry, in any order. An ASIN
	 * is written "id B0...", whatever its site, as it was when editions kept one ASIN, so marks made then hold.
	 * @param {Book} book
	 * @returns {string}
	 */
	static editionsKey(book){
		const ids = book.editions.flatMap(ed => [
			...Edition.IDS.flatMap(k => ed.ids(k).map(v => (k === 'asin' ? 'id' : k) + ' ' + v)),
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
