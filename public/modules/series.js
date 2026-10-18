// A series: what you keep about it (its series info: how many books are out, whether it is complete, a
// note, a link and its ids in external catalogs), and what goes for every series: names that are spelled differently but are one
// series, numbers and box sets' ranges ("4-6"), and a series written into a title ("Title (Series, #3)").
import {Text} from './text.js';
import {ExternalCatalog} from './external-catalog.js';
/** @import {Book} from './book.js' */
/** @import {Unchecked} from './text.js' */

/** @typedef {'ongoing' | 'complete'} SeriesStatus */

// "Title: Series, Book 3" (also "Volume 3", "Vol. 3", "#3" or "Book Three"). The title takes the last
// colon, so a subtitle stays with it; a series name with a colon in it loses its first part.
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven',
	'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
const COLON_SERIES = new RegExp('^(.+):\\s*(.+?)\\s*,\\s*(?:book|volume|vol\\.?|#)\\s*(\\d+(?:\\.\\d+)?|' +
	NUMBER_WORDS.join('|') + ')\\s*$', 'i');
// "Title (Series, #3)", as Goodreads writes it.
const PAREN = /^(.*?)\s*\(([^()]+)\)\s*$/;
const SERIES_MARKER = new RegExp('(#|' + Text.WORD_START + 'book(?![\\p{L}\\p{N}_])|' + Text.WORD_START + 'vol(?![\\p{L}\\p{N}_]))', 'iu');
// A series number, or a box set's range ("#1-3", "#1–3").
const PAREN_NUMBER = /\d+(?:\.\d+)?(?:\s*[-–]\s*\d+(?:\.\d+)?)?/;
/** @type {(text: string) => string} */
const rangeText = text => text.replace(/\s*[-–]\s*/, '-');

/** A series, by its name (as the books' `series` have it), with what you keep about it. */
export class Series {
	/** @type {SeriesStatus[]} */
	static STATUSES = ['ongoing', 'complete'];
	// The keys of a series' entry in the stored series info, in order.
	static KEYS = ['total', 'status', 'note', 'url', 'ext'];
	// A series number: "3", "2.5", or a box set's range "4-6".
	static NUMBER = /^\d+(\.\d+)?(-\d+(\.\d+)?)?$/;
	// A box set's range of whole numbers, "1-3"; more than BOX_MAX titles is taken for a typo.
	static BOX_RANGE = /^(\d+)-(\d+)$/;
	static BOX_MAX = 30;

	/**
	 * @param {string} name
	 * @param {{total?: number | 'many', status?: SeriesStatus, note?: string, url?: string, external?: Record<string, string>}} [info]
	 */
	constructor(name, {total, status, note, url, external = {}} = {}){
		this.name = name;
		/** @type {number | 'many' | undefined} the number of books released so far */
		this.total = total;
		/** @type {SeriesStatus | undefined} */
		this.status = status;
		/** @type {string | undefined} */
		this.note = note;
		/** @type {string | undefined} */
		this.url = url;
		/** @type {Record<string, string>} its ids by external catalog: {"goodreads": "123", "hardcover": "the-lantern-coast"} */
		this.external = {...external};
		/** @type {Record<string, unknown>} what the stored entry holds that is not a series' info (the Check reports it) */
		this.extra = {};
	}

	/**
	 * A series from its entry in the stored series info. A value that is not what its field holds is kept
	 * aside, as it is, and written back by toJSON(), so the Check still reports it. Throws when the entry
	 * is not an object.
	 * @param {string} name
	 * @param {Unchecked} json
	 * @returns {Series}
	 */
	static fromJSON(name, json){
		if(!Text.isObject(json)) throw new Error(`the series info of ${Text.repr(name)} is not an object`);
		const series = new Series(name);
		for(const [k, v] of Object.entries(json)){
			if(k === 'total' && (typeof v === 'number' || v === 'many')) series.total = v;
			else if(k === 'status' && Series.STATUSES.includes(v)) series.status = v;
			else if((k === 'note' || k === 'url') && typeof v === 'string') series[k] = v;
			else if(k === 'ext' && ExternalCatalog.isIds(v)) series.external = {...v};
			else series.extra[k] = v;
		}
		return series;
	}

	/** @returns {Record<string, unknown>} the entry as the stored series info keeps it */
	toJSON(){
		/** @type {Record<string, unknown>} */
		const out = {};
		/** @type {Record<string, unknown>} */
		const fields = {total: this.total, status: this.status, note: this.note, url: this.url, ext: ExternalCatalog.order(this.external) || undefined};
		for(const k of Series.KEYS){
			if(fields[k] !== undefined) out[k] = fields[k];
			else if(k in this.extra) out[k] = this.extra[k];
		}
		for(const [k, v] of Object.entries(this.extra)) if(!(k in out)) out[k] = v;
		return out;
	}

	/**
	 * The series numbers from 1 to the total released that none of `books` covers, e.g. [3, 5] (see missingNumbers).
	 * @param {Book[]} books the series' books
	 * @returns {number[] | null}
	 */
	missing(books){ return Series.missingNumbers(books, this.total); }

	// ------------------------------------------------------------------ names and numbers
	/**
	 * Key under which two series names count as the same series ('Ember Coast' == 'The Ember-Coast series').
	 * @param {unknown} name
	 * @returns {string}
	 */
	static norm(name){ return Series.key(Text.norm(name)); }

	/**
	 * The series key of a name already normalized: no leading "the", no word "series", no spaces.
	 * @param {string} n
	 * @returns {string}
	 */
	static key(n){ return n.replace(/^the /, '').replace(/(^| )series(?= |$)/g, ' ').replace(/ /g, ''); }

	/**
	 * [first, last] of a series number that is a range ("4-6" -> [4, 6]), or null for one number or none.
	 * @param {unknown} number
	 * @returns {[number, number] | null}
	 */
	static range(number){
		const m = /^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/.exec(String(number || '').trim());
		return m && Number(m[1]) < Number(m[2]) ? [Number(m[1]), Number(m[2])] : null;
	}

	/**
	 * How many titles of a series `books` (the series' books) hold: a box set kept as its own book beside
	 * its titles adds none, and one without them adds the numbers it covers that no title has.
	 * @param {Book[]} books
	 * @returns {number}
	 */
	static owned(books){
		const titles = books.filter(b => !b.isCollection());
		const numbers = new Set(titles.map(b => String(b.number || '').trim()));
		let count = titles.length;
		for(const b of books.filter(b => b.isCollection())){
			const [from, to] = /** @type {[number, number]} */ (Series.range(b.number));   // a collection's number is a range
			for(let n = Math.ceil(from); n <= to; n++) if(!numbers.has(String(n))){ numbers.add(String(n)); count++; }
		}
		return count;
	}

	/**
	 * Numbers as a list, runs joined: [3, 5, 6, 7] -> "#3, #5–7".
	 * @param {number[]} nums
	 * @returns {string}
	 */
	static numberList(nums){
		/** @type {[number, number][]} */
		const runs = [];
		nums.forEach(n=>{
			const last = runs[runs.length - 1];
			if(last && n === last[1] + 1) last[1] = n; else runs.push([n, n]);
		});
		return runs.map(([a, b])=> a === b ? `#${a}` : `#${a}–${b}`).join(', ');
	}

	/**
	 * The series numbers from 1 to `total` that none of `books` covers, e.g. [3, 5]. A boxed set
	 * ("4-6") covers each number in it; a novella such as "2.5" covers none, so it does not hide a
	 * missing book 2. Returns null when `total` is not a count (e.g. "many" or no series info).
	 * @param {Book[]} books
	 * @param {unknown} total
	 * @returns {number[] | null}
	 */
	static missingNumbers(books, total){
		if(typeof total !== 'number' || !(Number.isInteger(total) && total > 0)) return null;
		const owned = new Set();
		for(const b of books){
			const m = /^(\d+)(?:-(\d+))?$/.exec(String(b.number || '').trim());
			if(!m) continue;
			const from = parseInt(m[1], 10), to = Math.min(m[2] ? parseInt(m[2], 10) : from, total);
			for(let n = from; n <= to; n++) owned.add(n);
		}
		const missing = [];
		for(let n = 1; n <= total; n++) if(!owned.has(n)) missing.push(n);
		return missing;
	}

	/**
	 * The name an import gives a box set's title it doesn't know yet: "Ember, Book 2".
	 * @param {string} series
	 * @param {number | string} number
	 * @returns {string}
	 */
	static boxSetTitle(series, number){
		return `${series}, Book ${number}`;
	}

	// ------------------------------------------------------------------ a series in a title
	/**
	 * "Frosted (Blaze, #6; Dana O'Hare, #1)" -> ["Frosted", "Blaze", "6"]; a box set's "(Ember, #1-3)" gives "1-3".
	 * @param {string} raw
	 * @returns {[string, string | null, string | null]}
	 */
	static parseTitle(raw){
		const m = PAREN.exec(raw.trim());
		if(!m) return [raw.trim(), null, null];
		const clean = m[1].trim(), inner = m[2].trim();
		const first = inner.split(';')[0].trim();          // only the first series when several are listed
		const comma = first.lastIndexOf(',');
		const name = comma >= 0 ? first.slice(0, comma) : '';
		const tail = comma >= 0 ? first.slice(comma + 1) : first;
		if(name && SERIES_MARKER.test(tail)){
			const num = PAREN_NUMBER.exec(tail);
			return [clean, name.trim(), num ? rangeText(num[0]) : null];
		}
		const m2 = new RegExp('^(.*?)\\s*#\\s*(' + PAREN_NUMBER.source + ')$').exec(first);
		if(m2) return [clean, m2[1].trim(), rangeText(m2[2])];
		return [clean, first, null];
	}

	/**
	 * "Title: Series, Book 3" -> ["Title", "Series", "3"], or null.
	 * @param {string} raw
	 * @returns {[string, string, string] | null}
	 */
	static parseColonTitle(raw){
		const m = COLON_SERIES.exec(raw);
		if(!m) return null;
		const word = NUMBER_WORDS.indexOf(m[3].toLowerCase());
		return [m[1].trim(), m[2].trim(), word >= 0 ? String(word) : m[3]];
	}

	/**
	 * Split a series and number off a title written as "Title: Series, Book 3" or "Title (Series, #3)".
	 * Returns [title, series, number], or null when the title names no series with a number.
	 * @param {string} raw
	 * @returns {[string, string | null, string | null] | null}
	 */
	static splitTitle(raw){
		raw = Text.tidy(raw);
		const colon = Series.parseColonTitle(raw);
		if(colon) return colon;
		if(!PAREN.test(raw)) return null;
		const parts = Series.parseTitle(raw);
		return parts[1] && parts[2] ? parts : null;
	}
}
