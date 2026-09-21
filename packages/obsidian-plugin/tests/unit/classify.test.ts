import { describe, it, expect } from 'vitest';
import { classifyMemo, countByCategory } from '../../src/classify';

describe('classifyMemo', () => {
  it('頭の種類指定を最優先にする', () => {
    expect(classifyMemo('タスク: 牛乳を買う')).toBe('task');
    expect(classifyMemo('アイデア：リールで第二の脳を実演')).toBe('idea');
    expect(classifyMemo('リンク: https://example.com')).toBe('link');
    expect(classifyMemo('メモ: 今日は雨')).toBe('memo');
    expect(classifyMemo('todo: 請求書を送る')).toBe('task');
  });

  it('URL を含むものはリンク', () => {
    expect(classifyMemo('このX投稿、リールにしたら伸びそう https://x.com/abc/status/1')).toBe('link');
  });

  it('文末がやること系ならタスク', () => {
    expect(classifyMemo('明日クリニックに電話する')).toBe('task');
    expect(classifyMemo('来週の予定を確認')).toBe('task');
  });

  it('思いつき系はアイデア', () => {
    expect(classifyMemo('朝の30分作業を習慣にしたい')).toBe('idea');
    expect(classifyMemo('AI部下の話、note にしたら面白そう')).toBe('idea');
  });

  it('どれでもなければメモ', () => {
    expect(classifyMemo('今日は子どもと公園に行った')).toBe('memo');
    expect(classifyMemo('')).toBe('memo');
  });
});

describe('countByCategory', () => {
  it('件数だけを返す', () => {
    const counts = countByCategory(['タスク: a', 'https://a.b', '面白そう', 'ふつうの記録']);
    expect(counts).toEqual({ task: 1, link: 1, idea: 1, memo: 1 });
  });
});
