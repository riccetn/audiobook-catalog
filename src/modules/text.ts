// Text as the catalog keeps it: tidying, the forgiving forms that matching compares, names written as a
// list or as text, dates and lengths, and the page's spelling. Every other module builds on this one.
//
// Like every module in this folder it uses no browser APIs, so the tests run it in Node as it is.

/**
 * Data as it came from a file, a backup or localStorage, before it has been checked: it may be in an
 * older format or not a book at all, so the code that takes it checks what it uses.
 */
export type Unchecked = any;

/**
 * How a class reads one stored key (Text.setStored): whether a value is what the key holds, and how it is put on
 * its field (given undefined, the field is cleared).
 */
/**
 * A message a module hands a page: a template the app wrote, with a `{marker}` where each value goes, and the
 * values, which are data (a title, a name, a count) put in as they are, or Phrases of their own. The page spells
 * it (dom.ts spell()), so a title with "Catalog" in it is never respelled; `Text.filled(phrase, false)` is its
 * American English.
 */
export type Phrase = {template: string; values: Record<string, PhraseValue>};

/** what fills a Phrase's marker */
export type PhraseValue = string | number | Phrase;

/** An error whose message is a Phrase (see Text.errorPhrase); its `message` is the American English. */
export class PhraseError extends Error {
	/** the message as a Phrase */
	phrase: Phrase;

	constructor(template: string | Phrase, values: Record<string, PhraseValue> = {}, options?: ErrorOptions) {
		const phrase = typeof template === 'string' ? {template, values} : template;
		super(Text.filled(phrase, false), options);
		this.phrase = phrase;
	}
}

export type StoredField<T> = [(v: unknown) => boolean, (into: T, v: any) => void];

// JavaScript's \b is ASCII-only, so "é" would count as a word boundary; this is the Unicode "no word char before".
const WORD_START = '(?<![\\p{L}\\p{N}_])';
const RUN_TOGETHER_INITIALS = new RegExp(WORD_START + '([A-Z])\\.(?=[A-Z]\\.)', 'gu');
const INVISIBLE = /[\u200B\uFEFF]/g;
// eslint-disable-next-line no-control-regex -- the separator controls are what it matches
const WHITESPACE = /[\s\x1c-\x1f]+/g; // \s plus the ASCII separator controls
// What follows a comma without being a name of its own: "Ann Vale, Jr.".
const NAME_SUFFIX = /^(jr|sr|i{2,3}|iv|phd|md)\.?$/i;
// What follows a company's name after a comma: "Gull Audio, Inc."
const COMPANY_SUFFIX = /^(inc|llc|l\.l\.c|ltd|co|corp|plc|gmbh|ab|as|oy|bv|sa|srl|pty ltd)\.?$/i;

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

	/** Whether a stored value is a text with something in it. */
	static nonEmpty(v: unknown): v is string {
		return typeof v === 'string' && v.trim() !== '';
	}

	/** Whether a stored value is a list of names as books and editions keep them: not empty, each a text with something in it. */
	static isNameList(v: unknown): v is string[] {
		return Array.isArray(v) && v.length > 0 && v.every(Text.nonEmpty);
	}

	/**
	 * Set one stored key's value on a class that keeps what it can't read aside in `extra` (Book, Edition):
	 * `fields[key]` says whether the value is what the key holds and puts it on its field (undefined clears it);
	 * a value that isn't, and a key it doesn't know, is kept in `extra` as it is.
	 */
	static setStored<T extends {extra: Record<string, unknown>}>(
		into: T,
		fields: Record<string, StoredField<T>>,
		key: string,
		v: unknown,
	) {
		delete into.extra[key];
		const field = Object.hasOwn(fields, key) ? fields[key] : null;
		const ok = !!field && field[0](v);
		if (field) field[1](into, ok ? v : undefined);
		if (!ok && v !== undefined) into.extra[key] = v;
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
	 * Texts tidied, without the repeats that tidying reveals; what is not a text is kept.
	 */
	static tidyList(items: unknown[]): unknown[] {
		const out = items.map(x => (typeof x === 'string' ? Text.tidy(x) : x));
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
	 * Split publishers' names written as text into a list: "Gull Audio, Tern & Finch Press" -> ["Gull Audio",
	 * "Tern & Finch Press"]. Only commas and semicolons separate them, as "&" and "and" are often part of a
	 * publisher's name; a company's suffix stays with its name ("Gull Audio, Inc."). Names are trimmed, and
	 * repeats and empty parts dropped. A name in `known` is kept whole, commas and all ("Tern Press, Harbor
	 * Division"), so a publisher the catalog has survives a form that shows it among others.
	 * @param known publishers' names already known (the edition's own, the catalog's)
	 */
	static splitPublishers(text: unknown, known: Iterable<string> = []): string[] {
		const whole = new Set([...known].filter(name => name.includes(',')).map(name => Text.tidy(name)));
		const parts = String(text || '')
			.split(/[,;]/)
			.map(x => Text.tidy(x))
			.filter(Boolean);
		const names: string[] = [];
		for (let i = 0; i < parts.length; i++) {
			// the longest run of parts that is a known name
			let end = -1;
			for (let j = parts.length - 1; j > i && whole.size; j--)
				if (whole.has(parts.slice(i, j + 1).join(', '))) {
					end = j;
					break;
				}
			if (end >= 0) {
				names.push(parts.slice(i, end + 1).join(', '));
				i = end;
			} else if (COMPANY_SUFFIX.test(parts[i]) && names.length) names[names.length - 1] += ', ' + parts[i];
			else names.push(parts[i]);
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

	/**
	 * firstThree() as a Phrase, for a module's message: the items are data, "and 2 more" the app's text.
	 */
	static firstThreePhrase(items: string[], separator: string = ', '): PhraseValue {
		const shown = items.slice(0, 3).join(separator);
		return items.length > 3
			? Text.phrase('{items} and {count} more', {items: shown, count: items.length - 3})
			: shown;
	}

	// ------------------------------------------------------------------ dates and lengths
	/** Today in the viewer's time zone, as YYYY-MM-DD (a date read, as the pages add it). */
	static today(): string {
		const d = new Date();
		return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
	}

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
	 * 642 -> "10h 42m"; what parseLength() reads back.
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

	/**
	 * A typed web address as the catalog keeps it: trimmed, with https:// in front when it names no scheme
	 * ("gullwing.example/books" -> "https://gullwing.example/books"); '' for nothing. Another scheme is kept, for the Check to note.
	 */
	static tidyLink(text: string): string {
		const v = text.trim();
		if (!v) return '';
		if (v.startsWith('//')) return 'https:' + v;
		return /^[a-z][a-z0-9+.-]*:(?:\/\/|[^\d])/i.test(v) ? v : 'https://' + v;
	}

	/**
	 * Links as the catalog keeps them: each tidied (tidyLink()), once, in the order given, without empty ones;
	 * anything that is not a text is kept, for the Check to report.
	 */
	static tidyLinks(links: unknown[]): unknown[] {
		const out: unknown[] = [];
		for (const x of links) {
			const v = typeof x === 'string' ? Text.tidyLink(x) : x;
			if (v !== '' && !out.includes(v)) out.push(v);
		}
		return out;
	}

	/** Links typed one per line (or parted by spaces), as the catalog keeps them (tidyLinks()). */
	static parseLinks(text: string): string[] {
		return Text.tidyLinks(text.split(/\s+/)) as string[];
	}

	/** What a link is shown as: its site, without a leading "www." ("gullwing.example"); the address when it is no web address. */
	static linkLabel(href: string): string {
		return (Text.webHost(href) || href).replace(/^www\./, '');
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
	 * A message the app wrote (see Phrase) with `values` beside it.
	 */
	static phrase(template: string, values: Record<string, PhraseValue> = {}): Phrase {
		return {template, values};
	}

	/** Whether `v` is a Phrase (a page's values may also be elements, which are not). */
	static isPhrase(v: unknown): v is Phrase {
		return Text.isObject(v) && typeof v.template === 'string' && Text.isObject(v.values);
	}

	/**
	 * A count with its word as a Phrase, "{count} book" or "{count} books" (see plural), so a page spells the word.
	 * @param many the word for any other count than one
	 */
	static counted(n: number, word: string, many: string = word + 's'): Phrase {
		return Text.phrase(n === 1 ? `{count} ${word}` : `{count} ${many}`, {count: n});
	}

	/**
	 * Phrases as one, `separator` between them: ["a", "b"] -> "{p0}; {p1}".
	 */
	static joinPhrases(phrases: Phrase[], separator: string = '; '): Phrase {
		const values: Record<string, Phrase> = {};
		phrases.forEach((p, i) => (values['p' + i] = p));
		return Text.phrase(phrases.map((_p, i) => `{p${i}}`).join(separator), values);
	}

	/**
	 * A template the app wrote, respelled (see spelled), with its `{marker}`s filled in from `values` as they are:
	 * a value is a title, a name or other data, or text already spelled, and is never respelled; a value that is
	 * a Phrase is the app's own text, filled in the same way. A template's whole sentence stays one text, so
	 * another language can put the values where its own sentence needs them. A marker without a value throws,
	 * as it is a mistake in the code. `Text.filled(phrase, false)` is a module's message in American English.
	 */
	static filled(template: string | Phrase, british: boolean, values: Record<string, PhraseValue> = {}): string {
		return Text.templateParts(template, british, values).map(String).join('');
	}

	/**
	 * A template's parts in order (see filled): its own text respelled, and in place of each `{marker}` its
	 * value from `values`, whatever that is (a page puts elements in), as it is, but a Phrase filled in.
	 */
	static templateParts<T>(
		template: string | Phrase,
		british: boolean,
		values: Record<string, T | PhraseValue> = {},
	): (string | T | number)[] {
		if (typeof template !== 'string') return Text.templateParts<T>(template.template, british, template.values);
		return template.split(/(\{\w+\})/).map((part, i) => {
			if (i % 2 === 0) return Text.spelled(part, british);
			const key = part.slice(1, -1);
			if (!Object.hasOwn(values, key)) throw new Error(`No value for ${part} in "${template}"`);
			const value = values[key];
			return Text.isPhrase(value) ? Text.filled(value, british) : (value as T | string | number);
		});
	}

	/**
	 * What went wrong, from what a `catch` caught, as a Phrase: a PhraseError's own, else the error's message (or
	 * what was thrown) as a value, which is not the app's text (a browser's, a catalog's) and is never respelled.
	 */
	static errorPhrase(exc: unknown): Phrase {
		if (exc !== null && typeof exc === 'object' && 'phrase' in exc && Text.isPhrase(exc.phrase)) return exc.phrase;
		return Text.phrase('{error}', {error: Text.errorText(exc)});
	}

	/**
	 * What went wrong, from what a `catch` caught: an error's message, or what was thrown as text. (An error
	 * from another realm, like a test's, is no `instanceof Error` here, so this goes by its message.)
	 */
	static errorText(exc: unknown): string {
		return exc !== null && typeof exc === 'object' && 'message' in exc ? String(exc.message) : String(exc);
	}
}
