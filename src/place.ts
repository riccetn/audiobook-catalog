// A place's page (where a book's story takes place, its setting: place.html#place=id, by the id it is stored under; a name there, from a link, works too): where
// stories take place. It shows what you keep about the place (CATALOG.places: the places it is part of, who
// created it and who holds its rights, a note, its ids in external catalogs and other links), the places within it,
// the books set there, and the books set in the places within it, as a story set in London is set in England too.
// Its form edits or removes it. place.html#new opens the form of a new place, and place.html#new=id one within the
// place stored under id (+ Add a place on the list and a place's page). Every page holds every place (store.ts);
// this one loads the books set in it and in the places within it, and the places' records for the tree of the
// places within it (place-tree.ts).
import {Text} from './modules/text.js';
import {Place} from './modules/place.js';
import {Validator} from './modules/validator.js';
import {
	CATALOG,
	persist,
	startPage,
	afterSaving,
	loadRecords,
	queryCatalog,
	valueFromPageHash,
	idFromAddress,
	bookPageHref,
	seriesPageHref,
	placePageHref,
	namedPlacePageHref,
	hashValue,
	authorPageHref,
} from './store.js';
import {showIoStatus, byId, fieldById, spell, spellParts, plural, buildElement, fillElement, joined} from './dom.js';
import {
	externalFields,
	fillExternalFields,
	readExternalFields,
	externalLinks,
	linksField,
	webLinks,
} from './id-fields.js';
import {comboField} from './combo-box.js';
import {setAddress, nameLinks, authorLinks} from './book-list.js';
import {PlaceTree, readPlaces} from './place-tree.js';
import type {PlaceEntry} from './place-tree.js';
import type {Book} from './modules/book.js';
import type {Child, FormField} from './dom.js';

export let SHOWN: string | null = null; // the id of the place shown (#place=...); null until the address is read, and for a new one
/** a new place's form, open (#new): the place it is within, by name ('' for none) */
export let NEW_IN: string | null = null;
let EDITING: string | null = null; // the id of the place the form is editing, or null (a new place's form: NEW_IN)
let PLACES: PlaceEntry[] = []; // every place's record, for the tree of the places within the one shown
let REMOVING: string | null = null; // the place Remove was pressed for once, which a second press removes
let JOINING: string | null = null; // the name of another place Save was pressed once to rename it to, which a second press joins
// the names of the authors the catalog has, which the form's Created by offers as they are typed
let AUTHOR_NAMES: string[] = [];

/** the name of the place stored under `id` */
const nameOf: (id: string) => string = id => CATALOG.nameOf('places', id) ?? '';
/** the places the catalog has, by name */
const placeNames = (): string[] => [...CATALOG.namesOf('places')].sort((x, y) => x.localeCompare(y));
/** Places typed in a field: parted by commas or semicolons, but a place the catalog has stays whole ("Washington, D.C."). */
const splitPlaces = (text: unknown): string[] => Text.splitPublishers(text, placeNames());
const placeLinks = (names: string[]) => nameLinks(names, namedPlacePageHref);

export function render() {
	homePlaceForm();
	if (NEW_IN !== null) return renderNewPlace();
	if (SHOWN === null) return;
	document.title = spell('{page} · Audiobook Catalog', {page: nameOf(SHOWN)});
	renderPlacePage(SHOWN);
}

/**
 * The books set in the place stored under `id` and in every place within it.
 */
async function loadShown() {
	PLACES = await queryCatalog(readPlaces);
	if (SHOWN === null) return;
	const name = nameOf(SHOWN);
	const ids = [SHOWN, ...CATALOG.placeDescendants(name).map(n => CATALOG.idFor('places', n))];
	const books = await queryCatalog(r => Promise.all(ids.map(id => r.allKeys('books', 'placeIds', id))));
	await loadRecords({books: books.flat().map(key => key as string)});
}

/**
 * A book on a place's page: its title (a link to it), its authors, and its series and number.
 */
function bookLine(b: Book): HTMLLIElement {
	return buildElement(
		'li',
		{},
		buildElement('a', {href: bookPageHref(b.id || '')}, b.title),
		b.authors.length > 0 && [
			' ',
			buildElement('span', {class: 'with'}, spellParts('by {authors}', {authors: authorLinks(b.authors)})),
		],
		b.series && [
			' ',
			buildElement(
				'span',
				{class: 'with'},
				spellParts(b.number ? '{series} #{number}' : '{series}', {
					series: buildElement('a', {href: seriesPageHref(CATALOG.idFor('series', b.series))}, b.series),
					number: b.number || '',
				}),
			),
		],
	);
}

/** The books set in `name` (not the places within it), by title. */
function booksSetIn(name: string): Book[] {
	return CATALOG.books.filter(b => b.places.includes(name)).sort((x, y) => x.title.localeCompare(y.title));
}

/** A group of books on the page: its heading (a place's link, or text), how many, and the books. */
function bookGroup(heading: Child, books: Book[]): HTMLElement {
	return buildElement(
		'div',
		{class: 'series-group'},
		buildElement(
			'p',
			{class: 'series-title'},
			heading,
			' ',
			buildElement('span', {class: 'n'}, plural(books.length, 'book')),
		),
		buildElement('ul', {class: 'author-books'}, books.map(bookLine)),
	);
}

function renderPlacePage(id: string) {
	const name = nameOf(id);
	const info = CATALOG.places.get(id) || new Place(name);
	const own = booksSetIn(name);
	const places = CATALOG.placeDescendants(name);
	const within = places.map(p => ({name: p, books: booksSetIn(p)})).filter(p => p.books.length);
	const count = new Set([...own, ...within.flatMap(p => p.books)]).size;
	byId('subtitle').textContent = count
		? within.length
			? spell('{books} set here or in a place within it', {books: plural(count, 'audiobook')})
			: spell('{books} set here', {books: plural(count, 'audiobook')})
		: spell('No books set here yet.');
	const ancestors = CATALOG.placeAncestors(name).filter(a => !info.parents.includes(a));
	const links = [...externalLinks(info.external, 'place'), ...webLinks(info.links)];
	const facts: Child[] = [
		info.parents.length > 0 &&
			buildElement(
				'p',
				{class: 'place-fact'},
				spellParts('Part of {places}', {places: placeLinks(info.parents)}),
			),
		ancestors.length > 0 &&
			buildElement(
				'p',
				{class: 'place-fact'},
				spellParts('Also within {places}', {places: placeLinks(ancestors)}),
			),
		info.creators.length > 0 &&
			buildElement(
				'p',
				{class: 'place-fact'},
				spellParts('Created by {authors}', {authors: nameLinks(info.creators, authorPageHref)}),
			),
		info.owner && buildElement('p', {class: 'place-fact'}, spell('Rights held by {owner}', {owner: info.owner})),
	];
	// the places within it, as a tree with this one at the top
	const tree = new PlaceTree(PLACES);
	const self = tree.byId.get(id);
	const subtree = self && (tree.children.get(id) || []).length > 0 && tree.draw([self], false);
	const out: Child[] = [
		buildElement('div', {class: 'author-head'}, buildElement('h2', {class: 'author-name'}, name)),
		...facts,
		info.note && buildElement('div', {class: 'author-bio'}, buildElement('p', {}, info.note)),
		links.length > 0 && buildElement('p', {class: 'author-links'}, joined(links, ' ')),
		subtree &&
			buildElement(
				'div',
				{class: 'series-group'},
				buildElement('p', {class: 'series-title'}, spell('Places within it')),
				subtree,
			),
		own.length > 0 && bookGroup(spell(within.length ? 'Set here' : 'Books'), own),
		...within.map(p => bookGroup(buildElement('a', {href: namedPlacePageHref(p.name)}, p.name), p.books)),
		buildElement(
			'div',
			{class: 'page-actions'},
			buildElement('button', {type: 'button', class: 'aedit', onclick: () => openPlaceForm(id)}, spell('Edit')),
			buildElement('a', {class: 'sedit', href: '#new=' + hashValue(id)}, spell('+ Add a place within it')),
		),
	];
	fillElement(byId('placeBody'), out);
}

/** A new place's page: only its form, open, with the place it is within (when it was added from one). */
function renderNewPlace() {
	document.title = spell('{page} · Audiobook Catalog', {page: spell('New place')});
	byId('subtitle').textContent = NEW_IN
		? spell('A new place within {place}', {place: NEW_IN})
		: spell('A new place: a world, or somewhere in one');
	fillElement(byId('placeBody'));
}

// ------------------------------------------------------------------ the form
/**
 * Edits what CATALOG.places keeps about a place; like every edit, it is kept in this browser (see persist in
 * store.ts). Remove takes it off its books and removes it.
 * @param id the id it is stored under
 */
export function openPlaceForm(id: string | null) {
	const name = id === null ? '' : nameOf(id);
	const info = (id !== null && CATALOG.places.get(id)) || new Place(name, {parents: NEW_IN ? [NEW_IN] : []});
	EDITING = id;
	REMOVING = null;
	JOINING = null;
	byId('placeFormTitle').textContent = id === null ? spell('New place') : spell('Edit place: {name}', {name});
	byId('placeRemoveBtn').hidden = id === null;
	fieldById('sf_name').value = name;
	fieldById('sf_in').value = info.parents.join(', ');
	fieldById('sf_by').value = Text.namesText(info.creators);
	fieldById('sf_owner').value = info.owner || '';
	fieldById('sf_note').value = info.note || '';
	fillExternalFields('sf_ext_', 'place', info.external);
	fieldById('sf_links').value = info.links.join('\n');
	byId('placeFormError').textContent = '';
	const form = byId('placeForm');
	form.classList.add('open');
	form.scrollIntoView({behavior: 'smooth', block: 'center'});
	if (id === null) fieldById('sf_name').focus();
}

function closePlaceForm() {
	// a new place's form closed adds nothing: back to the place it was to be within, or the list
	if (NEW_IN !== null) {
		const within = CATALOG.nameIds.places.get(NEW_IN);
		location.assign(within === undefined ? 'places.html' : placePageHref(within));
		return;
	}
	EDITING = null;
	REMOVING = null;
	JOINING = null;
	const form = byId('placeForm') as HTMLFormElement;
	form.classList.remove('open');
	form.reset();
	byId('placeFormError').textContent = '';
}

// The form belongs to the place shown; another closes it.
function homePlaceForm() {
	if (EDITING !== null && EDITING !== SHOWN) closePlaceForm();
}

const showFormError = (text: string) => {
	byId('placeFormError').textContent = text;
};

/**
 * Save the form: what is kept about the place, and its name, which a rename changes on every book set there
 * and every place part of it. Renaming it to a place the catalog has already takes a second Save, and joins
 * the two: every book of either is set in the one, with what this form has, and what the other has where it is empty.
 */
export function savePlaceForm() {
	const adding = NEW_IN !== null;
	const id = EDITING;
	if (id === null && !adding) return;
	const name = id === null ? '' : nameOf(id);
	const newName = Text.tidy(fieldById('sf_name').value);
	if (!newName) return showFormError(spell('Give the place a name.'));
	if (adding && CATALOG.nameIds.places.has(newName))
		return showFormError(spell('There is already a place called {name}.', {name: newName}));
	if (splitPlaces(newName).join('\n') !== newName)
		return showFormError(
			spell('{name} would be read as several places: a comma or a semicolon separates names.', {name: newName}),
		);
	const parents = splitPlaces(fieldById('sf_in').value);
	// a place can't be part of itself, or of a place within it
	const circle = parents.filter(p => p === name || p === newName || CATALOG.placeCircle(name, p));
	if (circle.length)
		return showFormError(
			spell("{name} can't be part of {places}: it is within {name} already.", {
				name: newName,
				places: circle.join(', '),
			}),
		);
	const had = id === null ? undefined : CATALOG.places.get(id);
	const external = readExternalFields('sf_ext_', 'place', had ? had.external : {});
	if (external.bad.length)
		return showFormError(spell('Not an id or address there: {bad}.', {bad: external.bad.join('; ')}));
	const entry = Place.tidy(newName, {
		in: parents,
		by: Text.splitNames(fieldById('sf_by').value),
		owner: fieldById('sf_owner').value,
		note: fieldById('sf_note').value,
		ext: external.ids,
		links: Text.parseLinks(fieldById('sf_links').value),
	});
	// the same rules as Check, applied to this place alone; an id in a catalog this app doesn't know is only a
	// warning there, but here it is most likely a mistake
	if (entry) {
		const {errors, warnings} = Validator.validatePlaces({[newName]: entry.toJSON()});
		const problems = [...errors, ...warnings]
			.map(Validator.unlabeled)
			.filter(p => p.template !== Validator.PAGE_ON_CATALOG);
		if (problems.length) return showFormError(spell(Text.joinPhrases(problems)));
	}
	const renamed = !adding && newName !== name;
	const joins = renamed ? CATALOG.nameIds.places.get(newName) : undefined;
	// joining another is easy to do by mistake, so the first Save says so
	if (joins !== undefined && JOINING !== newName) {
		JOINING = newName;
		return showFormError(
			spell(
				'There is already a place called {name}. Press Save again to join them: every book set in either will be set in {name}, with what this form has, and what {name} has where this form is empty.',
				{name: newName},
			),
		);
	}
	const other = joins === undefined ? undefined : CATALOG.places.get(joins);
	const count = renamed ? CATALOG.renameEntry('places', name, newName) : 0;
	const newId = CATALOG.idFor('places', newName);
	const info = other
		? Place.tidy(newName, {
				in: [...new Set([...other.parents, ...(entry?.parents || [])])],
				by: [...new Set([...other.creators, ...(entry?.creators || [])])],
				owner: entry?.owner || other.owner,
				note: entry?.note || other.note,
				ext: {...other.external, ...entry?.external},
				links: [...new Set([...other.links, ...(entry?.links || [])])],
			})
		: entry;
	if (info) CATALOG.places.set(newId, info);
	else CATALOG.places.delete(newId);
	NEW_IN = null;
	closePlaceForm();
	// the address names it by id (a new one's named it by name, #new=)
	SHOWN = newId;
	setAddress('replace', placePageHref(newId));
	render();
	void persist().then(() =>
		afterSaving(async () => {
			await loadShown();
			render();
		}),
	);
	showIoStatus(
		renamed
			? spell('Renamed {name} to {newName} on {books}.', {name, newName, books: plural(count, 'book')})
			: adding
				? spell('Added {name}.', {name: newName})
				: spell('Saved {name}.', {name: newName}),
	);
}

/**
 * Remove: the first press says what it does, the second takes the place off its books and removes it. The
 * places within it stay, part of what it was part of instead.
 */
export function removePlace() {
	const id = EDITING;
	if (id === null) return;
	const name = nameOf(id);
	const count = CATALOG.booksOf('places', id).length;
	if (REMOVING !== id) {
		REMOVING = id;
		byId('placeFormError').textContent = count
			? spell(
					'This takes {name} off {books}, which stay in the catalog, and removes it; the places within it stay. Press Remove place again to do it.',
					{name, books: plural(count, 'book')},
				)
			: spell(
					'This removes {name}, where no book is set; the places within it stay. Press Remove place again to do it.',
					{
						name,
					},
				);
		return;
	}
	CATALOG.removeEntry('places', id);
	closePlaceForm();
	persist();
	byId('subtitle').textContent = '';
	fillElement(
		byId('placeBody'),
		buildElement(
			'p',
			{class: 'empty'},
			spellParts('{name} was removed. {all}', {
				name,
				all: buildElement('a', {href: 'places.html'}, spell('All places')),
			}),
		),
	);
	showIoStatus(
		count
			? spell('Removed {name} from {books}.', {name, books: plural(count, 'book')})
			: spell('Removed {name}.', {name}),
	);
}

// ------------------------------------------------------------------ the address
/** Whether the address is a new place's form: #new, or #new=id (within the place stored under id). */
const newInAddress = (): boolean => location.hash === '#new' || valueFromPageHash(location.hash, 'new') !== null;

/**
 * The id of the place the address names (#place=, by its id, or its name; a name the catalog doesn't have gets an
 * id, so its page says so and saving the form adds it); null when it names none.
 */
function shownInAddress(): string | null {
	const value = valueFromPageHash(location.hash, 'place');
	if (value === null) return null;
	return idFromAddress('places', value) ?? CATALOG.idFor('places', value);
}

/**
 * Show what the address names, once its books are loaded; an address naming no place goes to the list.
 */
export function showAddress(): Promise<void> {
	return afterSaving(async () => {
		if (newInAddress()) {
			const within = valueFromPageHash(location.hash, 'new');
			NEW_IN = within === null ? '' : (CATALOG.nameOf('places', within) ?? '');
			SHOWN = null;
			render();
			openPlaceForm(null);
			return;
		}
		NEW_IN = null;
		const shown = shownInAddress();
		if (shown === null) {
			location.replace('places.html');
			return;
		}
		if (shown === SHOWN && byId('placeBody').hasChildNodes()) return;
		const moved = shown !== SHOWN;
		SHOWN = shown;
		await loadShown();
		render();
		if (moved && typeof scrollTo === 'function') scrollTo(0, 0);
	});
}

// After a save took in what another tab changed: read the books again; when the other tab removed it, go to the list.
function refreshShown() {
	return afterSaving(async () => {
		if (SHOWN !== null && CATALOG.nameOf('places', SHOWN) === undefined) {
			location.replace('places.html');
			return;
		}
		await loadShown();
		render();
	});
}

export const READY = (() => {
	if (valueFromPageHash(location.hash, 'place') === null && !newInAddress()) {
		location.replace('places.html');
		return Promise.resolve();
	}
	fillElement(
		byId('sf_inBox'),
		comboField(buildElement('input', {id: 'sf_in'}), {names: placeNames, multiple: true, split: splitPlaces}),
	);
	fillElement(
		byId('sf_byBox'),
		comboField(buildElement('input', {id: 'sf_by'}), {names: () => AUTHOR_NAMES, multiple: true}),
	);
	fillElement(byId('sf_ext'), externalFields('sf_ext_', 'place'));
	fillElement(
		byId('sf_linksBox'),
		linksField('sf_links', 'place', group => document.getElementById('sf_ext_' + group) as FormField | null, {
			label: spell('Other links, one per line'),
		}),
	);
	byId('placeForm').addEventListener('submit', e => {
		e.preventDefault();
		savePlaceForm();
	});
	byId('placeRemoveBtn').addEventListener('click', removePlace);
	byId('cancelPlace').addEventListener('click', closePlaceForm);
	addEventListener('hashchange', showAddress);
	addEventListener('popstate', showAddress);
	return startPage(
		async () => {
			const keys = await queryCatalog(r => r.keys('contributors', 'kindName'));
			AUTHOR_NAMES = keys
				.filter(k => Array.isArray(k) && k[0] === 'author')
				.map(k => String((k as IDBValidKey[])[1]));
			await showAddress();
		},
		{refresh: refreshShown},
	);
})();
