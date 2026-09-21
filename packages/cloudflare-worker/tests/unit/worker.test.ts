import { describe, it, expect, vi, beforeEach } from 'vitest';
import app from '../../src/worker';

// Hono アプリに実リクエストを通すルートテスト。LINE 署名は本物と同じ HMAC で作る。

const LINE_CHANNEL_SECRET = 'test-channel-secret';
const USER_ID = 'U' + 'a'.repeat(32);
const OTHER_USER_ID = 'U' + 'c'.repeat(32);
const VAULT_ID = 'vault-1';
const ADMIN_KEY = 'admin-secret';

function createMockKV() {
  const store = new Map<string, string>();
  return {
    get: vi.fn((key: string, type?: string) => {
      const value = store.get(key);
      if (value === undefined) return Promise.resolve(null);
      return type === 'json' ? Promise.resolve(JSON.parse(value)) : Promise.resolve(value);
    }),
    put: vi.fn((key: string, value: string) => {
      store.set(key, value);
      return Promise.resolve();
    }),
    delete: vi.fn((key: string) => {
      store.delete(key);
      return Promise.resolve();
    }),
    list: vi.fn(({ prefix }: { prefix?: string } = {}) =>
      Promise.resolve({
        keys: Array.from(store.keys())
          .filter((name) => !prefix || name.startsWith(prefix))
          .map((name) => ({ name })),
      })
    ),
    _store: store,
  };
}

// D1 の最小モック。実行された SQL と bind 値を記録するだけ
function createMockD1() {
  const calls: { sql: string; params: unknown[] }[] = [];
  const firstResults: Record<string, unknown> = {};
  const prepare = vi.fn((sql: string) => {
    const stmt = {
      sql,
      params: [] as unknown[],
      bind: (...params: unknown[]) => {
        stmt.params = params;
        return stmt;
      },
      run: () => {
        calls.push({ sql, params: stmt.params });
        return Promise.resolve({ success: true });
      },
      first: () => {
        calls.push({ sql, params: stmt.params });
        const key = Object.keys(firstResults).find((k) => sql.includes(k));
        return Promise.resolve(key ? firstResults[key] : { n: 0 });
      },
      all: () => {
        calls.push({ sql, params: stmt.params });
        return Promise.resolve({ results: [] });
      },
    };
    return stmt;
  });
  return {
    prepare,
    batch: vi.fn((stmts: Array<{ sql: string; params: unknown[] }>) => {
      for (const s of stmts) calls.push({ sql: s.sql, params: s.params });
      return Promise.resolve([]);
    }),
    _calls: calls,
    _firstResults: firstResults,
  };
}

async function lineSignature(body: string, secret = LINE_CHANNEL_SECRET): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signed = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  return btoa(String.fromCharCode(...new Uint8Array(signed)));
}

function createEnv() {
  return {
    LINE_CHANNEL_ACCESS_TOKEN: 'token',
    LINE_CHANNEL_SECRET,
    LINE_MESSAGES: createMockKV(),
    LINE_USER_MAPPINGS: createMockKV(),
    LINE_PUBLIC_KEYS: createMockKV(),
    DB: createMockD1(),
    ADMIN_KEY,
    PLUGIN_NAME: 'LINE Memo Sync',
  };
}

type Env = ReturnType<typeof createEnv>;

function json(path: string, method: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

async function webhook(env: Env, events: unknown[], secret?: string) {
  const body = JSON.stringify({ events });
  const req = new Request('http://localhost/webhook', {
    method: 'POST',
    headers: { 'x-line-signature': await lineSignature(body, secret) },
    body,
  });
  return app.fetch(req, env);
}

function textEvent(text: string, id = 'm1', userId = USER_ID) {
  return { type: 'message', timestamp: 1_700_000_000_000, replyToken: 'r1', source: { userId }, message: { id, type: 'text', text } };
}

async function makeKeyPair() {
  const keyPair = await crypto.subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['encrypt', 'decrypt']);
  const spki = await crypto.subtle.exportKey('spki', keyPair.publicKey);
  const pem = `-----BEGIN PUBLIC KEY-----\n${btoa(String.fromCharCode(...new Uint8Array(spki)))}\n-----END PUBLIC KEY-----`;
  return { keyPair, pem };
}

describe('LINE Memo Sync worker', () => {
  let env: Env;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    env = createEnv();
    fetchMock = vi.fn(() => Promise.resolve(new Response('{}', { status: 200 })));
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  function lastReplyText(): string {
    const call = fetchMock.mock.calls.at(-1);
    const payload = JSON.parse((call?.[1] as RequestInit).body as string);
    return payload.messages[0].text as string;
  }

  function issuedCode(): string {
    const match = lastReplyText().match(/\b(\d{6})\b/);
    if (!match) throw new Error('code not found in reply');
    return match[1];
  }

  // 「LINE で連携コードをもらい、Obsidian が Register する」までを通す
  async function pair(userId = USER_ID, vaultId = VAULT_ID, pem?: string) {
    await webhook(env, [textEvent('連携コード', 'c1', userId)]);
    const code = issuedCode();
    const res = await app.fetch(json('/mapping', 'POST', { code, vaultId }), env);
    expect(res.status).toBe(200);
    if (pem) {
      const reg = await app.fetch(json('/publickey/register', 'POST', { userId, vaultId, publicKey: pem, keyId: 'k1' }), env);
      expect(reg.status).toBe(200);
    }
    return res;
  }

  it('health を返す', async () => {
    const res = await app.fetch(new Request('http://localhost/health'), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('署名が無い・違う・本文が改ざんされた webhook は 401 で何も保存しない', async () => {
    const none = await app.fetch(new Request('http://localhost/webhook', { method: 'POST', body: '{}' }), env);
    expect(none.status).toBe(401);

    const wrongSecret = await webhook(env, [textEvent('x')], 'other-secret');
    expect(wrongSecret.status).toBe(401);

    const body = JSON.stringify({ events: [textEvent('x')] });
    const tampered = new Request('http://localhost/webhook', {
      method: 'POST',
      headers: { 'x-line-signature': await lineSignature(body) },
      body: body.replace('"x"', '"y"'),
    });
    expect((await app.fetch(tampered, env)).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('未連携の人がメモを送ると、6桁の連携コードを返して本文は保存しない', async () => {
    const res = await webhook(env, [textEvent('買い物に行く')]);
    expect(res.status).toBe(200);
    expect(lastReplyText()).toMatch(/\d{6}/);
    expect(lastReplyText()).not.toContain(USER_ID);
    expect(env.LINE_MESSAGES._store.size).toBe(0);
  });

  it('友だち追加で使い方と連携コードを返し、連携済みなら再登録を促さない', async () => {
    await webhook(env, [{ type: 'follow', timestamp: 1, replyToken: 'r1', source: { userId: USER_ID } }]);
    expect(lastReplyText()).toContain('LINE Memo Sync の使い方');
    expect(lastReplyText()).toMatch(/\d{6}/);

    await pair();
    await webhook(env, [{ type: 'follow', timestamp: 1, replyToken: 'r1', source: { userId: USER_ID } }]);
    expect(lastReplyText()).not.toContain('Register');
  });

  it('連携コードで mapping が作られ、コードは使い捨てで、台帳にも入る', async () => {
    const res = await pair();
    expect(await res.json()).toEqual({ status: 'ok', userId: USER_ID });
    expect(env.LINE_USER_MAPPINGS._store.get(USER_ID)).toBe(VAULT_ID);
    expect(Array.from(env.LINE_USER_MAPPINGS._store.keys()).some((k) => k.startsWith('code/'))).toBe(false);
    expect(env.DB._calls.some((c) => c.sql.includes('INSERT INTO users') && c.params[0] === USER_ID)).toBe(true);
  });

  it('mapping は userId 指定では作れず、不正・期限切れコードは拒否する', async () => {
    const byId = await app.fetch(json('/mapping', 'POST', { userId: USER_ID, vaultId: VAULT_ID }), env);
    expect(byId.status).toBe(400);
    const bad = await app.fetch(json('/mapping', 'POST', { code: 'abcdef', vaultId: VAULT_ID }), env);
    expect(bad.status).toBe(400);
    const unknown = await app.fetch(json('/mapping', 'POST', { code: '123456', vaultId: VAULT_ID }), env);
    expect(unknown.status).toBe(404);
    expect(env.LINE_USER_MAPPINGS._store.has(USER_ID)).toBe(false);
  });

  it('他人の userId を知っていても、その人の mapping と公開鍵は書き換えられない', async () => {
    const { pem } = await makeKeyPair();
    await pair(USER_ID, VAULT_ID, pem);
    const before = env.LINE_PUBLIC_KEYS._store.get(`publickey/${USER_ID}`);

    // 攻撃者は自分のコードしか持っていない。それで被害者の ID は紐づかない
    await webhook(env, [textEvent('連携コード', 'c2', OTHER_USER_ID)]);
    const attackerCode = issuedCode();
    const res = await app.fetch(json('/mapping', 'POST', { code: attackerCode, vaultId: 'attacker-vault' }), env);
    expect(await res.json()).toEqual({ status: 'ok', userId: OTHER_USER_ID });
    expect(env.LINE_USER_MAPPINGS._store.get(USER_ID)).toBe(VAULT_ID);

    const { pem: attackerPem } = await makeKeyPair();
    const hijack = await app.fetch(json('/publickey/register', 'POST', { userId: USER_ID, vaultId: 'attacker-vault', publicKey: attackerPem, keyId: 'evil' }), env);
    expect(hijack.status).toBe(403);
    expect(env.LINE_PUBLIC_KEYS._store.get(`publickey/${USER_ID}`)).toBe(before);
  });

  it('公開鍵が無い間はメモを預からず、Register を促す', async () => {
    await pair();
    await webhook(env, [textEvent('まだ鍵がない')]);
    expect(env.LINE_MESSAGES._store.size).toBe(0);
    expect(lastReplyText()).toContain('Register');
    expect(env.DB._calls.some((c) => c.sql.includes('message_count = message_count + 1'))).toBe(false);
  });

  it('連携済みのメモは暗号化して保存し、本文は残らず、受け取り確認を返し、台帳の件数を増やす', async () => {
    const { keyPair, pem } = await makeKeyPair();
    await pair(USER_ID, VAULT_ID, pem);
    await webhook(env, [textEvent('秘密のメモ')]);

    const stored = JSON.parse(env.LINE_MESSAGES._store.get(`${VAULT_ID}/${USER_ID}/m1`)!);
    expect(stored.encrypted).toBe(true);
    expect(stored.text).toBe('');
    expect(JSON.stringify(stored)).not.toContain('秘密のメモ');
    expect(lastReplyText()).toContain('受け取りました');
    expect(env.DB._calls.some((c) => c.sql.includes('message_count = message_count + 1'))).toBe(true);

    // 本人の秘密鍵でだけ復号できる
    const b64 = (s: string) => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));
    const aesRaw = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, keyPair.privateKey, b64(stored.encryptedAESKey));
    const aesKey = await crypto.subtle.importKey('raw', aesRaw, { name: 'AES-GCM' }, false, ['decrypt']);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(stored.iv) }, aesKey, b64(stored.encryptedContent));
    expect(new TextDecoder().decode(plain)).toBe('秘密のメモ');
  });

  it('画像は受け取らず、文章で送るよう案内する', async () => {
    const { pem } = await makeKeyPair();
    await pair(USER_ID, VAULT_ID, pem);
    await webhook(env, [{ ...textEvent(''), message: { id: 'i1', type: 'image' } }]);
    expect(lastReplyText()).toContain('テキストだけ');
    expect(env.LINE_MESSAGES._store.size).toBe(0);
  });

  it('messages・publickey・sync-status は Vault ID が一致する人にだけ応じる', async () => {
    const { pem } = await makeKeyPair();
    await pair(USER_ID, VAULT_ID, pem);
    await webhook(env, [textEvent('メモ')]);

    const ok = await app.fetch(new Request(`http://localhost/messages/${VAULT_ID}/${USER_ID}`), env);
    expect(ok.status).toBe(200);
    expect((await ok.json()).length).toBe(1);

    expect((await app.fetch(new Request(`http://localhost/messages/other-vault/${USER_ID}`), env)).status).toBe(403);
    expect((await app.fetch(new Request(`http://localhost/publickey/${USER_ID}`, { headers: { 'X-Vault-Id': 'other-vault' } }), env)).status).toBe(403);
    expect((await app.fetch(json('/messages/update-sync-status', 'POST', { userId: USER_ID, vaultId: 'other-vault', messageIds: ['m1'] }), env)).status).toBe(403);
    expect(env.LINE_MESSAGES._store.size).toBe(1);
  });

  it('同期済みにするとサーバーから消える', async () => {
    const { pem } = await makeKeyPair();
    await pair(USER_ID, VAULT_ID, pem);
    await webhook(env, [textEvent('メモ')]);
    const res = await app.fetch(json('/messages/update-sync-status', 'POST', { userId: USER_ID, vaultId: VAULT_ID, messageIds: ['m1'] }), env);
    expect(res.status).toBe(200);
    expect(env.LINE_MESSAGES._store.size).toBe(0);
  });

  it('stats は件数を正規化して台帳に書く（負数・余分なキーは捨てる）', async () => {
    await pair();
    const res = await app.fetch(
      json('/stats', 'POST', { userId: USER_ID, vaultId: VAULT_ID, date: '2026-09-22', counts: { task: 2, idea: 1, link: 0, memo: -5, text: 'ignored' } }),
      env
    );
    expect(res.status).toBe(200);
    const insert = env.DB._calls.find((c) => c.sql.includes('INSERT INTO category_stats'));
    expect(insert?.params).toEqual([USER_ID, '2026-09-22', 2, 1, 0, 0, expect.any(Number)]);
    expect(env.DB._calls.some((c) => c.sql.includes('stats_opt_in = 1'))).toBe(true);
  });

  it('stats は未連携なら 403、日付が不正なら 400', async () => {
    const ng = await app.fetch(json('/stats', 'POST', { userId: USER_ID, vaultId: VAULT_ID, date: '2026-09-22', counts: {} }), env);
    expect(ng.status).toBe(403);
    await pair();
    const bad = await app.fetch(json('/stats', 'POST', { userId: USER_ID, vaultId: VAULT_ID, date: 'today', counts: {} }), env);
    expect(bad.status).toBe(400);
  });

  it('opt-out で台帳の共有フラグを 0 に戻す', async () => {
    await pair();
    const res = await app.fetch(json('/stats/opt-out', 'POST', { userId: USER_ID, vaultId: VAULT_ID }), env);
    expect(res.status).toBe(200);
    const call = env.DB._calls.find((c) => c.sql.includes('stats_opt_in = ?2'));
    expect(call?.params).toEqual([USER_ID, 0]);
  });

  it('台帳（D1）が無くてもメモの受け取りは止まらない', async () => {
    const { pem } = await makeKeyPair();
    const envNoDb = { ...env, DB: undefined } as unknown as Env;
    await webhook(envNoDb, [textEvent('連携コード', 'c1')]);
    const code = issuedCode();
    expect((await app.fetch(json('/mapping', 'POST', { code, vaultId: VAULT_ID }), envNoDb)).status).toBe(200);
    await app.fetch(json('/publickey/register', 'POST', { userId: USER_ID, vaultId: VAULT_ID, publicKey: pem, keyId: 'k1' }), envNoDb);
    await webhook(envNoDb, [textEvent('メモ')]);
    expect(envNoDb.LINE_MESSAGES._store.size).toBe(1);
  });

  it('別の Vault に付け替えると、古い Vault 宛ての未同期メモと鍵を捨てる', async () => {
    const { pem } = await makeKeyPair();
    await pair(USER_ID, VAULT_ID, pem);
    await webhook(env, [textEvent('古いメモ')]);
    expect(env.LINE_MESSAGES._store.size).toBe(1);

    await pair(USER_ID, 'vault-2');
    expect(env.LINE_USER_MAPPINGS._store.get(USER_ID)).toBe('vault-2');
    expect(env.LINE_MESSAGES._store.size).toBe(0);
    expect(env.LINE_PUBLIC_KEYS._store.has(`publickey/${USER_ID}`)).toBe(false);
  });

  it('mapping 削除で未同期メモ・公開鍵・台帳も消える', async () => {
    const { pem } = await makeKeyPair();
    await pair(USER_ID, VAULT_ID, pem);
    await webhook(env, [textEvent('メモ')]);
    const res = await app.fetch(json('/mapping', 'DELETE', { userId: USER_ID, vaultId: VAULT_ID }), env);
    expect(res.status).toBe(200);
    expect(env.LINE_MESSAGES._store.size).toBe(0);
    expect(env.LINE_PUBLIC_KEYS._store.size).toBe(0);
    expect(env.DB._calls.some((c) => c.sql.includes('DELETE FROM users'))).toBe(true);
  });

  it('admin/summary は鍵が合うときだけ返し、鍵未設定なら常に 401', async () => {
    const ng = await app.fetch(new Request('http://localhost/admin/summary', { headers: { 'X-Admin-Key': 'wrong' } }), env);
    expect(ng.status).toBe(401);
    const noKeyEnv = { ...env, ADMIN_KEY: undefined } as unknown as Env;
    const none = await app.fetch(new Request('http://localhost/admin/summary', { headers: { 'X-Admin-Key': '' } }), noKeyEnv);
    expect(none.status).toBe(401);

    env.DB._firstResults['COUNT(*) AS n FROM users WHERE stats_opt_in'] = { n: 3 };
    const ok = await app.fetch(new Request('http://localhost/admin/summary', { headers: { 'X-Admin-Key': ADMIN_KEY } }), env);
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.statsOptIn).toBe(3);
    expect(body.categoriesByMonth).toEqual([]);
  });
});
