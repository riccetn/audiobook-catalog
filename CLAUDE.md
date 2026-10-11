# CLAUDE.md

Guidance for Claude Code working in this repository. The README and `docs/` are the user-facing manual;
read them for workflows and the data format. This file covers what you need to change the code safely.

## What this is

A personal audiobook catalogue: static pages (`index.html`, `import.html`, `duplicates.html`, `authors.html`,
sharing `styles.css`) that run entirely in the browser and keep the catalogue in `localStorage`. There is
no server code and no command line: any static server (`make serve`, GitHub Pages) serves the pages, and
Node is only used to run the tests.

Everything that is served lives in `public/` (pages, modules, `styles.css`, the PWA files and `icons/`),
and nothing else goes there: `data/`, `docs/` and `tests/` stay outside it, so they are never served.
The module names below are files in `public/`.

- Vanilla JavaScript, no framework, no bundler, **no npm packages**. `package.json` only says
  `"type": "module"`; don't add dependencies to it, use Node built-ins in tests.
- ES modules everywhere (`import`/`export`, never `require`/`module.exports`). Each page loads only
  its own script with `<script type="module">`; that imports `store.js` and `importers.js`.
- Node 18+ for the tests (CI uses 24).

## Commands

```sh
make test       # node --experimental-vm-modules --test tests/*.test.mjs  (all suites, incl. the browser smoke test)
make serve      # python3 -m http.server --directory public on http://127.0.0.1:8000/ (the pages are ES modules, so not from file://)
node --test tests/importers.test.mjs          # one suite (the smoke test needs --experimental-vm-modules too)
node --test --test-name-pattern='merge' tests/importers.test.mjs   # one test
```

There is no linter or formatter config; match the surrounding style (see Conventions).
CI (`.github/workflows/ci.yml`) runs `make test` on pull requests and on pushes to `main`; `.github/workflows/pages.yml`
publishes `public/` to GitHub Pages on pushes to `main`.

## Architecture

- `importers.js`: the data pipeline, a module that exports its functions by name (`import * as CatalogImport
  from './importers.js'` in the pages, `as C` in the tests). Keep it free of imports and of Node or DOM APIs,
  so the tests run it in Node as it is.
  Key pieces: `tidyBook`/`tidyText`/`normalizeName`, `parseReadDate(s)`/`fixBooks`/`fixEditions`, `validate`, `formatNotes` (what is in an older format),
  `readAudible`, `readGoodreads`, `goodreadsCsv` (export for Goodreads' import), `merge`,
  `readHardcover`/`hardcoverMatches`/`addHardcoverIds`/`planHardcoverExport`, `parseHardcoverUrl`/`hardcoverBookId` (a book's id from its hardcover.app address), run by `runHardcover` through
  `hardcoverAsker` (fetch and pause are passed in; the GraphQL queries are in `HARDCOVER_QUERIES`), `sameEdition`/`saveBook`, `formatEdition`/`parseEditions`, `editionFields`/`editionFromFields` (the book form's edition cards), `parseAsins`/`asinsText` (ASINs by site as text),
  `parseExclusions`/`exclusionEntries`, `seriesRange`/`isCollection`/`bySeriesNumber`/`seriesOwned` (box sets, whose number is a range, last in a series and not counted as a title), `boxSetBooks` (Box sets on the import page), `tidyAuthor`/`validateAuthors`/`authorWorks`/`authorList` (the authors page and author info), `readBackup`, `readDataFiles` (Restore of a backup or of the old `data/` files picked together), `mergeBackup`, `findDuplicates`/`mergeBooks`/`splitEditions`.
- `store.js`: shared by the pages: the shared state (`DATA`, `SERIES_INFO`, `AUTHORS`, `EXCLUSIONS`, ..., exported;
  a page replaces `DATA`, `SERIES_INFO` and `AUTHORS` with `setData`/`setSeriesInfo`/`setAuthors`, since only the module that
  declares a binding can assign it), loading (`startPage(init, page)`: reads the catalogue from localStorage
  `audiobook-catalog-device` as a backup-shaped `{books, seriesInfo, authors, excluded}`, run through `readBackup`; with none
  it starts **empty**, never with the demo data; one that can't be read is set aside under `.unreadable`; edits left under the
  old `audiobook-catalog-data` key by the removed `make serve` save are adopted when there is no catalogue yet),
  `persist` (writes the whole catalogue back; refuses when another tab wrote it since this page last read or wrote it),
  the status line, the page links, the Hardcover token (localStorage `audiobook-catalog-hardcover-token`, only ever sent to
  Hardcover), `lookupHardcoverBook` and the Hardcover run banner (`showHardcoverJob`, `#bgTask`).
  Each page script ends with `export const READY = startPage(init)` (the import page also passes `{onHardcoverJob}`).
  Pairs marked "Not duplicates" (and editions marked "Keep separate") are kept in localStorage
  `audiobook-catalog-not-duplicates` (`notDuplicates` in backups).
- `manifest.webmanifest`, `sw.js`, `icons/`: the installable app. `sw.js` is network-first and caches
  the app's own files; add new files in `public/` to its `APP` list (the smoke test checks every module a
  page imports, and fails on any file in `public/` the list lacks).
- `app.js` (`index.html`): series overview, all books (an empty catalogue says where books come from), the book and
  series-info forms, module-level state (`VIEW`, `SERIES_FILTER`, ...). Its merge button links to `duplicates.html#merge=i,j`.
- `import.js` (`import.html`): Audible/Goodreads CSV preview and import, Goodreads CSV export, Check (`validate`, plus
  `FORMAT_NOTES` and **Save in the current format**) and Box sets (`boxSetBooks`), the Hardcover panel (`runHardcover`
  in the page, on a copy of the catalogue), Export / Restore (`readDataFiles`) / Merge of backups.
  Audible's catalogue doesn't allow browser requests, so there is no series lookup from Audible.
- `authors.js` (`authors.html`): the list of authors and an author's page (`#a=Name`): bio and links from
  `AUTHORS`, their series and titles from the books (`authorWorks`), and the author info form. Author
  names on the catalogue's book cards link here.
- `duplicates.js` (`duplicates.html`): duplicate groups and merging (joining editions that don't
  conflict, `editionsJoinable`), and books whose editions look like one (`splitEditions`).
- `tests/`: `node:test` suites (`*.test.mjs`, ESM).
  - `importers.test.mjs`: pipeline unit tests.
  - `data.test.mjs`: validates the demo data and enforces the privacy rules below.
  - `app.smoke.test.mjs`: runs a page's real HTML and its modules (`boot({page})`) as `vm.SourceTextModule`s
    (hence `--experimental-vm-modules`) with a hand-rolled fake DOM and a fake localStorage (`boot`'s `files`
    seed the stored catalogue, by default from `data/sample/`; `files: null` for none). Tests reach what the
    modules export (`ctx.render()`, `get('DATA')`, `run(...)`), so export what a test needs; a module's
    own code sees only what it imports, so a missing import fails here. When you add elements or DOM APIs
    to the app, the fake DOM may need extending. The page must fetch nothing but Hardcover (`fakeHardcover`
    in `tests/fake-hardcover.mjs`, built from Hardcover's published schema; the sandbox can't reach Hardcover).

## Data model (short form; full table in `docs/data-format.md`)

The catalogue (in localStorage and in backups) is `{books, seriesInfo, authors, excluded, notDuplicates}`. `books` is a list of titles with short keys `t a s sn g r hcb e` (title, list of authors, series,
series number as text, genres, dates read, Hardcover book id, editions). Each edition in `e` has `asin gr hc isbn n p d len desc`
(ASINs by site, `{"audible.com": "B0…", "amazon.com": "B0…"}`, Goodreads book id, Hardcover edition id, one ISBN, list of narrators, publisher, release date,
length in minutes, free-text description) and must not be empty. `asin`, `gr` and `hc` name an edition
(`EDITION_IDS`; `editionIds` gives an ASIN of any site, and only another ASIN on the same site disagrees) and match books; the ISBN names an edition too (`editionsConflict`: another ISBN is another
edition) but never matches books. Editions with an ISBN list or an `hcb`, from before, are split and the
id lifted to the book on load (`splitIsbns`, `fixBooks`); an edition's old one-ASIN `id` becomes its audible.com ASIN (`fixAsin`).
Audible imports' ASINs are the picked Audible site's (audible.com by default), Hardcover's and Goodreads' amazon.com's. A box set is one edition copied onto each of its titles, linked by the shared
identifier (`sameEdition`), and also a book of its own numbered with its range (`"1-3"`). Books from before editions (with `id`/`gr`/`isbn`/`n` on the book) are
migrated on load by `fixBooks`, and so are authors and narrators written as one comma separated
string (`fixPeople`/`splitNames`; `namesText` joins a list back for display). Matching and "Not duplicates"
keys use the first author (`firstAuthor`/`firstName`). A missing `r` means the read date is unknown, not unread. `seriesInfo` maps a series
name (must equal `s` exactly) to `{total, status: "ongoing"|"complete", note, url}`. `authors` (optional;
missing means `{}`) maps an author's name (as in `a`) to `{bio, url, audible, goodreads, hardcover}` (links as
full addresses); it travels like series info, and an
entry whose name no book has is a warning, not an error.
`excluded` lists ASINs, `ISBN 978…`, `Goodreads 12345`, `Hardcover 12345` or `Title | Author` entries that imports must never re-add; code only
ever adds to it (Restore and Merge add a backup's to it too). `notDuplicates` (pairs marked "Not duplicates" on the
Duplicates page) is add-only too. Restore also reads the old `data/` files (`books.json`, `series-info.json`, `authors.json`,
`excluded.txt`, `not-duplicates.txt`) picked together (`readDataFiles`).

Invariants the code relies on:
- Imports only add books, never overwrite. Matching order: any edition's ASIN (any site), `gr` or `hc`, then the book's `hcb`, then first author + series + number
  (spelling-insensitive), then author + title (forgiving Audible's long titles, never mistaking a
  boxed set for book 1). A box set with a range and an id is kept as its own book and gives its edition to each title (`mergeBoxSet`). A match may gain dates read and editions: an incoming edition fills in the
  edition it shares an identifier with (and that edition's box-set copies), or the match's only
  unshared edition when nothing conflicts, else is added; existing values are never changed.
- Every text field goes through `tidyBook`; `validate` warns on untidy values.
- Imports, Merge and Box sets validate a copy first and change nothing when it has errors; previews never change anything
  until confirmed.
- The Hardcover export only adds to Hardcover (books on the Read shelf, reads); it never changes a
  status, rating or review or removes anything there.

## Privacy (hard rule)

The repo is public; the user's library is not.
- The catalogue lives in the browser, but the user may still have the old data files in `data/`: never commit `data/books.json`,
  `data/series-info.json`, `data/authors.json`, `data/excluded.txt`, `data/not-duplicates.txt`, `data/hardcover-token` or anything in
  `data/raw/`. `tests/data.test.mjs` fails if they become tracked. The Hardcover token stays in that browser's localStorage, is
  only ever sent to Hardcover, and never goes in a backup.
- Only `data/sample/` (the tests' demo data; the page never loads it) is committed, and it and every example in tests and docs must be **invented**
  (fictional titles, authors, series). Never use real books from the user's data in tests or docs.

## Conventions

- 2-space indent, semicolons, single quotes, `function name(){` with no space before `{`,
  compact one-line helpers are fine. Comments explain *why* in plain sentences; JSDoc on
  non-obvious functions.
- Status messages and errors are short, plain English; anything that changes many books shows a preview first.
- The catalogue is stored as compact `JSON.stringify` output (backups are indented for reading).
- Behaviour changes need a test in the matching suite, and a docs update when user-visible
  (`docs/` documents every workflow; keep the README to the essentials).
- Commit messages: a short imperative summary of the user-visible change
  (e.g. "Exclude removed books from imports, and carry exclusions in exports").
