/**
 * TTS 服务。支持 Fish Audio 和有道智云。
 * 将文字合成为 mp3，缓存到本地，返回可被静态路由访问的 URL。
 */
import { createHash, randomUUID } from 'crypto';
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { config } from '../config.js';
import { requestBuffer, requestStream } from '../lib/http.js';

if (!existsSync(config.paths.ttsCache)) {
  mkdirSync(config.paths.ttsCache, { recursive: true });
}

/**
 * 合成文本为语音。返回形如 /tts/<hash>.mp3 的本地 URL，失败返回 null。
 */
export async function synthesize(text) {
  const provider = resolveProvider();
  const normalizedText = normalizeText(text);
  if (!provider || !normalizedText) return null;

  const cacheKey = buildCacheKey(provider, normalizedText);
  const filename = `${cacheKey}.${config.tts.format}`;
  const outPath = join(config.paths.ttsCache, filename);
  if (existsSync(outPath)) return `/tts/${filename}`;

  try {
    if (provider === 'youdao') {
      await writeAtomically(outPath, tempPath => synthesizeWithYoudao(normalizedText, tempPath));
    } else {
      await writeAtomically(outPath, tempPath => synthesizeWithFish(normalizedText, tempPath));
    }
    return `/tts/${filename}`;
  } catch (e) {
    console.warn(`[tts] ${e.message}`);
    return null;
  }
}

function resolveProvider() {
  const preferred = String(config.tts.provider || 'auto').toLowerCase();
  if (preferred === 'youdao') return hasYoudaoConfig() ? 'youdao' : null;
  if (preferred === 'fish') return hasFishConfig() ? 'fish' : null;
  if (hasYoudaoConfig()) return 'youdao';
  if (hasFishConfig()) return 'fish';
  return null;
}

function hasFishConfig() {
  return Boolean(config.tts.apiKey);
}

function hasYoudaoConfig() {
  return Boolean(config.tts.youdao.appKey && config.tts.youdao.appSecret && config.tts.youdao.voiceName);
}

function normalizeText(text) {
  const trimmed = String(text || '').replace(/\s+/g, ' ').trim();
  if (!trimmed) return '';
  return trimUtf8(trimmed, config.tts.maxInputBytes);
}

function trimUtf8(text, maxBytes) {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;

  let end = text.length;
  while (end > 0 && Buffer.byteLength(text.slice(0, end), 'utf8') > maxBytes) {
    end -= 1;
  }
  return text.slice(0, end).trim();
}

function buildCacheKey(provider, text) {
  const base = provider === 'youdao'
    ? [provider, text, config.tts.youdao.voiceName, config.tts.youdao.speed, config.tts.youdao.volume, config.tts.format]
    : [provider, text, config.tts.voiceId, config.tts.latency, config.tts.format];

  return createHash('md5').update(base.join('|')).digest('hex');
}

async function writeAtomically(outPath, writer) {
  const tempPath = `${outPath}.${process.pid}.${randomUUID()}.part`;

  try {
    await writer(tempPath);
    finalizeTempFile(tempPath, outPath);
  } catch (error) {
    cleanupTempFile(tempPath);
    throw error;
  }
}

function finalizeTempFile(tempPath, outPath) {
  try {
    renameSync(tempPath, outPath);
  } catch (error) {
    // 并发请求可能已经把同一个缓存 key 写好了；此时直接丢弃临时文件即可。
    if (existsSync(outPath)) {
      cleanupTempFile(tempPath);
      return;
    }
    cleanupTempFile(tempPath);
    throw error;
  }
}

function cleanupTempFile(path) {
  rmSync(path, { force: true });
}

async function synthesizeWithFish(text, outPath) {
  const body = JSON.stringify({
    text,
    reference_id: config.tts.voiceId || undefined,
    format: config.tts.format,
    latency: config.tts.latency,
  });

  await requestStream({
    url: `https://${config.tts.host}/v1/tts`,
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.tts.apiKey}`,
      'Content-Type': 'application/json',
    },
    body,
    timeoutMs: config.tts.timeoutMs,
  }, createWriteStream(outPath));
}

async function synthesizeWithYoudao(text, outPath) {
  const salt = randomUUID();
  const curtime = Math.floor(Date.now() / 1000).toString();
  const sign = createHash('sha256')
    .update(config.tts.youdao.appKey + truncateForSign(text) + salt + curtime + config.tts.youdao.appSecret)
    .digest('hex');

  const body = new URLSearchParams({
    q: text,
    appKey: config.tts.youdao.appKey,
    salt,
    sign,
    signType: 'v3',
    curtime,
    format: config.tts.format,
    speed: config.tts.youdao.speed,
    volume: config.tts.youdao.volume,
    voiceName: config.tts.youdao.voiceName,
  }).toString();

  const { status, headers, buffer } = await requestBuffer({
    url: config.tts.youdao.apiUrl,
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
    timeoutMs: config.tts.timeoutMs,
  });

  const contentType = String(headers['content-type'] || '').toLowerCase();
  if ((status || 0) >= 400) {
    throw new Error(`youdao HTTP ${status}`);
  }
  if (contentType.includes('application/json')) {
    throw new Error(parseYoudaoError(buffer));
  }
  if (!contentType.includes('audio')) {
    throw new Error(`youdao unexpected content-type: ${contentType || 'unknown'}`);
  }

  writeFileSync(outPath, buffer);
}

function truncateForSign(text) {
  return text.length <= 20
    ? text
    : `${text.slice(0, 10)}${text.length}${text.slice(-10)}`;
}

function parseYoudaoError(buffer) {
  try {
    const json = JSON.parse(buffer.toString('utf8'));
    const code = json?.errorCode || json?.code || 'unknown';
    const msg = json?.msg || json?.message || '';
    return `youdao error ${code}${msg ? `: ${msg}` : ''}`;
  } catch {
    return `youdao error: ${buffer.toString('utf8').slice(0, 200)}`;
  }
}
