import json
import re
import shutil
import tempfile
import unittest
from pathlib import Path

from catalog.build import render
from catalog.model import dump_books, dump_series_info

ROOT = Path(__file__).resolve().parent.parent


def embedded(html, tag):
    return json.loads(re.search(rf'<script type="application/json" id="{tag}">(.*?)</script>', html, re.S).group(1))


class Build(unittest.TestCase):
    def make_root(self, books, info=None):
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, True)
        shutil.copytree(ROOT / "src", tmp / "src")
        (tmp / "data").mkdir()
        dump_books(books, tmp / "data" / "books.json")
        dump_series_info(info or {}, tmp / "data" / "series-info.json")
        return tmp

    def test_the_real_project_builds_a_complete_page(self):
        html = render(ROOT)
        self.assertIsNone(re.search(r"\{\{[A-Z_]+\}\}", html), "an unreplaced placeholder is left in the page")
        self.assertEqual(html, render(ROOT), "build output must be deterministic")
        self.assertTrue(html.startswith("<!DOCTYPE html>"))
        self.assertEqual(embedded(html, "ui-state")["view"], "series")

    def test_embedded_data_round_trips(self):
        books = [{"t": "Tést", "a": "Åuthor", "s": "S", "sn": "1"}]
        info = {"S": {"total": 2, "status": "ongoing", "note": "n"}}
        html = render(self.make_root(books, info))
        self.assertEqual(embedded(html, "book-data"), books)
        self.assertEqual(embedded(html, "series-info"), info)

    def test_hostile_titles_cannot_break_out_of_the_script_tag(self):
        books = [{"t": "</script><script>alert(1)</script><!--", "a": "x"}]
        html = render(self.make_root(books))
        self.assertEqual(html.count("</script>"), 4)                # exactly the four real ones
        self.assertEqual(embedded(html, "book-data"), books)

    def test_invalid_data_refuses_to_build(self):
        with self.assertRaises(ValueError):
            render(self.make_root([{"t": "no author"}]))


if __name__ == "__main__":
    unittest.main()
