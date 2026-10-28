// The stats page (stats.html): how complete the catalog is. For books, editions, series and people, how many
// lack each value (CatalogStats.sections), each line opening to the ones without it, linked to their pages;
// and how many have an id in each external catalog (CatalogStats.byCatalog). It holds the whole catalog, as
// every count goes through all of it, and changes nothing.
import {Text} from './modules/text.js';
import {CatalogStats} from './modules/catalog-stats.js';
import {
	CATALOG,
	startPage,
	spell,
	byId,
	buildElement,
	fillElement,
	bookPageHref,
	seriesPageHref,
	creditPageHref,
} from './store.js';
/** @import {StatKind, StatSection, StatRow, CatalogCount} from './modules/catalog-stats.js' */

// How many entries a line lists when opened; the rest are counted.
export const LISTED = 100;

/**
 * The address of an entry's page.
 * @param {StatKind} kind
 * @param {string} id
 * @returns {string}
 */
function entryHref(kind, id) {
	if (kind === 'books' || kind === 'editions') return bookPageHref(id);
	if (kind === 'series') return seriesPageHref(id);
	return creditPageHref(kind, id);
}

/**
 * A share as a whole percent, never 0% or 100% unless it is.
 * @param {number} n
 * @param {number} total
 * @returns {string}
 */
export function percent(n, total) {
	if (!total) return '';
	const p = Math.round((100 * n) / total);
	return `${n && !p ? '<1' : n < total && p === 100 ? '>99' : p}%`;
}

/**
 * One line of a section: the value, how many lack it, and (when any do) the list of them.
 * @param {StatSection} section
 * @param {StatRow} row
 * @returns {HTMLElement}
 */
function statRow(section, row) {
	const n = row.missing.length;
	const head = [
		buildElement('span', {class: 'statLabel'}, spell(row.label)),
		buildElement('span', {class: 'statCount'}, n ? `${n} (${percent(n, section.total)})` : 'none'),
	];
	if (!n) return buildElement('div', {class: 'statRow statDone'}, ...head);
	const shown = row.missing.slice(0, LISTED);
	return buildElement(
		'details',
		{class: 'statRow', id: `stat-${section.kind}-${row.key}`},
		buildElement('summary', {}, ...head),
		buildElement(
			'ul',
			{class: 'statList'},
			...shown.map(x => buildElement('li', {}, buildElement('a', {href: entryHref(section.kind, x.id)}, x.name))),
			...(n > shown.length ? [buildElement('li', {class: 'statMore'}, `and ${n - shown.length} more`)] : []),
		),
	);
}

/**
 * The table of how many of each kind have an id in each catalog; catalogs nothing has an id in are left out.
 * @param {CatalogCount[]} counts
 * @param {StatSection[]} sections
 * @returns {HTMLElement}
 */
function catalogTable(counts, sections) {
	const used = counts.filter(c => Object.values(c.counts).some(n => n > 0));
	if (!used.length) return buildElement('p', {class: 'hint'}, spell('Nothing has an id in an external catalog yet.'));
	return buildElement(
		'div',
		{class: 'statTableWrap'},
		buildElement(
			'table',
			{class: 'statTable', id: 'statCatalogs'},
			buildElement(
				'thead',
				{},
				buildElement(
					'tr',
					{},
					buildElement('th', {}, spell('Catalog')),
					...sections.map(s => buildElement('th', {}, s.label)),
				),
			),
			buildElement(
				'tbody',
				{},
				...used.map(c =>
					buildElement(
						'tr',
						{},
						buildElement('th', {}, c.group.name),
						...sections.map(s =>
							buildElement(
								'td',
								{title: percent(c.counts[s.kind], s.total)},
								c.counts[s.kind] ? String(c.counts[s.kind]) : '',
							),
						),
					),
				),
			),
		),
	);
}

export function render() {
	const stats = new CatalogStats(CATALOG);
	const sections = stats.sections();
	const books = sections[0].total;
	byId('subtitle').textContent = books
		? `${Text.plural(books, 'audiobook')}, ${Text.plural(sections[1].total, 'edition')}`
		: spell('The catalog is empty.');
	if (!books) {
		fillElement(byId('statsBody'));
		return;
	}
	fillElement(
		byId('statsBody'),
		...sections.map(s =>
			buildElement(
				'section',
				{class: 'statSection', id: `stats-${s.kind}`},
				buildElement('h2', {}, s.label, ' ', buildElement('span', {class: 'statTotal'}, String(s.total))),
				...(s.total ? s.rows.map(row => statRow(s, row)) : [buildElement('p', {class: 'hint'}, 'None yet.')]),
			),
		),
		buildElement(
			'section',
			{class: 'statSection', id: 'stats-catalogs'},
			buildElement('h2', {}, spell('In external catalogs')),
			buildElement(
				'p',
				{class: 'hint'},
				spell(
					'How many have an id in each catalog. A book counts its editions’ ids too, and every Audible or Amazon site counts as one.',
				),
			),
			catalogTable(stats.byCatalog(), sections),
		),
	);
}

export const READY = startPage(render, {whole: true, refresh: render});
