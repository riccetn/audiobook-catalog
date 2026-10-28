# Development

## Layout

```
templates/            the pages' HTML as Liquid templates, which make pages (build.mjs) writes into public/
  layout.liquid, nav-link.liquid    what every page shares: the <head>, the title and the nav bar
  pages/              one template per page (books.liquid becomes public/books.html)
public/               the app, and all that a static server serves (make serve, GitHub Pages); its .html files are written, not committed
  index.html, series.js    Series: every series, and a series' own page (its books, and its form)
  books.html, books.js    Books: every book, searched, filtered and sorted
  book.html, book.js    a book's page: everything about it, Read today, Merge, and the book form (also for a new book)
  combo-box.js          the book form's search combo boxes: the author, narrator and publisher names the catalog has, as they are typed
  book-list.js          what those three share: book cards, covers, the lists grouped by series, the address helpers
  import.html, import.js    export file imports (Audible, Goodreads) and exports (Goodreads), catalogs' shelves (Hardcover, AudiobookDB), Check / Box sets, backups (Export / Restore / Merge)
  duplicates.html, duplicates.js    find and merge books entered twice
  stats.html, stats.js    how complete the catalog is: what lacks each value, and ids per external catalog (modules/catalog-stats.js counts)
  authors.html, narrators.html, publishers.html, credits.js    the lists of authors, narrators and publishers
                        (authors.js, narrators.js and publishers.js start credits.js with their kind)
  author.html, narrator.html, publisher.html, credit.js    one author's, narrator's or publisher's page: bio,
                        links, series and titles, and the form (author.js, narrator.js and publisher.js
                        start credit.js with their kind; credit-kinds.js holds what differs between the kinds)
  store.js              shared by the pages: loads from IndexedDB what the page shows, and saves every edit there
  styles.css
  manifest.webmanifest, sw.js, icons/    make the app installable (on a phone) and usable offline
  modules/              the pipeline as classes, one per module: Catalog, Book, Edition, Series, Contributor, the external
                        catalogs (see below), merge, validation (no browser APIs, so the tests run them in Node)
package.json          "type": "module" (every .js file is an ES module), Liquid (the pages), TypeScript (the type checker) and ESLint
api-docs/             TypeDoc's settings (typedoc.json) and its own package.json; make docs writes the API documentation into api-docs/out/
jsconfig.json, jsconfig.sw.json    what the type checker checks: the pages' modules, and the service worker on its own
server/               the optional server, never served from public/: worker.js lets a request in and routes it to the
                        catalog proxy (proxy.js, /proxy/...) or sync (sync.js, /sync); a Cloudflare Worker (wrangler.toml,
                        deploy.mjs), or make serve on this computer (serve.mjs, with sync in SQLite: sqlite-d1.js)
sample/               fictional demo data, used by the tests: the only data committed to git
tests/                node:test suites (*.test.mjs), including the browser smoke test
```

## Pages

The pages' HTML is written from Liquid templates (`liquidjs`, a development dependency with one dependency of its
own), so the `<head>` and the nav bar are written once. `make pages` (`node build.mjs`) renders each
`templates/pages/<name>.liquid` into `public/<name>.html`; `make test` and `make serve` run it first, and so do
both workflows. The written pages are in `.gitignore`: edit the template, never `public/*.html`. Last it writes
`public/sw-app.js` (git-ignored too): every file in `public/` (but `sw.js` and the API docs), which the service worker
caches, and a hash of them, which it names its cache by. A file added to `public/` or taken out needs nothing more. It
serves the app from that cache, so a deploy is picked up because this file changes. On `localhost` it goes to the
network first, so an edit shows on reload.

A page's template starts by naming the layout and what it fills in, then holds the page's own HTML:

```liquid
{% layout 'layout' title: 'Books' nav: 'books.html' script: 'books.js' %}
	<p class="sub" id="subtitle">Loading&hellip;</p>
	...
```

`title` goes before "· Audiobook Catalog" in the tab (left out on the Series page), `nav` is the nav bar link
marked current (a book's page marks Books), and `script` is the page's module. The nav bar's links are in
`layout.liquid`; a new page in it is a line there, and a template in `pages/`.
The build is strict, so a misspelled variable fails it. Nothing is rendered in the browser: Liquid never reaches
`public/`.

## External catalogs

The pages and the book form's lookup know the external catalogs only through four base classes in `modules/`, and
the lists of them in `CatalogConnectors` (`catalog-connectors.js`), so a catalog is added by writing a class for each
thing it does and listing it there:

| Base class                           | What it is                                            | Today                                                                                          | A subclass writes                                |
| ------------------------------------ | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `FileImporter`                       | an export file to import (a CSV)                      | `AudibleImporter`, `GoodreadsImporter`                                                         | `CATALOG`, `LABEL`, `readRow`                    |
| `FileExporter`                       | a file for another catalog's import                   | `GoodreadsExporter`                                                                            | `CATALOG`, `LABEL`, `FILE_NAME`, `write`         |
| `ShelfSync` (with a `CatalogClient`) | your shelves there: Compare, then send what is ticked | `HardcoverSync`, `AudiobookdbSync`, `AudibleSync`                                              | `CLIENT`, `compare`, `summary`, `send`, `addIds` |
| `BookSource`                         | a catalog the book form's _Fill in_ asks              | `AudibleSource`, `AudiobookdbSource`, `HardcoverSource`, `OpenLibrarySource`, `WikidataSource` | `CATALOG`, `LABEL`, `NEEDS`, `answers`, `lookup` |

A `CatalogClient` subclass asks the catalog's API and says what your key for it is: `KEY_NAME` (Hardcover calls its
key a token), `KEY_STORAGE` (where this browser keeps it), `KEY_HELP`, whether nothing works without it (`KEY_NEEDED`),
and whether it is asked through the catalog proxy (`VIA_PROXY`); `store.js` reads and saves every key the same way
(`savedKey`, `saveKey`, `catalogClient`). Besides the class:

- its ids and addresses go in `ExternalCatalog` (as before), and a proxied API's route in `server/proxy.js`;
- an export file's or a shelf sync's panel goes in `templates/pages/import.liquid`, its ids starting with the class's
  `CATALOG` (`<catalog>ImportBtn`, `<catalog>ExportBtn`; a shelf sync's panel is `{% render 'shelf-panel', ... %}`).
- a catalog without shelves of yours can still compare a series: `AudibleSync` plans nothing (`plan` is null), its
  client has no `KEY_STORAGE` (so `CatalogConnectors.CLIENTS` leaves it out), `PARTS` says it compares only
  series (the pages link only those to it), and its Compare row in the Audible panel is
  `{% render 'shelf-compare', ..., every: false %}`.
- a shelf sync listed in `SYNCS` also goes in `CompareCatalogs.ALL` (`compare-catalogs.js`: its `CATALOG`, `LABEL` and
  `PARTS` as plain data), which the series and author pages' Compare buttons read, so those pages don't load the
  syncs; a test fails when the two lists differ.
- a shelf sync listed in `SYNCS` is also asked by _Compare with all catalogs_ for each kind in its `PARTS` (`MultiComparison`), with nothing more
  to write.

`tests/catalog.test.mjs` has a made-up catalog, Shelfmark, written against the base classes alone.

## Tests

- `make test` runs `node --experimental-vm-modules --test tests/*.test.mjs`: the classes (`catalog.test.mjs`), the server (`server.test.mjs`: the catalog proxy, sync and `make serve`), the service worker (`service-worker.test.mjs`),
  and the browser smoke test (`app.smoke.test.mjs`), which executes each page's real modules against a small fake DOM built from
  its HTML, with a fake `localStorage` holding the demo data, which the page moves into a fake IndexedDB
  (`tests/fake-indexeddb.mjs`) as a browser would (running ES modules in `node:vm` is what needs the flag;
  Node prints an ExperimentalWarning for it, and for `node:sqlite`, which the server's tests use). They need Node 22.13 or later.
- `.github/workflows/ci.yml` runs the same on GitHub Actions. The smoke test also fails when `public/`
  holds a file no page uses (a page, a module one imports, or what their `<head>` or the manifest names), as the
  service worker caches all of it, so nothing ends up served by accident.
- `.github/workflows/pages.yml` publishes `public/` to GitHub Pages on pushes to `main`, and `.github/workflows/server.yml`
  deploys the server with `public/` as its static assets (`make deploy-server`), once the repository has its Cloudflare secrets.

## Types

The code is plain JavaScript with its types written in JSDoc comments, and TypeScript checks that the
code agrees with them. Nothing is compiled: the browser loads the files exactly as they are, and
TypeScript (a development dependency, like ESLint below) is never served.

```sh
npm install       # once: installs TypeScript and ESLint into node_modules/
make typecheck    # tsc --noEmit with checkJs and strict, over public/ (jsconfig.json, and jsconfig.sw.json for sw.js)
```

- The catalog's parts are classes in `modules/`: `Catalog`, `Book`, `Edition`, `Series`, `Contributor`, ... A module
  that only needs a type (a report of an import, a merge or a Hardcover run is a `@typedef` in the module that
  makes it) brings it in with `/** @import {MergeReport} from './merger.js' */`, a comment, so the browser
  loads nothing more.
- Functions say what they take and give with `@param` and `@returns`; a variable that starts empty says
  what it will hold (`/** @type {string[]} */`).
- The checker only knows what the code says. A catalog read from the old localStorage, a backup or a CSV is
  `Unchecked` (any) until the code has checked it: `Backup.read()` (with `BackupV1`, for a backup
  from before version 2 and the old localStorage catalog) brings it to the current format, and `Validator.validate()` is what makes sure it describes `Book`s before `Book.fromJSON()` makes them.
- `byId(id)` and `fieldById(id)` in `store.js` get the page's elements; they throw when the page lacks
  one, so a typo in an id fails at once with its name.
- CI runs `make typecheck` as part of `make check` (below).

## API documentation

`make docs` writes the code's API documentation with [TypeDoc](https://typedoc.org/), from the same JSDoc comments
and types the type checker reads: every page's module (`store.js`, `book-list.js`, `series.js`, ...) and every class
in `modules/`, with what each exports. Open `api-docs/out/index.html` in a browser; the folder is in `.gitignore`.

```sh
npm install   # once: also installs TypeDoc
make docs     # write api-docs/out/ (make docs API_DOCS=<folder> for another one; .\make.ps1 docs -Out <folder>)
```

- The settings are `api-docs/typedoc.json`: the entry points are `public/*.js` (but `sw.js`) and `public/modules/*.js`,
  read with `jsconfig.json`. A comment shows up there as it is written, so the doc comments on exported functions and
  classes are what the documentation says about them.
- TypeDoc needs TypeScript's JavaScript API, which TypeScript 7 (the type checker, `make typecheck`) doesn't have. So
  `api-docs/` is an npm workspace of its own, with TypeDoc and the TypeScript 6 it reads the code with in
  `api-docs/node_modules/`; one `npm install` (or `npm ci`) at the top installs both. TypeScript 6 disagrees with 7 on a
  few types, so TypeDoc skips the type check (`skipErrorChecking`): checking is `make typecheck`'s job.
- `.github/workflows/pages.yml` writes the documentation into `public/api/` before publishing, so it is served at
  `<site>/api/` beside the app (on GitHub Pages, `https://<user>.github.io/audiobook-catalog/api/`). It is written
  only there: locally it stays in `api-docs/out/`, outside `public/`, so `make serve` and the tests never see it.
  CI runs `make docs` on every pull request too, so a change that breaks it fails there first.

## Lint

`make lint` runs ESLint with its recommended rules (`eslint.config.js`) over `public/` and `tests/`. It looks
for likely mistakes, such as unused variables, needless escapes and invisible characters typed into the
source; it doesn't format, which is Prettier's job (below). The rules are ESLint's own, so:

- a catch that doesn't use the error leaves it out, `catch{ return null; }`, and one that does nothing says
  why, `catch{ /* the address just stays as it was */ }`;
- a parameter only named to document what an override gets starts with `_` (`FileImporter.readRow(_row, _result)`);
- where a rule is wrong for one line, say why beside it:
  `// eslint-disable-next-line no-control-regex -- the separator controls are what it matches`.

## Format

Prettier lays out the code, JSON, Markdown and YAML (`.prettierrc.json`): tabs, single quotes and 120 columns,
except Markdown and YAML, which take two spaces. `sample/` (kept in the old data files' compact shape) and
`package-lock.json` (npm writes it) are left alone (`.prettierignore`), and so is everything `.gitignore` lists.
`npm install` points git at `.githooks/`, whose `pre-commit` hook formats the files you commit and stages the
result (of a file only partly staged, just the staged version is formatted and linted, and the working copy is
formatted apart, so what stays unstaged is only your unstaged edits), then lints the JavaScript you commit with ESLint and type
checks the project with TypeScript, stopping the commit on an error (a warning is shown but lets it through; `git commit --no-verify` skips the hook).
`make format` formats everything, and `make format-check` fails on a file that isn't formatted.

`make check` runs test, typecheck, lint and format-check, and stops at the first that fails; CI runs it on
every pull request, so running it first catches what CI would.

## Spelling

The code, its comments and these docs use American spelling. The pages are written that way too, and
are shown in British spelling to a browser whose first English language is a British one
(`Text.prefersBritish` in `modules/text.js`, from `navigator.languages`; `en-GB`, `en-AU`, `en-IE`, `en-CA`, ...).
`store.js` respells the page's own HTML as it loads, and text the code puts on the page goes through
`spell()`; book titles and other data never do. `spelled()` knows only the words in `BRITISH_WORDS`
(now just catalog/catalogue), so a page that starts using another such word adds it there. Stored keys and
file names (`audiobook-catalog-device`, the backup's file name) are names, not text, and never change.
