"""Merge freshly imported records into the catalogue without clobbering hand edits."""
from __future__ import annotations

from dataclasses import dataclass, field

from .model import Exclusions, book_keys, lookup_keys, series_norm


@dataclass
class MergeReport:
    added: list[dict] = field(default_factory=list)
    backfilled: list[dict] = field(default_factory=list)   # existing books that just gained an Audible id
    excluded: list[dict] = field(default_factory=list)     # skipped because they are listed in excluded.txt
    matched: int = 0


def merge(existing: list[dict], incoming: list[dict], exclusions: Exclusions | None = None) -> MergeReport:
    """Append records that are not in `existing` yet (mutates `existing`).

    * An existing book always wins: titles, series and genres you edited are never overwritten.
    * The one exception is a missing `id`: if an incoming Audible record matches an existing book
      that has none, the id is filled in, so later imports recognise it even after more edits.
    * Series names are folded onto spellings already in use ("Ember Coast Series" -> "Ember Coast").
    """
    exclusions = exclusions or Exclusions()
    report = MergeReport()

    index: dict[tuple, int] = {}
    for i, rec in enumerate(existing):
        for key in book_keys(rec):
            index.setdefault(key, i)

    canonical: dict[str, str] = {}
    for rec in existing:
        if rec.get("s"):
            canonical.setdefault(series_norm(rec["s"]), rec["s"])

    for rec in incoming:
        rec = dict(rec)
        if rec.get("s"):
            rec["s"] = canonical.setdefault(series_norm(rec["s"]), rec["s"])

        match = next((index[k] for k in lookup_keys(rec) if k in index), None)
        if match is not None:
            report.matched += 1
            if rec.get("id") and not existing[match].get("id"):
                existing[match]["id"] = rec["id"]
                report.backfilled.append(existing[match])
                index.setdefault(("id", rec["id"]), match)
            continue
        if exclusions.covers(rec):
            report.excluded.append(rec)
            continue
        existing.append(rec)
        report.added.append(rec)
        for key in book_keys(rec):
            index.setdefault(key, len(existing) - 1)
    return report
