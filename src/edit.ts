// The Edit series page (edit.html#series=<id>, or #author=<id> for an author's books): a series and every
// book in it on one page, each book with its fields and its editions, edited in place. Editions are merged,
// split and removed here too (a removed one may be excluded from imports, Exclusions.editionEntries). The
// other catalogs are asked when the page opens (edit-catalogs.ts, loaded with import()): what they have that
// differs is shown on each book to pick, with what they would add and the books none of yours are. Nothing is
// saved until Review & save lists every change and Save is pressed: the books are edited as copies (`DRAFTS`),
// and Save puts them in the catalog with saveBook(), as the book form does, then adds the new books picked,
// renames the series and saves its info, as its form did.
import {Text} from './modules/text.js';
import {Book} from './modules/book.js';
import {Edition} from './modules/edition.js';
import {Series} from './modules/series.js';
import {Exclusions} from './modules/exclusions.js';
import {Validator} from './modules/validator.js';
import {ExternalCatalog} from './modules/external-catalog.js';
import {
	CATALOG,
	startPage,
	loadRecords,
	persist,
	queryCatalog,
	wholeCatalog,
	spell,
	byId,
	fieldById,
	buildElement,
	fillElement,
	showIoStatus,
	externalFields,
	linksField,
	fillExternalFields,
	readExternalFields,
	lookupHardcoverField,
	valueFromPageHash,
	idFromAddress,
	bookPageHref,
	seriesPageHref,
	creditPageHref,
	openWithStatus,
	hashValue,
} from './store.js';
import {coverImage, totalText, setAddress} from './book-list.js';
import type {Child, FormField} from './store.js';
import type {CatalogRun, CatalogChoice} from './edit-catalogs.js';
import type {CatalogEntry, FieldChoices} from './modules/book-review.js';
import type {NotAudio} from './modules/shelf-sync.js';

/** A book being edited: the book as loaded (`before`, as stored text) and the copy the page changes. */
export type Draft = {id: string; before: Book; book: Book; error: string; added?: NewPick};
/**
 * A new book picked to add (`kind` and its place in the review's fresh or missing books), drafted on the page
 * as its catalog has it (`before`), so it can be changed before it is added.
 */
export type NewPick = {kind: 'fresh' | 'missing'; n: number};
// the ids a new book's editions have on the page, so a field changed is told from the catalog's; never stored
const NEW_EDITION = 'new-edition-';

/** What the page edits: a series' books, or an author's. */
export let KIND: 'series' | 'author' = 'series';
/** The series' id, from the address (null on an author's page). */
export let SERIES_ID: string | null = null;
/** The author's id, from the address (null on a series' page). */
export let AUTHOR_ID: string | null = null;
/** What the other catalogs said, once asked; null before (or when none can be). */
export let RUN: CatalogRun | null = null;
/** Resolves once the other catalogs have been asked (each time the page asks them). */
export let ASKING: Promise<void> = Promise.resolve();
/** The new books picked, by their place in the review's: the catalog (its place) each is added as. */
export let FRESH_PICKS: Map<number, number> = new Map();
/**
 * The missing books picked (the books of the series the catalogs list, by their place in the review's): the
 * catalog (its place) each is added as, and the book as read from it (null while it is being read).
 */
export let MISSING_PICKS: Map<number, {source: number; book: Book | null}> = new Map();
/** The catalogs (by place) whose ids found for the series and its people are kept. */
export let INFO_PICKS: Set<number> = new Set();
/** The series' books, in series order, as the page has changed them. */
export let DRAFTS: Draft[] = [];
/** The entries Save adds to the exclusions list: the removed editions to keep out of imports. */
export let EXCLUDE: string[] = [];
// what an edition's Merge, Split or Remove has open: "<book place>:<edition place>:<what>"
let OPEN_PANEL: string | null = null;
let REMOVING_SERIES = false; // Remove series was pressed once; the second press removes it

// The fields of a book the page edits, besides its ids: [key, label]. The series is edited on an author's
// page; on a series' page it is the series' own name.
const BOOK_FIELDS: [string, string][] = [
	['t', 'Title'],
	['a', 'Authors'],
	['s', 'Series'],
	['sn', 'Number in the series'],
	['g', 'Genres'],
	['r', 'Read'],
];
/** The book fields with an input on this page. */
const bookFields = (): [string, string][] => BOOK_FIELDS.filter(([k]) => k !== 's' || KIND === 'author');
// The fields of an edition the page edits, besides its ids: [Edition.fields() key, label].
const EDITION_FIELDS: [string, string][] = [
	['t', 'Released as'],
	['n', 'Narrators'],
	['p', 'Publishers'],
	['d', 'Released'],
	['len', 'Length'],
	['isbn', 'ISBN'],
	['desc', 'Description'],
	['links', 'Links'],
];

// ------------------------------------------------------------------ what a book and an edition show
/**
 * A book's field as the page shows it in its input.
 */
export function bookFieldText(b: Book, key: string): string {
	if (key === 't') return b.title;
	if (key === 'a') return Text.namesText(b.authors);
	if (key === 's') return b.series || '';
	if (key === 'sn') return b.number || '';
	if (key === 'g') return b.genres.join(', ');
	if (key === 'r') return b.read.join(', ');
	return '';
}

/**
 * What tells an edition from the book's others: the start of its description, else its narrators, else its
 * ids; its publishers, release date and length follow (`meta`).
 */
export function editionName(ed: Edition): {name: string; meta: string[]} {
	const desc = Text.tidy(ed.description || '');
	const ids = [
		...ed.externalList().map(([key, v]) => `${Edition.fieldLabel(key)} ${v}`),
		...(ed.isbn ? [`ISBN ${ed.isbn}`] : []),
	];
	const name = desc
		? desc.length > 90
			? desc.slice(0, 88).replace(/\s+\S*$/, '') + '…'
			: desc
		: ed.narrators.length
			? `Narrated by ${Text.namesText(ed.narrators)}`
			: ed.title || ids[0] || 'An edition with nothing to tell it by';
	const meta = [
		...(desc && ed.narrators.length ? [Text.namesText(ed.narrators)] : []),
		...(ed.publishers.length ? [Text.namesText(ed.publishers)] : []),
		...(ed.released ? [ed.released] : []),
		...(ed.minutes !== undefined && Number.isInteger(ed.minutes) ? [Text.formatLength(ed.minutes)] : []),
		...ids,
	];
	return {name, meta};
}

/** The id of a field's input: the book's place, the edition's, and the key (':' is no id's). */
function inputId(i: number, j: number | null, key: string): string {
	return `b${i}${j === null ? '' : 'e' + j}_${key.replace(/[^\w.-]/g, '-')}`;
}

/** The book as loaded that `ed` is an edition of, by its stored id; null for an edition new on the page. */
function editionBefore(d: Draft, ed: Edition): Edition | null {
	return (ed.id !== undefined && d.before.editions.find(x => x.id === ed.id)) || null;
}

// ------------------------------------------------------------------ drawing
/**
 * A labeled input, marked when it differs from the book as loaded, with the other catalogs' values for it
 * (`choices`) to fill it in with.
 */
function field(
	id: string,
	label: string,
	value: string,
	was: string,
	attrs: Record<string, any> = {},
	choices: FieldChoices[] = [],
): HTMLElement {
	// links one per line
	const input = buildElement(attrs['data-key'] === 'links' ? 'textarea' : 'input', {id, ...attrs});
	(input as HTMLInputElement).value = value;
	const onchange = attrs.onchange as (() => void) | undefined;
	return buildElement(
		'div',
		{class: value === was ? 'editField' : 'editField changed'},
		buildElement('label', {for: id}, spell(label)),
		input,
		...choiceChips(id, value, choices, onchange || (() => {})),
	);
}

/**
 * The other catalogs' values for a field, each a button that puts it in the field's input (`id`), which is
 * then read as if typed (`onchange`).
 */
function choiceChips(id: string, value: string, choices: FieldChoices[], onchange: () => void): HTMLElement[] {
	const all = choices.flatMap(f => f.choices);
	if (!all.length) return [];
	return [
		buildElement(
			'div',
			{class: 'editChips'},
			...all.map((c, n) =>
				buildElement(
					'button',
					{
						type: 'button',
						class: Text.norm(c.text) === Text.norm(value) ? 'editChip picked' : 'editChip',
						id: `${id}-pick-${n}`,
						title: spell(`Use ${c.labels.join(' and ')}'s value`),
						onclick: () => {
							fieldById(id).value = c.text;
							onchange();
						},
					},
					buildElement(
						'span',
						{class: 'editChipFrom'},
						...c.labels.flatMap(iconOfLabel),
						buildElement('span', {class: 'visuallyHidden'}, c.labels.join(', ')),
					),
					' ',
					c.text,
				),
			),
		),
	];
}

/**
 * What the other catalogs say of a book's field (`ed` null) or of its edition `ed` (at `j` in the book).
 */
function choicesFor(d: Draft, ed: Edition | null, j: number | null, key: string): FieldChoices[] {
	const reviewed = RUN && RUN.review.books.get(d.id);
	if (!reviewed) return [];
	return reviewed.fields.filter(f => {
		if (f.field !== key) return false;
		if (ed === null) return f.editionPlace === null;
		if (f.editionPlace === null) return false;
		return f.edition !== null ? f.edition === ed.id : f.editionPlace === j;
	});
}

/** A book's card: its summary, its fields and its editions. */
function bookCard(d: Draft, i: number): HTMLElement {
	const b = d.book;
	const changed = b.text() !== d.before.text();
	const cover = coverImage(b, 'small');
	const fields = bookFields().map(([k, label]) =>
		field(
			inputId(i, null, k),
			label,
			bookFieldText(b, k),
			bookFieldText(d.before, k),
			{'data-book': String(i), onchange: () => readBookFields(i)},
			choicesFor(d, null, null, k),
		),
	);
	const ids = buildElement(
		'div',
		{class: 'formrow extFields', id: inputId(i, null, 'ext'), onchange: () => readBookFields(i)},
		...externalFields(inputId(i, null, 'ext_'), 'book'),
	);
	// a catalog's page typed among the links goes to its id field
	const links = linksField(
		inputId(i, null, 'links'),
		'book',
		group => document.getElementById(inputId(i, null, 'ext_') + group) as FormField | null,
		{
			value: b.links.join('\n'),
			onMoved: () => readBookFields(i),
			attrs: {onchange: () => readBookFields(i)},
		},
	);
	links.classList.toggle('changed', b.links.join(' ') !== d.before.links.join(' '));
	return buildElement(
		'details',
		{class: changed ? 'editBook changed' : 'editBook', id: `book-${i}`, open: ''},
		buildElement(
			'summary',
			{},
			...(cover ? [cover] : []),
			buildElement(
				'span',
				{class: 'editBookHead'},
				buildElement('span', {class: 'editBookTitle'}, (b.number ? b.number + ' · ' : '') + b.title),
				buildElement(
					'span',
					{class: 'editBookMeta'},
					[
						Text.namesText(b.authors),
						b.read.length ? `read ${b.read.join(', ')}` : '',
						Text.plural(b.editions.length, 'edition'),
					]
						.filter(Boolean)
						.join(' · '),
				),
			),
			...(changed ? [buildElement('span', {class: 'editPill'}, 'changed')] : []),
		),
		buildElement(
			'div',
			{class: 'editBookBody'},
			buildElement(
				'p',
				{class: 'editBookLinks'},
				...(d.added ? [] : [buildElement('a', {href: bookPageHref(d.id)}, "The book's page")]),
				...catalogLinks(d),
			),
			buildElement('div', {class: 'editFields'}, ...fields),
			ids,
			links,
			buildElement('p', {class: 'formError', id: `book-${i}-error`}, d.error),
			...catalogFinds(d, i),
			buildElement('h3', {class: 'editEditionsTitle'}, 'Editions'),
			...b.editions.map((ed, j) => editionCard(d, i, j)),
			...(b.editions.length ? [] : [buildElement('p', {class: 'hint'}, 'No editions yet.')]),
			...newEditionOffers(d, i),
			...excludedEditions(d),
			buildElement(
				'button',
				{type: 'button', class: 'editAddEdition', onclick: () => addEdition(i)},
				'+ Add an edition',
			),
		),
	);
}

/** An edition's card: what tells it apart, its fields, and Merge, Split and Remove. */
function editionCard(d: Draft, i: number, j: number): HTMLElement {
	const ed = d.book.editions[j];
	const was = editionBefore(d, ed);
	const wasFields = was ? was.fields() : {};
	const fields = ed.fields();
	const onchange = () => readEditionFields(i, j);
	const ext = Object.keys(fields).filter(k => k.startsWith('ext:'));
	const inputs = [
		...EDITION_FIELDS.map(([k, label]) =>
			field(
				inputId(i, j, k),
				label,
				fields[k] || '',
				wasFields[k] || '',
				{
					'data-key': k,
					onchange,
					// a short name for it, as the book form's: "UK edition", "Full cast"
					...(k === 'desc' ? {placeholder: 'e.g. UK edition'} : {}),
					...(k === 't' ? {placeholder: 'the same as the book'} : {}),
					// an edition's page on a catalog typed among its links goes to its id
					...(k === 'links'
						? {placeholder: 'https://… one per line', onfocusout: () => editionLinksToIds(i, j)}
						: {}),
				},
				choicesFor(d, ed, j, k),
			),
		),
		...ext.map(k =>
			field(inputId(i, j, k), Edition.fieldLabel(k.slice(4)), fields[k], wasFields[k] || '', {
				'data-key': k,
				onchange,
			}),
		),
		anotherIdField(i, j, onchange),
	];
	const panel = OPEN_PANEL && OPEN_PANEL.startsWith(`${i}:${j}:`) ? OPEN_PANEL.split(':')[2] : null;
	return buildElement(
		'details',
		{class: was && was.format() === ed.format() ? 'editEdition' : 'editEdition changed', id: `book-${i}-ed-${j}`},
		buildElement('summary', {}, ...editionSummary(d, ed), ...editionMarks(d, j)),
		...editionFinds(d, i, j),
		buildElement('div', {class: 'editFields'}, ...inputs),
		buildElement('p', {class: 'formError', id: `book-${i}-ed-${j}-error`}),
		buildElement(
			'div',
			{class: 'formbtns'},
			...(d.book.editions.length > 1
				? [buttonFor('Merge with…', () => openPanel(i, j, 'merge'), `book-${i}-ed-${j}-merge`)]
				: []),
			buttonFor('Split', () => openPanel(i, j, 'split'), `book-${i}-ed-${j}-split`),
			buttonFor('Remove edition', () => openPanel(i, j, 'remove'), `book-${i}-ed-${j}-remove`, 'removeBook'),
		),
		...(panel === 'merge' ? [mergePanel(i, j)] : []),
		...(panel === 'split' ? [splitPanel(i, j)] : []),
		...(panel === 'remove' ? [removePanel(i, j)] : []),
	);
}

/**
 * An edition's Another id: its address on any catalog, or a bare id with the catalog picked beside it (no
 * address at hand).
 */
function anotherIdField(i: number, j: number, onchange: () => void): HTMLElement {
	const id = inputId(i, j, 'more');
	const catalogs = ExternalCatalog.ALL.filter(def => def.kinds.edition);
	return buildElement(
		'div',
		{class: 'editField editAnotherId'},
		buildElement('label', {for: id}, 'Another id'),
		buildElement(
			'select',
			{id: inputId(i, j, 'more-catalog'), 'aria-label': 'Catalog of the id', onchange},
			buildElement('option', {value: ''}, spell('Catalog: from the address')),
			...catalogs.map(def =>
				buildElement(
					'option',
					{value: def.key},
					ExternalCatalog.family(def.key) === 'asin' ? `ASIN ${def.key}` : def.name,
				),
			),
		),
		buildElement('input', {
			id,
			'data-key': 'more',
			placeholder: "the edition's address, or its id and catalog",
			onchange,
		}),
	);
}

/** What tells an edition apart, as its card's summary shows it. */
function editionSummary(d: Draft, ed: Edition): HTMLElement[] {
	const {name, meta} = editionName(ed);
	const shared = sharedWith(d, ed);
	return [
		buildElement('span', {class: ed.description ? 'editEdName editEdDesc' : 'editEdName'}, name),
		buildElement('span', {class: 'editEdMeta'}, meta.join(' · ')),
		...(shared ? [buildElement('span', {class: 'editEdShared'}, spell(shared))] : []),
	];
}

function buttonFor(label: string, onclick: () => void, id: string, cls: string = ''): HTMLButtonElement {
	return buildElement('button', {type: 'button', id, ...(cls ? {class: cls} : {}), onclick}, spell(label));
}

/** Which other books of the page have this edition too (a box set's), as a note; '' for none. */
function sharedWith(d: Draft, ed: Edition): string {
	// (a new book's editions are its own copies until it is added)
	if (d.added) return '';
	const others = DRAFTS.filter(x => x !== d && !x.added && x.book.editions.some(y => y.sameAs(ed))).map(x => x.book);
	if (!others.length) return '';
	return `Also on ${others.map(b => b.title).join(', ')}: a change here changes it there too.`;
}

/** Merge with…: the book's other editions this one can be one with (none disagree on an id). */
function mergePanel(i: number, j: number): HTMLElement {
	const b = DRAFTS[i].book;
	const others = b.editions
		.map((ed, k) => k)
		.filter(k => k !== j && Edition.joinable([b.editions[j], b.editions[k]]));
	return buildElement(
		'div',
		{class: 'editInline', id: `book-${i}-ed-${j}-panel`},
		others.length
			? buildElement('p', {}, 'Merge this edition with:')
			: buildElement(
					'p',
					{},
					spell(
						'No other edition of this book can be merged with it: their ids differ (two ASINs on one site, or two ISBNs).',
					),
				),
		...others.map(k =>
			buildElement(
				'button',
				{type: 'button', id: `book-${i}-ed-${j}-merge-${k}`, onclick: () => mergeEditions(i, j, k)},
				editionName(b.editions[k]).name,
			),
		),
		buttonFor('Cancel', () => openPanel(i, j, null), `book-${i}-ed-${j}-cancel`),
	);
}

/** Split: the fields that move to a new edition (ticked), and those copied onto both. */
function splitPanel(i: number, j: number): HTMLElement {
	const fields = DRAFTS[i].book.editions[j].fields();
	// its covers and links stay on the edition kept
	const keys = Object.keys(fields).filter(k => !k.startsWith('img:') && k !== 'links');
	const label = (k: string) =>
		k.startsWith('ext:')
			? Edition.fieldLabel(k.slice(4))
			: (EDITION_FIELDS.find(([key]) => key === k) || [k, k])[1];
	return buildElement(
		'div',
		{class: 'editInline', id: `book-${i}-ed-${j}-panel`},
		buildElement('p', {}, 'Move to a new edition, or copy onto both:'),
		...keys.map(k =>
			buildElement(
				'div',
				{class: 'editSplitRow'},
				buildElement('span', {}, `${label(k)}: ${fields[k]}`),
				buildElement(
					'select',
					{id: `book-${i}-ed-${j}-split-${k.replace(/[^\w.-]/g, '-')}`, 'data-split': k},
					buildElement('option', {value: 'keep'}, 'keep here'),
					buildElement('option', {value: 'move'}, 'move'),
					buildElement('option', {value: 'copy'}, 'copy onto both'),
				),
			),
		),
		buildElement('p', {class: 'formError', id: `book-${i}-ed-${j}-split-error`}),
		buttonFor('Split', () => splitEdition(i, j), `book-${i}-ed-${j}-split-do`),
		buttonFor('Cancel', () => openPanel(i, j, null), `book-${i}-ed-${j}-cancel`),
	);
}

/** Remove: what it does, and whether imports may bring the edition back. */
function removePanel(i: number, j: number): HTMLElement {
	const ed = DRAFTS[i].book.editions[j];
	const entries = Exclusions.editionEntries(ed);
	return buildElement(
		'div',
		{class: 'editInline', id: `book-${i}-ed-${j}-panel`},
		buildElement('p', {}, 'Take this edition off the book? Its ids go with it.'),
		...(entries.length
			? [
					buildElement(
						'label',
						{class: 'editCheck'},
						buildElement('input', {type: 'checkbox', id: `book-${i}-ed-${j}-exclude`}),
						" Don't let imports add it again (the book still matches)",
					),
				]
			: []),
		buttonFor('Remove', () => removeEdition(i, j), `book-${i}-ed-${j}-remove-do`, 'removeBook'),
		buttonFor('Cancel', () => openPanel(i, j, null), `book-${i}-ed-${j}-cancel`),
	);
}

// ------------------------------------------------------------------ the other catalogs on a book
/** A link opening a catalog's page in a new tab. */
function outLink(href: string, text: string, catalog: string): HTMLAnchorElement {
	return buildElement(
		'a',
		{href, target: '_blank', rel: 'noopener', class: 'editOut'},
		catalogIcon(catalog),
		`${text} ↗`,
	);
}

/** The short mark each catalog's icon shows, by its group (any Audible site is Audible's). */
const CATALOG_MARKS: Record<string, string> = {
	audible: 'Au',
	amazon: 'Am',
	goodreads: 'Gr',
	hardcover: 'Hc',
	audiobookdb: 'AD',
	openlibrary: 'OL',
	isfdb: 'IS',
	bookbrainz: 'BB',
	wikidata: 'WD',
};

/** The catalogs whose site's `/favicon.ico` is broken: the icon their pages name instead, by group. */
const FAVICONS: Record<string, string> = {
	hardcover: 'https://assets.hardcover.app/static/favicon.ico',
};

/**
 * A small icon for an external catalog (`catalog`, its key or any of its sites'): its site's favicon, else
 * (when that can't be loaded) its mark in its own color, which CSS draws.
 */
export function catalogIcon(catalog: string): HTMLElement {
	const group = ExternalCatalog.groupOf(catalog)?.key || catalog;
	const home = ExternalCatalog.home(catalog);
	const src = FAVICONS[group] || (home && `${home}/favicon.ico`);
	const icon = buildElement('span', {
		class: src ? `catIcon cat-${group} favicon` : `catIcon cat-${group}`,
		'data-mark': CATALOG_MARKS[group] || group.slice(0, 2),
		'aria-hidden': 'true',
	});
	if (src)
		fillElement(
			icon,
			buildElement('img', {
				src,
				alt: '',
				referrerpolicy: 'no-referrer',
				decoding: 'async',
				onerror: () => {
					icon.classList.remove('favicon');
					fillElement(icon);
				},
			}),
		);
	return icon;
}

/** The icon of the catalog `label` names in this run (by its place), when it is one of them. */
function iconOfLabel(label: string): HTMLElement[] {
	const at = RUN ? RUN.labels.indexOf(label) : -1;
	return RUN && at >= 0 ? [catalogIcon(RUN.keys[at])] : [];
}

/**
 * Where the other catalogs have the book (links to their pages): the book on your shelves there, else the id
 * the book has there or that was found for it; and the catalogs that don't have it.
 */
function catalogLinks(d: Draft): Child[] {
	const run = RUN;
	const reviewed = run && run.review.books.get(d.id);
	if (!run || !reviewed) return [];
	const labels = run.labels;
	const seen: Set<string> = new Set();
	const links: Child[] = [];
	const link = (url: string | null, source: number) => {
		if (!url || seen.has(url)) return;
		seen.add(url);
		links.push(' · ', outLink(url, labels[source], run.keys[source]));
	};
	for (const entry of reviewed.entries) link(entry.url, entry.source);
	const missing: string[] = [];
	run.keys.forEach((key, source) => {
		if (reviewed.entries.some(e => e.source === source && e.url)) return;
		const found = d.book.idOn(key) ? d.book : run.idsFor(d.book, source);
		const id = found && found.idOn(key);
		if (id) link(ExternalCatalog.url(key, 'book', id), source);
		else if (reviewed.notFound.includes(source)) missing.push(labels[source]);
	});
	if (missing.length)
		links.push(' · ', buildElement('span', {class: 'editNotFound'}, `not found on ${missing.join(', ')}`));
	return links;
}

/**
 * What a catalog would add to a book: its book of yours taken in (`entry`, as an import would, with its
 * edition), else the ids and covers it found for it (`entry` null). `key` names it on the page.
 */
type Offer = {key: string; source: number; entry: CatalogEntry | null; after: Book};

/**
 * What the other catalogs would add to the book now, each once: each catalog's book of yours, else (for a
 * catalog with none to take) the ids and covers it found. Worked out from the book as it now is, so what is
 * taken is offered no more.
 */
function offersFor(d: Draft): Offer[] {
	const run = RUN;
	const reviewed = run && run.review.books.get(d.id);
	if (!run || !reviewed) return [];
	const out: Offer[] = [];
	const now = d.book.text();
	for (const entry of reviewed.entries) {
		const after = run.take(d.book, entry, true);
		if (after && after.text() !== now)
			out.push({key: `${entry.source}-${entry.at}`, source: entry.source, entry, after});
	}
	// a book of that catalog's to take brings its ids too: offered once, there
	for (const source of run.keys.keys()) {
		if (out.some(o => o.source === source)) continue;
		const after = run.idsFor(d.book, source);
		if (after && after.text() !== now) out.push({key: `${source}-ids`, source, entry: null, after});
	}
	return out;
}

/** The edition of `after` (an offer's book) that is `ed`, the book's `j`th: by its id, else by its place. */
function editionIn(after: Book, ed: Edition, j: number): Edition | undefined {
	return ed.id !== undefined ? after.editions.find(x => x.id === ed.id) : after.editions[j];
}

/** The editions an offer would add to the book: those of `after` that are none of the book's. */
function newEditionsOf(d: Draft, after: Book): Edition[] {
	const known = d.book.editions.map((ed, j) => editionIn(after, ed, j));
	return after.editions.filter(ed => !known.includes(ed));
}

/** What an offer changes on the book itself (not its editions), one line each. */
function bookPartChanges(d: Draft, after: Book): string[] {
	return bookChanges(d.book, bookPartOf(d, after));
}

/** The book with an offer's own values (title, people, series, genres, dates read, ids), its editions as they are. */
function bookPartOf(d: Draft, after: Book): Book {
	const out = after.clone();
	out.id = d.book.id;
	out.editions = d.book.clone().editions;
	return out;
}

/** The book with its `j`th edition as an offer has it. */
function withEditionOf(d: Draft, j: number, now: Edition): Book {
	const out = d.book.clone();
	const was = out.editions[j];
	const ed = now.clone();
	ed.id = was.id;
	out.editions[j] = ed;
	return out;
}

/** What an edition would be changed by, from the catalogs: each offer that changes it, with its lines. */
function editionOffers(d: Draft, j: number): {offer: Offer; lines: string[]; now: Edition}[] {
	const ed = d.book.editions[j];
	const out: {offer: Offer; lines: string[]; now: Edition}[] = [];
	for (const offer of offersFor(d)) {
		const now = editionIn(offer.after, ed, j);
		if (!now || now.format() === ed.format()) continue;
		out.push({offer, lines: editionFieldChanges(ed, now), now});
	}
	return out;
}

/** The notes that an edition may not be an audiobook, as the catalogs say (by the id or ISBN they name). */
function notAudioOf(d: Draft, ed: Edition): {source: number; note: NotAudio}[] {
	const reviewed = RUN && RUN.review.books.get(d.id);
	if (!reviewed) return [];
	const ids = [...Object.values(ed.external), ...(ed.isbn ? [ed.isbn] : [])];
	return reviewed.notAudio.filter(({note}) => ids.some(id => note.edition.split(/\s+/).includes(id)));
}

/** A catalog's line: its icon and what it would change, with Take. */
function offerRow(id: string, source: number, text: string, take: () => void, extra: Child[] = []): HTMLElement {
	const run = RUN as CatalogRun;
	return buildElement(
		'div',
		{class: 'editTake', id},
		buildElement('span', {}, catalogIcon(run.keys[source]), spell(`${run.labels[source]}: ${text}`)),
		...extra,
		buttonFor('Take', take, `${id}-do`),
	);
}

/**
 * What the other catalogs would change on the book itself (its ids, dates read, genres, ...), each with Take;
 * and the editions they would add, each with Add. What they would change on an edition is on its card.
 */
function catalogFinds(d: Draft, i: number): HTMLElement[] {
	const run = RUN;
	if (!run) return [];
	const out: HTMLElement[] = [];
	for (const offer of offersFor(d)) {
		const lines = bookPartChanges(d, offer.after);
		if (lines.length)
			out.push(
				offerRow(`book-${i}-take-${offer.key}`, offer.source, lines.join('; '), () => {
					d.book = bookPartOf(d, offer.after);
					renderBook(i);
				}),
			);
	}
	// a note that names none of its editions (as they are now) stays with the book
	const reviewed = run.review.books.get(d.id);
	const placed = new Set(d.book.editions.flatMap(ed => notAudioOf(d, ed).map(x => x.note)));
	for (const {source, note} of reviewed ? reviewed.notAudio : [])
		if (!placed.has(note)) out.push(notAudioNote(source, note));
	return out;
}

/** A catalog's note that an edition may not be an audiobook. */
function notAudioNote(source: number, note: NotAudio): HTMLElement {
	const run = RUN as CatalogRun;
	return buildElement(
		'p',
		{class: 'editNotAudio'},
		catalogIcon(run.keys[source]),
		spell(
			`Maybe not an audiobook: ${note.edition} is ${note.said}${note.maybe ? '' : ` on ${run.labels[source]}`}.`,
		),
		...(note.url ? [' ', outLink(note.url, run.labels[source], run.keys[source])] : []),
	);
}

/** The editions the other catalogs would add to the book, each with Add (an edition listed there may not be yours). */
function newEditionOffers(d: Draft, i: number): HTMLElement[] {
	const run = RUN;
	if (!run) return [];
	const out: HTMLElement[] = [];
	for (const offer of offersFor(d))
		newEditionsOf(d, offer.after).forEach((ed, k) => {
			const id = `book-${i}-new-${offer.key}-${k}`;
			out.push(
				buildElement(
					'div',
					{class: 'editTake editNewEdition', id},
					buildElement(
						'span',
						{},
						catalogIcon(run.keys[offer.source]),
						spell(`${run.labels[offer.source]} has another edition: ${editionName(ed).name}`),
						buildElement('span', {class: 'editEdMeta'}, ` ${ed.format()}`),
					),
					...coverPreviews(d.book, Book.fromJSON({t: d.book.title, a: d.book.authors, e: [ed.toJSON()]})),
					buttonFor(
						'Add',
						() => {
							d.book = d.book.clone();
							d.book.editions.push(ed.clone());
							renderBook(i);
						},
						`${id}-do`,
					),
				),
			);
		});
	return out;
}

/** In an edition's card: what the catalogs would change on it, each with Take, and their notes that it may not be an audiobook. */
function editionFinds(d: Draft, i: number, j: number): HTMLElement[] {
	const run = RUN;
	if (!run) return [];
	const ed = d.book.editions[j];
	return [
		...editionOffers(d, j).map(({offer, lines, now}) =>
			offerRow(
				`book-${i}-ed-${j}-take-${offer.key}`,
				offer.source,
				lines.join('; ') || 'a cover',
				() => {
					d.book = withEditionOf(d, j, now);
					renderBook(i);
				},
				coverPreviews(
					Book.fromJSON({t: d.book.title, a: d.book.authors, e: [ed.toJSON()]}),
					Book.fromJSON({t: d.book.title, a: d.book.authors, e: [now.toJSON()]}),
				),
			),
		),
		...notAudioOf(d, ed).map(({source, note}) => notAudioNote(source, note)),
	];
}

/** The marks on an edition's summary: what the catalogs would change on it, and whether it may not be an audiobook. */
function editionMarks(d: Draft, j: number): HTMLElement[] {
	const run = RUN;
	if (!run) return [];
	const ed = d.book.editions[j];
	const offers = editionOffers(d, j);
	const notAudio = notAudioOf(d, ed);
	const out: HTMLElement[] = [];
	if (offers.length) {
		const sources = [...new Set(offers.map(o => o.offer.source))];
		out.push(
			buildElement(
				'span',
				{
					class: 'editPill review',
					title: spell(`${sources.map(s => run.labels[s]).join(', ')} would change it`),
				},
				...sources.map(s => catalogIcon(run.keys[s])),
				spell('to review'),
			),
		);
	}
	if (notAudio.length)
		out.push(
			buildElement(
				'span',
				{class: 'editPill notAudio', title: spell('A catalog says it may not be an audiobook')},
				spell('not audio?'),
			),
		);
	return out;
}

/** The covers taking a catalog's ids would add to the book, to see before taking them. */
function coverPreviews(before: Book, after: Book): HTMLElement[] {
	const before_ = new Set(before.editions.flatMap(ed => Object.values(ed.covers)));
	const added = after.editions.flatMap(ed => Object.entries(ed.covers).filter(([, v]) => !before_.has(v)));
	const images = added
		.map(([catalog, key]) => {
			const only = Book.fromJSON({t: after.title, a: after.authors, e: [{img: {[catalog]: key}}]});
			return coverImage(only, 'small');
		})
		.filter((img): img is HTMLImageElement => img !== null);
	return images.length ? [buildElement('span', {class: 'editCovers'}, ...images)] : [];
}

/**
 * The editions the catalogs list for the book that you keep out of imports, behind a link: never taken, and
 * not used for the values offered.
 */
function excludedEditions(d: Draft): HTMLElement[] {
	const reviewed = RUN && RUN.review.books.get(d.id);
	if (!RUN || !reviewed) return [];
	const labels = RUN.labels;
	const seen: Set<string> = new Set();
	const rows: HTMLElement[] = [];
	for (const entry of reviewed.entries)
		for (const ed of entry.excluded) {
			const text = ed.format();
			if (seen.has(text)) continue;
			seen.add(text);
			const [site, id] = ed.externalList()[0] || [];
			const url = site && id ? ExternalCatalog.url(site, 'edition', id) : null;
			rows.push(
				buildElement(
					'li',
					{},
					`${text} (${labels[entry.source]})`,
					...(url ? [' ', outLink(url, ExternalCatalog.name(site as string), site as string)] : []),
				),
			);
		}
	if (!rows.length) return [];
	return [
		buildElement(
			'details',
			{class: 'editExcluded'},
			buildElement('summary', {}, Text.plural(rows.length, 'excluded edition')),
			buildElement(
				'p',
				{class: 'hint'},
				spell(
					'You keep these out of imports: nothing of theirs is taken or offered. Import & export lists them.',
				),
			),
			buildElement('ul', {}, ...rows),
		),
	];
}

// ------------------------------------------------------------------ the other catalogs on the page
/** The catalogs to ask, each ticked unless left out (remembered for the next run), and greyed when it can't be. */
function drawCatalogPicks(choices: CatalogChoice[], setSkipped: (catalog: string, skip: boolean) => void) {
	fillElement(
		byId('catalogPicks'),
		...choices.map(c =>
			buildElement(
				'label',
				{
					class: c.cantAsk ? 'editCheck cant' : 'editCheck',
					title: c.cantAsk ? spell(`${c.label} ${c.cantAsk}`) : '',
				},
				buildElement('input', {
					type: 'checkbox',
					id: `catalog-${c.catalog}`,
					checked: !c.skipped && !c.cantAsk,
					disabled: Boolean(c.cantAsk),
					onchange: (e: Event) => setSkipped(c.catalog, !(e.target as HTMLInputElement).checked),
				}),
				' ',
				catalogIcon(c.catalog),
				c.label,
				...(c.cantAsk ? [buildElement('span', {class: 'editWhy'}, spell(` (${c.cantAsk})`))] : []),
			),
		),
	);
}

/** What the catalogs read, and the ids they found. */
function drawCatalogFound() {
	const run = RUN;
	fillElement(byId('catalogNotes'), ...(run ? run.notes.map(n => buildElement('li', {}, spell(n))) : []));
	if (!run) return fillElement(byId('catalogFound'));
	fillElement(
		byId('catalogFound'),
		...run.review.infoIds.map(({source, ids}) =>
			buildElement(
				'label',
				{class: 'editCheck'},
				buildElement('input', {
					type: 'checkbox',
					id: `info-${source}`,
					checked: INFO_PICKS.has(source),
					onchange: (e: Event) => {
						if ((e.target as HTMLInputElement).checked) INFO_PICKS.add(source);
						else INFO_PICKS.delete(source);
						showChangeCount();
					},
				}),
				spell(
					` Keep the ids ${run.labels[source]} found for ${[...new Set(ids.map(x => x.name))].join(', ')} (where they have none)`,
				),
			),
		),
	);
}

/** The catalog `source` (by place) picks for a new book, when several have it: a select of them. */
function sourceSelect(
	id: string,
	from: {source: number}[],
	picked: number,
	pick: (source: number) => void,
	run: CatalogRun,
): HTMLElement {
	return buildElement(
		'select',
		{id, onchange: (e: Event) => pick(Number((e.target as HTMLSelectElement).value))},
		...from.map(f =>
			buildElement(
				'option',
				{value: String(f.source), selected: f.source === picked},
				`as ${run.labels[f.source]} has it`,
			),
		),
	);
}

/** A missing book's line: its number and title, and once read its authors. */
function missingLine(entry: {title: string; number?: string}, book: Book | null): string {
	const title = book ? book.title : entry.title;
	const number = book ? book.number || entry.number : entry.number;
	return `${number ? `${number}. ` : ''}${title}${book && book.authors.length ? ` by ${book.authors.join(', ')}` : ''}`;
}

/**
 * Pick a missing book to add as `source` has it: read from that catalog first when its comparison didn't
 * (only now that it is to be added). One that can't be read is unticked again, saying why.
 */
async function pickMissing(n: number, source: number) {
	const run = RUN;
	if (!run) return;
	MISSING_PICKS.set(n, {source, book: null});
	dropNew({kind: 'missing', n});
	drawNewBooks();
	let book: Book | null = null,
		problem = '';
	try {
		book = await run.missingBook(n, source);
		if (!book) problem = `${run.labels[source]} doesn't have it after all`;
	} catch (exc) {
		problem = Text.errorText(exc);
	}
	// unticked, or ticked as another catalog's, while it was read
	const now = MISSING_PICKS.get(n);
	if (RUN !== run || !now || now.source !== source || now.book) return;
	if (book) {
		MISSING_PICKS.set(n, {source, book});
		draftNew({kind: 'missing', n}, book);
	} else {
		MISSING_PICKS.delete(n);
		showIoStatus(
			spell(`Couldn't read ${run.review.missing[n].title} from ${run.labels[source]}: ${problem}`),
			true,
		);
	}
	drawNewBooks();
	showChangeCount();
}

/**
 * Draft a new book picked to add, as its catalog has it (in place of a draft of it as another catalog had it),
 * so its card shows every field.
 */
function draftNew(added: NewPick, theirs: Book) {
	dropNew(added);
	const book = theirs.clone();
	book.id = undefined;
	book.editions.forEach((ed, k) => (ed.id = NEW_EDITION + k));
	DRAFTS.push({id: '', before: book.clone(), book, error: '', added});
}

/** The draft of a new book picked to add; undefined when it is not picked (or not read yet). */
function newDraft(kind: NewPick['kind'], n: number): {d: Draft; i: number} | undefined {
	const i = DRAFTS.findIndex(d => d.added && d.added.kind === kind && d.added.n === n);
	return i < 0 ? undefined : {d: DRAFTS[i], i};
}

/** Drop the draft of a new book no longer picked (what the page has open on a draft after it, too). */
function dropNew(added: NewPick) {
	const found = newDraft(added.kind, added.n);
	if (!found) return;
	DRAFTS.splice(found.i, 1);
	if (OPEN_PANEL && Number(OPEN_PANEL.split(':')[0]) >= found.i) OPEN_PANEL = null;
}

/** Drop the drafts of every new book picked (the catalogs are asked again, or none is). */
function dropAllNew() {
	if (!DRAFTS.some(d => d.added)) return;
	DRAFTS = DRAFTS.filter(d => !d.added);
	OPEN_PANEL = null;
}

/** A new book's draft as it is added: without the ids its editions have only on the page. */
function addedBook(d: Draft): Book {
	const book = d.book.clone();
	book.id = undefined;
	for (const ed of book.editions) if (ed.id && ed.id.startsWith(NEW_EDITION)) ed.id = undefined;
	return book;
}

/** Draw the books again with the new ones among them, as a new book's tick or catalog changed. */
function drawNewBooks() {
	render();
}

/** The mark on a new book's card. */
const newTag = () => buildElement('span', {class: 'editNewTag'}, spell('Not in your catalog'));

/**
 * The books none of yours are, each a card with Add (and which catalog's, when several have it), with the
 * book it is for its place among yours: those on your shelves there, and the books of the series they list,
 * which are read only when ticked.
 */
function newCards(): {book: Book; card: HTMLElement}[] {
	const run = RUN;
	if (!run) return [];
	const name = KIND === 'series' ? shownName() : undefined;
	return [
		...run.review.fresh.map((book, n) => {
			const picked = FRESH_PICKS.get(n);
			const from = book.from.find(f => f.source === picked) || book.from[0];
			const pick = (source: number) => {
				const at = book.from.find(f => f.source === source);
				if (!at) return;
				FRESH_PICKS.set(n, source);
				draftNew({kind: 'fresh', n}, run.sources[source].result.incoming[at.at]);
				drawNewBooks();
				showChangeCount();
			};
			const theirs = run.sources[from.source].result.incoming[from.at];
			const drafted = newDraft('fresh', n);
			const card = buildElement(
				'div',
				{class: picked === undefined ? 'editNew' : 'editNew picked', id: `fresh-${n}`},
				newTag(),
				buildElement(
					'label',
					{class: 'editCheck'},
					buildElement('input', {
						type: 'checkbox',
						id: `fresh-${n}-add`,
						checked: picked !== undefined,
						onchange: (e: Event) => {
							if ((e.target as HTMLInputElement).checked) pick(from.source);
							else {
								FRESH_PICKS.delete(n);
								dropNew({kind: 'fresh', n});
								drawNewBooks();
								showChangeCount();
							}
						},
					}),
					` Add ${from.line}`,
				),
				book.from.length > 1
					? sourceSelect(`fresh-${n}-from`, book.from, from.source, pick, run)
					: buildElement('span', {class: 'hint'}, ` (${run.labels[from.source]})`),
				// picked, the book's whole form, as the catalog has it, to change before it is added
				...(drafted ? [bookCard(drafted.d, drafted.i)] : []),
			);
			return {book: theirs, card};
		}),
		...run.review.missing.map((entry, n) => {
			const picked = MISSING_PICKS.get(n);
			const from = entry.from.find(f => f.source === picked?.source) || entry.from[0];
			const reading = !!picked && !picked.book;
			const drafted = newDraft('missing', n);
			const book = Book.fromJSON({
				t: entry.title,
				a: [],
				...(name !== undefined ? {s: name} : {}),
				...(entry.number ? {sn: entry.number} : {}),
			});
			const card = buildElement(
				'div',
				{class: picked ? 'editNew picked' : 'editNew', id: `missing-${n}`},
				newTag(),
				buildElement(
					'label',
					{class: 'editCheck'},
					buildElement('input', {
						type: 'checkbox',
						id: `missing-${n}-add`,
						checked: !!picked,
						onchange: (e: Event) => {
							if ((e.target as HTMLInputElement).checked) void pickMissing(n, from.source);
							else {
								MISSING_PICKS.delete(n);
								dropNew({kind: 'missing', n});
								drawNewBooks();
								showChangeCount();
							}
						},
					}),
					` Add ${missingLine(entry, picked?.book || null)}`,
				),
				entry.from.length > 1
					? sourceSelect(
							`missing-${n}-from`,
							entry.from,
							from.source,
							source => void pickMissing(n, source),
							run,
						)
					: null,
				from.url ? outLink(from.url, run.labels[from.source], run.keys[from.source]) : null,
				reading
					? buildElement('span', {class: 'hint'}, spell(`Reading it from ${run.labels[from.source]}…`))
					: null,
				...(drafted ? [bookCard(drafted.d, drafted.i)] : []),
			);
			return {book, card};
		}),
	];
}

/**
 * Ask the other catalogs about the books shown: each ticked one that can be asked, in turn. The page holds
 * the whole catalog from then on, as a catalog's book may be one outside the series.
 */
export function askCatalogs(): Promise<void> {
	ASKING = (async () => {
		const name = shownName();
		if (name === undefined) return;
		const catalogs = await import('./edit-catalogs.js');
		const choices = catalogs.catalogChoices(KIND);
		drawCatalogPicks(choices, catalogs.setSkipped);
		const asked = choices.filter(c => !c.cantAsk && !c.skipped);
		if (!asked.length) {
			RUN = null;
			dropAllNew();
			render();
			drawCatalogFound();
			if (KIND === 'series') drawSeriesChips();
			fillElement(
				byId('catalogNotes'),
				buildElement(
					'li',
					{},
					spell(
						choices.some(c => !c.cantAsk)
							? 'No catalog is ticked: tick one, and Ask again.'
							: 'No catalog can be asked yet: save your server or a key on Import & export.',
					),
				),
			);
			return;
		}
		await wholeCatalog();
		RUN = await catalogs.runCatalogs(
			KIND,
			name,
			DRAFTS.filter(d => !d.added).map(d => d.id),
		);
		FRESH_PICKS = new Map();
		MISSING_PICKS = new Map();
		INFO_PICKS = new Set();
		dropAllNew();
		drawCatalogFound();
		render();
		if (KIND === 'series') drawSeriesChips();
	})();
	return ASKING;
}

/** The other catalogs' names for the series, under its name. */
function drawSeriesChips() {
	const choices = DRAFTS.flatMap(d => choicesFor(d, null, null, 's'));
	const merged: FieldChoices[] = [];
	for (const f of choices)
		for (const c of f.choices) {
			const had = merged.flatMap(x => x.choices).find(x => Text.norm(x.text) === Text.norm(c.text));
			if (had) had.labels = [...new Set([...had.labels, ...c.labels])];
			else merged.push({...f, choices: [{...c}]});
		}
	fillElement(
		byId('sf_nameChips'),
		...choiceChips('sf_name', fieldById('sf_name').value, merged, () => {
			showChangeCount();
			drawSeriesChips();
		}),
	);
}

/** Draw the books again, and how many changes there are. */
export function render() {
	// your books (where they were when the page opened, so a card doesn't move as its number is typed) and the
	// new ones, in series order
	// (a new book picked is drawn in its new book's card)
	const cards = [
		...DRAFTS.flatMap((d, i) => (d.added ? [] : [{book: d.before, card: bookCard(d, i)}])),
		...newCards(),
	].sort((x, y) => bookOrder(x.book, y.book));
	// a card opened or closed stays so when the books are drawn again (an id added to an edition, say)
	const list = byId('editBooks');
	const wasOpen = new Map(
		[...list.querySelectorAll('details[id]')].map(el => [el.getAttribute('id'), el.hasAttribute('open')]),
	);
	fillElement(list, ...cards.map(c => c.card));
	for (const el of list.querySelectorAll('details[id]')) {
		const open = wasOpen.get(el.getAttribute('id'));
		if (open === true) el.setAttribute('open', '');
		else if (open === false) el.removeAttribute('open');
	}
	DRAFTS.forEach((d, k) => fillExternalFields(inputId(k, null, 'ext_'), 'book', d.book.external));
	const own = DRAFTS.filter(d => !d.added).length;
	byId('bookCount').textContent = own ? Text.plural(own, 'book') : '';
	showChangeCount();
}

/**
 * Draw the books again after Merge, Split or Remove, or a field that needs inputs of its own: every field
 * read already is in the drafts, so nothing typed is lost; the books' ids are put back in their fields.
 */
function renderBook(i: number) {
	render();
	const card = document.getElementById(`book-${i}`);
	if (card) card.scrollIntoView({block: 'nearest'});
}

function showChangeCount() {
	const n = changes().length;
	byId('changeCount').textContent = n ? Text.plural(n, 'change') : 'No changes yet';
}

// ------------------------------------------------------------------ reading what is typed
/**
 * Read a book's fields into its draft; a field that can't be read is named on the book, and leaves the
 * draft as it was.
 */
export function readBookFields(i: number) {
	const d = DRAFTS[i];
	const value = (k: string) => fieldById(inputId(i, null, k)).value;
	const problems: string[] = [];
	const title = Text.tidy(value('t'));
	const authors = Text.splitNames(value('a'));
	if (!title) problems.push('A book needs a title.');
	if (!authors.length) problems.push('A book needs an author.');
	const {dates, bad} = Text.parseDates(value('r'));
	if (bad.length) problems.push(`Not a date: ${bad.join(', ')}. Use YYYY-MM-DD, or YYYY-MM / YYYY.`);
	const external = readExternalFields(inputId(i, null, 'ext_'), 'book', d.book.external);
	if (external.bad.length) problems.push(`Not a book's id or address there: ${external.bad.join('; ')}.`);
	d.error = problems.join(' ');
	byId(`book-${i}-error`).textContent = d.error;
	if (problems.length) return showChangeCount();
	const b = d.book;
	b.title = title;
	b.authors = authors;
	if (KIND === 'author') b.series = Text.tidy(value('s')) || undefined;
	const number = Text.tidy(value('sn'));
	b.number = number || undefined;
	b.genres = value('g')
		.split(',')
		.map(x => x.trim())
		.filter(Boolean);
	b.read = dates;
	b.external = external.ids;
	b.links = Text.parseLinks(value('links'));
	markFields(i);
}

/**
 * An edition's page on a catalog typed among its links (an Audible or Goodreads edition, say) goes to its id
 * field on the card, when that is empty or holds the same id, else to Another id when that is empty; the
 * edition is then read again. Other links stay.
 */
function editionLinksToIds(i: number, j: number) {
	const card = byId(`book-${i}-ed-${j}`);
	const input = (key: string) => card.querySelector(`[data-key="${key}"]`) as HTMLInputElement | null;
	const links = input('links');
	if (!links) return;
	const kept: string[] = [];
	let moved = false;
	for (const line of links.value.split(/\r\n|\r|\n/)) {
		const found = line.trim() ? Edition.idFromAddress(line.trim()) : null;
		const into =
			found &&
			[input(found.field), input('more')].find(
				x => x && (!Text.tidy(x.value) || Text.tidy(x.value) === found.id),
			);
		if (found && into) {
			into.value = into === input('more') ? line.trim() : found.id;
			// an address names its own catalog
			const catalog = document.getElementById(inputId(i, j, 'more-catalog')) as HTMLSelectElement | null;
			if (into === input('more') && catalog) catalog.value = '';
			moved = true;
		} else kept.push(line);
	}
	if (!moved) return;
	links.value = kept.join('\n').trim();
	readEditionFields(i, j);
}

/**
 * Read an edition's fields into the draft: a field that can't be read is named under the edition, and
 * leaves it as it was. Several ISBNs make that many editions.
 */
export function readEditionFields(i: number, j: number) {
	const d = DRAFTS[i];
	const ed = d.book.editions[j];
	const card = byId(`book-${i}-ed-${j}`);
	const typed: Record<string, string> = {};
	for (const [k, v] of Object.entries(ed.fields())) if (k.startsWith('img:')) typed[k] = v; // its covers stay
	const problems: string[] = [];
	for (const input of card.querySelectorAll('[data-key]') as unknown as HTMLInputElement[]) {
		const k = input.getAttribute('data-key') as string;
		if (k !== 'more') {
			typed[k] = input.value;
			continue;
		}
		const text = Text.tidy(input.value);
		if (!text) continue;
		// a bare id is read as the picked catalog's; without one, it must be an address
		const catalog = (document.getElementById(inputId(i, j, 'more-catalog')) as HTMLSelectElement | null)?.value;
		const found = catalog
			? ExternalCatalog.readId(text, 'edition', catalog)
			: ExternalCatalog.fromAddress(text, 'edition');
		if (found && Text.tidy(typed['ext:' + found.catalog] || ''))
			problems.push(`It has an id on ${ExternalCatalog.name(found.catalog)} already: ${text}.`);
		else if (found) typed['ext:' + found.catalog] = found.id;
		else if (catalog) problems.push(`Not an edition's id on ${ExternalCatalog.name(catalog)}: ${text}.`);
		else problems.push(`Not an edition's address: ${text}. For a bare id, pick its catalog.`);
	}
	// a publisher the edition or the catalog has stays whole, though its name holds a comma
	const read = Edition.fromFields(typed, [...ed.publishers, ...CATALOG.namesOf('publishers')]);
	if (read.bad.length) problems.push(`Not understood: ${read.bad.join('; ')}.`);
	if (!problems.length && !read.editions.length)
		problems.push('An edition needs something, such as an id or a narrator. To take it off, press Remove edition.');
	const error = byId(`book-${i}-ed-${j}-error`);
	error.textContent = problems.join(' ');
	if (problems.length) return;
	const [first, ...more] = read.editions;
	first.id = ed.id;
	if (first.title && Book.sameTitle(first.title, d.book.title)) first.title = undefined;
	d.book.editions = [...d.book.editions.slice(0, j), first, ...more, ...d.book.editions.slice(j + 1)];
	for (const [catalog, id] of Object.entries(read.book))
		if (!d.book.idOn(catalog)) d.book.external = {...d.book.external, [catalog]: id};
	// an id typed into Another id, an id emptied, or a second ISBN changes the inputs the edition needs
	const idKeys = (x: Record<string, string>) =>
		Object.keys(x)
			.filter(k => k.startsWith('ext:') && x[k])
			.sort()
			.join(' ');
	const shown = Object.fromEntries(
		[...card.querySelectorAll('[data-key]')].map(el => [el.getAttribute('data-key'), 'x']),
	) as Record<string, string>;
	if (more.length || typed.more || idKeys(first.fields()) !== idKeys(shown)) renderBook(i);
	else {
		fillElement(card.querySelector('summary') as HTMLElement, ...editionSummary(d, first));
		markFields(i);
	}
}

/** Mark a book's card, and its fields, as changed or not, without drawing the fields again. */
function markFields(i: number) {
	const d = DRAFTS[i];
	const card = byId(`book-${i}`);
	card.classList.toggle('changed', d.book.text() !== d.before.text());
	for (const [k] of bookFields()) {
		const input = fieldById(inputId(i, null, k));
		const box = input.closest('.editField');
		if (box) box.classList.toggle('changed', input.value !== bookFieldText(d.before, k));
	}
	const links = fieldById(inputId(i, null, 'links')).closest('.linksField');
	if (links) links.classList.toggle('changed', d.book.links.join(' ') !== d.before.links.join(' '));
	showChangeCount();
}

// ------------------------------------------------------------------ editions changed
function openPanel(i: number, j: number, what: string | null) {
	OPEN_PANEL = what === null ? null : `${i}:${j}:${what}`;
	renderBook(i);
	const card = document.getElementById(`book-${i}-ed-${j}`);
	if (card) card.setAttribute('open', '');
}

export function mergeEditions(i: number, j: number, k: number) {
	OPEN_PANEL = null;
	try {
		DRAFTS[i].book.mergeEditions([j, k]);
	} catch (exc) {
		showIoStatus(Text.errorText(exc), true);
		return;
	}
	renderBook(i);
}

export function splitEdition(i: number, j: number) {
	const move: string[] = [],
		copy: string[] = [];
	for (const select of byId(`book-${i}-ed-${j}-panel`).querySelectorAll('select') as unknown as HTMLSelectElement[]) {
		const k = select.getAttribute('data-split') as string;
		if (select.value === 'move') move.push(k);
		if (select.value === 'copy') copy.push(k);
	}
	try {
		DRAFTS[i].book.splitEdition(j, move, copy);
	} catch (exc) {
		byId(`book-${i}-ed-${j}-split-error`).textContent = Text.errorText(exc);
		return;
	}
	OPEN_PANEL = null;
	renderBook(i);
}

export function removeEdition(i: number, j: number) {
	const box = document.getElementById(`book-${i}-ed-${j}-exclude`) as HTMLInputElement | null;
	const ed = DRAFTS[i].book.removeEdition(j);
	if (box && box.checked) EXCLUDE = [...new Set([...EXCLUDE, ...Exclusions.editionEntries(ed)])];
	OPEN_PANEL = null;
	renderBook(i);
}

/** + Add an edition: an empty one, which needs a field filled in before Save. */
function addEdition(i: number) {
	const d = DRAFTS[i];
	d.book.editions = [...d.book.editions, new Edition()];
	renderBook(i);
	const card = document.getElementById(`book-${i}-ed-${d.book.editions.length - 1}`);
	if (card) card.setAttribute('open', '');
}

// ------------------------------------------------------------------ what Save would do
/**
 * What changed on a book, one line each: its fields, and each edition's (added, removed or changed).
 */
export function bookChanges(before: Book, after: Book, excluded: string[] = []): string[] {
	const out: string[] = [];
	const from = (was: string, now: string) => (was ? `${was} → ${now || '(empty)'}` : now);
	for (const [k, label] of BOOK_FIELDS) {
		const was = bookFieldText(before, k),
			now = bookFieldText(after, k);
		if (was !== now) out.push(`${label}: ${from(was, now)}`);
	}
	const ids = (b: Book) =>
		Object.entries(b.external)
			.map(([k, v]) => `${ExternalCatalog.name(k)} ${v}`)
			.join(', ');
	if (ids(before) !== ids(after)) out.push(`Ids: ${from(ids(before), ids(after))}`);
	if (before.links.join(' ') !== after.links.join(' '))
		out.push(`Links: ${from(before.links.join(' '), after.links.join(' '))}`);
	const kept = new Set(after.editions.map(ed => ed.id).filter(id => id !== undefined));
	for (const ed of before.editions) {
		if (ed.id !== undefined && kept.has(ed.id)) continue;
		const out_ = Exclusions.editionEntries(ed).some(e => excluded.includes(e)) ? ', and kept out of imports' : '';
		out.push(`Removed edition: ${editionName(ed).name}${out_}`);
	}
	for (const ed of after.editions) {
		const was = ed.id === undefined ? undefined : before.editions.find(x => x.id === ed.id);
		if (!was) {
			out.push(`New edition: ${ed.format() || '(empty)'}`);
			continue;
		}
		if (was.format() === ed.format()) continue;
		out.push(`Edition ${editionName(was).name}: ${editionFieldChanges(was, ed).join('; ') || 'a cover'}`);
	}
	return out;
}

/** What changed on an edition, one line per field (a cover alone, none). */
function editionFieldChanges(was: Edition, ed: Edition): string[] {
	const from = (x: string, now: string) => (x ? `${x} → ${now || '(empty)'}` : now);
	const a = was.fields(),
		b = ed.fields();
	return [...new Set([...Object.keys(a), ...Object.keys(b)])]
		.filter(k => !k.startsWith('img:') && (a[k] || '') !== (b[k] || ''))
		.map(k => {
			const label = k.startsWith('ext:')
				? Edition.fieldLabel(k.slice(4))
				: (EDITION_FIELDS.find(([key]) => key === k) || [k, k])[1];
			return `${label}: ${from(a[k] || '', b[k] || '')}`;
		});
}

/** Every change on the page, as [what it is on, the change]. */
export function changes(): [string, string][] {
	const out: [string, string][] = [];
	const name = SERIES_ID === null ? undefined : CATALOG.nameOf('series', SERIES_ID);
	if (name !== undefined) for (const line of seriesChanges(name)) out.push([name, line]);
	for (const d of DRAFTS)
		if (!d.added) for (const line of bookChanges(d.before, d.book, EXCLUDE)) out.push([d.book.title, line]);
	const run = RUN;
	if (run) {
		// a new book, then what was changed on it before it is added
		const added = (kind: NewPick['kind'], n: number, line: string) => {
			const d = newDraft(kind, n)?.d;
			const changed = d ? bookChanges(d.before, d.book, []) : [];
			out.push([spell('New book'), changed.length ? `${line}, changed here` : line]);
			if (d) for (const c of changed) out.push([d.book.title, c]);
		};
		for (const [n, source] of FRESH_PICKS) {
			const from = run.review.fresh[n] && run.review.fresh[n].from.find(f => f.source === source);
			if (from) added('fresh', n, `${from.line}, as ${run.labels[source]} has it`);
		}
		for (const [n, {source, book}] of MISSING_PICKS)
			if (book && run.review.missing[n])
				added('missing', n, `${missingLine(run.review.missing[n], book)}, as ${run.labels[source]} has it`);
		for (const source of INFO_PICKS)
			out.push([run.labels[source], spell('Keep the ids it found for the series and people')]);
	}
	return out;
}

/** The name of the series or author whose books are shown; undefined when there is none. */
function shownName(): string | undefined {
	if (KIND === 'author') return AUTHOR_ID === null ? undefined : CATALOG.nameOf('authors', AUTHOR_ID);
	return SERIES_ID === null ? undefined : CATALOG.nameOf('series', SERIES_ID);
}

/** The page the Edit page came from: the series', or the author's. */
function returnHref(): string | null {
	if (KIND === 'author') return AUTHOR_ID === null ? null : creditPageHref('authors', AUTHOR_ID);
	return SERIES_ID === null ? null : seriesPageHref(SERIES_ID);
}

/** What the series panel changes on the series, one line each. */
function seriesChanges(name: string): string[] {
	const info = SERIES_ID === null ? undefined : CATALOG.series.get(SERIES_ID);
	const out: string[] = [];
	const newName = Text.tidy(fieldById('sf_name').value);
	if (newName && newName !== name) out.push(`Renamed to ${newName}`);
	const total = fieldById('sf_total').value.trim(),
		wasTotal = info ? totalText(info) : '';
	if (total !== wasTotal) out.push(`Books released: ${total || '(empty)'}`);
	const status = fieldById('sf_status').value,
		wasStatus = (info && String(info.toJSON().status ?? '')) || 'ongoing'; // as the panel shows it
	if (status !== wasStatus && (total || wasTotal || info)) out.push(`Status: ${status}`);
	const note = Text.tidy(fieldById('sf_note').value);
	if (note !== (info ? info.note || '' : '')) out.push(`Note: ${note || '(empty)'}`);
	const ext = readExternalFields('sf_ext_', 'series', info ? info.external : {});
	const shown = (ids: Record<string, string>) => JSON.stringify(ExternalCatalog.order(ids) || {});
	if (ext.bad.length || shown(ext.ids) !== shown(info ? info.external : {})) out.push('Its ids in other catalogs');
	const links = Text.parseLinks(fieldById('sf_links').value).join(' ');
	if (links !== (info ? info.links.join(' ') : '')) out.push(`Links: ${links || '(empty)'}`);
	return out;
}

/**
 * The series as its panel has it, checked as Check would: null and the problem named under the panel when
 * it can't be saved; `entry` null when every field is empty (it then keeps no info).
 */
async function readSeriesPanel(): Promise<{newName: string; entry: Series | null; note: string} | null> {
	const id = SERIES_ID;
	const name = id === null ? undefined : CATALOG.nameOf('series', id);
	if (id === null || name === undefined) return null;
	const showError = (text: string) => {
		byId('seriesFormError').textContent = text;
		return null;
	};
	byId('seriesFormError').textContent = '';
	if (!Text.tidy(fieldById('sf_name').value)) return showError('Give the series a name.');
	// unchanged, it is kept as it is (Check may find fault with what it had: that is Check's to say)
	if (!seriesChanges(name).length) return {newName: name, entry: CATALOG.series.get(id) ?? null, note: ''};
	// a Hardcover address is looked up for its number first
	const lookup = lookupHardcoverField('sf_ext_', 'series');
	const hardcover = lookup ? await lookup : {error: '', note: ''};
	if (hardcover.error) return showError(hardcover.error);
	const newName = Text.tidy(fieldById('sf_name').value);
	if (!newName) return showError('Give the series a name.');
	const totalTyped = fieldById('sf_total').value.trim();
	const note = Text.tidy(fieldById('sf_note').value);
	const had = CATALOG.series.get(id);
	const external = readExternalFields('sf_ext_', 'series', had ? had.external : {});
	if (external.bad.length) return showError(`Not an id or address there: ${external.bad.join('; ')}.`);
	const links = Text.parseLinks(fieldById('sf_links').value);
	// a series needs none of these; with all of them empty, it keeps none
	if (!(totalTyped || note || Object.keys(external.ids).length || links.length))
		return {newName, entry: null, note: hardcover.note};
	// unchecked as typed: the Check below says what is wrong with the total or status
	const typed: Record<string, unknown> = {
		...(totalTyped ? {total: /^\d+$/.test(totalTyped) ? parseInt(totalTyped, 10) : totalTyped.toLowerCase()} : {}),
		status: fieldById('sf_status').value,
		note,
	};
	if (Object.keys(external.ids).length) typed.ext = ExternalCatalog.order(external.ids);
	if (links.length) typed.links = links;
	const {errors} = Validator.validate(JSON.parse(JSON.stringify(CATALOG.books)), {[name]: typed});
	const problems = errors
		.filter(e => e.startsWith('series-info'))
		.map(e => e.replace(/^series-info(\[[^\]]*\])?: /, ''));
	if (problems.length) return showError(problems.join('; '));
	return {newName, entry: Series.fromJSON(newName, typed), note: hardcover.note};
}

/** The problems that stop a book from being saved, as Check finds them on its editions. */
function bookProblems(b: Book): string[] {
	if (b.editions.some(ed => !ed.format())) return ['An edition is empty: fill it in, or remove it.'];
	const editions = b.editions.length ? {e: JSON.parse(JSON.stringify(b.editions))} : {}; // a book may have none
	return Validator.validate([{t: b.title, a: b.authors, ...editions}], {}).errors.map(e =>
		e.includes(' edition #') ? e.slice(e.indexOf(' edition #') + 1) : e,
	);
}

// ------------------------------------------------------------------ Review & save
/** Review & save: every change, listed, with Save; nothing when something can't be saved. */
export async function review() {
	const panel = byId('reviewPanel');
	setReviewing(false);
	const unread = unreadField();
	if (unread) return showProblem(unread, 'Some fields are not understood: they are marked on their books.');
	for (const [i, d] of DRAFTS.entries()) {
		const problems = bookProblems(d.book);
		byId(`book-${i}-error`).textContent = problems.join('; ');
		if (problems.length) return showProblem(byId(`book-${i}-error`), `${d.book.title}: ${problems.join('; ')}`);
	}
	const series = KIND === 'series' ? await readSeriesPanel() : null;
	if (KIND === 'series' && !series) return showProblem(byId('seriesFormError'));
	const name = shownName();
	if (name === undefined) return;
	const lines = changes();
	if (series && series.newName !== name) {
		await loadRecords({seriesNamed: [series.newName]});
		if (CATALOG.nameIds.series.has(series.newName))
			lines.unshift([
				name,
				`There is already a series called ${series.newName}: these books move into it` +
					(series.entry && CATALOG.seriesInfo(series.newName)
						? ', and its total, status, note and ids are replaced by these.'
						: '.'),
			]);
	}
	fillElement(
		byId('reviewList'),
		...(lines.length
			? lines.map(([on, line]) => buildElement('li', {}, buildElement('b', {}, on), ': ', line))
			: [buildElement('li', {}, 'Nothing changed.')]),
	);
	(byId('reviewSaveBtn') as HTMLButtonElement).disabled = !lines.length;
	setReviewing(true);
	panel.scrollIntoView({behavior: 'smooth', block: 'center'});
}

/**
 * Open or close the review: while it is open the fields can't be changed (`inert`), so Save saves what the
 * review lists; Back closes it to edit again.
 */
function setReviewing(open: boolean) {
	byId('reviewPanel').classList.toggle('open', open);
	for (const part of ['seriesPanel', 'catalogPanel', 'editBooks', 'saveBar']) {
		if (open) byId(part).setAttribute('inert', '');
		else byId(part).removeAttribute('inert');
	}
}

/** The first problem shown under a book or an edition whose fields can't be read, or null when there is none. */
function unreadField(): HTMLElement | null {
	for (const [i, d] of DRAFTS.entries()) {
		if (d.error) return byId(`book-${i}-error`);
		for (const j of d.book.editions.keys()) {
			const error = document.getElementById(`book-${i}-ed-${j}-error`);
			if (error && error.textContent) return error;
		}
	}
	return null;
}

/** Why Review & save stopped: in the status line, and the problem it names scrolled into view. */
function showProblem(at: HTMLElement, status?: string) {
	if (status) showIoStatus(status, true);
	at.scrollIntoView({behavior: 'smooth', block: 'center'});
}

/** Save: the books, the exclusions, then the series' rename and info. */
export async function save() {
	setReviewing(false);
	const series = KIND === 'series' ? await readSeriesPanel() : null;
	const name = shownName();
	if ((KIND === 'series' && !series) || name === undefined) return;
	// a box set's edition changed here changes on its other books too, so they are loaded first
	const keys = [
		...new Set(DRAFTS.filter(d => !d.added).flatMap(d => d.book.editions.flatMap(ed => ed.idAndIsbnKeys()))),
	];
	if (keys.length) await loadRecords({editionKeys: keys});
	let saved = 0,
		others = 0;
	for (const d of DRAFTS) {
		if (d.added || d.book.text() === d.before.text()) continue;
		if (!CATALOG.book(d.id)) continue; // removed in another tab meanwhile
		others += CATALOG.saveBook(d.id, d.book.clone());
		saved++;
	}
	const excluded = EXCLUDE.length ? CATALOG.addExclusions(EXCLUDE) : 0;
	// the new books picked, as changed on the page from what their catalog has (the page holds the whole catalog
	// once it asked one)
	let added = 0;
	const run = RUN;
	if (run)
		for (const [n, source] of FRESH_PICKS) {
			const d = newDraft('fresh', n)?.d;
			added += (run.addFresh(n, source, d && addedBook(d))?.added || []).length;
		}
	if (run)
		for (const [n, {book}] of MISSING_PICKS) {
			const d = newDraft('missing', n)?.d;
			if (book) added += run.addMissing(d ? addedBook(d) : book).added.length;
		}
	const parts: string[] = [];
	let newId: string | null = null;
	if (series) {
		const renamed = series.newName !== name;
		if (renamed) await loadRecords({seriesNamed: [series.newName]});
		const joins = renamed && CATALOG.nameIds.series.has(series.newName);
		const count = renamed ? CATALOG.renameEntry('series', name, series.newName) : 0;
		newId = CATALOG.idFor('series', series.newName);
		if (series.entry) CATALOG.series.set(newId, series.entry);
		else if (!joins) CATALOG.series.delete(newId);
		if (renamed) parts.push(`Renamed ${name} to ${series.newName} on ${Text.plural(count, 'book')}`);
	}
	// after the series' own info, which the panel replaces: these fill in only what it lacks
	let infoIds = 0;
	if (run) for (const source of INFO_PICKS) infoIds += run.keepInfoIds(source);
	await persist();
	parts.push(
		...[
			saved ? `saved ${Text.plural(saved, 'book')}` : '',
			others ? `updated the shared edition on ${Text.plural(others, 'other book')}` : '',
			added ? `added ${Text.plural(added, 'book')}` : '',
			excluded ? `kept ${Text.plural(excluded, 'edition id')} out of imports` : '',
			infoIds ? `kept ids found for ${Text.plural(infoIds, 'series or person', 'series and people')}` : '',
		].filter(Boolean),
	);
	if (newId !== null && newId !== SERIES_ID) {
		SERIES_ID = newId;
		setAddress('replace', '#series=' + hashValue(newId));
	}
	await loadShown();
	const status =
		(parts.length
			? parts.join(', ').replace(/^./, c => c.toUpperCase()) + '.'
			: `Saved ${series ? series.newName : name}.`) + (series && series.note ? ' ' + series.note : '');
	showIoStatus(status);
	const back = returnHref();
	if (back) openWithStatus(back, status);
}

/** Discard: nothing is saved, and the series' (or author's) page opens again. */
function discard() {
	const back = returnHref();
	if (back === null) return;
	void loadShown();
	location.assign(back);
}

/**
 * Remove series: the first press says what it does, the second takes the series off its books (they keep
 * everything else, but their number in it) and removes it, then goes to every series.
 */
async function removeSeries() {
	const id = SERIES_ID,
		name = id === null ? undefined : CATALOG.nameOf('series', id);
	if (id === null || name === undefined) return;
	if (changes().length) {
		byId('seriesFormError').textContent = 'Save or discard the changes first.';
		return;
	}
	const count = CATALOG.booksOf('series', id).length;
	if (!REMOVING_SERIES) {
		REMOVING_SERIES = true;
		byId('seriesFormError').textContent =
			(count
				? `This takes ${name} off its ${Text.plural(count, 'book')}, which stay in the catalog without a series or a number in it, and removes the series.`
				: `This removes ${name}, which no book is in.`) + ' Press Remove series again to do it.';
		return;
	}
	CATALOG.removeEntry('series', id);
	await persist();
	location.replace('index.html');
}

// ------------------------------------------------------------------ loading
/** Load the series' or the author's books, and draw them as stored. */
export async function loadShown() {
	if (KIND === 'author') await loadAuthor();
	else await loadSeries();
}

/** The order of the books shown: by series number (an author's by series first, then number). */
function bookOrder(x: Book, y: Book): number {
	if (KIND === 'series') return Book.bySeriesNumber(x, y);
	return (
		(x.series || '\uffff').localeCompare(y.series || '\uffff') ||
		Book.bySeriesNumber(x, y) ||
		x.title.localeCompare(y.title)
	);
}

/** Start the drafts from the books as they are now, nothing picked from the other catalogs. */
function startDrafts(books: Book[]) {
	EXCLUDE = [];
	OPEN_PANEL = null;
	FRESH_PICKS = new Map();
	MISSING_PICKS = new Map();
	INFO_PICKS = new Set();
	setReviewing(false);
	DRAFTS = books.map(b => ({id: b.id as string, before: b.clone(), book: b.clone(), error: ''}));
	render();
	drawCatalogFound();
}

/** Load the series and its books, and draw them as stored. */
export async function loadSeries() {
	const id = SERIES_ID;
	if (id === null) return;
	await loadRecords({seriesBooks: [id], series: [id]});
	const name = CATALOG.nameOf('series', id);
	if (name === undefined) {
		byId('subtitle').textContent = spell('There is no such series in the catalog.');
		DRAFTS = [];
		render();
		return;
	}
	const info = CATALOG.series.get(id);
	document.title = `Edit ${name}` + spell(' · Audiobook Catalog');
	byId('subtitle').textContent = name;
	byId('backLink').setAttribute('href', seriesPageHref(id));
	byId('backLink').textContent = '← ' + name;
	fieldById('sf_name').value = name;
	fieldById('sf_total').value = info ? totalText(info) : '';
	fieldById('sf_status').value = info ? String(info.toJSON().status ?? '') || 'ongoing' : 'ongoing';
	fieldById('sf_note').value = info ? info.note || '' : '';
	fillExternalFields('sf_ext_', 'series', info ? info.external : {});
	fieldById('sf_links').value = info ? info.links.join('\n') : '';
	byId('seriesFormError').textContent = '';
	REMOVING_SERIES = false;
	startDrafts(CATALOG.booksOf('series', id).slice().sort(bookOrder));
	drawSeriesChips();
}

/** Load the author's books (those that credit them as an author), and draw them as stored, by series. */
export async function loadAuthor() {
	const id = AUTHOR_ID;
	if (id === null) return;
	const credited = await queryCatalog(r => r.allKeys('credits', 'byTitle', r.keyRange.bound([id], [id, []])));
	await loadRecords({books: credited.map(key => (key as IDBValidKey[])[1] as string), contributors: [id]});
	const name = CATALOG.nameOf('authors', id);
	if (name === undefined) {
		byId('subtitle').textContent = spell('There is no such author in the catalog.');
		DRAFTS = [];
		render();
		return;
	}
	document.title = `Edit ${name}'s books` + spell(' · Audiobook Catalog');
	byId('subtitle').textContent = name;
	byId('backLink').setAttribute('href', creditPageHref('authors', id));
	byId('backLink').textContent = '← ' + name;
	startDrafts(CATALOG.booksOf('authors', id).slice().sort(bookOrder));
}

for (const field of ['sf_name', 'sf_total', 'sf_status', 'sf_note'])
	byId(field).addEventListener('change', showChangeCount);
fillElement(byId('sf_ext'), ...externalFields('sf_ext_', 'series'));
byId('sf_ext').addEventListener('change', showChangeCount);
fillElement(
	byId('sf_linksBox'),
	linksField('sf_links', 'series', group => document.getElementById('sf_ext_' + group) as FormField | null, {
		onMoved: showChangeCount,
		attrs: {onchange: showChangeCount},
	}),
);
byId('seriesRemoveBtn').addEventListener('click', removeSeries);
byId('reviewBtn').addEventListener('click', review);
byId('reviewSaveBtn').addEventListener('click', save);
byId('reviewBackBtn').addEventListener('click', () => setReviewing(false));
byId('askBtn').addEventListener('click', () => void askCatalogs());
byId('discardBtn').addEventListener('click', discard);

/** After a save took in what another tab changed (store.ts): the page shows the books as stored now. */
function refresh() {
	if (!changes().length) void loadShown();
}

export const READY = startPage(
	async () => {
		const author = valueFromPageHash(location.hash, 'author');
		if (author !== null) {
			KIND = 'author';
			byId('seriesPanel').hidden = true;
			byId('eyebrow').textContent = spell("Edit an author's books");
			// by its id, or by name from an older link
			AUTHOR_ID = await queryCatalog(async r => {
				const [rec] = await r.get('contributors', [author]);
				if (rec && rec.kind === 'author') return rec.id as string;
				const [named] = await r.all('contributors', 'kindName', ['author', author]);
				return named ? (named.id as string) : null;
			});
			if (AUTHOR_ID === null) {
				byId('subtitle').textContent = spell('No author to edit: open one from their page.');
				return;
			}
		} else {
			const value = valueFromPageHash(location.hash, 'series');
			if (value !== null) await loadRecords({series: [value], seriesNamed: [value]});
			SERIES_ID = idFromAddress('series', value);
			if (SERIES_ID === null) {
				byId('subtitle').textContent = spell('No series to edit: open one from its page.');
				return;
			}
		}
		await loadShown();
		void askCatalogs();
	},
	{refresh},
);
