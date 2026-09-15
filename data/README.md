# 配布デモトレース

`data/samples/` のgzip生トレース4本を配布します。5つのデモがこれらを使い、選択時にFileと同じWorker・Konata core・区間変換で解析します。通常ビルドはgzipを `dist/samples/` へバイト単位でコピーし、本体HTMLには小さなデモカタログだけを含めます。

配布を管理するファイルは次のとおりです。

- `sample-catalog.json`: デモ名、固定URL、元ファイル名、表示範囲・初期位置、見どころ、出典、確認済みCPU設定。命令・レジスタevent・Top-downの配列は含めません。
- `sample-sources.json`: 元ファイルの相対位置・サイズ・SHA256、原文prefixの長さ・SHA256、gzipのサイズ・SHA256。
- `samples/*.log.gz`: 時刻・ID・行番号を変えていない、元ログの連続した先頭部分。
- `traces.js` / `demo-manifest.json`: 旧デモとの記録一致を確認するCPU回帰fixture・生成レポート。通常ビルド・配信・実行時解析は参照しません。

| キー | 元ログ（入力ルートからの相対位置） | サイクル | 実行内容 |
| --- | --- | --- | --- |
| `branch-storm` | `gem5-traces/full-2iter/arm64/trace.log` | 73208–73335 | gem5 v25.1.0.1 / ARM64 O3、CoreMark 2 iterations |
| `wide-open` | 同上 | 73388–73515 | 同じ実行の別区間 |
| `memory-tide` | `rsd/mshr.log` | 3964–4091 | RSD / RISC-V、IntRegImm テストの起動処理。シミュレータの版は未確認 |
| `rename-rush` | `gem5-traces/detailed/arm64/trace.log` | 404–531 | gem5 v25.1.0.1 / ARM64 O3、CoreMark 1 iteration |
| `x86-recovery` | `gem5-traces/detailed/x86/trace.log` | 1596–1723 | gem5 v25.1.0.1 / x86 O3、CoreMark 1 iteration |

| 配布ファイル | 利用するデモ | 元ログの保持範囲 |
| --- | --- | --- |
| `gem5-arm-coremark.log.gz` | `branch-storm` / `wide-open` | 先頭24,043,690 bytes |
| `gem5-arm-registers.log.gz` | `rename-rush` | 先頭7,398,575 bytes |
| `gem5-x86-registers.log.gz` | `x86-recovery` | 先頭23,764,168 bytes |
| `rsd-memory.log.gz` | `memory-tide` | 全4,321,125 bytes |

4本の圧縮サイズは合計約4.63 MiBです。表示区間より前の記録を残すことで、Coreのcycle起点・ID/RID・詳細ログから得る初期レジスタ状態・注釈の原文行番号を保持します。表示区間より後にも対象命令の終了記録を含め、抜粋境界で完了命令を未完了へ変えないようにします。JSONから疑似ログを組み立てたり、途中の行を削って時刻やIDを補正したりしません。

gem5の詳細ログはO3PipeViewとO3CPUAllを含み、整数物理レジスタのrename / read / write / restoreを実行時に抽出します。最初の2デモはO3PipeViewが中心です。元configの `numPhysIntRegs=256` で容量は確認できますが、値や対応が記録されていない箇所は未知として表示します。既知のCPU設定はデモごとに渡し、ISAや容量の分からない任意Fileへ流用しません。

RSDのログはプロセッサRSDから取得されたものです。`D$-miss`、MSHR、`Br-pred-miss-ex` の注釈でキャッシュミスと予測ミスを確認しています。

公開前の照合で、元ログ全体の108種類の命令アドレスと命令内容が、RSDの `Asm/IntRegImm` テストの実行ファイルと一致しました。同梱デモの表示命令は `rsd-loader.c` の `_load`（データコピーとBSS初期化）です。gem5の4デモの命令アドレスは、CoreMarkの行列処理・リスト初期化・リスト整列の関数に対応します。命令列の出典、照合したリビジョン、再配布時に保持する権利表示は [第三者ライセンス](../THIRD_PARTY_NOTICES.md) を参照してください。

実行条件の根拠となるREADME / configの相対位置は、`sample-catalog.json` の `provenance.evidence` に残しています。それらの元ファイルは配布HTMLやgzipには含めません。通常のアプリ配布はライセンス全文をHTMLに含め、**Licenses** から読める状態を保ちます。

## 再生成

通常のビルド・表示変更では不要です。[generate-samples.cjs](../scripts/generate-samples.cjs) は `sample-sources.json` に記録した元ファイルサイズとprefixのハッシュを照合して、原文をNode標準のgzipで再圧縮します。既存のprefixを再生成するだけなら依存パッケージは不要です。

```sh
# 元ログ4本を上表の相対位置で inputs/ に配置する。
npm run demos:generate
# 検証用の依存を用意し、記録と配布の整合性を確認する。
npm ci
npm test
npm run build
```

元ログが別の場所にある場合はルートを明示できます。

```sh
SONATA_TRACE_ROOT=/path/to/trace-inputs npm run demos:generate
```

抽出範囲を変える場合は `sample-sources.json` のprefix長・原文ハッシュと、`sample-catalog.json` の表示範囲・見どころ・出典を見直します。元ログの先頭から改行境界までを保持し、選択した命令の終了記録と初期レジスタ状態が残ることを確認してください。配布データや元プログラムの変更は権利表示にも反映します。

`check-raw-samples.cjs` はCoreでgzipを解析し、旧5デモ計2,857命令のID・RID・fetch・retire・flush・命令文字列が変わっていないことを確認します。Top-downや構造推定は同じ有界な実行時解析を使います。分岐回復の支持例が不足する場合は原因を断定せず、旧fixtureの分類へ合わせるために抜粋外の情報を補いません。

候補区間の探索用 `npm run demos:select` と旧fixture生成用 `scripts/generate-demos.ts` は開発用に残しています。通常ビルドや生トレースの再圧縮には使いません。探索結果は `artifacts/trace-selection.json` に保存され、入力が見つからない候補はエラーを記録して次へ進みます。
