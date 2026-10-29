// Text as the catalog keeps it: tidying, the forgiving forms that matching compares, names written as a
// list or as text, dates and lengths, and the page's spelling. Every other module builds on this one.
//
// Like every module in this folder it uses no browser APIs, so the tests run it in Node as it is.

/**
 * Data as it came from a file, a backup or localStorage, before it has been checked: it may be in an
 * older format or not a book at all, so the code that takes it checks what it uses.
 */
export type Unchecked = any;

// JavaScript's \b is ASCII-only, so "é" would count as a word boundary; this is the Unicode "no word char before".
const WORD_START = '(?<![\\p{L}\\p{N}_])';
const RUN_TOGETHER_INITIALS = new RegExp(WORD_START + '([A-Z])\\.(?=[A-Z]\\.)', 'gu');
const INVISIBLE = /[\u200B\uFEFF]/g;
// eslint-disable-next-line no-control-regex -- the separator controls are what it matches
const WHITESPACE = /[\s\x1c-\x1f]+/g; // \s plus the ASCII separator controls
// What follows a comma without being a name of its own: "Ann Vale, Jr.".
const NAME_SUFFIX = /^(jr|sr|i{2,3}|iv|phd|md)\.?$/i;

// The pages are written in American spelling and shown in British spelling to a browser that prefers it.
// The words the pages use that the two spell differently, American first; add a word here when a page starts using one.
const BRITISH_WORDS = [['catalog', 'catalogue']];
// Regions whose English spells these words the British way (Canada included: it writes "catalogue").
const BRITISH_REGIONS = new Set(['GB', 'UK', 'IE', 'AU', 'NZ', 'ZA', 'IN', 'CA', 'SG', 'HK', 'MT', 'PK', 'NG', 'KE']);

/** Text helpers; every method is static. */
export class Text {
	static WORD_START = WORD_START;
	static BRITISH_WORDS = BRITISH_WORDS;

	static isObject(v: unknown): v is Record<string, any> {
		return v !== null && typeof v === 'object' && !Array.isArray(v);
	}

	/**
	 * Trim and collapse whitespace: tabs, newlines, non-breaking spaces and runs of spaces become one space.
	 */
	static tidy(text: string): string {
		return text.replace(INVISIBLE, '').replace(WHITESPACE, ' ').trim();
	}

	/**
	 * Tidy a person's name and space out run-together initials: "A.B.  Quill" -> "A. B. Quill".
	 */
	static normalizeName(name: string): string {
		return Text.tidy(name).replace(RUN_TOGETHER_INITIALS, '$1. ');
	}

	/**
	 * Names tidied (normalizeName), without the repeats that tidying reveals; what is not a name is kept.
	 */
	static tidyNames(names: unknown[]): unknown[] {
		const out = names.map(x => (typeof x === 'string' ? Text.normalizeName(x) : x));
		return out.filter((x, i) => typeof x !== 'string' || out.indexOf(x) === i);
	}

	/**
	 * Lower-case, drop accents ("é" -> "e") and collapse everything that is not a letter or digit, in any
	 * script: "Сёмга" stays a word, so two books in Cyrillic or Japanese are told apart by their titles.
	 */
	static norm(text: unknown): string {
		return String(text || '')
			.normalize('NFKD')
			.replace(/\p{M}+/gu, '')
			.toLowerCase()
			.replace(/[^\p{L}\p{N}]+/gu, ' ')
			.trim();
	}

	/**
	 * norm() as it was before it knew other scripts: everything but a-z and 0-9 dropped. Only for reading
	 * "Not duplicates" marks written then (see Duplicates.pairKey).
	 */
	static asciiNorm(text: unknown): string {
		return String(text || '')
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, ' ')
			.trim();
	}

	/**
	 * A key made of parts, JSON-encoded so it works as a Map and Set key.
	 */
	static key(...parts: unknown[]): string {
		return JSON.stringify(parts);
	}

	static escapeRegExp(s: string): string {
		return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	}

	/**
	 * Quote a value for a message, Python-repr style: 'Title', or "It's" when it contains a quote.
	 */
	static repr(v: unknown): string {
		if (Array.isArray(v)) return '[' + v.map(Text.repr).join(', ') + ']';
		if (typeof v !== 'string') return String(v);
		const q = v.includes("'") && !v.includes('"') ? '"' : "'";
		const body = v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
		return q + (q === "'" ? body.replace(/'/g, "\\'") : body) + q;
	}

	// ------------------------------------------------------------------ names
	/**
	 * Split names written as text into a list: "Ann Vale, R. T. Hale" or "Ann Vale & R. T. Hale" ->
	 * ["Ann Vale", "R. T. Hale"]. Commas, semicolons, "&" and "and" separate names; a suffix stays with its
	 * name ("Ann Vale, Jr."). Names are trimmed, and repeats and empty parts dropped.
	 */
	static splitNames(text: unknown): string[] {
		const names: string[] = [];
		for (const part of String(text || '')
			.split(/[,;]|\s&\s|\sand\s/)
			.map(x => Text.tidy(x))
			.filter(Boolean)) {
			if (NAME_SUFFIX.test(part) && names.length) names[names.length - 1] += ', ' + part;
			else names.push(part);
		}
		return names.filter((x, i) => names.indexOf(x) === i);
	}

	/**
	 * Names as one line of text: ["Ann Vale", "R. T. Hale"] -> "Ann Vale, R. T. Hale" (a string is returned as is).
	 */
	static namesText(names: unknown): string {
		return Array.isArray(names) ? names.join(', ') : String(names || '');
	}

	/**
	 * A count with its word: (1, "book") -> "1 book", (3, "book") -> "3 books", (2, "series", "series") -> "2 series".
	 * @param many the word for any other count than one
	 */
	static plural(n: number, word: string, many: string = word + 's'): string {
		return `${n} ${n === 1 ? word : many}`;
	}

	/**
	 * The first three of `items`, saying how many more there are: "a, b, c and 2 more".
	 */
	static firstThree(items: string[], separator: string = ', '): string {
		return items.slice(0, 3).join(separator) + (items.length > 3 ? ` and ${items.length - 3} more` : '');
	}

	// ------------------------------------------------------------------ dates and lengths
	/**
	 * A date as the catalog keeps it (a date read, a release date): "2024-03-15", or just "2024-03" /
	 * "2024" when that is all you remember. Also accepts Goodreads' "2024/03/15" and single-digit
	 * months/days. Returns the canonical form, or null when it is not a real date.
	 */
	static parseDate(text: unknown): string | null {
		const m = /^(\d{4})(?:[-/](\d{1,2})(?:[-/](\d{1,2}))?)?$/.exec(Text.tidy(String(text || '')));
		if (!m) return null;
		const [, y, mo, d] = m;
		if (mo === undefined) return y;
		const month = Number(mo);
		if (month < 1 || month > 12) return null;
		const pad = (n: number) => String(n).padStart(2, '0');
		if (d === undefined) return `${y}-${pad(month)}`;
		const day = Number(d);
		const daysInMonth = new Date(Date.UTC(Number(y), month, 0)).getUTCDate();
		if (day < 1 || day > daysInMonth) return null;
		return `${y}-${pad(month)}-${pad(day)}`;
	}

	/**
	 * Parse a comma separated list of dates. Returns {dates (sorted, no repeats), bad (unparseable)}.
	 */
	static parseDates(text: unknown): {dates: string[]; bad: string[]} {
		const dates = new Set<string>(),
			bad = [];
		for (const part of String(text || '')
			.split(/[,;]/)
			.map(x => x.trim())
			.filter(Boolean)) {
			const date = Text.parseDate(part);
			if (date) dates.add(date);
			else bad.push(part);
		}
		return {dates: [...dates].sort(), bad};
	}

	/**
	 * A length in whole minutes, from Audible's "11 hrs and 5 mins", "11h 5m", "45 min" or "11:05".
	 * Returns null when there is none.
	 */
	static parseLength(text: unknown): number | null {
		const s = Text.tidy(String(text || '')).toLowerCase();
		let m = /^(\d+):(\d{1,2})(?::\d{1,2})?$/.exec(s);
		if (m) return Number(m[1]) * 60 + Number(m[2]) || null;
		m = /^(?:(\d+)\s*h(?:ours?|rs?)?)?(?:\s*(?:and|,)?\s*(\d+)\s*m(?:in(?:ute)?s?)?)?$/.exec(s);
		if (!m || (m[1] === undefined && m[2] === undefined)) return null;
		return Number(m[1] || 0) * 60 + Number(m[2] || 0) || null;
	}

	/**
	 * 642 -> "10h 42m"; the form parseLength() reads back.
	 */
	static formatLength(minutes: number): string {
		const h = Math.floor(minutes / 60),
			m = minutes % 60;
		return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
	}

	/**
	 * The host of a web address ('www.audible.com' from 'https://www.audible.com/author/...'), or null when
	 * it is not one. A pattern rather than URL(), so this module needs nothing but the language itself.
	 */
	static webHost(text: string): string | null {
		const m = /^https?:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)*)(?::\d+)?(?:[/?#]\S*)?$/i.exec(text);
		return m ? m[1].toLowerCase() : null;
	}

	// ------------------------------------------------------------------ spelling and messages
	/**
	 * Whether the browser's languages (navigator.languages, most preferred first) ask for British spelling: the
	 * first English one decides, so a Swedish browser that takes en-GB next gets British. With no English
	 * one, or English without a British region (en, en-US), it is American.
	 * @param languages BCP 47 tags, as `en-GB` or `en_AU`
	 */
	static prefersBritish(languages: readonly string[]): boolean {
		const english = languages.map(tag => String(tag).split(/[-_]/)).find(parts => parts[0].toLowerCase() === 'en');
		if (!english) return false;
		// the region is the two-letter subtag after the language (and after a four-letter script, if any)
		const region = english.slice(1).find(part => /^[a-z]{2}$/i.test(part));
		return !!region && BRITISH_REGIONS.has(region.toUpperCase());
	}

	/**
	 * The page's own text in British spelling when `british`, else as it is. Only for text the app wrote:
	 * a book's title is the book's own and is never respelled.
	 */
	static spelled(text: string, british: boolean): string {
		if (!british) return text;
		for (const [us, uk] of BRITISH_WORDS) {
			// the word, capitalized or not and with a plural s, but not inside another word (audiobook-catalog-backup is a file name)
			text = text.replace(
				new RegExp(`(?<![\\w:-])([${us[0]}${us[0].toUpperCase()}])${us.slice(1)}(s?)\\b(?!-)`, 'g'),
				`$1${uk.slice(1)}$2`,
			);
		}
		return text;
	}

	/**
	 * What went wrong, from what a `catch` caught: an error's message, or what was thrown as text. (An error
	 * from another realm, like a test's, is no `instanceof Error` here, so this goes by its message.)
	 */
	static errorText(exc: unknown): string {
		return exc !== null && typeof exc === 'object' && 'message' in exc ? String(exc.message) : String(exc);
	}
}
