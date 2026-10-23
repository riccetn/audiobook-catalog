# Running the app and keeping your catalog

The pages are ES modules, which browsers won't load from a page opened straight from disk (`file://`),
so serve the `public/` folder, which holds the whole app and nothing else: `make serve` (Python's static
server on http://localhost:8000/, listening on 127.0.0.1 only), any other static web server pointed at
`public/` once `make pages` has written its pages from `templates/`, or GitHub Pages ([On your phone](phone.md)). Nothing on the server takes part: the pages never
ask it for anything but themselves, and the rest of the repository (`data/`, `docs/`, `templates/`, `tests/`) is never
served.

## Where the catalog lives

The catalog (books, series info, author, narrator and publisher info, the list of books imports skip and
the "Not duplicates" marks) is kept in the browser's IndexedDB, in a database called `audiobook-catalog`,
as a record per book, edition, series and person ([How the browser keeps it](data-format.md#how-the-browser-keeps-it)).
Every edit, import, Restore and Merge is saved there at once, and a save writes only what changed. All
pages of the app share it, and tabs can edit it at once: a tab that saves after another one did takes in
what the other changed first, so edits of different books, series or people in different tabs are all
kept (the tab shows the other's changes from then on). When both tabs changed the same entry (a book, an
edition, a series, a person), the tab that saves second saves nothing, names the entry and asks you to
reload it and make the change again, rather than overwriting the other.

Since the catalog is only in this browser, keep a backup: **Export** on the *Import & export* page (its
**Backups** panel comes first there) downloads one. The panel says when this browser last downloaded or
restored a backup and how many changes were saved since, and the *Series* and *Books* pages show a reminder when changes
were saved and the last backup is two weeks old, or 50 changes old (10 when there is none yet). This browser
keeps that date in localStorage (`audiobook-catalog-last-backup`).

## What each page loads

A page reads only what it shows, so a large catalog opens as fast as a small one:

- **Series**: the series records (each keeps how many books you own and which are missing),
  without reading a book.
- **A series** or **Standalone**: those books, their editions, and the series and people they name.
- **A book's page**: that book, and the other books of a box set it shares an edition with.
- **Books**: the first 50 books in the order shown (searched and filtered by the database's indexes),
  then 50 more with each press of **Show more**.
- **Authors**, **Narrators**, **Publishers**: the list is read from the people's records alone (each keeps
  how many books and series they have); someone's page reads their books.
- **Duplicates**: every book, since finding duplicates means comparing them all.
- **Import & export**: only how many books there are, until you press Import, Check, Box sets, a Hardcover
  button, Export, Restore or Merge; then the whole catalog, which the page keeps from then on.

The Duplicates link's count takes every book too: it is kept with the catalog, and a page that changed
the catalog counts again in the background after it saved.

 tied to the address the app is served from: `localhost:8000` and
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
