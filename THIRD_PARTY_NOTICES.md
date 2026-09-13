# 第三者ライセンスと権利表示

Sonata 本体は `LICENSE.md` の BSD-3-Clause で提供します。同梱する解析コードとデモの命令列については、以下の出典・権利表示を保持します。元ログから抽出した時刻・レジスタ・依存関係の情報と、元プログラム由来の命令列は区別して扱います。

この文書と下記のライセンス原文・クレジットは、配布 HTML にも埋め込まれます。画面の **Licenses** から全文を確認できます。

## Konata の解析コード

- 出典: https://github.com/shioyadan/Konata
- 著作権: Copyright (C) 2016-2026 Ryota Shioya
- ライセンス: [BSD-3-Clause](vendor/konata-core/LICENSE.md)
- 固定したソースとハッシュ: [vendor/konata-core/UPSTREAM.json](vendor/konata-core/UPSTREAM.json)

12 個の解析モジュールをソースとして同梱します。デモ抽出に加え、配布 HTML のトレース読み込みにも使用します。元の TypeScript は変更せず、ブラウザ向け生成時にモジュールを結合し、Worker の読み込みを Blob Worker に接続しています。

## Zstandard の圧縮・展開

- 出典: [@hpcc-js/wasm-zstd](https://github.com/hpcc-systems/hpcc-js-wasm)、版 `1.15.0`
- パッケージのライセンス: [Apache License 2.0](vendor/wasm-zstd/LICENSE)
- 埋め込み fzstd `0.1.1`: Copyright (c) 2020 Arjun Barrett、[MIT License](vendor/wasm-zstd/FZSTD-LICENSE.txt)
- 埋め込み Zstandard `1.5.7`: Copyright (c) Meta Platforms, Inc. and affiliates. All rights reserved.、[BSD-3-Clause](vendor/wasm-zstd/ZSTD-LICENSE.txt)
- 固定した配布物とハッシュ: [vendor/wasm-zstd/UPSTREAM.json](vendor/wasm-zstd/UPSTREAM.json)

トレース入力の Zstandard 展開と、解析した命令ページのメモリ内圧縮に使用します。npm の JavaScript 配布物と埋め込み WebAssembly をブラウザ向けコードに変換して同梱しています。Zstandard は複数ライセンスから BSD-3-Clause を選択しています。

## CoreMark 由来の命令列

- 出典: https://github.com/eembc/coremark
- ソースリビジョン: `1f483d5b8316753a742cbf5590caf5bd0a4e4777`
- 著作権: Copyright 2018 Embedded Microprocessor Benchmark Consortium (EEMBC)
- 原著者: Shay Gal-on
- ライセンス原文: [COREMARK-LICENSE.md](licenses/COREMARK-LICENSE.md) — Apache License 2.0 と COREMARK® ACCEPTABLE USE AGREEMENT
- 対象デモ: `branch-storm`、`wide-open`、`rename-rush`、`x86-recovery`

CoreMark を gem5 で実行したログから短い区間を抽出し、逆アセンブルされた命令や micro-op、時刻、レジスタ情報を表示用データへ変換しています。元の CoreMark ソースは改変していません。配布するデータの形式と区間は Sonata 用に加工しています。

同梱する命令アドレスは、使用した実行ファイルのシンボル表で `matrix_mul_vect` / `matrix_test` / `core_list_init` / `core_list_mergesort` / `cmp_idx` に対応します。CoreMark の C ソースや実行ファイル全体は同梱しません。

CoreMark® は Embedded Microprocessor Benchmark Consortium (EEMBC) の登録商標です。この名称はデータの出自を示すために使用しています。各デモは可視化のための短時間の実行で、CoreMark スコアや性能比較の結果として提供するものではありません。EEMBC による Sonata の推奨・認証を示すものでもありません。

## RSD 由来の命令列

- 出典: https://github.com/rsd-devel/rsd
- 照合したソースリビジョン: `7b65f6ba0bce58d4d859082660123b7100aae975`
- 対応するソース: [rsd-loader.c](https://github.com/rsd-devel/rsd/blob/7b65f6ba0bce58d4d859082660123b7100aae975/Processor/Src/Verification/TestCode/rsd-loader.c)
- 著作権: Copyright 2019-2023 Ryota Shioya and RSD contributors
- ライセンス: [Apache License 2.0](licenses/RSD-LICENSE.txt)
- クレジット: [RSD-CREDITS.md](licenses/RSD-CREDITS.md)
- 対象デモ: `memory-tide`（画面では **Miss & recover**）

RSD から得た `mshr.log` の一部を表示用データに加工しています。表示する命令アドレス `0x1a00`–`0x1a24` と命令内容は、RSD の `_load` 起動処理に一致します。この処理は ROM から RAM へのデータコピーと BSS の初期化を行います。元ソースに変更は加えていません。

元ログ全体の 108 種類の命令アドレスと命令内容は、[Asm/IntRegImm テスト](https://github.com/rsd-devel/rsd/blob/7b65f6ba0bce58d4d859082660123b7100aae975/Processor/Src/Verification/TestCode/Asm/IntRegImm/code.s)の実行ファイルと一致しました。比較には、起動処理の後に実行されたテスト本体の 38 種類の命令も含みます。シミュレータの版や実行設定までは特定できていません。上記リビジョンは命令の由来を照合した版であり、ログ生成時の RSD リビジョンを保証するものではありません。

## 開発用依存関係と画像

Electron、TypeScript、tsx / esbuild などの開発用依存関係は、開発・検証・データ抽出に使用します。上記で同梱を明記した解析・圧縮実装を除き、npm パッケージ本体を Sonata の Git リポジトリや配布 HTML には含めません。gem5 と RSD のシミュレータ本体も同梱しません。

`docs/images/overview.png` は Sonata 自身の画面から生成した画像です。外部画像・Web フォント・音声をアプリへ埋め込んでいません。フォントは閲覧環境のシステムフォントを使用します。
