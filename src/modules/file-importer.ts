// What every importer of an export file (a CSV) shares: it reads the file a row at a time into books, tidied
// the way the catalog keeps them. The merge into the catalog is not an importer's: see Catalog.merge. The
// Import & export page knows only this class: a subclass says what its export is (CATALOG, LABEL) and how
// to read one of its rows (readRow).
import {Csv} from './csv.js';
import type {Book} from './book.js';
import type {CsvRow} from './csv.js';

/** what an importer found in an export */
export type ReadResult = {books: Book[]; warnings: string[]; skippedUnfinished: number};

/** Reads an export file into books; a subclass says how to read one of its rows (readRow). */
export class FileImporter {
	/** The catalog the export is from, as ExternalCatalog names it ('goodreads'); also its panel's prefix. */
	static CATALOG = '';
	/** A short name for the export, for the page ("Audible"). */
	static LABEL = 'CSV';
	/** Whether its editions are yours (an export of your own library's), so a comparison ticks them at first. */
	static EDITIONS_YOURS = false;
	/**
	 * Whether its titles are its editions' (an Audible site's, a Goodreads edition's), not the work's, so a
	 * comparison may offer one the catalog lacks as the title that edition was released under.
	 */
	static EDITION_TITLES = false;

	site: string;

	/**
	 * @param site the site of the catalog the export is from, for a catalog with several (Audible's);
	 *   its panel's `<CATALOG>ImportSite` field picks it
	 */
	constructor(site?: string) {
		this.site = site || '';
	}

	/** @returns a short name for the export, for the page */
	get label(): string {
		return (this.constructor as typeof FileImporter).LABEL;
	}

	/**
	 * Read the text of an export.
	 */
	read(text: unknown): ReadResult {
		const result: ReadResult = {books: [], warnings: [], skippedUnfinished: 0};
		for (const row of Csv.parse(text)) this.readRow(row, result);
		return result;
	}

	/**
	 * Read one row into `result`: a book read, a warning, or one more book skipped as unfinished.
	 */
	readRow(_row: CsvRow, _result: ReadResult) {
		throw new Error(`${this.label}: readRow is not written`);
	}
}
