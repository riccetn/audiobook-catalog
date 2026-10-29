// Compare a series with Audible's catalog: its books there beside yours, to fill in what yours lack (narrators,
// publisher, release date, length, ISBN, genres) as an import would, and the series' Audible id and count of
// books. Audible's catalog needs no account and has no shelves of yours, so nothing is planned or sent: it is a
// ShelfSync without a plan. Audible lists every edition it sells of a series' books (other publishers,
// abridged), so a book of yours takes the edition with one of its ASINs, else the one edition of its number;
// with several and none of yours, only what the book itself has, as it can't tell which edition is yours.
import {Text} from './text.js';
import {ExternalCatalog} from './external-catalog.js';
import {Series} from './series.js';
import {Comparison} from './comparison.js';
import {ShelfSync} from './shelf-sync.js';
import {AudibleClient} from './audible-client.js';
import {AudibleSource} from './audible-source.js';
import type {Unchecked} from './text.js';
import type {Book} from './book.js';
import type {Catalog} from './catalog.js';
import type {MergeOptions} from './merger.js';
import type {Step} from './catalog-client.js';
import type {ShelfPart, ShelfComparison, InfoId, NotAudio} from './shelf-sync.js';

/**
 * A comparison with a series on Audible: the site asked, and how many books the series has there (whole numbers).
 */
export type AudibleComparison = ShelfComparison & {site: string; numbers: number};

// Audible puts these in a series to stand for books it has yet to sell
const PLACEHOLDER = /series advisor placeholder/i;

/** Compares a series' books with Audible's catalog. */
export class AudibleSync extends ShelfSync {
	static CLIENT = AudibleClient;
	static PARTS = ['series'] as readonly ('series' | 'author')[];
	static FOUND = 'ids and book counts';

	// The client is its own catalog's, with what that catalog asks.
	declare client: AudibleClient;

	constructor(client: AudibleClient) {
		super(client);
		this.client = client;
	}

	/**
	 * The series `part` names on Audible beside `catalog` (not changed): on the site most of its books' ASINs
	 * are from, the series by its Audible id there, else the one Audible lists your books in. Each book of
	 * yours in it is compared as an import would take Audible's (only those: none is added). Only reads Audible;
	 * `step(text, done, total)` hears how far it has got.
	 */
	async compare(catalog: Catalog, step: Step, part?: ShelfPart): Promise<AudibleComparison> {
		if (!part || part.kind !== 'series') throw new Error('Audible compares one series at a time: pick a series');
		const client = this.client;
		const mine = catalog.books.filter(Comparison.scope('series', part.name));
		const id = catalog.nameIds.series.get(part.name);
		const info = id === undefined ? undefined : catalog.series.get(id);
		const site = AudibleSync.siteOf(mine, info);
		const saved = info && info.external[site];
		const asin = saved && AudibleClient.ID.test(saved) ? saved : await this.findSeries(mine, site, part, step);
		if (!asin)
			throw new Error(
				`${site} lists none of your books in the series ${part.name}; paste the series' address on ${site} in its form`,
			);
		step(`Reading the series ${part.name} on ${site}`);
		const series = await client.series(site, asin, 'relationships,product_desc');
		if (!series) throw new Error(`${site} has no series ${asin}`);
		const children = (Array.isArray(series.relationships) ? series.relationships : []).filter(
			(r: unknown) =>
				Text.isObject(r) &&
				r.relationship_to_product === 'child' &&
				r.relationship_type === 'series' &&
				typeof r.asin === 'string',
		);
		const products = await client.products(
			site,
			children.map((c: Unchecked) => c.asin),
			AudibleSource.GROUPS,
			step,
			"Reading the series' books",
		);
		// each book there by its number in the series, editions in Audible's order (sort)
		const byNumber: Map<string, {number: string; products: Unchecked[]}> = new Map();
		const ordered = [...children].sort((x, y) => (Number(x.sort) || 0) - (Number(y.sort) || 0));
		for (const child of ordered) {
			const product = products.get(child.asin);
			if (!product || PLACEHOLDER.test(String(product.publisher_name || ''))) continue;
			const listed = (Array.isArray(product.series) ? product.series : []).find(
				(s: unknown) => Text.isObject(s) && s.asin === asin,
			);
			const number = Text.tidy(String((listed && listed.sequence) || child.sequence || ''));
			const key = AudibleSync.numberKey(number);
			if (!key) continue; // a collection or a companion without a number
			const entry = byNumber.get(key) || byNumber.set(key, {number, products: []}).get(key);
			if (entry) entry.products.push(product);
		}
		const byAsin: Map<string, Book> = new Map();
		for (const b of mine) for (const a of b.ids('asin')) byAsin.set(a, b);
		const incomingOf: (product: Unchecked, yours: Book | undefined, number: string, edition: boolean) => Book = (
			product,
			yours,
			number,
			edition,
		) => {
			const book = AudibleSource.book(product, site, asin);
			book.series = part.name;
			// your number for it when it is the same one ("04" and "4")
			book.number =
				yours && yours.number && AudibleSync.numberKey(yours.number) === AudibleSync.numberKey(number)
					? yours.number
					: number;
			if (!edition) book.editions = [];
			return book;
		};
		const incoming: Book[] = [];
		const missing: string[] = [];
		const warnings: string[] = [];
		const editionsYours: Book[] = [];
		for (const [key, {number, products: editions}] of byNumber) {
			const yours = editions.filter(p => byAsin.has(p.asin));
			for (const p of yours) {
				const book = incomingOf(p, byAsin.get(p.asin), number, true);
				incoming.push(book);
				editionsYours.push(book);
			}
			const unmatched = mine.filter(
				b => b.number && AudibleSync.numberKey(b.number) === key && !b.ids('asin').some(a => products.has(a)),
			);
			const best = editions.find(p => p.format_type !== 'abridged') || editions[0];
			if (unmatched.length) {
				incoming.push(incomingOf(best, unmatched[0], number, editions.length === 1));
				if (editions.length > 1)
					warnings.push(
						`${unmatched[0].title}: ${site} has ${editions.length} editions of book ${number} and none has an ASIN of yours; give yours its ASIN to fill it in`,
					);
			}
			// a box set of books there isn't one to have
			else if (
				!yours.length &&
				!key.includes('-') &&
				!mine.some(b => b.number && AudibleSync.numberKey(b.number) === key)
			)
				missing.push(`${number}. ${Text.tidy(best.title)}`);
		}
		const notAudio = await this.unsold(mine, site, products, step);
		// a product's title is its site's, the title it was released under there
		const opts: MergeOptions = {addable: () => false, editionTitles: true};
		const comparison = Comparison.compare(catalog, incoming, opts);
		const numbers = [...byNumber.keys()].filter(k => /^\d+$/.test(k)).length;
		const needsId = !info || !info.external[site];
		const needsTotal = (!info || info.total === undefined) && numbers > 0;
		const infoIds: InfoId[] =
			catalog.namesOf('series').has(part.name) && (needsId || needsTotal)
				? [{kind: 'series', name: part.name, id: asin, catalog: site, ...(needsTotal ? {total: numbers} : {})}]
				: [];
		return {
			comparison,
			incoming,
			opts,
			warnings,
			yours: editionsYours,
			found: null,
			idsFound: [],
			infoIds,
			plan: null,
			missing,
			notAudio,
			site,
			numbers,
		};
	}

	/**
	 * The editions of `books` whose ASIN on `site` (or its Amazon's) Audible doesn't sell there: maybe not
	 * audiobooks, as an Amazon ASIN may be a Kindle or print edition's (from a Goodreads or Hardcover import),
	 * though Audible also stops selling some. `sold` holds the products already read; the others are asked.
	 */
	async unsold(books: Book[], site: string, sold: Map<string, Unchecked>, step: Step): Promise<NotAudio[]> {
		const asins: [Book, string, string][] = [];
		for (const book of books)
			for (const ed of book.editions)
				for (const [key, id] of Object.entries(ed.external))
					if (ExternalCatalog.family(key) === 'asin' && AudibleSource.site(key) === site && !sold.has(id))
						asins.push([book, id, key]);
		if (!asins.length) return [];
		const found = await this.client.products(
			site,
			[...new Set(asins.map(([, a]) => a))],
			'product_desc',
			step,
			'Checking your ASINs on Audible',
		);
		return asins
			.filter(([, a]) => !found.has(a))
			.map(([book, a, key]) => ({
				book,
				yours: true,
				edition: `ASIN ${a}`,
				said: `not sold on ${site}: maybe a Kindle or print edition's ASIN`,
				// its page where it came from: an Amazon one shows what it is
				url: ExternalCatalog.url(key, 'edition', a),
				maybe: true,
			}));
	}

	/**
	 * The Audible site a series is read on: the one most of `books`' ASINs are from (an Amazon site's is its
	 * Audible's: amazon.de, audible.de), else the first its info has an id on, else audible.com.
	 */
	static siteOf(books: Book[], info: Series | undefined): string {
		const counts: Map<string, number> = new Map();
		for (const ed of books.flatMap(b => b.editions))
			for (const key of Object.keys(ed.external))
				if (ExternalCatalog.family(key) === 'asin') {
					const site = AudibleSource.site(key);
					counts.set(site, (counts.get(site) || 0) + 1);
				}
		const top = [...counts].sort((x, y) => y[1] - x[1])[0];
		if (top) return top[0];
		const saved = info && Object.keys(info.external).find(k => ExternalCatalog.get(k)?.group === 'audible');
		return saved || ExternalCatalog.AUDIBLE_SITE;
	}

	/**
	 * The ASIN of the series `part` names on `site`, from what Audible says of your books in it there: the
	 * series named so, else the one listing most of them by their numbers; null when there is none.
	 */
	async findSeries(books: Book[], site: string, part: ShelfPart, step: Step): Promise<string | null> {
		const byAsin: Map<string, Book> = new Map();
		for (const b of books)
			for (const ed of b.editions)
				for (const [key, id] of Object.entries(ed.external))
					if (ExternalCatalog.family(key) === 'asin' && AudibleSource.site(key) === site) byAsin.set(id, b);
		if (!byAsin.size) return null;
		const products = await this.client.products(
			site,
			[...byAsin.keys()],
			'series,product_desc', // the title comes with product_desc
			step,
			'Finding the series on Audible',
		);
		const same = ShelfSync.sameName(part);
		const byNumber: Map<string, number> = new Map();
		for (const [a, product] of products) {
			const book = byAsin.get(a);
			for (const s of Array.isArray(product.series) ? product.series : []) {
				if (!Text.isObject(s) || typeof s.asin !== 'string' || !AudibleClient.ID.test(s.asin)) continue;
				if (same(s.title)) return s.asin;
				if (
					book &&
					book.number &&
					AudibleSync.numberKey(book.number) === AudibleSync.numberKey(String(s.sequence || ''))
				)
					byNumber.set(s.asin, (byNumber.get(s.asin) || 0) + 1);
			}
		}
		const [first, second] = [...byNumber].sort((x, y) => y[1] - x[1]);
		return first && (!second || second[1] < first[1]) ? first[0] : null;
	}

	/**
	 * A series number as it compares: "02" and "2.0" are "2", a range "1-3"; '' for none.
	 */
	static numberKey(number: string): string {
		const m = /^(\d+(?:\.\d+)?)(?:-(\d+(?:\.\d+)?))?$/.exec(Text.tidy(number));
		if (!m) return '';
		return [m[1], m[2]]
			.filter(Boolean)
			.map(n => String(Number(n)))
			.join('-');
	}

	/**
	 * What a comparison's first line says it read.
	 */
	summary(
		result: AudibleComparison,
		catalog: Catalog,
		scope: {kind: 'series' | 'author'; name: string; label: string} | null,
	): string {
		const here = ShelfSync.inScope(catalog, scope).length;
		return `${scope ? `Only ${scope.label}: ` : ''}${Text.plural(here, 'book')} in this catalog, ${Text.plural(result.numbers, 'book')} in the series on ${result.site}`;
	}

	/**
	 * The ids found are the editions', which the comparison takes in: nothing more.
	 */
	static addIds(_books: Book[], _found: unknown): Book[] {
		return [];
	}

	/**
	 * Give the series its Audible id on the site asked and its count of books there, where it has none yet.
	 * @param catalog changed in place
	 * @returns how many series gained one
	 */
	static setInfoIds(catalog: Catalog, found: InfoId[]): number {
		let n = 0;
		for (const {kind, name, id, catalog: site = ExternalCatalog.AUDIBLE_SITE, total} of found) {
			if (kind !== 'series' || !catalog.namesOf('series').has(name)) continue;
			const key = catalog.idFor('series', name);
			const info = catalog.series.get(key) || new Series(name);
			let changed = false;
			if (!info.external[site]) {
				info.external = {...info.external, [site]: id};
				changed = true;
			}
			if (info.total === undefined && total !== undefined) {
				info.total = total;
				changed = true;
			}
			catalog.series.set(key, info);
			if (changed) n++;
		}
		return n;
	}

	static notAdded(count: number): string {
		return `Not matched with a book of yours, so left out: ${count}`;
	}
}
