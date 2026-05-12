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
import { mountSoundPanel } from './sound.js';

// ── DOM ─────────────────────────────────────────────
const $ = id => document.getElementById(id);
const audioEl = $('audio');
const inputEl = $('input');
const modeBtn = $('mode-btn');
const soundBtn = $('sound-btn');
const statusRight = $('status-right');
const lyricEl = $('lyric-ticker');
const seenChatIds = new Set();
let inputMode = 'song';

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
const profileModal = $('profile-modal');
const soundModal = $('sound-modal');
const profileBtn = $('settings-btn');

mountProfilePanel(profileModal, profileBtn);
mountSoundPanel(soundModal, soundBtn, player);

profileBtn.addEventListener('click', () => {
  soundModal.hidden = true;
  soundBtn?.setAttribute('aria-expanded', 'false');
});
soundBtn.addEventListener('click', () => {
  profileModal.hidden = true;
  profileBtn?.setAttribute('aria-expanded', 'false');
});

// 歌词同步：每首歌换时重新绑定
let stopLyrics = () => {};
player.on('song-change', song => {
  queueView.setActive(player.idx);
  if (song) setInputMode('chat', { auto: true });
  else setInputMode('song', { auto: true });
  stopLyrics();
  stopLyrics = syncLyrics(audioEl, song?.lyric || '', text => {
    lyricEl.textContent = text;
  });
});
player.on('dj-preview', preview => {
  if (preview.say) chat.add('ai', preview.say);
  if (preview.ttsUrl) {
    void player.playTTS(preview.ttsUrl).then(started => {
      if (started) api.markDjPreview(preview.nextSongId).catch(() => {});
    });
  }
});
player.on('queue-change', queue => queueView.setQueue(queue));

// ── Input ───────────────────────────────────────────
async function send(message) {
  const requestId = createRequestId();
  chat.add('user', message);
  chat.showTyping();
  statusRight.textContent = 'PROCESSING…';
  try {
    const data = await api.chat(message, requestId, inputMode);
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
modeBtn.addEventListener('click', () => {
  setInputMode(inputMode === 'song' ? 'chat' : 'song');
  inputEl.focus();
});

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
  .then(d => {
    player.syncState(d);
    setInputMode(d?.nowPlaying?.url ? 'chat' : 'song', { auto: true });
  })
  .catch(() => {});

function createRequestId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `chat_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function handleChatPayload(data) {
  if (shouldSkipChatPayload(data?.requestId)) return;
  if (!data?.chatOnly) {
    player.syncState(data, { autoplay: true });
  }
  if (data.say) chat.add('ai', data.say);
  if (data.ttsUrl) player.playTTS(data.ttsUrl);
}

function setInputMode(mode, { auto = false } = {}) {
  const next = mode === 'chat' ? 'chat' : 'song';
  if (auto && inputMode === 'song' && next === 'chat') {
    inputMode = next;
  } else if (auto && inputMode === 'chat' && next === 'song') {
    inputMode = next;
  } else if (!auto) {
    inputMode = next;
  } else if (!modeBtn.dataset.mode) {
    inputMode = next;
  }

  modeBtn.dataset.mode = inputMode;
  modeBtn.textContent = inputMode === 'song' ? '点歌' : '聊天';
  modeBtn.setAttribute('aria-pressed', inputMode === 'song' ? 'true' : 'false');
  modeBtn.title = inputMode === 'song'
    ? '当前模式：点歌，发送会换歌'
    : '当前模式：聊天，发送不会换歌';
  inputEl.placeholder = inputMode === 'song'
    ? '说你想听什么_'
    : '和 anjiu 聊聊当前这首歌_';
}

function shouldSkipChatPayload(requestId) {
  if (!requestId) return false;
  if (seenChatIds.has(requestId)) return true;
  seenChatIds.add(requestId);
  setTimeout(() => seenChatIds.delete(requestId), 60000);
  return false;
}
