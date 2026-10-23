// The Audible importer: an Audible Library Extractor CSV, of which only finished books are kept. Audible's
// catalog doesn't allow browser requests, so there is nothing more to ask Audible.
import {Text} from './text.js';
import {ExternalCatalog} from './external-catalog.js';
import {Book} from './book.js';
import {Series} from './series.js';
import {Csv} from './csv.js';
import {FileImporter} from './file-importer.js';
/** @import {CsvRow} from './csv.js' */
/** @import {ReadResult} from './file-importer.js' */

// Audible's built-in "Your First Listen" sample appears in every library.
const SAMPLE_ASINS = new Set(['B002V8N37Q']);
// "Thornmere: Wardens (book 3), Thornmere (book 5)": anchor on the "(book N)" markers,
// because series names themselves can contain commas ("Vera Stone, Ghost Hunter").
const SERIES_PART = /\s*(.+?)\s*\(books?\s*([^)]*)\)\s*(?:,|$)/iy;
const cell = Csv.cell;

/** Reads an Audible Library Extractor CSV. */
export class AudibleImporter extends FileImporter {
	static CATALOG = 'audible';
	static LABEL = 'Audible';
	static EDITIONS_YOURS = true;
	static SAMPLE_ASINS = SAMPLE_ASINS;

	/** @param {string} [site] the Audible site whose ASINs the export has (audible.com unless said) */
	constructor(site){
		super(site || ExternalCatalog.AUDIBLE_SITE);
	}

	/**
	 * @param {CsvRow} row
	 * @param {ReadResult} result
	 */
	readRow(row, result){
		const [book, warning] = this.rowToBook(row);
		if(book === null){
			if(cell(row, 'Progress') !== 'Finished' && !SAMPLE_ASINS.has(cell(row, 'ASIN'))) result.skippedUnfinished++;
			return;
		}
		if(!book.authors.length){
			result.warnings.push(`${Text.repr(book.title)}: no author in the export, skipped`);
			return;
		}
		result.books.push(book);
		if(warning) result.warnings.push(warning);
	}

	/**
	 * Convert one row: [book, or null when it is not a finished book; a warning, or null].
	 * @param {CsvRow} row
	 * @returns {[Book | null, string | null]}
	 */
	rowToBook(row){
		if(cell(row, 'Progress') !== 'Finished') return [null, null];
		const asin = cell(row, 'ASIN');
		if(SAMPLE_ASINS.has(asin)) return [null, null];

		let [series, number, ambiguous] = AudibleImporter.chooseSeries(AudibleImporter.parseSeriesField(row.Series));
		if(series && number === null){
			number = (row['Book Numbers'] || '').split(',')[0].trim() || null;
		}

		const title = (row['Title Short'] || row.Title || '').trim();
		// the book as stored, with its edition's ISBNs as a list until Book.tidyJSON() makes one edition per ISBN
		/** @type {Record<string, any>} */
		const rec = {t: AudibleImporter.cleanTitle(title, series ? number : null), a: Text.splitNames(cell(row, 'Authors'))};
		if(series){
			rec.s = series;
			if(number) rec.sn = number;
		}
		let tags = (row.Tags || '').split(',').map(t => t.trim()).filter(Boolean);
		if(!tags.length && cell(row, 'Child Category')) tags = [cell(row, 'Child Category')];
		if(tags.length) rec.g = tags;
		/** @type {Record<string, any>} */
		const edition = {};
		if(asin) edition.ext = {[this.site]: asin};
		if(Text.splitNames(cell(row, 'Narrators')).length) edition.n = Text.splitNames(cell(row, 'Narrators'));
		const isbns = Csv.rowIsbns(row);
		if(isbns.length) edition.isbn = isbns;
		if(cell(row, 'Publishers')) edition.p = cell(row, 'Publishers');
		const released = Text.parseDate(cell(row, 'Release Date'));
		if(released) edition.d = released;
		const minutes = Text.parseLength(cell(row, 'Length'));
		if(minutes) edition.len = minutes;
		if(Object.keys(edition).length) rec.e = [edition];
		// a title like "Lantern of the Deep: Ember Coast, Book 2" with no Series column
		const book = Book.fromRecord(Book.fixSeriesTitle(rec));

		const warning = ambiguous
			? `${Text.repr(book.title)}: belongs to several series (${row.Series}); using ${Text.repr(series)}`
			: null;
		return [book, warning];
	}

	/**
	 * "S (book 2), T (books 1-4)" -> [["S", "2"], ["T", "1-4"]]; a missing number is null.
	 * @param {string | undefined} field
	 * @returns {[string, string | null][]}
	 */
	static parseSeriesField(field){
		const raw = (field || '').trim();
		/** @type {[string, string | null][]} */
		const pairs = [];
		let pos = 0;
		while(pos < raw.length){
			SERIES_PART.lastIndex = pos;
			const m = SERIES_PART.exec(raw);
			if(!m) break;
			pairs.push([m[1].trim(), m[2].trim() || null]);
			pos = SERIES_PART.lastIndex;
		}
		const rest = raw.slice(pos).replace(/^[ ,]+|[ ,]+$/g, '');
		if(rest) pairs.push([rest, null]);
		return pairs;
	}

	/**
	 * Pick one series when Audible lists several. Returns [name, number, wasAmbiguous]. A parent
	 * series wins over its sub-series ("Thornmere" over "Thornmere: Wardens"); otherwise the first
	 * listed wins and the book is flagged for review.
	 * @param {[string, string | null][]} pairs
	 * @returns {[string | null, string | null, boolean]}
	 */
	static chooseSeries(pairs){
		if(!pairs.length) return [null, null, false];
		if(pairs.length === 1) return [pairs[0][0], pairs[0][1], false];
		const names = pairs.map(([name]) => name);
		for(const [name, number] of pairs){
			if(names.every(other => other === name || other.startsWith(name + ':'))) return [name, number, false];
		}
		return [pairs[0][0], pairs[0][1], true];
	}

	/**
	 * Drop a trailing series number that Audible bakes into short titles ("Lantern of the Deep 10").
	 * @param {string} title
	 * @param {string | null} number
	 * @returns {string}
	 */
	static cleanTitle(title, number){
		title = title.trim();
		// a box set's range stays: "Ember: Books 1-3" is the set's name, which the merge keeps on its edition
		if(number && !Series.BOX_RANGE.test(number)){
			const stripped = title.replace(new RegExp('[\\s:,\\-]+' + Text.escapeRegExp(number.trim()) + '\\s*$'), '');
			if(stripped) return stripped;
		}
		return title;
	}
}
