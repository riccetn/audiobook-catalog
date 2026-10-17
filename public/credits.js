// The authors, narrators and publishers pages: everyone the books credit as one of them, and one
// person's or publisher's page (authors.html#a=id, narrators.html#n=id, publishers.html#p=id, by the id they
// are stored under; a name there, from a link of before, works too) with
// what you keep about them (CATALOG.authors, .narrators, .publishers: a short bio, their own site, their
// ids on Audible, Amazon, Goodreads and Hardcover, which link to their pages there, and other links) and the series and titles of theirs you have, worked out from
// the books. Each page's own script (authors.js, narrators.js, publishers.js) starts this one with its kind.
// Loading and saving live in store.js.
import {Text} from './modules/text.js';
import {Catalog} from './modules/catalog.js';
import {Contributor} from './modules/contributor.js';
import {Series} from './modules/series.js';
import {Validator} from './modules/validator.js';
import { CATALOG, persist, showIoStatus, startPage, byId, fieldById, spell, buildElement, fillElement, joined,
	authorPageHref, narratorPageHref, publisherPageHref, valueFromPageHash, idFromAddress, externalFields, fillExternalFields, readExternalFields, externalLinks, lookupHardcoverField } from './store.js';
/** @import {Book} from './modules/book.js' */
/** @import {ContributorKind} from './modules/contributor.js' */
/** @import {Child} from './store.js' */

/**
 * What differs between the three pages.
 * @typedef {object} CreditKind
 * @property {ContributorKind} infoKey where the catalog keeps their info: CATALOG.narrators
 * @property {string} hashKey the address's key: #n=id
 * @property {'author' | 'narrator' | 'publisher'} one 'narrator' (also what an external catalog calls them)
 * @property {string} many 'narrators'
 * @property {string} title the page's title: 'Narrators'
 * @property {string} none the subtitle of someone with no books
 * @property {[string, string]} site their own site's form label and example
 * @property {(name: string) => string} href the address of someone's page
 * @property {(b: Book) => string[]} namesOf who the kind credits on a book
 * @property {() => {name: string, books: number, series: number}[]} list
 * @property {(name: string) => {series: {name: string, books: Book[]}[], titles: Book[]}} works
 */

/** @type {Record<'author' | 'narrator' | 'publisher', CreditKind>} */
export const CREDIT_KINDS = {
	author: {infoKey: 'authors', hashKey: 'a', one: 'author', many: 'authors', title: 'Authors', none: 'No books by this author in the catalog.',
		site: ['Personal website', 'https://'],
		href: authorPageHref, namesOf: Catalog.authorsOf, list: ()=> CATALOG.authorList(), works: name=> CATALOG.authorWorks(name)},
	narrator: {infoKey: 'narrators', hashKey: 'n', one: 'narrator', many: 'narrators', title: 'Narrators', none: 'No books narrated by them in the catalog.',
		site: ['Personal website', 'https://'],
		href: narratorPageHref, namesOf: Catalog.narratorsOf, list: ()=> CATALOG.narratorList(), works: name=> CATALOG.narratorWorks(name)},
	publisher: {infoKey: 'publishers', hashKey: 'p', one: 'publisher', many: 'publishers', title: 'Publishers', none: 'No books from this publisher in the catalog.',
		site: ['Website', 'https://'],
		href: publisherPageHref, namesOf: Catalog.publishersOf, list: ()=> CATALOG.publisherList(), works: name=> CATALOG.publisherWorks(name)},
};

/** @type {CreditKind} */
export let KIND = CREDIT_KINDS.author;
/** @type {string | null} */
export let SHOWN = null;              // the id of the author, narrator or publisher shown (#a=...), or null for the list
/** @type {string | null} */
let EDITING = null;                   // the id of whose info the form is editing, or null

const hashValue = (/** @type {string} */ v)=> encodeURIComponent(v).replace(/%20/g, '+');
const bookHref = (/** @type {Book} */ b)=> 'index.html#book=' + hashValue(b.id || '');
const seriesHref = (/** @type {string} */ name)=> 'index.html#series=' + hashValue(CATALOG.idFor('series', name));
const plural = (/** @type {number} */ n, /** @type {string} */ word, many = word + 's')=> `${n} ${n === 1 ? word : many}`;
/** @type {(names: string[], href: (name: string) => string) => Child[]} */
const nameLinks = (names, href)=> joined(names.map(x=> buildElement('a', {href: href(x)}, x)), ', ');
/** @returns {Map<string, Contributor>} what the catalog keeps about the page's kind, by id */
const kept = ()=> CATALOG[KIND.infoKey];
/** @type {(id: string) => string} the name of the one stored under `id` */
const nameOf = id=> CATALOG.nameOf(KIND.infoKey, id) ?? '';
/** @type {(name: string) => Contributor | undefined} what the catalog keeps about `name` */
const infoOf = name=> { const id = CATALOG.nameIds[KIND.infoKey].get(name); return id === undefined ? undefined : kept().get(id); };

/**
 * A bio as paragraphs: a blank line starts a new one, a single line break stays a line break.
 * @param {string} bio
 * @returns {HTMLParagraphElement[]}
 */
function bioParagraphs(bio){
	return bio.split(/\n{2,}/).map(p=> buildElement('p', {}, p.split('\n').flatMap((line, i)=> i ? [buildElement('br'), line] : [line])));
}

export function render(){
	homeCreditForm();
	byId('crumb').classList.toggle('show', SHOWN !== null);
	byId('creditControls').style.display = SHOWN === null ? '' : 'none';
	document.title = (SHOWN === null ? KIND.title : nameOf(SHOWN)) + spell(' · Audiobook Catalog');
	if(SHOWN === null) renderCreditList(); else renderCreditPage(SHOWN);
}

function renderCreditList(){
	const q = fieldById('q').value.trim().toLowerCase();
	const all = KIND.list();
	const shown = q ? all.filter(x=> x.name.toLowerCase().includes(q)) : all;
	byId('subtitle').textContent = `${plural(all.length, KIND.one)} across ${plural(CATALOG.books.length, 'audiobook')}`;
	fillElement(byId('creditBody'), shown.length ? shown.map(x=> buildElement('div', {class: 'srow'},
		buildElement('div', {class: 'srow-head'},
			buildElement('a', {class: 'srow-title', href: KIND.href(x.name)}, x.name), ' ',
			buildElement('span', {class: 'srow-owned'}, `${plural(x.books, 'book')}${x.series ? ', ' + plural(x.series, 'series', 'series') : ''}`)),
		bioLine(x.name) || (KIND !== CREDIT_KINDS.author && topAuthorsLine(x.name))))
		: buildElement('p', {class: 'empty'}, all.length ? `No ${KIND.many} match your search.`
			: KIND === CREDIT_KINDS.author ? 'No books yet.' : `No ${KIND.many} yet: they come from the books' editions.`));
}

/**
 * The first line of someone's bio, for the list; null when there is none.
 * @param {string} name
 * @returns {HTMLParagraphElement | null}
 */
function bioLine(name){
	const info = infoOf(name);
	return info && info.bio ? buildElement('p', {class: 'srow-note'}, info.bio.split('\n')[0]) : null;
}

/**
 * The authors whose books someone narrates or publishes most, for the list: "Mostly Ann Vale, Bo Reed".
 * @param {string} name
 * @returns {HTMLParagraphElement | null}
 */
function topAuthorsLine(name){
	/** @type {Map<string, number>} */
	const count = new Map();
	for(const b of CATALOG.books) if(KIND.namesOf(b).includes(name)) for(const a of b.authors) count.set(a, (count.get(a) || 0) + 1);
	const top = [...count].sort((x, y)=> y[1] - x[1] || x[0].localeCompare(y[0])).slice(0, 3).map(([a])=> a);
	return top.length ? buildElement('p', {class: 'srow-note'}, (count.size > top.length ? 'Mostly ' : 'Books by ') + top.join(', ')) : null;
}

/**
 * A book on someone's page: its number in the series, its title (a link to it in the catalog), and on an
 * author's page who else wrote it; on a narrator's or publisher's page its authors, and for a narrator who
 * else reads the editions they read.
 * @param {Book} b
 * @param {string} name
 * @returns {HTMLLIElement}
 */
function creditBookLine(b, name){
	const isAuthor = KIND === CREDIT_KINDS.author;
	const others = isAuthor ? b.authors.filter(x=> x !== name)
		: KIND === CREDIT_KINDS.narrator ? [...new Set(b.editions.filter(ed=> ed.narrators.includes(name)).flatMap(ed=> ed.narrators))].filter(x=> x !== name)
		: [];
	return buildElement('li', {}, b.number && [buildElement('span', {class: 'num'}, '#' + b.number), ' '], buildElement('a', {href: bookHref(b)}, b.title),
		!isAuthor && b.authors.length > 0 && [' ', buildElement('span', {class: 'with'}, 'by ', nameLinks(b.authors, authorPageHref))],
		others.length > 0 && [' ', buildElement('span', {class: 'with'}, 'with ', nameLinks(others, KIND.href))]);
}

/**
 * The heading of a series on someone's page: on an author's, how many of it you own (of the released
 * total, with its status); otherwise how many of its books are theirs.
 * @param {{name: string, books: Book[]}} s
 * @returns {HTMLParagraphElement}
 */
function seriesHeading(s){
	const link = buildElement('a', {href: seriesHref(s.name)}, s.name);
	if(KIND !== CREDIT_KINDS.author) return buildElement('p', {class: 'series-title'}, link, ' ', buildElement('span', {class: 'n'}, plural(s.books.length, 'book')));
	const si = CATALOG.seriesInfo(s.name);
	return buildElement('p', {class: 'series-title'}, link,
		' ', buildElement('span', {class: 'n'}, `${Series.owned(s.books)} owned${si ? ' of ' + si.total : ''}`),
		si && [' ', buildElement('span', {class: `status ${si.status}`}, si.status === 'complete' ? 'complete' : 'ongoing')]);
}

/** @param {string} id */
function renderCreditPage(id){
	const name = nameOf(id);
	const info = kept().get(id) || new Contributor(name);
	const {series, titles} = KIND.works(name);
	const count = series.reduce((n, s)=> n + s.books.length, 0) + titles.length;
	byId('subtitle').textContent = count
		? `${plural(count, 'audiobook')}${series.length ? ' in ' + plural(series.length, 'series', 'series') : ''}${series.length && titles.length ? ` and ${titles.length} outside a series` : ''}`
		: spell(KIND.none);
	const label = kept().has(id) ? `Edit ${KIND.one} info` : `Add ${KIND.one} info`;
	/** @type {(href: string, text: string) => HTMLAnchorElement} */
	const link = (href, text)=> buildElement('a', {class: 'authorlink', href, target: '_blank', rel: 'noopener'}, `${text} ↗`);
	// their own site, their pages in external catalogs, then any other link (by its site's name)
	const links = [info.url && link(info.url, 'Website'), ...externalLinks(info.external, KIND.one),
		...info.links.map(href=> link(href, (Text.webHost(href) || href).replace(/^www\./, '')))].filter(x=> !!x);
	/** @type {Child[]} */
	const out = [
		buildElement('div', {class: 'author-head'}, buildElement('h2', {class: 'author-name'}, name),
			buildElement('button', {class: 'iconbtn aedit', title: label, 'aria-label': label, onclick: ()=> openCreditForm(id)}, '✎')),
		info.bio && buildElement('div', {class: 'author-bio'}, bioParagraphs(info.bio)),
		links.length > 0 && buildElement('p', {class: 'author-links'}, joined(links, ' ')),
		!info.bio && !links.length && buildElement('p', {class: 'hint'}, 'No bio or links yet: add them with ✎.'),
	];
	series.forEach(s=> out.push(buildElement('div', {class: 'series-group'}, seriesHeading(s),
		buildElement('ul', {class: 'author-books'}, s.books.map(b=> creditBookLine(b, name))))));
	if(titles.length){
		out.push(buildElement('div', {class: 'series-group'},
			buildElement('p', {class: 'series-title'}, series.length ? 'Outside a series' : 'Titles', ' ', buildElement('span', {class: 'n'}, plural(titles.length, 'book'))),
			buildElement('ul', {class: 'author-books'}, titles.map(b=> creditBookLine(b, name)))));
	}
	fillElement(byId('creditBody'), out);
}

// ------------------------------------------------------------------ the info form
/**
 * Edits someone's entry in CATALOG.authors (or .narrators, .publishers); like every edit, it is kept in
 * this browser (see persist in store.js).
 * @param {string} id the id they are stored under
 */
export function openCreditForm(id){
	const name = nameOf(id);
	const info = kept().get(id) || new Contributor(name);
	EDITING = id;
	const one = KIND.one[0].toUpperCase() + KIND.one.slice(1);
	byId('creditFormTitle').textContent = (kept().has(id) ? `${one} info: ` : `Add ${KIND.one} info: `) + name;
	fieldById('cf_bio').value = info.bio || '';
	fieldById('cf_url').value = info.url || '';
	fillExternalFields('cf_ext_', KIND.one, info.external);
	byId('creditFormError').textContent = '';
	byId('creditSaveBtn').textContent = `Save ${KIND.one} info`;
	byId('creditRemoveBtn').style.display = kept().has(id) ? '' : 'none';
	const form = byId('creditForm');
	form.classList.add('open');
	form.scrollIntoView({behavior: 'smooth', block: 'center'});
}

function closeCreditForm(){
	EDITING = null;
	const form = /** @type {HTMLFormElement} */ (byId('creditForm'));
	form.classList.remove('open');
	form.reset();
	byId('creditFormError').textContent = '';
}

// The form belongs to the page shown; another page, or the list, closes it.
function homeCreditForm(){
	if(EDITING !== null && EDITING !== SHOWN) closeCreditForm();
}

async function saveCreditForm(){
	const id = EDITING;
	if(id === null) return;
	const name = nameOf(id);
	// a Hardcover address is looked up for its number first, unless the form is closed or moved meanwhile
	const lookup = lookupHardcoverField('cf_ext_', KIND.one);
	const hardcover = lookup ? await lookup : {error: '', note: ''};
	if(EDITING !== id) return;
	if(hardcover.error){ byId('creditFormError').textContent = hardcover.error; return; }
	const had = kept().get(id);
	const external = readExternalFields('cf_ext_', KIND.one, had ? had.external : {});
	if(external.bad.length){ byId('creditFormError').textContent = `Not an id or address there: ${external.bad.join('; ')}.`; return; }
	// the links the form has no field for are kept
	const entry = Contributor.tidy(name, {bio: fieldById('cf_bio').value, url: fieldById('cf_url').value, ext: external.ids, links: had ? had.links : []});
	// the same rules as Check, applied to this entry alone; an id in a catalog this app doesn't know is only
	// a warning there, but here it is most likely a mistake
	if(entry){
		const {errors, warnings} = Validator.validateContributors(JSON.parse(JSON.stringify(CATALOG.books)), KIND.infoKey, {[name]: entry.toJSON()});
		const problems = [...errors, ...warnings.filter(w=> !/matches no|is a page on/.test(w))].map(e=> e.replace(/^\w+\[[^\]]*\]: /, ''));
		if(problems.length){ byId('creditFormError').textContent = problems.join('; '); return; }
	}
	if(entry) kept().set(id, entry); else kept().delete(id);
	closeCreditForm(); render(); persist();
	showIoStatus((entry ? `Saved ${KIND.one} info for ${name}.` : `Removed ${KIND.one} info for ${name}.`) + (hardcover.note ? ' ' + hardcover.note : ''));
}

function removeCreditInfo(){
	const id = EDITING;
	if(id === null || !kept().has(id)) return;
	const name = nameOf(id);
	kept().delete(id);
	closeCreditForm(); render(); persist();
	showIoStatus(`Removed ${KIND.one} info for ${name}.`);
}

// ------------------------------------------------------------------ the address
// authors.html is the list, authors.html#a=id an author's page (likewise #n= and #p=); links between
// them change the address, so Back and Forward step through them.
/**
 * The id of the one the address names (by their id, or their name), or null for the list. A name no book
 * has gets an id too, so their page says so and info can be added for them.
 * @returns {string | null}
 */
function shownInAddress(){
	const value = valueFromPageHash(location.hash, KIND.hashKey);
	return value === null ? null : idFromAddress(KIND.infoKey, value) ?? CATALOG.idFor(KIND.infoKey, value);
}

export function showAddress(){
	const id = shownInAddress();
	if(id === SHOWN && byId('creditBody').hasChildNodes()) return;
	const moved = id !== SHOWN;
	SHOWN = id;
	render();
	if(moved && typeof scrollTo === 'function') scrollTo(0, 0);
}

/**
 * Start the authors, narrators or publishers page.
 * @param {'author' | 'narrator' | 'publisher'} kind
 * @returns {Promise<void>}
 */
export function startCreditsPage(kind){
	KIND = CREDIT_KINDS[kind];
	byId('cf_url_label').textContent = KIND.site[0];
	byId('cf_url').setAttribute('placeholder', KIND.site[1]);
	fillElement(byId('cf_ext'), externalFields('cf_ext_', KIND.one));
	byId('creditForm').addEventListener('submit', e=>{ e.preventDefault(); return saveCreditForm(); });
	byId('creditRemoveBtn').addEventListener('click', removeCreditInfo);
	byId('cancelCredit').addEventListener('click', closeCreditForm);
	byId('q').addEventListener('input', render);
	addEventListener('hashchange', showAddress);
	addEventListener('popstate', showAddress);
	return startPage(()=>{ SHOWN = shownInAddress(); render(); }, {refresh: ()=>{ if(SHOWN !== null && CATALOG.nameOf(KIND.infoKey, SHOWN) === undefined) SHOWN = null; render(); }});
}
