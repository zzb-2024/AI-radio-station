/**
 * 统一 LLM 调用层：固定使用 OpenAI GPT-5.5。
 * 对外负责上下文组装、错误提示和对话历史持久化。
 */
import { config } from '../config.js';
import { buildContext } from '../core/context.js';
import { state } from '../core/state.js';
import { completeOpenAI, hasOpenAIConfig } from './openai.js';

const RADIO_PLAN_OUTPUT_CONTRACT = [
  '',
  '---',
  '输出契约（严格遵守）：',
  '- 只输出单个合法 JSON 对象。',
  '- 不要 markdown 代码块，不要解释，不要前后缀文字。',
  '- JSON 字段必须且只能包含：say, play, reason, segue。',
  '- play 必须是字符串数组，元素格式是“歌曲名 - 艺术家”。',
  '- 选曲必须优先遵守长期用户画像，尤其是避免内容、场景偏好和 DJ 风格。',
  '- 遇到天气、心情、场景化点歌时，say 要自然承接氛围，不要复述用户整句，也不要说“为你播放 + 原话”。',
].join('\n');

const RADIO_CHAT_SYSTEM = [
  '',
  '---',
  '当前用户是在和电台 DJ 交流，不是在要求换歌或推荐歌单。',
  '用户说“这首歌”“他”“作者”“背景”时，默认都指当前播放的歌曲；不要根据较早聊天历史改指其它歌曲。',
  '请只做简短、自然、有陪伴感的中文回复，像真人在边听歌边聊天。',
  '不要像客服、说明书或标准答案；可以有轻微口语感，但别油腻、别端着。',
  '不要输出 JSON，不要列歌单，不要主动开始播放歌曲。',
  '如果用户只是聊天、提问、表达心情，就先接住对方的话；需要时可以温和承接当前音乐氛围。',
  '如果系统上下文里出现“联网搜索结果”，优先使用其中的信息；信息不足就明确说不确定，不要编造。',
  '回复控制在 120 个中文字以内，适合被 TTS 朗读。',
].join('\n');

export async function askRadioPlan(userInput, env = {}) {
  const { systemPrompt, messages } = await buildContext(userInput, env);
  const raw = await completeText({
    label: 'plan',
    systemPrompt: `${systemPrompt}${RADIO_PLAN_OUTPUT_CONTRACT}`,
    messages: messages.slice(-1),
    maxTokens: config.openai.maxTokens,
  });

  const result = parsePlanPayload(raw);
  await state.addConversationTurn(userInput || '(auto)', JSON.stringify(result));
  return result;
}

export async function askRadioChat(userInput, env = {}, { allowPlanFallback = false } = {}) {
  const { systemPrompt, messages } = await buildContext(userInput, env);
  const raw = (await completeText({
    label: 'chat',
    systemPrompt: `${systemPrompt}${RADIO_CHAT_SYSTEM}`,
    messages: [
      ...messages.slice(-3, -1),
      currentSongContextMessage(env.currentSong),
      messages[messages.length - 1],
    ].filter(Boolean),
    maxTokens: Math.min(config.openai.maxTokens, 260),
  })).trim();
  const accidentalPlan = allowPlanFallback ? parseOptionalPlanPayload(raw) : null;
  if (accidentalPlan?.play?.length) {
    return accidentalPlan;
  }

  await state.addConversationTurn(userInput || '(chat)', raw);
  return {
    say: raw,
    play: [],
    reason: 'chat',
    segue: '',
  };
}

function currentSongContextMessage(song) {
  if (!song?.name) return null;
  const details = [
    `当前播放歌曲：${song.name} - ${song.artist || '未知艺人'}`,
    song.album ? `专辑：${song.album}` : '',
    song.publishTime ? `发行时间戳：${song.publishTime}` : '',
    song.lyric ? `已知创作信息：${extractCreditLines(song.lyric).join('；')}` : '',
  ].filter(Boolean).join('；');

  return {
    role: 'system',
    content: `${details}。回答用户追问时，“这首歌”必须指这首当前播放歌曲。`,
  };
}

function extractCreditLines(lyric) {
  return String(lyric || '')
    .split(/\r?\n/)
    .map(line => line.replace(/^\[\d{2}:\d{2}(?:\.\d+)?\]\s*/, '').trim())
    .filter(line => /^(作词|作曲|编曲|制作人)\s*:/.test(line))
    .slice(0, 6);
}

export async function completeText({
  label,
  systemPrompt,
  messages,
  maxTokens = config.openai.maxTokens,
} = {}) {
  if (!hasOpenAIConfig()) {
    throw new Error('no LLM provider configured (set OPENAI_API_KEY for GPT-5.5)');
  }

  try {
    return await completeOpenAI({ systemPrompt, messages, maxTokens });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[llm:${label}] openai failed: ${message}`);
    const hint = deriveFailureHint(message);
    throw new Error(`OpenAI GPT-5.5 failed: ${message}${hint ? `; hint: ${hint}` : ''}`);
  }
}

function parsePlanPayload(text) {
  const candidates = [text, extractCodeBlock(text), extractJSONObject(text)].filter(Boolean);

  for (const raw of candidates) {
    try {
      return normalizePlanResult(JSON.parse(raw));
    } catch {
      // 继续尝试下一种候选格式
    }
  }

  throw new Error(`LLM: no valid JSON in response: ${String(text).slice(0, 200)}`);
}

function parseOptionalPlanPayload(text) {
  const candidates = [text, extractCodeBlock(text), extractJSONObject(text)].filter(Boolean);
  for (const raw of candidates) {
    try {
      const result = normalizePlanResult(JSON.parse(raw));
      return result.play.length ? result : null;
    } catch {
      // 不是合法播放计划时按普通聊天处理。
    }
  }
  return null;
}

function extractCodeBlock(text) {
  const match = String(text || '').match(/```(?:json)?\s*([\s\S]*?)```/i);
  return match?.[1]?.trim() || '';
}

function extractJSONObject(text) {
  const source = String(text || '');
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  if (start < 0 || end <= start) return '';
  return source.slice(start, end + 1);
}

function normalizePlanResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error('LLM result must be an object');
  }

  return {
    say: typeof result.say === 'string' ? result.say.trim() : '',
    play: Array.isArray(result.play)
      ? result.play.map(item => String(item).trim()).filter(Boolean)
      : [],
    reason: typeof result.reason === 'string' ? result.reason.trim() : '',
    segue: typeof result.segue === 'string' ? result.segue.trim() : '',
  };
}

function deriveFailureHint(message) {
  if (
    /request timeout/i.test(message) &&
    config.openai.apiUrl === 'https://api.openai.com'
  ) {
    return 'set OPENAI_API_URL to a reachable OpenAI-compatible proxy, or confirm direct access to api.openai.com';
  }

  return '';
}
