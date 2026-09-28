"""Keeps personal data out of the public repository."""
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PRIVATE = ["data/books.json", "data/series-info.json", "data/excluded.txt", "data/raw/*"]


class Hygiene(unittest.TestCase):
    def test_gitignore_covers_every_personal_file(self):
        lines = {l.strip() for l in (ROOT / ".gitignore").read_text().splitlines()}
        for pattern in PRIVATE:
            self.assertIn(pattern, lines, f".gitignore must list {pattern}")

    def test_only_demo_data_is_tracked(self):
        try:
            out = subprocess.run(["git", "ls-files", "data"], cwd=ROOT, capture_output=True, text=True, check=True).stdout
        except (OSError, subprocess.CalledProcessError):
            self.skipTest("not inside a git checkout")
        tracked = set(out.split())
        self.assertLessEqual(tracked, {"data/sample/books.json", "data/sample/series-info.json", "data/raw/.gitkeep"})


if __name__ == "__main__":
    unittest.main()
