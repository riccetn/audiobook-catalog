// Every external catalog the app reads or writes, by what it does: the export files it imports, the files it
// writes for another catalog's import, the catalogs whose shelves it compares and sends to, and the catalogs
// the book form looks books up in. The pages and CatalogLookup go through these lists and the base classes
// alone (FileImporter, FileExporter, ShelfSync, BookSource, CatalogClient), so a catalog is added by writing its
// classes and listing them here (and its ids in ExternalCatalog, as before).
import {AudibleImporter} from './audible-importer.js';
import {GoodreadsImporter} from './goodreads-importer.js';
import {GoodreadsExporter} from './goodreads-exporter.js';
import {HardcoverSync} from './hardcover-sync.js';
import {AudiobookdbSync} from './audiobookdb-sync.js';
import {AudibleSource} from './audible-source.js';
import {AudiobookdbSource} from './audiobookdb-source.js';
import {HardcoverSource} from './hardcover-source.js';
import {OpenLibrarySource} from './open-library-source.js';
import {WikidataSource} from './wikidata-source.js';
/** @import {ClientClass} from './catalog-client.js' */

/** The external catalogs, by what the app does with them. */
export class CatalogConnectors {
	/** The export files that are imported, as their panels show them on Import & export. */
	static IMPORTERS = [AudibleImporter, GoodreadsImporter];
	/** The files written for another catalog's import. */
	static EXPORTERS = [GoodreadsExporter];
	/** The catalogs whose shelves are compared with the catalog, and sent to. */
	static SYNCS = [HardcoverSync, AudiobookdbSync];
	/**
	 * The client classes of those catalogs: their keys, which Import & export saves.
	 * @type {ClientClass[]}
	 */
	static CLIENTS = CatalogConnectors.SYNCS.map(sync => sync.CLIENT);
	/**
	 * The catalogs the book form looks books up in, in the order they are asked: the store's own catalog first
	 * for an ASIN (Audible, then AudiobookDB, then Hardcover only when neither has it), Hardcover before Open
	 * Library for an ISBN, as it knows audiobooks best.
	 */
	static SOURCES = [AudibleSource, AudiobookdbSource, HardcoverSource, OpenLibrarySource, WikidataSource];
}
