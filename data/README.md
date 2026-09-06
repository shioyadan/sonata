# 同梱デモトレース

`traces.js` と `demo-manifest.json` は Git に含めます。前者はブラウザ用の実トレース抜粋、後者は出自・区間・イベント数などの生成レポートです。元の大きなログは含めません。

| キー | 元ログ（入力ルートからの相対位置） | サイクル | 実行内容 |
| --- | --- | --- | --- |
| `branch-storm` | `gem5-traces/full-2iter/arm64/trace.log` | 73208–73335 | gem5 v25.1.0.1 / ARM64 O3、CoreMark 2 iterations |
| `wide-open` | 同上 | 73388–73515 | 同じ実行の別区間 |
| `memory-tide` | `rsd/mshr.log` | 3964–4091 | RSD / RISC-V、IntRegImm テストの起動処理。シミュレータの版は未確認 |
| `rename-rush` | `gem5-traces/detailed/arm64/trace.log` | 404–531 | gem5 v25.1.0.1 / ARM64 O3、CoreMark 1 iteration |
| `x86-recovery` | `gem5-traces/detailed/x86/trace.log` | 1596–1723 | gem5 v25.1.0.1 / x86 O3、CoreMark 1 iteration |

gem5 の詳細ログは O3PipeView と O3CPUAll を含みます。実際の整数物理レジスタの rename / read / write / restore を抽出しています。最初の2本は O3PipeView が中心で、対応や値が記録されていない箇所は未観測として表示します。

RSD のログはプロセッサ RSD から取得されたものです。`D$-miss`、MSHR、`Br-pred-miss-ex` の注釈でキャッシュミスと予測ミスを確認しています。

公開前の照合で、元ログ全体の 108 種類の命令アドレスと命令内容が、RSD の `Asm/IntRegImm` テストの実行ファイルと一致しました。同梱デモの表示命令は `rsd-loader.c` の `_load`（データコピーと BSS 初期化）です。gem5 の4デモの命令アドレスは、CoreMark の行列処理・リスト初期化・リスト整列の関数に対応します。命令列の出典、照合したリビジョン、再配布時に保持する権利表示は [第三者ライセンス](../THIRD_PARTY_NOTICES.md) を参照してください。

実行条件の根拠となる README / config の相対位置も、各デモの `demo.provenance.evidence` に残しています。それらの元ファイルは埋め込み HTML に含まれません。抽出条件は [generate-demos.ts](../scripts/generate-demos.ts)、表示する出自は [provenance.ts](../scripts/provenance.ts) が管理します。

## 再生成

通常のビルドではこの操作は不要です。元ログを再取得した場合や抽出区間を変える場合に使います。

```sh
npm ci
# デフォルトはリポジトリ内の inputs/。元ログ4本を上表の相対位置に配置する。
npm run demos:generate
npm test
npm run build
```

元ログが別の場所にある場合は、ルートを明示できます。

```sh
SONATA_TRACE_ROOT=/path/to/trace-inputs npm run demos:generate
```

ARM64 / x86 の大きなログは先頭24 MiBまでを読みます。候補区間の探索は `npm run demos:select` で行い、結果を `artifacts/trace-selection.json` に保存します。探索候補のうち元ログがないものはレポートにエラーとして記録し、取得できたログの探索を続けます。

Top-down は固定した Konata 解析コードで集計した slot と照合し、commit / squash を観測する前に結果を先取りしないよう、その観測時刻も含めます。抽出時に既知のイベント数や整合性を検査します。
