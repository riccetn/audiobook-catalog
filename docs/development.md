# Development

## Layout

```
templates/            the pages' HTML as Liquid templates, which make pages (build.mjs) writes into public/
  layout.liquid, nav-link.liquid    what every page shares: the <head>, the title and the nav bar
  pages/              one template per page (books.liquid becomes public/books.html)
public/               the app, and all that a static server serves (make serve, GitHub Pages); its .html files are written, not committed
  index.html, series.js    Series: every series, and a series' own page (its books, and its info form)
  books.html, books.js    Books: every book, searched, filtered and sorted
  book.html, book.js    a book's page: everything about it, Read today, Merge, and the book form (also for a new book)
  combo-box.js          the book form's search combo boxes: the author, narrator and publisher names the catalog has, as they are typed
  book-list.js          what those three share: book cards, covers, the lists grouped by series, the address helpers
  import.html, import.js    Audible, Goodreads and Hardcover imports, Goodreads CSV export, Check / Box sets, backups (Export / Restore / Merge)
  duplicates.html, duplicates.js    find and merge books entered twice
  authors.html, narrators.html, publishers.html, credits.js    the lists of authors, narrators and publishers
                        (authors.js, narrators.js and publishers.js start credits.js with their kind)
  author.html, narrator.html, publisher.html, credit.js    one author's, narrator's or publisher's page: bio,
                        links, series and titles, and the info form (author.js, narrator.js and publisher.js
                        start credit.js with their kind; credit-kinds.js holds what differs between the kinds)
  store.js              shared by the pages: loads from IndexedDB what the page shows, and saves every edit there
  styles.css
  manifest.webmanifest, sw.js, icons/    make the app installable (on a phone) and usable offline
  modules/              the pipeline as classes, one per module: Catalog, Book, Edition, Series, Contributor, the importers and
                        exporter, merge, validation, Hardcover (no browser APIs, so the tests run them in Node)
package.json          "type": "module" (every .js file is an ES module), Liquid (the pages), TypeScript (the type checker) and ESLint
jsconfig.json, jsconfig.sw.json    what the type checker checks: the pages' modules, and the service worker on its own
sample/               fictional demo data, used by the tests: the only data committed to git
tests/                node:test suites (*.test.mjs), including the browser smoke test
```

## Pages

The pages' HTML is written from Liquid templates (`liquidjs`, a development dependency with one dependency of its
own), so the `<head>` and the nav bar are written once. `make pages` (`node build.mjs`) renders each
`templates/pages/<name>.liquid` into `public/<name>.html`; `make test` and `make serve` run it first, and so do
both workflows. The written pages are in `.gitignore`: edit the template, never `public/*.html`.

A page's template starts by naming the layout and what it fills in, then holds the page's own HTML:

```liquid
{% layout 'layout' title: 'Books' nav: 'books.html' script: 'books.js' %}
	<p class="sub" id="subtitle">Loading&hellip;</p>
	...
```

`title` goes before "· Audiobook Catalog" in the tab (left out on the Series page), `nav` is the nav bar link
marked current (a book's page marks Books), and `script` is the page's module. The nav bar's links are in
`layout.liquid`; a new page in it is a line there, a template in `pages/`, and its file in `sw.js`'s `APP` list.
The build is strict, so a misspelled variable fails it. Nothing is rendered in the browser: Liquid never reaches
`public/`.

## Tests

- `make test` runs `node --experimental-vm-modules --test tests/*.test.mjs`: the classes (`catalog.test.mjs`),
  and the browser smoke test (`app.smoke.test.mjs`), which executes each page's real modules against a small fake DOM built from
  its HTML, with a fake `localStorage` holding the demo data, which the page moves into a fake IndexedDB
  (`tests/fake-indexeddb.mjs`) as a browser would (running ES modules in `node:vm` is what needs the flag;
  Node prints an ExperimentalWarning for it).
- `.github/workflows/ci.yml` runs the same on GitHub Actions. The smoke test also fails when `public/`
  holds a file the service worker doesn't cache, so nothing ends up served by accident.
- `.github/workflows/pages.yml` publishes `public/` to GitHub Pages on pushes to `main`.

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
  `Unchecked` (any) until the code has checked it: `Backup.read()` and `Book.fixBooks()` bring it to the
  current format, and `Validator.validate()` is what makes sure it describes `Book`s before `Book.fromJSON()` makes them.
- `byId(id)` and `fieldById(id)` in `store.js` get the page's elements; they throw when the page lacks
  one, so a typo in an id fails at once with its name.
- CI runs `make typecheck` as part of `make check` (below).

## Lint

`make lint` runs ESLint with its recommended rules (`eslint.config.js`) over `public/` and `tests/`. It looks
for likely mistakes, such as unused variables, needless escapes and invisible characters typed into the
source; it doesn't format, which is left to `.editorconfig`. The rules are ESLint's own, so:
- a catch that doesn't use the error leaves it out, `catch{ return null; }`, and one that does nothing says
  why, `catch{ /* the address just stays as it was */ }`;
- a parameter only named to document what an override gets starts with `_` (`Importer.readRow(_row, _result)`);
- where a rule is wrong for one line, say why beside it:
  `// eslint-disable-next-line no-control-regex -- the separator controls are what it matches`.

`make check` runs all three of test, typecheck and lint, and stops at the first that fails; CI runs it on
every pull request, so running it first catches what CI would.

## Spelling

The code, its comments and these docs use American spelling. The pages are written that way too, and
are shown in British spelling to a browser whose first English language is a British one
(`Text.prefersBritish` in `modules/text.js`, from `navigator.languages`; `en-GB`, `en-AU`, `en-IE`, `en-CA`, ...).
`store.js` respells the page's own HTML as it loads, and text the code puts on the page goes through
`spell()`; book titles and other data never do. `spelled()` knows only the words in `BRITISH_WORDS`
(now just catalog/catalogue), so a page that starts using another such word adds it there. Stored keys and
file names (`audiobook-catalog-device`, the backup's file name) are names, not text, and never change.
