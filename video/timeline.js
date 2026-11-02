/**
 * The timeline under the preview.
 *
 *   drag a gold handle   -> trim the start or end
 *   drag across the bar  -> select a stretch (then "Remove selection")
 *   click the bar        -> jump there
 *
 * The handles are focusable and move with the arrow keys (Shift for bigger
 * steps), so trimming can be done precisely without a steady mouse hand.
 */

const CLICK_TOLERANCE_PX = 4;
const KEY_STEP = 0.1;
const KEY_STEP_LARGE = 1;

export class Timeline {
  constructor(root, { onSeek, onTrim, onSelect }) {
    this.root = root;
    this.onSeek = onSeek;
    this.onTrim = onTrim;
    this.onSelect = onSelect;
    this.project = null;
    this.selection = null;
    this.playhead = 0;

    root.innerHTML = `
      <div class="tl-track" data-role="track">
        <div class="tl-out tl-out-left"></div>
        <div class="tl-out tl-out-right"></div>
        <div class="tl-cuts"></div>
        <div class="tl-selection" hidden></div>
        <div class="tl-playhead"></div>
        <button class="tl-handle tl-handle-start" type="button" aria-label="Trim start"></button>
        <button class="tl-handle tl-handle-end" type="button" aria-label="Trim end"></button>
      </div>
      <div class="tl-scale"><span data-role="zero">0:00</span><span data-role="total">0:00</span></div>
    `;

    this.track = root.querySelector('[data-role="track"]');
    this.parts = {
      outLeft: root.querySelector('.tl-out-left'),
      outRight: root.querySelector('.tl-out-right'),
      cuts: root.querySelector('.tl-cuts'),
      selection: root.querySelector('.tl-selection'),
      playhead: root.querySelector('.tl-playhead'),
      start: root.querySelector('.tl-handle-start'),
      end: root.querySelector('.tl-handle-end'),
      total: root.querySelector('[data-role="total"]'),
    };

    this.bindPointer();
    this.bindKeys();
  }

  /** Seconds at a horizontal pixel position on the track. */
  timeAt(clientX) {
    const rect = this.track.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return fraction * (this.project?.duration || 0);
  }

  percent(time) {
    return `${(100 * time) / (this.project?.duration || 1)}%`;
  }

  bindPointer() {
    let drag = null;

    this.track.addEventListener('pointerdown', (event) => {
      if (!this.project || event.button !== 0) return;
      const handle = event.target.closest('.tl-handle');
      drag = {
        kind: handle ? (handle === this.parts.start ? 'start' : 'end') : 'select',
        startX: event.clientX,
        startTime: this.timeAt(event.clientX),
      };
      this.track.setPointerCapture(event.pointerId);
      event.preventDefault();
    });

    this.track.addEventListener('pointermove', (event) => {
      if (!drag) return;
      const time = this.timeAt(event.clientX);
      const { trim } = this.project;
      if (drag.kind === 'start') {
        this.onTrim(Math.min(time, trim.end - 0.1), trim.end);
      } else if (drag.kind === 'end') {
        this.onTrim(trim.start, Math.max(time, trim.start + 0.1));
      } else if (Math.abs(event.clientX - drag.startX) > CLICK_TOLERANCE_PX) {
        this.setSelection({ start: Math.min(drag.startTime, time), end: Math.max(drag.startTime, time) });
      }
    });

    const finish = (event) => {
      if (!drag) return;
      if (drag.kind === 'select' && Math.abs(event.clientX - drag.startX) <= CLICK_TOLERANCE_PX) {
        // A click, not a drag: jump there and clear any selection.
        this.setSelection(null);
        this.onSeek(drag.startTime);
      }
      drag = null;
    };
    this.track.addEventListener('pointerup', finish);
    this.track.addEventListener('pointercancel', finish);
  }

  bindKeys() {
    const nudge = (which) => (event) => {
      if (!this.project) return;
      const step = event.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
      const delta = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
      if (!delta) return;
      event.preventDefault();
      const { trim } = this.project;
      if (which === 'start') this.onTrim(Math.min(trim.start + delta, trim.end - 0.1), trim.end);
      else this.onTrim(trim.start, Math.max(trim.end + delta, trim.start + 0.1));
    };
    this.parts.start.addEventListener('keydown', nudge('start'));
    this.parts.end.addEventListener('keydown', nudge('end'));
  }

  setSelection(range) {
    this.selection = range && range.end - range.start >= 0.1 ? range : null;
    this.onSelect(this.selection);
    this.render();
  }

  setProject(project) {
    this.project = project;
    this.selection = null;
    this.render();
  }

  setPlayhead(time) {
    this.playhead = time;
    if (this.project) this.parts.playhead.style.left = this.percent(time);
  }

  render() {
    const project = this.project;
    this.root.classList.toggle('is-empty', !project);
    if (!project) return;

    const { trim, cuts, duration } = project;
    const { outLeft, outRight, start, end, selection, total } = this.parts;

    outLeft.style.width = this.percent(trim.start);
    outRight.style.left = this.percent(trim.end);
    outRight.style.width = this.percent(duration - trim.end);
    start.style.left = this.percent(trim.start);
    end.style.left = this.percent(trim.end);

    this.parts.cuts.replaceChildren(...cuts.map((cut) => {
      const block = document.createElement('div');
      block.className = 'tl-cut';
      block.style.left = this.percent(cut.start);
      block.style.width = this.percent(cut.end - cut.start);
      return block;
    }));

    if (this.selection) {
      selection.hidden = false;
      selection.style.left = this.percent(this.selection.start);
      selection.style.width = this.percent(this.selection.end - this.selection.start);
    } else {
      selection.hidden = true;
    }

    const minutes = Math.floor(duration / 60);
    total.textContent = `${minutes}:${String(Math.floor(duration % 60)).padStart(2, '0')}`;
    this.setPlayhead(this.playhead);
  }
}
