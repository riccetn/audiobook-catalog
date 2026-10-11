# Development

## Layout

```
public/               the app, and all that a static server serves (make serve, GitHub Pages)
  index.html, app.js    the catalogue: browse by series or all books, edit books and series info
  import.html, import.js    Audible, Goodreads and Hardcover imports, Goodreads CSV export, Check / Box sets, backups (Export / Restore / Merge)
  duplicates.html, duplicates.js    find and merge books entered twice
  authors.html, authors.js    the authors, and each author's page: bio, links, series and titles
  store.js              shared by the pages: loads the catalogue from localStorage and saves every edit there
  styles.css
  manifest.webmanifest, sw.js, icons/    make the app installable (on a phone) and usable offline
  importers.js          the pipeline: importers, merge, validation, Hardcover (no browser APIs, so the tests run it in Node)
package.json          "type": "module" (every .js file is an ES module) and TypeScript, the type checker
jsconfig.json, jsconfig.sw.json    what the type checker checks: the pages' modules, and the service worker on its own
data/
  sample/             fictional demo data, used by the tests: the only data committed to git
  raw/                a place for your Audible/Goodreads exports (git-ignored)
tests/                node:test suites (*.test.mjs), including the browser smoke test
```

## Tests

- `make test` runs `node --experimental-vm-modules --test tests/*.test.mjs`: the importers (`importers.test.mjs`),
  checks on the demo data and on what git tracks (`data.test.mjs`) and the browser smoke test
  (`app.smoke.test.mjs`), which executes each page's real modules against a small fake DOM built from
  its HTML, with a fake `localStorage` holding the demo data (running ES modules in `node:vm` is what
  needs the flag; Node prints an ExperimentalWarning for it).
- `.github/workflows/ci.yml` runs the same on GitHub Actions. The smoke test also fails when `public/`
  holds a file the service worker doesn't cache, so nothing ends up served by accident.
- `.github/workflows/pages.yml` publishes `public/` to GitHub Pages on pushes to `main`.

## Types

The code is plain JavaScript with its types written in JSDoc comments, and TypeScript checks that the
code agrees with them. Nothing is compiled: the browser loads the files exactly as they are, and
TypeScript (the only npm package, a development dependency) is never served.

```sh
npm install       # once: installs TypeScript into node_modules/
make typecheck    # tsc --noEmit with checkJs and strict, over public/ (jsconfig.json, and jsconfig.sw.json for sw.js)
```

- The catalogue's shapes are `@typedef`s at the top of `importers.js`: `Book`, `Edition`, `SeriesEntry`,
  `AuthorEntry`, `Backup` and the reports of imports, merges and Hardcover runs. Other modules bring
  them in with `/** @import {Book, Edition} from './importers.js' */`, a comment, so the browser loads
  nothing more.
- Functions say what they take and give with `@param` and `@returns`; a variable that starts empty says
  what it will hold (`/** @type {string[]} */`).
- The checker only knows what the code says. A catalogue read from localStorage, a backup or a CSV is
  `Unchecked` (any) until the code has checked it: `readBackup()` and `fixBooks()` bring it to the
  current format, and `validate()` is what makes sure it is a list of `Book`s.
- `byId(id)` and `fieldById(id)` in `store.js` get the page's elements; they throw when the page lacks
  one, so a typo in an id fails at once with its name.
- CI runs `make typecheck` beside `make test`.

