import tempfile
import unittest
from pathlib import Path

from catalog.goodreads import parse_title, read_library


class TitleParsing(unittest.TestCase):
    def test_common_goodreads_series_formats(self):
        cases = {
            "Rains of Harrow (The Wayfarer Inn, #7)": ("Rains of Harrow", "The Wayfarer Inn", "7"),
            "Frosted (Blaze, #6; Dana O'Hare, #1)": ("Frosted", "Blaze", "6"),
            "Ballads and Brigands (Red Harbor #3)": ("Ballads and Brigands", "Red Harbor", "3"),
            "Rift Clash: A LitRPG Adventure (Rift Universe, Book 8)": ("Rift Clash: A LitRPG Adventure", "Rift Universe", "8"),
            "Parallel (Parallel, #1)": ("Parallel", "Parallel", "1"),
            "The Lamplighter": ("The Lamplighter", None, None),
        }
        for raw, expected in cases.items():
            self.assertEqual(parse_title(raw), expected, raw)


class Reading(unittest.TestCase):
    def test_only_read_audio_editions_are_kept(self):
        header = "Title,Author,Additional Authors,Binding,Exclusive Shelf,Bookshelves\n"
        rows = (
            "\"Kept (Series, #2)\",Ann,Nate Narrator,Audible Audio,read,\"urban-fantasy, witches\"\n"
            "Paperback,Bob,,Paperback,read,\n"
            "Unread audio,Cy,,Audiobook,to-read,\n"
        )
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "gr.csv"
            path.write_text(header + rows, encoding="utf-8")
            result = read_library(path)
        self.assertEqual(result.records, [
            {"t": "Kept", "a": "Ann", "n": "Nate Narrator", "s": "Series", "sn": "2", "g": ["urban-fantasy", "witches"]}
        ])


if __name__ == "__main__":
    unittest.main()
