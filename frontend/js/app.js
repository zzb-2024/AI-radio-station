/**
 * 应用入口：装配各模块、绑定交互、连接 WS。
 */
import { CONFIG } from './config.js';
import { api, connectWs } from './api.js';
import { Chat } from './chat.js';
import { QueueView } from './queue.js';
import { Player } from './player.js';
import { syncLyrics } from './lyrics.js';
import { mountProfilePanel } from './profile.js';

// ── DOM ─────────────────────────────────────────────
const $ = id => document.getElementById(id);
const audioEl = $('audio');
const inputEl = $('input');
const statusRight = $('status-right');
const lyricEl = $('lyric-ticker');
const seenChatIds = new Set();

// ── Components ──────────────────────────────────────
const chat = new Chat($('messages'));

const player = new Player(audioEl, {
  btnPlay:     $('btn-play'),
  btnPrev:     $('btn-prev'),
  btnNext:     $('btn-next'),
  progress:    $('progress-wrap'),
  progressBar: $('progress-bar'),
  nameEl:      $('player-song'),
  artistEl:    $('player-artist'),
  coverEl:     $('player-cover'),
});

const queueView = new QueueView($('queue-items'), idx => player.requestPlayIdx(idx));
mountProfilePanel($('profile-modal'), $('settings-btn'));

// 歌词同步：每首歌换时重新绑定
let stopLyrics = () => {};
player.on('song-change', song => {
  queueView.setActive(player.idx);
  stopLyrics();
  stopLyrics = syncLyrics(audioEl, song?.lyric || '', text => {
    lyricEl.textContent = text;
  });
});
player.on('queue-change', queue => queueView.setQueue(queue));

// ── Input ───────────────────────────────────────────
async function send(message) {
  const requestId = createRequestId();
  chat.add('user', message);
  chat.showTyping();
  statusRight.textContent = 'PROCESSING…';
  try {
    const data = await api.chat(message, requestId);
    chat.hideTyping();
    handleChatPayload(data);
  } catch (e) {
    chat.hideTyping();
    chat.add('ai', 'Signal lost. Try again.');
    console.error(e);
  } finally {
    statusRight.textContent = 'SIGNAL ACTIVE';
  }
}

function submit() {
  const v = inputEl.value.trim();
  if (!v) return;
  inputEl.value = '';
  send(v);
}

inputEl.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
$('send-btn').addEventListener('click', submit);

document.querySelectorAll('.tag').forEach(t => {
  t.addEventListener('click', () => {
    inputEl.value = t.dataset.val;
    inputEl.focus();
  });
});

// ── WebSocket (live push) ───────────────────────────
connectWs(d => {
  if (d.type === 'chat') {
    handleChatPayload(d);
  } else if (d.type === 'dj') {
    if (d.say) chat.add('ai', d.say);
    if (d.ttsUrl) player.playTTS(d.ttsUrl);
  } else if (d.type === 'connected' || d.type === 'schedule' || d.type === 'now-playing') {
    player.syncState(d, { autoplay: true });
    if (d.say) chat.add('ai', d.say);
    if (d.ttsUrl) player.playTTS(d.ttsUrl);
  }
});

// ── Init ────────────────────────────────────────────
setTimeout(() => $('loading').classList.add('hide'), CONFIG.ui.loadingMs);

api.now()
  .then(d => player.syncState(d))
  .catch(() => {});

function createRequestId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `chat_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function handleChatPayload(data) {
  if (shouldSkipChatPayload(data?.requestId)) return;
  player.syncState(data, { autoplay: true });
  if (data.say) chat.add('ai', data.say);
  if (data.ttsUrl) player.playTTS(data.ttsUrl);
}

function shouldSkipChatPayload(requestId) {
  if (!requestId) return false;
  if (seenChatIds.has(requestId)) return true;
  seenChatIds.add(requestId);
  setTimeout(() => seenChatIds.delete(requestId), 60000);
  return false;
}
