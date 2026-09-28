"""Command line entry point:  python -m catalog <command>"""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

from . import audible, goodreads
from .build import build
from .merge import merge
from .model import (
    data_dir, dump_books, dump_series_info, is_demo, live_data_dir, load_books, load_exclusions,
    load_series_info, tidy_book, validate,
)

ROOT = Path(__file__).resolve().parent.parent


def _paths(args):
    d = args.data
    return d / "books.json", d / "series-info.json", d / "excluded.txt"


def _shown(path: Path, root: Path) -> str:
    try:
        return str(path.relative_to(root))
    except ValueError:
        return str(path)


DEMO_NOTE = ("note: no data/books.json found, so this is the bundled demo data (data/sample). "
             "Run `python -m catalog init` to start your own catalogue.")


def _require_own_data(args) -> bool:
    """Commands that write must never touch the demo data."""
    if is_demo(args.root, args.data):
        print("No catalogue data yet. Run `python -m catalog init` first "
              "(or `init --sample` to start from the demo data).", file=sys.stderr)
        return False
    return True


def _preview(records, limit=15):
    for rec in records[:limit]:
        series = f"  [{rec['s']} #{rec['sn']}]" if rec.get("s") and rec.get("sn") else (f"  [{rec['s']}]" if rec.get("s") else "")
        print(f"    + {rec['t']} - {rec['a']}{series}")
    if len(records) > limit:
        print(f"    ... and {len(records) - limit} more")


def _run_import(args, reader, label) -> int:
    if not _require_own_data(args):
        return 2
    books_path, info_path, excluded_path = _paths(args)
    books = load_books(books_path)
    result = reader.read_library(args.file)
    report = merge(books, result.records, load_exclusions(excluded_path))

    print(f"{label}: {len(result.records)} finished books read from {args.file.name}")
    print(f"  already in the catalogue: {report.matched}")
    if report.backfilled:
        print(f"  Audible ids filled in on existing books: {len(report.backfilled)}")
    if report.excluded:
        print(f"  skipped (listed in data/excluded.txt): {len(report.excluded)}")
    print(f"  new: {len(report.added)}")
    _preview(report.added)
    if result.warnings:
        print(f"  needs a look ({len(result.warnings)}):")
        for w in result.warnings[:15]:
            print("    ! " + w)

    errors, _ = validate(books, load_series_info(info_path))
    if errors:
        print("Validation failed, nothing written:\n  " + "\n  ".join(errors[:10]), file=sys.stderr)
        return 1
    if args.dry_run:
        print("(dry run: nothing written)")
        return 0
    dump_books(books, books_path)
    print(f"wrote {_shown(books_path, args.root)}")
    return 0


def cmd_import_audible(args) -> int:
    return _run_import(args, audible, "Audible")


def cmd_import_goodreads(args) -> int:
    return _run_import(args, goodreads, "Goodreads")


def cmd_validate(args) -> int:
    books_path, info_path, _ = _paths(args)
    if is_demo(args.root, args.data):
        print(DEMO_NOTE)
    books, info = load_books(books_path), load_series_info(info_path)
    errors, warnings = validate(books, info)
    for w in warnings:
        print("warning: " + w)
    for e in errors:
        print("error: " + e)
    series = {b["s"] for b in books if b.get("s")}
    print(f"{len(books)} books, {len(series)} series, {len(info)} with release info; "
          f"{len(errors)} error(s), {len(warnings)} warning(s)")
    return 1 if errors else 0


EXCLUDED_HEADER = """# Books that imports must never re-add (because you removed them on purpose).
# One entry per line; anything after '#' is a comment. Either:
#   B0XXXXXXXX                  an Audible ASIN
#   Some Title | Some Author    for books with no ASIN (e.g. Goodreads-only entries)
"""


def cmd_init(args) -> int:
    """Create your own (git-ignored) data files, empty or copied from the demo data."""
    target = live_data_dir(args.root, args.data_dir)
    books_path, info_path, excluded_path = target / "books.json", target / "series-info.json", target / "excluded.txt"
    if books_path.exists():
        print(f"{_shown(books_path, args.root)} already exists; not touching it.", file=sys.stderr)
        return 1
    target.mkdir(parents=True, exist_ok=True)
    (target / "raw").mkdir(exist_ok=True)
    if args.sample:
        demo = args.root / "data" / "sample"
        dump_books(load_books(demo / "books.json"), books_path)
        dump_series_info(load_series_info(demo / "series-info.json"), info_path)
    else:
        dump_books([], books_path)
        dump_series_info({}, info_path)
    if not excluded_path.exists():
        excluded_path.write_text(EXCLUDED_HEADER, encoding="utf-8")
    print(f"created {_shown(target, args.root)}/ with books.json, series-info.json and excluded.txt")
    print("next: save your Audible export in its raw/ folder and run `python -m catalog import-audible <file>`")
    return 0


def cmd_format(args) -> int:
    """Rewrite data/*.json in the canonical layout (one book per line, series-info sorted)."""
    if not _require_own_data(args):
        return 2
    books_path, info_path, _ = _paths(args)
    dump_books(load_books(books_path), books_path)
    dump_series_info(load_series_info(info_path), info_path)
    print("data files rewritten in canonical layout")
    return 0


def cmd_build(args) -> int:
    if is_demo(args.root, args.data):
        print(DEMO_NOTE)
    out = build(args.root, args.out, args.data)
    print(f"built {out} ({out.stat().st_size / 1024:.0f} KB)")
    return 0


def cmd_sync_export(args) -> int:
    """Replace data/books.json with a backup exported from the app (Export button)."""
    if not _require_own_data(args):
        return 2
    books_path, info_path, _ = _paths(args)
    try:
        new_books = json.loads(args.file.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"cannot read {args.file}: {exc}", file=sys.stderr)
        return 1
    errors, _ = validate(new_books, load_series_info(info_path))
    # series-info problems are expected if a series was renamed/removed in the app; report but do not block on those
    blocking = [e for e in errors if not e.startswith("series-info")]
    if blocking:
        print("Not a valid catalogue export:\n  " + "\n  ".join(blocking[:10]), file=sys.stderr)
        return 1
    tidied_books = [tidy_book(book) for book in new_books]      # the app's edit form does not enforce tidy text
    tidied = sum(1 for before, after in zip(new_books, tidied_books) if before != after)
    new_books = tidied_books
    if tidied:
        print(f"tidied stray spacing / run-together initials on {tidied} book(s)")
    old_books = load_books(books_path)
    before = Counter((b["t"], b["a"]) for b in old_books)
    after = Counter((b["t"], b["a"]) for b in new_books)
    gone, new = list((before - after).elements()), list((after - before).elements())
    print(f"{len(old_books)} -> {len(new_books)} books; {len(new)} new/renamed, {len(gone)} removed/renamed")
    for title, author in new[:10]:
        print(f"    + {title} - {author}")
    for title, author in gone[:10]:
        print(f"    - {title} - {author}")
    if args.dry_run:
        print("(dry run: nothing written)")
        return 0
    dump_books(new_books, books_path)
    print(f"wrote {_shown(books_path, args.root)}")
    orphaned = [e for e in errors if e.startswith("series-info")]
    if orphaned:
        print("series-info needs attention:\n  " + "\n  ".join(orphaned))
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="python -m catalog", description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT, help="project root (default: this checkout)")
    parser.add_argument("--data-dir", type=Path, default=None,
                        help="folder with books.json and series-info.json (default: $CATALOG_DATA_DIR, "
                             "then ./data, then the bundled demo)")
    sub = parser.add_subparsers(dest="command", required=True)

    for name, func, helptext in (
        ("import-audible", cmd_import_audible, "add new finished books from an Audible Library Extractor CSV"),
        ("import-goodreads", cmd_import_goodreads, "add audiobooks from a Goodreads library export CSV"),
    ):
        p = sub.add_parser(name, help=helptext)
        p.add_argument("file", type=Path)
        p.add_argument("--dry-run", action="store_true", help="show what would change without writing")
        p.set_defaults(func=func)

    p = sub.add_parser("init", help="create your own git-ignored data files")
    p.add_argument("--sample", action="store_true", help="start from the demo data instead of an empty catalogue")
    p.set_defaults(func=cmd_init)

    p = sub.add_parser("validate", help="check data/ for problems")
    p.set_defaults(func=cmd_validate)

    p = sub.add_parser("format", help="rewrite data/*.json in the canonical layout")
    p.set_defaults(func=cmd_format)

    p = sub.add_parser("build", help="write dist/audiobook-catalog.html")
    p.add_argument("--out", type=Path)
    p.set_defaults(func=cmd_build)

    p = sub.add_parser("sync-export", help="adopt a JSON backup exported from the app as data/books.json")
    p.add_argument("file", type=Path)
    p.add_argument("--dry-run", action="store_true")
    p.set_defaults(func=cmd_sync_export)

    args = parser.parse_args(argv)
    args.root = Path(args.root).resolve()
    args.data = data_dir(args.root, args.data_dir)
    try:
        return args.func(args)
    except FileNotFoundError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
