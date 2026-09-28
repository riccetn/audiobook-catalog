# Audiobook catalogue

A personal audiobook library, merged from an Audible export and a Goodreads export, grouped by
series and searchable by title, author, series and genre. It builds into **one self-contained HTML
file** that works offline, and also runs as a hosted Claude artifact.

- Python 3.10+ (standard library only) for the data pipeline and build
- Vanilla JavaScript for the app: no framework, no bundler, no dependencies
- Node 18+ is optional, only for the browser smoke test

```sh
git clone <this repo> && cd audiobook-catalog
make test     # unit tests + browser smoke test (uses the bundled fictional demo data)
make serve    # builds and previews the demo at http://localhost:8000/audiobook-catalog.html
make help
```

## Start your own catalogue

The repository ships **fictional demo data** only; your own library lives in git-ignored files.

```sh
python -m catalog init                                   # creates data/books.json etc. (empty)
cp ~/Downloads/ALE-spreadsheet-library.csv data/raw/     # your Audible Library Extractor export
python -m catalog import-audible data/raw/ALE-spreadsheet-library.csv --dry-run
python -m catalog import-audible data/raw/ALE-spreadsheet-library.csv
make build                                               # dist/audiobook-catalog.html: your page
```

Until `data/books.json` exists, `build` and `validate` fall back to the demo data (and say so).
Commands that write refuse to touch the demo data.

## Layout

```
data/
  sample/             fictional demo data: the only data committed to git
  books.json          YOUR catalogue, one book per line (git-ignored)
  series-info.json    YOUR researched release info per series (git-ignored)
  excluded.txt        books your imports must never re-add (git-ignored)
  raw/                your Audible/Goodreads exports (git-ignored)
src/
  index.template.html page skeleton with {{PLACEHOLDERS}}
  styles.css
  app.js              the whole UI
catalog/              the pipeline: importers, merge, validation, build, CLI (python -m catalog)
tests/                unittest suite + app.smoke.test.mjs
dist/                 build output (git-ignored, it embeds your data)
```

## Data format

`data/books.json` is a list of records with short keys, to keep the embedded page small:

| key  | meaning                                             | required |
|------|-----------------------------------------------------|----------|
| `t`  | title                                               | yes      |
| `a`  | author                                              | yes      |
| `n`  | narrator(s)                                         |          |
| `s`  | series name                                         |          |
| `sn` | position in series, as text (`"3"`, `"4-6"` for a boxed set) |  |
| `g`  | list of genre/tag strings                           |          |
| `id` | Audible ASIN, so re-imports recognise the book      |          |

`data/series-info.json` maps a series name (it must match `s` exactly) to
`{"total": 12, "status": "ongoing" | "complete", "note": "...", "url": "https://..."}`.
`total` is the number of books released so far; `url` (an author or publisher site) is optional.

`make validate` checks all of this and warns about suspicious entries.

## Everyday workflows

**Add new Audible purchases**

1. Export your library with the Audible Library Extractor and save the CSV in `data/raw/`.
2. `python -m catalog import-audible data/raw/<file>.csv --dry-run` to preview, then run it without `--dry-run`.
3. `make test`, then commit `data/books.json`.

Only finished books are imported. The command lists what it added, and anything ambiguous
(for example a book Audible files under several series).

**Edit in the app, then bring the changes back**

Edit books in the page (pencil icon, `+ Add a book`), press **Export**, then:

```sh
python -m catalog sync-export ~/Downloads/audiobook-catalog-backup-2026-01-01.json --dry-run
python -m catalog sync-export ~/Downloads/audiobook-catalog-backup-2026-01-01.json
```

It refuses files that are not valid catalogue exports and prints what changed before writing.
You can also edit `data/books.json` by hand; `make format` restores the one-book-per-line layout.

**Update release info for a series**: edit `data/series-info.json`, then `make validate`.

**Remove a book for good**: delete it from `data/books.json` *and* add its ASIN (or `Title | Author`
for books without one) to `data/excluded.txt`, otherwise the next import brings it back.

**Goodreads**: `python -m catalog import-goodreads data/raw/goodreads_library_export.csv`. Goodreads
has no "audiobook" flag, so books are picked by edition (Audible Audio, Audiobook, Audio CD,
MP3...) and the *read* shelf. Narrators come from the "Additional Authors" column, which is a guess.

## Tidy names and spacing

Authors and narrators keep a space between initials (`A. B. Quill`, not `A.B. Quill`), so the filters
never list one person twice. Every text field also has stray spacing removed: runs of spaces, tabs,
non-breaking or invisible characters, and leading/trailing whitespace. Both importers and
`sync-export` apply this automatically (`tidy_book` in `catalog/model.py`), and `make validate` warns
about any value that is not tidy. Capitalisation and quote styles are left alone.

## How imports avoid clobbering your edits

Imports only ever *add* books; an existing book is never overwritten. An incoming book counts as
already present if any of these match, strongest first:

1. its Audible `id`
2. same first author + same series (spelling-insensitive: `Ember Coast` = `Ember Coast Series`) + same number
3. same author and title, also forgiving of the long Audible form: `A Crown of Embers 5: A Spark of Dawn`
   finds your `A Spark of Dawn`, and `X, Book 1` finds `X`. A boxed set is never mistaken for its first book.

When a match has no `id` yet, the Audible ASIN is filled in, so later imports keep matching even
after more edits. New books get the series spelling already in use. If Audible lists a book under
several series, a parent series wins over its sub-series (`Thornmere` over `Thornmere: Wardens`);
otherwise the first is used and the book is flagged in the import output.

## Two ways the app saves

| where it runs | how edits persist |
|---|---|
| Hosted Claude artifact | the page republishes itself with the new data |
| Standalone file (`dist/`) | `localStorage` in that browser, plus **Export / Import** JSON for real backups |

Local edits are tagged with a fingerprint of the data the file was built from. After a rebuild
with different data, older local edits are **set aside** (kept under the
`audiobook-catalog-data.backup` key) instead of silently hiding your new data. Treat `data/books.json`
in git as the master copy and the browser as a scratch pad: Export, then `sync-export`.

To host it again as a Claude artifact, give `dist/audiobook-catalog.html` to Claude to publish.
It uses a Claude-only save call when available and falls back to the local mode everywhere else.

## Development

- `make test` runs `python -m unittest` and `node --test tests/app.smoke.test.mjs`. The smoke test
  executes the built page's real script against a small fake DOM; `make test` builds first.
- `.github/workflows/ci.yml` runs the same on GitHub Actions and uploads the built page.
- The build is deterministic: same inputs, byte-identical output. Data is embedded with `<`
  escaped, so a hostile title cannot break out of its `<script>` tag (there is a test for it).

## Privacy

This repository is meant to be public, so nothing personal is tracked:

- `data/books.json`, `data/series-info.json`, `data/excluded.txt`, `data/raw/*` and `dist/` are in
  `.gitignore`. `tests/test_repo_hygiene.py` fails if any of them stops being ignored or a
  file under `data/` other than the demo data becomes tracked.
- The demo data and every example in the tests and docs are invented.
- The consequence: **git does not back up your catalogue.** Keep your own copy: use the app's
  **Export** button, copy the `data/` files somewhere safe, or keep them in a separate *private*
  repository and point the tools at it with `--data-dir ~/my-catalogue-data` (or the
  `CATALOG_DATA_DIR` environment variable).

If you ever commit personal data by mistake, deleting it in a later commit is not enough: it stays
in history. Rewrite the history (or start the repository afresh) before pushing.

## Changes compared with the hosted page

The app was split into `src/` unchanged, apart from two fixes that only matter once there is a
build step (see the commit history):

- local edits are reused only when they were made against the same build (see above)
- editing a book keeps its `id`

## Known data quirks

`make validate` may warn about entries carried over from an Audible export, for example a series
name such as `Some Series (book ), Other Series` when Audible lists several series for one book, or
`∞` as a series number. Fix them with the edit form or in `data/books.json`.
