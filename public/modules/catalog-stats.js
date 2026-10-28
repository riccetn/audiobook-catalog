// How complete the catalog is: for books, editions, series and people, how many lack each value worth having
// (an external id, a length, a release date, a bio, ...), and how many have an id in each external catalog.
// It only reads the catalog; the Stats page (stats.js) draws what it gives.
import {Catalog} from './catalog.js';
import {Contributor} from './contributor.js';
import {ExternalCatalog} from './external-catalog.js';
/** @import {Book} from './book.js' */
/** @import {Edition} from './edition.js' */
/** @import {NamedKind} from './catalog.js' */
/** @import {CatalogGroup} from './external-catalog.js' */

/** @typedef {'books' | 'editions' | NamedKind} StatKind what a section counts */
/**
 * Something a row counts: what its page is known by (a book's id for a book and its editions, else the series'
 * or person's id) and what the page shows it as.
 * @typedef {{id: string, name: string}} StatEntry
 */
/** @typedef {{key: string, label: string, missing: StatEntry[]}} StatRow one value, and the entries without it */
/** @typedef {{kind: StatKind, label: string, total: number, rows: StatRow[]}} StatSection */
/** @typedef {{group: CatalogGroup, counts: Record<StatKind, number>}} CatalogCount how many of each kind have an id in a catalog */

/**
 * One kind of thing in the catalog, with each value a row checks.
 * @template T
 * @typedef {object} Counted
 * @property {StatEntry} entry
 * @property {T} value
 * @property {Record<string, string>[]} external every id it has, by catalog (a book's own and its editions')
 */

/** @type {(ids: Record<string, string>[]) => boolean} */
const hasAny = ids => ids.some(x => Object.keys(x).length > 0);

export class CatalogStats {
	/** @type {StatKind[]} the sections, in the order the page shows them */
	static KINDS = ['books', 'editions', 'series', 'authors', 'narrators', 'publishers'];
	/** @type {Record<StatKind, string>} */
	static LABELS = {
		books: 'Books',
		editions: 'Editions',
		series: 'Series',
		authors: 'Authors',
		narrators: 'Narrators',
		publishers: 'Publishers',
	};

	/**
	 * @param {Catalog} catalog the whole catalog
	 */
	constructor(catalog) {
		this.catalog = catalog;
		/** @type {Counted<Book>[]} */
		this.books = catalog.books.map(b => ({
			entry: {id: b.id || '', name: b.title},
			value: b,
			external: [b.external, ...b.editions.map(ed => ed.external)],
		}));
		/** @type {Counted<Edition>[]} each edition once: a box set's copies share an id */
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
	 * @param {NamedKind} kind
	 * @returns {Counted<{total?: unknown, status?: unknown, bio?: string} | undefined>[]}
	 */
	named(kind) {
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
	 * @returns {StatSection[]}
	 */
	sections() {
		/**
		 * @template T
		 * @param {StatKind} kind
		 * @param {Counted<T>[]} all
		 * @param {[string, string, (x: Counted<T>) => boolean][]} checks key, label and whether it has the value
		 * @returns {StatSection}
		 */
		const section = (kind, all, checks) => ({
			kind,
			label: CatalogStats.LABELS[kind],
			total: all.length,
			rows: checks.map(([key, label, has]) => ({
				key,
				label,
				missing: all.filter(x => !has(x)).map(x => x.entry),
			})),
		});
		/** @type {[string, string, (x: Counted<any>) => boolean]} */
		const external = ['external', 'No external catalog id', x => hasAny(x.external)];
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
	 * @returns {CatalogCount[]}
	 */
	byCatalog() {
		/** @type {[StatKind, Counted<unknown>[]][]} */
		const kinds = [
			['books', this.books],
			['editions', this.editions],
			...Catalog.NAMED_KINDS.map(
				kind => /** @type {[StatKind, Counted<unknown>[]]} */ ([kind, this.named(kind)]),
			),
		];
		return ExternalCatalog.GROUPS.map(group => {
			/** @type {(x: Counted<unknown>) => boolean} */
			const inGroup = x =>
				x.external.some(ids => Object.keys(ids).some(k => ExternalCatalog.groupOf(k)?.key === group.key));
			return {
				group,
				counts: /** @type {Record<StatKind, number>} */ (
					Object.fromEntries(kinds.map(([kind, all]) => [kind, all.filter(inGroup).length]))
				),
			};
		});
	}
}
