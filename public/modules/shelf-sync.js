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
/** @import {Book} from './book.js' */
/** @import {Catalog, NamedKind} from './catalog.js' */
/** @import {MergeOptions} from './merger.js' */
/** @import {ComparisonResult} from './comparison.js' */
/** @import {Step} from './catalog-client.js' */

/** @typedef {{kind: 'series' | 'author', name: string, id?: string}} ShelfPart a series or an author, and its id on the other catalog when it has one */
/** @typedef {{kind: NamedKind, name: string, id: string}} InfoId an id found on the other catalog for a series or person of yours */
/**
 * One entry of a plan: your books that are one book there (a box set's titles may be), with the dates read
 * to send (on a catalog that takes them).
 * @typedef {{books: Book[], dates?: string[]}} PlanEntry
 */
/**
 * What sending to a catalog would do (planned by compare()): the books to put on your Read shelf (`name`, as
 * the catalog shows it), the reads to add to books already there, those on another shelf there (left alone),
 * those it doesn't have, and dates read it can't take.
 * @typedef {object} SyncPlan
 * @property {string} name
 * @property {PlanEntry[]} add
 * @property {PlanEntry[]} reads
 * @property {[Book, string][]} otherShelf
 * @property {Book[]} unknown
 * @property {[Book, string][]} inexact
 */
/**
 * Your shelves on a catalog beside the catalog (compare()).
 * @typedef {object} ShelfComparison
 * @property {ComparisonResult} comparison the books on your Read shelf beside the catalog's
 * @property {Book[]} incoming the books on your Read shelf compared (those in the scope asked for)
 * @property {MergeOptions} opts how they are imported (Comparison.apply() takes them)
 * @property {string[]} warnings
 * @property {unknown} found what the catalog has for your books; the subclass's addIds() gives their ids
 * @property {Book[]} idsFound the books that gain an id there, in the comparison's merged copy
 * @property {InfoId[]} infoIds the series and people that gain an id there
 * @property {SyncPlan | null} plan what putting your books there would do; null when it can't be known (no key)
 * @property {string[]} missing the series' books there that aren't in the catalog (a series only)
 */
/** @typedef {{shelved: number, reads: number, problems: string[]}} Sent what sending one entry of a plan did */
/** @typedef {'add' | 'reads'} PlanGroup */

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

	/** @param {CatalogClient} client */
	constructor(client){
		this.client = client;
	}

	/** @returns {typeof ShelfSync} the sync's class, with what it says of its catalog */
	get kind(){ return /** @type {typeof ShelfSync} */ (this.constructor); }

	/** @returns {string} its catalog's name, as the page says it */
	get label(){ return this.kind.CLIENT.LABEL; }

	/**
	 * A series or an author of `catalog` to compare, with the id its info has on this catalog (when it is one
	 * of the catalog's ids: a name kept from a page's address is not).
	 * @param {Catalog} catalog
	 * @param {'series' | 'author'} kind
	 * @param {string} name
	 * @returns {ShelfPart}
	 */
	static part(catalog, kind, name){
		const key = kind === 'series' ? 'series' : 'authors';
		const id = catalog.nameIds[key].get(name);
		const info = id === undefined ? undefined : catalog.infoMap(key).get(id);
		const there = info && info.external[this.CLIENT.CATALOG];
		return {kind, name, ...there && this.CLIENT.ID.test(there) ? {id: there} : {}};
	}

	/**
	 * Your shelves beside `catalog` (not changed), for every book or, with `part`, only a series' or an
	 * author's. Only reads the other catalog; `step(text, done, total)` hears how far it has got.
	 * @param {Catalog} _catalog
	 * @param {Step} _step
	 * @param {ShelfPart} [_part]
	 * @returns {Promise<ShelfComparison>}
	 */
	async compare(_catalog, _step, _part){
		throw new Error(`${this.label}: compare is not written`);
	}

	/**
	 * What a comparison's first line says it read: how many books on either side, for `scope` (the series or
	 * author compared) or for every book of `catalog`.
	 * @param {ShelfComparison} _result
	 * @param {Catalog} _catalog
	 * @param {{kind: 'series' | 'author', name: string, label: string} | null} _scope
	 * @returns {string}
	 */
	summary(_result, _catalog, _scope){
		throw new Error(`${this.label}: summary is not written`);
	}

	/**
	 * Send one entry of a plan: put its book on your Read shelf (`add`), or add its reads (`reads`). A problem
	 * the catalog answers is in what it gives; it throws when the catalog can't be asked.
	 * @param {PlanEntry} _entry
	 * @param {SyncPlan} _plan
	 * @param {PlanGroup} _group
	 * @returns {Promise<Sent>}
	 */
	async send(_entry, _plan, _group){
		throw new Error(`${this.label}: send is not written`);
	}

	/**
	 * What the comparison says of the `count` books it can't add, as it can't tell which edition is yours.
	 * @param {number} count
	 * @returns {string}
	 */
	static notAdded(count){
		return `Not added, as ${this.CLIENT.LABEL} can't tell which edition is yours: ${count}`;
	}

	/**
	 * Give `books` the ids found for them (`found`, a comparison's), only where they have none. Changes `books`
	 * in place; returns those that gained an id.
	 * @param {Book[]} _books
	 * @param {unknown} _found
	 * @returns {Book[]}
	 */
	static addIds(_books, _found){
		throw new Error(`${this.CLIENT.LABEL}: addIds is not written`);
	}

	/**
	 * Give the catalog's series and people the ids found (a comparison's infoIds), where they have none yet.
	 * @param {Catalog} _catalog changed in place
	 * @param {InfoId[]} _found
	 * @returns {number} how many gained one
	 */
	static setInfoIds(_catalog, _found){
		return 0;
	}

	/**
	 * Carry out a plan (or the part of it picked): put its `add` books on your Read shelf, and add its `reads`.
	 * Stops after STOP_AFTER entries in a row fail. Returns a promise of the exit code.
	 * @param {SyncPlan} plan
	 * @param {(line: string) => void} out
	 * @param {(line: string) => void} err
	 * @param {Step} step
	 * @returns {Promise<number>}
	 */
	async push(plan, out, err, step){
		const label = this.label, reads = this.kind.SENDS_READS;
		const done = {shelved: 0, reads: 0};
		/** @type {string[]} */
		const problems = [];
		/** @type {[PlanGroup, string][]} */
		const groups = [['add', `Putting books on your ${label} ${plan.name} shelf`], ['reads', `Adding reads to books on your ${plan.name} shelf`]];
		const total = plan.add.length + plan.reads.length;
		let at = 0, failed = 0;
		for(const [group, doing] of groups){
			for(const entry of plan[group]){
				step(doing, at++, total);
				try{
					const sent = await this.send(entry, plan, group);
					done.shelved += sent.shelved;
					done.reads += sent.reads;
					problems.push(...sent.problems);
					failed = 0;
				}catch(exc){
					problems.push(`${entry.books[0].title}: not added (${Text.errorText(exc)})`);
					if(++failed >= this.kind.STOP_AFTER){
						err(`error: ${Text.errorText(exc)}; stopped after putting ${done.shelved} book(s) on ${label}${reads ? ` and adding ${done.reads} read(s)` : ''}. ` +
							'Run it again to carry on: what is already there is not added twice.');
						return 1;
					}
				}
			}
		}
		out(`put ${done.shelved} book(s) on your ${label} ${plan.name} shelf${reads ? ` and added ${done.reads} read(s)` : ''}`);
		for(const p of problems.slice(0, 15)) out('    ! ' + p);
		return problems.length ? 1 : 0;
	}

	/**
	 * The books of `catalog` in `scope` (a series or an author), or every book for none.
	 * @param {Catalog} catalog
	 * @param {{kind: 'series' | 'author', name: string} | null} scope
	 * @returns {Book[]}
	 */
	static inScope(catalog, scope){
		return scope ? catalog.books.filter(Comparison.scope(scope.kind, scope.name)) : catalog.books;
	}

	/**
	 * Whether a series or an author (`part`) named so on the other catalog is the one asked for, spelled any
	 * way Comparison.scope takes as the same.
	 * @param {ShelfPart} part
	 * @returns {(name: unknown) => boolean}
	 */
	static sameName(part){
		const norm = part.kind === 'series' ? Series.norm : Text.norm, wanted = norm(part.name);
		return name => typeof name === 'string' && Boolean(Text.tidy(name)) && norm(Text.tidy(name)) === wanted;
	}
}
