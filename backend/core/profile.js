/**
 * 用户画像：长期偏好、场景规则、DJ 风格。
 * 存在 user/profile.json，供前端编辑和 LLM 上下文读取。
 */
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { config } from '../config.js';

const PROFILE_PATH = join(config.paths.user, 'profile.json');

export const DEFAULT_PROFILE = {
  taste: {
    favoriteArtists: '',
    favoriteGenres: '',
    favoriteLanguages: '',
    preferredTempo: '',
    avoid: '',
  },
  scenes: {
    work: '',
    lateNight: '',
    commute: '',
    sleep: '',
    rainyDay: '',
  },
  djStyle: {
    tone: '克制、成熟、像深夜电台主持人',
    songIntro: '每首歌开始前自然介绍，能确认背景就讲背景，不确定就讲听感和歌词意象',
    transition: '上一首和下一首之间要有自然过渡',
  },
  notes: '',
  updatedAt: '',
};

export async function getProfile() {
  try {
    const raw = await readFile(PROFILE_PATH, 'utf8');
    return normalizeProfile(JSON.parse(raw));
  } catch {
    return normalizeProfile({});
  }
}

export async function saveProfile(input) {
  const profile = normalizeProfile(input);
  profile.updatedAt = new Date().toISOString();
  await writeFile(PROFILE_PATH, `${JSON.stringify(profile, null, 2)}\n`, 'utf8');
  return profile;
}

export function buildProfileSuggestion(profile, recentPlays = []) {
  const current = normalizeProfile(profile);
  const recent = Array.isArray(recentPlays) ? recentPlays : [];
  const artists = countArtists(recent);
  const topArtists = artists.slice(0, 6).map(item => item.name);
  const repeatedArtists = artists.filter(item => item.count >= 2).slice(0, 5).map(item => item.name);
  const recentSongs = recent.slice(0, 8)
    .map(item => `${item.song}${item.artist ? ` - ${item.artist}` : ''}`)
    .filter(Boolean);

  const patch = normalizeProfile(current);
  const reasons = [];

  const artistCandidates = repeatedArtists.length ? repeatedArtists : topArtists.slice(0, 4);
  const mergedArtists = mergeList(current.taste.favoriteArtists, artistCandidates);
  if (mergedArtists && mergedArtists !== current.taste.favoriteArtists) {
    patch.taste.favoriteArtists = mergedArtists;
    reasons.push(`最近常听：${artistCandidates.join('、')}`);
  }

  if (recentSongs.length) {
    const note = `最近播放倾向：${recentSongs.join('；')}`;
    patch.notes = mergeSentence(current.notes, note);
    reasons.push('已根据最近播放生成可确认的偏好笔记');
  }

  return {
    available: reasons.length > 0,
    reasons,
    patch,
    stats: {
      totalPlays: recent.length,
      topArtists: artists.slice(0, 8),
    },
  };
}

export function formatProfileForPrompt(profile) {
  const p = normalizeProfile(profile);
  return [
    '## 长期用户画像（优先级高于通用口味文件）',
    formatSection('音乐口味', {
      喜欢的歌手: p.taste.favoriteArtists,
      喜欢的曲风: p.taste.favoriteGenres,
      偏好语种: p.taste.favoriteLanguages,
      节奏偏好: p.taste.preferredTempo,
      避免内容: p.taste.avoid,
    }),
    formatSection('场景偏好', {
      工作专注: p.scenes.work,
      深夜: p.scenes.lateNight,
      通勤: p.scenes.commute,
      睡前: p.scenes.sleep,
      雨天: p.scenes.rainyDay,
    }),
    formatSection('DJ 风格', {
      语气: p.djStyle.tone,
      歌曲介绍: p.djStyle.songIntro,
      过渡方式: p.djStyle.transition,
    }),
    p.notes ? `补充笔记：${p.notes}` : '',
  ].filter(Boolean).join('\n');
}

function normalizeProfile(input) {
  const source = input && typeof input === 'object' ? input : {};
  return {
    taste: {
      favoriteArtists: text(source.taste?.favoriteArtists),
      favoriteGenres: text(source.taste?.favoriteGenres),
      favoriteLanguages: text(source.taste?.favoriteLanguages),
      preferredTempo: text(source.taste?.preferredTempo),
      avoid: text(source.taste?.avoid),
    },
    scenes: {
      work: text(source.scenes?.work),
      lateNight: text(source.scenes?.lateNight),
      commute: text(source.scenes?.commute),
      sleep: text(source.scenes?.sleep),
      rainyDay: text(source.scenes?.rainyDay),
    },
    djStyle: {
      tone: text(source.djStyle?.tone) || DEFAULT_PROFILE.djStyle.tone,
      songIntro: text(source.djStyle?.songIntro) || DEFAULT_PROFILE.djStyle.songIntro,
      transition: text(source.djStyle?.transition) || DEFAULT_PROFILE.djStyle.transition,
    },
    notes: text(source.notes),
    updatedAt: text(source.updatedAt),
  };
}

function text(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function formatSection(title, fields) {
  const lines = Object.entries(fields)
    .filter(([, value]) => value)
    .map(([key, value]) => `- ${key}：${value}`);
  return lines.length ? `### ${title}\n${lines.join('\n')}` : '';
}

function countArtists(plays) {
  const counts = new Map();
  for (const play of plays) {
    for (const artist of splitList(play?.artist)) {
      counts.set(artist, (counts.get(artist) || 0) + 1);
    }
  }
  return Array.from(counts, ([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-CN'));
}

function splitList(value) {
  return String(value || '')
    .split(/[、,，/]+/)
    .map(item => item.trim())
    .filter(Boolean);
}

function mergeList(existing, additions) {
  const seen = new Set();
  const merged = [];
  for (const item of [...splitList(existing), ...additions]) {
    if (!item || seen.has(item)) continue;
    seen.add(item);
    merged.push(item);
  }
  return merged.slice(0, 12).join(', ');
}

function mergeSentence(existing, addition) {
  const base = text(existing);
  if (!addition) return base;
  if (base.includes(addition)) return base;
  return [base, addition].filter(Boolean).join('；').slice(0, 700);
}
