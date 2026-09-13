# Konata コアの固定スナップショット

デモ抽出、トレースの読み込み、構造検出、Top-down 集計に必要な Konata の12モジュールを、依存関係を含めて固定しています。ブラウザでは、このソースから生成した [browser.cjs](browser.cjs) を使用します。

- 出典: https://github.com/shioyadan/Konata
- 元の場所: `src/core/`
- リビジョン、各ファイルの SHA-256: [UPSTREAM.json](UPSTREAM.json)
- ライセンス: [BSD-3-Clause](LICENSE.md)
- 取り込み時の変更: TypeScript ソースは変更なし。ライセンス本文は行末の空白だけを整理。

`file_line_reader`、Kanata / gem5 パーサー、モデル、op store / paged op store、ステージ構造検出、cycle activity / Top-down 解析、Zstandard の互換層、形式選択を行う `trace_parser` が対象です。

## ブラウザ向け生成物

`node scripts/generate-core.cjs` で、開発依存の TypeScript を使って必要なモジュールを自己完結した CommonJS に変換します。通常ビルドはコミット済みの生成物を使うため、Node 標準機能だけで完結します。Zstandard の実装と埋め込み WASM は [vendor/wasm-zstd](../wasm-zstd/README.md) の固定ソースを組み込みます。生成物、生成スクリプト、型宣言、入力ソースの SHA-256 と TypeScript の版も `UPSTREAM.json` に記録します。

元の TypeScript は変更せず、生成時に Zstandard Worker の import を Blob Worker のコンストラクターへ置き換えます。元 Worker 本文は副 Worker 内だけで評価するため、Parser Worker の `onmessage` を上書きしません。Blob URL は Worker の生成直後に回収し、Worker の停止は Core の reader / store の終了処理が行います。

公開 API は `parseTraceFile`、`StageStructureDetector` と、実行時検査用の `PagedOpStore`、`OnikiriParser`、`Gem5O3PipeViewParser`、`FileLineReader` です。[browser.d.cts](browser.d.cts) はブラウザの DOM 型に `lib.webworker` を混入させない公開型境界で、元実装との型互換性を検査します。

## 読み込みとメモリ

入力は `File` 相当の `name` / `size` / `type` / `stream()` を持つオブジェクトです。平文、gzip、Zstandard をストリーム処理し、Kanata 判定が不成立ならストリームを開き直して gem5 O3PipeView を試します。圧縮形式は拡張子または MIME で選択します。キャンセル時は `AbortSignal` を通知し、受け取った trace の利用終了時には `close()` を呼びます。

PagedOpStore は展開済みページと命令キャッシュの数を制限しますが、圧縮済みページと retire ID の索引はメモリに保持します。大きな入力の全データがディスクへ退避される仕組みではなく、必要メモリは命令数・内容にも依存します。Sonata は store と索引を Parser Worker 内で保持し、表示区間だけを画面へ渡します。

更新時は固定リビジョンと全ソースのハッシュを更新し、生成物を再生成してください。`node scripts/generate-core.cjs --check` は再生成による差分を検出します。`node scripts/check-core.cjs` はスナップショット、型境界、圧縮入力、形式選択、キャンセル、ページ復元、副 Worker と解放を検査します。
