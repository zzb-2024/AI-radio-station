/**
 * 用户画像：手动确认层 + 自动学习层。
 *
 * 自动层采用轻量证据模型：
 * - 播放行为和聊天文本会写入 auto.evidence。
 * - 每条证据有 kind / value / weight / at。
 * - 读取画像时按时间衰减聚合，得到可解释的长期偏好。
 */
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { config } from '../config.js';

const PROFILE_PATH = join(config.paths.user, 'profile.json');
const AUTO_VERSION = 1;
const AUTO_EVIDENCE_LIMIT = 160;
const AUTO_HALF_LIFE_DAYS = 21;
const DAY_MS = 24 * 60 * 60 * 1000;

const DEFAULT_AUTO_PROFILE = {
  version: AUTO_VERSION,
  updatedAt: '',
  summary: '',
  stats: {
    playEvents: 0,
    chatEvents: 0,
    toplistEvents: 0,
  },
  evidence: [],
};

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
  auto: DEFAULT_AUTO_PROFILE,
  updatedAt: '',
};

let profileWriteQueue = Promise.resolve();

export async function getProfile() {
  await profileWriteQueue;
  return await readProfileFile();
}

export async function saveProfile(input) {
  return queueProfileWrite(async () => {
    const current = await readProfileFile();
    const profile = mergeProfilePatch(current, input);
    profile.updatedAt = new Date().toISOString();
    await writeProfileFile(profile);
    return profile;
  });
}

export async function learnProfileFromPlay(song, context = {}) {
  const evidence = buildPlayEvidence(song, context);
  return appendAutoEvidence(evidence, {
    playEvents: 1,
    toplistEvents: context?.toplist?.id || context?.toplist?.name ? 1 : 0,
  });
}

export async function learnProfileFromConversation(userInput, assistantOutput = '', context = {}) {
  const evidence = buildConversationEvidence(userInput, assistantOutput, context);
  return appendAutoEvidence(evidence, { chatEvents: 1 });
}

export function buildProfileSuggestion(profile, recentPlays = []) {
  const current = normalizeProfile(profile);
  const recent = Array.isArray(recentPlays) ? recentPlays : [];
  const derived = deriveAutoProfile(current.auto);
  const artists = countArtists(recent);
  const topArtists = artists.slice(0, 6).map(item => item.name);
  const repeatedArtists = artists.filter(item => item.count >= 2).slice(0, 5).map(item => item.name);
  const recentSongs = recent.slice(0, 8)
    .map(item => `${item.song}${item.artist ? ` - ${item.artist}` : ''}`)
    .filter(Boolean);

  const patch = {
    taste: { ...current.taste },
    scenes: { ...current.scenes },
    djStyle: { ...current.djStyle },
    notes: current.notes,
  };
  const reasons = [];

  const artistCandidates = uniqueList([
    ...splitList(derived.taste.favoriteArtists),
    ...(repeatedArtists.length ? repeatedArtists : topArtists.slice(0, 4)),
  ]);
  const mergedArtists = mergeList(current.taste.favoriteArtists, artistCandidates);
  if (mergedArtists && mergedArtists !== current.taste.favoriteArtists) {
    patch.taste.favoriteArtists = mergedArtists;
    reasons.push(`最近常听：${artistCandidates.slice(0, 6).join('、')}`);
  }

  for (const [path, label] of [
    ['taste.favoriteGenres', '曲风'],
    ['taste.favoriteLanguages', '语种'],
    ['taste.preferredTempo', '节奏'],
    ['taste.avoid', '避免项'],
    ['scenes.work', '工作场景'],
    ['scenes.lateNight', '深夜场景'],
    ['scenes.commute', '通勤场景'],
    ['scenes.sleep', '睡前场景'],
  ]) {
    const suggestion = getPath(derived, path);
    const currentValue = getPath(current, path);
    if (suggestion && suggestion !== currentValue) {
      setPath(patch, path, mergeList(currentValue, splitList(suggestion)));
      reasons.push(`自动学习到${label}偏好：${suggestion}`);
    }
  }

  if (derived.djStyle.songIntro && !current.djStyle.songIntro.includes(derived.djStyle.songIntro)) {
    patch.djStyle.songIntro = mergeSentence(current.djStyle.songIntro, derived.djStyle.songIntro);
    reasons.push('自动学习到歌曲介绍偏好');
  }

  if (derived.djStyle.transition && !current.djStyle.transition.includes(derived.djStyle.transition)) {
    patch.djStyle.transition = mergeSentence(current.djStyle.transition, derived.djStyle.transition);
    reasons.push('自动学习到切歌过渡偏好');
  }

  if (derived.summary) {
    patch.notes = mergeSentence(current.notes, `自动学习摘要：${derived.summary}`);
    reasons.push('已根据播放和聊天生成自动画像摘要');
  } else if (recentSongs.length) {
    patch.notes = mergeSentence(current.notes, `最近播放倾向：${recentSongs.join('；')}`);
    reasons.push('已根据最近播放生成可确认的偏好笔记');
  }

  return {
    available: reasons.length > 0,
    reasons,
    patch: normalizeProfile({ ...current, ...patch, auto: current.auto }),
    stats: {
      totalPlays: recent.length,
      topArtists: artists.slice(0, 8),
      autoEvidence: current.auto.evidence.length,
      autoSummary: derived.summary,
    },
  };
}

export function formatProfileForPrompt(profile) {
  const p = normalizeProfile(profile);
  const auto = deriveAutoProfile(p.auto);
  return [
    '## 长期用户画像（手动确认优先，自动学习补充）',
    formatSection('手动音乐口味', {
      喜欢的歌手: p.taste.favoriteArtists,
      喜欢的曲风: p.taste.favoriteGenres,
      偏好语种: p.taste.favoriteLanguages,
      节奏偏好: p.taste.preferredTempo,
      避免内容: p.taste.avoid,
    }),
    formatSection('手动场景偏好', {
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
    formatAutoProfileForPrompt(auto),
    p.notes ? `补充笔记：${p.notes}` : '',
  ].filter(Boolean).join('\n');
}

function deriveAutoProfile(autoInput) {
  const auto = normalizeAutoProfile(autoInput);
  const scores = scoreEvidence(auto.evidence);
  const take = (kind, limit) => topValues(scores.get(kind), limit);
  const context = buildContextProfile(scores);

  const taste = {
    favoriteArtists: take('artist', 6).join(', '),
    favoriteGenres: take('genre', 5).join(', '),
    favoriteLanguages: take('language', 4).join(', '),
    preferredTempo: take('tempo', 4).join(', '),
    avoid: take('avoid', 4).join(', '),
  };

  const scenes = {
    work: take('scene.work', 3).join('；'),
    lateNight: take('scene.lateNight', 3).join('；'),
    commute: take('scene.commute', 3).join('；'),
    sleep: take('scene.sleep', 3).join('；'),
    rainyDay: take('scene.rainyDay', 3).join('；'),
  };

  const djStyle = {
    tone: take('dj.tone', 3).join('；'),
    songIntro: take('dj.songIntro', 3).join('；'),
    transition: take('dj.transition', 3).join('；'),
  };
  const audio = take('audio.balance', 3).join('；');

  const summary = buildAutoSummary({ taste, scenes, djStyle, audio, context });

  return {
    taste,
    scenes,
    djStyle,
    audio,
    context,
    summary,
    updatedAt: auto.updatedAt,
    stats: auto.stats,
    evidenceCount: auto.evidence.length,
  };
}

function formatAutoProfileForPrompt(auto) {
  if (!auto.summary && !auto.evidenceCount) return '';
  return [
    '### 系统自动学习画像',
    auto.summary ? `- 摘要：${auto.summary}` : '',
    auto.taste.favoriteArtists ? `- 自动常听歌手：${auto.taste.favoriteArtists}` : '',
    auto.taste.favoriteGenres ? `- 自动曲风倾向：${auto.taste.favoriteGenres}` : '',
    auto.taste.favoriteLanguages ? `- 自动语种倾向：${auto.taste.favoriteLanguages}` : '',
    auto.taste.preferredTempo ? `- 自动节奏倾向：${auto.taste.preferredTempo}` : '',
    auto.taste.avoid ? `- 自动避免项：${auto.taste.avoid}` : '',
    auto.scenes.work ? `- 工作/学习：${auto.scenes.work}` : '',
    auto.scenes.lateNight ? `- 深夜：${auto.scenes.lateNight}` : '',
    auto.scenes.commute ? `- 通勤/开车：${auto.scenes.commute}` : '',
    auto.scenes.sleep ? `- 睡前：${auto.scenes.sleep}` : '',
    auto.djStyle.songIntro ? `- 歌曲介绍偏好：${auto.djStyle.songIntro}` : '',
    auto.djStyle.transition ? `- 过渡偏好：${auto.djStyle.transition}` : '',
    auto.djStyle.tone ? `- 交流语气偏好：${auto.djStyle.tone}` : '',
    auto.audio ? `- 音频偏好：${auto.audio}` : '',
    ...(auto.context?.weather || []).map(line => `- 天气上下文：${line}`),
    ...(auto.context?.time || []).map(line => `- 时间上下文：${line}`),
  ].filter(Boolean).join('\n');
}

async function appendAutoEvidence(entries, statsPatch = {}) {
  const now = new Date().toISOString();
  const normalized = entries
    .map(entry => normalizeEvidence({ ...entry, at: entry.at || now }))
    .filter(Boolean);

  return queueProfileWrite(async () => {
    const current = await readProfileFile();
    const auto = normalizeAutoProfile(current.auto);
    auto.evidence = [...auto.evidence, ...normalized].slice(-AUTO_EVIDENCE_LIMIT);
    auto.stats = {
      playEvents: auto.stats.playEvents + numberOr(statsPatch.playEvents, 0),
      chatEvents: auto.stats.chatEvents + numberOr(statsPatch.chatEvents, 0),
      toplistEvents: auto.stats.toplistEvents + numberOr(statsPatch.toplistEvents, 0),
    };
    auto.updatedAt = normalized.length || Object.keys(statsPatch).length ? now : auto.updatedAt;
    auto.summary = deriveAutoProfile(auto).summary;

    const next = normalizeProfile({
      ...current,
      auto,
      updatedAt: auto.updatedAt || current.updatedAt,
    });
    await writeProfileFile(next);
    return next;
  });
}

function buildPlayEvidence(song, context = {}) {
  const evidence = [];
  const source = text(context.source) || 'play';
  const note = compactNote([
    context.requestText,
    context.reason,
    song?.name ? `${song.name} - ${song.artist || ''}` : '',
  ].filter(Boolean).join(' | '));

  for (const artist of splitArtists(song?.artist)) {
    evidence.push(makeEvidence('artist', artist, 1.4, source, note));
  }

  const language = inferLanguage(song);
  if (language) evidence.push(makeEvidence('language', language, 0.65, source, note));

  evidence.push(...extractContextEvidence(song, context, source, note, 1.05));
  evidence.push(...extractToplistEvidence(context.toplist, context.requestText, source, note));
  evidence.push(...extractTextSignals(context.requestText || '', source, 1.2));
  return uniqueEvidence(evidence);
}

function buildConversationEvidence(userInput, assistantOutput = '', context = {}) {
  const source = text(context.source) || 'chat';
  const message = String(userInput || '');
  const note = compactNote(message);
  const evidence = [
    ...extractTextSignals(message, source, 2.2),
    ...extractToplistEvidence(context.toplist, message, source, note),
  ];

  if (context.currentSong?.artist && /(这首歌|这首|背景|创作|作者|讲讲|介绍)/.test(message)) {
    for (const artist of splitArtists(context.currentSong.artist)) {
      evidence.push(makeEvidence('artist', artist, 0.5, source, note));
    }
  }

  if (context.currentSong?.name && /(天气|下雨|雨天|晴天|阴天|雪天|雾天|晚上|深夜|早上|通勤|睡前|此刻|现在)/.test(message)) {
    evidence.push(...extractContextEvidence(context.currentSong, context, source, note, 0.6));
  }

  if (assistantOutput && /没搜到|找不到|不能播放/.test(String(assistantOutput))) {
    evidence.push(makeEvidence('avoid', '无法播放时先解释原因，不要硬切到无关歌曲', 0.8, source, note));
  }

  return uniqueEvidence(evidence);
}

function extractToplistEvidence(toplist, requestText = '', source = 'toplist', note = '') {
  const textBlob = `${toplist?.name || ''} ${toplist?.category || ''} ${requestText || ''}`;
  if (!textBlob.trim()) return [];

  const evidence = [];
  for (const rule of TOPLIST_RULES) {
    if (!rule.regex.test(textBlob)) continue;
    evidence.push(makeEvidence(rule.kind, rule.value, rule.weight, source, note || compactNote(textBlob)));
  }
  return evidence;
}

function extractTextSignals(input, source = 'chat', baseWeight = 1) {
  const raw = String(input || '').trim();
  if (!raw) return [];

  const evidence = [];
  for (const rule of TEXT_SIGNAL_RULES) {
    if (rule.skipIf?.test(raw)) continue;
    if (!rule.regex.test(raw)) continue;
    evidence.push(makeEvidence(rule.kind, rule.value, baseWeight * rule.weight, source, compactNote(raw)));
  }
  return evidence;
}

function extractContextEvidence(song, context = {}, source = 'play', note = '', baseWeight = 1) {
  const evidence = [];
  const songLine = normalizeSongLine(song);
  if (!songLine) return evidence;

  const weatherBucket = normalizeWeatherBucket(context.weather);
  if (weatherBucket) {
    evidence.push(makeEvidence(`context.weather.${weatherBucket}.song`, songLine, baseWeight * 1.2, source, note));
    for (const artist of splitArtists(song?.artist)) {
      evidence.push(makeEvidence(`context.weather.${weatherBucket}.artist`, artist, baseWeight * 0.9, source, note));
    }
    if (context.toplist?.name) {
      evidence.push(makeEvidence(`context.weather.${weatherBucket}.toplist`, text(context.toplist.name), baseWeight * 0.7, source, note));
    }
  }

  const timeBucket = normalizeTimeBucket(context.timePart || context.time || context.timestamp);
  if (timeBucket) {
    evidence.push(makeEvidence(`context.time.${timeBucket}.song`, songLine, baseWeight * 1.1, source, note));
    for (const artist of splitArtists(song?.artist)) {
      evidence.push(makeEvidence(`context.time.${timeBucket}.artist`, artist, baseWeight * 0.8, source, note));
    }
  }

  return evidence;
}

const TOPLIST_RULES = [
  { regex: /电音|电子|edm|house|techno|舞曲/i, kind: 'genre', value: '电音', weight: 2.2 },
  { regex: /国风|古风|古典|中文/i, kind: 'genre', value: '国风/古风', weight: 2 },
  { regex: /说唱|rap|hip hop|trap/i, kind: 'genre', value: '说唱', weight: 1.8 },
  { regex: /民谣/i, kind: 'genre', value: '民谣', weight: 1.8 },
  { regex: /摇滚|rock/i, kind: 'genre', value: '摇滚', weight: 1.8 },
  { regex: /欧美|billboard|uk|beatport/i, kind: 'language', value: '英文/欧美', weight: 1.4 },
  { regex: /日语|oricon|日本/i, kind: 'language', value: '日语', weight: 1.4 },
  { regex: /韩语|韩国/i, kind: 'language', value: '韩语', weight: 1.4 },
  { regex: /热歌|热门|实时|飙升/i, kind: 'tempo', value: '热门、热度高', weight: 1.2 },
  { regex: /电音|电子|edm|house|techno|舞曲/i, kind: 'tempo', value: '节奏感强', weight: 1.5 },
  { regex: /国风|古风|古典/i, kind: 'tempo', value: '旋律感和氛围感更重要', weight: 1.2 },
];

const TEXT_SIGNAL_RULES = [
  {
    regex: /电音|电子|edm|house|techno|舞曲/i,
    skipIf: /(不要|不想听|别放|别来|太吵|太闹|太躁).{0,8}(电音|电子|edm|house|techno|舞曲)/i,
    kind: 'genre',
    value: '电音',
    weight: 1.7,
  },
  { regex: /国风|古风|武侠|仙侠/i, kind: 'genre', value: '国风/古风', weight: 1.6 },
  { regex: /说唱|rap|hip hop|trap/i, kind: 'genre', value: '说唱', weight: 1.5 },
  { regex: /民谣/i, kind: 'genre', value: '民谣', weight: 1.5 },
  { regex: /摇滚|rock/i, kind: 'genre', value: '摇滚', weight: 1.5 },
  { regex: /爵士|jazz/i, kind: 'genre', value: '爵士', weight: 1.4 },
  { regex: /r&b|rnb|节奏布鲁斯|灵魂乐|soul/i, kind: 'genre', value: 'R&B/Soul', weight: 1.5 },
  { regex: /city\s*pop|城市流行/i, kind: 'genre', value: 'City Pop', weight: 1.4 },
  { regex: /氛围|ambient|器乐|纯音乐|后摇|post-rock/i, kind: 'genre', value: '器乐/氛围', weight: 1.4 },
  { regex: /中文|华语|国语/i, kind: 'language', value: '中文', weight: 1.2 },
  { regex: /英文|欧美|english|western/i, kind: 'language', value: '英文/欧美', weight: 1.2 },
  { regex: /日语|日文|japanese/i, kind: 'language', value: '日语', weight: 1.2 },
  { regex: /韩语|韩文|korean/i, kind: 'language', value: '韩语', weight: 1.2 },
  { regex: /粤语|粤文|cantonese/i, kind: 'language', value: '粤语', weight: 1.2 },
  { regex: /节奏感强|带感|高能|动起来|鼓点|重拍|跑步|开车|提神|躁一点/i, kind: 'tempo', value: '节奏感强', weight: 1.4 },
  { regex: /慢一点|中慢|舒缓|安静|克制|轻柔|低频|别太躁|不要太躁|不要太快/i, kind: 'tempo', value: '中慢速、克制', weight: 1.4 },
  { regex: /太吵|太闹|太躁|不要太炸|别太吵|别太闹|高频刺激/i, kind: 'avoid', value: '过度吵闹或高频刺激的歌', weight: 1.8 },
  { regex: /太甜|甜腻|口水情歌|土味/i, kind: 'avoid', value: '太甜腻的口水情歌', weight: 1.5 },
  { regex: /不要切歌|别切歌|先别换|保持当前播放|别突然换歌/i, kind: 'dj.tone', value: '聊天时先保持当前播放，不要主动切歌', weight: 1.7 },
  { regex: /背景|故事|创作|作者|作词|作曲|采访|什么情况下写|介绍歌曲|讲讲这首歌|这首歌/i, kind: 'dj.songIntro', value: '喜欢歌曲背景、创作状态和作品位置', weight: 1.7 },
  { regex: /过渡|衔接|切换|切歌|别生硬|不要生硬|上一首|下一首|尾段|结尾/i, kind: 'dj.transition', value: '切歌时提前铺垫，自然过渡，别硬切', weight: 1.7 },
  { regex: /人机|机器人|自然一点|像真人|客服|机械|别太官方|别太标准答案/i, kind: 'dj.tone', value: '交流要自然像真人聊天，不要客服感和机械感', weight: 1.7 },
  { regex: /工作|学习|专注|写代码|办公/i, kind: 'scene.work', value: '少打扰、节奏稳定、适合专注', weight: 1.4 },
  { regex: /深夜|晚上|夜里|夜晚|凌晨/i, kind: 'scene.lateNight', value: '安静、克制、有一点城市夜晚的感觉', weight: 1.4 },
  { regex: /通勤|开车|地铁|路上/i, kind: 'scene.commute', value: '节奏稳定、有推进感，但不要压迫', weight: 1.3 },
  { regex: /睡前|助眠|准备睡|睡觉/i, kind: 'scene.sleep', value: '轻声、低频、少鼓点', weight: 1.4 },
  { regex: /雨天|下雨|阴天/i, kind: 'scene.rainyDay', value: '湿润、低饱和、情绪不要太满', weight: 1.2 },
  { regex: /tts|口播|人声|声音太小|听不清|音量|音乐.{0,8}降低|音乐.{0,8}太大/i, kind: 'audio.balance', value: 'TTS 人声要清楚，音乐不要盖住口播', weight: 1.6 },
  { regex: /音乐.{0,8}50%|降到\s*50|一半音量/i, kind: 'audio.balance', value: '口播时音乐约降到 50%，但要平滑淡入淡出', weight: 1.6 },
  { regex: /语速.{0,8}1\.2|速度.{0,8}1\.2|说话.{0,8}1\.2/i, kind: 'audio.balance', value: 'TTS 语速偏快，约 1.2 倍', weight: 1.4 },
];

function scoreEvidence(evidence) {
  const now = Date.now();
  const scores = new Map();

  for (const item of evidence) {
    const at = Date.parse(item.at);
    const age = Number.isFinite(at) ? Math.max(0, now - at) : 0;
    const decay = Math.pow(0.5, age / (AUTO_HALF_LIFE_DAYS * DAY_MS));
    const score = numberOr(item.weight, 1) * decay;
    if (!score || score <= 0) continue;

    const bucket = scores.get(item.kind) || new Map();
    bucket.set(item.value, (bucket.get(item.value) || 0) + score);
    scores.set(item.kind, bucket);
  }

  return scores;
}

function topValues(bucket, limit) {
  if (!bucket) return [];
  return Array.from(bucket.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN'))
    .slice(0, limit)
    .map(([value]) => value);
}

function buildAutoSummary({ taste, scenes, djStyle, audio, context }) {
  const parts = [];
  if (taste.favoriteGenres) parts.push(`偏好${taste.favoriteGenres}`);
  if (taste.favoriteArtists) parts.push(`常听${taste.favoriteArtists}`);
  if (taste.preferredTempo) parts.push(`节奏倾向是${taste.preferredTempo}`);

  const sceneText = [
    scenes.work ? `工作时${scenes.work}` : '',
    scenes.lateNight ? `深夜${scenes.lateNight}` : '',
    scenes.sleep ? `睡前${scenes.sleep}` : '',
    scenes.commute ? `通勤时${scenes.commute}` : '',
  ].filter(Boolean).join('；');
  if (sceneText) parts.push(sceneText);

  if (djStyle.songIntro) parts.push(`歌曲介绍上${djStyle.songIntro}`);
  if (djStyle.transition) parts.push(`过渡上${djStyle.transition}`);
  if (djStyle.tone) parts.push(`交流上${djStyle.tone}`);
  if (audio) parts.push(`音频上${audio}`);
  if (context?.weather?.length) parts.push(`天气场景上${context.weather.join('；')}`);
  if (context?.time?.length) parts.push(`时间场景上${context.time.join('；')}`);
  return parts.join('；').slice(0, 520);
}

function normalizeProfile(input) {
  const source = objectOr(input);
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
    auto: normalizeAutoProfile(source.auto),
    updatedAt: text(source.updatedAt),
  };
}

function normalizeAutoProfile(input) {
  const source = objectOr(input);
  const stats = objectOr(source.stats);
  const evidence = Array.isArray(source.evidence)
    ? source.evidence.map(normalizeEvidence).filter(Boolean).slice(-AUTO_EVIDENCE_LIMIT)
    : [];

  return {
    version: AUTO_VERSION,
    updatedAt: text(source.updatedAt),
    summary: text(source.summary),
    stats: {
      playEvents: numberOr(stats.playEvents, 0),
      chatEvents: numberOr(stats.chatEvents, 0),
      toplistEvents: numberOr(stats.toplistEvents, 0),
    },
    evidence,
  };
}

function normalizeEvidence(input) {
  const source = objectOr(input);
  const kind = text(source.kind);
  const value = text(source.value);
  if (!kind || !value) return null;
  return {
    at: text(source.at) || new Date().toISOString(),
    source: text(source.source) || 'auto',
    kind,
    value,
    weight: clamp(numberOr(source.weight, 1), 0.1, 8),
    note: compactNote(source.note),
  };
}

function mergeProfilePatch(existing, patch) {
  const current = normalizeProfile(existing);
  const source = objectOr(patch);
  const next = normalizeProfile(current);

  if (hasOwn(source, 'taste')) {
    next.taste = mergeKnownFields(current.taste, source.taste, Object.keys(DEFAULT_PROFILE.taste));
  }
  if (hasOwn(source, 'scenes')) {
    next.scenes = mergeKnownFields(current.scenes, source.scenes, Object.keys(DEFAULT_PROFILE.scenes));
  }
  if (hasOwn(source, 'djStyle')) {
    next.djStyle = mergeKnownFields(current.djStyle, source.djStyle, Object.keys(DEFAULT_PROFILE.djStyle));
    next.djStyle.tone ||= DEFAULT_PROFILE.djStyle.tone;
    next.djStyle.songIntro ||= DEFAULT_PROFILE.djStyle.songIntro;
    next.djStyle.transition ||= DEFAULT_PROFILE.djStyle.transition;
  }
  if (hasOwn(source, 'notes')) next.notes = text(source.notes);
  if (hasOwn(source, 'auto')) next.auto = normalizeAutoProfile(source.auto);
  if (hasOwn(source, 'updatedAt')) next.updatedAt = text(source.updatedAt);
  return normalizeProfile(next);
}

function mergeKnownFields(base, patch, keys) {
  const next = { ...base };
  const source = objectOr(patch);
  for (const key of keys) {
    if (hasOwn(source, key)) next[key] = text(source[key]);
  }
  return next;
}

async function readProfileFile() {
  try {
    const raw = await readFile(PROFILE_PATH, 'utf8');
    return normalizeProfile(JSON.parse(raw));
  } catch {
    return normalizeProfile(DEFAULT_PROFILE);
  }
}

async function writeProfileFile(profile) {
  await writeFile(PROFILE_PATH, `${JSON.stringify(normalizeProfile(profile), null, 2)}\n`, 'utf8');
}

function queueProfileWrite(task) {
  const run = profileWriteQueue.then(task, task);
  profileWriteQueue = run.catch(() => {});
  return run;
}

function formatSection(title, fields) {
  const lines = Object.entries(fields)
    .filter(([, value]) => value)
    .map(([key, value]) => `- ${key}：${value}`);
  return lines.length ? `### ${title}\n${lines.join('\n')}` : '';
}

function makeEvidence(kind, value, weight, source, note = '') {
  return { kind, value, weight, source, note };
}

function uniqueEvidence(entries) {
  const seen = new Set();
  const output = [];
  for (const entry of entries) {
    const item = normalizeEvidence(entry);
    if (!item) continue;
    const key = `${item.kind}\u0000${item.value}\u0000${item.source}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }
  return output;
}

function buildContextProfile(scores) {
  return {
    weather: buildContextSummary(scores, 'context.weather.', WEATHER_CONTEXT_LABELS),
    time: buildContextSummary(scores, 'context.time.', TIME_CONTEXT_LABELS),
  };
}

function buildContextSummary(scores, prefix, labels) {
  const groups = new Map();
  for (const [kind, bucket] of scores.entries()) {
    if (!kind.startsWith(prefix)) continue;
    const remainder = kind.slice(prefix.length);
    const [bucketKey, detail = 'song'] = remainder.split('.');
    const group = groups.get(bucketKey) || {};
    group[detail] = bucket;
    groups.set(bucketKey, group);
  }

  return Array.from(groups.entries())
    .map(([bucketKey, group]) => formatContextSummaryLine(labels[bucketKey] || bucketKey, group))
    .filter(Boolean)
    .slice(0, 5);
}

function formatContextSummaryLine(label, group) {
  const songs = topValues(group.song, 3);
  const artists = topValues(group.artist, 3);
  const toplists = topValues(group.toplist, 2);
  const parts = [];
  if (songs.length) parts.push(`常听歌：${songs.join('、')}`);
  if (artists.length) parts.push(`常听歌手：${artists.join('、')}`);
  if (toplists.length) parts.push(`常来自：${toplists.join('、')}`);
  return parts.length ? `${label}${parts.join('；')}` : '';
}

function splitArtists(value) {
  return uniqueList(String(value || '')
    .split(/[、,，/;；]+/)
    .map(item => item.replace(/\b(feat|ft)\.?\b.*$/i, '').trim())
    .filter(item => item.length >= 2 && item.length <= 48));
}

function normalizeSongLine(song) {
  if (!song?.name) return '';
  return `${song.name} - ${song.artist || '未知艺人'}`;
}

function normalizeWeatherBucket(value) {
  const textValue = text(value);
  if (!textValue) return '';
  if (/(暴雨|大雨|中雨|小雨|阵雨|雷雨|雨)/.test(textValue)) return 'rain';
  if (/(暴雪|大雪|中雪|小雪|雪)/.test(textValue)) return 'snow';
  if (/(雾霾|霾|haze)/i.test(textValue)) return 'haze';
  if (/(雾|fog)/i.test(textValue)) return 'fog';
  if (/(晴|clear|sunny)/i.test(textValue)) return 'sunny';
  if (/(多云|阴|cloud)/i.test(textValue)) return 'cloudy';
  if (/(风|wind)/i.test(textValue)) return 'windy';
  return '';
}

function normalizeTimeBucket(value) {
  let date = value;
  if (typeof value === 'string' || typeof value === 'number') date = new Date(value);
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) date = new Date();
  const hour = date.getHours();
  if (hour >= 5 && hour < 9) return 'morning';
  if (hour >= 9 && hour < 12) return 'forenoon';
  if (hour >= 12 && hour < 14) return 'noon';
  if (hour >= 14 && hour < 18) return 'afternoon';
  if (hour >= 18 && hour < 22) return 'evening';
  if (hour >= 22 || hour < 2) return 'lateNight';
  return 'night';
}

const WEATHER_CONTEXT_LABELS = {
  rain: '雨天',
  snow: '雪天',
  haze: '雾霾天',
  fog: '雾天',
  sunny: '晴天',
  cloudy: '阴天/多云',
  windy: '大风天',
};

const TIME_CONTEXT_LABELS = {
  morning: '早晨',
  forenoon: '上午',
  noon: '中午',
  afternoon: '下午',
  evening: '傍晚',
  night: '夜间',
  lateNight: '深夜',
};

function inferLanguage(song) {
  const blob = `${song?.name || ''} ${song?.artist || ''}`;
  if (/[ぁ-ゟ゠-ヿ]/.test(blob)) return '日语';
  if (/[가-힣]/.test(blob)) return '韩语';
  if (/[\u4e00-\u9fff]/.test(blob)) return '中文';
  if (/[a-z]/i.test(blob)) return '英文/欧美';
  return '';
}

function countArtists(plays) {
  const counts = new Map();
  for (const play of plays) {
    for (const artist of splitArtists(play?.artist)) {
      counts.set(artist, (counts.get(artist) || 0) + 1);
    }
  }
  return Array.from(counts, ([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-CN'));
}

function splitList(value) {
  return String(value || '')
    .split(/[、,，;；/]+/)
    .map(item => item.trim())
    .filter(Boolean);
}

function mergeList(existing, additions) {
  const merged = uniqueList([...splitList(existing), ...additions]);
  return merged.slice(0, 12).join(', ');
}

function mergeSentence(existing, addition) {
  const base = text(existing);
  const next = text(addition);
  if (!next) return base;
  if (base.includes(next)) return base;
  return [base, next].filter(Boolean).join('；').slice(0, 900);
}

function uniqueList(items) {
  const seen = new Set();
  const output = [];
  for (const item of items) {
    const value = text(item);
    const key = value.toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    output.push(value);
  }
  return output;
}

function getPath(source, path) {
  return path.split('.').reduce((value, key) => value?.[key], source);
}

function setPath(target, path, value) {
  const parts = path.split('.');
  let current = target;
  for (let i = 0; i < parts.length - 1; i += 1) {
    current = current[parts[i]] ||= {};
  }
  current[parts.at(-1)] = value;
}

function compactNote(value) {
  return text(value).slice(0, 160);
}

function text(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function objectOr(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function hasOwn(source, key) {
  return Object.prototype.hasOwnProperty.call(source, key);
}

function numberOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
