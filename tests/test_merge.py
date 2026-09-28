import copy
import unittest

from catalog.merge import merge
from catalog.model import Exclusions


def book(t, a="Author", **kw):
    return {"t": t, "a": a, **kw}


class Merging(unittest.TestCase):
    def test_new_books_are_appended_and_the_merge_is_idempotent(self):
        existing = [book("One")]
        incoming = [book("One"), book("Two", id="B2")]
        report = merge(existing, incoming)
        self.assertEqual([b["t"] for b in existing], ["One", "Two"])
        self.assertEqual((report.matched, len(report.added)), (1, 1))
        again = merge(existing, copy.deepcopy(incoming))
        self.assertEqual(len(again.added), 0)
        self.assertEqual(len(existing), 2)

    def test_hand_edits_win_but_a_missing_id_is_filled_in(self):
        existing = [book("A Spark of Dawn", a="Ilse Marlowe", s="A Crown of Embers", sn="5", g=["Mine"])]
        incoming = [book("A Crown of Embers 5: A Spark of Dawn", a="Ilse Marlowe", s="A Crown of Embers Series", sn="5",
                         g=["Theirs"], id="B5")]
        report = merge(existing, incoming)
        self.assertEqual(len(existing), 1)
        self.assertEqual(existing[0], {"t": "A Spark of Dawn", "a": "Ilse Marlowe", "s": "A Crown of Embers", "sn": "5",
                                       "g": ["Mine"], "id": "B5"})
        self.assertEqual(len(report.backfilled), 1)

    def test_an_id_match_beats_everything_else(self):
        existing = [book("Completely Renamed", id="B7")]
        report = merge(existing, [book("Original Title", id="B7")])
        self.assertEqual((len(existing), len(report.added)), (1, 0))

    def test_hand_cleaned_titles_still_match_the_long_audible_form(self):
        existing = [book("A Crown of Embers", a="Ilse Marlowe")]
        merge(existing, [book("A Crown of Embers, Book 1", a="Ilse Marlowe", id="B1")])
        self.assertEqual(len(existing), 1)
        self.assertEqual(existing[0]["id"], "B1")

    def test_a_boxed_set_is_not_mistaken_for_its_first_book(self):
        existing = [book("Lantern of the Deep", a="R.T. Hale")]
        report = merge(existing, [book("Lantern of the Deep: Books 1-3", a="R.T. Hale")])
        self.assertEqual(len(report.added), 1)

    def test_series_names_are_folded_onto_the_spelling_already_in_use(self):
        existing = [book("One", s="Ember Coast", sn="1")]
        merge(existing, [book("Two", s="Ember Coast Series", sn="2"), book("Three", s="ember-coast", sn="3")])
        self.assertEqual({b["s"] for b in existing}, {"Ember Coast"})

    def test_excluded_books_are_never_re_added(self):
        existing = []
        exclusions = Exclusions(ids={"B9"}, titles={("removed box set", "author")})
        report = merge(existing, [book("Gone", id="B9"), book("Removed Box Set"), book("Fine")], exclusions)
        self.assertEqual([b["t"] for b in existing], ["Fine"])
        self.assertEqual(len(report.excluded), 2)

    def test_same_title_by_different_authors_are_different_books(self):
        existing = [book("Dark", a="Ann")]
        merge(existing, [book("Dark", a="Bob")])
        self.assertEqual(len(existing), 2)


if __name__ == "__main__":
    unittest.main()
