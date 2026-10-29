// A book looked up in the external catalogs a web page may read, to fill in the book form. Each catalog is a
// BookSource (CatalogConnectors.SOURCES); this asks them in turn, by what was pasted: the catalog whose id it
// is, the others that know such an id (an ISBN, an ASIN), and then those that fill in what the rest lack
// (narrators, length) by the edition found. What each needs (a token, the catalog proxy) the sources say, so
// nothing here names a catalog. Nothing here changes the catalog; the requests are passed in, so the tests run
// it offline.
import {Text} from './text.js';
import {Isbn} from './isbn.js';
import {Book} from './book.js';
import {Edition} from './edition.js';
import {ExternalCatalog} from './external-catalog.js';
import type {BookSource} from './book-source.js';
import {CatalogConnectors} from './catalog-connectors.js';
import type {Get, Pasted, Found} from './book-source.js';
import type {CatalogClient} from './catalog-client.js';

const ON_THE_PAGE = 'on the Import & export page';

/**
 * "A, B or C".
 */
const listed = (items: string[], last: string): string =>
	items.length > 1 ? `${items.slice(0, -1).join(', ')} ${last} ${items[items.length - 1]}` : items.join('');

/** Looks books up in the external catalogs a page may read. */
export class CatalogLookup {
	sources: BookSource[];

	/**
	 * @param get asks the catalogs that answer web pages (Open Library, Wikidata)
	 * @param clients ask the catalogs whose key is saved (Hardcover with your token)
	 * @param proxy asks through the catalog proxy, given a route (`audible/audible.com/catalog/products/B0…`,
	 *   `audiobookdb/releases/…`), or null when none is saved
	 * @param sources the catalogs asked, in order
	 */
	constructor(
		get: Get,
		clients: CatalogClient[],
		proxy: Get | null = null,
		sources: (typeof BookSource)[] = CatalogConnectors.SOURCES,
	) {
		const context = {get, clients, proxy};
		this.sources = sources.map(Source => new Source(context));
	}

	/**
	 * What a pasted address or id names: an ISBN; an address of a book's or edition's page in an external
	 * catalog (also one only its catalog reads, such as a Hardcover book's page by its name); a bare id a
	 * source reads (OL…W, Q…, an ASIN). null when it is none of them.
	 */
	static read(text: unknown, sources: (typeof BookSource)[] = CatalogConnectors.SOURCES): Pasted | null {
		const value = Text.tidy(String(text || ''));
		if (!value) return null;
		const isbn = Isbn.parse(value.replace(/^isbn(?:-1[03])?:?\s*/i, ''));
		if (isbn) return {catalog: 'isbn', kind: 'isbn', id: isbn};
		for (const Source of sources) {
			const pasted = Source.read(value);
			if (pasted) return pasted;
		}
		for (const kind of ['edition', 'book'] as const) {
			const found = ExternalCatalog.fromAddress(value, kind);
			if (found) return {...found, kind};
		}
		return null;
	}

	/** @returns the catalogs whose addresses can be pasted: "Open Library, Wikidata or Audible" */
	get pastable(): string {
		return listed([...new Set(this.sources.flatMap(s => s.kind.NAMES))], 'or');
	}

	/**
	 * The book `text` names, from the catalogs that have it: the one whose id it is (and those that know such an
	 * id too, or when it has none), then those that fill in what the first lacks, by the edition's ASIN or ISBN.
	 * What the first has wins; the others only fill in what it lacks. Throws with a short reason when `text`
	 * names nothing this can look up, or no catalog has it. Text that is no address, id or ISBN is a title,
	 * searched on the source that SEARCHES (by `authors` too, when the form has them).
	 */
	async find(text: unknown, authors: string[] = []): Promise<Found> {
		const typed = Text.tidy(String(text || ''));
		let pasted = CatalogLookup.read(
			typed,
			this.sources.map(s => s.kind),
		);
		const searcher = this.sources.find(s => s.kind.SEARCHES && s.available);
		if (!pasted && searcher && typed.length >= 3)
			pasted = {catalog: searcher.kind.CATALOG, kind: 'book', id: await searcher.search(typed, authors)};
		if (!pasted)
			throw new Error(
				`paste the address of a book or edition on ${this.pastable}, or an ISBN${searcher ? ', or type its title' : ''}`,
			);
		const found: Found = {book: new Book(), sources: [], notes: []};
		const asked: Set<BookSource> = new Set();
		const take: (source: BookSource, book: Book | null) => void = (source, book) => {
			if (!book) return;
			CatalogLookup.fill(found.book, book);
			if (!found.sources.includes(source.label)) found.sources.push(source.label);
		};
		const ask: (source: BookSource, what: Pasted, noted: boolean) => Promise<void> = async (
			source,
			what,
			noted,
		) => {
			asked.add(source);
			if (!noted) {
				take(source, await source.lookup(what, found));
				return;
			}
			try {
				take(source, await source.lookup(what, found));
			} catch (err) {
				found.notes.push(`${source.label} couldn't be asked: ${Text.errorText(err)}`);
			}
		};
		const answering = (how: 'own' | 'also' | 'fallback') =>
			this.sources.filter(s => s.answers(pasted as Pasted) === how);
		const candidates = [...answering('own'), ...answering('also'), ...answering('fallback')];
		const usable = candidates.filter(s => s.available);
		if (!candidates.length)
			throw new Error(
				`${ExternalCatalog.name(pasted.catalog)} can't be read from a web page; paste an address on ${this.pastable}, or an ISBN`,
			);
		if (!usable.length) throw new Error(CatalogLookup.unavailable(candidates));
		// a catalog asked beside others doesn't stop the lookup when it can't be asked
		const noted = usable.length > 1;
		for (const source of usable.filter(s => s.answers(pasted as Pasted) !== 'fallback'))
			await ask(source, pasted, noted);
		for (const source of usable.filter(s => s.answers(pasted as Pasted) === 'fallback'))
			if (!found.sources.length) await ask(source, pasted, noted);
		// the id pasted stays, on the book or its edition
		if (pasted.kind === 'book' && pasted.id && !found.book.external[pasted.catalog])
			found.book.external[pasted.catalog] = pasted.id;
		if (!found.sources.length) {
			const where =
				pasted.kind === 'isbn'
					? `with ISBN ${pasted.id}`
					: ExternalCatalog.family(pasted.catalog) === 'asin'
						? `with ASIN ${pasted.id}`
						: pasted.id;
			const unasked = candidates.filter(s => !s.available);
			throw new Error(
				`no catalog has a book ${where}${found.notes.length ? ` (${found.notes.join('; ')})` : ''}` +
					(unasked.length
						? ` (to ask ${listed(
								unasked.map(s => s.label),
								'and',
							)} too, ${listed([...new Set(unasked.map(s => s.needsText))], 'and')} ${ON_THE_PAGE})`
						: ''),
			);
		}
		if (pasted.kind === 'edition') {
			if (!found.book.editions.length) found.book.editions = [new Edition()];
			const [ed] = found.book.editions;
			if (!ed.external[pasted.catalog])
				ed.external = ExternalCatalog.order({[pasted.catalog]: pasted.id, ...ed.external}) || {};
		}
		// those that know narrators and length, for what the others lack, by the edition's ASIN or ISBN
		const ed = found.book.editions[0];
		if (!ed) return found;
		for (const source of this.sources.filter(
			s => s.kind.FILLS_IN && !asked.has(s) && !found.sources.includes(s.label),
		)) {
			const what = CatalogLookup.editionIds(ed).find(x => source.answers(x));
			if (!what) continue;
			if (source.available) await ask(source, what, true);
			// a key is saved in a moment; a server is set up once, and so not asked for each book
			else if (source.kind.NEEDS === 'key' && (!ed.narrators.length || !ed.minutes))
				found.notes.push(
					`to fill in narrators and length from ${source.label} too, ${source.needsText} ${ON_THE_PAGE}`,
				);
		}
		return found;
	}

	/**
	 * Why none of `sources` can be asked (each needs what isn't saved), and what to save.
	 */
	static unavailable(sources: BookSource[]): string {
		const proxied = sources.filter(s => s.kind.NEEDS === 'proxy').map(s => s.label);
		const keyed = sources.filter(s => s.kind.NEEDS !== 'proxy');
		const proxy = `${listed(proxied, 'and')} can't be read from a web page; `;
		if (!keyed.length)
			return `${proxy}to ask ${proxied.length > 1 ? 'them' : 'it'} through a server of your own, save your server ${ON_THE_PAGE} first`;
		const ask = `to look it up on ${listed(
			keyed.map(s => s.label),
			'or',
		)}, ${listed([...new Set(keyed.map(s => s.needsText))], 'or')} ${ON_THE_PAGE} first`;
		return proxied.length ? `${proxy}${ask}, or save your server there to ask ${listed(proxied, 'and')}` : ask;
	}

	/**
	 * What an edition can be looked up by elsewhere: its ASIN (an Audible site's first, under that site), then its ISBN.
	 */
	static editionIds(ed: Edition): Pasted[] {
		const ids: Pasted[] = [];
		const audible = Object.keys(ed.external).find(key => ExternalCatalog.groupOf(key)?.key === 'audible');
		const asin = audible ? ed.external[audible] : ed.ids('asin')[0];
		if (asin) ids.push({catalog: audible || ExternalCatalog.AUDIBLE_SITE, kind: 'edition', id: asin});
		const isbn = ed.isbns()[0];
		if (isbn) ids.push({catalog: 'isbn', kind: 'isbn', id: isbn});
		return ids;
	}

	/**
	 * Fill `book` in (in place) from `from`: its title, authors, series and number,
	 * genres where it has none; ids in catalogs it has none in; the edition where it has none, else the
	 * edition's gaps when the two don't disagree.
	 */
	static fill(book: Book, from: Book) {
		if (!book.title) book.title = from.title;
		if (!book.authors.length) book.authors = [...from.authors];
		if (!book.series && from.series) {
			book.series = from.series;
			if (from.number) book.number = from.number;
		} else if (book.series && !book.number && from.number && from.series === book.series) book.number = from.number;
		if (!book.genres.length) book.genres = [...from.genres];
		for (const [key, id] of Object.entries(from.external)) if (!book.external[key]) book.external[key] = id;
		const [ed] = from.editions;
		if (!ed) return;
		if (!book.editions.length) book.editions = [ed];
		else if (!book.editions[0].conflictsWith(ed)) book.editions[0].fillFrom(ed);
	}
}
