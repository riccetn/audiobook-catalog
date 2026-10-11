# Audiobook catalogue

A personal audiobook library, merged from Audible, Goodreads and Hardcover exports, grouped by series
and searchable by title, author, series and genre. The app is four plain pages (the catalogue, *Authors*,
*Import & export* and *Duplicates*) with a stylesheet and a script each, all in `public/`. Everything runs in the browser,
and the catalogue is kept in the browser's local storage. There is no build step and no server code.

- Vanilla JavaScript: no framework, no bundler, no dependencies
- Node 18+ only for the tests; no npm packages

```sh
git clone <this repo> && cd audiobook-catalog
make test     # all tests, including a browser smoke test
make serve    # serves public/ at http://localhost:8000/ (any static server, or GitHub Pages, works too)
make help
```

## Start your own catalogue

The first time the app opens in a browser, the catalogue is empty. Fill it from *Import & export*:
import an [Audible](docs/audible.md), [Goodreads](docs/goodreads.md) or [Hardcover](docs/hardcover.md)
library, restore a backup, or add books by hand with **+ Add a book**.

If you kept the catalogue in `data/` files before it moved into the browser, **Restore** on *Import & export*
takes them: pick `books.json`, `series-info.json`, `authors.json`, `excluded.txt` and `not-duplicates.txt`
together. After that the files are no longer used.

## Using it

- The catalogue page browses by series or all books and edits books and series info; *Import & export*
  imports CSVs, runs Hardcover, checks the catalogue, makes backups and merges them; *Duplicates* merges books entered twice.
- *Authors* gives each author a page with a short bio, links to their website and their Audible, Goodreads
  and Hardcover pages, and their series and titles ([Authors](docs/authors.md)).
- Every edit is saved in the browser as you make it. Each browser (and each phone) keeps its own
  catalogue, so **Export** a backup now and then: it is the only copy outside the browser.

## Documentation

- [Everyday workflows](docs/workflows.md): editing, series info, missing books, removing and merging
  books, ISBNs, dates read, links
- [Authors](docs/authors.md): author pages with a bio, links, and their series and titles
- [Data format](docs/data-format.md): books, editions, box sets, series info, author info, tidy names
  and known data quirks
- [Audible](docs/audible.md): importing your Audible library
- [Goodreads](docs/goodreads.md): importing from and exporting to Goodreads
- [Hardcover](docs/hardcover.md): importing, exporting and syncing with Hardcover
- [Merge a backup from another device](docs/backups.md): combining two catalogues that both changed
- [How imports avoid clobbering your edits](docs/imports.md): how imported books are matched and merged
- [Running the app and keeping your catalogue](docs/saving.md): serving the pages, browser storage, backups
- [On your phone](docs/phone.md): installing the app
- [Development](docs/development.md): file layout and tests

## Privacy

This repository is meant to be public, and your catalogue never enters it: it lives in your browser.

- The demo data in `data/sample/` (used by the tests) and every example in the tests and docs are invented.
- Data files from before the catalogue moved into the browser (`data/books.json`, `data/series-info.json`,
  `data/authors.json`, `data/excluded.txt`, `data/not-duplicates.txt`, `data/hardcover-token`) and `data/raw/*`
  are in `.gitignore`. `tests/data.test.mjs` fails if any of them stops being ignored or a file under `data/`
  other than the demo data becomes tracked.
- **Nothing backs up your catalogue but you.** Clearing the site's data in the browser deletes it, so keep
  the backups you **Export** somewhere safe.

If you ever commit personal data by mistake, deleting it in a later commit is not enough: it stays
in history. Rewrite the history (or start the repository afresh) before pushing.
