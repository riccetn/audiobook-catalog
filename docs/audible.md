# Audible

## Add new Audible purchases

1. Export your library with the Audible Library Extractor.
2. On the _Import & export_ page, press **Import CSV** in the **Audible** panel and pick the export. For an export from another
   site than audible.com, pick the site beside the button first, so its ASINs are kept as that site's.
3. The page shows the export's books beside yours ([the comparison](imports.md#the-comparison)): what is
   new, what it would fill in on books you have, the values that differ, and what needs a look (for example
   a book Audible files under several series). Tick what to take; nothing changes until you press **Apply**,
   and then, like any edit, it is saved in the browser (see [Running the app and keeping your catalog](saving.md)).

Only finished books are imported, and books on the exclusion list are skipped. Each book gets its Audible
edition: the ASIN, the ISBNs, the narrators, the publisher, the release date and the length, as far as the
export has them.

## Fill in a series' books from Audible

Audible's catalog doesn't let a web page ask it about books, so it is asked through your
[server's catalog proxy](server.md); without one, set up on the _Import & export_ page, there is nothing to compare.
No Audible account is needed, and nothing is sent to Audible.

1. Press **Edit** at the end of a series' page (on _Series_): its _Edit series_ page asks Audible when it opens
   ([Editing books and series](editing-series.md#other-catalogs)), unless you untick Audible there.
2. The series is read on the Audible site most of its books' Audible ASINs are from, as each site has its own
   ASINs. An Amazon site's ASIN is that site's alone (Goodreads and Hardcover list amazon.com's, often a Kindle or
   print edition's), so it is never asked of Audible. It is found by the ASIN in the series' Audible field, else from what
   Audible says of your books in it.
3. The page shows on each of your books what its edition there would fill in (narrators, publisher, release
   date, length, ISBN) and the values that differ, and lists the series' books on Audible that aren't in the catalog. Box sets, placeholders for
   books to come and companions without a number aren't listed.
4. Audible lists every edition it sells of each book (other publishers, abridged ones). A book of yours takes
   the edition with one of its ASINs, which is ticked; else, when Audible has one edition of its number, that
   one, which you take with its book if it is yours. With several and none of yours, nothing is offered: give the
   book its ASIN on the page, and press **Ask again**.
5. **Save** takes in what you took, and keeps the series' Audible id and its count of books (whole numbers)
   where the series has none yet, when you tick that under _Other catalogs_.

Your editions whose ASIN on that Audible site Audible doesn't sell there are marked _Maybe not an audiobook_ on
their book: often another site's ASIN put under that site. It is only a guess, as Audible also stops selling some
audiobooks; follow the link to see what the ASIN is, and correct the edition on the page.

Only series are compared with Audible, not authors.
