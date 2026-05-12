/**
 * 意图识别。根据用户输入判断是直接搜歌还是调 AI 规划。
 */

const DIRECT_PATTERNS = /^(播放|来一首|放一首|搜索|search)\s+.+/i;
const DIRECT_PREFIX = /^(播放|来一首|放一首|搜索|search)\s+/i;

/**
 * @param {string} input
 * @returns {'direct'|'ai'|'auto'}
 */
export function route(input) {
  if (!input || !input.trim()) return 'auto';
  if (DIRECT_PATTERNS.test(input.trim())) return 'direct';
  return 'ai';
}

/**
 * 从直接搜歌输入中提取关键词。
 * "播放 陈粒 走马" → "陈粒 走马"
 */
export function extractDirectKeyword(input) {
  return (input || '').replace(DIRECT_PREFIX, '').trim();
}
