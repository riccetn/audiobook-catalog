// The merge that adds imported books to the catalog without clobbering hand edits: what an import finds
// already there only gains what it lacks. Box sets are kept both as their own book and as their titles.
import {Text} from './text.js';
import {Edition} from './edition.js';
import {Book} from './book.js';
import {Series} from './series.js';
import {Exclusions} from './exclusions.js';
/** @import {EditionKey} from './edition.js' */

/**
 * What merge() did: the books (as added, or the existing book) on each list.
 * @typedef {object} MergeReport
 * @property {Book[]} added
 * @property {Book[]} backfilled books that gained an ASIN
 * @property {Book[]} goodreadsFilled
 * @property {Book[]} hardcoverFilled
 * @property {Book[]} isbnsFilled
 * @property {Book[]} detailsFilled a narrator, publisher, release date, length or description
 * @property {Book[]} editionsAdded
 * @property {Book[]} datesFilled
 * @property {Book[]} excluded
 * @property {Book[]} notAdded
 * @property {{title: string, authors: string[], titles: number, added: number}[]} boxSets
 * @property {number} matched
 */

/**
 * @typedef {object} MergeOptions
 * @property {boolean} [allDates] add every incoming date read the book lacks, not only to a book with none
 * @property {(book: Book) => boolean} [addable] whether an unmatched book may be added
 */

// Which report list a book goes on when one of its editions gains a value.
/** @type {Record<EditionKey, 'backfilled' | 'goodreadsFilled' | 'hardcoverFilled' | 'isbnsFilled' | 'detailsFilled'>} */
const FILLED_REPORT = {asin: 'backfilled', gr: 'goodreadsFilled', hc: 'hardcoverFilled', isbn: 'isbnsFilled', n: 'detailsFilled', p: 'detailsFilled', d: 'detailsFilled', len: 'detailsFilled', desc: 'detailsFilled'};

/** Adds books to a list of books, the way imports do. */
export class Merger {
	/**
	 * @param {Book[]} books the books to add to; changed in place
	 * @param {Exclusions} [exclusions] what must never be added
	 * @param {MergeOptions} [opts]
	 */
	constructor(books, exclusions, opts){
		this.books = books;
		this.exclusions = exclusions || new Exclusions();
		this.opts = opts || {};
	}

	/**
	 * Append incoming books that are not among the books yet. An existing book always wins, except that it
	 * gains dates read when it has none, and the editions it lacks:
	 * - an incoming edition with the same ASIN, Goodreads id or ISBN as one of the book's editions fills in
	 *   what that edition is missing (and so does every copy of it on a box set's other titles);
	 * - otherwise, when the book has one edition of its own that does not disagree on the ASIN or
	 *   Goodreads id, that edition is filled in (a Goodreads export finding the book an Audible import added);
	 * - otherwise the incoming edition is added as another edition of the book.
	 * A book of another Hardcover book that finds a book by a box set's edition is the box set: its dates
	 * read go to every title the edition is on. Series names are folded onto the spelling already in use.
	 * ISBNs never make two books the same: one ISBN may be on several books (a boxed set's ISBN on each
	 * book in it).
	 * Options: `allDates` adds every incoming date read the book lacks, not only to a book with none (for
	 * sources that keep every read, like Hardcover; a date counts as there when the book has it or the month
	 * or year it falls in); `addable(book)` says whether an unmatched book may be added (others only fill
	 * in a book they match, and go on `notAdded`).
	 * A box set with a series range ("1-3") and an id or ISBN is kept as its own book and becomes its titles
	 * too (see mergeBoxSet below); so is a book of another Hardcover book found by a box set's edition.
	 * Returns {added, backfilled, goodreadsFilled, hardcoverFilled, isbnsFilled, detailsFilled, editionsAdded,
	 * datesFilled, excluded, notAdded, boxSets, matched}: books that gained an ASIN, a Goodreads id, a Hardcover
	 * id, ISBNs, a narrator, publisher, release date or length, a new edition, dates read; box sets
	 * kept as their own book and their titles ({title, authors, titles: how many you had, added: how many were added}).
	 * The incoming books are copied, never changed or added themselves.
	 * @param {Book[]} incoming
	 * @returns {MergeReport}
	 */
	merge(incoming){
		const existing = this.books, exclusions = this.exclusions, opts = this.opts;
		/** @type {MergeReport} */
		const report = {added: [], backfilled: [], goodreadsFilled: [], hardcoverFilled: [], isbnsFilled: [], detailsFilled: [], editionsAdded: [],
			datesFilled: [], excluded: [], notAdded: [], boxSets: [], matched: 0};

		/** @type {Map<string, number>} */
		const index = new Map();
		const indexKey = (/** @type {string} */ k, /** @type {number} */ i) => { if(!index.has(k)) index.set(k, i); };
		const indexBook = (/** @type {number} */ i) => existing[i].keys().forEach(k => indexKey(k, i));
		existing.forEach((b, i) => indexBook(i));

		/** @type {Map<string, string>} */
		const canonical = new Map();
		for(const b of existing){
			if(b.series && !canonical.has(Series.norm(b.series))) canonical.set(Series.norm(b.series), b.series);
		}

		// [book index, edition] of every copy of an edition, on any book, other than the edition itself
		/** @type {(ed: Edition) => [number, Edition][]} */
		const copiesOf = ed => existing.flatMap((b, i) => b.editions.filter(x => x !== ed && x.sameAs(ed)).map(x => /** @type {[number, Edition]} */ ([i, x])));
		/** @type {(list: Book[], book: Book) => void} */
		const note = (list, book) => { if(!list.includes(book) && !report.added.includes(book)) list.push(book); };
		/** @type {(reader: Book, rec: Book) => void} */
		const giveDates = (reader, rec) => {
			if(rec.read.length && reader.value('r') === undefined){
				reader.read = [...rec.read];
				note(report.datesFilled, reader);
			} else if(opts.allDates && rec.read.length && reader.read.length){
				const more = rec.read.filter(d => !reader.hasReadDate(d));
				if(more.length){
					reader.read = [...new Set([...reader.read, ...more])].sort();
					note(report.datesFilled, reader);
				}
			}
		};
		// Give book `i` (one title of a box set, whose titles are `set`) the set's edition `ed`: it fills in
		// the copy the book has (by an id, or the one edition it shares with another title of the set that
		// does not disagree, as when Goodreads' box set finds the one an Audible import split), else is added
		// beside the book's own editions, which are other editions and never filled in.
		/** @type {(i: number, ed: Edition, set: number[]) => void} */
		const giveBoxEdition = (i, ed, set) => {
			const book = existing[i];
			const shared = book.editions.filter(x => !x.conflictsWith(ed) && copiesOf(x).some(([j]) => j !== i && set.includes(j)));
			const target = book.editions.find(x => x.sameAs(ed)) || (shared.length === 1 ? shared[0] : undefined);
			if(target){
				for(const field of target.fillFrom(ed)) note(report[FILLED_REPORT[field]], book);
			} else {
				book.editions = [...book.editions, ed.clone()];
				note(report.editionsAdded, book);
			}
			indexBook(i);
		};
		// An edition of a box set's own book: the set's edition, described by the set's title when it has no description.
		/** @type {(ed: Edition, title: string) => Edition} */
		const setEdition = (ed, title) => {
			const copy = ed.clone();
			if(!copy.description && title) copy.description = title;
			return copy;
		};

		/**
		 * An incoming box set (a series and a range, "1-3") is kept as its own title, and each number is a title
		 * too, found by author, series and number (or by already holding the set's edition), or else added. The
		 * set and every title get the set's edition, and the set's dates read when they have none. The set is
		 * found by holding its edition without being one title of the series, by its title, or by author, series
		 * and range. Returns false when nothing ties the titles together, and the set then merges as any other book.
		 * @type {(rec: Book, original: Book, range: [number, number]) => boolean}
		 */
		const mergeBoxSet = (rec, original, [lo, hi]) => {
			// without an id or ISBN there is nothing to tie the titles together, so the set stays one book
			if(!rec.editions.some(ed => Edition.IDS.some(k => ed.ids(k).length) || ed.isbns().length)) return false;
			const editions = rec.editions.map(ed => setEdition(ed, rec.title));
			const author = rec.authorKey(), series = Series.norm(rec.series);
			const ownsSet = (/** @type {Book} */ b) => b.editions.some(x => editions.some(ed => Edition.IDS.some(k => x.sharesId(ed, k)) && x.sameAs(ed)));
			const titleNumber = (/** @type {Book} */ b) => b.authorKey() === author && Series.norm(b.series || '') === series && /^\d+$/.test(String(b.number || '').trim()) ?
				Number(String(b.number).trim()) : null;
			/** @type {number[]} */
			const titles = [];
			const excluded = exclusions.covers(rec);
			let added = 0;
			// whether `book` (the set or one of its titles) may be added; a refused one goes on its report list
			/** @type {(book: Book, isSet: boolean) => boolean} */
			const add = (book, isSet) => {
				if(excluded || (!isSet && exclusions.covers(book))){ report.excluded.push(book); return false; }
				if(opts.addable && !opts.addable(original)){ report.notAdded.push(book); return false; }
				existing.push(book);
				report.added.push(book);
				indexBook(existing.length - 1);
				return true;
			};
			const copy = (/** @type {Book} */ book) => {
				book.genres = [...rec.genres];
				book.read = [...rec.read];
				book.editions = editions.map(ed => ed.clone());
				return book;
			};
			const rangeKey = Text.key('series', author, series, String(rec.number).trim());
			let setIndex = existing.findIndex(b => (ownsSet(b) && titleNumber(b) === null) || (Text.norm(b.title) === Text.norm(rec.title) && b.authorKey() === author));
			const atRange = index.get(rangeKey);
			if(setIndex < 0 && atRange !== undefined) setIndex = atRange;
			const setFound = setIndex >= 0;
			for(let n = lo; n <= hi; n++){
				let i = existing.findIndex(b => ownsSet(b) && titleNumber(b) === n);
				if(i < 0) i = index.get(Text.key('series', author, series, String(n))) ?? -1;
				if(i >= 0 && i !== setIndex){ titles.push(i); continue; }
				// (a box set has a series)
				const title = new Book({title: Series.boxSetTitle(String(rec.series), n), authors: rec.authors, series: rec.series, number: String(n)});
				if(add(copy(title), false)) added++;
			}
			const set = new Book({title: rec.title, authors: rec.authors, series: rec.series, number: String(rec.number).trim()});
			if(!setFound && add(copy(set), true)) setIndex = existing.length - 1;
			const found = setFound ? [...titles, setIndex] : titles;
			if(found.length) report.matched++;
			const before = found.map(i => JSON.stringify(existing[i]));
			for(const i of found){
				for(const ed of editions) giveBoxEdition(i, ed, found);
				giveDates(existing[i], rec);
			}
			// every copy of the set's edition ends up with all it is known by
			for(const ed of editions){
				const copies = existing.flatMap((b, i) => b.editions.filter(x => x.sameAs(ed)).map(x => /** @type {[number, Edition]} */ ([i, x])));
				for(const [, x] of copies) for(const [, y] of copies) x.fillFrom(y);
				copies.forEach(([i]) => indexBook(i));
			}
			const changed = found.filter((i, j) => JSON.stringify(existing[i]) !== before[j]).length;
			if(added || changed || (!setFound && setIndex >= 0)) report.boxSets.push({title: rec.title, authors: rec.authors, titles: titles.length, added});
			return true;
		};

		for(const original of incoming){
			const rec = original.clone();
			if(rec.series){
				const k = Series.norm(rec.series);
				if(!canonical.has(k)) canonical.set(k, rec.series);
				rec.series = canonical.get(k);
			}
			const range = rec.boxRange();
			if(range && mergeBoxSet(rec, original, range)) continue;

			const hit = rec.lookupKeys().find(k => index.has(k));
			if(hit !== undefined){
				let match = /** @type {number} */ (index.get(hit)), book = existing[match];
				report.matched++;
				// A book of another Hardcover book that finds a book by a box set's edition finds the book that is
				// that Hardcover book, when there is one: the set kept as its own book, or another of its titles.
				if(rec.hardcoverId && book.hardcoverId !== rec.hardcoverId){
					const set = existing.findIndex((b, i) => i !== match && b.hardcoverId === rec.hardcoverId &&
						b.editions.some(x => rec.editions.some(ed => x.sameAs(ed))));
					if(set >= 0){ match = set; book = existing[set]; }
				}
				const isSet = book.isCollection();
				// A Hardcover book other than this one, found by a box set's edition, is the box set: reading it
				// was reading each of its titles, and so is reading a set kept as its own book.
				const boxSet = !!(rec.hardcoverId && book.hardcoverId && rec.hardcoverId !== book.hardcoverId);
				/** @type {Edition[]} */
				const setEditions = [];
				const readers = new Set([match]);
				for(const ed of rec.editions){
					const own = book.editions;
					let target = own.find(x => x.sameAs(ed));
					if(!target && own.length === 1 && !own[0].conflictsWith(ed) && !copiesOf(own[0]).length) target = own[0];
					if(target){
						const copies = copiesOf(target);
						if(boxSet || isSet) copies.forEach(([i]) => readers.add(i));
						if(boxSet && copies.length) setEditions.push(target);
						for(const field of target.fillFrom(ed)) note(report[FILLED_REPORT[field]], book);
						for(const [i, copy] of copies){ copy.fillFrom(target); indexBook(i); }
					} else if(own.length){
						book.editions = [...own, ed.clone()];
						note(report.editionsAdded, book);
					} else {
						// a book without editions just gains the ids it lacked, as before editions existed
						const first = new Edition();
						book.editions = [first];
						for(const field of first.fillFrom(ed)) note(report[FILLED_REPORT[field]], book);
					}
					indexBook(match);
				}
				if(rec.hardcoverId && !book.hardcoverId){
					book.hardcoverId = rec.hardcoverId;
					note(report.hardcoverFilled, book);
					indexBook(match);
				}
				for(const i of readers) giveDates(existing[i], rec);
				// the box set is kept as its own book beside its titles when they are numbers in a row of one
				// series, so it can be their collection ("1-3")
				const titles = [...readers].map(i => existing[i]), number = setEditions.length ? Merger.collectionNumber(titles) : null;
				if(number && (!rec.series || Series.norm(rec.series) === Series.norm(titles[0].series))){
					const set = rec.clone();
					set.series = titles[0].series;
					set.number = number;
					set.editions = setEditions.map(ed => setEdition(ed, rec.title));
					if(exclusions.covers(set)) report.excluded.push(set);
					else if(opts.addable && !opts.addable(original)) report.notAdded.push(set);
					else {
						existing.push(set);
						report.added.push(set);
						indexBook(existing.length - 1);
						report.boxSets.push({title: set.title, authors: set.authors, titles: titles.length, added: 0});
					}
				}
				continue;
			}
			if(exclusions.covers(rec)){
				report.excluded.push(rec);
				continue;
			}
			if(opts.addable && !opts.addable(original)){
				report.notAdded.push(rec);
				continue;
			}
			existing.push(rec);
			report.added.push(rec);
			indexBook(existing.length - 1);
		}
		return report;
	}

	/**
	 * Keep each box set in `books` both as its own book and as its titles (changes `books` in place, never
	 * changing a value it has): a set kept as one book (a series range, "1-3", and an id or ISBN) gains its
	 * titles the way an import of it would add them, and titles that share an edition, numbers in a row of one
	 * series, gain the set as its own book (named by the edition's description, else "Series, Books 1-3"),
	 * with the dates read they all have. Nothing `exclusions` covers is added.
	 * Returns merge()'s report, whose `added` are the titles and sets added.
	 * @param {Book[]} books
	 * @param {Exclusions} [exclusions]
	 * @returns {MergeReport}
	 */
	static boxSets(books, exclusions){
		exclusions = exclusions || new Exclusions();
		const report = new Merger(books, exclusions).merge(books.filter(b => b.isCollection()));
		const done = new Set();
		for(const b of [...books]){
			for(const ed of b.editions){
				if(done.has(ed) || !Edition.IDS.some(k => ed.ids(k).length)) continue;
				const copies = books.flatMap(x => x.editions.filter(y => y.sameAs(ed)).map(y => /** @type {[Book, Edition]} */ ([x, y])));
				copies.forEach(([, y]) => done.add(y));
				const holders = [...new Set(copies.map(([x]) => x))];
				const number = holders.some(x => x.isCollection()) ? null : Merger.collectionNumber(holders);
				if(!number) continue;
				const first = holders.find(x => x.number === number.split('-')[0]) || holders[0];
				const dates = holders.every(x => x.read.length) ? first.read.filter(d => holders.every(x => x.read.includes(d))) : [];
				const set = new Book({title: ed.description || `${first.series}, Books ${number}`, authors: first.authors, series: first.series, number,
					read: dates, editions: [ed.clone()]});
				if(exclusions.covers(set)){ report.excluded.push(set); continue; }
				books.push(set);
				report.added.push(set);
				report.boxSets.push({title: set.title, authors: set.authors, titles: holders.length, added: 0});
			}
		}
		return report;
	}

	/**
	 * "1-3" when `books` are titles 1, 2 and 3 of one series, by one first author; else null.
	 * @param {Book[]} books
	 * @returns {string | null}
	 */
	static collectionNumber(books){
		if(books.length < 2) return null;
		const series = Series.norm(books[0].series || ''), author = books[0].authorKey();
		const numbers = books.map(b => series && Series.norm(b.series || '') === series && b.authorKey() === author &&
			/^\d+$/.test(String(b.number || '').trim()) ? Number(String(b.number).trim()) : NaN).sort((x, y) => x - y);
		if(numbers.some((n, i) => Number.isNaN(n) || (i && n !== numbers[i - 1] + 1))) return null;
		return `${numbers[0]}-${numbers[numbers.length - 1]}`;
	}
}
