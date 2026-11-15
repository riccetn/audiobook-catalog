// A book's cover: the image an edition keeps the key of (in a catalog whose covers' addresses can't be worked out
// from an id), then, from the ids its editions already have, the cover each catalog has of an id or of the ISBN.
// Which catalogs have covers, and where, is in their definitions (ExternalCatalog, CoverDefinition). The page tries
// the addresses in order and shows the first that loads.
import {Text} from './text.js';
import {ExternalCatalog} from './external-catalog.js';
import type {CoverDefinition, CoverSize} from './external-catalog.js';
import type {Book} from './book.js';

export type {CoverSize};

/** the catalogs with covers by an id or an ISBN, a family's once (its sites share them), in the usual order */
const BY_ID: {family: string; cover: CoverDefinition}[] = [];
for (const def of ExternalCatalog.ALL)
	if (def.cover && (def.cover.byId || def.cover.byIsbn) && !BY_ID.some(x => x.family === def.family))
		BY_ID.push({family: def.family, cover: def.cover});

/**
 * A cover's address from its catalog's pattern, with `value` in place of {id}, {isbn} or {key}.
 */
function address(pattern: string, cover: CoverDefinition, size: CoverSize, value: string): string {
	return pattern.replace(/\{(?:id|isbn|key)\}/, encodeURIComponent(value)).replace('{size}', cover.sizes[size]);
}

/** Where a book's cover can be found; every method is static. */
export class Cover {
	/** the catalogs an edition keeps a cover's key from (`img`), in the order they are tried */
	static CATALOGS: string[] = ExternalCatalog.ALL.filter(def => def.cover && def.cover.byKey).map(def => def.key);

	/**
	 * Whether a value is what an edition keeps as its covers: an object of catalog -> the key of its image there,
	 * at least one.
	 */
	static isKeys(v: unknown): v is Record<string, string> {
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
	 */
	static isKey(catalog: string, key: string): boolean {
		const cover = Cover.CATALOGS.includes(catalog) ? ExternalCatalog.coverOf(catalog) : null;
		return !!cover && !!cover.key && new RegExp(`^(?:${cover.key})$`).test(key);
	}

	/**
	 * The key of the cover a catalog's answer gives the address of ("https://cdn.audiobookdb.org/<key>"), which is
	 * what an edition keeps; null when it is no address of a cover there.
	 */
	static keyOf(catalog: string, image: unknown): string | null {
		const cover = ExternalCatalog.coverOf(catalog),
			url = typeof image === 'string' ? image.trim() : '';
		if (!cover || !cover.keyAt || !url.startsWith(cover.keyAt)) return null;
		const key = url.slice(cover.keyAt.length).replace(/\/$/, '');
		return Cover.isKey(catalog, key) ? key : null;
	}

	/**
	 * The addresses a book's cover may be at, best first, each once: each edition's covers by the keys it keeps,
	 * then, catalog by catalog, each edition's cover by its id there and by its ISBN. Empty when its editions have
	 * none of those.
	 * @param size 'small' for a card, 'large' for the book's details
	 */
	static addresses(book: Book, size: CoverSize = 'small'): string[] {
		const found: string[] = [];
		for (const catalog of Cover.CATALOGS) {
			const cover = ExternalCatalog.coverOf(catalog);
			for (const ed of book.editions) {
				const key = ed.covers[catalog];
				if (cover && cover.byKey && key && Cover.isKey(catalog, key))
					found.push(address(cover.byKey, cover, size, key));
			}
		}
		for (const {family, cover} of BY_ID)
			for (const ed of book.editions) {
				if (cover.byId)
					for (const [key, id] of ed.externalList())
						if (ExternalCatalog.family(key) === family && ExternalCatalog.isId(key, 'edition', id))
							found.push(address(cover.byId, cover, size, id));
				if (cover.byIsbn && ed.isbn) found.push(address(cover.byIsbn, cover, size, ed.isbn));
			}
		return [...new Set(found)];
	}

	/**
	 * Whether a loaded image is a real cover: a catalog may answer an id it has no image for with a 1×1 picture.
	 * @param width the image's natural width
	 */
	static isCover(width: number, height: number): boolean {
		return width > 1 && height > 1;
	}
}
