# Running the app and keeping your catalogue

The pages are ES modules, which browsers won't load from a page opened straight from disk (`file://`),
so serve the project folder: `make serve` (Python's static server on http://localhost:8000/, listening on
127.0.0.1 only), any other static web server pointed at the project root, or GitHub Pages
([On your phone](phone.md)). Nothing on the server takes part: the pages never ask it for anything but
themselves.

## Where the catalogue lives

The catalogue (books, series info, author info and the list of books imports skip) is kept in the
browser's `localStorage`, under the key `audiobook-catalog-device`, and "Not duplicates" marks under
`audiobook-catalog-not-duplicates`. Every edit, import, Restore and Merge is saved there at once. All
pages of the app share it; if two tabs edit the catalogue at once, the one that saves second refuses
and asks you to reload it, rather than overwriting the other.

Each browser keeps its own catalogue, tied to the address the app is served from: `localhost:8000` and
your GitHub Pages site are two catalogues, and so are two browsers on one PC. Move a catalogue with a
backup (below), and combine two that both changed with **Merge** ([Merge a backup from another device](backups.md)).

The first time the app opens somewhere, the catalogue is empty. The app asks the browser to keep its
storage when space runs low, but clearing the site's data (or the browser deciding to) deletes it.
If the stored catalogue can't be read, it is set aside under `audiobook-catalog-device.unreadable` and
the catalogue starts empty; restore a backup.

## Backups

**Export** on *Import & export* downloads a backup: the books, series and author info, the list of books
imports skip and the "Not duplicates" marks, as one JSON file. It is the only copy of your catalogue
outside the browser, so export now and then and keep the files somewhere safe.

**Restore** replaces the catalogue with a backup. It also takes the data files of a catalogue from
before it lived in the browser: pick `books.json`, `series-info.json`, `authors.json`, `excluded.txt` and
`not-duplicates.txt` (from `data/`) together. Only `books.json` is needed; series info and author info
the files don't have are kept as they are, and the exclusions and marks are added to those kept already.

Edits made in a page that was waiting for the old `make serve` to save them to `data/` are taken as the
catalogue the first time the app opens in that browser, if it has no catalogue yet.
