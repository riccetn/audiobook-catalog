// A series: what you keep about it (its series info: how many books are out, whether it is complete, a
// note and its ids in external catalogs), and what goes for every series: names that are spelled differently but are one
// series, numbers and box sets' ranges ("4-6"), and a series written into a title ("Title (Series, #3)").
import {Text} from './text.js';
import {ExternalCatalog} from './external-catalog.js';
import {Contributor} from './contributor.js';
import type {Book} from './book.js';
import type {Unchecked} from './text.js';

export type SeriesStatus = 'ongoing' | 'complete';

// "Title: Series, Book 3" (also "Volume 3", "Vol. 3", "#3" or "Book Three"). The title takes the last
// colon, so a subtitle stays with it; a series name with a colon in it loses its first part.
const NUMBER_WORDS = [
	'zero',
	'one',
	'two',
	'three',
	'four',
	'five',
	'six',
	'seven',
	'eight',
	'nine',
	'ten',
	'eleven',
	'twelve',
	'thirteen',
	'fourteen',
	'fifteen',
	'sixteen',
	'seventeen',
	'eighteen',
	'nineteen',
	'twenty',
];
const COLON_SERIES = new RegExp(
	'^(.+):\\s*(.+?)\\s*,\\s*(?:book|volume|vol\\.?|#)\\s*(\\d+(?:\\.\\d+)?|' + NUMBER_WORDS.join('|') + ')\\s*$',
	'i',
);
// "Title (Series, #3)", as Goodreads writes it.
const PAREN = /^(.*?)\s*\(([^()]+)\)\s*$/;
const SERIES_MARKER = new RegExp(
	'(#|' + Text.WORD_START + 'book(?![\\p{L}\\p{N}_])|' + Text.WORD_START + 'vol(?![\\p{L}\\p{N}_]))',
	'iu',
);
// A series number, or a box set's range ("#1-3", "#1–3").
const PAREN_NUMBER = /\d+(?:\.\d+)?(?:\s*[-–]\s*\d+(?:\.\d+)?)?/;
const rangeText: (text: string) => string = text => text.replace(/\s*[-–]\s*/, '-');

/** A series, by its name (as the books' `series` have it), with what you keep about it. */
export class Series {
	static STATUSES: SeriesStatus[] = ['ongoing', 'complete'];
	// The keys of a series' entry in the stored series info, in order.
	static KEYS = ['total', 'status', 'note', 'ext'];
	// A series number: "3", "2.5", or a box set's range "4-6".
	static NUMBER = /^\d+(\.\d+)?(-\d+(\.\d+)?)?$/;
	// A box set's range of whole numbers, "1-3"; more than BOX_MAX titles is taken for a typo.
	static BOX_RANGE = /^(\d+)-(\d+)$/;
	static BOX_MAX = 30;

	name: string;
	/** the number of books released so far */
	total: number | 'many' | undefined;
	status: SeriesStatus | undefined;
	note: string | undefined;
	/** its ids by external catalog: {"goodreads": "123", "hardcover": "the-lantern-coast"} */
	external: Record<string, string>;
	/** what the stored entry holds that is not a series' info (the Check reports it) */
	extra: Record<string, unknown>;

	constructor(
		name: string,
		{
			total,
			status,
			note,
			external = {},
		}: {total?: number | 'many'; status?: SeriesStatus; note?: string; external?: Record<string, string>} = {},
	) {
		this.name = name;
		this.total = total;
		this.status = status;
		this.note = note;
		this.external = {...external};
		this.extra = {};
	}

	/**
	 * A series from its entry in the stored series info. A value that is not what its field holds is kept
	 * aside, as it is, and written back by toJSON(), so the Check still reports it. Throws when the entry
	 * is not an object.
	 */
	static fromJSON(name: string, json: Unchecked): Series {
		if (!Text.isObject(json)) throw new Error(`the series info of ${Text.repr(name)} is not an object`);
		const series = new Series(name);
		for (const [k, v] of Object.entries(json)) {
			if (k === 'total' && (typeof v === 'number' || v === 'many')) series.total = v;
			else if (k === 'status' && Series.STATUSES.includes(v)) series.status = v;
			else if (k === 'note' && typeof v === 'string') series.note = v;
			else if (k === 'ext' && ExternalCatalog.isIds(v)) series.external = {...v};
			else series.extra[k] = v;
		}
		return series;
	}

	/** @returns the entry as the stored series info keeps it */
	toJSON(): Record<string, unknown> {
		const out: Record<string, unknown> = {};
		const fields: Record<string, unknown> = {
			total: this.total,
			status: this.status,
			note: this.note,
			ext: ExternalCatalog.order(this.external) || undefined,
		};
		for (const k of Series.KEYS) {
			if (fields[k] !== undefined) out[k] = fields[k];
			else if (k in this.extra) out[k] = this.extra[k];
		}
		for (const [k, v] of Object.entries(this.extra)) if (!(k in out)) out[k] = v;
		return out;
	}

	/**
	 * The series numbers from 1 to the total released that none of `books` covers, e.g. [3, 5] (see missingNumbers).
	 * @param books the series' books
	 */
	missing(books: Book[]): number[] | null {
		return Series.missingNumbers(books, this.total);
	}

	/**
	 * Until 2026-10 a series kept an author's or publisher's site (`url`, which fromJSON() keeps aside); the
	 * authors and publishers keep their own now. The site leaves the series for the one the series' books
	 * all agree on, through `give(kind, name, site)` (false when it can't take it): their one author, else
	 * their editions' one publisher. When there is no such one, it goes at the end of the series' note, so
	 * nothing is lost. Returns whether the series had a site.
	 * @param books the series' books
	 */
	moveSite(books: Book[], give: (kind: 'authors' | 'publishers', name: string, site: string) => boolean): boolean {
		const url = this.extra.url;
		// a note that isn't text stays as it is for the Check, and so does the site then
		if (typeof url !== 'string' || 'note' in this.extra) return false;
		delete this.extra.url;
		const site = url.trim();
		if (!site) return true;
		const authors = [...new Set(books.flatMap(b => b.authors))];
		const publishers = [...new Set(books.flatMap(b => b.editions.map(ed => ed.publisher || '')))];
		if (authors.length === 1 && give('authors', authors[0], site)) return true;
		if (publishers.length === 1 && publishers[0] && give('publishers', publishers[0], site)) return true;
		this.note = [this.note, `site: ${site}`].filter(Boolean).join('; ');
		return true;
	}

	/**
	 * Move every series' site (moveSite) to its author or publisher, in a whole catalog or backup: `series`
	 * and the people are kept under `keyOf(kind, name)` (an id, or in a backup the name); people missing
	 * (null, a backup from before they were kept) can't take one. A series left with no info is taken out
	 * of `series`. Returns whether any series had a site.
	 */
	static moveSites(
		series: Map<string, Series>,
		books: Book[],
		people: {authors: Map<string, Contributor> | null; publishers: Map<string, Contributor> | null},
		keyOf: (kind: 'authors' | 'publishers', name: string) => string,
	): boolean {
		let moved = false;
		for (const [key, s] of [...series]) {
			const own = books.filter(b => b.series === s.name);
			const had = s.moveSite(own, (kind, name, site) => {
				const map = people[kind];
				if (!map) return false;
				const k = keyOf(kind, name),
					info = map.get(k) || new Contributor(name);
				if (!info.addSite(site)) return false;
				map.set(k, info);
				return true;
			});
			if (!had) continue;
			moved = true;
			if (!Object.keys(s.toJSON()).length) series.delete(key);
		}
		return moved;
	}

	// ------------------------------------------------------------------ names and numbers
	/**
	 * Key under which two series names count as the same series ('Ember Coast' == 'The Ember-Coast series').
	 */
	static norm(name: unknown): string {
		return Series.key(Text.norm(name));
	}

	/**
	 * The series key of a name already normalized: no leading "the", no word "series", no spaces.
	 */
	static key(n: string): string {
		return n
			.replace(/^the /, '')
			.replace(/(^| )series(?= |$)/g, ' ')
			.replace(/ /g, '');
	}

	/**
	 * [first, last] of a series number that is a range ("4-6" -> [4, 6]), or null for one number or none.
	 */
	static range(number: unknown): [number, number] | null {
		const m = /^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/.exec(String(number || '').trim());
		return m && Number(m[1]) < Number(m[2]) ? [Number(m[1]), Number(m[2])] : null;
	}

	/**
	 * How many titles of a series `books` (the series' books) hold: a box set kept as its own book beside
	 * its titles adds none, and one without them adds the numbers it covers that no title has.
	 */
	static owned(books: Book[]): number {
		const titles = books.filter(b => !b.isCollection());
		const numbers = new Set(titles.map(b => String(b.number || '').trim()));
		let count = titles.length;
		for (const b of books.filter(b => b.isCollection())) {
			const [from, to] = Series.range(b.number) as [number, number]; // a collection's number is a range
			for (let n = Math.ceil(from); n <= to; n++)
				if (!numbers.has(String(n))) {
					numbers.add(String(n));
					count++;
				}
		}
		return count;
	}

	/**
	 * Numbers as a list, runs joined: [3, 5, 6, 7] -> "#3, #5–7".
	 */
	static numberList(nums: number[]): string {
		const runs: [number, number][] = [];
		nums.forEach(n => {
			const last = runs[runs.length - 1];
			if (last && n === last[1] + 1) last[1] = n;
			else runs.push([n, n]);
		});
		return runs.map(([a, b]) => (a === b ? `#${a}` : `#${a}–${b}`)).join(', ');
	}

	/**
	 * The series numbers from 1 to `total` that none of `books` covers, e.g. [3, 5]. A boxed set
	 * ("4-6") covers each number in it; a novella such as "2.5" covers none, so it does not hide a
	 * missing book 2. Returns null when `total` is not a count (e.g. "many" or no series info).
	 */
	static missingNumbers(books: Book[], total: unknown): number[] | null {
		if (typeof total !== 'number' || !(Number.isInteger(total) && total > 0)) return null;
		const owned = new Set();
		for (const b of books) {
			const m = /^(\d+)(?:-(\d+))?$/.exec(String(b.number || '').trim());
			if (!m) continue;
			const from = parseInt(m[1], 10),
				to = Math.min(m[2] ? parseInt(m[2], 10) : from, total);
			for (let n = from; n <= to; n++) owned.add(n);
		}
		const missing = [];
		for (let n = 1; n <= total; n++) if (!owned.has(n)) missing.push(n);
		return missing;
	}

	/**
	 * The name an import gives a box set's title it doesn't know yet: "Ember, Book 2".
	 */
	static boxSetTitle(series: string, number: number | string): string {
		return `${series}, Book ${number}`;
	}

	// ------------------------------------------------------------------ a series in a title
	/**
	 * "Frosted (Blaze, #6; Dana O'Hare, #1)" -> ["Frosted", "Blaze", "6"]; a box set's "(Ember, #1-3)" gives "1-3".
	 */
	static parseTitle(raw: string): [string, string | null, string | null] {
		const m = PAREN.exec(raw.trim());
		if (!m) return [raw.trim(), null, null];
		const clean = m[1].trim(),
			inner = m[2].trim();
		const first = inner.split(';')[0].trim(); // only the first series when several are listed
		const comma = first.lastIndexOf(',');
		const name = comma >= 0 ? first.slice(0, comma) : '';
		const tail = comma >= 0 ? first.slice(comma + 1) : first;
		if (name && SERIES_MARKER.test(tail)) {
			const num = PAREN_NUMBER.exec(tail);
			return [clean, name.trim(), num ? rangeText(num[0]) : null];
		}
		const m2 = new RegExp('^(.*?)\\s*#\\s*(' + PAREN_NUMBER.source + ')$').exec(first);
		if (m2) return [clean, m2[1].trim(), rangeText(m2[2])];
		return [clean, first, null];
	}

	/**
	 * "Title: Series, Book 3" -> ["Title", "Series", "3"], or null.
	 */
	static parseColonTitle(raw: string): [string, string, string] | null {
		const m = COLON_SERIES.exec(raw);
		if (!m) return null;
		const word = NUMBER_WORDS.indexOf(m[3].toLowerCase());
		return [m[1].trim(), m[2].trim(), word >= 0 ? String(word) : m[3]];
	}

	/**
	 * Split a series and number off a title written as "Title: Series, Book 3" or "Title (Series, #3)".
	 * Returns [title, series, number], or null when the title names no series with a number.
	 */
	static splitTitle(raw: string): [string, string | null, string | null] | null {
		raw = Text.tidy(raw);
		const colon = Series.parseColonTitle(raw);
		if (colon) return colon;
		if (!PAREN.test(raw)) return null;
		const parts = Series.parseTitle(raw);
		return parts[1] && parts[2] ? parts : null;
	}
}
