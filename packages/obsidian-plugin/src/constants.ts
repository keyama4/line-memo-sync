const isLocalMode = process.env.NODE_ENV === 'local';

// ビルド時の既定値。設定画面の「API URL」で上書きできる（自分でサーバーを立てる人向け）
export const DEFAULT_API_URL = process.env.OBSIDIAN_LINE_API_URL || (isLocalMode ? 'http://localhost:8787' : '');

let baseUrl = DEFAULT_API_URL;

export function setApiBaseUrl(url: string | undefined): void {
  const trimmed = (url ?? '').trim().replace(/\/+$/, '');
  baseUrl = trimmed || DEFAULT_API_URL;
}

export function getApiBaseUrl(): string {
  return baseUrl;
}

function requireIds(vaultId: string, userId: string): void {
  if (!vaultId || !userId) {
    throw new Error('Vault ID と LINE User ID の両方が必要です');
  }
}

export const API_ENDPOINTS = {
  get BASE_URL(): string {
    return baseUrl;
  },
  MESSAGES: (vaultId: string, userId: string): string => {
    requireIds(vaultId, userId);
    return `${baseUrl}/messages/${vaultId}/${userId}`;
  },
  get MAPPING(): string {
    return `${baseUrl}/mapping`;
  },
  get DELETE_MAPPING(): string {
    return `${baseUrl}/mapping`;
  },
  get UPDATE_SYNC_STATUS(): string {
    return `${baseUrl}/messages/update-sync-status`;
  },
  get REGISTER_PUBLIC_KEY(): string {
    return `${baseUrl}/publickey/register`;
  },
  GET_PUBLIC_KEY: (userId: string): string => `${baseUrl}/publickey/${userId}`,
  get STATS(): string {
    return `${baseUrl}/stats`;
  },
  get STATS_OPT_OUT(): string {
    return `${baseUrl}/stats/opt-out`;
  },
};

// LINE 公式アカウント「Obsidian Memo」の友だち追加リンク（ビルド時に埋め込む）
export const LINE_ADD_FRIEND_URL = process.env.LINE_ADD_FRIEND_URL || '';
export const PLUGIN_DISPLAY_NAME = 'LINE Memo Sync';
