// AudiobookDB as a source of the Edit page's Fill in: its API doesn't answer web pages, so it is asked through
// the user's own catalog proxy (server/proxy.ts), by its books and releases, by an ASIN (beside Audible), and
// by a typed title. A release's ASINs are taken under the site its links name for them. Its series, people
// (authors and narrators) and publishers give their id there, a person's description, and a series' or an
// author's ASIN on the sites its links name.
import {Text, PhraseError} from './text.js';
import {Isbn} from './isbn.js';
import {Book} from './book.js';
import {ExternalCatalog} from './external-catalog.js';
import {BookSource} from './book-source.js';
import {AudiobookdbClient} from './audiobookdb-client.js';
import type {Unchecked} from './text.js';
import type {Pasted, Answers, Found, EntryKind, EntryQuery, EntryAnswer} from './book-source.js';

/** Where AudiobookDB's API has a kind of series or person, and the role a person of that kind has on a book. */
const ENTRY_PATHS: Record<EntryKind, {path: string; role?: string}> = {
	series: {path: 'series'},
	author: {path: 'people', role: 'Author'},
	narrator: {path: 'people', role: 'Narrator'},
	publisher: {path: 'publishers'},
};

const tidyText = BookSource.text;

/** Looks books up on AudiobookDB, through the catalog proxy. */
export class AudiobookdbSource extends BookSource {
	static CATALOG = 'audiobookdb';
	static LABEL = 'AudiobookDB';
	static NAMES = ['AudiobookDB'];
	static NEEDS = 'proxy' as const;
	static CLIENT = AudiobookdbClient;
	static SEARCHES = true;
	static ENTRIES = ['series', 'author', 'narrator', 'publisher'] as const;

	/**
	 * Its own books and releases, and ASINs beside Audible.
	 */
	answers(pasted: Pasted): Answers {
		return ExternalCatalog.family(pasted.catalog) === 'asin' ? 'also' : super.answers(pasted);
	}

	async lookup(pasted: Pasted, found: Found): Promise<Book | null> {
		if (pasted.catalog !== AudiobookdbSource.CATALOG) return this.byAsin(pasted.id);
		return pasted.kind === 'edition' ? this.release(pasted.id) : this.work(pasted.id, found);
	}

	/**
	 * The book AudiobookDB files an ASIN under, with the release it belongs to; null when it has none.
	 */
	async byAsin(asin: string): Promise<Book | null> {
		const book = await this.proxied(`audiobookdb/audiobooks/external/audible/${encodeURIComponent(asin)}`);
		if (!book) return null;
		const release = (Array.isArray(book.releases) ? book.releases : []).find(
			(r: unknown) => Text.isObject(r) && r.id === book.matchedReleaseId,
		);
		return AudiobookdbSource.book(book, release || null);
	}

	/**
	 * The AudiobookDB book with the title `title` (spelled any way, punctuation aside), by one of `authors` when
	 * any are given. Throws, naming a few, when there are several, and when there is none.
	 * @returns its id
	 */
	async search(title: string, authors: string[]): Promise<string> {
		const answer = await this.proxied(`audiobookdb/books?q=${encodeURIComponent(title)}&take=50`, true);
		const books = Array.isArray(answer)
			? answer.filter(
					b =>
						Text.isObject(b) &&
						typeof b.id === 'string' &&
						Text.norm(tidyText(b.title)) === Text.norm(title),
				)
			: [];
		const names: (b: Unchecked) => string[] = b =>
			Array.isArray(b.authors)
				? b.authors.map((a: unknown) => (Text.isObject(a) ? tidyText(a.name) : '')).filter(Boolean)
				: [];
		const wanted = new Set(authors.map(Text.norm).filter(Boolean));
		const hits = wanted.size ? books.filter(b => names(b).some(n => wanted.has(Text.norm(n)))) : books;
		if (hits.length === 1) return hits[0].id;
		if (!hits.length)
			throw new PhraseError(
				wanted.size
					? 'AudiobookDB has no book titled {title} by {authors}; paste its address instead'
					: 'AudiobookDB has no book titled {title}; paste its address instead',
				{title, authors: authors.join(', ')},
			);
		const some = hits.slice(0, 3).map(b => {
			const values = {
				title: tidyText(b.title),
				authors: names(b).join(', '),
				url: ExternalCatalog.url('audiobookdb', 'book', b.id) || '',
			};
			return values.authors
				? Text.phrase('{title} by {authors} ({url})', values)
				: Text.phrase('{title} by no author ({url})', values);
		});
		throw new PhraseError(
			hits.length > 3
				? 'AudiobookDB has {count} books titled {title}: {some}…; type the author first, or paste the address of the one you mean'
				: 'AudiobookDB has {count} books titled {title}: {some}; type the author first, or paste the address of the one you mean',
			{count: hits.length, title, some: Text.joinPhrases(some)},
		);
	}

	/**
	 * A book with its edition from an AudiobookDB release (and the release's book).
	 */
	async release(id: string): Promise<Book> {
		const release = await this.proxied(`audiobookdb/releases/${encodeURIComponent(id)}`);
		if (!release) throw new PhraseError('AudiobookDB has no release {id}', {id});
		const bookId = Text.isObject(release.book) && typeof release.book.id === 'string' ? release.book.id : '';
		const book = bookId ? await this.proxied(`audiobookdb/books/${encodeURIComponent(bookId)}`) : null;
		return AudiobookdbSource.book(book || (Text.isObject(release.book) ? release.book : {}), release);
	}

	/**
	 * A book from AudiobookDB, with its edition when it has only one release (of several, it can't tell which
	 * is yours: `found` says to paste the release's address).
	 */
	async work(id: string, found: Found): Promise<Book> {
		const book = await this.proxied(`audiobookdb/books/${encodeURIComponent(id)}`);
		if (!book) throw new PhraseError('AudiobookDB has no book {id}', {id});
		const releases = (Array.isArray(book.releases) ? book.releases : []).filter((r: unknown) => Text.isObject(r));
		if (releases.length > 1)
			found.notes.push(
				Text.phrase(
					"AudiobookDB has {count} releases of it; paste your release's address to fill in its edition",
					{count: releases.length},
				),
			);
		return AudiobookdbSource.book(book, releases.length === 1 ? releases[0] : null);
	}

	/**
	 * A book made of an AudiobookDB book and one of its releases: title, authors, its numbered series (not an
	 * umbrella one numbered 0), genres, and the edition: its release id, ISBN, narrators, publisher, release date,
	 * length, cover (the release's, else the book's), and its ASINs, each under the site its link names.
	 */
	static book(book: Unchecked, release: Unchecked | null): Book {
		const people = AudiobookdbClient.namesIn;
		const rec: Record<string, any> = {
			t: tidyText(book.title) || (release ? tidyText(release.title) : ''),
			a: people(book.people, 'Author'),
		};
		if (typeof book.id === 'string' && book.id) rec.ext = {audiobookdb: book.id};
		const series = (Array.isArray(book.series) ? book.series : []).filter(
			(s: unknown) => Text.isObject(s) && Text.isObject(s.series) && tidyText(s.series.title),
		);
		const numbered = series.find(
			(s: Unchecked) => /^\d+(?:\.\d+)?$/.test(tidyText(s.ordinal)) && Number(tidyText(s.ordinal)) > 0,
		);
		const inSeries = numbered || (series.length === 1 ? series[0] : null);
		if (inSeries) {
			rec.s = tidyText(inSeries.series.title);
			if (inSeries === numbered) rec.sn = tidyText(inSeries.ordinal);
		}
		const genres = Array.isArray(book.genres)
			? book.genres.map((g: unknown) => (Text.isObject(g) ? tidyText(g.title) : '')).filter(Boolean)
			: [];
		if (genres.length) rec.g = [...new Set(genres)].slice(0, 5);
		if (release) {
			const ed: Record<string, any> = {};
			const ext: Record<string, string> = {...AudiobookdbClient.asinsBySite(release)};
			if (typeof release.id === 'string' && release.id) ext.audiobookdb = release.id;
			if (Object.keys(ext).length) ed.ext = ExternalCatalog.order(ext);
			const isbn = Isbn.parse(release.isbn);
			if (isbn) ed.isbn = isbn;
			const narrators = people(release.people, 'Narrator');
			if (narrators.length) ed.n = narrators;
			if (Text.isObject(release.publisher) && tidyText(release.publisher.name))
				ed.p = [tidyText(release.publisher.name)];
			const released = BookSource.date(release.releaseDate);
			if (released) ed.d = released;
			const minutes = AudiobookdbSource.minutes(release);
			if (minutes) ed.len = minutes;
			const cover = AudiobookdbClient.coverKey(release.images) || AudiobookdbClient.coverKey(book.images);
			if (Object.keys(ed).length && cover) ed.img = {audiobookdb: cover};
			if (Object.keys(ed).length) rec.e = [ed];
		}
		return Book.fromRecord(Book.fixSeriesTitle(rec));
	}

	/**
	 * A release's length in minutes, from its seconds or its "H:MM:SS"; null when it has neither.
	 */
	static minutes(release: Unchecked): number | null {
		let seconds = Number.isFinite(release.runtimeLengthSec) ? Number(release.runtimeLengthSec) : NaN;
		const m =
			typeof release.duration === 'string' ? /^(\d+):([0-5]\d):([0-5]\d)$/.exec(release.duration.trim()) : null;
		if (!(seconds > 0) && m) seconds = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
		return seconds >= 60 ? Math.round(seconds / 60) : null;
	}

	// ------------------------------------------------------------------ series and people
	async entry(kind: EntryKind, id: string): Promise<EntryAnswer | null> {
		const entry = await this.proxied(`audiobookdb/${ENTRY_PATHS[kind].path}/${encodeURIComponent(id)}`);
		return entry ? this.entryOf(kind, entry, 'id') : null;
	}

	/**
	 * A series or person by the AudiobookDB books of its books, which name them (a narrator and a publisher on
	 * their releases); else those called `name`, each with what AudiobookDB lists of theirs.
	 */
	async findEntries({kind, name, books}: EntryQuery): Promise<EntryAnswer[]> {
		const {path, role} = ENTRY_PATHS[kind];
		const mine = [...new Set(books.map(b => b.external[AudiobookdbSource.CATALOG]).filter(Boolean))];
		for (const id of mine.slice(0, 3)) {
			const book = await this.proxied(`audiobookdb/books/${encodeURIComponent(id)}`);
			if (!book) continue;
			const releases: Unchecked[] = (Array.isArray(book.releases) ? book.releases : []).filter(Text.isObject);
			const named: unknown[] =
				kind === 'series'
					? (Array.isArray(book.series) ? book.series : []).map((s: unknown) =>
							Text.isObject(s) && Text.isObject(s.series)
								? {id: s.series.id, name: s.series.title}
								: null,
						)
					: kind === 'publisher'
						? releases.map(r => r.publisher)
						: [book, ...releases].flatMap(x => AudiobookdbClient.peopleIn(x.people, role as string));
			const ids = new Set(
				named
					.filter(x => Text.isObject(x) && typeof x.id === 'string' && BookSource.sameName(x.name, name))
					.map(x => (x as Unchecked).id as string),
			);
			if (ids.size !== 1) continue;
			const found = await this.entry(kind, [...ids][0]);
			if (found) return [{...found, by: 'books'}];
		}
		const answer = await this.proxied(`audiobookdb/${path}?q=${encodeURIComponent(name)}&take=20`, true);
		const hits: Unchecked[] = (Array.isArray(answer) ? answer : [])
			.filter(
				(hit: unknown) =>
					Text.isObject(hit) &&
					typeof hit.id === 'string' &&
					BookSource.sameName(kind === 'series' ? hit.title : hit.name, name) &&
					(!role || !Array.isArray(hit.roleNames) || hit.roleNames.includes(role)),
			)
			.slice(0, AudiobookdbSource.NAMESAKES);
		const found: EntryAnswer[] = [];
		for (const hit of hits) {
			const entry = await this.proxied(`audiobookdb/${path}/${encodeURIComponent(hit.id)}`);
			if (entry) found.push(this.entryOf(kind, entry, 'name', AudiobookdbSource.aboutHit(kind, hit)));
		}
		return found;
	}

	/**
	 * What tells a search's hit from others of its name: a series' count of books, a person's first books, a
	 * publisher's count of releases; null when the hit says none.
	 */
	static aboutHit(kind: EntryKind, hit: Unchecked): EntryAnswer['about'] {
		if (kind === 'series') return Number.isInteger(hit.bookCount) ? Text.counted(hit.bookCount, 'book') : null;
		if (kind === 'publisher')
			return Number.isInteger(hit.releaseCount) ? Text.counted(hit.releaseCount, 'release') : null;
		const titles = (Array.isArray(hit.sampleCredits) ? hit.sampleCredits : [])
			.map((c: unknown) => (Text.isObject(c) && Text.isObject(c.book) ? tidyText(c.book.title) : ''))
			.filter(Boolean)
			.slice(0, 3);
		return titles.length ? Text.phrase('credited on {titles}', {titles: titles.join(', ')}) : null;
	}

	/**
	 * A series, person or publisher from AudiobookDB's answer: a person's description, and for a series or an
	 * author the ASINs its links have, each under its site (a narrator has no ASIN on Audible).
	 */
	entryOf(kind: EntryKind, entry: Unchecked, by: EntryAnswer['by'], about: EntryAnswer['about'] = null): EntryAnswer {
		const asins = kind === 'series' || kind === 'author' ? AudiobookdbClient.asinsBySite(entry) : {};
		return this.answerOf(
			kind,
			String(entry.id),
			tidyText(kind === 'series' ? entry.title : entry.name),
			by,
			{bio: kind === 'series' || kind === 'publisher' ? undefined : entry.description, external: asins},
			about,
		);
	}
}
