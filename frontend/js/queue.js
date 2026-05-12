/**
 * 右侧歌曲队列渲染。
 */

export class QueueView {
  /**
   * @param {HTMLElement} listEl
   * @param {(index:number)=>void} onPick
   */
  constructor(listEl, onPick) {
    this.listEl = listEl;
    this.onPick = onPick;
    this.queue = [];
    this.activeIdx = -1;

    listEl.addEventListener('click', e => {
      const item = e.target.closest('.qi');
      if (!item || item.classList.contains('locked')) return;
      const idx = parseInt(item.dataset.idx, 10);
      if (Number.isFinite(idx)) this.onPick(idx);
    });
  }

  setQueue(queue) {
    this.queue = queue || [];
    this.render();
  }

  setActive(idx) {
    this.activeIdx = idx;
    this.render();
  }

  render() {
    if (!this.queue.length) {
      this.listEl.innerHTML = '<div class="qi-empty">AWAITING SIGNAL…</div>';
      return;
    }
    this.listEl.innerHTML = this.queue.map((s, i) => {
      const classes = ['qi'];
      if (i === this.activeIdx) classes.push('active');
      if (!s.url) classes.push('locked');
      const cover = s.cover
        ? `<img src="${escapeAttr(s.cover)}" loading="lazy" alt="">`
        : '♪';
      const badge = i === this.activeIdx ? '▶ NOW' : '·';
      return `
        <div class="${classes.join(' ')}" data-idx="${i}">
          <div class="qi-cover">${cover}</div>
          <div class="qi-info">
            <div class="qi-name">${escapeHtml(s.name || '')}</div>
            <div class="qi-artist">${escapeHtml(s.artist || '')}</div>
            <div class="qi-badge">${badge}</div>
          </div>
        </div>`;
    }).join('');
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }
