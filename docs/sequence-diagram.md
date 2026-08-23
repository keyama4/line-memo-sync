# LINE to Obsidian シーケンス図

このドキュメントでは、LINEメッセージ（テキスト・画像・音声）からObsidianへの保存までの流れ、および決済フローを説明します。バックエンドはCloudflare Workers + KV + R2で構成され、Obsidianプラグインは自動/手動同期のタイミングでWorkerにポーリング（GETリクエスト）してメッセージを取得します。

- テキストメッセージ同期フロー
- 画像送信フロー
- 音声文字起こしフロー
- Stripe決済フロー

## テキストメッセージ同期フロー

```mermaid
sequenceDiagram
    actor User
    participant LINE
    participant Worker as Cloudflare Worker
    participant KV as KV (LINE_MESSAGES)
    participant Obsidian_Plugin
    participant Obsidian_Vault

    Note over User,Obsidian_Vault: 初期設定フェーズ
    User->>Obsidian_Plugin: プラグインインストール
    User->>LINE: LINE公式アカウントを友達追加
    User->>LINE: /myid を送信
    LINE->>Worker: Webhookイベント送信
    Worker-->>LINE: LINE User IDを返信
    User->>Obsidian_Plugin: LINE User ID / Vault ID を入力し登録
    Obsidian_Plugin->>Worker: POST /mapping (userId, vaultId)
    Obsidian_Plugin->>Worker: POST /publickey/register (E2EE公開鍵)

    Note over User,Obsidian_Vault: メッセージ送信フェーズ
    User->>LINE: テキストメッセージ送信
    LINE->>Worker: Webhookイベント送信<br/>POST /webhook
    Worker->>Worker: LINE署名検証 + Vault ID解決

    alt Vaultマッピング未登録
        Worker-->>LINE: 連携案内メッセージを返信<br/>(LINE User IDを含む)
    else Vaultマッピング済み
        Worker->>Worker: E2EE公開鍵で本文を暗号化<br/>(公開鍵未登録時は平文で保存)
        Worker->>KV: 暗号化メッセージを保存<br/>(TTL 10日)
        Worker-->>LINE: 200 OK
    end

    Note over User,Obsidian_Vault: 同期フェーズ（ポーリング）
    Obsidian_Plugin->>Worker: GET /messages/:vaultId/:userId
    Worker->>KV: 未同期メッセージを取得
    Worker-->>Obsidian_Plugin: メッセージ一覧を返却
    Obsidian_Plugin->>Obsidian_Plugin: 秘密鍵で復号
    Obsidian_Plugin->>Obsidian_Vault: Markdownファイル作成
    Obsidian_Plugin->>Worker: POST /messages/update-sync-status
    Worker->>KV: synced=true に更新
    Obsidian_Plugin->>User: 通知表示<br/>(メッセージ保存完了)
```

### フローの説明

#### 初期設定フェーズ
1. ユーザーがObsidianプラグインをインストール
2. LINE公式アカウントを友達追加し、`/myid` を送信してLINE User IDを取得
3. Obsidianプラグイン設定でLINE User ID / Vault IDを入力し「Register」を実行
   - `POST /mapping` でVault IDとLINE User IDの紐付けをKVに保存
   - `POST /publickey/register` でE2EE用のRSA公開鍵をWorkerに登録

#### メッセージ送信フェーズ
1. ユーザーがLINEでテキストメッセージを送信
2. LINEがWebhookイベントをCloudflare WorkerのPOST `/webhook` に送信
3. Workerが署名検証後、Vault IDマッピングを確認
   - 未登録の場合：連携案内とLINE User IDを返信
   - 登録済みの場合：公開鍵があればAES-GCM+RSA-OAEPで本文を暗号化し、KV（`LINE_MESSAGES`、TTL 10日）に保存

#### 同期フェーズ（ポーリング）
1. Obsidianプラグインが手動 or 自動同期タイミングで `GET /messages/:vaultId/:userId` を実行
2. Workerが未同期メッセージをKVから取得して返却
3. プラグインが秘密鍵で復号し、Markdownファイルを作成
4. `POST /messages/update-sync-status` で同期済みフラグを更新
5. プラグインがユーザーに完了通知を表示

## 画像送信フロー

```mermaid
sequenceDiagram
    actor User
    participant LINE
    participant Worker as Cloudflare Worker
    participant KV as KV (LINE_SUBSCRIPTIONS / LINE_MESSAGES)
    participant R2 as R2 (LINE_IMAGES)
    participant Obsidian_Plugin
    participant Obsidian_Vault

    User->>LINE: 画像を送信
    LINE->>Worker: Webhookイベント送信<br/>POST /webhook (type=image)
    Worker->>Worker: Vault ID解決

    alt Vaultマッピング未登録
        Worker-->>LINE: 連携案内メッセージを返信
    else Vaultマッピング済み
        Worker->>KV: サブスクリプション状態を取得

        alt 無料枠を使い切り / 支払い遅延で猶予期間も終了
            Worker-->>LINE: アップグレード or 支払い確認を促す返信
        else 送信可能（無料枠内 or プレミアム）
            Worker->>LINE: 画像コンテンツを取得（Content API）
            Worker->>Worker: サイズチェック（上限10MB）
            Worker->>Worker: 公開鍵があれば画像を暗号化
            Worker->>R2: 暗号化 (or 平文) 画像を保存<br/>キー: vaultId/userId/messageId
            Worker->>KV: 画像メタデータを保存<br/>(TTL 7日)
            Worker->>KV: 画像送信カウントを+1
            opt 無料枠の残りが3枚
                Worker->>LINE: 残り枚数の注意をpush通知
            end
            Worker-->>LINE: 200 OK
        end
    end

    Note over Obsidian_Plugin,Obsidian_Vault: 同期フェーズ（ポーリング）
    Obsidian_Plugin->>Worker: GET /images/:vaultId/:userId
    Worker->>KV: 未同期の画像メタデータを取得
    Worker-->>Obsidian_Plugin: 画像メタデータ一覧を返却
    Obsidian_Plugin->>Worker: GET /images/:vaultId/:userId/:messageId/content
    Worker->>R2: 画像バイナリを取得
    Worker-->>Obsidian_Plugin: 画像データを返却
    Obsidian_Plugin->>Obsidian_Plugin: 秘密鍵で復号
    Obsidian_Plugin->>Obsidian_Vault: 画像ファイル + ノートを作成
    Obsidian_Plugin->>Worker: POST /images/update-sync-status
    Worker->>KV: synced=true に更新
    Worker->>R2: 同期済み画像をR2から削除
    Obsidian_Plugin->>User: 通知表示<br/>(画像保存完了)
```

### フローの説明
1. ユーザーがLINEで画像を送信すると、WorkerがVault IDマッピングとサブスクリプション状態（`LINE_SUBSCRIPTIONS`）を確認する
2. 無料プランは累計10枚まで送信可能。枠を使い切った場合や支払いに問題がある場合はアップグレード・支払い確認を促す返信を行い、画像は保存しない
3. 送信可能な場合、LINE Content APIから画像を取得し10MB以内かチェックした上で、E2EE公開鍵が登録済みならAES-GCMで暗号化してR2（`LINE_IMAGES`）に保存し、メタデータをKVに保存する（TTL 7日）
4. 無料プランの残り枚数が3枚になった時点でpush通知を送る
5. Obsidianプラグインは同期タイミングで画像メタデータと画像本体を取得し、復号してVaultに画像ファイルとノートを作成する
6. 同期完了をWorkerに通知すると、Workerは対象画像をR2から削除する。同期されないまま7日経過した画像はTTLにより自動的に期限切れとなる

## 音声文字起こしフロー

```mermaid
sequenceDiagram
    actor User
    participant LINE
    participant Worker as Cloudflare Worker
    participant KV as KV (LINE_SUBSCRIPTIONS / LINE_MESSAGES)
    participant WorkersAI as Cloudflare Workers AI (Whisper)
    participant Obsidian_Plugin
    participant Obsidian_Vault

    User->>LINE: 音声メッセージを送信
    LINE->>Worker: Webhookイベント送信<br/>POST /webhook (type=audio)
    Worker->>Worker: Vault ID解決

    alt Vaultマッピング未登録
        Worker-->>LINE: 連携案内メッセージを返信
    else Vaultマッピング済み
        Worker->>KV: サブスクリプション状態を取得（文字起こし回数）

        alt 無料枠(累計10回)を使い切り
            Worker-->>LINE: アップグレードを促す返信
        else 文字起こし可能（無料枠内 or プレミアム）
            Worker->>LINE: 音声コンテンツを取得（Content API）
            Note over Worker,WorkersAI: 音声データはサーバー側で処理される<br/>（テキスト/画像のE2E暗号化とは異なる）
            Worker->>WorkersAI: 音声データを送信し文字起こしを依頼
            WorkersAI-->>Worker: 文字起こしテキストを返却
            Worker->>Worker: 音声データを破棄（サーバーに保存しない）
            Worker->>Worker: 公開鍵があれば文字起こしテキストを暗号化
            Worker->>KV: テキストメッセージとして保存<br/>(TTL 10日)
            Worker->>KV: 文字起こし回数を+1
            opt 無料枠の残りが3回
                Worker->>LINE: 残り回数の注意をpush通知
            end
            Worker-->>LINE: 200 OK
        end
    end

    Note over Obsidian_Plugin,Obsidian_Vault: 同期フェーズ（テキスト同期フローと共通）
    Obsidian_Plugin->>Worker: GET /messages/:vaultId/:userId
    Worker-->>Obsidian_Plugin: 文字起こし結果を含むメッセージ一覧
    Obsidian_Plugin->>Obsidian_Plugin: 秘密鍵で復号
    Obsidian_Plugin->>Obsidian_Vault: Markdownファイル作成
    Obsidian_Plugin->>Worker: POST /messages/update-sync-status
```

### フローの説明
1. ユーザーがLINEで音声メッセージを送信すると、Workerがサブスクリプション状態（文字起こし回数）を確認する
2. 無料プランは累計10回まで。枠を使い切った場合はアップグレードを促す返信のみ行う
3. 文字起こし可能な場合、LINE Content APIから音声データを取得し、**Cloudflare Workers AI（Whisper）にサーバー側で送信して文字起こしを行う**。これはテキスト・画像がE2E暗号化されるのに対し、音声は処理の性質上サーバー側で内容を扱う点で異なる
4. 音声ファイル自体はサーバーに保存されず、文字起こし後に破棄される
5. 文字起こし結果のテキストは、通常のテキストメッセージと同じE2E暗号化を適用してKVに保存される（TTL 10日）
6. 無料プランの残り回数が3回になった時点でpush通知を送る
7. Obsidianプラグインへの同期はテキストメッセージ同期フローと同じ経路（`GET /messages/:vaultId/:userId` によるポーリング）で行われる

## Stripe決済フロー

```mermaid
sequenceDiagram
    actor User
    participant LINE
    participant Worker as Cloudflare Worker
    participant Stripe
    participant KV as KV (LINE_SUBSCRIPTIONS)

    Note over User,KV: アップグレード（Checkout開始）
    User->>LINE: /upgrade または「アップグレード」を送信
    LINE->>Worker: Webhookイベント送信
    Worker->>Stripe: Checkout Session作成<br/>(metadata: lineUserId)
    Stripe-->>Worker: Checkout URL
    Worker-->>LINE: Checkout URLを返信

    Note over User,KV: 決済完了
    User->>Stripe: Checkout URLで決済を完了
    Stripe->>Worker: Webhook: checkout.session.completed
    Worker->>Worker: 署名検証
    Worker->>KV: status=active, stripeCustomerId,<br/>subscriptionId を保存
    Worker->>KV: customerId → lineUserId の逆引きindexを保存
    Worker->>LINE: push通知（プレミアム開始）

    Note over User,KV: 支払い失敗
    Stripe->>Worker: Webhook: invoice.payment_failed
    Worker->>KV: lineUserIdを逆引きし status=past_due に更新
    Worker->>LINE: push通知（支払い失敗）

    Note over User,KV: 解約
    Stripe->>Worker: Webhook: customer.subscription.deleted
    Worker->>KV: lineUserIdを逆引きし<br/>status=canceled, subscriptionId=null に更新
    Worker->>LINE: push通知（解約完了）
```

### フローの説明
1. ユーザーがLINEで `/upgrade` または「アップグレード」を送信すると、WorkerがStripe Checkout Sessionを作成し、LINE User IDをmetadataに紐付ける
2. WorkerはStripeから受け取ったCheckout URLをLINEに直接返信する
3. ユーザーがCheckout URLで決済を完了すると、Stripeが `checkout.session.completed` WebhookをWorkerに送信する
4. Workerは署名を検証し、KV（`LINE_SUBSCRIPTIONS`）のプラン状態を `active` に更新し、Stripe顧客IDからLINE User IDを引けるよう逆引きindexを保存する
5. 決済完了・支払い失敗（`invoice.payment_failed` → `past_due`）・解約（`customer.subscription.deleted` → `canceled`）のいずれの場合も、対応するLINEユーザーへpush通知が送られる

## 重要なポイント
- すべてのメッセージ・画像はVault IDによって適切なObsidian Vaultに振り分けられる
- Obsidianプラグインは常にWorkerへポーリング（GETリクエスト）してメッセージ/画像を取得する。Worker側からプラグインへ直接プッシュすることはない
- メッセージ・画像の保存は非同期で行われ、エラーが発生してもLINE Webhookには適切なレスポンスが返される
- テキストと画像はE2E暗号化されサーバーは復号できないが、音声文字起こしは処理の性質上サーバー側（Cloudflare Workers AI）で音声を扱う。文字起こし結果のテキストはテキストメッセージと同じ暗号化で保存される
- 画像は同期完了時にR2から削除され、未同期でも7日でTTL失効する。テキスト（文字起こし結果含む）はKV上で10日後にTTL失効する
- 無料プランの画像送信・音声文字起こしはそれぞれ累計10回までで、プレミアムプラン（月額300円）は両方が無制限になる
- Stripe決済イベント（完了・失敗・解約）はLINEへのpush通知でユーザーに伝えられる
