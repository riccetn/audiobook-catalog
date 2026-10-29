// What every catalog whose shelves the page compares with the catalog shares (Hardcover, AudiobookDB): Compare
// reads your shelves there into books an import takes (Comparison), finds the catalog's books there, and plans
// putting them on your Read shelf; Apply takes in what was ticked and sends the ticked part of the plan (push).
// A subclass reads its catalog (compare) and sends one entry of a plan (send); the page knows only this class,
// and a subclass's static texts say what differs on it. Comparing only reads the other catalog, and sending
// only adds to it.
import {Text} from './text.js';
import {Series} from './series.js';
import {Comparison} from './comparison.js';
import {CatalogClient} from './catalog-client.js';
import type {Book} from './book.js';
import type {Catalog, NamedKind} from './catalog.js';
import type {MergeOptions} from './merger.js';
import type {ComparisonResult} from './comparison.js';
import type {Step} from './catalog-client.js';

/** a series or an author, and its id on the other catalog when it has one */
export type ShelfPart = {kind: 'series' | 'author'; name: string; id?: string};
/**
 * An id found on the other catalog for a series or person of yours: under `catalog` (the key in ExternalCatalog;
 * the client's CATALOG when left out), and for a series its count of books there (`total`), when it says.
 */
export type InfoId = {kind: NamedKind; name: string; id: string; catalog?: string; total?: number};
/**
 * One entry of a plan: your books that are one book there (a box set's titles may be), with the dates read
 * to send (on a catalog that takes them).
 */
export type PlanEntry = {books: Book[]; dates?: string[]};
/**
 * What sending to a catalog would do (planned by compare()): the books to put on your Read shelf (`name`, as
 * the catalog shows it), the reads to add to books already there, those on another shelf there (left alone),
 * those it doesn't have, and dates read it can't take.
 */
export interface SyncPlan {
	name: string;
	add: PlanEntry[];
	reads: PlanEntry[];
	otherShelf: [Book, string][];
	unknown: Book[];
	inexact: [Book, string][];
}
/**
 * A book that may not be an audiobook, as the other catalog says, which may be a data problem: an edition of
 * yours (`yours`), or the one on your shelf there. `edition` names it ("ASIN B0…", "ISBN 978…", "Hardcover
 * edition 601"), `said` is what the catalog has it as ("a print book"), `url` its page there; `maybe` when
 * it is only a guess (Audible not selling it).
 */
export type NotAudio = {
	book: Book;
	yours: boolean;
	edition: string;
	said: string;
	url?: string | null;
	maybe?: boolean;
};
/** Your shelves on a catalog beside the catalog (compare()). */
export interface ShelfComparison {
	/** the books on your Read shelf beside the catalog's */
	comparison: ComparisonResult;
	/** the books on your Read shelf compared (those in the scope asked for) */
	incoming: Book[];
	/** how they are imported (Comparison.apply() takes them) */
	opts: MergeOptions;
	warnings: string[];
	/** what the catalog has for your books; the subclass's addIds() gives their ids */
	found: unknown;
	/** the books that gain an id there, in the comparison's merged copy */
	idsFound: Book[];
	/** the series and people that gain an id there */
	infoIds: InfoId[];
	/** what putting your books there would do; null when it can't be known (no key) */
	plan: SyncPlan | null;
	/** the series' books there that aren't in the catalog (a series only) */
	missing: string[];
	/** the editions of yours and on your shelves there that may not be audiobooks */
	notAudio: NotAudio[];
	/** the incoming books whose edition is yours there (found by its id), ticked at first */
	yours?: Book[];
}
/** what sending one entry of a plan did */
export type Sent = {shelved: number; reads: number; problems: string[]};
export type PlanGroup = 'add' | 'reads';

/** Compares the catalog with your shelves on one catalog, and puts books (and reads) on them. */
export class ShelfSync {
	/** The client class it asks through: its catalog's name, key and ids. */
	static CLIENT = CatalogClient;
	/** Whether it sends dates read too (as reads on books on your Read shelf there). */
	static SENDS_READS = false;
	/** Sending stops after this many entries in a row fail. */
	static STOP_AFTER = 3;
	/** What the comparison says of the books it doesn't find there. */
	static NOT_FOUND = '';
	/** What Compare finds on your books besides the books themselves, which Apply saves when ticked: "ids", "ids and covers". */
	static FOUND = 'ids';
	/** What it compares besides every book: a series' books, an author's (their pages link to Compare). */
	static PARTS = ['series', 'author'] as readonly ('series' | 'author')[];

	client: CatalogClient;

	constructor(client: CatalogClient) {
		this.client = client;
	}

	/** @returns the sync's class, with what it says of its catalog */
	get kind(): typeof ShelfSync {
		return this.constructor as typeof ShelfSync;
	}

	/** @returns its catalog's name, as the page says it */
	get label(): string {
		return this.kind.CLIENT.LABEL;
	}

	/**
	 * A series or an author of `catalog` to compare, with the id its info has on this catalog (when it is one
	 * of the catalog's ids: a name kept from a page's address is not).
	 */
	static part(catalog: Catalog, kind: 'series' | 'author', name: string): ShelfPart {
		const key = kind === 'series' ? 'series' : 'authors';
		const id = catalog.nameIds[key].get(name);
		const info = id === undefined ? undefined : catalog.infoMap(key).get(id);
		const there = info && info.external[this.CLIENT.CATALOG];
		return {kind, name, ...(there && this.CLIENT.ID.test(there) ? {id: there} : {})};
	}

	/**
	 * Your shelves beside `catalog` (not changed), for every book or, with `part`, only a series' or an
	 * author's. Only reads the other catalog; `step(text, done, total)` hears how far it has got.
	 */
	async compare(_catalog: Catalog, _step: Step, _part?: ShelfPart): Promise<ShelfComparison> {
		throw new Error(`${this.label}: compare is not written`);
	}

	/**
	 * What a comparison's first line says it read: how many books on either side, for `scope` (the series or
	 * author compared) or for every book of `catalog`.
	 */
	summary(
		_result: ShelfComparison,
		_catalog: Catalog,
		_scope: {kind: 'series' | 'author'; name: string; label: string} | null,
	): string {
		throw new Error(`${this.label}: summary is not written`);
	}

	/**
	 * Send one entry of a plan: put its book on your Read shelf (`add`), or add its reads (`reads`). A problem
	 * the catalog answers is in what it gives; it throws when the catalog can't be asked.
	 */
	async send(_entry: PlanEntry, _plan: SyncPlan, _group: PlanGroup): Promise<Sent> {
		throw new Error(`${this.label}: send is not written`);
	}

	/**
	 * What the comparison says of the `count` books it can't add, as it can't tell which edition is yours.
	 */
	static notAdded(count: number): string {
		return `Not added, as ${this.CLIENT.LABEL} can't tell which edition is yours: ${count}`;
	}

	/**
	 * Give `books` the ids found for them (`found`, a comparison's), only where they have none. Changes `books`
	 * in place; returns those that gained an id.
	 */
	static addIds(_books: Book[], _found: unknown): Book[] {
		throw new Error(`${this.CLIENT.LABEL}: addIds is not written`);
	}

	/**
	 * Give the catalog's series and people the ids found (a comparison's infoIds), where they have none yet.
	 * @param _catalog changed in place
	 * @returns how many gained one
	 */
	static setInfoIds(_catalog: Catalog, _found: InfoId[]): number {
		return 0;
	}

	/**
	 * Carry out a plan (or the part of it picked): put its `add` books on your Read shelf, and add its `reads`.
	 * Stops after STOP_AFTER entries in a row fail. Returns a promise of the exit code.
	 */
	async push(plan: SyncPlan, out: (line: string) => void, err: (line: string) => void, step: Step): Promise<number> {
		const label = this.label,
			reads = this.kind.SENDS_READS;
		const done = {shelved: 0, reads: 0};
		const problems: string[] = [];
		const groups: [PlanGroup, string][] = [
			['add', `Putting books on your ${label} ${plan.name} shelf`],
			['reads', `Adding reads to books on your ${plan.name} shelf`],
		];
		const total = plan.add.length + plan.reads.length;
		let at = 0,
			failed = 0;
		for (const [group, doing] of groups) {
			for (const entry of plan[group]) {
				step(doing, at++, total);
				try {
					const sent = await this.send(entry, plan, group);
					done.shelved += sent.shelved;
					done.reads += sent.reads;
					problems.push(...sent.problems);
					failed = 0;
				} catch (exc) {
					problems.push(`${entry.books[0].title}: not added (${Text.errorText(exc)})`);
					if (++failed >= this.kind.STOP_AFTER) {
						err(
							`error: ${Text.errorText(exc)}; stopped after putting ${done.shelved} book(s) on ${label}${reads ? ` and adding ${done.reads} read(s)` : ''}. ` +
								'Run it again to carry on: what is already there is not added twice.',
						);
						return 1;
					}
				}
			}
		}
		out(
			`put ${done.shelved} book(s) on your ${label} ${plan.name} shelf${reads ? ` and added ${done.reads} read(s)` : ''}`,
		);
		for (const p of problems.slice(0, 15)) out('    ! ' + p);
		return problems.length ? 1 : 0;
	}

	/**
	 * The books of `catalog` in `scope` (a series or an author), or every book for none.
	 */
	static inScope(catalog: Catalog, scope: {kind: 'series' | 'author'; name: string} | null): Book[] {
		return scope ? catalog.books.filter(Comparison.scope(scope.kind, scope.name)) : catalog.books;
	}

	/**
	 * Whether a series or an author (`part`) named so on the other catalog is the one asked for, spelled any
	 * way Comparison.scope takes as the same.
	 */
	static sameName(part: ShelfPart): (name: unknown) => boolean {
		const norm = part.kind === 'series' ? Series.norm : Text.norm,
			wanted = norm(part.name);
		return name => typeof name === 'string' && Boolean(Text.tidy(name)) && norm(Text.tidy(name)) === wanted;
	}
}
