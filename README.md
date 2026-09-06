# Sonata

**[▶ ライブデモ](https://shioyadan.github.io/sonata/)**

**プロセッサの実行トレースを、動きで見る。**

Sonata（そなた）は、プロセッサ内部を流れる命令を WebGL で可視化するブラウザアプリです。命令列、依存行列、レジスタリネーム、物理レジスタ、実行パイプ、ROB、コミット、予測ミスからの復帰を、実トレースに沿って再生します。

![Sonata のパイプライン表示](docs/images/overview.png)

## 起動

Node.js **22.12 以降**を使用します。ビルドとローカル表示には Node の標準ライブラリだけを使うので、依存パッケージのインストールは不要です。

```sh
git clone https://github.com/shioyadan/sonata.git
cd sonata
npm run build
```

生成された **`dist/sonata.html`** をブラウザで開いてください。コード・スタイル・全5デモが入った単一 HTML です。別の場所へコピーしても、ネットワーク接続なしで動きます。ブラウザは WebGL 2 が必要です。

ローカル HTTP サーバーで開く場合は `npm start` を使います。ビルド後に `http://127.0.0.1:4173` で表示できます。ソース変更後は再起動してください。

## 操作

| 操作 | 動作 |
| --- | --- |
| ドラッグ / 1本指 | カメラを回転 |
| ホイール / ピンチ | 拡大・縮小 |
| 2本指の平行移動 | 図を移動 |
| Fit / ダブルクリック | カメラをリセット |
| Space / ← → | 再生・停止 / 1サイクル移動 |
| F / C | 次のフラッシュ / Cinema |
| 命令の粒子をクリック | 対象命令を追跡 |

スマートフォンでは再生・シークを画面内に保ち、**Demo & settings** からデモや表示設定を開きます。横向きにも対応しています。動きを減らす OS 設定を尊重し、画面上でアニメーションを有効にできます。

## デモ

| デモ | シミュレータ / プロセッサ | 実行内容・見どころ |
| --- | --- | --- |
| Branch storm | gem5 ARM64 O3 | CoreMark、連続する予測ミス |
| Wide open | gem5 ARM64 O3 | CoreMark、高い命令流量 |
| Miss & recover | RSD / RISC-V | `mshr.log`、キャッシュミスと予測ミス。プログラム名は未確認 |
| Rename rush | gem5 ARM64 O3 | CoreMark、記録されたリネームと物理レジスタの読み書き |
| x86 recovery | gem5 x86 O3 | CoreMark、micro-op とレジスタ復元 |

実行条件は各デモの **Run details** と [デモの出自](data/README.md) に記載しています。データに記録された時刻・依存関係と、推定した構造や光の演出を区別しています。Top-down はトレースから推定した分類を、現在から過去8サイクルの窓で表示します。実装上の解釈は [可視化の仕様](docs/visualization.md) を参照してください。

## 開発と検証

```sh
npm ci
npm test
npm run test:render
```

Electron はブラウザの検証用です。配布 HTML には含みません。画面のない Linux では Xvfb を使用します。

```sh
xvfb-run -a -s '-screen 0 1600x1100x24' npm run test:render
# スマートフォンの表示・タッチ操作だけを検査
xvfb-run -a -s '-screen 0 1600x1100x24' npm run test:mobile
```

検証画像は `artifacts/screenshots/` に出力します。描画検査は HTML だけを一時フォルダへコピーし、外部アクセスを禁止して実行します。CI でもモデル・単一 HTML・デスクトップ・モバイルを確認します。詳細は [開発ガイド](docs/development.md) にまとめています。

README とソースコードの説明コメントは日本語で記述します。

## 構成

```text
src/                    HTML・CSS・WebGL 描画・再生モデル
data/                   Git に含める5本の実トレース抜粋と出自
scripts/                ビルド・検証・デモ抽出
vendor/konata-core/      抽出に使う Konata 解析コードの固定スナップショット
docs/                   可視化の仕様と開発手順
dist/sonata.html         配布用の生成物（Git 対象外）
artifacts/              検証画像・レポート（Git 対象外）
inputs/                 再抽出用の元ログ（Git 対象外）
work/                   ローカル作業メモ・引き継ぎ資料（Git 対象外）
```

通常のビルド・検証には Konata のチェックアウトや元ログは不要です。デモを再抽出する場合だけ、[再生成の手順](data/README.md#再生成) に沿って元ログを用意してください。

## ライセンス

[BSD-3-Clause](LICENSE.md)。Konata から引き継いだ著作権表示を保持しています。解析コードの出典・固定リビジョンは [vendor/konata-core](vendor/konata-core/README.md) に記録しています。
