# Audiobook catalogue

A personal audiobook library, merged from an Audible export and a Goodreads export, grouped by
series and searchable by title, author, series and genre. The app is three plain pages (the catalogue,
*Import & export* and *Duplicates*) with a stylesheet and a script each, and it reads the catalogue
from `data/`. There is no build step.

- Vanilla JavaScript for the app: no framework, no bundler, no dependencies
- Node 18+ for the command line tools (`node catalog.js`) and the tests; no npm packages

```sh
git clone <this repo> && cd audiobook-catalog
make test     # all tests, including a browser smoke test (uses the bundled fictional demo data)
make serve    # serves the app (with the demo data) at http://localhost:8000/
make help
```

## Start your own catalogue

The repository ships **fictional demo data** only; your own library lives in git-ignored files.

```sh
node catalog.js init                                     # creates data/books.json etc. (empty)
cp ~/Downloads/ALE-spreadsheet-library.csv data/raw/     # your Audible Library Extractor export
node catalog.js import-audible data/raw/ALE-spreadsheet-library.csv --dry-run
node catalog.js import-audible data/raw/ALE-spreadsheet-library.csv
make serve                                               # your catalogue at http://localhost:8000/
```

Until `data/books.json` exists, the app and `validate` fall back to the demo data (`validate` says so).
Commands that write refuse to touch the demo data.

## Layout

```
data/
  sample/             fictional demo data: the only data committed to git
  books.json          YOUR catalogue (git-ignored)
  series-info.json    YOUR researched release info per series (git-ignored)
  excluded.txt        books your imports must never re-add (git-ignored)
  raw/                your Audible/Goodreads exports (git-ignored)
index.html, app.js    the catalogue: browse by series or all books, edit books and series info
import.html, import.js    Audible and Goodreads CSV imports, backups (Export / Restore)
duplicates.html, duplicates.js    find and merge books entered twice
store.js              shared by the pages: loads data/books.json (or data/sample/), keeps and saves edits
styles.css
importers.js          the pipeline: importers, merge, validation (used by the page and the CLI)
catalog.js            the command line: node catalog.js <command> (--help lists the commands)
tests/                node:test suites (*.test.mjs), including the browser smoke test
```

## Data format

`data/books.json` is a list of titles, with short keys to keep the file small:

| key  | meaning                                             | required |
|------|-----------------------------------------------------|----------|
| `t`  | title                                               | yes      |
| `a`  | author                                              | yes      |
| `s`  | series name                                         |          |
| `sn` | position in series, as text (`"3"`, `"4-6"` for a boxed set) |  |
| `g`  | list of genre/tag strings                           |          |
| `r`  | list of dates you read it, oldest first (`["2023-06-02", "2025-11-20"]`); `"2024-03"` or `"2024"` when you don't remember the day. A single date may be written as a plain string (`"r": "2024-03-15"`); it is read as a list. No `r` means the date is unknown, not that the book is unread |  |
| `e`  | list of the title's editions (below)                |          |

Each title can have several **editions** (the Audible release, a UK release with another narrator, a
dramatized adaptation, the CD...). Every field of an edition is optional, but an edition is never empty;
the ASIN, Goodreads id and ISBNs are what imports and box sets go by:

| key    | meaning                                                                  |
|--------|--------------------------------------------------------------------------|
| `id`   | Audible ASIN, so re-imports recognise the book                           |
| `gr`   | Goodreads book id, the number in `goodreads.com/book/show/…` (`"4242"`), so re-imports recognise the book |
| `isbn` | list of this edition's ISBNs, always the 13-digit form without hyphens (`["9780000000002"]`). A single ISBN may be written as a plain string, with hyphens or as an ISBN-10; it is read as a list, and tidied to the 13-digit form when the page or `sync-export` saves |
| `n`    | narrator(s) of this edition                                              |
| `p`    | publisher                                                                |
| `d`    | release date (`"2021-05-04"`, `"2021-05"` or `"2021"`)                   |
| `len`  | length in whole minutes (`642`)                                          |
| `desc` | your own description of the edition, free text (`"UK edition"`, `"First edition"`, `"Dramatized adaptation"`, `"Audio CD"`) |

```json
{"t":"The Salt Road","a":"Marisol Quenby","s":"The Lantern Coast","sn":"1",
 "e":[{"id":"B0SAMPLE01","gr":"9001","isbn":["9780000000002"],"n":"Tobias Frane","p":"Gullwing Audio","d":"2019-04-02","len":642},
      {"id":"B0SAMPLE02","n":"Hollis Marr","desc":"UK edition"}]}
```

**Box sets**: an edition that holds several titles (a box set, an omnibus) is listed on each of those
titles, with the same ASIN, Goodreads id or ISBN; that shared identifier is what ties them together.
The page shows "Also in this edition: …" on each of them, and editing the edition on one updates it on
the others. `make validate` warns when the copies disagree. (A book you only have as a box set can still
be one record with a range such as `"sn": "2-3"`.)

**Older files**: before editions, a book held its `id`, `gr` and `isbn` itself, and its narrator (`n`)
until narrators moved to editions. Such books are still read: the ids become one edition (all its ISBNs
on it; split them in the edit form if they belong to different editions), and the narrator goes on each
edition that has none (on a new edition, for a book without any). `make validate` mentions it, and
`make format`, or any save from the page, an import or `sync-export`, writes them in the new shape.

`data/series-info.json` maps a series name (it must match `s` exactly) to
`{"total": 12, "status": "ongoing" | "complete", "note": "...", "url": "https://..."}`.
`total` is the number of books released so far; `url` (an author or publisher site) is optional.

`make validate` checks all of this and warns about suspicious entries.

## Everyday workflows

**Add new Audible purchases**

1. Export your library with the Audible Library Extractor and save the CSV in `data/raw/`.
2. `node catalog.js import-audible data/raw/<file>.csv --dry-run` to preview, then run it without `--dry-run`.
3. `make test`, then commit `data/books.json`.

Only finished books are imported. The command lists what it added, and anything ambiguous
(for example a book Audible files under several series). Each book gets its Audible edition: the ASIN,
the ISBNs, the narrators, the publisher, the release date and the length, as far as the export has them.

**Or import in the app**: on the *Import & export* page, press **Audible CSV** (or **Goodreads CSV**) and pick the export. The page
runs the same importer and merge as the command line (both use `importers.js`), honours
`data/excluded.txt`, and shows the same preview: what is already there, which Audible and Goodreads ids get filled
in, what is new and what needs a look. Nothing changes until you press **Add books**; then, like any
edit in the page, it is saved to `data/books.json` (see below).

**Edit in the app**

Edit books in the page (pencil icon, `+ Add a book`). *Editions* takes one edition per line, the way the
book card shows them: `UK edition; Narrated by Hollis Marr; ASIN B0SAMPLE01; Goodreads 4242;
ISBN 978-0-00-000000-2; Publisher Gullwing Audio; Released 2021-05; Length 10h 42m` (any of the parts;
hyphens and ISBN-10s are fine). Text without a label is the edition's description, so a line can be as
short as `Dramatized adaptation; Narrated by A full cast`. The narrator is on the edition too: the card
lists the narrators of all a book's editions, and each edition line names its own when they differ;
searching finds narrators and descriptions. To tie a box set to
its titles, give the edition the same ASIN (or Goodreads id) on each title: the details you typed on one
are copied to the others. On the card, an edition's ASIN links to the book on Audible (audible.com,
which sends you on to your own store) and its Goodreads id to the book on Goodreads. With `make serve` and your own `data/books.json`,
every change is saved to `data/books.json` and `data/series-info.json` as you make it. With any other
server, or the demo data, edits stay in the browser: press **Export** on the *Import & export* page, then:

```sh
node catalog.js sync-export ~/Downloads/audiobook-catalog-backup-2026-01-01.json --dry-run
node catalog.js sync-export ~/Downloads/audiobook-catalog-backup-2026-01-01.json
```

It refuses files that are not valid catalogue exports and prints what changed before writing.
An export holds the books, the series info and the list of books imports must skip
(`{"books": [...], "seriesInfo": {...}, "excluded": [...]}`), so `sync-export` updates
`data/series-info.json` too and adds any new entries to `data/excluded.txt` (it never removes one).
Backups from before series info was exported (a plain list of books), or before the exclusions were,
still work and leave those files as they are. The app's **Restore** reads all of them the same way,
adding the backup's exclusions to the ones it already has.
You can also edit `data/books.json` by hand; `make format` rewrites it the way the tools write it.

**Update release info for a series**: press the pencil next to a series (in the series overview or
above its books) to edit how many books are released, whether it is ongoing or complete, the note and
the author site, or to add or remove that info. The form checks the same rules as `make validate`.
Like book edits, the change is saved to `data/series-info.json`. Or edit
`data/series-info.json` by hand, then `make validate`.

**Find books missing from a series**: when a series has a released total in `data/series-info.json`,
the series overview and the series itself list the numbers you don't own (for example
"missing #3, #5–7"). A boxed set (`"4-6"`) counts for every number in it; a novella such as `"2.5"`
doesn't count for book 2. Pick **Series with missing books** in the series overview to see only
those series. Series whose total is `"many"`, or that have no release info, are left out.

**Remove a book for good**: press the &times; on the book (twice, to confirm). The page adds it to
the import exclusion list, `data/excluded.txt`, as the ASINs and Goodreads ids (`Goodreads 4242`) of its
editions, and as `Title | Author`, so no later Audible or Goodreads import brings it back. With
`make serve` that is saved to `data/excluded.txt` along with the removal; otherwise it goes into
**Export**, and `sync-export` adds it there. When editing `data/books.json` by hand, add the ASIN,
`Goodreads 4242` or `Title | Author` to `data/excluded.txt` yourself (a Goodreads id needs its `Goodreads`
prefix; a bare number is read as an ASIN). You can also exclude by ISBN: a line `ISBN 978-0-00-000000-2`
(or just the ISBN-13) skips every imported book that carries that ISBN, in any of its editions' forms (so
an ISBN shared by a boxed set skips all its books); a bare 10-character ISBN counts as both an ASIN and an ISBN.
Removing a book in the page does not add its ISBNs, since another book may share them. To let an import add a book again, delete its lines
from `data/excluded.txt`.

**Merge duplicates**: the *Duplicates* page (its link shows how many it found) lists books that look like
one title entered twice, found the way an import matches books (same author, series and number,
or same author and title, forgiving Audible's long titles); books that only share a box set's edition
are not duplicates. For each pair, pick the title, author and series to keep where they
differ; genres, dates read and editions are combined (an edition with the same ASIN, Goodreads id or ISBN
as one already kept fills it in). **Merge into one** keeps a single book and removes the others, without
adding them to `data/excluded.txt`, since the kept book carries their ids and imports find it. **Not
duplicates** stops offering that pair in this browser. To merge two books the list misses (say, an
author spelled two ways), press &#8644; on one book in the catalogue and then on the other; the
duplicates page opens with the two. Like any edit, a merge is saved to `data/books.json`.

When the merged entries' editions don't disagree on an ASIN or Goodreads id (typically one book
imported from Audible with its ASIN and from Goodreads with its Goodreads id), they become one edition
with both ids; untick *Make the editions one edition* to keep them separate. Where they disagree on a
detail such as the length, the first entry's value is kept. A box set's shared edition is never
joined this way. Books merged before this, or that got two such editions some other way, are listed
under *Editions that look like one*: **Make one edition** joins them, **Keep separate** stops
listing that book in this browser. The *Duplicates* link counts both.

**ISBNs**: both importers store the ISBNs in the export (Audible Library Extractor's `ISBN10` and `ISBN13` columns,
Goodreads' `ISBN` and `ISBN13`) on the edition they import. Edit them in the page under *Editions*
(`ISBN 978-0-00-000000-2, 0-306-40615-2`; stored as ISBN-13). The same ISBN may be on several books, e.g. each
book of a boxed set. Searching the library for an ISBN, typed any way, finds the books that carry it;
searching for an ASIN, a Goodreads id or a publisher works too.

**Keep track of when you read a book**: edit the book in the page and fill in *Date(s) read*
(`2024-03-15`, or `2024-03` / `2024` if you don't remember the day; several dates, comma separated,
for a re-read), or press **+ Read today**. The date shows on the book, and in **All Books** the
*Read in* filter picks the books read in a given year, or those with no date yet. A Goodreads import
fills in its *Date Read* on books that have no dates yet (Goodreads keeps only the latest one); it never
changes dates you already have. Audible imports do not set dates read.

**Goodreads**: `node catalog.js import-goodreads data/raw/goodreads_library_export.csv`, or
**Goodreads CSV** in the app. Goodreads has no "audiobook" flag, so books are picked by edition (Audible Audio, Audiobook, Audio CD,
MP3...) and the *read* shelf. The edition's narrator comes from the "Additional Authors" column, which is a guess
(it never replaces a narrator you already have).
Each book keeps Goodreads' *Book Id* as its edition's `gr`, with the edition's *Publisher* and *Year Published*,
so a later export still finds it after you rename it; books already in the catalogue get their Goodreads id
filled in the first time an export matches them. Goodreads puts the series in the title, as
`The First Adventure (Fantasy Adventures, #1)` or `The First Adventure: Fantasy Adventures, Book 1`; both
become the title `The First Adventure` in series `Fantasy Adventures`, number `1`.

Books imported before titles were split this way (or by hand) are split when the catalogue loads: a book with
no series gets the one in its title, and a book that already has that series just loses it from the title.
A book whose title names a different series or number than the one it has is left alone. `make validate`
says how many titles still hold their series, and `make format`, or any save, writes them split.

## Tidy names and spacing

Authors and narrators keep a space between initials (`A. B. Quill`, not `A.B. Quill`), so the filters
never list one person twice. Every text field also has stray spacing removed: runs of spaces, tabs,
non-breaking or invisible characters, and leading/trailing whitespace. Both importers and
`sync-export` apply this automatically (`tidyBook` in `importers.js`), and `make validate` warns
about any value that is not tidy. Capitalisation and quote styles are left alone.

## How imports avoid clobbering your edits

Imports only ever *add* books; an existing book is never overwritten. An incoming book counts as
already present if any of these match, strongest first:

1. the Audible `id` or Goodreads id (`gr`) of any of its editions
2. same first author + same series (spelling-insensitive: `Ember Coast` = `Ember Coast Series`) + same number
3. same author and title, also forgiving of the long Audible form: `A Crown of Embers 5: A Spark of Dawn`
   finds your `A Spark of Dawn`, and `X, Book 1` finds `X`. A boxed set is never mistaken for its first book.

The imported edition then goes into the match without replacing anything:
- if one of the match's editions has the same ASIN, Goodreads id or ISBN, that edition gets whatever it is
  missing (ASIN, Goodreads id, more ISBNs, publisher, release date, length), and so do its copies on a box set's other titles;
- otherwise, if the match has a single edition of its own that does not have a different ASIN or Goodreads id,
  that edition is filled in the same way (so a Goodreads export finds and completes the edition an Audible import made);
- otherwise it is added as another edition of the book.

Dates read are filled in when the match has none. So later imports keep matching even after more edits.
ISBNs are *not* used to decide that two books are the same, because one ISBN can belong to several books (a boxed set):
an incoming book whose ISBN is already on another book is still added if nothing else matches. New books get the series spelling already in use. If Audible lists a book under
several series, a parent series wins over its sub-series (`Thornmere` over `Thornmere: Wardens`);
otherwise the first is used and the book is flagged in the import output.

## Running the app and saving edits

The page loads its data with `fetch`, which browsers block for pages opened straight from disk
(`file://`), so serve the project folder: `make serve` (it listens on 127.0.0.1 only, since the folder
holds your personal data). Any static web server pointed at the project root works too. The app uses
`data/books.json` and `data/series-info.json`, or `data/sample/` if you have no `data/books.json`;
`--data-dir` and `CATALOG_DATA_DIR` only affect the command line tools, not the page.

`make serve` also saves: every edit in the pages (books, series info, CSV imports, **Restore** of a
backup, merges) is sent to the server, which checks it like `sync-export` does (the same validation and
tidying) and writes `data/books.json` and `data/series-info.json`, and adds books removed in the page
to `data/excluded.txt` (that file is only ever added to). It only accepts saves from the page
it serves, only to your own `data/books.json` (never the demo), and refuses a save if either file changed
on disk since the page loaded it (an import, a `sync-export`, a hand edit), so it never overwrites
those; reload the page to pick them up. A refused or failed save (for example with the server stopped)
says so under the buttons.

Until the disk has them, edits also live in that browser's `localStorage`, and with any other static
server they only live there: use **Export** and `sync-export`. **Export / Restore** JSON also make real
backups (books, series info and the import exclusion list). Local edits are tagged with a fingerprint of the `books.json` and
`series-info.json` they were made against. When either changes, older local edits are **set aside**
(kept under the `audiobook-catalog-data.backup` key) instead of silently hiding your new data; if they
still match on the next load, `make serve` saves them then.

All pages share those edits, so moving between them keeps your work. If two tabs edit the catalogue
at once, the one that saves second refuses and asks you to reload it, rather than overwriting the other.

## Development

- `make test` runs `node --test tests/*.test.mjs`: the importers (`importers.test.mjs`), the command
  line and the save endpoint of `serve` (`cli.test.mjs`), checks on the data files (`data.test.mjs`) and the browser smoke test
  (`app.smoke.test.mjs`), which executes each page's real scripts against a small fake DOM built from
  its HTML, with a fake `fetch` serving the demo data.
- `.github/workflows/ci.yml` runs the same on GitHub Actions.

## Privacy

This repository is meant to be public, so nothing personal is tracked:

- `data/books.json`, `data/series-info.json`, `data/excluded.txt` and `data/raw/*` are in
  `.gitignore`. `tests/data.test.mjs` fails if any of them stops being ignored or a
  file under `data/` other than the demo data becomes tracked.
- The demo data and every example in the tests and docs are invented.
- The consequence: **git does not back up your catalogue.** Keep your own copy: use the app's
  **Export** button, copy the `data/` files somewhere safe, or keep them in a separate *private*
  repository and point the tools at it with `--data-dir ~/my-catalogue-data` (or the
  `CATALOG_DATA_DIR` environment variable).

If you ever commit personal data by mistake, deleting it in a later commit is not enough: it stays
in history. Rewrite the history (or start the repository afresh) before pushing.

## Known data quirks

`make validate` may warn about entries carried over from an Audible export, for example a series
name such as `Some Series (book ), Other Series` when Audible lists several series for one book, or
`∞` as a series number. Fix them with the edit form or in `data/books.json`.
