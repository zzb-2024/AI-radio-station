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
