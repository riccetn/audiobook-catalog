# CLAUDE.md

Guidance for Claude Code working in this repository. The README and `docs/` are the user-facing manual;
read them for workflows and the data format. This file covers what you need to change the code safely.

## What this is

A personal audiobook catalog: static pages (`index.html`, `books.html`, `book.html`, `import.html`, `duplicates.html`, `authors.html`,
`narrators.html`, `publishers.html`, `author.html`, `narrator.html`, `publisher.html`, sharing `styles.css`) that run entirely in the browser and keep the catalog in IndexedDB. There is
no server code and no command line: any static server (`make serve`, GitHub Pages) serves the pages, and
Node is only used to write the pages and run the tests.

Everything that is served lives in `public/` (pages, modules, `styles.css`, the PWA files and `icons/`; the published site adds the API docs at `api/`),
and nothing else goes there: `docs/`, `templates/`, `tests/`, `api-docs/` and `proxy/` stay outside it, so they are never served.
The one piece that runs elsewhere is the optional catalog proxy (`proxy/`, below), a Cloudflare Worker the user deploys
themselves; the app never needs it.
The module names below are files in `public/`.

The pages' HTML is the one thing built: `make pages` (`build.mjs`) renders `templates/pages/<name>.liquid` with
[Liquid](https://liquidjs.com/) into `public/<name>.html`, each filling in `templates/layout.liquid` (the `<head>`, the title and the
nav bar, whose links are `nav-link.liquid` includes). The written pages are in `.gitignore`: **edit the templates, never `public/*.html`**.
A page's template starts with `{% layout 'layout' title: 'Books' nav: 'books.html' script: 'books.js' %}` (`title` left out
on the Series page; `nav` is the link marked current, `aria-current` only on that page itself). The build is strict (an
unknown variable or filter fails it). `make test` and `make serve` build first, and so do both workflows.

- Vanilla JavaScript, no framework, no bundler, **no npm packages in the app or the tests**. `package.json` says
  `"type": "module"` and its devDependencies are tools only, never served or imported by the app or tests:
  Liquid (`liquidjs`, `make pages`), TypeScript (`make typecheck`) and ESLint with `@eslint/js` and `globals` (`make lint`),
  plus TypeDoc (`make docs`) in the `api-docs/` workspace; don't add others, use Node built-ins in tests.
- Types are JSDoc comments checked by `tsc` (checkJs, strict); nothing is compiled, the browser loads the files as they are.
- ES modules everywhere (`import`/`export`, never `require`/`module.exports`). Each page loads only
  its own script with `<script type="module">`; that imports `store.js` and the classes in `modules/`.
- Node 18+ for the tests (CI uses 24).

## Commands

```sh
make pages      # node build.mjs: write public/*.html from templates/ (needs `npm install` once)
make test       # make pages, then node --experimental-vm-modules --test tests/*.test.mjs  (all suites, incl. the browser smoke test)
make typecheck  # tsc -p jsconfig.json and -p jsconfig.sw.json (sw.js, with the worker's globals); needs `npm install` once
make lint       # eslint . with the recommended rules (eslint.config.js); needs `npm install` once
make check      # test, typecheck and lint, what CI runs; run it before a PR
make docs       # TypeDoc: the API documentation from the JSDoc, into api-docs/out/ (git-ignored; API_DOCS=<folder> for another)
make serve      # make pages, then python3 -m http.server --directory public on http://127.0.0.1:8000/ (the pages are ES modules, so not from file://)
node --test tests/catalog.test.mjs            # one suite (the smoke test reads the pages, so make pages after editing a template) (the smoke test needs --experimental-vm-modules too)
node --test --test-name-pattern='merge' tests/catalog.test.mjs   # one test
```

On Windows, where make is usually missing, `.\make.ps1 test` (`check`, `pages`, `typecheck`, `lint`, `docs` (`-Out`), `serve`, `help`) runs the same commands;
keep `make.ps1` in step with the `Makefile` when a command changes.

ESLint looks for mistakes, not formatting, with its recommended rules as they are: a catch that doesn't use the error is
`catch{`, an empty one holds a comment saying why failing is fine, and an unused parameter starts with `_`; where a rule is wrong for one line, `// eslint-disable-next-line <rule> -- <why>`. There is no formatter; `.editorconfig` sets tab
indentation for code, and otherwise match the surrounding style (see Conventions).
CI (`.github/workflows/ci.yml`) runs `npm ci`, `make check` and `make docs` on pull requests and on pushes to `main`; `.github/workflows/pages.yml`
publishes `public/` to GitHub Pages on pushes to `main`, with `make docs API_DOCS=public/api` first, so the API documentation is served at `/api/`.
The docs are written into `public/` only there: locally they stay in `api-docs/out/` (the smoke test fails on files in `public/` that `sw.js` doesn't list).

TypeDoc (`api-docs/typedoc.json`: `public/*.js` but `sw.js`, and `public/modules/*.js`, with `jsconfig.json`) needs TypeScript's JS API, which
TypeScript 7 lacks, so `api-docs/` is an npm workspace (root `package.json` `workspaces`) with its own TypeScript 6 in `api-docs/node_modules/`,
and `skipErrorChecking` (6 and 7 disagree on a few types; `make typecheck` is the check). The doc comments on exports are the API docs.

## Architecture

- `modules/`: the data pipeline as ES6 classes, one class per module (file names are the class in kebab case:
  `Book` in `book.js`, `GoodreadsImporter` in `goodreads-importer.js`). Keep them free of Node and DOM APIs (they only import
  each other), so the tests run them in Node as they are. Each class holds descriptive fields in memory and reads/writes the
  stored short keys with `fromJSON`/`toJSON` (so `JSON.stringify(catalog)` is the stored shape); a value it doesn't know or
  that is malformed is kept as it was (`extra`), so Check still reports it. Migrations and Check work on the stored JSON.
  - `Catalog`: books, `series` (`Map` of id -> `Series`), `authors`, `narrators`, `publishers` (`Map`s of id -> `Contributor`), `exclusions`,
    `marks` ("Not duplicates" and "Keep separate", by id: `markNotDuplicates`, `markKeepSeparate`, `markTexts`/`addMarkTexts`, `resolveMarks`),
    `nameIds` (the ids series and people are known by, by name, each an entry of its own: `idFor` (gives a new name one), `nameOf`, `namesOf`, `booksOf`, `removeEntry`/`removeProblem`, `seriesInfo`,
    `infoByName`/`replaceInfo` for the name-keyed backup shape; `renameEntry` renames a series or person on every book and keeps their id), `assignIds` (before every save);
    `fromJSON`/`fromBackup`/`toJSON`/`clone`/`replaceWith`, `validate`, `book(id)`, `saveBook(id, book)`, `merge` (an import), `addBoxSets`,
    `duplicates()`, `addExclusions`, `renameEntry`, `seriesBooks`, `works(kind, name)` (an
    author's, narrator's or publisher's books, by `namesOn`: `authorsOf`/`narratorsOf`/`publishersOf`), and `bookErrors` (`validate`'s errors but the
    series info's, which stop an import, a merge or the box sets).
  - `Book` (`id title authors series number genres read external editions`): `idOn`/`ids`, `exclusionEntries`, `isCollection`/`boxRange`, `static storedEditions` (a stored book's editions that are objects),
    `lookupKeys`, `static bySeriesNumber`/`merge`, and the JSON-level migrations `fixBooks`/`tidyJSON`/`fixEditions`/`fixSeriesTitle`/`fixIds`.
  - `Edition` (`id external isbn narrators publisher released minutes description`): `idOn`/`ids`/`idKeys`/`idAndIsbnKeys` (its ids and "isbn 978…", what finds it and its box set's copies), `sameAs`/`conflictsWith`/`fillFrom`,
    `joinable`/`join`, `format`/`parse` and `fields`/`fromFields` (the book form's edition cards; both also return the book's ids found), `parseAsins`/`asinsText`, `idFromAddress`, `splitIsbns`/`fixIds`.
  - `ExternalCatalog` (the external catalogs as plain data, `ALL`: each Audible and Amazon site, Goodreads, Hardcover, AudiobookDB, Open Library, ISFDB, BookBrainz and Wikidata, with a
    description and, per kind (`book edition series author narrator publisher`), the id's pattern and its page's address; `GROUPS` (one form
    field each), families (every ASIN is family `asin`, so they match across sites)): `url` (id to address), `fromAddress`/`readId` (address or
    typed text to id), `siteOf`, `fieldText`, `order`, `tidy`, `problems` (Check's errors and warnings), `ASIN_SITES`.
  - `Series` (series info `total status note external`, and series numbers: `range`, `owned`, `missingNumbers`, `parseTitle`; `moveSites` gives an old series' site (`url`) to its one author or publisher, else its note), `Contributor` (an author's, narrator's or publisher's info, `bio url external links`: `KEYS`, `ONE`, `KINDS`, `tidy`, `fixLinks`),
    `Exclusions` (`parse`, `covers`, `entries`), `Text` (tidying, names, dates, `spelled`/`prefersBritish`/`BRITISH_WORDS`, `errorText`, `plural` for a count with its word, `firstThree` for a long list),
    `Cover` (`addresses`: a book's cover addresses from its editions' ASINs, Open Library ids and ISBNs, nothing stored; `isCover`), `Isbn`, `Csv`, `Validator` (`validate`, `validateContributors`), `Merger` (the matching order below), `Duplicates` (`groups`, `splitEditions`),
    `Backup` (`read`, `readFiles` for Restore of a backup or the old `data/` files, `mergeInto`).
  - `CatalogRecords` (the catalog as IndexedDB records and back: `STORES` with their indexes, `fromCatalog`/`toCatalog`,
    `unstorable`, `snapshot`/`changes` for saving only what changed, `merge` (`DERIVED`) for taking in another tab's save; `bookRecord`/`seriesRecord`/`contributorRecord`/`creditsOf`, which a save
    also uses from inside its transaction) and `CatalogDatabase` (`open`, `load`, `read(fn)` with a `CatalogReader` (`get`, `all`, `under`,
    `page`, `keys`, `count`: by index, a page at a time), `save` with the revision check that throws `CatalogConflict`, which works the
    derived fields out from the stored records so a page holding a slice can save (`SaveTransaction`), `setAside`, the kept Duplicates count;
    the browser's `indexedDB` is passed in). `MemoryReader` answers a `CatalogReader`'s questions from records in memory.
  - `Importer` (reads a CSV a row at a time into books) with `AudibleImporter` and `GoodreadsImporter`; `GoodreadsExporter`
    (CSV for Goodreads' import); `HardcoverClient` (GraphQL `ask`, with fetch and pause passed in; queries, `parseUrl`/`bookId`, `idBySlug`) and
    `HardcoverSync` (`compare`: only reads Hardcover, for every book or a series' or an author's (`comparePart`: reads only that part of the shelves, by the series' or author's Hardcover ids (`partIds`; Hardcover refuses `_ilike`), `shelfOf`/`shelfOfBooks`; both read the shelf's books with `readShelfBooks` and plan with `planFor`), `bookRecord` (a Hardcover book's title, authors and series, which `CatalogLookup` uses too), `push`, `read`, `lookups`/`addIds`, `planExport`).
  - `CatalogLookup` (the book form's *Fill in from another catalog*: `read` names what was pasted (an ISBN, an address or bare id), `find` looks the book up with
    the fetch, `HardcoverClient` and catalog proxy passed in: Open Library and Wikidata (open CORS, no key), Hardcover with the token (its books, and the ASINs, ISBNs and
    Goodreads editions it knows, as Audible, Amazon and Goodreads can't be read from a page), and with the proxy (`proxied`) Audible's catalog API
    (`audible`/`audibleBook`, `audibleSite`; a product without a title is one the site doesn't sell) and AudiobookDB (`audiobookdbByAsin`, `audiobookdbRelease`,
    `audiobookdbWork`, `audiobookdbBook`; ASINs it lists aren't taken, as it doesn't say their site); `noting` keeps a catalog asked beside others from failing
    the lookup; `fill` (gaps only), `date`/`seriesOf`/`minutes`).
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
  yet, the catalog localStorage kept (`audiobook-catalog-device`, backup-shaped, plus `audiobook-catalog-not-duplicates`) is read through `Catalog.fromJSON`, saved, and its keys renamed `….moved-to-indexeddb`;
  without IndexedDB the page shows that catalog and saves nothing),
  `persist` (async, queued; writes only the records that changed, with the ids `fromCatalog` gives; when another tab saved
  since this page last read or wrote (`SEEN_REVISION`), first takes in what it changed (`catchUp`: `CatalogRecords.merge`, then
  the page's `refresh(before)` from `startPage`), and refuses when both changed the same record, or when `CatalogRecords.unstorable` names values a record can't hold;
  `whenSaved`, `storedRevision`),
  the status line (`showIoStatus`, with an optional Undo for `STATUS_TIME`), `byId`/`fieldById` (the page's elements; they throw on a missing id), `buildElement`/`fillElement`/`joined` (building elements, below),
  the external id fields of the book, series and info forms (`externalFields`/`fillExternalFields`/`readExternalFields`, one per
  `ExternalCatalog` group; `externalFieldToId` turns a pasted address into its id, or moves it to its catalog's field, on focusout) and `externalLinks`, the page links
  (`pageHref(file, hash)`, only the hash on that page itself; `bookPageHref`, `seriesPageHref`, `standalonePageHref`; `creditPageHref(kind, id)`, and `authorPageHref`/`narratorPageHref`/`publisherPageHref`, which write the id the page holds for the name, else the name, never a new id; `valueFromPageHash` and `idFromAddress` read an address back, taking an id or, from older links, a name), the last backup (`noteBackup`, `backupAge`, `needsBackup`; localStorage `audiobook-catalog-last-backup`), the Hardcover token (localStorage `audiobook-catalog-hardcover-token`, only ever sent to
  Hardcover; `hardcoverClient(token)`), the catalog proxy (localStorage `audiobook-catalog-proxy`, `{url, key}`: `browserProxy`,
  `proxyAddress` (https, or http on this computer), `fetchViaProxy(route)` with the `X-Proxy-Key` header; set on Import & export, `showProxy`/`saveProxy`/`checkProxy`, which asks `ping`), `lookupHardcoverBook`, `lookupHardcoverField` (a series' or person's Hardcover number from the name in its address; the name is kept when Hardcover can't be asked) and the Hardcover run banner (`showHardcoverJob`, `#bgTask`).
  Each page script ends with `export const READY = startPage(init, {refresh})` (`init` may be async; the import page also passes `onHardcoverJob`;
  the people's lists end with `startCreditsPage(kind)` and their pages with `startCreditPage(kind)`, which call it).
  Pages keep what they show by id (books by `Book.id`, series and people by `CATALOG.idFor(kind, name)`), and so do their
  addresses (`index.html#series=<id>`, `book.html#book=<id>`, `#a=<id>`, `#merge=<id>,<id>`); an address with a name or title still opens it.
  Pairs marked "Not duplicates" (and editions marked "Keep separate") are `CATALOG.marks` by book (and edition) ids, so they
  survive a retitle; backups carry them as text (`markTexts`/`addMarkTexts`), and a text that matches no book stays a text mark.
- `manifest.webmanifest`, `sw.js`, `icons/`: the installable app. `sw.js` is network-first and caches
  the app's own files; add new files in `public/` to its `APP` list (the smoke test checks every module a
  page imports, and fails on any file in `public/` the list lacks).
- `book-list.js`: what the series, books and book pages share: a book's card (`bookCard`, only its title, number, authors,
  narrators and dates read) and cover (`coverImage`, an `<img>` that tries each of `Cover.addresses` in turn, unless *Covers* is off,
  `coversShown`/`watchCoversBox`, localStorage `audiobook-catalog-covers`), `BookList` (the ids listed, `PAGE_SIZE` = 50 loaded at a
  time, `more`), `readOrdered` (series order from the indexes alone), `bookGroups` (books grouped by series with their headings, or
  `sorted` as one list), `showEmptyCatalog`, `showBackupNudge`, `nameLinks` (and `authorLinks`/`narratorLinks`), `statusTag`, `watchSearchAndFilters` (the series and books pages' search box and Filters button),
  and the address helpers `hashParts`/`hashText`/`hashOf` (with `store.js`'s `hashValue`)/`setAddress`.
- `combo-box.js`: a search combo box (`comboBox(input, list, {names, multiple, onPick})`, `comboField` builds one): an
  `<input>` listing the names matching what is typed (`matchingNames`; in a field of several names, the one the cursor is in, `namePart`),
  picked with a click or the arrow keys and Enter, and a note below it naming what is new (`newNames`, `refreshNewNotes`). The book form's
  authors and series (`#f_aList`/`#f_aNew`, `#f_sList`/`#f_sNew` in the template) and each edition's narrators and
  publisher use it, over `FORM_NAMES` (`loadFormNames`, from the contributors' `kindName` and the series' `name` index, when the form opens).
- `series.js` (`index.html`, *Series*): every series (from the series records alone, `#q=...&missing`), and a series' page
  (`#series=<id>`, `#standalone`: its books, Compare with Hardcover, and its form with Remove series, `openSeriesForm`); `SERIES_FILTER`, `openSeries`.
  Addresses from when this page showed all books and each book (`#books...`, `#book=<id>`) go to `books.html` and `book.html`
  (`movedAddress`, with `location.replace`).
- `books.js` (`books.html`, *Books*): every book, 50 at a time (`showMore`), searched, filtered and sorted (`#q=&author=&genre=&read=&sort=`).
- `book.js` (`book.html`): a book's page (`#book=<id>`, `BOOK_FILTER`; `bookDetails`, with the other books of its box set
  loaded), Read today, Edit and Merge (Merge searches for the other book, `findMergeBooks`, and links to `duplicates.html#merge=<id>,<id>`),
  and the book form (`openEditForm`; Remove book is in it; *Fill in from another catalog*, `fillFromCatalog`, fills its empty fields), which also adds a book (`#add`, with `&series=<id>` or `&author=<name>`;
  `ADDING`; saved, the page shows the new book). `+ Add a book` on the series and books pages links here.
- `import.js` (`import.html`; shows the book count until an action calls `withWholeCatalog`): the comparison an Audible or
  Goodreads CSV import, or the Hardcover panel's Compare (`HardcoverSync.compare`; for a series or an author, which their pages link to
  with `hardcoverCompareHref`, `#hardcover-series=<id>`/`#hardcover-author=<id>`), opens (`PENDING_COMPARE`, its ticks in
  `picks`; `drawCompare`; Apply runs `Comparison.apply` on a copy, then for Hardcover saves and `push`es the ticked part of the plan),
  Goodreads CSV export, Check (`CATALOG.validate`) and Box sets (`addBoxSets`), Export / Restore (`Backup.readFiles`) / Merge of backups.
  Audible's catalog doesn't allow browser requests, so imports don't look series up on Audible (only the book form does, through the catalog proxy).
- `credit-kinds.js`: `CREDIT_KINDS`, what differs between authors, narrators and publishers on their lists and pages
  (`infoKey`, `hashKey`, `list`, `page`, labels, `href`).
- `credits.js` (`authors.html`, `narrators.html`, `publishers.html`, each started by its own `authors.js`/`narrators.js`/
  `publishers.js` with `startCreditsPage(kind)`): the list of authors, narrators or publishers (read from the contributors
  records alone, `LIST`). An address from when the list also showed one's page (`authors.html#a=<id>`) goes to their page
  (`location.replace`).
- `credit.js` (`author.html`, `narrator.html`, `publisher.html`, started by `author.js`/`narrator.js`/`publisher.js` with
  `startCreditPage(kind)`): one's page (`#a=<id>`, `#n=<id>`, `#p=<id>`; loads their books by their credits; without an
  address it goes to the list): bio and links from `CATALOG.authors` (`.narrators`, `.publishers`, by id), their series and
  titles from the books (`CATALOG.works`), and the form (its Name renames them on every book, `renameEntry`, and a name the catalog has joins them on a second Save; Remove author/narrator/publisher). Names on the catalog's book
  cards link here (`creditPageHref`).
- `duplicates.js` (`duplicates.html`): duplicate groups and merging (joining editions that don't
  conflict, `Edition.joinable`), and books whose editions look like one (`splitEditions`).
- `proxy/`: the catalog proxy, a Cloudflare Worker (`worker.js`, `wrangler.toml`; `docs/catalog-proxy.md`) for the catalogs whose APIs send
  no CORS headers. Routes name a catalog (`CATALOGS`: `audiobookdb`, `audible/<site>` (only `catalog/...`), `bookbrainz`, `isfdb`), never an
  address (`upstreamUrl`); GET only, only `ALLOWED_ORIGINS`, only with the `PROXY_KEY` secret (`X-Proxy-Key`); no cookies or other headers either
  way; answers found cached a day; `/ping`. `handle(request, env, deps)` takes the fetch and cache so the tests run it in Node. Hardcover never goes
  through it. Type checked with the pages (`jsconfig.json`), linted with service worker globals; deployed with `npx wrangler`, not a devDependency.
- `tests/`: `node:test` suites (`*.test.mjs`, ESM). They read the pages as written in `public/`, so they run after `make pages`.
  - `catalog.test.mjs`: unit tests of the classes in `modules/` (`Book.fromJSON` in, `JSON.stringify` out, so they compare stored shapes).
  - `proxy.test.mjs`: the Worker's `handle` with a fake catalog and cache (what it lets through and refuses).
  - `app.smoke.test.mjs`: runs a page's real HTML and its modules (`boot({page})`) as `vm.SourceTextModule`s
    (hence `--experimental-vm-modules`) with a hand-rolled fake DOM (the page's `<body>` parsed into elements; tests read
    what the page drew as `innerHTML`, written as a browser writes it, and setting `innerHTML` throws), a fake localStorage (`boot`'s `files`
    seed the old localStorage catalog, by default from `sample/`, which the page moves to IndexedDB; `files: null` for none) and a fake
    IndexedDB (`tests/fake-indexeddb.mjs`; pages booted with the same `storage` Map share it, like tabs, and their ids are `id-1`, ...;
    `await kept(storage)` is what is stored, once the saves are done; a page draws what it reads after its saves, so `await idle()`
    after a step that changes what is shown; `database.reads(store)` counts the records handed out; `get` leaves out `uid`, `withIds` keeps it; `bootBook(title)` boots a book's page,
    `follow(hash)` follows a link to another place on the page, and `location.replaced` is where `location.replace` sent it). Tests reach what the
    modules export (`ctx.render()`, `get('CATALOG.books')`, `run(...)`), so export what a test needs; a module's
    own code sees only what it imports, so a missing import fails here. When you add elements or DOM APIs
    to the app, the fake DOM may need extending. The page must fetch nothing but Hardcover (`fakeHardcover`
    in `tests/fake-hardcover.mjs`, built from Hardcover's published schema; the sandbox can't reach Hardcover), Open Library and Wikidata
    (`fakeCatalogs` in `tests/fake-catalogs.mjs`, `boot`'s `catalogs`), and the catalog proxy at a `*.workers.dev` address (`boot`'s `proxy`;
    the proxy test puts the real `handle` there; `fakeProxyCatalogs` answers its Audible and AudiobookDB routes).; covers are `<img>`s, which the fake DOM never loads.

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
name (must equal `s` exactly) to `{total, status: "ongoing"|"complete", note, ext}` (an old `url` is moved, `Catalog.moveSeriesSites`). `authors` (optional;
missing means `{}`) maps an author's name (as in `a`) to `{bio, url, ext, links}` (ids by catalog, and other addresses; the old `audible`/`goodreads`/`hardcover`
addresses are read into `ext` by `Contributor.fixLinks`), and `narrators` and `publishers` (likewise optional) map a narrator's name (as in an edition's `n`) or
a publisher's (as in `p`) to the same; they travel like series info.
A series or person is an entry of its own once it has an id: it stays when no book names it any more (`assignIds` keeps its id,
the save keeps its record; a backup's `ids` carries it), and goes only by `Catalog.removeEntry` (Remove series/author/... in their
forms; it takes the name off every book, and refuses to leave a book without an author, `removeProblem`). The UI never says "info".
`ids` maps series, author, narrator and publisher names to their ids (`Catalog.nameIds`); a backup without ids gets new ones.
IndexedDB (`CatalogRecords.STORES`, documented in `docs/data-format.md`): stores `books editions series contributors credits marks exclusions meta`,
plain objects with descriptive fields, ids from `crypto.randomUUID()` that never change, references by id (a box set's edition is
one record with `bookIds`), derived fields (sort keys, counts, `credits`) rewritten on every save and never read back, and every
sorting index ending in the key so lists can be paged. There is no `extra`: a value a class keeps aside is not stored.
The database is version 4 (`CatalogDatabase.VERSION`; `upgrade` adds and drops indexes to match `STORES`, and from versions 1 to 3
puts meta `reshape`, so the next page loads all of it, moves the series' sites and saves every record again with the derived fields this version reads); `toCatalog` still reads
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
