# CLAUDE.md

Guidance for Claude Code working in this repository. The README is the user-facing manual; read it
for workflows and the data format. This file covers what you need to change the code safely.

## What this is

A personal audiobook catalogue: a static page (`index.html`, `styles.css`, `app.js`) that reads
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
CI (`.github/workflows/ci.yml`) runs `make test` then `make validate` on push and PR.

## Architecture

- `importers.js`: the data pipeline, shared by the page and the CLI. It is written as a plain
  script defining the global `CatalogImport` (loaded by `index.html` via `<script>`) and also
  `module.exports` it for `catalog.js`. Keep it that way: no `import`/`require`, no Node or DOM APIs,
  so the page and the CLI import, tidy, validate and merge identically.
  Key pieces: `tidyBook`/`tidyText`/`normalizeName`, `parseReadDate(s)`/`fixBooks`/`fixEditions`, `validate`,
  `readAudible`, `readGoodreads`, `merge`, `sameEdition`/`saveBook`, `formatEdition`/`parseEditions`,
  `parseExclusions`/`exclusionEntries`, `readBackup`, `fingerprint`.
- `catalog.js`: CommonJS CLI (`main(argv, io)`) and the `serve` HTTP server. `serve` exposes a save
  endpoint (`handleSave`) that only accepts same-origin requests, never writes the demo data, runs
  the same checks as `sync-export`, refuses a save if the file's `fingerprint` changed on disk since
  the page loaded it, and writes atomically (`writeAtomic`). Exports `main`, `createServer` etc. for tests.
- `app.js`: the whole UI, global-state style (`DATA`, `SERIES_INFO`, `VIEW`, ...) rendering into
  elements from `index.html`. Fetches `data/` then falls back to `data/sample/`. Keeps unsaved edits in
  `localStorage` (`audiobook-catalog-data`), tagged with the fingerprint of the files they were made
  against; stale edits are set aside under `audiobook-catalog-data.backup`.
- `tests/`: `node:test` suites (`*.test.mjs`, ESM).
  - `importers.test.mjs`: pipeline unit tests.
  - `cli.test.mjs`: CLI commands and the `serve` save endpoint, in temp directories.
  - `data.test.mjs`: validates the data files and enforces the privacy rules below.
  - `app.smoke.test.mjs`: runs the real `index.html` + `importers.js` + `app.js` in `node:vm` with a
    hand-rolled fake DOM and fake `fetch`. When you add elements or DOM APIs to the app, the fake DOM
    may need extending.

## Data model (short form; full table in the README)

`books.json` is a list of titles with short keys `t a n s sn g r e` (title, author, narrator, series,
series number as text, genres, dates read, editions). Each edition in `e` has `id gr isbn p d len`
(Audible ASIN, Goodreads book id, ISBNs, publisher, release date, length in minutes) and needs one of
the first three. A box set is one edition copied onto each of its titles, linked by the shared
identifier (`sameEdition`). Books from before editions (with `id`/`gr`/`isbn` on the book) are
migrated on load by `fixBooks`. A missing `r` means the read date is unknown, not unread. `series-info.json` maps a series
name (must equal `s` exactly) to `{total, status: "ongoing"|"complete", note, url}`.
`data/excluded.txt` lists ASINs, `ISBN 978…`, `Goodreads 12345` or `Title | Author` lines that imports must never re-add; code only
ever appends to it.

Invariants the code relies on:
- Imports only add books, never overwrite. Matching order: any edition's `id` or `gr`, then first author + series + number
  (spelling-insensitive), then author + title (forgiving Audible's long titles, never mistaking a
  boxed set for book 1). A match may gain dates read and editions: an incoming edition fills in the
  edition it shares an identifier with (and that edition's box-set copies), or the match's only
  unshared edition when nothing conflicts, else is added; existing values are never changed.
- Every text field goes through `tidyBook`; `validate` warns on untidy values.
- Anything that writes user data (imports, `sync-export`, `serve` saves) validates first and refuses
  to touch `data/sample/`.

## Privacy (hard rule)

The repo is public; the user's library is not.
- Never commit `data/books.json`, `data/series-info.json`, `data/excluded.txt` or anything in
  `data/raw/`. `tests/data.test.mjs` fails if they become tracked.
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
