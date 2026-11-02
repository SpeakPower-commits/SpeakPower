/**
 * The edit, as data.
 *
 * An edit never touches the source file. It is a description -- trim points,
 * removed stretches, format and graphics -- that the preview plays back live
 * and the exporter renders once. Keeping it as plain data is what lets the
 * preview and the export agree exactly.
 *
 * Times are in seconds of the SOURCE video unless a name says otherwise.
 */

export const MIN_RANGE = 0.1; // anything shorter than this is noise from a click

export function createProject(file, duration, width, height) {
  return {
    file,
    duration,
    width,
    height,
    trim: { start: 0, end: duration },
    cuts: [],               // removed stretches inside the trim: [{start, end}]
    format: '9:16',
    framing: 'blur',
    headline: '',
    logo: 'none',           // off by default: client videos are not SpeakPower's
    captions: { enabled: true, segments: [] },
    // The main video is track V1. Everything layered over it -- b-roll,
    // pictures, titles, recordings, music -- lives in media and clips (see
    // tracks.js), placed in time on the finished video.
    joinTransition: 'cut',  // what happens where a removed part closes up
    mainVolume: 1,
    media: [],
    clips: [],
    trackOff: {},           // track id -> true when hidden (video) or muted (audio)
  };
}

/** Merge overlapping or touching ranges, sorted by start. */
export function mergeRanges(ranges) {
  const sorted = ranges
    .filter((range) => range.end - range.start >= MIN_RANGE)
    .map((range) => ({ start: range.start, end: range.end }))
    .sort((a, b) => a.start - b.start);
  const merged = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push(range);
    }
  }
  return merged;
}

/** Add a removed stretch, clipped to the trim and merged with its neighbours. */
export function addCut(project, start, end) {
  const lo = Math.max(project.trim.start, Math.min(start, end));
  const hi = Math.min(project.trim.end, Math.max(start, end));
  if (hi - lo < MIN_RANGE) return false;
  project.cuts = mergeRanges([...project.cuts, { start: lo, end: hi }]);
  return true;
}

export function removeCut(project, index) {
  project.cuts.splice(index, 1);
}

/** Move a trim point, keeping start before end and dropping cuts it swallows. */
export function setTrim(project, start, end) {
  const lo = Math.max(0, Math.min(start, project.duration));
  const hi = Math.max(0, Math.min(end, project.duration));
  if (hi - lo < MIN_RANGE) return false;
  project.trim = { start: lo, end: hi };
  project.cuts = mergeRanges(
    project.cuts.map((cut) => ({
      start: Math.max(cut.start, lo),
      end: Math.min(cut.end, hi),
    })),
  );
  return true;
}

/** The stretches that make it into the export, in order. */
export function keptRanges(project) {
  const kept = [];
  let cursor = project.trim.start;
  for (const cut of project.cuts) {
    if (cut.start > cursor) kept.push({ start: cursor, end: cut.start });
    cursor = Math.max(cursor, cut.end);
  }
  if (project.trim.end > cursor) kept.push({ start: cursor, end: project.trim.end });
  return kept.filter((range) => range.end - range.start >= MIN_RANGE / 10);
}

export function outputDuration(project) {
  return keptRanges(project).reduce((total, range) => total + (range.end - range.start), 0);
}

/**
 * Where should playback be, given a source time?
 *
 * Returns the source time itself if it is kept; otherwise the start of the next
 * kept stretch, or null when there is nothing left to play.
 */
export function nextPlayableTime(project, time) {
  for (const range of keptRanges(project)) {
    if (time < range.start) return range.start;
    if (time < range.end) return time;
  }
  return null;
}

/** Source time to position in the finished video. */
export function sourceToOutput(project, time) {
  let elapsed = 0;
  for (const range of keptRanges(project)) {
    if (time < range.start) return elapsed;
    if (time <= range.end) return elapsed + (time - range.start);
    elapsed += range.end - range.start;
  }
  return elapsed;
}

/**
 * Position in the finished video to source time in the main video, or null
 * once the main video has ended (layers can run on past it).
 */
export function outputToSource(project, time) {
  let elapsed = 0;
  for (const range of keptRanges(project)) {
    const length = range.end - range.start;
    if (time < elapsed + length) return range.start + Math.max(0, time - elapsed);
    elapsed += length;
  }
  return null;
}

/** Where the kept stretches meet in the finished video: one time per closed-up cut. */
export function joinTimes(project) {
  const joins = [];
  let elapsed = 0;
  const ranges = keptRanges(project);
  ranges.forEach((range, index) => {
    elapsed += range.end - range.start;
    if (index < ranges.length - 1) joins.push(elapsed);
  });
  return joins;
}

/**
 * 83.4 -> "1:23.4"
 *
 * Rounds to the nearest tenth before splitting into minutes and seconds, so
 * 12.9999 reads "0:13.0" rather than "0:12.9" -- a mouse-drawn cut lands a
 * hair either side of a round number, and truncating made it look wrong.
 */
export function formatTime(seconds, withTenths = true) {
  const safe = Math.max(0, seconds || 0);
  if (!withTenths) {
    const whole = Math.round(safe);
    return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
  }
  const tenths = Math.round(safe * 10);
  const minutes = Math.floor(tenths / 600);
  const rest = tenths - minutes * 600;
  return `${minutes}:${String(Math.floor(rest / 10)).padStart(2, '0')}.${rest % 10}`;
}
