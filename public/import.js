// The import and export page: adding books from Audible and Goodreads exports, Hardcover, and backups.
// Loading and saving live in store.js.
import * as CatalogImport from './importers.js';
import {
	DATA, SERIES_INFO, AUTHORS, setData, setSeriesInfo, setAuthors, EXCLUSIONS, LOCAL_SEEN, NOT_DUPLICATES,
	addNotDuplicates, esc, localNow, persist, addExclusions, showIoStatus,
	minutes, showHardcoverJob, HARDCOVER_TOKEN_KEY, HARDCOVER_PAUSE_MS, browserHardcoverToken,
	fetchHardcover, startPage, FORMAT_NOTES, byId, fieldById, BRITISH, spell
} from './store.js';
/** @import {Book, ReadResult, Backup} from './importers.js' */
/** @import {HardcoverJob} from './store.js' */

/** @typedef {HardcoverJob['mode']} HardcoverMode */
/** @typedef {'audible' | 'goodreads'} ImportKind */

function refreshPage(){
	byId('subtitle').textContent = spell(`${DATA.length} audiobooks in the catalog`);
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
	const backup = {books: DATA, seriesInfo: SERIES_INFO, authors: AUTHORS, excluded: EXCLUSIONS.entries, notDuplicates: [...NOT_DUPLICATES]};
	download(JSON.stringify(backup, null, '\t'), 'application/json', 'audiobook-catalog-backup');
	showIoStatus('Backup downloaded.');
}

function exportGoodreads(){
	const out = CatalogImport.goodreadsCsv(DATA);
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
 * (books.json, series-info.json, ... picked together; CatalogImport.readDataFiles), replaces the catalog.
 * @param {File[]} files
 */
async function importBackup(files){
	try{
		const {books, seriesInfo, authors, excluded, notDuplicates} = CatalogImport.readDataFiles(await readFiles(files));
		const bad = books.some(b=> !b || typeof b !== 'object' || !b.t || !b.a);
		if(bad) throw new Error('missing title/author');
		setData(books);
		if(seriesInfo) setSeriesInfo(seriesInfo);     // older backups have no series info: keep the current one
		if(authors) setAuthors(authors);              // nor author info
		const newlyExcluded = addExclusions(excluded || []);   // added to, never replaced: removing one is a hand edit
		addNotDuplicates(notDuplicates || []);                  // likewise the pairs marked "Not duplicates"
		refreshPage(); persist();
		showIoStatus(`Restored ${books.length} books` + (seriesInfo ? ` and info for ${Object.keys(seriesInfo).length} series` : '') +
			(newlyExcluded ? `; ${newlyExcluded} more excluded from imports.` : '.'));
	}catch(err){
		showIoStatus(spell("Couldn't read that — pick a catalog backup JSON, or your books.json with the other data files."), true);
	}
}

// ------------------------------------------------------------ Audible / Goodreads CSV import
// Read the export, merge it into a copy of the catalog, show what would change, and only apply it
// when confirmed. Like every edit in the page, the result is then saved (see persist).
/** @type {Record<ImportKind, {label: string, read: (text: string) => ReadResult}>} */
const IMPORTERS = {
	// an Audible export's ASINs are those of the site picked beside the buttons (audible.com unless changed)
	audible: {label: 'Audible', read: text=> CatalogImport.readAudible(text, fieldById('audibleImportSite').value)},
	goodreads: {label: 'Goodreads', read: CatalogImport.readGoodreads},
};
/** @type {ImportKind} */
let IMPORT_KIND = 'audible';
/** @type {Book[] | null} */
export let PENDING_IMPORT = null;   // the records of the import previewed, until it is applied or canceled

/**
 * Merge into a copy of DATA, so nothing changes until the result is known to be valid.
 * @param {Book[]} records
 */
function mergeIntoCopy(records){
	/** @type {Book[]} */
	const data = JSON.parse(JSON.stringify(DATA));
	const report = CatalogImport.merge(data, records, EXCLUSIONS);
	// series-info problems are not the import's doing (a series renamed in the page); only block on the books
	const errors = CatalogImport.validate(data, SERIES_INFO).errors.filter(e=> !e.startsWith('series-info'));
	return {data, report, errors};
}

/**
 * A book in a preview list: title, author and series, escaped.
 * @param {Book} rec
 * @returns {string}
 */
function bookLine(rec){
	const series = rec.s ? `  [${rec.s}${rec.sn ? ' #' + rec.sn : ''}]` : '';
	return `${esc(rec.t)} &mdash; ${esc(CatalogImport.namesText(rec.a))}${esc(series)}`;
}

/**
 * Show what importing an export would do, in the preview.
 * @param {ImportKind} kind
 * @param {string} text the export's text
 * @param {string} fileName
 */
function previewImport(kind, text, fileName){
	const importer = IMPORTERS[kind];
	const result = importer.read(text);
	const {report, errors} = mergeIntoCopy(result.records);
	const changes = report.added.length + report.backfilled.length + report.goodreadsFilled.length + report.datesFilled.length +
		report.isbnsFilled.length + report.detailsFilled.length + report.editionsAdded.length;
	PENDING_IMPORT = errors.length || !changes ? null : result.records;
	PENDING_HARDCOVER = null;
	PENDING_MERGE = null;
	PENDING_TIDY = null;
	byId('mergePrefer').classList.remove('show');

	const li = (/** @type {Book} */ rec) => `<li>${bookLine(rec)}</li>`;
	let html = `<p>${result.records.length} finished book${result.records.length === 1 ? '' : 's'} read from ${esc(fileName)}</p>`;
	html += spell(`<p>Already in the catalog: ${report.matched}</p>`);
	if(result.skippedUnfinished) html += `<p>Not finished yet, skipped: ${result.skippedUnfinished}</p>`;
	if(report.backfilled.length) html += `<p>ASINs filled in on existing books: ${report.backfilled.length}</p>`;
	if(report.goodreadsFilled.length) html += `<p>Goodreads ids filled in on existing books: ${report.goodreadsFilled.length}</p>`;
	if(report.datesFilled.length) html += `<p>Dates read filled in on existing books: ${report.datesFilled.length}</p>`;
	if(report.isbnsFilled.length) html += `<p>ISBNs added to existing books: ${report.isbnsFilled.length}</p>`;
	if(report.detailsFilled.length) html += `<p>Narrator, publisher, release date or length filled in on existing books: ${report.detailsFilled.length}</p>`;
	if(report.editionsAdded.length) html += `<p>Other editions added to existing books: ${report.editionsAdded.length}</p>`;
	if(report.excluded.length) html += `<p>Skipped (excluded from imports): ${report.excluded.length}</p>`;
	if(report.boxSets.length){
		html += `<p>Box sets split into their titles, each with the set's edition: ${report.boxSets.length}</p><ul>` +
			report.boxSets.map(b=> `<li>${esc(b.t)} &mdash; ${esc(CatalogImport.namesText(b.a))}: ${b.titles} already here, ${b.added} added</li>`).join('') + '</ul>';
		if(report.boxSets.some(b=> b.added)) html += spell('<p>A title not in the catalog yet is named &ldquo;Series, Book N&rdquo; until you rename it on its card.</p>');
	}
	html += `<p>New: ${report.added.length}</p>`;
	if(report.added.length) html += `<ul>${report.added.map(li).join('')}</ul>`;
	if(result.warnings.length){
		html += `<p class="warn">Needs a look (${result.warnings.length}):</p><ul>${result.warnings.map(w=>`<li>${esc(w)}</li>`).join('')}</ul>`;
	}
	if(errors.length){
		html += `<p class="warn">Validation failed, nothing will be changed:</p><ul>${errors.slice(0, 10).map(e=>`<li>${esc(e)}</li>`).join('')}</ul>`;
	} else if(!changes){
		html += '<p>Nothing new to add.</p>';
	}

	byId('importPreviewTitle').textContent = `${importer.label} import`;
	byId('importPreviewBody').innerHTML = html;
	const confirmBtn = byId('importConfirm');
	confirmBtn.style.display = PENDING_IMPORT ? '' : 'none';
	confirmBtn.textContent = report.added.length
		? `Add ${report.added.length} book${report.added.length === 1 ? '' : 's'}`
		: report.backfilled.length ? 'Save ASINs' : report.goodreadsFilled.length ? 'Save Goodreads ids' : report.datesFilled.length ? 'Save dates read'
		: report.editionsAdded.length ? 'Save editions' : report.isbnsFilled.length ? 'Save ISBNs' : 'Save edition details';
	byId('importCancel').textContent = PENDING_IMPORT ? 'Cancel' : 'Close';
	byId('importPreview').classList.add('open');
}

function applyImport(){
	if(!PENDING_IMPORT) return;
	// merged again, in case books were edited while the preview was open
	const {data, report, errors} = mergeIntoCopy(PENDING_IMPORT);
	closeImportPreview();
	if(errors.length){ showIoStatus(spell('The catalog changed and the import no longer validates; nothing was added.'), true); return; }
	const added = report.added.length, backfilled = report.backfilled.length, dated = report.datesFilled.length;
	const withIsbns = report.isbnsFilled.length, withGr = report.goodreadsFilled.length;
	const withEditions = report.editionsAdded.length, withDetails = report.detailsFilled.length;
	setData(data);
	refreshPage(); persist();
	const done = `Added ${added} book${added === 1 ? '' : 's'}` +
		(backfilled ? `, filled in ${backfilled} ASIN${backfilled === 1 ? '' : 's'}` : '') +
		(withGr ? `, filled in ${withGr} Goodreads id${withGr === 1 ? '' : 's'}` : '') +
		(dated ? `, filled in dates read on ${dated} book${dated === 1 ? '' : 's'}` : '') +
		(withIsbns ? `, added ISBNs to ${withIsbns} book${withIsbns === 1 ? '' : 's'}` : '') +
		(withEditions ? `, added editions to ${withEditions} book${withEditions === 1 ? '' : 's'}` : '') +
		(withDetails ? `, filled in edition details on ${withDetails} book${withDetails === 1 ? '' : 's'}` : '') + '.';
	showIoStatus(done);
}

// ------------------------------------------------------------ Merge a backup from another device
// Restore replaces the catalog; Merge is for two catalogs that have both changed since they were
// last the same (the phone and the PC, say), so neither side's edits are lost (CatalogImport.mergeBackup).
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
	// mergeBackup takes the marks as a list (it only makes a Set of them again)
	const m = CatalogImport.mergeBackup(DATA, SERIES_INFO, EXCLUSIONS, backup, prefer, [...NOT_DUPLICATES], AUTHORS);
	// series info left without books is expected after a series was renamed; anything else blocks
	const errors = [...CatalogImport.validate(m.books, m.seriesInfo).errors.filter(e=> !/^series-info: .* matches no series/.test(e)),
		...CatalogImport.validateAuthors(m.books, m.authors).errors];
	const changes = m.added.length + m.updated.length + m.removed.length + m.infoAdded.length + m.infoChanged.length +
		m.authorsAdded.length + m.authorsChanged.length + m.excluded.length + m.notDuplicates.length;
	return {m, errors, changes};
}

function previewMerge(){
	if(!PENDING_MERGE) return;
	const {backup, fileName} = PENDING_MERGE;
	const {m, errors, changes} = mergeIntoCatalog(backup);
	const list = (/** @type {Book[]} */ recs) => recs.length ? `<ul>${recs.map(r=> `<li>${bookLine(r)}</li>`).join('')}</ul>` : '';
	let html = `<p>${backup.books.length} books in ${esc(fileName)}; ${m.books.length} after merging.</p>`;
	html += `<p>New from the backup: ${m.added.length}</p>` + list(m.added);
	html += `<p>Gaining genres, dates read or editions${m.conflicts.length ? ', or the version kept below' : ''}: ${m.updated.length}</p>`;
	html += `<p>Removed (removed on the other device): ${m.removed.length}</p>` + list(m.removed);
	if(m.skipped.length) html += `<p>Not added back (removed here): ${m.skipped.length}</p>`;
	if(m.conflicts.length){
		const kept = fieldById('mergePreferSelect').value === 'backup' ? "the backup's" : spell("this catalog's");
		html += `<p>Title, author or series differ, keeping ${kept}: ${m.conflicts.length}</p><ul>` +
			m.conflicts.map(c=> `<li>${bookLine(c.mine)} / backup: ${bookLine(c.theirs)}</li>`).join('') + '</ul>';
	}
	const infoDiffer = m.infoChanged.length + m.infoKept.length;
	if(m.infoAdded.length || infoDiffer){
		html += `<p>Series info: ${m.infoAdded.length} added` + (infoDiffer ? `, ${infoDiffer} differing (keeping ${m.infoChanged.length ? "the backup's" : spell("this catalog's")})` : '') + '</p>';
	}
	const authorsDiffer = m.authorsChanged.length + m.authorsKept.length;
	if(m.authorsAdded.length || authorsDiffer){
		html += `<p>Author info: ${m.authorsAdded.length} added` + (authorsDiffer ? `, ${authorsDiffer} differing (keeping ${m.authorsChanged.length ? "the backup's" : spell("this catalog's")})` : '') + '</p>';
	}
	if(m.excluded.length) html += `<p>More books excluded from imports: ${m.excluded.length}</p>`;
	if(m.notDuplicates.length) html += `<p>More books marked "Not duplicates": ${m.notDuplicates.length}</p>`;
	if(errors.length){
		html += `<p class="warn">Validation failed, nothing will be changed:</p><ul>${errors.slice(0, 10).map(e=>`<li>${esc(e)}</li>`).join('')}</ul>`;
	} else if(!changes){
		html += spell('<p>Nothing to merge: this catalog already has everything in the backup.</p>');
	}
	const ok = !errors.length && changes;
	byId('importPreviewTitle').textContent = 'Merge a backup';
	byId('importPreviewBody').innerHTML = html;
	byId('mergePrefer').classList.add('show');
	const confirmBtn = byId('importConfirm');
	confirmBtn.style.display = ok ? '' : 'none';
	confirmBtn.textContent = 'Merge';
	byId('importCancel').textContent = ok ? 'Cancel' : 'Close';
	byId('importPreview').classList.add('open');
}

function applyMerge(){
	if(!PENDING_MERGE) return;
	// merged again, in case books were edited while the preview was open
	const {m, errors, changes} = mergeIntoCatalog(PENDING_MERGE.backup);
	closeImportPreview();
	if(errors.length || !changes){ showIoStatus(spell('The catalog changed and the merge no longer applies; nothing was changed.'), true); return; }
	setData(m.books);
	setSeriesInfo(m.seriesInfo);
	setAuthors(m.authors);
	addExclusions(m.excluded);
	addNotDuplicates(m.notDuplicates);
	refreshPage(); persist();
	showIoStatus(`Merged: ${m.added.length} added, ${m.updated.length} updated, ${m.removed.length} removed.`);
}

/**
 * Read a backup to merge, and preview the merge.
 * @param {File} file
 */
function mergeBackupFile(file){
	const reader = new FileReader();
	reader.onload = e=>{
		try{
			const backup = CatalogImport.readBackup(JSON.parse(readText(e)));
			if(backup.books.some(b=> !b || typeof b !== 'object' || !b.t || !b.a)) throw new Error('missing title/author');
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
// The check lists errors, warnings and what is kept in an older format, which it offers to save in the
// current one; box sets are previewed like an import and only applied when confirmed.
/** @type {'format' | 'box-sets' | null} */
export let PENDING_TIDY = null;   // 'format' or 'box-sets', while its preview is open

/**
 * A list of messages, at most `limit` of them, saying how many more there are.
 * @param {string[]} items
 * @param {number} [limit]
 * @returns {string}
 */
function messageList(items, limit = 100){
	const more = items.length > limit ? `<li>&hellip;and ${items.length - limit} more</li>` : '';
	return `<ul>${items.slice(0, limit).map(m=> `<li>${esc(m)}</li>`).join('')}${more}</ul>`;
}

/**
 * Show the check or the box sets in the preview; its confirm button (labeled `confirm`) shows when PENDING_TIDY is set.
 * @param {string} title
 * @param {string} html
 * @param {string} confirm
 */
function showTidyPreview(title, html, confirm){
	PENDING_IMPORT = null;
	PENDING_HARDCOVER = null;
	PENDING_MERGE = null;
	byId('mergePrefer').classList.remove('show');
	byId('importPreviewTitle').textContent = title;
	byId('importPreviewBody').innerHTML = html;
	const confirmBtn = byId('importConfirm');
	confirmBtn.style.display = PENDING_TIDY ? '' : 'none';
	confirmBtn.textContent = confirm;
	byId('importCancel').textContent = PENDING_TIDY ? 'Cancel' : 'Close';
	byId('importPreview').classList.add('open');
	byId('importPreview').scrollIntoView();   // it opens at the top, far above these buttons
}

function checkCatalog(){
	const {errors, warnings} = CatalogImport.validate(DATA, SERIES_INFO);
	const people = CatalogImport.validateAuthors(DATA, AUTHORS);
	errors.push(...people.errors);
	warnings.push(...people.warnings);
	const series = new Set(DATA.filter(b=> b.s).map(b=> b.s)).size;
	const authors = Object.keys(AUTHORS).length;
	let html = `<p>${DATA.length} books, ${series} series, ${Object.keys(SERIES_INFO).length} with release info, ` +
		`${authors} author${authors === 1 ? '' : 's'} with info.</p>`;
	if(errors.length) html += `<p class="warn">Errors (${errors.length}):</p>` + messageList(errors);
	if(warnings.length) html += `<p class="warn">Needs a look (${warnings.length}):</p>` + messageList(warnings);
	if(FORMAT_NOTES.length){
		html += `<p>In an older format (read the current way here):</p>` + messageList(FORMAT_NOTES);
		html += '<p>Save it to keep it in the current format; any edit does that too.</p>';
	}
	if(!errors.length && !warnings.length && !FORMAT_NOTES.length) html += '<p>No problems found.</p>';
	PENDING_TIDY = FORMAT_NOTES.length ? 'format' : null;
	showTidyPreview(spell('Check the catalog'), html, 'Save in the current format');
}

// Keep each box set as its own book and as its titles, in a copy of DATA (CatalogImport.boxSetBooks).
function boxSetsIntoCopy(){
	/** @type {Book[]} */
	const data = JSON.parse(JSON.stringify(DATA));
	const report = CatalogImport.boxSetBooks(data, EXCLUSIONS);
	const errors = CatalogImport.validate(data, SERIES_INFO).errors.filter(e=> !e.startsWith('series-info'));
	return {data, report, errors};
}

function previewBoxSets(){
	const {report, errors} = boxSetsIntoCopy();
	let html = `<p>Box sets: ${report.boxSets.length}</p>`;
	if(report.boxSets.length){
		html += '<ul>' + report.boxSets.map(b=> `<li>${esc(b.t)} &mdash; ${esc(CatalogImport.namesText(b.a))}: ${b.titles} title${b.titles === 1 ? '' : 's'} already here</li>`).join('') + '</ul>';
	}
	if(report.excluded.length) html += `<p>Skipped (excluded from imports): ${report.excluded.length}</p>`;
	html += `<p>New: ${report.added.length}</p>`;
	if(report.added.length){
		html += `<ul>${report.added.map(b=> `<li>${bookLine(b)}</li>`).join('')}</ul>`;
	}
	if(report.boxSets.some(b=> b.added)){
		html += spell('<p>A title not in the catalog yet is named &ldquo;Series, Book N&rdquo; until you rename it on its card.</p>');
	}
	if(errors.length){
		html += '<p class="warn">Validation failed, nothing will be changed:</p>' + messageList(errors, 10);
	} else if(!report.added.length){
		html += '<p>Every box set is already kept both as its own book and as its titles.</p>';
	}
	PENDING_TIDY = errors.length || !report.added.length ? null : 'box-sets';
	showTidyPreview('Box sets', html, `Add ${report.added.length} book${report.added.length === 1 ? '' : 's'}`);
}

function applyTidy(){
	const pending = PENDING_TIDY;
	closeImportPreview();
	if(pending === 'format'){
		// a save writes the books as the page holds them, which is the current format
		persist();
		if(!FORMAT_NOTES.length) showIoStatus('Saved in the current format.');
		return;
	}
	// applied again, in case books were edited while the preview was open
	const {data, report, errors} = boxSetsIntoCopy();
	if(errors.length){ showIoStatus(spell('The catalog changed and the box sets no longer validate; nothing was changed.'), true); return; }
	setData(data);
	refreshPage(); persist();
	const added = report.added.length;
	showIoStatus(`Added ${added} book${added === 1 ? '' : 's'} for box sets.`);
}

// ------------------------------------------------------------ Hardcover
// The page runs it itself, as Hardcover's API allows browser requests, with a token kept in this browser
// only (never in a backup); it stops if you leave the page, so the browser asks first. A dry run shows
// what would happen, and confirming runs it for real.
/** @type {Record<HardcoverMode, {title: string, confirm: string}>} */
const HARDCOVER_MODES = {
	import: {title: 'Import from Hardcover', confirm: 'Import'},
	export: {title: 'Export to Hardcover', confirm: 'Export to Hardcover'},
	sync: {title: 'Sync with Hardcover', confirm: 'Sync'},
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
		else localStorage.setItem(HARDCOVER_TOKEN_KEY, CatalogImport.cleanHardcoverToken(input.value));
		input.value = '';
		showIoStatus(remove ? 'Hardcover token removed.' : 'Hardcover token saved.');
	}catch(e){
		showIoStatus(`Couldn't ${remove ? 'remove' : 'save'} the token: this browser refused to store it.`, true);
	}
	showHardcoverToken();
}

/**
 * Run `mode` (CatalogImport.runHardcover) on a copy of the catalog, shown in the banner on top. A real
 * run keeps its changes (persist) before sending anything to Hardcover, unless the catalog was edited meanwhile. Returns a promise of the ended run.
 * @param {HardcoverMode} mode
 * @param {boolean} dryRun
 * @returns {Promise<HardcoverJob | undefined>} undefined when it didn't start
 */
async function runHardcover(mode, dryRun){
	if(PAGE_RUN) return;
	const token = browserHardcoverToken();
	if(!token){ showIoStatus('Save your Hardcover API token first (below the buttons).', true); return; }
	const started = Date.now();
	/** @type {{out: string[], err: string[]}} */
	const lines = {out: [], err: []};
	/** @type {HardcoverJob} */
	const job = PAGE_RUN = {mode, dryRun, running: true, elapsed: 0, step: 'Starting'};
	const show = () => { job.elapsed = Date.now() - started; showHardcoverJob(job); };
	const ticker = setInterval(show, 1000);
	show();
	const before = JSON.stringify(DATA), seen = LOCAL_SEEN;
	const books = JSON.parse(before);
	const save = async (/** @type {boolean} */ changed) => {
		if(JSON.stringify(DATA) !== before || localNow() !== seen){
			lines.err.push(spell('error: the catalog was edited while this ran (here or in another tab); nothing written, nothing sent to Hardcover. Run it again.'));
			return false;
		}
		if(changed){
			setData(books);
			persist();
			refreshPage();
			lines.out.push(spell('saved the catalog'));
		}
		return true;
	};
	const pause = () => new Promise(done => setTimeout(done, HARDCOVER_PAUSE_MS));
	/** @type {number} */
	let code;
	try{
		code = await CatalogImport.runHardcover(books, mode, CatalogImport.hardcoverAsker(token, fetchHardcover, pause), {
			exclusions: EXCLUSIONS, info: SERIES_INFO, dryRun, save, british: BRITISH,
			out: line => lines.out.push(line), err: line => lines.err.push(line),
			step: (text, done, total) => { Object.assign(job, {step: text, done, total}); show(); },
		});
	}catch(e){
		lines.err.push(`error: ${CatalogImport.errorText(e)}`);
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
	byId('importPreviewBody').innerHTML = `<pre>${esc(text)}</pre>` +
		(pending && result.code === 0 ? '<p>Nothing has changed yet, here or on Hardcover.</p>' : '');
	const confirmBtn = byId('importConfirm');
	confirmBtn.style.display = PENDING_HARDCOVER ? '' : 'none';
	confirmBtn.textContent = HARDCOVER_MODES[mode].confirm;
	byId('importCancel').textContent = PENDING_HARDCOVER ? 'Cancel' : 'Close';
	byId('importPreview').classList.add('open');
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
	reader.onload = e=>{
		try{
			previewImport(kind, readText(e), file.name);
		}catch(err){
			closeImportPreview();
			showIoStatus(`Couldn't read that file as a ${IMPORTERS[kind].label} export.`, true);
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

byId('checkBtn').addEventListener('click', checkCatalog);
byId('boxSetsBtn').addEventListener('click', previewBoxSets);
byId('exportBtn').addEventListener('click', exportBackup);
byId('exportGoodreadsBtn').addEventListener('click', exportGoodreads);
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

export const READY = startPage(()=>{ refreshPage(); showHardcoverToken(); }, {onHardcoverJob});
