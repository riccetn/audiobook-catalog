# Audiobook catalogue

A personal audiobook library, merged from an Audible export and a Goodreads export, grouped by
series and searchable by title, author, series and genre. The app is three plain pages (the catalogue,
*Import & export* and *Duplicates*) with a stylesheet and a script each, and it reads the catalogue
from `data/`. There is no build step.

- Vanilla JavaScript for the app: no framework, no bundler, no dependencies
- Node 18+ for the command line tools (`node catalog.js`) and the tests; no npm packages

```sh
git clone <this repo> && cd audiobook-catalog
make test     # all tests, including a browser smoke test (uses the bundled fictional demo data)
make serve    # serves the app (with the demo data) at http://localhost:8000/
make help
```

## Start your own catalogue

The repository ships **fictional demo data** only; your own library lives in git-ignored files.

```sh
node catalog.js init                                     # creates data/books.json etc. (empty)
cp ~/Downloads/ALE-spreadsheet-library.csv data/raw/     # your Audible Library Extractor export
node catalog.js import-audible data/raw/ALE-spreadsheet-library.csv --dry-run
node catalog.js import-audible data/raw/ALE-spreadsheet-library.csv
make serve                                               # your catalogue at http://localhost:8000/
```

Until `data/books.json` exists, the app and `validate` fall back to the demo data (`validate` says so).
Commands that write refuse to touch the demo data.

## Using it

- The catalogue page browses by series or all books and edits books and series info; *Import & export*
  imports Audible and Goodreads CSVs, makes backups and merges them; *Duplicates* merges books entered twice.
- With `make serve` and your own `data/books.json`, every edit in the pages is saved to `data/` as you
  make it. With any other server, or the demo data, edits stay in the browser: **Export** them and run
  `node catalog.js sync-export <file>`.
- The catalogue can also import from and export to your shelves on [Hardcover](docs/hardcover.md).
- `make validate` checks the data files and warns about suspicious entries.

## Documentation

- [Everyday workflows](docs/workflows.md): imports, editing, series info, missing books, removing and
  merging books, dates read, Goodreads import and export, links
- [Data format](docs/data-format.md): `books.json`, editions, box sets, `series-info.json`, tidy names
  and known data quirks
- [Merge a backup from another device](docs/backups.md): combining two catalogues that both changed
- [Hardcover](docs/hardcover.md): importing, exporting and syncing with Hardcover
- [How imports avoid clobbering your edits](docs/imports.md): how imported books are matched and merged
- [Running the app and saving edits](docs/saving.md): `make serve`, browser storage, backups
- [On your phone](docs/phone.md): installing the app and keeping a catalogue on the device
- [Development](docs/development.md): file layout and tests

## Privacy

This repository is meant to be public, so nothing personal is tracked:

- `data/books.json`, `data/series-info.json`, `data/excluded.txt`, `data/hardcover-token` and `data/raw/*` are in
  `.gitignore`. `tests/data.test.mjs` fails if any of them stops being ignored or a
  file under `data/` other than the demo data becomes tracked.
- The demo data and every example in the tests and docs are invented.
- The consequence: **git does not back up your catalogue.** Keep your own copy: use the app's
  **Export** button, copy the `data/` files somewhere safe, or keep them in a separate *private*
  repository and point the tools at it with `--data-dir ~/my-catalogue-data` (or the
  `CATALOG_DATA_DIR` environment variable).

If you ever commit personal data by mistake, deleting it in a later commit is not enough: it stays
in history. Rewrite the history (or start the repository afresh) before pushing.
