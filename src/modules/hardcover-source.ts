// Hardcover as a source of the book form's Fill in: its API answers web pages, with the token saved in this
// browser. Besides its own books and editions, it knows the ASINs, ISBNs and Goodreads editions of its
// editions, which is how Amazon's and Goodreads' ids are looked up, as those can't be read from a web page.
import {Text} from './text.js';
import {Book} from './book.js';
import {ExternalCatalog} from './external-catalog.js';
import {BookSource} from './book-source.js';
import {HardcoverClient} from './hardcover-client.js';
import {HardcoverSync} from './hardcover-sync.js';
import type {Unchecked} from './text.js';
import type {Pasted, Answers} from './book-source.js';

/** Looks books up on Hardcover, with your token. */
export class HardcoverSource extends BookSource {
	static CATALOG = 'hardcover';
	static LABEL = 'Hardcover';
	static NAMES = ['Hardcover', 'Goodreads'];
	static NEEDS = 'key' as const;
	static CLIENT = HardcoverClient;
	static FILLS_IN = true;

	/**
	 * A Hardcover address: a book's or edition's, or a book's page by its name (`slug`), whose id only Hardcover knows.
	 */
	static read(value: string): Pasted | null {
		const url = HardcoverClient.parseUrl(value);
		if (!url) return null;
		if (url.edition) return {catalog: 'hardcover', kind: 'edition', id: url.edition};
		if (url.book) return {catalog: 'hardcover', kind: 'book', id: url.book};
		return {catalog: 'hardcover', kind: 'book', id: '', slug: url.slug};
	}

	/**
	 * Its own books and editions; ISBNs and Goodreads ids beside the others; an ASIN when neither Audible nor
	 * AudiobookDB has it.
	 */
	answers(pasted: Pasted): Answers {
		if (pasted.kind === 'isbn' || pasted.catalog === 'goodreads') return 'also';
		if (ExternalCatalog.family(pasted.catalog) === 'asin') return 'fallback';
		return super.answers(pasted);
	}

	/** @returns its client (lookup() is only asked when it has one) */
	get hardcover(): HardcoverClient {
		return this.client as HardcoverClient;
	}

	async lookup(pasted: Pasted): Promise<Book | null> {
		if (pasted.kind === 'isbn') return this.by('isbn', pasted.id);
		if (pasted.catalog === 'goodreads') {
			if (pasted.kind === 'book')
				throw new Error(
					"Hardcover knows Goodreads editions (goodreads.com/book/show/…), not their works; paste the edition's address",
				);
			return this.by('gr', pasted.id);
		}
		if (pasted.catalog !== HardcoverSource.CATALOG) return this.by('asin', pasted.id);
		if (pasted.kind === 'edition') {
			const book = await this.book(null, pasted.id);
			if (!book) throw new Error(`Hardcover has no edition ${pasted.id}`);
			return book;
		}
		const id = pasted.id || (await HardcoverClient.bookId(this.hardcover, `hardcover.app/books/${pasted.slug}`)).id;
		const book = await this.book(id, null);
		if (!book) throw new Error(`Hardcover has no book ${id}`);
		return book;
	}

	/**
	 * A book from Hardcover by an edition's ASIN, ISBN or Goodreads id; null when Hardcover has none.
	 */
	async by(kind: 'asin' | 'isbn' | 'gr', id: string): Promise<Book | null> {
		const hit = (await this.hardcover.find({[kind]: [id]}, () => {}))[kind].get(id);
		return hit ? this.book(hit.hcb, hit.hc) : null;
	}

	/**
	 * A book from Hardcover: the book (by its id, or the edition's) with the edition, or with its audiobook
	 * edition when none is named; null when Hardcover has no such book or edition.
	 */
	async book(bookId: string | null, editionId: string | null): Promise<Book | null> {
		const client = this.hardcover;
		let edition: Unchecked | null = null;
		if (editionId) {
			const [row] =
				(await client.ask(HardcoverClient.QUERIES.editions, {ids: [Number(editionId)]})).editions || [];
			if (!Text.isObject(row)) return null;
			edition = row;
			if (!bookId && Number.isInteger(row.book_id)) bookId = String(row.book_id);
		}
		if (!bookId) return null;
		const [book] = (await client.ask(HardcoverClient.QUERIES.books, {ids: [Number(bookId)]})).books || [];
		if (!Text.isObject(book) || typeof book.title !== 'string') return null;
		if (!edition) {
			const [audio] =
				(await client.ask(HardcoverClient.QUERIES.audioEditions, {book: Number(bookId)})).editions || [];
			if (Text.isObject(audio)) edition = audio;
		}
		const rec = HardcoverSync.bookRecord(book);
		rec.ext = {hardcover: bookId};
		if (edition) rec.e = [HardcoverSync.edition(edition).toJSON()];
		return Book.fromRecord(Book.fixSeriesTitle(rec));
	}
}
