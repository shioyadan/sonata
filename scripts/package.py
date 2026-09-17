#!/usr/bin/env python3
"""生成済みHTMLと起動ヘルパーを、再現可能な更新用ZIPへまとめる。"""

import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import zipfile


def build_archive(root, output):
    revision = subprocess.check_output(
        ["git", "-C", str(root), "log", "-1", "--format=%H %ct"], text=True
    ).strip().split()
    commit, timestamp = revision[0], int(revision[1])
    date = datetime.datetime.fromtimestamp(timestamp, datetime.timezone.utc)
    html = (root / "dist/sonata.html").read_bytes()
    if not html.lower().startswith(b"<!doctype html>"):
        raise ValueError("Invalid distribution HTML. Run npm run build first.")
    match = re.search(rb"^globalThis\.sonataDemoCatalog=(.+);$", html, re.MULTILINE)
    if not match:
        raise ValueError("Missing demo catalog in the distribution HTML.")
    catalog = json.loads(match[1])
    samples = {}
    for entry in catalog:
        url = entry["url"]
        if not re.fullmatch(r"samples/[a-z0-9]+(?:-[a-z0-9]+)*\.log\.gz", url):
            raise ValueError(f"Invalid sample URL: {url}")
        content = (root / "dist" / url).read_bytes()
        if len(content) != entry["size"]:
            raise ValueError(f"Sample size differs from the catalog: {url}")
        samples[url] = content
    payload = {"sonata.html": html, **samples}
    for name in ["sonata.sh", "README.md", "LICENSE.md", "THIRD_PARTY_NOTICES.md"]:
        payload[name] = (root / name).read_bytes()
    manifest = {
        "version": 1,
        "commit": commit,
        "timestamp": timestamp,
        "date": date.date().isoformat(),
        "files": {
            name: {"sha256": hashlib.sha256(content).hexdigest(), "bytes": len(content)}
            for name, content in sorted(payload.items())
        },
    }
    payload["build.json"] = (json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode()
    output.parent.mkdir(parents=True, exist_ok=True)
    # 途中失敗で前回の配布物を壊さず、完成したZIPだけを固定名へ置く。
    fd, temporary = tempfile.mkstemp(prefix=".sonata-package-", suffix=".zip", dir=output.parent)
    os.close(fd)
    try:
        with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for name, content in sorted(payload.items()):
                info = zipfile.ZipInfo("sonata-latest/" + name, date.timetuple()[:6])
                info.create_system = 3
                info.external_attr = (0o100755 if name == "sonata.sh" else 0o100644) << 16
                info.compress_type = zipfile.ZIP_STORED if name.endswith(".gz") else zipfile.ZIP_DEFLATED
                archive.writestr(info, content, compresslevel=9)
        os.replace(temporary, output)
    finally:
        Path(temporary).unlink(missing_ok=True)
    return manifest


def main():
    root = Path(__file__).resolve().parent.parent
    output = root / "dist/sonata-latest.zip"
    try:
        manifest = build_archive(root, output)
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError) as error:
        print(f"Could not package Sonata: {error}", file=sys.stderr)
        return 1
    print(f"{output.relative_to(root)} · {manifest['commit'][:12]} ({manifest['date']})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
