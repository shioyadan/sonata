# Konata コアの固定スナップショット

デモの抽出・構造検出・Top-down 集計に必要な Konata の10モジュールを、依存関係を含めて固定しています。ブラウザ用の Sonata や配布 HTML からは読み込みません。

- 出典: https://github.com/shioyadan/Konata
- 元の場所: `src/core/`
- リビジョン、各ファイルの SHA-256: [UPSTREAM.json](UPSTREAM.json)
- ライセンス: [BSD-3-Clause](LICENSE.md)
- 取り込み時の変更: TypeScript ソースは変更なし。ライセンス本文は行末の空白だけを整理。

`file_line_reader`、Kanata / gem5 パーサー、モデルと op store、ステージ構造検出、cycle activity / Top-down 解析、Zstandard の互換層が対象です。`@hpcc-js/wasm-zstd` はデモ抽出用の開発依存として取得します。

更新時はこのディレクトリだけで完結する依存関係を維持し、固定リビジョンとファイルハッシュを更新してください。ローカルに変更を加える場合は、その内容とハッシュも明示します。`npm test` で記録との一致を確認します。
