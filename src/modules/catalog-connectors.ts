// Every external catalog the app reads or writes, by what it does: the export files it imports, the files it
// writes for another catalog's import, the catalogs whose shelves it compares and sends to, and the catalogs
// the Edit page looks books up in. The pages and CatalogLookup go through these lists and the base classes
// alone (FileImporter, FileExporter, ShelfSync, BookSource, CatalogClient), so a catalog is added by writing its
// classes and listing them here, and its ids, and what they can do, in ExternalCatalog; nothing else names a catalog.
import {AudibleImporter} from './audible-importer.js';
import {GoodreadsImporter} from './goodreads-importer.js';
import {GoodreadsExporter} from './goodreads-exporter.js';
import {HardcoverSync} from './hardcover-sync.js';
import {AudiobookdbSync} from './audiobookdb-sync.js';
import {AudibleSync} from './audible-sync.js';
import {AudibleSource} from './audible-source.js';
import {AudiobookdbSource} from './audiobookdb-source.js';
import {HardcoverSource} from './hardcover-source.js';
import {OpenLibrarySource} from './open-library-source.js';
import {WikidataSource} from './wikidata-source.js';
import type {ClientClass} from './catalog-client.js';

/** A catalog's panel on Import & export, as templates/pages/import.liquid writes it; the notes are the page's HTML. */
export interface CatalogPanel {
	/** the panel's prefix: its ids are `<catalog>Panel`, `<catalog>ImportBtn`, ... */
	catalog: string;
	label: string;
	/** how it is reached, beside the heading ('CSV file', 'Online') */
	via: string;
	/** the Import row: the sites to pick from (none for a catalog with one), the button's title, the row's note */
	importer: {sites: readonly string[]; title: string; note: string} | null;
	/** the Export row: what kind of file it downloads ('CSV'), the button's title, the row's note */
	exporter: {format: string; title: string; note: string} | null;
	/** the Compare row of a catalog whose shelves are compared for every book */
	compare: {note: string} | null;
	/** a note below the rows (a catalog compared only on the Edit page) */
	note: string;
	/** the row of your key: what the catalog calls it ('API token') and the buttons' word for it ('token') */
	key: {name: string; word: string} | null;
}

/** The external catalogs, by what the app does with them. */
export class CatalogConnectors {
	/** The export files that are imported, as their panels show them on Import & export. */
	static IMPORTERS = [AudibleImporter, GoodreadsImporter];
	/** The files written for another catalog's import. */
	static EXPORTERS = [GoodreadsExporter];
	/**
	 * The catalogs whose shelves are compared with the catalog, and sent to; and Audible, whose series are
	 * compared (it has no shelves of yours, so nothing is sent).
	 */
	static SYNCS = [HardcoverSync, AudiobookdbSync, AudibleSync];
	/**
	 * The client classes of those catalogs that take your key, which Import & export saves.
	 */
	static CLIENTS: ClientClass[] = CatalogConnectors.SYNCS.map(sync => sync.CLIENT).filter(
		Client => Client.KEY_STORAGE,
	);
	/**
	 * The catalogs the Edit page looks books up in, in the order they are asked: the store's own catalog first
	 * for an ASIN (Audible, then AudiobookDB, then Hardcover only when neither has it), Hardcover before Open
	 * Library for an ISBN, as it knows audiobooks best.
	 */
	static SOURCES = [AudibleSource, AudiobookdbSource, HardcoverSource, OpenLibrarySource, WikidataSource];

	/**
	 * The client class of a catalog, by its CATALOG (its group's key in ExternalCatalog: 'hardcover'); null when
	 * the app asks it nothing.
	 */
	static client(catalog: string): ClientClass | null {
		const clients: ClientClass[] = [
			...CatalogConnectors.SYNCS.map(sync => sync.CLIENT),
			...CatalogConnectors.SOURCES.map(source => source.CLIENT),
		];
		return clients.find(Client => Client.CATALOG && Client.CATALOG === catalog) || null;
	}

	/**
	 * The catalogs with a panel on Import & export, each once, in the order they are listed above, with what its
	 * panel holds: its importer, exporter and shelf sync (null for none). make pages writes the panels from this.
	 */
	static panels(): CatalogPanel[] {
		const keys = [
			...CatalogConnectors.IMPORTERS.map(x => x.CATALOG),
			...CatalogConnectors.EXPORTERS.map(x => x.CATALOG),
			...CatalogConnectors.SYNCS.map(x => x.CLIENT.CATALOG),
		];
		return [...new Set(keys)].map(catalog => {
			const Importer = CatalogConnectors.IMPORTERS.find(x => x.CATALOG === catalog) || null,
				Exporter = CatalogConnectors.EXPORTERS.find(x => x.CATALOG === catalog) || null,
				Sync = CatalogConnectors.SYNCS.find(x => x.CLIENT.CATALOG === catalog) || null;
			const Client = Sync ? Sync.CLIENT : null;
			return {
				catalog,
				label: (Importer || Exporter || Client)?.LABEL || catalog,
				via: (Importer || Exporter)?.VIA || (Client?.VIA_PROXY ? 'Through the proxy' : 'Online'),
				importer: Importer && {sites: Importer.SITES, title: Importer.PANEL_TITLE, note: Importer.PANEL_NOTE},
				exporter: Exporter && {
					format: Exporter.FORMAT,
					title: Exporter.PANEL_TITLE,
					note: Exporter.PANEL_NOTE,
				},
				compare: Sync && Sync.EVERY_BOOK ? {note: Sync.PANEL_NOTE} : null,
				note: Sync && !Sync.EVERY_BOOK ? Sync.PANEL_NOTE : '',
				key: Client && Client.KEY_STORAGE ? {name: Client.KEY_NAME, word: Client.KEY_WORD} : null,
			};
		});
	}
}
