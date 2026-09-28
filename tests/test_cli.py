import contextlib
import io
import shutil
import tempfile
import unittest
from pathlib import Path

from catalog.cli import main
from catalog.model import load_books

ROOT = Path(__file__).resolve().parent.parent


class Cli(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        shutil.copytree(ROOT / "src", self.tmp / "src")
        shutil.copytree(ROOT / "data" / "sample", self.tmp / "data" / "sample")

    def run_cli(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = main(["--root", str(self.tmp), *argv])
        return code, out.getvalue(), err.getvalue()

    def test_a_fresh_checkout_builds_and_validates_the_demo_data(self):
        for command in ("validate", "build"):
            code, out, _ = self.run_cli(command)
            self.assertEqual(code, 0, command)
            self.assertIn("demo data", out)
        self.assertTrue((self.tmp / "dist" / "audiobook-catalog.html").exists())

    def test_commands_that_write_refuse_to_touch_the_demo_data(self):
        for argv in (["format"], ["import-audible", "x.csv"], ["sync-export", "x.json"]):
            code, _, err = self.run_cli(*argv)
            self.assertEqual(code, 2, argv)
            self.assertIn("init", err)

    def test_init_creates_an_empty_catalogue_and_never_overwrites(self):
        code, out, _ = self.run_cli("init")
        self.assertEqual(code, 0)
        self.assertEqual(load_books(self.tmp / "data" / "books.json"), [])
        self.assertTrue((self.tmp / "data" / "excluded.txt").exists())
        code, _, err = self.run_cli("init")
        self.assertEqual(code, 1)
        self.assertIn("already exists", err)
        # once your own data exists it is used instead of the demo
        code, out, _ = self.run_cli("build")
        self.assertEqual(code, 0)
        self.assertNotIn("demo data", out)

    def test_init_sample_copies_the_demo_data(self):
        self.assertEqual(self.run_cli("init", "--sample")[0], 0)
        self.assertEqual(load_books(self.tmp / "data" / "books.json"), load_books(self.tmp / "data" / "sample" / "books.json"))

    def test_sync_export_spaces_author_initials(self):
        import json
        self.assertEqual(self.run_cli("init", "--sample")[0], 0)
        export = self.tmp / "export.json"
        export.write_text(json.dumps([{"t": "New Book", "a": "A.B. Quill"}]), encoding="utf-8")
        code, out, _ = self.run_cli("sync-export", str(export))
        self.assertEqual(code, 0)
        self.assertIn("spaced out run-together author initials on 1", out)
        self.assertEqual(load_books(self.tmp / "data" / "books.json")[0]["a"], "A. B. Quill")

    def test_data_dir_option_points_anywhere(self):
        elsewhere = self.tmp / "elsewhere"
        self.assertEqual(self.run_cli("--data-dir", str(elsewhere), "init")[0], 0)
        self.assertEqual(load_books(elsewhere / "books.json"), [])
        code, out, _ = self.run_cli("--data-dir", str(elsewhere), "build")
        self.assertEqual(code, 0)
        self.assertNotIn("demo data", out)

    def test_a_missing_explicit_data_dir_is_an_error_not_a_silent_fallback(self):
        code, _, err = self.run_cli("--data-dir", str(self.tmp / "nope"), "build")
        self.assertEqual(code, 1)
        self.assertIn("error", err)


if __name__ == "__main__":
    unittest.main()
