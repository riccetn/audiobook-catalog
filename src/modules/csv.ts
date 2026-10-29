// CSV, as Audible Library Extractor and Goodreads write it and Goodreads' import reads it.
import {Isbn} from './isbn.js';

/** a CSV row by its header's names (Csv.parse) */
export type CsvRow = Record<string, string | undefined>;

// Audible Library Extractor has "ISBN10" and "ISBN13", Goodreads "ISBN" and "ISBN13"; spacing and case are forgiven.
const ISBN_COLUMN = /^isbns?[\s_-]*(1[03])?$/i;

/** Reading and writing CSV; every method is static. */
export class Csv {
	/**
	 * Parse CSV text (RFC 4180: quoted fields, doubled quotes, newlines inside quotes) into objects
	 * keyed by the header row: a leading BOM is dropped, blank lines are
	 * skipped, and missing trailing fields are undefined.
	 */
	static parse(input: unknown): CsvRow[] {
		const text = String(input || '').replace(/^\uFEFF/, '');
		const rows: string[][] = [];
		let row: string[] = [];
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
			const obj: CsvRow = {};
			header.forEach((name, j) => {
				obj[name] = r[j];
			});
			return obj;
		});
	}

	/**
	 * A field as CSV writes it: quoted when it holds a quote, a comma or a line break.
	 */
	static field(v: string): string {
		return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
	}

	/**
	 * A row's value in a column, trimmed; '' when it has none.
	 */
	static cell(row: CsvRow, name: string): string {
		return (row[name] || '').trim();
	}

	/**
	 * The valid ISBNs in a row's ISBN columns, 13-digit and without repeats.
	 */
	static rowIsbns(row: CsvRow): string[] {
		const isbns: string[] = [];
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
