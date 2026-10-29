// Open Library as a source of the book form's Fill in: it answers any web page (open CORS, no key), by its
// works (OL…W), editions (OL…M) and ISBNs. It has no narrators, and seldom a series.
import {Text} from './text.js';
import {Isbn} from './isbn.js';
import {Book} from './book.js';
import {ExternalCatalog} from './external-catalog.js';
import {BookSource} from './book-source.js';
import type {Unchecked} from './text.js';
import type {Pasted, Answers} from './book-source.js';

const OPEN_LIBRARY = 'https://openlibrary.org';
const tidyText = BookSource.text;

/** Looks books up on Open Library. */
export class OpenLibrarySource extends BookSource {
	static CATALOG = 'openlibrary';
	static LABEL = 'Open Library';
	static NAMES = ['Open Library'];

	/**
	 * A bare Open Library id: OL…M an edition, OL…W a work.
	 */
	static read(value: string): Pasted | null {
		if (/^OL\d+M$/i.test(value)) return {catalog: 'openlibrary', kind: 'edition', id: value.toUpperCase()};
		if (/^OL\d+W$/i.test(value)) return {catalog: 'openlibrary', kind: 'book', id: value.toUpperCase()};
		return null;
	}

	/**
	 * Its own works and editions, and ISBNs beside the others.
	 */
	answers(pasted: Pasted): Answers {
		return pasted.kind === 'isbn' ? 'also' : super.answers(pasted);
	}

	async lookup(pasted: Pasted): Promise<Book | null> {
		if (pasted.kind === 'isbn') return this.byIsbn(pasted.id);
		return pasted.kind === 'edition' ? this.edition(pasted.id) : this.work(pasted.id);
	}

	/**
	 * An Open Library answer, or null when it has no such page.
	 */
	async ask(path: string): Promise<Unchecked | null> {
		return this.json(OPEN_LIBRARY + path);
	}

	/**
	 * The names of Open Library's authors, by their keys ("/authors/OL1A"); those it doesn't have are left out.
	 */
	async authors(keys: unknown[]): Promise<string[]> {
		const names = [];
		for (const key of keys.filter(k => typeof k === 'string' && /^\/authors\/OL\d+A$/.test(k)).slice(0, 10)) {
			const author = await this.ask(`${key}.json`);
			if (author && typeof author.name === 'string' && Text.tidy(author.name)) names.push(Text.tidy(author.name));
		}
		return [...new Set(names)];
	}

	/**
	 * A book from Open Library's work.
	 * @param id OL…W
	 */
	async work(id: string): Promise<Book> {
		const work = await this.ask(`/works/${id}.json`);
		if (!work) throw new Error(`Open Library has no work ${id}`);
		const authors = await this.authors(
			(Array.isArray(work.authors) ? work.authors : []).map((a: unknown) =>
				Text.isObject(a) && Text.isObject(a.author) ? a.author.key : null,
			),
		);
		return OpenLibrarySource.book(work, null, authors);
	}

	/**
	 * A book with its edition from Open Library's edition (and its work, for the authors when the edition
	 * names none).
	 * @param id OL…M
	 */
	async edition(id: string): Promise<Book> {
		const edition = await this.ask(`/books/${id}.json`);
		if (!edition) throw new Error(`Open Library has no edition ${id}`);
		return this.bookOf(edition);
	}

	/**
	 * The book of the edition with this ISBN on Open Library; null when it has none.
	 */
	async byIsbn(isbn: string): Promise<Book | null> {
		const edition = await this.ask(`/isbn/${isbn}.json`);
		return edition ? this.bookOf(edition) : null;
	}

	/**
	 * @param edition an Open Library edition
	 */
	async bookOf(edition: Unchecked): Promise<Book> {
		const workKey =
			Array.isArray(edition.works) && Text.isObject(edition.works[0]) && typeof edition.works[0].key === 'string'
				? edition.works[0].key
				: null;
		const work = workKey && /^\/works\/OL\d+W$/.test(workKey) ? await this.ask(`${workKey}.json`) : null;
		const of = (x: Unchecked | null) =>
			x && Array.isArray(x.authors)
				? x.authors.map((a: unknown) =>
						Text.isObject(a) ? (Text.isObject(a.author) ? a.author.key : a.key) : null,
					)
				: [];
		const editionAuthors = of(edition);
		const authors = await this.authors(editionAuthors.length ? editionAuthors : of(work));
		return OpenLibrarySource.book(work || {}, edition, authors);
	}

	/**
	 * A book made of an Open Library work and edition (either may be all but empty) and its authors' names.
	 */
	static book(work: Unchecked, edition: Unchecked | null, authors: string[]): Book {
		const idOf: (x: unknown, re: RegExp) => string | null = (x, re) => {
			const m = re.exec(tidyText(x));
			return m ? m[1] : null;
		};
		const first: (x: unknown) => unknown = x => (Array.isArray(x) ? x[0] : undefined);
		const rec: Record<string, any> = {
			t: tidyText(work.title) || (edition ? tidyText(edition.title) : ''),
			a: authors,
		};
		const workId = idOf(work.key, /^\/works\/(OL\d+W)$/);
		if (workId) rec.ext = {openlibrary: workId};
		if (edition) {
			const series = OpenLibrarySource.seriesOf(tidyText(first(edition.series)));
			if (series) {
				rec.s = series.name;
				if (series.number) rec.sn = series.number;
			}
			const ed: Record<string, any> = {ext: {}};
			const editionId = idOf(edition.key, /^\/books\/(OL\d+M)$/);
			if (editionId) ed.ext.openlibrary = editionId;
			const ids = Text.isObject(edition.identifiers) ? edition.identifiers : {};
			const goodreads = tidyText(first(ids.goodreads));
			if (/^\d+$/.test(goodreads)) ed.ext.goodreads = goodreads;
			// Open Library's Amazon id is amazon.com's; a print book's is its ISBN-10, which is no ASIN
			const amazon = tidyText(first(ids.amazon)).toUpperCase();
			if (/^B[A-Z0-9]{9}$/.test(amazon)) ed.ext[ExternalCatalog.AMAZON_SITE] = amazon;
			const isbn = [first(edition.isbn_13), first(edition.isbn_10)].map(Isbn.parse).find(Boolean);
			if (isbn) ed.isbn = isbn;
			const publisher = tidyText(first(edition.publishers));
			if (publisher) ed.p = publisher;
			const released = BookSource.date(edition.publish_date);
			if (released) ed.d = released;
			const narrators = (Array.isArray(edition.contributors) ? edition.contributors : [])
				.filter((c: unknown) => Text.isObject(c) && /narrat|read/i.test(tidyText(c.role)))
				.map((c: Unchecked) => tidyText(c.name))
				.filter(Boolean);
			if (narrators.length) ed.n = narrators;
			if (!Object.keys(ed.ext).length) delete ed.ext;
			if (Object.keys(ed).length) rec.e = [ed];
		}
		return Book.fromRecord(Book.fixSeriesTitle(rec));
	}

	/**
	 * A series as Open Library writes it on an edition ("Discworld (3)", "The Expanse ; 1", "Discworld -- 3")
	 * as {name, number}; null when there is none.
	 */
	static seriesOf(text: string): {name: string; number: string | null} | null {
		const value = Text.tidy(text);
		if (!value) return null;
		const m = /^(.*?)[\s,;:(#-]+(?:(?:book|vol(?:ume)?|no|number)\.?\s*)?#?\s*(\d+(?:\.\d+)?)\)?$/i.exec(value);
		if (m && Text.tidy(m[1])) return {name: Text.tidy(m[1]), number: m[2]};
		return {name: value, number: null};
	}
}
