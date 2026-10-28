// What the series and author pages' Compare buttons offer: each catalog of CatalogConnectors.SYNCS (its
// client's CATALOG and LABEL, and its PARTS), as plain data, so those pages don't load the syncs, their
// clients and everything the Import & export page compares with. A test keeps it the same as SYNCS.

/**
 * A catalog a series' or an author's books can be compared with.
 * @typedef {object} CompareCatalog
 * @property {string} catalog its client's CATALOG, which the Import & export page's panel is named by
 * @property {string} label its client's LABEL
 * @property {readonly ('series' | 'author')[]} parts what of the catalog it compares (its sync's PARTS)
 */

/** The catalogs the series and author pages compare with. */
export class CompareCatalogs {
	/**
	 * In the order of CatalogConnectors.SYNCS.
	 * @type {readonly CompareCatalog[]}
	 */
	static ALL = [
		{catalog: 'hardcover', label: 'Hardcover', parts: ['series', 'author']},
		{catalog: 'audiobookdb', label: 'AudiobookDB', parts: ['series', 'author']},
		{catalog: 'audible', label: 'Audible', parts: ['series']},
	];

	/**
	 * The catalogs that compare a series' or an author's books.
	 * @param {'series' | 'author'} kind
	 * @returns {CompareCatalog[]}
	 */
	static of(kind) {
		return CompareCatalogs.ALL.filter(c => c.parts.includes(kind));
	}
}
