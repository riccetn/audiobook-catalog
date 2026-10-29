// Audible as a source of the book form's Fill in: its catalog API doesn't answer web pages, so it is asked
// through the user's own catalog proxy (server/proxy.ts), by an Audible or Amazon ASIN, on the site of the ASIN.
import {Text} from './text.js';
import {Isbn} from './isbn.js';
import {Book} from './book.js';
import {ExternalCatalog} from './external-catalog.js';
import {BookSource} from './book-source.js';
import type {Unchecked} from './text.js';
import type {Pasted, Answers} from './book-source.js';

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

	/**
	 * A bare ASIN, as audible.com's (the book form takes a bare one).
	 */
	static read(value: string): Pasted | null {
		return /^B0[A-Z0-9]{8}$/i.test(value)
			? {catalog: ExternalCatalog.AUDIBLE_SITE, kind: 'edition', id: value.toUpperCase()}
			: null;
	}

	/**
	 * Any Audible or Amazon site's ASIN is its own.
	 */
	answers(pasted: Pasted): Answers {
		return ExternalCatalog.family(pasted.catalog) === 'asin' ? 'own' : null;
	}

	/**
	 * The book of an ASIN on its site's Audible; null when that site doesn't sell it.
	 */
	async lookup(pasted: Pasted): Promise<Book | null> {
		const book = await this.product(AudibleSource.site(pasted.catalog), pasted.id);
		// the title is the site's, the one this edition was released under there: the book form keeps it on the
		// edition when the book has another
		if (book && book.editions[0]) book.editions[0].title = book.title;
		return book;
	}

	/**
	 * The Audible site whose catalog API answers for an ASIN of `key`: the site itself, an Amazon site's Audible
	 * (amazon.de: audible.de), else audible.com.
	 */
	static site(key: string): string {
		const site = key.replace(/^amazon\./, 'audible.');
		return ExternalCatalog.get(site)?.group === 'audible' ? site : ExternalCatalog.AUDIBLE_SITE;
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
		const numbered = series.find((s: Unchecked) => /^\d+(?:\.\d+)?(?:-\d+(?:\.\d+)?)?$/.test(text(s.sequence)));
		const asked = seriesAsin ? series.find((s: Unchecked) => s.asin === seriesAsin) : undefined;
		const inSeries = asked || numbered || (series.length === 1 ? series[0] : null);
		if (inSeries) {
			rec.s = text(inSeries.title);
			if (/^\d+(?:\.\d+)?(?:-\d+(?:\.\d+)?)?$/.test(text(inSeries.sequence))) rec.sn = text(inSeries.sequence);
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
		if (text(product.publisher_name)) ed.p = text(product.publisher_name);
		const released = BookSource.date(product.release_date);
		if (released) ed.d = released;
		if (Number.isInteger(product.runtime_length_min) && product.runtime_length_min > 0)
			ed.len = product.runtime_length_min;
		rec.e = [ed];
		return Book.fromRecord(Book.fixSeriesTitle(rec));
	}
}
