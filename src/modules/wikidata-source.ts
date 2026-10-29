// Wikidata as a source of the book form's Fill in: it answers any web page (open CORS, no key), by its items
// (Q…), with a book's title, authors, series and genres, and its ids in other catalogs. It has no editions.
import {Text} from './text.js';
import {Book} from './book.js';
import {BookSource} from './book-source.js';
import type {Unchecked} from './text.js';
import type {Pasted} from './book-source.js';

const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';
// Wikidata's properties of a book: its title, authors, series (with the number as a qualifier), genres, and
// its ids in catalogs this app knows
const P = {
	title: 'P1476',
	author: 'P50',
	series: 'P179',
	number: 'P1545',
	genre: 'P136',
	openLibrary: 'P648',
	goodreadsWork: 'P8383',
	isfdbTitle: 'P1274',
};

/** Looks books up on Wikidata. */
export class WikidataSource extends BookSource {
	static CATALOG = 'wikidata';
	static LABEL = 'Wikidata';
	static NAMES = ['Wikidata'];

	/**
	 * A bare Wikidata item (Q…).
	 */
	static read(value: string): Pasted | null {
		return /^Q\d+$/i.test(value) ? {catalog: 'wikidata', kind: 'book', id: value.toUpperCase()} : null;
	}

	async lookup(pasted: Pasted): Promise<Book> {
		return this.item(pasted.id);
	}

	/**
	 * Wikidata's items, by id, with their labels (in English) and claims.
	 */
	async items(ids: string[], claims: boolean): Promise<Record<string, Unchecked>> {
		if (!ids.length) return {};
		const params = new URLSearchParams({
			action: 'wbgetentities',
			ids: ids.slice(0, 50).join('|'),
			props: claims ? 'labels|claims' : 'labels',
			languages: 'en',
			languagefallback: '1',
			format: 'json',
			origin: '*',
		});
		const answer = await this.json(`${WIKIDATA_API}?${params}`);
		return answer && Text.isObject(answer.entities) ? answer.entities : {};
	}

	/**
	 * A book from its Wikidata item: its title, authors, series and number, genres, and its ids in Open Library
	 * (a work), Goodreads (a work) and ISFDB (a title).
	 * @param id Q…
	 */
	async item(id: string): Promise<Book> {
		const item = (await this.items([id], true))[id];
		if (!Text.isObject(item) || 'missing' in item) throw new Error(`Wikidata has no item ${id}`);
		const claims = Text.isObject(item.claims) ? item.claims : {};
		const of: (prop: string) => Unchecked[] = prop =>
			Array.isArray(claims[prop])
				? claims[prop].filter((c: unknown) => Text.isObject(c) && c.rank !== 'deprecated')
				: [];
		const value: (claim: Unchecked) => unknown = claim =>
			Text.isObject(claim.mainsnak) && Text.isObject(claim.mainsnak.datavalue)
				? claim.mainsnak.datavalue.value
				: undefined;
		/** the items a property names */
		const items: (prop: string) => string[] = prop =>
			of(prop)
				.map(c => {
					const v = value(c);
					return Text.isObject(v) && typeof v.id === 'string' ? v.id : '';
				})
				.filter(Boolean);
		const string: (prop: string) => string = prop => {
			const v = of(prop)
				.map(value)
				.find(x => typeof x === 'string');
			return typeof v === 'string' ? Text.tidy(v) : '';
		};
		const authors = items(P.author),
			series = items(P.series),
			genres = items(P.genre).slice(0, 5);
		if (!authors.length) throw new Error(`Wikidata's ${id} names no author, so it is not a book`);
		const labels = await this.items([...new Set([...authors, ...series.slice(0, 1), ...genres])], false);
		const label: (x: string) => string = x => {
			const l = labels[x] && Text.isObject(labels[x].labels) ? labels[x].labels.en : null;
			return Text.isObject(l) && typeof l.value === 'string' ? Text.tidy(l.value) : '';
		};
		const own = Text.isObject(item.labels) && Text.isObject(item.labels.en) ? item.labels.en.value : '';
		const title = of(P.title)
			.map(value)
			.find(v => Text.isObject(v) && typeof v.text === 'string');
		const rec: Record<string, any> = {
			t: Text.tidy(Text.isObject(title) ? title.text : typeof own === 'string' ? own : ''),
			a: authors.map(label).filter(Boolean),
		};
		if (!rec.t || !rec.a.length) throw new Error(`Wikidata's ${id} has no title or author in English`);
		const [inSeries] = of(P.series);
		if (inSeries && label(series[0])) {
			rec.s = label(series[0]);
			const qualifiers =
				Text.isObject(inSeries.qualifiers) && Array.isArray(inSeries.qualifiers[P.number])
					? inSeries.qualifiers[P.number]
					: [];
			const n = qualifiers
				.map((q: Unchecked) => (Text.isObject(q.datavalue) ? q.datavalue.value : null))
				.find((x: unknown) => typeof x === 'string');
			if (n && /^\d+(?:\.\d+)?$/.test(n.trim())) rec.sn = n.trim();
		}
		const g = genres.map(label).filter(Boolean);
		if (g.length) rec.g = g;
		const ext: Record<string, string> = {wikidata: id};
		const openLibrary = string(P.openLibrary).toUpperCase(),
			goodreads = string(P.goodreadsWork),
			isfdb = string(P.isfdbTitle);
		if (/^OL\d+W$/.test(openLibrary)) ext.openlibrary = openLibrary;
		if (/^\d+$/.test(goodreads)) ext.goodreads = goodreads;
		if (/^\d+$/.test(isfdb)) ext.isfdb = isfdb;
		rec.ext = ext;
		return Book.fromRecord(rec);
	}
}
