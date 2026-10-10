# Development

## Layout

```
data/
  sample/             fictional demo data: the only data committed to git
  books.json          YOUR catalogue (git-ignored)
  series-info.json    YOUR researched release info per series (git-ignored)
  authors.json        YOUR bios and links for authors (git-ignored)
  excluded.txt        books your imports must never re-add (git-ignored)
  not-duplicates.txt  books the Duplicates page was told are different (git-ignored)
  hardcover-token     YOUR Hardcover API token, if you saved one (git-ignored)
  raw/                your Audible/Goodreads exports (git-ignored)
index.html, app.js    the catalogue: browse by series or all books, edit books and series info
import.html, import.js    Audible and Goodreads CSV imports, Goodreads CSV export, Check / Box sets, backups (Export / Restore / Merge)
duplicates.html, duplicates.js    find and merge books entered twice
authors.html, authors.js    the authors, and each author's page: bio, links, series and titles
store.js              shared by the pages: loads data/books.json (or data/sample/), keeps and saves edits
styles.css
manifest.webmanifest, sw.js, icons/    make the app installable (on a phone) and usable offline
importers.js          the pipeline: importers, merge, validation (used by the page and the CLI)
package.json          only "type": "module": every .js file is an ES module (no npm packages)
catalog.js            the command line: node catalog.js <command> (--help lists the commands)
tests/                node:test suites (*.test.mjs), including the browser smoke test
```

## Tests

- `make test` runs `node --experimental-vm-modules --test tests/*.test.mjs`: the importers (`importers.test.mjs`), the command
  line and the save endpoint of `serve` (`cli.test.mjs`), checks on the data files (`data.test.mjs`) and the browser smoke test
  (`app.smoke.test.mjs`), which executes each page's real modules against a small fake DOM built from
  its HTML, with a fake `fetch` serving the demo data (running ES modules in `node:vm` is what needs the
  flag; Node prints an ExperimentalWarning for it).
- `.github/workflows/ci.yml` runs the same on GitHub Actions.
