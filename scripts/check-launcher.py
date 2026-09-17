#!/usr/bin/env python3
"""隔離した配布物で実HTTP配信と更新の取消し・検証・復旧を確認する。"""

from contextlib import contextmanager
import datetime
import hashlib
import http.client
import importlib.util
import json
import os
from pathlib import Path
import re
import selectors
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
import warnings
import zipfile

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("sonata_launcher", ROOT / "scripts/launcher.py")
LAUNCHER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(LAUNCHER)
HTML = '<!doctype html>\n<title>{}</title>\nglobalThis.sonataDemoCatalog=[{{"key":"demo","url":"samples/demo.log.gz"}}];\n'


def distribution(root, commit="a", timestamp=100):
    (root / "scripts").mkdir(parents=True)
    (root / "samples").mkdir()
    shutil.copy2(ROOT / "sonata.sh", root / "sonata.sh")
    shutil.copy2(ROOT / "scripts/launcher.py", root / "scripts/launcher.py")
    (root / "sonata.html").write_text(HTML.format(commit), encoding="utf-8")
    (root / "samples/demo.log.gz").write_bytes(b"\x1f\x8b" + commit.encode())
    for name in ("README.md", "LICENSE.md", "THIRD_PARTY_NOTICES.md"):
        (root / name).write_text(name + commit, encoding="utf-8")
    files = {}
    for path in sorted(root.rglob("*")):
        if path.is_file():
            content = path.read_bytes()
            files[path.relative_to(root).as_posix()] = {
                "bytes": len(content), "sha256": hashlib.sha256(content).hexdigest(),
            }
    manifest = {"version": 1, "commit": commit * 40, "timestamp": timestamp,
                "date": datetime.datetime.fromtimestamp(timestamp, datetime.timezone.utc).strftime("%Y-%m-%d"),
                "files": files}
    (root / "build.json").write_text(json.dumps(manifest), encoding="utf-8")
    return root


def archive(root, destination, extra=None, omit=None):
    with zipfile.ZipFile(destination, "w", zipfile.ZIP_DEFLATED) as result:
        for file in sorted(root.rglob("*")):
            if file.is_file() and file.relative_to(root).as_posix() != omit:
                result.write(file, "sonata-latest/" + file.relative_to(root).as_posix())
        if extra:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", UserWarning)
                result.writestr(*extra)
    return destination.as_uri()


def snapshot(root):
    return {file.relative_to(root).as_posix(): file.read_bytes() for file in root.rglob("*") if file.is_file()}


def run(root, *arguments, input="", **environment):
    env = {key: value for key, value in os.environ.items() if key not in ("SONATA_PORT", "SONATA_UPDATE_URL")}
    env.update(environment)
    return subprocess.run([str(root / "sonata.sh"), *map(str, arguments)], cwd=root.parent,
                          env=env, input=input, text=True, capture_output=True, timeout=20)


@contextmanager
def server(root, *arguments, executable=None, **environment):
    env = {key: value for key, value in os.environ.items() if key not in ("SONATA_PORT", "SONATA_UPDATE_URL")}
    env.update(environment)
    process = subprocess.Popen([str(executable or root / "sonata.sh"), *map(str, arguments)],
                               cwd=root.parent, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            if not selector.select(timeout=10):
                raise AssertionError("Launcher did not print its URL")
        line = process.stdout.readline().strip()
        match = re.fullmatch(r"Sonata URL: http://127\.0\.0\.1:([0-9]+)/(#trace=1)?", line)
        if not match:
            raise AssertionError(f"Invalid launcher output: {line}, {process.stderr.read()}")
        port = int(match.group(1))
        assert process.stdout.readline().strip() == f"SSH tunnel: ssh -L {port}:127.0.0.1:{port} <host>"
        yield port, bool(match.group(2))
    finally:
        if process.poll() is None:
            process.send_signal(signal.SIGINT)
        try:
            output, errors = process.communicate(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.communicate()
            raise AssertionError("Launcher did not stop on Ctrl+C")
        assert process.returncode == 0, (process.returncode, output, errors)


def request(port, path, method="GET"):
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    try:
        connection.putrequest(method, path, skip_host=True)
        connection.putheader("Host", "127.0.0.1")
        connection.endheaders()
        response = connection.getresponse()
        return response.status, dict(response.getheaders()), response.read()
    finally:
        connection.close()


class LauncherTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="sonata-launcher-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.installed = distribution(self.root / "installed copy")

    def test_http_trace_and_isolation(self):
        trace = self.root / "命令 trace.gz"
        # 圧縮形式をHTTPで展開せず、大きなファイルもコピー単位で配信する。
        content = b"\x1f\x8b" + bytes(range(256)) * 16384
        trace.write_bytes(content)
        link = self.root / "trace link"
        link.symlink_to(trace)
        wrapper = self.root / "sonata link"
        wrapper.symlink_to(self.installed / "sonata.sh")
        (self.installed / "samples/private.log.gz").write_bytes(b"private")
        with server(self.installed, link, executable=wrapper) as (port, has_trace):
            self.assertTrue(has_trace)
            for path in ("/", "/sonata.html?cache=1"):
                status, headers, body = request(port, path)
                self.assertEqual(status, 200)
                self.assertEqual(body, (self.installed / "sonata.html").read_bytes())
                self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
            status, headers, body = request(port, "/trace-info")
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(body), {"name": trace.name, "size": len(content),
                                              "lastModified": trace.stat().st_mtime_ns // 1_000_000})
            for method in ("GET", "HEAD"):
                status, headers, body = request(port, "/trace1", method)
                self.assertEqual(status, 200)
                self.assertEqual(int(headers["Content-Length"]), len(content))
                self.assertNotIn("Content-Encoding", headers)
                self.assertEqual(body, content if method == "GET" else b"")
                status, headers, body = request(port, "/samples/demo.log.gz", method)
                self.assertEqual(status, 200)
                self.assertEqual(headers["Content-Type"], "application/gzip")
                self.assertNotIn("Content-Encoding", headers)
            for path in ("/trace2", "/samples/", "/samples/private.log.gz", "/README.md", "/scripts/launcher.py",
                         "/../sonata.html", "/%2e%2e/sonata.html", "/.git/config"):
                self.assertEqual(request(port, path)[0], 404, path)
            for path in ("/%zz", "/%FF", "http://[bad/", "http://elsewhere/"):
                self.assertEqual(request(port, path)[0], 400, path)
            self.assertEqual(request(port, "/", "POST")[0], 405)
            self.assertEqual(request(port, "/")[0], 200)

    def test_source_tree_and_no_trace(self):
        (self.installed / "dist").mkdir()
        for name in ("sonata.html", "samples"):
            (self.installed / name).rename(self.installed / "dist" / name)
        with server(self.installed) as (port, has_trace):
            self.assertFalse(has_trace)
            self.assertEqual(request(port, "/")[0], 200)
            self.assertEqual(request(port, "/trace-info")[0], 404)
            self.assertEqual(request(port, "/trace1")[0], 404)
        result = run(self.installed, "--update")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("only an extracted distribution", result.stderr)

    def test_invalid_arguments_and_busy_port(self):
        self.assertEqual(run(self.installed, "--help").returncode, 0)
        for arguments in (("a", "b"), ("--unknown",), ("--update", "a"), ("missing",), (str(self.root),)):
            self.assertNotEqual(run(self.installed, *arguments).returncode, 0)
        for value in ("", "0", "65536", "-1", "12.2", "abc"):
            result = run(self.installed, SONATA_PORT=value)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("SONATA_PORT", result.stderr)
        with socket.socket() as occupied:
            occupied.bind(("127.0.0.1", 0))
            occupied.listen()
            result = run(self.installed, SONATA_PORT=str(occupied.getsockname()[1]))
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn("Sonata URL:", result.stdout)
        (self.installed / "sonata.html").unlink()
        result = run(self.installed)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("npm run build", result.stderr)

    def test_update_confirmation_preservation_and_same_build(self):
        payload = distribution(self.root / "payload", "b", 200)
        url = archive(payload, self.root / "update.zip")
        personal = self.installed / "my trace.log.gz"
        personal.write_bytes(b"keep me")
        before = snapshot(self.installed)
        for answer in ("n\n", ""):
            result = run(self.installed, "--update", input=answer, SONATA_UPDATE_URL=url)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("A newer Sonata build", result.stdout)
            self.assertIn("Update cancelled", result.stdout)
            self.assertEqual(snapshot(self.installed), before)
        link = self.root / "update link"
        link.symlink_to(self.installed / "sonata.sh")
        result = subprocess.run([str(link), "--update"], input="yes\n", text=True, capture_output=True,
                                env={**os.environ, "SONATA_UPDATE_URL": url}, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Sonata was updated", result.stdout)
        self.assertEqual(snapshot(self.installed), {**snapshot(payload), "my trace.log.gz": b"keep me"})
        self.assertTrue(os.access(self.installed / "sonata.sh", os.X_OK))
        result = run(self.installed, "--update", SONATA_UPDATE_URL=url)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("already up to date", result.stdout)
        self.assertNotIn("Install this update", result.stderr)
        older = distribution(self.root / "older", "c", 50)
        result = run(self.installed, "--update", SONATA_UPDATE_URL=archive(older, self.root / "older.zip"))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("downgrade", result.stdout)
        self.assertIn("Update cancelled", result.stdout)

    def test_invalid_archives_and_destinations(self):
        payload = distribution(self.root / "payload", "b", 200)
        before = snapshot(self.installed)
        symlink = zipfile.ZipInfo("sonata-latest/samples/link.log.gz")
        symlink.create_system = 3
        symlink.external_attr = (stat.S_IFLNK | 0o777) << 16
        variants = [
            {"omit": "sonata.html"},
            {"extra": ("sonata-latest/../outside", b"escape")},
            {"extra": ("/absolute", b"escape")},
            {"extra": ("sonata-latest/README.md", b"duplicate")},
            {"extra": ("sonata-latest/unlisted", b"unlisted")},
            {"extra": (symlink, b"../outside")},
        ]
        for index, variant in enumerate(variants):
            url = archive(payload, self.root / f"invalid-{index}.zip", **variant)
            result = run(self.installed, "--update", input="yes\n", SONATA_UPDATE_URL=url)
            self.assertNotEqual(result.returncode, 0, result.stdout)
            self.assertEqual(snapshot(self.installed), before)
            self.assertNotIn("Install this update", result.stderr)
        (payload / "sonata.html").write_text(HTML.format("x"), encoding="utf-8")
        result = run(self.installed, "--update", input="yes\n",
                     SONATA_UPDATE_URL=archive(payload, self.root / "wrong-hash.zip"))
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(snapshot(self.installed), before)
        self.assertFalse((self.root / "outside").exists())
        self.assertFalse(list(self.installed.glob(".sonata-update-*")))
        (self.installed / ".git").write_text("gitdir: elsewhere")
        result = run(self.installed, "--update")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("only an extracted distribution", result.stderr)

    def test_rollback_and_symlink_destination(self):
        payload = distribution(self.root / "payload", "b", 200)
        before = snapshot(self.installed)
        replace = os.replace
        def fail_once(source, target):
            if Path(source) == payload / "sonata.html":
                raise OSError("injected replacement failure")
            replace(source, target)
        with mock.patch.object(LAUNCHER.os, "replace", side_effect=fail_once):
            with self.assertRaisesRegex(OSError, "injected"):
                LAUNCHER.install_update(self.installed, payload, ["README.md", "sonata.html"], self.root / "backup")
        self.assertEqual(snapshot(self.installed), before)
        external = self.root / "external"
        external.write_bytes(b"untouched")
        (self.installed / "README.md").unlink()
        (self.installed / "README.md").symlink_to(external)
        with self.assertRaisesRegex(ValueError, "symlink"):
            LAUNCHER.install_update(self.installed, payload, ["README.md"], self.root / "backup-2")
        self.assertEqual(external.read_bytes(), b"untouched")


if __name__ == "__main__":
    unittest.main(verbosity=2)
