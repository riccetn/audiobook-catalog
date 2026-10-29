// What every exporter to an import file of another catalog shares (Goodreads' CSV): it writes books into a
// file to download. The Import & export page knows only this class: a subclass says what the file is
// (CATALOG, LABEL, FORMAT, FILE_NAME, TYPE) and writes it (write).
import type {Book} from './book.js';

/** the file's text, how many books are in it, and what the page says of them */
export type ExportResult = {text: string; books: number; notes: string[]};

/** Writes books into another catalog's import file; a subclass says how (write). */
export class FileExporter {
	/** The catalog the file is for, as ExternalCatalog names it ('goodreads'); also its panel's prefix. */
	static CATALOG = '';
	/** The catalog's name, as the page says it ("Goodreads"). */
	static LABEL = '';
	/** What kind of file it is, as the page says it ("CSV"). */
	static FORMAT = 'CSV';
	/** The downloaded file's name, before its date and extension. */
	static FILE_NAME = 'export';
	/** Its media type: 'text/csv'. */
	static TYPE = 'text/csv';

	/** @returns the exporter's class, with what it says of its file */
	get kind(): typeof FileExporter {
		return this.constructor as typeof FileExporter;
	}

	/**
	 * Write `books` into the file.
	 */
	write(_books: Book[]): ExportResult {
		throw new Error(`${this.kind.LABEL}: write is not written`);
	}
}
