// Open Library as a source of the book form's Fill in: it answers any web page (open CORS, no key), by its
// works (OL…W), editions (OL…M) and ISBNs. It has no narrators, and seldom a series.
import {Text} from './text.js';
import {Isbn} from './isbn.js';
import {Book} from './book.js';
import {ExternalCatalog} from './external-catalog.js';
import {BookSource} from './book-source.js';
/** @import {Unchecked} from './text.js' */
/** @import {Pasted, Answers} from './book-source.js' */

const OPEN_LIBRARY = 'https://openlibrary.org';
const tidyText = BookSource.text;

/** Looks books up on Open Library. */
export class OpenLibrarySource extends BookSource {
	static CATALOG = 'openlibrary';
	static LABEL = 'Open Library';
	static NAMES = ['Open Library'];

	/**
	 * A bare Open Library id: OL…M an edition, OL…W a work.
	 * @param {string} value
	 * @returns {Pasted | null}
	 */
	static read(value) {
		if (/^OL\d+M$/i.test(value)) return {catalog: 'openlibrary', kind: 'edition', id: value.toUpperCase()};
		if (/^OL\d+W$/i.test(value)) return {catalog: 'openlibrary', kind: 'book', id: value.toUpperCase()};
		return null;
	}

	/**
	 * Its own works and editions, and ISBNs beside the others.
	 * @param {Pasted} pasted
	 * @returns {Answers}
	 */
	answers(pasted) {
		return pasted.kind === 'isbn' ? 'also' : super.answers(pasted);
	}

	/**
	 * @param {Pasted} pasted
	 * @returns {Promise<Book | null>}
	 */
	async lookup(pasted) {
		if (pasted.kind === 'isbn') return this.byIsbn(pasted.id);
		return pasted.kind === 'edition' ? this.edition(pasted.id) : this.work(pasted.id);
	}

	/**
	 * An Open Library answer, or null when it has no such page.
	 * @param {string} path
	 * @returns {Promise<Unchecked | null>}
	 */
	async ask(path) {
		return this.json(OPEN_LIBRARY + path);
	}

	/**
	 * The names of Open Library's authors, by their keys ("/authors/OL1A"); those it doesn't have are left out.
	 * @param {unknown[]} keys
	 * @returns {Promise<string[]>}
	 */
	async authors(keys) {
		const names = [];
		for (const key of keys.filter(k => typeof k === 'string' && /^\/authors\/OL\d+A$/.test(k)).slice(0, 10)) {
			const author = await this.ask(`${key}.json`);
			if (author && typeof author.name === 'string' && Text.tidy(author.name)) names.push(Text.tidy(author.name));
		}
		return [...new Set(names)];
	}

	/**
	 * A book from Open Library's work.
	 * @param {string} id OL…W
	 * @returns {Promise<Book>}
	 */
	async work(id) {
		const work = await this.ask(`/works/${id}.json`);
		if (!work) throw new Error(`Open Library has no work ${id}`);
		const authors = await this.authors(
			(Array.isArray(work.authors) ? work.authors : []).map((/** @type {unknown} */ a) =>
				Text.isObject(a) && Text.isObject(a.author) ? a.author.key : null,
			),
		);
		return OpenLibrarySource.book(work, null, authors);
	}

	/**
	 * A book with its edition from Open Library's edition (and its work, for the authors when the edition
	 * names none).
	 * @param {string} id OL…M
	 * @returns {Promise<Book>}
	 */
	async edition(id) {
		const edition = await this.ask(`/books/${id}.json`);
		if (!edition) throw new Error(`Open Library has no edition ${id}`);
		return this.bookOf(edition);
	}

	/**
	 * The book of the edition with this ISBN on Open Library; null when it has none.
	 * @param {string} isbn
	 * @returns {Promise<Book | null>}
	 */
	async byIsbn(isbn) {
		const edition = await this.ask(`/isbn/${isbn}.json`);
		return edition ? this.bookOf(edition) : null;
	}

	/**
	 * @param {Unchecked} edition an Open Library edition
	 * @returns {Promise<Book>}
	 */
	async bookOf(edition) {
		const workKey =
			Array.isArray(edition.works) && Text.isObject(edition.works[0]) && typeof edition.works[0].key === 'string'
				? edition.works[0].key
				: null;
		const work = workKey && /^\/works\/OL\d+W$/.test(workKey) ? await this.ask(`${workKey}.json`) : null;
		const of = (/** @type {Unchecked | null} */ x) =>
			x && Array.isArray(x.authors)
				? x.authors.map((/** @type {unknown} */ a) =>
						Text.isObject(a) ? (Text.isObject(a.author) ? a.author.key : a.key) : null,
					)
				: [];
		const editionAuthors = of(edition);
		const authors = await this.authors(editionAuthors.length ? editionAuthors : of(work));
		return OpenLibrarySource.book(work || {}, edition, authors);
	}

	/**
	 * A book made of an Open Library work and edition (either may be all but empty) and its authors' names.
	 * @param {Unchecked} work
	 * @param {Unchecked | null} edition
	 * @param {string[]} authors
	 * @returns {Book}
	 */
	static book(work, edition, authors) {
		/** @type {(x: unknown, re: RegExp) => string | null} */
		const idOf = (x, re) => {
			const m = re.exec(tidyText(x));
			return m ? m[1] : null;
		};
		/** @type {(x: unknown) => unknown} */
		const first = x => (Array.isArray(x) ? x[0] : undefined);
		/** @type {Record<string, any>} */
		const rec = {t: tidyText(work.title) || (edition ? tidyText(edition.title) : ''), a: authors};
		const workId = idOf(work.key, /^\/works\/(OL\d+W)$/);
		if (workId) rec.ext = {openlibrary: workId};
		if (edition) {
			const series = OpenLibrarySource.seriesOf(tidyText(first(edition.series)));
			if (series) {
				rec.s = series.name;
				if (series.number) rec.sn = series.number;
			}
			/** @type {Record<string, any>} */
			const ed = {ext: {}};
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
				.filter((/** @type {unknown} */ c) => Text.isObject(c) && /narrat|read/i.test(tidyText(c.role)))
				.map((/** @type {Unchecked} */ c) => tidyText(c.name))
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
	 * @param {string} text
	 * @returns {{name: string, number: string | null} | null}
	 */
	static seriesOf(text) {
		const value = Text.tidy(text);
		if (!value) return null;
		const m = /^(.*?)[\s,;:(#-]+(?:(?:book|vol(?:ume)?|no|number)\.?\s*)?#?\s*(\d+(?:\.\d+)?)\)?$/i.exec(value);
		if (m && Text.tidy(m[1])) return {name: Text.tidy(m[1]), number: m[2]};
		return {name: value, number: null};
	}
}
