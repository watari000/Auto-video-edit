# AGY.md｜Antigravity 開発ガイド・エージェント行動規範

本リポジトリ（`Auto-video-edit`）で作業するAIエージェントおよび開発者は、[PROJECT_SPEC.md](./PROJECT_SPEC.md) に定義された方針・憲法・コーディング基準に従うこと。

## 1. プロジェクト憲法（5原則）
1. **RULE 01｜著作権・プラットフォーム規約の遵守**: 他者の元映像や商用音源を再配布しない。ガイドは自作SVGシルエットや撮影指示で抽象化し、書き出しは無音で行う。
2. **RULE 02｜プライバシー・ゼロサーバー原則**: `apps/user-editor/` では、利用者の画像・動画を外部へ送信しない（`File` / `Blob` / `ObjectURL` / `Canvas` でブラウザ内完結）。`fetch` は静的テンプレートとガイド素材（`shared/templates/...`）の取得のみ許可する。
3. **RULE 03｜Human-in-the-Loop**: `apps/creator-studio/` で生成したテンプレート・ガイドは、製作者が確認・承認したもの（`status: "published"`）のみ公開する。
4. **RULE 04｜製作者ツールのシンプルさ**: `apps/creator-studio/` は自分専用ツールとして簡潔に保つ。
5. **RULE 05｜低コスト・軽量構成**: ビルド不要の静的ホスティング構成（Vanilla ES Modules）と iPhone Safari で動作する軽量処理を基本とする。

## 2. 2層分離アーキテクチャとフォルダ構成
- `shared/schemas/template.schema.json`: 製作者・利用者共通のテンプレートJSONスキーマ（Draft 2020-12）。
- `shared/templates/<template-id>/`: 公開テンプレート本体（`template.json`）と図解SVG（`guide-assets/`）。
- `apps/user-editor/`: 利用者向け静的Webアプリ（撮影ガイド・プリチェック・スライドトリミング・Canvasプレビュー・無音動画書き出し）。
- `apps/creator-studio/`: 製作者専用ツール（Phase 2〜3で実装）。
- `tests/`: スキーマ検証・単体テスト・ローカル確認用静的サーバー。

## 3. コーディング規約
- **責務分離**: DOM操作（`src/*`）とメディア処理・スキーマ検証ロジック（`lib/*`）を分離し、純粋関数として単体テストできるようにする。
- **iOS Safari メモリ対策**:
  - 出力解像度は最大 `1080x1920`（偶数サイズ）、最大 `30fps` に制限する。
  - 生成した `ObjectURL` や一時 `Canvas` / `MediaStream` は使用後または `beforeunload` で必ず解放する。
- **エラー表示**: ユーザー向け画面では英語の生エラーを出さず、状況と対処法を日本語で案内する。
- **命名規則**:
  - ファイル名: `kebab-case`
  - 変数・関数名: `camelCase`
  - 定数: `UPPER_SNAKE_CASE`
- **コメント方針**: What だけでなく Why（例: Safariメモリ対策やH.264偶数ピクセル制約など）を簡潔に残す。

## 4. ローカル実行・テスト手順
- **自動テスト実行**:
  ```powershell
  node --test tests/validate-template.test.mjs
  ```
- **ローカルプレビュー起動**:
  ```powershell
  node tests/serve-static.mjs
  ```
  起動後、ブラウザで `http://localhost:4173/apps/user-editor/` を開く。

## 5. Git 運用ルール
- ファイルの作成・編集とテスト検証が完了したら、そのまま自動でローカルコミットまで行う。
- コミットメッセージは日本語で簡潔に変更内容を記載する。
- リモートへの `git push` は、ユーザーから明示的に指示された場合のみ実行する。
