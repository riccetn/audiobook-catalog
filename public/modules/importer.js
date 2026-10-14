// What every importer of an export (a CSV file) shares: it reads the file a row at a time into books,
// tidied the way the catalog keeps them. The merge into the catalog is not an importer's: see Catalog.merge.
import {Book} from './book.js';
import {Csv} from './csv.js';
/** @import {CsvRow} from './csv.js' */
/** @import {Unchecked} from './text.js' */

/** @typedef {{books: Book[], warnings: string[], skippedUnfinished: number}} ReadResult what an importer found in an export */

/** Reads an export into books; a subclass says how to read one of its rows (readRow). */
export class Importer {
	/** A short name for the export, for the page ("Audible"). */
	get label(){ return 'CSV'; }

	/**
	 * Read the text of an export.
	 * @param {unknown} text
	 * @returns {ReadResult}
	 */
	read(text){
		/** @type {ReadResult} */
		const result = {books: [], warnings: [], skippedUnfinished: 0};
		for(const row of Csv.parse(text)) this.readRow(row, result);
		return result;
	}

	/**
	 * Read one row into `result`: a book read, a warning, or one more book skipped as unfinished.
	 * @param {CsvRow} row
	 * @param {ReadResult} result
	 */
	readRow(row, result){
		throw new Error(`${this.label}: readRow is not written`);
	}

	/**
	 * A book made of what a row holds, in the stored form, tidied the way the catalog keeps it (Book.tidyJSON).
	 * @param {Unchecked} rec
	 * @returns {Book}
	 */
	static book(rec){ return Book.fromJSON(Book.tidyJSON(rec)); }
}
