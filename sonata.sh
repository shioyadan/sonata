#!/usr/bin/env bash
# 配信・更新処理をこのファイルに内包する。stdinは更新の確認入力に残す。
set -eu
exec python3 /dev/fd/3 "$0" "$@" 3<<'SONATA_PYTHON'
"""同梱HTMLと指定トレースだけを配信し、展開済み配布物を更新する。"""

import argparse
import ast
import datetime
import hashlib
import http.server
import json
import os
from pathlib import Path
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request
import zipfile

UPDATE_URL = "https://shioyadan.github.io/sonata/sonata-latest.zip"
MAX_UPDATE_BYTES = 256 * 1024 * 1024
SAMPLE_PATH = re.compile(r"samples/[a-z0-9]+(?:-[a-z0-9]+)*\.log\.gz\Z")
REQUIRED_FILES = {
    "sonata.sh", "sonata.html", "README.md",
    "LICENSE.md", "THIRD_PARTY_NOTICES.md",
}


def sample_paths(html):
    assignment = re.search(r"^globalThis\.sonataDemoCatalog=(.+);$", html, re.MULTILINE)
    if not assignment:
        raise ValueError("Missing demo catalog in sonata.html")
    catalog = json.loads(assignment.group(1))
    if not isinstance(catalog, list):
        raise ValueError("Invalid demo catalog")
    paths, keys = set(), set()
    for entry in catalog:
        if not isinstance(entry, dict):
            raise ValueError("Invalid demo catalog entry")
        key, url = entry.get("key"), entry.get("url")
        if (not isinstance(key, str) or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", key)
                or key in keys or not isinstance(url, str) or not SAMPLE_PATH.fullmatch(url)):
            raise ValueError("Invalid or duplicate demo URL")
        keys.add(key)
        paths.add(url)
    return paths


def serve(root, trace):
    html = root / "sonata.html"
    if not html.is_file():
        html = root / "dist" / "sonata.html"
    if not html.is_file():
        raise ValueError("sonata.html was not found. Extract a distribution or run npm run build first.")
    files = {"/": html, "/sonata.html": html}
    for name in sample_paths(html.read_text(encoding="utf-8")):
        sample = html.parent / name
        if sample.is_symlink() or sample.parent.is_symlink():
            raise ValueError("Sample files must not be symlinks")
        files["/" + name] = sample
    metadata = None
    if trace is not None:
        trace = Path(trace).resolve(strict=True)
        if not trace.is_file() or not os.access(trace, os.R_OK):
            raise ValueError("Trace is not a readable file")
        if any(ord(char) < 32 or ord(char) == 127 for char in trace.name):
            raise ValueError("Trace names must not contain control characters")
        info = trace.stat()
        metadata = json.dumps({
            "name": trace.name, "size": info.st_size,
            "lastModified": info.st_mtime_ns // 1_000_000,
        }, ensure_ascii=False).encode("utf-8")
        files["/trace1"] = trace
    value = os.environ.get("SONATA_PORT")
    if value is not None and (not re.fullmatch(r"[0-9]{1,5}", value) or not 1 <= int(value) <= 65535):
        raise ValueError("SONATA_PORT must be an integer from 1 to 65535.")

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, format, *args):
            pass

        def reply(self, status, content_type=None, length=0):
            self.send_response(status)
            self.send_header("Content-Length", str(length))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            if content_type:
                self.send_header("Content-Type", content_type)
            if status == 405:
                self.send_header("Allow", "GET, HEAD")
            self.end_headers()

        def send_file(self):
            try:
                if re.search(r"%(?![0-9a-fA-F]{2})", self.path):
                    raise ValueError("Invalid URL escape")
                parsed = urllib.parse.urlsplit(self.path)
                urllib.parse.unquote(parsed.path, errors="strict")
                if parsed.scheme or parsed.netloc or not parsed.path.startswith("/"):
                    raise ValueError("Invalid request target")
            except (ValueError, UnicodeError):
                self.reply(400)
                return
            if parsed.path == "/trace-info" and metadata is not None:
                self.reply(200, "application/json; charset=utf-8", len(metadata))
                if self.command != "HEAD":
                    self.wfile.write(metadata)
                return
            file = files.get(parsed.path)
            if file is None:
                self.reply(404)
                return
            try:
                stream = file.open("rb")
            except OSError:
                self.reply(404)
                return
            with stream:
                content_type = "application/octet-stream"
                if parsed.path in ("/", "/sonata.html"):
                    content_type = "text/html; charset=utf-8"
                elif parsed.path.startswith("/samples/"):
                    content_type = "application/gzip"
                self.reply(200, content_type, os.fstat(stream.fileno()).st_size)
                if self.command != "HEAD":
                    try:
                        shutil.copyfileobj(stream, self.wfile, 1024 * 1024)
                    except (BrokenPipeError, ConnectionResetError):
                        pass  # ブラウザでの読込み取消しはサーバーのエラーにしない。

        do_GET = send_file
        do_HEAD = send_file

        def unsupported(self):
            self.reply(405)

        do_POST = do_PUT = do_DELETE = do_PATCH = do_OPTIONS = unsupported

    # OSに直接空きportを割り当ててもらい、探索とbindの間の競合を避ける。
    with http.server.ThreadingHTTPServer(("127.0.0.1", int(value) if value else 0), Handler) as server:
        port = server.server_port
        print(f"Sonata URL: http://127.0.0.1:{port}/" + ("#trace=1" if trace else ""), flush=True)
        print(f"SSH tunnel: ssh -L {port}:127.0.0.1:{port} <host>", flush=True)
        print("Press Ctrl+C to stop the server.", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"Duplicate manifest key: {key}")
        result[key] = value
    return result


def read_manifest(path):
    if path.stat().st_size > 1024 * 1024:
        raise ValueError("Build manifest is too large")
    manifest = json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=unique_object)
    if not isinstance(manifest, dict):
        raise ValueError("Invalid build manifest")
    timestamp = manifest.get("timestamp")
    if (type(manifest.get("version")) is not int or manifest["version"] != 1
            or not isinstance(manifest.get("commit"), str)
            or not re.fullmatch(r"[0-9a-f]{40}", manifest["commit"])
            or type(timestamp) is not int or timestamp < 0):
        raise ValueError("Invalid build identity")
    date = datetime.datetime.fromtimestamp(timestamp, datetime.timezone.utc).strftime("%Y-%m-%d")
    if manifest.get("date") != date:
        raise ValueError("Invalid build date")
    files = manifest.get("files")
    if not isinstance(files, dict) or not REQUIRED_FILES.issubset(files):
        raise ValueError("Build manifest is missing required files")
    for name, info in files.items():
        if name not in REQUIRED_FILES and not SAMPLE_PATH.fullmatch(name):
            raise ValueError(f"Unsupported distribution path: {name}")
        if (not isinstance(info, dict) or type(info.get("bytes")) is not int or info["bytes"] < 0
                or not isinstance(info.get("sha256"), str) or not re.fullmatch(r"[0-9a-f]{64}", info["sha256"])):
            raise ValueError(f"Invalid file descriptor: {name}")
    if sum(info["bytes"] for info in files.values()) > MAX_UPDATE_BYTES:
        raise ValueError("Unpacked update is too large")
    return manifest


def unpack_update(archive_path, payload):
    with zipfile.ZipFile(archive_path) as archive:
        entries = archive.infolist()
        names = set()
        members = {}
        if len(entries) > 1024 or sum(entry.file_size for entry in entries) > MAX_UPDATE_BYTES:
            raise ValueError("Update archive is too large")
        for entry in entries:
            name = entry.filename
            mode = stat.S_IFMT(entry.external_attr >> 16)
            if name != entry.orig_filename or name in names or mode not in (0, stat.S_IFREG, stat.S_IFDIR):
                raise ValueError("Duplicate or non-regular archive member")
            names.add(name)
            if entry.is_dir():
                if name not in ("sonata-latest/", "sonata-latest/samples/"):
                    raise ValueError("Unsupported archive directory")
                continue
            if mode == stat.S_IFDIR or not name.startswith("sonata-latest/"):
                raise ValueError("Invalid archive member")
            relative = name[len("sonata-latest/"):]
            if relative not in REQUIRED_FILES | {"build.json"} and not SAMPLE_PATH.fullmatch(relative):
                raise ValueError(f"Unsupported archive path: {relative}")
            members[relative] = entry
        if "build.json" not in members or members["build.json"].file_size > 1024 * 1024:
            raise ValueError("Missing or invalid build manifest")
        payload.mkdir()
        (payload / "build.json").write_bytes(archive.read(members["build.json"]))
        manifest = read_manifest(payload / "build.json")
        if set(members) != set(manifest["files"]) | {"build.json"}:
            raise ValueError("Archive contents do not match the build manifest")
        for name, descriptor in manifest["files"].items():
            entry = members[name]
            if entry.file_size != descriptor["bytes"]:
                raise ValueError(f"Incorrect update size: {name}")
            destination = payload / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            digest = hashlib.sha256()
            with archive.open(entry) as source, destination.open("wb") as target:
                while chunk := source.read(1024 * 1024):
                    digest.update(chunk)
                    target.write(chunk)
            if digest.hexdigest() != descriptor["sha256"]:
                raise ValueError(f"Incorrect update hash: {name}")
            destination.chmod(0o755 if name == "sonata.sh" else 0o644)
    html = (payload / "sonata.html").read_text(encoding="utf-8")
    if not html.lower().startswith("<!doctype html>"):
        raise ValueError("Invalid sonata.html")
    if sample_paths(html) != {name for name in manifest["files"] if SAMPLE_PATH.fullmatch(name)}:
        raise ValueError("Update samples do not match the HTML catalog")
    script = payload / "sonata.sh"
    script_text = script.read_text(encoding="utf-8")
    if not script_text.startswith("#!/usr/bin/env bash\n"):
        raise ValueError("Invalid sonata.sh")
    subprocess.run(["bash", "-n", str(script)], check=True, capture_output=True)
    embedded = re.search(r"3<<'SONATA_PYTHON'\n(.*)\nSONATA_PYTHON\n?\Z", script_text, re.DOTALL)
    if not embedded:
        raise ValueError("Missing Python implementation in sonata.sh")
    ast.parse(embedded[1], filename="sonata.sh")
    return manifest


def same_file(left, right):
    if not left.is_file() or left.stat().st_size != right.stat().st_size:
        return False
    with left.open("rb") as first, right.open("rb") as second:
        while chunk := first.read(1024 * 1024):
            if chunk != second.read(len(chunk)):
                return False
    return True


def validate_destinations(root, names):
    # 読取り前に全置換先を確認する。外側を指すsymlinkやディレクトリは扱わない。
    for name in names:
        destination = root / name
        for path in (destination, *destination.parents):
            if path == root:
                break
            if path.is_symlink():
                raise ValueError(f"Update destination is a symlink: {name}")
            if path != destination and path.exists() and not path.is_dir():
                raise ValueError(f"Update parent is not a directory: {name}")
        if destination.exists() and not destination.is_file():
            raise ValueError(f"Update destination is not a file: {name}")


def install_update(root, payload, names, backup):
    validate_destinations(root, names)
    existing = set()
    for name in names:
        destination = root / name
        if destination.exists():
            saved = backup / name
            saved.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(destination, saved)
            existing.add(name)
    installed = []
    try:
        for name in names:
            destination = root / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            installed.append(name)
            os.replace(payload / name, destination)
    except BaseException:
        # Ctrl+C/TERMも復旧する。復旧中の再度のsignalでbackupを失わない。
        handlers = {sig: signal.signal(sig, signal.SIG_IGN) for sig in (signal.SIGINT, signal.SIGTERM)}
        try:
            for name in reversed(installed):
                if name in existing:
                    os.replace(backup / name, root / name)
                else:
                    (root / name).unlink(missing_ok=True)
        except BaseException as error:
            raise RuntimeError(f"Rollback failed; original files remain in {backup}: {error}") from error
        finally:
            for sig, handler in handlers.items():
                signal.signal(sig, handler)
        raise


def update(root):
    if ((root / ".git").exists() or (root / ".git").is_symlink()
            or (root / "sonata.html").is_symlink()
            or not (root / "sonata.html").is_file() or (root / "build.json").is_symlink()
            or not (root / "build.json").is_file()):
        raise ValueError("Sonata can update only an extracted distribution with sonata.html and build.json.")
    current = read_manifest(root / "build.json")
    temporary = Path(tempfile.mkdtemp(prefix=".sonata-update-", dir=root))
    keep_backup = False
    try:
        print("Downloading the latest Sonata development build...", flush=True)
        url = os.environ.get("SONATA_UPDATE_URL", UPDATE_URL)
        if urllib.parse.urlsplit(url).scheme not in ("https", "http", "file"):
            raise ValueError("Unsupported update URL")
        archive_path = temporary / "update.zip"
        with urllib.request.urlopen(url, timeout=30) as response, archive_path.open("wb") as archive:
            downloaded = 0
            while chunk := response.read(1024 * 1024):
                downloaded += len(chunk)
                if downloaded > MAX_UPDATE_BYTES:
                    raise ValueError("Downloaded update is too large")
                archive.write(chunk)
        payload = temporary / "payload"
        available = unpack_update(archive_path, payload)
        print(f"Installed build: {current['commit']} ({current['date']})")
        print(f"Available build: {available['commit']} ({available['date']})")
        names = sorted(available["files"]) + ["build.json"]
        validate_destinations(root, names)
        changed = [name for name in names if not same_file(root / name, payload / name)]
        if not changed:
            print("Sonata is already up to date.")
            return
        if available["timestamp"] > current["timestamp"]:
            print("A newer Sonata build is available:")
        elif available["timestamp"] < current["timestamp"]:
            print("The available Sonata build is older than this copy (downgrade):")
        else:
            print("The available Sonata build differs from this copy:")
        for name in changed:
            print("  " + name)
        print("Install this update? [y/N] ", end="", file=sys.stderr, flush=True)
        answer = sys.stdin.readline().strip().lower()
        if answer not in ("y", "yes"):
            print("Update cancelled.")
            return
        try:
            install_update(root, payload, names, temporary / "backup")
        except RuntimeError:
            keep_backup = True
            raise
        print("Sonata was updated to the latest development build.")
    finally:
        if not keep_backup:
            shutil.rmtree(temporary)


def main(root):
    parser = argparse.ArgumentParser(prog="sonata.sh", description="Serve Sonata and one local trace over an SSH tunnel.")
    parser.add_argument("trace", nargs="?", metavar="TRACE", help="optional raw, gzip or zstd trace")
    parser.add_argument("--update", action="store_true", help="update an extracted Sonata distribution")
    arguments = parser.parse_args()
    if arguments.update and arguments.trace:
        parser.error("--update does not accept a trace")
    try:
        if arguments.update:
            def interrupt(signum, frame):
                raise KeyboardInterrupt
            signal.signal(signal.SIGTERM, interrupt)
            update(root)
        else:
            serve(root, arguments.trace)
    except KeyboardInterrupt:
        print("Operation cancelled.", file=sys.stderr)
        return 130
    except (OSError, ValueError, OverflowError, RuntimeError, zipfile.BadZipFile, subprocess.CalledProcessError, SyntaxError) as error:
        print(f"Sonata: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    root = Path(sys.argv.pop(1)).resolve().parent
    sys.exit(main(root))
SONATA_PYTHON
