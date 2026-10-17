// The Goodreads exporter: the catalog as a Goodreads library export CSV, which Goodreads' import accepts.
import {Edition} from './edition.js';
import {Isbn} from './isbn.js';
import {Csv} from './csv.js';
/** @import {Book} from './book.js' */

// Goodreads shelf names are lower case with hyphens: "Science Fiction" -> "science-fiction".
/** @type {(g: string) => string} */
const shelf = g => g.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');

/** Writes books as a Goodreads library export. */
export class GoodreadsExporter {
	// The columns of a Goodreads library export, which is also what goodreads.com/review/import takes.
	static COLUMNS = ['Book Id', 'Title', 'Author', 'Additional Authors', 'ISBN', 'ISBN13', 'Publisher', 'Binding',
		'Year Published', 'Date Read', 'Bookshelves', 'Exclusive Shelf', 'Read Count'];

	/**
	 * Write `books` as a Goodreads library export CSV: every book on the "read" shelf, with its series in
	 * the title as Goodreads writes it, its genres as shelves, and the Goodreads id and ISBNs of one edition
	 * so Goodreads picks that edition (without them it goes by title and author). Goodreads keeps one date
	 * read, so a book gets its latest full date; a book without one (no dates, or only "2024-03") goes on the
	 * shelf with no date. Returns {csv, books, withoutIds, withoutDate}.
	 * @param {Book[]} books
	 * @returns {{csv: string, books: number, withoutIds: number, withoutDate: number}}
	 */
	write(books){
		/** @type {Map<string, Set<Book>>} */
		const owners = new Map();   // "gr:123" / "asin:B0..." / "isbn:978..." -> books carrying it
		const edKeys = (/** @type {Edition} */ ed) => [...ed.ids('asin').map(v => 'asin:' + v), ...ed.ids('goodreads').map(v => 'gr:' + v), ...ed.isbns().map(i => 'isbn:' + i)];
		books.forEach(book => book.editions.forEach(ed => edKeys(ed).forEach(k => {
			let set = owners.get(k);
			if(!set) owners.set(k, set = new Set());
			set.add(book);
		})));
		const report = {books: 0, withoutIds: 0, withoutDate: 0};
		const lines = [GoodreadsExporter.COLUMNS.join(',')];
		for(const book of books){
			if(!book.title || !book.authors.length) continue;
			const ed = GoodreadsExporter.edition(book, x => edKeys(x).some(k => (owners.get(k) || new Set()).size > 1)) || new Edition();
			const isbn = ed.isbns()[0] || '';
			const series = book.series ? ` (${book.series}${book.number ? ', #' + book.number : ''})` : '';
			const dates = book.read.filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
			/** @type {Record<string, string>} */
			const row = {
				'Book Id': ed.idOn('goodreads') || '',
				'Title': book.title + series,
				'Author': book.authors[0],
				'Additional Authors': book.authors.slice(1).join(', '),
				'ISBN': Isbn.isbn10Of(isbn),
				'ISBN13': isbn,
				'Publisher': ed.publisher || '',
				'Binding': ed.ids('asin').length ? 'Audible Audio' : 'Audiobook',
				'Year Published': ed.released ? ed.released.slice(0, 4) : '',
				'Date Read': dates.length ? dates[dates.length - 1].replace(/-/g, '/') : '',
				'Bookshelves': book.genres.map(shelf).filter(Boolean).join(', '),
				'Exclusive Shelf': 'read',
				'Read Count': book.read.length ? String(book.read.length) : '',
			};
			lines.push(GoodreadsExporter.COLUMNS.map(c => Csv.field(row[c])).join(','));
			report.books++;
			if(!ed.idOn('goodreads') && !isbn) report.withoutIds++;
			if(!dates.length) report.withoutDate++;
		}
		return {csv: lines.join('\n') + '\n', ...report};
	}

	/**
	 * The edition Goodreads should find a book by: one of its own (a box set's edition is on several titles,
	 * and its ids would make Goodreads file every one of them as the box set; the set's own book may use it), with a Goodreads id and an
	 * ISBN if possible. `shared` tells whether an id or ISBN is on another book too.
	 * @param {Book} book
	 * @param {(ed: Edition) => boolean} shared
	 * @returns {Edition | null}
	 */
	static edition(book, shared){
		const own = book.editions.filter(ed => book.isCollection() || !shared(ed));   // a box set's own book is the set
		const rank = (/** @type {Edition} */ ed) => (ed.idOn('goodreads') ? 2 : 0) + (ed.isbns().length ? 1 : 0);
		return own.reduce((/** @type {Edition | null} */ best, ed) => (!best || rank(ed) > rank(best) ? ed : best), null);
	}
}
