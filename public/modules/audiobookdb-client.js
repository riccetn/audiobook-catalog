// AudiobookDB's API (audiobookdb.org/docs): asking it, and what it answers. Its API sends no CORS headers, so
// the page asks it through the catalog proxy (the fetch it is given: route in, Response out), and the tests
// give it a fake. Your API key, when saved, is sent only with what acts for your account (who you are, your
// shelves, putting a book on one); the proxy passes it on to those paths alone, and refuses it anywhere else.
import {Text} from './text.js';
import {CatalogClient} from './catalog-client.js';
/** @import {Unchecked} from './text.js' */
/** @import {CatalogFetch, Pause} from './catalog-client.js' */
/**
 * One of your AudiobookDB shelves, as the API answers it: its books are {id, title, people, addedAt}.
 * @typedef {{id: string, slug: string, name: string, isDefault: boolean, isExclusive: boolean, books: Unchecked[]}} AudiobookdbShelf
 */

// A short wait is asked for again at most this often before giving up, and never longer than this.
const RETRIES = 3;
const LONGEST_WAIT = 60;

/** Asks AudiobookDB's API through the catalog proxy, one request at a time. */
export class AudiobookdbClient extends CatalogClient {
	static CATALOG = 'audiobookdb';
	static LABEL = 'AudiobookDB';
	// AudiobookDB's ids, of every kind: 12 letters and digits (as ExternalCatalog takes them)
	static ID = /^[A-Za-z0-9]{12}$/;
	static KEY_STORAGE = 'audiobook-catalog-audiobookdb-key';
	static KEY_HELP =
		'Paste an API key from audiobookdb.org (under your account) and save it, to compare your shelves and put books on them; it is kept in this browser only (never in a backup). Without it, Compare only finds your books there.';
	static KEY_NEEDED = false;
	static VIA_PROXY = true;
	static PAUSE_MS = 500; // AudiobookDB allows a burst of 25, then about 10 a second

	/**
	 * A client that asks through `get` (the catalog proxy), with `key` (your API key, '' for none), calling
	 * `pause(gap)` between requests and `pause` again when AudiobookDB asks to slow down (it allows a burst of 25 and a daily budget).
	 * @param {CatalogFetch} get
	 * @param {string} key
	 * @param {Pause} pause
	 * @param {number} [gap] milliseconds between requests
	 */
	constructor(get, key, pause, gap) {
		super(get, key, pause, gap);
		/** @type {string | undefined} whose shelves they are, once AudiobookDB said */
		this.username = undefined;
	}

	/**
	 * Ask AudiobookDB for `path` (in its API, with any query) and return what it answers; null for a 404.
	 * `keyed` sends your key along (only the paths that act for your account), `body` makes it a POST.
	 * Throws with a short reason when AudiobookDB or the proxy says no.
	 * @param {string} path
	 * @param {{keyed?: boolean, body?: Unchecked}} [opts]
	 * @returns {Promise<any>}
	 */
	async ask(path, {keyed = false, body} = {}) {
		for (let attempt = 0; ; attempt++) {
			await this.waitTurn();
			const init = {
				...(body ? {method: 'POST', body: JSON.stringify(body)} : {}),
				...(keyed && this.key ? {key: this.key} : {}),
			};
			const res = await this.get(`audiobookdb/${path}`, init);
			const wait = res.status === 429 ? AudiobookdbClient.waitFor(res.headers) : 0;
			if (res.status === 429 && attempt < RETRIES && wait <= LONGEST_WAIT) {
				await this.pause(1000 * wait);
				continue;
			}
			if (res.status === 404) return null;
			/** @type {any} */
			let json = null;
			try {
				json = await res.json();
			} catch {
				/* reported below */
			}
			const said =
				json && Array.isArray(json.errors) && json.errors[0] && typeof json.errors[0].title === 'string'
					? ` (${json.errors[0].title})`
					: '';
			if (res.status === 429)
				throw new Error('AudiobookDB asks to slow down (its daily budget may be spent); try again later');
			if (res.status === 401)
				throw new Error(
					keyed && this.key
						? 'AudiobookDB refused your API key (make a new one on audiobookdb.org, under your account)'
						: 'AudiobookDB needs your API key for that: save it on the Import & export page',
				);
			if (res.status === 403)
				throw new Error(
					`AudiobookDB said no${said}: your shelves are private and it doesn't know the key, or the key can't do that`,
				);
			if ((res.status === 400 || res.status === 405) && keyed)
				throw new Error(
					`your server refused it (${res.status}): deploy it again (make deploy-server) to bring it up to date`,
				);
			if (!res.ok || json === null) throw new Error(`AudiobookDB answered ${res.status}${said}`);
			return json;
		}
	}

	/**
	 * How many seconds AudiobookDB asks to wait before asking again: its Retry-After, else until its
	 * ratelimit-reset (the time the budget is filled again, in seconds since 1970, or seconds from now), else 10.
	 * @param {Headers | undefined} headers
	 * @param {number} [now] milliseconds since 1970
	 * @returns {number}
	 */
	static waitFor(headers, now = Date.now()) {
		const retry = Number(headers && headers.get('Retry-After'));
		if (retry > 0) return retry;
		const reset = Number(headers && headers.get('ratelimit-reset'));
		if (reset > 0) return Math.max(1, Math.ceil(reset > 1e9 ? reset - now / 1000 : reset));
		return 10;
	}

	/**
	 * Who your API key belongs to: your username on AudiobookDB.
	 * @returns {Promise<string>}
	 */
	async whoAmI() {
		if (this.username) return this.username;
		if (!this.key) throw new Error('save your AudiobookDB API key first');
		const me = await this.ask('auth/session', {keyed: true});
		const user = Text.isObject(me) && Text.isObject(me.user) ? me.user : me;
		const name = Text.isObject(user) && typeof user.username === 'string' ? user.username.trim() : '';
		if (!name) throw new Error("AudiobookDB didn't say whose key it is");
		return (this.username = name);
	}

	/**
	 * Every one of your shelves, with all their books.
	 * @returns {Promise<AudiobookdbShelf[]>}
	 */
	async shelves() {
		const user = encodeURIComponent(await this.whoAmI());
		const answer = await this.ask(`users/username/${user}/shelves`, {keyed: true});
		if (!Array.isArray(answer)) throw new Error("AudiobookDB sent something that isn't a list of shelves");
		return answer
			.filter(s => Text.isObject(s) && typeof s.slug === 'string')
			.map(s => ({...s, books: Array.isArray(s.books) ? s.books.filter(Text.isObject) : []}));
	}

	/**
	 * Put a book on one of your shelves.
	 * @param {string} shelf its slug
	 * @param {string} bookId
	 * @returns {Promise<void>}
	 */
	async addToShelf(shelf, bookId) {
		const user = encodeURIComponent(await this.whoAmI());
		await this.ask(`users/username/${user}/shelves/${encodeURIComponent(shelf)}/books`, {
			keyed: true,
			body: {bookId},
		});
	}

	/**
	 * A book with all it has (people, series, releases with their ids elsewhere); null when there is none.
	 * @param {string} id
	 * @returns {Promise<Unchecked | null>}
	 */
	async book(id) {
		const book = await this.ask(`books/${encodeURIComponent(id)}`);
		return Text.isObject(book) ? book : null;
	}

	/**
	 * The book AudiobookDB files an Audible ASIN under, with `matchedReleaseId`; null when it has none.
	 * @param {string} asin
	 * @returns {Promise<Unchecked | null>}
	 */
	async byAsin(asin) {
		const book = await this.ask(`audiobooks/external/audible/${encodeURIComponent(asin)}`);
		return Text.isObject(book) ? book : null;
	}

	/**
	 * A series with its books ({ordinal, book: {id, title}}); null when there is none.
	 * @param {string} id
	 * @returns {Promise<Unchecked | null>}
	 */
	async series(id) {
		const series = await this.ask(`series/${encodeURIComponent(id)}?include=books`);
		return Text.isObject(series) ? series : null;
	}

	/**
	 * A person with their books ({role, book: {id, title}}); null when there is none.
	 * @param {string} id
	 * @returns {Promise<Unchecked | null>}
	 */
	async person(id) {
		const person = await this.ask(`people/${encodeURIComponent(id)}?include=roles`);
		return Text.isObject(person) ? person : null;
	}

	/**
	 * The ASINs an AudiobookDB release has on Audible (AudiobookDB doesn't say which site).
	 * @param {Unchecked} release
	 * @returns {string[]}
	 */
	static asins(release) {
		return (Array.isArray(release.external) ? release.external : [])
			.filter(
				(/** @type {unknown} */ x) =>
					Text.isObject(x) &&
					Text.isObject(x.category) &&
					x.category.title === 'Audible' &&
					typeof x.itemId === 'string',
			)
			.map((/** @type {Unchecked} */ x) => x.itemId.trim().toUpperCase())
			.filter((/** @type {string} */ a) => /^[A-Z0-9]{10}$/.test(a));
	}
}
