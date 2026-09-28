"""Reader for the Audible Library Extractor (ALE) spreadsheet export."""
from __future__ import annotations

import csv
import re
from dataclasses import dataclass, field
from pathlib import Path

from .model import normalize_author

# Audible's built-in "Your First Listen" sample appears in every library.
SAMPLE_ASINS = {"B002V8N37Q"}

# "Thornmere: Wardens (book 3), Thornmere (book 5)": anchor on the "(book N)" markers,
# because series names themselves can contain commas ("Vera Stone, Ghost Hunter").
_SERIES_PART = re.compile(r"\s*(.+?)\s*\(books?\s*([^)]*)\)\s*(?:,|$)", re.IGNORECASE)


def parse_series_field(raw: str | None) -> list[tuple[str, str | None]]:
    raw = (raw or "").strip()
    pairs: list[tuple[str, str | None]] = []
    pos = 0
    while pos < len(raw):
        m = _SERIES_PART.match(raw, pos)
        if not m:
            break
        pairs.append((m.group(1).strip(), m.group(2).strip() or None))
        pos = m.end()
    rest = raw[pos:].strip(" ,")
    if rest:
        pairs.append((rest, None))
    return pairs


def choose_series(pairs: list[tuple[str, str | None]]) -> tuple[str | None, str | None, bool]:
    """Pick one series when Audible lists several. Returns (name, number, was_ambiguous).

    A parent series wins over its sub-series ("Thornmere" over "Thornmere: Wardens"),
    which keeps a sprawling universe together. Otherwise the first listed wins and the
    caller is told so it can flag the book for review.
    """
    if not pairs:
        return None, None, False
    if len(pairs) == 1:
        return pairs[0][0], pairs[0][1], False
    names = [name for name, _ in pairs]
    for name, number in pairs:
        if all(other == name or other.startswith(name + ":") for other in names):
            return name, number, False
    return pairs[0][0], pairs[0][1], True


def clean_title(title: str, number: str | None) -> str:
    """Drop a trailing series number that Audible bakes into short titles ("Lantern of the Deep 10")."""
    title = title.strip()
    if number:
        stripped = re.sub(r"[\s:,\-]+" + re.escape(number.strip()) + r"\s*$", "", title)
        if stripped:
            return stripped
    return title


@dataclass
class ImportResult:
    records: list[dict] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    skipped_unfinished: int = 0


def row_to_record(row: dict) -> tuple[dict | None, str | None]:
    """Convert one CSV row. Returns (record or None, warning or None)."""
    if (row.get("Progress") or "").strip() != "Finished":
        return None, None
    asin = (row.get("ASIN") or "").strip()
    if asin in SAMPLE_ASINS:
        return None, None

    series, number, ambiguous = choose_series(parse_series_field(row.get("Series")))
    if series and number is None:
        first_number = (row.get("Book Numbers") or "").split(",")[0].strip()
        number = first_number or None

    title = (row.get("Title Short") or row.get("Title") or "").strip()
    rec: dict = {"t": clean_title(title, number if series else None), "a": normalize_author((row.get("Authors") or "").strip())}
    narrator = (row.get("Narrators") or "").strip()
    if narrator:
        rec["n"] = narrator
    if series:
        rec["s"] = series
        if number:
            rec["sn"] = number
    tags = [t.strip() for t in (row.get("Tags") or "").split(",") if t.strip()]
    if not tags and (row.get("Child Category") or "").strip():
        tags = [row["Child Category"].strip()]
    if tags:
        rec["g"] = tags
    if asin:
        rec["id"] = asin

    warning = None
    if ambiguous:
        warning = f"{rec['t']!r}: belongs to several series ({row.get('Series')}); using {series!r}"
    return rec, warning


def read_library(path: Path) -> ImportResult:
    result = ImportResult()
    with open(path, newline="", encoding="utf-8-sig") as fh:
        for row in csv.DictReader(fh):
            rec, warning = row_to_record(row)
            if rec is None:
                if (row.get("Progress") or "").strip() != "Finished" and (row.get("ASIN") or "").strip() not in SAMPLE_ASINS:
                    result.skipped_unfinished += 1
                continue
            if not rec["a"]:
                result.warnings.append(f"{rec['t']!r}: no author in the export, skipped")
                continue
            result.records.append(rec)
            if warning:
                result.warnings.append(warning)
    return result
