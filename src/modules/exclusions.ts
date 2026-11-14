// The books imports must never re-add, because you removed them on purpose: the exclusions list. An entry
// that starts with "Edition" keeps out one edition only: its book still matches and gains everything else.
import {Text} from './text.js';
import type {Edition} from './edition.js';
import {Isbn} from './isbn.js';
import {Book} from './book.js';
import {Series} from './series.js';
import {ExternalCatalog} from './external-catalog.js';
import type {FamilyDefinition} from './external-catalog.js';

// "Edition B0…", "Edition ISBN 978…", "Edition Goodreads 4242", "Edition Hardcover 601": one edition, not its book.
const EDITION_ENTRY = /^edition:?\s+(.+)$/i;

/** How the list reads the ids of one family of catalogs (ExternalCatalog.EXCLUDING). */
interface EntryReader {
	family: string;
	/** what an entry writes before the id; '' when the id stands alone */
	name: string;
	/** reads a line (its first group the id) */
	entry: RegExp;
	/** reads what follows "Edition" */
	edition: RegExp;
	upper: boolean;
}
// An id with its catalog's name before it ("Goodreads 12345", or "GR 12345": the name tells it from an id that
// stands alone), and an id alone on its line (an ASIN: letters and digits only, kept in capitals).
const READERS: EntryReader[] = ExternalCatalog.EXCLUDING.map(family => {
	const of = family.exclusion as NonNullable<FamilyDefinition['exclusion']>;
	const before = of.name
		? `(?:${[of.name, ...(of.also || [])].map(Text.escapeRegExp).join('|')})(?:\\s+id)?:?\\s*`
		: '';
	return {
		family: family.key,
		name: of.name,
		entry: new RegExp(`^${before}(${of.id})$`, 'i'),
		edition: new RegExp(`^${before}(${of.edition || of.id})$`, 'i'),
		upper: !!of.upper,
	};
});
const NAMED = READERS.filter(r => r.name),
	ALONE = READERS.filter(r => !r.name);

/** Books that imports must never re-add (because you removed them on purpose). */
export class Exclusions {
	/** the edition ids kept out, by their family (ExternalCatalog.family: "asin", "goodreads") */
	ids: Map<string, Set<string>>;
	titles: Set<string>;
	isbns: Set<string>;
	/** the editions kept out, by Edition.idAndIsbnKeys() ("asin B0…", "isbn 978…", "goodreads 4242") */
	editions: Set<string>;
	lines: Map<string, string>;
	/** the lines that are none of the entries above (a title without its author), kept as written but matching nothing */
	unreadable: Set<string>;

	constructor() {
		this.ids = new Map();
		this.titles = new Set(); // key(norm(title), first author)
		this.isbns = new Set(); // 13-digit ISBNs
		this.editions = new Set();
		this.lines = new Map(); // key -> the entry as written in the exclusions list
		this.unreadable = new Set();
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
		const edition = EDITION_ENTRY.exec(line);
		if (edition && Exclusions.editionKey(edition[1])) return this.addEdition(edition[1]);
		const bar = line.indexOf('|');
		if (bar < 0) {
			for (const reader of NAMED) {
				const m = reader.entry.exec(line);
				if (!m) continue;
				const id = reader.upper ? m[1].toUpperCase() : m[1];
				if (this.has(reader.family, id)) return null;
				this.idsOf(reader.family).add(id);
				this.lines.set(Text.key('id', reader.family, id), (line = `${reader.name} ${id}`));
				return line;
			}
			const isbn = Isbn.parse(line);
			if (isbn && (/^isbn/i.test(line) || !/^[\dX]{10}$/i.test(line))) {
				if (this.isbns.has(isbn)) return null;
				this.isbns.add(isbn);
				this.lines.set(Text.key('isbn', isbn), (line = `ISBN ${isbn}`));
				return line;
			}
			const alone = ALONE.find(reader => reader.entry.test(line));
			if (!alone) return this.addUnreadable(line);
			if (alone.upper) line = line.toUpperCase();
			if (this.has(alone.family, line) && (!isbn || this.isbns.has(isbn))) return null;
			this.idsOf(alone.family).add(line);
			if (isbn) this.isbns.add(isbn);
			this.lines.set(Text.key('id', alone.family, line), line);
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

	/** The ids of a family kept out, to add to. */
	private idsOf(family: string): Set<string> {
		let ids = this.ids.get(family);
		if (!ids) this.ids.set(family, (ids = new Set()));
		return ids;
	}

	/**
	 * Whether an edition id of a family (ExternalCatalog.family) is kept out, as the list writes it.
	 */
	has(family: string, id: string): boolean {
		return !!this.ids.get(family)?.has(id);
	}

	/**
	 * Add an edition's entry, `id` being what follows "Edition": an ASIN, "ISBN 978...", "Goodreads 4242"
	 * or "Hardcover 601". Returns the entry as written, or null when it is not one or is there already.
	 */
	addEdition(id: string): string | null {
		const found = Exclusions.editionKey(id);
		if (!found || this.editions.has(found.key)) return null;
		this.editions.add(found.key);
		const line = `Edition ${found.shown}`;
		this.lines.set(Text.key('edition', found.key), line);
		return line;
	}

	/**
	 * What follows "Edition" read: its key among `editions` and how the entry shows it; null when it is no id.
	 */
	static editionKey(id: string): {key: string; shown: string} | null {
		const isbn = Isbn.parse(id);
		const read = (reader: EntryReader) => {
			const m = reader.edition.exec(id),
				value = m && (reader.upper ? m[1].toUpperCase() : m[1]);
			return value
				? {key: `${reader.family} ${value}`, shown: reader.name ? `${reader.name} ${value}` : value}
				: null;
		};
		for (const reader of NAMED) {
			const found = read(reader);
			if (found) return found;
		}
		if (isbn && (/^isbn/i.test(id) || !/^[\dX]{10}$/i.test(id)))
			return {key: `isbn ${isbn}`, shown: `ISBN ${isbn}`};
		for (const reader of ALONE) {
			const found = read(reader);
			if (found) return found;
		}
		return null;
	}

	/**
	 * Keep a line that is no entry as it was written, so it isn't lost and the Check can name it; it keeps nothing out.
	 */
	addUnreadable(line: string): string | null {
		if (this.unreadable.has(line)) return null;
		this.unreadable.add(line);
		this.lines.set(Text.key('unreadable', line), line);
		return line;
	}

	/**
	 * The entries that keep `ed` out of imports, one per id it has (an ASIN of any site, its ISBN, its
	 * Goodreads and Hardcover edition ids).
	 */
	static editionEntries(ed: Edition): string[] {
		const out = new Exclusions();
		const of = (readers: EntryReader[]) =>
			readers.flatMap(r => ed.ids(r.family).map(id => (r.name ? `${r.name} ${id}` : id)));
		const entries = [...of(ALONE), ...ed.isbns().map(isbn => `ISBN ${isbn}`), ...of(NAMED)];
		return entries.map(id => out.addEdition(id)).filter((line): line is string => line !== null);
	}

	/**
	 * Whether the list keeps the edition `ed` out (an entry for an edition, by any id it has).
	 */
	coversEdition(ed: Edition): boolean {
		return this.editions.size > 0 && ed.idAndIsbnKeys().some(k => this.editions.has(k));
	}

	/**
	 * Take `entry` off the list (as `entries` writes it); returns whether it was there.
	 */
	remove(entry: string): boolean {
		const kept = this.entries.filter(e => e !== entry);
		if (kept.length === this.lines.size) return false;
		const rebuilt = Exclusions.parse(kept.join('\n'));
		Object.assign(this, rebuilt);
		return true;
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
			READERS.some(r => book.ids(r.family).some(id => this.has(r.family, r.upper ? id.toUpperCase() : id))) ||
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
