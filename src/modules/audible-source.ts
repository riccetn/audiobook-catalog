// Audible as a source of the Edit page's Fill in: its catalog API doesn't answer web pages, so it is asked
// through the user's own catalog proxy (server/proxy.ts), by an Audible or Amazon ASIN, on the site of the ASIN.
// A series' and an author's ASIN on a site are read off the products of their books there.
import {Series} from './series.js';
import {Text} from './text.js';
import {Isbn} from './isbn.js';
import {Book} from './book.js';
import {ExternalCatalog} from './external-catalog.js';
import {BookSource} from './book-source.js';
import type {Unchecked} from './text.js';
import type {Pasted, Answers, Hit, EntryQuery, EntryAnswer} from './book-source.js';

/** Looks books up in Audible's catalog, through the catalog proxy. */
export class AudibleSource extends BookSource {
	/** What Audible's catalog API is asked for a book: the people, series, edition details and genres. */
	static GROUPS =
		'contributors,media,product_attrs,product_desc,product_details,product_extended_attrs,series,category_ladders';
	static CATALOG = ExternalCatalog.AUDIBLE_SITE;
	static LABEL = 'Audible';
	static NAMES = ['Audible', 'Amazon'];
	static NEEDS = 'proxy' as const;
	static FILLS_IN = true;
	static SEARCHES = true;
	static ENTRIES = ['series', 'author'] as const;
	/** How many products a title search lists at most (Audible's own limit is 50). */
	static SEARCH_RESULTS = 50;
	/** How many of the books' ASINs on a site are asked about, in one request. */
	static ENTRY_BOOKS = 20;

	/**
	 * A bare ASIN, as audible.com's (Fill in takes a bare one).
	 */
	static read(value: string): Pasted | null {
		return /^B0[A-Z0-9]{8}$/i.test(value)
			? {catalog: ExternalCatalog.AUDIBLE_SITE, kind: 'edition', id: value.toUpperCase()}
			: null;
	}

	/**
	 * Any Audible site's ASIN is its own. An Amazon site's isn't: an ASIN is one site's, and Goodreads' and
	 * Hardcover's are mostly Kindle or print editions', which no Audible site sells.
	 */
	answers(pasted: Pasted): Answers {
		return AudibleSource.isSite(pasted.catalog) ? 'own' : null;
	}

	/**
	 * The book of an ASIN on its site's Audible; null when that site doesn't sell it.
	 */
	async lookup(pasted: Pasted): Promise<Book | null> {
		const book = await this.product(pasted.catalog, pasted.id);
		// the title is the site's, the one this edition was released under there: the Edit page keeps it on the
		// edition when the book has another
		if (book && book.editions[0]) book.editions[0].title = book.title;
		return book;
	}

	/**
	 * The products audible.com's catalog lists for a title (as a bare ASIN is read as audible.com's), each an
	 * edition, with its authors; a product without a title is one the site doesn't sell.
	 */
	async titled(title: string): Promise<Hit[]> {
		const site = ExternalCatalog.AUDIBLE_SITE;
		const params = new URLSearchParams({
			title,
			num_results: String(AudibleSource.SEARCH_RESULTS),
			products_sort_by: 'Relevance',
			response_groups: 'contributors,product_desc',
		});
		const answer = await this.proxied(`audible/${site}/catalog/products?${params}`);
		const products: unknown[] = answer && Array.isArray(answer.products) ? answer.products : [];
		return products
			.filter(
				(p): p is Unchecked =>
					Text.isObject(p) && typeof p.asin === 'string' && Boolean(BookSource.text(p.title)),
			)
			.map(p => ({
				catalog: site,
				kind: 'edition' as const,
				id: p.asin.toUpperCase(),
				title: BookSource.text(p.title),
				authors: (Array.isArray(p.authors) ? p.authors : [])
					.map((a: unknown) => (Text.isObject(a) ? BookSource.text(a.name) : ''))
					.filter(Boolean),
			}));
	}

	/** Whether `key` is an Audible site's (`audible.de`), whose catalog API answers for its ASINs; an Amazon site's isn't. */
	static isSite(key: string): boolean {
		return ExternalCatalog.get(key)?.group === 'audible';
	}

	/**
	 * A book with its edition from Audible's catalog API on `site`; null when the site doesn't sell it (Audible
	 * answers that with a product of only its ASIN).
	 */
	async product(site: string, asin: string): Promise<Book | null> {
		const answer = await this.proxied(
			`audible/${site}/catalog/products/${encodeURIComponent(asin)}?response_groups=${AudibleSource.GROUPS}`,
		);
		const product = answer && Text.isObject(answer.product) ? answer.product : null;
		return product && typeof product.title === 'string' && Text.tidy(product.title)
			? AudibleSource.book(product, site)
			: null;
	}

	/**
	 * A book made of an Audible product: title, authors, its numbered series (not an umbrella one without a
	 * number; with `seriesAsin`, that series and its number there, when the product lists it), genres (the second step of each of its genre ladders: "Fantasy" under "Science Fiction & Fantasy"),
	 * and the edition: its ASIN on `site`, ISBN, narrators, publisher, release date and length.
	 */
	static book(product: Unchecked, site: string, seriesAsin: string = ''): Book {
		const text: (x: unknown) => string = x => (typeof x === 'string' ? Text.tidy(x.replace(/&amp;/g, '&')) : '');
		const names: (x: unknown) => string[] = x =>
			Array.isArray(x) ? [...new Set(x.map(p => (Text.isObject(p) ? text(p.name) : '')).filter(Boolean))] : [];
		const rec: Record<string, any> = {t: text(product.title), a: names(product.authors)};
		const series = (Array.isArray(product.series) ? product.series : []).filter(
			(s: unknown) => Text.isObject(s) && text(s.title),
		);
		const numbered = series.find((s: Unchecked) => Series.NUMBER.test(text(s.sequence)));
		const asked = seriesAsin ? series.find((s: Unchecked) => s.asin === seriesAsin) : undefined;
		const inSeries = asked || numbered || (series.length === 1 ? series[0] : null);
		if (inSeries) {
			rec.s = text(inSeries.title);
			if (Series.NUMBER.test(text(inSeries.sequence))) rec.sn = text(inSeries.sequence);
		}
		const genres = (Array.isArray(product.category_ladders) ? product.category_ladders : [])
			.filter((l: unknown) => Text.isObject(l) && l.root === 'Genres' && Array.isArray(l.ladder))
			.map((l: Unchecked) => {
				const step = l.ladder[1] || l.ladder[0];
				return Text.isObject(step) ? text(step.name) : '';
			})
			.filter(Boolean);
		if (genres.length) rec.g = [...new Set(genres)].slice(0, 3);
		const ed: Record<string, any> = {ext: {[site]: text(product.asin).toUpperCase()}};
		const isbn = Isbn.parse(product.isbn);
		if (isbn) ed.isbn = isbn;
		const narrators = names(product.narrators);
		if (narrators.length) ed.n = narrators;
		if (text(product.publisher_name)) ed.p = [text(product.publisher_name)];
		const released = BookSource.date(product.release_date);
		if (released) ed.d = released;
		if (Number.isInteger(product.runtime_length_min) && product.runtime_length_min > 0)
			ed.len = product.runtime_length_min;
		rec.e = [ed];
		return Book.fromRecord(Book.fixSeriesTitle(rec));
	}

	// ------------------------------------------------------------------ series and authors
	/**
	 * A series' or an author's ASIN on each Audible site its books have editions on, read off those editions'
	 * products there, which name their series and authors. Audible has no search by name a page could ask, and
	 * says nothing more of a series or author than its books do, so there is nothing to find without them.
	 */
	async findEntries({kind, name, books}: EntryQuery): Promise<EntryAnswer[]> {
		const bySite: Map<string, Set<string>> = new Map();
		for (const b of books)
			for (const ed of b.editions)
				for (const [site, asin] of Object.entries(ed.external))
					if (AudibleSource.isSite(site)) bySite.set(site, (bySite.get(site) || new Set()).add(asin));
		const found: EntryAnswer[] = [];
		for (const [site, asins] of bySite) {
			const list = [...asins].slice(0, AudibleSource.ENTRY_BOOKS).map(encodeURIComponent).join(',');
			const answer = await this.proxied(
				`audible/${site}/catalog/products?asins=${list}&response_groups=series,contributors,product_desc`,
			);
			const products: unknown[] = answer && Array.isArray(answer.products) ? answer.products : [];
			const named: unknown[] = products.flatMap(p =>
				Text.isObject(p) ? (kind === 'series' ? p.series : p.authors) || [] : [],
			);
			const ids = new Set(
				named
					.filter(
						x =>
							Text.isObject(x) &&
							typeof x.asin === 'string' &&
							BookSource.sameName(kind === 'series' ? x.title : x.name, name),
					)
					.map(x => ((x as Unchecked).asin as string).toUpperCase()),
			);
			if (ids.size === 1) found.push(this.answerOf(kind, [...ids][0], name, 'books', {}, null, site));
		}
		return found;
	}
}
