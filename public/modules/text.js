// Text as the catalog keeps it: tidying, the forgiving forms that matching compares, names written as a
// list or as text, dates and lengths, and the page's spelling. Every other module builds on this one.
//
// Like every module in this folder it uses no browser APIs, so the tests run it in Node as it is.

/**
 * Data as it came from a file, a backup or localStorage, before it has been checked: it may be in an
 * older format or not a book at all, so the code that takes it checks what it uses.
 * @typedef {any} Unchecked
 */

// JavaScript's \b is ASCII-only, so "é" would count as a word boundary; this is the Unicode "no word char before".
const WORD_START = '(?<![\\p{L}\\p{N}_])';
const RUN_TOGETHER_INITIALS = new RegExp(WORD_START + '([A-Z])\\.(?=[A-Z]\\.)', 'gu');
const INVISIBLE = /[​﻿]/g;
const WHITESPACE = /[\s\x1c-\x1f]+/g;   // \s plus the ASCII separator controls
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

	/**
	 * @param {unknown} v
	 * @returns {v is Record<string, any>}
	 */
	static isObject(v){ return v !== null && typeof v === 'object' && !Array.isArray(v); }

	/**
	 * Trim and collapse whitespace: tabs, newlines, non-breaking spaces and runs of spaces become one space.
	 * @param {string} text
	 * @returns {string}
	 */
	static tidy(text){
		return text.replace(INVISIBLE, '').replace(WHITESPACE, ' ').trim();
	}

	/**
	 * Tidy a person's name and space out run-together initials: "A.B.  Quill" -> "A. B. Quill".
	 * @param {string} name
	 * @returns {string}
	 */
	static normalizeName(name){
		return Text.tidy(name).replace(RUN_TOGETHER_INITIALS, '$1. ');
	}

	/**
	 * Names tidied (normalizeName), without the repeats that tidying reveals; what is not a name is kept.
	 * @param {unknown[]} names
	 * @returns {unknown[]}
	 */
	static tidyNames(names){
		const out = names.map(x => typeof x === 'string' ? Text.normalizeName(x) : x);
		return out.filter((x, i) => typeof x !== 'string' || out.indexOf(x) === i);
	}

	/**
	 * Lower-case, drop accents ("é" -> "e") and collapse everything that is not a letter or digit, in any
	 * script: "Сёмга" stays a word, so two books in Cyrillic or Japanese are told apart by their titles.
	 * @param {unknown} text
	 * @returns {string}
	 */
	static norm(text){
		return String(text || '').normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase()
			.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
	}

	/**
	 * norm() as it was before it knew other scripts: everything but a-z and 0-9 dropped. Only for reading
	 * "Not duplicates" marks written then (see Duplicates.pairKey).
	 * @param {unknown} text
	 * @returns {string}
	 */
	static asciiNorm(text){
		return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
	}

	/**
	 * A key made of parts, JSON-encoded so it works as a Map and Set key.
	 * @param {...unknown} parts
	 * @returns {string}
	 */
	static key(...parts){ return JSON.stringify(parts); }

	/**
	 * @param {string} s
	 * @returns {string}
	 */
	static escapeRegExp(s){ return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

	/**
	 * Quote a value for a message, Python-repr style: 'Title', or "It's" when it contains a quote.
	 * @param {unknown} v
	 * @returns {string}
	 */
	static repr(v){
		if(Array.isArray(v)) return '[' + v.map(Text.repr).join(', ') + ']';
		if(typeof v !== 'string') return String(v);
		const q = v.includes("'") && !v.includes('"') ? '"' : "'";
		const body = v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
		return q + (q === "'" ? body.replace(/'/g, "\\'") : body) + q;
	}

	// ------------------------------------------------------------------ names
	/**
	 * Split names written as text into a list: "Ann Vale, R. T. Hale" or "Ann Vale & R. T. Hale" ->
	 * ["Ann Vale", "R. T. Hale"]. Commas, semicolons, "&" and "and" separate names; a suffix stays with its
	 * name ("Ann Vale, Jr."). Names are trimmed, and repeats and empty parts dropped.
	 * @param {unknown} text
	 * @returns {string[]}
	 */
	static splitNames(text){
		/** @type {string[]} */
		const names = [];
		for(const part of String(text || '').split(/[,;]|\s&\s|\sand\s/).map(x => Text.tidy(x)).filter(Boolean)){
			if(NAME_SUFFIX.test(part) && names.length) names[names.length - 1] += ', ' + part;
			else names.push(part);
		}
		return names.filter((x, i) => names.indexOf(x) === i);
	}

	/**
	 * Names as one line of text: ["Ann Vale", "R. T. Hale"] -> "Ann Vale, R. T. Hale" (a string is returned as is).
	 * @param {unknown} names
	 * @returns {string}
	 */
	static namesText(names){
		return Array.isArray(names) ? names.join(', ') : String(names || '');
	}

	/**
	 * Names as a list. Before they were lists, the authors ("a") and an edition's narrators ("n") were one
	 * comma separated string; that is split (splitNames). A list keeps its names as they are, without
	 * repeats or empty ones; anything else is left for the Check to report. Returns null for no names.
	 * @param {unknown} v
	 * @returns {unknown}
	 */
	static fixNames(v){
		if(typeof v === 'string') return Text.splitNames(v).length ? Text.splitNames(v) : null;
		if(!Array.isArray(v)) return v;
		const names = v.filter((x, i) => !(typeof x === 'string' && (!x.trim() || v.indexOf(x) !== i)));
		return !names.length ? null : names.length === v.length ? v : names;
	}

	/**
	 * A stored book or edition with its authors ("a") and narrators ("n") as lists (fixNames()), its
	 * editions' too; the record itself is returned when nothing changes.
	 * @template T
	 * @param {T} rec
	 * @returns {T}
	 */
	static fixPeople(rec){
		if(!Text.isObject(rec)) return rec;
		/** @type {Record<string, any>} */
		let out = rec;
		for(const k of ['a', 'n']){
			if(!(k in rec)) continue;
			const names = Text.fixNames(rec[k]);
			if(names === rec[k]) continue;
			if(out === rec) out = {...rec};
			if(names === null) delete out[k]; else out[k] = names;
		}
		if(Array.isArray(rec.e) && rec.e.some(ed => Text.fixPeople(ed) !== ed)){
			if(out === rec) out = {...rec};
			out.e = rec.e.map(Text.fixPeople);
		}
		return /** @type {T} */ (out);
	}

	// ------------------------------------------------------------------ dates and lengths
	/**
	 * A date as the catalog keeps it (a date read, a release date): "2024-03-15", or just "2024-03" /
	 * "2024" when that is all you remember. Also accepts Goodreads' "2024/03/15" and single-digit
	 * months/days. Returns the canonical form, or null when it is not a real date.
	 * @param {unknown} text
	 * @returns {string | null}
	 */
	static parseDate(text){
		const m = /^(\d{4})(?:[-/](\d{1,2})(?:[-/](\d{1,2}))?)?$/.exec(Text.tidy(String(text || '')));
		if(!m) return null;
		const [, y, mo, d] = m;
		if(mo === undefined) return y;
		const month = Number(mo);
		if(month < 1 || month > 12) return null;
		const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
		if(d === undefined) return `${y}-${pad(month)}`;
		const day = Number(d);
		const daysInMonth = new Date(Date.UTC(Number(y), month, 0)).getUTCDate();
		if(day < 1 || day > daysInMonth) return null;
		return `${y}-${pad(month)}-${pad(day)}`;
	}

	/**
	 * Parse a comma separated list of dates. Returns {dates (sorted, no repeats), bad (unparseable)}.
	 * @param {unknown} text
	 * @returns {{dates: string[], bad: string[]}}
	 */
	static parseDates(text){
		const dates = new Set(), bad = [];
		for(const part of String(text || '').split(/[,;]/).map(x => x.trim()).filter(Boolean)){
			const date = Text.parseDate(part);
			if(date) dates.add(date); else bad.push(part);
		}
		return {dates: [...dates].sort(), bad};
	}

	/**
	 * A length in whole minutes, from Audible's "11 hrs and 5 mins", "11h 5m", "45 min" or "11:05".
	 * Returns null when there is none.
	 * @param {unknown} text
	 * @returns {number | null}
	 */
	static parseLength(text){
		const s = Text.tidy(String(text || '')).toLowerCase();
		let m = /^(\d+):(\d{1,2})(?::\d{1,2})?$/.exec(s);
		if(m) return Number(m[1]) * 60 + Number(m[2]) || null;
		m = /^(?:(\d+)\s*h(?:ours?|rs?)?)?(?:\s*(?:and|,)?\s*(\d+)\s*m(?:in(?:ute)?s?)?)?$/.exec(s);
		if(!m || (m[1] === undefined && m[2] === undefined)) return null;
		return Number(m[1] || 0) * 60 + Number(m[2] || 0) || null;
	}

	/**
	 * 642 -> "10h 42m"; the form parseLength() reads back.
	 * @param {number} minutes
	 * @returns {string}
	 */
	static formatLength(minutes){
		const h = Math.floor(minutes / 60), m = minutes % 60;
		return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
	}

	/**
	 * The host of a web address ('www.audible.com' from 'https://www.audible.com/author/...'), or null when
	 * it is not one. A pattern rather than URL(), so this module needs nothing but the language itself.
	 * @param {string} text
	 * @returns {string | null}
	 */
	static webHost(text){
		const m = /^https?:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)*)(?::\d+)?(?:[\/?#]\S*)?$/i.exec(text);
		return m ? m[1].toLowerCase() : null;
	}

	// ------------------------------------------------------------------ spelling and messages
	/**
	 * Whether the browser's languages (navigator.languages, most preferred first) ask for British spelling: the
	 * first English one decides, so a Swedish browser that takes en-GB next gets British. With no English
	 * one, or English without a British region (en, en-US), it is American.
	 * @param {readonly string[]} languages BCP 47 tags, as `en-GB` or `en_AU`
	 * @returns {boolean}
	 */
	static prefersBritish(languages){
		const english = languages.map(tag => String(tag).split(/[-_]/)).find(parts => parts[0].toLowerCase() === 'en');
		if(!english) return false;
		// the region is the two-letter subtag after the language (and after a four-letter script, if any)
		const region = english.slice(1).find(part => /^[a-z]{2}$/i.test(part));
		return !!region && BRITISH_REGIONS.has(region.toUpperCase());
	}

	/**
	 * The page's own text in British spelling when `british`, else as it is. Only for text the app wrote:
	 * a book's title is the book's own and is never respelled.
	 * @param {string} text
	 * @param {boolean} british
	 * @returns {string}
	 */
	static spelled(text, british){
		if(!british) return text;
		for(const [us, uk] of BRITISH_WORDS){
			// the word, capitalized or not and with a plural s, but not inside another word (audiobook-catalog-backup is a file name)
			text = text.replace(new RegExp(`(?<![\\w:-])([${us[0]}${us[0].toUpperCase()}])${us.slice(1)}(s?)\\b(?!-)`, 'g'), `$1${uk.slice(1)}$2`);
		}
		return text;
	}

	/**
	 * What went wrong, from what a `catch` caught: an error's message, or what was thrown as text. (An error
	 * from another realm, like a test's, is no `instanceof Error` here, so this goes by its message.)
	 * @param {unknown} exc
	 * @returns {string}
	 */
	static errorText(exc){
		return exc !== null && typeof exc === 'object' && 'message' in exc ? String(exc.message) : String(exc);
	}
}
