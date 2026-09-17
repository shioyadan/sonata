#!/usr/bin/env bash
# symlink経由でも実体の配布ディレクトリを使う。
set -eu
exec python3 -c '
import os, runpy, sys
launcher = os.path.join(os.path.dirname(os.path.realpath(sys.argv[1])), "scripts", "launcher.py")
sys.argv = [launcher, *sys.argv[2:]]
runpy.run_path(launcher, run_name="__main__")
' "$0" "$@"
