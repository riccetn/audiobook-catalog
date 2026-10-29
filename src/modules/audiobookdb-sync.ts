// Your AudiobookDB shelves beside the catalog, and putting books on your Read shelf there. AudiobookDB is only
// ever reached through an AudiobookdbClient (through the catalog proxy), and the catalog is never changed
// here. AudiobookDB's shelves hold books, not releases, and no dates read, ratings or reviews; everything in the
// catalog counts as read, so it all belongs on your Read shelf. Sending only adds: nothing is taken off a
// shelf, no shelf is made, and AudiobookDB's own catalog is never edited. The reading of answers and the
// planning are static, so the tests run them offline.
import {Text} from './text.js';
import {Book} from './book.js';
import {Series} from './series.js';
import {Contributor} from './contributor.js';
import {Comparison} from './comparison.js';
import {Cover} from './cover.js';
import {AudiobookdbSource} from './audiobookdb-source.js';
import {AudiobookdbClient} from './audiobookdb-client.js';
import {ShelfSync} from './shelf-sync.js';
import type {Unchecked} from './text.js';
import type {Step} from './catalog-client.js';
import type {ShelfPart, InfoId, PlanEntry, Sent} from './shelf-sync.js';
import type {AudiobookdbShelf} from './audiobookdb-client.js';
import {Catalog} from './catalog.js';
import type {NamedKind} from './catalog.js';
import type {MergeOptions} from './merger.js';
import type {ComparisonResult} from './comparison.js';

/**
 * What AudiobookDB has for your books: by ASIN, the AudiobookDB book and release it is; by AudiobookDB
 * book id, the book as AudiobookDB answers it (people, series, releases).
 */
export type AudiobookdbFound = {
	asin: Map<string, {book: string; release: string | null}>;
	books: Map<string, Unchecked>;
};
/**
 * What an export to AudiobookDB would do (AudiobookdbSync.planExport()): the books to put on your Read shelf
 * (`shelf`, its slug, and `name`, as AudiobookDB shows it: *Listened*), those on another of its own shelves (left alone), and those AudiobookDB doesn't have.
 */
export interface AudiobookdbPlan {
	shelf: string;
	name: string;
	add: {book: string; books: Book[]}[];
	/** none: AudiobookDB keeps no dates read */
	reads: never[];
	otherShelf: [Book, string][];
	unknown: Book[];
	/** none */
	inexact: never[];
}
/** Your AudiobookDB shelves beside the catalog (AudiobookdbSync.compare()). */
export interface AudiobookdbComparison {
	/** the books on your Read shelf beside the catalog's */
	comparison: ComparisonResult;
	/** the books on your Read shelf compared (those in the scope asked for) */
	incoming: Book[];
	/** how they are imported (Comparison.apply() takes them) */
	opts: MergeOptions;
	warnings: string[];
	/** what AudiobookDB has for your books (addIds() gives their ids) */
	found: AudiobookdbFound;
	/** the books that gain an AudiobookDB id or cover, in the comparison's merged copy */
	idsFound: Book[];
	/** the series and people that gain an AudiobookDB id */
	infoIds: InfoId[];
	/** what putting your books on AudiobookDB would do; null without your key */
	plan: AudiobookdbPlan | null;
	/** how many books your Read shelf has (in the scope asked for); null without your key */
	onShelf: number | null;
	/** the series' books on AudiobookDB that aren't in the catalog (a series only) */
	missing: string[];
	/** none: AudiobookDB lists only audiobooks */
	notAudio: never[];
}

const tidyText: (x: unknown) => string = x => (typeof x === 'string' ? Text.tidy(x) : '');
const list: (x: unknown) => Unchecked[] = x => (Array.isArray(x) ? x.filter(Text.isObject) : []);

/** Compares the catalog with your AudiobookDB shelves, and puts books on your Read shelf there. */
export class AudiobookdbSync extends ShelfSync {
	static CLIENT = AudiobookdbClient;
	static NOT_FOUND =
		'No ASIN AudiobookDB knows: give the book its AudiobookDB id in its edit form, or add it on audiobookdb.org.';
	static FOUND = 'ids and covers';

	// The client is its own catalog's, with what that catalog asks.
	declare client: AudiobookdbClient;

	constructor(client: AudiobookdbClient) {
		super(client);
		this.client = client;
	}

	/**
	 * Your AudiobookDB shelves beside `catalog` (not changed): your books are found on AudiobookDB (by their
	 * AudiobookDB id, else by an ASIN), and with your API key the books on your Read shelf are compared with
	 * the catalog's as an import would take them, and planned to go there. With `part` (a series or an author,
	 * with its AudiobookDB id when you gave it one), only its books on either side are read and compared.
	 * Only reads AudiobookDB; `step(text, done, total)` hears how far it has got.
	 */
	async compare(catalog: Catalog, step: Step, part?: ShelfPart): Promise<AudiobookdbComparison> {
		const client = this.client;
		const scope = part ? Comparison.scope(part.kind, part.name) : () => true;
		const mine = catalog.books.filter(scope).map(b => b.clone());
		const found = await this.find(mine, step);
		AudiobookdbSync.addIds(mine, found);
		const myIds = new Set(mine.map(b => b.idOn('audiobookdb')).filter(id => typeof id === 'string'));
		let shelves: AudiobookdbShelf[] | null = null;
		if (client.key) {
			step('Reading your AudiobookDB shelves');
			shelves = await client.shelves();
		}
		const read = shelves ? AudiobookdbSync.readShelf(shelves) : null;
		let wanted = read ? read.books : [];
		const missing: string[] = [];
		if (part) {
			const id = AudiobookdbSync.partId(part, mine, found);
			let theirs: Unchecked[] = [];
			if (id) {
				step(`Reading ${part.kind === 'series' ? 'the series' : 'the author'} ${part.name} on AudiobookDB`);
				const answer = part.kind === 'series' ? await client.series(id) : await client.person(id);
				theirs = answer
					? list(
							part.kind === 'series'
								? answer.books
								: list(answer.roles).filter(r => Text.isObject(r.role) && r.role.name === 'Author'),
						)
							.map(x => x.book)
							.filter(Text.isObject)
					: [];
			}
			const inPart = new Set(theirs.map(b => b.id));
			const author = Text.norm(part.name);
			wanted = wanted.filter(
				sb =>
					myIds.has(sb.id) ||
					inPart.has(sb.id) ||
					(part.kind === 'author' &&
						AudiobookdbSync.people(sb.people, 'Author').some(n => Text.norm(n) === author)),
			);
			if (part.kind === 'series') {
				const shelved = new Set(wanted.map(sb => sb.id));
				for (const b of theirs)
					if (!myIds.has(b.id) && !shelved.has(b.id) && tidyText(b.title)) missing.push(tidyText(b.title));
			}
		}
		const details = await AudiobookdbClient.each(
			wanted.filter(sb => typeof sb.id === 'string'),
			'Reading the books on your Read shelf',
			step,
			async sb => found.books.get(sb.id) || (await client.book(sb.id)),
		);
		const warnings: string[] = [];
		const incoming: Book[] = [];
		details.forEach((detail, i) => {
			if (detail) found.books.set(detail.id, detail);
			const book = detail && AudiobookdbSync.incoming(detail, mine);
			if (book) incoming.push(book);
			else
				warnings.push(
					`AudiobookDB book ${wanted[i].id}${tidyText(wanted[i].title) ? ` (${tidyText(wanted[i].title)})` : ''}: not found, or no title or author, skipped`,
				);
		});
		const inScope = part ? incoming.filter(b => scope(b) || myIds.has(b.idOn('audiobookdb') as string)) : incoming;
		const opts: MergeOptions = {addable: book => book.editions.length > 0};
		const comparison = Comparison.compare(catalog, inScope, opts);
		const books = comparison.merged.books.filter(scope);
		const idsFound = AudiobookdbSync.addIds(books, found);
		const infoIds = AudiobookdbSync.infoIds(catalog, books, found, comparison.report.added);
		const plan = shelves && read ? AudiobookdbSync.planExport(books, shelves, read) : null;
		return {
			comparison,
			incoming: inScope,
			opts,
			warnings,
			found,
			idsFound,
			infoIds,
			plan,
			onShelf: read ? wanted.length : null,
			missing,
			notAudio: [],
		};
	}

	static notAdded(count: number): string {
		return `Not added, as AudiobookDB has several releases of them and none is yours: ${count}. Add them from the book form with your release's address.`;
	}

	/**
	 * What a comparison's first line says it read.
	 */
	summary(
		result: AudiobookdbComparison,
		catalog: Catalog,
		scope: {kind: 'series' | 'author'; name: string; label: string} | null,
	): string {
		const here = ShelfSync.inScope(catalog, scope).length;
		// the catalog's own books come first in the comparison's merged copy, with the ids found
		const mine = result.comparison.merged.books.slice(0, catalog.books.length);
		const found = (scope ? mine.filter(Comparison.scope(scope.kind, scope.name)) : mine).filter(b =>
			b.idOn('audiobookdb'),
		).length;
		const shelf =
			result.onShelf === null
				? ''
				: `, ${Text.plural(result.onShelf, 'book')} on your AudiobookDB ${result.plan ? result.plan.name : 'Read'} shelf`;
		return `${scope ? `Only ${scope.label}: ` : ''}${Text.plural(here, 'book')} in this catalog, ${found} of them on AudiobookDB${shelf}`;
	}

	/**
	 * What AudiobookDB has for `books`: a book without an AudiobookDB id is looked up by its own editions'
	 * ASINs (a box set's edition finds the box set, not the title); a book with one, whose editions lack
	 * their release ids or covers, is read.
	 */
	async find(books: Book[], step: Step): Promise<AudiobookdbFound> {
		const found: AudiobookdbFound = {asin: new Map(), books: new Map()};
		const shared = Book.sharedEditionTest(books);
		const unknown = books.filter(
			b => !b.idOn('audiobookdb') && b.editions.some(ed => !shared(ed) && ed.ids('asin').length),
		);
		const known = [
			...new Set(
				books
					.filter(
						b =>
							b.idOn('audiobookdb') &&
							b.editions.some(ed => !ed.idOn('audiobookdb') || !ed.covers.audiobookdb),
					)
					.map(b => b.idOn('audiobookdb') as string),
			),
		];
		const asked = new Set();
		await AudiobookdbClient.each(unknown, 'Finding your books on AudiobookDB', step, async b => {
			for (const asin of b.editions.filter(ed => !shared(ed)).flatMap(ed => ed.ids('asin'))) {
				if (asked.has(asin)) continue;
				asked.add(asin);
				const book = await this.client.byAsin(asin);
				if (!book || typeof book.id !== 'string') continue;
				found.asin.set(asin, {
					book: book.id,
					release: typeof book.matchedReleaseId === 'string' ? book.matchedReleaseId : null,
				});
				found.books.set(book.id, book);
				return;
			}
		});
		await AudiobookdbClient.each(known, 'Reading your books on AudiobookDB', step, async id => {
			const book = await this.client.book(id);
			if (book) found.books.set(id, book);
		});
		return found;
	}

	/**
	 * Send one entry of planExport()'s plan to AudiobookDB: put its book on your Read shelf.
	 */
	async send(entry: PlanEntry, plan: AudiobookdbPlan): Promise<Sent> {
		await this.client.addToShelf(plan.shelf, (entry as AudiobookdbPlan['add'][number]).book);
		return {shelved: 1, reads: 0, problems: []};
	}

	// ------------------------------------------------------------ reading answers
	/**
	 * Names from an AudiobookDB people list ({role: {name}, person: {name}}), those with `role`.
	 */
	static people(people: unknown, role: string): string[] {
		return [
			...new Set(
				list(people)
					.filter(p => Text.isObject(p.role) && p.role.name === role && Text.isObject(p.person))
					.map(p => tidyText(p.person.name))
					.filter(Boolean),
			),
		];
	}

	/**
	 * Your Read shelf among your shelves: AudiobookDB's own shelf named Read (or Finished, or Listened).
	 */
	static readShelf(shelves: AudiobookdbShelf[]): AudiobookdbShelf {
		const named = (s: AudiobookdbShelf, re: RegExp) => re.test(s.slug) || re.test(tidyText(s.name));
		const read =
			shelves.find(s => s.isDefault && named(s, /^read$/i)) ||
			shelves.find(s => s.isDefault && named(s, /^(finished|listened)$/i)) ||
			shelves.find(s => named(s, /^read$/i));
		if (!read)
			throw new Error(
				`AudiobookDB has no Read shelf of yours (your shelves: ${shelves.map(s => tidyText(s.name) || s.slug).join(', ') || 'none'})`,
			);
		return read;
	}

	/**
	 * The AudiobookDB id of a series or an author: the one given, else the one AudiobookDB gives it on your
	 * books of it it has (named the same, as Comparison.scope compares names); null when there is none.
	 * @param books your books of it
	 */
	static partId(part: ShelfPart, books: Book[], found: AudiobookdbFound): string | null {
		if (part.id && AudiobookdbClient.ID.test(part.id)) return part.id;
		const same = ShelfSync.sameName(part);
		for (const b of books) {
			const detail = found.books.get(b.idOn('audiobookdb') || '');
			if (!detail) continue;
			const rows =
				part.kind === 'series'
					? list(detail.series)
							.map(s => s.series)
							.filter(Text.isObject)
							.map(s => ({id: s.id, name: s.title}))
					: list(detail.people)
							.filter(p => Text.isObject(p.role) && p.role.name === 'Author')
							.map(p => p.person)
							.filter(Text.isObject);
			for (const row of rows) {
				const named = tidyText(row.name);
				if (typeof row.id === 'string' && same(named)) return row.id;
			}
		}
		return null;
	}

	/**
	 * A book on your Read shelf as an import takes it: AudiobookDB's book, with the release that is an edition
	 * of yours of it (by its release id or ASIN; the ASIN is put under your edition's site, as AudiobookDB
	 * doesn't say which it is), else its one release; with several releases and none of yours, none, as it
	 * can't tell which is yours. null when it has no title or author.
	 * @param mine your books, with the AudiobookDB ids found
	 */
	static incoming(detail: Unchecked, mine: Book[]): Book | null {
		const releases = list(detail.releases);
		let release: Unchecked | null = releases.length === 1 ? releases[0] : null;
		let asin: [string, string] | null = null;
		for (const b of mine.filter(x => x.idOn('audiobookdb') === detail.id)) {
			for (const ed of b.editions) {
				const hit =
					releases.find(r => r.id === ed.idOn('audiobookdb')) ||
					releases.find(r => AudiobookdbClient.asins(r).some(a => ed.ids('asin').includes(a)));
				if (!hit) continue;
				release = hit;
				const site = Object.keys(ed.external).find(
					k =>
						ed.ids('asin').includes(ed.external[k]) &&
						AudiobookdbClient.asins(hit).includes(ed.external[k]),
				);
				asin = site ? [site, ed.external[site]] : null;
				break;
			}
			if (release && releases.length > 1) break;
		}
		const book = AudiobookdbSource.book(detail, release);
		if (!book.title || !book.authors.length) return null;
		if (asin && book.editions[0]) book.editions[0].external = {[asin[0]]: asin[1], ...book.editions[0].external};
		return book;
	}

	/**
	 * Give your books and editions the AudiobookDB ids found for them (`found`): a book without one gets that
	 * of the book an edition of its own is on AudiobookDB, and each edition the id of the release it is (by
	 * its ASIN), when that release is of the book's own AudiobookDB book (a box set's edition is on its
	 * titles, but is the box set's release), and each edition with a release id that release's cover (else the
	 * book's). Only empty values are filled. Changes `books` in place; returns those that gained an id or a cover.
	 */
	static addIds(books: Book[], found: AudiobookdbFound): Book[] {
		const filled = [],
			shared = Book.sharedEditionTest(books);
		for (const b of books) {
			let gained = false;
			if (!b.idOn('audiobookdb')) {
				const hit = b.editions
					.filter(ed => !shared(ed))
					.flatMap(ed => ed.ids('asin'))
					.map(a => found.asin.get(a))
					.find(Boolean);
				if (hit) {
					b.external = {...b.external, audiobookdb: hit.book};
					gained = true;
				}
			}
			const detail = found.books.get(b.idOn('audiobookdb') || '');
			if (detail) {
				const releases = list(detail.releases);
				for (const ed of b.editions.filter(x => !x.idOn('audiobookdb'))) {
					const asins = ed.ids('asin');
					const byAsin = asins.map(a => found.asin.get(a)).find(h => h && h.book === detail.id && h.release);
					const release = byAsin
						? byAsin.release
						: releases.find(r => AudiobookdbClient.asins(r).some(a => asins.includes(a)))?.id;
					if (typeof release === 'string' && release) {
						ed.external = {...ed.external, audiobookdb: release};
						for (const copy of books
							.flatMap(x => x.editions)
							.filter(x => x !== ed && x.sameAs(ed) && !x.idOn('audiobookdb')))
							copy.external = {...copy.external, audiobookdb: release};
						gained = true;
					}
				}
				for (const ed of b.editions.filter(x => x.idOn('audiobookdb') && !x.covers.audiobookdb)) {
					const release = releases.find(r => r.id === ed.idOn('audiobookdb'));
					const cover =
						release && (Cover.audiobookdbKey(release.images) || Cover.audiobookdbKey(detail.images));
					if (!cover) continue;
					for (const x of [
						ed,
						...books
							.flatMap(y => y.editions)
							.filter(y => y !== ed && y.sameAs(ed) && !y.covers.audiobookdb),
					])
						x.covers = {...x.covers, audiobookdb: cover};
					gained = true;
				}
			}
			if (gained) filled.push(b);
		}
		return filled;
	}

	/**
	 * The AudiobookDB ids of the series and people on `books` (with the ids found) that the catalog has
	 * none for: those AudiobookDB names the same on the same book (an author, the series) or release (a
	 * narrator, the publisher). Only names the catalog has, or the books it would add (`added`) have: a
	 * name only on an edition left out stays out.
	 */
	static infoIds(catalog: Catalog, books: Book[], found: AudiobookdbFound, added: Book[] = []): InfoId[] {
		const ids: Map<string, InfoId> = new Map();
		const named: Map<NamedKind, Set<string>> = new Map();
		const namesOf: (kind: NamedKind) => Set<string> = kind =>
			named.get(kind) ||
			named.set(kind, new Set([...catalog.namesOf(kind), ...added.flatMap(Catalog.namesOn(kind))])).get(kind) ||
			new Set();
		const take: (
			kind: NamedKind,
			name: string | undefined,
			rows: Unchecked[],
			norm: (n: string) => string,
		) => void = (kind, name, rows, norm) => {
			if (!name || ids.has(`${kind}\n${name}`) || !namesOf(kind).has(name)) return;
			const id = catalog.nameIds[kind].get(name);
			const info = id === undefined ? undefined : catalog.infoMap(kind).get(id);
			if (info && info.external.audiobookdb) return;
			const row = rows.find(
				r =>
					typeof r.id === 'string' &&
					AudiobookdbClient.ID.test(r.id) &&
					norm(tidyText(r.name)) === norm(name),
			);
			if (row) ids.set(`${kind}\n${name}`, {kind, name, id: row.id});
		};
		const persons: (people: unknown, role: string) => Unchecked[] = (people, role) =>
			list(people)
				.filter(p => Text.isObject(p.role) && p.role.name === role)
				.map(p => p.person)
				.filter(Text.isObject);
		for (const b of books) {
			const detail = found.books.get(b.idOn('audiobookdb') || '');
			if (!detail) continue;
			for (const a of b.authors) take('authors', a, persons(detail.people, 'Author'), Text.norm);
			take(
				'series',
				b.series || undefined,
				list(detail.series)
					.map(s => s.series)
					.filter(Text.isObject)
					.map(s => ({id: s.id, name: s.title})),
				Series.norm,
			);
			for (const ed of b.editions) {
				const release = list(detail.releases).find(r => r.id === ed.idOn('audiobookdb'));
				if (!release) continue;
				for (const n of ed.narrators) take('narrators', n, persons(release.people, 'Narrator'), Text.norm);
				take(
					'publishers',
					ed.publisher || undefined,
					Text.isObject(release.publisher) ? [release.publisher] : [],
					Text.norm,
				);
			}
		}
		return [...ids.values()];
	}

	/**
	 * Give the catalog's series and people the AudiobookDB ids found (infoIds), where they have none yet and
	 * the catalog has them (on its books, or with info).
	 * @param catalog changed in place
	 * @returns how many gained one
	 */
	static setInfoIds(catalog: Catalog, found: InfoId[]): number {
		let n = 0;
		for (const {kind, name, id} of found) {
			if (!catalog.namesOf(kind).has(name)) continue;
			const key = catalog.idFor(kind, name),
				map = catalog.infoMap(kind);
			const info = map.get(key) || (kind === 'series' ? new Series(name) : new Contributor(name));
			if (info.external.audiobookdb) continue;
			info.external = {...info.external, audiobookdb: id};
			map.set(key, info);
			n++;
		}
		return n;
	}

	// --------------------------------------------------------------- the export
	/**
	 * What an export to AudiobookDB would do: each of your books (everything in the catalog counts as read)
	 * goes on your Read shelf as its AudiobookDB book, unless it is there already. A book on another of the
	 * shelves that hold a book on one of them only (exclusive: To Listen, Currently Listening) is left alone, as
	 * putting it on Read would take it off that one; the others (Favorites, your own) don't count. Books without an AudiobookDB id are listed as unknown.
	 */
	static planExport(books: Book[], shelves: AudiobookdbShelf[], read: AudiobookdbShelf): AudiobookdbPlan {
		const plan: AudiobookdbPlan = {
			shelf: read.slug,
			name: tidyText(read.name) || read.slug,
			add: [],
			reads: [],
			otherShelf: [],
			unknown: [],
			inexact: [],
		};
		const onRead = new Set(list(read.books).map(b => b.id));
		const elsewhere: Map<unknown, string> = new Map();
		for (const s of shelves)
			if (s !== read && s.isExclusive)
				for (const b of list(s.books))
					if (!elsewhere.has(b.id)) elsewhere.set(b.id, tidyText(s.name) || s.slug);
		const wanted: Map<string, Book[]> = new Map();
		for (const b of books) {
			const id = b.idOn('audiobookdb');
			if (!id) {
				plan.unknown.push(b);
				continue;
			}
			if (onRead.has(id)) continue;
			const other = elsewhere.get(id);
			if (other) {
				plan.otherShelf.push([b, other]);
				continue;
			}
			wanted.set(id, [...(wanted.get(id) || []), b]);
		}
		for (const [book, of] of wanted) plan.add.push({book, books: of});
		return plan;
	}
}
