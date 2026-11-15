// Hardcover as a source of the Edit page's Fill in: its API answers web pages, with the token saved in this
// browser. Besides its own books and editions, it knows the ASINs, ISBNs and Goodreads editions of its
// editions, which is how Amazon's and Goodreads' ids are looked up, as those can't be read from a web page.
// Its series, authors (narrators are authors there) and publishers give their number, a series' count of books
// and whether it is complete, and an author's bio.
import {Text, PhraseError} from './text.js';
import {Book} from './book.js';
import {ExternalCatalog} from './external-catalog.js';
import {BookSource} from './book-source.js';
import {HardcoverClient} from './hardcover-client.js';
import {HardcoverSync} from './hardcover-sync.js';
import type {Unchecked} from './text.js';
import type {Pasted, Answers, EntryKind, EntryQuery, EntryAnswer} from './book-source.js';

/** How Hardcover is asked about a kind of series or person: what it says of some ids, those of a name, its table. */
const ENTRY_QUERIES: Record<EntryKind, {info: string; byName: string; table: string}> = {
	series: {info: HardcoverClient.QUERIES.seriesInfo, byName: HardcoverClient.QUERIES.seriesByName, table: 'series'},
	author: {info: HardcoverClient.QUERIES.authorInfo, byName: HardcoverClient.QUERIES.authorsByName, table: 'authors'},
	narrator: {
		info: HardcoverClient.QUERIES.authorInfo,
		byName: HardcoverClient.QUERIES.authorsByName,
		table: 'authors',
	},
	publisher: {
		info: HardcoverClient.QUERIES.publisherInfo,
		byName: HardcoverClient.QUERIES.publishersByName,
		table: 'publishers',
	},
};
/** a Hardcover id as text (a publisher's is a bigint, which may come as text); '' when it is none */
const numberOf = (x: unknown): string =>
	Number.isInteger(x) || (typeof x === 'string' && HardcoverClient.ID.test(x)) ? String(x) : '';

/** Looks books up on Hardcover, with your token. */
export class HardcoverSource extends BookSource {
	static CATALOG = 'hardcover';
	static LABEL = 'Hardcover';
	static NAMES = ['Hardcover', 'Goodreads'];
	static NEEDS = 'key' as const;
	static CLIENT = HardcoverClient;
	static FILLS_IN = true;
	static ENTRIES = ['series', 'author', 'narrator', 'publisher'] as const;

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
			if (!book) throw new PhraseError('Hardcover has no edition {id}', {id: pasted.id});
			return book;
		}
		const id = pasted.id || (await HardcoverClient.bookId(this.hardcover, `hardcover.app/books/${pasted.slug}`)).id;
		const book = await this.book(id, null);
		if (!book) throw new PhraseError('Hardcover has no book {id}', {id});
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

	// ------------------------------------------------------------------ series and people
	/**
	 * A series, author, narrator or publisher by its number, or by the name in its page's address (the id it is
	 * kept by while Hardcover couldn't be asked for the number).
	 */
	async entry(kind: EntryKind, id: string): Promise<EntryAnswer | null> {
		const number = HardcoverClient.ID.test(id)
			? id
			: (await HardcoverClient.idBySlug(this.hardcover, kind, id))?.id;
		const [found] = number ? await this.entries(kind, [number], 'id') : [];
		return found || null;
	}

	/**
	 * A series or author by the Hardcover books of its books, which name them; else those called `name` (Hardcover
	 * matches a name only as it is written), each with how many books it has there.
	 */
	async findEntries({kind, name, books}: EntryQuery): Promise<EntryAnswer[]> {
		const client = this.hardcover;
		const mine = [
			...new Set(books.map(b => b.external[HardcoverSource.CATALOG]).filter(id => /^\d+$/.test(id || ''))),
		];
		if (mine.length && (kind === 'series' || kind === 'author')) {
			const rows = (await client.ask(HardcoverClient.QUERIES.bookParts, {ids: mine.slice(0, 20).map(Number)}))
				.books;
			const parts: unknown[] = (Array.isArray(rows) ? rows : []).flatMap((row: unknown) =>
				!Text.isObject(row)
					? []
					: kind === 'series'
						? (Array.isArray(row.book_series) ? row.book_series : []).map((x: Unchecked) => x && x.series)
						: (Array.isArray(row.contributions) ? row.contributions : []).map(
								(x: Unchecked) => x && x.author,
							),
			);
			const ids = new Set(
				parts
					.filter(x => Text.isObject(x) && BookSource.sameName(x.name, name))
					.map(x => numberOf((x as Unchecked).id)),
			);
			ids.delete('');
			if (ids.size === 1) return this.entries(kind, [...ids], 'books');
		}
		const {byName, table} = ENTRY_QUERIES[kind];
		const named = (await client.ask(byName, {names: [name]}))[table];
		const ids = (Array.isArray(named) ? named : []).map((row: unknown) =>
			Text.isObject(row) ? numberOf(row.id) : '',
		);
		return this.entries(kind, [...new Set(ids.filter(Boolean))].slice(0, HardcoverSource.NAMESAKES), 'name');
	}

	/**
	 * What Hardcover says of the series, authors or publishers with these numbers; one merged into another is
	 * given as that one.
	 */
	async entries(kind: EntryKind, ids: string[], by: EntryAnswer['by']): Promise<EntryAnswer[]> {
		if (!ids.length) return [];
		const {info, table} = ENTRY_QUERIES[kind];
		// a publisher's bigint is sent as text
		const rows = (await this.hardcover.ask(info, {ids: kind === 'publisher' ? ids : ids.map(Number)}))[table];
		const found: EntryAnswer[] = [];
		for (const row of Array.isArray(rows) ? rows : []) {
			const id = Text.isObject(row) ? numberOf(row.canonical_id) || numberOf(row.id) : '';
			if (!id || found.some(x => x.id === id)) continue;
			const count = Number(kind === 'publisher' ? row.editions_count : row.books_count) || 0;
			const total = Number.isInteger(row.primary_books_count) ? row.primary_books_count : row.books_count;
			found.push(
				this.answerOf(
					kind,
					id,
					typeof row.name === 'string' ? row.name : '',
					by,
					kind === 'series'
						? {total, ...(row.is_completed === true ? {status: 'complete' as const} : {})}
						: {bio: row.bio},
					Text.counted(count, kind === 'publisher' ? 'edition' : 'book'),
				),
			);
		}
		return found;
	}
}
