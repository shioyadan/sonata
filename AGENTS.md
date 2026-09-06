# Sonata の作業指針

このリポジトリ全体に適用します。

## 最初に読むもの

- [README.md](README.md): 起動、操作、構成。
- [docs/development.md](docs/development.md): ビルド、検証、コミット、公開の手順。
- [docs/maintenance.md](docs/maintenance.md): 作業履歴から抽出した設計判断と保守上の注意。
- 表示を変更する場合は [docs/visualization.md](docs/visualization.md)。
- ローカルに `work/` があれば、`WORKLOG.md` の最新項目と `STATE.json`、必要に応じて `HANDOFF.md` を読む。`work/` は Git 対象外なので、新しいチェックアウトには存在しなくてよい。

## 作業範囲と表記

- 作業対象は独立した Sonata リポジトリ。別の Konata チェックアウトや元ログを変更しない。
- README、開発文書、ソースコードの説明コメントは日本語。画面の文言、識別子、エラーメッセージ、ライセンス原文は既存の方針を保つ。
- README は機能・操作・開発を説明し、プロジェクト成立の経緯は記載しない。ブランド表示は `sonata` の文字を用いる。
- コミットメッセージは **`type(scope): description`**。スコープを必須にし、変更対象を具体的に示す。例: `fix(server): reject malformed request URLs`、`test(render): wait for desktop layout restoration`、`docs(maintenance): record development decisions`。
- 既存のユーザー変更を保持し、依頼と無関係なファイルをまとめてコミットしない。

## 実装で維持すること

- 通常のビルドは Node の標準機能だけで完結させる。`dist/sonata.html` は、スタイル・コード・全デモ・ライセンスを含むオフラインで動く単一 HTML。
- 再生モデルは `src/replay-model.js`、描画・DOM・操作は `src/sonata.js` に分ける。
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
| 文書だけ | 差分とリンク・コマンドの整合性を確認 |

画面のない Linux では `xvfb-run -a -s '-screen 0 1600x1100x24' npm run test:render` を使う。検証範囲と未検証の環境を区別して報告する。非同期の画面変化は、制限時間内で実状態を待ち、assertion を削って通さない。

## 記録と公開

- 作業の区切りで `work/WORKLOG.md` に依頼、変更理由、検証結果、残作業を追記する。ローカルの引き継ぎ資料がある場合は現在の状態も揃える。
- 将来の開発者にも必要な判断・制約・再現方法を `docs/` に反映する。個人環境の絶対パス、一時ログ、認証の状態は `work/` / `artifacts/` に置く。
- `work/`、`artifacts/`、`inputs/`、`dist/`、`node_modules/` は Git 対象外。公開文書がこれらの存在を必須にしない。
- push はユーザーの依頼範囲で行う。`main` の push は CI 成功後に Pages を更新するため、実行後はコミット・CI・公開結果を確認する。
