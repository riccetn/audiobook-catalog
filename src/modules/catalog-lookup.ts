// A book looked up in the external catalogs a web page may read, to fill in a book on the Edit page. Each catalog is a
// BookSource (CatalogConnectors.SOURCES); this asks them in turn, by what was pasted: the catalog whose id it
// is, the others that know such an id (an ISBN, an ASIN), and then those that fill in what the rest lack
// (narrators, length) by the edition found. What each needs (a token, the catalog proxy) the sources say, so
// nothing here names a catalog. Nothing here changes the catalog; the requests are passed in, so the tests run
// it offline.
import {Text, PhraseError} from './text.js';
import type {Phrase, PhraseValue} from './text.js';
import {Isbn} from './isbn.js';
import {Book} from './book.js';
import {Edition} from './edition.js';
import {ExternalCatalog} from './external-catalog.js';
import type {BookSource} from './book-source.js';
import {CatalogConnectors} from './catalog-connectors.js';
import type {Get, Pasted, Found} from './book-source.js';
import type {CatalogClient} from './catalog-client.js';

/**
 * "A, B or C", as a Phrase whose items are its values.
 */
const listed = (items: PhraseValue[], last: 'and' | 'or'): PhraseValue => {
	if (items.length < 2) return items.length ? items[0] : '';
	const values: Record<string, PhraseValue> = {};
	items.forEach((item, i) => (values['i' + i] = item));
	const head = items
		.slice(0, -1)
		.map((_item, i) => `{i${i}}`)
		.join(', ');
	return Text.phrase(`${head} ${last} {i${items.length - 1}}`, values);
};

/** the different texts of `needs` (BookSource.needsText), once each */
const needed = (needs: (Phrase | null)[]): Phrase[] => {
	const out: Phrase[] = [];
	for (const n of needs) if (n && !out.some(x => Text.filled(x, false) === Text.filled(n, false))) out.push(n);
	return out;
};

/** What CatalogLookup.fill filled in: a field of the book, its id or ids in other catalogs, or an edition. */
export type Filled = 'title' | 'authors' | 'series' | 'number' | 'genres' | 'id' | 'ids' | 'edition';

/**
 * How CatalogLookup.fill fills a book in: `publishers`, the publishers' names the catalog has, which an
 * edition's publishers aren't split in; `answer`, whether the book is a lookup's answer (Found.book), whose
 * edition keeps the title it was sold under.
 */
export type FillOptions = {publishers?: Iterable<string>; answer?: boolean};

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
	get pastable(): PhraseValue {
		return listed([...new Set(this.sources.flatMap(s => s.kind.NAMES))], 'or');
	}

	/**
	 * The book `text` names, from the catalogs that have it: the one whose id it is (and those that know such an
	 * id too, or when it has none), then those that fill in what the first lacks, by the edition's ASIN or ISBN.
	 * What the first has wins; the others only fill in what it lacks. Throws with a short reason when `text`
	 * names nothing this can look up, or no catalog has it. Text that is no address, id or ISBN is a title,
	 * searched on the source that SEARCHES (by `authors` too, when the book has them).
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
			throw new PhraseError(
				searcher
					? 'paste the address of a book or edition on {catalogs}, or an ISBN, or type its title'
					: 'paste the address of a book or edition on {catalogs}, or an ISBN',
				{catalogs: this.pastable},
			);
		const found: Found = {book: new Book(), sources: [], notes: []};
		const asked: Set<BookSource> = new Set();
		const take: (source: BookSource, book: Book | null) => void = (source, book) => {
			if (!book) return;
			CatalogLookup.fill(found.book, book, {answer: true});
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
				found.notes.push(
					Text.phrase("{catalog} couldn't be asked: {error}", {
						catalog: source.label,
						error: Text.errorPhrase(err),
					}),
				);
			}
		};
		const answering = (how: 'own' | 'also' | 'fallback') =>
			this.sources.filter(s => s.answers(pasted as Pasted) === how);
		const candidates = [...answering('own'), ...answering('also'), ...answering('fallback')];
		const usable = candidates.filter(s => s.available);
		if (!candidates.length)
			throw new PhraseError(
				"{catalog} can't be read from a web page; paste an address on {catalogs}, or an ISBN",
				{
					catalog: ExternalCatalog.name(pasted.catalog),
					catalogs: this.pastable,
				},
			);
		if (!usable.length) throw new PhraseError(CatalogLookup.unavailable(candidates));
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
					? Text.phrase('with ISBN {id}', {id: pasted.id})
					: ExternalCatalog.family(pasted.catalog) === 'asin'
						? Text.phrase('with ASIN {id}', {id: pasted.id})
						: pasted.id;
			const unasked = candidates.filter(s => !s.available);
			// a template for each case: with what the others said, and with what to save to ask the rest
			throw new PhraseError(
				'no catalog has a book {where}' +
					(found.notes.length ? ' ({notes})' : '') +
					(unasked.length ? ' (to ask {unasked} too, {needs} on the Import & export page)' : ''),
				{
					where,
					notes: Text.joinPhrases(found.notes),
					unasked: listed(
						unasked.map(s => s.label),
						'and',
					),
					needs: listed(needed(unasked.map(s => s.needsText)), 'and'),
				},
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
					Text.phrase(
						'to fill in narrators and length from {catalog} too, {needs} on the Import & export page',
						{
							catalog: source.label,
							needs: source.needsText || '',
						},
					),
				);
		}
		return found;
	}

	/**
	 * Why none of `sources` can be asked (each needs what isn't saved), and what to save.
	 */
	static unavailable(sources: BookSource[]): Phrase {
		const proxied = sources.filter(s => s.kind.NEEDS === 'proxy').map(s => s.label);
		const keyed = sources.filter(s => s.kind.NEEDS !== 'proxy');
		const values = {
			proxied: listed(proxied, 'and'),
			keyed: listed(
				keyed.map(s => s.label),
				'or',
			),
			needs: listed(needed(keyed.map(s => s.needsText)), 'or'),
		};
		// a whole template for each case
		if (!keyed.length)
			return Text.phrase(
				proxied.length > 1
					? "{proxied} can't be read from a web page; to ask them through a server of your own, save your server on the Import & export page first"
					: "{proxied} can't be read from a web page; to ask it through a server of your own, save your server on the Import & export page first",
				values,
			);
		return Text.phrase(
			proxied.length
				? "{proxied} can't be read from a web page; to look it up on {keyed}, {needs} on the Import & export page first, or save your server there to ask {proxied}"
				: 'to look it up on {keyed}, {needs} on the Import & export page first',
			values,
		);
	}

	/**
	 * What an edition can be looked up by elsewhere: its ASIN (an Audible site's first), under its own site, then
	 * its ISBN. An Amazon site's ASIN stays that site's, so Audible isn't asked about it.
	 */
	static editionIds(ed: Edition): Pasted[] {
		const ids: Pasted[] = [];
		const keys = Object.keys(ed.external).filter(key => ExternalCatalog.family(key) === 'asin');
		const site = keys.find(key => ExternalCatalog.groupOf(key)?.key === 'audible') || keys[0];
		if (site) ids.push({catalog: site, kind: 'edition', id: ed.external[site]});
		const isbn = ed.isbns()[0];
		if (isbn) ids.push({catalog: 'isbn', kind: 'isbn', id: isbn});
		return ids;
	}

	/**
	 * Fill `book` in (in place) from `from`, gaps only: its title, authors, series, number (only with its own
	 * series) and genres where it has none, and ids in catalogs it has none in; and `from`'s first edition
	 * (CatalogLookup.fillEdition). Returns what was filled in.
	 */
	static fill(book: Book, from: Book, opts: FillOptions = {}): Filled[] {
		const filled: Filled[] = [];
		if (!book.title && from.title) {
			book.title = from.title;
			filled.push('title');
		}
		if (!book.authors.length && from.authors.length) {
			book.authors = [...from.authors];
			filled.push('authors');
		}
		if (!book.series && from.series) {
			book.series = from.series;
			filled.push('series');
		}
		if (book.series === from.series && !book.number && from.number) {
			book.number = from.number;
			filled.push('number');
		}
		if (!book.genres.length && from.genres.length) {
			book.genres = [...from.genres];
			filled.push('genres');
		}
		const ids = Object.entries(from.external).filter(([key]) => !book.external[key]);
		if (ids.length) {
			book.external = {...book.external, ...Object.fromEntries(ids)};
			filled.push(ids.length === 1 ? 'id' : 'ids');
		}
		const [ed] = from.editions;
		if (ed && CatalogLookup.fillEdition(book, ed, opts)) filled.push('edition');
		return filled;
	}

	/**
	 * Put an edition in a book (in place): in the gaps of the edition that is the same (it shares an id with it,
	 * an ASIN on any site, or its ISBN), else of the first one whose fields it fills without changing any, else
	 * as an edition of its own. Returns whether anything was filled in.
	 */
	static fillEdition(book: Book, ed: Edition, opts: FillOptions = {}): boolean {
		const fields = ed.fields();
		// the title it was released under is no title of its own when it is the book's (but an answer keeps it,
		// for the book it fills in, which may have another)
		if (!opts.answer && fields.t && Book.sameTitle(fields.t, book.title)) delete fields.t;
		const has = (card: Record<string, string>, k: string) => Text.tidy(card[k] || '');
		const at = [
			book.editions.findIndex(x => x.sharesId(ed)),
			book.editions.findIndex(x => x.sameAs(ed)),
			book.editions.findIndex(x => {
				const mine = x.fields();
				return Object.entries(fields).every(([k, v]) => !has(mine, k) || has(mine, k) === Text.tidy(v));
			}),
		].find(j => j >= 0);
		const mine = at === undefined ? {} : book.editions[at].fields();
		let gained = false;
		for (const [k, v] of Object.entries(fields))
			if (v && !has(mine, k)) {
				mine[k] = v;
				gained = true;
			}
		if (!gained) return false;
		// the publishers either edition names stay whole, as the catalog's do
		const known = [...(opts.publishers || []), ...ed.publishers, ...book.editions.flatMap(x => x.publishers)];
		const [first, ...more] = Edition.fromFields(mine, known).editions;
		if (!first) return false;
		if (at === undefined) {
			book.editions = [...book.editions, first, ...more];
			return true;
		}
		first.id = book.editions[at].id;
		book.editions = [...book.editions.slice(0, at), first, ...more, ...book.editions.slice(at + 1)];
		return true;
	}
}
