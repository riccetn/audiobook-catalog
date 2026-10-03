# How imports avoid clobbering your edits

Imports only ever *add* books; an existing book is never overwritten. An incoming book counts as
already present if any of these match, strongest first:

1. the Audible `id`, Goodreads id (`gr`) or Hardcover id (`hc`) of any of its editions, then its Hardcover
   book id (`hcb`, another edition of the same book on Hardcover)
2. same first author + same series (spelling-insensitive: `Ember Coast` = `Ember Coast Series`) + same number
3. same author and title, also forgiving of the long Audible form: `A Crown of Embers 5: A Spark of Dawn`
   finds your `A Spark of Dawn`, and `X, Book 1` finds `X`. A boxed set is never mistaken for its first book.

The imported edition then goes into the match without replacing anything:
- if one of the match's editions has the same ASIN, Goodreads id or ISBN, that edition gets whatever it is
  missing (ASIN, Goodreads id, ISBN, publisher, release date, length), and so do its copies on a box set's other titles;
- otherwise, if the match has a single edition of its own that does not have a different ASIN, Goodreads id or ISBN,
  that edition is filled in the same way (so a Goodreads export finds and completes the edition an Audible import made);
- otherwise it is added as another edition of the book.

Dates read are filled in when the match has none, and so is the Hardcover book id. So later imports keep matching even after more edits.
ISBNs are *not* used to decide that two books are the same, because one ISBN can belong to several books (a boxed set):
an incoming book whose ISBN is already on another book is still added if nothing else matches. New books get the series spelling already in use. If Audible lists a book under
several series, a parent series wins over its sub-series (`Thornmere` over `Thornmere: Wardens`);
otherwise the first is used and the book is flagged in the import output.

## Box sets

A box set in an export, one whose series number is a range (Audible's `Ember (books 1-3)`, Goodreads'
`The Ember Trilogy (Ember, #1-3)`), is added as its titles rather than as one book: books 1, 2 and 3 of
`Ember` each get the set's edition, the same ASIN or Goodreads id on each (see
[box sets](data-format.md)), with the set's name as the edition's description. A title you already have
(same first author, series and number) gains the edition beside its own editions, which are never filled
in from the set's; a title you don't have yet is added as `Ember, Book 2`, for you to rename. Each title
gets the set's date read when it has none. The import lists the box sets it split. Importing the same set
from the other export later fills in that edition on every title (Goodreads' id beside Audible's ASIN).

A box set stays one book when it is already in your catalogue as one book, when its export names no range
(an "omnibus" with no numbers: the export doesn't say which titles it holds), or when it has no ASIN,
Goodreads id or ISBN to tie its titles together.
