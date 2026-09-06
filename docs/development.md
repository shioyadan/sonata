# Development

## 境界

- `src/sonata.js`: WebGL 2 の描画、DOM、カメラ・タッチ操作、再生時計。
- `src/replay-model.js`: FIFO、依存行列、レジスタ状態、命令列の巻き戻し、Top-down の時刻サンプリング。DOM や WebGL に依存しない再生モデル。
- `src/index.html` / `src/sonata.css`: 画面とレスポンシブレイアウト。
- `scripts/import-trace.ts` と関連モジュール: 元ログからデモ用の小さなデータを抽出。
- `vendor/konata-core/`: 抽出にだけ使う解析器の固定スナップショット。

描画ライブラリやフレームワークの実行時依存はありません。`window.sonata` は決定的な時刻シークと状態参照のための診断 API です。テストはこれを通して実データと画面を照合します。

## ビルド

`npm run build` は Node の標準ライブラリだけで、`src/index.html` にスタイル・スクリプト・デモを埋め込みます。出力は `dist/sonata.html`。ライセンス表示も HTML 内に保持します。埋め込み JSON の文字列内を変更せず、長すぎる行を改行します。

`npm start` はビルドした HTML だけを配信します。ソースディレクトリや元ログを公開するサーバーではありません。環境変数 `SONATA_HOST` / `SONATA_PORT` で待ち受け先を変更できます。スマートフォンから同じネットワーク経由で確認する場合の例:

```sh
SONATA_HOST=0.0.0.0 npm start
```

端末のブラウザで開発マシンの IP アドレスとポート4173を開きます。

## 検証

`npm test` は再生モデルの整合性とビルドの独立性を検査します。ビルド検査は、必要なソースだけを別の一時ディレクトリにコピーし、`node_modules` や Konata のチェックアウトなしで同一 HTML を作れることを確認します。デモの内容、UTF-8、外部スクリプトの不在、vendor のハッシュも確認します。

`npm run test:render` は、ビルドした単一 HTML だけを別の一時ディレクトリへコピーして Electron で開きます。外部リソースへのアクセスを禁止し、全5デモの FIFO、ステージ、pipe と接続線、依存行列、レジスタ、フラッシュ、Top-down、操作、動きを減らす設定を検査します。

モバイルは DPR 2 とタッチイベントを使い、320 × 568、390 × 844、430 × 932、932 × 430 で検査します。ピンチ、2本指の移動、指を離した後の回転、キャンセル、Fit、設定パネル、横向きからの復帰を含みます。実機 Safari / Chrome の検査を置き換えるものではありません。

ヘッドレス Linux の実行例:

```sh
xvfb-run -a -s '-screen 0 1600x1100x24' npm run test:render
xvfb-run -a -s '-screen 0 1600x1100x24' npm run test:mobile
```

画像は `artifacts/screenshots/` に保存します。SwiftShader による CPU 描画で検証するため、記録される fps は実 GPU の速度と異なります。

既存の HTML 自体を検査したい場合は、`SONATA_HTML=/path/to/sonata.html` を指定します。通常は毎回ビルドするので、古い生成物を誤って検査しません。`npm run capture:flush` はビルド済み HTML の通常再生から巻き戻し・分解中の画像を取得します。

## Git に含めるもの

ソース、埋め込みデモ、ロックファイル、解析器の出典、文書を管理します。README 用の代表画像だけは `docs/images/overview.png` に置きます。日々のスクリーンショットやレポートは `artifacts/`、配布用 HTML は `dist/`、元ログは `inputs/` に分離し、これらは `.gitignore` で除外します。

Konata の解析コードを更新する場合は [vendor の手順](../vendor/konata-core/README.md) に従い、デモの再生成と描画検査を実行してください。ブラウザ側の演出を変えるだけなら、元ログや解析器の再生成は不要です。

## ライブデモの公開

公開先は https://shioyadan.github.io/sonata/ です。初回公開前に GitHub リポジトリの **Settings → Pages → Build and deployment → Source** を **GitHub Actions** に設定してください。

`.github/workflows/ci.yml` は `main` への push または手動実行でモデル・ビルド・描画を検証し、成功した同じコミットから `dist/sonata.html` を生成して、Pages の `index.html` として公開します。pull request は検証だけを行います。依存パッケージやソース、元ログを公開用ディレクトリへコピーしません。

README 冒頭の **Live demo** はこの公開先へリンクします。初回の Pages 設定とワークフローが完了するまではリンク先は未公開です。
