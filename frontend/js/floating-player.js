/**
 * Document Picture-in-Picture 悬浮播放器。
 * 三层状态：圆盘 -> 播放器 -> 队列；聊天/点歌只在队列层弹窗显示。
 */
import { sourceLabel } from './queue.js';
import { syncLyrics } from './lyrics.js';

const LEVEL = {
  DISC: 'disc',
  PLAYER: 'player',
  QUEUE: 'queue',
};

const SIZES = {
  [LEVEL.DISC]: { width: 160, height: 160 },
  [LEVEL.PLAYER]: { width: 430, height: 250 },
  [LEVEL.QUEUE]: { width: 560, height: 680 },
};

export function createFloatingPlayer({
  button,
  player,
  sendMessage,
  openFallback,
  onFloatingChange = () => {},
}) {
  let pipWindow = null;
  let level = LEVEL.DISC;
  let chatOpen = false;
  let inputMode = player.currentSong ? 'chat' : 'song';
  let stopLyrics = () => {};
  let nodes = {};

  const audioHandlers = {
    play: () => updatePlayback(),
    pause: () => updatePlayback(),
    timeupdate: () => updateProgress(),
    loadedmetadata: () => updateProgress(),
  };

  button?.addEventListener('click', () => {
    void open();
  });

  player.on('song-change', song => {
    inputMode = song ? 'chat' : 'song';
    restartLyrics(song);
    renderAll();
  });
  player.on('queue-change', () => renderQueue());

  async function open() {
    if (pipWindow && !pipWindow.closed) {
      pipWindow.focus();
      return;
    }

    if (!canUseDocumentPip()) {
      openFallback?.();
      return;
    }

    try {
      pipWindow = await window.documentPictureInPicture.requestWindow({
        ...SIZES[LEVEL.DISC],
        disallowReturnToOpener: true,
      });
      level = LEVEL.DISC;
      chatOpen = false;
      build();
      bindAudio();
      restartLyrics(player.currentSong);
      renderAll();
      setButtonActive(true);
      onFloatingChange(true);
      pipWindow.addEventListener('pagehide', close, { once: true });
    } catch (error) {
      console.warn('[floating-player]', error.message);
      openFallback?.();
    }
  }

  function build() {
    const doc = pipWindow.document;
    doc.title = '悬浮播放器';
    doc.head.innerHTML = '<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">';
    const style = doc.createElement('style');
    style.textContent = floatingCss();
    doc.head.appendChild(style);
    doc.body.innerHTML = floatingHtml();
    nodes = {
      root: doc.getElementById('float-player'),
      disc: doc.getElementById('fp-disc'),
      cover: doc.getElementById('fp-cover'),
      song: doc.getElementById('fp-song'),
      artist: doc.getElementById('fp-artist'),
      lyric: doc.getElementById('fp-lyric'),
      source: doc.getElementById('fp-source'),
      state: doc.getElementById('fp-state'),
      progress: doc.getElementById('fp-progress'),
      progressBar: doc.getElementById('fp-progress-bar'),
      time: doc.getElementById('fp-time'),
      btnPrev: doc.getElementById('fp-prev'),
      btnPlay: doc.getElementById('fp-play'),
      btnNext: doc.getElementById('fp-next'),
      btnLevel: doc.getElementById('fp-level'),
      btnMin: doc.getElementById('fp-min'),
      queue: doc.getElementById('fp-queue'),
      chatOpen: doc.getElementById('fp-chat-open'),
      chatPanel: doc.getElementById('fp-chat-panel'),
      chatClose: doc.getElementById('fp-chat-close'),
      messages: doc.getElementById('fp-messages'),
      input: doc.getElementById('fp-input'),
      send: doc.getElementById('fp-send'),
      modeSong: doc.getElementById('fp-mode-song'),
      modeChat: doc.getElementById('fp-mode-chat'),
    };

    nodes.disc.addEventListener('click', advanceLevel);
    nodes.btnLevel.addEventListener('click', advanceLevel);
    nodes.btnPrev.addEventListener('click', () => player.requestPrev());
    nodes.btnPlay.addEventListener('click', () => player.toggle());
    nodes.btnNext.addEventListener('click', () => player.requestNext('manual'));
    nodes.progress.addEventListener('click', seek);
    nodes.btnMin.addEventListener('click', () => setLevel(LEVEL.DISC));
    nodes.chatOpen.addEventListener('click', openChatPanel);
    nodes.chatClose.addEventListener('click', closeChatPanel);
    nodes.modeSong.addEventListener('click', () => setMode('song'));
    nodes.modeChat.addEventListener('click', () => setMode('chat'));
    nodes.send.addEventListener('click', submit);
    nodes.input.addEventListener('keydown', event => {
      if (event.key === 'Enter') submit();
    });
    nodes.queue.addEventListener('click', event => {
      const item = event.target.closest('[data-idx]');
      const idx = Number(item?.dataset.idx);
      if (Number.isFinite(idx)) player.requestPlayIdx(idx);
    });
    pipWindow.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      if (chatOpen) closeChatPanel();
      else if (level !== LEVEL.DISC) setLevel(LEVEL.DISC);
    });

    applyLevel(false);
  }

  function bindAudio() {
    for (const [event, handler] of Object.entries(audioHandlers)) {
      player.audio.addEventListener(event, handler);
    }
  }

  function unbindAudio() {
    for (const [event, handler] of Object.entries(audioHandlers)) {
      player.audio.removeEventListener(event, handler);
    }
  }

  function close() {
    unbindAudio();
    stopLyrics();
    stopLyrics = () => {};
    pipWindow = null;
    nodes = {};
    setButtonActive(false);
    onFloatingChange(false);
  }

  function advanceLevel() {
    if (level === LEVEL.DISC) setLevel(LEVEL.PLAYER);
    else if (level === LEVEL.PLAYER) setLevel(LEVEL.QUEUE);
    else setLevel(LEVEL.DISC);
  }

  function setLevel(next) {
    level = next;
    chatOpen = level === LEVEL.QUEUE;
    applyLevel(true);
    renderQueue();
    updateChatPanel();
  }

  function applyLevel(shouldResize) {
    if (!isOpen()) return;
    nodes.root.classList.remove('level-disc', 'level-player', 'level-queue');
    nodes.root.classList.add(`level-${level}`);
    nodes.root.dataset.level = level;
    nodes.btnLevel.textContent = level === LEVEL.PLAYER ? '队列' : '圆盘';
    nodes.btnLevel.setAttribute('aria-label', level === LEVEL.PLAYER ? 'open queue' : 'collapse to disc');
    nodes.disc.setAttribute('aria-label', level === LEVEL.DISC ? '打开播放器' : level === LEVEL.PLAYER ? '打开节目队列' : '收起为圆盘');
    if (shouldResize) resizeForLevel(level);
  }

  function resizeForLevel(next) {
    if (!pipWindow?.resizeTo) return;
    const size = SIZES[next] || SIZES[LEVEL.DISC];
    try {
      pipWindow.resizeTo(size.width, size.height);
    } catch {}
  }

  function openChatPanel() {
    if (level !== LEVEL.QUEUE) setLevel(LEVEL.QUEUE);
    chatOpen = true;
    updateChatPanel();
    nodes.input?.focus();
  }

  function closeChatPanel() {
    chatOpen = false;
    updateChatPanel();
  }

  function updateChatPanel() {
    if (!isOpen()) return;
    nodes.chatPanel.hidden = !chatOpen || level !== LEVEL.QUEUE;
    nodes.root.classList.toggle('chat-open', chatOpen && level === LEVEL.QUEUE);
    nodes.chatOpen.textContent = chatOpen ? '收起对话' : '聊天 / 点歌';
    nodes.chatOpen.setAttribute('aria-expanded', chatOpen ? 'true' : 'false');
  }

  function submit() {
    const message = nodes.input.value.trim();
    if (!message) return;
    nodes.input.value = '';
    addMessage('user', message);
    addMessage('ai', 'anjiu 正在听你说', { typing: true });
    sendMessage(message, { mode: inputMode })
      .catch(error => {
        clearTyping();
        addMessage('ai', '信号断了一下，稍后再试。');
        console.error(error);
      });
  }

  function handlePayload(data) {
    if (!isOpen()) return;
    clearTyping();
    if (data?.say) addMessage('ai', data.say);
    renderAll();
  }

  function addAi(text) {
    if (!isOpen() || !text) return;
    clearTyping();
    addMessage('ai', text);
  }

  function renderAll() {
    if (!isOpen()) return;
    renderSong();
    renderQueue();
    updatePlayback();
    updateProgress();
    setMode(inputMode);
    applyLevel(false);
    updateChatPanel();
  }

  function renderSong() {
    const song = player.currentSong;
    nodes.song.textContent = song?.name || '—';
    nodes.artist.textContent = song?.artist || '';
    nodes.source.textContent = sourceLabel(song || {}) || 'LOCAL SIGNAL';
    nodes.cover.innerHTML = song?.cover ? `<img src="${escapeAttr(song.cover)}" alt="">` : '♪';
  }

  function renderQueue() {
    if (!isOpen()) return;
    const start = Math.max(0, player.idx);
    const rows = player.queue.slice(start, start + 11);
    if (!rows.length) {
      nodes.queue.innerHTML = '<div class="fp-empty">AWAITING SIGNAL</div>';
      return;
    }
    nodes.queue.innerHTML = rows.map((song, offset) => {
      const index = start + offset;
      const active = index === player.idx;
      const label = sourceLabel(song);
      const cover = song.cover ? `<img src="${escapeAttr(song.cover)}" alt="">` : '♪';
      return `
        <button class="fp-q ${active ? 'active' : ''}" type="button" data-idx="${index}">
          <span class="fp-q-cover">${cover}</span>
          <span class="fp-q-main">
            <span class="fp-q-name">${escapeHtml(song.name || '')}</span>
            <span class="fp-q-artist">${escapeHtml(song.artist || '')}</span>
            ${label ? `<span class="fp-q-source">${escapeHtml(label)}</span>` : ''}
          </span>
        </button>`;
    }).join('');
  }

  function updatePlayback() {
    if (!isOpen()) return;
    const playing = !player.audio.paused;
    nodes.btnPlay.textContent = playing ? '⏸' : '▶';
    nodes.state.textContent = player.currentSong?.name || (player.tts ? 'TTS' : (playing ? 'LIVE' : 'IDLE'));
    nodes.root.classList.toggle('playing', playing);
  }

  function updateProgress() {
    if (!isOpen()) return;
    const duration = Number.isFinite(player.audio.duration) ? player.audio.duration : 0;
    const current = Number.isFinite(player.audio.currentTime) ? player.audio.currentTime : 0;
    nodes.progressBar.style.width = duration ? `${current / duration * 100}%` : '0%';
    nodes.time.textContent = `${formatTime(current)} / ${formatTime(duration)}`;
  }

  function seek(event) {
    const duration = player.audio.duration;
    if (!duration) return;
    const rect = event.currentTarget.getBoundingClientRect();
    player.audio.currentTime = (event.clientX - rect.left) / rect.width * duration;
  }

  function setMode(mode) {
    inputMode = mode === 'song' ? 'song' : 'chat';
    if (!isOpen()) return;
    nodes.modeSong.classList.toggle('active', inputMode === 'song');
    nodes.modeChat.classList.toggle('active', inputMode === 'chat');
    nodes.modeSong.setAttribute('aria-pressed', inputMode === 'song' ? 'true' : 'false');
    nodes.modeChat.setAttribute('aria-pressed', inputMode === 'chat' ? 'true' : 'false');
    nodes.input.placeholder = inputMode === 'song'
      ? '说你想听什么_'
      : '聊聊当前这首歌_';
  }

  function restartLyrics(song) {
    stopLyrics();
    stopLyrics = () => {};
    if (!isOpen()) return;
    nodes.lyric.textContent = '';
    stopLyrics = syncLyrics(player.audio, song?.lyric || '', text => {
      if (nodes.lyric) nodes.lyric.textContent = text;
    });
  }

  function addMessage(role, text, { typing = false } = {}) {
    if (!nodes.messages) return;
    const item = pipWindow.document.createElement('div');
    item.className = `fp-msg ${role}`;
    if (typing) item.dataset.typing = '1';
    item.textContent = text;
    nodes.messages.appendChild(item);
    while (nodes.messages.children.length > 5) nodes.messages.firstElementChild.remove();
    nodes.messages.scrollTop = nodes.messages.scrollHeight;
  }

  function clearTyping() {
    nodes.messages?.querySelector('[data-typing]')?.remove();
  }

  function setButtonActive(active) {
    button?.classList.toggle('active', active);
    button?.setAttribute('aria-pressed', active ? 'true' : 'false');
  }

  function isOpen() {
    return Boolean(pipWindow && !pipWindow.closed && nodes.root);
  }

  return {
    open,
    isOpen,
    handlePayload,
    addAi,
  };
}

function canUseDocumentPip() {
  return Boolean(window.documentPictureInPicture?.requestWindow);
}

function floatingHtml() {
  return `
    <section id="float-player" class="level-disc">
      <div class="fp-mini">
        <button id="fp-min" class="fp-min" type="button" aria-label="最小化为圆盘">−</button>
        <button id="fp-disc" class="fp-disc" type="button" aria-label="打开播放器">
          <span class="fp-record">
            <span class="fp-grooves"></span>
            <span id="fp-cover" class="fp-cover">♪</span>
          </span>
          <span id="fp-state" class="fp-state">IDLE</span>
        </button>

        <div class="fp-main">
          <div class="fp-topline">
            <span id="fp-source">LOCAL SIGNAL</span>
          </div>
          <div id="fp-song">—</div>
          <div id="fp-artist"></div>
          <div id="fp-lyric"></div>
          <div id="fp-progress"><div id="fp-progress-bar"></div></div>
          <div class="fp-controls">
            <button id="fp-prev" type="button" aria-label="previous">⟨⟨</button>
            <button id="fp-play" type="button" aria-label="play">▶</button>
            <button id="fp-next" type="button" aria-label="next">⟩⟩</button>
            <span id="fp-time">0:00 / 0:00</span>
            <button id="fp-level" class="fp-level" type="button">队列</button>
          </div>
        </div>
      </div>

      <div class="fp-full">
        <div class="fp-section-row">
          <div>
            <div class="fp-section-title">节目队列</div>
            <div class="fp-section-sub">NEXT 10</div>
          </div>
          <button id="fp-chat-open" type="button" aria-expanded="false">聊天 / 点歌</button>
        </div>
        <div id="fp-queue"></div>
      </div>

      <div id="fp-chat-panel" class="fp-chat-panel" hidden>
        <div class="fp-chat-head">
          <div>anjiu</div>
          <button id="fp-chat-close" type="button" aria-label="close chat">关闭</button>
        </div>
        <div class="fp-mode">
          <button id="fp-mode-song" type="button">点歌 · 会切歌</button>
          <button id="fp-mode-chat" type="button">聊天 · 不动播放</button>
        </div>
        <div id="fp-messages"></div>
        <div class="fp-input-row">
          <input id="fp-input" type="text" autocomplete="off" spellcheck="false">
          <button id="fp-send" type="button">SEND</button>
        </div>
      </div>
    </section>`;
}

function floatingCss() {
  return `
    *{box-sizing:border-box;margin:0;padding:0}
    html,body{width:100%;height:100%;overflow:hidden;background:#050608;color:#f4f6f8;font-family:Inter,"Noto Sans SC",system-ui,sans-serif}
    button,input{font:inherit}
    button{border:0;background:none;color:inherit;cursor:pointer}
    img{display:block;width:100%;height:100%;object-fit:cover}
    #float-player{position:relative;height:100vh;overflow:hidden;color:#f4f6f8}
    #float-player.level-disc{display:flex;align-items:center;justify-content:center;background:transparent;border:0;padding:0;border-radius:50%}
    #float-player.level-player,#float-player.level-queue{display:grid;grid-template-rows:auto minmax(0,1fr);gap:10px;padding:10px;background:linear-gradient(180deg,rgba(23,28,33,.96),rgba(13,16,20,.96));border:1px solid rgba(255,255,255,.08)}
    #float-player.level-queue.chat-open{grid-template-rows:auto minmax(0,1fr) minmax(218px,250px)}

    .fp-mini{position:relative;width:100%;min-width:0;display:grid;gap:10px}
    .level-disc .fp-mini{height:100%;grid-template-columns:1fr;place-items:center}
    .level-player .fp-mini,.level-queue .fp-mini{grid-template-columns:92px minmax(0,1fr);align-items:center}

    .fp-disc{position:relative;width:min(150px,calc(100vmin - 12px));aspect-ratio:1;border-radius:50%;display:grid;place-items:center;outline:none}
    .level-player .fp-disc,.level-queue .fp-disc{width:92px}
    .fp-disc::before{content:'';position:absolute;inset:-3px;border-radius:50%;background:radial-gradient(circle,rgba(255,255,255,.07) 0 62%,rgba(255,255,255,.03) 63% 100%);box-shadow:0 0 0 1px rgba(255,255,255,.08),0 0 28px rgba(0,0,0,.35)}
    .fp-disc::after{content:'';position:absolute;inset:10px;border-radius:50%;background:repeating-radial-gradient(circle,rgba(255,255,255,.09) 0 1px,transparent 1px 7px);opacity:.72}
    .fp-disc:focus-visible{outline:2px solid rgba(209,215,221,.7);outline-offset:3px}
    .fp-record{position:absolute;inset:19px;border-radius:50%;overflow:hidden;background:#191c20;display:grid;place-items:center;transition:transform .18s cubic-bezier(.4,0,.2,1)}
    .level-player .fp-record,.level-queue .fp-record{inset:12px}
    #float-player.playing .fp-record{animation:spin 18s linear infinite}
    .fp-grooves{position:absolute;inset:0;border-radius:50%;background:radial-gradient(circle at center,rgba(255,255,255,.04) 0 13%,transparent 13.5% 100%),repeating-radial-gradient(circle,rgba(255,255,255,.12) 0 1px,transparent 1px 10px)}
    .fp-cover{position:absolute;inset:24px;border-radius:50%;overflow:hidden;display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,.04);color:rgba(255,255,255,.2);font-size:26px;z-index:1}
    .level-player .fp-cover,.level-queue .fp-cover{inset:16px;font-size:18px}
    .fp-state{position:absolute;bottom:12px;left:50%;transform:translateX(-50%);z-index:2;max-width:74%;padding:3px 7px;border-radius:999px;background:rgba(0,0,0,.48);font-size:10px;color:#d1d7dd;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .level-player .fp-state,.level-queue .fp-state{bottom:5px;max-width:76%;font-size:8px}

    .fp-main{display:none;min-width:0;flex-direction:column;justify-content:center;gap:6px}
    .level-player .fp-main,.level-queue .fp-main{display:flex}
    .level-player .fp-mini{grid-row:1 / -1;height:100%}
    .level-player .fp-main{display:grid;grid-template-rows:auto auto auto minmax(58px,1fr) auto auto;align-content:stretch;height:100%}
    .fp-min{display:none;position:absolute;right:0;top:0;z-index:4;width:26px;height:26px;border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.055);color:#d1d7dd;font-size:18px;line-height:1}
    .level-player .fp-min,.level-queue .fp-min{display:block}
    .fp-topline{display:flex;align-items:center;gap:6px;min-width:0;color:#a6afb8;font-size:9px;letter-spacing:.12em}
    #fp-source{max-width:190px;padding:3px 5px;background:rgba(255,255,255,.045);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    #fp-song{font-size:18px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    #fp-artist,#fp-lyric,#fp-time{color:#a6afb8;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    #fp-lyric{min-height:15px;color:rgba(244,246,248,.72)}
    .level-player #fp-lyric{align-self:center;justify-self:center;width:100%;height:52px;display:flex;align-items:center;justify-content:center;text-align:center;font-size:15px;line-height:1.45;color:rgba(244,246,248,.84);white-space:normal;overflow:hidden;text-overflow:clip}
    #fp-progress{height:3px;background:rgba(255,255,255,.12);cursor:pointer}
    #fp-progress-bar{height:100%;width:0;background:#d1d7dd}
    .fp-controls{display:grid;grid-template-columns:30px 36px 30px minmax(0,1fr) 44px;gap:6px;align-items:center}
    .fp-controls button,.fp-mode button,#fp-send,#fp-chat-open,#fp-chat-close{height:28px;border:1px solid rgba(255,255,255,.09);background:rgba(255,255,255,.04);color:#d1d7dd}
    .fp-level{font-size:11px}

    .fp-full{display:none;min-height:0}
    .level-queue .fp-full{display:grid;grid-template-rows:auto minmax(0,1fr);gap:10px}
    .fp-section-row{display:flex;align-items:center;justify-content:space-between;gap:10px}
    .fp-section-title{color:#f4f6f8;font-size:13px;font-weight:500}
    .fp-section-sub{margin-top:2px;color:#a6afb8;font-size:9px;letter-spacing:.14em}
    #fp-chat-open{padding:0 9px;font-size:11px;white-space:nowrap}
    #fp-queue{min-height:0;overflow:auto;display:flex;flex-direction:column;gap:6px}
    .fp-q{width:100%;min-width:0;display:grid;grid-template-columns:38px minmax(0,1fr);gap:8px;padding:6px;border:1px solid transparent;text-align:left;background:rgba(255,255,255,.025)}
    .fp-q.active{border-color:rgba(152,163,175,.32);background:rgba(152,163,175,.1)}
    .fp-q-cover{width:38px;height:38px;display:flex;align-items:center;justify-content:center;overflow:hidden;background:rgba(255,255,255,.05);color:rgba(255,255,255,.2)}
    .fp-q-main{min-width:0;display:block}
    .fp-q-name,.fp-q-artist,.fp-q-source{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .fp-q-name{font-size:12px;color:#f4f6f8}
    .fp-q-artist{margin-top:2px;font-size:10px;color:#a6afb8}
    .fp-q-source{width:max-content;max-width:100%;margin-top:3px;padding:1px 4px;background:rgba(255,255,255,.05);font-size:9px;color:rgba(244,246,248,.7)}

    .fp-chat-panel{display:grid;grid-template-rows:auto auto minmax(60px,1fr) auto;gap:10px;min-height:0;padding:12px;background:rgba(9,12,16,.98);border:1px solid rgba(255,255,255,.10);box-shadow:0 18px 48px rgba(0,0,0,.22)}
    .fp-chat-panel[hidden]{display:none}
    .fp-chat-head{display:flex;align-items:center;justify-content:space-between;color:#f4f6f8;font-size:13px}
    #fp-chat-close{height:24px;padding:0 8px;font-size:10px}
    .fp-mode{display:grid;grid-template-columns:1fr 1fr;gap:8px}
    .fp-mode button{font-size:11px;color:#a6afb8}
    .fp-mode button.active{border-color:rgba(152,163,175,.34);color:#f4f6f8;background:rgba(152,163,175,.12)}
    #fp-messages{min-height:0;overflow:auto;display:flex;flex-direction:column;gap:6px}
    .fp-msg{max-width:92%;padding:6px 8px;background:rgba(255,255,255,.045);font-size:12px;line-height:1.35;color:#a6afb8}
    .fp-msg.user{align-self:flex-end;color:#f4f6f8}
    .fp-input-row{display:grid;grid-template-columns:minmax(0,1fr)64px;gap:8px}
    #fp-input{height:34px;min-width:0;border:1px solid rgba(255,255,255,.09);outline:none;background:rgba(255,255,255,.04);color:#f4f6f8;padding:0 9px}
    #fp-send{height:34px;font-size:10px;letter-spacing:.12em}
    .fp-empty{padding:18px 0;text-align:center;color:rgba(166,175,184,.6);font-size:11px}
    @keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
  `;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function escapeAttr(s) {
  return escapeHtml(s);
}

function formatTime(seconds) {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  const mins = Math.floor(value / 60);
  const secs = String(value % 60).padStart(2, '0');
  return `${mins}:${secs}`;
}
