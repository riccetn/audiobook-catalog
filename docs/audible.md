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

Audible's catalog doesn't let a web page ask it about books, so the app can't look up series on Audible.
Fill in a missing series in the book's edit form, and a series' released total in its series info form.
