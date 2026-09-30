# Audiobook catalogue

A personal audiobook library, merged from an Audible export and a Goodreads export, grouped by
series and searchable by title, author, series and genre. The app is a plain `index.html` with
`styles.css` and `app.js` next to it, and it reads the catalogue from `data/`. There is no build step.

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

## Layout

```
data/
  sample/             fictional demo data: the only data committed to git
  books.json          YOUR catalogue, one book per line (git-ignored)
  series-info.json    YOUR researched release info per series (git-ignored)
  excluded.txt        books your imports must never re-add (git-ignored)
  raw/                your Audible/Goodreads exports (git-ignored)
index.html            the page; links styles.css and app.js
styles.css
app.js                the whole UI; fetches data/books.json (or data/sample/) at startup
importers.js          the pipeline: importers, merge, validation (used by the page and the CLI)
catalog.js            the command line: node catalog.js <command> (--help lists the commands)
tests/                node:test suites (*.test.mjs), including the browser smoke test
```

## Data format

`data/books.json` is a list of records with short keys, to keep the file small:

| key  | meaning                                             | required |
|------|-----------------------------------------------------|----------|
| `t`  | title                                               | yes      |
| `a`  | author                                              | yes      |
| `n`  | narrator(s)                                         |          |
| `s`  | series name                                         |          |
| `sn` | position in series, as text (`"3"`, `"4-6"` for a boxed set) |  |
| `g`  | list of genre/tag strings                           |          |
| `id` | Audible ASIN, so re-imports recognise the book      |          |
| `r`  | list of dates you read it, oldest first (`["2023-06-02", "2025-11-20"]`); `"2024-03"` or `"2024"` when you don't remember the day. A single date may be written as a plain string (`"r": "2024-03-15"`); it is read as a list |  |

`data/series-info.json` maps a series name (it must match `s` exactly) to
`{"total": 12, "status": "ongoing" | "complete", "note": "...", "url": "https://..."}`.
`total` is the number of books released so far; `url` (an author or publisher site) is optional.

`make validate` checks all of this and warns about suspicious entries.

## Everyday workflows

**Add new Audible purchases**

1. Export your library with the Audible Library Extractor and save the CSV in `data/raw/`.
2. `node catalog.js import-audible data/raw/<file>.csv --dry-run` to preview, then run it without `--dry-run`.
3. `make test`, then commit `data/books.json`.

Only finished books are imported. The command lists what it added, and anything ambiguous
(for example a book Audible files under several series).

**Or import in the app**: press **Audible CSV** (or **Goodreads CSV**) and pick the export. The page
runs the same importer and merge as the command line (both use `importers.js`), honours
`data/excluded.txt`, and shows the same preview: what is already there, which Audible ids get filled
in, what is new and what needs a look. Nothing changes until you press **Add books**; then, like any
edit in the page, it is saved to `data/books.json` (see below).

**Edit in the app**

Edit books in the page (pencil icon, `+ Add a book`). With `make serve` and your own `data/books.json`,
every change is saved to `data/books.json` and `data/series-info.json` as you make it. With any other
server, or the demo data, edits stay in the browser: press **Export**, then:

```sh
node catalog.js sync-export ~/Downloads/audiobook-catalog-backup-2026-01-01.json --dry-run
node catalog.js sync-export ~/Downloads/audiobook-catalog-backup-2026-01-01.json
```

It refuses files that are not valid catalogue exports and prints what changed before writing.
An export holds both the books and the series info (`{"books": [...], "seriesInfo": {...}}`), so
`sync-export` updates `data/series-info.json` too; backups from before series info was exported (a
plain list of books) still work and leave `data/series-info.json` as it is. The app's **Import**
reads both kinds the same way.
You can also edit `data/books.json` by hand; `make format` restores the one-book-per-line layout.

**Update release info for a series**: press the pencil next to a series (in the series overview or
above its books) to edit how many books are released, whether it is ongoing or complete, the note and
the author site, or to add or remove that info. The form checks the same rules as `make validate`.
Like book edits, the change is saved to `data/series-info.json`. Or edit
`data/series-info.json` by hand, then `make validate`.

**Remove a book for good**: delete it from `data/books.json` *and* add its ASIN (or `Title | Author`
for books without one) to `data/excluded.txt`, otherwise the next import brings it back.

**Keep track of when you read a book**: edit the book in the page and fill in *Date(s) read*
(`2024-03-15`, or `2024-03` / `2024` if you don't remember the day; several dates, comma separated,
for a re-read), or press **+ Read today**. The date shows on the book, and in **All Books** the
*Read in* filter picks the books read in a given year, or those with no date yet. A Goodreads import
fills in its *Date Read* on books that have no dates yet (Goodreads keeps only the latest one); it never
changes dates you already have. Audible imports do not set dates read.

**Goodreads**: `node catalog.js import-goodreads data/raw/goodreads_library_export.csv`, or
**Goodreads CSV** in the app. Goodreads has no "audiobook" flag, so books are picked by edition (Audible Audio, Audiobook, Audio CD,
MP3...) and the *read* shelf. Narrators come from the "Additional Authors" column, which is a guess.

## Tidy names and spacing

Authors and narrators keep a space between initials (`A. B. Quill`, not `A.B. Quill`), so the filters
never list one person twice. Every text field also has stray spacing removed: runs of spaces, tabs,
non-breaking or invisible characters, and leading/trailing whitespace. Both importers and
`sync-export` apply this automatically (`tidyBook` in `importers.js`), and `make validate` warns
about any value that is not tidy. Capitalisation and quote styles are left alone.

## How imports avoid clobbering your edits

Imports only ever *add* books; an existing book is never overwritten. An incoming book counts as
already present if any of these match, strongest first:

1. its Audible `id`
2. same first author + same series (spelling-insensitive: `Ember Coast` = `Ember Coast Series`) + same number
3. same author and title, also forgiving of the long Audible form: `A Crown of Embers 5: A Spark of Dawn`
   finds your `A Spark of Dawn`, and `X, Book 1` finds `X`. A boxed set is never mistaken for its first book.

When a match has no `id` yet, the Audible ASIN is filled in (and likewise dates read, when it has none), so later imports keep matching even
after more edits. New books get the series spelling already in use. If Audible lists a book under
several series, a parent series wins over its sub-series (`Thornmere` over `Thornmere: Wardens`);
otherwise the first is used and the book is flagged in the import output.

## Running the app and saving edits

The page loads its data with `fetch`, which browsers block for pages opened straight from disk
(`file://`), so serve the project folder: `make serve` (it listens on 127.0.0.1 only, since the folder
holds your personal data). Any static web server pointed at the project root works too. The app uses
`data/books.json` and `data/series-info.json`, or `data/sample/` if you have no `data/books.json`;
`--data-dir` and `CATALOG_DATA_DIR` only affect the command line tools, not the page.

`make serve` also saves: every edit in the page (books, series info, CSV imports, **Import** of a
backup) is sent to the server, which checks it like `sync-export` does (the same validation and
tidying) and writes `data/books.json` and `data/series-info.json`. It only accepts saves from the page
it serves, only to your own `data/books.json` (never the demo), and refuses a save if either file changed
on disk since the page loaded it (an import, a `sync-export`, a hand edit), so it never overwrites
those; reload the page to pick them up. A refused or failed save (for example with the server stopped)
says so under the buttons.

Until the disk has them, edits also live in that browser's `localStorage`, and with any other static
server they only live there: use **Export** and `sync-export`. **Export / Import** JSON also make real
backups (books and series info). Local edits are tagged with a fingerprint of the `books.json` and
`series-info.json` they were made against. When either changes, older local edits are **set aside**
(kept under the `audiobook-catalog-data.backup` key) instead of silently hiding your new data; if they
still match on the next load, `make serve` saves them then.

## Development

- `make test` runs `node --test tests/*.test.mjs`: the importers (`importers.test.mjs`), the command
  line and the save endpoint of `serve` (`cli.test.mjs`), checks on the data files (`data.test.mjs`) and the browser smoke test
  (`app.smoke.test.mjs`), which executes the real `app.js` against a small fake DOM built from
  `index.html`, with a fake `fetch` serving the demo data.
- `.github/workflows/ci.yml` runs the same on GitHub Actions.

## Privacy

This repository is meant to be public, so nothing personal is tracked:

- `data/books.json`, `data/series-info.json`, `data/excluded.txt` and `data/raw/*` are in
  `.gitignore`. `tests/data.test.mjs` fails if any of them stops being ignored or a
  file under `data/` other than the demo data becomes tracked.
- The demo data and every example in the tests and docs are invented.
- The consequence: **git does not back up your catalogue.** Keep your own copy: use the app's
  **Export** button, copy the `data/` files somewhere safe, or keep them in a separate *private*
  repository and point the tools at it with `--data-dir ~/my-catalogue-data` (or the
  `CATALOG_DATA_DIR` environment variable).

If you ever commit personal data by mistake, deleting it in a later commit is not enough: it stays
in history. Rewrite the history (or start the repository afresh) before pushing.

## Known data quirks

`make validate` may warn about entries carried over from an Audible export, for example a series
name such as `Some Series (book ), Other Series` when Audible lists several series for one book, or
`∞` as a series number. Fix them with the edit form or in `data/books.json`.
