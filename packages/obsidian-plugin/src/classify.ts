export type MemoCategory = 'task' | 'idea' | 'link' | 'memo';

export type CategoryCounts = Record<MemoCategory, number>;

const PREFIX_PATTERNS: Array<[RegExp, MemoCategory]> = [
  [/^(タスク|todo|やること)\s*[:：]/i, 'task'],
  [/^(アイデア|idea|ネタ)\s*[:：]/i, 'idea'],
  [/^(リンク|link|参考|あとで読む)\s*[:：]/i, 'link'],
  [/^(メモ|memo)\s*[:：]/i, 'memo'],
];

const URL_PATTERN = /https?:\/\/\S+/i;
// 文末の動詞で「やること」を拾う。「〜する」は多すぎるので、行末だけを見る
const TASK_PATTERN = /(する|やる|買う|送る|確認|連絡|予約|申し込む|提出|返信|作る|直す|片付ける|払う)(こと)?[。！!]?\s*$/;
const IDEA_PATTERN = /(したい|たい|どうか|どうだろう|かも|案|ネタ|企画|アイデア|良さそう|よさそう|面白そう|おもしろそう)/;

// CLAUDE.md の「LINEメモの整理ルール」と同じ4分類。本文はここで見るだけで、外には件数しか出さない
export function classifyMemo(text: string): MemoCategory {
  const trimmed = text.trim();
  for (const [pattern, category] of PREFIX_PATTERNS) {
    if (pattern.test(trimmed)) {
      return category;
    }
  }
  if (URL_PATTERN.test(trimmed)) {
    return 'link';
  }
  if (TASK_PATTERN.test(trimmed)) {
    return 'task';
  }
  if (IDEA_PATTERN.test(trimmed)) {
    return 'idea';
  }
  return 'memo';
}

export function emptyCounts(): CategoryCounts {
  return { task: 0, idea: 0, link: 0, memo: 0 };
}

export function countByCategory(texts: string[]): CategoryCounts {
  const counts = emptyCounts();
  for (const text of texts) {
    counts[classifyMemo(text)] += 1;
  }
  return counts;
}
