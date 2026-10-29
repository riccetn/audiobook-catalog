// How complete the catalog is: for books, editions, series and people, how many lack each value worth having
// (an external id, a length, a release date, a bio, ...), and how many have an id in each external catalog.
// It only reads the catalog; the Stats page (stats.ts) draws what it gives.
import {Catalog} from './catalog.js';
import {Contributor} from './contributor.js';
import {ExternalCatalog} from './external-catalog.js';
import type {Book} from './book.js';
import type {Edition} from './edition.js';
import type {NamedKind} from './catalog.js';
import type {CatalogGroup} from './external-catalog.js';

/** what a section counts */
export type StatKind = 'books' | 'editions' | NamedKind;
/**
 * Something a row counts: what its page is known by (a book's id for a book and its editions, else the series'
 * or person's id) and what the page shows it as.
 */
export type StatEntry = {id: string; name: string};
/** one value, and the entries without it */
export type StatRow = {key: string; label: string; missing: StatEntry[]};
export type StatSection = {kind: StatKind; label: string; total: number; rows: StatRow[]};
/** how many of each kind have an id in a catalog */
export type CatalogCount = {group: CatalogGroup; counts: Record<StatKind, number>};

/** One kind of thing in the catalog, with each value a row checks. */
export interface Counted<T> {
	entry: StatEntry;
	value: T;
	/** every id it has, by catalog (a book's own and its editions') */
	external: Record<string, string>[];
}

const hasAny: (ids: Record<string, string>[]) => boolean = ids => ids.some(x => Object.keys(x).length > 0);

export class CatalogStats {
	/** the sections, in the order the page shows them */
	static KINDS: StatKind[] = ['books', 'editions', 'series', 'authors', 'narrators', 'publishers'];
	static LABELS: Record<StatKind, string> = {
		books: 'Books',
		editions: 'Editions',
		series: 'Series',
		authors: 'Authors',
		narrators: 'Narrators',
		publishers: 'Publishers',
	};

	catalog: Catalog;
	books: Counted<Book>[];
	/** each edition once: a box set's copies share an id */
	editions: Counted<Edition>[];

	/**
	 * @param catalog the whole catalog
	 */
	constructor(catalog: Catalog) {
		this.catalog = catalog;
		this.books = catalog.books.map(b => ({
			entry: {id: b.id || '', name: b.title},
			value: b,
			external: [b.external, ...b.editions.map(ed => ed.external)],
		}));
		this.editions = [];
		const seen = new Set();
		for (const b of catalog.books) {
			for (const ed of b.editions) {
				if (ed.id && seen.has(ed.id)) continue;
				if (ed.id) seen.add(ed.id);
				this.editions.push({
					entry: {id: b.id || '', name: ed.title || b.title},
					value: ed,
					external: [ed.external],
				});
			}
		}
	}

	/**
	 * The series, authors, narrators or publishers, each with its info (undefined when it has none), by name.
	 */
	named(kind: NamedKind): Counted<{total?: unknown; status?: unknown; bio?: string} | undefined>[] {
		const byName = new Map([...this.catalog.infoMap(kind).values()].map(info => [info.name, info]));
		return [...this.catalog.namesOf(kind)]
			.sort((x, y) => x.localeCompare(y))
			.map(name => {
				const info = byName.get(name);
				return {
					entry: {id: this.catalog.idFor(kind, name), name},
					value: info,
					external: info ? [info.external] : [],
				};
			});
	}

	/**
	 * Each kind's section: how many there are, and per value the ones without it.
	 */
	sections(): StatSection[] {
		/**
		 * @param checks key, label and whether it has the value
		 */
		const section = <T>(
			kind: StatKind,
			all: Counted<T>[],
			checks: [string, string, (x: Counted<T>) => boolean][],
		): StatSection => ({
			kind,
			label: CatalogStats.LABELS[kind],
			total: all.length,
			rows: checks.map(([key, label, has]) => ({
				key,
				label,
				missing: all.filter(x => !has(x)).map(x => x.entry),
			})),
		});
		const external: [string, string, (x: Counted<any>) => boolean] = [
			'external',
			'No external catalog id',
			x => hasAny(x.external),
		];
		return [
			section('books', this.books, [
				external,
				['editions', 'No editions', x => x.value.editions.length > 0],
				['genres', 'No genres', x => x.value.genres.length > 0],
				// a book without a date read has an unknown date, not none: it may well have been read
				['read', 'Date read unknown', x => x.value.read.length > 0],
			]),
			section('editions', this.editions, [
				external,
				['asin', 'No ASIN', x => Boolean(x.value.ids('asin').length)],
				['isbn', 'No ISBN', x => Boolean(x.value.isbn)],
				['narrators', 'No narrators', x => x.value.narrators.length > 0],
				['publisher', 'No publisher', x => Boolean(x.value.publisher)],
				['released', 'No release date', x => Boolean(x.value.released)],
				['minutes', 'No length', x => x.value.minutes !== undefined],
				['description', 'No description', x => Boolean(x.value.description)],
			]),
			section('series', this.named('series'), [
				external,
				['total', 'No number of books', x => x.value?.total !== undefined],
				['status', 'No status (ongoing or complete)', x => x.value?.status !== undefined],
			]),
			...Contributor.KINDS.map(kind =>
				section(kind, this.named(kind), [external, ['bio', 'No bio', x => Boolean(x.value?.bio)]]),
			),
		];
	}

	/**
	 * How many of each kind have an id in each external catalog (a form field's catalogs together: every
	 * Audible site is Audible), in the usual order; a book counts its editions' ids too.
	 */
	byCatalog(): CatalogCount[] {
		const kinds: [StatKind, Counted<unknown>[]][] = [
			['books', this.books],
			['editions', this.editions],
			...Catalog.NAMED_KINDS.map(kind => [kind, this.named(kind)] as [StatKind, Counted<unknown>[]]),
		];
		return ExternalCatalog.GROUPS.map(group => {
			const inGroup: (x: Counted<unknown>) => boolean = x =>
				x.external.some(ids => Object.keys(ids).some(k => ExternalCatalog.groupOf(k)?.key === group.key));
			return {
				group,
				counts: Object.fromEntries(kinds.map(([kind, all]) => [kind, all.filter(inGroup).length])) as Record<
					StatKind,
					number
				>,
			};
		});
	}
}
