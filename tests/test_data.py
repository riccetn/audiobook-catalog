"""Guards the data files. The demo data is always checked; your own data too, when it is present."""
import tempfile
import unittest
from pathlib import Path

from catalog.model import dump_books, dump_series_info, load_books, load_series_info, validate

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"


def canonical(folder: Path) -> bool:
    with tempfile.TemporaryDirectory() as d:
        books, info = Path(d) / "b.json", Path(d) / "s.json"
        dump_books(load_books(folder / "books.json"), books)
        dump_series_info(load_series_info(folder / "series-info.json"), info)
        return (books.read_text(encoding="utf-8") == (folder / "books.json").read_text(encoding="utf-8")
                and info.read_text(encoding="utf-8") == (folder / "series-info.json").read_text(encoding="utf-8"))


class DemoData(unittest.TestCase):
    folder = DATA / "sample"

    def test_validates_without_errors_or_warnings(self):
        self.assertEqual(validate(load_books(self.folder / "books.json"), load_series_info(self.folder / "series-info.json")),
                         ([], []))

    def test_is_in_canonical_layout(self):
        self.assertTrue(canonical(self.folder), "run `make format` (on your own data) or regenerate the demo files")

    def test_has_what_the_smoke_test_needs(self):
        books = load_books(self.folder / "books.json")
        self.assertTrue(any(not b.get("s") for b in books), "needs standalone books")
        self.assertTrue(any(b.get("s") for b in books), "needs series")


@unittest.skipUnless((DATA / "books.json").exists(), "no personal data/books.json (fine: it is git-ignored)")
class OwnData(unittest.TestCase):
    def test_validates_without_errors(self):
        errors, _ = validate(load_books(DATA / "books.json"), load_series_info(DATA / "series-info.json"))
        self.assertEqual(errors, [])

    def test_is_in_canonical_layout(self):
        self.assertTrue(canonical(DATA), "run `make format`")


if __name__ == "__main__":
    unittest.main()
