# Everyday workflows

**Add new Audible purchases or Goodreads books**: see [Audible](audible.md) and [Goodreads](goodreads.md).

**Edit in the app**

Edit books in the page (pencil icon, `+ Add a book`). The pencil opens the form in place of the book's card in the
list; `+ Add a book` opens it at the top. *Editions* has a card per edition, with a field for each part: description, narrators, ASINs (a field per
site: audible.com's, and one for each site the edition has an ASIN on; *+ Another site* adds a field for
another Amazon or Audible site, and the address of the book's page there works too), Goodreads id,
Hardcover edition (its id, or just the address of the edition's page on Hardcover,
`https://hardcover.app/books/the-salt-road/editions/501`), ISBN (hyphens and ISBN-10s are fine), publisher,
release date (`2021-05`) and length (`10h 42m`). Leave a field empty when you don't know it; `+ Add an edition`
adds a card and *Remove* drops one. A card that is an edition of a box set says which other books it is on,
since a change to it changes it there too. A field the page can't read is named when you save, and nothing changes.
The Hardcover book has its own field, which takes the book's id or, since the Hardcover app doesn't show
it, the address of the book's page (`https://hardcover.app/books/the-salt-road`) or of one of its editions'
pages: the page looks the book up on Hardcover and puts its id in the field (when you leave the field, or
when you save). That needs your Hardcover API token, saved on the *Import & export* page (see
[Hardcover](hardcover.md)). Several authors, or several narrators of an
edition, are written separated by commas (`Ann Vale, Bo Reed`); each is its own entry in the author
filter. The narrator is on the edition too: the card
lists the narrators of all a book's editions, and each edition line names its own when they differ;
searching finds narrators and descriptions. To tie a box set to
its titles, give the edition the same ASIN (or Goodreads or Hardcover id) on each title: the details you typed on one
are copied to the others. On the card, each of an edition's ASINs links to the book on its site
(`audible.co.uk/pd/…`, `amazon.com/dp/…`), its Goodreads id to the book on Goodreads, and its Hardcover ids
to the edition and the book on Hardcover (`hardcover.app/id/edition/501`, an address that keeps working
when Hardcover renames the book). With `make serve` and your own `data/books.json`,
every change is saved to `data/books.json`, `data/series-info.json` and `data/authors.json` as you make it. With any other
server, or the demo data, edits stay in the browser: press **Export** on the *Import & export* page, then:

```sh
node catalog.js sync-export ~/Downloads/audiobook-catalog-backup-2026-01-01.json --dry-run
node catalog.js sync-export ~/Downloads/audiobook-catalog-backup-2026-01-01.json
```

It refuses files that are not valid catalogue exports and prints what changed before writing.
An export holds the books, the series info, the author info, the list of books imports must skip and the pairs marked
**Not duplicates** (`{"books": [...], "seriesInfo": {...}, "authors": {...}, "excluded": [...], "notDuplicates": [...]}`),
so `sync-export` updates `data/series-info.json` and `data/authors.json` too and adds any new entries to `data/excluded.txt` and
`data/not-duplicates.txt` (it never removes one).
Backups from before series info was exported (a plain list of books), or before the author info or the exclusions were,
still work and leave those files as they are. The app's **Restore** reads all of them the same way,
adding the backup's exclusions and **Not duplicates** marks to the ones it already has.

When both catalogues have changed, merge the backup instead: see
[Merge a backup from another device](backups.md).
You can also edit `data/books.json` by hand; `make format` rewrites it the way the tools write it.

**Check the catalogue**: **Check** on the *Import & export* page lists the errors and warnings `make validate`
would, and the data files still in an older format or layout; under `make serve` its **Rewrite data files**
does what `make format` does.

**Authors' bios and links**: the *Authors* page lists every author; each author's page shows a bio,
links to their website and their pages on Audible, Goodreads and Hardcover, and their series and titles.
Author names on the books link there. See [Authors](authors.md).

**Update release info for a series**: press the pencil next to a series (in the series overview or
above its books) to edit how many books are released, whether it is ongoing or complete, the note and
the author site, or to add or remove that info. The form checks the same rules as `make validate`.
Like book edits, the change is saved to `data/series-info.json`.
The same form renames the series: change its name and every book in the series gets the new name
(a series without info is renamed without adding any). Renaming it to a series you already have
moves its books into that one; the first **Save** says so and the second does it, and if the form has
info it replaces the other series' info. Or edit
`data/series-info.json` by hand, then `make validate`.

**Find books missing from a series**: when a series has a released total in `data/series-info.json`,
the series overview and the series itself list the numbers you don't own (for example
"missing #3, #5–7"). A boxed set (`"4-6"`) counts for every number in it, but not as one more book owned; a
novella such as `"2.5"` doesn't count for book 2. Pick **Series with missing books** in the series overview to see only
those series. Series whose total is `"many"`, or that have no release info, are left out.

**Fill in series from Audible**: see [Audible](audible.md#fill-in-series-from-audible).

**Remove a book for good**: press the &times; on the book (twice, to confirm). The page adds it to
the import exclusion list, `data/excluded.txt`, as the ASINs, Goodreads ids (`Goodreads 4242`) and Hardcover
ids (`Hardcover 501`) of its editions, and as `Title | Author`, so no later Audible, Goodreads or Hardcover
import brings it back. With
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
duplicates** stops offering that pair. To merge two books the list misses (say, an
author spelled two ways), press &#8644; on one book in the catalogue and then on the other; the
duplicates page opens with the two. Like any edit, a merge is saved to `data/books.json`.

When the merged entries' editions don't disagree on an ASIN or Goodreads id (typically one book
imported from Audible with its ASIN and from Goodreads with its Goodreads id), they become one edition
with both ids; untick *Make the editions one edition* to keep them separate. Where they disagree on a
detail such as the length, the first entry's value is kept. A box set's shared edition is never
joined this way. Books merged before this, or that got two such editions some other way, are listed
under *Editions that look like one*: **Make one edition** joins them, **Keep separate** stops
listing that book. The *Duplicates* link counts both.

Both marks are kept in the browser, and with `make serve` also in `data/not-duplicates.txt`, so
other browsers see them too; a mark made without `make serve` is added to the file the next time
the page saves there. Like `data/excluded.txt`, the file is only ever added to: delete a line by
hand to have that pair offered again. Backups carry the marks as well.

**ISBNs**: both importers store the ISBN in the export (Audible Library Extractor's `ISBN10` and `ISBN13` columns,
Goodreads' `ISBN` and `ISBN13`) on the edition they import. An edition has one ISBN: two different ISBNs are two
editions, so a second one becomes an edition of its own. Edit them in the page under *Editions*
(`978-0-00-000000-2`, or `0-306-40615-2`; stored as ISBN-13; several ISBNs in one card's field are that many editions). The same ISBN may be on several books, e.g. each
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

**Goodreads**: import from and export to Goodreads; see [Goodreads](goodreads.md).

**Hardcover**: import from, export to and sync with your Hardcover shelves; see [Hardcover](hardcover.md).
