/**
 * 意图识别。根据用户输入判断是直接搜歌还是调 AI 规划。
 */

const DIRECT_PATTERNS = /^(播放|来一首|放一首|搜索|search)\s+.+/i;
const DIRECT_PREFIX = /^(播放|来一首|放一首|搜索|search)\s+/i;
const MUSIC_PLAN_PATTERNS = /(放点|来点|来几首|想听|推荐|合适|适合|换一批|换几首|换歌|切歌|下一首|新歌单|歌单|音乐|歌曲|电台|助眠|通勤|学习|工作|跑步|开车|睡前|安静的|开心的|难过的|治愈|摇滚|民谣|爵士|电子|电音|house|techno|edm|舞曲|流行|热门|榜单|古风|国风|新歌|年度|今年|2026|26年|说唱|陶喆|周杰伦|陈奕迅|林俊杰|王菲|孙燕姿)/i;
const CHAT_PATTERNS = /^(你好|嗨|在吗|你是谁|聊聊|陪我聊|我想聊|我有点|我觉得|为什么|怎么办|你觉得|可以问你|给我讲讲|解释一下|谢谢|晚安|早安)/i;

/**
 * @param {string} input
 * @returns {'direct'|'plan'|'chat'|'auto'}
 */
export function route(input) {
  const text = String(input || '').trim();
  if (!text) return 'auto';
  if (DIRECT_PATTERNS.test(text)) return 'direct';
  if (CHAT_PATTERNS.test(text) && !MUSIC_PLAN_PATTERNS.test(text)) return 'chat';
  if (MUSIC_PLAN_PATTERNS.test(text)) return 'plan';
  return 'chat';
}

/**
 * 从直接搜歌输入中提取关键词。
 * "播放 陈粒 走马" → "陈粒 走马"
 */
export function extractDirectKeyword(input) {
  return (input || '').replace(DIRECT_PREFIX, '').trim();
}
