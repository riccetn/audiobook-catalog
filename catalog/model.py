"""Data model: loading/saving, name normalisation, de-duplication keys and validation.

A book record uses short keys so the embedded page stays small:

    t   title (required)
    a   author (required)
    n   narrator(s)
    s   series name
    sn  position in the series, as text ("3", "4-6" for a boxed set)
    g   list of genre/tag strings
    id  Audible ASIN, used to recognise the same book on re-import
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path

BOOK_KEYS = ("t", "a", "n", "s", "sn", "g", "id")
STATUSES = {"ongoing", "complete"}
_SERIES_NUMBER = re.compile(r"^\d+(\.\d+)?(-\d+(\.\d+)?)?$")


# ---------------------------------------------------------------- normalisation
def norm(text: str | None) -> str:
    """Lower-case and collapse everything that is not a letter or digit."""
    return re.sub(r"[^a-z0-9]+", " ", (text or "").lower()).strip()


def series_norm(name: str | None) -> str:
    """Key under which two series names count as the same series.

    'Ember Coast' == 'Ember Coast Series' == 'The Ember-Coast series'.
    """
    n = norm(name)
    n = re.sub(r"^the\s+", "", n)
    n = re.sub(r"\bseries\b", "", n)
    return re.sub(r"[^a-z0-9]", "", n)


_RUN_TOGETHER_INITIALS = re.compile(r"\b([A-Z])\.(?=[A-Z]\.)")
_INVISIBLE = re.compile("[\u200b\ufeff]")


def tidy_text(text: str) -> str:
    """Trim and collapse whitespace: tabs, newlines, non-breaking spaces and runs of spaces become one space."""
    return re.sub(r"\s+", " ", _INVISIBLE.sub("", text)).strip()


def normalize_name(name: str) -> str:
    """Tidy a person's name (authors and narrators) and space out run-together initials.

    "A.B.  Quill" -> "A. B. Quill". Works on multi-name strings too: "Ann Vale, A.B. Quill".
    """
    return _RUN_TOGETHER_INITIALS.sub(r"\1. ", tidy_text(name))


def tidy_book(rec: dict) -> dict:
    """Return a copy of a book record with tidy text in every field (see normalize_name / tidy_text)."""
    out = dict(rec)
    for key in ("t", "s", "sn", "id"):
        if isinstance(out.get(key), str):
            out[key] = tidy_text(out[key])
    for key in ("a", "n"):
        if isinstance(out.get(key), str):
            out[key] = normalize_name(out[key])
    if isinstance(out.get("g"), list):
        out["g"] = [tidy_text(x) if isinstance(x, str) else x for x in out["g"]]
        out["g"] = [x for x in out["g"] if x != ""]
    return out


def first_author(authors: str | None) -> str:
    return norm(re.split(r",| and | & ", authors or "")[0])


def book_keys(rec: dict) -> list[tuple]:
    """Identity keys for a book, strongest first.

    The series key survives title edits, which is why it comes before the title key.
    """
    keys: list[tuple] = []
    if rec.get("id"):
        keys.append(("id", rec["id"]))
    if rec.get("s") and rec.get("sn"):
        keys.append(("series", first_author(rec["a"]), series_norm(rec["s"]), str(rec["sn"]).strip()))
    keys.append(("title", norm(rec["t"]), first_author(rec["a"])))
    return keys


def lookup_keys(rec: dict) -> list[tuple]:
    """Keys used to *find* an incoming record among existing books.

    Adds forgiving title variants, because catalogue titles are often hand-cleaned while
    Audible keeps the long form: "A Crown of Embers 5: A Spark of Dawn" -> "A Spark of Dawn",
    "A Crown of Embers, Book 1" -> "A Crown of Embers". Deliberately one-directional
    (long incoming vs short existing) so a boxed set is never mistaken for its first book.
    """
    keys = book_keys(rec)
    author = first_author(rec["a"])
    title = rec["t"]
    variants = []
    if ":" in title:
        variants.append(title.rsplit(":", 1)[1])
    stripped = re.sub(r",?\s*\bbook\s*\d+\s*$", "", title, flags=re.IGNORECASE)
    if stripped != title:
        variants.append(stripped)
    for v in variants:
        key = ("title", norm(v), author)
        if norm(v) and key not in keys:
            keys.append(key)
    return keys


# ------------------------------------------------------------------ data location
DATA_DIR_ENV = "CATALOG_DATA_DIR"


def live_data_dir(root: Path, override: Path | None = None) -> Path:
    """Where *your* catalogue lives: --data-dir, else $CATALOG_DATA_DIR, else <root>/data (git-ignored)."""
    if override:
        return Path(override).expanduser()
    if os.environ.get(DATA_DIR_ENV):
        return Path(os.environ[DATA_DIR_ENV]).expanduser()
    return Path(root) / "data"


def data_dir(root: Path, override: Path | None = None) -> Path:
    """Directory to read from. With nothing configured and no data/books.json yet, use the bundled demo."""
    live = live_data_dir(root, override)
    explicit = bool(override or os.environ.get(DATA_DIR_ENV))
    if explicit or (live / "books.json").exists():
        return live
    return live / "sample"


def is_demo(root: Path, path: Path) -> bool:
    return Path(path) == Path(root) / "data" / "sample"


# ------------------------------------------------------------------- load / save
def load_books(path: Path) -> list[dict]:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def _record_line(book: dict) -> str:
    ordered = {k: book[k] for k in BOOK_KEYS if k in book}
    ordered.update({k: v for k, v in book.items() if k not in BOOK_KEYS})
    return json.dumps(ordered, ensure_ascii=False, separators=(",", ":"))


def dump_books(books: list[dict], path: Path) -> None:
    """One record per line, so git diffs show exactly which books changed."""
    if not books:
        text = "[]\n"
    else:
        text = "[\n" + ",\n".join("  " + _record_line(b) for b in books) + "\n]\n"
    Path(path).write_text(text, encoding="utf-8")


def load_series_info(path: Path) -> dict:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def dump_series_info(info: dict, path: Path) -> None:
    ordered = {name: info[name] for name in sorted(info, key=str.casefold)}
    Path(path).write_text(json.dumps(ordered, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


class Exclusions:
    """Books that imports must never re-add (because you removed them on purpose)."""

    def __init__(self, ids: set[str] | None = None, titles: set[tuple[str, str]] | None = None):
        self.ids = ids or set()
        self.titles = titles or set()

    def covers(self, rec: dict) -> bool:
        return rec.get("id") in self.ids or (norm(rec["t"]), first_author(rec["a"])) in self.titles

    def __len__(self) -> int:
        return len(self.ids) + len(self.titles)


def load_exclusions(path: Path) -> Exclusions:
    """Read data/excluded.txt. One entry per line, '#' starts a comment:

        B0XXXXXXXX                 an Audible ASIN
        Some Title | Some Author   for books that have no ASIN (e.g. Goodreads-only entries)
    """
    path = Path(path)
    ex = Exclusions()
    if not path.exists():
        return ex
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.split("#", 1)[0].strip()
        if not line:
            continue
        if "|" in line:
            title, author = (part.strip() for part in line.split("|", 1))
            ex.titles.add((norm(title), first_author(author)))
        else:
            ex.ids.add(line)
    return ex


# ---------------------------------------------------------------------- validate
def validate(books: list[dict], info: dict) -> tuple[list[str], list[str]]:
    """Return (errors, warnings). Errors block imports and syncs; warnings are worth a look."""
    errors: list[str] = []
    warnings: list[str] = []

    if not isinstance(books, list):
        return ["books.json must contain a list"], warnings

    seen_ids: dict[str, str] = {}
    for i, b in enumerate(books):
        label = f"book #{i} ({b.get('t', '?')!r})" if isinstance(b, dict) else f"book #{i}"
        if not isinstance(b, dict):
            errors.append(f"{label}: not an object")
            continue
        for key in b:
            if key not in BOOK_KEYS:
                errors.append(f"{label}: unknown key {key!r}")
        for key in ("t", "a"):
            if not isinstance(b.get(key), str) or not b[key].strip():
                errors.append(f"{label}: missing {key!r}")
        for key in ("n", "s", "sn", "id"):
            if key in b and (not isinstance(b[key], str) or not b[key].strip()):
                errors.append(f"{label}: {key!r} must be a non-empty string when present")
        if "g" in b and not (isinstance(b["g"], list) and all(isinstance(x, str) and x.strip() for x in b["g"])):
            errors.append(f"{label}: 'g' must be a list of non-empty strings")
        if b.get("sn") and not b.get("s"):
            errors.append(f"{label}: has a series number but no series")
        if b.get("sn") and isinstance(b["sn"], str) and not _SERIES_NUMBER.match(b["sn"].strip()):
            warnings.append(f"{label}: unusual series number {b['sn']!r}")
        if b.get("id"):
            if b["id"] in seen_ids:
                errors.append(f"{label}: duplicate id {b['id']} (also {seen_ids[b['id']]})")
            seen_ids[b["id"]] = label

    series_names = {b["s"] for b in books if isinstance(b, dict) and b.get("s")}

    untidy: dict[tuple[str, str], str] = {}
    labels = {"t": "title", "a": "author", "n": "narrator", "s": "series", "g": "genre"}
    for book in books:
        if not isinstance(book, dict):
            continue
        for key, label in labels.items():
            values = book.get(key)
            for value in (values if isinstance(values, list) else [values]):
                if not isinstance(value, str):
                    continue
                expected = normalize_name(value) if key in ("a", "n") else tidy_text(value)
                if expected != value:
                    untidy[(label, value)] = expected
    for (label, value), expected in sorted(untidy.items()):
        warnings.append(f"{label} {value!r} has stray spacing or run-together initials; use {expected!r}")

    for name in sorted(series_names):
        if re.search(r"\(books?\b", name, re.IGNORECASE):
            warnings.append(f"series name {name!r} looks like leftover Audible markup (several series joined together?)")

    by_norm: dict[str, set[str]] = {}
    for name in series_names:
        by_norm.setdefault(series_norm(name), set()).add(name)
    for variants in by_norm.values():
        if len(variants) > 1:
            warnings.append("series names that look like the same series: " + " / ".join(sorted(variants)))

    for name, entry in info.items():
        if name not in series_names:
            errors.append(f"series-info: {name!r} matches no series in books.json")
        if not isinstance(entry, dict):
            errors.append(f"series-info[{name!r}]: not an object")
            continue
        if entry.get("status") not in STATUSES:
            errors.append(f"series-info[{name!r}]: status must be one of {sorted(STATUSES)}")
        total = entry.get("total")
        if not (isinstance(total, int) and not isinstance(total, bool) and total > 0) and total != "many":
            errors.append(f"series-info[{name!r}]: total must be a positive integer (or \"many\")")
        if not isinstance(entry.get("note"), str) or not entry["note"].strip():
            errors.append(f"series-info[{name!r}]: note is required")
        if "url" in entry and not (isinstance(entry["url"], str) and entry["url"].startswith(("http://", "https://"))):
            errors.append(f"series-info[{name!r}]: url must start with http:// or https://")
        unknown = set(entry) - {"total", "status", "note", "url"}
        if unknown:
            errors.append(f"series-info[{name!r}]: unknown keys {sorted(unknown)}")
    return errors, warnings
