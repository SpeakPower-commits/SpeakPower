/**
 * The multi-track timeline: V8 at the top down to V1 (the main video), then
 * the four audio tracks. Laid out in time on the FINISHED video.
 *
 *   click or drag on empty space  -> move the playhead (scrub)
 *   drag a clip                   -> move it in time, or up and down to another track
 *   drag a clip's edge            -> trim it
 *   click a track's name          -> hide it (video) or mute it (audio)
 *
 * Clips snap to the playhead, to each other and to the main video's joins, so
 * lining a cutaway up with a cut takes no steady hand.
 */

import { formatTime, joinTimes, keptRanges, outputDuration } from './project.js';
import {
  AUDIO_TRACKS, JOIN_TRANSITIONS, MAIN_TRACK, VIDEO_TRACKS, clipEnd, clipLength, isAudioTrack,
  mediaOf, moveClip, timelineDuration, trackLabel, tracksFor, trimClipEnd, trimClipStart,
} from './tracks.js';

export const LANES = [...VIDEO_TRACKS.slice().reverse(), MAIN_TRACK, ...AUDIO_TRACKS];
const SNAP_PX = 8;
const CLICK_PX = 3;
const TICK_STEPS = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200];
const MIN_TICK_PX = 64;

export class TrackTimeline {
  /**
   * @param root   the container element
   * @param hooks  { onSeek(time), onSelect(clipId|null), onChange(kind), onToggleTrack(track) }
   */
  constructor(root, hooks) {
    this.root = root;
    this.hooks = hooks;
    this.project = null;
    this.selected = null;
    this.time = 0;
    this.zoom = 0; // 2^zoom times the fit-to-width scale

    root.innerHTML = `
      <div class="mt-heads">
        <div class="mt-corner"></div>
        ${LANES.map((lane) => `
          <div class="mt-head${lane === MAIN_TRACK ? ' is-main' : ''}${isAudioTrack(lane) ? ' is-audio' : ''}">
            <button type="button" class="mt-toggle" data-track="${lane}" aria-pressed="false"
              title="${isAudioTrack(lane) ? 'Mute' : 'Hide'} ${trackLabel(lane)}">${trackLabel(lane)}</button>
          </div>`).join('')}
      </div>
      <div class="mt-scroll">
        <div class="mt-canvas">
          <div class="mt-ruler"></div>
          <div class="mt-lanes">
            ${LANES.map((lane) => `<div class="mt-lane${lane === MAIN_TRACK ? ' is-main' : ''}${isAudioTrack(lane) ? ' is-audio' : ''}" data-track="${lane}"></div>`).join('')}
          </div>
          <div class="mt-playhead"></div>
        </div>
      </div>`;

    this.scroll = root.querySelector('.mt-scroll');
    this.canvas = root.querySelector('.mt-canvas');
    this.ruler = root.querySelector('.mt-ruler');
    this.lanesBox = root.querySelector('.mt-lanes');
    this.lanes = Object.fromEntries([...root.querySelectorAll('.mt-lane')].map((lane) => [lane.dataset.track, lane]));
    this.playhead = root.querySelector('.mt-playhead');

    root.querySelectorAll('.mt-toggle').forEach((button) => {
      button.addEventListener('click', () => this.hooks.onToggleTrack?.(button.dataset.track));
    });
    // Focusable, and focused on click, so Space, S and Delete act on the
    // timeline rather than on whichever field was last used.
    root.tabIndex = 0;
    this.bindPointer(this.lanesBox);
    this.bindPointer(this.ruler);
    new ResizeObserver(() => this.render()).observe(this.scroll);
  }

  // --- Scale ------------------------------------------------------------------

  /** Seconds shown: the edit plus room to drag past its end (outros, music tails). */
  span() {
    const length = this.project ? timelineDuration(this.project) : 0;
    return Math.max(10, length * 1.08 + 2);
  }

  pixelsPerSecond() {
    const width = Math.max(200, this.scroll.clientWidth - 12);
    return (width / this.span()) * 2 ** this.zoom;
  }

  timeAt(clientX) {
    const rect = this.canvas.getBoundingClientRect();
    return Math.max(0, (clientX - rect.left) / this.pps);
  }

  laneAt(clientY) {
    return LANES.find((lane) => {
      const rect = this.lanes[lane].getBoundingClientRect();
      return clientY >= rect.top && clientY < rect.bottom;
    }) || null;
  }

  setZoom(zoom) {
    this.zoom = zoom;
    this.render();
    this.reveal(this.time);
  }

  // --- Snapping -------------------------------------------------------------------

  snapPoints(ignore) {
    const project = this.project;
    const points = [0, this.time, outputDuration(project), ...joinTimes(project)];
    for (const clip of project.clips) {
      if (clip === ignore) continue;
      points.push(clip.start, clipEnd(clip));
    }
    return points;
  }

  /** The nearest snap point to a time, if one is within reach on screen. */
  snap(time, ignore) {
    const reach = SNAP_PX / this.pps;
    let best = time;
    let distance = reach;
    for (const point of this.snapPoints(ignore)) {
      const gap = Math.abs(point - time);
      if (gap < distance) { distance = gap; best = point; }
    }
    return best;
  }

  /** Snap a moving clip by whichever of its edges is closest to a snap point. */
  snapMove(start, clip) {
    const length = clipLength(clip);
    const byStart = this.snap(start, clip);
    const byEnd = this.snap(start + length, clip) - length;
    const startGap = Math.abs(byStart - start);
    const endGap = Math.abs(byEnd - start);
    if (startGap === 0 && endGap === 0) return start;
    if (startGap === 0) return byEnd;
    if (endGap === 0) return byStart;
    return startGap <= endGap ? byStart : byEnd;
  }

  // --- Pointer ----------------------------------------------------------------------

  bindPointer(area) {
    let drag = null;

    area.addEventListener('pointerdown', (event) => {
      if (!this.project || event.button !== 0) return;
      const time = this.timeAt(event.clientX);
      const element = event.target.closest('.mt-clip');
      const clip = element && this.project.clips.find((item) => item.id === element.dataset.id);
      if (clip) {
        const edge = event.target.closest('.mt-edge');
        drag = {
          mode: edge ? (edge.classList.contains('is-left') ? 'start' : 'end') : 'move',
          clip,
          grab: time - clip.start,
          x: event.clientX,
          y: event.clientY,
          changed: false,
        };
        this.hooks.onSelect?.(clip.id);
      } else {
        drag = { mode: 'seek' };
        if (area === this.lanesBox) this.hooks.onSelect?.(null);
        this.hooks.onSeek?.(time);
      }
      area.setPointerCapture(event.pointerId);
      event.preventDefault();
      this.root.focus({ preventScroll: true });
    });

    area.addEventListener('pointermove', (event) => {
      if (!drag) return;
      const project = this.project;
      const time = this.timeAt(event.clientX);
      if (drag.mode === 'seek') {
        this.hooks.onSeek?.(time);
        return;
      }
      if (!drag.changed && Math.abs(event.clientX - drag.x) < CLICK_PX && Math.abs(event.clientY - drag.y) < CLICK_PX) return;

      const { clip } = drag;
      let changed = false;
      if (drag.mode === 'move') {
        const lane = this.laneAt(event.clientY);
        const track = lane && tracksFor(clip.kind).includes(lane) ? lane : clip.track;
        const start = this.snapMove(time - drag.grab, clip);
        changed = moveClip(project, clip, start, track) || moveClip(project, clip, start, clip.track);
      } else if (drag.mode === 'start') {
        changed = trimClipStart(project, clip, this.snap(time, clip));
      } else {
        changed = trimClipEnd(project, clip, this.snap(time, clip), mediaOf(project, clip)?.duration ?? Infinity);
      }
      if (changed) {
        drag.changed = true;
        this.hooks.onChange?.('drag');
      }
    });

    const finish = () => {
      if (drag?.changed) this.hooks.onChange?.('commit');
      drag = null;
    };
    area.addEventListener('pointerup', finish);
    area.addEventListener('pointercancel', finish);
  }

  // --- Drawing ------------------------------------------------------------------------

  setProject(project) {
    this.project = project;
    this.selected = null;
    this.render();
  }

  select(id) {
    this.selected = id;
    for (const element of this.lanesBox.querySelectorAll('.mt-clip')) {
      element.classList.toggle('is-selected', element.dataset.id === id);
    }
  }

  setTime(time, follow = false) {
    this.time = time;
    if (!this.pps) return;
    this.playhead.style.transform = `translateX(${time * this.pps}px)`;
    if (follow) this.reveal(time);
  }

  /** Scroll so a time is in view, as playback runs off the right edge. */
  reveal(time) {
    const x = time * this.pps;
    const { scrollLeft, clientWidth } = this.scroll;
    if (x < scrollLeft || x > scrollLeft + clientWidth - 24) this.scroll.scrollLeft = Math.max(0, x - 40);
  }

  renderRuler(span) {
    const step = TICK_STEPS.find((candidate) => candidate * this.pps >= MIN_TICK_PX) || TICK_STEPS[TICK_STEPS.length - 1];
    const ticks = [];
    for (let time = 0; time <= span; time += step) {
      const tick = document.createElement('span');
      tick.className = 'mt-tick';
      tick.style.left = `${time * this.pps}px`;
      tick.textContent = step < 1 ? formatTime(time) : formatTime(time, false);
      ticks.push(tick);
    }
    this.ruler.replaceChildren(...ticks);
  }

  renderMain() {
    const project = this.project;
    const lane = this.lanes[MAIN_TRACK];
    const parts = [];
    let elapsed = 0;
    keptRanges(project).forEach((range, index) => {
      const length = range.end - range.start;
      const block = document.createElement('div');
      block.className = 'mt-main';
      block.style.left = `${elapsed * this.pps}px`;
      block.style.width = `${Math.max(2, length * this.pps)}px`;
      block.title = `Main video ${formatTime(range.start)} – ${formatTime(range.end)}`;
      block.innerHTML = `<span class="mt-clip-name">${index === 0 ? 'Main video' : ''}</span>`;
      parts.push(block);
      elapsed += length;
    });
    for (const join of joinTimes(project)) {
      const marker = document.createElement('div');
      marker.className = `mt-join is-${project.joinTransition}`;
      marker.style.left = `${join * this.pps}px`;
      marker.title = JOIN_TRANSITIONS[project.joinTransition];
      parts.push(marker);
    }
    lane.replaceChildren(...parts);
  }

  renderClip(clip) {
    const project = this.project;
    const media = mediaOf(project, clip);
    const element = document.createElement('div');
    element.className = `mt-clip kind-${clip.kind}${clip.id === this.selected ? ' is-selected' : ''}`;
    element.dataset.id = clip.id;
    element.style.left = `${clip.start * this.pps}px`;
    element.style.width = `${Math.max(6, clipLength(clip) * this.pps)}px`;
    const fade = (type) => (type && type !== 'none' ? Math.min(clip.transitionDuration, clipLength(clip) / 2) * this.pps : 0);
    element.style.setProperty('--fade-in', `${fade(clip.transitionIn)}px`);
    element.style.setProperty('--fade-out', `${fade(clip.transitionOut)}px`);

    const drawnNames = { text: 'Title', card: 'Card', callout: 'Pop-up', progress: 'Progress bar' };
    const name = clip.kind in drawnNames
      ? (clip.title || clip.subtitle || drawnNames[clip.kind])
      : (media?.name || 'Missing file');
    const label = document.createElement('span');
    label.className = 'mt-clip-name';
    label.textContent = name;
    element.title = `${name} · ${formatTime(clip.start)} – ${formatTime(clipEnd(clip))}`;

    const left = document.createElement('div');
    left.className = 'mt-edge is-left';
    const right = document.createElement('div');
    right.className = 'mt-edge is-right';
    element.append(left, label, right);
    return element;
  }

  render() {
    const project = this.project;
    this.root.classList.toggle('is-empty', !project);
    if (!project) return;
    this.pps = this.pixelsPerSecond();
    const span = this.span();
    this.canvas.style.width = `${span * this.pps}px`;

    this.renderRuler(span);
    this.renderMain();
    for (const lane of LANES) {
      if (lane === MAIN_TRACK) continue;
      this.lanes[lane].replaceChildren(...project.clips.filter((clip) => clip.track === lane).map((clip) => this.renderClip(clip)));
    }
    this.root.querySelectorAll('.mt-toggle').forEach((button) => {
      const off = !!project.trackOff[button.dataset.track];
      button.setAttribute('aria-pressed', String(off));
      button.classList.toggle('is-off', off);
    });
    for (const lane of LANES) this.lanes[lane].classList.toggle('is-off', !!project.trackOff[lane]);
    this.setTime(this.time);
  }
}
