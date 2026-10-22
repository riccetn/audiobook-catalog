// An author's, a narrator's or a publisher's page (author.html#a=id, narrator.html#n=id, publisher.html#p=id,
// by the id they are stored under; a name there, from a link of before, works too) with what you keep about
// them (CATALOG.authors, .narrators, .publishers: a short bio, their own site, their ids on Audible, Amazon,
// Goodreads and Hardcover, which link to their pages there, and other links), the series and titles of theirs
// you have, worked out from the books, and the form that edits or removes them. Each page's own script (author.js, narrator.js,
// publisher.js) starts this one with its kind; the lists of them are credits.js's. The page loads their
// record and their books. Loading and saving live in store.js.
import {Text} from './modules/text.js';
import {Contributor} from './modules/contributor.js';
import {Series} from './modules/series.js';
import {Validator} from './modules/validator.js';
import { CATALOG, persist, showIoStatus, startPage, afterSaving, loadRecords, queryCatalog, byId, fieldById, spell, buildElement, fillElement, joined,
	authorPageHref, valueFromPageHash, idFromAddress, externalFields, fillExternalFields, readExternalFields, externalLinks, lookupHardcoverField, hardcoverCompareHref, bookPageHref, seriesPageHref } from './store.js';
import {CREDIT_KINDS} from './credit-kinds.js';
import {setAddress} from './book-list.js';
/** @import {CreditKind} from './credit-kinds.js' */
/** @import {Book} from './modules/book.js' */
/** @import {Child} from './store.js' */
/** @import {ContributorRecord} from './modules/catalog-records.js' */

/** @type {CreditKind} */
let KIND = CREDIT_KINDS.author;
/** @type {string | null} */
export let SHOWN = null;              // the id of the author, narrator or publisher shown (#a=...); null until the address is read
/** @type {string | null} */
let EDITING = null;                   // the id of whom the form is editing, or null
/** @type {string | null} */
let REMOVING = null;                  // whom Remove was pressed for once, which a second press removes
/** @type {string | null} */
let JOINING = null;                   // the name of another one Save was pressed once to rename them to, which a second press joins

const bookHref = (/** @type {Book} */ b)=> bookPageHref(b.id || '');
const seriesHref = (/** @type {string} */ name)=> seriesPageHref(CATALOG.idFor('series', name));
/** @type {(names: string[], href: (name: string) => string) => Child[]} */
const nameLinks = (names, href)=> joined(names.map(x=> buildElement('a', {href: href(x)}, x)), ', ');
/** @returns {Map<string, Contributor>} what the catalog keeps about the page's kind, by id */
const kept = ()=> CATALOG[KIND.infoKey];
/** @type {(id: string) => string} the name of the one stored under `id` */
const nameOf = id=> CATALOG.nameOf(KIND.infoKey, id) ?? '';

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
	if(SHOWN === null) return;
	document.title = nameOf(SHOWN) + spell(' · Audiobook Catalog');
	renderCreditPage(SHOWN);
}

/**
 * The record of the one stored under `id`, and their books.
 * @param {string} id
 */
async function loadCredited(id){
	const credited = await queryCatalog(r=> r.allKeys('credits', 'byTitle', r.keyRange.bound([id], [id, []])));
	await loadRecords({books: credited.map(key=> /** @type {string} */ (/** @type {IDBValidKey[]} */ (key)[1])), contributors: [id]});
}

// Their record and their books.
async function loadShown(){
	if(SHOWN === null) return;
	const id = SHOWN;
	await loadCredited(id);
	// someone no book has got an id from the address alone, which loading the records dropped: they get one again
	const named = valueFromPageHash(location.hash, KIND.hashKey);
	if(CATALOG.nameOf(KIND.infoKey, id) === undefined && named !== null && idFromAddress(KIND.infoKey, named) === null) SHOWN = CATALOG.idFor(KIND.infoKey, named);
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
	if(KIND !== CREDIT_KINDS.author) return buildElement('p', {class: 'series-title'}, link, ' ', buildElement('span', {class: 'n'}, Text.plural(s.books.length, 'book')));
	const si = CATALOG.seriesInfo(s.name);
	return buildElement('p', {class: 'series-title'}, link,
		' ', buildElement('span', {class: 'n'}, `${Series.owned(s.books)} owned${si ? ' of ' + si.total : ''}`),
		si && [' ', buildElement('span', {class: `status ${si.status}`}, si.status === 'complete' ? 'complete' : 'ongoing')]);
}

/**
 * On an author's page, the numbers of a series that none of their books has, up to its released total.
 * @param {{name: string, books: Book[]}} s
 * @returns {HTMLParagraphElement | false}
 */
function missingNote(s){
	const si = KIND === CREDIT_KINDS.author && CATALOG.seriesInfo(s.name);
	const missing = si && si.missing(s.books);
	return !!missing && missing.length > 0 && buildElement('p', {class: 'series-note'}, `missing ${Series.numberList(missing)}`);
}

/** @param {string} id */
function renderCreditPage(id){
	const name = nameOf(id);
	const info = kept().get(id) || new Contributor(name);
	const {series, titles} = KIND.works(name);
	const count = series.reduce((n, s)=> n + s.books.length, 0) + titles.length;
	byId('subtitle').textContent = count
		? `${Text.plural(count, 'audiobook')}${series.length ? ' in ' + Text.plural(series.length, 'series', 'series') : ''}${series.length && titles.length ? ` and ${titles.length} outside a series` : ''}`
		: spell(KIND.none);
	/** @type {(href: string, text: string) => HTMLAnchorElement} */
	const link = (href, text)=> buildElement('a', {class: 'authorlink', href, target: '_blank', rel: 'noopener'}, `${text} ↗`);
	// their own site, their pages in external catalogs, then any other link (by its site's name)
	const links = [info.url && link(info.url, 'Website'), ...externalLinks(info.external, KIND.one),
		...info.links.map(href=> link(href, (Text.webHost(href) || href).replace(/^www\./, '')))].filter(x=> !!x);
	/** @type {Child[]} */
	const out = [
		buildElement('div', {class: 'author-head'}, buildElement('h2', {class: 'author-name'}, name)),
		info.bio && buildElement('div', {class: 'author-bio'}, bioParagraphs(info.bio)),
		links.length > 0 && buildElement('p', {class: 'author-links'}, joined(links, ' ')),
		!info.bio && !links.length && buildElement('p', {class: 'hint'}, 'No bio or links yet: add them with Edit, at the end of the page.'),
		KIND === CREDIT_KINDS.author && count > 0 && buildElement('p', {class: 'author-actions'},
			buildElement('a', {class: 'hardcoverCompare', href: hardcoverCompareHref('author', id)}, 'Compare their books with Hardcover')),
	];
	series.forEach(s=> out.push(buildElement('div', {class: 'series-group'}, seriesHeading(s), missingNote(s),
		buildElement('ul', {class: 'author-books'}, s.books.map(b=> creditBookLine(b, name))))));
	if(titles.length){
		out.push(buildElement('div', {class: 'series-group'},
			buildElement('p', {class: 'series-title'}, series.length ? 'Outside a series' : 'Titles', ' ', buildElement('span', {class: 'n'}, Text.plural(titles.length, 'book'))),
			buildElement('ul', {class: 'author-books'}, titles.map(b=> creditBookLine(b, name)))));
	}
	// viewing them comes first, so editing them comes after their books
	out.push(buildElement('div', {class: 'page-actions'},
		buildElement('button', {type: 'button', class: 'aedit', onclick: ()=> openCreditForm(id)}, 'Edit')));
	fillElement(byId('creditBody'), out);
}

// ------------------------------------------------------------------ the form
/**
 * Edits what CATALOG.authors (or .narrators, .publishers) keeps about someone; like every edit, it is kept
 * in this browser (see persist in store.js). Remove takes them off their books and removes them.
 * @param {string} id the id they are stored under
 */
function openCreditForm(id){
	const name = nameOf(id);
	const info = kept().get(id) || new Contributor(name);
	EDITING = id; REMOVING = null; JOINING = null;
	byId('creditFormTitle').textContent = `Edit ${KIND.one}: ${name}`;
	fieldById('cf_name').value = name;
	fieldById('cf_bio').value = info.bio || '';
	fieldById('cf_url').value = info.url || '';
	fillExternalFields('cf_ext_', KIND.one, info.external);
	byId('creditFormError').textContent = '';
	byId('creditSaveBtn').textContent = `Save ${KIND.one}`;
	byId('creditRemoveBtn').textContent = `Remove ${KIND.one}`;
	const form = byId('creditForm');
	form.classList.add('open');
	form.scrollIntoView({behavior: 'smooth', block: 'center'});
}

function closeCreditForm(){
	EDITING = null; REMOVING = null; JOINING = null;
	const form = /** @type {HTMLFormElement} */ (byId('creditForm'));
	form.classList.remove('open');
	form.reset();
	byId('creditFormError').textContent = '';
}

// The form belongs to the page shown; another page closes it.
function homeCreditForm(){
	if(EDITING !== null && EDITING !== SHOWN) closeCreditForm();
}

/** @param {string} text */
const showFormError = text=> { byId('creditFormError').textContent = text; };

/**
 * Save the form: what is kept about them, and their name, which a rename changes on every book that credits
 * them. Renaming them to someone the catalog has already takes a second Save, and joins the two: every
 * book credits the one name, and what this form has wins over what the other has, which fills in the rest.
 */
async function saveCreditForm(){
	const id = EDITING;
	if(id === null) return;
	// a Hardcover address is looked up for its number first, unless the form is closed or moved meanwhile
	const lookup = lookupHardcoverField('cf_ext_', KIND.one);
	const hardcover = lookup ? await lookup : {error: '', note: ''};
	if(EDITING !== id) return;
	// they may have been renamed in another tab meanwhile, so their name is read now
	const name = nameOf(id);
	if(hardcover.error) return showFormError(hardcover.error);
	const newName = Text.tidy(fieldById('cf_name').value);
	if(!newName) return showFormError(`Give the ${KIND.one} a name.`);
	// a publisher is one name, but authors and narrators are a list the book form splits
	if(KIND !== CREDIT_KINDS.publisher && Text.splitNames(newName).join('\n') !== newName){
		return showFormError(`${newName} would be read as several ${KIND.many}: a comma, a semicolon, "&" or "and" separates names.`);
	}
	const renamed = newName !== name;
	const had = kept().get(id);
	const external = readExternalFields('cf_ext_', KIND.one, had ? had.external : {});
	if(external.bad.length) return showFormError(`Not an id or address there: ${external.bad.join('; ')}.`);
	// the links the form has no field for are kept
	const entry = Contributor.tidy(newName, {bio: fieldById('cf_bio').value, url: fieldById('cf_url').value, ext: external.ids, links: had ? had.links : []});
	// the same rules as Check, applied to this entry alone (under the name their books have now); an id in
	// a catalog this app doesn't know is only a warning there, but here it is most likely a mistake
	if(entry){
		const {errors, warnings} = Validator.validateContributors(JSON.parse(JSON.stringify(CATALOG.books)), KIND.infoKey, {[name]: entry.toJSON()});
		const problems = [...errors, ...warnings.filter(w=> !/is a page on/.test(w))].map(e=> e.replace(/^\w+\[[^\]]*\]: /, ''));
		if(problems.length) return showFormError(problems.join('; '));
	}
	// the one the new name is, with their books, which join these
	if(renamed){
		/** @type {ContributorRecord[]} */
		const named = await queryCatalog(r=> r.all('contributors', 'kindName', [KIND.one, newName]));
		for(const rec of named) await loadCredited(rec.id);
		if(EDITING !== id) return;
	}
	const joins = renamed ? CATALOG.nameIds[KIND.infoKey].get(newName) : undefined;
	// joining another is easy to do by mistake, so the first Save says so
	if(joins !== undefined && JOINING !== newName){
		JOINING = newName;
		return showFormError(`There is already ${/^[aeiou]/.test(KIND.one) ? 'an' : 'a'} ${KIND.one} called ${newName}. Press Save again to join them: ` +
			`every book of either will credit ${newName}, with what this form has, and what ${newName} has where this form is empty.`);
	}
	const other = joins === undefined ? undefined : kept().get(joins);
	// renamed on their books, keeping the id they are stored under (or taking the id of the one they join)
	const count = renamed ? CATALOG.renameEntry(KIND.infoKey, name, newName) : 0;
	const newId = CATALOG.idFor(KIND.infoKey, newName);
	const info = other ? Contributor.tidy(newName, {bio: entry?.bio || other.bio, url: entry?.url || other.url,
		ext: {...other.external, ...entry?.external}, links: [...new Set([...other.links, ...entry?.links || []])]}) : entry;
	if(info) kept().set(newId, info); else kept().delete(newId);
	closeCreditForm();
	// the page shows them under their new name, and its address names them by id (an old link may have named them)
	if(renamed){
		SHOWN = newId;
		setAddress('replace', KIND.href(newName));
	}
	render(); persist();
	showIoStatus((renamed ? `Renamed ${name} to ${newName} on ${Text.plural(count, 'book')}.` : `Saved ${newName}.`) + (hardcover.note ? ' ' + hardcover.note : ''));
}

/**
 * Remove: the first press says what it does, the second takes them off their books (the editions they
 * read or publish) and removes them. The page loaded every book that credits them.
 */
function removeCredit(){
	const id = EDITING;
	if(id === null) return;
	const name = nameOf(id);
	const problem = CATALOG.removeProblem(KIND.infoKey, id);
	if(problem){ byId('creditFormError').textContent = problem; return; }
	const count = CATALOG.booksOf(KIND.infoKey, id).length;
	if(REMOVING !== id){
		REMOVING = id;
		byId('creditFormError').textContent = (count ? `This takes ${name} off ${Text.plural(count, 'book')}${KIND === CREDIT_KINDS.author ? '' : `' editions`}, which stay in the catalog, and removes them.`
			: `This removes ${name}, whom no book credits.`) + ` Press Remove ${KIND.one} again to do it.`;
		return;
	}
	CATALOG.removeEntry(KIND.infoKey, id);
	closeCreditForm();
	persist();
	// their page is gone: it says so, with the way back to the list
	byId('subtitle').textContent = '';
	fillElement(byId('creditBody'), buildElement('p', {class: 'empty'}, `${name} was removed. `, buildElement('a', {href: KIND.list}, `All ${KIND.many}`)));
	showIoStatus(count ? `Removed ${name} from ${Text.plural(count, 'book')}.` : `Removed ${name}.`);
}

// ------------------------------------------------------------------ the address
// author.html#a=id is an author's page (likewise #n= and #p=); links between them change only the address,
// so Back and Forward step through them. Without one the page goes to the list.
/**
 * The id of the one the address names (by their id, or their name, as stored), or null when it names no
 * one. A name the catalog doesn't have gets an id too, so their page says so (and saving the form adds them).
 * @returns {Promise<string | null>}
 */
async function shownInAddress(){
	const value = valueFromPageHash(location.hash, KIND.hashKey);
	if(value === null) return null;
	const stored = await queryCatalog(async r=>{
		/** @type {ContributorRecord[]} */
		const [rec] = await r.get('contributors', [value]);
		if(rec && rec.kind === KIND.one) return rec.id;
		/** @type {ContributorRecord[]} */
		const [named] = await r.all('contributors', 'kindName', [KIND.one, value]);
		return named ? named.id : null;
	});
	return stored ?? idFromAddress(KIND.infoKey, value) ?? CATALOG.idFor(KIND.infoKey, value);
}

/**
 * Show what the address names, once what it needs is loaded; an address naming no one goes to the list.
 * @returns {Promise<void>}
 */
export function showAddress(){
	return afterSaving(async ()=>{
		const id = await shownInAddress();
		if(id === null){ location.replace(KIND.list); return; }
		if(id === SHOWN && byId('creditBody').hasChildNodes()) return;
		const moved = id !== SHOWN;
		SHOWN = id;
		await loadShown();
		render();
		if(moved && typeof scrollTo === 'function') scrollTo(0, 0);
	});
}

// After a save took in what another tab changed: read them again; when the other tab removed them, go to the list.
function refreshShown(){
	return afterSaving(async ()=>{
		await loadShown();
		if(SHOWN !== null && CATALOG.nameOf(KIND.infoKey, SHOWN) === undefined){ location.replace(KIND.list); return; }
		render();
	});
}

/**
 * Start an author's, a narrator's or a publisher's page.
 * @param {'author' | 'narrator' | 'publisher'} kind
 * @returns {Promise<void>}
 */
export function startCreditPage(kind){
	KIND = CREDIT_KINDS[kind];
	if(valueFromPageHash(location.hash, KIND.hashKey) === null){ location.replace(KIND.list); return Promise.resolve(); }
	byId('cf_url_label').textContent = KIND.site[0];
	byId('cf_url').setAttribute('placeholder', KIND.site[1]);
	fillElement(byId('cf_ext'), externalFields('cf_ext_', KIND.one));
	byId('creditForm').addEventListener('submit', e=>{ e.preventDefault(); return saveCreditForm(); });
	byId('creditRemoveBtn').addEventListener('click', removeCredit);
	byId('cancelCredit').addEventListener('click', closeCreditForm);
	addEventListener('hashchange', showAddress);
	addEventListener('popstate', showAddress);
	return startPage(async ()=>{ SHOWN = await shownInAddress(); await loadShown(); render(); }, {refresh: refreshShown});
}
