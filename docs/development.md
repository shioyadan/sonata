# 開発ガイド

README は日本語で、機能・操作・開発手順を説明します。プロジェクト成立の経緯は README に記載しません。ソースコードと検証・ビルド用スクリプトの説明コメントは日本語で記述し、識別子・画面の文言・ライセンス原文はそれぞれの用途に合わせて維持します。

作業上の指針は [AGENTS.md](../AGENTS.md)、設計判断と過去の検査から得た確認事項は [継続開発のための判断と確認事項](maintenance.md) を参照してください。

## コミットと作業記録

コミットメッセージはスコープ付き Conventional Commits の `type(scope): description` 形式にします。例: `fix(server): reject malformed request URLs`、`test(render): wait for desktop layout restoration`、`docs(maintenance): record development decisions`。変更対象を表すスコープを必須とし、一つの目的として説明できる変更をまとめます。

日付、依頼、変更理由、検証結果、残作業は `work/WORKLOG.md` に記録します。`work/` はローカルの履歴・引き継ぎ用で、Git 管理対象外です。継続して必要な仕様・判断理由・再現方法は `docs/` の関連文書へ反映し、個人環境のパスや一時的な調査ログはローカルに保持します。

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

Node の推奨バージョンは `.nvmrc` に固定し、セキュリティ修正版へ更新します。`npm run test:server` はローカルでサーバーを起動し、GET / HEAD、ソースの非公開、未対応メソッドと不正な URL の拒否、異常なリクエスト後も配信が継続することを確認します。

`THIRD_PARTY_NOTICES.md` と `licenses/` の原文は、配布 HTML の **Licenses** パネルへ埋め込みます。デモの元プログラムやライセンスが変わった場合はこれらも更新し、`npm test` で全文の保持を確認してください。

`npm run test:render` は、ビルドした単一 HTML だけを別の一時ディレクトリへコピーして Electron で開きます。外部リソースへのアクセスを禁止し、全5デモの FIFO、ステージ、pipe と接続線、依存行列、レジスタ、フラッシュ、Top-down、操作、動きを減らす設定を検査します。

モバイルは DPR 2 とタッチイベントを使い、320 × 568、390 × 844、430 × 932、932 × 430 で検査します。ピンチ、2本指の移動、指を離した後の回転、キャンセル、Fit、設定パネル、横向きからの復帰を含みます。実機 Safari / Chrome の検査を置き換えるものではありません。

ブラウザの回帰検査は `scripts/check-browser.cjs` にまとめ、`npm run test:render` と CI に含めています。個別に実行する場合は `npm run test:browser` を使います。

- Electron の入力イベントで、矢印・Space・Cinema・Escape と、トレースの先頭・末尾の境界を検査します。
- range / select / button にフォーカスがある場合、全体のショートカットが重複して動かないことを確認します。Licenses のキーボード操作、Tab のフォーカス範囲、Escape 後のフォーカス復帰も検査します。
- 初期化時に WebGL 2 を利用できない状態を作り、案内と権利表示が利用できることを確認します。
- 実際の WebGL context loss / restore を発生させ、案内、再生時計の停止、復旧後の再生と描画画素を確認します。単なるフラグの変化だけで復旧成功とは判定しません。

モバイル検査では設定パネルを開いたままデスクトップへ戻すケースも含め、サイドバー・ダイアログ・フォーカスの復帰を確認します。

ヘッドレス Linux の実行例:

```sh
xvfb-run -a -s '-screen 0 1600x1100x24' npm run test:render
xvfb-run -a -s '-screen 0 1600x1100x24' npm run test:mobile
xvfb-run -a -s '-screen 0 1600x1100x24' npm run test:browser
```

画像は `artifacts/screenshots/` に保存します。SwiftShader による CPU 描画で検証するため、記録される fps は実 GPU の速度と異なります。

既存の HTML 自体を検査したい場合は、`SONATA_HTML=/path/to/sonata.html` を指定します。通常は毎回ビルドするので、古い生成物を誤って検査しません。`npm run capture:flush` はビルド済み HTML の通常再生から巻き戻し・分解中の画像を取得します。

## Git に含めるもの

ソース、埋め込みデモ、ロックファイル、解析器の出典、文書を管理します。README 用の代表画像だけは `docs/images/overview.png` に置きます。日々のスクリーンショットやレポートは `artifacts/`、配布用 HTML は `dist/`、元ログは `inputs/` に分離し、これらは `.gitignore` で除外します。

Konata の解析コードを更新する場合は [vendor の手順](../vendor/konata-core/README.md) に従い、デモの再生成と描画検査を実行してください。ブラウザ側の演出を変えるだけなら、元ログや解析器の再生成は不要です。

## ライブデモの公開

公開先は https://shioyadan.github.io/sonata/ です。初回公開前に GitHub リポジトリの **Settings → Pages → Build and deployment → Source** を **GitHub Actions** に設定してください。

`.github/workflows/ci.yml` は `main` への push または手動実行でモデル・ビルド・サーバー・描画を検証し、成功した同じコミットから `dist/sonata.html` を生成して、Pages の `index.html` として公開します。pull request は検証だけを行います。依存パッケージやソース、元ログを公開用ディレクトリへコピーしません。

README 冒頭の **ライブデモ** はこの公開先へリンクします。push 後は GitHub Actions で対象コミットの `verify` と `pages` が成功したことを確認し、公開 URL の応答と生成 HTML の内容を確認します。`verify` が失敗した場合は `pages` がスキップされ、初回は未公開、既存サイトがある場合は前の公開内容が維持されます。
