// The import and export page: comparing the catalog with Audible and Goodreads exports and with Hardcover and
// AudiobookDB, to take books and values from them (and send books and reads to Hardcover and AudiobookDB), and backups.
// It shows only how many books there are until an action needs every book (an import, Check, Box sets,
// Hardcover, AudiobookDB, Export, Restore or Merge), and then holds the whole catalog. Loading and saving live in store.js.
import {Text} from './modules/text.js';
import {Catalog} from './modules/catalog.js';
import {Backup} from './modules/backup.js';
import {CatalogRecords} from './modules/catalog-records.js';
import {AudibleImporter} from './modules/audible-importer.js';
import {GoodreadsImporter} from './modules/goodreads-importer.js';
import {GoodreadsExporter} from './modules/goodreads-exporter.js';
import {HardcoverClient} from './modules/hardcover-client.js';
import {HardcoverSync} from './modules/hardcover-sync.js';
import {AudiobookdbSync} from './modules/audiobookdb-sync.js';
import {Comparison} from './modules/comparison.js';
import {
	CATALOG, SEEN_REVISION, storedRevision, whenSaved, persist, showIoStatus,
	minutes, showCatalogJob, HARDCOVER_TOKEN_KEY, browserHardcoverToken, PROXY_STORAGE_KEY, browserProxy, proxyAddress, fetchViaProxy,
	hardcoverClient, AUDIOBOOKDB_KEY_STORAGE, browserAudiobookdbKey, audiobookdbClient, startPage, afterSaving, queryCatalog, wholeCatalog, byId, fieldById, spell, valueFromPageHash, idFromAddress, buildElement, fillElement,
	noteBackup, backupAge, backupAgeText
} from './store.js';
/** @import {Child} from './store.js' */
/** @import {Book} from './modules/book.js' */
/** @import {Importer} from './modules/importer.js' */
/** @import {CatalogJob} from './store.js' */
/** @import {MergeOptions, MergeReport} from './modules/merger.js' */
/** @import {ComparisonResult, ComparedBook, Difference} from './modules/comparison.js' */
/** @import {HardcoverComparison, HardcoverPlan, HardcoverPart} from './modules/hardcover-sync.js' */
/** @import {AudiobookdbComparison, AudiobookdbPlan, AudiobookdbPart} from './modules/audiobookdb-sync.js' */
/** @import {Step} from './modules/hardcover-client.js' */

/** @typedef {CatalogJob['mode']} CatalogMode */
/** @typedef {'audible' | 'goodreads'} ImportKind */
/** @typedef {'hardcover' | 'audiobookdb'} OnlineCatalog a catalog compared online, by its panel's prefix */

function refreshPage(){
	return afterSaving(async ()=>{
		const count = await queryCatalog(r=> r.count('books'));
		byId('subtitle').textContent = spell(`${count} audiobooks in the catalog`);
		byId('backupState').textContent = backupAgeText(await backupAge());
	});
}

/**
 * Hold the whole catalog, which the page keeps from then on; false, said on the status line, when it can't be read.
 * @returns {Promise<boolean>}
 */
async function holdWholeCatalog(){
	try{
		await wholeCatalog();
		return true;
	}catch(e){
		showIoStatus(spell(`Couldn't read the catalog kept in this browser: ${Text.errorText(e)}. Reload the page.`), true);
		return false;
	}
}

/**
 * Run `task` once the page holds the whole catalog (holdWholeCatalog); not when it can't be read.
 * @param {() => void} task
 * @returns {Promise<void>}
 */
async function withWholeCatalog(task){
	if(await holdWholeCatalog()) task();
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
	noteBackup().then(refreshPage);
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
 * Pick the files to read; resolves to [{name, text}].
 * @param {Iterable<File>} files
 * @returns {Promise<{name: string, text: string}[]>}
 */
function readFiles(files){
	return Promise.all([...files].map(file=> /** @type {Promise<{name: string, text: string}>} */ (new Promise((resolve, reject)=>{
		const reader = new FileReader();
		// the event's target is the reader, which read a string
		reader.onload = e=> resolve({name: file.name, text: /** @type {string} */ (/** @type {FileReader} */ (e.target).result)});
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
	if(!await holdWholeCatalog()) return;   // what it replaces is all of it
	try{
		const {books, series, authors, narrators, publishers, excluded, notDuplicates, nameIds} = Backup.readFiles(await readFiles(files));
		const bad = books.some(b=> !b.title || !b.authors.length);
		if(bad) throw new Error('missing title/author');
		// the catalog is kept as records, which have no place for a value that isn't what its field holds
		const unstorable = CatalogRecords.unstorable(new Catalog({books, series: series || undefined, authors: authors || undefined,
			narrators: narrators || undefined, publishers: publishers || undefined}));
		if(unstorable.length){
			showIoStatus(`Not restored: fix these values in the backup first (they aren't what their field holds): ${Text.firstThree(unstorable, '; ')}.`, true);
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
		const newlyExcluded = CATALOG.addExclusions(excluded || []);   // added to, never replaced: removing one is a hand edit
		CATALOG.addMarkTexts([...keptMarks, ...notDuplicates || []]);   // likewise the pairs marked "Not duplicates"
		persist(); noteBackup().then(refreshPage);   // what was restored is in that backup
		showIoStatus(`Restored ${books.length} books` + (series ? ` and the release details of ${series.size} series` : '') +
			(newlyExcluded ? `; ${newlyExcluded} more excluded from imports.` : '.'));
	}catch{
		showIoStatus(spell("Couldn't read that — pick a catalog backup JSON, or your books.json with the other data files."), true);
	}
}

// ------------------------------------------------------------ Comparing with Audible, Goodreads, Hardcover and AudiobookDB
// An import shows the books of the other source beside this catalog's (Comparison), and takes only what is
// ticked: the books to import (new ones, and those it has more of), and the values of the other source to put
// in place of this catalog's. For Hardcover and AudiobookDB the same view also picks books (and reads) to put there.
// Like every edit in the page, the result is then saved (see persist).
/** @type {Record<ImportKind, () => Importer>} */
const IMPORTERS = {
	// an Audible export's ASINs are those of the site picked beside the buttons (audible.com unless changed)
	audible: ()=> new AudibleImporter(fieldById('audibleImportSite').value),
	goodreads: ()=> new GoodreadsImporter(),
};
/** @type {ImportKind} */
let IMPORT_KIND = 'audible';

/**
 * What is ticked in a comparison: the incoming books to import (by place), those whose edition goes into the
 * book they find (an edition ticked imports its book), the differences to take (by key), the Hardcover or
 * AudiobookDB plan's books to put on the Read shelf and reads to add (by place), and whether to keep the ids found there.
 * @typedef {{take: Set<number>, editions: Set<number>, patch: Set<string>, add: Set<number>, reads: Set<number>, ids: boolean}} ComparePicks
 */
/**
 * A comparison open in the preview.
 * @typedef {object} PendingCompare
 * @property {ImportKind | OnlineCatalog} source
 * @property {string} name the other source's name, as the page says it
 * @property {string[]} notes lines on top: what was read
 * @property {Book[]} incoming
 * @property {MergeOptions} [opts]
 * @property {ComparisonResult} comparison
 * @property {string[]} warnings
 * @property {HardcoverComparison | null} hardcover
 * @property {AudiobookdbComparison | null} audiobookdb
 * @property {ComparePicks} picks
 */
/** @type {PendingCompare | null} */
let PENDING_COMPARE = null;   // until it is applied or closed

/**
 * A comparison to open, with what an import would take ticked; but the edition Goodreads or Hardcover has
 * for a book you have is unticked, as it may be one picked there for want of the one you have.
 * @param {Omit<PendingCompare, 'picks'>} compare
 * @returns {PendingCompare}
 */
function pendingCompare(compare){
	const books = compare.comparison.books;
	const take = new Set(books.filter(b=> b.kind === 'new' || (b.kind === 'gains' && (b.gains.length || b.added.length))).map(b=> b.at));
	const editions = new Set(compare.source === 'audible' ? books.filter(b=> b.editionGains.length).map(b=> b.at) : []);
	return {...compare, picks: {take, editions, patch: new Set(), add: new Set(), reads: new Set(), ids: true}};
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
		items.length > limit && buildElement('li', {}, `…and ${items.length - limit} more`));
}

/** @typedef {'take' | 'editions' | 'patch' | 'add' | 'reads'} PickGroup */

/**
 * How many changes the ticks of a comparison make.
 * @param {PendingCompare} compare
 * @returns {number}
 */
function pickedCount(compare){
	const {picks} = compare;
	return picks.take.size + [...picks.editions].filter(at=> !picks.take.has(at)).length + picks.patch.size + picks.add.size + picks.reads.size + (picks.ids && idsToSave(compare) ? 1 : 0);
}

/**
 * How many books, series and people gain an id found on Hardcover or AudiobookDB in a comparison.
 * @param {PendingCompare} compare
 * @returns {number}
 */
function idsToSave(compare){
	const {hardcover, audiobookdb} = compare;
	return hardcover ? hardcover.idsFound.length : audiobookdb ? audiobookdb.idsFound.length + audiobookdb.infoIds.length : 0;
}

/**
 * The preview's buttons: the confirm button, labeled `confirm`, and Cancel; only Close when `confirm` is ''.
 * @param {string} confirm
 */
function showPreviewButtons(confirm){
	const confirmBtn = byId('importConfirm');
	confirmBtn.style.display = confirm ? '' : 'none';
	confirmBtn.textContent = confirm;
	byId('importCancel').textContent = confirm ? 'Cancel' : 'Close';
}

/**
 * Show `body` in the preview under `title`, with its buttons (showPreviewButtons), and open it under the
 * panel `panelId` when given (openPreview).
 * @param {string} title
 * @param {Child[]} body
 * @param {string} confirm
 * @param {string} [panelId]
 */
function showPreview(title, body, confirm, panelId){
	byId('importPreviewTitle').textContent = title;
	fillElement(byId('importPreviewBody'), body);
	showPreviewButtons(confirm);
	if(panelId) openPreview(panelId);
}

/** @returns {string} the comparison's Apply button's label, for the changes ticked; '' for none */
function applyLabel(){
	const n = PENDING_COMPARE ? pickedCount(PENDING_COMPARE) : 0;
	return n ? `Apply ${Text.plural(n, 'change')}` : '';
}

function updateApplyButton(){ showPreviewButtons(applyLabel()); }

/**
 * A tickbox of the comparison, for the pick `key` of `group`.
 * @param {PickGroup} group
 * @param {number | string} key
 * @param {Child[]} label
 * @returns {HTMLLabelElement}
 */
function pickBox(group, key, label){
	const compare = /** @type {PendingCompare} */ (PENDING_COMPARE);
	const picked = /** @type {Set<number | string>} */ (compare.picks[group]);
	return buildElement('label', {class: 'cmpPick'}, buildElement('input', {type: 'checkbox', 'data-pick': `${group}:${key}`, checked: picked.has(key),
		onchange: (/** @type {Event} */ e)=>{
			if(/** @type {HTMLInputElement} */ (e.currentTarget).checked) picked.add(key); else picked.delete(key);
			updateApplyButton();
		}}), ' ', ...label);
}

/**
 * A group of the comparison: its heading with how many, tick all and none for its `keys`, and its rows.
 * @param {string} heading
 * @param {Child[]} rows
 * @param {PickGroup | null} group
 * @param {(number | string)[]} keys
 * @param {string} [note]
 * @returns {HTMLElement | null}
 */
function compareGroup(heading, rows, group, keys, note){
	if(!rows.length) return null;
	const tick = (/** @type {boolean} */ on)=> ()=>{
		const compare = /** @type {PendingCompare} */ (PENDING_COMPARE);
		const picked = /** @type {Set<number | string>} */ (compare.picks[/** @type {PickGroup} */ (group)]);
		for(const k of keys) if(on) picked.add(k); else picked.delete(k);
		drawCompare();
	};
	return buildElement('section', {class: 'cmpGroup'},
		buildElement('h4', {}, `${heading} (${rows.length})`, group && keys.length > 1 && [' ',
			buildElement('button', {type: 'button', class: 'cmpTick', onclick: tick(true)}, 'Tick all'), ' ',
			buildElement('button', {type: 'button', class: 'cmpTick', onclick: tick(false)}, 'Tick none')]),
		note && para(note, 'cmpNote'),
		buildElement('ul', {class: 'cmpRows'}, rows.map(r=> buildElement('li', {}, r))));
}

/**
 * One difference, to tick: "Narrators: Ann Vale here, Bo Reed on Goodreads".
 * @param {Difference} d
 * @param {string} name
 * @returns {HTMLLIElement}
 */
function differenceRow(d, name){
	return buildElement('li', {}, pickBox('patch', d.key, [`${d.label}: `, buildElement('span', {class: 'cmpHere'}, d.here || 'none'),
		spell(' here, '), buildElement('span', {class: 'cmpThere'}, d.there), ` on ${name}`]));
}

/** Draw the comparison open (PENDING_COMPARE) in the preview. */
function drawCompare(){
	const compare = /** @type {PendingCompare} */ (PENDING_COMPARE);
	const {name, comparison, hardcover, audiobookdb} = compare;
	const books = comparison.books;
	const of = (/** @type {ComparedBook['kind']} */ kind)=> books.filter(b=> b.kind === kind);
	const fresh = of('new'), gains = of('gains');
	const differing = books.filter(b=> b.differences.length), same = of('same').filter(b=> !b.differences.length);
	/** @type {Child[]} */
	const out = compare.notes.map(n=> para(n));
	out.push(para(spell(`${fresh.length} new, ${gains.length} with more to give, ${differing.length} with values that differ, ${same.length} the same as in this catalog.`)));

	// a new book as it would be added, in the series spelling in use
	out.push(compareGroup(`New from ${name}`, fresh.map(b=> [pickBox('take', b.at, [Comparison.bookLine(b.added[0] || b.theirs)]),
		b.added.length > 1 && messageList(b.added.map(Comparison.bookLine))]), 'take', fresh.map(b=> b.at)));
	const fromEdition = (/** @type {ComparedBook} */ b)=> b.editionGains.length ?
		buildElement('ul', {}, buildElement('li', {}, pickBox('editions', b.at, [`the ${name} edition: ${b.editionGains.join('; ')}`]))) : null;
	out.push(compareGroup(`${name} has more`, gains.map(b=> b.gains.length || b.added.length
		? [pickBox('take', b.at, [Comparison.bookLine(b.books[0] || b.theirs)]), messageList([...b.gains, ...b.added.map(a=> `adds ${Comparison.bookLine(a)}`)]), fromEdition(b)]
		: [buildElement('span', {class: 'cmpBook'}, Comparison.bookLine(b.books[0])), fromEdition(b)]), 'take', gains.filter(b=> b.gains.length || b.added.length).map(b=> b.at),
		spell(compare.source === 'audible' ? 'Ticked, importing fills in what this catalog lacks, and changes nothing it has.'
			: `Ticked, importing fills in what this catalog lacks, and changes nothing it has. The ${name} edition is left out unless you tick it, as it may have been picked there for want of yours.`)));
	out.push(compareGroup('Different in both', differing.map(b=> [buildElement('span', {class: 'cmpBook'}, Comparison.bookLine(b.books[0])),
		buildElement('ul', {}, b.differences.map(d=> differenceRow(d, name)))]),
		'patch', differing.flatMap(b=> b.differences.map(d=> d.key)), spell(`Tick a value to use the one on ${name} in place of this catalog's.` +
			(compare.source === 'audible' ? '' : ` An edition's values are those of the edition picked on ${name}, which may not be yours.`))));

	if(hardcover){
		const {plan} = hardcover;
		const dates = (/** @type {string[]} */ d)=> d.length ? `: read ${d.join(', ')}` : '';
		out.push(compareGroup('Not on your Hardcover Read shelf', plan.add.map((a, i)=> pickBox('add', i, [a.books.map(Comparison.bookLine).join('; '), dates(a.dates)])),
			'add', plan.add.map((a, i)=> i), 'Tick a book to put it on your Read shelf on Hardcover, with its dates read.'));
		out.push(compareGroup('Reads Hardcover lacks', plan.reads.map((a, i)=> pickBox('reads', i, [a.books.map(Comparison.bookLine).join('; '), dates(a.dates)])),
			'reads', plan.reads.map((a, i)=> i), 'Tick a book to add these reads to it on Hardcover.'));
		if(hardcover.idsFound.length){
			out.push(buildElement('label', {class: 'cmpPick cmpIds'}, buildElement('input', {type: 'checkbox', 'data-pick': 'ids', checked: compare.picks.ids,
				onchange: (/** @type {Event} */ e)=>{ compare.picks.ids = /** @type {HTMLInputElement} */ (e.currentTarget).checked; updateApplyButton(); }}),
				` Save the Hardcover ids found for ${Text.plural(hardcover.idsFound.length, 'book')}`));
		}
		out.push(compareGroup('On another Hardcover shelf, left alone', plan.otherShelf.map(([b, status])=> `${Comparison.bookLine(b)}: ${status}`), null, []));
		out.push(compareGroup('Not found on Hardcover', plan.unknown.map(Comparison.bookLine), null, [],
			'No ASIN, ISBN or Goodreads id Hardcover knows: give the book a "Hardcover <edition id>" in its edit form.'));
		if(plan.inexact.length) out.push(para(`Dates read without a day, which Hardcover can't take: ${plan.inexact.length}`));
	} else if(audiobookdb){
		const {plan, idsFound, infoIds} = audiobookdb;
		if(plan){
			out.push(compareGroup(`Not on your AudiobookDB ${plan.name} shelf`, plan.add.map((a, i)=> pickBox('add', i, [a.books.map(Comparison.bookLine).join('; ')])),
				'add', plan.add.map((a, i)=> i), `Tick a book to put it on your ${plan.name} shelf on AudiobookDB.`));
			out.push(compareGroup('On another AudiobookDB shelf, left alone', plan.otherShelf.map(([b, shelf])=> `${Comparison.bookLine(b)}: ${shelf}`), null, []));
			out.push(compareGroup('Not found on AudiobookDB', plan.unknown.map(Comparison.bookLine), null, [],
				'No ASIN AudiobookDB knows: give the book its AudiobookDB id in its edit form, or add it on audiobookdb.org.'));
		} else out.push(para('Save your AudiobookDB API key (below the buttons) to compare your shelves too, and to put books on them.'));
		if(idsFound.length || infoIds.length){
			const saving = [idsFound.length && Text.plural(idsFound.length, 'book'), infoIds.length && Text.plural(infoIds.length, 'series or person', 'series and people')].filter(Boolean).join(', ');
			out.push(buildElement('label', {class: 'cmpPick cmpIds'}, buildElement('input', {type: 'checkbox', 'data-pick': 'ids', checked: compare.picks.ids,
				onchange: (/** @type {Event} */ e)=>{ compare.picks.ids = /** @type {HTMLInputElement} */ (e.currentTarget).checked; updateApplyButton(); }}),
				` Save the AudiobookDB ids and covers found for ${saving}`));
		}
		if(audiobookdb.missing.length){
			out.push(buildElement('details', {class: 'cmpOnlyHere'}, buildElement('summary', {}, spell(`In the series on AudiobookDB, not in this catalog: ${audiobookdb.missing.length}`)),
				messageList(audiobookdb.missing, 100)));
		}
	} else if(comparison.onlyHere.length){
		out.push(buildElement('details', {class: 'cmpOnlyHere'}, buildElement('summary', {}, spell(`Only in this catalog: ${comparison.onlyHere.length}`)),
			messageList(comparison.onlyHere.map(Comparison.bookLine), 100)));
	}
	const excluded = of('excluded'), notAdded = of('notAdded');
	if(excluded.length) out.push(para(`Skipped (excluded from imports): ${excluded.length}`), messageList(excluded.map(b=> Comparison.bookLine(b.theirs)), 10));
	if(notAdded.length){
		out.push(para(spell(audiobookdb ? `Not added, as AudiobookDB has several releases of them and none is yours: ${notAdded.length}. Add them from the book form with your release's address.`
			: `Not added, as Hardcover has no audiobook edition picked for them: ${notAdded.length}`)), messageList(notAdded.map(b=> Comparison.bookLine(b.theirs)), 10));
	}
	if(compare.warnings.length) out.push(para(`Needs a look (${compare.warnings.length}):`, 'warn'), messageList(compare.warnings));
	if(!pickedCount(compare) && !fresh.length && !gains.length && !differing.length && !(hardcover && (hardcover.plan.add.length || hardcover.plan.reads.length))
		&& !(audiobookdb && audiobookdb.plan && audiobookdb.plan.add.length)){
		out.push(para(spell('Nothing to take or send: both have the same.')));
	}
	showPreview(spell(`Compare with ${name}`), out, applyLabel());
}

/**
 * Open a comparison in the preview, under the panel of its source.
 * @param {Omit<PendingCompare, 'picks'>} compare
 */
function openCompare(compare){
	closeImportPreview();
	PENDING_COMPARE = pendingCompare(compare);
	drawCompare();
	openPreview(`${compare.source}Panel`);
}

/**
 * Show the books of an Audible or Goodreads export beside this catalog's.
 * @param {ImportKind} kind
 * @param {string} text the export's text
 * @param {string} fileName
 */
function compareExport(kind, text, fileName){
	const importer = IMPORTERS[kind]();
	const result = importer.read(text);
	const notes = [`${Text.plural(result.books.length, 'finished book')} read from ${fileName}`];
	if(result.skippedUnfinished) notes.push(`Not finished yet, skipped: ${result.skippedUnfinished}`);
	openCompare({source: kind, name: importer.label, notes, incoming: result.books, comparison: Comparison.compare(CATALOG, result.books),
		warnings: result.warnings, hardcover: null, audiobookdb: null});
}

/**
 * The catalog with what is ticked in `compare` taken in, in a copy, with what blocks it.
 * @param {PendingCompare} compare
 */
function applyIntoCopy(compare){
	const copy = CATALOG.clone();
	const {take, editions} = compare.picks;
	const {report, patched} = Comparison.apply(copy, compare.incoming, {...compare.picks, take: new Set([...take, ...editions])}, compare.opts);
	const {hardcover, audiobookdb, picks} = compare;
	const idsFound = !picks.ids ? 0 : hardcover ? HardcoverSync.addIds(copy.books, hardcover.found).length
		: audiobookdb ? AudiobookdbSync.addIds(copy.books, audiobookdb.found).length : 0;
	const infoIds = picks.ids && audiobookdb ? AudiobookdbSync.setInfoIds(copy, audiobookdb.infoIds) : 0;
	const errors = copy.bookErrors();
	return {copy, report, patched, idsFound, infoIds, errors};
}

/**
 * What applying a comparison did here, as the status line says it: "Added 2 books, filled in 1 ASIN, changed 1 value".
 * @param {MergeReport} report
 * @param {number} patched
 * @param {number} [idsFound] books that got a Hardcover or AudiobookDB id (or AudiobookDB cover) found for them
 * @param {string} [found] what was found for them, and where
 * @param {number} [infoIds] series and people that got an AudiobookDB id
 * @returns {string}
 */
function appliedText(report, patched, idsFound = 0, found = 'Hardcover ids', infoIds = 0){
	/** @type {[Book[], (n: number) => string][]} */
	const filled = [[report.backfilled, n=> `filled in ${Text.plural(n, 'ASIN')}`], [report.goodreadsFilled, n=> `filled in ${Text.plural(n, 'Goodreads id')}`],
		[report.hardcoverFilled, n=> `filled in Hardcover ids on ${Text.plural(n, 'book')}`], [report.datesFilled, n=> `filled in dates read on ${Text.plural(n, 'book')}`],
		[report.isbnsFilled, n=> `added ISBNs to ${Text.plural(n, 'book')}`], [report.editionsAdded, n=> `added editions to ${Text.plural(n, 'book')}`],
		[report.detailsFilled, n=> `filled in edition details on ${Text.plural(n, 'book')}`]];
	return [`Added ${Text.plural(report.added.length, 'book')}`, ...filled.filter(([list])=> list.length).map(([list, say])=> say(list.length)),
		(idsFound || infoIds) && `saved ${found} found for ` + [idsFound && Text.plural(idsFound, 'book'),
			infoIds && Text.plural(infoIds, 'series or person', 'series and people')].filter(Boolean).join(' and '), patched && `changed ${Text.plural(patched, 'value')}`].filter(Boolean).join(', ');
}

function applyCompare(){
	const compare = PENDING_COMPARE;
	if(!compare) return;
	if(compare.hardcover) return applyHardcover(compare);
	if(compare.audiobookdb) return applyAudiobookdb(compare);
	closeImportPreview();
	// applied to the catalog as it is now, in case books were edited while the comparison was open
	const {copy, report, patched, errors} = applyIntoCopy(compare);
	if(errors.length){ showIoStatus(spell('The catalog changed and the import no longer validates; nothing was changed.'), true); return; }
	CATALOG.books = copy.books;
	refreshPage(); persist();
	showIoStatus(appliedText(report, patched) + '.');
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
	const merged = new Catalog({books: m.books, series: m.series, authors: m.authors, narrators: m.narrators, publishers: m.publishers});
	const errors = merged.validate({contributors: true}).errors;
	const changes = [m.added, m.updated, m.removed, m.infoAdded, m.infoChanged, m.authorsAdded, m.authorsChanged, m.narratorsAdded,
		m.narratorsChanged, m.publishersAdded, m.publishersChanged, m.excluded, m.notDuplicates].reduce((n, list)=> n + list.length, 0);
	return {m, errors, changes};
}

function previewMerge(){
	if(!PENDING_MERGE) return;
	const {backup, fileName} = PENDING_MERGE;
	const {m, errors, changes} = mergeIntoCatalog(backup);
	const list = (/** @type {Book[]} */ books) => messageList(books.map(Comparison.bookLine));
	/** @type {Child[]} */
	const out = [para(`${backup.books.length} books in ${fileName}; ${m.books.length} after merging.`)];
	out.push(para(`New from the backup: ${m.added.length}`), list(m.added));
	out.push(para(`Gaining genres, dates read or editions${m.conflicts.length ? ', or the version kept below' : ''}: ${m.updated.length}`));
	out.push(para(`Removed (removed on the other device): ${m.removed.length}`), list(m.removed));
	if(m.skipped.length) out.push(para(`Not added back (removed here): ${m.skipped.length}`));
	if(m.conflicts.length){
		const kept = fieldById('mergePreferSelect').value === 'backup' ? "the backup's" : spell("this catalog's");
		out.push(para(`Title, author or series differ, keeping ${kept}: ${m.conflicts.length}`),
			messageList(m.conflicts.map(c=> `${Comparison.bookLine(c.mine)} / backup: ${Comparison.bookLine(c.theirs)}`)));
	}
	const infoDiffer = m.infoChanged.length + m.infoKept.length;
	if(m.infoAdded.length || infoDiffer){
		out.push(para(`Series' totals, status, notes and links: ${m.infoAdded.length} added` + (infoDiffer ? `, ${infoDiffer} differing (keeping ${m.infoChanged.length ? "the backup's" : spell("this catalog's")})` : '')));
	}
	for(const [label, added, changed, kept] of /** @type {[string, string[], string[], string[]][]} */ ([
		["Authors' bios and links", m.authorsAdded, m.authorsChanged, m.authorsKept],
		["Narrators' bios and links", m.narratorsAdded, m.narratorsChanged, m.narratorsKept],
		["Publishers' bios and links", m.publishersAdded, m.publishersChanged, m.publishersKept]])){
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
	byId('mergePrefer').classList.add('show');
	showPreview('Merge a backup', out, !errors.length && changes ? 'Merge' : '', 'backupPanel');
}

function applyMerge(){
	if(!PENDING_MERGE) return;
	// merged again, in case books were edited while the preview was open
	const {m, errors, changes} = mergeIntoCatalog(PENDING_MERGE.backup);
	closeImportPreview();
	if(errors.length || !changes){ showIoStatus(spell('The catalog changed and the merge no longer applies; nothing was changed.'), true); return; }
	CATALOG.books = m.books;
	for(const kind of /** @type {const} */ (['series', 'authors', 'narrators', 'publishers'])) CATALOG.replaceInfo(kind, m[kind]);
	CATALOG.addExclusions(m.excluded);
	CATALOG.addMarkTexts(m.notDuplicates);
	refreshPage(); persist();
	showIoStatus(`Merged: ${m.added.length} added, ${m.updated.length} updated, ${m.removed.length} removed.`);
}

/**
 * Read a backup to merge, and preview the merge.
 * @param {File} file
 */
async function mergeBackupFile(file){
	if(!await holdWholeCatalog()) return;
	try{
		const [{text}] = await readFiles([file]);
		const backup = Backup.read(JSON.parse(text));
		if(backup.books.some(b=> !b.title || !b.authors.length)) throw new Error('missing title/author');
		PENDING_COMPARE = null;
		PENDING_MERGE = {backup, fileName: file.name};
		PENDING_TIDY = null;
		previewMerge();
	}catch{
		closeImportPreview();
		showIoStatus(spell("Couldn't read that file \u2014 make sure it's a catalog backup JSON."), true);
	}
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
	PENDING_COMPARE = null;
	PENDING_MERGE = null;
	byId('mergePrefer').classList.remove('show');
	showPreview(title, body, PENDING_TIDY ? confirm : '', 'checkPanel');
}

function checkCatalog(){
	const {errors, warnings} = CATALOG.validate({contributors: true});
	const people = [Text.plural(CATALOG.nameIds.authors.size, 'author'), Text.plural(CATALOG.nameIds.narrators.size, 'narrator'), Text.plural(CATALOG.nameIds.publishers.size, 'publisher')];
	const described = CATALOG.authors.size + CATALOG.narrators.size + CATALOG.publishers.size;
	/** @type {Child[]} */
	const out = [para(`${CATALOG.books.length} books; ${CATALOG.nameIds.series.size} series, ${CATALOG.series.size} with a released total; ` +
		`${people.join(', ')}, ${described} with a bio or links.`)];
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
	const errors = copy.bookErrors();
	return {copy, report, errors};
}

function previewBoxSets(){
	const {report, errors} = boxSetsIntoCopy();
	/** @type {Child[]} */
	const out = [para(`Box sets: ${report.boxSets.length}`),
		messageList(report.boxSets.map(b=> `${b.title} \u2014 ${Text.namesText(b.authors)}: ${Text.plural(b.titles, 'title')} already here`))];
	if(report.excluded.length) out.push(para(`Skipped (excluded from imports): ${report.excluded.length}`));
	out.push(para(`New: ${report.added.length}`), messageList(report.added.map(Comparison.bookLine)));
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
// The page asks Hardcover itself, as Hardcover's API allows browser requests, with a token kept in this
// browser only (never in a backup). Comparing only reads Hardcover; applying saves the catalog first, then
// sends what was ticked, and that stops if you leave the page, so the browser asks first.
/** @type {CatalogJob | null} */
let PAGE_RUN = null;           // a run going on in this page (showCatalogJob)

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
	}catch{
		showIoStatus(`Couldn't ${remove ? 'remove' : 'save'} the token: this browser refused to store it.`, true);
	}
	showHardcoverToken();
}

// ------------------------------------------------------------ the catalog proxy
// Its address and key are kept in this browser only (never in a backup), like the Hardcover token.
function showProxy(){
	const proxy = browserProxy();
	byId('proxyState').textContent = proxy
		? `Saved in this browser only (never in a backup): ${proxy.url}`
		: 'Paste your proxy\'s address and key and save them; they are kept in this browser only (never in a backup).';
	byId('proxyCheck').style.display = proxy ? '' : 'none';
	byId('proxyRemove').style.display = proxy ? '' : 'none';
}

/**
 * Save the proxy typed in the page in this browser and check it, or `remove` the saved one.
 * @param {boolean} remove
 */
async function saveProxy(remove){
	const url = fieldById('proxyUrl'), key = fieldById('proxyKey');
	const address = proxyAddress(url.value);
	if(!remove){
		if(!address){ showIoStatus('Paste the proxy\'s address first (https://…workers.dev).', true); return; }
		if(!key.value.trim()){ showIoStatus('Paste the proxy\'s key first.', true); return; }
	}
	try{
		if(remove) localStorage.removeItem(PROXY_STORAGE_KEY);
		else localStorage.setItem(PROXY_STORAGE_KEY, JSON.stringify({url: address, key: key.value.trim()}));
		url.value = ''; key.value = '';
	}catch{
		showIoStatus(`Couldn't ${remove ? 'remove' : 'save'} the proxy: this browser refused to store it.`, true);
		return;
	}
	showProxy();
	if(remove) showIoStatus('Catalog proxy removed.');
	else await checkProxy('Catalog proxy saved');
}

/**
 * Ask the saved proxy whether it answers this page with its key, and say so.
 * @param {string} [saved] what the status line starts with, after a save
 */
async function checkProxy(saved){
	const start = saved ? `${saved}; ` : '';
	try{
		const res = await fetchViaProxy('ping');
		if(res.ok){
			const names = /** @type {{catalogs?: string[]}} */ (await res.json()).catalogs || [];
			showIoStatus(`${start}${saved ? 'it' : 'The catalog proxy'} answers, for ${names.join(', ')}.`);
		}else if(res.status === 401) showIoStatus(`${start}the proxy refused the key.`, true);
		else showIoStatus(`${start}the proxy answered ${res.status}.`, true);
	}catch(e){
		showIoStatus(`${start}${Text.errorText(e)}.`, true);
	}
}

/**
 * Run `task` with Hardcover or AudiobookDB (`catalog`), shown in the banner on top while it goes (as a `mode`
 * job), handing it the step it reports its progress through. Resolves to what it gave or threw and how long it
 * took; to undefined when another run is going on.
 * @template T
 * @param {string} catalog
 * @param {CatalogMode} mode
 * @param {(step: Step) => Promise<T>} task
 * @returns {Promise<{value?: T, error?: unknown, elapsed: number} | undefined>}
 */
async function withCatalogJob(catalog, mode, task){
	if(PAGE_RUN) return undefined;
	const started = Date.now();
	/** @type {CatalogJob} */
	const job = PAGE_RUN = {catalog, mode, dryRun: mode === 'compare', running: true, elapsed: 0, step: 'Starting'};
	const show = ()=>{ job.elapsed = Date.now() - started; showCatalogJob(job); };
	const ticker = setInterval(show, 1000);
	show();
	/** @type {{value?: T, error?: unknown, elapsed: number}} */
	const result = {elapsed: 0};
	try{
		result.value = await task((text, done, total)=>{ Object.assign(job, {step: text, done, total}); show(); });
	}catch(e){
		result.error = e;
	}
	clearInterval(ticker);
	Object.assign(job, {running: false, elapsed: Date.now() - started});
	result.elapsed = job.elapsed;
	PAGE_RUN = null;
	showCatalogJob(job);
	return result;
}

/**
 * The part of the catalog to compare with Hardcover or AudiobookDB, as picked beside its panel's button: null for every book.
 * @param {OnlineCatalog} online
 * @returns {{kind: 'series' | 'author', name: string, label: string} | null}
 */
function scopeOf(online){
	const kind = fieldById(`${online}Scope`).value;
	if(kind !== 'series' && kind !== 'author') return null;
	const name = Text.tidy(fieldById(`${online}ScopeName`).value);
	return {kind, name, label: kind === 'series' ? `the series \u201C${name}\u201D` : `books by ${name}`};
}

/**
 * The name field shows for a series or an author, and offers the names in the catalog.
 * @param {OnlineCatalog} online
 */
function showScope(online){
	const kind = fieldById(`${online}Scope`).value;
	const input = /** @type {HTMLInputElement} */ (byId(`${online}ScopeName`));
	input.style.display = kind ? '' : 'none';
	input.placeholder = kind === 'series' ? 'Series' : 'Author';
	if(!kind) return;
	withWholeCatalog(()=>{
		const names = [...CATALOG.namesOf(kind === 'series' ? 'series' : 'authors')].sort((x, y)=> x.localeCompare(y));
		fillElement(byId(`${online}ScopeNames`), names.map(name=> buildElement('option', {value: name})));
	});
}

/**
 * A series' or an author's page links here to compare their books with Hardcover or AudiobookDB
 * (#hardcover-series=<id>, #audiobookdb-author=<id>): pick them beside that Compare button, and compare.
 */
async function compareFromAddress(){
	const online = /** @type {OnlineCatalog | undefined} */ ((/^#(hardcover|audiobookdb)-/.exec(location.hash) || [])[1]);
	if(!online || !await holdWholeCatalog()) return;   // the names are the catalog's
	for(const [kind, key] of /** @type {const} */ ([['series', 'series'], ['author', 'authors']])){
		const id = idFromAddress(key, valueFromPageHash(location.hash, `${online}-${kind}`));
		const name = id === null ? undefined : CATALOG.nameOf(key, id);
		if(name === undefined) continue;
		fieldById(`${online}Scope`).value = kind;
		fieldById(`${online}ScopeName`).value = name;
		showScope(online);
		byId(`${online}Panel`).scrollIntoView({block: 'start'});
		await (online === 'hardcover' ? compareHardcover() : compareAudiobookdb());
		return;
	}
}

/**
 * A series or an author to compare with Hardcover, with the Hardcover id its info has (a number; a name kept
 * from a page's address is not one).
 * @param {'series' | 'author'} kind
 * @param {string} name
 * @returns {HardcoverPart}
 */
function hardcoverPart(kind, name){
	const id = CATALOG.nameIds[kind === 'series' ? 'series' : 'authors'].get(name);
	const info = id === undefined ? undefined : (kind === 'series' ? CATALOG.series : CATALOG.authors).get(id);
	const hardcover = info && info.external.hardcover;
	return {kind, name, ...hardcover && HardcoverClient.ID.test(hardcover) ? {hardcover} : {}};
}

// Show your Hardcover shelves beside this catalog, or beside a series' or an author's books. Only reads Hardcover.
async function compareHardcover(){
	if(PAGE_RUN) return;
	const token = browserHardcoverToken();
	if(!token){ showIoStatus('Save your Hardcover API token first (below the buttons).', true); return; }
	const scope = scopeOf('hardcover');
	if(scope && !scope.name){ showIoStatus(`Type the ${scope.kind === 'series' ? 'series' : 'author'} to compare first.`, true); return; }
	if(!await holdWholeCatalog()) return;
	const inScope = scope ? Comparison.scope(scope.kind, scope.name) : null;
	const here = inScope ? CATALOG.books.filter(inScope).length : CATALOG.books.length;
	if(scope && !here){ showIoStatus(spell(`No book in this catalog is ${scope.kind === 'series' ? 'in' : 'by'} ${scope.kind === 'series' ? scope.label : scope.name}.`), true); return; }
	closeImportPreview();
	await whenSaved();   // compared with the catalog as saved
	const run = await withCatalogJob('Hardcover', 'compare', step=> new HardcoverSync(hardcoverClient(token)).compare(CATALOG, step, scope ? hardcoverPart(scope.kind, scope.name) : undefined));
	if(!run) return;
	const hc = run.value;
	if(!hc){
		showPreview(spell('Compare with Hardcover'), [para(`Couldn't compare: ${Text.errorText(run.error)}`, 'warn')], '', 'hardcoverPanel');
		return;
	}
	const notes = [scope
		? spell(`Only ${scope.label}: ${Text.plural(here, 'book')} in this catalog, ${hc.incoming.length} on your Hardcover Read shelf (took ${minutes(run.elapsed)})`)
		: `${Text.plural(hc.incoming.length, 'book')} on your Hardcover Read shelf` + (hc.otherShelves ? `, ${hc.otherShelves} on other shelves` : '') + ` (took ${minutes(run.elapsed)})`];
	openCompare({source: 'hardcover', name: 'Hardcover', notes, incoming: hc.incoming, opts: hc.opts, comparison: hc.comparison,
		warnings: hc.warnings, hardcover: hc, audiobookdb: null});
}

/**
 * Take in what is ticked of a Hardcover comparison, save it, and then send what is ticked to Hardcover.
 * @param {PendingCompare} compare
 */
async function applyHardcover(compare){
	const hc = /** @type {HardcoverComparison} */ (compare.hardcover);
	const token = browserHardcoverToken();
	const {picks} = compare;
	/** @type {HardcoverPlan} */
	const plan = {add: hc.plan.add.filter((a, i)=> picks.add.has(i)), reads: hc.plan.reads.filter((a, i)=> picks.reads.has(i)), otherShelf: [], unknown: [], inexact: []};
	if(PAGE_RUN) return;
	if((plan.add.length || plan.reads.length) && !token){ showIoStatus('Save your Hardcover API token first (below the buttons).', true); return; }
	closeImportPreview();
	await whenSaved();
	if(await storedRevision() !== SEEN_REVISION){
		showIoStatus(spell('The catalog was edited in another tab since you compared; nothing was changed, nothing sent to Hardcover. Compare again.'), true);
		return;
	}
	const {copy, report, patched, idsFound, errors} = applyIntoCopy(compare);
	if(errors.length){ showIoStatus(spell('The catalog changed and the import no longer validates; nothing was changed, nothing sent to Hardcover.'), true); return; }
	const here = appliedText(report, patched, idsFound);
	if(JSON.stringify(copy.books) !== JSON.stringify(CATALOG.books)){
		CATALOG.books = copy.books;
		await persist();   // kept before anything is sent, so the ids found stay even if Hardcover stops answering
		refreshPage();
	}
	if(!plan.add.length && !plan.reads.length){ showIoStatus(here + '.'); return; }
	/** @type {string[]} */
	const lines = [];
	const say = (/** @type {string} */ line)=>{ lines.push(line); };
	const run = await withCatalogJob('Hardcover', 'send', step=> new HardcoverSync(hardcoverClient(/** @type {string} */ (token))).push(plan, say, say, step));
	if(!run) return;
	if(run.error) lines.push(`error: ${Text.errorText(run.error)}`);
	const ok = !run.error && run.value === 0;
	showPreview(`Hardcover updated (took ${minutes(run.elapsed)})`, [para(here + ' here.'), buildElement('pre', {}, lines.join('\n'))], '', 'hardcoverPanel');
	showIoStatus(ok ? `${here}; Hardcover updated.` : 'Not everything went through on Hardcover; see the details.', !ok);
}

// ------------------------------------------------------------ AudiobookDB
// AudiobookDB is asked through the catalog proxy, with your API key (kept in this browser only, never in a
// backup) for your shelves. Comparing only reads it; applying saves the catalog first, then puts what was
// ticked on your Read shelf there, which stops if you leave the page, so the browser asks first.
function showAudiobookdbKey(){
	const saved = Boolean(browserAudiobookdbKey());
	byId('audiobookdbKeyState').textContent = saved
		? 'Your AudiobookDB API key is saved in this browser only (never in a backup).'
		: 'Paste an API key from audiobookdb.org (under your account) and save it, to compare your shelves and put books on them; it is kept in this browser only (never in a backup). Without it, Compare only finds your books there.';
	byId('audiobookdbKeyRemove').style.display = saved ? '' : 'none';
}

/**
 * Save the AudiobookDB key pasted in the page in this browser, or `remove` the saved one.
 * @param {boolean} remove
 */
function saveAudiobookdbKey(remove){
	const input = fieldById('audiobookdbKey');
	if(!remove && !input.value.trim()){ showIoStatus('Paste your AudiobookDB API key first.', true); return; }
	try{
		if(remove) localStorage.removeItem(AUDIOBOOKDB_KEY_STORAGE);
		else localStorage.setItem(AUDIOBOOKDB_KEY_STORAGE, input.value.trim());
		input.value = '';
		showIoStatus(remove ? 'AudiobookDB key removed.' : 'AudiobookDB key saved.');
	}catch{
		showIoStatus(`Couldn't ${remove ? 'remove' : 'save'} the key: this browser refused to store it.`, true);
	}
	showAudiobookdbKey();
}

/**
 * A series or an author to compare with AudiobookDB, with the AudiobookDB id its info has.
 * @param {'series' | 'author'} kind
 * @param {string} name
 * @returns {AudiobookdbPart}
 */
function audiobookdbPart(kind, name){
	const id = CATALOG.nameIds[kind === 'series' ? 'series' : 'authors'].get(name);
	const info = id === undefined ? undefined : (kind === 'series' ? CATALOG.series : CATALOG.authors).get(id);
	const audiobookdb = info && info.external.audiobookdb;
	return {kind, name, ...audiobookdb ? {audiobookdb} : {}};
}

// Show your AudiobookDB shelves beside this catalog, or beside a series' or an author's books. Only reads AudiobookDB.
async function compareAudiobookdb(){
	if(PAGE_RUN) return;
	if(!browserProxy()){ showIoStatus('AudiobookDB is asked through your catalog proxy: save one first (below).', true); return; }
	const scope = scopeOf('audiobookdb');
	if(scope && !scope.name){ showIoStatus(`Type the ${scope.kind === 'series' ? 'series' : 'author'} to compare first.`, true); return; }
	if(!await holdWholeCatalog()) return;
	const inScope = scope ? Comparison.scope(scope.kind, scope.name) : null;
	const here = inScope ? CATALOG.books.filter(inScope).length : CATALOG.books.length;
	if(scope && !here){ showIoStatus(spell(`No book in this catalog is ${scope.kind === 'series' ? 'in' : 'by'} ${scope.kind === 'series' ? scope.label : scope.name}.`), true); return; }
	closeImportPreview();
	await whenSaved();   // compared with the catalog as saved
	const key = browserAudiobookdbKey();
	const run = await withCatalogJob('AudiobookDB', 'compare', step=> new AudiobookdbSync(audiobookdbClient(key)).compare(CATALOG, step, scope ? audiobookdbPart(scope.kind, scope.name) : undefined));
	if(!run) return;
	const ab = run.value;
	if(!ab){
		showPreview('Compare with AudiobookDB', [para(`Couldn't compare: ${Text.errorText(run.error)}`, 'warn')], '', 'audiobookdbPanel');
		return;
	}
	// the catalog's own books come first in the comparison's merged copy, with the ids found
	const found = ab.comparison.merged.books.slice(0, CATALOG.books.length).filter(inScope || (()=> true)).filter(b=> b.idOn('audiobookdb')).length;
	const shelf = ab.onShelf === null ? '' : `, ${Text.plural(ab.onShelf, 'book')} on your AudiobookDB ${ab.plan ? ab.plan.name : 'Read'} shelf`;
	const notes = [spell(`${scope ? `Only ${scope.label}: ` : ''}${Text.plural(here, 'book')} in this catalog, ${found} of them on AudiobookDB${shelf} (took ${minutes(run.elapsed)})`)];
	openCompare({source: 'audiobookdb', name: 'AudiobookDB', notes, incoming: ab.incoming, opts: ab.opts, comparison: ab.comparison,
		warnings: ab.warnings, hardcover: null, audiobookdb: ab});
}

/**
 * Take in what is ticked of an AudiobookDB comparison, save it, and then put what is ticked on your Read shelf there.
 * @param {PendingCompare} compare
 */
async function applyAudiobookdb(compare){
	const ab = /** @type {AudiobookdbComparison} */ (compare.audiobookdb);
	const key = browserAudiobookdbKey();
	const {picks} = compare;
	/** @type {AudiobookdbPlan | null} */
	const plan = ab.plan && {...ab.plan, add: ab.plan.add.filter((a, i)=> picks.add.has(i)), otherShelf: [], unknown: []};
	if(PAGE_RUN) return;
	if(plan && plan.add.length && !key){ showIoStatus('Save your AudiobookDB API key first (below the buttons).', true); return; }
	closeImportPreview();
	await whenSaved();
	if(await storedRevision() !== SEEN_REVISION){
		showIoStatus(spell('The catalog was edited in another tab since you compared; nothing was changed, nothing sent to AudiobookDB. Compare again.'), true);
		return;
	}
	const {copy, report, patched, idsFound, infoIds, errors} = applyIntoCopy(compare);
	if(errors.length){ showIoStatus(spell('The catalog changed and the import no longer validates; nothing was changed, nothing sent to AudiobookDB.'), true); return; }
	const here = appliedText(report, patched, idsFound, 'AudiobookDB ids and covers', infoIds);
	if(JSON.stringify(copy.books) !== JSON.stringify(CATALOG.books) || infoIds){
		CATALOG.books = copy.books;
		if(picks.ids) AudiobookdbSync.setInfoIds(CATALOG, ab.infoIds);
		await persist();   // kept before anything is sent, so the ids found stay even if AudiobookDB stops answering
		refreshPage();
	}
	if(!plan || !plan.add.length){ showIoStatus(here + '.'); return; }
	/** @type {string[]} */
	const lines = [];
	const say = (/** @type {string} */ line)=>{ lines.push(line); };
	const run = await withCatalogJob('AudiobookDB', 'send', step=> new AudiobookdbSync(audiobookdbClient(key)).push(plan, say, say, step));
	if(!run) return;
	if(run.error) lines.push(`error: ${Text.errorText(run.error)}`);
	const ok = !run.error && run.value === 0;
	showPreview(`AudiobookDB updated (took ${minutes(run.elapsed)})`, [para(here + ' here.'), buildElement('pre', {}, lines.join('\n'))], '', 'audiobookdbPanel');
	showIoStatus(ok ? `${here}; AudiobookDB updated.` : 'Not everything went through on AudiobookDB; see the details.', !ok);
}

// Leaving the page stops sending to Hardcover or AudiobookDB: the browser asks first. (Nothing is lost by stopping
// early: compare and apply again to carry on, as nothing already there is added twice.)
addEventListener('beforeunload', e => {
	if(PAGE_RUN && !PAGE_RUN.dryRun){ e.preventDefault(); e.returnValue = ''; }
});

/**
 * Each update of a run (showCatalogJob in store.js): no second run while one goes.
 * @param {CatalogJob | null} job
 */
function onCatalogJob(job){
	for(const id of ['hardcoverCompareBtn', 'audiobookdbCompareBtn']) /** @type {HTMLButtonElement} */ (byId(id)).disabled = Boolean(job && job.running);
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
	PENDING_COMPARE = null;
	PENDING_MERGE = null;
	PENDING_TIDY = null;
	byId('mergePrefer').classList.remove('show');
	byId('importPreview').classList.remove('open');
}

/**
 * Read an Audible or Goodreads export, and preview its import.
 * @param {ImportKind} kind
 * @param {File} file
 */
async function importCsv(kind, file){
	if(!await holdWholeCatalog()) return;
	try{
		const [{text}] = await readFiles([file]);
		compareExport(kind, text, file.name);
	}catch{
		closeImportPreview();
		showIoStatus(`Couldn't read that file as a ${IMPORTERS[kind]().label} export.`, true);
	}
}

byId('importAudibleBtn').addEventListener('click', ()=>{ IMPORT_KIND = 'audible'; byId('importCsvFile').click(); });
byId('importGoodreadsBtn').addEventListener('click', ()=>{ IMPORT_KIND = 'goodreads'; byId('importCsvFile').click(); });
/**
 * When files are picked in the file field `id`, hand them to `take`, and empty the field, so the same file
 * can be picked again.
 * @param {string} id
 * @param {(files: File[]) => Promise<void>} take
 */
function onFilesPicked(id, take){
	byId(id).addEventListener('change', e=>{
		const input = /** @type {HTMLInputElement} */ (e.target);
		const files = [...(input.files || [])];
		input.value = '';
		if(files.length) return take(files);
	});
}
onFilesPicked('importCsvFile', files=> importCsv(IMPORT_KIND, files[0]));
byId('importConfirm').addEventListener('click', ()=> PENDING_TIDY ? applyTidy() : PENDING_MERGE ? applyMerge() : applyCompare());
byId('hardcoverCompareBtn').addEventListener('click', compareHardcover);
byId('hardcoverScope').addEventListener('change', ()=> showScope('hardcover'));
byId('hardcoverTokenSave').addEventListener('click', ()=> saveHardcoverToken(false));
byId('hardcoverTokenRemove').addEventListener('click', ()=> saveHardcoverToken(true));
byId('audiobookdbCompareBtn').addEventListener('click', compareAudiobookdb);
byId('audiobookdbScope').addEventListener('change', ()=> showScope('audiobookdb'));
byId('audiobookdbKeySave').addEventListener('click', ()=> saveAudiobookdbKey(false));
byId('audiobookdbKeyRemove').addEventListener('click', ()=> saveAudiobookdbKey(true));
byId('proxySave').addEventListener('click', ()=> saveProxy(false));
byId('proxyCheck').addEventListener('click', ()=> checkProxy());
byId('proxyRemove').addEventListener('click', ()=> saveProxy(true));
byId('importCancel').addEventListener('click', closeImportPreview);

byId('checkBtn').addEventListener('click', ()=> withWholeCatalog(checkCatalog));
byId('boxSetsBtn').addEventListener('click', ()=> withWholeCatalog(previewBoxSets));
byId('exportBtn').addEventListener('click', ()=> withWholeCatalog(exportBackup));
byId('exportGoodreadsBtn').addEventListener('click', ()=> withWholeCatalog(exportGoodreads));
byId('importBtn').addEventListener('click', ()=> byId('importFile').click());
byId('mergeBtn').addEventListener('click', ()=> byId('mergeFile').click());
onFilesPicked('mergeFile', files=> mergeBackupFile(files[0]));
byId('mergePreferSelect').addEventListener('change', ()=>{ if(PENDING_MERGE) previewMerge(); });
onFilesPicked('importFile', importBackup);

export const READY = startPage(()=>{ refreshPage(); showHardcoverToken(); showAudiobookdbKey(); showProxy(); showScope('hardcover'); showScope('audiobookdb'); compareFromAddress(); }, {refresh: refreshPage, onCatalogJob});
