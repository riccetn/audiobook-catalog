// The Goodreads importer: a Goodreads library export CSV, of which audio editions on the "read" shelf are kept.
import {Text} from './text.js';
import {Edition} from './edition.js';
import {Series} from './series.js';
import {Csv} from './csv.js';
import {Importer} from './importer.js';
/** @import {CsvRow} from './csv.js' */
/** @import {ReadResult} from './importer.js' */

// Goodreads has no "audiobook" flag; the edition's binding is the best signal there is.
const AUDIO_BINDINGS = new Set(['Audio CD', 'Audiobook', 'Audible Audio', 'MP3 CD', 'MP3 Book', 'Audio']);
const cell = Csv.cell;

/** Reads a Goodreads library export CSV. */
export class GoodreadsImporter extends Importer {
	static AUDIO_BINDINGS = AUDIO_BINDINGS;

	get label(){ return 'Goodreads'; }

	/**
	 * @param {CsvRow} row
	 * @param {ReadResult} result
	 */
	readRow(row, result){
		if(!AUDIO_BINDINGS.has(cell(row, 'Binding'))) return;
		if(cell(row, 'Exclusive Shelf') !== 'read'){ result.skippedUnfinished++; return; }
		const [title, series, number] = GoodreadsImporter.readTitle(row.Title || '');
		// the book as stored, with its edition's ISBNs as a list until Book.tidyJSON() makes one edition per ISBN
		/** @type {Record<string, any>} */
		const rec = {t: title, a: Text.splitNames(cell(row, 'Author'))};
		if(series){
			rec.s = series;
			if(number) rec.sn = number;
		}
		const shelves = (row.Bookshelves || '').split(',').map(s => s.trim()).filter(Boolean);
		if(shelves.length) rec.g = shelves;
		/** @type {Record<string, any>} */
		const edition = {};
		// Goodreads' own id for the edition; spreadsheet programs sometimes save it as ="12345".
		const gr = cell(row, 'Book Id').replace(/[="\s]/g, '');
		if(Edition.GOODREADS_ID.test(gr)) edition.gr = gr;
		// Goodreads' own export has no ASIN, but a CSV made like it may; an ASIN Goodreads knows is amazon.com's
		const asin = cell(row, 'ASIN').replace(/[="\s]/g, '').toUpperCase();
		if(/^[A-Z0-9]{10}$/.test(asin)) edition.asin = {[Edition.AMAZON_SITE]: asin};
		// Goodreads files narrators under "Additional Authors"; treat that as a best guess.
		if(Text.splitNames(cell(row, 'Additional Authors')).length) edition.n = Text.splitNames(cell(row, 'Additional Authors'));
		const isbns = Csv.rowIsbns(row);
		if(isbns.length) edition.isbn = isbns;
		if(cell(row, 'Publisher')) edition.p = cell(row, 'Publisher');
		const year = Text.parseDate(cell(row, 'Year Published'));   // this edition's; "Original Publication Year" is the book's
		if(year) edition.d = year;
		if(Object.keys(edition).length) rec.e = [edition];
		const read = Text.parseDate(cell(row, 'Date Read'));   // Goodreads keeps only the latest read
		if(read) rec.r = [read];
		const book = Importer.book(rec);
		if(book.authors.length && book.title) result.books.push(book);
	}

	/**
	 * A Goodreads title: "Frosted (Blaze, #6; Dana O'Hare, #1)" or "Frosted: Blaze, Book 6" -> ["Frosted", "Blaze", "6"].
	 * When both are there, the colon part is dropped if it names the same series.
	 * @param {string} raw
	 * @returns {[string, string | null, string | null]}
	 */
	static readTitle(raw){
		const [title, series, number] = Series.parseTitle(raw);
		const colon = Series.parseColonTitle(title);
		if(!colon) return [title, series, number];
		if(!series) return colon;
		return Series.norm(colon[1]) === Series.norm(series) ? [colon[0], series, number || colon[2]] : [title, series, number];
	}
}
