// ISBNs, as an edition keeps one: always the 13-digit form without hyphens, so the ISBN-10 and ISBN-13 of
// one edition are the same entry.
import {Text} from './text.js';

/** @type {(s: string) => boolean} */
const isbn10Ok = s => [...s].reduce((sum, c, i) => sum + (10 - i) * (c === 'X' ? 10 : Number(c)), 0) % 11 === 0;
/** @type {(s: string) => string} */
const isbn13Check = s =>
	String((10 - ([...s.slice(0, 12)].reduce((sum, c, i) => sum + Number(c) * (i % 2 ? 3 : 1), 0) % 10)) % 10);

/** Reading and writing ISBNs; every method is static. */
export class Isbn {
	/**
	 * An ISBN in its 13-digit form. Accepts hyphens and spaces, an "ISBN" prefix, and Goodreads'
	 * ="0441013597" quoting. Returns null when it is not a valid ISBN (wrong length or check digit).
	 * @param {unknown} text
	 * @returns {string | null}
	 */
	static parse(text) {
		const s = String(text || '')
			.toUpperCase()
			.replace(/ISBN(?:-?1[03])?:?/g, '')
			.replace(/[\s\-="']/g, '');
		if (/^\d{9}[\dX]$/.test(s)) {
			if (!isbn10Ok(s)) return null;
			const twelve = '978' + s.slice(0, 9);
			return twelve + isbn13Check(twelve);
		}
		if (/^97[89]\d{10}$/.test(s)) return isbn13Check(s) === s[12] ? s : null;
		return null;
	}

	/**
	 * Parse a list of ISBNs separated by commas or semicolons (or spaces, when every part is a whole ISBN).
	 * Returns {isbns (13-digit, no repeats, in the order given), bad (not an ISBN)}.
	 * @param {unknown} text
	 * @returns {{isbns: string[], bad: string[]}}
	 */
	static parseList(text) {
		/** @type {string[]} */
		const isbns = [],
			bad = [];
		for (const part of String(text || '')
			.split(/[,;]/)
			.map(x => Text.tidy(x))
			.filter(Boolean)) {
			let found = [Isbn.parse(part)];
			if (!found[0] && part.includes(' ')) {
				const words = part.split(' ').map(Isbn.parse);
				if (words.every(Boolean)) found = words;
			}
			if (!found[0]) {
				bad.push(part);
				continue;
			}
			for (const isbn of found) if (isbn && !isbns.includes(isbn)) isbns.push(isbn);
		}
		return {isbns, bad};
	}

	/**
	 * The 10-digit form of a 978 ISBN, or '' (979 ISBNs have none).
	 * @param {string} isbn13
	 * @returns {string}
	 */
	static isbn10Of(isbn13) {
		if (!isbn13.startsWith('978')) return '';
		const nine = isbn13.slice(3, 12);
		const check = (11 - ([...nine].reduce((sum, c, i) => sum + (10 - i) * Number(c), 0) % 11)) % 11;
		return nine + (check === 10 ? 'X' : String(check));
	}
}
