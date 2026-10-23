// AudiobookDB as a source of the book form's Fill in: its API doesn't answer web pages, so it is asked through
// the user's own catalog proxy (proxy/worker.js), by its books and releases, by an ASIN (beside Audible), and
// by a typed title. The ASINs it lists are not taken, as it doesn't say which Audible site they are on.
import {Text} from './text.js';
import {Isbn} from './isbn.js';
import {Book} from './book.js';
import {ExternalCatalog} from './external-catalog.js';
import {BookSource} from './book-source.js';
import {AudiobookdbClient} from './audiobookdb-client.js';
/** @import {Unchecked} from './text.js' */
/** @import {Pasted, Answers, Found} from './book-source.js' */

const tidyText = BookSource.text;

/** Looks books up on AudiobookDB, through the catalog proxy. */
export class AudiobookdbSource extends BookSource {
	static CATALOG = 'audiobookdb';
	static LABEL = 'AudiobookDB';
	static NAMES = ['AudiobookDB'];
	static NEEDS = /** @type {const} */ ('proxy');
	static CLIENT = AudiobookdbClient;
	static SEARCHES = true;

	/**
	 * Its own books and releases, and ASINs beside Audible.
	 * @param {Pasted} pasted
	 * @returns {Answers}
	 */
	answers(pasted){
		return ExternalCatalog.family(pasted.catalog) === 'asin' ? 'also' : super.answers(pasted);
	}

	/**
	 * @param {Pasted} pasted
	 * @param {Found} found
	 * @returns {Promise<Book | null>}
	 */
	async lookup(pasted, found){
		if(pasted.catalog !== AudiobookdbSource.CATALOG) return this.byAsin(pasted.id);
		return pasted.kind === 'edition' ? this.release(pasted.id) : this.work(pasted.id, found);
	}

	/**
	 * The book AudiobookDB files an ASIN under, with the release it belongs to; null when it has none.
	 * @param {string} asin
	 * @returns {Promise<Book | null>}
	 */
	async byAsin(asin){
		const book = await this.proxied(`audiobookdb/audiobooks/external/audible/${encodeURIComponent(asin)}`);
		if(!book) return null;
		const release = (Array.isArray(book.releases) ? book.releases : []).find((/** @type {unknown} */ r) => Text.isObject(r) && r.id === book.matchedReleaseId);
		return AudiobookdbSource.book(book, release || null);
	}

	/**
	 * The AudiobookDB book with the title `title` (spelled any way, punctuation aside), by one of `authors` when
	 * any are given. Throws, naming a few, when there are several, and when there is none.
	 * @param {string} title
	 * @param {string[]} authors
	 * @returns {Promise<string>} its id
	 */
	async search(title, authors){
		const answer = await this.proxied(`audiobookdb/books?q=${encodeURIComponent(title)}&take=50`, true);
		const books = Array.isArray(answer) ? answer.filter(b => Text.isObject(b) && typeof b.id === 'string' && Text.norm(tidyText(b.title)) === Text.norm(title)) : [];
		/** @type {(b: Unchecked) => string[]} */
		const names = b => Array.isArray(b.authors) ? b.authors.map((/** @type {unknown} */ a) => Text.isObject(a) ? tidyText(a.name) : '').filter(Boolean) : [];
		const wanted = new Set(authors.map(Text.norm).filter(Boolean));
		const hits = wanted.size ? books.filter(b => names(b).some(n => wanted.has(Text.norm(n)))) : books;
		if(hits.length === 1) return hits[0].id;
		if(!hits.length) throw new Error(`AudiobookDB has no book titled ${title}${wanted.size ? ` by ${authors.join(', ')}` : ''}; paste its address instead`);
		const some = hits.slice(0, 3).map(b => `${tidyText(b.title)} by ${names(b).join(', ') || 'no author'} (${ExternalCatalog.url('audiobookdb', 'book', b.id)})`);
		throw new Error(`AudiobookDB has ${hits.length} books titled ${title}: ${some.join('; ')}${hits.length > 3 ? '…' : ''}; type the author first, or paste the address of the one you mean`);
	}

	/**
	 * A book with its edition from an AudiobookDB release (and the release's book).
	 * @param {string} id
	 * @returns {Promise<Book>}
	 */
	async release(id){
		const release = await this.proxied(`audiobookdb/releases/${encodeURIComponent(id)}`);
		if(!release) throw new Error(`AudiobookDB has no release ${id}`);
		const bookId = Text.isObject(release.book) && typeof release.book.id === 'string' ? release.book.id : '';
		const book = bookId ? await this.proxied(`audiobookdb/books/${encodeURIComponent(bookId)}`) : null;
		return AudiobookdbSource.book(book || (Text.isObject(release.book) ? release.book : {}), release);
	}

	/**
	 * A book from AudiobookDB, with its edition when it has only one release (of several, it can't tell which
	 * is yours: `found` says to paste the release's address).
	 * @param {string} id
	 * @param {Found} found
	 * @returns {Promise<Book>}
	 */
	async work(id, found){
		const book = await this.proxied(`audiobookdb/books/${encodeURIComponent(id)}`);
		if(!book) throw new Error(`AudiobookDB has no book ${id}`);
		const releases = (Array.isArray(book.releases) ? book.releases : []).filter((/** @type {unknown} */ r) => Text.isObject(r));
		if(releases.length > 1) found.notes.push(`AudiobookDB has ${releases.length} releases of it; paste your release's address to fill in its edition`);
		return AudiobookdbSource.book(book, releases.length === 1 ? releases[0] : null);
	}

	/**
	 * A book made of an AudiobookDB book and one of its releases: title, authors, its numbered series (not an
	 * umbrella one numbered 0), genres, and the edition: its release id, ISBN, narrators, publisher, release date
	 * and length. Its ASINs are left out, as AudiobookDB doesn't say which Audible site they are on.
	 * @param {Unchecked} book
	 * @param {Unchecked | null} release
	 * @returns {Book}
	 */
	static book(book, release){
		/** @type {(x: unknown, role: string) => string[]} */
		const people = (x, role) => Array.isArray(x) ? [...new Set(x.filter(p => Text.isObject(p) && Text.isObject(p.role) && p.role.name === role && Text.isObject(p.person))
			.map(p => tidyText(p.person.name)).filter(Boolean))] : [];
		/** @type {Record<string, any>} */
		const rec = {t: tidyText(book.title) || (release ? tidyText(release.title) : ''), a: people(book.people, 'Author')};
		if(typeof book.id === 'string' && book.id) rec.ext = {audiobookdb: book.id};
		const series = (Array.isArray(book.series) ? book.series : []).filter((/** @type {unknown} */ s) => Text.isObject(s) && Text.isObject(s.series) && tidyText(s.series.title));
		const numbered = series.find((/** @type {Unchecked} */ s) => /^\d+(?:\.\d+)?$/.test(tidyText(s.ordinal)) && Number(tidyText(s.ordinal)) > 0);
		const inSeries = numbered || (series.length === 1 ? series[0] : null);
		if(inSeries){
			rec.s = tidyText(inSeries.series.title);
			if(inSeries === numbered) rec.sn = tidyText(inSeries.ordinal);
		}
		const genres = Array.isArray(book.genres) ? book.genres.map((/** @type {unknown} */ g) => Text.isObject(g) ? tidyText(g.title) : '').filter(Boolean) : [];
		if(genres.length) rec.g = [...new Set(genres)].slice(0, 5);
		if(release){
			/** @type {Record<string, any>} */
			const ed = {};
			if(typeof release.id === 'string' && release.id) ed.ext = {audiobookdb: release.id};
			const isbn = Isbn.parse(release.isbn);
			if(isbn) ed.isbn = isbn;
			const narrators = people(release.people, 'Narrator');
			if(narrators.length) ed.n = narrators;
			if(Text.isObject(release.publisher) && tidyText(release.publisher.name)) ed.p = tidyText(release.publisher.name);
			const released = BookSource.date(release.releaseDate);
			if(released) ed.d = released;
			const minutes = AudiobookdbSource.minutes(release);
			if(minutes) ed.len = minutes;
			if(Object.keys(ed).length) rec.e = [ed];
		}
		return Book.fromRecord(Book.fixSeriesTitle(rec));
	}

	/**
	 * A release's length in minutes, from its seconds or its "H:MM:SS"; null when it has neither.
	 * @param {Unchecked} release
	 * @returns {number | null}
	 */
	static minutes(release){
		let seconds = Number.isFinite(release.runtimeLengthSec) ? Number(release.runtimeLengthSec) : NaN;
		const m = typeof release.duration === 'string' ? /^(\d+):([0-5]\d):([0-5]\d)$/.exec(release.duration.trim()) : null;
		if(!(seconds > 0) && m) seconds = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
		return seconds >= 60 ? Math.round(seconds / 60) : null;
	}
}
