// The import and export page: comparing the catalog with export files (Audible's, Goodreads') and with catalogs'
// shelves (Hardcover's, AudiobookDB's), to take books and values from them (and send books and reads to those
// shelves), files for other catalogs' imports, and backups. It knows the external catalogs only through
// CatalogConnectors and their base classes (FileImporter, FileExporter, ShelfSync, CatalogClient), and each
// catalog's panel by its prefix (its CATALOG). It shows only how many books there are until an action needs
// every book (an import, Check, Box sets, a comparison, Export, Restore or Merge), and then holds the whole
// catalog. Loading and saving live in store.js.
import {Text} from './modules/text.js';
import {Catalog} from './modules/catalog.js';
import {Backup, NewerBackup, UnreadableBackup} from './modules/backup.js';
import {CatalogRecords} from './modules/catalog-records.js';
import {CatalogConnectors} from './modules/catalog-connectors.js';
import {Comparison} from './modules/comparison.js';
import {
	CATALOG,
	SEEN_REVISION,
	storedRevision,
	whenSaved,
	persist,
	showIoStatus,
	minutes,
	showCatalogJob,
	PROXY_STORAGE_KEY,
	browserProxy,
	proxyAddress,
	fetchViaProxy,
	savedKey,
	saveKey,
	catalogClient,
	startPage,
	afterSaving,
	queryCatalog,
	wholeCatalog,
	byId,
	fieldById,
	spell,
	valueFromPageHash,
	idFromAddress,
	takeShelfCompare,
	buildElement,
	fillElement,
	noteBackup,
	backupAge,
	backupAgeText,
	bookPageHref,
} from './store.js';
/** @import {Child} from './store.js' */
/** @import {Book} from './modules/book.js' */
/** @import {FileImporter} from './modules/file-importer.js' */
/** @import {FileExporter} from './modules/file-exporter.js' */
/** @import {ShelfSync, ShelfComparison, SyncPlan, NotAudio} from './modules/shelf-sync.js' */
/** @import {ClientClass} from './modules/catalog-client.js' */
/** @import {CatalogJob} from './store.js' */
/** @import {MergeOptions, MergeReport} from './modules/merger.js' */
/** @import {ComparisonResult, ComparedBook, Difference} from './modules/comparison.js' */
/** @import {Step} from './modules/catalog-client.js' */

/** @typedef {CatalogJob['mode']} CatalogMode */
/** @typedef {typeof FileImporter} ImporterClass */
/** @typedef {typeof ShelfSync} SyncClass */

function refreshPage() {
	return afterSaving(async () => {
		const count = await queryCatalog(r => r.count('books'));
		byId('subtitle').textContent = spell(`${count} audiobooks in the catalog`);
		byId('backupState').textContent = backupAgeText(await backupAge());
	});
}

/**
 * Hold the whole catalog, which the page keeps from then on; false, said on the status line, when it can't be read.
 * @returns {Promise<boolean>}
 */
async function holdWholeCatalog() {
	try {
		await wholeCatalog();
		return true;
	} catch (e) {
		showIoStatus(
			spell(`Couldn't read the catalog kept in this browser: ${Text.errorText(e)}. Reload the page.`),
			true,
		);
		return false;
	}
}

/**
 * Run `task` once the page holds the whole catalog (holdWholeCatalog); not when it can't be read.
 * @param {() => void} task
 * @returns {Promise<void>}
 */
async function withWholeCatalog(task) {
	if (await holdWholeCatalog()) task();
}

/**
 * Hand the browser `text` as a file to save, named `name` and today's date.
 * @param {string} text
 * @param {string} type its media type: 'text/csv' or 'application/json'
 * @param {string} name
 */
function download(text, type, name) {
	const blob = new Blob([text], {type});
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = name + '-' + new Date().toISOString().slice(0, 10) + (type === 'text/csv' ? '.csv' : '.json');
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	URL.revokeObjectURL(url);
}

function exportBackup() {
	// version 2: the stored records by store and id (Backup.write)
	download(JSON.stringify(Backup.write(CATALOG), null, '\t'), 'application/json', 'audiobook-catalog-backup');
	showIoStatus('Backup downloaded.');
	noteBackup().then(refreshPage);
}

/**
 * Download the catalog as an export file for another catalog's import.
 * @param {FileExporter} exporter
 */
function exportFile(exporter) {
	const {LABEL, FORMAT, FILE_NAME, TYPE} = exporter.kind;
	const out = exporter.write(CATALOG.books);
	download(out.text, TYPE, FILE_NAME);
	showIoStatus(
		`${LABEL} ${FORMAT} with ${out.books} books downloaded${out.notes.length ? ' (' + out.notes.join('; ') + ')' : ''}.`,
	);
}

/**
 * Pick the files to read; resolves to [{name, text}].
 * @param {Iterable<File>} files
 * @returns {Promise<{name: string, text: string}[]>}
 */
function readFiles(files) {
	return Promise.all(
		[...files].map(
			file =>
				/** @type {Promise<{name: string, text: string}>} */ (
					new Promise((resolve, reject) => {
						const reader = new FileReader();
						// the event's target is the reader, which read a string
						reader.onload = e =>
							resolve({
								name: file.name,
								text: /** @type {string} */ (/** @type {FileReader} */ (e.target).result),
							});
						reader.onerror = () => reject(new Error(`couldn't read ${file.name}`));
						reader.readAsText(file);
					})
				),
		),
	);
}

/**
 * Restore: a backup, or the data files of a catalog from before it lived in the browser
 * (books.json, series-info.json, ... picked together; Backup.readFiles), replaces the catalog.
 * @param {File[]} files
 */
async function importBackup(files) {
	if (!(await holdWholeCatalog())) return; // what it replaces is all of it
	try {
		const {books, series, authors, narrators, publishers, excluded, notDuplicates, marks, nameIds} =
			Backup.readFiles(await readFiles(files));
		const bad = books.some(b => !b.title || !b.authors.length);
		if (bad) throw new Error('missing title/author');
		// the catalog is kept as records, which have no place for a value that isn't what its field holds
		const unstorable = CatalogRecords.unstorable(
			new Catalog({
				books,
				series: series || undefined,
				authors: authors || undefined,
				narrators: narrators || undefined,
				publishers: publishers || undefined,
			}),
		);
		if (unstorable.length) {
			showIoStatus(
				`Not restored: fix these values in the backup first (they aren't what their field holds): ${Text.firstThree(unstorable, '; ')}.`,
				true,
			);
			return;
		}
		// the info kept is by name here, as it is moved over to the ids its names have
		const keptInfo = /** @type {const} */ (['series', 'authors', 'narrators', 'publishers']).map(
			kind => /** @type {const} */ ([kind, CATALOG.infoByName(kind)]),
		);
		// and the marks are taken as text, to point them at the books restored
		const keptMarks = CATALOG.markTexts();
		CATALOG.books = books;
		CATALOG.marks = new Map();
		if (nameIds) CATALOG.nameIds = nameIds; // the ids series and people were stored under, when the backup has them
		for (const [kind, had] of keptInfo) {
			// older backups have no series info, nor author, narrator and publisher info: keep the current one
			const restored = {series, authors, narrators, publishers}[kind];
			CATALOG.replaceInfo(kind, restored || had);
		}
		const newlyExcluded = CATALOG.addExclusions(excluded || []); // added to, never replaced: removing one is a hand edit
		// likewise the pairs marked "Not duplicates": a version 2 backup's by the ids of its books, an older one's as text
		CATALOG.addMarkTexts([...keptMarks, ...(marks ? [] : notDuplicates || [])]);
		if (marks) {
			CATALOG.addMarks(marks.map(m => ({...m})));
			CATALOG.resolveMarks();
		}
		persist();
		noteBackup().then(refreshPage); // what was restored is in that backup
		showIoStatus(
			`Restored ${books.length} books` +
				(series ? ` and the release details of ${series.size} series` : '') +
				(newlyExcluded ? `; ${newlyExcluded} more excluded from imports.` : '.'),
		);
	} catch (exc) {
		showIoStatus(
			exc instanceof NewerBackup
				? 'Not restored: a newer version of the catalog made that backup. Reload the page to update it, then try again.'
				: exc instanceof UnreadableBackup
					? `Not restored: ${exc.message}.`
					: spell(
							"Couldn't read that — pick a catalog backup JSON, or your books.json with the other data files.",
						),
			true,
		);
	}
}

// ------------------------------------------------------------ Comparing with export files and catalogs' shelves
// An import shows the books of the other source beside this catalog's (Comparison), and takes only what is
// ticked: the books to import (new ones, and those it has more of), and the values of the other source to put
// in place of this catalog's. For a catalog's shelves (ShelfSync) the same view also picks books (and reads) to
// put there. Like every edit in the page, the result is then saved (see persist).
/**
 * An importer of `Importer`'s files; the site picked beside its button, for an export of a catalog with
 * several (Audible's ASINs are those of the site picked, audible.com unless changed).
 * @param {ImporterClass} Importer
 * @returns {FileImporter}
 */
function importerOf(Importer) {
	const site = document.getElementById(`${Importer.CATALOG}ImportSite`);
	return new /** @type {new (site?: string) => FileImporter} */ (Importer)(
		site ? /** @type {HTMLSelectElement} */ (site).value : undefined,
	);
}
/** @type {ImporterClass} */
let IMPORT_KIND = CatalogConnectors.IMPORTERS[0];

/**
 * What is ticked in a comparison: the incoming books to import (by place), those whose edition goes into the
 * book they find (an edition ticked imports its book), the differences to take (by key), the books of a
 * catalog's plan to put on its Read shelf and reads to add (by place), and whether to keep the ids found there.
 * @typedef {{take: Set<number>, editions: Set<number>, patch: Set<string>, add: Set<number>, reads: Set<number>, ids: boolean}} ComparePicks
 */
/**
 * A comparison open in the preview.
 * @typedef {object} PendingCompare
 * @property {string} source the other source's catalog (its panel's prefix)
 * @property {string} name the other source's name, as the page says it
 * @property {boolean} editionsYours whether its editions are yours (an export of your library's), so they are ticked
 * @property {string[]} notes lines on top: what was read
 * @property {Book[]} incoming
 * @property {MergeOptions} [opts]
 * @property {ComparisonResult} comparison
 * @property {string[]} warnings
 * @property {{sync: ShelfSync, result: ShelfComparison} | null} online the comparison with a catalog's shelves
 * @property {ComparePicks} picks
 */
/** @type {PendingCompare | null} */
let PENDING_COMPARE = null; // until it is applied or closed

/**
 * A comparison to open, with what an import would take ticked; but the edition a catalog has
 * for a book you have is unticked, as it may be one picked there for want of the one you have.
 * @param {Omit<PendingCompare, 'picks'>} compare
 * @returns {PendingCompare}
 */
function pendingCompare(compare) {
	const books = compare.comparison.books;
	const take = new Set(
		books
			.filter(b => b.kind === 'new' || (b.kind === 'gains' && (b.gains.length || b.added.length)))
			.map(b => b.at),
	);
	// an export's editions are yours, and so are those a catalog found by an id of yours (ShelfComparison.yours)
	const yours = new Set((compare.online && compare.online.result.yours) || []);
	const editions = new Set(
		books.filter(b => b.editionGains.length && (compare.editionsYours || yours.has(b.theirs))).map(b => b.at),
	);
	return {...compare, picks: {take, editions, patch: new Set(), add: new Set(), reads: new Set(), ids: true}};
}

/**
 * A paragraph of the preview.
 * @param {string} text
 * @param {string} [className]
 * @returns {HTMLParagraphElement}
 */
const para = (text, className) => buildElement('p', {class: className}, text);

/**
 * A list of messages, at most `limit` of them, saying how many more there are; nothing when there are none.
 * @param {string[]} items
 * @param {number} [limit]
 * @returns {HTMLUListElement | null}
 */
function messageList(items, limit = Infinity) {
	if (!items.length) return null;
	return buildElement(
		'ul',
		{},
		items.slice(0, limit).map(m => buildElement('li', {}, m)),
		items.length > limit && buildElement('li', {}, `…and ${items.length - limit} more`),
	);
}

/** @typedef {'take' | 'editions' | 'patch' | 'add' | 'reads'} PickGroup */

/**
 * How many changes the ticks of a comparison make.
 * @param {PendingCompare} compare
 * @returns {number}
 */
function pickedCount(compare) {
	const {picks} = compare;
	return (
		picks.take.size +
		[...picks.editions].filter(at => !picks.take.has(at)).length +
		picks.patch.size +
		picks.add.size +
		picks.reads.size +
		(picks.ids && idsToSave(compare) ? 1 : 0)
	);
}

/**
 * How many books, series and people gain an id found on a catalog in a comparison with its shelves.
 * @param {PendingCompare} compare
 * @returns {number}
 */
function idsToSave(compare) {
	const {online} = compare;
	return online ? online.result.idsFound.length + online.result.infoIds.length : 0;
}

/**
 * The preview's buttons: the confirm button, labeled `confirm`, and Cancel; only Close when `confirm` is ''.
 * @param {string} confirm
 */
function showPreviewButtons(confirm) {
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
function showPreview(title, body, confirm, panelId) {
	byId('importPreviewTitle').textContent = title;
	fillElement(byId('importPreviewBody'), body);
	showPreviewButtons(confirm);
	if (panelId) openPreview(panelId);
}

/** @returns {string} the comparison's Apply button's label, for the changes ticked; '' for none */
function applyLabel() {
	const n = PENDING_COMPARE ? pickedCount(PENDING_COMPARE) : 0;
	return n ? `Apply ${Text.plural(n, 'change')}` : '';
}

function updateApplyButton() {
	showPreviewButtons(applyLabel());
}

/**
 * A tickbox of the comparison, for the pick `key` of `group`.
 * @param {PickGroup} group
 * @param {number | string} key
 * @param {Child[]} label
 * @returns {HTMLLabelElement}
 */
function pickBox(group, key, label) {
	const compare = /** @type {PendingCompare} */ (PENDING_COMPARE);
	const picked = /** @type {Set<number | string>} */ (compare.picks[group]);
	return buildElement(
		'label',
		{class: 'cmpPick'},
		buildElement('input', {
			type: 'checkbox',
			'data-pick': `${group}:${key}`,
			checked: picked.has(key),
			onchange: (/** @type {Event} */ e) => {
				if (/** @type {HTMLInputElement} */ (e.currentTarget).checked) picked.add(key);
				else picked.delete(key);
				updateApplyButton();
			},
		}),
		' ',
		...label,
	);
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
function compareGroup(heading, rows, group, keys, note) {
	if (!rows.length) return null;
	const tick = (/** @type {boolean} */ on) => () => {
		const compare = /** @type {PendingCompare} */ (PENDING_COMPARE);
		const picked = /** @type {Set<number | string>} */ (compare.picks[/** @type {PickGroup} */ (group)]);
		for (const k of keys)
			if (on) picked.add(k);
			else picked.delete(k);
		drawCompare();
	};
	return buildElement(
		'section',
		{class: 'cmpGroup'},
		buildElement(
			'h4',
			{},
			`${heading} (${rows.length})`,
			group &&
				keys.length > 1 && [
					' ',
					buildElement('button', {type: 'button', class: 'cmpTick', onclick: tick(true)}, 'Tick all'),
					' ',
					buildElement('button', {type: 'button', class: 'cmpTick', onclick: tick(false)}, 'Tick none'),
				],
		),
		note && para(note, 'cmpNote'),
		buildElement(
			'ul',
			{class: 'cmpRows'},
			rows.map(r => buildElement('li', {}, r)),
		),
	);
}

/**
 * One difference, to tick: "Narrators: Ann Vale here, Bo Reed on Goodreads".
 * @param {Difference} d
 * @param {string} name
 * @returns {HTMLLIElement}
 */
function differenceRow(d, name) {
	return buildElement(
		'li',
		{},
		pickBox('patch', d.key, [
			`${d.label}: `,
			buildElement('span', {class: 'cmpHere'}, d.here || 'none'),
			spell(' here, '),
			buildElement('span', {class: 'cmpThere'}, d.there),
			` on ${name}`,
		]),
	);
}

/** Draw the comparison open (PENDING_COMPARE) in the preview. */
function drawCompare() {
	const compare = /** @type {PendingCompare} */ (PENDING_COMPARE);
	const {name, comparison, online} = compare;
	const books = comparison.books;
	const of = (/** @type {ComparedBook['kind']} */ kind) => books.filter(b => b.kind === kind);
	const fresh = of('new'),
		gains = of('gains');
	const differing = books.filter(b => b.differences.length),
		same = of('same').filter(b => !b.differences.length);
	/** @type {Child[]} */
	const out = compare.notes.map(n => para(n));
	out.push(
		para(
			spell(
				`${fresh.length} new, ${gains.length} with more to give, ${differing.length} with values that differ, ${same.length} the same as in this catalog.`,
			),
		),
	);

	// a new book as it would be added, in the series spelling in use
	out.push(
		compareGroup(
			`New from ${name}`,
			fresh.map(b => [
				pickBox('take', b.at, [Comparison.bookLine(b.added[0] || b.theirs)]),
				b.added.length > 1 && messageList(b.added.map(Comparison.bookLine)),
			]),
			'take',
			fresh.map(b => b.at),
		),
	);
	const fromEdition = (/** @type {ComparedBook} */ b) =>
		b.editionGains.length
			? buildElement(
					'ul',
					{},
					buildElement(
						'li',
						{},
						pickBox('editions', b.at, [`the ${name} edition: ${b.editionGains.join('; ')}`]),
					),
				)
			: null;
	out.push(
		compareGroup(
			`${name} has more`,
			gains.map(b =>
				b.gains.length || b.added.length
					? [
							pickBox('take', b.at, [Comparison.bookLine(b.books[0] || b.theirs)]),
							messageList([...b.gains, ...b.added.map(a => `adds ${Comparison.bookLine(a)}`)]),
							fromEdition(b),
						]
					: [buildElement('span', {class: 'cmpBook'}, Comparison.bookLine(b.books[0])), fromEdition(b)],
			),
			'take',
			gains.filter(b => b.gains.length || b.added.length).map(b => b.at),
			spell(
				compare.editionsYours
					? 'Ticked, importing fills in what this catalog lacks, and changes nothing it has.'
					: `Ticked, importing fills in what this catalog lacks, and changes nothing it has. The ${name} edition is left out unless you tick it, as it may have been picked there for want of yours.`,
			),
		),
	);
	out.push(
		compareGroup(
			'Different in both',
			differing.map(b => [
				buildElement('span', {class: 'cmpBook'}, Comparison.bookLine(b.books[0])),
				buildElement(
					'ul',
					{},
					b.differences.map(d => differenceRow(d, name)),
				),
			]),
			'patch',
			differing.flatMap(b => b.differences.map(d => d.key)),
			spell(
				`Tick a value to use the one on ${name} in place of this catalog's.` +
					(compare.editionsYours
						? ''
						: ` An edition's values are those of the edition picked on ${name}, which may not be yours.`),
			),
		),
	);

	if (online) out.push(...shelfSections(compare, online.sync, online.result));
	else if (comparison.onlyHere.length) {
		out.push(
			buildElement(
				'details',
				{class: 'cmpOnlyHere'},
				buildElement('summary', {}, spell(`Only in this catalog: ${comparison.onlyHere.length}`)),
				messageList(comparison.onlyHere.map(Comparison.bookLine), 100),
			),
		);
	}
	const excluded = of('excluded'),
		notAdded = of('notAdded');
	if (excluded.length)
		out.push(
			para(`Skipped (excluded from imports): ${excluded.length}`),
			messageList(
				excluded.map(b => Comparison.bookLine(b.theirs)),
				10,
			),
		);
	if (notAdded.length && online) {
		out.push(
			para(spell(online.sync.kind.notAdded(notAdded.length))),
			messageList(
				notAdded.map(b => Comparison.bookLine(b.theirs)),
				10,
			),
		);
	}
	if (compare.warnings.length)
		out.push(para(`Needs a look (${compare.warnings.length}):`, 'warn'), messageList(compare.warnings));
	const plan = online && online.result.plan;
	if (
		!pickedCount(compare) &&
		!fresh.length &&
		!gains.length &&
		!differing.length &&
		!(plan && (plan.add.length || plan.reads.length))
	) {
		out.push(para(spell('Nothing to take or send: both have the same.')));
	}
	showPreview(spell(`Compare with ${name}`), out, applyLabel());
}

/**
 * The part of a comparison that is about a catalog's shelves: what putting your books there would do, to
 * tick, and the ids found there to keep.
 * @param {PendingCompare} compare
 * @param {ShelfSync} sync
 * @param {ShelfComparison} result
 * @returns {Child[]}
 */
function shelfSections(compare, sync, result) {
	const label = sync.label,
		{plan, idsFound, infoIds} = result;
	/** @type {Child[]} */
	const out = [];
	if (plan) {
		const dates = (/** @type {string[] | undefined} */ d) => (d && d.length ? `: read ${d.join(', ')}` : '');
		out.push(
			compareGroup(
				`Not on your ${label} ${plan.name} shelf`,
				plan.add.map((a, i) =>
					pickBox('add', i, [a.books.map(Comparison.bookLine).join('; '), dates(a.dates)]),
				),
				'add',
				plan.add.map((a, i) => i),
				`Tick a book to put it on your ${plan.name} shelf on ${label}${sync.kind.SENDS_READS ? ', with its dates read' : ''}.`,
			),
		);
		out.push(
			compareGroup(
				`Reads ${label} lacks`,
				plan.reads.map((a, i) =>
					pickBox('reads', i, [a.books.map(Comparison.bookLine).join('; '), dates(a.dates)]),
				),
				'reads',
				plan.reads.map((a, i) => i),
				`Tick a book to add these reads to it on ${label}.`,
			),
		);
	} else if (sync.kind.CLIENT.KEY_STORAGE)
		out.push(
			para(
				`Save your ${label} ${sync.kind.CLIENT.KEY_NAME} (below the buttons) to compare your shelves too, and to put books on them.`,
			),
		);
	if (idsFound.length || infoIds.length) {
		const saving = [
			idsFound.length && Text.plural(idsFound.length, 'book'),
			infoIds.length && Text.plural(infoIds.length, 'series or person', 'series and people'),
		]
			.filter(Boolean)
			.join(', ');
		out.push(
			buildElement(
				'label',
				{class: 'cmpPick cmpIds'},
				buildElement('input', {
					type: 'checkbox',
					'data-pick': 'ids',
					checked: compare.picks.ids,
					onchange: (/** @type {Event} */ e) => {
						compare.picks.ids = /** @type {HTMLInputElement} */ (e.currentTarget).checked;
						updateApplyButton();
					},
				}),
				` Save the ${label} ${sync.kind.FOUND} found for ${saving}`,
			),
		);
	}
	if (plan) {
		out.push(
			compareGroup(
				`On another ${label} shelf, left alone`,
				plan.otherShelf.map(([b, shelf]) => `${Comparison.bookLine(b)}: ${shelf}`),
				null,
				[],
			),
		);
		out.push(
			compareGroup(`Not found on ${label}`, plan.unknown.map(Comparison.bookLine), null, [], sync.kind.NOT_FOUND),
		);
		if (plan.inexact.length)
			out.push(para(`Dates read without a day, which ${label} can't take: ${plan.inexact.length}`));
	}
	out.push(...notAudioSections(result.notAudio, label));
	if (result.missing.length) {
		out.push(
			buildElement(
				'details',
				{class: 'cmpOnlyHere'},
				buildElement(
					'summary',
					{},
					spell(`In the series on ${label}, not in this catalog: ${result.missing.length}`),
				),
				messageList(result.missing, 100),
			),
		);
	}
	return out;
}

/**
 * The books a catalog says may not be audiobooks, which may be data problems: your editions it has as
 * something else, and the books on your shelves there read as something else. Nothing to tick: they are
 * put right in the book's form here, or on the catalog.
 * @param {NotAudio[]} notAudio
 * @param {string} label
 * @returns {Child[]}
 */
function notAudioSections(notAudio, label) {
	/** @type {(n: NotAudio) => Child} */
	const row = n => [
		n.yours && n.book.id
			? buildElement('a', {href: bookPageHref(n.book.id)}, Comparison.bookLine(n.book))
			: Comparison.bookLine(n.book),
		n.yours ? `: ${n.edition} is ${n.said}${n.maybe ? '' : ` on ${label}`}` : `: read as ${n.said} (${n.edition})`,
		n.url && [
			' ',
			buildElement(
				'a',
				{href: n.url, target: '_blank', rel: 'noopener'},
				`${new URL(n.url).hostname.replace(/^www\./, '')} \u2197`,
			),
		],
	];
	return [
		compareGroup(
			'Maybe not audiobooks, in this catalog',
			notAudio.filter(n => n.yours).map(row),
			null,
			[],
			spell(
				`${label} has these editions of yours as something else: give the book its audiobook edition in its form.`,
			),
		),
		compareGroup(
			`Maybe not audiobooks, on your ${label} shelves`,
			notAudio.filter(n => !n.yours).map(row),
			null,
			[],
			spell(`You read these on ${label} as something else: pick the audiobook edition there.`),
		),
	];
}

/**
 * Open a comparison in the preview, under the panel of its source.
 * @param {Omit<PendingCompare, 'picks'>} compare
 */
function openCompare(compare) {
	closeImportPreview();
	PENDING_COMPARE = pendingCompare(compare);
	drawCompare();
	openPreview(`${compare.source}Panel`);
}

/**
 * Show the books of an export file beside this catalog's.
 * @param {ImporterClass} Importer
 * @param {string} text the export's text
 * @param {string} fileName
 */
function compareExport(Importer, text, fileName) {
	const importer = importerOf(Importer);
	const result = importer.read(text);
	const notes = [`${Text.plural(result.books.length, 'finished book')} read from ${fileName}`];
	if (result.skippedUnfinished) notes.push(`Not finished yet, skipped: ${result.skippedUnfinished}`);
	openCompare({
		source: Importer.CATALOG,
		name: importer.label,
		editionsYours: Importer.EDITIONS_YOURS,
		notes,
		incoming: result.books,
		comparison: Comparison.compare(CATALOG, result.books),
		warnings: result.warnings,
		online: null,
	});
}

/**
 * The catalog with what is ticked in `compare` taken in, in a copy, with what blocks it.
 * @param {PendingCompare} compare
 */
function applyIntoCopy(compare) {
	const copy = CATALOG.clone();
	const {take, editions} = compare.picks;
	const {report, patched} = Comparison.apply(
		copy,
		compare.incoming,
		{...compare.picks, take: new Set([...take, ...editions])},
		compare.opts,
	);
	const {online, picks} = compare;
	const idsFound = picks.ids && online ? online.sync.kind.addIds(copy.books, online.result.found).length : 0;
	const infoIds = picks.ids && online ? online.sync.kind.setInfoIds(copy, online.result.infoIds) : 0;
	const errors = copy.bookErrors();
	return {copy, report, patched, idsFound, infoIds, errors};
}

/**
 * What applying a comparison did here, as the status line says it: "Added 2 books, filled in 1 ASIN, changed 1 value".
 * @param {MergeReport} report
 * @param {number} patched
 * @param {number} [idsFound] books that got an id (or a cover) found for them on the catalog compared
 * @param {string} [found] where, and what was found ("AudiobookDB ids and covers")
 * @param {number} [infoIds] series and people that got an id found there
 * @returns {string}
 */
function appliedText(report, patched, idsFound = 0, found = '', infoIds = 0) {
	/** @type {[Book[], (n: number) => string][]} */
	const filled = [
		[report.backfilled, n => `filled in ${Text.plural(n, 'ASIN')}`],
		[report.goodreadsFilled, n => `filled in ${Text.plural(n, 'Goodreads id')}`],
		[report.hardcoverFilled, n => `filled in Hardcover ids on ${Text.plural(n, 'book')}`],
		[report.datesFilled, n => `filled in dates read on ${Text.plural(n, 'book')}`],
		[report.isbnsFilled, n => `added ISBNs to ${Text.plural(n, 'book')}`],
		[report.editionsAdded, n => `added editions to ${Text.plural(n, 'book')}`],
		[report.detailsFilled, n => `filled in edition details on ${Text.plural(n, 'book')}`],
	];
	return [
		`Added ${Text.plural(report.added.length, 'book')}`,
		...filled.filter(([list]) => list.length).map(([list, say]) => say(list.length)),
		(idsFound || infoIds) &&
			`saved ${found} found for ` +
				[
					idsFound && Text.plural(idsFound, 'book'),
					infoIds && Text.plural(infoIds, 'series or person', 'series and people'),
				]
					.filter(Boolean)
					.join(' and '),
		patched && `changed ${Text.plural(patched, 'value')}`,
	]
		.filter(Boolean)
		.join(', ');
}

function applyCompare() {
	const compare = PENDING_COMPARE;
	if (!compare) return;
	if (compare.online) return applyShelfSync(compare);
	closeImportPreview();
	// applied to the catalog as it is now, in case books were edited while the comparison was open
	const {copy, report, patched, errors} = applyIntoCopy(compare);
	if (errors.length) {
		showIoStatus(spell('The catalog changed and the import no longer validates; nothing was changed.'), true);
		return;
	}
	CATALOG.books = copy.books;
	refreshPage();
	persist();
	showIoStatus(appliedText(report, patched) + '.');
}

// ------------------------------------------------------------ Merge a backup from another device
// Restore replaces the catalog; Merge is for two catalogs that have both changed since they were
// last the same (the phone and the PC, say), so neither side's edits are lost (Backup.mergeInto).
// Like a CSV import it is previewed first, and only applied when confirmed.
/** @type {{backup: Backup, fileName: string} | null} */
let PENDING_MERGE = null; // {backup, fileName} while its preview is open

/**
 * The catalog merged with a backup, in copies, with what blocks it and how many changes it makes.
 * @param {Backup} backup
 */
function mergeIntoCatalog(backup) {
	// the select's options are 'mine' and 'backup'
	const prefer = /** @type {'mine' | 'backup'} */ (fieldById('mergePreferSelect').value);
	const m = backup.mergeInto(CATALOG, prefer);
	const merged = new Catalog({
		books: m.books,
		series: m.series,
		authors: m.authors,
		narrators: m.narrators,
		publishers: m.publishers,
	});
	const errors = merged.validate({contributors: true}).errors;
	const changes = [
		m.added,
		m.updated,
		m.removed,
		m.infoAdded,
		m.infoChanged,
		m.authorsAdded,
		m.authorsChanged,
		m.narratorsAdded,
		m.narratorsChanged,
		m.publishersAdded,
		m.publishersChanged,
		m.excluded,
		m.notDuplicates,
		m.renamed,
	].reduce((n, list) => n + list.length, 0);
	return {m, errors, changes};
}

function previewMerge() {
	if (!PENDING_MERGE) return;
	const {backup, fileName} = PENDING_MERGE;
	const {m, errors, changes} = mergeIntoCatalog(backup);
	const list = (/** @type {Book[]} */ books) => messageList(books.map(Comparison.bookLine));
	/** @type {Child[]} */
	const out = [para(`${backup.books.length} books in ${fileName}; ${m.books.length} after merging.`)];
	out.push(para(`New from the backup: ${m.added.length}`), list(m.added));
	out.push(
		para(
			`Gaining genres, dates read or editions${m.conflicts.length ? ', or the version kept below' : ''}: ${m.updated.length}`,
		),
	);
	out.push(para(`Removed (removed on the other device): ${m.removed.length}`), list(m.removed));
	if (m.skipped.length) out.push(para(`Not added back (removed here): ${m.skipped.length}`));
	if (m.conflicts.length) {
		const kept = fieldById('mergePreferSelect').value === 'backup' ? "the backup's" : spell("this catalog's");
		out.push(
			para(`Title, author or series differ, keeping ${kept}: ${m.conflicts.length}`),
			messageList(
				m.conflicts.map(c => `${Comparison.bookLine(c.mine)} / backup: ${Comparison.bookLine(c.theirs)}`),
			),
		);
	}
	const infoDiffer = m.infoChanged.length + m.infoKept.length;
	if (m.infoAdded.length || infoDiffer) {
		out.push(
			para(
				`Series' totals, status, notes and links: ${m.infoAdded.length} added` +
					(infoDiffer
						? `, ${infoDiffer} differing (keeping ${m.infoChanged.length ? "the backup's" : spell("this catalog's")})`
						: ''),
			),
		);
	}
	for (const [label, added, changed, kept] of /** @type {[string, string[], string[], string[]][]} */ ([
		["Authors' bios and links", m.authorsAdded, m.authorsChanged, m.authorsKept],
		["Narrators' bios and links", m.narratorsAdded, m.narratorsChanged, m.narratorsKept],
		["Publishers' bios and links", m.publishersAdded, m.publishersChanged, m.publishersKept],
	])) {
		const differ = changed.length + kept.length;
		if (added.length || differ) {
			out.push(
				para(
					`${label}: ${added.length} added` +
						(differ
							? `, ${differ} differing (keeping ${changed.length ? "the backup's" : spell("this catalog's")})`
							: ''),
				),
			);
		}
	}
	if (m.renamed.length) {
		out.push(
			para(`Renamed as in the backup: ${m.renamed.length}`),
			messageList(m.renamed.map(r => `${r.from} \u2192 ${r.to}`)),
		);
	}
	if (m.excluded.length) out.push(para(`More books excluded from imports: ${m.excluded.length}`));
	if (m.notDuplicates.length) out.push(para(`More books marked "Not duplicates": ${m.notDuplicates.length}`));
	if (errors.length) {
		out.push(para('Validation failed, nothing will be changed:', 'warn'), messageList(errors.slice(0, 10)));
	} else if (!changes) {
		out.push(para(spell('Nothing to merge: this catalog already has everything in the backup.')));
	}
	byId('mergePrefer').classList.add('show');
	showPreview('Merge a backup', out, !errors.length && changes ? 'Merge' : '', 'backupPanel');
}

function applyMerge() {
	if (!PENDING_MERGE) return;
	// merged again, in case books were edited while the preview was open
	const {m, errors, changes} = mergeIntoCatalog(PENDING_MERGE.backup);
	closeImportPreview();
	if (errors.length || !changes) {
		showIoStatus(spell('The catalog changed and the merge no longer applies; nothing was changed.'), true);
		return;
	}
	// a series or person renamed keeps their id (the merged books have the new name already)
	for (const {kind, from, to} of m.renamed) CATALOG.renameEntry(kind, from, to);
	CATALOG.books = m.books;
	for (const kind of /** @type {const} */ (['series', 'authors', 'narrators', 'publishers']))
		CATALOG.replaceInfo(kind, m[kind]);
	CATALOG.addExclusions(m.excluded);
	CATALOG.addMarkTexts(m.notDuplicates);
	refreshPage();
	persist();
	showIoStatus(`Merged: ${m.added.length} added, ${m.updated.length} updated, ${m.removed.length} removed.`);
}

/**
 * Read a backup to merge, and preview the merge.
 * @param {File} file
 */
async function mergeBackupFile(file) {
	if (!(await holdWholeCatalog())) return;
	try {
		const [{text}] = await readFiles([file]);
		const backup = Backup.read(JSON.parse(text));
		if (backup.books.some(b => !b.title || !b.authors.length)) throw new Error('missing title/author');
		PENDING_COMPARE = null;
		PENDING_MERGE = {backup, fileName: file.name};
		PENDING_TIDY = null;
		previewMerge();
	} catch (exc) {
		closeImportPreview();
		showIoStatus(
			exc instanceof NewerBackup
				? 'Not merged: a newer version of the catalog made that backup. Reload the page to update it, then try again.'
				: exc instanceof UnreadableBackup
					? `Not merged: ${exc.message}.`
					: spell("Couldn't read that file \u2014 make sure it's a catalog backup JSON."),
			true,
		);
	}
}

// ------------------------------------------------------------ Check the catalog, box sets
// The check lists errors and warnings; box sets are previewed like an import and only applied when confirmed.
/** @type {'box-sets' | null} */
let PENDING_TIDY = null; // 'box-sets', while its preview is open

/**
 * Show the check or the box sets in the preview; its confirm button (labeled `confirm`) shows when PENDING_TIDY is set.
 * @param {string} title
 * @param {Child[]} body
 * @param {string} confirm
 */
function showTidyPreview(title, body, confirm) {
	PENDING_COMPARE = null;
	PENDING_MERGE = null;
	byId('mergePrefer').classList.remove('show');
	showPreview(title, body, PENDING_TIDY ? confirm : '', 'checkPanel');
}

function checkCatalog() {
	const {errors, warnings} = CATALOG.validate({contributors: true});
	const people = [
		Text.plural(CATALOG.nameIds.authors.size, 'author'),
		Text.plural(CATALOG.nameIds.narrators.size, 'narrator'),
		Text.plural(CATALOG.nameIds.publishers.size, 'publisher'),
	];
	const described = CATALOG.authors.size + CATALOG.narrators.size + CATALOG.publishers.size;
	/** @type {Child[]} */
	const out = [
		para(
			`${CATALOG.books.length} books; ${CATALOG.nameIds.series.size} series, ${CATALOG.series.size} with a released total; ` +
				`${people.join(', ')}, ${described} with a bio or links.`,
		),
	];
	if (errors.length) out.push(para(`Errors (${errors.length}):`, 'warn'), messageList(errors, 100));
	if (warnings.length) out.push(para(`Needs a look (${warnings.length}):`, 'warn'), messageList(warnings, 100));
	if (!errors.length && !warnings.length) out.push(para('No problems found.'));
	PENDING_TIDY = null;
	showTidyPreview(spell('Check the catalog'), out, '');
}

// Keep each box set as its own book and as its titles, in a copy of the catalog (Catalog.addBoxSets).
function boxSetsIntoCopy() {
	const copy = CATALOG.clone();
	const report = copy.addBoxSets();
	const errors = copy.bookErrors();
	return {copy, report, errors};
}

function previewBoxSets() {
	const {report, errors} = boxSetsIntoCopy();
	/** @type {Child[]} */
	const out = [
		para(`Box sets: ${report.boxSets.length}`),
		messageList(
			report.boxSets.map(
				b => `${b.title} \u2014 ${Text.namesText(b.authors)}: ${Text.plural(b.titles, 'title')} already here`,
			),
		),
	];
	if (report.excluded.length) out.push(para(`Skipped (excluded from imports): ${report.excluded.length}`));
	out.push(para(`New: ${report.added.length}`), messageList(report.added.map(Comparison.bookLine)));
	if (report.boxSets.some(b => b.added)) {
		out.push(
			para(
				spell(
					'A title not in the catalog yet is named \u201CSeries, Book N\u201D until you rename it on its card.',
				),
			),
		);
	}
	if (errors.length) {
		out.push(para('Validation failed, nothing will be changed:', 'warn'), messageList(errors, 10));
	} else if (!report.added.length) {
		out.push(para('Every box set is already kept both as its own book and as its titles.'));
	}
	PENDING_TIDY = errors.length || !report.added.length ? null : 'box-sets';
	showTidyPreview('Box sets', out, `Add ${Text.plural(report.added.length, 'book')}`);
}

function applyTidy() {
	closeImportPreview();
	// applied again, in case books were edited while the preview was open
	const {copy, report, errors} = boxSetsIntoCopy();
	if (errors.length) {
		showIoStatus(spell('The catalog changed and the box sets no longer validate; nothing was changed.'), true);
		return;
	}
	CATALOG.books = copy.books;
	refreshPage();
	persist();
	const added = report.added.length;
	showIoStatus(`Added ${Text.plural(added, 'book')} for box sets.`);
}

// ------------------------------------------------------------ the catalogs' shelves, and your keys for them
// Each catalog in CatalogConnectors.SYNCS has a panel (its prefix is its client's CATALOG), with its Compare
// button and, for a catalog that takes one, your key for it (Hardcover's token, AudiobookDB's API key), kept in
// this browser only (never in a backup). Comparing only reads the catalog; applying saves the catalog first, then sends what was ticked,
// and that stops if you leave the page, so the browser asks first.
/** @type {CatalogJob | null} */
let PAGE_RUN = null; // a run going on in this page (showCatalogJob)

/**
 * Say in its panel whether your key for `Client`'s catalog is saved.
 * @param {ClientClass} Client
 */
function showKey(Client) {
	const saved = Boolean(savedKey(Client)),
		prefix = Client.CATALOG;
	byId(`${prefix}KeyState`).textContent = saved
		? `Your ${Client.LABEL} ${Client.KEY_NAME} is saved in this browser only (never in a backup).`
		: Client.KEY_HELP;
	byId(`${prefix}KeyRemove`).style.display = saved ? '' : 'none';
}

/**
 * Save the key pasted in `Client`'s panel in this browser, or `remove` the saved one.
 * @param {ClientClass} Client
 * @param {boolean} remove
 */
function saveKeyOf(Client, remove) {
	const input = fieldById(`${Client.CATALOG}Key`),
		name = `${Client.LABEL} ${Client.KEY_NAME}`;
	if (!remove && !Client.cleanKey(input.value)) {
		showIoStatus(`Paste your ${name} first.`, true);
		return;
	}
	try {
		saveKey(Client, remove ? '' : input.value);
		input.value = '';
		showIoStatus(remove ? `${name} removed.` : `${name} saved.`);
	} catch {
		showIoStatus(
			`Couldn't ${remove ? 'remove' : 'save'} the ${Client.KEY_NAME}: this browser refused to store it.`,
			true,
		);
	}
	showKey(Client);
}

// ------------------------------------------------------------ the catalog proxy
// Its address and key are kept in this browser only (never in a backup), like your keys for the catalogs.
function showProxy() {
	const proxy = browserProxy();
	byId('proxyState').textContent = proxy
		? `Saved in this browser only (never in a backup): ${proxy.url}`
		: "Paste your proxy's address and key and save them; they are kept in this browser only (never in a backup).";
	byId('proxyCheck').style.display = proxy ? '' : 'none';
	byId('proxyRemove').style.display = proxy ? '' : 'none';
}

/**
 * Save the proxy typed in the page in this browser and check it, or `remove` the saved one.
 * @param {boolean} remove
 */
async function saveProxy(remove) {
	const url = fieldById('proxyUrl'),
		key = fieldById('proxyKey');
	const address = proxyAddress(url.value);
	if (!remove) {
		if (!address) {
			showIoStatus("Paste the proxy's address first (https://…workers.dev).", true);
			return;
		}
		if (!key.value.trim()) {
			showIoStatus("Paste the proxy's key first.", true);
			return;
		}
	}
	try {
		if (remove) localStorage.removeItem(PROXY_STORAGE_KEY);
		else localStorage.setItem(PROXY_STORAGE_KEY, JSON.stringify({url: address, key: key.value.trim()}));
		url.value = '';
		key.value = '';
	} catch {
		showIoStatus(`Couldn't ${remove ? 'remove' : 'save'} the proxy: this browser refused to store it.`, true);
		return;
	}
	showProxy();
	if (remove) showIoStatus('Catalog proxy removed.');
	else await checkProxy('Catalog proxy saved');
}

/**
 * Ask the saved proxy whether it answers this page with its key, and say so.
 * @param {string} [saved] what the status line starts with, after a save
 */
async function checkProxy(saved) {
	const start = saved ? `${saved}; ` : '';
	try {
		const res = await fetchViaProxy('ping');
		if (res.ok) {
			const names = /** @type {{catalogs?: string[]}} */ (await res.json()).catalogs || [];
			showIoStatus(`${start}${saved ? 'it' : 'The catalog proxy'} answers, for ${names.join(', ')}.`);
		} else if (res.status === 401) showIoStatus(`${start}the proxy refused the key.`, true);
		else showIoStatus(`${start}the proxy answered ${res.status}.`, true);
	} catch (e) {
		showIoStatus(`${start}${Text.errorText(e)}.`, true);
	}
}

/**
 * Run `task` with a catalog's shelves (`catalog`, its name), shown in the banner on top while it goes (as a `mode`
 * job), handing it the step it reports its progress through. Resolves to what it gave or threw and how long it
 * took; to undefined when another run is going on.
 * @template T
 * @param {string} catalog
 * @param {CatalogMode} mode
 * @param {(step: Step) => Promise<T>} task
 * @returns {Promise<{value?: T, error?: unknown, elapsed: number} | undefined>}
 */
async function withCatalogJob(catalog, mode, task) {
	if (PAGE_RUN) return undefined;
	const started = Date.now();
	/** @type {CatalogJob} */
	const job = (PAGE_RUN = {catalog, mode, dryRun: mode === 'compare', running: true, elapsed: 0, step: 'Starting'});
	const show = () => {
		job.elapsed = Date.now() - started;
		showCatalogJob(job);
	};
	const ticker = setInterval(show, 1000);
	show();
	/** @type {{value?: T, error?: unknown, elapsed: number}} */
	const result = {elapsed: 0};
	try {
		result.value = await task((text, done, total) => {
			Object.assign(job, {step: text, done, total});
			show();
		});
	} catch (e) {
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
 * The part of the catalog to compare with a catalog's shelves, as picked beside its panel's button: null for every book.
 * @param {string} online the panel's prefix
 * @returns {{kind: 'series' | 'author', name: string, label: string} | null}
 */
function scopeOf(online) {
	const kind = fieldById(`${online}Scope`).value;
	if (kind !== 'series' && kind !== 'author') return null;
	const name = Text.tidy(fieldById(`${online}ScopeName`).value);
	return {kind, name, label: kind === 'series' ? `the series \u201C${name}\u201D` : `books by ${name}`};
}

/**
 * The name field shows for a series or an author, and offers the names in the catalog.
 * @param {string} online the panel's prefix
 */
function showScope(online) {
	const kind = fieldById(`${online}Scope`).value;
	const input = /** @type {HTMLInputElement} */ (byId(`${online}ScopeName`));
	input.style.display = kind ? '' : 'none';
	input.placeholder = kind === 'series' ? 'Series' : 'Author';
	if (!kind) return;
	withWholeCatalog(() => {
		const names = [...CATALOG.namesOf(kind === 'series' ? 'series' : 'authors')].sort((x, y) => x.localeCompare(y));
		fillElement(
			byId(`${online}ScopeNames`),
			names.map(name => buildElement('option', {value: name})),
		);
	});
}

/**
 * A Compare button on a series' or an author's page opens this page to compare their books with a catalog
 * (takeShelfCompare; older links name it in the address, #hardcover-series=<id>, #audiobookdb-author=<id>):
 * pick them beside that Compare button, and compare.
 */
async function compareFromAddress() {
	const handed = takeShelfCompare();
	/** @type {(Sync: SyncClass) => {kind: 'series' | 'author', id: string | null} | null} */
	const asked = Sync => {
		const online = Sync.CLIENT.CATALOG;
		if (handed) return handed.catalog === online ? {kind: handed.kind, id: handed.id} : null;
		if (!location.hash.startsWith(`#${online}-`)) return null;
		for (const kind of /** @type {const} */ (['series', 'author'])) {
			const value = valueFromPageHash(location.hash, `${online}-${kind}`);
			if (value !== null) return {kind, id: value};
		}
		return null;
	};
	const Sync = CatalogConnectors.SYNCS.find(asked);
	const request = Sync && asked(Sync);
	if (!Sync || !request || !(await holdWholeCatalog())) return; // the names are the catalog's
	const online = Sync.CLIENT.CATALOG,
		key = request.kind === 'series' ? 'series' : 'authors';
	const id = idFromAddress(key, request.id);
	const name = id === null ? undefined : CATALOG.nameOf(key, id);
	if (name === undefined) return;
	fieldById(`${online}Scope`).value = request.kind;
	fieldById(`${online}ScopeName`).value = name;
	showScope(online);
	byId(`${online}Panel`).scrollIntoView({block: 'start'});
	await compareShelfSync(Sync);
}

/**
 * Show your shelves on `Sync`'s catalog beside this catalog, or beside a series' or an author's books. Only
 * reads that catalog.
 * @param {SyncClass} Sync
 */
async function compareShelfSync(Sync) {
	if (PAGE_RUN) return;
	const Client = Sync.CLIENT,
		label = Client.LABEL,
		prefix = Client.CATALOG;
	const key = savedKey(Client);
	if (Client.VIA_PROXY && !browserProxy()) {
		showIoStatus(`${label} is asked through your catalog proxy: save one first (below).`, true);
		return;
	}
	if (Client.KEY_NEEDED && !key) {
		showIoStatus(`Save your ${label} ${Client.KEY_NAME} first (below the buttons).`, true);
		return;
	}
	const scope = scopeOf(prefix);
	if (scope && !scope.name) {
		showIoStatus(`Type the ${scope.kind === 'series' ? 'series' : 'author'} to compare first.`, true);
		return;
	}
	if (!(await holdWholeCatalog())) return;
	if (scope && !Sync.inScope(CATALOG, scope).length) {
		showIoStatus(
			spell(
				`No book in this catalog is ${scope.kind === 'series' ? 'in' : 'by'} ${scope.kind === 'series' ? scope.label : scope.name}.`,
			),
			true,
		);
		return;
	}
	closeImportPreview();
	await whenSaved(); // compared with the catalog as saved
	const sync = new /** @type {new (client: unknown) => ShelfSync} */ (Sync)(catalogClient(Client, key));
	const run = await withCatalogJob(label, 'compare', step =>
		sync.compare(CATALOG, step, scope ? Sync.part(CATALOG, scope.kind, scope.name) : undefined),
	);
	if (!run) return;
	const result = run.value;
	if (!result) {
		showPreview(
			spell(`Compare with ${label}`),
			[para(`Couldn't compare: ${Text.errorText(run.error)}`, 'warn')],
			'',
			`${prefix}Panel`,
		);
		return;
	}
	const notes = [spell(`${sync.summary(result, CATALOG, scope)} (took ${minutes(run.elapsed)})`)];
	openCompare({
		source: prefix,
		name: label,
		editionsYours: false,
		notes,
		incoming: result.incoming,
		opts: result.opts,
		comparison: result.comparison,
		warnings: result.warnings,
		online: {sync, result},
	});
}

/**
 * Take in what is ticked of a comparison with a catalog's shelves, save it, and then send what is ticked there.
 * @param {PendingCompare} compare
 */
async function applyShelfSync(compare) {
	const {sync, result} = /** @type {NonNullable<PendingCompare['online']>} */ (compare.online);
	const Client = sync.kind.CLIENT,
		label = sync.label;
	const key = savedKey(Client);
	const {picks} = compare;
	/** @type {SyncPlan | null} */
	const plan = result.plan && {
		...result.plan,
		add: result.plan.add.filter((a, i) => picks.add.has(i)),
		reads: result.plan.reads.filter((a, i) => picks.reads.has(i)),
		otherShelf: [],
		unknown: [],
		inexact: [],
	};
	const sending = Boolean(plan && (plan.add.length || plan.reads.length));
	if (PAGE_RUN) return;
	if (sending && !key) {
		showIoStatus(`Save your ${label} ${Client.KEY_NAME} first (below the buttons).`, true);
		return;
	}
	closeImportPreview();
	await whenSaved();
	if ((await storedRevision()) !== SEEN_REVISION) {
		showIoStatus(
			spell(
				`The catalog was edited in another tab since you compared; nothing was changed, nothing sent to ${label}. Compare again.`,
			),
			true,
		);
		return;
	}
	const {copy, report, patched, idsFound, infoIds, errors} = applyIntoCopy(compare);
	if (errors.length) {
		showIoStatus(
			spell(
				`The catalog changed and the import no longer validates; nothing was changed, nothing sent to ${label}.`,
			),
			true,
		);
		return;
	}
	const here = appliedText(report, patched, idsFound, `${label} ${sync.kind.FOUND}`, infoIds);
	if (JSON.stringify(copy.books) !== JSON.stringify(CATALOG.books) || infoIds) {
		CATALOG.books = copy.books;
		if (picks.ids) sync.kind.setInfoIds(CATALOG, result.infoIds);
		await persist(); // kept before anything is sent, so the ids found stay even if the catalog stops answering
		refreshPage();
	}
	if (!plan || !sending) {
		showIoStatus(here + '.');
		return;
	}
	/** @type {string[]} */
	const lines = [];
	const say = (/** @type {string} */ line) => {
		lines.push(line);
	};
	const run = await withCatalogJob(label, 'send', step => sync.push(plan, say, say, step));
	if (!run) return;
	if (run.error) lines.push(`error: ${Text.errorText(run.error)}`);
	const ok = !run.error && run.value === 0;
	showPreview(
		`${label} updated (took ${minutes(run.elapsed)})`,
		[para(here + ' here.'), buildElement('pre', {}, lines.join('\n'))],
		'',
		`${Client.CATALOG}Panel`,
	);
	showIoStatus(ok ? `${here}; ${label} updated.` : `Not everything went through on ${label}; see the details.`, !ok);
}

// Leaving the page stops sending to a catalog's shelves: the browser asks first. (Nothing is lost by stopping
// early: compare and apply again to carry on, as nothing already there is added twice.)
addEventListener('beforeunload', e => {
	if (PAGE_RUN && !PAGE_RUN.dryRun) {
		e.preventDefault();
		e.returnValue = '';
	}
});

/**
 * Each update of a run (showCatalogJob in store.js): no second run while one goes.
 * @param {CatalogJob | null} job
 */
function onCatalogJob(job) {
	for (const Sync of CatalogConnectors.SYNCS)
		/** @type {HTMLButtonElement} */ (byId(`${Sync.CLIENT.CATALOG}CompareBtn`)).disabled = Boolean(
			job && job.running,
		);
}

/**
 * Open the preview right under the panel whose button asked for it, so it is next to what it is about.
 * @param {string} panelId
 */
function openPreview(panelId) {
	const preview = byId('importPreview');
	byId(panelId).after(preview);
	preview.classList.add('open');
	preview.scrollIntoView({block: 'nearest'});
}

function closeImportPreview() {
	PENDING_COMPARE = null;
	PENDING_MERGE = null;
	PENDING_TIDY = null;
	byId('mergePrefer').classList.remove('show');
	byId('importPreview').classList.remove('open');
}

/**
 * Read an export file, and preview its import.
 * @param {ImporterClass} Importer
 * @param {File} file
 */
async function importCsv(Importer, file) {
	if (!(await holdWholeCatalog())) return;
	try {
		const [{text}] = await readFiles([file]);
		compareExport(Importer, text, file.name);
	} catch {
		closeImportPreview();
		showIoStatus(`Couldn't read that file as a ${Importer.LABEL} export.`, true);
	}
}

for (const Importer of CatalogConnectors.IMPORTERS) {
	byId(`${Importer.CATALOG}ImportBtn`).addEventListener('click', () => {
		IMPORT_KIND = Importer;
		byId('importCsvFile').click();
	});
}
for (const Exporter of CatalogConnectors.EXPORTERS) {
	byId(`${Exporter.CATALOG}ExportBtn`).addEventListener('click', () =>
		withWholeCatalog(() => exportFile(new /** @type {new () => FileExporter} */ (Exporter)())),
	);
}
for (const Sync of CatalogConnectors.SYNCS) {
	const Client = Sync.CLIENT,
		prefix = Client.CATALOG;
	byId(`${prefix}CompareBtn`).addEventListener('click', () => compareShelfSync(Sync));
	byId(`${prefix}Scope`).addEventListener('change', () => showScope(prefix));
	if (!Client.KEY_STORAGE) continue; // asked without a key (Audible)
	byId(`${prefix}KeySave`).addEventListener('click', () => saveKeyOf(Client, false));
	byId(`${prefix}KeyRemove`).addEventListener('click', () => saveKeyOf(Client, true));
}
/**
 * When files are picked in the file field `id`, hand them to `take`, and empty the field, so the same file
 * can be picked again.
 * @param {string} id
 * @param {(files: File[]) => Promise<void>} take
 */
function onFilesPicked(id, take) {
	byId(id).addEventListener('change', e => {
		const input = /** @type {HTMLInputElement} */ (e.target);
		const files = [...(input.files || [])];
		input.value = '';
		if (files.length) return take(files);
	});
}
onFilesPicked('importCsvFile', files => importCsv(IMPORT_KIND, files[0]));
byId('importConfirm').addEventListener('click', () =>
	PENDING_TIDY ? applyTidy() : PENDING_MERGE ? applyMerge() : applyCompare(),
);
byId('proxySave').addEventListener('click', () => saveProxy(false));
byId('proxyCheck').addEventListener('click', () => checkProxy());
byId('proxyRemove').addEventListener('click', () => saveProxy(true));
byId('importCancel').addEventListener('click', closeImportPreview);

byId('checkBtn').addEventListener('click', () => withWholeCatalog(checkCatalog));
byId('boxSetsBtn').addEventListener('click', () => withWholeCatalog(previewBoxSets));
byId('exportBtn').addEventListener('click', () => withWholeCatalog(exportBackup));
byId('importBtn').addEventListener('click', () => byId('importFile').click());
byId('mergeBtn').addEventListener('click', () => byId('mergeFile').click());
onFilesPicked('mergeFile', files => mergeBackupFile(files[0]));
byId('mergePreferSelect').addEventListener('change', () => {
	if (PENDING_MERGE) previewMerge();
});
onFilesPicked('importFile', importBackup);

export const READY = startPage(
	() => {
		refreshPage();
		for (const Client of CatalogConnectors.CLIENTS) showKey(Client);
		for (const Sync of CatalogConnectors.SYNCS) showScope(Sync.CLIENT.CATALOG);
		showProxy();
		compareFromAddress();
	},
	{refresh: refreshPage, onCatalogJob},
);
