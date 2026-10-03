# Everyday workflows

**Add new Audible purchases**

1. Export your library with the Audible Library Extractor and save the CSV in `data/raw/`.
2. `node catalog.js import-audible data/raw/<file>.csv --dry-run` to preview, then run it without `--dry-run`.
   Add `--series` (and `--store uk` etc. if needed) to also fill in the new books' series and the release
   info of series new to the catalogue from Audible, as **Fill in series from Audible** below does for the
   whole catalogue.
3. `make test`, then commit `data/books.json`.

Only finished books are imported. The command lists what it added, and anything ambiguous
(for example a book Audible files under several series). Each book gets its Audible edition: the ASIN,
the ISBNs, the narrators, the publisher, the release date and the length, as far as the export has them.

**Or import in the app**: on the *Import & export* page, press **Audible CSV** (or **Goodreads CSV**) and pick the export. The page
runs the same importer and merge as the command line (both use `importers.js`), honours
`data/excluded.txt`, and shows the same preview: what is already there, which Audible and Goodreads ids get filled
in, what is new and what needs a look. Nothing changes until you press **Add books**; then, like any
edit in the page, it is saved to `data/books.json` (see [Running the app and saving edits](saving.md)).

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

**Fill in series from Audible**: `node catalog.js series --dry-run` looks up your books on Audible by
their ASIN and shows what it would fill in; run it without `--dry-run` to save it. A book with no series
gets Audible's series and number (spelled the way your other books spell that series), a book with a
series but no number gets the number, and a series with no release info gets the number of books Audible
has out as its total, marked `ongoing` with a note, because Audible can't tell whether a series is finished:
check it and change it to `complete` in the series form. Nothing you have is ever changed. A box set's ASIN
gives its titles the series but not a number (the number would be the set's). Books without an ASIN (only
from Goodreads) are not looked up. It asks audible.com; `--store uk` (or `de`, `fr`, `ca`, `au`, ...)
asks another store, for books the first one doesn't know. It needs the internet and uses Audible's own
catalogue API, which needs no account but isn't an official public API, so it could stop working.

**Or in the app**: with `make serve` running, the *Import & export* page has **Fill in series from
Audible**. Pick the store and press **Look up series**; the server asks Audible (a browser may not), and the
page shows what would be filled in, the same way the command does. Nothing changes until you press
**Save series**; then it is saved like any other edit. The panel only shows when the page is served by
`make serve`.
The page can also do it after every Audible CSV import: tick **After an Audible import, look up the new
books' series on Audible** under the import buttons (this browser remembers it). After **Add books**, it
looks up just the new books and shows their series to confirm.

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

**Link to a series, a book or a search**: the address after the `#` says what the catalogue shows, so
you can bookmark it, share it with yourself or reload it: `index.html#series=The+Lantern+Coast` (a series,
from its name in the overview), `#standalone`, `#book=The+Salt+Road` (a book's title on its card links
here, as do the other titles of a box set), `#books` (all books), and the search and filters on top:
`#books&q=quenby&genre=Fantasy&read=2023` (`read=undated` for books with no date read), or
`#q=coast&missing` in the series overview. The browser's back and forward buttons step through what
you looked at: each series, book, view and filter you pick is one step, and so is a search, however
many letters you type. Ctrl- or middle-click a series or book to open it in a new tab.

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

**Export to Goodreads**: `node catalog.js export-goodreads goodreads.csv` (or **Goodreads CSV** under
*Export to Goodreads* on the *Import & export* page) writes the catalogue as a Goodreads library export,
the format Goodreads' [import page](https://www.goodreads.com/review/import) takes. Every book goes on the
*read* shelf, also those with no date read (a missing date means unknown, not unread), with the series in
the title (`The First Adventure (Fantasy Adventures, #1)`), the first author as *Author* and the rest as
*Additional Authors*, its genres as shelves (`Science Fiction` becomes `science-fiction`), and how many
dates read it has as *Read Count*. Goodreads keeps one date read, so a book gets its latest full date
(`2024-03-15` becomes `2024/03/15`); one read only in `2024-03` or `2024` goes without. Goodreads finds a
book by the *Book Id* and ISBN of one of its editions (preferring one with both), else by title and
author; a box set's edition, shared with its other titles, is left out so Goodreads doesn't file each
title as the box set. The command says how many books have no id or ISBN and how many no full date.
Our own Goodreads import reads the file back.

Books imported before titles were split this way (or by hand) are split when the catalogue loads: a book with
no series gets the one in its title, and a book that already has that series just loses it from the title.
A book whose title names a different series or number than the one it has is left alone. `make validate`
says how many titles still hold their series, and `make format`, or any save, writes them split.
