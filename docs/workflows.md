# Everyday workflows

**Add new Audible purchases or Goodreads books**: see [Audible](audible.md) and [Goodreads](goodreads.md).

**The pages**: *Series* (`index.html`) lists every series; a series' name opens its page, with its books in order
and its info (**Edit** at the end). *Books* (`books.html`) lists every book, 50 at a time, with the search,
filters and order. A book's title, anywhere, opens its own page (`book.html`).

**A book's card and its page**: a book's card in a list shows only its title, series number, authors,
narrators and dates read. Its title opens the book's page (`book.html#book=…`): its series and number, dates read,
genres, its ids in external catalogs, and each of its editions with every part (description, narrators,
ASINs, other catalogs' ids, ISBN, publisher, release date, length, and the other books of a box set it is on).
Above it, the crumb links back to the book's series. The card has no buttons; the page ends with **Edit**
and **Merge**. In the book form (**Edit**) the book's ids in other catalogs are
folded under *The book in other catalogs*, which names the catalogs it has one in.

**Covers**: a book's card shows a small cover, and its details a larger one. Nothing is stored for it: the
page asks for the cover by the ids the book's editions already have, first Amazon's image of each ASIN (an
audiobook's square cover), then Open Library's of the edition's Open Library id and of its ISBN, and shows the first
that loads. A book whose editions have none of those, or that neither site has a cover for, shows none.
Asking tells Amazon and Open Library those ids, so *Covers* (next to *+ Add a book* on *Series* and *Books*) turns them off; the choice
is kept in this browser. Firefox's strict tracking protection blocks Amazon's images; the cover then comes
from Open Library when it has one.

**Edit in the app**

Edit books in the page (**Edit** at the end of a book's page, `+ Add a book`). **Edit** opens the form in place of the book's
details. `+ Add a book`, on *Books* and on a series' page, opens the form for a new book on a page of its own
(`book.html#add`), with the series and author filled in from where you were: the series you were looking at,
and the author picked in the author filter (else the author of every book in the series). Saving shows the new
book's page; *Cancel* goes back to the series or the books.

*Fill in from another catalog*, at the top of the form, looks a book up and fills in the form's empty fields
(nothing you typed is replaced): paste the address of its page and press *Fill in* (or Enter). These work
without an account, as their catalogs let a web page read them: an Open Library work or edition
(`https://openlibrary.org/books/OL…M`, or the bare `OL…M`/`OL…W`), a Wikidata item (`Q…`), or an ISBN, which is
looked up on Open Library. With your Hardcover API token saved (see [Hardcover](hardcover.md)), Hardcover is
asked too: a book's or edition's page on hardcover.app, and the pages Hardcover knows the ids of, an Audible or
Amazon page (by its ASIN) and a Goodreads edition (`goodreads.com/book/show/…`); an ISBN is looked up there
first, and an Open Library edition's ISBN or ASIN is looked up there for the narrators and length Open Library
doesn't have. Audible, Amazon, Goodreads and AudiobookDB can't be read from a web page themselves, so without the
token their addresses can't be looked up, unless you have a [catalog proxy](catalog-proxy.md) saved. With the proxy,
an Audible or Amazon page (or a bare ASIN) is looked up on that Audible site's catalog (an Amazon site on its Audible
site, else audible.com) and on AudiobookDB; an AudiobookDB book or release (`audiobookdb.org/releases/…`) is looked
up there (a book of several releases comes without an edition: paste your release's address); and an edition found
elsewhere with an ASIN is looked up on Audible for what it lacks. Hardcover is still asked for what those lack. It fills in the title, authors, series and number, genres (from Wikidata, Audible and AudiobookDB), the
book's ids in those catalogs, and an edition (narrators, ASIN, Goodreads, Hardcover, Open Library and AudiobookDB ids, ISBN,
publisher, release date, length): in the gaps of the card that is the same edition (it has one of its ids, an
ASIN on any site, or its ISBN), else of the first card that has nothing else in its fields, else on a card of its own. The status line says what was filled in and from where; look it over before saving. It is in
the form while editing a book too, where it fills in only what the book lacks.

*Editions* has a card per edition, with a field for each part: description, narrators, ASINs (a field per
site: audible.com's, and one for each site the edition has an ASIN on; *+ Another site* adds a field for
another Amazon or Audible site), Goodreads id, Hardcover edition (*+ Another catalog* adds a field for its id on AudiobookDB, Open
Library, ISFDB or BookBrainz, shown from then on), ISBN (hyphens and ISBN-10s are fine), publisher,
release date (`2021-05`) and length (`10h 42m`). The ASIN and other catalogs' edition fields also take the address of the book's
page on that site (`https://www.audible.co.uk/pd/The-Salt-Road-Audiobook/B0…`, `https://www.amazon.com/dp/B0…`,
`https://www.goodreads.com/book/show/4242-the-salt-road`, `https://hardcover.app/books/the-salt-road/editions/501`,
`https://audiobookdb.org/releases/Kx7UDyK3gMqj`):
when you leave the field it shows just the id, and an Audible or Amazon page's ASIN moves to the field for
its site, and another catalog's id to its field (added when the card has none). Leave a field empty when you don't know it; `+ Add an edition`
adds a card and *Remove* drops one. A card that is an edition of a box set says which other books it is on,
since a change to it changes it there too. A field the page can't read is named when you save, and nothing changes.
The Hardcover book has its own field, which takes the book's id or, since the Hardcover app doesn't show
it, the address of the book's page (`https://hardcover.app/books/the-salt-road`) or of one of its editions'
pages: the page looks the book up on Hardcover and puts its id in the field (when you leave the field, or
when you save). That needs your Hardcover API token, saved on the *Import & export* page (see
[Hardcover](hardcover.md)). The Goodreads book field takes the id of the book's work on Goodreads (all its
editions), or the address of its page (`https://www.goodreads.com/work/editions/99`); the AudiobookDB, Open Library, ISFDB, BookBrainz and
Wikidata book fields likewise take the id of the book's work (title, item) there or its page's address. Several authors, or several narrators of an
edition, are written separated by commas (`Ann Vale, Bo Reed`); each is its own entry in the author
filter. As you type an author, a narrator or a publisher, the field lists the names the catalog already has that
match the name you are typing (those starting with it first): click one, or pick it with the arrow keys and Enter,
and it takes the place of what you typed (Escape closes the list); the series field does the same. A new name is simply
typed out, and the field says so below it ("New author: ..., added to the catalog when this is saved"): saving
adds it as an author (series, narrator, publisher) of its own, and the status line names what was new. The narrator is on the edition too: the card
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
untidy name, a link to the wrong site...).

**Authors' bios and links**: the *Authors* page lists every author; each author's page (`author.html`) shows a bio,
links to their website and their pages on Audible, Goodreads, Hardcover and the other catalogs, and their series and titles.
Author names on the books link there. See [Authors](authors.md).

**Narrators and publishers**: the *Narrators* and *Publishers* pages list everyone named on the editions,
each with a page of their bio, links, series and titles; their names on the books link there. See
[Narrators and publishers](narrators-publishers.md).

**Update release info for a series**: press **Edit** at the end of a series' page (open it from *Series*) to edit how many books are released, whether it is ongoing or complete, the note and
the series' ids on Audible, Goodreads, Hardcover, AudiobookDB, ISFDB, BookBrainz and Wikidata (the id, or the address of the series'
page there, `https://www.audible.com/series/…/B0…`, `https://www.goodreads.com/series/90001`,
`https://hardcover.app/series/the-lantern-coast`, which Hardcover is asked to turn into the series' number; the series links to each).
Every field is optional, and clearing them all keeps nothing about the series. The form checks the same rules as **Check**.
The same form renames the series: change its name and every book in the series gets the new name.
Renaming it to a series you already have moves its books into that one; the first **Save** says so and
the second does it, and what the form has replaces what the other series has.

A series is an entry of its own: it stays when no book is in it any more ("no books yet" on *Series*), until you
remove it. **Remove series** in its form takes it off its books, which stay in the catalog without a series
or a number in it, and removes it; the first press says how many books it changes, the second does it.

**Find books missing from a series**: when a series has a released total,
the *Series* page and the series' own page list the numbers you don't own (for example
"missing #3, #5–7"). A boxed set (`"4-6"`) counts for every number in it, but not as one more book owned; a
novella such as `"2.5"` doesn't count for book 2. Pick **Series with missing books** on *Series* to see only
those series. Series whose total is `"many"`, or that have no release info, are left out.

**Remove a book for good**: press **Edit** on the book's details, then **Remove book** in the form. It leaves the list at once, and the status line
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
are not duplicates. What the entries have alike is said once above them; for each pair, pick the title, author and series to keep where they
differ; genres, dates read and editions are combined (an edition with the same ASIN, Goodreads id or ISBN
as one already kept fills it in). **Merge into one** keeps a single book and removes the others, without
adding them to the exclusion list, since the kept book carries their ids and imports find it. **Not
duplicates** stops offering that pair. To merge two books the list misses (say, an
author spelled two ways), press **Merge** on one book's details and search for the other (by title, author,
series or ISBN, as the catalog's search does); picking it opens the duplicates page with the two.

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

**Link to a series, a book or a search**: the address after the `#` says what a page shows, so
you can bookmark it, share it with yourself or reload it: `index.html#series=…` (a series, from its name in the
list), `index.html#standalone`, `index.html#q=coast&missing` (the series searched, only those with gaps),
`book.html#book=…` (a book's page: its title on its card links here, as do the other titles of a
box set on theirs), and on *Books* the search, filters and order: `books.html#q=quenby&genre=Fantasy&read=2023`
(`read=undated` for books with no date read). The browser's back and forward buttons step through what
you looked at: each series, book and filter you pick is one step, and so is a search, however
many letters you type. A series or book is named in the address by the id the catalog keeps for it, so
the link still works after you retitle the book or rename the series; an address with the name or title
(`index.html#series=The+Lantern+Coast`, `book.html#book=The+Salt+Road`) opens it too, and so do the addresses from
when one page showed it all (`index.html#books…` opens *Books*, `index.html#book=…` the book's page). An author's,
a narrator's or a publisher's page is `author.html#a=…`, `narrator.html#n=…` or `publisher.html#p=…`; the addresses
from when their lists showed them too (`authors.html#a=…` and the like) open it as well.

**Keep track of when you read a book**: edit the book in the page and fill in *Date(s) read*
(`2024-03-15`, or `2024-03` / `2024` if you don't remember the day; several dates, comma separated,
for a re-read), or press **+ Read today** in the form. Quicker: open the book (its title) and press **+ Read today**
beside its dates read, which saves at once and offers **Undo** for a few seconds. The date shows on the book, and on **Books** the
*Read in* filter picks the books read in a given year, or those with no date yet. The order list beside the filters sorts
**Books** by *Recently read* (the latest date read first; books without one follow in series order) or *Recently added*
(the books an import or the form added last first) instead of by series; the address keeps it (`books.html#sort=read`). A Goodreads import
fills in its *Date Read* on books that have no dates yet (Goodreads keeps only the latest one); it never
changes dates you already have. Audible imports do not set dates read.

**Goodreads**: import from and export to Goodreads; see [Goodreads](goodreads.md).

**Hardcover**: compare the catalog with your Hardcover shelves, take books from them and put books and reads on them; see [Hardcover](hardcover.md).
