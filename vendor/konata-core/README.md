# Konata core snapshot

This directory pins the ten Konata modules required for demo extraction, structure detection, and Top-down analysis, including their local dependencies. The Sonata browser application and standalone HTML do not load these modules.

- Source: https://github.com/shioyadan/Konata
- Original directory: `src/core/`
- Revision and per-file SHA-256 hashes: [UPSTREAM.json](UPSTREAM.json)
- License: [BSD-3-Clause](LICENSE.md)
- Local changes: TypeScript sources are unchanged. Only trailing whitespace was removed from the license text.

The snapshot includes `file_line_reader`, the Kanata and gem5 parsers, the model and op store, stage structure detection, cycle activity and Top-down analysis, and the Zstandard compatibility layer. `@hpcc-js/wasm-zstd` is installed as a development dependency for trace extraction.

When updating the snapshot, keep all local module dependencies within this directory and update the pinned revision and hashes. Document any local source changes and update their hashes as well. `npm test` verifies that the files match the recorded hashes.
