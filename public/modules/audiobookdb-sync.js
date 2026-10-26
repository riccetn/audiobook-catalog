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
/** @import {Unchecked} from './text.js' */
/** @import {Step} from './catalog-client.js' */
/** @import {ShelfPart, InfoId, PlanEntry, Sent} from './shelf-sync.js' */
/** @import {AudiobookdbShelf} from './audiobookdb-client.js' */
import {Catalog} from './catalog.js';
/** @import {NamedKind} from './catalog.js' */
/** @import {MergeOptions} from './merger.js' */
/** @import {ComparisonResult} from './comparison.js' */

/**
 * What AudiobookDB has for your books: by ASIN, the AudiobookDB book and release it is; by AudiobookDB
 * book id, the book as AudiobookDB answers it (people, series, releases).
 * @typedef {{asin: Map<string, {book: string, release: string | null}>, books: Map<string, Unchecked>}} AudiobookdbFound
 */
/**
 * What an export to AudiobookDB would do (AudiobookdbSync.planExport()): the books to put on your Read shelf
 * (`shelf`, its slug, and `name`, as AudiobookDB shows it: *Listened*), those on another of its own shelves (left alone), and those AudiobookDB doesn't have.
 * @typedef {object} AudiobookdbPlan
 * @property {string} shelf
 * @property {string} name
 * @property {{book: string, books: Book[]}[]} add
 * @property {never[]} reads none: AudiobookDB keeps no dates read
 * @property {[Book, string][]} otherShelf
 * @property {Book[]} unknown
 * @property {never[]} inexact none
 */
/**
 * Your AudiobookDB shelves beside the catalog (AudiobookdbSync.compare()).
 * @typedef {object} AudiobookdbComparison
 * @property {ComparisonResult} comparison the books on your Read shelf beside the catalog's
 * @property {Book[]} incoming the books on your Read shelf compared (those in the scope asked for)
 * @property {MergeOptions} opts how they are imported (Comparison.apply() takes them)
 * @property {string[]} warnings
 * @property {AudiobookdbFound} found what AudiobookDB has for your books (addIds() gives their ids)
 * @property {Book[]} idsFound the books that gain an AudiobookDB id or cover, in the comparison's merged copy
 * @property {InfoId[]} infoIds the series and people that gain an AudiobookDB id
 * @property {AudiobookdbPlan | null} plan what putting your books on AudiobookDB would do; null without your key
 * @property {number | null} onShelf how many books your Read shelf has (in the scope asked for); null without your key
 * @property {string[]} missing the series' books on AudiobookDB that aren't in the catalog (a series only)
 * @property {never[]} notAudio none: AudiobookDB lists only audiobooks
 */

/** @type {(x: unknown) => string} */
const tidyText = x => (typeof x === 'string' ? Text.tidy(x) : '');
/** @type {(x: unknown) => Unchecked[]} */
const list = x => (Array.isArray(x) ? x.filter(Text.isObject) : []);

/** Compares the catalog with your AudiobookDB shelves, and puts books on your Read shelf there. */
export class AudiobookdbSync extends ShelfSync {
	static CLIENT = AudiobookdbClient;
	static NOT_FOUND =
		'No ASIN AudiobookDB knows: give the book its AudiobookDB id in its edit form, or add it on audiobookdb.org.';
	static FOUND = 'ids and covers';

	/** @param {AudiobookdbClient} client */
	constructor(client) {
		super(client);
		this.client = client;
	}

	/**
	 * Your AudiobookDB shelves beside `catalog` (not changed): your books are found on AudiobookDB (by their
	 * AudiobookDB id, else by an ASIN), and with your API key the books on your Read shelf are compared with
	 * the catalog's as an import would take them, and planned to go there. With `part` (a series or an author,
	 * with its AudiobookDB id when you gave it one), only its books on either side are read and compared.
	 * Only reads AudiobookDB; `step(text, done, total)` hears how far it has got.
	 * @param {Catalog} catalog
	 * @param {Step} step
	 * @param {ShelfPart} [part]
	 * @returns {Promise<AudiobookdbComparison>}
	 */
	async compare(catalog, step, part) {
		const client = this.client;
		const scope = part ? Comparison.scope(part.kind, part.name) : () => true;
		const mine = catalog.books.filter(scope).map(b => b.clone());
		const found = await this.find(mine, step);
		AudiobookdbSync.addIds(mine, found);
		const myIds = new Set(mine.map(b => b.idOn('audiobookdb')).filter(id => typeof id === 'string'));
		/** @type {AudiobookdbShelf[] | null} */
		let shelves = null;
		if (client.key) {
			step('Reading your AudiobookDB shelves');
			shelves = await client.shelves();
		}
		const read = shelves ? AudiobookdbSync.readShelf(shelves) : null;
		let wanted = read ? read.books : [];
		/** @type {string[]} */
		const missing = [];
		if (part) {
			const id = AudiobookdbSync.partId(part, mine, found);
			/** @type {Unchecked[]} */
			let theirs = [];
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
		/** @type {string[]} */
		const warnings = [];
		/** @type {Book[]} */
		const incoming = [];
		details.forEach((detail, i) => {
			if (detail) found.books.set(detail.id, detail);
			const book = detail && AudiobookdbSync.incoming(detail, mine);
			if (book) incoming.push(book);
			else
				warnings.push(
					`AudiobookDB book ${wanted[i].id}${tidyText(wanted[i].title) ? ` (${tidyText(wanted[i].title)})` : ''}: not found, or no title or author, skipped`,
				);
		});
		const inScope = part
			? incoming.filter(b => scope(b) || myIds.has(/** @type {string} */ (b.idOn('audiobookdb'))))
			: incoming;
		/** @type {MergeOptions} */
		const opts = {addable: book => book.editions.length > 0};
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

	/**
	 * @param {number} count
	 * @returns {string}
	 */
	static notAdded(count) {
		return `Not added, as AudiobookDB has several releases of them and none is yours: ${count}. Add them from the book form with your release's address.`;
	}

	/**
	 * What a comparison's first line says it read.
	 * @param {AudiobookdbComparison} result
	 * @param {Catalog} catalog
	 * @param {{kind: 'series' | 'author', name: string, label: string} | null} scope
	 * @returns {string}
	 */
	summary(result, catalog, scope) {
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
	 * @param {Book[]} books
	 * @param {Step} step
	 * @returns {Promise<AudiobookdbFound>}
	 */
	async find(books, step) {
		/** @type {AudiobookdbFound} */
		const found = {asin: new Map(), books: new Map()};
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
					.map(b => /** @type {string} */ (b.idOn('audiobookdb'))),
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
	 * @param {PlanEntry} entry
	 * @param {AudiobookdbPlan} plan
	 * @returns {Promise<Sent>}
	 */
	async send(entry, plan) {
		await this.client.addToShelf(plan.shelf, /** @type {AudiobookdbPlan['add'][number]} */ (entry).book);
		return {shelved: 1, reads: 0, problems: []};
	}

	// ------------------------------------------------------------ reading answers
	/**
	 * Names from an AudiobookDB people list ({role: {name}, person: {name}}), those with `role`.
	 * @param {unknown} people
	 * @param {string} role
	 * @returns {string[]}
	 */
	static people(people, role) {
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
	 * @param {AudiobookdbShelf[]} shelves
	 * @returns {AudiobookdbShelf}
	 */
	static readShelf(shelves) {
		const named = (/** @type {AudiobookdbShelf} */ s, /** @type {RegExp} */ re) =>
			re.test(s.slug) || re.test(tidyText(s.name));
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
	 * @param {ShelfPart} part
	 * @param {Book[]} books your books of it
	 * @param {AudiobookdbFound} found
	 * @returns {string | null}
	 */
	static partId(part, books, found) {
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
	 * @param {Unchecked} detail
	 * @param {Book[]} mine your books, with the AudiobookDB ids found
	 * @returns {Book | null}
	 */
	static incoming(detail, mine) {
		const releases = list(detail.releases);
		/** @type {Unchecked | null} */
		let release = releases.length === 1 ? releases[0] : null;
		/** @type {[string, string] | null} */
		let asin = null;
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
	 * @param {Book[]} books
	 * @param {AudiobookdbFound} found
	 * @returns {Book[]}
	 */
	static addIds(books, found) {
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
	 * @param {Catalog} catalog
	 * @param {Book[]} books
	 * @param {AudiobookdbFound} found
	 * @param {Book[]} [added]
	 * @returns {InfoId[]}
	 */
	static infoIds(catalog, books, found, added = []) {
		/** @type {Map<string, InfoId>} */
		const ids = new Map();
		/** @type {Map<NamedKind, Set<string>>} */
		const named = new Map();
		/** @type {(kind: NamedKind) => Set<string>} */
		const namesOf = kind =>
			named.get(kind) ||
			named.set(kind, new Set([...catalog.namesOf(kind), ...added.flatMap(Catalog.namesOn(kind))])).get(kind) ||
			new Set();
		/** @type {(kind: NamedKind, name: string | undefined, rows: Unchecked[], norm: (n: string) => string) => void} */
		const take = (kind, name, rows, norm) => {
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
		/** @type {(people: unknown, role: string) => Unchecked[]} */
		const persons = (people, role) =>
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
	 * @param {Catalog} catalog changed in place
	 * @param {InfoId[]} found
	 * @returns {number} how many gained one
	 */
	static setInfoIds(catalog, found) {
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
	 * @param {Book[]} books
	 * @param {AudiobookdbShelf[]} shelves
	 * @param {AudiobookdbShelf} read
	 * @returns {AudiobookdbPlan}
	 */
	static planExport(books, shelves, read) {
		/** @type {AudiobookdbPlan} */
		const plan = {
			shelf: read.slug,
			name: tidyText(read.name) || read.slug,
			add: [],
			reads: [],
			otherShelf: [],
			unknown: [],
			inexact: [],
		};
		const onRead = new Set(list(read.books).map(b => b.id));
		/** @type {Map<unknown, string>} */
		const elsewhere = new Map();
		for (const s of shelves)
			if (s !== read && s.isExclusive)
				for (const b of list(s.books))
					if (!elsewhere.has(b.id)) elsewhere.set(b.id, tidyText(s.name) || s.slug);
		/** @type {Map<string, Book[]>} */
		const wanted = new Map();
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
