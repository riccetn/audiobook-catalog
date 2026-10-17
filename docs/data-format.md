# Data format

A backup ([Running the app and keeping your catalog](saving.md)) is one JSON file:
`{"books": [...], "seriesInfo": {...}, "authors": {...}, "narrators": {...}, "publishers": {...}, "excluded": [...], "notDuplicates": [...], "ids": {...}}`.
The browser keeps the same catalog as records in IndexedDB ([How the browser keeps it](#how-the-browser-keeps-it), below).
The books (`books.json` before the catalog moved into the browser) are a list of titles, with short keys to keep it small:

| key  | meaning                                             | required |
|------|-----------------------------------------------------|----------|
| `t`  | title                                               | yes      |
| `a`  | list of authors, one name each (`["Ann Vale", "Bo Reed"]`) | yes |
| `s`  | series name                                         |          |
| `sn` | position in series, as text (`"3"`, `"4-6"` for a box set, which is listed after the series' titles) |  |
| `g`  | list of genre/tag strings                           |          |
| `r`  | list of dates you read it, oldest first (`["2023-06-02", "2025-11-20"]`); `"2024-03"` or `"2024"` when you don't remember the day. A single date may be written as a plain string (`"r": "2024-03-15"`); it is read as a list. No `r` means the date is unknown, not that the book is unread |  |
| `ext` | the book's own ids in [external catalogs](#external-catalogs) (`{"hardcover": "77", "goodreads": "99"}`): Hardcover's book, whose every edition is an edition of this book, and Goodreads' work |  |
| `e`  | list of the title's editions (below)                |          |
| `uid` | the id the book is stored under in the browser, which never changes (written first) |  |

Each title can have several **editions** (the Audible release, a UK release with another narrator, a
dramatized adaptation, the CD...). Every field of an edition is optional, but an edition is never empty;
its ids in external catalogs and its ISBN are what imports and box sets go by:

| key    | meaning                                                                  |
|--------|--------------------------------------------------------------------------|
| `ext`  | the edition's ids in [external catalogs](#external-catalogs): `{"audible.com": "B0…", "amazon.com": "B0…", "goodreads": "4242", "hardcover": "501"}`. Each Audible and Amazon site may give one edition an ASIN of its own, so each is kept under its site's address (`audible.com`, `audible.co.uk`, `amazon.com`, `amazon.de`, …); Goodreads' id is the number in `goodreads.com/book/show/…`, Hardcover's the one in `hardcover.app/id/edition/…`. Re-imports recognize the book by any of them (an ASIN on any site); only another id in the same catalog (another ASIN on the same site) makes another edition |
| `isbn` | this edition's ISBN, the 13-digit form without hyphens (`"9780000000002"`). One per edition: another ISBN is another edition. It may be written with hyphens or as an ISBN-10, and is tidied to the 13-digit form when the page saves |
| `n`    | list of this edition's narrators, one name each (`["Tobias Frane"]`)     |
| `p`    | publisher                                                                |
| `d`    | release date (`"2021-05-04"`, `"2021-05"` or `"2021"`)                   |
| `len`  | length in whole minutes (`642`)                                          |
| `desc` | your own description of the edition, free text (`"UK edition"`, `"First edition"`, `"Dramatized adaptation"`, `"Audio CD"`) |
| `uid`  | the id the edition is stored under in the browser, which never changes; a box set's copies share it (written first) |

```json
{"t":"The Salt Road","a":["Marisol Quenby"],"s":"The Lantern Coast","sn":"1","ext":{"hardcover":"77"},
 "e":[{"ext":{"audible.com":"B0SAMPLE01","amazon.com":"B0SAMPLE03","goodreads":"9001","hardcover":"501"},"isbn":"9780000000002","n":["Tobias Frane"],"p":"Gullwing Audio","d":"2019-04-02","len":642},
      {"ext":{"audible.co.uk":"B0SAMPLE02"},"n":["Hollis Marr","Dana Whitlock"],"desc":"UK edition"}]}
```

**Which site an ASIN is from**: an Audible import's ASINs are from the Audible site you pick (audible.com
unless you pick another, see [Audible](audible.md)); ASINs from Hardcover or Goodreads are amazon.com's,
the site they use. An edition's ASIN from before ASINs were kept by site (`"id": "B0…"`) is read as its
audible.com ASIN.

**Box sets**: an edition that holds several titles (a box set, an omnibus) is listed on each of those
titles, with the same ASIN, Goodreads id or ISBN; that shared identifier is what ties them together.
The page shows "Also in this edition: …" on each of them, and editing the edition on one updates it on
the others. **Check** warns when the copies disagree. A box set is also a book of its own, whose
series number is the range it holds (`"sn": "2-3"`), with the same edition. Imports keep a box set this
way, as its own book and as its titles ([Box sets](imports.md#box-sets)), and **Box sets** on the
*Import & export* page brings older box sets up to date. (A box set with nothing to tie it to its titles is just the one book
with a range.)

**Older files**: before editions, a book held its `id`, `gr` and `isbn` itself, and its narrator (`n`)
until narrators moved to editions. Such books are still read: the ids become one edition, and the
narrator goes on each edition that has none (on a new edition, for a book without any). Until
2026-10 an edition could hold a list of ISBNs and the Hardcover book id (`hcb`); an edition with
several ISBNs is read as one edition per ISBN (the first keeps everything else, each other ISBN becomes
an edition of its own), and the Hardcover book id moves to the book (a box set's, which is on each of
its titles, gives way to the book's own). Until 2026-10 the authors and narrators were one comma
separated text (`"a": "Ann Vale, Bo Reed"`); that is read as a list, split at commas, semicolons, `&`
and `and` (a suffix such as `Jr.` stays with its name). Until 2026-10 an edition had one ASIN, `id`,
which is read as its audible.com ASIN. Until 2026-10 the ids had keys of their own: an edition's ASINs
by site in `asin`, its Goodreads id in `gr` and its Hardcover id in `hc`, and the book's Hardcover id
in `hcb`; they are read into `ext`. A backup or Restore in an older shape is read this way, and the
browser keeps the catalog in the current one.

The series info (`seriesInfo`, `series-info.json` before) maps a series name (it must match `s` exactly) to
`{"total": 12, "status": "ongoing" | "complete", "note": "...", "url": "https://...", "ext": {...}}`.
`total` is the number of books released so far; `url` (an author or publisher site) and `ext` (the
series' ids in [external catalogs](#external-catalogs), `{"audible.com": "B0…", "goodreads": "90001", "hardcover": "3101"}`) are optional.

## Authors

The author info (`authors`, `authors.json` before) maps an author's name (it must match a name in some
book's `a` exactly) to what you keep about them; every field is optional:

```json
{"Marisol Quenby": {"bio": "Writes seafaring fantasy.\n\nLives by the sea.", "url": "https://example.com/",
  "ext": {"audible.com": "B0SAMPLEA1", "goodreads": "1234", "hardcover": "marisol-quenby"}}}
```

| key     | meaning                                                              |
|---------|----------------------------------------------------------------------|
| `bio`   | a short bio, free text; a blank line (`\n\n`) starts a new paragraph |
| `url`   | the author's own website                                             |
| `ext`   | their ids in [external catalogs](#external-catalogs): their author page's ASIN on an Audible or Amazon site, the number of their Goodreads page, their number on Hardcover (or, when Hardcover couldn't be asked for it, the name in their Hardcover page's address). The page links to each |
| `links` | other pages about them, as a list of addresses: where an author page's address from before could not be read as an id, it is kept here |

Links must start with `http://` or `https://`; **Check** warns when an id is not one its catalog
gives, when one of `links` is an external catalog's page (keep its id in `ext` instead), and when an
entry matches no author of any book (an author renamed on their books). Until 2026-10 the entry kept
the addresses of their pages as `audible`, `goodreads` and `hardcover`; each is read into `ext`. The
series and titles on an author's page are not stored here: they come from the books.

## Narrators and publishers

The narrator info (`narrators`) and publisher info (`publishers`) work the same way, with the same keys:
`narrators` maps a narrator's name (as an edition's `n` writes it) and `publishers` a publisher's name (as an
edition's `p` writes it) to a bio and links. For a narrator, the Audible id is their name as Audible's
narrator search takes it, and Goodreads' and Hardcover's ids are their author pages' (both sites list
narrators as authors), and so is BookBrainz's; for a publisher, Audible's id is its name as Audible's publisher search takes it
and Hardcover's its number there (Goodreads has no publisher pages). Both can also have a
Wikidata item, and a publisher an ISFDB and a BookBrainz id. Both are
optional (missing means `{}`), and **Check** warns, as for authors, about an entry that matches no edition.

```json
{"narrators": {"Ingrid Voss": {"bio": "Narrates fantasy.", "ext": {"audible.com": "Ingrid Voss", "hardcover": "4102"}}},
 "publishers": {"Kestrel Row Audio": {"url": "https://example.com/", "ext": {"hardcover": "5101"}}}}
```

## External catalogs

Books, editions, series and people keep only the ids other catalogs give them, never the address of
their page there: the app knows, for each catalog, how its pages' addresses are made
(`modules/external-catalog.js`), so it makes the link from the id, and reads the id out of an address
pasted into a form. The key in `ext` is the catalog's:

| key | catalog | ids it gives |
|-----|---------|--------------|
| `audible.com`, `audible.co.uk`, `audible.de`, `audible.fr`, `audible.it`, `audible.es`, `audible.ca`, `audible.com.au`, `audible.in`, `audible.co.jp` | an Audible store | an edition's ASIN (`/pd/B0…`), a series' (`/series/B0…`) and an author's (`/author/B0…`); a narrator's or publisher's name, for Audible's search |
| `amazon.com`, `amazon.co.uk`, … (each Audible store's Amazon twin, and `amazon.se`, `amazon.nl`, `amazon.pl`, `amazon.com.br`, `amazon.com.mx`) | an Amazon store | an edition's ASIN (`/dp/B0…`) and an author's (`/stores/author/B0…`) |
| `goodreads` | Goodreads | a book's work (`/work/editions/99`), an edition (`/book/show/4242`), a series (`/series/90001`), an author or narrator (`/author/show/1234`) |
| `hardcover` | Hardcover | a book (`/id/book/77`), an edition (`/id/edition/501`), a series (`/id/series/3101`), an author or narrator (`/id/author/4101`), a publisher (`/id/publisher/5101`), each by its number; a series' or person's page by the name in its address (`/authors/marisol-quenby`) when Hardcover couldn't be asked for the number |
| `openlibrary` | Open Library (`openlibrary.org`) | a book's work (`/works/OL123W`), an edition (`/books/OL456M`), an author (`/authors/OL789A`) |
| `isfdb` | ISFDB, the Internet Speculative Fiction Database (`isfdb.org`) | a book's title (`/cgi-bin/title.cgi?194342`), an edition, which ISFDB calls a publication (`pl.cgi?…`), a series (`pe.cgi?…`), an author (`ea.cgi?…`), a publisher (`publisher.cgi?…`) |
| `bookbrainz` | BookBrainz (`bookbrainz.org`) | a book's work (`/work/…`), an edition (`/edition/…`), a series, an author or narrator (`/author/…`), a publisher, each by its UUID |
| `wikidata` | Wikidata (`wikidata.org`) | the item (`/wiki/Q1001`) of a book, a series, an author, a narrator or a publisher; not of an edition, since an item's address doesn't say whether it is a book or an edition |

Every ASIN, on any Audible or Amazon site, names the same edition wherever it is found, so an import
from one site matches an edition another site gave. **Check** reports an id its catalog doesn't give
(`"4242x"` for Goodreads) and warns about a key it doesn't know.

**Check** checks all of this and warns about suspicious entries.

## Ids

`ids` maps each series, author, narrator and publisher name to the id it is stored under:
`{"series": {"The Lantern Coast": "3f2b…"}, "authors": {…}, "narrators": {…}, "publishers": {…}}`. With the books' and
editions' `uid`, it lets a Restore put back the same records, and a **Merge** find a book by its id first
(before its ASIN, title or place in a series), even when it was retitled on the other device. Backups
without ids still work: whatever has none gets a new one.

## How the browser keeps it

The browser keeps the catalog in IndexedDB, database `audiobook-catalog`, as plain objects with
descriptive field names. Every record has an id that never changes (`crypto.randomUUID()`), and records
point at each other by id, so renaming a series changes one record. Fields marked *derived* are written
from the others on every save, only so an index can sort or filter without reading other records
(`modules/catalog-records.js`). Every index that sorts ends with the record's key, so a page can ask for
the next rows after the last one it shows (`IDBKeyRange.lowerBound([sortTitle, id], true)`), which is
how a list can be paged or scrolled without loading all of it.

| store | key | holds | indexes |
|-------|-----|-------|---------|
| `books` | `id` | `title`, `authorIds`, `seriesId`, `number`, `genres`, `read`, `external` (its ids by catalog), `editionIds` (in order), `position` (the catalog's order); derived: `sortTitle`, `titleKey`, `firstAuthorKey`, `seriesKey`, `isCollection`, `numberKey`, `numberEnd`, `lastRead`, `words`, `externalKeys` (`"hardcover 77"`) | `byTitle` [sortTitle, id], `bySeries` [seriesId, isCollection, numberKey, numberEnd, sortTitle, id], `byLastRead` [lastRead, id], `byAuthorTitle` and `byAuthorSeries` (import matching), `genres`, `words` and `externalKeys` (multiEntry) |
| `editions` | `id` | `bookIds` (a box set's edition is one record on all its titles), `external` (its ids by catalog), `isbn`, `narratorIds`, `publisherId`, `released`, `minutes`, `description`; derived: `idKeys` (`"asin B0…"` for an ASIN on any site, `"goodreads 4242"`, `"hardcover 501"`, `"isbn 978…"`) | `bookIds`, `idKeys`, `narratorIds` (multiEntry), `publisherId` |
| `series` | `id` | `name`, `total`, `status`, `note`, `url`, `external`; derived: `sortName`, `bookCount`, `owned`, `missing`, `lastRead`, `externalKeys` | `name` (unique), `byName` [sortName, id], `byStatus` [status, sortName, id], `externalKeys` (multiEntry) |
| `contributors` | `id` | `kind` (`author`, `narrator`, `publisher`), `name`, `bio`, `url`, `external`, `links`; derived: `sortName`, `bookCount`, `externalKeys` | `kindName` [kind, name] (unique), `byName` [kind, sortName, id], `externalKeys` (multiEntry) |
| `credits` | [contributorId, bookId] | derived: who is credited on which book, as what, with the book's `sortTitle`, `seriesId` and `numberKey` | `byTitle` [contributorId, sortTitle, bookId], `bySeries` [contributorId, seriesId, numberKey, bookId], `bookId` |
| `marks` | `id` | "Not duplicates" (`bookIds`), "Keep separate" (`bookIds`, `editionIds`), or a mark that matched no book (`key`, its text) | `bookIds` (multiEntry) |
| `exclusions` | `entry` | an entry of the exclusions list, and its `position` in it | |
| `meta` | `key` | `revision` (bumped by every save; when another tab saved since the page read it, the page takes in the records that tab changed before it saves, and refuses when both changed the same record), and `unreadable` (a catalog set aside) | |

Every series a book names and every person a book or edition credits has a record, with info or without.
The database is version 2: version 1 kept the ids under fields of their own (an edition's `asins`,
`goodreadsId` and `hardcoverId`, a book's `hardcoverId`, a person's `audible`, `goodreads` and
`hardcover` addresses) and indexed the books' `hardcoverId`; a page that finds records like that reads
them, and saves them again the current way at once.
A value the classes keep aside because it isn't what its field holds has no place in a record, so a
catalog or backup with one is not stored until it is fixed (see [Where the catalog lives](saving.md#where-the-catalog-lives)).

## Tidy names and spacing

Authors and narrators keep a space between initials (`A. B. Quill`, not `A.B. Quill`), so the filters
never list one person twice. Every text field also has stray spacing removed: runs of spaces, tabs,
non-breaking or invisible characters, and leading/trailing whitespace. The importers and the edit forms
apply this automatically (`Book.tidyJSON` in `modules/book.js`), and **Check** warns
about any value that is not tidy. Capitalisation and quote styles are left alone.

## Known data quirks

**Check** may warn about entries carried over from an Audible export, for example a series
name such as `Some Series (book ), Other Series` when Audible lists several series for one book, or
`∞` as a series number. Fix them with the edit form.
