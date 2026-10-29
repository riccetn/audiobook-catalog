// The books imports must never re-add, because you removed them on purpose: the exclusions list.
import {Text} from './text.js';
import {Isbn} from './isbn.js';
import {Book} from './book.js';
import {Series} from './series.js';

// "Goodreads 12345" (or "GR 12345"): a Goodreads book id, which needs its prefix to tell it from an ASIN.
const GOODREADS_ENTRY = /^(?:goodreads|gr)(?:\s+id)?:?\s*(\d+)$/i;
// "Hardcover 12345": a Hardcover edition id.
const HARDCOVER_ENTRY = /^hardcover(?:\s+id)?:?\s*(\d+)$/i;

/** Books that imports must never re-add (because you removed them on purpose). */
export class Exclusions {
	ids: Set<string>;
	titles: Set<string>;
	isbns: Set<string>;
	grs: Set<string>;
	hcs: Set<string>;
	lines: Map<string, string>;

	constructor() {
		this.ids = new Set();
		this.titles = new Set(); // key(norm(title), first author)
		this.isbns = new Set(); // 13-digit ISBNs
		this.grs = new Set(); // Goodreads book ids
		this.hcs = new Set(); // Hardcover edition ids
		this.lines = new Map(); // key -> the entry as written in the exclusions list
	}

	/**
	 * The exclusions list from its text: an ASIN, "ISBN 978...", "Goodreads 12345", "Hardcover 12345" or
	 * "Title | Author", per line; '#' starts a comment.
	 */
	static parse(text: string | null | undefined): Exclusions {
		const ex = new Exclusions();
		for (const line of (text || '').split(/\r\n|\r|\n/)) ex.add(line);
		return ex;
	}

	/**
	 * Add one line of the exclusions list: an ASIN, "ISBN 978...", "Goodreads 12345", "Hardcover 12345" or
	 * "Title | Author"; '#' starts a comment.
	 * Returns the entry as it should be written, or null for a blank line or one already covered.
	 * A bare ISBN-13 counts as an ISBN; a bare ISBN-10 as both an ASIN and an ISBN (Amazon uses a print
	 * edition's ISBN-10 as its ASIN).
	 */
	add(entry: unknown): string | null {
		let line = Text.tidy(String(entry).split('#')[0]);
		if (!line) return null;
		const bar = line.indexOf('|');
		if (bar < 0) {
			const gr = GOODREADS_ENTRY.exec(line);
			if (gr) {
				if (this.grs.has(gr[1])) return null;
				this.grs.add(gr[1]);
				this.lines.set(Text.key('gr', gr[1]), (line = `Goodreads ${gr[1]}`));
				return line;
			}
			const hc = HARDCOVER_ENTRY.exec(line);
			if (hc) {
				if (this.hcs.has(hc[1])) return null;
				this.hcs.add(hc[1]);
				this.lines.set(Text.key('hc', hc[1]), (line = `Hardcover ${hc[1]}`));
				return line;
			}
			const isbn = Isbn.parse(line);
			if (isbn && (/^isbn/i.test(line) || !/^[\dX]{10}$/i.test(line))) {
				if (this.isbns.has(isbn)) return null;
				this.isbns.add(isbn);
				this.lines.set(Text.key('isbn', isbn), (line = `ISBN ${isbn}`));
				return line;
			}
			if (this.ids.has(line) && (!isbn || this.isbns.has(isbn))) return null;
			this.ids.add(line);
			if (isbn) this.isbns.add(isbn);
			this.lines.set(Text.key('id', line), line);
			return line;
		}
		const title = line.slice(0, bar).trim(),
			author = line.slice(bar + 1).trim();
		const k = Text.key(Text.norm(title), Book.firstAuthor(author));
		if (this.titles.has(k)) return null;
		this.titles.add(k);
		// an entry written before series were split off titles still keeps out the book under its short title
		const split = Series.splitTitle(title);
		if (split && split[0]) this.titles.add(Text.key(Text.norm(split[0]), Book.firstAuthor(author)));
		this.lines.set(k, (line = `${title} | ${author}`));
		return line;
	}

	/**
	 * Add entries; returns how many were new.
	 */
	addAll(entries: string[]): number {
		return entries.map(e => this.add(e)).filter(Boolean).length;
	}

	/**
	 * Whether the list keeps `book` out.
	 */
	covers(book: Book): boolean {
		return (
			book.ids('asin').some(id => this.ids.has(id)) ||
			book.ids('goodreads').some(gr => this.grs.has(gr)) ||
			book.ids('hardcover').some(hc => this.hcs.has(hc)) ||
			(Text.norm(book.title) !== '' && this.titles.has(Text.key(Text.norm(book.title), book.authorKey()))) ||
			book.isbns().some(isbn => this.isbns.has(isbn))
		);
	}

	/** @returns a copy */
	clone(): Exclusions {
		return Exclusions.parse(this.entries.join('\n'));
	}

	/** The entries, one per line as in the exclusions list, without comments. */
	get entries() {
		return [...this.lines.values()];
	}
	get size() {
		return this.lines.size;
	}
}
