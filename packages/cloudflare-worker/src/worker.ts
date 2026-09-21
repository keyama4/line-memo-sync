/// <reference types="@cloudflare/workers-types" />
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Context } from 'hono';

type MemoCategory = 'task' | 'idea' | 'link' | 'memo';

// LINE Memo Sync 受付サーバー。
// LINE 公式アカウントに届いたテキストを、利用者の公開鍵で暗号化して一時保管し、
// Obsidian プラグインが取りに来るまで預かる。本文は復号できない前提で設計する。
// 台帳（D1）には「誰が・いつ・何件」と、本人がオンにした場合の種類別件数だけを持つ。

interface Bindings {
  LINE_CHANNEL_ACCESS_TOKEN: string;
  LINE_CHANNEL_SECRET: string;
  LINE_MESSAGES: KVNamespace;
  LINE_USER_MAPPINGS: KVNamespace;
  LINE_PUBLIC_KEYS: KVNamespace;
  DB?: D1Database;
  ADMIN_KEY?: string;
  HELP_ARTICLE_URL?: string;
  PLUGIN_NAME?: string;
}

interface LineMessage {
  timestamp: number;
  messageId: string;
  userId: string;
  text: string;
  vaultId: string;
  synced?: boolean;
  encrypted?: boolean;
  encryptedContent?: string;
  encryptedAESKey?: string;
  iv?: string;
  senderKeyId?: string;
  recipientUserId?: string;
  version?: string;
}

interface PublicKeyData {
  userId: string;
  publicKey: string;
  keyId: string;
  registeredAt: number;
}

interface LineTextMessage {
  type: 'text';
  text: string;
}

interface LineWebhookEvent {
  type: string;
  timestamp: number;
  replyToken?: string;
  source?: { userId?: string };
  message?: { id: string; type: string; text?: string };
}

export type CategoryCounts = Record<MemoCategory, number>;

const TEXT_EXPIRATION_TTL = 60 * 60 * 24 * 10;
// 連携コードは LINE 側で発行し、10分で失効する。LINE User ID の貼り付けを不要にし、他人の ID を使った乗っ取りを防ぐ
const PAIRING_CODE_TTL = 60 * 10;
const DEFAULT_PLUGIN_NAME = 'LINE Memo Sync';

const app = new Hono<{ Bindings: Bindings }>();

// ===== 共通ユーティリティ =====

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

function pemToBase64(pem: string): string {
  return pem
    .replace(/-----BEGIN [^-]+-----/, '')
    .replace(/-----END [^-]+-----/, '')
    .replace(/[\r\n]/g, '')
    .trim();
}

function arrayBufferToBase64(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function timingSafeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

async function validateLineSignature(body: string, channelSecret: string, signature: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(channelSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signed = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  return timingSafeStringEqual(arrayBufferToBase64(signed), signature);
}

async function replyMessage(channelAccessToken: string, replyToken: string, messages: LineTextMessage[]): Promise<void> {
  const response = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${channelAccessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ replyToken, messages }),
  });
  if (!response.ok) {
    throw new Error(`LINE reply API failed: ${response.status}`);
  }
}

function text(t: string): LineTextMessage {
  return { type: 'text', text: t };
}

function pluginName(c: Context<{ Bindings: Bindings }>): string {
  return c.env.PLUGIN_NAME || DEFAULT_PLUGIN_NAME;
}

async function getVaultIdForUser(c: Context<{ Bindings: Bindings }>, userId: string): Promise<string | null> {
  try {
    return await c.env.LINE_USER_MAPPINGS.get(userId);
  } catch (err) {
    console.error(`Error fetching vault mapping for user ${userId}:`, err);
    return null;
  }
}

async function issuePairingCode(c: Context<{ Bindings: Bindings }>, userId: string): Promise<string> {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  const code = String(buf[0] % 1_000_000).padStart(6, '0');
  await c.env.LINE_USER_MAPPINGS.put(`code/${code}`, userId, { expirationTtl: PAIRING_CODE_TTL });
  return code;
}

async function consumePairingCode(c: Context<{ Bindings: Bindings }>, code: string): Promise<string | null> {
  const key = `code/${code}`;
  const userId = await c.env.LINE_USER_MAPPINGS.get(key);
  if (userId) {
    await c.env.LINE_USER_MAPPINGS.delete(key);
  }
  return userId;
}

async function deletePendingMessages(c: Context<{ Bindings: Bindings }>, vaultId: string, userId: string): Promise<void> {
  const { keys } = await c.env.LINE_MESSAGES.list({ prefix: `${vaultId}/${userId}/` });
  for (const key of keys) {
    await c.env.LINE_MESSAGES.delete(key.name);
  }
}

// ===== 台帳（D1）。失敗してもメモの受け取りは止めない =====

async function ledgerUpsertUser(c: Context<{ Bindings: Bindings }>, userId: string, vaultId: string): Promise<void> {
  const db = c.env.DB;
  if (!db) return;
  try {
    await db
      .prepare(
        `INSERT INTO users (line_user_id, vault_id, registered_at, message_count)
         VALUES (?1, ?2, ?3, 0)
         ON CONFLICT(line_user_id) DO UPDATE SET vault_id = excluded.vault_id`
      )
      .bind(userId, vaultId, Date.now())
      .run();
  } catch (err) {
    console.error('ledgerUpsertUser failed:', err);
  }
}

async function ledgerCountMessage(c: Context<{ Bindings: Bindings }>, userId: string, timestamp: number): Promise<void> {
  const db = c.env.DB;
  if (!db) return;
  try {
    await db
      .prepare(`UPDATE users SET message_count = message_count + 1, last_message_at = ?2 WHERE line_user_id = ?1`)
      .bind(userId, timestamp)
      .run();
  } catch (err) {
    console.error('ledgerCountMessage failed:', err);
  }
}

async function ledgerDeleteUser(c: Context<{ Bindings: Bindings }>, userId: string): Promise<void> {
  const db = c.env.DB;
  if (!db) return;
  try {
    await db.batch([
      db.prepare(`DELETE FROM category_stats WHERE line_user_id = ?1`).bind(userId),
      db.prepare(`DELETE FROM users WHERE line_user_id = ?1`).bind(userId),
    ]);
  } catch (err) {
    console.error('ledgerDeleteUser failed:', err);
  }
}

async function ledgerSetOptIn(c: Context<{ Bindings: Bindings }>, userId: string, enabled: boolean): Promise<void> {
  const db = c.env.DB;
  if (!db) return;
  try {
    await db.prepare(`UPDATE users SET stats_opt_in = ?2 WHERE line_user_id = ?1`).bind(userId, enabled ? 1 : 0).run();
  } catch (err) {
    console.error('ledgerSetOptIn failed:', err);
  }
}

async function ledgerSaveStats(
  c: Context<{ Bindings: Bindings }>,
  userId: string,
  date: string,
  counts: CategoryCounts
): Promise<boolean> {
  const db = c.env.DB;
  if (!db) return false;
  try {
    await db.batch([
      db.prepare(`UPDATE users SET stats_opt_in = 1 WHERE line_user_id = ?1`).bind(userId),
      db
        .prepare(
          `INSERT INTO category_stats (line_user_id, date, task, idea, link, memo, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
           ON CONFLICT(line_user_id, date) DO UPDATE SET
             task = task + excluded.task,
             idea = idea + excluded.idea,
             link = link + excluded.link,
             memo = memo + excluded.memo,
             updated_at = excluded.updated_at`
        )
        .bind(userId, date, counts.task, counts.idea, counts.link, counts.memo, Date.now()),
    ]);
    return true;
  } catch (err) {
    console.error('ledgerSaveStats failed:', err);
    return false;
  }
}

// ===== 暗号化 =====

// 利用者の公開鍵で AES 鍵を包んで保存する。公開鍵が無ければ null を返し、平文では絶対に預からない
async function buildTextMessage(
  c: Context<{ Bindings: Bindings }>,
  userId: string,
  vaultId: string,
  messageId: string,
  timestamp: number,
  body: string
): Promise<LineMessage | null> {
  const publicKeyData = (await c.env.LINE_PUBLIC_KEYS.get(`publickey/${userId}`, 'json')) as PublicKeyData | null;
  if (!publicKeyData || !publicKeyData.publicKey) {
    return null;
  }

  {
    const aesKey = (await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
      'encrypt',
      'decrypt',
    ])) as CryptoKey;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoder = new TextEncoder();
    const encryptedContent = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv.buffer as ArrayBuffer },
      aesKey,
      encoder.encode(body).buffer as ArrayBuffer
    );

    const publicKey = await crypto.subtle.importKey(
      'spki',
      base64ToArrayBuffer(pemToBase64(publicKeyData.publicKey)),
      { name: 'RSA-OAEP', hash: 'SHA-256' },
      false,
      ['encrypt']
    );
    const exportedAesKey = await crypto.subtle.exportKey('raw', aesKey);
    const encryptedAesKey = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, publicKey, exportedAesKey as ArrayBuffer);

    return {
      timestamp,
      messageId,
      userId,
      text: '',
      vaultId,
      synced: false,
      encrypted: true,
      encryptedContent: arrayBufferToBase64(encryptedContent),
      encryptedAESKey: arrayBufferToBase64(encryptedAesKey),
      iv: arrayBufferToBase64(iv),
      senderKeyId: publicKeyData.keyId,
      recipientUserId: userId,
      version: '1.0',
    };
  }
}

// ===== Bot の返信文 =====

function helpText(c: Context<{ Bindings: Bindings }>, code: string | null, mapped: boolean): string {
  const name = pluginName(c);
  const article = c.env.HELP_ARTICLE_URL ? `\n\n設定手順の記事はこちら:\n${c.env.HELP_ARTICLE_URL}` : '';
  if (!mapped) {
    return (
      `${name} の使い方\n\n` +
      `まず Obsidian との連携が必要です。\n\n` +
      `1. Obsidian にプラグイン「${name}」を入れる\n` +
      `2. 設定画面の「連携コード」に次の6桁を入れる（10分で期限切れ。切れたら「連携コード」と送ってください）\n${code ?? '（「連携コード」と送ると発行されます）'}\n` +
      `3. 「Register」を押す\n\n` +
      `終わったら、このトークに送るだけでメモが Obsidian に届きます。` +
      article
    );
  }
  return (
    `${name} の使い方\n\n` +
    `このトークに送った文章が、次に Obsidian を開いたときに取り込まれます。\n` +
    `預かるのは10日間なので、それまでに一度 Obsidian を開いてください。\n` +
    `雑な一言で大丈夫です。頭に「タスク:」「アイデア:」と付けると仕分けが正確になります。\n\n` +
    `別の Vault に付け替えたいときは「連携コード」と送ると新しいコードが出ます。` +
    article
  );
}

function needSetupText(c: Context<{ Bindings: Bindings }>, code: string): string {
  return (
    `Obsidian との連携がまだです。\n\n` +
    `連携コード（10分有効）:\n${code}\n\n` +
    `Obsidian の「${pluginName(c)}」設定画面に入れて「Register」を押してください。\n` +
    `終わったら、もう一度メッセージを送ってください。`
  );
}

const NEED_KEY_TEXT = 'Obsidian 側の設定が途中です。設定画面で「Register」をもう一度押してから送ってください。メモはまだ預かっていません。';

// 受け取り確認は短く。毎回長文だと通知が邪魔になる
const ACK_TEXT = '受け取りました。';

// ===== ミドルウェア =====

app.use(
  '*',
  cors({
    origin: ['app://obsidian.md'],
    allowMethods: ['GET', 'POST', 'DELETE'],
    allowHeaders: ['Content-Type', 'X-Vault-Id', 'X-Admin-Key'],
    exposeHeaders: ['Content-Length', 'Content-Type'],
    maxAge: 86400,
  })
);

app.use('*', async (c, next) => {
  try {
    await next();
  } catch (err) {
    console.error('Unexpected error:', err);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// ===== ルート =====

app.get('/health', (c) => c.json({ status: 'ok' }));

app.get('/messages/:vaultId/:userId', async (c) => {
  const vaultId = c.req.param('vaultId');
  const userId = c.req.param('userId');
  if (!userId) {
    return c.json({ error: 'Missing userId parameter' }, 400);
  }

  const storedVaultId = await getVaultIdForUser(c, userId);
  if (!storedVaultId || storedVaultId !== vaultId) {
    return c.json({ error: 'Unauthorized access' }, 403);
  }

  const messages: LineMessage[] = [];
  const { keys } = await c.env.LINE_MESSAGES.list({ prefix: `${vaultId}/${userId}/` });
  for (const key of keys) {
    try {
      const message = await c.env.LINE_MESSAGES.get(key.name, 'json');
      if (message) {
        messages.push(message as LineMessage);
      }
    } catch (err) {
      console.error(`Error fetching message ${key.name}:`, err);
    }
  }
  return c.json(messages);
});

// 連携は LINE が発行した6桁コードでしか作れない。ID だけ知っている第三者には作らせない
app.post('/mapping', async (c) => {
  const { code, vaultId } = await c.req.json();
  if (!code || !vaultId) {
    return c.json({ error: 'Missing code or vaultId' }, 400);
  }
  if (!/^\d{6}$/.test(String(code))) {
    return c.json({ error: 'Invalid code' }, 400);
  }
  const userId = await consumePairingCode(c, String(code));
  if (!userId) {
    return c.json({ error: 'Code expired or unknown' }, 404);
  }
  const previousVaultId = await getVaultIdForUser(c, userId);
  if (previousVaultId && previousVaultId !== vaultId) {
    // 付け替え。古い Vault 宛ての未同期メモと鍵は捨てる
    await deletePendingMessages(c, previousVaultId, userId);
    await c.env.LINE_PUBLIC_KEYS.delete(`publickey/${userId}`);
  }
  await c.env.LINE_USER_MAPPINGS.put(userId, vaultId);
  await ledgerUpsertUser(c, userId, vaultId);
  return c.json({ status: 'ok', userId });
});

app.delete('/mapping', async (c) => {
  const { userId, vaultId } = await c.req.json();
  if (!userId || !vaultId) {
    return c.json({ error: 'Missing userId or vaultId' }, 400);
  }
  const storedVaultId = await getVaultIdForUser(c, userId);
  if (!storedVaultId || storedVaultId !== vaultId) {
    return c.json({ error: 'Unauthorized: VaultId does not match' }, 403);
  }
  await deletePendingMessages(c, vaultId, userId);
  await c.env.LINE_USER_MAPPINGS.delete(userId);
  await c.env.LINE_PUBLIC_KEYS.delete(`publickey/${userId}`);
  await ledgerDeleteUser(c, userId);
  return c.json({ status: 'ok' });
});

app.post('/messages/update-sync-status', async (c) => {
  const { vaultId, messageIds, userId } = await c.req.json();
  if (!vaultId || !messageIds || !Array.isArray(messageIds)) {
    return c.json({ error: 'Missing vaultId or messageIds' }, 400);
  }
  if (!userId) {
    return c.json({ error: 'Missing userId' }, 400);
  }
  const storedVaultId = await getVaultIdForUser(c, userId);
  if (!storedVaultId || storedVaultId !== vaultId) {
    return c.json({ error: 'Unauthorized access' }, 403);
  }

  // 同期済みは即削除する。サーバーに残す理由がない
  for (const messageId of messageIds) {
    try {
      await c.env.LINE_MESSAGES.delete(`${vaultId}/${userId}/${messageId}`);
    } catch (err) {
      console.error(`Error deleting message ${messageId}:`, err);
    }
  }
  return c.json({ status: 'ok', updated: messageIds.length });
});

app.post('/publickey/register', async (c) => {
  const { userId, vaultId, publicKey, keyId } = await c.req.json();
  if (!userId || !vaultId || !publicKey || !keyId) {
    return c.json({ error: 'Missing required parameters' }, 400);
  }
  const storedVaultId = await getVaultIdForUser(c, userId);
  if (!storedVaultId || storedVaultId !== vaultId) {
    return c.json({ error: 'Unauthorized' }, 403);
  }
  // 鍵に期限は付けない。期限切れで黙って平文になる経路を作らないため。消すのは DELETE /mapping だけ
  const keyData: PublicKeyData = { userId, publicKey, keyId, registeredAt: Date.now() };
  await c.env.LINE_PUBLIC_KEYS.put(`publickey/${userId}`, JSON.stringify(keyData));
  return c.json({ success: true });
});

app.get('/publickey/:userId', async (c) => {
  const userId = c.req.param('userId');
  const vaultId = c.req.header('X-Vault-Id');
  if (!userId) {
    return c.json({ error: 'Missing userId parameter' }, 400);
  }
  if (!vaultId) {
    return c.json({ error: 'Missing X-Vault-Id header' }, 400);
  }
  const storedVaultId = await getVaultIdForUser(c, userId);
  if (!storedVaultId || storedVaultId !== vaultId) {
    return c.json({ error: 'Unauthorized' }, 403);
  }
  const keyData = await c.env.LINE_PUBLIC_KEYS.get(`publickey/${userId}`, 'json');
  if (!keyData) {
    return c.json({ error: 'Public key not found' }, 404);
  }
  return c.json(keyData as PublicKeyData);
});

// 本人がオンにした場合だけプラグインが送ってくる、種類別の件数。本文は含まない
app.post('/stats', async (c) => {
  const { userId, vaultId, date, counts } = await c.req.json();
  if (!userId || !vaultId || !date || !counts) {
    return c.json({ error: 'Missing required parameters' }, 400);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return c.json({ error: 'Invalid date' }, 400);
  }
  const storedVaultId = await getVaultIdForUser(c, userId);
  if (!storedVaultId || storedVaultId !== vaultId) {
    return c.json({ error: 'Unauthorized' }, 403);
  }
  const normalized: CategoryCounts = { task: 0, idea: 0, link: 0, memo: 0 };
  for (const key of Object.keys(normalized) as MemoCategory[]) {
    const value = Number(counts[key] ?? 0);
    normalized[key] = Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  }
  const saved = await ledgerSaveStats(c, userId, date, normalized);
  return c.json({ status: saved ? 'ok' : 'skipped' });
});

// 共有をオフに戻したことを台帳に反映する。過去の件数は消さない（集計は匿名のため）
app.post('/stats/opt-out', async (c) => {
  const { userId, vaultId } = await c.req.json();
  if (!userId || !vaultId) {
    return c.json({ error: 'Missing required parameters' }, 400);
  }
  const storedVaultId = await getVaultIdForUser(c, userId);
  if (!storedVaultId || storedVaultId !== vaultId) {
    return c.json({ error: 'Unauthorized' }, 403);
  }
  await ledgerSetOptIn(c, userId, false);
  return c.json({ status: 'ok' });
});

// 発信の種として見る集計。個人は特定しない
app.get('/admin/summary', async (c) => {
  const adminKey = c.req.header('X-Admin-Key');
  if (!c.env.ADMIN_KEY || !adminKey || !timingSafeStringEqual(adminKey, c.env.ADMIN_KEY)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  const db = c.env.DB;
  if (!db) {
    return c.json({ error: 'Ledger not configured' }, 500);
  }
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const [users, active, optIn, monthly] = await Promise.all([
    db.prepare(`SELECT COUNT(*) AS n FROM users`).first<{ n: number }>(),
    db.prepare(`SELECT COUNT(*) AS n FROM users WHERE last_message_at >= ?1`).bind(weekAgo).first<{ n: number }>(),
    db.prepare(`SELECT COUNT(*) AS n FROM users WHERE stats_opt_in = 1`).first<{ n: number }>(),
    db
      .prepare(
        `SELECT substr(date, 1, 7) AS month,
                SUM(task) AS task, SUM(idea) AS idea, SUM(link) AS link, SUM(memo) AS memo
         FROM category_stats GROUP BY month ORDER BY month DESC LIMIT 12`
      )
      .all(),
  ]);
  return c.json({
    users: users?.n ?? 0,
    activeLast7Days: active?.n ?? 0,
    statsOptIn: optIn?.n ?? 0,
    categoriesByMonth: monthly.results ?? [],
  });
});

app.post('/webhook', async (c) => {
  const signature = c.req.header('x-line-signature');
  if (!signature) {
    return c.json({ error: 'Missing signature' }, 401);
  }
  const body = await c.req.text();
  if (!(await validateLineSignature(body, c.env.LINE_CHANNEL_SECRET, signature))) {
    return c.json({ error: 'Invalid signature' }, 401);
  }

  const events = (JSON.parse(body).events ?? []) as LineWebhookEvent[];
  for (const event of events) {
    const userId = event.source?.userId;
    const replyToken = event.replyToken;
    if (!userId || !replyToken) {
      continue;
    }
    const token = c.env.LINE_CHANNEL_ACCESS_TOKEN;

    try {
      const vaultId = await getVaultIdForUser(c, userId);

      if (event.type === 'follow') {
        const code = vaultId ? null : await issuePairingCode(c, userId);
        await replyMessage(token, replyToken, [text(helpText(c, code, !!vaultId))]);
        continue;
      }

      if (event.type !== 'message' || !event.message) {
        continue;
      }

      if (event.message.type !== 'text') {
        await replyMessage(token, replyToken, [text('いまはテキストだけ受け取れます。写真や音声は文章にして送ってください。')]);
        continue;
      }

      const messageText = event.message.text ?? '';
      const trimmed = messageText.trim();

      if (trimmed === '/code' || trimmed === '連携コード') {
        const code = await issuePairingCode(c, userId);
        await replyMessage(token, replyToken, [text(needSetupText(c, code))]);
        continue;
      }

      if (trimmed === '/myid') {
        await replyMessage(token, replyToken, [text(`あなたの LINE User ID:\n${userId}\n\n連携にはこの ID ではなく「連携コード」を使います。`)]);
        continue;
      }

      if (trimmed === '/help' || trimmed === '使い方') {
        const code = vaultId ? null : await issuePairingCode(c, userId);
        await replyMessage(token, replyToken, [text(helpText(c, code, !!vaultId))]);
        continue;
      }

      if (!vaultId) {
        const code = await issuePairingCode(c, userId);
        await replyMessage(token, replyToken, [text(needSetupText(c, code))]);
        continue;
      }

      const message = await buildTextMessage(c, userId, vaultId, event.message.id, event.timestamp, messageText);
      if (!message) {
        await replyMessage(token, replyToken, [text(NEED_KEY_TEXT)]);
        continue;
      }
      await c.env.LINE_MESSAGES.put(`${vaultId}/${userId}/${event.message.id}`, JSON.stringify(message), {
        expirationTtl: TEXT_EXPIRATION_TTL,
      });
      await ledgerCountMessage(c, userId, event.timestamp);
      await replyMessage(token, replyToken, [text(ACK_TEXT)]);
    } catch (err) {
      console.error('Error handling event:', err);
    }
  }

  return c.json({ status: 'ok' });
});

export default app;
