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
