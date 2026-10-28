# Audiobook catalog

A personal audiobook library, merged from Audible, Goodreads and Hardcover exports, grouped by series
and searchable by title, author, series and genre. The app is four plain pages (the catalog, _Authors_,
_Import & export_ and _Duplicates_) with a stylesheet and a script each, all in `public/`. Everything runs in the browser,
and the catalog is kept in the browser's IndexedDB. There is no server code, and the only build step writes the
pages' HTML from [Liquid](https://liquidjs.com/) templates (`make pages`), so they share their head and nav bar.

- Vanilla JavaScript: no framework, no bundler, nothing the app loads from npm (Liquid only writes the pages)
- Node 18+ for the tests; TypeScript (`npm install`) checks the code against its JSDoc types, without a build step

```sh
git clone <this repo> && cd audiobook-catalog
npm install   # once: Liquid, TypeScript, ESLint and TypeDoc
make pages    # write the pages into public/ from templates/ (test and serve do it first)
make test     # all tests, including a browser smoke test
make typecheck   # check the code against its types (TypeScript)
make lint     # look for likely mistakes (ESLint)
make check    # everything CI runs: test, typecheck, lint and the format check
make docs     # the API documentation (TypeDoc) in api-docs/out/; published at <site>/api/ beside the app
make serve    # serves public/ at http://localhost:8000/ (any static server, or GitHub Pages, works too)
make help
```

On Windows without make, `.\make.ps1 test` (or `check`, `pages`, `typecheck`, `lint`, `docs`, `serve`, `help`) runs the same commands in PowerShell.

## Start your own catalog

The first time the app opens in a browser, the catalog is empty. Fill it from _Import & export_:
import an [Audible](docs/audible.md), [Goodreads](docs/goodreads.md), [Hardcover](docs/hardcover.md) or
[AudiobookDB](docs/audiobookdb.md) library, restore a backup, or add books by hand with **+ Add a book**, whose form can fill itself in from a book's
page on Open Library, Wikidata or Hardcover, or its ISBN.

## Using it

- _Series_ lists every series and opens each one's books (and edits or removes it); _Books_ lists every book, searched,
  filtered and sorted; a book's title opens its own page, with everything about it and its **Edit** and **Merge**.
  _Import & export_ imports CSVs, runs Hardcover and AudiobookDB, checks the catalog, makes backups and merges them; _Duplicates_
  merges books entered twice; _Stats_ shows how complete the catalog is (what lacks an external id, a length, a release date, ...).
- _Authors_ gives each author a page with a short bio, links to their website and their Audible, Goodreads
  and Hardcover pages, and their series and titles ([Authors](docs/authors.md)). _Narrators_ and _Publishers_
  do the same for everyone named on the editions ([Narrators and publishers](docs/narrators-publishers.md)).
- Every edit is saved in the browser as you make it. Each browser (and each phone) keeps its own
  catalog, so **Export** a backup now and then: it is the only copy outside the browser.
- The pages speak British English ("catalogue") when your browser's first English language is a British
  one (en-GB, en-AU, en-IE, ...), and American English otherwise.

## Documentation

- [Everyday workflows](docs/workflows.md): editing, series info, missing books, removing and merging
  books, a book's details, ISBNs, dates read, links
- [Authors](docs/authors.md): author pages with a bio, links, and their series and titles
- [Narrators and publishers](docs/narrators-publishers.md): a page for each narrator and publisher with a bio, links, and their series and titles
- [Data format](docs/data-format.md): books, editions, box sets, series info, author, narrator and publisher info, tidy names
  and known data quirks
- [Audible](docs/audible.md): importing your Audible library
- [Goodreads](docs/goodreads.md): importing from and exporting to Goodreads
- [Hardcover](docs/hardcover.md): comparing with your Hardcover shelves, and putting books and reads on them
- [AudiobookDB](docs/audiobookdb.md): finding your books on AudiobookDB, comparing with your shelves there, and putting books on them
- [Catalog proxy](docs/catalog-proxy.md): an optional Cloudflare Worker of your own for the catalogs that don't answer web pages,
  which can also sync your devices
- [Merge a backup from another device](docs/backups.md): combining two catalogs that both changed
- [How imports avoid clobbering your edits](docs/imports.md): the comparison an import shows, comparing a series or an author with several catalogs at once, and how imported books are matched and merged
- [Running the app and keeping your catalog](docs/saving.md): serving the pages, browser storage, backups
- [On your phone](docs/phone.md): installing the app
- [Development](docs/development.md): file layout, tests, type checking and the API documentation

## Privacy

This repository is meant to be public, and your catalog never enters it: it lives in your browser.

- The demo data in `sample/` (used by the tests) and every example in the tests and docs are invented.
- Book covers are loaded from Amazon and Open Library by the books' ASINs and ISBNs; untick _Covers_ to
  ask neither.
- **Nothing backs up your catalog but you.** Clearing the site's data in the browser deletes it, so keep
  the backups you **Export** somewhere safe.

If you ever commit personal data by mistake, deleting it in a later commit is not enough: it stays
in history. Rewrite the history (or start the repository afresh) before pushing.
