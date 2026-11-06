// The Edit series page (edit.html#series=<id>): a series and every book in it on one page, each book with its
// fields and its editions, edited in place. Editions are merged, split and removed here too (a removed one
// may be excluded from imports, Exclusions.editionEntries). Nothing is saved until Review & save lists every
// change and Save is pressed: the books are edited as copies (`DRAFTS`), and Save puts them in the catalog
// with saveBook(), as the book form does, then renames the series and saves its info, as its form did.
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
	spell,
	byId,
	fieldById,
	buildElement,
	fillElement,
	showIoStatus,
	externalFields,
	fillExternalFields,
	readExternalFields,
	lookupHardcoverField,
	valueFromPageHash,
	idFromAddress,
	bookPageHref,
	seriesPageHref,
	openWithStatus,
	hashValue,
} from './store.js';
import {coverImage, totalText, setAddress} from './book-list.js';

/** A book being edited: the book as loaded (`before`, as stored text) and the copy the page changes. */
export type Draft = {id: string; before: Book; book: Book; error: string};

/** The series' id, from the address. */
export let SERIES_ID: string | null = null;
/** The series' books, in series order, as the page has changed them. */
export let DRAFTS: Draft[] = [];
/** The entries Save adds to the exclusions list: the removed editions to keep out of imports. */
export let EXCLUDE: string[] = [];
// what an edition's Merge, Split or Remove has open: "<book place>:<edition place>:<what>"
let OPEN_PANEL: string | null = null;
let REMOVING_SERIES = false; // Remove series was pressed once; the second press removes it

// The fields of a book the page edits, besides its ids: [key, label].
const BOOK_FIELDS: [string, string][] = [
	['t', 'Title'],
	['a', 'Authors'],
	['sn', 'Number in the series'],
	['g', 'Genres'],
	['r', 'Read'],
];
// The fields of an edition the page edits, besides its ids: [Edition.fields() key, label].
const EDITION_FIELDS: [string, string][] = [
	['t', 'Released as'],
	['n', 'Narrators'],
	['p', 'Publishers'],
	['d', 'Released'],
	['len', 'Length'],
	['isbn', 'ISBN'],
	['desc', 'Description'],
];

// ------------------------------------------------------------------ what a book and an edition show
/**
 * A book's field as the page shows it in its input.
 */
export function bookFieldText(b: Book, key: string): string {
	if (key === 't') return b.title;
	if (key === 'a') return Text.namesText(b.authors);
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
/** A labeled input, marked when it differs from the book as loaded. */
function field(id: string, label: string, value: string, was: string, attrs: Record<string, any> = {}): HTMLElement {
	const tag = attrs.multiline ? 'textarea' : 'input';
	delete attrs.multiline;
	const input = buildElement(tag, {id, ...attrs});
	(input as HTMLInputElement).value = value;
	return buildElement(
		'div',
		{class: value === was ? 'editField' : 'editField changed'},
		buildElement('label', {for: id}, spell(label)),
		input,
	);
}

/** A book's card: its summary, its fields and its editions. */
function bookCard(d: Draft, i: number): HTMLElement {
	const b = d.book;
	const changed = b.text() !== d.before.text();
	const cover = coverImage(b, 'small');
	const fields = BOOK_FIELDS.map(([k, label]) =>
		field(inputId(i, null, k), label, bookFieldText(b, k), bookFieldText(d.before, k), {
			'data-book': String(i),
			onchange: () => readBookFields(i),
		}),
	);
	const ids = buildElement(
		'div',
		{class: 'formrow extFields', id: inputId(i, null, 'ext'), onchange: () => readBookFields(i)},
		...externalFields(inputId(i, null, 'ext_'), 'book'),
	);
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
				buildElement('a', {href: bookPageHref(d.id)}, "The book's page"),
			),
			buildElement('div', {class: 'editFields'}, ...fields),
			ids,
			buildElement('p', {class: 'formError', id: `book-${i}-error`}, d.error),
			buildElement('h3', {class: 'editEditionsTitle'}, 'Editions'),
			...b.editions.map((ed, j) => editionCard(d, i, j)),
			...(b.editions.length ? [] : [buildElement('p', {class: 'hint'}, 'No editions yet.')]),
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
			field(inputId(i, j, k), label, fields[k] || '', wasFields[k] || '', {
				'data-key': k,
				onchange,
				...(k === 'desc' ? {multiline: true} : {}),
				...(k === 't' ? {placeholder: 'the same as the book'} : {}),
			}),
		),
		...ext.map(k =>
			field(inputId(i, j, k), Edition.fieldLabel(k.slice(4)), fields[k], wasFields[k] || '', {
				'data-key': k,
				onchange,
			}),
		),
		field(inputId(i, j, 'more'), 'Another id', '', '', {
			'data-key': 'more',
			placeholder: "the edition's address on any catalog",
			onchange,
		}),
	];
	const panel = OPEN_PANEL && OPEN_PANEL.startsWith(`${i}:${j}:`) ? OPEN_PANEL.split(':')[2] : null;
	return buildElement(
		'details',
		{class: was && was.format() === ed.format() ? 'editEdition' : 'editEdition changed', id: `book-${i}-ed-${j}`},
		buildElement('summary', {}, ...editionSummary(d, ed)),
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
	const others = DRAFTS.filter(x => x !== d && x.book.editions.some(y => y.sameAs(ed))).map(x => x.book);
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
	const keys = Object.keys(fields).filter(k => !k.startsWith('img:'));
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

/** Draw the books again, and how many changes there are. */
export function render() {
	fillElement(byId('editBooks'), ...DRAFTS.map(bookCard));
	byId('bookCount').textContent = DRAFTS.length ? Text.plural(DRAFTS.length, 'book') : '';
	showChangeCount();
}

/**
 * Draw the books again after Merge, Split or Remove, or a field that needs inputs of its own: every field
 * read already is in the drafts, so nothing typed is lost; the books' ids are put back in their fields.
 */
function renderBook(i: number) {
	render();
	DRAFTS.forEach((d, k) => fillExternalFields(inputId(k, null, 'ext_'), 'book', d.book.external));
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
	const number = Text.tidy(value('sn'));
	b.number = number || undefined;
	b.genres = value('g')
		.split(',')
		.map(x => x.trim())
		.filter(Boolean);
	b.read = dates;
	b.external = external.ids;
	markFields(i);
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
		const found = ExternalCatalog.fromAddress(text, 'edition');
		if (found && !Text.tidy(typed['ext:' + found.catalog] || '')) typed['ext:' + found.catalog] = text;
		else problems.push(`Not an edition's address: ${text}.`);
	}
	const read = Edition.fromFields(typed);
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
	for (const [k] of BOOK_FIELDS) {
		const input = fieldById(inputId(i, null, k));
		const box = input.closest('.editField');
		if (box) box.classList.toggle('changed', input.value !== bookFieldText(d.before, k));
	}
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
		const a = was.fields(),
			b = ed.fields();
		const parts = [...new Set([...Object.keys(a), ...Object.keys(b)])]
			.filter(k => !k.startsWith('img:') && (a[k] || '') !== (b[k] || ''))
			.map(k => {
				const label = k.startsWith('ext:')
					? Edition.fieldLabel(k.slice(4))
					: (EDITION_FIELDS.find(([key]) => key === k) || [k, k])[1];
				return `${label}: ${from(a[k] || '', b[k] || '')}`;
			});
		out.push(`Edition ${editionName(was).name}: ${parts.join('; ')}`);
	}
	return out;
}

/** Every change on the page, as [what it is on, the change]. */
export function changes(): [string, string][] {
	const out: [string, string][] = [];
	const name = SERIES_ID === null ? undefined : CATALOG.nameOf('series', SERIES_ID);
	if (name !== undefined) for (const line of seriesChanges(name)) out.push([name, line]);
	for (const d of DRAFTS) for (const line of bookChanges(d.before, d.book, EXCLUDE)) out.push([d.book.title, line]);
	return out;
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
		wasStatus = info ? String(info.toJSON().status ?? '') : 'ongoing';
	if (status !== wasStatus && (total || wasTotal || info)) out.push(`Status: ${status}`);
	const note = Text.tidy(fieldById('sf_note').value);
	if (note !== (info ? info.note || '' : '')) out.push(`Note: ${note || '(empty)'}`);
	const ext = readExternalFields('sf_ext_', 'series', info ? info.external : {});
	const shown = (ids: Record<string, string>) => JSON.stringify(ExternalCatalog.order(ids) || {});
	if (!ext.bad.length && shown(ext.ids) !== shown(info ? info.external : {})) out.push('Its ids in other catalogs');
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
	// a series needs none of these; with all of them empty, it keeps none
	if (!(totalTyped || note || Object.keys(external.ids).length)) return {newName, entry: null, note: hardcover.note};
	// unchecked as typed: the Check below says what is wrong with the total or status
	const typed: Record<string, unknown> = {
		total: /^\d+$/.test(totalTyped) ? parseInt(totalTyped, 10) : totalTyped.toLowerCase(),
		status: fieldById('sf_status').value,
		note,
	};
	if (Object.keys(external.ids).length) typed.ext = ExternalCatalog.order(external.ids);
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
	return Validator.validate([{t: b.title, a: b.authors, e: JSON.parse(JSON.stringify(b.editions))}], {}).errors.map(
		e => (e.includes(' edition #') ? e.slice(e.indexOf(' edition #') + 1) : e),
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
	const series = await readSeriesPanel();
	if (!series) return showProblem(byId('seriesFormError'));
	const name = SERIES_ID === null ? undefined : CATALOG.nameOf('series', SERIES_ID);
	if (name === undefined) return;
	const lines = changes();
	if (series.newName !== name) {
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
	for (const part of ['seriesPanel', 'editBooks', 'saveBar']) {
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
	const series = await readSeriesPanel();
	const id = SERIES_ID;
	const name = id === null ? undefined : CATALOG.nameOf('series', id);
	if (!series || id === null || name === undefined) return;
	// a box set's edition changed here changes on its other books too, so they are loaded first
	const keys = [...new Set(DRAFTS.flatMap(d => d.book.editions.flatMap(ed => ed.idAndIsbnKeys())))];
	if (keys.length) await loadRecords({editionKeys: keys});
	let saved = 0,
		others = 0;
	for (const d of DRAFTS) {
		if (d.book.text() === d.before.text()) continue;
		if (!CATALOG.book(d.id)) continue; // removed in another tab meanwhile
		others += CATALOG.saveBook(d.id, d.book.clone());
		saved++;
	}
	const excluded = EXCLUDE.length ? CATALOG.addExclusions(EXCLUDE) : 0;
	const renamed = series.newName !== name;
	if (renamed) await loadRecords({seriesNamed: [series.newName]});
	const joins = renamed && CATALOG.nameIds.series.has(series.newName);
	const count = renamed ? CATALOG.renameEntry('series', name, series.newName) : 0;
	const newId = CATALOG.idFor('series', series.newName);
	if (series.entry) CATALOG.series.set(newId, series.entry);
	else if (!joins) CATALOG.series.delete(newId);
	await persist();
	const parts = [
		renamed ? `Renamed ${name} to ${series.newName} on ${Text.plural(count, 'book')}` : '',
		saved ? `saved ${Text.plural(saved, 'book')}` : '',
		others ? `updated the shared edition on ${Text.plural(others, 'other book')}` : '',
		excluded ? `kept ${Text.plural(excluded, 'edition id')} out of imports` : '',
	].filter(Boolean);
	SERIES_ID = newId;
	if (newId !== id) setAddress('replace', '#series=' + hashValue(newId));
	await loadSeries();
	const status =
		(parts.length ? parts.join(', ').replace(/^./, c => c.toUpperCase()) + '.' : `Saved ${series.newName}.`) +
		(series.note ? ' ' + series.note : '');
	showIoStatus(status);
	openWithStatus(seriesPageHref(newId), status);
}

/** Discard: nothing is saved, and the series' page opens again. */
function discard() {
	if (SERIES_ID === null) return;
	void loadSeries();
	location.assign(seriesPageHref(SERIES_ID));
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
	byId('seriesFormError').textContent = '';
	REMOVING_SERIES = false;
	EXCLUDE = [];
	OPEN_PANEL = null;
	setReviewing(false);
	DRAFTS = CATALOG.booksOf('series', id)
		.slice()
		.sort(Book.bySeriesNumber)
		.map(b => ({id: b.id as string, before: b.clone(), book: b.clone(), error: ''}));
	render();
	DRAFTS.forEach((d, i) => fillExternalFields(inputId(i, null, 'ext_'), 'book', d.book.external));
}

for (const field of ['sf_name', 'sf_total', 'sf_status', 'sf_note'])
	byId(field).addEventListener('change', showChangeCount);
fillElement(byId('sf_ext'), ...externalFields('sf_ext_', 'series'));
byId('sf_ext').addEventListener('change', showChangeCount);
byId('seriesRemoveBtn').addEventListener('click', removeSeries);
byId('reviewBtn').addEventListener('click', review);
byId('reviewSaveBtn').addEventListener('click', save);
byId('reviewBackBtn').addEventListener('click', () => setReviewing(false));
byId('discardBtn').addEventListener('click', discard);

/** After a save took in what another tab changed (store.ts): the page shows the series as stored now. */
function refresh() {
	if (!changes().length) void loadSeries();
}

export const READY = startPage(
	async () => {
		const value = valueFromPageHash(location.hash, 'series');
		if (value !== null) await loadRecords({series: [value], seriesNamed: [value]});
		SERIES_ID = idFromAddress('series', value);
		if (SERIES_ID === null) {
			byId('subtitle').textContent = spell('No series to edit: open one from its page.');
			return;
		}
		await loadSeries();
	},
	{refresh},
);
