"""Reader for a Goodreads library export (Settings > Import and export)."""
from __future__ import annotations

import csv
import re
from pathlib import Path

from .audible import ImportResult

# Goodreads has no "audiobook" flag; the edition's binding is the best signal there is.
AUDIO_BINDINGS = {"Audio CD", "Audiobook", "Audible Audio", "MP3 CD", "MP3 Book", "Audio"}

_PAREN = re.compile(r"^(.*?)\s*\(([^()]+)\)\s*$")


def parse_title(raw: str) -> tuple[str, str | None, str | None]:
    """'Frosted (Blaze, #6; Dana O'Hare, #1)' -> ('Frosted', 'Blaze', '6')."""
    m = _PAREN.match(raw.strip())
    if not m:
        return raw.strip(), None, None
    clean, inner = m.group(1).strip(), m.group(2).strip()
    first = inner.split(";")[0].strip()          # only the first series when several are listed
    name, _, tail = first.rpartition(",")
    if name and re.search(r"(#|\bbook\b|\bvol\b)", tail, re.IGNORECASE):
        num = re.search(r"\d+(?:\.\d+)?", tail)
        return clean, name.strip(), num.group(0) if num else None
    m2 = re.match(r"^(.*?)\s*#\s*(\d+(?:\.\d+)?)$", first)
    if m2:
        return clean, m2.group(1).strip(), m2.group(2)
    return clean, first, None


def read_library(path: Path) -> ImportResult:
    result = ImportResult()
    with open(path, newline="", encoding="utf-8-sig") as fh:
        for row in csv.DictReader(fh):
            if (row.get("Binding") or "").strip() not in AUDIO_BINDINGS:
                continue
            if (row.get("Exclusive Shelf") or "").strip() != "read":
                result.skipped_unfinished += 1
                continue
            title, series, number = parse_title(row.get("Title") or "")
            rec: dict = {"t": title, "a": (row.get("Author") or "").strip()}
            # Goodreads files narrators under "Additional Authors"; treat that as a best guess.
            narrator = (row.get("Additional Authors") or "").strip()
            if narrator:
                rec["n"] = narrator
            if series:
                rec["s"] = series
                if number:
                    rec["sn"] = number
            shelves = [s.strip() for s in (row.get("Bookshelves") or "").split(",") if s.strip()]
            if shelves:
                rec["g"] = shelves
            if rec["a"] and rec["t"]:
                result.records.append(rec)
    return result
