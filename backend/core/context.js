/**
 * 构造传给 GPT-5.5 的 system prompt + message 历史。
 * 读 persona / 用户画像 / 口味 / 情绪规则 / 环境上下文，拼成单条 system。
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { config } from '../config.js';
import { state } from './state.js';
import { formatProfileForPrompt, getProfile } from './profile.js';

function readOptional(absPath) {
  try { return readFileSync(absPath, 'utf8'); }
  catch { return ''; }
}

function formatTime() {
  return new Date().toLocaleString('zh-CN', { hour12: false });
}

export async function buildContext(userInput, env = {}) {
  const persona   = readOptional(join(config.paths.prompts, 'persona.md'));
  const taste     = readOptional(join(config.paths.user, 'taste.md'));
  const routines  = readOptional(join(config.paths.user, 'routines.md'));
  const moodRules = readOptional(join(config.paths.user, 'mood-rules.md'));
  const profile   = await getProfile();

  const recent = (await state.recentPlays(20))
    .map(r => `${r.song} - ${r.artist}`).join('\n') || '无';
  const todayPlan = (await state.getTodayPlan()) || '无';

  const envBlock = [
    `当前时间：${formatTime()}`,
    `天气：${env.weather || '未知'}`,
    `日程：${env.calendar || todayPlan}`,
  ].join('\n');

  const systemPrompt = [
    persona,
    '\n---\n## 用户品味',
    taste,
    '\n## 作息规律',
    routines,
    '\n## 情绪规则',
    moodRules,
    '\n---\n',
    formatProfileForPrompt(profile),
    '\n---\n## 环境',
    envBlock,
    '\n## 最近播放（避免重复）',
    recent,
  ].join('\n');

  const messages = await state.getMessages(8);
  if (userInput) messages.push({ role: 'user', content: userInput });

  return { systemPrompt, messages };
}
