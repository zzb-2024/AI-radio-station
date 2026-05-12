/**
 * 集中配置。所有硬编码值、环境变量、默认值都从这里读取。
 * 业务代码不再直接访问 process.env，也不再手动解析路径。
 */
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const BACKEND_DIR  = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(BACKEND_DIR, '..');

const env = process.env;
function int(key, def)  { const v = parseInt(env[key] ?? '', 10); return Number.isFinite(v) ? v : def; }
function str(key, def = '') { return env[key] ?? def; }
function bool(key, def = false) {
  const v = env[key];
  if (v == null) return def;
  return /^(1|true|yes|on)$/i.test(v);
}

export const config = {
  server: {
    port: int('PORT', 8080),
  },

  openai: {
    apiUrl:          str('OPENAI_API_URL', 'https://api.openai.com'),
    apiKey:          str('OPENAI_API_KEY'),
    model:           str('OPENAI_MODEL', 'gpt-5.5'),
    maxTokens:       int('OPENAI_MAX_TOKENS', 1024),
    timeoutMs:       int('OPENAI_TIMEOUT_MS', 30000),
    reasoningEffort: str('OPENAI_REASONING_EFFORT', 'low'),
  },

  // 网易云音乐（公开 API + weapi fallback）
  ncm: {
    host:      str('NCM_HOST', 'music.163.com'),
    userAgent: str('NCM_UA', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'),
    musicU:    str('NCM_MUSIC_U'), // 黑胶 cookie，解锁 VIP
    csrf:      str('NCM_CSRF'),
    timeoutMs: int('NCM_TIMEOUT_MS', 8000),
    bitrate:   str('NCM_BITRATE', 'standard'),
  },

  // Fish Audio TTS
  tts: {
    provider:  str('TTS_PROVIDER', 'auto'),
    apiKey:    str('FISH_API_KEY'),
    voiceId:   str('FISH_VOICE_ID'),
    host:      str('FISH_HOST', 'api.fish.audio'),
    timeoutMs: int('FISH_TIMEOUT_MS', 15000),
    format:    str('FISH_FORMAT', 'mp3'),
    latency:   str('FISH_LATENCY', 'normal'),
    maxInputBytes: int('TTS_MAX_INPUT_BYTES', 2048),
    youdao: {
      apiUrl:    str('YOUDAO_TTS_API_URL', 'https://openapi.youdao.com/ttsapi'),
      appKey:    str('YOUDAO_TTS_APP_KEY'),
      appSecret: str('YOUDAO_TTS_APP_SECRET'),
      voiceName: str('YOUDAO_TTS_VOICE_NAME', 'youxiaoxun'),
      speed:     str('YOUDAO_TTS_SPEED', '1'),
      volume:    str('YOUDAO_TTS_VOLUME', '1.50'),
    },
  },

  dj: {
    enabled:  bool('DJ_ENABLED', true),
    maxChars: int('DJ_MAX_CHARS', 160),
    gapMin:   int('DJ_GAP_MIN', 1),
    gapMax:   int('DJ_GAP_MAX', 1),
  },

  weather: {
    provider:     str('WEATHER_PROVIDER', 'caiyun'),
    city:         str('WEATHER_CITY', '合肥'),
    longitude:    str('WEATHER_LONGITUDE', '117.2272'),
    latitude:     str('WEATHER_LATITUDE', '31.8206'),
    timeoutMs:    int('WEATHER_TIMEOUT_MS', 5000),
    openWeatherKey: str('OPENWEATHER_KEY'),
    caiyun: {
      appKey:    str('CAIYUN_APP_KEY'),
      appSecret: str('CAIYUN_APP_SECRET'),
      token:     str('CAIYUN_TOKEN'),
    },
  },

  state: {
    maxPlays:    int('STATE_MAX_PLAYS', 500),
    maxMessages: int('STATE_MAX_MESSAGES', 50),
  },

  queue: {
    searchLimitPerItem: int('QUEUE_SEARCH_LIMIT', 1),
    directSearchLimit:  int('DIRECT_SEARCH_LIMIT', 3),
  },

  scheduler: {
    enabled: bool('SCHEDULER_ENABLED', true),
    // cron 表达式 → 触发标签
    triggers: {
      '0 7 * * *':  '早晨7点',
      '0 9 * * *':  '上午9点工作时间',
      '0 12 * * *': '中午12点',
      '0 14 * * *': '下午2点',
      '0 18 * * *': '傍晚6点下班',
      '0 22 * * *': '晚上10点睡前',
    },
    hourlyEnabled:   bool('SCHEDULER_HOURLY', false),
    hourlyBlacklist: [7, 9, 12, 14, 18, 22],
  },

  // 绝对路径。业务模块直接用，不再自己拼。
  paths: {
    root:      PROJECT_ROOT,
    backend:   BACKEND_DIR,
    frontend:  resolve(PROJECT_ROOT, 'frontend'),
    ttsCache:  resolve(PROJECT_ROOT, 'cache/tts'),
    prompts:   resolve(PROJECT_ROOT, 'prompts'),
    user:      resolve(PROJECT_ROOT, 'user'),
    stateFile: resolve(PROJECT_ROOT, str('STATE_FILE', 'state.json')),
  },
};

export function assertConfig() {
  if (!config.openai.apiKey) {
    console.warn('[config] OPENAI_API_KEY not set — GPT-5.5 AI chat will fail');
  }
  if (!config.ncm.musicU) {
    console.warn('[config] NCM_MUSIC_U not set — VIP songs will be unavailable');
  }
  if (config.tts.provider === 'youdao' && !config.tts.youdao.appKey) {
    console.warn('[config] TTS_PROVIDER=youdao but YOUDAO_TTS_APP_KEY is missing');
  }
}
