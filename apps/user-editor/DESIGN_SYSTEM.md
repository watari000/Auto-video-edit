# KINETIC ATELIER — Design System Specification (`apps/user-editor`)

## 1. Design Philosophy: Editorial Film Studio × Modern Japanese Minimalism
一般的な AI 生成テンプレートに見られる「白背景＋丸角カード＋均等な絵文字アイコン＋汎用ブルーボタン」を排し、**現代的な映画カラーグレーディングスイートと日本のエディトリアル誌**を融合したスタジオUIを構築する。

### Anti-AI-Template 原則
1. **カード乱用の廃止**: 全セクションを同じ白い丸角カードで囲わず、背景のコントラストと `1px` ヘアラインボーダー（`--line-subtle` / `--line-strong`）で空間を区切る。
2. **タイポグラフィの明確な階層**: セリフ体の大きな章番号（`Cormorant Garamond`）、可読性の高い日本語サンセリフ（`Zen Kaku Gothic New`）、タイムコードや仕様値のための等幅フォント（`JetBrains Mono`）を明確に使い分ける。
3. **スタジオワークベンチ構図**: デスクトップでは左側に「素材・トリミング・テロップ調整」、右側に追従（`sticky`）する「9:16 シネマモニター」を配置し、編集操作とプレビュー確認の視線移動を最小化する。
4. **触覚的なフィードバック**: カメラのRECランプを想起させるバーミリオン（`#ff4d1c`）とシャンパンゴールド（`#d4af7a`）、フィルムグレインの微細な質感、Expo Out カーブ（`cubic-bezier(0.16, 1, 0.3, 1)`）による滑らかなトランジションを採用する。

---

## 2. Color Tokens (`design-system.css`)

| Token | Value | Role |
| :--- | :--- | :--- |
| `--bg-canvas` | `#09090b` | スタジオ最背面（Obsidian Matte） |
| `--bg-elevated` | `#111114` | パネル・ワークベンチ面 |
| `--bg-panel` | `#16161b` | 入力欄・インナーモジュール面 |
| `--bg-glass` | `rgba(17, 17, 20, 0.78)` | スティッキーヘッダー用半透明面 |
| `--line-subtle` | `rgba(244, 241, 234, 0.09)` | 繊細なグリッド・区切り線 |
| `--line-strong` | `rgba(244, 241, 234, 0.22)` | ホバー・アクティブ枠線 |
| `--ink-primary` | `#f4f1ea` | 温かみのあるアイボリー本文 |
| `--ink-secondary` | `#a19d95` | 補足・ガイド説明文 |
| `--ink-muted` | `#6e6a63` | タイムコード・補助ラベル |
| `--accent-signal` | `#ff4d1c` | RECインジケーター・主要アクション（書き出しCTA） |
| `--accent-champagne` | `#d4af7a` | 見出しアクセント・時間尺ハイライト |
| `--sem-ok` | `#34d399` | 素材準備完了・良好判定 |
| `--sem-tip` | `#f59e0b` | 優しいアドバイス（暗さ・横向き補正） |
| `--sem-err` | `#fb7185` | エラー通知 |

---

## 3. Typography Scale
- **Display Serif (`--font-display`)**: `'Cormorant Garamond', Georgia, serif` — セクション番号（`01`〜`04`）およびブランド表記。
- **UI Sans (`--font-sans`)**: `'Zen Kaku Gothic New', 'Inter', -apple-system, BlinkMacSystemFont, "Hiragino Sans", sans-serif` — 日本語UI・撮影ガイド・エラー案内。
- **Technical Mono (`--font-mono`)**: `'JetBrains Mono', ui-monospace, monospace` — タイムコード（`00:01.5`）、解像度（`1080×1920`）、BPM（`85–105`）、進捗率。

---

## 4. Performance & iOS Safari Considerations
- フィルムグレイン（`.film-grain`）は `pointer-events: none` と軽量な静的インラインSVGデータURIのみを使用し、スクロール時の再描画負荷を抑える。
- `backdrop-filter` はトップナビゲーションのみに限定し、キャンバス描画や動画書き出し処理（`video-engine.js` / `video-exporter.js`）と競合しないよう配慮している。
