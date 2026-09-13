# Zstandard の固定スナップショット

`@hpcc-js/wasm-zstd` 1.15.0 の npm 配布物から `dist/index.js` と `LICENSE` を変更せずに同梱しています。版、元リビジョン、npm integrity、各ファイルの SHA-256 は [UPSTREAM.json](UPSTREAM.json) に記録しています。

`index.js` には WebAssembly のバイナリが埋め込まれています。Konata のブラウザ向け生成物にはこのソースを CommonJS に変換して組み込み、別の WASM ファイルやネットワーク取得を必要としません。原本のソースマップは同梱せず、生成物からその参照コメントも除去します。

以下の権利表示を配布 HTML にも保持します。

- `@hpcc-js/wasm-zstd`: [Apache License 2.0](LICENSE)
- 埋め込み fzstd 0.1.1: [MIT License](FZSTD-LICENSE.txt)
- 埋め込み Zstandard 1.5.7: [BSD-3-Clause](ZSTD-LICENSE.txt)

fzstd / Zstandard のライセンス原文は固定した Konata の `THIRD_PARTY_LICENSES.md` から取得し、出典を記録しています。Zstandard は複数ライセンスから BSD-3-Clause を選択しています。

更新する際は npm の配布物と埋め込み実装の版・ライセンスを照合し、ハッシュと権利表示も更新してください。`node scripts/generate-core.cjs` でブラウザ向け生成物を再生成し、`node scripts/check-core.cjs` でオフラインの圧縮処理と Worker の解放を確認します。
