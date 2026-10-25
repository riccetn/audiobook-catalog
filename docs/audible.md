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
[catalog proxy](catalog-proxy.md); without one, set up on the _Import & export_ page, there is nothing to compare.
No Audible account is needed, and nothing is sent to Audible.

1. Press **Compare with Audible** beside **Edit** at the end of a series' page (on _Series_), or on the _Import & export_ page type the
   series beside **Compare** in the **Audible** panel and press it.
2. The series is read on the Audible site most of its books' ASINs are from (an amazon.de ASIN reads audible.de),
   as each site has its own ASINs. It is found by the ASIN in the series' Audible field, else from what
   Audible says of your books in it.
3. The page shows the series' books on Audible beside yours ([the comparison](imports.md#the-comparison)):
   what their editions there would fill in on yours (narrators, publisher, release date, length, ISBN), the
   values that differ, and the series' books on Audible that aren't in the catalog. Box sets, placeholders for
   books to come and companions without a number aren't listed.
4. Audible lists every edition it sells of each book (other publishers, abridged ones). A book of yours takes
   the edition with one of its ASINs, which is ticked; else, when Audible has one edition of its number, that
   one, which you tick if it is yours. With several and none of yours, the comparison says so: give the book
   its ASIN in its edit form, and compare again.
5. **Apply** takes in what you ticked, and keeps the series' Audible id and its count of books (whole numbers)
   where the series has none yet.

Only series are compared with Audible, not authors.
