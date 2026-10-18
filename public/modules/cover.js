// A book's cover, from the ids its editions already have, so nothing about it is stored: Amazon's image of an
// ASIN (an audiobook's square cover), then Open Library's of an edition's id or ISBN. The page tries them in
// order and shows the first that loads.
import {ExternalCatalog} from './external-catalog.js';
/** @import {Book} from './book.js' */

/** @typedef {'small' | 'large'} CoverSize */

// Amazon's images are asked from media-amazon.com: Firefox's tracking protection lists it as content, blocked only
// when protection is strict, while the older hosts (images-na.ssl-images-amazon.com) are listed as analytics.
const AMAZON_IMAGES = 'https://m.media-amazon.com/images/P/';

/** Where a book's cover can be found; every method is static. */
export class Cover {
	/**
	 * The addresses a book's cover may be at, best first, each once: each edition's ASINs (Amazon), then its
	 * Open Library edition id and its ISBN (Open Library, which answers "not found" rather than a blank image).
	 * Empty when its editions have none of those.
	 * @param {Book} book
	 * @param {CoverSize} [size] 'small' for a card, 'large' for the book's details
	 * @returns {string[]}
	 */
	static addresses(book, size = 'small'){
		// Amazon's M and L are 160 and 500 pixels tall, Open Library's M and L 180 and 500: a card's cover sharp on a phone's
		// screen, and the details' at its larger size.
		const amazon = size === 'small' ? 'MZZZZZZZ' : 'LZZZZZZZ', openLibrary = size === 'small' ? 'M' : 'L';
		/** @type {string[]} */
		const found = [];
		for(const ed of book.editions)
			for(const [site, asin] of ed.externalList())
				if(ExternalCatalog.family(site) === 'asin' && ExternalCatalog.isId(site, 'edition', asin)) found.push(`${AMAZON_IMAGES}${encodeURIComponent(asin)}.01.${amazon}.jpg`);
		for(const ed of book.editions){
			const olid = ed.idOn('openlibrary');
			if(olid && ExternalCatalog.isId('openlibrary', 'edition', olid))
				found.push(`https://covers.openlibrary.org/b/olid/${encodeURIComponent(olid)}-${openLibrary}.jpg?default=false`);
			if(ed.isbn) found.push(`https://covers.openlibrary.org/b/isbn/${encodeURIComponent(ed.isbn)}-${openLibrary}.jpg?default=false`);
		}
		return [...new Set(found)];
	}

	/**
	 * Whether a loaded image is a real cover: Amazon answers an ASIN it has no image for with a 1×1 picture.
	 * @param {number} width the image's natural width
	 * @param {number} height
	 * @returns {boolean}
	 */
	static isCover(width, height){ return width > 1 && height > 1; }
}
