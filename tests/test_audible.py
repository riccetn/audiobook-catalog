import tempfile
import unittest
from pathlib import Path

from catalog.audible import choose_series, clean_title, parse_series_field, read_library, row_to_record

HEADER = "Title,Title Short,Series,Book Numbers,Authors,Narrators,Tags,Child Category,Progress,ASIN,Blurb\n"


class SeriesField(unittest.TestCase):
    def test_several_series_are_split_on_the_book_markers(self):
        self.assertEqual(parse_series_field("Thornmere: Wardens (book 1), Thornmere (book 5)"),
                         [("Thornmere: Wardens", "1"), ("Thornmere", "5")])

    def test_commas_inside_a_series_name_survive(self):
        self.assertEqual(parse_series_field("Vera Stone, Ghost Hunter (book 3)"), [("Vera Stone, Ghost Hunter", "3")])

    def test_empty_number_ranges_and_unnumbered_series(self):
        self.assertEqual(parse_series_field(""), [])
        self.assertEqual(parse_series_field(None), [])
        self.assertEqual(parse_series_field("The Aetherverse (book ), Side Projects (book 1)"),
                         [("The Aetherverse", None), ("Side Projects", "1")])
        self.assertEqual(parse_series_field("Brine Bound (books 1-4)"), [("Brine Bound", "1-4")])
        self.assertEqual(parse_series_field("Just A Name"), [("Just A Name", None)])

    def test_parent_series_beats_its_sub_series_in_either_order(self):
        for raw in ("Thornmere: Ferrymen (book 1), Thornmere (book 4)", "Thornmere (book 4), Thornmere: Ferrymen (book 1)"):
            self.assertEqual(choose_series(parse_series_field(raw)), ("Thornmere", "4", False))

    def test_unrelated_series_pick_the_first_and_flag_it(self):
        self.assertEqual(choose_series([("A", "1"), ("B", "2")]), ("A", "1", True))
        self.assertEqual(choose_series([]), (None, None, False))


class Titles(unittest.TestCase):
    def test_trailing_series_number_is_dropped_only_when_it_matches(self):
        self.assertEqual(clean_title("Lantern of the Deep 10", "10"), "Lantern of the Deep")
        self.assertEqual(clean_title("Emberhart: 2", "2"), "Emberhart")
        self.assertEqual(clean_title("Marsh Kisses", "1"), "Marsh Kisses")
        self.assertEqual(clean_title("Mort", None), "Mort")
        self.assertEqual(clean_title("7", "7"), "7")               # never produce an empty title


class Rows(unittest.TestCase):
    base = {"Title": "T", "Title Short": "Ts", "Authors": "A", "Progress": "Finished", "ASIN": "B0000000A1"}

    def row(self, **kw):
        return {**self.base, **kw}

    def test_finished_book_becomes_a_record(self):
        rec, warning = row_to_record(self.row(Series="S (book 2)", Narrators="N", Tags="Fantasy, Magic"))
        self.assertEqual(rec, {"t": "Ts", "a": "A", "n": "N", "s": "S", "sn": "2", "g": ["Fantasy", "Magic"], "id": "B0000000A1"})
        self.assertIsNone(warning)

    def test_author_initials_are_spaced(self):
        rec, _ = row_to_record(self.row(Authors="A.B. Quill, Ann Vale"))
        self.assertEqual(rec["a"], "A. B. Quill, Ann Vale")

    def test_unfinished_books_and_the_audible_sample_are_ignored(self):
        self.assertEqual(row_to_record(self.row(Progress="3h left")), (None, None))
        self.assertEqual(row_to_record(self.row(ASIN="B002V8N37Q")), (None, None))

    def test_falls_back_to_category_and_to_the_book_numbers_column(self):
        rec, _ = row_to_record(self.row(Series="S", **{"Book Numbers": "4, 1", "Child Category": "Epic"}))
        self.assertEqual((rec["sn"], rec["g"]), ("4", ["Epic"]))

    def test_ambiguous_series_produce_a_warning(self):
        rec, warning = row_to_record(self.row(Series="A (book 1), B (book 2)"))
        self.assertEqual(rec["s"], "A")
        self.assertIn("several series", warning)

    def test_read_library_handles_bom_quoted_newlines_and_counts(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "lib.csv"
            path.write_text(
                "\ufeff" + HEADER
                + 'T1,T1,S (book 1),1,Au,Na,"a, b",,Finished,B1,"multi\nline blurb"\n'
                + "T2,T2,,,Au,,,,1h left,B2,\n"
                + "Your First Listen,Your First Listen,,,Audible,,,,Finished,B002V8N37Q,\n"
                + "T3,T3,,,,,,,Finished,B3,\n",
                encoding="utf-8",
            )
            result = read_library(path)
        self.assertEqual([r["t"] for r in result.records], ["T1"])
        self.assertEqual(result.skipped_unfinished, 1)
        self.assertTrue(any("no author" in w for w in result.warnings))


if __name__ == "__main__":
    unittest.main()
