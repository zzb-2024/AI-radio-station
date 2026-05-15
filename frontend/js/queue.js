/**
 * 右侧歌曲队列渲染。
 */

export class QueueView {
  /**
   * @param {HTMLElement} listEl
   * @param {(index:number)=>void} onPick
   * @param {{limit?: number|null}} options
   */
  constructor(listEl, onPick, options = {}) {
    this.listEl = listEl;
    this.onPick = onPick;
    this.limit = Number.isFinite(options.limit) ? Math.max(1, options.limit) : null;
    this.statusEl = null;
    this.queue = [];
    this.activeIdx = -1;

    listEl.addEventListener('click', e => {
      const item = e.target.closest('.qi');
      if (!item || item.classList.contains('locked')) return;
      const idx = parseInt(item.dataset.idx, 10);
      if (Number.isFinite(idx)) this.onPick(idx);
    });
  }

  attachStatus(statusEl) {
    this.statusEl = statusEl;
    this.updateStatus();
  }

  setQueue(queue) {
    this.queue = queue || [];
    this.render();
    this.updateStatus();
  }

  setActive(idx) {
    this.activeIdx = idx;
    this.render();
    this.updateStatus();
  }

  updateStatus() {
    if (!this.statusEl) return;
    const total = this.queue.length;
    const nextCount = Math.max(0, total - Math.max(this.activeIdx, -1) - 1);
    this.statusEl.textContent = total ? `NEXT ${Math.min(10, nextCount)} / ${total}` : 'NEXT 10';
  }

  render() {
    if (!this.queue.length) {
      this.listEl.innerHTML = '<div class="qi-empty">AWAITING SIGNAL…</div>';
      return;
    }
    const rows = this.visibleRows();
    this.listEl.innerHTML = rows.map(({ song: s, index: i }) => {
      const classes = ['qi'];
      if (i === this.activeIdx) classes.push('active');
      if (!s.url) classes.push('locked');
      const cover = s.cover
        ? `<img src="${escapeAttr(s.cover)}" loading="lazy" alt="">`
        : '♪';
      const badge = i === this.activeIdx ? '▶ NOW' : '·';
      const source = sourceLabel(s);
      return `
        <div class="${classes.join(' ')}" data-idx="${i}">
          <div class="qi-cover">${cover}</div>
          <div class="qi-info">
            <div class="qi-name">${escapeHtml(s.name || '')}</div>
            <div class="qi-artist">${escapeHtml(s.artist || '')}</div>
            <div class="qi-badge">${badge}</div>
            ${source ? `<div class="qi-source">${escapeHtml(source)}</div>` : ''}
          </div>
        </div>`;
    }).join('');
  }

  visibleRows() {
    const rows = this.queue.map((song, index) => ({ song, index }));
    if (!this.limit || rows.length <= this.limit) return rows;
    const start = Math.max(0, this.activeIdx);
    return rows.slice(start, start + this.limit);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

export function sourceLabel(song = {}) {
  if (song.toplist?.name) return song.toplist.name;
  const plan = song.musicPlan || {};
  if (plan.toplistName) return plan.toplistName;
  if (plan.genre && plan.scene) return `${plan.scene} · ${plan.genre}`;
  if (plan.genre) return plan.genre;
  if (plan.scene) return plan.scene;
  if (plan.mood) return plan.mood;
  const reason = String(song.requestReason || '').trim();
  if (reason === 'toplist') return '榜单';
  if (reason === 'direct') return '搜歌';
  if (reason === 'fallback') return '应急推荐';
  if (/skip|跳过|avoid/i.test(reason)) return '根据跳过修正';
  return reason ? reason.slice(0, 18) : '';
}
