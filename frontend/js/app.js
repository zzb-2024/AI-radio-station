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
import { createFloatingPlayer } from './floating-player.js';

// ── DOM ─────────────────────────────────────────────
const $ = id => document.getElementById(id);
const audioEl = $('audio');
const inputEl = $('input');
const modeBtn = $('mode-btn');
const soundBtn = $('sound-btn');
const playerWindowBtn = $('player-window-btn');
const queueBtn = $('queue-btn');
const queueCol = $('queue-col');
const statusRight = $('status-right');
const lyricEl = $('lyric-ticker');
const seenChatIds = new Set();
const PLAYER_WINDOW_HEARTBEAT_KEY = 'gpt-neural-radio-player-heartbeat';
const PLAYER_WINDOW_TTL_MS = 5000;
let inputMode = 'song';
let externalPlayerActive = false;
let floatingPlayerActive = false;

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
queueView.attachStatus($('queue-status'));
const profileModal = $('profile-modal');
const soundModal = $('sound-modal');
const profileBtn = $('settings-btn');

mountProfilePanel(profileModal, profileBtn);
mountSoundPanel(soundModal, soundBtn, player);
const floatingPlayer = createFloatingPlayer({
  button: playerWindowBtn,
  player,
  sendMessage: send,
  openFallback: openExternalPlayerWindow,
  onFloatingChange(active) {
    floatingPlayerActive = active;
    updatePlayerButtonState();
  },
});
setExternalPlayerActive(isExternalPlayerFresh());
setInterval(() => setExternalPlayerActive(isExternalPlayerFresh()), 2500);

profileBtn.addEventListener('click', () => {
  soundModal.hidden = true;
  soundBtn?.setAttribute('aria-expanded', 'false');
});
soundBtn.addEventListener('click', () => {
  profileModal.hidden = true;
  profileBtn?.setAttribute('aria-expanded', 'false');
});
queueBtn?.addEventListener('click', () => {
  queueCol?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  queueCol?.classList.add('pulse');
  setTimeout(() => queueCol?.classList.remove('pulse'), 650);
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
  if (preview.say) floatingPlayer.addAi(preview.say);
  if (preview.ttsUrl) {
    void player.playTTS(preview.ttsUrl).then(started => {
      if (started) api.markDjPreview(preview.nextSongId).catch(() => {});
    });
  }
});
player.on('queue-change', queue => queueView.setQueue(queue));

// ── Input ───────────────────────────────────────────
async function send(message, { mode = inputMode, echo = true } = {}) {
  const requestId = createRequestId();
  if (echo) chat.add('user', message);
  chat.showTyping();
  statusRight.textContent = 'PROCESSING…';
  try {
    const data = await api.chat(message, requestId, mode);
    chat.hideTyping();
    handleChatPayload(data);
    return data;
  } catch (e) {
    chat.hideTyping();
    chat.add('ai', 'Signal lost. Try again.');
    console.error(e);
    throw e;
  } finally {
    statusRight.textContent = 'SIGNAL ACTIVE';
  }
}

function submit() {
  const v = inputEl.value.trim();
  if (!v) return;
  inputEl.value = '';
  void send(v).catch(() => {});
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
    if (d.say) floatingPlayer.addAi(d.say);
    if (!externalPlayerActive && d.ttsUrl) player.playTTS(d.ttsUrl);
  } else if (d.type === 'connected' || d.type === 'schedule' || d.type === 'now-playing') {
    player.syncState(d, { autoplay: !externalPlayerActive });
    if (d.say) chat.add('ai', d.say);
    if (d.say) floatingPlayer.addAi(d.say);
    if (!externalPlayerActive && d.ttsUrl) player.playTTS(d.ttsUrl);
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
    player.syncState(data, { autoplay: !externalPlayerActive });
  }
  if (data.say) chat.add('ai', data.say);
  floatingPlayer.handlePayload(data);
  if (!externalPlayerActive && data.ttsUrl) player.playTTS(data.ttsUrl);
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

function openExternalPlayerWindow() {
  const w = Math.min(1180, Math.max(960, window.screen?.availWidth ? window.screen.availWidth - 120 : 1080));
  const h = Math.min(760, Math.max(620, window.screen?.availHeight ? window.screen.availHeight - 120 : 680));
  const left = window.screen?.availWidth ? Math.max(0, Math.round((window.screen.availWidth - w) / 2)) : 80;
  const top = window.screen?.availHeight ? Math.max(0, Math.round((window.screen.availHeight - h) / 2)) : 60;
  const child = window.open(
    '/player.html',
    'gpt_neural_radio_player',
    `popup=yes,width=${w},height=${h},left=${left},top=${top},resizable=yes,scrollbars=no`
  );
  if (child) {
    child.focus();
    setExternalPlayerActive(true);
  } else {
    location.href = '/player.html';
  }
}

function setExternalPlayerActive(active) {
  externalPlayerActive = Boolean(active);
  updatePlayerButtonState();
  if (externalPlayerActive) {
    player.pause?.();
  }
}

window.addEventListener('message', event => {
  if (event.origin !== location.origin) return;
  if (event.data?.type === 'radio-player-ready') setExternalPlayerActive(true);
  if (event.data?.type === 'radio-player-closed') setExternalPlayerActive(false);
});

window.addEventListener('storage', event => {
  if (event.key === PLAYER_WINDOW_HEARTBEAT_KEY) setExternalPlayerActive(isExternalPlayerFresh());
});

function isExternalPlayerFresh() {
  const at = Number(localStorage.getItem(PLAYER_WINDOW_HEARTBEAT_KEY) || 0);
  return Number.isFinite(at) && Date.now() - at < PLAYER_WINDOW_TTL_MS;
}

function updatePlayerButtonState() {
  const active = externalPlayerActive || floatingPlayerActive;
  if (!playerWindowBtn) return;
  playerWindowBtn.classList.toggle('active', active);
  playerWindowBtn.setAttribute('aria-pressed', active ? 'true' : 'false');
}
