// The import and export page: adding books from Audible and Goodreads exports, Hardcover, and backups.
// It shows only how many books there are until an action needs every book (an import, Check, Box sets,
// Hardcover, Export, Restore or Merge), and then holds the whole catalog. Loading and saving live in store.js.
import {Text} from './modules/text.js';
import {Catalog} from './modules/catalog.js';
import {Backup} from './modules/backup.js';
import {CatalogRecords} from './modules/catalog-records.js';
import {AudibleImporter} from './modules/audible-importer.js';
import {GoodreadsImporter} from './modules/goodreads-importer.js';
import {GoodreadsExporter} from './modules/goodreads-exporter.js';
import {HardcoverClient} from './modules/hardcover-client.js';
import {HardcoverSync} from './modules/hardcover-sync.js';
import {
	CATALOG, SEEN_REVISION, storedRevision, whenSaved, persist, addExclusions, showIoStatus,
	minutes, showHardcoverJob, HARDCOVER_TOKEN_KEY, browserHardcoverToken,
	hardcoverClient, startPage, afterSaving, queryCatalog, wholeCatalog, byId, fieldById, BRITISH, spell, buildElement, fillElement
} from './store.js';
/** @import {Child} from './store.js' */
/** @import {Book} from './modules/book.js' */
/** @import {Importer} from './modules/importer.js' */
/** @import {HardcoverJob} from './store.js' */

/** @typedef {HardcoverJob['mode']} HardcoverMode */
/** @typedef {'audible' | 'goodreads'} ImportKind */

function refreshPage(){
	return afterSaving(async ()=>{
		const count = await queryCatalog(r=> r.count('books'));
		byId('subtitle').textContent = spell(`${count} audiobooks in the catalog`);
	});
}

/**
 * Run `task` once the page holds the whole catalog, which it keeps from then on; undefined when it can't be read.
 * @template T
 * @param {() => T} task
 * @returns {Promise<T | undefined>}
 */
async function withWholeCatalog(task){
	try{
		await wholeCatalog();
	}catch(e){
		showIoStatus(spell(`Couldn't read the catalog kept in this browser: ${Text.errorText(e)}. Reload the page.`), true);
		return undefined;
	}
	return task();
}

/**
 * Hand the browser `text` as a file to save, named `name` and today's date.
 * @param {string} text
 * @param {string} type its media type: 'text/csv' or 'application/json'
 * @param {string} name
 */
function download(text, type, name){
	const blob = new Blob([text], {type});
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = name + '-' + new Date().toISOString().slice(0,10) + (type === 'text/csv' ? '.csv' : '.json');
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	URL.revokeObjectURL(url);
}

function exportBackup(){
	// {books, seriesInfo, authors, narrators, publishers, excluded, notDuplicates} (Catalog.toJSON)
	download(JSON.stringify(CATALOG, null, '\t'), 'application/json', 'audiobook-catalog-backup');
	showIoStatus('Backup downloaded.');
}

function exportGoodreads(){
	const out = new GoodreadsExporter().write(CATALOG.books);
	download(out.csv, 'text/csv', 'goodreads-import');
	/** @type {string[]} */
	const notes = [];
	if(out.withoutIds) notes.push(`${out.withoutIds} without a Goodreads id or ISBN, which Goodreads finds by title and author`);
	if(out.withoutDate) notes.push(`${out.withoutDate} without a full date read`);
	showIoStatus(`Goodreads CSV with ${out.books} books downloaded${notes.length ? ' (' + notes.join('; ') + ')' : ''}.`);
}

/**
 * What a FileReader that was asked to readAsText() read: its onload event's target is the reader, and
 * its result a string.
 * @param {ProgressEvent<FileReader>} e
 * @returns {string}
 */
const readText = e => /** @type {string} */ (/** @type {FileReader} */ (e.target).result);

/**
 * Pick the files to read; resolves to [{name, text}].
 * @param {Iterable<File>} files
 * @returns {Promise<{name: string, text: string}[]>}
 */
function readFiles(files){
	return Promise.all([...files].map(file=> /** @type {Promise<{name: string, text: string}>} */ (new Promise((resolve, reject)=>{
		const reader = new FileReader();
		reader.onload = e=> resolve({name: file.name, text: readText(e)});
		reader.onerror = ()=> reject(new Error(`couldn't read ${file.name}`));
		reader.readAsText(file);
	}))));
}

/**
 * Restore: a backup, or the data files of a catalog from before it lived in the browser
 * (books.json, series-info.json, ... picked together; Backup.readFiles), replaces the catalog.
 * @param {File[]} files
 */
async function importBackup(files){
	if(!await withWholeCatalog(()=> true)) return;   // what it replaces is all of it
	try{
		const {books, series, authors, narrators, publishers, excluded, notDuplicates, nameIds} = Backup.readFiles(await readFiles(files));
		const bad = books.some(b=> !b.title || !b.authors.length);
		if(bad) throw new Error('missing title/author');
		// the catalog is kept as records, which have no place for a value that isn't what its field holds
		const unstorable = CatalogRecords.unstorable(new Catalog({books, series: series || undefined, authors: authors || undefined,
			narrators: narrators || undefined, publishers: publishers || undefined}));
		if(unstorable.length){
			showIoStatus(`Not restored: fix these values in the backup first (they aren't what their field holds): ${unstorable.slice(0, 3).join('; ')}` +
				(unstorable.length > 3 ? ` and ${unstorable.length - 3} more.` : '.'), true);
			return;
		}
		// the info kept is by name here, as it is moved over to the ids its names have
		const keptInfo = /** @type {const} */ (['series', 'authors', 'narrators', 'publishers']).map(kind=> /** @type {const} */ ([kind, CATALOG.infoByName(kind)]));
		// and the marks are taken as text, to point them at the books restored
		const keptMarks = CATALOG.markTexts();
		CATALOG.books = books;
		CATALOG.marks = new Map();
		if(nameIds) CATALOG.nameIds = nameIds;          // the ids series and people were stored under, when the backup has them
		for(const [kind, had] of keptInfo){
			// older backups have no series info, nor author, narrator and publisher info: keep the current one
			const restored = {series, authors, narrators, publishers}[kind];
			CATALOG.replaceInfo(kind, restored || had);
		}
		const newlyExcluded = addExclusions(excluded || []);   // added to, never replaced: removing one is a hand edit
		CATALOG.addMarkTexts([...keptMarks, ...notDuplicates || []]);   // likewise the pairs marked "Not duplicates"
		refreshPage(); persist();
		showIoStatus(`Restored ${books.length} books` + (series ? ` and info for ${series.size} series` : '') +
			(newlyExcluded ? `; ${newlyExcluded} more excluded from imports.` : '.'));
	}catch(err){
		showIoStatus(spell("Couldn't read that — pick a catalog backup JSON, or your books.json with the other data files."), true);
	}
}

// ------------------------------------------------------------ Audible / Goodreads CSV import
// Read the export, merge it into a copy of the catalog, show what would change, and only apply it
// when confirmed. Like every edit in the page, the result is then saved (see persist).
/** @type {Record<ImportKind, () => Importer>} */
const IMPORTERS = {
	// an Audible export's ASINs are those of the site picked beside the buttons (audible.com unless changed)
	audible: ()=> new AudibleImporter(fieldById('audibleImportSite').value),
	goodreads: ()=> new GoodreadsImporter(),
};
/** @type {ImportKind} */
let IMPORT_KIND = 'audible';
/** @type {Book[] | null} */
let PENDING_IMPORT = null;   // the books of the import previewed, until it is applied or canceled

/**
 * Merge into a copy of the catalog, so nothing changes until the result is known to be valid.
 * @param {Book[]} books
 */
function mergeIntoCopy(books){
	const copy = CATALOG.clone();
	const report = copy.merge(books);
	// series-info problems are not the import's doing (a series renamed in the page); only block on the books
	const errors = copy.validate().errors.filter(e=> !e.startsWith('series-info'));
	return {copy, report, errors};
}

/**
 * A book in a preview list: title, author and series.
 * @param {Book} b
 * @returns {string}
 */
function bookLine(b){
	const series = b.series ? `  [${b.series}${b.number ? ' #' + b.number : ''}]` : '';
	return `${b.title} \u2014 ${Text.namesText(b.authors)}${series}`;
}

/**
 * A paragraph of the preview.
 * @param {string} text
 * @param {string} [className]
 * @returns {HTMLParagraphElement}
 */
const para = (text, className)=> buildElement('p', {class: className}, text);

/**
 * A list of messages, at most `limit` of them, saying how many more there are; nothing when there are none.
 * @param {string[]} items
 * @param {number} [limit]
 * @returns {HTMLUListElement | null}
 */
function messageList(items, limit = Infinity){
	if(!items.length) return null;
	return buildElement('ul', {}, items.slice(0, limit).map(m=> buildElement('li', {}, m)),
		items.length > limit && buildElement('li', {}, `\u2026and ${items.length - limit} more`));
}

/**
 * Show what importing an export would do, in the preview.
 * @param {ImportKind} kind
 * @param {string} text the export's text
 * @param {string} fileName
 */
function previewImport(kind, text, fileName){
	const importer = IMPORTERS[kind]();
	const result = importer.read(text);
	const {report, errors} = mergeIntoCopy(result.books);
	const changes = report.added.length + report.backfilled.length + report.goodreadsFilled.length + report.datesFilled.length +
		report.isbnsFilled.length + report.detailsFilled.length + report.editionsAdded.length;
	PENDING_IMPORT = errors.length || !changes ? null : result.books;
	PENDING_HARDCOVER = null;
	PENDING_MERGE = null;
	PENDING_TIDY = null;
	byId('mergePrefer').classList.remove('show');

	/** @type {Child[]} */
	const out = [para(`${Text.plural(result.books.length, 'finished book')} read from ${fileName}`)];
	out.push(para(spell(`Already in the catalog: ${report.matched}`)));
	if(result.skippedUnfinished) out.push(para(`Not finished yet, skipped: ${result.skippedUnfinished}`));
	if(report.backfilled.length) out.push(para(`ASINs filled in on existing books: ${report.backfilled.length}`));
	if(report.goodreadsFilled.length) out.push(para(`Goodreads ids filled in on existing books: ${report.goodreadsFilled.length}`));
	if(report.datesFilled.length) out.push(para(`Dates read filled in on existing books: ${report.datesFilled.length}`));
	if(report.isbnsFilled.length) out.push(para(`ISBNs added to existing books: ${report.isbnsFilled.length}`));
	if(report.detailsFilled.length) out.push(para(`Narrator, publisher, release date or length filled in on existing books: ${report.detailsFilled.length}`));
	if(report.editionsAdded.length) out.push(para(`Other editions added to existing books: ${report.editionsAdded.length}`));
	if(report.excluded.length) out.push(para(`Skipped (excluded from imports): ${report.excluded.length}`));
	if(report.boxSets.length){
		out.push(para(`Box sets split into their titles, each with the set's edition: ${report.boxSets.length}`),
			messageList(report.boxSets.map(b=> `${b.title} \u2014 ${Text.namesText(b.authors)}: ${b.titles} already here, ${b.added} added`)));
		if(report.boxSets.some(b=> b.added)) out.push(para(spell('A title not in the catalog yet is named \u201CSeries, Book N\u201D until you rename it on its card.')));
	}
	out.push(para(`New: ${report.added.length}`), messageList(report.added.map(bookLine)));
	if(result.warnings.length){
		out.push(para(`Needs a look (${result.warnings.length}):`, 'warn'), messageList(result.warnings));
	}
	if(errors.length){
		out.push(para('Validation failed, nothing will be changed:', 'warn'), messageList(errors.slice(0, 10)));
	} else if(!changes){
		out.push(para('Nothing new to add.'));
	}

	byId('importPreviewTitle').textContent = `${importer.label} import`;
	fillElement(byId('importPreviewBody'), out);
	const confirmBtn = byId('importConfirm');
	confirmBtn.style.display = PENDING_IMPORT ? '' : 'none';
	confirmBtn.textContent = report.added.length
		? `Add ${Text.plural(report.added.length, 'book')}`
		: report.backfilled.length ? 'Save ASINs' : report.goodreadsFilled.length ? 'Save Goodreads ids' : report.datesFilled.length ? 'Save dates read'
		: report.editionsAdded.length ? 'Save editions' : report.isbnsFilled.length ? 'Save ISBNs' : 'Save edition details';
	byId('importCancel').textContent = PENDING_IMPORT ? 'Cancel' : 'Close';
	openPreview(`${kind}Panel`);
}

function applyImport(){
	if(!PENDING_IMPORT) return;
	// merged again, in case books were edited while the preview was open
	const {copy, report, errors} = mergeIntoCopy(PENDING_IMPORT);
	closeImportPreview();
	if(errors.length){ showIoStatus(spell('The catalog changed and the import no longer validates; nothing was added.'), true); return; }
	const added = report.added.length, backfilled = report.backfilled.length, dated = report.datesFilled.length;
	const withIsbns = report.isbnsFilled.length, withGr = report.goodreadsFilled.length;
	const withEditions = report.editionsAdded.length, withDetails = report.detailsFilled.length;
	CATALOG.books = copy.books;
	refreshPage(); persist();
	const done = `Added ${Text.plural(added, 'book')}` +
		(backfilled ? `, filled in ${Text.plural(backfilled, 'ASIN')}` : '') +
		(withGr ? `, filled in ${Text.plural(withGr, 'Goodreads id')}` : '') +
		(dated ? `, filled in dates read on ${Text.plural(dated, 'book')}` : '') +
		(withIsbns ? `, added ISBNs to ${Text.plural(withIsbns, 'book')}` : '') +
		(withEditions ? `, added editions to ${Text.plural(withEditions, 'book')}` : '') +
		(withDetails ? `, filled in edition details on ${Text.plural(withDetails, 'book')}` : '') + '.';
	showIoStatus(done);
}

// ------------------------------------------------------------ Merge a backup from another device
// Restore replaces the catalog; Merge is for two catalogs that have both changed since they were
// last the same (the phone and the PC, say), so neither side's edits are lost (Backup.mergeInto).
// Like a CSV import it is previewed first, and only applied when confirmed.
/** @type {{backup: Backup, fileName: string} | null} */
let PENDING_MERGE = null;      // {backup, fileName} while its preview is open

/**
 * The catalog merged with a backup, in copies, with what blocks it and how many changes it makes.
 * @param {Backup} backup
 */
function mergeIntoCatalog(backup){
	// the select's options are 'mine' and 'backup'
	const prefer = /** @type {'mine' | 'backup'} */ (fieldById('mergePreferSelect').value);
	const m = backup.mergeInto(CATALOG, prefer);
	// series info left without books is expected after a series was renamed; anything else blocks
	const merged = new Catalog({books: m.books, series: m.series, authors: m.authors, narrators: m.narrators, publishers: m.publishers});
	const errors = merged.validate({contributors: true}).errors.filter(e=> !/^series-info: .* matches no series/.test(e));
	const changes = m.added.length + m.updated.length + m.removed.length + m.infoAdded.length + m.infoChanged.length +
		m.authorsAdded.length + m.authorsChanged.length + m.narratorsAdded.length + m.narratorsChanged.length +
		m.publishersAdded.length + m.publishersChanged.length + m.excluded.length + m.notDuplicates.length;
	return {m, errors, changes};
}

function previewMerge(){
	if(!PENDING_MERGE) return;
	const {backup, fileName} = PENDING_MERGE;
	const {m, errors, changes} = mergeIntoCatalog(backup);
	const list = (/** @type {Book[]} */ books) => messageList(books.map(bookLine));
	/** @type {Child[]} */
	const out = [para(`${backup.books.length} books in ${fileName}; ${m.books.length} after merging.`)];
	out.push(para(`New from the backup: ${m.added.length}`), list(m.added));
	out.push(para(`Gaining genres, dates read or editions${m.conflicts.length ? ', or the version kept below' : ''}: ${m.updated.length}`));
	out.push(para(`Removed (removed on the other device): ${m.removed.length}`), list(m.removed));
	if(m.skipped.length) out.push(para(`Not added back (removed here): ${m.skipped.length}`));
	if(m.conflicts.length){
		const kept = fieldById('mergePreferSelect').value === 'backup' ? "the backup's" : spell("this catalog's");
		out.push(para(`Title, author or series differ, keeping ${kept}: ${m.conflicts.length}`),
			messageList(m.conflicts.map(c=> `${bookLine(c.mine)} / backup: ${bookLine(c.theirs)}`)));
	}
	const infoDiffer = m.infoChanged.length + m.infoKept.length;
	if(m.infoAdded.length || infoDiffer){
		out.push(para(`Series info: ${m.infoAdded.length} added` + (infoDiffer ? `, ${infoDiffer} differing (keeping ${m.infoChanged.length ? "the backup's" : spell("this catalog's")})` : '')));
	}
	for(const [label, added, changed, kept] of /** @type {[string, string[], string[], string[]][]} */ ([
		['Author info', m.authorsAdded, m.authorsChanged, m.authorsKept],
		['Narrator info', m.narratorsAdded, m.narratorsChanged, m.narratorsKept],
		['Publisher info', m.publishersAdded, m.publishersChanged, m.publishersKept]])){
		const differ = changed.length + kept.length;
		if(added.length || differ){
			out.push(para(`${label}: ${added.length} added` + (differ ? `, ${differ} differing (keeping ${changed.length ? "the backup's" : spell("this catalog's")})` : '')));
		}
	}
	if(m.excluded.length) out.push(para(`More books excluded from imports: ${m.excluded.length}`));
	if(m.notDuplicates.length) out.push(para(`More books marked "Not duplicates": ${m.notDuplicates.length}`));
	if(errors.length){
		out.push(para('Validation failed, nothing will be changed:', 'warn'), messageList(errors.slice(0, 10)));
	} else if(!changes){
		out.push(para(spell('Nothing to merge: this catalog already has everything in the backup.')));
	}
	const ok = !errors.length && changes;
	byId('importPreviewTitle').textContent = 'Merge a backup';
	fillElement(byId('importPreviewBody'), out);
	byId('mergePrefer').classList.add('show');
	const confirmBtn = byId('importConfirm');
	confirmBtn.style.display = ok ? '' : 'none';
	confirmBtn.textContent = 'Merge';
	byId('importCancel').textContent = ok ? 'Cancel' : 'Close';
	openPreview('backupPanel');
}

function applyMerge(){
	if(!PENDING_MERGE) return;
	// merged again, in case books were edited while the preview was open
	const {m, errors, changes} = mergeIntoCatalog(PENDING_MERGE.backup);
	closeImportPreview();
	if(errors.length || !changes){ showIoStatus(spell('The catalog changed and the merge no longer applies; nothing was changed.'), true); return; }
	CATALOG.books = m.books;
	CATALOG.replaceInfo('series', m.series);
	CATALOG.replaceInfo('authors', m.authors);
	CATALOG.replaceInfo('narrators', m.narrators);
	CATALOG.replaceInfo('publishers', m.publishers);
	addExclusions(m.excluded);
	CATALOG.addMarkTexts(m.notDuplicates);
	refreshPage(); persist();
	showIoStatus(`Merged: ${m.added.length} added, ${m.updated.length} updated, ${m.removed.length} removed.`);
}

/**
 * Read a backup to merge, and preview the merge.
 * @param {File} file
 */
function mergeBackupFile(file){
	const reader = new FileReader();
	reader.onload = async e=>{
		if(!await withWholeCatalog(()=> true)) return;
		try{
			const backup = Backup.read(JSON.parse(readText(e)));
			if(backup.books.some(b=> !b.title || !b.authors.length)) throw new Error('missing title/author');
			PENDING_IMPORT = null;
			PENDING_HARDCOVER = null;
			PENDING_MERGE = {backup, fileName: file.name};
			PENDING_TIDY = null;
			previewMerge();
		}catch(err){
			closeImportPreview();
			showIoStatus(spell("Couldn't read that file \u2014 make sure it's a catalog backup JSON."), true);
		}
	};
	reader.readAsText(file);
}

// ------------------------------------------------------------ Check the catalog, box sets
// The check lists errors and warnings; box sets are previewed like an import and only applied when confirmed.
/** @type {'box-sets' | null} */
let PENDING_TIDY = null;   // 'box-sets', while its preview is open

/**
 * Show the check or the box sets in the preview; its confirm button (labeled `confirm`) shows when PENDING_TIDY is set.
 * @param {string} title
 * @param {Child[]} body
 * @param {string} confirm
 */
function showTidyPreview(title, body, confirm){
	PENDING_IMPORT = null;
	PENDING_HARDCOVER = null;
	PENDING_MERGE = null;
	byId('mergePrefer').classList.remove('show');
	byId('importPreviewTitle').textContent = title;
	fillElement(byId('importPreviewBody'), body);
	const confirmBtn = byId('importConfirm');
	confirmBtn.style.display = PENDING_TIDY ? '' : 'none';
	confirmBtn.textContent = confirm;
	byId('importCancel').textContent = PENDING_TIDY ? 'Cancel' : 'Close';
	openPreview('checkPanel');
}

function checkCatalog(){
	const {errors, warnings} = CATALOG.validate({contributors: true});
	const series = new Set(CATALOG.books.filter(b=> b.series).map(b=> b.series)).size;
	const withInfo = [Text.plural(CATALOG.authors.size, 'author'), Text.plural(CATALOG.narrators.size, 'narrator'), Text.plural(CATALOG.publishers.size, 'publisher')];
	/** @type {Child[]} */
	const out = [para(`${CATALOG.books.length} books, ${series} series, ${CATALOG.series.size} with release info, ` +
		`${withInfo.join(', ')} with info.`)];
	if(errors.length) out.push(para(`Errors (${errors.length}):`, 'warn'), messageList(errors, 100));
	if(warnings.length) out.push(para(`Needs a look (${warnings.length}):`, 'warn'), messageList(warnings, 100));
	if(!errors.length && !warnings.length) out.push(para('No problems found.'));
	PENDING_TIDY = null;
	showTidyPreview(spell('Check the catalog'), out, '');
}

// Keep each box set as its own book and as its titles, in a copy of the catalog (Catalog.addBoxSets).
function boxSetsIntoCopy(){
	const copy = CATALOG.clone();
	const report = copy.addBoxSets();
	const errors = copy.validate().errors.filter(e=> !e.startsWith('series-info'));
	return {copy, report, errors};
}

function previewBoxSets(){
	const {report, errors} = boxSetsIntoCopy();
	/** @type {Child[]} */
	const out = [para(`Box sets: ${report.boxSets.length}`),
		messageList(report.boxSets.map(b=> `${b.title} \u2014 ${Text.namesText(b.authors)}: ${Text.plural(b.titles, 'title')} already here`))];
	if(report.excluded.length) out.push(para(`Skipped (excluded from imports): ${report.excluded.length}`));
	out.push(para(`New: ${report.added.length}`), messageList(report.added.map(bookLine)));
	if(report.boxSets.some(b=> b.added)){
		out.push(para(spell('A title not in the catalog yet is named \u201CSeries, Book N\u201D until you rename it on its card.')));
	}
	if(errors.length){
		out.push(para('Validation failed, nothing will be changed:', 'warn'), messageList(errors, 10));
	} else if(!report.added.length){
		out.push(para('Every box set is already kept both as its own book and as its titles.'));
	}
	PENDING_TIDY = errors.length || !report.added.length ? null : 'box-sets';
	showTidyPreview('Box sets', out, `Add ${Text.plural(report.added.length, 'book')}`);
}

function applyTidy(){
	closeImportPreview();
	// applied again, in case books were edited while the preview was open
	const {copy, report, errors} = boxSetsIntoCopy();
	if(errors.length){ showIoStatus(spell('The catalog changed and the box sets no longer validate; nothing was changed.'), true); return; }
	CATALOG.books = copy.books;
	refreshPage(); persist();
	const added = report.added.length;
	showIoStatus(`Added ${Text.plural(added, 'book')} for box sets.`);
}

// ------------------------------------------------------------ Hardcover
// The page runs it itself, as Hardcover's API allows browser requests, with a token kept in this browser
// only (never in a backup); it stops if you leave the page, so the browser asks first. A dry run shows
// what would happen, and confirming runs it for real.
/** @type {Record<HardcoverMode, {title: string, confirm: string}>} */
const HARDCOVER_MODES = {
	import: {title: 'Import from Hardcover', confirm: 'Import'},
	export: {title: 'Export to Hardcover', confirm: 'Export to Hardcover'},
	sync: {title: 'Sync with Hardcover', confirm: 'Import and export'},
};
/** @type {HardcoverMode | null} */
export let PENDING_HARDCOVER = null;   // the mode, while its preview is open
/** @type {HardcoverJob | null} */
let PAGE_RUN = null;           // a run going on in this page (showHardcoverJob)

function showHardcoverToken(){
	const saved = Boolean(browserHardcoverToken());
	byId('hardcoverTokenState').textContent = saved
		? 'Your Hardcover API token is saved in this browser only (never in a backup).'
		: 'Paste an API token from hardcover.app/account/api (scopes read:me, read:catalog, read:library and write:library) and save it; it is kept in this browser only (never in a backup).';
	byId('hardcoverTokenRemove').style.display = saved ? '' : 'none';
}

/**
 * Save the token pasted in the page in this browser, or `remove` the saved one.
 * @param {boolean} remove
 */
function saveHardcoverToken(remove){
	const input = fieldById('hardcoverToken');
	if(!remove && !input.value.trim()){ showIoStatus('Paste your Hardcover API token first.', true); return; }
	try{
		if(remove) localStorage.removeItem(HARDCOVER_TOKEN_KEY);
		else localStorage.setItem(HARDCOVER_TOKEN_KEY, HardcoverClient.cleanToken(input.value));
		input.value = '';
		showIoStatus(remove ? 'Hardcover token removed.' : 'Hardcover token saved.');
	}catch(e){
		showIoStatus(`Couldn't ${remove ? 'remove' : 'save'} the token: this browser refused to store it.`, true);
	}
	showHardcoverToken();
}

/**
 * Run `mode` (HardcoverSync.run) on a copy of the catalog, shown in the banner on top. A real
 * run keeps its changes (persist) before sending anything to Hardcover, unless the catalog was edited meanwhile. Returns a promise of the ended run.
 * @param {HardcoverMode} mode
 * @param {boolean} dryRun
 * @returns {Promise<HardcoverJob | undefined>} undefined when it didn't start
 */
async function runHardcover(mode, dryRun){
	if(PAGE_RUN) return;
	const token = browserHardcoverToken();
	if(!token){ showIoStatus('Save your Hardcover API token first (below the buttons).', true); return; }
	if(!await withWholeCatalog(()=> true)) return;
	if(PAGE_RUN) return;
	const started = Date.now();
	/** @type {{out: string[], err: string[]}} */
	const lines = {out: [], err: []};
	/** @type {HardcoverJob} */
	const job = PAGE_RUN = {mode, dryRun, running: true, elapsed: 0, step: 'Starting'};
	const show = () => { job.elapsed = Date.now() - started; showHardcoverJob(job); };
	const ticker = setInterval(show, 1000);
	show();
	await whenSaved();   // this page's own saves don't count as an edit made while it ran
	const before = JSON.stringify(CATALOG.books), seen = SEEN_REVISION;
	const copy = CATALOG.clone();
	const save = async (/** @type {boolean} */ changed) => {
		if(JSON.stringify(CATALOG.books) !== before || await storedRevision() !== seen){
			lines.err.push(spell('error: the catalog was edited while this ran (here or in another tab); nothing written, nothing sent to Hardcover. Run it again.'));
			return false;
		}
		if(changed){
			CATALOG.books = copy.books;
			await persist();
			refreshPage();
			lines.out.push(spell('saved the catalog'));
		}
		return true;
	};
	/** @type {number} */
	let code;
	try{
		code = await new HardcoverSync(hardcoverClient(token)).run(copy, mode, {
			dryRun, save, british: BRITISH,
			out: line => lines.out.push(line), err: line => lines.err.push(line),
			step: (text, done, total) => { Object.assign(job, {step: text, done, total}); show(); },
		});
	}catch(e){
		lines.err.push(`error: ${Text.errorText(e)}`);
		code = 1;
	}
	clearInterval(ticker);
	Object.assign(job, {running: false, code, out: lines.out.join('\n'), err: lines.err.join('\n'), elapsed: Date.now() - started});
	PAGE_RUN = null;
	showHardcoverJob(job);
	showHardcoverResult(mode, job, dryRun);
	if(!dryRun) showIoStatus(code === 0 ? `${HARDCOVER_MODES[mode].title}: done.` : 'Not everything went through; see the details.', code !== 0);
	return job;
}

// Leaving the page stops a run going on in it: the browser asks first. (Nothing is lost by stopping
// early: a run again carries on, as nothing already on Hardcover is added twice.)
addEventListener('beforeunload', e => {
	if(PAGE_RUN && !PAGE_RUN.dryRun){ e.preventDefault(); e.returnValue = ''; }
});

/**
 * Each update of a run (showHardcoverJob in store.js): no second run while one goes.
 * @param {HardcoverJob | null} job
 */
function onHardcoverJob(job){
	const busy = Boolean(job && job.running);
	for(const id of ['hardcoverImportBtn', 'hardcoverExportBtn', 'hardcoverSyncBtn']) /** @type {HTMLButtonElement} */ (byId(id)).disabled = busy;
}

/**
 * Show how a run went in the preview; a `pending` (dry) run that went through can be confirmed.
 * @param {HardcoverMode} mode
 * @param {HardcoverJob} result
 * @param {boolean} pending
 */
function showHardcoverResult(mode, result, pending){
	PENDING_IMPORT = null;
	PENDING_HARDCOVER = pending && result.code === 0 ? mode : null;
	PENDING_MERGE = null;
	PENDING_TIDY = null;
	byId('mergePrefer').classList.remove('show');
	const text = [result.out, result.err].filter(Boolean).join('\n').replace(/\(dry run: nothing written\)\s*$/, '');
	const took = Number.isFinite(result.elapsed) ? ` (took ${minutes(result.elapsed)})` : '';
	byId('importPreviewTitle').textContent = HARDCOVER_MODES[mode].title + (pending ? ': preview' : took);
	fillElement(byId('importPreviewBody'), buildElement('pre', {}, text),
		pending && result.code === 0 && para('Nothing has changed yet, here or on Hardcover.'));
	const confirmBtn = byId('importConfirm');
	confirmBtn.style.display = PENDING_HARDCOVER ? '' : 'none';
	confirmBtn.textContent = HARDCOVER_MODES[mode].confirm;
	byId('importCancel').textContent = PENDING_HARDCOVER ? 'Cancel' : 'Close';
	openPreview('hardcoverPanel');
}

/** @param {HardcoverMode} mode */
function previewHardcover(mode){
	closeImportPreview();
	return runHardcover(mode, true);
}

function applyHardcover(){
	const mode = PENDING_HARDCOVER;
	if(!mode) return;
	closeImportPreview();
	return runHardcover(mode, false);
}

/**
 * Open the preview right under the panel whose button asked for it, so it is next to what it is about.
 * @param {string} panelId
 */
function openPreview(panelId){
	const preview = byId('importPreview');
	byId(panelId).after(preview);
	preview.classList.add('open');
	preview.scrollIntoView({block: 'nearest'});
}

function closeImportPreview(){
	PENDING_IMPORT = null;
	PENDING_MERGE = null;
	PENDING_TIDY = null;
	byId('mergePrefer').classList.remove('show');
	PENDING_HARDCOVER = null;
	byId('importPreview').classList.remove('open');
}

/**
 * Read an Audible or Goodreads export, and preview its import.
 * @param {ImportKind} kind
 * @param {File} file
 */
function importCsv(kind, file){
	const reader = new FileReader();
	reader.onload = async e=>{
		if(!await withWholeCatalog(()=> true)) return;
		try{
			previewImport(kind, readText(e), file.name);
		}catch(err){
			closeImportPreview();
			showIoStatus(`Couldn't read that file as a ${IMPORTERS[kind]().label} export.`, true);
		}
	};
	reader.readAsText(file);
}

byId('importAudibleBtn').addEventListener('click', ()=>{ IMPORT_KIND = 'audible'; byId('importCsvFile').click(); });
byId('importGoodreadsBtn').addEventListener('click', ()=>{ IMPORT_KIND = 'goodreads'; byId('importCsvFile').click(); });
byId('importCsvFile').addEventListener('change', e=>{
	const input = /** @type {HTMLInputElement} */ (e.target);
	const file = input.files && input.files[0];
	if(file) importCsv(IMPORT_KIND, file);
	input.value = '';
});
byId('importConfirm').addEventListener('click', ()=> PENDING_TIDY ? applyTidy() : PENDING_MERGE ? applyMerge() : PENDING_HARDCOVER ? applyHardcover() : applyImport());
for(const mode of /** @type {HardcoverMode[]} */ (Object.keys(HARDCOVER_MODES))){
	byId(`hardcover${mode[0].toUpperCase()}${mode.slice(1)}Btn`).addEventListener('click', ()=> previewHardcover(mode));
}
byId('hardcoverTokenSave').addEventListener('click', ()=> saveHardcoverToken(false));
byId('hardcoverTokenRemove').addEventListener('click', ()=> saveHardcoverToken(true));
byId('importCancel').addEventListener('click', closeImportPreview);

byId('checkBtn').addEventListener('click', ()=> withWholeCatalog(checkCatalog));
byId('boxSetsBtn').addEventListener('click', ()=> withWholeCatalog(previewBoxSets));
byId('exportBtn').addEventListener('click', ()=> withWholeCatalog(exportBackup));
byId('exportGoodreadsBtn').addEventListener('click', ()=> withWholeCatalog(exportGoodreads));
byId('importBtn').addEventListener('click', ()=> byId('importFile').click());
byId('mergeBtn').addEventListener('click', ()=> byId('mergeFile').click());
byId('mergeFile').addEventListener('change', e=>{
	const input = /** @type {HTMLInputElement} */ (e.target);
	const file = input.files && input.files[0];
	if(file) mergeBackupFile(file);
	input.value = '';
});
byId('mergePreferSelect').addEventListener('change', ()=>{ if(PENDING_MERGE) previewMerge(); });
byId('importFile').addEventListener('change', e=>{
	const input = /** @type {HTMLInputElement} */ (e.target);
	const files = [...(input.files || [])];
	input.value = '';
	if(files.length) return importBackup(files);
});

export const READY = startPage(()=>{ refreshPage(); showHardcoverToken(); }, {refresh: refreshPage, onHardcoverJob});
