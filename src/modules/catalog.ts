// The catalog itself: the books, the series info, the author info, the exclusions list and the "Not
// duplicates" marks, and what is done to them as a whole. Inside, an entry is known by the id it is stored
// under: a book by Book.id, a series or person by their id in nameIds (the books name them, so a name leads
// to its id), and their info and the marks by those ids. toJSON() writes it by name, as a version 1 backup has it
// ({books, seriesInfo, authors, narrators, publishers, excluded, notDuplicates, ids}), which the Check reads, and
// Backup.toCatalog() reads a backup of any version; Export writes version 3, the stored records (Backup.write).
// Reading backups, imports (Merger) and the Check (Validator) live in their own modules, so a page that only
// shows the catalog doesn't load them.
import {Book} from './book.js';
import {Series} from './series.js';
import {Contributor} from './contributor.js';
import {Edition} from './edition.js';
import {Exclusions} from './exclusions.js';
import {Duplicates} from './duplicates.js';
import {Text} from './text.js';
import type {ContributorKind} from './contributor.js';
import type {Backup} from './backup.js';
import type {Mark} from './duplicates.js';

/** what is known by its name on the books: a series, or an author, narrator or publisher */
export type NamedKind = 'series' | ContributorKind;
/**
 * The ids that series, authors, narrators and publishers are stored under, by name (as the books write it),
 * whether or not there is info about them. Each is an entry of its own: it stays when no book names it any
 * more, until it is removed (Catalog.removeEntry), and a series keeps its id when it is renamed (Catalog.renameEntry).
 */
export type NameIds = Record<NamedKind, Map<string, string>>;
// An edition's values without its id, for "is this copy the same edition?".
const editionValues: (ed: Edition) => string = ed => JSON.stringify(Edition.KEYS.map(k => ed.value(k)));

/**
 * The parts of a catalog; each may be left out. The info is given by name, as a backup has it; the
 * catalog keeps it by the id each name is stored under (from `nameIds`, else a new one).
 */
export interface CatalogInit {
	books?: Book[];
	/** series name (as the books' `series` have it) -> its info */
	series?: Map<string, Series>;
	/** author name (as the books' `authors` have it) -> their info */
	authors?: Map<string, Contributor>;
	/** narrator name (as the editions' `narrators` have it) -> their info */
	narrators?: Map<string, Contributor>;
	/** publisher name (as the editions' `publisher` has it) -> its info */
	publishers?: Map<string, Contributor>;
	/** the books imports must never re-add */
	exclusions?: Exclusions;
	/** "Not duplicates" (and "Keep separate") marks of the duplicates page, as text (Duplicates.textMark) */
	notDuplicates?: Iterable<string>;
	nameIds?: NameIds;
}

/** The catalog. */
export class Catalog {
	static NAMED_KINDS: NamedKind[] = ['series', ...Contributor.KINDS];

	/** @returns a new id */
	static newId(): string {
		return crypto.randomUUID();
	}

	books: Book[];
	nameIds: NameIds;
	/** series info, by the id of the series */
	series: Map<string, Series>;
	/** author info, by the author's id */
	authors: Map<string, Contributor>;
	/** narrator info, by the narrator's id */
	narrators: Map<string, Contributor>;
	/** publisher info, by the publisher's id */
	publishers: Map<string, Contributor>;
	exclusions: Exclusions;
	/** the duplicates page's marks, by their id */
	marks: Map<string, Mark>;

	constructor({
		books = [],
		series = new Map(),
		authors = new Map(),
		narrators = new Map(),
		publishers = new Map(),
		exclusions = new Exclusions(),
		notDuplicates = [],
		nameIds = Catalog.emptyNameIds(),
	}: CatalogInit = {}) {
		this.books = books;
		this.nameIds = Catalog.copyNameIds(nameIds);
		this.series = new Map();
		this.authors = new Map();
		this.narrators = new Map();
		this.publishers = new Map();
		for (const [name, info] of series) this.series.set(this.idFor('series', name), info);
		for (const [kind, byName] of [
			['authors', authors],
			['narrators', narrators],
			['publishers', publishers],
		] as [ContributorKind, Map<string, Contributor>][]) {
			for (const [name, info] of byName) this[kind].set(this.idFor(kind, name), info);
		}
		this.exclusions = exclusions;
		this.marks = new Map();
		for (const text of notDuplicates) {
			const mark = Duplicates.textMark(text);
			this.marks.set(mark.id, mark);
		}
	}

	/** @returns no ids yet */
	static emptyNameIds(): NameIds {
		return {series: new Map(), authors: new Map(), narrators: new Map(), publishers: new Map()};
	}

	/**
	 * A catalog made of a backup; what the backup lacks is empty.
	 */
	static fromBackup(backup: Backup): Catalog {
		const catalog = new Catalog({
			books: backup.books,
			series: backup.series || new Map(),
			authors: backup.authors || new Map(),
			narrators: backup.narrators || new Map(),
			publishers: backup.publishers || new Map(),
			exclusions: Exclusions.parse((backup.excluded || []).join('\n')),
			notDuplicates: backup.marks ? [] : backup.notDuplicates || [],
			nameIds: backup.nameIds || Catalog.emptyNameIds(),
		});
		// a version 2 backup's marks point at its books by id, as the catalog's do
		if (backup.marks) {
			catalog.addMarks(backup.marks.map(m => ({...m})));
			catalog.resolveMarks();
		}
		return catalog;
	}

	/**
	 * The catalog as a version 1 backup holds it, by name; `ids` (the ids of series and people by name) only when there are any.
	 */
	toJSON(): {
		books: Book[];
		seriesInfo: Record<string, Series>;
		authors: Record<string, Contributor>;
		narrators: Record<string, Contributor>;
		publishers: Record<string, Contributor>;
		excluded: string[];
		notDuplicates: string[];
		ids?: Record<NamedKind, Record<string, string>>;
	} {
		const json = {
			books: this.books,
			seriesInfo: Object.fromEntries(this.infoByName('series')),
			authors: Object.fromEntries(this.infoByName('authors')),
			narrators: Object.fromEntries(this.infoByName('narrators')),
			publishers: Object.fromEntries(this.infoByName('publishers')),
			excluded: this.exclusions.entries,
			notDuplicates: this.markTexts(),
		};
		if (!Catalog.NAMED_KINDS.some(kind => this.nameIds[kind].size)) return json;
		const ids = Object.fromEntries(
			Catalog.NAMED_KINDS.map(kind => [kind, Object.fromEntries(this.nameIds[kind])]),
		) as Record<NamedKind, Record<string, string>>;
		return {...json, ids};
	}

	/** @returns a copy, sharing nothing with this one */
	clone(): Catalog {
		const copy: (x: unknown) => unknown = x => JSON.parse(JSON.stringify(x));
		const out = new Catalog({
			books: this.books.map(b => b.clone()),
			exclusions: this.exclusions.clone(),
			nameIds: this.nameIds,
		});
		for (const [id, s] of this.series) out.series.set(id, Series.fromJSON(s.name, copy(s)));
		for (const kind of Contributor.KINDS)
			for (const [id, c] of this[kind]) out[kind].set(id, Contributor.fromJSON(c.name, copy(c)));
		for (const [id, mark] of this.marks) out.marks.set(id, copy(mark) as Mark);
		return out;
	}

	/**
	 * @returns a copy
	 */
	static copyNameIds(ids: NameIds): NameIds {
		const out = Catalog.emptyNameIds();
		for (const kind of Catalog.NAMED_KINDS) out[kind] = new Map(ids[kind]);
		return out;
	}

	/**
	 * Take every part of `other` (Restore, a merge applied).
	 */
	replaceWith(other: Catalog) {
		this.books = other.books;
		this.series = other.series;
		this.authors = other.authors;
		this.narrators = other.narrators;
		this.publishers = other.publishers;
		this.exclusions = other.exclusions;
		this.marks = other.marks;
		this.nameIds = other.nameIds;
	}

	// ------------------------------------------------------------------ ids
	/**
	 * Give an id to every book, edition, series and person in the catalog that has none, and a new one to
	 * any that shares its id with another (a book restored twice, say). A box set's edition is one record:
	 * its copies on its titles keep (or get) one id while they are the same edition, and a copy that differs
	 * gets one of its own. A series or person keeps its id when no book names them any more (they are
	 * entries of their own, until removeEntry). The marks then point at the books they are about (resolveMarks).
	 * As it runs on every load and before every save, it also puts each book's editions in order of release
	 * (Book.sortEditions), whatever added or changed them.
	 */
	assignIds(newId: () => string = Catalog.newId) {
		const bookIds = new Set();
		for (const b of this.books) {
			if (!b.id || bookIds.has(b.id)) b.id = newId();
			bookIds.add(b.id);
			b.sortEditions();
		}
		/** edition id -> the values of the first edition seen with it */
		const valuesOf: Map<string, string> = new Map();
		/** values of an edition with an identifier -> its id, to find a copy's */
		const idOf: Map<string, string> = new Map();
		for (const b of this.books) {
			const own = new Set();
			for (const ed of b.editions) {
				const values = editionValues(ed),
					shareable = ed.idAndIsbnKeys().length > 0;
				let id = ed.id;
				if (id && (own.has(id) || (valuesOf.has(id) && valuesOf.get(id) !== values))) id = undefined;
				if (!id && shareable) id = idOf.get(values);
				if (!id || own.has(id)) id = newId();
				ed.id = id;
				own.add(id);
				if (!valuesOf.has(id)) valuesOf.set(id, values);
				if (shareable && !idOf.has(values)) idOf.set(values, id);
			}
		}
		for (const kind of Catalog.NAMED_KINDS) {
			const ids = this.nameIds[kind],
				info = this.infoMap(kind);
			const names = this.namesOf(kind);
			// info is kept by id, so its name keeps that id whatever the books do
			for (const [id, entry] of [...info]) {
				const named = ids.get(entry.name);
				if (named === undefined) ids.set(entry.name, id);
				else if (named !== id && !info.has(named)) {
					info.delete(id);
					info.set(named, entry);
				}
			}
			const seen = new Set();
			for (const name of names) {
				let id = ids.get(name);
				if (!id || seen.has(id)) {
					const had = id;
					ids.set(name, (id = newId()));
					const entry = had === undefined ? undefined : info.get(had);
					if (entry && entry.name === name) {
						info.delete(had as string);
						info.set(id, entry);
					}
				}
				seen.add(id);
			}
		}
		this.resolveMarks();
	}

	/**
	 * Move the series' sites, kept from before authors and publishers kept their own, to them (Series.moveSites).
	 * Only for a whole catalog, as it goes by every book of a series. Returns whether any series had one.
	 */
	moveSeriesSites(): boolean {
		return Series.moveSites(this.series, this.books, this, (kind, name) => this.idFor(kind, name));
	}

	/**
	 * The names of a kind the catalog has: on its books, or with info.
	 */
	namesOf(kind: NamedKind): Set<string> {
		const onBook = Catalog.namesOn(kind);
		return new Set([...this.books.flatMap(onBook), ...[...this.infoMap(kind).values()].map(x => x.name)]);
	}

	/**
	 * The info of a kind, by id (the series' or the people's).
	 */
	infoMap(kind: NamedKind): Map<string, Series | Contributor> {
		return this[kind] as Map<string, Series | Contributor>;
	}

	/**
	 * The id `name` is stored under, giving it one when it has none yet (a series or person just typed in).
	 */
	idFor(kind: NamedKind, name: string): string {
		const ids = this.nameIds[kind];
		let id = ids.get(name);
		if (id === undefined) ids.set(name, (id = Catalog.newId()));
		return id;
	}

	/**
	 * The name stored under `id`; undefined when no series or person of the kind has it.
	 */
	nameOf(kind: NamedKind, id: string): string | undefined {
		for (const [name, x] of this.nameIds[kind]) if (x === id) return name;
		return undefined;
	}

	/**
	 * The series info of the series `name`, if it has some.
	 */
	seriesInfo(name: string): Series | undefined {
		const id = this.nameIds.series.get(name);
		return id === undefined ? undefined : this.series.get(id);
	}

	/**
	 * Every entry of a kind's info by its name, as a backup has it.
	 */
	infoByName<K extends NamedKind>(kind: K): Map<string, K extends 'series' ? Series : Contributor> {
		return new Map(
			[...this.infoMap(kind)].map(([id, info]) => [
				this.nameOf(kind, id) ?? info.name,
				info as K extends 'series' ? Series : Contributor,
			]),
		);
	}

	/**
	 * Replace a kind's info with `byName` (Restore, a merge applied); each name keeps the id it has.
	 */
	replaceInfo(kind: NamedKind, byName: Map<string, Series | Contributor>) {
		const info = this.infoMap(kind);
		info.clear();
		for (const [name, entry] of byName) info.set(this.idFor(kind, name), entry);
	}

	// ------------------------------------------------------------------ books
	/**
	 * Save `book` in place of the book stored under `id` (or add it, when `id` is null; it gets an id of its
	 * own) and keep the editions it shares with other books in step: a copy that was identical to the edition
	 * before the edit gets the edit, and an edition that shares an ASIN or Goodreads id with one on another
	 * book (a box set being linked up) takes what that one has and passes it on. Returns how many other books changed.
	 */
	saveBook(id: string | null, book: Book): number {
		const books = this.books;
		const index = id === null ? -1 : books.findIndex(b => b.id === id);
		if (id !== null && index < 0) throw new Error(`no book is stored under ${id}`);
		if (id === null && book.id === undefined) book.id = Catalog.newId();
		const old = index < 0 ? [] : books[index].editions;
		const neu = book.editions;
		const others = books.map((b, k) => k).filter(k => k !== index);
		const linked: (x: Edition, ed: Edition) => boolean = (x, ed) => x.sharesId(ed) && !x.conflictsWith(ed);
		const befores = neu.map(
			(ed, j) => old.find(x => x.sameAs(ed)) || (old.length === neu.length ? old[j] : undefined),
		);
		const same: (x: Edition, y: Edition | undefined) => boolean = (x, y) =>
			y !== undefined && JSON.stringify(x) === JSON.stringify(y);
		neu.forEach((ed, j) => {
			for (const k of others)
				for (const x of books[k].editions) if (!same(x, befores[j]) && linked(x, ed)) ed.fillFrom(x);
		});
		const changed = new Set();
		neu.forEach((ed, j) => {
			for (const k of others) {
				books[k].editions = books[k].editions.map(x => {
					if (!(same(x, befores[j]) || linked(x, ed)) || same(x, ed)) return x;
					changed.add(k);
					return ed.clone();
				});
			}
		});
		if (index < 0) books.push(book);
		else books[index] = book;
		return changed.size;
	}

	/**
	 * The book stored under `id`, if there is one.
	 */
	book(id: string | null | undefined): Book | undefined {
		return id === null || id === undefined ? undefined : this.books.find(b => b.id === id);
	}

	/** @returns the duplicates among the books, but for those marked "Not duplicates" */
	duplicates(): Duplicates {
		return new Duplicates(this.books, this.marks);
	}

	/**
	 * Add entries to the exclusions list (an ASIN, "ISBN 978...", "Goodreads 12345" or "Title | Author"); returns how many were new.
	 */
	addExclusions(entries: string[]): number {
		return this.exclusions.addAll(entries);
	}

	/**
	 * Mark each two of `books` as different books ("Not duplicates"); returns how many marks were new.
	 */
	markNotDuplicates(books: Book[]): number {
		return this.addMarks(books.flatMap((x, k) => books.slice(k + 1).map(y => Duplicates.pairMark(x, y))));
	}

	/**
	 * Mark the editions `book` has as different editions ("Keep separate"); returns 1 when that is new.
	 */
	markKeepSeparate(book: Book): number {
		return this.addMarks([Duplicates.keepMark(book)]);
	}

	/**
	 * Add marks as a backup writes them (Duplicates.pairKey(), editionsKey()), pointing them at the books
	 * they are about where they match (resolveMarks); returns how many were new.
	 */
	addMarkTexts(texts: string[]): number {
		const had = new Set(this.markTexts());
		const count = this.addMarks(texts.filter(t => !had.has(t)).map(Duplicates.textMark));
		this.resolveMarks();
		return count;
	}

	/**
	 * @returns how many were new
	 */
	addMarks(marks: Mark[]): number {
		const before = this.marks.size;
		for (const mark of marks) if (!this.marks.has(mark.id)) this.marks.set(mark.id, mark);
		return this.marks.size - before;
	}

	/**
	 * The marks as text, as a backup has them: a pair by what identifies its titles (Duplicates.pairKey()), a
	 * book's editions by their ids in external catalogs (Duplicates.editionsKey()), so they hold in another catalog too.
	 */
	markTexts(): string[] {
		const byId = new Map(this.books.map(b => [b.id, b]));
		const out: Set<string> = new Set();
		for (const m of this.marks.values()) {
			const [x, y] = (m.bookIds || []).map(id => byId.get(id));
			if (m.kind === 'notDuplicates') {
				if (x && y) out.add(Duplicates.pairKey(x, y));
			} else if (m.kind === 'keepSeparate') {
				// the book's editions now, if they are still the ones marked; else the mark as it was
				const key = x && Duplicates.keepMark(x).id === m.id ? Duplicates.editionsKey(x) : m.key;
				if (key) out.add(key);
			} else if (m.key) out.add(m.key);
		}
		return [...out];
	}

	/**
	 * Point the marks at the books (and editions) they are about, so they still hold when a book is retitled
	 * or an edition's ids change: a mark as text that matches books by what identifies them becomes one by
	 * their ids. A "Keep separate" mark whose book has other editions now goes back to its text, and a pair
	 * mark of a book that is gone goes.
	 */
	resolveMarks() {
		const byHalf: Map<string, string[]> = new Map();
		const byEditions: Map<string, Book[]> = new Map();
		const known = new Set();
		for (const b of this.books) {
			if (b.id === undefined) continue;
			known.add(b.id);
			for (const key of new Set([Duplicates.bookKey(b), Duplicates.bookKey(b, Text.asciiNorm)]))
				byHalf.set(key, [...(byHalf.get(key) || []), b.id]);
			const key = Duplicates.editionsKey(b);
			byEditions.set(key, [...(byEditions.get(key) || []), b]);
		}
		const out: Map<string, Mark> = new Map();
		const put: (mark: Mark) => void = mark => {
			if (!out.has(mark.id)) out.set(mark.id, mark);
		};
		for (const m of this.marks.values()) {
			if (m.kind === 'notDuplicates') {
				if ((m.bookIds || []).every(id => known.has(id))) put(m);
				continue;
			}
			if (m.kind === 'keepSeparate') {
				const b = this.book((m.bookIds || [])[0]);
				if (b && Duplicates.keepMark(b).id === m.id) put(m);
				else if (m.key) put(Duplicates.textMark(m.key));
				continue;
			}
			const text = m.key || '';
			const halves = Duplicates.pairHalves(text);
			const [x, y] = halves ? halves.map(h => byHalf.get(h) || []) : [[], []];
			const owners = byEditions.get(text) || [];
			if (x.length === 1 && y.length === 1 && x[0] !== y[0]) {
				const bookIds = [x[0], y[0]].sort();
				put({id: `pair ${bookIds.join(' ')}`, kind: 'notDuplicates', bookIds});
			} else if (owners.length === 1 && Duplicates.keepMark(owners[0]).kind === 'keepSeparate') {
				put({...Duplicates.keepMark(owners[0]), key: text});
			} else put(m);
		}
		this.marks = out;
	}

	// ------------------------------------------------------------------ series and authors
	/**
	 * The books of a series, as they are listed.
	 */
	seriesBooks(name: string): Book[] {
		return this.books.filter(b => b.series === name);
	}

	/**
	 * The series numbers you don't own yet, from the series info's released total; null when that is unknown.
	 */
	missing(name: string): number[] | null {
		const info = this.seriesInfo(name);
		return info ? info.missing(this.seriesBooks(name)) : null;
	}

	/**
	 * Rename a series, author, narrator or publisher on every book naming them (a book that names both the
	 * old and the new name names the new one once), and move their info, which replaces any the new name
	 * had; returns how many books changed. The entry keeps its id, unless it joins one that has its own.
	 */
	renameEntry(kind: NamedKind, name: string, newName: string): number {
		const swap: (names: string[]) => string[] = names => [...new Set(names.map(x => (x === name ? newName : x)))];
		let count = 0;
		for (const b of this.books) {
			let hit = false;
			if (kind === 'series' && b.series === name) {
				b.series = newName;
				hit = true;
			}
			if (kind === 'authors' && b.authors.includes(name)) {
				b.authors = swap(b.authors);
				hit = true;
			}
			for (const ed of b.editions) {
				if (kind === 'narrators' && ed.narrators.includes(name)) {
					ed.narrators = swap(ed.narrators);
					hit = true;
				}
				if (kind === 'publishers' && ed.publisher === name) {
					ed.publisher = newName;
					hit = true;
				}
			}
			if (hit) count++;
		}
		const ids = this.nameIds[kind],
			infos = this.infoMap(kind),
			id = ids.get(name),
			joined = ids.get(newName);
		ids.delete(name);
		const info = id === undefined ? undefined : infos.get(id);
		if (id !== undefined) infos.delete(id);
		const target = joined ?? id;
		if (joined === undefined && id !== undefined) ids.set(newName, id);
		if (info && target !== undefined) {
			info.name = newName;
			infos.set(target, info);
		}
		return count;
	}

	/**
	 * Remove a series, author, narrator or publisher: their name comes off every book (a series' books lose
	 * their number in it too, and a person comes off the editions they read or publish), and their entry and
	 * info go. Returns the books changed. Throws when an author is the only author of a book, as a book needs
	 * one (removeProblem says so first).
	 */
	removeEntry(kind: NamedKind, id: string): Book[] {
		const problem = this.removeProblem(kind, id);
		if (problem) throw new Error(problem);
		const name = this.nameOf(kind, id);
		const changed: Book[] = [];
		if (name !== undefined) {
			for (const b of this.books) {
				let hit = false;
				if (kind === 'series' && b.series === name) {
					b.series = undefined;
					b.number = undefined;
					hit = true;
				}
				if (kind === 'authors' && b.authors.includes(name)) {
					b.authors = b.authors.filter(a => a !== name);
					hit = true;
				}
				for (const ed of b.editions) {
					if (kind === 'narrators' && ed.narrators.includes(name)) {
						ed.narrators = ed.narrators.filter(n => n !== name);
						hit = true;
					}
					if (kind === 'publishers' && ed.publisher === name) {
						ed.publisher = undefined;
						hit = true;
					}
				}
				if (hit) changed.push(b);
			}
			this.nameIds[kind].delete(name);
		}
		this.infoMap(kind).delete(id);
		return changed;
	}

	/**
	 * Why removeEntry() can't remove an entry (an author who is the only author of some books), or ''.
	 */
	removeProblem(kind: NamedKind, id: string): string {
		const name = this.nameOf(kind, id);
		if (kind !== 'authors' || name === undefined) return '';
		const alone = this.books.filter(b => b.authors.length === 1 && b.authors[0] === name);
		if (!alone.length) return '';
		const titles = Text.firstThree(alone.map(b => b.title));
		return `${name} is the only author of ${Text.plural(alone.length, 'book')} (${titles}): give ${alone.length > 1 ? 'them' : 'it'} another author first, or remove ${alone.length > 1 ? 'them' : 'it'}.`;
	}

	/**
	 * The books naming the series, author, narrator or publisher stored under `id`, of those the catalog holds.
	 */
	booksOf(kind: NamedKind, id: string): Book[] {
		const name = this.nameOf(kind, id);
		if (name === undefined) return [];
		const onBook = Catalog.namesOn(kind);
		return this.books.filter(b => onBook(b).includes(name));
	}

	/**
	 * What the author, narrator or publisher `name` is credited with on the books (an author alone or with
	 * others, a narrator or publisher on any edition, each book once): {series: [{name, books}], titles} with
	 * each series' books in series order and the books outside a series by title.
	 */
	works(kind: ContributorKind, name: string): {series: {name: string; books: Book[]}[]; titles: Book[]} {
		const namesOf = Catalog.namesOn(kind);
		const own = this.books.filter(b => namesOf(b).includes(name));
		const bySeries: Map<string, Book[]> = new Map();
		for (const b of own) {
			if (!b.series) continue;
			const list = bySeries.get(b.series);
			if (list) list.push(b);
			else bySeries.set(b.series, [b]);
		}
		const series = [...bySeries]
			.sort((x, y) => x[0].localeCompare(y[0]))
			.map(([s, list]) => ({name: s, books: list.sort(Book.bySeriesNumber)}));
		const titles = own.filter(b => !b.series).sort((x, y) => x.title.localeCompare(y.title));
		return {series, titles};
	}

	/**
	 * How a book gives the names of a kind: its series, authors, or its editions' narrators or publishers.
	 */
	static namesOn(kind: NamedKind): (b: Book) => string[] {
		return kind === 'series'
			? b => (b.series ? [b.series] : [])
			: kind === 'authors'
				? Catalog.authorsOf
				: kind === 'narrators'
					? Catalog.narratorsOf
					: Catalog.publishersOf;
	}
	/** @returns its authors */
	static authorsOf(b: Book): string[] {
		return b.authors;
	}
	/** @returns the narrators of all its editions, each once */
	static narratorsOf(b: Book): string[] {
		return [...new Set(b.editions.flatMap(ed => ed.narrators))];
	}
	/** @returns the publishers of all its editions, each once */
	static publishersOf(b: Book): string[] {
		return [...new Set(b.editions.map(ed => ed.publisher || '').filter(Boolean))];
	}
}
