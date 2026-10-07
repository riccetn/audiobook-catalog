# Data format

`data/books.json` is a list of titles, with short keys to keep the file small:

| key  | meaning                                             | required |
|------|-----------------------------------------------------|----------|
| `t`  | title                                               | yes      |
| `a`  | list of authors, one name each (`["Ann Vale", "Bo Reed"]`) | yes |
| `s`  | series name                                         |          |
| `sn` | position in series, as text (`"3"`, `"4-6"` for a boxed set) |  |
| `g`  | list of genre/tag strings                           |          |
| `r`  | list of dates you read it, oldest first (`["2023-06-02", "2025-11-20"]`); `"2024-03"` or `"2024"` when you don't remember the day. A single date may be written as a plain string (`"r": "2024-03-15"`); it is read as a list. No `r` means the date is unknown, not that the book is unread |  |
| `hcb` | Hardcover's id of the book (`"77"`), the number in `hardcover.app/id/book/…`; every edition of it is an edition of this book |  |
| `e`  | list of the title's editions (below)                |          |

Each title can have several **editions** (the Audible release, a UK release with another narrator, a
dramatized adaptation, the CD...). Every field of an edition is optional, but an edition is never empty;
the ASIN, Goodreads id, Hardcover id and ISBN are what imports and box sets go by:

| key    | meaning                                                                  |
|--------|--------------------------------------------------------------------------|
| `asin` | the edition's ASINs, by site: `{"audible.com": "B0…", "amazon.com": "B0…"}`. Amazon and each of its Audible and Amazon sites may give one edition an ASIN of its own, so each is kept under its site's address (`audible.com`, `audible.co.uk`, `amazon.com`, `amazon.de`, …). Re-imports recognise the book by any of them; only another ASIN on the same site makes another edition |
| `gr`   | Goodreads book id, the number in `goodreads.com/book/show/…` (`"4242"`), so re-imports recognise the book |
| `hc`   | Hardcover's id of this edition (`"501"`), so Hardcover imports and exports recognise it      |
| `isbn` | this edition's ISBN, the 13-digit form without hyphens (`"9780000000002"`). One per edition: another ISBN is another edition. It may be written with hyphens or as an ISBN-10, and is tidied to the 13-digit form when the page or `sync-export` saves |
| `n`    | list of this edition's narrators, one name each (`["Tobias Frane"]`)     |
| `p`    | publisher                                                                |
| `d`    | release date (`"2021-05-04"`, `"2021-05"` or `"2021"`)                   |
| `len`  | length in whole minutes (`642`)                                          |
| `desc` | your own description of the edition, free text (`"UK edition"`, `"First edition"`, `"Dramatized adaptation"`, `"Audio CD"`) |

```json
{"t":"The Salt Road","a":["Marisol Quenby"],"s":"The Lantern Coast","sn":"1","hcb":"77",
 "e":[{"asin":{"audible.com":"B0SAMPLE01","amazon.com":"B0SAMPLE03"},"gr":"9001","hc":"501","isbn":"9780000000002","n":["Tobias Frane"],"p":"Gullwing Audio","d":"2019-04-02","len":642},
      {"asin":{"audible.co.uk":"B0SAMPLE02"},"n":["Hollis Marr","Dana Whitlock"],"desc":"UK edition"}]}
```

**Which site an ASIN is from**: an Audible import's ASINs are from the Audible site you pick (audible.com
unless you pick another, see [Audible](audible.md)); ASINs from Hardcover or Goodreads are amazon.com's,
the site they use. An edition's ASIN from before ASINs were kept by site (`"id": "B0…"`) is read as its
audible.com ASIN.

**Box sets**: an edition that holds several titles (a box set, an omnibus) is listed on each of those
titles, with the same ASIN, Goodreads id or ISBN; that shared identifier is what ties them together.
The page shows "Also in this edition: …" on each of them, and editing the edition on one updates it on
the others. `make validate` warns when the copies disagree. Imports split a box set into its titles this
way ([Box sets](imports.md#box-sets)). (A book you only have as a box set can still be one record with a
range such as `"sn": "2-3"`.)

**Older files**: before editions, a book held its `id`, `gr` and `isbn` itself, and its narrator (`n`)
until narrators moved to editions. Such books are still read: the ids become one edition, and the
narrator goes on each edition that has none (on a new edition, for a book without any). Until
2026-10 an edition could hold a list of ISBNs and the Hardcover book id (`hcb`); an edition with
several ISBNs is read as one edition per ISBN (the first keeps everything else, each other ISBN becomes
an edition of its own), and the Hardcover book id moves to the book (a box set's, which is on each of
its titles, gives way to the book's own). Until 2026-10 the authors and narrators were one comma
separated text (`"a": "Ann Vale, Bo Reed"`); that is read as a list, split at commas, semicolons, `&`
and `and` (a suffix such as `Jr.` stays with its name). Until 2026-10 an edition had one ASIN, `id`,
which is read as its audible.com ASIN (`"asin": {"audible.com": …}`). `make validate` mentions all of these, and
`make format`, or any save from the page, an import or `sync-export`, writes them in the new shape.

`data/series-info.json` maps a series name (it must match `s` exactly) to
`{"total": 12, "status": "ongoing" | "complete", "note": "...", "url": "https://..."}`.
`total` is the number of books released so far; `url` (an author or publisher site) is optional.

`make validate` checks all of this and warns about suspicious entries.

## Tidy names and spacing

Authors and narrators keep a space between initials (`A. B. Quill`, not `A.B. Quill`), so the filters
never list one person twice. Every text field also has stray spacing removed: runs of spaces, tabs,
non-breaking or invisible characters, and leading/trailing whitespace. Both importers and
`sync-export` apply this automatically (`tidyBook` in `importers.js`), and `make validate` warns
about any value that is not tidy. Capitalisation and quote styles are left alone.

## Known data quirks

`make validate` may warn about entries carried over from an Audible export, for example a series
name such as `Some Series (book ), Other Series` when Audible lists several series for one book, or
`∞` as a series number. Fix them with the edit form or in `data/books.json`.
