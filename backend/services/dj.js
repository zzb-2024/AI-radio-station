/**
 * AI DJ 串场文案。用于切歌时生成 1-2 句短解说。
 */
import { config } from '../config.js';
import { buildContext } from '../core/context.js';
import { completeText } from './llm.js';

export async function composeDjCommentary({ currentSong, previousSong = null, trigger = '切歌' } = {}) {
  if (!config.dj.enabled || !currentSong?.name) return '';

  const { systemPrompt } = await buildContext('', {});
  const currentLine = formatSong(currentSong);
  const previousLine = previousSong?.name ? formatSong(previousSong) : '无';
  const albumLine = currentSong.album ? currentSong.album : '未知';
  const releaseLine = formatRelease(currentSong.publishTime);
  const lyricPreview = pickLyricPreview(currentSong.lyric);

  const system = [
    systemPrompt,
    '',
    '---',
    '你现在不是歌单规划助手，而是一位真正在线主持的中文电台 DJ。',
    '你的任务是在每首歌开始时说一段自然的开场介绍。',
    '要求：',
    '- 只输出最终文案，不要 JSON，不要引号，不要列表，不要解释。',
    '- 中文输出，控制在 60 到 150 个字，两到三句。',
    '- 每次都要有过渡感：如果有上一首，先用一句把上一首的余味接到当前歌曲。',
    '- 可以介绍歌曲背景、创作场景、歌手状态或作品位置，但只能说你确信的公开常识。',
    '- 不确定背景时不要编造年份、地点、采访、故事或作者意图，改讲听感、编曲、歌词意象、专辑信息和适合的聆听方式。',
    '- 必须遵守长期用户画像里的 DJ 风格、歌曲介绍偏好和避免内容。',
    '- 口吻要像成熟的中文电台主持人：温和、有信息量、不鸡汤、不堆形容词。',
  ].join('\n');

  const prompt = [
    `触发场景：${trigger}`,
    `上一首：${previousLine}`,
    `当前歌曲：${currentLine}`,
    `专辑：${albumLine}`,
    `发行时间：${releaseLine}`,
    `歌词片段：${lyricPreview || '无'}`,
    '现在给出这首歌开始前的 DJ 介绍和过渡。',
  ].join('\n');

  try {
    const text = await completeText({
      label: 'dj',
      systemPrompt: system,
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 220,
    });
    return normalizeCommentary(text);
  } catch (e) {
    console.warn(`[dj] ${e.message}`);
    return '';
  }
}

function formatSong(song) {
  const artist = song?.artist ? ` - ${song.artist}` : '';
  return `${song?.name || '未知曲目'}${artist}`;
}

function formatRelease(publishTime) {
  let ts = Number(publishTime);
  if (!Number.isFinite(ts) || ts <= 0) return '未知';
  if (ts < 100000000000) ts *= 1000;
  return new Date(ts).getFullYear().toString();
}

function pickLyricPreview(lyric = '') {
  if (!lyric) return '';

  const lines = lyric
    .split('\n')
    .map(line => line.replace(/\[[^\]]+\]/g, '').trim())
    .filter(Boolean);

  return lines.slice(0, 2).join(' / ').slice(0, 60);
}

function normalizeCommentary(text) {
  return text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^["'“”]+|["'“”]+$/g, '')
    .trim()
    .slice(0, config.dj.maxChars);
}
