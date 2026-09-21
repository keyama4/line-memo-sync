import { describe, it, expect, vi, beforeEach } from 'vitest';
import { requestUrl } from 'obsidian';
import LinePlugin from '../../src/main';

// B案の約束をプラグイン側で守っているかの番人。
// 既定では /stats を呼ばない。オンでも本文は送らず、件数と日付だけ。同期済み確定に失敗したら送らない。

const mockApp = {
  vault: {
    adapter: { exists: vi.fn() },
    createFolder: vi.fn().mockResolvedValue(undefined),
    create: vi.fn().mockResolvedValue(undefined),
    getAbstractFileByPath: vi.fn().mockReturnValue(null),
  },
} as any;

class TestLinePlugin extends LinePlugin {
  app = mockApp;
  loadData = vi.fn().mockResolvedValue({});
  saveData = vi.fn().mockResolvedValue(undefined);
  addSettingTab = vi.fn();
  addCommand = vi.fn();
  addRibbonIcon = vi.fn();
  registerInterval = vi.fn();
}

const MESSAGES = [
  { timestamp: 1_700_000_000_000, messageId: 'm1', userId: 'U1', vaultId: 'v', text: 'タスク: 請求書を送る', encrypted: false },
  { timestamp: 1_700_000_000_000, messageId: 'm2', userId: 'U1', vaultId: 'v', text: 'https://x.com/a/status/1', encrypted: false },
  { timestamp: 1_700_000_000_000, messageId: 'm3', userId: 'U1', vaultId: 'v', text: '今日は晴れ', encrypted: false },
];

function callsTo(path: string) {
  return vi.mocked(requestUrl).mock.calls.filter((c) => String((c[0] as { url: string }).url).endsWith(path));
}

describe('利用状況の共有（shareStats）', () => {
  let plugin: TestLinePlugin;

  beforeEach(async () => {
    vi.clearAllMocks();
    plugin = new TestLinePlugin(mockApp, {} as any);
    await plugin.loadSettings();
    plugin.settings.vaultId = 'v';
    plugin.settings.lineUserId = 'U1';
    plugin.keyManager = { loadKeys: vi.fn().mockResolvedValue({ keyId: 'k' }), initialize: vi.fn() } as any;
    plugin.messageEncryptor = { processMessage: vi.fn(async (m: { text: string }) => m.text) } as any;
    plugin.errorHandler = { handleError: vi.fn() } as any;
    vi.mocked(requestUrl).mockImplementation(async (opts: any) => {
      if (String(opts.url).includes('/messages/v/U1')) {
        return { status: 200, text: JSON.stringify(MESSAGES) } as any;
      }
      return { status: 200, json: {} } as any;
    });
  });

  it('既定はオフで、同期しても /stats を呼ばない', async () => {
    expect(plugin.settings.shareStats).toBe(false);
    await (plugin as any).syncMessages(true);
    expect(mockApp.vault.create).toHaveBeenCalledTimes(3);
    expect(callsTo('/stats')).toHaveLength(0);
  });

  it('オンのときは日付ごとの件数だけを送り、本文は含めない', async () => {
    plugin.settings.shareStats = true;
    await (plugin as any).syncMessages(true);

    const calls = callsTo('/stats');
    expect(calls).toHaveLength(1);
    const body = JSON.parse((calls[0][0] as { body: string }).body);
    expect(Object.keys(body).sort()).toEqual(['counts', 'date', 'userId', 'vaultId']);
    expect(body.counts).toEqual({ task: 1, idea: 0, link: 1, memo: 1 });
    expect(body.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const raw = (calls[0][0] as { body: string }).body;
    for (const m of MESSAGES) {
      expect(raw).not.toContain(m.text);
    }
  });

  it('同期済みの確定に失敗したら送らない（再同期で二重計上しないため）', async () => {
    plugin.settings.shareStats = true;
    vi.mocked(requestUrl).mockImplementation(async (opts: any) => {
      if (String(opts.url).includes('/messages/v/U1')) {
        return { status: 200, text: JSON.stringify(MESSAGES) } as any;
      }
      if (String(opts.url).endsWith('/messages/update-sync-status')) {
        return { status: 500 } as any;
      }
      return { status: 200, json: {} } as any;
    });
    await (plugin as any).syncMessages(true);
    expect(callsTo('/stats')).toHaveLength(0);
  });

  it('復号できなかったメモは件数に入れない', async () => {
    plugin.settings.shareStats = true;
    // 暗号化済みメッセージは text が空で届く。復号に失敗すると placeholder になる
    const encrypted = MESSAGES.map((m) => (m.messageId === 'm3' ? { ...m, text: '', encrypted: true } : m));
    vi.mocked(requestUrl).mockImplementation(async (opts: any) => {
      if (String(opts.url).includes('/messages/v/U1')) {
        return { status: 200, text: JSON.stringify(encrypted) } as any;
      }
      return { status: 200, json: {} } as any;
    });
    plugin.messageEncryptor = {
      processMessage: vi.fn(async (m: { messageId: string; text: string }) => {
        if (m.messageId === 'm3') throw new Error('decrypt failed');
        return m.text;
      }),
    } as any;
    plugin.errorHandler = { handleError: vi.fn().mockResolvedValue(null) } as any;
    await (plugin as any).syncMessages(true);
    const body = JSON.parse((callsTo('/stats')[0][0] as { body: string }).body);
    expect(body.counts).toEqual({ task: 1, idea: 0, link: 1, memo: 0 });
  });

  it('オフに戻すと opt-out をサーバーに伝える', async () => {
    await plugin.sendStatsOptOut();
    const calls = callsTo('/stats/opt-out');
    expect(calls).toHaveLength(1);
    expect(JSON.parse((calls[0][0] as { body: string }).body)).toEqual({ userId: 'U1', vaultId: 'v' });
  });
});
