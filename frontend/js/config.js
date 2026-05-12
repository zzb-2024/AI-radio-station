/**
 * 前端常量。
 */
export const CONFIG = {
  api: {
    chat:   '/api/chat',
    next:   '/api/next',
    now:    '/api/now',
    profile: '/api/profile',
    profileSuggestion: '/api/profile/suggestion',
  },
  ws: {
    path: '/stream',
  },
  lyric: {
    tickIntervalMs: 300,
  },
  player: {
    fakeLevelPlaying:  () => 0.4 + Math.random() * 0.4,
    fakeLevelIdle:     () => 0.08 + Math.random() * 0.06,
    fakeLevelEase:     0.12,
  },
  audio: {
    ttsDuckVolume: 0.35,
    ttsBoostGain: 1.08,
    musicFadeMs: 520,
    ttsFadeMs: 220,
    ttsRestoreDelayMs: 140,
  },
  ui: {
    loadingMs: 1300,
  },
};

/**
 * 根据当前页面协议选 ws 或 wss。
 */
export function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}${CONFIG.ws.path}`;
}
