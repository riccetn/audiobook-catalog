# Authors

The *Authors* page lists every author in the catalogue, with how many of their books and series you
have; the search box narrows the list by name. Click an author (or an author's name on a book in the
catalogue) to open their page, `authors.html#a=Marisol+Quenby`:

- a short bio, if you wrote one;
- links to their own website and their author pages on Audible, Goodreads and Hardcover, if you added them;
- their series, each with how many books you own (of the released total, when the series has release
  info) and its books in order;
- their books outside a series.

The series and titles come from `data/books.json`: a book is listed for each of its authors, so a book
written by two authors is on both pages, with a link to the other one. Each title and series links back
to it in the catalogue.

**Add or edit the bio and links**: press the pencil next to the author's name. The bio keeps its
paragraphs (leave a blank line between them). Paste each link from the browser's address bar, for
example `https://www.audible.com/author/...` (any Audible store), `https://www.goodreads.com/author/show/...`
and `https://hardcover.app/authors/...`; the form refuses an address that doesn't start with `https://`
(or `http://`), or that is on another site than its field says. Clearing every field, or **Remove info**,
removes the entry. Like every edit, the change is saved to `data/authors.json` with `make serve`; otherwise
it stays in the browser until you **Export** and run `sync-export` (see [Everyday workflows](workflows.md)).

The info is kept by the author's name exactly as the books write it. If you rename an author on their
books, their entry stays under the old name: `make validate` warns that it matches no author, and you can
rename the key in `data/authors.json` by hand. See [Data format](data-format.md#authors) for the file.
