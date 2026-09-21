# 公開までの手順（本人操作が必要なところ）

## 実施済み（2026-09-22）

| 項目 | 値 |
|---|---|
| 公式 LINE | Obsidian Memo（2026-09-22 に「タクト｜AIに任せる側のスキル」から改名。ベーシックID @450xsede、友だち追加 https://line.me/R/ti/p/@450xsede。改名後7日間は再変更不可） |
| Messaging API | 有効。プロバイダー「タクト」、Channel ID 2011689071。Webhook オン、応答メッセージ・あいさつメッセージはオフ |
| 受付サーバー | https://line-memo-sync.linememo.workers.dev（Cloudflare アカウント hatakeyama@viable.jp。KV 3つ・D1 台帳作成済み、schema 適用済み） |
| Webhook URL | https://line-memo-sync.linememo.workers.dev/webhook（LINE 側に設定済み） |
| ADMIN_KEY | 登録済み。値は `~/.config/line-memo-sync-admin-key` |
| プラグイン | 本番 URL と友だち追加リンク入りでビルドし、自分の Vault に配置済み |

残り: LINE_CHANNEL_ACCESS_TOKEN と LINE_CHANNEL_SECRET の `wrangler secret put`（本人が貼る）→ LINE Developers で Webhook「検証」→ 実機テスト。

LINE と Cloudflare のアカウント操作は本人が行う。Claude はコマンドと設定ファイルを用意する。

## 1. LINE 公式アカウントで Messaging API を有効にする

1. https://manager.line.biz で「Obsidian Memo」を開く
2. 設定 → Messaging API → 「Messaging API を利用する」→ プロバイダーを作成（名前は何でもよい）
3. https://developers.line.biz/console/ で該当チャネルを開く
4. Messaging API 設定タブで次を控える
   - チャネルシークレット（Basic settings タブ）
   - チャネルアクセストークン（長期）を発行
5. 同じタブで「応答メッセージ」をオフ、「Webhook の利用」をオンにする（Webhook URL は手順 3 のあとで入れる）

## 2. Cloudflare に受付サーバーを作る

Cloudflare アカウントが無ければ https://dash.cloudflare.com で作る（無料）。

```bash
cd /Users/yosuke/cc/labs/active/line-memo-sync/packages/cloudflare-worker
pnpm exec wrangler login
```

```bash
pnpm exec wrangler kv namespace create LINE_MESSAGES
```

```bash
pnpm exec wrangler kv namespace create LINE_USER_MAPPINGS
```

```bash
pnpm exec wrangler kv namespace create LINE_PUBLIC_KEYS
```

```bash
pnpm exec wrangler d1 create line-memo-sync-ledger
```

出力された id を `wrangler.toml` の `REPLACE_WITH_...` に貼る（Claude に任せてよい）。次に台帳の表を作る。

```bash
pnpm exec wrangler d1 execute line-memo-sync-ledger --remote --file=schema.sql
```

秘密情報を登録する（貼り付けを求められる）。

```bash
pnpm exec wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
```

```bash
pnpm exec wrangler secret put LINE_CHANNEL_SECRET
```

```bash
pnpm exec wrangler secret put ADMIN_KEY
```

デプロイ。

```bash
pnpm deploy
```

出力される `https://line-memo-sync.<アカウント名>.workers.dev` が受付サーバーの URL。

## 3. Webhook を向ける

LINE Developers の Messaging API 設定タブで Webhook URL に `https://line-memo-sync.<アカウント名>.workers.dev/webhook` を入れ、「検証」を押して成功を確認する。

## 4. プラグインをビルドする

受付サーバーの URL を焼き込んでビルドする。

```bash
cd /Users/yosuke/cc/labs/active/line-memo-sync/packages/obsidian-plugin && NODE_ENV=production OBSIDIAN_LINE_API_URL=https://line-memo-sync.<アカウント名>.workers.dev LINE_ADD_FRIEND_URL=https://lin.ee/xxxx pnpm build
```

できた `main.js` と `manifest.json`、`styles.css` を配布する。

## 5. 配布の方法

| 方法 | 手順 | 向き |
|---|---|---|
| 手動 | Vault の `.obsidian/plugins/line-memo-sync/` に3ファイルを置き、コミュニティプラグインで有効化 | 最初のテスト |
| BRAT | GitHub リポジトリにリリースを作り、フォロワーは BRAT で `<配布元の GitHub アカウント>/line-memo-sync` を追加 | 公式一覧に載るまで |
| 公式一覧 | https://github.com/obsidianmd/obsidian-releases に PR を出す。審査に数週間 | 本番 |

## 6. 動作確認

1. 自分の LINE で公式アカウントに「連携コード」と送る → 6桁のコードが返る（10分有効）
2. Obsidian の設定で「連携コード」に6桁を入れて Register（Vault ID は空なら自動で作られる）
3. 「テスト」と送る → 「受け取りました」と返る。「設定が途中です」と返ったら Register をもう一度押す
4. Obsidian の同期ボタンを押す → `LINE/` に日付ファイルができる
5. 設定の「利用状況の共有」をオンにして同期 → `/admin/summary` の categoriesByMonth に件数が入る

## 7. 発信の種を見る

```bash
curl -s -H "X-Admin-Key: <ADMIN_KEY>" https://line-memo-sync.<アカウント名>.workers.dev/admin/summary
```

登録者数、直近7日の利用者数、集計共有をオンにした人数、月ごとの種類別件数が返る。
