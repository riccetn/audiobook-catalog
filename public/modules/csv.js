// CSV, as Audible Library Extractor and Goodreads write it and Goodreads' import reads it.
import {Isbn} from './isbn.js';

/** @typedef {Record<string, string | undefined>} CsvRow a CSV row by its header's names (Csv.parse) */

// Audible Library Extractor has "ISBN10" and "ISBN13", Goodreads "ISBN" and "ISBN13"; spacing and case are forgiven.
const ISBN_COLUMN = /^isbns?[\s_-]*(1[03])?$/i;

/** Reading and writing CSV; every method is static. */
export class Csv {
	/**
	 * Parse CSV text (RFC 4180: quoted fields, doubled quotes, newlines inside quotes) into objects
	 * keyed by the header row: a leading BOM is dropped, blank lines are
	 * skipped, and missing trailing fields are undefined.
	 * @param {unknown} input
	 * @returns {CsvRow[]}
	 */
	static parse(input) {
		const text = String(input || '').replace(/^\uFEFF/, '');
		/** @type {string[][]} */
		const rows = [];
		/** @type {string[]} */
		let row = [];
		let field = '',
			quoted = false,
			atStart = true,
			i = 0;
		const endField = () => {
			row.push(field);
			field = '';
			atStart = true;
		};
		const endRow = () => {
			endField();
			rows.push(row);
			row = [];
		};
		while (i < text.length) {
			const c = text[i];
			if (quoted) {
				if (c === '"') {
					if (text[i + 1] === '"') {
						field += '"';
						i += 2;
						continue;
					}
					quoted = false;
					atStart = false;
					i++;
					continue;
				}
				field += c;
				i++;
				continue;
			}
			if (c === '"' && atStart) {
				quoted = true;
				atStart = false;
				i++;
			} else if (c === ',') {
				endField();
				i++;
			} else if (c === '\r') {
				endRow();
				i += text[i + 1] === '\n' ? 2 : 1;
			} else if (c === '\n') {
				endRow();
				i++;
			} else {
				field += c;
				atStart = false;
				i++;
			}
		}
		if (!atStart || row.length) endRow();

		const nonBlank = rows.filter(r => !(r.length === 1 && r[0] === ''));
		if (!nonBlank.length) return [];
		const [header, ...body] = nonBlank;
		return body.map(r => {
			/** @type {CsvRow} */
			const obj = {};
			header.forEach((name, j) => {
				obj[name] = r[j];
			});
			return obj;
		});
	}

	/**
	 * A field as CSV writes it: quoted when it holds a quote, a comma or a line break.
	 * @param {string} v
	 * @returns {string}
	 */
	static field(v) {
		return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
	}

	/**
	 * A row's value in a column, trimmed; '' when it has none.
	 * @param {CsvRow} row
	 * @param {string} name
	 * @returns {string}
	 */
	static cell(row, name) {
		return (row[name] || '').trim();
	}

	/**
	 * The valid ISBNs in a row's ISBN columns, 13-digit and without repeats.
	 * @param {CsvRow} row
	 * @returns {string[]}
	 */
	static rowIsbns(row) {
		/** @type {string[]} */
		const isbns = [];
		for (const [name, value] of Object.entries(row)) {
			if (!ISBN_COLUMN.test(name.trim())) continue;
			for (const part of String(value || '').split(/[,;]/)) {
				const isbn = Isbn.parse(part);
				if (isbn && !isbns.includes(isbn)) isbns.push(isbn);
			}
		}
		return isbns;
	}
}
