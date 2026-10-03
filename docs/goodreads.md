# Goodreads

## Import from Goodreads

`node catalog.js import-goodreads data/raw/goodreads_library_export.csv`, or
**Goodreads CSV** in the app (it works like [the Audible import in the app](audible.md#add-new-audible-purchases)). Goodreads has no "audiobook" flag, so books are picked by edition (Audible Audio, Audiobook, Audio CD,
MP3...) and the *read* shelf. The edition's narrator comes from the "Additional Authors" column, which is a guess
(it never replaces a narrator you already have).
Each book keeps Goodreads' *Book Id* as its edition's `gr`, with the edition's *Publisher* and *Year Published*,
so a later export still finds it after you rename it; books already in the catalogue get their Goodreads id
filled in the first time an export matches them. Goodreads puts the series in the title, as
`The First Adventure (Fantasy Adventures, #1)` or `The First Adventure: Fantasy Adventures, Book 1`; both
become the title `The First Adventure` in series `Fantasy Adventures`, number `1`.

## Export to Goodreads

`node catalog.js export-goodreads goodreads.csv` (or **Goodreads CSV** under
*Export to Goodreads* on the *Import & export* page) writes the catalogue as a Goodreads library export,
the format Goodreads' [import page](https://www.goodreads.com/review/import) takes. Every book goes on the
*read* shelf, also those with no date read (a missing date means unknown, not unread), with the series in
the title (`The First Adventure (Fantasy Adventures, #1)`), the first author as *Author* and the rest as
*Additional Authors*, its genres as shelves (`Science Fiction` becomes `science-fiction`), and how many
dates read it has as *Read Count*. Goodreads keeps one date read, so a book gets its latest full date
(`2024-03-15` becomes `2024/03/15`); one read only in `2024-03` or `2024` goes without. Goodreads finds a
book by the *Book Id* and ISBN of one of its editions (preferring one with both), else by title and
author; a box set's edition, shared with its other titles, is left out so Goodreads doesn't file each
title as the box set. The command says how many books have no id or ISBN and how many no full date.
Our own Goodreads import reads the file back.

Books imported before titles were split this way (or by hand) are split when the catalogue loads: a book with
no series gets the one in its title, and a book that already has that series just loses it from the title.
A book whose title names a different series or number than the one it has is left alone. `make validate`
says how many titles still hold their series, and `make format`, or any save, writes them split.
