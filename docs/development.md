# 開発ガイド

README は日本語で、機能・操作・開発手順を説明します。プロジェクト成立の経緯は README に記載しません。ソースコードと検証・ビルド用スクリプトの説明コメントは日本語で記述し、識別子・画面の文言・ライセンス原文はそれぞれの用途に合わせて維持します。

作業上の指針は [AGENTS.md](../AGENTS.md)、設計判断と過去の検査から得た確認事項は [継続開発のための判断と確認事項](maintenance.md) を参照してください。

## コミットと作業記録

検証後のコミットは自動で行って構いません。push はユーザーが明示的に依頼した場合だけ実行します。実装・修正・テスト追加やコミットの依頼から push の許可を推測せず、過去の別の変更に対する push 依頼を、以後の変更への包括的な許可と扱いません。

コミットメッセージはスコープ付き Conventional Commits の `type(scope): description` 形式にします。例: `fix(server): reject malformed request URLs`、`test(render): wait for desktop layout restoration`、`docs(maintenance): record development decisions`。変更対象を表すスコープを必須とし、一つの目的として説明できる変更をまとめます。

日付、依頼、変更理由、検証結果、残作業は `work/WORKLOG.md` に記録します。`work/` はローカルの履歴・引き継ぎ用で、Git 管理対象外です。継続して必要な仕様・判断理由・再現方法は `docs/` の関連文書へ反映し、個人環境のパスや一時的な調査ログはローカルに保持します。

## 並列作業用のworktree

親のチェックアウトを調整・統合の場所にし、編集を伴う各タスクを `task/<作業名>/` のworktreeと同名の `task/<作業名>` ブランチへ割り当てます。`task/` 全体はGit対象外で、必要なときだけ作成します。各worktreeはリポジトリの追跡ファイル一式を持ち、Gitのコミット・ブランチ情報を共有します。

親はまず独立した2タスク程度に分け、同じファイルや共通APIを変更する場合は担当と取り込み順を先に決めます。共有の型・関数を変更するタスクに依存する場合は、その変更を先に取り込み、後続のworktreeを作ります。

### 作成と割り当て

以下は親のチェックアウトのルートで実行します。`task-name` は未使用の作業名へ置き換えます。親の追跡ファイルの変更を先にコミットし、子へ渡す基点を確定してください。未コミットの編集は新しいworktreeへ引き継がれません。

```sh
git status --short
git worktree list
mkdir -p task
git worktree add -b task/task-name task/task-name HEAD
git -C task/task-name rev-parse --show-toplevel
git -C task/task-name rev-parse HEAD
```

最後の2コマンドで得た絶対パスと基点コミットを、目的・担当ファイル・共有インターフェース・完了条件・必要な検証とともにサブエージェントへ渡します。子が使うコマンドの作業ディレクトリと編集先を、そのworktreeに固定します。worktreeの作成だけでエージェントの作業場所が切り替わるわけではありません。同じブランチを親と子で同時にcheckoutしません。

親は `work/TASKS.md` に作業名、パス、ブランチ、基点、担当、変更範囲、状態、結果のコミットIDを記録します。これは並列作業を始めるときに作るローカル記録です。子が必要とする引き継ぎ情報は親が渡し、全体の `work/` を複製・共有しません。

子は担当worktreeのルートから既存のAGENTS・開発文書を読み、必要な検証に合わせて `npm ci` やビルドを実行します。`node_modules/`・`dist/`・`artifacts/` は各worktreeで管理し、親の生成物を上書きしません。各自の `work/WORKLOG.md` に理由と結果を残し、検証後にスコープ付きConventional Commitを作ります。

Electron/SwiftShaderの検査と性能計測は、worktree間でもCPU/GPUを共有します。親へ実行の開始・終了を連絡して順番に実行し、終了コードとログの場所を返します。プレビューサーバーを並べる場合は `SONATA_PORT` を分けます。

### レビューと統合

子は変更内容、コミットID、検証結果、残課題を親へ返します。親は担当範囲と差分を確認し、自身の統合先ブランチへ一つずつ取り込みます。以下も親のチェックアウトのルートで実行し、作業ツリーがクリーンであることを確認してからマージします。

```sh
git status --short
git log --oneline HEAD..task/task-name
git diff HEAD...task/task-name
git merge --ff -m "chore(worktree): integrate task-name" task/task-name
```

fast-forwardできる場合は既存コミットを保ち、分岐している場合は上記のスコープ付きメッセージでマージコミットを作ります。競合は親が担当者と調整して解消し、統合後の変更範囲に必要な検証を行います。各タスクの検証成功と、統合後の成功は分けて記録します。pushはユーザーから明示的に依頼された場合だけ親が実行します。

### 片付け

子と関連プロセスの終了後、親が必要な `work/` の記録や `artifacts/` を回収し、全体のWORKLOGへ結果をまとめます。継続して必要な判断は `docs/` に反映します。無視されたファイルも含めて確認し、残したい情報があるworktreeは保持します。

```sh
git -C task/task-name status --short --ignored
git merge-base --is-ancestor task/task-name HEAD &&
  git worktree remove task/task-name &&
  git branch -d task/task-name
git worktree list
```

取り込みの確認が失敗した場合や、削除をGitが拒否した場合は内容を調べます。`--force`で消さず、未コミットの変更と必要な記録を保存してから再実行します。空の `task/` は次の作業用に残せます。

## 境界

現在の `src/` は TypeScript 9個・CSS 3個・HTML 1個です。ファイル数は固定せず、責務と変更のまとまりに応じて見直します。各ファイルの責務と状態の所有者は [ソースの構造](architecture.md) を参照してください。

- `src/sonata.cts`: 起動、再生時計、共通操作、DOM と診断 API。
- `src/camera.cts`: カメラの状態・投影とマウス / タッチ操作。GPU 資源から独立。
- `src/replay-model.cts` / `src/geometry.cts`: トレース準備と再生状態、経路・接地。DOM / GPU から独立して検査可能。
- `src/scene.cts` / `src/activity.cts` / `src/renderer.cts`: 固定シーン、動的表示、WebGL 資源・影と描画。材質の GLSL は `src/shaders.cts`。
- `src/index.html` / `src/sonata.css` / `src/scene.css` / `src/appearance.css`: 画面の骨格、共通 UI、シーン、画面サイズと配色の上書き。CSS の適用順は HTML の link 順。
- `scripts/import-trace.ts` と関連モジュール: 元ログからデモ用の小さなデータを抽出。
- `vendor/konata-core/`: 抽出にだけ使う解析器の固定スナップショット。

描画ライブラリやフレームワークの実行時依存はありません。`window.sonata` は決定的な時刻シークと状態参照のための診断 API です。テストはこれを通して実データと画面を照合します。

## 整形

```sh
npm run format
npm run format:check
```

`src/` と自作の `scripts/` を、開発依存に固定した Prettier で整形します。設定は `.prettierrc.json` の4スペース・行幅120文字を目安とし、長い文字列やHTMLの空白の意味を保つために例外を許容します。文・型の項目・長い引数列を適切に改行し、行数を減らすために詰め直しません。データ・vendor・ライセンス原文・生成物・作業用worktreeは整形対象外です。

文字列内のスクリプトやGLSLは自動整形の対象外です。GLSLを編集するときも文ごとの改行と字下げを保ち、`#version`・補間・演算子の意味を変えないようにします。HTMLやCSSの整形は空白の意味が変わり得るため、描画検査も行います。CI は `npm run format:check` で整形を確認します。フォーマッターは通常ビルドには使いません。

## ビルド

`npm run build` は Node の標準ライブラリだけで、`src/index.html` にスタイル・スクリプト・デモを埋め込みます。出力は `dist/sonata.html`。ライセンス表示も HTML 内に保持します。埋め込み JSON の文字列内を変更せず、長すぎる行を改行します。

ブラウザ用の相対 CommonJS は `scripts/bundle.cjs` で結合します。`.cts` の型と CommonJS 用の import/export 構文は Node 標準の `stripTypeScriptTypes` の `transform` モードで変換します。新しいモジュールは拡張子付きの相対パスで参照し、実行時の外部読み込みを追加しません。ソースを直接開かず、ビルドした HTML または `npm start` で確認します。

`npm start` はビルドした HTML だけを配信します。ソースディレクトリや元ログを公開するサーバーではありません。環境変数 `SONATA_HOST` / `SONATA_PORT` で待ち受け先を変更できます。スマートフォンから同じネットワーク経由で確認する場合の例:

```sh
SONATA_HOST=0.0.0.0 npm start
```

端末のブラウザで開発マシンの IP アドレスとポート4173を開きます。

## 型検査

```sh
npm ci
npm run typecheck
```

`src/` の全 `.cts` と画面検査の `scripts/check-browser.cts` / `scripts/check-smoke.cts` / `scripts/browser-test.cts` を `tsconfig.json` の `strict` と `noEmit` で検査します。再生モデル・経路計算から UI・固定シーン・動的表示・GPU への型の受け渡しも対象です。デモ抽出スクリプトと vendor はこの型検査の対象外です。型のためだけに `src/` のファイルを増やさず、共有型は所有者のモジュールから公開します。

型検査用の TypeScript と Node の型定義は開発依存としてバージョンを固定します。通常ビルドはこれらを読み込みません。型変換だけでは型の正しさを検査できないため、CI は `npm run typecheck` と実行時の検証を別々に実施します。`scripts/check-types.cts` は誤った引数型や null の見落としを拒否することも確認し、型が `any` に落ちた場合に検出できるようにします。未生成の GPU 資源、Aluminum / Paper の材質設定、経路計算で保持すべき命令・ステージ情報も型の回帰検査に含めます。

[Node の TypeScript 対応](https://nodejs.org/docs/latest-v22.x/api/typescript.html)に合わせ、CommonJS を明示する `.cts` を使います。直接読み込む Node の検査は `--experimental-transform-types` 付きで起動します（`npm test` に設定済み）。変換 API は実験的なので、`.nvmrc` の更新時は型検査、モジュール結合、依存なしの再現ビルドを確認してください。独自の構文変換器や tsconfig のパス別名は追加しません。

## 検証

`npm test` は再生モデルの整合性、紙箱・金属パックの接地と正立した滑走、ビルドの独立性を検査します。ビルド検査は、必要なソースだけを別の一時ディレクトリにコピーし、`node_modules` や Konata のチェックアウトなしで同一 HTML を作れることを確認します。デモの内容、UTF-8、外部スクリプトの不在、vendor のハッシュも確認します。

`scripts/check-scene.cjs` は全5デモの配置と命令経路を DOM / GPU なしで準備し、別のインスタンスへの状態混入と元データの変更を検出します。未読込み・空の一覧・読込み失敗時の状態保持と、再読込み後も配置が同じ参照を使えることも確認します。`scripts/check-bundle.cjs` は独立した JavaScript 環境で相対パス、変数スコープ、一度だけの実行、循環参照、不正な参照の拒否を確認します。`scripts/check-browser-test.cjs` はページ内関数の引数・Promise・例外の受け渡しと、フレーム待機・期限超過時の診断を別のJavaScript実行環境で確認します。条件・診断・描画の無応答、期限後の結果と例外、期限タイマーの回収も検査します。いずれも `npm test` に含まれます。

Node の推奨バージョンは `.nvmrc` に固定し、セキュリティ修正版へ更新します。`npm run test:server` はローカルでサーバーを起動し、GET / HEAD、ソースの非公開、未対応メソッドと不正な URL の拒否、異常なリクエスト後も配信が継続することを確認します。

`THIRD_PARTY_NOTICES.md` と `licenses/` の原文は、配布 HTML の **Licenses** パネルへ埋め込みます。デモの元プログラムやライセンスが変わった場合はこれらも更新し、`npm test` で全文の保持を確認してください。

`npm run test:smoke` は、単一HTMLの起動と再生・操作、全5デモの代表時刻、3スタイルの描画、モバイル1サイズからデスクトップへの復帰、ライセンス表示を短く確認します。全描画検査と同じHTML単体コピー・外部要求禁止・一時プロファイルを使います。

`npm run test:render` は、ビルドした単一 HTML だけを別の一時ディレクトリへコピーして Electron で開きます。外部リソースへのアクセスを禁止し、全5デモの FIFO、ステージ、pipe と接続線、依存行列、レジスタ、フラッシュ、Top-down、操作を検査します。OS の動きを減らす設定でも再生・演出が自動で始まること、手動で演出を OFF / ON にできること、再読込み時は再び ON になることも確認します。

モバイルは DPR 2 とタッチイベントを使い、320 × 568、390 × 844、430 × 932、932 × 430 で検査します。ピンチ、2本指の移動、指を離した後の回転、キャンセル、Fit、設定パネル、横向きからの復帰を含みます。実機 Safari / Chrome の検査を置き換えるものではありません。

ブラウザの回帰検査は `scripts/check-browser.cts` にまとめ、`npm run test:render` と手動の全描画CIに含めています。個別に実行する場合は `npm run test:browser` を使います。ページ内で実行する操作も TypeScript の関数として記述し、診断 API の名前や引数の変更を型検査で検出します。検査用モジュールは Electron 側で Node 標準の型除去を使って読み込み、製品 HTML には含めません。共通の待機処理は `scripts/browser-test.cts` が担当し、検査ごとの期限・収束条件・失敗時の診断は呼び出し側で指定します。

`waitFor` の `timeout` は条件の確認全体の期限です。1回の確認が応答しなくても終了し、ポーリングごとに期限を更新しません。既存の5秒・10秒・カメラ収束30秒と、50/60msの確認間隔を維持します。失敗時の診断取得は追加で最大1秒（`diagnosticsTimeout`）とし、診断が失敗しても元の検査メッセージを残します。`settle` は2フレームと任意の `gl.finish()` を合計10秒以内に待ち、必要なら `timeout` を指定できます。

- Electron の入力イベントで、矢印・Space・Cinema・Escape と、トレースの先頭・末尾の境界を検査します。
- 右ドラッグ・左ドラッグ・ホイールの実入力でズームと回転の分離を確認し、ズームボタン・ピンチの拡大上限と Fit への復帰も検査します。
- range / select / button にフォーカスがある場合、全体のショートカットが重複して動かないことを確認します。Licenses のキーボード操作、Tab のフォーカス範囲、Escape 後のフォーカス復帰も検査します。
- 初期化時に WebGL 2 を利用できない状態を作り、案内と権利表示が利用できることを確認します。
- Neon / Aluminum / Paper それぞれで実際の WebGL context loss / restore を発生させ、案内、再生時計の停止、復旧後の再生と描画画素を確認します。Aluminum / Paper の材質テクスチャと投影影を復旧後にも生成できることを含め、単なるフラグの変化だけで復旧成功とは判定しません。
- MSAA を使えない環境を注入し、Paper の不透明な小さな折り箱と Aluminum の金属パックが、描画画素を出して WebGL エラーなく動作することを確認します。材質拡大のカメラ収束は、Fit・最大拡大と同じく最大30秒待ち、許容誤差は変えません。

スタイルの比較検査は `scripts/check-styles.cjs` にまとめ、`npm run test:styles` で個別実行できます。全5デモで3スタイルの切り替え前後の再生状態・水平座標・選択を照合し、再生の継続、スタイルごとの命令形状の固定、命令選択と描画画素の変化、Aluminum / Paper のモバイル4画面とタッチ操作も確認します。スタイルボタンと視点ボタンの見た目を照合し、モバイルでは44px以上の操作領域、ヒット判定、実タッチ・Spaceでのスタイル切り替え、再生ショートカットとの分離も検査します。これらは全体の `npm run test:render` に含まれます。[外観の仕様](visual-styles.md)に画像の出力先と設計判断を記載しています。

実トレースで移動・待機・停止・シーク・デモ再読込み後の姿勢を検査し、紙の折り箱と金属パックが Motion effects の OFF / ON でも同じ向きと駒の画素を保つことを確認します。画像の比較は canvas 自体から読み取り、図に重なる操作ボタンの文字を画素差に含めません。

命令のサイズは全5デモの見どころをシークし、同じフレーム内と異なる時点で半径が変わらないことを確認します。スケジューラ・ROB・Rn の全配置先も照合し、駒の直径より間隔が広いことを検査します。

`scripts/check-stage-layout.cjs` は、スケジューラの横線・縦線が表示容量と一致し、実際のGPU描画に各1本ずつ含まれることを照合します。Rnは元トレースの全滞在区間で配置先の重複を検査し、再生範囲内の混雑する時刻で全命令の表示、間隔、シークでの復元も確認します。この検査は `test:styles` と全 `test:render` に含まれます。

ステージ間の移動は `scripts/check-stage-transfers.cjs` で、全5デモの異なるステージ間とROB→COMMIT・退場を細かくシークし、両端より土台まで落ちること、急な高さの跳び、水平経路やシーク順によるずれを検出します。

接地は `scripts/check-piece-grounding.cjs` で、紙の折り箱と金属パックの寸法、角と面取り、傾斜面、台の縁、シーク順からの独立性と、障害物判定用の外接球を検査します。描画検査の `scripts/check-grounded-pieces.cjs` はユニット上の接触点、ステージ間の非接地、実際の GPU バッファの座標・半径を照合します。スタイル間で Y 座標が変わるため、共通の水平経路と再生状態を比較し、命令選択は接地後の画面座標に実入力を送ります。

動く命令の影は `scripts/check-piece-shadows.cjs` で、同じフレームから影だけを除いた画素と比較します。面が暗くなること、時刻に合わせて影が移動すること、停止・シークで同じ描画へ戻ること、両形状に影があることを確認します。カメラ操作では影を再生成せず、Neon に戻すと影のターゲットを解放することも検査します。これらは `test:styles` と全 `test:render` に含まれます。

モバイル検査では設定パネルを開いたままデスクトップへ戻すケースも含め、サイドバー・ダイアログ・フォーカスの復帰を確認します。

ヘッドレス Linux の実行例:

```sh
xvfb-run -a -s '-screen 0 1600x1100x24' npm run test:smoke
xvfb-run -a -s '-screen 0 1600x1100x24' npm run test:render
xvfb-run -a -s '-screen 0 1600x1100x24' npm run test:mobile
xvfb-run -a -s '-screen 0 1600x1100x24' npm run test:browser
```

描画検査は一時的なブラウザプロファイルを使い、ローカルでもCIと同じ初期状態から始めます。大量の時刻やスタイルを続けて検査するときは、`createBrowserTest(window).sampleFrame(() => evaluate(...))` で状態の採取と1フレームの待機を行います。戻り値は待機前に採取した状態で、採取と待機は合計10秒（必要なら `timeout`）に制限されます。

通常のpush / pull requestでは、整形・型・モデル・ビルド・サーバーの検査と `npm run test:smoke` を実行します。`verify` は最大5分、その中の基本描画ステップは最大3分です。全時刻走査、複数画面のタッチ操作、材質拡大・影の比較、全スタイルの障害復旧は通常CIへ含めず、ローカルの全検査を維持します。

GitHub Actionsで全描画検査を行う場合は **Verify and publish Sonata → Run workflow → full_render** を選びます。手動実行の入力は既定でOFFです。ONの場合は基本描画を重複実行せず `npm run test:render` を実行し、検証ジョブの上限を25分にします。基本検査と全検査の成功を区別し、全検査が必要な変更では [AGENTS.md](../AGENTS.md#変更に応じた検証) に従ってローカルで確認してください。各描画区間の開始・終了・経過秒はログから確認できます。

描画検査の標準出力・標準エラーは `artifacts/ci-render.log` にも保存します。失敗時は末尾60行（最大10,000文字）を `Rendering failure` の検査注釈に載せ、ログAPIの権限がなくても AssertionError と前後の情報を確認できるようにします。`pipefail` で元の検査失敗を維持し、注釈出力の成否で成功扱いにしません。

画像は `artifacts/screenshots/` に保存します。SwiftShader による CPU 描画で検証するため、記録される fps は実 GPU の速度と異なります。

既存の HTML 自体を検査したい場合は、`SONATA_HTML=/path/to/sonata.html` を指定します。通常は毎回ビルドするので、古い生成物を誤って検査しません。`npm run capture:flush` はビルド済み HTML の通常再生から巻き戻し・分解中の画像を取得します。

## Git に含めるもの

ソース、埋め込みデモ、ロックファイル、解析器の出典、文書を管理します。README 用の代表画像だけは `docs/images/overview.png` に置きます。日々のスクリーンショットやレポートは `artifacts/`、配布用 HTML は `dist/`、元ログは `inputs/` に分離し、これらは `.gitignore` で除外します。

Konata の解析コードを更新する場合は [vendor の手順](../vendor/konata-core/README.md) に従い、デモの再生成と描画検査を実行してください。ブラウザ側の演出を変えるだけなら、元ログや解析器の再生成は不要です。

## ライブデモの公開

公開先は https://shioyadan.github.io/sonata/ です。初回公開前に GitHub リポジトリの **Settings → Pages → Build and deployment → Source** を **GitHub Actions** に設定してください。

`.github/workflows/ci.yml` は `main` への push または手動実行でモデル・ビルド・サーバーと、選択された範囲の描画を検証し、成功した同じコミットから `dist/sonata.html` を生成して、Pages の `index.html` として公開します。pull request は検証だけを行います。通常は基本描画検査、手動で `full_render` を選んだ場合は全描画検査が公開条件です。Pagesジョブの上限は5分です。依存パッケージやソース、元ログを公開用ディレクトリへコピーしません。

README 冒頭の **ライブデモ** はこの公開先へリンクします。push 後は GitHub Actions で対象コミットの `verify` と `pages` が成功したことを確認し、公開 URL の応答と生成 HTML の内容を確認します。`verify` が失敗した場合は `pages` がスキップされ、初回は未公開、既存サイトがある場合は前の公開内容が維持されます。
