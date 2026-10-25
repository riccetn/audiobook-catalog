// A book's cover: AudiobookDB's image an edition keeps the key of (its address can't be worked out from an id),
// then, from the ids its editions already have, Amazon's image of an ASIN (an audiobook's square cover) and Open
// Library's of an edition's id or ISBN. The page tries them in order and shows the first that loads.
import {Text} from './text.js';
import {ExternalCatalog} from './external-catalog.js';
/** @import {Book} from './book.js' */

/** @typedef {'small' | 'large'} CoverSize */

// Amazon's images are asked from media-amazon.com: Firefox's tracking protection lists it as content, blocked only
// when protection is strict, while the older hosts (images-na.ssl-images-amazon.com) are listed as analytics.
const AMAZON_IMAGES = 'https://m.media-amazon.com/images/P/';
// AudiobookDB keeps each image under the hash of its content; the key alone is no image, its sizes are below it.
const AUDIOBOOKDB_IMAGES = 'https://cdn.audiobookdb.org/';
const AUDIOBOOKDB_KEY = /^[0-9a-f]{64}$/;

/** Where a book's cover can be found; every method is static. */
export class Cover {
	/** @type {string[]} the catalogs an edition keeps a cover's key from (`img`), in the order they are tried */
	static CATALOGS = ['audiobookdb'];

	/**
	 * Whether a value is what an edition keeps as its covers: an object of catalog -> the key of its image there,
	 * at least one.
	 * @param {unknown} v
	 * @returns {v is Record<string, string>}
	 */
	static isKeys(v) {
		return (
			Text.isObject(v) &&
			Object.keys(v).length > 0 &&
			Object.entries(v).every(
				([catalog, key]) =>
					Cover.CATALOGS.includes(catalog) && typeof key === 'string' && Cover.isKey(catalog, key),
			)
		);
	}

	/**
	 * Whether `key` is a cover's key on `catalog`.
	 * @param {string} catalog
	 * @param {string} key
	 * @returns {boolean}
	 */
	static isKey(catalog, key) {
		return catalog === 'audiobookdb' && AUDIOBOOKDB_KEY.test(key);
	}

	/**
	 * The key of the first cover in an AudiobookDB answer's `images` ({url: "https://cdn.audiobookdb.org/<key>", ...}),
	 * or null when it has none.
	 * @param {unknown} images
	 * @returns {string | null}
	 */
	static audiobookdbKey(images) {
		for (const image of Array.isArray(images) ? images : []) {
			const url = Text.isObject(image) && typeof image.url === 'string' ? image.url.trim() : '';
			const key = url.startsWith(AUDIOBOOKDB_IMAGES)
				? url.slice(AUDIOBOOKDB_IMAGES.length).replace(/\/$/, '')
				: '';
			if (AUDIOBOOKDB_KEY.test(key)) return key;
		}
		return null;
	}

	/**
	 * The addresses a book's cover may be at, best first, each once: each edition's AudiobookDB cover, then its
	 * ASINs (Amazon), then its Open Library edition id and its ISBN (Open Library, which answers "not found"
	 * rather than a blank image). Empty when its editions have none of those.
	 * @param {Book} book
	 * @param {CoverSize} [size] 'small' for a card, 'large' for the book's details
	 * @returns {string[]}
	 */
	static addresses(book, size = 'small') {
		// Amazon's M and L are 160 and 500 pixels tall, Open Library's M and L 180 and 500, AudiobookDB's small and large
		// 192 and 768: a card's cover sharp on a phone's screen, and the details' at its larger size.
		const amazon = size === 'small' ? 'MZZZZZZZ' : 'LZZZZZZZ',
			openLibrary = size === 'small' ? 'M' : 'L';
		/** @type {string[]} */
		const found = [];
		for (const ed of book.editions) {
			const key = ed.covers.audiobookdb;
			if (key && AUDIOBOOKDB_KEY.test(key)) found.push(`${AUDIOBOOKDB_IMAGES}${key}/${size}.jpg`);
		}
		for (const ed of book.editions)
			for (const [site, asin] of ed.externalList())
				if (ExternalCatalog.family(site) === 'asin' && ExternalCatalog.isId(site, 'edition', asin))
					found.push(`${AMAZON_IMAGES}${encodeURIComponent(asin)}.01.${amazon}.jpg`);
		for (const ed of book.editions) {
			const olid = ed.idOn('openlibrary');
			if (olid && ExternalCatalog.isId('openlibrary', 'edition', olid))
				found.push(
					`https://covers.openlibrary.org/b/olid/${encodeURIComponent(olid)}-${openLibrary}.jpg?default=false`,
				);
			if (ed.isbn)
				found.push(
					`https://covers.openlibrary.org/b/isbn/${encodeURIComponent(ed.isbn)}-${openLibrary}.jpg?default=false`,
				);
		}
		return [...new Set(found)];
	}

	/**
	 * Whether a loaded image is a real cover: Amazon answers an ASIN it has no image for with a 1×1 picture.
	 * @param {number} width the image's natural width
	 * @param {number} height
	 * @returns {boolean}
	 */
	static isCover(width, height) {
		return width > 1 && height > 1;
	}
}
