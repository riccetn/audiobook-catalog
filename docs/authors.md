# Authors

The *Authors* page lists every author in the catalog, with how many of their books and series you
have; the search box narrows the list by name. Click an author (or an author's name on a book in the
catalog) to open their page. Its address names the author by the id the catalog keeps for them, which stays the
same when you correct the name; an address with the name, `authors.html#a=Marisol+Quenby`, opens the same page:

- a short bio, if you wrote one;
- links to their own website and their author pages on Audible, Goodreads, Hardcover, Open Library, ISFDB,
  BookBrainz and Wikidata, if you added them;
- their series, each with how many books you own (of the released total, when the series has release
  info), the numbers none of their books has (*missing #5–6*), and its books in order;
- their books outside a series.

The series and titles come from the books: a book is listed for each of its authors, so a book
written by two authors is on both pages, with a link to the other one. Each title and series links back
to it in the catalog.

**Add or edit the bio and links**: press **Edit** at the end of the author's page, after their books. The bio keeps its
paragraphs (leave a blank line between them). The website must start with `https://` (or `http://`).
The Audible, Amazon, Goodreads, Hardcover, Open Library, ISFDB, BookBrainz and Wikidata fields keep the author's id there: type it, or paste the
address of their page from the browser's address bar (`https://www.audible.co.uk/author/Name/B0...` on any
Audible store, `https://www.amazon.com/stores/author/B0...`, `https://www.goodreads.com/author/show/1234...`,
`https://hardcover.app/authors/name` (Hardcover is asked for the author's number, see [Hardcover](hardcover.md)), `https://openlibrary.org/authors/OL789A`, `https://www.isfdb.org/cgi-bin/ea.cgi?77`,
`https://www.wikidata.org/wiki/Q1001`, ...) and the id is read from it. A bare id in the Audible or Amazon field is
audible.com's or amazon.com's; for another store, paste the address, and the field shows it that way. The
form refuses what is neither an id nor an address there (a Hardcover address in the Goodreads field, say).
Clearing every field, or **Remove info**, removes the entry. Like every edit, the change is saved in the browser (see [Running the app and keeping your catalog](saving.md)).

The info is kept by the author's name exactly as the books write it. If you rename an author on their
books, their entry stays under the old name: **Check** warns that it matches no author; copy the bio and
links to the new name and remove the old entry. See [Data format](data-format.md#authors) for how it is kept.
