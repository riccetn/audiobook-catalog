// What every importer of an export file (a CSV) shares: it reads the file a row at a time into books, tidied
// the way the catalog keeps them. The merge into the catalog is not an importer's: see Catalog.merge. The
// Import & export page knows only this class: a subclass says what its export is (CATALOG, LABEL) and how
// to read one of its rows (readRow).
import {Csv} from './csv.js';
/** @import {Book} from './book.js' */
/** @import {CsvRow} from './csv.js' */

/** @typedef {{books: Book[], warnings: string[], skippedUnfinished: number}} ReadResult what an importer found in an export */

/** Reads an export file into books; a subclass says how to read one of its rows (readRow). */
export class FileImporter {
	/** The catalog the export is from, as ExternalCatalog names it ('goodreads'); also its panel's prefix. */
	static CATALOG = '';
	/** A short name for the export, for the page ("Audible"). */
	static LABEL = 'CSV';
	/** Whether its editions are yours (an export of your own library's), so a comparison ticks them at first. */
	static EDITIONS_YOURS = false;

	/**
	 * @param {string} [site] the site of the catalog the export is from, for a catalog with several (Audible's);
	 *   its panel's `<CATALOG>ImportSite` field picks it
	 */
	constructor(site){
		this.site = site || '';
	}

	/** @returns {string} a short name for the export, for the page */
	get label(){ return /** @type {typeof FileImporter} */ (this.constructor).LABEL; }

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
	 * @param {CsvRow} _row
	 * @param {ReadResult} _result
	 */
	readRow(_row, _result){
		throw new Error(`${this.label}: readRow is not written`);
	}
}
