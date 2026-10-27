# How imports avoid clobbering your edits

## The comparison

An Audible or Goodreads import, and **Compare** in the Hardcover and AudiobookDB panels, first show the other catalog's books
beside yours, under the panel you started from, and change nothing until you press **Apply**. Each group
lists its books with a tickbox, and **Tick all** and **Tick none** for the group:

- **New from …**: books you don't have yet, ticked. Untick a book to leave it out; it is offered again the
  next time.
- **… has more**: books you have that the other catalog has more of, each with what it would gain. The
  book's own gains (dates read, its Goodreads or Hardcover book id) are ticked. What its edition there would
  bring (ids, an ISBN, a narrator, publisher, release date or length, or another edition) has a tickbox of its
  own: ticked for Audible, whose edition is the one you have, but unticked for Goodreads and Hardcover, which
  make you pick an edition to shelve a book, so theirs may be one picked for want of yours. Importing only
  fills in what your book lacks (see below).
- **Different in both**: where both have a value and they differ (the title, authors, series, number in
  the series, dates read, or an edition's narrators, publisher, release date or length), one tickbox per
  value, _unticked_: tick one to put the other catalog's value in place of yours (an edition's value from
  Goodreads or Hardcover is that of the edition picked there, which may not be yours). This is the only way an
  import changes a value you have, and only the values you tick. A series your book lacks is offered
  here too, as an import doesn't add one. A series' name renames the series, on all its books, keeping its
  details (the row says `renames the series, on 4 books`), when the other catalog puts every one of its books
  it has in that one series and no series here has that name; otherwise it moves only that book. The long form of an Audible title (`A Crown of Embers 5: A Spark
of Dawn`) is the same title, a series spelled another way (`Ember Coast Series`) the same series, and a
  length a minute off the same length, so none of them is listed; nor is a title with a subtitle (`The Salt Road: A
Novel`), or one an edition of the book was released under. An Audible export or **Compare** and a Goodreads
  export have the title each edition was released under (on that site, or that Goodreads edition), so a title your
  book lacks is offered there twice, _unticked_: as **Title** (renaming the book) and as **Released as**, the title of the
  edition it found the book by (`Released as: none here, The Keeper of Lanterns on Audible`). Hardcover and
  AudiobookDB have the work's title, so theirs is only ever a Title.
- **Only in this catalog** (for a file): your books the file doesn't have, to look through. For Hardcover,
  see [Hardcover](hardcover.md): your books not on your _Read_ shelf there, and reads it lacks, can be ticked
  to be put on Hardcover.
- Books on the exclusion list are counted and listed, and never added.
- **Maybe not audiobooks** (comparing with Hardcover or a series with Audible): your editions the other catalog
  has as a print book or an ebook (or, on Audible, doesn't sell), and books on your shelves there read in
  another format, as they may be data problems. Nothing to tick: see [Hardcover](hardcover.md) and
  [Audible](audible.md).

**Apply** (with **Cancel**, kept at the bottom of the screen while you scroll the comparison) says how many changes are ticked. It takes them into the catalog as it is then (a value that no
longer differs is left alone), checks the result first and changes nothing when it has errors, then saves.

## Several catalogs at once

**Compare with all catalogs**, on a series' page and an author's (beside their other Compare buttons), and in the
_All catalogs_ panel on _Import & export_, compares that series' or author's books with Hardcover, AudiobookDB and
Audible together (Audible only for a series), each as its own **Compare** would. A catalog that can't be asked (no
token or proxy saved) is named at the top and left out; one that fails is named with why, and the others still show.
Nothing is picked when it opens, so **Apply** stays hidden until you pick something, and changes only what you picked:

- **Different in the catalogs**: for each of your books, every field where a catalog has another value than yours, or
  has one where yours has none (the title, authors, series, number, dates read, or an edition's narrators,
  publisher, release date or length). Each value is listed once, with the catalogs that have it (`8h on AudiobookDB
and Audible`), beside yours (`none here`), which is picked. Pick a catalog's value to use it instead; a series' name renames
  the series as in a single catalog's comparison, when the catalogs agree on its books.
- **New books**: the books none of yours are, each once however many catalogs have it, _not added_ unless you
  pick the catalog to add it from.
- **More to give**: what each catalog's book would fill in on yours (its ids, dates read, and what its edition
  brings), to tick. It only fills gaps, and a value picked above wins.
- **Ids found**: the ids each catalog found for your books, series and people, to tick.
- **Maybe not audiobooks**: each catalog's list, as in its own comparison (nothing to pick). A print or ebook
  edition on Hardcover gives no values above.

Nothing is sent to any catalog: putting books on your shelves stays with each catalog's own **Compare**.

## Matching

An import only ever _adds_ books, and fills in what a book you have lacks; it changes a value you have only
where you ticked it in the comparison. An incoming book counts as already present if any of these match,
strongest first:

1. an ASIN (on any site), the Goodreads id or Hardcover id of any of its editions, then its Hardcover
   book id (another edition of the same book on Hardcover)
2. same first author + same series (spelling-insensitive: `Ember Coast` = `Ember Coast Series`) + same number
3. same author and title, also forgiving of the long Audible form: `A Crown of Embers 5: A Spark of Dawn`
   finds your `A Spark of Dawn`, `X, Book 1` finds `X`, and `X: A Novel` finds `X`; any title an edition of
   yours was released under counts as the book's (but a box set's edition's title is the set's, not its books').
   A boxed set is never mistaken for its first book (`X: Books 1-3` never finds `X`).

Titles, authors and series are compared ignoring case, punctuation and accents (`Café` = `Cafe`), in any
script: two books in Cyrillic or Japanese are told apart by their titles like any others.

The imported edition then goes into the match without replacing anything:

- if one of the match's editions has the same ASIN, Goodreads id or ISBN, that edition gets whatever it is
  missing (ASIN, Goodreads id, ISBN, publisher, release date, length), and so do its copies on a box set's other titles;
- otherwise, if the match has a single edition of its own that does not have a different ASIN (on the same site), Goodreads id or ISBN,
  that edition is filled in the same way (so a Goodreads export finds and completes the edition an Audible import made);
- otherwise it is added as another edition of the book.

Dates read are filled in when the match has none, and so is the Hardcover book id. So later imports keep matching even after more edits.
ISBNs are _not_ used to decide that two books are the same, because one ISBN can belong to several books (a boxed set):
an incoming book whose ISBN is already on another book is still added if nothing else matches. New books get the series spelling already in use. If Audible lists a book under
several series, a parent series wins over its sub-series (`Thornmere` over `Thornmere: Wardens`);
otherwise the first is used and the book is flagged in the import output.

## Box sets

A box set in an export, one whose series number is a range (Audible's `Ember (books 1-3)`, Goodreads'
`The Ember Trilogy (Ember, #1-3)`), is kept both as its own book and as its titles: the set is a book of
the series numbered `1-3`, and books 1, 2 and 3 of `Ember` each get the set's edition too, the same ASIN
or Goodreads id on each (see [box sets](data-format.md)), with the set's name as the edition's
description. The set's own book is found again by that edition, by its title, or by author, series and
range, so the other export's copy of it fills it in rather than adding it twice. A title you already have
(same first author, series and number) gains the edition beside its own editions, which are never filled
in from the set's; a title you don't have yet is added as `Ember, Book 2`: rename it in its edit form. Each title
gets the set's date read when it has none. The import lists the box sets it kept. Importing the same set
from the other export later fills in that edition on the set and every title (Goodreads' id beside
Audible's ASIN). A box set you already have as one book gains its titles the same way.

A Hardcover box set has no range, but when its edition is on titles you have that are numbers in a row
of one series (books 1 and 2 of `Gull Isle`), the Hardcover import adds the set as their collection
(`Gull Isle`, `1-2`); reading it on Hardcover counts as reading each of those titles.

A box set stays one book when its export names no range (an "omnibus" with no numbers: the export doesn't
say which titles it holds), or when it has no ASIN, Goodreads id or ISBN to tie its titles together.

In a series, a box set (any book whose number is a range) is listed after the titles, and the series
counts its titles, not the set: "3 owned + 1 box set".

**Box sets already in your catalog**: **Box sets** on the _Import & export_ page brings the box sets you
imported before this up to date: a set kept as one book (a range and an
ASIN, Goodreads id, Hardcover id or ISBN) gains its titles as an import would add them, and titles that
share an edition and are numbers in a row of one series gain the set as its own book, named by the
edition's description (the set's name, from an import) or else `Series, Books 1-3`, with the dates read
all its titles have. Nothing on the exclusion list is added, so a title or set you removed stays away.
It lists what it would add, and changes nothing until you confirm.
