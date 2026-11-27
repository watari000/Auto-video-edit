# Auto-video-edit

AIによる流行動画リサーチ＆撮影ガイド作成（製作者サイド）と、ブラウザ完結のローカル自動編集（利用者サイド）を分離したリール動画制作アシストWebアプリです。

詳細な仕様・憲法は [PROJECT_SPEC.md](./PROJECT_SPEC.md)、エージェント向け開発規範は [AGY.md](./AGY.md) を参照してください。

## フォルダ構成

```text
Auto-video-edit/
├── README.md
├── PROJECT_SPEC.md
├── AGY.md
├── .github/workflows/
├── shared/
│   ├── schemas/template.schema.json
│   └── templates/sample-cafe-01/
├── apps/
│   ├── creator-studio/        # 製作者用ツール（Phase 2〜3）
│   └── user-editor/           # 利用者用・ブラウザ完結自動編集アプリ（Phase 1 MVP）
└── tests/
    ├── serve-static.mjs       # ローカル確認用静的サーバー
    └── validate-template.test.mjs
```

## Phase 1 MVP の起動・検証方法（Node.js のみで動作）

ビルドツール不要の Vanilla HTML / CSS / ES Modules で実装しています。

### 1. テストの実行
```powershell
node --test tests/validate-template.test.mjs
```

### 2. ローカルWebアプリの確認
```powershell
node tests/serve-static.mjs
```
サーバー起動後、ブラウザで以下にアクセスしてください：
- 利用者向けエディタ: `http://localhost:4173/apps/user-editor/`
