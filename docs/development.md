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
package.json          only "type": "module": every .js file is an ES module (no npm packages)
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
