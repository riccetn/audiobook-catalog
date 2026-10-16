# Running the app and keeping your catalog

The pages are ES modules, which browsers won't load from a page opened straight from disk (`file://`),
so serve the `public/` folder, which holds the whole app and nothing else: `make serve` (Python's static
server on http://localhost:8000/, listening on 127.0.0.1 only), any other static web server pointed at
`public/`, or GitHub Pages ([On your phone](phone.md)). Nothing on the server takes part: the pages never
ask it for anything but themselves, and the rest of the repository (`data/`, `docs/`, `tests/`) is never
served.

## Where the catalog lives

The catalog (books, series info, author, narrator and publisher info, the list of books imports skip and
the "Not duplicates" marks) is kept in the browser's IndexedDB, in a database called `audiobook-catalog`,
as a record per book, edition, series and person ([How the browser keeps it](data-format.md#how-the-browser-keeps-it)).
Every edit, import, Restore and Merge is saved there at once, and a save writes only what changed. All
pages of the app share it; if two tabs edit the catalog at once, the one that saves second refuses
and asks you to reload it, rather than overwriting the other.

Each browser keeps its own catalog, tied to the address the app is served from: `localhost:8000` and
your GitHub Pages site are two catalogs, and so are two browsers on one PC. Move a catalog with a
backup (below), and combine two that both changed with **Merge** ([Merge a backup from another device](backups.md)).

The first time the app opens somewhere, the catalog is empty. The app asks the browser to keep its
storage when space runs low, but clearing the site's data (or the browser deciding to) deletes it.
If the stored catalog can't be read, it is set aside (in the database's `meta` store, under `unreadable`)
and the catalog starts empty; restore a backup. A browser that keeps no IndexedDB for the page (some
private windows) shows the catalog but saves nothing, and says so: export a backup before you leave.

**From localStorage**: until 2026-10 the catalog was kept in `localStorage`, under the key
`audiobook-catalog-device`, with the "Not duplicates" marks under `audiobook-catalog-not-duplicates`. The
first time the app opens in a browser that still has those, it moves them into IndexedDB (in the current
format) and renames the keys to `audiobook-catalog-device.moved-to-indexeddb` and
`audiobook-catalog-not-duplicates.moved-to-indexeddb`, a copy that is never read again. A catalog with a
value IndexedDB has no place for (a value that isn't what its field holds, or a key no book has, which
**Check** lists) is shown but not moved, and nothing is saved until it is fixed: export a backup, fix
the values the message names, and Restore it.

## Backups

**Export** on *Import & export* downloads a backup: the books, series, author, narrator and publisher info, the list of books
imports skip and the "Not duplicates" marks, as one JSON file. It is the only copy of your catalog
outside the browser, so export now and then and keep the files somewhere safe.

**Restore** replaces the catalog with a backup; the books, editions, series and people keep the ids they
were stored under (a backup carries them), so a Restore of this browser's own backup puts back the same
records. A backup with a value the catalog has no place for is not restored, and the message names it.
It also takes the data files of a catalog from
before it lived in the browser: pick `books.json`, `series-info.json`, `authors.json`, `excluded.txt` and
`not-duplicates.txt` (from `data/`) together. Only `books.json` is needed; series info and author info
the files don't have are kept as they are, and the exclusions and marks are added to those kept already.

Edits made in a page that was waiting for the old `make serve` to save them to `data/` are taken as the
catalog the first time the app opens in that browser, if it has no catalog yet.
