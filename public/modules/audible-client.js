// Audible's catalog API (api.audible.<site>/1.0/catalog/...), which needs no account but doesn't answer web
// pages, so the page asks it through the catalog proxy (the fetch it is given: route in, Response out), and the
// tests give it a fake. Each Audible site has its own catalog: its own ASINs for books and series.
import {Text} from './text.js';
import {CatalogClient} from './catalog-client.js';
/** @import {Unchecked} from './text.js' */
/** @import {Step} from './catalog-client.js' */

/** Asks Audible's catalog API of one site or another through the catalog proxy, one request at a time. */
export class AudibleClient extends CatalogClient {
	// the prefix of the Audible panel on Import & export; ids go under each site's key (audible.co.uk)
	static CATALOG = 'audible';
	static LABEL = 'Audible';
	// an ASIN, of a book or a series
	static ID = /^[A-Z0-9]{10}$/;
	// no key: Audible's catalog is asked without an account
	static KEY_NAME = '';
	static KEY_NEEDED = false;
	static VIA_PROXY = true;
	static PAUSE_MS = 250;
	/** The most ASINs Audible answers in one request (it refuses more). */
	static BATCH = 50;

	/**
	 * Ask `site`'s catalog for `path` (under its API's catalog/, with any query); null for a 404. Throws with a
	 * short reason when Audible or the proxy says no.
	 * @param {string} site
	 * @param {string} path
	 * @returns {Promise<Unchecked | null>}
	 */
	async ask(site, path) {
		await this.waitTurn();
		const res = await this.get(`audible/${site}/catalog/${path}`);
		if (res.status === 404) return null;
		if (res.status === 401) throw new Error('your server refused its key (check it on the Import & export page)');
		/** @type {unknown} */
		let json = null;
		try {
			json = await res.json();
		} catch {
			/* reported below */
		}
		const said = Text.isObject(json) && typeof json.message === 'string' ? ` (${Text.tidy(json.message)})` : '';
		if (!res.ok || !Text.isObject(json)) throw new Error(`Audible (${site}) answered ${res.status}${said}`);
		return json;
	}

	/**
	 * A product (a book, or a series) on `site` with the response `groups` asked; null when the site doesn't
	 * have it (Audible answers that with a product of only its ASIN, without a title).
	 * @param {string} site
	 * @param {string} asin
	 * @param {string} groups
	 * @returns {Promise<Unchecked | null>}
	 */
	async product(site, asin, groups) {
		const answer = await this.ask(site, `products/${encodeURIComponent(asin)}?response_groups=${groups}`);
		const product = answer && answer.product;
		return Text.isObject(product) && AudibleClient.titled(product) ? product : null;
	}

	/**
	 * A series on `site` with the response `groups` asked, its books under `relationships`; null when the site
	 * doesn't have it. Its books are what counts: a series' answer may come without a title.
	 * @param {string} site
	 * @param {string} asin
	 * @param {string} groups
	 * @returns {Promise<Unchecked | null>}
	 */
	async series(site, asin, groups) {
		const answer = await this.ask(site, `products/${encodeURIComponent(asin)}?response_groups=${groups}`);
		const product = answer && answer.product;
		return Text.isObject(product) &&
			(AudibleClient.titled(product) || (Array.isArray(product.relationships) && product.relationships.length))
			? product
			: null;
	}

	/**
	 * The products of `asins` on `site`, BATCH at a time, by ASIN; those the site doesn't have are left out.
	 * @param {string} site
	 * @param {string[]} asins
	 * @param {string} groups
	 * @param {Step} step
	 * @param {string} text what the step says
	 * @returns {Promise<Map<string, Unchecked>>}
	 */
	async products(site, asins, groups, step, text) {
		/** @type {Map<string, Unchecked>} */
		const found = new Map();
		const batches = [];
		for (let i = 0; i < asins.length; i += AudibleClient.BATCH)
			batches.push(asins.slice(i, i + AudibleClient.BATCH));
		await AudibleClient.each(batches, text, step, async batch => {
			const answer = await this.ask(
				site,
				`products?asins=${batch.map(encodeURIComponent).join(',')}&response_groups=${groups}`,
			);
			const products = answer && Array.isArray(answer.products) ? answer.products : [];
			for (const p of products)
				if (Text.isObject(p) && typeof p.asin === 'string' && AudibleClient.titled(p)) found.set(p.asin, p);
		});
		return found;
	}

	/**
	 * Whether a product is one the site has: it has a title.
	 * @param {Unchecked} product
	 * @returns {boolean}
	 */
	static titled(product) {
		return typeof product.title === 'string' && Boolean(Text.tidy(product.title));
	}
}
