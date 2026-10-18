# CLAUDE.md

Guidance for Claude Code working in this repository. The README and `docs/` are the user-facing manual;
read them for workflows and the data format. This file covers what you need to change the code safely.

## What this is

A personal audiobook catalog: static pages (`index.html`, `import.html`, `duplicates.html`, `authors.html`,
`narrators.html`, `publishers.html`, sharing `styles.css`) that run entirely in the browser and keep the catalog in IndexedDB. There is
no server code and no command line: any static server (`make serve`, GitHub Pages) serves the pages, and
Node is only used to run the tests.

Everything that is served lives in `public/` (pages, modules, `styles.css`, the PWA files and `icons/`),
and nothing else goes there: `docs/` and `tests/` stay outside it, so they are never served.
The module names below are files in `public/`.

- Vanilla JavaScript, no framework, no bundler, **no npm packages in the app or the tests**. `package.json` says
  `"type": "module"` and has one devDependency, TypeScript, used only as a checker (`make typecheck`); don't add
  others, use Node built-ins in tests.
- Types are JSDoc comments checked by `tsc` (checkJs, strict); nothing is compiled, the browser loads the files as they are.
- ES modules everywhere (`import`/`export`, never `require`/`module.exports`). Each page loads only
  its own script with `<script type="module">`; that imports `store.js` and the classes in `modules/`.
- Node 18+ for the tests (CI uses 24).

## Commands

```sh
make test       # node --experimental-vm-modules --test tests/*.test.mjs  (all suites, incl. the browser smoke test)
make typecheck  # tsc -p jsconfig.json and -p jsconfig.sw.json (sw.js, with the worker's globals); needs `npm install` once
make serve      # python3 -m http.server --directory public on http://127.0.0.1:8000/ (the pages are ES modules, so not from file://)
node --test tests/catalog.test.mjs            # one suite (the smoke test needs --experimental-vm-modules too)
node --test --test-name-pattern='merge' tests/catalog.test.mjs   # one test
```

There is no linter or formatter; `.editorconfig` sets tab indentation for code, and otherwise match the surrounding style (see Conventions).
CI (`.github/workflows/ci.yml`) runs `make test` and `make typecheck` on pull requests and on pushes to `main`; `.github/workflows/pages.yml`
publishes `public/` to GitHub Pages on pushes to `main`.

## Architecture

- `modules/`: the data pipeline as ES6 classes, one class per module (file names are the class in kebab case:
  `Book` in `book.js`, `GoodreadsImporter` in `goodreads-importer.js`). Keep them free of Node and DOM APIs (they only import
  each other), so the tests run them in Node as they are. Each class holds descriptive fields in memory and reads/writes the
  stored short keys with `fromJSON`/`toJSON` (so `JSON.stringify(catalog)` is the stored shape); a value it doesn't know or
  that is malformed is kept as it was (`extra`), so Check still reports it. Migrations and Check work on the stored JSON.
  - `Catalog`: books, `series` (`Map` of id -> `Series`), `authors`, `narrators`, `publishers` (`Map`s of id -> `Contributor`), `exclusions`,
    `marks` ("Not duplicates" and "Keep separate", by id: `markNotDuplicates`, `markKeepSeparate`, `markTexts`/`addMarkTexts`, `resolveMarks`),
    `nameIds` (the ids series and people are known by, by name: `idFor` (gives a new name one), `nameOf`, `namesOf`, `seriesInfo`,
    `infoByName`/`replaceInfo` for the name-keyed backup shape; `renameSeries` keeps a series' id), `assignIds` (before every save);
    `fromJSON`/`fromBackup`/`toJSON`/`clone`/`replaceWith`, `validate`, `book(id)`, `saveBook(id, book)`, `merge` (an import), `addBoxSets`,
    `duplicates()`, `addExclusions`, `renameSeries`, `seriesBooks`, `authorWorks`,
    `narratorWorks` and `publisherWorks` (all `creditedWorks` with `authorsOf`/`narratorsOf`/`publishersOf`).
  - `Book` (`id title authors series number genres read external editions`): `idOn`/`ids`, `exclusionEntries`, `isCollection`/`boxRange`,
    `lookupKeys`, `static bySeriesNumber`/`merge`, and the JSON-level migrations `fixBooks`/`tidyJSON`/`fixEditions`/`fixSeriesTitle`/`fixIds`.
  - `Edition` (`id external isbn narrators publisher released minutes description`): `idOn`/`ids`/`idKeys`, `sameAs`/`conflictsWith`/`fillFrom`,
    `joinable`/`join`, `format`/`parse` and `fields`/`fromFields` (the book form's edition cards; both also return the book's ids found), `parseAsins`/`asinsText`, `idFromAddress`, `splitIsbns`/`fixIds`.
  - `ExternalCatalog` (the external catalogs as plain data, `ALL`: each Audible and Amazon site, Goodreads, Hardcover, Open Library, ISFDB, BookBrainz and Wikidata, with a
    description and, per kind (`book edition series author narrator publisher`), the id's pattern and its page's address; `GROUPS` (one form
    field each), families (every ASIN is family `asin`, so they match across sites)): `url` (id to address), `fromAddress`/`readId` (address or
    typed text to id), `siteOf`, `fieldText`, `order`, `tidy`, `problems` (Check's errors and warnings), `ASIN_SITES`.
  - `Series` (series info `total status note url external`, and series numbers: `range`, `owned`, `missingNumbers`, `parseTitle`), `Contributor` (an author's, narrator's or publisher's info, `bio url external links`: `KEYS`, `ONE`, `KINDS`, `tidy`, `fixLinks`),
    `Exclusions` (`parse`, `covers`, `entries`), `Text` (tidying, names, dates, `spelled`/`prefersBritish`/`BRITISH_WORDS`, `errorText`, `plural` for a count with its word),
    `Isbn`, `Csv`, `Validator` (`validate`, `validateContributors`), `Merger` (the matching order below), `Duplicates` (`groups`, `splitEditions`),
    `Backup` (`read`, `readFiles` for Restore of a backup or the old `data/` files, `mergeInto`).
  - `CatalogRecords` (the catalog as IndexedDB records and back: `STORES` with their indexes, `fromCatalog`/`toCatalog`,
    `unstorable`, `snapshot`/`changes` for saving only what changed, `merge` (`DERIVED`) for taking in another tab's save; `bookRecord`/`seriesRecord`/`contributorRecord`/`creditsOf`, which a save
    also uses from inside its transaction) and `CatalogDatabase` (`open`, `load`, `read(fn)` with a `CatalogReader` (`get`, `all`, `under`,
    `page`, `keys`, `count`: by index, a page at a time), `save` with the revision check that throws `CatalogConflict`, which works the
    derived fields out from the stored records so a page holding a slice can save (`SaveTransaction`), `setAside`, the kept Duplicates count;
    the browser's `indexedDB` is passed in). `MemoryReader` answers a `CatalogReader`'s questions from records in memory.
  - `Importer` (reads a CSV a row at a time into books) with `AudibleImporter` and `GoodreadsImporter`; `GoodreadsExporter`
    (CSV for Goodreads' import); `HardcoverClient` (GraphQL `ask`, with fetch and pause passed in; queries, `parseUrl`/`bookId`, `idBySlug`) and
    `HardcoverSync` (`compare`: only reads Hardcover, for every book or a series' or an author's (`comparePart`: reads only that part of the shelves, by the series' or author's Hardcover ids (`partIds`; Hardcover refuses `_ilike`), `shelfOf`/`shelfOfBooks`), `push`, `read`, `lookups`/`addIds`, `planExport`).
  - `Comparison` (`compare`: each incoming book's `kind`, `gains`, `editionGains` and `differences` beside the catalog, from
    `Merger`'s report `matches`; `apply`: imports the books picked by place, their editions only where picked (`MergeOptions.withEditions`;
    Goodreads' and Hardcover's are unticked at first, as an edition picked there may not be the user's), and puts in the values picked by `Difference.key`).
  Typedefs that aren't a class (`Unchecked` for data not yet checked, `MergeReport`, `Picks`, ...) live in the module that makes them;
  others bring them in with `/** @import {MergeReport} from './merger.js' */`.
- `store.js`: shared by the pages: the one `CATALOG` (a `Catalog`, exported; pages change its fields or call `replaceWith`),
  loading (`startPage(init, page)`: a page holds **only what it shows**: `CATALOG` starts empty, `loadRecords(want)` brings in books
  (and what they need) by id, series or edition key, `queryCatalog(ask)` asks the database with a `CatalogReader`, and
  `wholeCatalog()` (or `startPage`'s `{whole: true}`, the Duplicates page) holds every record from then on (`WHOLE`); `afterSaving(task)`
  runs a read once the saves are done, and `whenSaved` waits for those reads too. Reading all of it (`CatalogDatabase`, `CatalogRecords.toCatalog`); with none
  it starts **empty**, never with the demo data; one that can't be read is set aside (meta `unreadable`); when nothing was saved
  yet, the catalog localStorage kept (`audiobook-catalog-device`, backup-shaped, plus `audiobook-catalog-not-duplicates`, or the
  old `audiobook-catalog-data` edits) is read through `Catalog.fromJSON`, saved, and its keys renamed `….moved-to-indexeddb`;
  without IndexedDB the page shows that catalog and saves nothing),
  `persist` (async, queued; writes only the records that changed, with the ids `fromCatalog` gives; when another tab saved
  since this page last read or wrote (`SEEN_REVISION`), first takes in what it changed (`catchUp`: `CatalogRecords.merge`, then
  the page's `refresh(before)` from `startPage`), and refuses when both changed the same record, or when `CatalogRecords.unstorable` names values a record can't hold;
  `whenSaved`, `storedRevision`),
  the status line (`showIoStatus`, with an optional Undo for `STATUS_TIME`), `byId`/`fieldById` (the page's elements; they throw on a missing id), `buildElement`/`fillElement`/`joined` (building elements, below),
  the external id fields of the book, series and info forms (`externalFields`/`fillExternalFields`/`readExternalFields`, one per
  `ExternalCatalog` group) and `externalLinks`, the page links
  (`creditPageHref(kind, id)`, and `authorPageHref`/`narratorPageHref`/`publisherPageHref`, which write the id the page holds for the name, else the name, never a new id; `valueFromPageHash` and `idFromAddress` read an address back, taking an id or, from older links, a name), the last backup (`noteBackup`, `backupAge`, `needsBackup`; localStorage `audiobook-catalog-last-backup`), the Hardcover token (localStorage `audiobook-catalog-hardcover-token`, only ever sent to
  Hardcover; `hardcoverClient(token)`), `lookupHardcoverBook`, `lookupHardcoverField` (a series' or person's Hardcover number from the name in its address; the name is kept when Hardcover can't be asked) and the Hardcover run banner (`showHardcoverJob`, `#bgTask`).
  Each page script ends with `export const READY = startPage(init, {refresh})` (`init` may be async; the import page also passes `onHardcoverJob`;
  the narrators and publishers pages end with `startCreditsPage(kind)`, which calls it).
  Pages keep what they show by id (books by `Book.id`, series and people by `CATALOG.idFor(kind, name)`), and so do their
  addresses (`#series=<id>`, `#book=<id>`, `#a=<id>`, `#merge=<id>,<id>`); an address with a name or title still opens it.
  Pairs marked "Not duplicates" (and editions marked "Keep separate") are `CATALOG.marks` by book (and edition) ids, so they
  survive a retitle; backups carry them as text (`markTexts`/`addMarkTexts`), and a text that matches no book stays a text mark.
- `manifest.webmanifest`, `sw.js`, `icons/`: the installable app. `sw.js` is network-first and caches
  the app's own files; add new files in `public/` to its `APP` list (the smoke test checks every module a
  page imports, and fails on any file in `public/` the list lacks).
- `app.js` (`index.html`): series overview (from the series records alone), all books (50 at a time, `PAGE_SIZE`, `showMore`;
  `refreshView` reads what is shown again; an empty catalog says where books come from; a book's card, `bookCard`, holds only its title, number,
authors, narrators and dates read, and `#book=<id>` shows everything else, `bookDetails`), the book and
  series-info forms, module-level state (`VIEW`, `SERIES_FILTER`, ...). Its merge button links to `duplicates.html#merge=<id>,<id>`.
- `import.js` (`import.html`; shows the book count until an action calls `withWholeCatalog`): the comparison an Audible or
  Goodreads CSV import, or the Hardcover panel's Compare (`HardcoverSync.compare`; for a series or an author, which their pages link to
  with `hardcoverCompareHref`, `#hardcover-series=<id>`/`#hardcover-author=<id>`), opens (`PENDING_COMPARE`, its ticks in
  `picks`; `drawCompare`; Apply runs `Comparison.apply` on a copy, then for Hardcover saves and `push`es the ticked part of the plan),
  Goodreads CSV export, Check (`CATALOG.validate`) and Box sets (`addBoxSets`), Export / Restore (`Backup.readFiles`) / Merge of backups.
  Audible's catalog doesn't allow browser requests, so there is no series lookup from Audible.
- `credits.js` (`authors.html`, `narrators.html`, `publishers.html`, each started by its own `authors.js`/`narrators.js`/
  `publishers.js` with `startCreditsPage(kind)`; `CREDIT_KINDS` holds what differs): the list of authors, narrators or
  publishers (read from the contributors records alone, `LIST`) and one's page (`#a=<id>`, `#n=<id>`, `#p=<id>`; loads their books by their credits): bio and links from `CATALOG.authors` (`.narrators`,
  `.publishers`, by id), their series and titles from the books (`authorWorks`/`narratorWorks`/`publisherWorks`), and the info
  form. Names on the catalog's book cards link here.
- `duplicates.js` (`duplicates.html`): duplicate groups and merging (joining editions that don't
  conflict, `Edition.joinable`), and books whose editions look like one (`splitEditions`).
- `tests/`: `node:test` suites (`*.test.mjs`, ESM).
  - `catalog.test.mjs`: unit tests of the classes in `modules/` (`Book.fromJSON` in, `JSON.stringify` out, so they compare stored shapes).
  - `app.smoke.test.mjs`: runs a page's real HTML and its modules (`boot({page})`) as `vm.SourceTextModule`s
    (hence `--experimental-vm-modules`) with a hand-rolled fake DOM (the page's `<body>` parsed into elements; tests read
    what the page drew as `innerHTML`, written as a browser writes it, and setting `innerHTML` throws), a fake localStorage (`boot`'s `files`
    seed the old localStorage catalog, by default from `sample/`, which the page moves to IndexedDB; `files: null` for none) and a fake
    IndexedDB (`tests/fake-indexeddb.mjs`; pages booted with the same `storage` Map share it, like tabs, and their ids are `id-1`, ...;
    `await kept(storage)` is what is stored, once the saves are done; a page draws what it reads after its saves, so `await idle()`
    after a step that changes what is shown; `database.reads(store)` counts the records handed out; `get` leaves out `uid`, `withIds` keeps it). Tests reach what the
    modules export (`ctx.render()`, `get('CATALOG.books')`, `run(...)`), so export what a test needs; a module's
    own code sees only what it imports, so a missing import fails here. When you add elements or DOM APIs
    to the app, the fake DOM may need extending. The page must fetch nothing but Hardcover (`fakeHardcover`
    in `tests/fake-hardcover.mjs`, built from Hardcover's published schema; the sandbox can't reach Hardcover).

## Data model (short form; full table in `docs/data-format.md`)

A backup is `{books, seriesInfo, authors, narrators, publishers, excluded, notDuplicates, ids}`; the browser keeps the same catalog as
IndexedDB records (below). `books` is a list of titles with short keys `uid t a s sn g r ext e` (the id it is stored under, title, list of authors, series,
series number as text, genres, dates read, its own external ids (`{"hardcover": "77", "goodreads": "99"}`), editions). Each edition in `e` has `uid ext isbn n p d len desc`
(its stored id (a box set's copies share it), its ids by external catalog, `{"audible.com": "B0…", "amazon.com": "B0…", "goodreads": "4242", "hardcover": "501"}`, one ISBN, list of narrators, publisher, release date,
length in minutes, free-text description) and must not be empty. Entries keep only ids, never addresses: `ExternalCatalog` makes the link
from an id and reads the id out of a pasted address. An edition's `ext` names it
(`idKeys`, `"asin B0…"` for any site's ASIN; `ids('asin')` gives an ASIN of any site, and only another id under the same key disagrees) and matches books; the ISBN names an edition too (`conflictsWith`: another ISBN is another
edition) but never matches books. Editions with an ISBN list or an `hcb`, from before, are split and the
id lifted to the book on load (`Edition.splitIsbns`, `Book.fixBooks`); the old keys `id`/`asin`/`gr`/`hc` on an edition and `hcb` on a book become `ext` (`Edition.fixIds`, `Book.fixIds`).
Audible imports' ASINs are the picked Audible site's (audible.com by default), Hardcover's and Goodreads' amazon.com's. A box set is one edition copied onto each of its titles, linked by the shared
identifier (`sameAs`), and also a book of its own numbered with its range (`"1-3"`). Books from before editions (with `id`/`gr`/`isbn`/`n` on the book) are
migrated on load by `Book.fixBooks`, and so are authors and narrators written as one comma separated
string (`Text.fixPeople`/`splitNames`; `namesText` joins a list back for display). Matching and "Not duplicates"
keys use the first author (`Book.firstAuthor`/`firstName`). A missing `r` means the read date is unknown, not unread. `seriesInfo` maps a series
name (must equal `s` exactly) to `{total, status: "ongoing"|"complete", note, url, ext}`. `authors` (optional;
missing means `{}`) maps an author's name (as in `a`) to `{bio, url, ext, links}` (ids by catalog, and other addresses; the old `audible`/`goodreads`/`hardcover`
addresses are read into `ext` by `Contributor.fixLinks`), and `narrators` and `publishers` (likewise optional) map a narrator's name (as in an edition's `n`) or
a publisher's (as in `p`) to the same; they travel like series info, and an
entry whose name no book has is a warning, not an error.
`ids` maps series, author, narrator and publisher names to their ids (`Catalog.nameIds`); a backup without ids gets new ones.
IndexedDB (`CatalogRecords.STORES`, documented in `docs/data-format.md`): stores `books editions series contributors credits marks exclusions meta`,
plain objects with descriptive fields, ids from `crypto.randomUUID()` that never change, references by id (a box set's edition is
one record with `bookIds`), derived fields (sort keys, counts, `credits`) rewritten on every save and never read back, and every
sorting index ending in the key so lists can be paged. There is no `extra`: a value a class keeps aside is not stored.
The database is version 3 (`CatalogDatabase.VERSION`; `upgrade` adds and drops indexes to match `STORES`, and from versions 1 and 2
puts meta `reshape`, so the next page saves every record again with the derived fields this version reads); `toCatalog` still reads
version 1's records (ids under fields of their own), and `startPage` saves them again at once (`CatalogRecords.outdated`).
`excluded` lists ASINs, `ISBN 978…`, `Goodreads 12345`, `Hardcover 12345` or `Title | Author` entries that imports must never re-add; code only
ever adds to it (Restore and Merge add a backup's to it too). `notDuplicates` (pairs marked "Not duplicates" on the
Duplicates page) is add-only too. Restore also reads the old `data/` files (`books.json`, `series-info.json`, `authors.json`, `narrators.json`, `publishers.json`,
`excluded.txt`, `not-duplicates.txt`) picked together (`Backup.readFiles`).

Invariants the code relies on:
- Imports only add books, and never overwrite a value except one the user ticked in the comparison (`Comparison.apply`). Matching order: any edition's external id (an ASIN on any site), then the book's Hardcover id, then first author + series + number
  (spelling-insensitive), then author + title (forgiving Audible's long titles, never mistaking a
  boxed set for book 1). A box set with a range and an id is kept as its own book and gives its edition to each title (`Merger`). A match may gain dates read and editions: an incoming edition fills in the
  edition it shares an identifier with (and that edition's box-set copies), or the match's only
  unshared edition when nothing conflicts, else is added; existing values are never changed.
- Every text field goes through `Book.tidyJSON`; `Validator.validate` warns on untidy values.
- Imports, Merge and Box sets validate a copy first and change nothing when it has errors; previews never change anything
  until confirmed.
- Sending to Hardcover only adds to it (books on the Read shelf, reads), only what the user ticked; it never changes a
  status, rating or review or removes anything there. Comparing only reads it.

## Privacy (hard rule)

The repo is public; the user's library is not.
- The catalog lives in the browser.
- Only `sample/` (the tests' demo data; the page never loads it) is committed, and it and every example in tests and docs must be **invented**
  (fictional titles, authors, series). Never use real books from the user's data in tests or docs.

## Conventions

- Indent with one tab (see `.editorconfig`), semicolons, single quotes, `function name(){` with no space before `{`,
  compact one-line helpers are fine. Comments explain *why* in plain sentences; JSDoc on
  non-obvious functions.
- Status messages and errors are short, plain English; anything that changes many books shows a preview first.
- Pages draw with the DOM API, never HTML strings: `buildElement(tag, attrs, ...children)` from `store.js` makes an element
  (children are elements or text, always put in as text; an `on...` function in `attrs` is a listener), `fillElement(el, ...children)`
  replaces what an element holds, and `joined(items, ', ')` puts a separator between children. No `innerHTML`.
- American spelling everywhere in code, comments and docs. Text the page shows (status lines, previews, titles set
  from code) goes through `spell()` from `store.js`, which gives British spelling to a browser that prefers it
  (`prefersBritish`/`spelled`/`BRITISH_WORDS` in `modules/text.js`); the static HTML is respelled on load. Never respell data.
- The catalog is stored as compact `JSON.stringify` output (backups are indented for reading).
- Every function has its types in JSDoc (`@param`, `@returns`, `@type` for a variable that starts empty), and
  `make typecheck` passes; a cast (`/** @type {X} */ (value)`) only where the code knows more than the checker, with
  the reason when it isn't plain. No `@ts-ignore`. `catch` gets `unknown`: `errorText(exc)` gives its message.
- Behavior changes need a test in the matching suite, and a docs update when user-visible
  (`docs/` documents every workflow; keep the README to the essentials).
- Commit messages: a short imperative summary of the user-visible change
  (e.g. "Exclude removed books from imports, and carry exclusions in exports").
