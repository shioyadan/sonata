#!/usr/bin/env python3
"""配布ZIPの実行属性・記録・再現性・入力失敗時の保持を検査する。"""

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("sonata_package", Path(__file__).with_name("package.py"))
package = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package)


class PackageTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="sonata-package-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / "source with spaces"
        self.root.mkdir()
        for directory in ["dist/samples", "scripts", "work"]:
            (self.root / directory).mkdir(parents=True)
        self.content = {
            "sonata.sh": b"#!/usr/bin/env bash\nexit 0\n",
            "scripts/launcher.py": b'print("Sonata")\n',
            "README.md": "起動方法\n".encode(),
            "LICENSE.md": b"License text\n",
            "THIRD_PARTY_NOTICES.md": b"Third-party text\n",
            "dist/samples/test.log.gz": b"compressed trace fixture",
            "work/private.txt": b"must not be packaged",
        }
        catalog = [{
            "key": "test", "url": "samples/test.log.gz",
            "size": len(self.content["dist/samples/test.log.gz"]),
        }]
        self.content["dist/sonata.html"] = (
            "<!doctype html>\n<script>\nglobalThis.sonataDemoCatalog=" + json.dumps(catalog) + ";\n</script>\n"
        ).encode()
        for name, content in self.content.items():
            (self.root / name).write_bytes(content)
        self.git("init", "-q")
        self.git("add", ".")
        self.git(
            "-c", "user.name=Sonata test", "-c", "user.email=test@example.invalid",
            "commit", "-qm", "fixture", "--no-gpg-sign",
        )
        self.output = self.root / "dist/sonata-latest.zip"

    def git(self, *args):
        return subprocess.check_output(
            ["git", "-C", str(self.root), *args],
            env={
                **os.environ,
                "GIT_AUTHOR_DATE": "2026-09-01T00:00:00Z",
                "GIT_COMMITTER_DATE": "2026-09-01T00:00:00Z",
            },
            stderr=subprocess.PIPE,
            text=True,
        ).strip()

    def test_contents_identity_and_reproducibility(self):
        manifest = package.build_archive(self.root, self.output)
        original = self.output.read_bytes()
        package.build_archive(self.root, self.output)
        self.assertEqual(self.output.read_bytes(), original)
        self.assertEqual(manifest["commit"], self.git("rev-parse", "HEAD"))
        self.assertEqual(manifest["date"], "2026-09-01")
        self.assertEqual(manifest["timestamp"], 1788220800)
        with zipfile.ZipFile(self.output) as archive:
            self.assertEqual(archive.testzip(), None)
            expected = {
                name.removeprefix("dist/"): content
                for name, content in self.content.items() if not name.startswith("work/")
            }
            self.assertEqual(
                set(archive.namelist()), {"sonata-latest/" + name for name in [*expected, "build.json"]}
            )
            self.assertEqual(json.loads(archive.read("sonata-latest/build.json")), manifest)
            for name, content in expected.items():
                self.assertEqual(archive.read("sonata-latest/" + name), content)
                self.assertEqual(
                    manifest["files"][name],
                    {"bytes": len(content), "sha256": hashlib.sha256(content).hexdigest()},
                )
                mode = archive.getinfo("sonata-latest/" + name).external_attr >> 16
                self.assertEqual(mode & 0o777, 0o755 if name == "sonata.sh" else 0o644)

    def test_invalid_input_keeps_previous_archive(self):
        package.build_archive(self.root, self.output)
        original = self.output.read_bytes()
        sample = self.root / "dist/samples/test.log.gz"
        sample.write_bytes(b"truncated")
        with self.assertRaisesRegex(ValueError, "size differs"):
            package.build_archive(self.root, self.output)
        self.assertEqual(self.output.read_bytes(), original)
        sample.unlink()
        with self.assertRaises(FileNotFoundError):
            package.build_archive(self.root, self.output)
        self.assertEqual(self.output.read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
