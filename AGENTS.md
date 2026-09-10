# Sonata の作業指針

このリポジトリ全体に適用します。

## 最初に読むもの

- [README.md](README.md): 起動、操作、構成。
- [docs/development.md](docs/development.md): ビルド、検証、コミット、公開の手順。
- [docs/maintenance.md](docs/maintenance.md): 作業履歴から抽出した設計判断と保守上の注意。
- 構造を変更する場合は [docs/architecture.md](docs/architecture.md)。
- 表示を変更する場合は [docs/visualization.md](docs/visualization.md)。
- ローカルに `work/` があれば、`WORKLOG.md` の最新項目と `STATE.json`、必要に応じて `HANDOFF.md` を読む。`work/` は Git 対象外なので、新しいチェックアウトには存在しなくてよい。

## 作業範囲と表記

- 作業対象は独立した Sonata リポジトリ。別の Konata チェックアウトや元ログを変更しない。
- README、開発文書、ソースコードの説明コメントは日本語。画面の文言、識別子、エラーメッセージ、ライセンス原文は既存の方針を保つ。
- README は機能・操作・開発を説明し、プロジェクト成立の経緯は記載しない。ブランド表示は `sonata` の文字を用いる。
- コミットメッセージは **`type(scope): description`**。スコープを必須にし、変更対象を具体的に示す。例: `fix(server): reject malformed request URLs`、`test(render): wait for desktop layout restoration`、`docs(maintenance): record development decisions`。
- **検証後のコミットは自動で行ってよい。push はユーザーが明示的に依頼した場合だけ実行する。** 実装・修正・テスト追加やコミットの依頼から push の許可を推測しない。過去の別の変更に対する push 依頼を、以後の変更への包括的な許可と扱わない。
- 既存のユーザー変更を保持し、依頼と無関係なファイルをまとめてコミットしない。

## 実装で維持すること

- 通常のビルドは Node の標準機能だけで完結させる。`dist/sonata.html` は、スタイル・コード・全デモ・ライセンスを含むオフラインで動く単一 HTML。
- `src/` は HTML・CSS を含む10ファイルを基本とする。`src/sonata.js` は起動・操作・カメラ・DOM 表示をまとめ、再生モデル、空間計算、固定シーン、動的表示、GPU は [構造の指針](docs/architecture.md) に沿って分ける。
- 共有状態の巨大な箱や汎用プラグイン基盤を追加せず、必要な依存を明示して渡す。分割は責務を基準にし、行数だけの細分化や無関係な処理の集約を避ける。
- 一緒に変更する処理と状態の所有者を近くに置く。100〜250行などの小さな上限を分割理由にせず、一つの変更を少数のファイルで理解・完結できるかを優先する。
- 記録値、推定値、未観測、表示上の演出を区別する。未観測のレジスタ値や依存関係を補完せず、commit / squash の結果を時刻より前に反映しない。
- デモ抽出時だけ `inputs/` または `SONATA_TRACE_ROOT` を使う。表示だけの変更ではデモを再生成しない。
- 第三者の出典・ライセンス原文を保持する。vendor 更新時は固定リビジョン、変更内容、ハッシュも更新する。

## 変更に応じた検証

Node は `.nvmrc`、依存は `package-lock.json` を基準にする。必要なら `npm ci` を実行する。

| 変更 | 検証 |
| --- | --- |
| 再生モデル、ビルド、ライセンス、データ、vendor | `npm test` |
| プレビューサーバー | `npm run test:server` |
| 描画、DOM、CSS、操作、描画検査スクリプト | `npm run test:render` |
| モバイルだけの調整 | 作業中は `npm run test:mobile`、最終確認はデスクトップへの復帰も含む |
| キーボード、ダイアログ、描画の障害対応 | 作業中は `npm run test:browser`、最終確認はこれらを含む `npm run test:render` |
| 文書だけ | 差分とリンク・コマンドの整合性を確認 |

画面のない Linux では `xvfb-run -a -s '-screen 0 1600x1100x24' npm run test:render` を使う。検証範囲と未検証の環境を区別して報告する。非同期の画面変化は、制限時間内で実状態を待ち、assertion を削って通さない。

## 記録と公開

- 作業の区切りで `work/WORKLOG.md` に依頼、変更理由、検証結果、残作業を追記する。ローカルの引き継ぎ資料がある場合は現在の状態も揃える。
- 将来の開発者にも必要な判断・制約・再現方法を `docs/` に反映する。個人環境の絶対パス、一時ログ、認証の状態は `work/` / `artifacts/` に置く。
- `work/`、`artifacts/`、`inputs/`、`dist/`、`node_modules/` は Git 対象外。公開文書がこれらの存在を必須にしない。
- 明示的に依頼された push の実行後は、コミット・CI・公開結果を確認する。`main` の push は CI 成功後に Pages を更新する。
