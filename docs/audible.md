# Audible

## Add new Audible purchases

1. Export your library with the Audible Library Extractor.
2. On the *Import & export* page, press **Audible CSV** and pick the export. For an export from another
   site than audible.com, pick the site under the buttons first, so its ASINs are kept as that site's.
3. The page shows what would change: what is already there, which Audible and Goodreads ids get filled
   in, what is new and what needs a look (for example a book Audible files under several series).
   Nothing changes until you press **Add books**; then, like any edit, it is saved in the browser
   (see [Running the app and keeping your catalogue](saving.md)).

Only finished books are imported, and books on the exclusion list are skipped. Each book gets its Audible
edition: the ASIN, the ISBNs, the narrators, the publisher, the release date and the length, as far as the
export has them.

Audible's catalogue doesn't let a web page ask it about books, so the app can't look up series on Audible.
Fill in a missing series in the book's edit form, and a series' released total in its series info form.
