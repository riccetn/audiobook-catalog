# Merge a backup from another device

**Restore** replaces the catalogue with the backup, which loses any edits made here since. When both
sides have changed (books added, read or removed on the phone *and* on the PC), merge instead: **Merge**
on the *Import & export* page previews the result first, and changes nothing until you confirm it.

A backup has no record of what the two catalogues last had in common, so the merge works from what each
side has. Books are matched by title and author first, then by series and number, then by ASIN,
Goodreads or Hardcover id (so each title of a box set finds its own book).
- A book only the backup has is added, unless it is excluded here (you removed it here).
- A book only this side has stays, unless the backup newly excludes it (it was removed there, which
  always adds it to the exclusions); then it is removed here too.
- A book both have keeps all the genres, dates read and editions of both.
- Author info only the backup has is added.
- Where the title, author or series differ, and for series or author info both have but differently, this side's
  version is kept; choose *the backup's version* in the preview to take
  the backup's instead. The preview lists each such book.
- The backup's excluded books are added to those excluded here, and its **Not duplicates** marks to the
  marks here.

A book renamed on one side that has no ASIN or Goodreads id, and no series number, can't be matched,
so both names end up in the catalogue; the *Duplicates* page finds them for you to merge.
