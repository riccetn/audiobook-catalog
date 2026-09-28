import tempfile
import unittest
from pathlib import Path

from catalog.model import (
    Exclusions, book_keys, dump_books, dump_series_info, first_author, load_books, load_exclusions,
    load_series_info, lookup_keys, norm, normalize_author, series_norm, validate,
)


class Normalisation(unittest.TestCase):
    def test_series_norm_treats_spelling_variants_as_one_series(self):
        variants = ["Ember Coast", "Ember Coast Series", "The Ember-Coast series", "ember coast"]
        self.assertEqual(len({series_norm(v) for v in variants}), 1)
        self.assertEqual(series_norm("Salt-Marsh Hollow"), series_norm("Salt Marsh Hollow"))

    def test_series_norm_keeps_different_series_apart(self):
        self.assertNotEqual(series_norm("The Harbor Guild"), series_norm("The Ridge Guild"))

    def test_first_author_ignores_co_authors(self):
        self.assertEqual(first_author("R.T. Hale, C.J. Marsh"), first_author("R.T. Hale"))
        self.assertEqual(first_author("Ann Vale and P.T. Vale"), norm("Ann Vale"))

    def test_series_key_survives_a_title_edit(self):
        a = {"t": "A Spark of Dawn", "a": "Ilse Marlowe", "s": "A Crown of Embers", "sn": "5"}
        b = {"t": "A Crown of Embers 5: A Spark of Dawn", "a": "Ilse Marlowe", "s": "A Crown of Embers Series", "sn": "5"}
        self.assertEqual(set(book_keys(a)) & set(book_keys(b)), {book_keys(a)[0]})

    def test_lookup_keys_are_forgiving_in_one_direction_only(self):
        long_form = {"t": "A Crown of Embers 5: A Spark of Dawn", "a": "Ilse Marlowe"}
        self.assertIn(("title", norm("A Spark of Dawn"), norm("Ilse Marlowe")), lookup_keys(long_form))
        box = {"t": "Lantern of the Deep: Books 1-3", "a": "R.T. Hale"}
        self.assertNotIn(("title", norm("Lantern of the Deep"), norm("R.T. Hale")), lookup_keys(box))


class AuthorInitials(unittest.TestCase):
    def test_run_together_initials_get_a_space(self):
        cases = {
            "A.B. Quill": "A. B. Quill",
            "A. B. Quill": "A. B. Quill",                       # already fine: idempotent
            "A.B.C. Quill": "A. B. C. Quill",                   # any number of initials
            "Ann Vale, R.T. Hale": "Ann Vale, R. T. Hale",      # every name in a multi-author string
            "R.T. Hale and P.Q. Vale": "R. T. Hale and P. Q. Vale",
            "Ann Vale": "Ann Vale",
            "A. Quill": "A. Quill",                             # a single initial is untouched
            "Quill, A.B.": "Quill, A. B.",
        }
        for raw, expected in cases.items():
            self.assertEqual(normalize_author(raw), expected, raw)
            self.assertEqual(normalize_author(expected), expected, "idempotent: " + expected)

    def test_validation_warns_once_per_spelling(self):
        books = [{"t": "1", "a": "A.B. Quill"}, {"t": "2", "a": "A.B. Quill"}, {"t": "3", "a": "Ann Vale"}]
        warnings = validate(books, {})[1]
        self.assertEqual(len([w for w in warnings if "run-together initials" in w]), 1)
        self.assertIn("'A. B. Quill'", "\n".join(warnings))


class Storage(unittest.TestCase):
    def test_books_are_written_one_per_line_in_a_stable_key_order(self):
        books = [{"a": "X", "t": "Title", "g": ["Fantasy"], "id": "B0"}, {"t": "Ünï", "a": "Y"}]
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "books.json"
            dump_books(books, path)
            text = path.read_text(encoding="utf-8")
            self.assertEqual(text.splitlines()[1], '  {"t":"Title","a":"X","g":["Fantasy"],"id":"B0"},')
            self.assertIn("Ünï", text)                      # no \u escapes
            self.assertEqual(load_books(path), books)
            dump_books([], path)
            self.assertEqual(path.read_text(), "[]\n")

    def test_series_info_is_sorted_for_stable_diffs(self):
        info = {"b": {"total": 1}, "A": {"total": 2}}
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "s.json"
            dump_series_info(info, path)
            self.assertEqual(list(load_series_info(path)), ["A", "b"])

    def test_exclusions_accept_asins_and_title_author_pairs(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "excluded.txt"
            path.write_text("# comment\nB012345678  # trailing note\nSome Title | Some Author\n\n", encoding="utf-8")
            ex = load_exclusions(path)
        self.assertTrue(ex.covers({"t": "x", "a": "y", "id": "B012345678"}))
        self.assertTrue(ex.covers({"t": "SOME title!", "a": "Some Author"}))
        self.assertFalse(ex.covers({"t": "Other", "a": "Some Author"}))
        self.assertEqual(len(load_exclusions(Path("/nonexistent"))), 0)
        self.assertIsInstance(ex, Exclusions)


class Validation(unittest.TestCase):
    def errors(self, books, info=None):
        return validate(books, info or {})[0]

    def warnings(self, books, info=None):
        return validate(books, info or {})[1]

    def test_a_clean_catalogue_passes(self):
        books = [{"t": "A", "a": "B", "s": "S", "sn": "1", "g": ["x"], "id": "B0"}]
        info = {"S": {"total": 3, "status": "ongoing", "note": "n", "url": "https://example.com"}}
        self.assertEqual(validate(books, info), ([], []))

    def test_required_fields_and_unknown_keys(self):
        errors = self.errors([{"t": "", "a": "x"}, {"t": "t", "a": "a", "bogus": 1}, "nope"])
        self.assertEqual(len(errors), 3)

    def test_series_number_needs_a_series(self):
        self.assertTrue(any("no series" in e for e in self.errors([{"t": "t", "a": "a", "sn": "1"}])))

    def test_duplicate_ids_are_rejected(self):
        books = [{"t": "1", "a": "a", "id": "B0"}, {"t": "2", "a": "a", "id": "B0"}]
        self.assertTrue(any("duplicate id" in e for e in self.errors(books)))

    def test_series_info_must_match_a_series_and_be_well_formed(self):
        books = [{"t": "t", "a": "a", "s": "Real"}]
        errors = self.errors(books, {
            "Ghost": {"total": 2, "status": "ongoing", "note": "n"},
            "Real": {"total": 0, "status": "paused", "note": "", "url": "ftp://x", "extra": 1},
        })
        text = "\n".join(errors)
        for needle in ("'Ghost' matches no series", "status must be", "total must be", "note is required", "url must start", "unknown keys"):
            self.assertIn(needle, text)

    def test_many_is_an_allowed_total(self):
        books = [{"t": "t", "a": "a", "s": "S"}]
        self.assertEqual(self.errors(books, {"S": {"total": "many", "status": "ongoing", "note": "n"}}), [])

    def test_warnings_flag_lookalike_series_and_leftover_markup(self):
        books = [
            {"t": "1", "a": "a", "s": "Ember Coast"},
            {"t": "2", "a": "a", "s": "Ember Coast Series"},
            {"t": "3", "a": "a", "s": "Foo (book 1), Bar"},
            {"t": "4", "a": "a", "s": "Odd", "sn": "1, 1"},
        ]
        text = "\n".join(self.warnings(books))
        self.assertIn("look like the same series", text)
        self.assertIn("leftover Audible markup", text)
        self.assertIn("unusual series number", text)


if __name__ == "__main__":
    unittest.main()
