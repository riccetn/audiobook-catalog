# Authors

The *Authors* page lists every author in the catalog, with how many of their books and series you
have; the search box narrows the list by name. Click an author (or an author's name on a book in the
catalog) to open their page (`author.html`). Its address names the author by the id the catalog keeps for them, which stays the
same when you correct the name; an address with the name, `author.html#a=Marisol+Quenby`, opens the same page,
and so do the addresses from when the list showed each author too (`authors.html#a=…`). Their page has:

- a short bio, if you wrote one;
- links to their own website and their author pages on Audible, Goodreads, Hardcover, AudiobookDB, Open Library, ISFDB,
  BookBrainz and Wikidata, if you added them;
- their series, each with how many books you own (of the released total, when the series has release
  info), the numbers none of their books has (*missing #5–6*), and its books in order;
- their books outside a series.

The series and titles come from the books: a book is listed for each of its authors, so a book
written by two authors is on both pages, with a link to the other one. Each title and series links back
to it in the catalog.

**Add or edit the bio and links**: press **Edit** at the end of the author's page, after their books. The bio keeps its
paragraphs (leave a blank line between them). The website must start with `https://` (or `http://`).
The Audible, Amazon, Goodreads, Hardcover, AudiobookDB, Open Library, ISFDB, BookBrainz and Wikidata fields keep the author's id there: type it, or paste the
address of their page from the browser's address bar (`https://www.audible.co.uk/author/Name/B0...` on any
Audible store, `https://www.amazon.com/stores/author/B0...`, `https://www.goodreads.com/author/show/1234...`,
`https://hardcover.app/authors/name` (Hardcover is asked for the author's number, see [Hardcover](hardcover.md)), `https://audiobookdb.org/people/GRNdEqe6PKeT`, `https://openlibrary.org/authors/OL789A`, `https://www.isfdb.org/cgi-bin/ea.cgi?77`,
`https://www.wikidata.org/wiki/Q1001`, ...) and the id is read from it: when you leave the field it shows just the id, and
an address pasted into another catalog's field moves to that one's (when it is empty). A bare id in the Audible or Amazon field is
audible.com's or amazon.com's; for another store, paste the address, and the field keeps it as an address (without the name in it). The
form refuses what is neither an id nor an address there (a Hardcover address in the Goodreads field, say).
Clearing every field keeps nothing about them; the author stays. Like every edit, the change is saved in the browser (see [Running the app and keeping your catalog](saving.md)).

An author is an entry of their own, under the name exactly as the books write it: they stay in the catalog,
and on *Authors* ("no books yet"), when no book names them any more, until you remove them. The book form
says when a name you type is new (see [Everyday workflows](workflows.md#editing)).

**Rename an author**: change the **Name** in the form and save; every book that credits them gets the new
name, and they keep their bio, links and page (its address follows). Narrators and publishers are renamed the
same way, on the editions they read or publish. An author's or narrator's name can't hold a comma, a semicolon,
`&` or `and`, which the book form reads as between names. Renaming them to someone the catalog already has
joins the two, which is how to tidy up one person kept under two spellings: the first Save says so, the second
does it. Every book of either then credits the one name, which keeps what the form has and, where the form is
empty, what the other had (their ids in other catalogs and their other links are put together).

**Remove an author**: **Remove author** in the form takes them off every book and removes them. The first
press says how many books it changes, the second does it. An author who is the only author of a book can't
be removed, as a book needs an author: the form names those books, so you can give them another author
first (or remove them). See [Data format](data-format.md#authors) for how it is kept.
