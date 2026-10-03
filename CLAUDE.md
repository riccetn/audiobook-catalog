# CLAUDE.md

Guidance for Claude Code working in this repository. The README is the user-facing manual; read it
for workflows and the data format. This file covers what you need to change the code safely.

## What this is

A personal audiobook catalogue: static pages (`index.html`, `import.html`, `duplicates.html`, sharing
`styles.css`) that read
`data/books.json` and `data/series-info.json`, plus a Node command line (`catalog.js`) for imports,
validation and a local server that saves edits made in the page.

- Vanilla JavaScript, no framework, no bundler, **no npm packages** (there is no `package.json`).
  Don't add dependencies; use Node built-ins.
- Node 18+ (CI uses 22).

## Commands

```sh
make test       # node --test tests/*.test.mjs  (all suites, incl. the browser smoke test)
make validate   # node catalog.js validate      (CI runs this too)
make serve      # app at http://127.0.0.1:8000/, saves page edits to data/
make format     # node catalog.js format
node catalog.js --help
node --test tests/importers.test.mjs          # one suite
node --test --test-name-pattern='merge' tests/importers.test.mjs   # one test
```

There is no linter or formatter config; match the surrounding style (see Conventions).
CI (`.github/workflows/ci.yml`) runs `make test` then `make validate` on pull requests and on pushes to `main`.

## Architecture

- `importers.js`: the data pipeline, shared by the page and the CLI. It is written as a plain
  script defining the global `CatalogImport` (loaded by every page via `<script>`) and also
  `module.exports` it for `catalog.js`. Keep it that way: no `import`/`require`, no Node or DOM APIs,
  so the page and the CLI import, tidy, validate and merge identically.
  Key pieces: `tidyBook`/`tidyText`/`normalizeName`, `parseReadDate(s)`/`fixBooks`/`fixEditions`, `validate`,
  `readAudible`, `readGoodreads`, `goodreadsCsv` (export for Goodreads' import), `merge`, `seriesLookups`/`seriesFromAudible` (the `series` command),
  `readHardcover`/`hardcoverMatches`/`addHardcoverIds`/`planHardcoverExport` (the `hardcover-*` commands; the
  GraphQL queries are in `HARDCOVER_QUERIES`), `sameEdition`/`saveBook`, `formatEdition`/`parseEditions`,
  `parseExclusions`/`exclusionEntries`, `readBackup`, `mergeBackup`, `fingerprint`, `findDuplicates`/`mergeBooks`/`splitEditions`.
- `catalog.js`: CommonJS CLI (`main(argv, io)`; `series` fetches from Audible and `hardcover-import|export|sync` talk to
  Hardcover's GraphQL API, both through `io.fetch`, and return a promise; the Hardcover token comes from
  `HARDCOVER_TOKEN` in `io.env`/`process.env`, else `data/hardcover-token`) and the `serve` HTTP server. `serve` exposes a save
  endpoint (`handleSave`) that only accepts same-origin requests, never writes the demo data, runs
  the same checks as `sync-export`, refuses a save if the file's `fingerprint` changed on disk since
  the page loaded it, and writes atomically (`writeAtomic`). It also proxies the page's Audible lookups
  (`handleAudible`, `POST api/audible`, same-origin, batches of 25 ASINs); the page offers them when
  `GET api/save` says `audible: true` (`AUDIBLE_LOOKUP` in `store.js`). For the page's Hardcover panel it keeps
  the token (`handleHardcoverToken`, `api/hardcover/token`: GET says whether one is saved, never what it is)
  and runs `cmdHardcover` (`handleHardcover`, `POST api/hardcover`, same-origin, fingerprint-checked like a
  save); the static server never serves the token file. Exports `main`, `createServer` etc. for tests.
- `store.js`: shared by the pages, loaded after `importers.js`: the globals (`DATA`, `SERIES_INFO`,
  `EXCLUSIONS`, ...), loading (`startPage(init)`: fetches `data/`, then falls back to `data/sample/`),
  `persist` (localStorage `audiobook-catalog-data`, tagged with the fingerprint of the files the edits
  were made against, plus `saveToDisk` under `make serve`), the status line and the page links.
  Stale edits are set aside under `audiobook-catalog-data.backup`; `persist` refuses when another
  tab wrote localStorage since this page last did. Each page script defines `refreshPage()` (redraw
  from `DATA`, called after a save to disk tidied the books) and `const READY = startPage(...)`.
  Pairs marked "Not duplicates" (and editions marked "Keep separate") are kept in localStorage
  `audiobook-catalog-not-duplicates` and, under `make serve`, appended to `data/not-duplicates.txt`
  with the next save (`notDuplicates` in the save body and in backups).
  With no `data/books.json` served (the demo, e.g. the installed phone app), a Restore makes the
  backup this device's own catalogue (`keepOnDevice`, localStorage `audiobook-catalog-device`), which
  then loads instead of the demo and takes every save (`ON_DEVICE`).
- `manifest.webmanifest`, `sw.js`, `icons/`: the installable app. `sw.js` is network-first and caches
  only the app and `data/sample/`, never `data/` or `api/`; add new page scripts to its `APP` list
  (the smoke test checks).
- `app.js` (`index.html`): series overview, all books, the book and series-info forms, global-state
  style (`VIEW`, `SERIES_FILTER`, ...). Its merge button links to `duplicates.html#merge=i,j`.
- `import.js` (`import.html`): Audible/Goodreads CSV preview and import, Goodreads CSV export, the Hardcover panel (under `make serve`), Export / Restore / Merge of backups.
- `duplicates.js` (`duplicates.html`): duplicate groups and merging (joining editions that don't
  conflict, `editionsJoinable`), and books whose editions look like one (`splitEditions`).
- `tests/`: `node:test` suites (`*.test.mjs`, ESM).
  - `importers.test.mjs`: pipeline unit tests.
  - `cli.test.mjs`: CLI commands and the `serve` save endpoint, in temp directories.
  - `data.test.mjs`: validates the data files and enforces the privacy rules below.
  - `app.smoke.test.mjs`: runs a page's real HTML and its scripts (`boot({page})`) in `node:vm` with a
    hand-rolled fake DOM and fake `fetch`. When you add elements or DOM APIs to the app, the fake DOM
    may need extending.

## Data model (short form; full table in the README)

`books.json` is a list of titles with short keys `t a s sn g r e` (title, author, series,
series number as text, genres, dates read, editions). Each edition in `e` has `id gr hc hcb isbn n p d len desc`
(Audible ASIN, Goodreads book id, Hardcover edition and book ids, ISBNs, narrator, publisher, release date,
length in minutes, free-text description) and must not be empty. `id`, `gr` and `hc` name an edition
(`EDITION_IDS`); `hcb` is shared by every edition of a Hardcover book, so it only matches books. A box set is one edition copied onto each of its titles, linked by the shared
identifier (`sameEdition`). Books from before editions (with `id`/`gr`/`isbn`/`n` on the book) are
migrated on load by `fixBooks`. A missing `r` means the read date is unknown, not unread. `series-info.json` maps a series
name (must equal `s` exactly) to `{total, status: "ongoing"|"complete", note, url}`.
`data/excluded.txt` lists ASINs, `ISBN 978…`, `Goodreads 12345`, `Hardcover 12345` or `Title | Author` lines that imports must never re-add; code only
ever appends to it. `data/not-duplicates.txt` (pairs marked "Not duplicates" on the
Duplicates page) is append-only too.

Invariants the code relies on:
- Imports only add books, never overwrite. Matching order: any edition's `id`, `gr` or `hc`, then `hcb`, then first author + series + number
  (spelling-insensitive), then author + title (forgiving Audible's long titles, never mistaking a
  boxed set for book 1). A match may gain dates read and editions: an incoming edition fills in the
  edition it shares an identifier with (and that edition's box-set copies), or the match's only
  unshared edition when nothing conflicts, else is added; existing values are never changed.
- Every text field goes through `tidyBook`; `validate` warns on untidy values.
- Anything that writes user data (imports, `sync-export`, `serve` saves) validates first and refuses
  to touch `data/sample/`.
- The Hardcover export only adds to Hardcover (books on the Read shelf, reads); it never changes a
  status, rating or review or removes anything there. The sandbox can't reach Hardcover: its tests use
  the fake API in `tests/cli.test.mjs` (`fakeHardcover`), built from Hardcover's published schema.

## Privacy (hard rule)

The repo is public; the user's library is not.
- Never commit `data/books.json`, `data/series-info.json`, `data/excluded.txt`, `data/not-duplicates.txt`, `data/hardcover-token` or anything in
  `data/raw/`. The token must never reach a page, a backup or a log. `tests/data.test.mjs` fails if they become tracked.
- Only `data/sample/` is committed, and it and every example in tests and docs must be **invented**
  (fictional titles, authors, series). Never use real books from the user's data in tests or docs.

## Conventions

- 2-space indent, semicolons, single quotes, `function name(){` with no space before `{`,
  compact one-line helpers are fine. Comments explain *why* in plain sentences; JSDoc on
  non-obvious functions.
- CLI output and errors are short, plain English; commands that write support `--dry-run`.
- The data files are written as compact `JSON.stringify` output; the owner removed the
  one-book-per-line canonical layout on purpose, so don't reintroduce reformatting.
- Behaviour changes need a test in the matching suite, and a README update when user-visible
  (the README documents every workflow).
- Commit messages: a short imperative summary of the user-visible change
  (e.g. "Exclude removed books from imports, and carry exclusions in exports").
