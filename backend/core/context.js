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
    `当前播放：${formatCurrentSong(env.currentSong)}`,
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
    formatWebSearchContext(env.webSearch),
    '\n## 最近播放（避免重复）',
    recent,
  ].join('\n');

  const messages = await state.getMessages(8);
  if (userInput) messages.push({ role: 'user', content: userInput });

  return { systemPrompt, messages };
}

function formatCurrentSong(song) {
  if (!song?.name) return '无';
  const parts = [
    `${song.name} - ${song.artist || '未知艺人'}`,
    song.album ? `专辑：${song.album}` : '',
    song.raw ? `原始搜索：${song.raw}` : '',
  ].filter(Boolean);
  return parts.join('；');
}

function formatWebSearchContext(search) {
  if (!search?.results?.length) return '';

  const lines = [
    '\n## 联网搜索结果',
    '以下是实时搜索摘要。涉及最新榜单、热门歌曲或歌曲背景时，优先使用这些结果；如果结果不足或互相矛盾，请明确说明不确定，不要编造。',
    `搜索词：${search.query}`,
    search.intent?.keywords ? `搜索关键词：${search.intent.keywords}` : '',
    ...search.results.slice(0, 6).map((result, index) => [
      `${index + 1}. ${result.title || '未命名结果'}`,
      result.media ? `来源：${result.media}` : '',
      result.publishDate ? `时间：${result.publishDate}` : '',
      result.content ? `摘要：${trimForPrompt(result.content, 260)}` : '',
      result.link ? `链接：${result.link}` : '',
    ].filter(Boolean).join('\n')),
  ].filter(Boolean);

  return lines.join('\n');
}

function trimForPrompt(text, maxLength) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}
