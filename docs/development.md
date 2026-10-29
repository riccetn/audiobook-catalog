# Development

## Layout

```
templates/            the pages' HTML as Liquid templates, which make pages (build.mjs) writes into public/
  layout.liquid, nav-link.liquid    what every page shares: the <head>, the title and the nav bar
  pages/              one template per page (books.liquid becomes public/books.html)
src/                  the app's TypeScript, which make pages compiles into public/ (series.ts becomes public/series.js)
  series.ts           Series (index.html): every series, and a series' own page (its books, and its form)
  books.ts            Books: every book, searched, filtered and sorted
  book.ts             a book's page: everything about it, Read today, Merge, and the book form (also for a new book)
  combo-box.ts        the book form's search combo boxes: the author, narrator and publisher names the catalog has, as they are typed
  book-list.ts        what those three share: book cards, covers, the lists grouped by series, the address helpers
  import.ts           export file imports (Audible, Goodreads) and exports (Goodreads), catalogs' shelves (Hardcover, AudiobookDB), Check / Box sets, backups (Export / Restore / Merge)
  duplicates.ts       find and merge books entered twice
  stats.ts            how complete the catalog is: what lacks each value, and ids per external catalog (modules/catalog-stats.ts counts)
  credits.ts          the lists of authors, narrators and publishers
                        (authors.ts, narrators.ts and publishers.ts start credits.ts with their kind)
  credit.ts           one author's, narrator's or publisher's page: bio, links, series and titles, and the form
                        (author.ts, narrator.ts and publisher.ts start credit.ts with their kind; credit-kinds.ts holds
                        what differs between the kinds)
  store.ts            shared by the pages: loads from IndexedDB what the page shows, and saves every edit there
  sw.ts               the service worker, which makes the app installable (on a phone) and usable offline
  modules/            the pipeline as classes, one per module: Catalog, Book, Edition, Series, Contributor, the external
                        catalogs (see below), merge, validation (no browser APIs, so the tests run them in Node)
  vendor/qrcode.d.mts the types of the QR code library make pages copies into public/vendor/
public/               the app, and all that a static server serves (make serve, GitHub Pages): the pages and scripts
                        make pages writes (not committed), styles.css, manifest.webmanifest and icons/
package.json          "type": "module" (every .js and .mjs file is an ES module), Liquid (the pages), TypeScript, ESLint
                        with typescript-eslint, Prettier and TypeDoc
tsconfig.json, tsconfig.sw.json, tsconfig.server.json    how TypeScript compiles the pages' modules, the service
                        worker on its own, and checks the server
api-docs/             TypeDoc's settings (typedoc.json); make docs writes the API documentation into api-docs/out/
server/               the optional server, never served from public/: worker.ts lets a request in and routes it to the
                        catalog proxy (proxy.ts, /proxy/...) or sync (sync.ts, /sync); a Cloudflare Worker (wrangler.toml,
                        deploy.mjs), or make serve on this computer (serve.mjs, with sync in SQLite: sqlite-d1.ts)
sample/               fictional demo data, used by the tests: the only data committed to git
tests/                node:test suites (*.test.mjs), including the browser smoke test
```

## Pages

The pages' HTML is written from Liquid templates (`liquidjs`, a development dependency with one dependency of its
own), so the `<head>` and the nav bar are written once. `make pages` (`node build.mjs`) first compiles `src/`
into `public/` (see [Types](#types)), then renders each `templates/pages/<name>.liquid` into `public/<name>.html`;
`make test` and `make serve` run it first, and so do both workflows. The written pages and scripts are in
`.gitignore`: edit the template or the TypeScript, never what is in `public/`. Last it writes
`public/sw-app.js` (git-ignored too): every file in `public/` (but `sw.js`, the source maps and the API docs), which the service worker
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
the lists of them in `CatalogConnectors` (`catalog-connectors.ts`), so a catalog is added by writing a class for each
thing it does and listing it there:

| Base class                           | What it is                                            | Today                                                                                          | A subclass writes                                |
| ------------------------------------ | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `FileImporter`                       | an export file to import (a CSV)                      | `AudibleImporter`, `GoodreadsImporter`                                                         | `CATALOG`, `LABEL`, `readRow`                    |
| `FileExporter`                       | a file for another catalog's import                   | `GoodreadsExporter`                                                                            | `CATALOG`, `LABEL`, `FILE_NAME`, `write`         |
| `ShelfSync` (with a `CatalogClient`) | your shelves there: Compare, then send what is ticked | `HardcoverSync`, `AudiobookdbSync`, `AudibleSync`                                              | `CLIENT`, `compare`, `summary`, `send`, `addIds` |
| `BookSource`                         | a catalog the book form's _Fill in_ asks              | `AudibleSource`, `AudiobookdbSource`, `HardcoverSource`, `OpenLibrarySource`, `WikidataSource` | `CATALOG`, `LABEL`, `NEEDS`, `answers`, `lookup` |

A `CatalogClient` subclass asks the catalog's API and says what your key for it is: `KEY_NAME` (Hardcover calls its
key a token), `KEY_STORAGE` (where this browser keeps it), `KEY_HELP`, whether nothing works without it (`KEY_NEEDED`),
and whether it is asked through the catalog proxy (`VIA_PROXY`); `store.ts` reads and saves every key the same way
(`savedKey`, `saveKey`, `catalogClient`). Besides the class:

- its ids and addresses go in `ExternalCatalog` (as before), and a proxied API's route in `server/proxy.ts`;
- an export file's or a shelf sync's panel goes in `templates/pages/import.liquid`, its ids starting with the class's
  `CATALOG` (`<catalog>ImportBtn`, `<catalog>ExportBtn`; a shelf sync's panel is `{% render 'shelf-panel', ... %}`).
- a catalog without shelves of yours can still compare a series: `AudibleSync` plans nothing (`plan` is null), its
  client has no `KEY_STORAGE` (so `CatalogConnectors.CLIENTS` leaves it out), `PARTS` says it compares only
  series (the pages link only those to it), and its Compare row in the Audible panel is
  `{% render 'shelf-compare', ..., every: false %}`.
- a shelf sync listed in `SYNCS` also goes in `CompareCatalogs.ALL` (`compare-catalogs.ts`: its `CATALOG`, `LABEL` and
  `PARTS` as plain data), which the series and author pages' Compare buttons read, so those pages don't load the
  syncs; a test fails when the two lists differ.
- a shelf sync listed in `SYNCS` is also asked by _Compare with all catalogs_ for each kind in its `PARTS` (`MultiComparison`), with nothing more
  to write.

`tests/catalog.test.mjs` has a made-up catalog, Shelfmark, written against the base classes alone.

## Tests

- `make test` runs `node --experimental-vm-modules --enable-source-maps --test tests/*.test.mjs` on what `make pages`
  compiled into `public/` (so run that first when you run one suite by hand): the classes (`catalog.test.mjs`), the server (`server.test.mjs`: the catalog proxy, sync and `make serve`), the service worker (`service-worker.test.mjs`),
  and the browser smoke test (`app.smoke.test.mjs`), which executes each page's real modules against a small fake DOM built from
  its HTML, with a fake `localStorage` holding the demo data, which the page moves into a fake IndexedDB
  (`tests/fake-indexeddb.mjs`) as a browser would (running ES modules in `node:vm` is what needs the flag;
  Node prints an ExperimentalWarning for it, and for `node:sqlite`, which the server's tests use). With the source
  maps, a failure's stack trace names the line in `src/`. They need Node 22.18 or later, which runs the server's
  TypeScript as it is.
- `.github/workflows/ci.yml` runs the same on GitHub Actions. The smoke test also fails when `public/`
  holds a file no page uses (a page, a module one imports, or what their `<head>` or the manifest names), as the
  service worker caches all of it, so nothing ends up served by accident.
- `.github/workflows/pages.yml` publishes `public/` to GitHub Pages on pushes to `main`, and `.github/workflows/server.yml`
  deploys the server with `public/` as its static assets (`make deploy-server`), once the repository has its Cloudflare secrets.

## Types

The app is written in TypeScript, in `src/`, and `make pages` compiles it with `tsc` into `public/`, where the
browser loads it: each `src/<name>.ts` becomes `public/<name>.js` (and `src/modules/` becomes `public/modules/`),
with a source map beside it, `<name>.js.map`, which holds the TypeScript itself. Nothing is bundled or minified, and
a type error stops the build. The compiled files are in `.gitignore`, and `make pages` clears them out before it
compiles, so a module taken out of `src/` isn't still served.

```sh
npm install       # once: installs TypeScript, ESLint and typescript-eslint into node_modules/
make pages        # compile src/ into public/ (tsconfig.json, and tsconfig.sw.json for the service worker), then the pages
make typecheck    # check src/ and server/ without writing anything (tsconfig.server.json for the server)
```

- **Debugging.** DevTools (Chrome, Edge, Firefox, and a phone through `chrome://inspect`) reads the source maps, so
  Sources shows the files of `src/` under their own names, breakpoints go on their lines, and an error in the
  console names its line in `src/`. The compiled `.js` shifts lines (a line that held only a type is gone), so a
  line number from the compiled file alone, without its map, doesn't match `src/`. The service worker doesn't cache
  the maps: DevTools fetches them only while it is open.
- **The server** (`server/*.ts`) isn't compiled: Wrangler and Node (22.18 on) run TypeScript as it is, by stripping
  its types. So its files import each other by their `.ts` names (`allowImportingTsExtensions`) and use only
  TypeScript stripping can remove (`erasableSyntaxOnly`: no `enum`, `namespace` or parameter properties).
- **Imports.** The app's modules import each other by the names they are served under (`import {Book} from
'./book.js'`), which TypeScript finds as `book.ts`. A type alone comes in with `import type`
  (`verbatimModuleSyntax`), which the compiled file leaves out, so the browser loads nothing more for it.
- A class declares its fields with their types above its constructor; a type that isn't a class (a report of an
  import, a merge or a Hardcover run: `MergeReport`, `Picks`, ...) is an exported `interface` or `type` in the
  module that makes it.
- The checker only knows what the code says. A catalog read from the old localStorage, a backup or a CSV is
  `Unchecked` (any) until the code has checked it: `Backup.read()` (with `BackupV1`, for a backup
  from before version 2 and the old localStorage catalog) brings it to the current format, and `Validator.validate()` is what makes sure it describes `Book`s before `Book.fromJSON()` makes them.
- `byId(id)` and `fieldById(id)` in `store.ts` get the page's elements; they throw when the page lacks
  one, so a typo in an id fails at once with its name.
- CI runs `make typecheck` as part of `make check` (below), and `make pages` checks the app again as it compiles it.

## API documentation

`make docs` writes the code's API documentation with [TypeDoc](https://typedoc.org/), from the code's doc comments
and its types: every page's module (`store.ts`, `book-list.ts`, `series.ts`, ...) and every class
in `modules/`, with what each exports. Open `api-docs/out/index.html` in a browser; the folder is in `.gitignore`.

```sh
npm install   # once: also installs TypeDoc
make docs     # write api-docs/out/ (make docs API_DOCS=<folder> for another one; .\make.ps1 docs -Out <folder>)
```

- The settings are `api-docs/typedoc.json`: the entry points are `src/*.ts` (but `sw.ts`) and `src/modules/*.ts`,
  read with `tsconfig.json`. A comment shows up there as it is written, so the doc comments on exported functions and
  classes are what the documentation says about them.
- TypeDoc, like typescript-eslint, needs TypeScript's JavaScript API, which TypeScript 7 doesn't have yet, so the
  repository stays on TypeScript 6 until both support 7.
- `.github/workflows/pages.yml` writes the documentation into `public/api/` before publishing, so it is served at
  `<site>/api/` beside the app (on GitHub Pages, `https://<user>.github.io/audiobook-catalog/api/`). It is written
  only there: locally it stays in `api-docs/out/`, outside `public/`, so `make serve` and the tests never see it.
  CI runs `make docs` on every pull request too, so a change that breaks it fails there first.

## Lint

`make lint` runs ESLint with its recommended rules, and typescript-eslint's for the TypeScript (`eslint.config.js`),
over `src/`, `server/` and `tests/` (not `public/`, which is compiled). It looks
for likely mistakes, such as unused variables, needless escapes and invisible characters typed into the
source; it doesn't format, which is Prettier's job (below). The rules are ESLint's own, so:

- a catch that doesn't use the error leaves it out, `catch{ return null; }`, and one that does nothing says
  why, `catch{ /* the address just stays as it was */ }`;
- a parameter only named to document what an override gets starts with `_` (`FileImporter.readRow(_row, _result)`);
- `any` is allowed (`no-explicit-any` is off) where the code means "whatever this holds", a stored record or a
  catalog's answer, as the JSDoc types had it before the code was TypeScript;
- where a rule is wrong for one line, say why beside it:
  `// eslint-disable-next-line no-control-regex -- the separator controls are what it matches`.

## Format

Prettier lays out the code, JSON, Markdown and YAML (`.prettierrc.json`): tabs, single quotes and 120 columns,
except Markdown and YAML, which take two spaces. `sample/` (kept in the old data files' compact shape) and
`package-lock.json` (npm writes it) are left alone (`.prettierignore`), and so is everything `.gitignore` lists.
`npm install` points git at `.githooks/`, whose `pre-commit` hook formats the files you commit and stages the
result (of a file only partly staged, just the staged version is formatted and linted, and the working copy is
formatted apart, so what stays unstaged is only your unstaged edits), then lints the code you commit with ESLint and type
checks the project with TypeScript, stopping the commit on an error (a warning is shown but lets it through; `git commit --no-verify` skips the hook).
`make format` formats everything, and `make format-check` fails on a file that isn't formatted.

`make check` runs test, typecheck, lint and format-check, and stops at the first that fails; CI runs it on
every pull request, so running it first catches what CI would.

## Spelling

The code, its comments and these docs use American spelling. The pages are written that way too, and
are shown in British spelling to a browser whose first English language is a British one
(`Text.prefersBritish` in `modules/text.ts`, from `navigator.languages`; `en-GB`, `en-AU`, `en-IE`, `en-CA`, ...).
`store.ts` respells the page's own HTML as it loads, and text the code puts on the page goes through
`spell()`; book titles and other data never do. `spelled()` knows only the words in `BRITISH_WORDS`
(now just catalog/catalogue), so a page that starts using another such word adds it there. Stored keys and
file names (`audiobook-catalog-device`, the backup's file name) are names, not text, and never change.
