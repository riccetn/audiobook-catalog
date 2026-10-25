# Goodreads

## Import from Goodreads

**Import CSV** in the **Goodreads** panel of the _Import & export_ page takes Goodreads' library
export; it works like [the Audible import](audible.md#add-new-audible-purchases), showing the export's books beside
yours to pick what to take ([the comparison](imports.md#the-comparison)). Goodreads has no "audiobook" flag, so books are picked by edition (Audible Audio, Audiobook, Audio CD,
MP3...) and the _read_ shelf. The edition's narrator comes from the "Additional Authors" column, which is a guess
(it never replaces a narrator you already have).
Each book keeps Goodreads' _Book Id_ as its edition's Goodreads id (`ext.goodreads`), with the edition's _Publisher_ and _Year Published_,
so a later export still finds it after you rename it; books already in the catalog get their Goodreads id
filled in the first time an export matches them. Goodreads puts the series in the title, as
`The First Adventure (Fantasy Adventures, #1)` or `The First Adventure: Fantasy Adventures, Book 1`; both
become the title `The First Adventure` in series `Fantasy Adventures`, number `1`.

## Export to Goodreads

**Download CSV** in the **Goodreads** panel of the _Import & export_ page downloads the catalog as a Goodreads library export,
the format Goodreads' [import page](https://www.goodreads.com/review/import) takes. Every book goes on the
_read_ shelf, also those with no date read (a missing date means unknown, not unread), with the series in
the title (`The First Adventure (Fantasy Adventures, #1)`), the first author as _Author_ and the rest as
_Additional Authors_, its genres as shelves (`Science Fiction` becomes `science-fiction`), and how many
dates read it has as _Read Count_. Goodreads keeps one date read, so a book gets its latest full date
(`2024-03-15` becomes `2024/03/15`); one read only in `2024-03` or `2024` goes without. Goodreads finds a
book by the _Book Id_ and ISBN of one of its editions (preferring one with both), else by title and
author; a box set's edition, shared with its other titles, is left out so Goodreads doesn't file each
title as the box set (the box set's own book, whose number is a range, goes by it). The page says how many books have no id or ISBN and how many no full date.
Our own Goodreads import reads the file back.

Books imported before titles were split this way (or by hand) are split when the catalog loads: a book with
no series gets the one in its title, and a book that already has that series just loses it from the title.
A book whose title names a different series or number than the one it has is left alone. **Check**
says how many titles still hold their series, and any save writes them split.
