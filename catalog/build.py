"""Assemble the single-file page: src/ template + styles + script + data -> dist/."""
from __future__ import annotations

import json
import re
from pathlib import Path

from .model import data_dir, load_books, load_series_info, validate

DEFAULT_UI_STATE = {"view": "series", "filter": None, "q": "", "authorFilter": "", "genreFilter": ""}


def _embed_json(value) -> str:
    """Compact JSON that is safe inside a <script> element."""
    text = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    # "<" as a JSON unicode escape means "</script>" and "<!--" can never appear in the page source.
    return text.replace("<", "\\u003c")


def render(root: Path, data: Path | None = None) -> str:
    """`data` is a directory holding books.json and series-info.json (default: see model.data_dir)."""
    root = Path(root)
    data = data_dir(root, data)
    books = load_books(data / "books.json")
    info = load_series_info(data / "series-info.json")
    errors, _ = validate(books, info)
    if errors:
        raise ValueError("data failed validation:\n  " + "\n  ".join(errors[:20]))

    parts = {
        "STYLES": (root / "src" / "styles.css").read_text(encoding="utf-8").rstrip("\n"),
        "APP_JS": (root / "src" / "app.js").read_text(encoding="utf-8").rstrip("\n"),
        "BOOK_DATA": _embed_json(books),
        "SERIES_INFO": _embed_json(info),
        "UI_STATE": _embed_json(DEFAULT_UI_STATE),
    }
    template = (root / "src" / "index.template.html").read_text(encoding="utf-8")
    # One pass, so text inside the inserted parts is never re-scanned for placeholders.
    return re.sub(r"\{\{([A-Z_]+)\}\}", lambda m: parts[m.group(1)], template)


def build(root: Path, out: Path | None = None, data: Path | None = None) -> Path:
    root = Path(root)
    out = Path(out) if out else root / "dist" / "audiobook-catalog.html"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(render(root, data), encoding="utf-8")
    return out
