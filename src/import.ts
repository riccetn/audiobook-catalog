// The import and export page: comparing the catalog with export files (Audible's, Goodreads') and with catalogs'
// shelves (Hardcover's, AudiobookDB's), to take books and values from them (and send books and reads to those
// shelves), files for other catalogs' imports, and backups. It knows the external catalogs only through
// CatalogConnectors and their base classes (FileImporter, FileExporter, ShelfSync, CatalogClient), and each
// catalog's panel by its prefix (its CATALOG). It shows only how many books there are until an action needs
// every book (an import, Check, Box sets, a comparison, Export, Restore or Merge), and then holds the whole
// catalog. Loading and saving live in store.ts.
import {Text} from './modules/text.js';
import {Catalog} from './modules/catalog.js';
import type {NameIds} from './modules/catalog.js';
import {Backup, NewerBackup, UnreadableBackup} from './modules/backup.js';
import {CatalogRecords} from './modules/catalog-records.js';
import {CatalogConnectors} from './modules/catalog-connectors.js';
import {Comparison} from './modules/comparison.js';
import {WrongPassphrase, UnrelatedCatalogs} from './modules/catalog-sync.js';
import {DeviceSetup} from './modules/device-setup.js';
import {Merger} from './modules/merger.js';
import {Validator} from './modules/validator.js';
import {
	CATALOG,
	SEEN_REVISION,
	storedRevision,
	whenSaved,
	persist,
	minutes,
	showCatalogJob,
	SYNC_STORAGE_KEY,
	savedPassphrase,
	lastSync,
	syncCatalog,
	startPage,
	afterSaving,
	queryCatalog,
	wholeCatalog,
	noteBackup,
	backupAge,
	backupAgeText,
	bookPageHref,
} from './store.js';
import {
	showIoStatus,
	byId,
	fieldById,
	spell,
	spellParts,
	plural,
	firstThree,
	buildElement,
	fillElement,
} from './dom.js';
import {
	SERVER_STORAGE_KEY,
	savedServer,
	serverAddress,
	fetchFromServer,
	savedKey,
	saveKey,
	catalogClient,
} from './connections.js';
import type {Child} from './dom.js';
import type {Book} from './modules/book.js';
import type {FileImporter} from './modules/file-importer.js';
import type {FileExporter} from './modules/file-exporter.js';
import type {ShelfSync, ShelfComparison, SyncPlan, NotAudio} from './modules/shelf-sync.js';
import type {ClientClass} from './modules/catalog-client.js';
import type {DeviceSettings} from './modules/device-setup.js';
import type {CatalogJob} from './store.js';
import type {MergeOptions, MergeReport} from './modules/merger.js';
import type {ComparisonResult, ComparedBook, Difference, SeriesRename} from './modules/comparison.js';
import type {Step} from './modules/catalog-client.js';
import type {SyncPrefer} from './modules/catalog-sync.js';

export type CatalogMode = CatalogJob['mode'];
export type ImporterClass = typeof FileImporter;
export type SyncClass = typeof ShelfSync;

function refreshPage() {
	return afterSaving(async () => {
		const count = await queryCatalog(r => r.count('books'));
		byId('subtitle').textContent = spell('{count} audiobooks in the catalog', {count});
		byId('backupState').textContent = backupAgeText(await backupAge());
	});
}

/**
 * Hold the whole catalog, which the page keeps from then on; false, said on the status line, when it can't be read.
 */
async function holdWholeCatalog(): Promise<boolean> {
	try {
		await wholeCatalog();
		return true;
	} catch (e) {
		showIoStatus(
			spell("Couldn't read the catalog kept in this browser: {error}. Reload the page.", {
				error: spell(Text.errorText(e)),
			}),
			true,
		);
		return false;
	}
}

/**
 * Run `task` once the page holds the whole catalog (holdWholeCatalog); not when it can't be read.
 */
async function withWholeCatalog(task: () => void): Promise<void> {
	if (await holdWholeCatalog()) task();
}

// ------------------------------------------------------------------ the exclusions list
/** The exclusions list, each entry with a Remove button that lets imports add it again. */
export function showExclusions() {
	const entries = CATALOG.exclusions.entries;
	fillElement(
		byId('exclusionsList'),
		entries.length
			? buildElement(
					'ul',
					{class: 'exclusionsList'},
					...entries.map(entry =>
						buildElement(
							'li',
							{},
							buildElement('span', {}, entry),
							' ',
							buildElement(
								'button',
								{
									type: 'button',
									class: 'removeExclusion',
									'data-entry': entry,
									onclick: () => removeExclusion(entry),
								},
								spell('Remove'),
							),
						),
					),
				)
			: buildElement('p', {class: 'ioNote'}, spell('Imports skip nothing: no book or edition is excluded.')),
	);
}

/** Take `entry` off the exclusions list, with an Undo that puts it back. */
function removeExclusion(entry: string) {
	if (!CATALOG.removeExclusion(entry)) return;
	persist();
	showExclusions();
	showIoStatus(spell('Imports may add {entry} again.', {entry}), false, () => {
		CATALOG.addExclusions([entry]);
		persist();
		showExclusions();
	});
}

/**
 * Hand the browser `text` as a file to save, named `name` and today's date.
 * @param type its media type: 'text/csv' or 'application/json'
 */
function download(text: string, type: string, name: string) {
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
	// the stored records by store and id (Backup.write, Backup.VERSION)
	download(JSON.stringify(Backup.write(CATALOG), null, '\t'), 'application/json', 'audiobook-catalog-backup');
	showIoStatus(spell('Backup downloaded.'));
	noteBackup().then(refreshPage);
}

/**
 * Download the catalog as an export file for another catalog's import.
 */
function exportFile(exporter: FileExporter) {
	const {LABEL, FORMAT, FILE_NAME, TYPE} = exporter.kind;
	const out = exporter.write(CATALOG.books);
	download(out.text, TYPE, FILE_NAME);
	// (its notes are the exporter's, a module's)
	const values = {catalog: LABEL, format: spell(FORMAT), count: out.books, notes: spell(out.notes.join('; '))};
	showIoStatus(
		out.notes.length
			? spell('{catalog} {format} with {count} books downloaded ({notes}).', values)
			: spell('{catalog} {format} with {count} books downloaded.', values),
	);
}

/**
 * Pick the files to read; resolves to [{name, text}].
 */
function readFiles(files: Iterable<File>): Promise<{name: string; text: string}[]> {
	return Promise.all(
		[...files].map(
			file =>
				new Promise((resolve, reject) => {
					const reader = new FileReader();
					// the event's target is the reader, which read a string
					reader.onload = e =>
						resolve({
							name: file.name,
							text: (e.target as FileReader).result as string,
						});
					reader.onerror = () => reject(new Error(spell("couldn't read {file}", {file: file.name})));
					reader.readAsText(file);
				}) as Promise<{name: string; text: string}>,
		),
	);
}

/**
 * Whether `theirs` has a series or person of `ours` (by name) under another id.
 */
function namedUnderOtherIds(ours: NameIds, theirs: NameIds): boolean {
	return Catalog.NAMED_KINDS.some(kind =>
		[...theirs[kind]].some(([name, id]) => {
			const mine = ours[kind].get(name);
			return mine !== undefined && mine !== id;
		}),
	);
}

/**
 * Restore: a backup, or the data files of a catalog from before it lived in the browser
 * (books.json, series-info.json, ... picked together; Backup.readFiles), replaces the catalog.
 */
async function importBackup(files: File[]) {
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
				spell(
					"Not restored: fix these values in the backup first (they aren't what their field holds): {values}.",
					{
						values: firstThree(unstorable, '; '),
					},
				),
				true,
			);
			return;
		}
		// the info kept is by name here, as it is moved over to the ids its names have
		const keptInfo = (['series', 'authors', 'narrators', 'publishers'] as const).map(
			kind => [kind, CATALOG.infoByName(kind)] as const,
		);
		// and the marks are taken as text, to point them at the books restored
		const keptMarks = CATALOG.markTexts();
		// A backup of a catalog made apart from this one (the same export imported on two devices) has this one's
		// series and people under other ids, which can't be stored beside this one's names, as each name is stored
		// once: this catalog goes first, as when a sync replaces it (syncCatalog).
		if (nameIds && namedUnderOtherIds(CATALOG.nameIds, nameIds)) {
			const had = new Catalog();
			had.replaceWith(CATALOG);
			const emptied = new Catalog();
			emptied.addExclusions(CATALOG.exclusions.entries); // only ever added to
			CATALOG.replaceWith(emptied);
			if (!(await persist())) {
				CATALOG.replaceWith(had); // persist said why; the catalog is as it was
				return;
			}
		}
		CATALOG.books = books;
		CATALOG.marks = new Map();
		if (nameIds) CATALOG.nameIds = nameIds; // the ids series and people were stored under, when the backup has them
		for (const [kind, had] of keptInfo) {
			// older backups have no series info, nor author, narrator and publisher info: keep the current one
			const restored = {series, authors, narrators, publishers}[kind];
			CATALOG.replaceInfo(kind, restored || had);
		}
		const newlyExcluded = CATALOG.addExclusions(excluded || []); // added to, never replaced: removing one is a hand edit
		// likewise the pairs marked "Not duplicates": a backup's from version 2 on by the ids of its books, an older one's as text
		CATALOG.addMarkTexts([...keptMarks, ...(marks ? [] : notDuplicates || [])]);
		if (marks) {
			CATALOG.addMarks(marks.map(m => ({...m})));
			CATALOG.resolveMarks();
		}
		persist();
		noteBackup().then(refreshPage); // what was restored is in that backup
		// one whole sentence for each case, as spell() wants
		const restored = series
			? newlyExcluded
				? 'Restored {books} books and the release details of {series} series; {excluded} more excluded from imports.'
				: 'Restored {books} books and the release details of {series} series.'
			: newlyExcluded
				? 'Restored {books} books; {excluded} more excluded from imports.'
				: 'Restored {books} books.';
		showIoStatus(spell(restored, {books: books.length, series: series ? series.size : 0, excluded: newlyExcluded}));
	} catch (exc) {
		showIoStatus(
			exc instanceof NewerBackup
				? spell(
						'Not restored: a newer version of the catalog made that backup. Reload the page to update it, then try again.',
					)
				: exc instanceof UnreadableBackup
					? spell('Not restored: {problem}.', {problem: spell(exc.message)})
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
 */
function importerOf(Importer: ImporterClass): FileImporter {
	const site = document.getElementById(`${Importer.CATALOG}ImportSite`);
	return new (Importer as new (site?: string) => FileImporter)(site ? (site as HTMLSelectElement).value : undefined);
}
let IMPORT_KIND: ImporterClass = CatalogConnectors.IMPORTERS[0];

/**
 * What is ticked in a comparison: the incoming books to import (by place), those whose edition goes into the
 * book they find (an edition ticked imports its book), the differences to take (by key), the books of a
 * catalog's plan to put on its Read shelf and reads to add (by place), and whether to keep the ids found there.
 */
export type ComparePicks = {
	take: Set<number>;
	editions: Set<number>;
	patch: Set<string>;
	add: Set<number>;
	reads: Set<number>;
	ids: boolean;
};
/** A comparison open in the preview. */
export interface PendingCompare {
	/** the other source's catalog (its panel's prefix) */
	source: string;
	/** the other source's name, as the page says it */
	name: string;
	/** whether its editions are yours (an export of your library's), so they are ticked */
	editionsYours: boolean;
	/** lines on top: what was read */
	notes: string[];
	incoming: Book[];
	opts?: MergeOptions;
	comparison: ComparisonResult;
	warnings: string[];
	/** the comparison with a catalog's shelves */
	online: {sync: ShelfSync; result: ShelfComparison} | null;
	picks: ComparePicks;
}
let PENDING_COMPARE: PendingCompare | null = null; // until it is applied or closed

/**
 * A comparison to open, with what an import would take ticked; but the edition a catalog has
 * for a book you have is unticked, as it may be one picked there for want of the one you have.
 */
function pendingCompare(compare: Omit<PendingCompare, 'picks'>): PendingCompare {
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
 * A paragraph of the preview: `text` as given, spelled by the caller (see spell).
 */
const para = (text: string, className?: string): HTMLParagraphElement => buildElement('p', {class: className}, text);

/**
 * A list of messages, at most `limit` of them, saying how many more there are; nothing when there are none.
 */
function messageList(items: string[], limit: number = Infinity): HTMLUListElement | null {
	if (!items.length) return null;
	return buildElement(
		'ul',
		{},
		items.slice(0, limit).map(m => buildElement('li', {}, m)),
		items.length > limit && buildElement('li', {}, spell('…and {count} more', {count: items.length - limit})),
	);
}

export type PickGroup = 'take' | 'editions' | 'patch' | 'add' | 'reads';

/**
 * How many changes the ticks of a comparison make.
 */
function pickedCount(compare: PendingCompare): number {
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
 */
function idsToSave(compare: PendingCompare): number {
	const {online} = compare;
	return online ? online.result.idsFound.length + online.result.infoIds.length : 0;
}

/**
 * The preview's buttons: the confirm button, labeled `confirm`, and Cancel; only Close when `confirm` is ''.
 */
function showPreviewButtons(confirm: string) {
	const confirmBtn = byId('importConfirm');
	confirmBtn.style.display = confirm ? '' : 'none';
	confirmBtn.textContent = confirm;
	byId('importCancel').textContent = spell(confirm ? 'Cancel' : 'Close');
}

/**
 * Show `body` in the preview under `title`, with its buttons (showPreviewButtons), and open it under the
 * panel `panelId` when given (openPreview).
 */
function showPreview(title: string, body: Child[], confirm: string, panelId?: string) {
	byId('importPreviewTitle').textContent = title;
	fillElement(byId('importPreviewBody'), body);
	showPreviewButtons(confirm);
	if (panelId) openPreview(panelId);
}

/** @returns the comparison's Apply button's label, for the changes ticked; '' for none */
function applyLabel(): string {
	const n = PENDING_COMPARE ? pickedCount(PENDING_COMPARE) : 0;
	return n ? spell('Apply {changes}', {changes: plural(n, 'change')}) : '';
}

function updateApplyButton() {
	showPreviewButtons(applyLabel());
}

/**
 * A tickbox of the comparison, for the pick `key` of `group`.
 */
function pickBox(group: PickGroup, key: number | string, label: Child[]): HTMLLabelElement {
	const compare = PENDING_COMPARE as PendingCompare;
	const picked = compare.picks[group] as Set<number | string>;
	return buildElement(
		'label',
		{class: 'cmpPick'},
		buildElement('input', {
			type: 'checkbox',
			'data-pick': `${group}:${key}`,
			checked: picked.has(key),
			onchange: (e: Event) => {
				if ((e.currentTarget as HTMLInputElement).checked) picked.add(key);
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
 */
function compareGroup(
	heading: string,
	rows: Child[],
	group: PickGroup | null,
	keys: (number | string)[],
	note?: string,
): HTMLElement | null {
	if (!rows.length) return null;
	const tick = (on: boolean) => () => {
		const compare = PENDING_COMPARE as PendingCompare;
		const picked = compare.picks[group as PickGroup] as Set<number | string>;
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
			spell('{heading} ({count})', {heading, count: rows.length}),
			group &&
				keys.length > 1 && [
					' ',
					buildElement('button', {type: 'button', class: 'cmpTick', onclick: tick(true)}, spell('Tick all')),
					' ',
					buildElement(
						'button',
						{type: 'button', class: 'cmpTick', onclick: tick(false)},
						spell('Tick none'),
					),
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
 * One difference, to tick: "Narrators: Ann Vale here, Bo Reed on Goodreads". A series' name that renames
 * the series (`renames`, Comparison.seriesRenames) says so.
 */
function differenceRow(d: Difference, name: string, renames: Map<string, string>): HTMLLIElement {
	return buildElement(
		'li',
		{},
		pickBox('patch', d.key, [
			spellParts('{field}: {here} here, {there} on {catalog}', {
				// the field's label is Comparison's, a module's
				field: spell(d.label),
				here: buildElement('span', {class: 'cmpHere'}, d.here || spell('none')),
				there: buildElement('span', {class: 'cmpThere'}, d.there),
				catalog: name,
			}),
			d.field === 's' && renames.has(d.here) ? renameNote(d.here) : '',
		]),
	);
}

/**
 * What picking a series' new name does: " (renames the series, on its 4 books)".
 */
function renameNote(series: string): string {
	return ' ' + spell('(renames the series, on {books})', {books: plural(CATALOG.seriesBooks(series).length, 'book')});
}

/** Draw the comparison open (PENDING_COMPARE) in the preview. */
function drawCompare() {
	const compare = PENDING_COMPARE as PendingCompare;
	const {name, comparison, online} = compare;
	const books = comparison.books;
	const renames = Comparison.seriesRenames(CATALOG, books);
	const of = (kind: ComparedBook['kind']) => books.filter(b => b.kind === kind);
	const fresh = of('new'),
		gains = of('gains');
	const differing = books.filter(b => b.differences.length),
		same = of('same').filter(b => !b.differences.length);
	const out: Child[] = compare.notes.map(n => para(n));
	out.push(
		para(
			spell(
				'{fresh} new, {gains} with more to give, {differing} with values that differ, {same} the same as in this catalog.',
				{fresh: fresh.length, gains: gains.length, differing: differing.length, same: same.length},
			),
		),
	);

	// a new book as it would be added, in the series spelling in use
	out.push(
		compareGroup(
			spell('New from {catalog}', {catalog: name}),
			fresh.map(b => [
				pickBox('take', b.at, [Comparison.bookLine(b.added[0] || b.theirs)]),
				b.added.length > 1 && messageList(b.added.map(Comparison.bookLine)),
			]),
			'take',
			fresh.map(b => b.at),
		),
	);
	const fromEdition = (b: ComparedBook) =>
		b.editionGains.length
			? buildElement(
					'ul',
					{},
					buildElement(
						'li',
						{},
						pickBox('editions', b.at, [
							// what the edition gains is Comparison's, a module's
							spell('the {catalog} edition: {gains}', {
								catalog: name,
								gains: spell(b.editionGains.join('; ')),
							}),
						]),
					),
				)
			: null;
	out.push(
		compareGroup(
			spell('{catalog} has more', {catalog: name}),
			gains.map(b =>
				b.gains.length || b.added.length
					? [
							pickBox('take', b.at, [Comparison.bookLine(b.books[0] || b.theirs)]),
							messageList([
								...b.gains.map(g => spell(g)),
								...b.added.map(a => spell('adds {book}', {book: Comparison.bookLine(a)})),
							]),
							fromEdition(b),
						]
					: [buildElement('span', {class: 'cmpBook'}, Comparison.bookLine(b.books[0])), fromEdition(b)],
			),
			'take',
			gains.filter(b => b.gains.length || b.added.length).map(b => b.at),
			spell(
				compare.editionsYours
					? 'Ticked, importing fills in what this catalog lacks, and changes nothing it has.'
					: 'Ticked, importing fills in what this catalog lacks, and changes nothing it has. The {catalog} edition is left out unless you tick it, as it may have been picked there for want of yours.',
				{catalog: name},
			),
		),
	);
	out.push(
		compareGroup(
			spell('Different in both'),
			differing.map(b => [
				buildElement('span', {class: 'cmpBook'}, Comparison.bookLine(b.books[0])),
				buildElement(
					'ul',
					{},
					b.differences.map(d => differenceRow(d, name, renames)),
				),
			]),
			'patch',
			differing.flatMap(b => b.differences.map(d => d.key)),
			spell(
				compare.editionsYours
					? "Tick a value to use the one on {catalog} in place of this catalog's."
					: "Tick a value to use the one on {catalog} in place of this catalog's. An edition's values are those of the edition picked on {catalog}, which may not be yours.",
				{catalog: name},
			),
		),
	);

	if (online) out.push(...shelfSections(compare, online.sync, online.result));
	else if (comparison.onlyHere.length) {
		out.push(
			buildElement(
				'details',
				{class: 'cmpOnlyHere'},
				buildElement(
					'summary',
					{},
					spell('Only in this catalog: {count}', {count: comparison.onlyHere.length}),
				),
				messageList(comparison.onlyHere.map(Comparison.bookLine), 100),
			),
		);
	}
	const excluded = of('excluded'),
		notAdded = of('notAdded');
	if (excluded.length)
		out.push(
			para(spell('Skipped (excluded from imports): {count}', {count: excluded.length})),
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
		out.push(
			para(spell('Needs a look ({count}):', {count: compare.warnings.length}), 'warn'),
			messageList(compare.warnings.map(w => spell(w))),
		);
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
	showPreview(spell('Compare with {catalog}', {catalog: name}), out, applyLabel());
}

/**
 * The part of a comparison that is about a catalog's shelves: what putting your books there would do, to
 * tick, and the ids found there to keep.
 */
function shelfSections(compare: PendingCompare, sync: ShelfSync, result: ShelfComparison): Child[] {
	const label = sync.label,
		{plan, idsFound, infoIds} = result;
	const out: Child[] = [];
	if (plan) {
		const dates = (d: string[] | undefined) =>
			d && d.length ? spell(': read {dates}', {dates: d.join(', ')}) : '';
		out.push(
			compareGroup(
				spell('Not on your {catalog} {shelf} shelf', {catalog: label, shelf: plan.name}),
				plan.add.map((a, i) =>
					pickBox('add', i, [a.books.map(Comparison.bookLine).join('; '), dates(a.dates)]),
				),
				'add',
				plan.add.map((a, i) => i),
				spell(
					sync.kind.SENDS_READS
						? 'Tick a book to put it on your {shelf} shelf on {catalog}, with its dates read.'
						: 'Tick a book to put it on your {shelf} shelf on {catalog}.',
					{shelf: plan.name, catalog: label},
				),
			),
		);
		out.push(
			compareGroup(
				spell('Reads {catalog} lacks', {catalog: label}),
				plan.reads.map((a, i) =>
					pickBox('reads', i, [a.books.map(Comparison.bookLine).join('; '), dates(a.dates)]),
				),
				'reads',
				plan.reads.map((a, i) => i),
				spell('Tick a book to add these reads to it on {catalog}.', {catalog: label}),
			),
		);
	} else if (sync.kind.CLIENT.KEY_STORAGE)
		out.push(
			para(
				spell(
					'Save your {catalog} {key} (below the buttons) to compare your shelves too, and to put books on them.',
					{
						catalog: label,
						key: spell(sync.kind.CLIENT.KEY_NAME),
					},
				),
			),
		);
	if (idsFound.length || infoIds.length) {
		const saving = [
			idsFound.length && plural(idsFound.length, 'book'),
			infoIds.length && plural(infoIds.length, 'series or person', 'series and people'),
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
					onchange: (e: Event) => {
						compare.picks.ids = (e.currentTarget as HTMLInputElement).checked;
						updateApplyButton();
					},
				}),
				' ',
				spell('Save the {catalog} {found} found for {saving}', {
					catalog: label,
					found: spell(sync.kind.FOUND),
					saving,
				}),
			),
		);
	}
	if (plan) {
		out.push(
			compareGroup(
				spell('On another {catalog} shelf, left alone', {catalog: label}),
				plan.otherShelf.map(([b, shelf]) => `${Comparison.bookLine(b)}: ${shelf}`),
				null,
				[],
			),
		);
		out.push(
			compareGroup(
				spell('Not found on {catalog}', {catalog: label}),
				plan.unknown.map(Comparison.bookLine),
				null,
				[],
				spell(sync.kind.NOT_FOUND),
			),
		);
		if (plan.inexact.length)
			out.push(
				para(
					spell("Dates read without a day, which {catalog} can't take: {count}", {
						catalog: label,
						count: plan.inexact.length,
					}),
				),
			);
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
					spell('In the series on {catalog}, not in this catalog: {count}', {
						catalog: label,
						count: result.missing.length,
					}),
				),
				messageList(
					result.missing.map(m => (m.number ? `${m.number}. ${m.title}` : m.title)),
					100,
				),
			),
		);
	}
	return out;
}

/**
 * The books a catalog says may not be audiobooks, which may be data problems: your editions it has as
 * something else, and the books on your shelves there read as something else. Nothing to tick: they are
 * put right in the book's form here, or on the catalog.
 */
function notAudioSections(notAudio: NotAudio[], label: string): Child[] {
	const row: (n: NotAudio) => Child = n => [
		n.yours && n.book.id
			? buildElement('a', {href: bookPageHref(n.book.id)}, Comparison.bookLine(n.book))
			: Comparison.bookLine(n.book),
		// what the catalog said it is, in the sync's (a module's) words
		n.yours
			? n.maybe
				? spell(': {edition} is {said}', {edition: n.edition, said: spell(n.said)})
				: spell(': {edition} is {said} on {catalog}', {edition: n.edition, said: spell(n.said), catalog: label})
			: spell(': read as {said} ({edition})', {said: spell(n.said), edition: n.edition}),
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
			spell('Maybe not audiobooks, in this catalog'),
			notAudio.filter(n => n.yours).map(row),
			null,
			[],
			spell(
				'By what {catalog} says, these editions of yours may not be audiobooks: if so, give the book its audiobook edition in its form.',
				{catalog: label},
			),
		),
		compareGroup(
			spell('Maybe not audiobooks, on your {catalog} shelves', {catalog: label}),
			notAudio.filter(n => !n.yours).map(row),
			null,
			[],
			spell('You read these on {catalog} as something else: pick the audiobook edition there.', {catalog: label}),
		),
	];
}

/**
 * Open a comparison in the preview, under the panel of its source.
 */
function openCompare(compare: Omit<PendingCompare, 'picks'>) {
	closeImportPreview();
	PENDING_COMPARE = pendingCompare(compare);
	drawCompare();
	openPreview(`${compare.source}Panel`);
}

/**
 * Show the books of an export file beside this catalog's.
 * @param text the export's text
 */
function compareExport(Importer: ImporterClass, text: string, fileName: string) {
	const importer = importerOf(Importer);
	const result = importer.read(text);
	const notes = [
		spell('{books} read from {file}', {books: plural(result.books.length, 'finished book'), file: fileName}),
	];
	const opts: MergeOptions = {editionTitles: Importer.EDITION_TITLES};
	if (result.skippedUnfinished)
		notes.push(spell('Not finished yet, skipped: {count}', {count: result.skippedUnfinished}));
	openCompare({
		source: Importer.CATALOG,
		name: importer.label,
		editionsYours: Importer.EDITIONS_YOURS,
		notes,
		incoming: result.books,
		comparison: Comparison.compare(CATALOG, result.books, opts),
		opts,
		warnings: result.warnings,
		online: null,
	});
}

/**
 * Take the books of `copy` (the catalog with a comparison applied) into the catalog, with the series it
 * renamed, which keep their id and info.
 */
function takeBooks(copy: Catalog, renamed: SeriesRename[]) {
	for (const {from, to} of renamed) CATALOG.renameEntry('series', from, to);
	CATALOG.books = copy.books;
}

/**
 * The catalog with what is ticked in `compare` taken in, in a copy, with what blocks it.
 */
function applyIntoCopy(compare: PendingCompare) {
	const copy = CATALOG.clone();
	const {take, editions} = compare.picks;
	const {report, patched, renamed} = Comparison.apply(
		copy,
		compare.incoming,
		{...compare.picks, take: new Set([...take, ...editions])},
		compare.opts,
	);
	const {online, picks} = compare;
	const idsFound = picks.ids && online ? online.sync.kind.addIds(copy.books, online.result.found).length : 0;
	const infoIds = picks.ids && online ? online.sync.kind.setInfoIds(copy, online.result.infoIds) : 0;
	const errors = Validator.bookErrors(copy);
	return {copy, report, patched, renamed, idsFound, infoIds, errors};
}

/**
 * What applying a comparison did here, as the status line says it: "Added 2 books, filled in 1 ASIN, changed 1 value".
 * @param idsFound books that got an id (or a cover) found for them on the catalog compared
 * @param found where, and what was found ("AudiobookDB ids and covers"), spelled
 * @param infoIds series and people that got an id found there
 */
function appliedText(
	report: MergeReport,
	patched: number,
	idsFound: number = 0,
	found: string = '',
	infoIds: number = 0,
): string {
	const filled: [Book[], (n: number) => string][] = [
		[report.backfilled, n => spell('filled in {asins}', {asins: plural(n, 'ASIN')})],
		[report.goodreadsFilled, n => spell('filled in {ids}', {ids: plural(n, 'Goodreads id')})],
		[report.hardcoverFilled, n => spell('filled in Hardcover ids on {books}', {books: plural(n, 'book')})],
		[report.datesFilled, n => spell('filled in dates read on {books}', {books: plural(n, 'book')})],
		[report.isbnsFilled, n => spell('added ISBNs to {books}', {books: plural(n, 'book')})],
		[report.editionsAdded, n => spell('added editions to {books}', {books: plural(n, 'book')})],
		[report.detailsFilled, n => spell('filled in edition details on {books}', {books: plural(n, 'book')})],
	];
	const saved = {
		found,
		books: plural(idsFound, 'book'),
		people: plural(infoIds, 'series or person', 'series and people'),
	};
	return [
		spell('Added {books}', {books: plural(report.added.length, 'book')}),
		...filled.filter(([list]) => list.length).map(([list, say]) => say(list.length)),
		idsFound && infoIds
			? spell('saved {found} found for {books} and {people}', saved)
			: idsFound
				? spell('saved {found} found for {books}', saved)
				: infoIds
					? spell('saved {found} found for {people}', saved)
					: '',
		patched && spell('changed {values}', {values: plural(patched, 'value')}),
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
	const {copy, report, patched, renamed, errors} = applyIntoCopy(compare);
	if (errors.length) {
		showIoStatus(spell('The catalog changed and the import no longer validates; nothing was changed.'), true);
		return;
	}
	takeBooks(copy, renamed);
	refreshPage();
	persist();
	showIoStatus(spell('{done}.', {done: appliedText(report, patched)}));
}

// ------------------------------------------------------------ Merge a backup from another device
// Restore replaces the catalog; Merge is for two catalogs that have both changed since they were
// last the same (the phone and the PC, say), so neither side's edits are lost (Backup.mergeInto).
// Like a CSV import it is previewed first, and only applied when confirmed.
let PENDING_MERGE: {backup: Backup; fileName: string} | null = null; // {backup, fileName} while its preview is open

/**
 * The catalog merged with a backup, in copies, with what blocks it and how many changes it makes.
 */
function mergeIntoCatalog(backup: Backup) {
	// the select's options are 'mine' and 'backup'
	const prefer = fieldById('mergePreferSelect').value as 'mine' | 'backup';
	const m = backup.mergeInto(CATALOG, prefer);
	const merged = new Catalog({
		books: m.books,
		series: m.series,
		authors: m.authors,
		narrators: m.narrators,
		publishers: m.publishers,
	});
	const errors = Validator.check(merged, {contributors: true}).errors;
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
	const list = (books: Book[]) => messageList(books.map(Comparison.bookLine));
	const out: Child[] = [
		para(
			spell('{count} books in {file}; {merged} after merging.', {
				count: backup.books.length,
				file: fileName,
				merged: m.books.length,
			}),
		),
	];
	out.push(para(spell('New from the backup: {count}', {count: m.added.length})), list(m.added));
	out.push(
		para(
			spell(
				m.conflicts.length
					? 'Gaining genres, dates read or editions, or the version kept below: {count}'
					: 'Gaining genres, dates read or editions: {count}',
				{count: m.updated.length},
			),
		),
	);
	out.push(para(spell('Removed (removed on the other device): {count}', {count: m.removed.length})), list(m.removed));
	if (m.skipped.length) out.push(para(spell('Not added back (removed here): {count}', {count: m.skipped.length})));
	const keeping = (backups: boolean) => spell(backups ? "the backup's" : "this catalog's");
	if (m.conflicts.length) {
		const kept = keeping(fieldById('mergePreferSelect').value === 'backup');
		out.push(
			para(spell('Title, author or series differ, keeping {kept}: {count}', {kept, count: m.conflicts.length})),
			messageList(
				m.conflicts.map(c =>
					spell('{mine} / backup: {theirs}', {
						mine: Comparison.bookLine(c.mine),
						theirs: Comparison.bookLine(c.theirs),
					}),
				),
			),
		);
	}
	// what was added, and what differs and which was kept, of series' and people's info
	const infoLine = (label: string, added: number, differ: number, backups: boolean) =>
		spell(differ ? '{label}: {added} added, {differ} differing (keeping {kept})' : '{label}: {added} added', {
			label: spell(label),
			added,
			differ,
			kept: keeping(backups),
		});
	const infoDiffer = m.infoChanged.length + m.infoKept.length;
	if (m.infoAdded.length || infoDiffer)
		out.push(
			para(
				infoLine(
					"Series' totals, status, notes and links",
					m.infoAdded.length,
					infoDiffer,
					!!m.infoChanged.length,
				),
			),
		);
	for (const [label, added, changed, kept] of [
		["Authors' bios and links", m.authorsAdded, m.authorsChanged, m.authorsKept],
		["Narrators' bios and links", m.narratorsAdded, m.narratorsChanged, m.narratorsKept],
		["Publishers' bios and links", m.publishersAdded, m.publishersChanged, m.publishersKept],
	] as [string, string[], string[], string[]][]) {
		const differ = changed.length + kept.length;
		if (added.length || differ) out.push(para(infoLine(label, added.length, differ, !!changed.length)));
	}
	if (m.renamed.length) {
		out.push(
			para(spell('Renamed as in the backup: {count}', {count: m.renamed.length})),
			messageList(m.renamed.map(r => `${r.from} \u2192 ${r.to}`)),
		);
	}
	if (m.excluded.length)
		out.push(para(spell('More books excluded from imports: {count}', {count: m.excluded.length})));
	if (m.notDuplicates.length)
		out.push(para(spell('More books marked "Not duplicates": {count}', {count: m.notDuplicates.length})));
	if (errors.length) {
		// Check's messages, which a module writes
		out.push(
			para(spell('Validation failed, nothing will be changed:'), 'warn'),
			messageList(errors.slice(0, 10).map(e => spell(e))),
		);
	} else if (!changes) {
		out.push(para(spell('Nothing to merge: this catalog already has everything in the backup.')));
	}
	byId('mergePrefer').classList.add('show');
	showPreview(spell('Merge a backup'), out, !errors.length && changes ? spell('Merge') : '', 'backupPanel');
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
	for (const kind of ['series', 'authors', 'narrators', 'publishers'] as const) CATALOG.replaceInfo(kind, m[kind]);
	CATALOG.addExclusions(m.excluded);
	CATALOG.addMarkTexts(m.notDuplicates);
	refreshPage();
	persist();
	showIoStatus(
		spell('Merged: {added} added, {updated} updated, {removed} removed.', {
			added: m.added.length,
			updated: m.updated.length,
			removed: m.removed.length,
		}),
	);
}

/**
 * Read a backup to merge, and preview the merge.
 */
async function mergeBackupFile(file: File) {
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
				? spell(
						'Not merged: a newer version of the catalog made that backup. Reload the page to update it, then try again.',
					)
				: exc instanceof UnreadableBackup
					? spell('Not merged: {problem}.', {problem: spell(exc.message)})
					: spell("Couldn't read that file \u2014 make sure it's a catalog backup JSON."),
			true,
		);
	}
}

// ------------------------------------------------------------ Check the catalog, box sets
// The check lists errors and warnings; box sets are previewed like an import and only applied when confirmed.
let PENDING_TIDY: 'box-sets' | null = null; // 'box-sets', while its preview is open

/**
 * Show the check or the box sets in the preview; its confirm button (labeled `confirm`) shows when PENDING_TIDY is set.
 */
function showTidyPreview(title: string, body: Child[], confirm: string) {
	PENDING_COMPARE = null;
	PENDING_MERGE = null;
	byId('mergePrefer').classList.remove('show');
	showPreview(title, body, PENDING_TIDY ? confirm : '', 'checkPanel');
}

function checkCatalog() {
	const {errors, warnings} = Validator.check(CATALOG, {contributors: true});
	const out: Child[] = [
		para(
			spell(
				'{books} books; {series} series, {totals} with a released total; {authors}, {narrators}, {publishers}, {described} with a bio or links.',
				{
					books: CATALOG.books.length,
					series: CATALOG.nameIds.series.size,
					totals: CATALOG.series.size,
					authors: plural(CATALOG.nameIds.authors.size, 'author'),
					narrators: plural(CATALOG.nameIds.narrators.size, 'narrator'),
					publishers: plural(CATALOG.nameIds.publishers.size, 'publisher'),
					described: CATALOG.authors.size + CATALOG.narrators.size + CATALOG.publishers.size,
				},
			),
		),
	];
	// Check's messages, which a module writes
	if (errors.length)
		out.push(
			para(spell('Errors ({count}):', {count: errors.length}), 'warn'),
			messageList(
				errors.map(e => spell(e)),
				100,
			),
		);
	if (warnings.length)
		out.push(
			para(spell('Needs a look ({count}):', {count: warnings.length}), 'warn'),
			messageList(
				warnings.map(w => spell(w)),
				100,
			),
		);
	if (!errors.length && !warnings.length) out.push(para(spell('No problems found.')));
	PENDING_TIDY = null;
	showTidyPreview(spell('Check the catalog'), out, '');
}

// Keep each box set as its own book and as its titles, in a copy of the catalog (Merger.boxSets).
function boxSetsIntoCopy() {
	const copy = CATALOG.clone();
	const report = Merger.boxSets(copy.books, copy.exclusions);
	const errors = Validator.bookErrors(copy);
	return {copy, report, errors};
}

function previewBoxSets() {
	const {report, errors} = boxSetsIntoCopy();
	const out: Child[] = [
		para(spell('Box sets: {count}', {count: report.boxSets.length})),
		messageList(
			report.boxSets.map(b =>
				spell('{title} \u2014 {authors}: {titles} already here', {
					title: b.title,
					authors: Text.namesText(b.authors),
					titles: plural(b.titles, 'title'),
				}),
			),
		),
	];
	if (report.excluded.length)
		out.push(para(spell('Skipped (excluded from imports): {count}', {count: report.excluded.length})));
	out.push(
		para(spell('New: {count}', {count: report.added.length})),
		messageList(report.added.map(Comparison.bookLine)),
	);
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
		out.push(
			para(spell('Validation failed, nothing will be changed:'), 'warn'),
			messageList(
				errors.map(e => spell(e)),
				10,
			),
		);
	} else if (!report.added.length) {
		out.push(para(spell('Every box set is already kept both as its own book and as its titles.')));
	}
	PENDING_TIDY = errors.length || !report.added.length ? null : 'box-sets';
	showTidyPreview(spell('Box sets'), out, spell('Add {books}', {books: plural(report.added.length, 'book')}));
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
	showIoStatus(spell('Added {books} for box sets.', {books: plural(added, 'book')}));
}

// ------------------------------------------------------------ the catalogs' shelves, and your keys for them
// Each catalog in CatalogConnectors.SYNCS has a panel (its prefix is its client's CATALOG), with its Compare
// button and, for a catalog that takes one, your key for it (Hardcover's token, AudiobookDB's API key), kept in
// this browser only (never in a backup). Comparing only reads the catalog; applying saves the catalog first, then sends what was ticked,
// and that stops if you leave the page, so the browser asks first.
let PAGE_RUN: CatalogJob | null = null; // a run going on in this page (showCatalogJob)

/**
 * Say in its panel whether your key for `Client`'s catalog is saved.
 */
function showKey(Client: ClientClass) {
	const saved = Boolean(savedKey(Client)),
		prefix = Client.CATALOG;
	byId(`${prefix}KeyState`).textContent = saved
		? spell('Your {catalog} {key} is saved in this browser only (never in a backup).', {
				catalog: Client.LABEL,
				key: spell(Client.KEY_NAME),
			})
		: spell(Client.KEY_HELP);
	byId(`${prefix}KeyRemove`).style.display = saved ? '' : 'none';
}

/**
 * Save the key pasted in `Client`'s panel in this browser, or `remove` the saved one.
 */
function saveKeyOf(Client: ClientClass, remove: boolean) {
	const input = fieldById(`${Client.CATALOG}Key`);
	const values = {catalog: Client.LABEL, key: spell(Client.KEY_NAME)};
	if (!remove && !Client.cleanKey(input.value)) {
		showIoStatus(spell('Paste your {catalog} {key} first.', values), true);
		return;
	}
	try {
		saveKey(Client, remove ? '' : input.value);
		input.value = '';
		showIoStatus(spell(remove ? '{catalog} {key} removed.' : '{catalog} {key} saved.', values));
	} catch {
		showIoStatus(
			spell(
				remove
					? "Couldn't remove the {key}: this browser refused to store it."
					: "Couldn't save the {key}: this browser refused to store it.",
				values,
			),
			true,
		);
	}
	showKey(Client);
	showSetupPicks();
}

// ------------------------------------------------------------ your server
// Its address and key are kept in this browser only (never in a backup), like your keys for the catalogs.
function showServer() {
	const server = savedServer();
	byId('serverState').textContent = server
		? spell('Saved in this browser only (never in a backup): {url}', {url: server.url})
		: spell(
				"Paste your server's address and key and save them; they are kept in this browser only (never in a backup).",
			);
	byId('serverCheck').style.display = server ? '' : 'none';
	byId('serverRemove').style.display = server ? '' : 'none';
}

/**
 * Save the server typed in the page in this browser and check it, or `remove` the saved one.
 */
async function saveServer(remove: boolean) {
	const url = fieldById('serverUrl'),
		key = fieldById('serverKey');
	const address = serverAddress(url.value);
	if (!remove) {
		if (!address) {
			showIoStatus(spell("Paste the server's address first (https://…workers.dev)."), true);
			return;
		}
		if (!key.value.trim()) {
			showIoStatus(spell("Paste the server's key first."), true);
			return;
		}
	}
	try {
		if (remove) localStorage.removeItem(SERVER_STORAGE_KEY);
		else localStorage.setItem(SERVER_STORAGE_KEY, JSON.stringify({url: address, key: key.value.trim()}));
		url.value = '';
		key.value = '';
	} catch {
		showIoStatus(
			spell(
				remove
					? "Couldn't remove the server: this browser refused to store it."
					: "Couldn't save the server: this browser refused to store it.",
			),
			true,
		);
		return;
	}
	showServer();
	showSetupPicks();
	if (remove) showIoStatus(spell('Server removed.'));
	else await checkServer(spell('Server saved'));
}

/**
 * Ask the saved server whether it answers this page with its key, and what it does, and say so.
 * @param saved what the status line starts with, after a save (spelled)
 */
async function checkServer(saved?: string) {
	// what the server said, after what was saved, else as a sentence of its own
	const say: (text: string, error?: boolean) => void = (text, error = false) =>
		showIoStatus(
			saved ? spell('{saved}; {text}', {saved, text}) : text.charAt(0).toUpperCase() + text.slice(1),
			error,
		);
	try {
		const res = await fetchFromServer('ping');
		if (res.ok) {
			const ping = (await res.json()) as {proxy?: string[]; sync?: boolean};
			// a server from before the proxy moved under /proxy/ lists its catalogs as `catalogs`
			if (!ping.proxy) say(spell('your server is from before this version: deploy it again.'), true);
			else {
				const catalogs = {catalogs: ping.proxy.join(', ')};
				say(
					saved
						? ping.sync
							? spell(
									'it answers: its catalog proxy asks {catalogs}, and it keeps the copy devices sync with.',
									catalogs,
								)
							: spell(
									'it answers: its catalog proxy asks {catalogs}, and sync is not set up on it.',
									catalogs,
								)
						: ping.sync
							? spell(
									'your server answers: its catalog proxy asks {catalogs}, and it keeps the copy devices sync with.',
									catalogs,
								)
							: spell(
									'your server answers: its catalog proxy asks {catalogs}, and sync is not set up on it.',
									catalogs,
								),
				);
			}
		} else if (res.status === 401) say(spell('your server refused the key.'), true);
		else say(spell('your server answered {status}.', {status: res.status}), true);
	} catch (e) {
		say(spell('{error}.', {error: spell(Text.errorText(e))}), true);
	}
}

// ------------------------------------------------------------ syncing devices
// The passphrase is kept in this browser only, like the server's key; syncing itself is syncCatalog() in store.ts.
async function showSync() {
	const saved = Boolean(savedPassphrase());
	byId('syncPassphraseState').textContent = saved
		? spell('A passphrase is saved in this browser only (never in a backup).')
		: spell('Save the passphrase your devices sync with; the first device to sync sets it.');
	byId('syncPassphraseRemove').style.display = saved ? '' : 'none';
	const last = await lastSync();
	byId('syncState').textContent = last
		? spell('Last synced {when}.', {when: new Date(last.at).toLocaleString()})
		: spell('Not synced from this browser yet.');
}

/**
 * Save the passphrase typed in the page in this browser, or `remove` the saved one.
 */
function saveSyncPassphrase(remove: boolean) {
	const field = fieldById('syncPassphrase');
	if (!remove && !field.value) {
		showIoStatus(spell('Type the sync passphrase first.'), true);
		return;
	}
	try {
		if (remove) localStorage.removeItem(SYNC_STORAGE_KEY);
		else localStorage.setItem(SYNC_STORAGE_KEY, field.value);
		field.value = '';
	} catch {
		showIoStatus(
			spell(
				remove
					? "Couldn't remove the passphrase: this browser refused to store it."
					: "Couldn't save the passphrase: this browser refused to store it.",
			),
			true,
		);
		return;
	}
	showSync();
	showSetupPicks();
	showIoStatus(spell(remove ? 'Sync passphrase removed.' : 'Sync passphrase saved.'));
}

/**
 * Show the choice a sync waits on (`which` buttons, after `text`), or hide it.
 */
function showSyncChoice(text: string, which: ('syncKeepMine' | 'syncKeepTheirs' | 'syncReplace')[]) {
	byId('syncChoice').style.display = which.length ? '' : 'none';
	byId('syncChoiceText').textContent = text;
	for (const id of ['syncKeepMine', 'syncKeepTheirs', 'syncReplace'] as const)
		byId(id).style.display = which.includes(id) ? '' : 'none';
}

/**
 * Sync with the other devices, keeping `prefer`'s version of what both changed when it is given.
 */
async function runSync(prefer?: SyncPrefer) {
	showSyncChoice('', []);
	if (!savedServer()) {
		showIoStatus(spell('Syncing goes through your server: save it first (above).'), true);
		return;
	}
	const button = byId('syncBtn') as HTMLButtonElement;
	button.disabled = true;
	showIoStatus(spell('Syncing…'));
	try {
		const {taken, sent, conflicts} = await syncCatalog(prefer);
		if (conflicts.length && !prefer) {
			showIoStatus(spell('Not synced: another device changed these too.'), true);
			showSyncChoice(
				spell('Changed on this device and another: {entries}. Keep which?', {entries: firstThree(conflicts)}),
				['syncKeepMine', 'syncKeepTheirs'],
			);
		} else {
			const values = {changes: plural(taken, 'change')};
			showIoStatus(
				spell(
					taken
						? sent
							? "Synced: {changes} taken in from your other devices; this device's catalog sent."
							: 'Synced: {changes} taken in from your other devices; nothing to send.'
						: sent
							? "Synced: nothing new from your other devices; this device's catalog sent."
							: 'Synced: nothing new from your other devices; nothing to send.',
					values,
				),
			);
		}
	} catch (e) {
		if (e instanceof UnrelatedCatalogs) {
			showIoStatus(
				spell('Not synced: this catalog and the synced one were not made from the same catalog.'),
				true,
			);
			showSyncChoice(
				spell(
					'Both have {names} under other ids. Use the synced catalog here (this one is replaced; Export a backup first), or see the docs to join them.',
					// the names, from the module's message
					{names: e.message.replace(/^two \S+ are named /, '')},
				),
				['syncReplace'],
			);
		} else
			showIoStatus(
				e instanceof WrongPassphrase
					? spell('Not synced: {problem}. Use the passphrase your other devices sync with.', {
							problem: spell(e.message),
						})
					: e instanceof NewerBackup
						? spell(
								'Not synced: a newer version of the app synced last. Reload the page to update it, then sync again.',
							)
						: spell('Not synced: {problem}.', {problem: spell(Text.errorText(e))}),
				true,
			);
	} finally {
		button.disabled = false;
		refreshPage();
		showSync();
	}
}

// ------------------------------------------------------------ setting up another device
// The settings kept in this browser only (your server, the sync passphrase, your keys for the catalogs) go to
// another device in one link, shown as a QR code (DeviceSetup); that device's page asks before saving them.

/** How long the QR code shows before it hides itself, as anyone who sees it can read the settings. */
const SETUP_SHOWN_MS = 2 * 60 * 1000;
let SETUP_HIDE_TIMER: ReturnType<typeof setTimeout> | null = null;
/** the settings a link brought, until saved or not */
let RECEIVED_SETTINGS: DeviceSettings | null = null;

/**
 * The settings saved in this browser that a link can hand over, each with what the page calls it.
 */
function savedDeviceSettings(): {id: string; label: string; settings: DeviceSettings}[] {
	const saved = [];
	const server = savedServer();
	if (server) saved.push({id: 'server', label: spell('Your server ({url})', {url: server.url}), settings: {server}});
	const passphrase = savedPassphrase();
	if (passphrase) saved.push({id: 'passphrase', label: spell('The sync passphrase'), settings: {passphrase}});
	for (const Client of CatalogConnectors.CLIENTS) {
		const key = savedKey(Client);
		if (key)
			saved.push({
				id: Client.CATALOG,
				label: spell('Your {catalog} {key}', {catalog: Client.LABEL, key: spell(Client.KEY_NAME)}),
				settings: {keys: {[Client.CATALOG]: key}},
			});
	}
	return saved;
}

/** List the settings saved in this browser, each ticked, for the QR code; a setting saved or removed since hides the code. */
function showSetupPicks() {
	hideSetupCode();
	const saved = savedDeviceSettings();
	fillElement(
		byId('setupPicks'),
		...saved.map(s =>
			buildElement(
				'label',
				{},
				buildElement('input', {type: 'checkbox', id: `setupPick-${s.id}`, checked: true}),
				' ',
				s.label,
			),
		),
	);
	byId('setupShowBtn').style.display = saved.length ? '' : 'none';
	byId('setupState').textContent = saved.length
		? ''
		: spell('Nothing to hand over yet: save your server, the sync passphrase or a key on this page first.');
}

/**
 * The Import & export page's address on the other device: this one, unless this page is on this computer only
 * (make serve), when it is your server's, which serves the app too; '' when there is neither.
 */
function setupPageAddress(): string {
	if (!['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) return location.origin + location.pathname;
	const server = savedServer();
	return server && server.url.startsWith('https:') ? `${server.url}/import.html` : '';
}

/**
 * The link that hands the ticked settings over, or why there is none.
 */
export function setupLink(): {link: string} | {problem: string} {
	const settings: DeviceSettings = {};
	for (const {id, settings: one} of savedDeviceSettings()) {
		if (!(byId(`setupPick-${id}`) as HTMLInputElement).checked) continue;
		Object.assign(settings, one, one.keys ? {keys: {...settings.keys, ...one.keys}} : {});
	}
	if (DeviceSetup.isEmpty(settings)) return {problem: spell('Tick a setting to hand over first.')};
	const page = setupPageAddress();
	if (!page)
		return {
			problem: spell(
				"This page is on this computer only, so a phone can't open the link: open the app at the address your phone uses (GitHub Pages, or your server) and show the code there.",
			),
		};
	return {link: DeviceSetup.link(page, settings)};
}

/** Show the QR code of the link that hands the ticked settings over, for SETUP_SHOWN_MS. */
async function showSetupCode() {
	const made = setupLink();
	if ('problem' in made) {
		showIoStatus(made.problem, true);
		return;
	}
	const {default: qrcode} = await import('./vendor/qrcode.mjs');
	// type 0 picks the smallest code that holds the link; L (the least error correction) keeps a long key's code
	// readable, as a code on a screen is not smudged or torn
	const code = qrcode(0, 'L');
	code.addData(made.link);
	code.make();
	// whole pixels a module (a code scaled by a fraction has uneven modules, which cameras misread), about 400 wide
	// with the quiet zone of four modules the standard asks for
	const cell = Math.max(3, Math.round(400 / (code.getModuleCount() + 8)));
	byId('setupQr').setAttribute('src', code.createDataURL(cell, 4 * cell));
	byId('setupCode').style.display = '';
	byId('setupHideBtn').style.display = '';
	if (SETUP_HIDE_TIMER !== null) clearTimeout(SETUP_HIDE_TIMER);
	SETUP_HIDE_TIMER = setTimeout(hideSetupCode, SETUP_SHOWN_MS);
}

/** Hide the QR code, and forget it. */
function hideSetupCode() {
	if (SETUP_HIDE_TIMER !== null) clearTimeout(SETUP_HIDE_TIMER);
	SETUP_HIDE_TIMER = null;
	byId('setupQr').removeAttribute('src');
	byId('setupCode').style.display = 'none';
	byId('setupHideBtn').style.display = 'none';
}

/**
 * When this page was opened by another device's link, take the settings out of the address at once (so they are
 * in no history entry) and ask whether to save them. Only what this browser can use is offered: a server address
 * serverAddress takes, and keys for the catalogs it knows.
 */
function takeSettingsFromAddress() {
	const brought = DeviceSetup.fromHash(location.hash);
	if (!brought) return;
	history.replaceState(null, '', location.pathname + location.search);
	const settings: DeviceSettings = {};
	const lines: string[] = [];
	const url = brought.server && serverAddress(brought.server.url);
	if (brought.server && url) {
		settings.server = {url, key: brought.server.key};
		lines.push(
			spell(savedServer() ? 'Your server, {url} (in place of the one saved here)' : 'Your server, {url}', {url}),
		);
	}
	if (brought.passphrase) {
		settings.passphrase = brought.passphrase;
		lines.push(
			spell(savedPassphrase() ? 'The sync passphrase (in place of the one saved here)' : 'The sync passphrase'),
		);
	}
	for (const Client of CatalogConnectors.CLIENTS) {
		const key = brought.keys?.[Client.CATALOG];
		if (!key) continue;
		settings.keys = {...settings.keys, [Client.CATALOG]: key};
		lines.push(
			spell(savedKey(Client) ? 'Your {catalog} {key} (in place of the one saved here)' : 'Your {catalog} {key}', {
				catalog: Client.LABEL,
				key: spell(Client.KEY_NAME),
			}),
		);
	}
	if (DeviceSetup.isEmpty(settings)) {
		showIoStatus(spell("The link's settings can't be used here, so nothing was saved."), true);
		return;
	}
	RECEIVED_SETTINGS = settings;
	fillElement(byId('setupReceivedList'), ...lines.map(line => buildElement('li', {}, line)));
	byId('setupReceived').style.display = '';
}

/** Save the settings the link brought in this browser, and see that the server answers. */
async function saveReceivedSettings() {
	const settings = RECEIVED_SETTINGS;
	if (!settings) return;
	try {
		if (settings.server) localStorage.setItem(SERVER_STORAGE_KEY, JSON.stringify(settings.server));
		if (settings.passphrase) localStorage.setItem(SYNC_STORAGE_KEY, settings.passphrase);
		for (const Client of CatalogConnectors.CLIENTS) {
			const key = settings.keys?.[Client.CATALOG];
			if (key) saveKey(Client, key);
		}
	} catch {
		showIoStatus(spell("Couldn't save the settings: this browser refused to store them."), true);
		return;
	}
	closeReceivedSettings();
	showServer();
	showSync();
	for (const Client of CatalogConnectors.CLIENTS) showKey(Client);
	showSetupPicks();
	if (settings.server) await checkServer(spell('Settings saved'));
	else showIoStatus(spell('Settings saved.'));
}

/** Forget the settings the link brought, saved or not. */
function closeReceivedSettings() {
	RECEIVED_SETTINGS = null;
	fillElement(byId('setupReceivedList'));
	byId('setupReceived').style.display = 'none';
}

/**
 * Run `task` with a catalog's shelves (`catalog`, its name), shown in the banner on top while it goes (as a `mode`
 * job), handing it the step it reports its progress through. Resolves to what it gave or threw and how long it
 * took; to undefined when another run is going on.
 */
async function withCatalogJob<T>(
	catalog: string,
	mode: CatalogMode,
	task: (step: Step) => Promise<T>,
): Promise<{value?: T; error?: unknown; elapsed: number} | undefined> {
	if (PAGE_RUN) return undefined;
	const started = Date.now();
	const job: CatalogJob = (PAGE_RUN = {
		catalog,
		mode,
		dryRun: mode === 'compare',
		running: true,
		elapsed: 0,
		step: 'Starting',
	});
	const show = () => {
		job.elapsed = Date.now() - started;
		showCatalogJob(job);
	};
	const ticker = setInterval(show, 1000);
	show();
	const result: {value?: T; error?: unknown; elapsed: number} = {elapsed: 0};
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
 * An address from when a series' or an author's page compared its books here (#hardcover-series=<id>,
 * #all-author=<id>, ...) goes to the Edit series page, which compares them now; true when it went.
 */
function movedCompareAddress(): boolean {
	const found = /^#[a-z]+-(series|author)=(.*)$/.exec(location.hash);
	if (!found) return false;
	location.replace(`edit.html#${found[1]}=${found[2]}`);
	return true;
}

/**
 * Show your shelves on `Sync`'s catalog beside this catalog, or beside a series' or an author's books. Only
 * reads that catalog.
 */
async function compareShelfSync(Sync: SyncClass) {
	if (PAGE_RUN) return;
	const Client = Sync.CLIENT,
		label = Client.LABEL,
		prefix = Client.CATALOG;
	const key = savedKey(Client);
	if (Client.VIA_PROXY && !savedServer()) {
		showIoStatus(
			spell("{catalog} is asked through your server's catalog proxy: save your server first (below).", {
				catalog: label,
			}),
			true,
		);
		return;
	}
	if (Client.KEY_NEEDED && !key) {
		showIoStatus(
			spell('Save your {catalog} {key} first (below the buttons).', {
				catalog: label,
				key: spell(Client.KEY_NAME),
			}),
			true,
		);
		return;
	}
	if (!(await holdWholeCatalog())) return;
	closeImportPreview();
	await whenSaved(); // compared with the catalog as saved
	const sync = new (Sync as new (client: unknown) => ShelfSync)(catalogClient(Client, key));
	const run = await withCatalogJob(label, 'compare', step => sync.compare(CATALOG, step));
	if (!run) return;
	const result = run.value;
	if (!result) {
		showPreview(
			spell('Compare with {catalog}', {catalog: label}),
			[para(spell("Couldn't compare: {error}", {error: spell(Text.errorText(run.error))}), 'warn')],
			'',
			`${prefix}Panel`,
		);
		return;
	}
	// (the summary is the sync's words, a module's)
	const notes = [
		spell('{summary} (took {time})', {
			summary: spell(sync.summary(result, CATALOG, null)),
			time: minutes(run.elapsed),
		}),
	];
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
 */
async function applyShelfSync(compare: PendingCompare) {
	const {sync, result} = compare.online as NonNullable<PendingCompare['online']>;
	const Client = sync.kind.CLIENT,
		label = sync.label;
	const key = savedKey(Client);
	const {picks} = compare;
	const plan: SyncPlan | null = result.plan && {
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
		showIoStatus(
			spell('Save your {catalog} {key} first (below the buttons).', {
				catalog: label,
				key: spell(Client.KEY_NAME),
			}),
			true,
		);
		return;
	}
	closeImportPreview();
	await whenSaved();
	if ((await storedRevision()) !== SEEN_REVISION) {
		showIoStatus(
			spell(
				'The catalog was edited in another tab since you compared; nothing was changed, nothing sent to {catalog}. Compare again.',
				{catalog: label},
			),
			true,
		);
		return;
	}
	const {copy, report, patched, renamed, idsFound, infoIds, errors} = applyIntoCopy(compare);
	if (errors.length) {
		showIoStatus(
			spell(
				'The catalog changed and the import no longer validates; nothing was changed, nothing sent to {catalog}.',
				{catalog: label},
			),
			true,
		);
		return;
	}
	const found = spell('{catalog} {found}', {catalog: label, found: spell(sync.kind.FOUND)});
	const here = appliedText(report, patched, idsFound, found, infoIds);
	if (JSON.stringify(copy.books) !== JSON.stringify(CATALOG.books) || infoIds) {
		takeBooks(copy, renamed);
		if (picks.ids) sync.kind.setInfoIds(CATALOG, result.infoIds);
		// kept before anything is sent, so the ids found stay even if the catalog stops answering
		const kept = await persist();
		refreshPage();
		// not kept: the status line says why, and nothing is sent for books this catalog may not hold after a reload
		if (!kept) return;
	}
	if (!plan || !sending) {
		showIoStatus(spell('{done}.', {done: here}));
		return;
	}
	const lines: string[] = [];
	const say = (line: string) => {
		lines.push(line);
	};
	const run = await withCatalogJob(label, 'send', step => sync.push(plan, say, say, step));
	if (!run) return;
	if (run.error) lines.push(spell('error: {error}', {error: spell(Text.errorText(run.error))}));
	const ok = !run.error && run.value === 0;
	showPreview(
		spell('{catalog} updated (took {time})', {catalog: label, time: minutes(run.elapsed)}),
		// (what was sent, line by line, in the sync's words, a module's)
		[para(spell('{done} here.', {done: here})), buildElement('pre', {}, spell(lines.join('\n')))],
		'',
		`${Client.CATALOG}Panel`,
	);
	showIoStatus(
		ok
			? spell('{done}; {catalog} updated.', {done: here, catalog: label})
			: spell('Not everything went through on {catalog}; see the details.', {catalog: label}),
		!ok,
	);
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
 * Each update of a run (showCatalogJob in store.ts): no second run while one goes.
 */
function onCatalogJob(job: CatalogJob | null) {
	for (const Sync of CatalogConnectors.SYNCS.filter(Sync => Sync.EVERY_BOOK))
		(byId(`${Sync.CLIENT.CATALOG}CompareBtn`) as HTMLButtonElement).disabled = Boolean(job && job.running);
}

/**
 * Open the preview right under the panel whose button asked for it, so it is next to what it is about.
 */
function openPreview(panelId: string) {
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
 */
async function importCsv(Importer: ImporterClass, file: File) {
	if (!(await holdWholeCatalog())) return;
	try {
		const [{text}] = await readFiles([file]);
		compareExport(Importer, text, file.name);
	} catch {
		closeImportPreview();
		showIoStatus(spell("Couldn't read that file as a {catalog} export.", {catalog: Importer.LABEL}), true);
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
		withWholeCatalog(() => exportFile(new (Exporter as new () => FileExporter)())),
	);
}
for (const Sync of CatalogConnectors.SYNCS) {
	const Client = Sync.CLIENT,
		prefix = Client.CATALOG;
	if (Sync.EVERY_BOOK) byId(`${prefix}CompareBtn`).addEventListener('click', () => compareShelfSync(Sync));
	if (!Client.KEY_STORAGE) continue; // asked without a key (Audible)
	byId(`${prefix}KeySave`).addEventListener('click', () => saveKeyOf(Client, false));
	byId(`${prefix}KeyRemove`).addEventListener('click', () => saveKeyOf(Client, true));
}
/**
 * When files are picked in the file field `id`, hand them to `take`, and empty the field, so the same file
 * can be picked again.
 */
function onFilesPicked(id: string, take: (files: File[]) => Promise<void>) {
	byId(id).addEventListener('change', e => {
		const input = e.target as HTMLInputElement;
		const files = [...(input.files || [])];
		input.value = '';
		if (files.length) return take(files);
	});
}
onFilesPicked('importCsvFile', files => importCsv(IMPORT_KIND, files[0]));
byId('importConfirm').addEventListener('click', () =>
	PENDING_TIDY ? applyTidy() : PENDING_MERGE ? applyMerge() : applyCompare(),
);
byId('serverSave').addEventListener('click', () => saveServer(false));
byId('serverCheck').addEventListener('click', () => checkServer());
byId('serverRemove').addEventListener('click', () => saveServer(true));
byId('importCancel').addEventListener('click', closeImportPreview);
byId('syncPassphraseSave').addEventListener('click', () => saveSyncPassphrase(false));
byId('syncPassphraseRemove').addEventListener('click', () => saveSyncPassphrase(true));
byId('syncBtn').addEventListener('click', () => runSync());
byId('syncKeepMine').addEventListener('click', () => runSync('mine'));
byId('syncKeepTheirs').addEventListener('click', () => runSync('theirs'));
byId('syncReplace').addEventListener('click', () => runSync('replace'));
byId('setupShowBtn').addEventListener('click', showSetupCode);
byId('setupHideBtn').addEventListener('click', hideSetupCode);
byId('setupReceivedSave').addEventListener('click', saveReceivedSettings);
byId('setupReceivedSkip').addEventListener('click', () => {
	closeReceivedSettings();
	showIoStatus(spell('Nothing saved.'));
});

byId('checkBtn').addEventListener('click', () => withWholeCatalog(checkCatalog));
byId('exclusionsBtn').addEventListener('click', () => withWholeCatalog(showExclusions));
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
		if (movedCompareAddress()) return;
		refreshPage();
		for (const Client of CatalogConnectors.CLIENTS) showKey(Client);
		showServer();
		showSyncChoice('', []);
		showSync();
		showSetupPicks();
		takeSettingsFromAddress();
	},
	{refresh: refreshPage, onCatalogJob},
);
