// The external catalogs on the Edit series page (edit.ts loads this with import(), as only this needs the
// catalogs' connectors): which catalogs a series' or an author's books are compared with (every one set up,
// but those unticked for the next run, remembered in this browser), running their comparisons in turn, and
// what the page takes from them (BookReview). Comparing only reads the catalogs; nothing is sent to them.
import {Text} from './modules/text.js';
import {Merger} from './modules/merger.js';
import {BookReview} from './modules/book-review.js';
import {CatalogConnectors} from './modules/catalog-connectors.js';
import {CATALOG, savedKey, savedServer, catalogClient, showCatalogJob, whenSaved, type CatalogJob} from './store.js';
import type {Book} from './modules/book.js';
import type {MergeReport} from './modules/merger.js';
import type {ShelfSync, ShelfComparison} from './modules/shelf-sync.js';
import type {CatalogEntry, ReviewResult} from './modules/book-review.js';

type SyncClass = typeof ShelfSync;

/** localStorage: the catalogs (by their client's CATALOG) left out of the Edit page's next run. */
export const SKIP_STORAGE_KEY = 'audiobook-catalog-edit-skip';

/** A catalog the page can compare with: its key, its name, and what keeps it from being asked ('' for nothing). */
export type CatalogChoice = {catalog: string; label: string; cantAsk: string; skipped: boolean};

/** The catalogs left out of the next run, as remembered in this browser. */
function skipped(): Set<string> {
	try {
		const list: unknown = JSON.parse(localStorage.getItem(SKIP_STORAGE_KEY) || '[]');
		return new Set(Array.isArray(list) ? list.filter(x => typeof x === 'string') : []);
	} catch {
		return new Set();
	}
}

/** Remember whether `catalog` is asked on the next run. */
export function setSkipped(catalog: string, skip: boolean) {
	const now = skipped();
	if (skip) now.add(catalog);
	else now.delete(catalog);
	try {
		localStorage.setItem(SKIP_STORAGE_KEY, JSON.stringify([...now].sort()));
	} catch {
		/* asked again next time */
	}
}

/** What keeps a catalog from being asked now ('' when nothing does): no server saved, or no key where it needs one. */
function cantAsk(Sync: SyncClass): string {
	const Client = Sync.CLIENT;
	if (Client.VIA_PROXY && !savedServer()) return "needs your server's catalog proxy (on Import & export)";
	if (Client.KEY_NEEDED && !savedKey(Client))
		return `needs your ${Client.LABEL} ${Client.KEY_NAME} (on Import & export)`;
	return '';
}

/** The catalogs that compare a series' or an author's books. */
function syncsFor(kind: 'series' | 'author'): SyncClass[] {
	return CatalogConnectors.SYNCS.filter(Sync => Sync.PARTS.includes(kind));
}

/** The catalogs the page offers for `kind`, each with whether it can be asked and is left out. */
export function catalogChoices(kind: 'series' | 'author'): CatalogChoice[] {
	const skip = skipped();
	return syncsFor(kind).map(Sync => ({
		catalog: Sync.CLIENT.CATALOG,
		label: Sync.CLIENT.LABEL,
		cantAsk: cantAsk(Sync),
		skipped: skip.has(Sync.CLIENT.CATALOG),
	}));
}

/** A catalog compared: its sync (which takes the ids it found) and its comparison. */
type Compared = {sync: ShelfSync; result: ShelfComparison};

/** The catalogs compared with a series' or an author's books, and what the page takes from them. */
export class CatalogRun {
	/** each catalog compared, in the order asked */
	sources: Compared[];
	/** each catalog's name, by its place in `sources` */
	labels: string[];
	/** each catalog's key in ExternalCatalog, by its place in `sources` */
	keys: string[];
	/** what was read, and what couldn't be, one line each */
	notes: string[];
	review: ReviewResult;

	constructor(sources: Compared[], notes: string[], ids: string[]) {
		this.sources = sources;
		this.labels = sources.map(s => s.sync.label);
		this.keys = sources.map(s => s.sync.kind.CLIENT.CATALOG);
		this.notes = notes;
		this.review = BookReview.compare(
			CATALOG,
			sources.map(({sync, result}) => ({label: sync.label, catalog: sync.kind.CLIENT.CATALOG, result})),
			ids,
		);
	}

	/**
	 * `book` with a catalog's book taken in (its ids, dates read and edition details, and its edition with
	 * `withEdition`), and the ids that catalog found for it; null when it is another book.
	 */
	take(book: Book, entry: CatalogEntry, withEdition: boolean): Book | null {
		const {sync, result} = this.sources[entry.source];
		const taken = BookReview.take(book, entry.theirs, CATALOG.exclusions, result.opts, withEdition);
		if (!taken) return null;
		return BookReview.withIds(taken, (books, found) => sync.kind.addIds(books, found), result.found) || taken;
	}

	/** `book` with the ids (and covers) a catalog found for it; null when it found nothing new. */
	idsFor(book: Book, source: number): Book | null {
		const {sync, result} = this.sources[source];
		return BookReview.withIds(book, (books, found) => sync.kind.addIds(books, found), result.found);
	}

	/** Add to the catalog the new book `fresh` (its place in the review's) as `source` has it. */
	addFresh(fresh: number, source: number): MergeReport | null {
		const from = this.review.fresh[fresh] && this.review.fresh[fresh].from.find(f => f.source === source);
		if (!from) return null;
		const {result} = this.sources[source];
		return Merger.into(CATALOG, [result.incoming[from.at]], result.opts);
	}

	/** Keep the ids a catalog found for the series and people, where they have none; how many gained one. */
	keepInfoIds(source: number): number {
		const {sync, result} = this.sources[source];
		return sync.kind.setInfoIds(CATALOG, result.infoIds);
	}
}

/**
 * Compare the books of a series or an author (`name`, with `ids` the books shown) with every catalog that can
 * be asked and isn't left out, in turn, with the run shown in the banner on top. The page holds the whole
 * catalog (a catalog's book may be one outside the series).
 */
export async function runCatalogs(kind: 'series' | 'author', name: string, ids: string[]): Promise<CatalogRun> {
	await whenSaved(); // compared with the catalog as saved
	const skip = skipped();
	const notes: string[] = [];
	const sources: Compared[] = [];
	const asked = syncsFor(kind).filter(Sync => {
		const why = cantAsk(Sync);
		if (why) notes.push(`${Sync.CLIENT.LABEL}: not asked, as it ${why}.`);
		return !why && !skip.has(Sync.CLIENT.CATALOG);
	});
	const started = Date.now();
	for (const Sync of asked) {
		const Client = Sync.CLIENT;
		const job: CatalogJob = {catalog: Client.LABEL, mode: 'compare', dryRun: true, running: true, elapsed: 0};
		showCatalogJob(job);
		const sync = new (Sync as new (client: unknown) => ShelfSync)(catalogClient(Client, savedKey(Client)));
		try {
			const result = await sync.compare(
				CATALOG,
				(text, done, total) => {
					Object.assign(job, {step: text, done, total, elapsed: Date.now() - started});
					showCatalogJob(job);
				},
				Sync.part(CATALOG, kind, name),
			);
			sources.push({sync, result});
			notes.push(`${Client.LABEL}: ${Text.plural(result.incoming.length, 'book')} read.`);
		} catch (e) {
			notes.push(`${Client.LABEL}: couldn't compare: ${Text.errorText(e)}`);
		}
	}
	showCatalogJob(null);
	return new CatalogRun(sources, notes, ids);
}
