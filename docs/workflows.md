# Everyday workflows

**Add new Audible purchases or Goodreads books**: see [Audible](audible.md) and [Goodreads](goodreads.md).

**A book's card and its details**: a book's card in the list shows only its title, series number, authors,
narrators and dates read. Its title opens the book's details (`#book=…`): its series and number, dates read,
genres, its ids in external catalogs, and each of its editions with every part (description, narrators,
ASINs, other catalogs' ids, ISBN, publisher, release date, length, and the other books of a box set it is on).
The edit, merge and remove buttons are on both.

**Edit in the app**

Edit books in the page (pencil icon, `+ Add a book`). The pencil opens the form in place of the book's card in the
list; `+ Add a book` opens it at the top, with the series and author filled in from what the list shows: the
series you are looking at, and the author picked in the author filter (else the author of every book in the
series). *Editions* has a card per edition, with a field for each part: description, narrators, ASINs (a field per
site: audible.com's, and one for each site the edition has an ASIN on; *+ Another site* adds a field for
another Amazon or Audible site), Goodreads id, Hardcover edition (*+ Another catalog* adds a field for its id on Open
Library, ISFDB or BookBrainz, shown from then on), ISBN (hyphens and ISBN-10s are fine), publisher,
release date (`2021-05`) and length (`10h 42m`). The ASIN and other catalogs' edition fields also take the address of the book's
page on that site (`https://www.audible.co.uk/pd/The-Salt-Road-Audiobook/B0…`, `https://www.amazon.com/dp/B0…`,
`https://www.goodreads.com/book/show/4242-the-salt-road`, `https://hardcover.app/books/the-salt-road/editions/501`):
when you leave the field it shows just the id, and an Audible or Amazon page's ASIN moves to the field for
its site (added when the card has none). Leave a field empty when you don't know it; `+ Add an edition`
adds a card and *Remove* drops one. A card that is an edition of a box set says which other books it is on,
since a change to it changes it there too. A field the page can't read is named when you save, and nothing changes.
The Hardcover book has its own field, which takes the book's id or, since the Hardcover app doesn't show
it, the address of the book's page (`https://hardcover.app/books/the-salt-road`) or of one of its editions'
pages: the page looks the book up on Hardcover and puts its id in the field (when you leave the field, or
when you save). That needs your Hardcover API token, saved on the *Import & export* page (see
[Hardcover](hardcover.md)). The Goodreads book field takes the id of the book's work on Goodreads (all its
editions), or the address of its page (`https://www.goodreads.com/work/editions/99`); the Open Library, ISFDB, BookBrainz and
Wikidata book fields likewise take the id of the book's work (title, item) there or its page's address. Several authors, or several narrators of an
edition, are written separated by commas (`Ann Vale, Bo Reed`); each is its own entry in the author
filter. The narrator is on the edition too: the card
lists the narrators of all a book's editions, and the book's details name each edition's;
searching finds narrators and descriptions. To tie a box set to
its titles, give the edition the same ASIN (or Goodreads or Hardcover id) on each title: the details you typed on one
are copied to the others. In a book's details, each of an edition's ASINs links to the book on its site
(`audible.co.uk/pd/…`, `amazon.com/dp/…`), its Goodreads id to the book on Goodreads, and its Hardcover ids
to the edition and the book on Hardcover (`hardcover.app/id/edition/501`, an address that keeps working
when Hardcover renames the book). Every change is saved in the browser as you make it (see
[Running the app and keeping your catalog](saving.md)).

**Back up and move the catalog**: **Export** on the *Import & export* page downloads a backup with the
books, the series info, the author, narrator and publisher info, the list of books imports must skip and the pairs marked
**Not duplicates** (`{"books": [...], "seriesInfo": {...}, "authors": {...}, "narrators": {...}, "publishers": {...}, "excluded": [...], "notDuplicates": [...]}`).
**Restore** replaces the catalog with one. Backups from before series info was exported (a plain list of
books), or before the author info or the exclusions were, still work and keep what the catalog has; the
backup's exclusions and **Not duplicates** marks are added to the ones it already has. When both
catalogs have changed, merge the backup instead: see [Merge a backup from another device](backups.md).

**Check the catalog**: **Check** on the *Import & export* page lists errors and warnings (a series
info entry no book has, an untidy name, a link to the wrong site...).

**Authors' bios and links**: the *Authors* page lists every author; each author's page shows a bio,
links to their website and their pages on Audible, Goodreads, Hardcover and the other catalogs, and their series and titles.
Author names on the books link there. See [Authors](authors.md).

**Narrators and publishers**: the *Narrators* and *Publishers* pages list everyone named on the editions,
each with a page of their bio, links, series and titles; their names on the books link there. See
[Narrators and publishers](narrators-publishers.md).

**Update release info for a series**: press the pencil next to a series (in the series overview or
above its books) to edit how many books are released, whether it is ongoing or complete, the note and
the author site, the series' ids on Audible, Goodreads, Hardcover, ISFDB, BookBrainz and Wikidata (the id, or the address of the series'
page there, `https://www.audible.com/series/…/B0…`, `https://www.goodreads.com/series/90001`,
`https://hardcover.app/series/the-lantern-coast`, which Hardcover is asked to turn into the series' number; the series links to each), or to add or remove that info.
The form checks the same rules as **Check**.
The same form renames the series: change its name and every book in the series gets the new name
(a series without info is renamed without adding any). Renaming it to a series you already have
moves its books into that one; the first **Save** says so and the second does it, and if the form has
info it replaces the other series' info.

**Find books missing from a series**: when a series has a released total in its series info,
the series overview and the series itself list the numbers you don't own (for example
"missing #3, #5–7"). A boxed set (`"4-6"`) counts for every number in it, but not as one more book owned; a
novella such as `"2.5"` doesn't count for book 2. Pick **Series with missing books** in the series overview to see only
those series. Series whose total is `"many"`, or that have no release info, are left out.

**Remove a book for good**: press the &times; on the book. It leaves the list at once, and the status line
offers **Undo** for a few seconds; once that is gone (or you leave the page), the page takes it out and adds it to
the import exclusion list, as the ASINs, Goodreads ids (`Goodreads 4242`) and Hardcover
ids (`Hardcover 501`) of its editions, and as `Title | Author`, so no later Audible, Goodreads or Hardcover
import brings it back. Backups carry the list (`excluded`), one entry per line: an ASIN,
`Goodreads 4242` (a bare number is read as an ASIN), `Hardcover 501` or `Title | Author`. An entry
`ISBN 978-0-00-000000-2` (or just the ISBN-13) skips every imported book that carries that ISBN, in any of its editions' forms (so
an ISBN shared by a boxed set skips all its books); a bare 10-character ISBN counts as both an ASIN and an ISBN.
Removing a book in the page does not add its ISBNs, since another book may share them. The list is only
ever added to: to let an import add a book again, delete its entries from a backup's `excluded` and
restore it.

**Merge duplicates**: the *Duplicates* page (its link shows how many it found) lists books that look like
one title entered twice, found the way an import matches books (same author, series and number,
or same author and title, forgiving Audible's long titles); books that only share a box set's edition
are not duplicates. For each pair, pick the title, author and series to keep where they
differ; genres, dates read and editions are combined (an edition with the same ASIN, Goodreads id or ISBN
as one already kept fills it in). **Merge into one** keeps a single book and removes the others, without
adding them to the exclusion list, since the kept book carries their ids and imports find it. **Not
duplicates** stops offering that pair. To merge two books the list misses (say, an
author spelled two ways), press &#8644; on one book in the catalog and then on the other; the
duplicates page opens with the two.

When the merged entries' editions don't disagree on an ASIN or Goodreads id (typically one book
imported from Audible with its ASIN and from Goodreads with its Goodreads id), they become one edition
with both ids; untick *Make the editions one edition* to keep them separate. Where they disagree on a
detail such as the length, the first entry's value is kept. A box set's shared edition is never
joined this way. Books merged before this, or that got two such editions some other way, are listed
under *Editions that look like one*: **Make one edition** joins them, **Keep separate** stops
listing that book. The *Duplicates* link counts both.

Both marks are kept in the browser with the books they name, so they still hold after you retitle a
book; backups carry them by title and author (`notDuplicates`), so Restore and Merge bring them to
another browser. Like the exclusion list, they are only ever added to.

**ISBNs**: both importers store the ISBN in the export (Audible Library Extractor's `ISBN10` and `ISBN13` columns,
Goodreads' `ISBN` and `ISBN13`) on the edition they import. An edition has one ISBN: two different ISBNs are two
editions, so a second one becomes an edition of its own. Edit them in the page under *Editions*
(`978-0-00-000000-2`, or `0-306-40615-2`; stored as ISBN-13; several ISBNs in one card's field are that many editions). The same ISBN may be on several books, e.g. each
book of a boxed set. Searching the library for an ISBN, typed any way, finds the books that carry it;
searching for an ASIN, a Goodreads id or a publisher works too.

**Link to a series, a book or a search**: the address after the `#` says what the catalog shows, so
you can bookmark it, share it with yourself or reload it: `#series=…` (a series, from its name in the
overview), `#standalone`, `#book=…` (the book's details: its title on its card links here, as do the other titles of a
box set in their details), `#books` (all books), and the search and filters on top:
`#books&q=quenby&genre=Fantasy&read=2023` (`read=undated` for books with no date read), or
`#q=coast&missing` in the series overview. The browser's back and forward buttons step through what
you looked at: each series, book, view and filter you pick is one step, and so is a search, however
many letters you type. A series or book is named in the address by the id the catalog keeps for it, so
the link still works after you retitle the book or rename the series; an address with the name or title
(`index.html#series=The+Lantern+Coast`, `#book=The+Salt+Road`) opens it too. Ctrl- or middle-click a series or book to open it in a new tab.

**Keep track of when you read a book**: edit the book in the page and fill in *Date(s) read*
(`2024-03-15`, or `2024-03` / `2024` if you don't remember the day; several dates, comma separated,
for a re-read), or press **+ Read today** in the form. Quicker: open the book (its title) and press **+ Read today**
beside its dates read, which saves at once and offers **Undo** for a few seconds. The date shows on the book, and in **All Books** the
*Read in* filter picks the books read in a given year, or those with no date yet. A Goodreads import
fills in its *Date Read* on books that have no dates yet (Goodreads keeps only the latest one); it never
changes dates you already have. Audible imports do not set dates read.

**Goodreads**: import from and export to Goodreads; see [Goodreads](goodreads.md).

**Hardcover**: compare the catalog with your Hardcover shelves, take books from them and put books and reads on them; see [Hardcover](hardcover.md).
