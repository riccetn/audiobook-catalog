// Wikidata as a source of the Edit page's Fill in: it answers any web page (open CORS, no key), by its items
// (Q…), with a book's title, authors, series and genres, and its ids in other catalogs. It has no editions.
// A series, author, narrator or publisher is an item too: it gives their site and their ids in other catalogs.
import {Text, PhraseError} from './text.js';
import {Book} from './book.js';
import {BookSource} from './book-source.js';
import type {Unchecked} from './text.js';
import type {Pasted, EntryKind, EntryQuery, EntryAnswer} from './book-source.js';

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

// Wikidata's properties of a series or a person: their site, and their ids in catalogs this app knows, by kind
// (checked against Wikidata on 2026-11-15); a narrator is a person as an author is
const SITE = 'P856';
const PERSON_IDS = {
	openlibrary: 'P648',
	goodreads: 'P2963',
	isfdb: 'P1233',
	bookbrainz: 'P2607',
	'amazon.com': 'P4862',
};
const ENTRY_IDS: Record<EntryKind, Record<string, string>> = {
	series: {goodreads: 'P6947', isfdb: 'P1235', bookbrainz: 'P12048'},
	author: PERSON_IDS,
	narrator: PERSON_IDS,
	publisher: {isfdb: 'P1239', bookbrainz: 'P8063'},
};
// which of a book's properties names its series or its authors
const ON_BOOK: Partial<Record<EntryKind, string>> = {series: P.series, author: P.author};

/** an item's claims of a property that aren't deprecated */
const claimsOf = (item: Unchecked, prop: string): Unchecked[] =>
	Text.isObject(item.claims) && Array.isArray(item.claims[prop])
		? item.claims[prop].filter((c: unknown) => Text.isObject(c) && c.rank !== 'deprecated')
		: [];
/** what a claim says: a text, or an item ({id}) */
const valueOf = (claim: Unchecked): unknown =>
	Text.isObject(claim.mainsnak) && Text.isObject(claim.mainsnak.datavalue)
		? claim.mainsnak.datavalue.value
		: undefined;
/** an item's label or description in English, tidied */
const inEnglish = (item: unknown, what: 'labels' | 'descriptions'): string => {
	const text = Text.isObject(item) && Text.isObject(item[what]) ? item[what].en : null;
	return Text.isObject(text) && typeof text.value === 'string' ? Text.tidy(text.value) : '';
};

/** Looks books, series and people up on Wikidata. */
export class WikidataSource extends BookSource {
	static CATALOG = 'wikidata';
	static LABEL = 'Wikidata';
	static NAMES = ['Wikidata'];
	static ENTRIES = ['series', 'author', 'narrator', 'publisher'] as const;

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
			props: claims ? 'labels|descriptions|claims' : 'labels',
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
		if (!Text.isObject(item) || 'missing' in item) throw new PhraseError('Wikidata has no item {id}', {id});
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
		if (!authors.length) throw new PhraseError("Wikidata's {id} names no author, so it is not a book", {id});
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
		if (!rec.t || !rec.a.length) throw new PhraseError("Wikidata's {id} has no title or author in English", {id});
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

	// ------------------------------------------------------------------ series and people
	async entry(kind: EntryKind, id: string): Promise<EntryAnswer | null> {
		const item = (await this.items([id], true))[id];
		return Text.isObject(item) && !('missing' in item) ? this.entryOf(kind, item, 'id') : null;
	}

	/**
	 * A series or author by the Wikidata items of its books, which name them; else the items called `name`, each
	 * with Wikidata's description of it.
	 */
	async findEntries({kind, name, books}: EntryQuery): Promise<EntryAnswer[]> {
		const prop = ON_BOOK[kind];
		const mine = [...new Set(books.map(b => b.external[WikidataSource.CATALOG]).filter(Boolean))].slice(0, 5);
		if (prop && mine.length) {
			const named = Object.values(await this.items(mine, true)).flatMap(item =>
				Text.isObject(item)
					? claimsOf(item, prop).map(claim => {
							const v = valueOf(claim);
							return Text.isObject(v) && typeof v.id === 'string' ? v.id : '';
						})
					: [],
			);
			const items = await this.items([...new Set(named.filter(Boolean))], true);
			const same = Object.values(items).filter(item => BookSource.sameName(inEnglish(item, 'labels'), name));
			if (same.length === 1) return [this.entryOf(kind, same[0], 'books')];
		}
		const params = new URLSearchParams({
			action: 'wbsearchentities',
			search: name,
			type: 'item',
			language: 'en',
			limit: '10',
			format: 'json',
			origin: '*',
		});
		const answer = await this.json(`${WIKIDATA_API}?${params}`);
		const hits = (answer && Array.isArray(answer.search) ? answer.search : [])
			.filter(
				(hit: unknown) =>
					Text.isObject(hit) && /^Q\d+$/.test(String(hit.id)) && BookSource.sameName(hit.label, name),
			)
			.slice(0, WikidataSource.NAMESAKES)
			.map((hit: Unchecked) => hit.id as string);
		const items = await this.items(hits, true);
		return hits
			.map((id: string) => items[id])
			.filter((item: unknown) => Text.isObject(item) && !('missing' in item))
			.map((item: Unchecked) => this.entryOf(kind, item, 'name'));
	}

	/**
	 * A series or person from its Wikidata item: its site, and its ids in the catalogs Wikidata knows them in.
	 */
	entryOf(kind: EntryKind, item: Unchecked, by: EntryAnswer['by']): EntryAnswer {
		const string = (prop: string): string => {
			const v = claimsOf(item, prop)
				.map(valueOf)
				.find(x => typeof x === 'string');
			return typeof v === 'string' ? Text.tidy(v) : '';
		};
		const external: Record<string, string> = {};
		for (const [catalog, prop] of Object.entries(ENTRY_IDS[kind])) {
			const id = string(prop);
			if (id) external[catalog] = /^ol\d+[a-z]$/i.test(id) ? id.toUpperCase() : id;
		}
		const described = inEnglish(item, 'descriptions');
		return this.answerOf(
			kind,
			String(item.id),
			inEnglish(item, 'labels'),
			by,
			{url: string(SITE), external},
			described ? Text.phrase('{description}', {description: described}) : null,
		);
	}
}
