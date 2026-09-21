# LINE Memo Sync

LINE に送ったメモが、そのまま Obsidian の Vault に貯まる Obsidian プラグインと受付サーバーです。
LINE 公式アカウント「Obsidian Memo」と対で使います。

## できること

- LINE 公式アカウントに送ったテキストが、次に Obsidian を開いたときに `LINE/` フォルダに入る
- 受け取った瞬間に本人だけの鍵をかけて預かるので、保存されたメモを運営者は読めない。鍵が未登録の間はメモを預からず、設定を促す
- 連携は LINE が発行する6桁の連携コード（10分有効）で行う。LINE User ID を貼る必要はなく、ID を知っている第三者が他人の連携を奪えない
- 自動同期（1〜5時間ごと）と起動時同期。預かるのは10日間なので、それまでに一度 Obsidian を開く
- 本人がオンにした場合だけ、種類別（タスク／アイデア／リンク／メモ）の件数をサーバーに送る。本文は送らない。既定はオフ

受け取るのはテキストだけです。画像・音声・決済は扱いません。

正直な注意点: LINE からの受信は平文で届き、サーバー内で暗号化しています。端末間の完全な E2E ではなく、「保存後は運営者も読めない」設計です。

## 構成

```
packages/
  obsidian-plugin/    Obsidian プラグイン本体
  cloudflare-worker/  受付サーバー（Cloudflare Workers + KV + D1）
docs/                 やさしい要件・設計と、公開までの手順
```

## 台帳（D1）に持つもの

| テーブル | 中身 |
|---|---|
| users | LINE User ID、Vault ID、登録日、最終送信日、送信件数、集計共有のオン／オフ |
| category_stats | 日付ごとの種類別件数（本人がオンにした場合だけ） |

メモ本文はどこにも保存しません。KV に一時保管する本文は暗号化済みで、同期が終わった時点で削除します。

## 開発

```bash
pnpm install
pnpm test:run
pnpm --filter obsidian-plugin build
pnpm --filter cloudflare-worker dev
```

公開までの手順は [docs/SETUP.md](docs/SETUP.md) を参照。

## 由来とライセンス

このプロジェクトは onikun94 氏の [LINE Notes Sync](https://github.com/onikun94/line_to_obsidian)（MIT ライセンス）を土台に、テキスト専用・台帳付きに整えたものです。元の著作権表示は LICENSE に残しています。本プロジェクトも MIT ライセンスです。
