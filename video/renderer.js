/**
 * Draws one finished frame: the reframed video plus its graphics.
 *
 * The live preview and the exporter both call drawFrame(), so what the user
 * sees while editing is exactly what the export contains. Everything is laid
 * out relative to the canvas, which lets the preview run on a small canvas and
 * the export on a full 1080p one with identical proportions.
 */

import { drawCaptions } from './captions.js';
import { CAPTION_FONT, HEADLINE_FONT, wrapLines } from './text.js';
import { MAIN_TRACK, VIDEO_TRACKS, clipsOn, isActive, joinEffectAt, transitionAt } from './tracks.js';

export const FORMATS = {
  '9:16': { width: 1080, height: 1920, label: 'Vertical 9:16', use: 'Reels · TikTok · Shorts' },
  '1:1': { width: 1080, height: 1080, label: 'Square 1:1', use: 'Instagram · LinkedIn feed' },
  '16:9': { width: 1920, height: 1080, label: 'Widescreen 16:9', use: 'YouTube · presentations' },
};

// SpeakPower brand colours for on-video graphics. The gold is the brighter
// one from the GRIOT mark: the UI's softer gold disappears against footage.
const GOLD = '#E0BE55';
const NAVY_BAND = 'rgba(40, 49, 66, 0.84)';
const WHITE = '#FFFFFF';


// Per-format placement, as fractions of the frame. Vertical video keeps its
// graphics clear of the platform's own header and its caption/username area;
// the other formats have no such overlays to avoid.
// lowerThirdBottom keeps name titles clear of the captions beneath them.
const LAYOUT = {
  '9:16': { headlineTop: 0.208, captionBottom: 0.245, logoTop: 0.12, logoBesideHeadline: false, lowerThirdBottom: 0.37 },
  '1:1': { headlineTop: 0.085, captionBottom: 0.13, logoTop: 0.045, logoBesideHeadline: true, lowerThirdBottom: 0.31 },
  '16:9': { headlineTop: 0.075, captionBottom: 0.11, logoTop: 0.045, logoBesideHeadline: true, lowerThirdBottom: 0.30 },
};

/**
 * Fonts and the logo, loaded once. Fonts are bundled with the app rather than
 * relied on from the system: an office PC will not have Inter installed, and a
 * missing font would silently change the look of every export.
 */
let assetsPromise = null;

// Fonts and the badge sit beside this module, wherever the site is served from.
const HERE = new URL('.', import.meta.url).href.replace(/\/$/, '');

export function loadAssets(base = HERE) {
  // Shared by the editor and the automatic editor, so fonts register once.
  if (!assetsPromise) {
    assetsPromise = fetchAssets(base).catch((error) => {
      assetsPromise = null;
      throw error;
    });
  }
  return assetsPromise;
}

async function fetchAssets(base) {
  const faces = [
    new FontFace(HEADLINE_FONT, `url(${base}/fonts/Inter-ExtraBold.otf)`),
    new FontFace(CAPTION_FONT, `url(${base}/fonts/Inter-Black.otf)`),
  ];
  await Promise.all(faces.map(async (face) => {
    await face.load();
    document.fonts.add(face);
  }));

  const logo = new Image();
  logo.src = `${base}/brand/speakpower-badge.png`;
  await logo.decode();

  return { logos: { speakpower: logo } };
}

/** Scale (w, h) to fit (W, H): "cover" fills and crops, "contain" fits inside. */
function fit(sourceWidth, sourceHeight, width, height, mode) {
  const scale = mode === 'cover'
    ? Math.max(width / sourceWidth, height / sourceHeight)
    : Math.min(width / sourceWidth, height / sourceHeight);
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;
  return { x: (width - drawWidth) / 2, y: (height - drawHeight) / 2, width: drawWidth, height: drawHeight };
}

// Reused scratch canvas for the blurred background, so a long export does not
// allocate a new canvas per frame.
let blurCanvas = null;

function drawBlurredBackground(ctx, source, sourceWidth, sourceHeight, width, height, x = 0, y = 0) {
  // Blur a small copy and stretch it up. Blurring the full 1080x1920 frame
  // every frame is the single most expensive thing a canvas filter can do;
  // at 1/8 size the result is visually the same and many times cheaper.
  const smallWidth = Math.max(16, Math.round(width / 8));
  const smallHeight = Math.max(16, Math.round(height / 8));
  if (!blurCanvas || blurCanvas.width !== smallWidth || blurCanvas.height !== smallHeight) {
    blurCanvas = new OffscreenCanvas(smallWidth, smallHeight);
  }
  const small = blurCanvas.getContext('2d');
  const cover = fit(sourceWidth, sourceHeight, smallWidth, smallHeight, 'cover');
  small.filter = 'blur(3px) brightness(0.72)';
  small.drawImage(source, cover.x, cover.y, cover.width, cover.height);
  small.filter = 'none';

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(blurCanvas, x, y, width, height);
}

function roundedRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + width, y, x + width, y + height, radius);
  ctx.arcTo(x + width, y + height, x, y + height, radius);
  ctx.arcTo(x, y + height, x, y, radius);
  ctx.arcTo(x, y, x + width, y, radius);
  ctx.closePath();
}

function drawHeadline(ctx, text, width, height, unit, layout, logoReserve, alpha) {
  const fontSize = 60 * unit;
  const padX = 30 * unit;
  const padY = 18 * unit;
  const lineHeight = fontSize * 1.18;
  const side = 70 * unit + logoReserve;

  ctx.font = `${fontSize}px ${HEADLINE_FONT}`;
  const lines = wrapLines(ctx, text, width - 2 * side - 2 * padX).slice(0, 3);
  if (!lines.length) return;

  const textWidth = Math.max(...lines.map((line) => ctx.measureText(line).width));
  const boxWidth = textWidth + 2 * padX;
  const boxHeight = lines.length * lineHeight + 2 * padY;
  const boxX = (width - boxWidth) / 2;
  const boxY = height * layout.headlineTop;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = NAVY_BAND;
  roundedRect(ctx, boxX, boxY, boxWidth, boxHeight, 14 * unit);
  ctx.fill();

  ctx.fillStyle = WHITE;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  lines.forEach((line, index) => {
    ctx.fillText(line, width / 2, boxY + padY + lineHeight * (index + 0.5));
  });
  ctx.restore();
}

/** Draw a picture into a box: cropped to fill it, or whole over a blurred fill. */
function drawPicture(ctx, image, imageWidth, imageHeight, box, mode) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(box.x, box.y, box.width, box.height);
  ctx.clip();
  if (mode === 'contain') {
    drawBlurredBackground(ctx, image, imageWidth, imageHeight, box.width, box.height, box.x, box.y);
  }
  const placed = fit(imageWidth, imageHeight, box.width, box.height, mode);
  ctx.drawImage(image, box.x + placed.x, box.y + placed.y, placed.width, placed.height);
  ctx.restore();
}

/** The box a layer occupies for its layout. */
function layoutBox(layout, size, imageWidth, imageHeight, width, height, unit, frameLayout) {
  switch (layout) {
    case 'top': return { x: 0, y: 0, width, height: height / 2 };
    case 'bottom': return { x: 0, y: height / 2, width, height: height / 2 };
    case 'left': return { x: 0, y: 0, width: width / 2, height };
    case 'right': return { x: width / 2, y: 0, width: width / 2, height };
    case 'logo-tr': case 'logo-tl': case 'logo-br': case 'logo-bl': {
      // A logo or badge: small, whole, unframed, in a corner.
      const aspect = imageHeight / imageWidth || 1;
      let boxWidth = width * Math.min(0.4, Math.max(0.06, size || 0.14));
      let boxHeight = boxWidth * aspect;
      if (boxHeight > height * 0.18) {
        boxHeight = height * 0.18;
        boxWidth = boxHeight / aspect;
      }
      const margin = 40 * unit;
      const right = layout.endsWith('r');
      const top = layout.includes('-t');
      return {
        x: right ? width - boxWidth - margin : margin,
        y: top ? height * frameLayout.logoTop : height * (1 - frameLayout.captionBottom) - 230 * unit - boxHeight,
        width: boxWidth,
        height: boxHeight,
        plain: true,
      };
    }
    case 'pip-tr': case 'pip-tl': case 'pip-br': case 'pip-bl': {
      const aspect = imageHeight / imageWidth || 9 / 16;
      let boxWidth = width * Math.min(0.8, Math.max(0.15, size || 0.36));
      let boxHeight = boxWidth * aspect;
      // A tall or square picture is limited by height, so it never swamps the frame.
      const maxHeight = height * 0.45;
      if (boxHeight > maxHeight) {
        boxHeight = maxHeight;
        boxWidth = boxHeight / aspect;
      }
      const margin = 48 * unit;
      const right = layout.endsWith('r');
      const top = layout.includes('-t');
      // Bottom corners sit just above the captions; top corners below the platform's header.
      const bottomEdge = height * (1 - frameLayout.captionBottom) - 230 * unit;
      return {
        x: right ? width - boxWidth - margin : margin,
        y: top ? height * 0.1 : Math.max(height * 0.1, bottomEdge - boxHeight),
        width: boxWidth,
        height: boxHeight,
        corner: true,
      };
    }
    default: return { x: 0, y: 0, width, height };
  }
}

/** Apply a clip's transition around its drawing: fade, slide, zoom or wipe. */
function withTransition(ctx, transition, box, width, draw) {
  const { type, phase, p } = transition;
  if (p <= 0) return;
  ctx.save();
  if (type === 'fade') {
    ctx.globalAlpha *= p;
  } else if (type === 'slide') {
    // In from the right, out to the left.
    ctx.translate((phase === 'in' ? 1 : -1) * (1 - p) * width, 0);
  } else if (type === 'zoom') {
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const scale = 0.6 + 0.4 * p;
    ctx.translate(cx, cy);
    ctx.scale(scale, scale);
    ctx.translate(-cx, -cy);
    ctx.globalAlpha *= p;
  } else if (type === 'wipe') {
    ctx.beginPath();
    ctx.rect(box.x, box.y, box.width * p, box.height);
    ctx.clip();
  }
  draw();
  ctx.restore();
}

function drawLayer(ctx, clip, layer, time, width, height, unit, frameLayout) {
  const box = layoutBox(clip.layout, clip.size, layer.width, layer.height, width, height, unit, frameLayout);
  withTransition(ctx, transitionAt(clip, time), box, width, () => {
    if (box.corner) {
      // Picture-in-picture: a framed, rounded window with a soft shadow.
      const radius = 22 * unit;
      ctx.save();
      ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
      ctx.shadowBlur = 30 * unit;
      ctx.shadowOffsetY = 10 * unit;
      ctx.fillStyle = WHITE;
      roundedRect(ctx, box.x - 5 * unit, box.y - 5 * unit, box.width + 10 * unit, box.height + 10 * unit, radius + 5 * unit);
      ctx.fill();
      ctx.restore();
      ctx.save();
      roundedRect(ctx, box.x, box.y, box.width, box.height, radius);
      ctx.clip();
      drawPicture(ctx, layer.image, layer.width, layer.height, box, 'cover');
      ctx.restore();
    } else if (box.plain) {
      ctx.drawImage(layer.image, box.x, box.y, box.width, box.height);
    } else {
      drawPicture(ctx, layer.image, layer.width, layer.height, box, clip.layout === 'fit' ? 'contain' : 'cover');
    }
  });
}

/** Lines of text that fit a width, shrinking the font until they fit in maxLines. */
function fitText(ctx, text, font, size, maxWidth, maxLines) {
  let fontSize = size;
  let lines = [];
  for (let attempt = 0; attempt < 6; attempt += 1) {
    ctx.font = `${fontSize}px ${font}`;
    lines = wrapLines(ctx, text, maxWidth);
    if (lines.length <= maxLines) break;
    fontSize *= 0.88;
  }
  return { lines: lines.slice(0, maxLines), fontSize };
}

/**
 * Designed cards, drawn rather than imported:
 *   hook    -- the opening line of a short, big over a darkened frame
 *   chapter -- a titled panel marking a new part of an episode
 *   end     -- the closing card: logo and call to action on navy
 */
function drawCard(ctx, clip, time, width, height, unit, assets, project) {
  const title = (clip.title || '').trim();
  const subtitle = (clip.subtitle || '').trim();
  const box = { x: 0, y: 0, width, height };
  withTransition(ctx, transitionAt(clip, time), box, width, () => {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (clip.style === 'end') {
      ctx.fillStyle = '#283142';
      ctx.fillRect(0, 0, width, height);
      // The client's logo from the brand kit when the card has one, else SpeakPower's.
      const own = clip.mediaId ? project.media.find((item) => item.id === clip.mediaId)?.image : null;
      const logo = own || assets?.logos?.speakpower;
      let y = height * 0.36;
      if (logo) {
        // Fit within a square box, whatever the logo's shape.
        const box = Math.min(width, height) * 0.3;
        const ratio = logo.naturalHeight / logo.naturalWidth || 1;
        const logoWidth = ratio > 1 ? box / ratio : box;
        const logoHeight = logoWidth * ratio;
        ctx.drawImage(logo, (width - logoWidth) / 2, y - logoHeight / 2, logoWidth, logoHeight);
        y += logoHeight / 2 + 90 * unit;
      }
      const main = fitText(ctx, title, HEADLINE_FONT, 76 * unit, width * 0.82, 3);
      ctx.fillStyle = WHITE;
      ctx.font = `${main.fontSize}px ${HEADLINE_FONT}`;
      main.lines.forEach((line, index) => ctx.fillText(line, width / 2, y + index * main.fontSize * 1.2));
      y += main.lines.length * main.fontSize * 1.2 + 24 * unit;
      if (subtitle) {
        ctx.fillStyle = GOLD;
        ctx.font = `${44 * unit}px ${HEADLINE_FONT}`;
        ctx.fillText(subtitle, width / 2, y);
      }
      return;
    }

    if (clip.style === 'hook') {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.42)';
      ctx.fillRect(0, 0, width, height);
      const text = fitText(ctx, title.toUpperCase(), CAPTION_FONT, 104 * unit, width * 0.84, 4);
      const lineHeight = text.fontSize * 1.12;
      const top = height * 0.42 - (text.lines.length * lineHeight) / 2;
      ctx.font = `${text.fontSize}px ${CAPTION_FONT}`;
      ctx.lineJoin = 'round';
      text.lines.forEach((line, index) => {
        const y = top + lineHeight * (index + 0.5);
        ctx.lineWidth = 16 * unit;
        ctx.strokeStyle = '#000';
        ctx.strokeText(line, width / 2, y);
        ctx.fillStyle = index === 0 ? GOLD : WHITE;
        ctx.fillText(line, width / 2, y);
      });
      return;
    }

    // chapter
    const text = fitText(ctx, title, HEADLINE_FONT, 72 * unit, width * 0.7, 2);
    const lineHeight = text.fontSize * 1.18;
    const labelSize = 30 * unit;
    ctx.font = `${text.fontSize}px ${HEADLINE_FONT}`;
    const textWidth = Math.max(...text.lines.map((line) => ctx.measureText(line).width), 200 * unit);
    const panel = {
      width: textWidth + 120 * unit,
      height: text.lines.length * lineHeight + labelSize + 100 * unit,
    };
    panel.x = (width - panel.width) / 2;
    panel.y = (height - panel.height) / 2;
    ctx.fillStyle = NAVY_BAND;
    roundedRect(ctx, panel.x, panel.y, panel.width, panel.height, 18 * unit);
    ctx.fill();
    ctx.fillStyle = GOLD;
    ctx.fillRect(panel.x + panel.width / 2 - 40 * unit, panel.y + 34 * unit, 80 * unit, 5 * unit);
    ctx.font = `${labelSize}px ${HEADLINE_FONT}`;
    ctx.fillText((subtitle || 'Chapter').toUpperCase(), width / 2, panel.y + 34 * unit + labelSize);
    ctx.fillStyle = WHITE;
    ctx.font = `${text.fontSize}px ${HEADLINE_FONT}`;
    text.lines.forEach((line, index) => {
      ctx.fillText(line, width / 2, panel.y + 60 * unit + labelSize + lineHeight * (index + 0.5));
    });
  });
}

/** A key phrase popping up as it is said: navy on a gold tag, slightly tilted. */
function drawCallout(ctx, clip, time, width, height, unit, layout) {
  const text = (clip.title || '').trim().toUpperCase();
  if (!text) return;
  const fitted = fitText(ctx, text, CAPTION_FONT, 78 * unit, width * 0.72, 2);
  const lineHeight = fitted.fontSize * 1.1;
  ctx.font = `${fitted.fontSize}px ${CAPTION_FONT}`;
  const textWidth = Math.max(...fitted.lines.map((line) => ctx.measureText(line).width));
  const padX = 34 * unit;
  const padY = 22 * unit;
  const box = {
    width: textWidth + 2 * padX,
    height: fitted.lines.length * lineHeight + 2 * padY,
  };
  box.x = (width - box.width) / 2;
  box.y = height * (layout === LAYOUT['9:16'] ? 0.36 : 0.3) - box.height / 2;

  withTransition(ctx, transitionAt(clip, time), box, width, () => {
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    ctx.translate(cx, cy);
    ctx.rotate(-0.035);
    ctx.translate(-cx, -cy);
    ctx.shadowColor = 'rgba(0, 0, 0, 0.4)';
    ctx.shadowBlur = 24 * unit;
    ctx.shadowOffsetY = 8 * unit;
    ctx.fillStyle = GOLD;
    roundedRect(ctx, box.x, box.y, box.width, box.height, 16 * unit);
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.fillStyle = '#1d2432';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    fitted.lines.forEach((line, index) => ctx.fillText(line, cx, box.y + padY + lineHeight * (index + 0.5)));
  });
}

/** A thin gold bar across the top that fills as the clip plays. */
function drawProgress(ctx, clip, time, width, unit) {
  const fraction = Math.min(1, Math.max(0, (time - clip.start) / (clip.out - clip.in)));
  const barHeight = 10 * unit;
  ctx.save();
  ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
  ctx.fillRect(0, 0, width, barHeight);
  ctx.fillStyle = GOLD;
  ctx.fillRect(0, 0, width * fraction, barHeight);
  ctx.restore();
}

/** A name title for interviews: navy panel, gold accent bar, name over role. */
function drawLowerThird(ctx, clip, time, width, height, unit, layout) {
  const title = (clip.title || '').trim();
  const subtitle = (clip.subtitle || '').trim();
  if (!title && !subtitle) return;

  const titleSize = 56 * unit;
  const subtitleSize = 36 * unit;
  const padX = 34 * unit;
  const padY = 22 * unit;
  const bar = 12 * unit;
  const maxText = width * 0.78 - 2 * padX - bar;

  ctx.font = `${titleSize}px ${HEADLINE_FONT}`;
  const titleLines = title ? wrapLines(ctx, title, maxText).slice(0, 2) : [];
  const titleWidth = Math.max(0, ...titleLines.map((line) => ctx.measureText(line).width));
  ctx.font = `${subtitleSize}px ${HEADLINE_FONT}`;
  const subtitleLines = subtitle ? wrapLines(ctx, subtitle, maxText).slice(0, 2) : [];
  const subtitleWidth = Math.max(0, ...subtitleLines.map((line) => ctx.measureText(line).width));

  const gap = titleLines.length && subtitleLines.length ? 10 * unit : 0;
  const textHeight = titleLines.length * titleSize * 1.15 + gap + subtitleLines.length * subtitleSize * 1.2;
  const box = {
    x: 60 * unit,
    width: Math.max(titleWidth, subtitleWidth) + 2 * padX + bar,
    height: textHeight + 2 * padY,
  };
  box.y = height - layout.lowerThirdBottom * height - box.height;

  withTransition(ctx, transitionAt(clip, time), box, width, () => {
    ctx.fillStyle = NAVY_BAND;
    roundedRect(ctx, box.x, box.y, box.width, box.height, 12 * unit);
    ctx.fill();
    ctx.fillStyle = GOLD;
    ctx.fillRect(box.x, box.y, bar, box.height);

    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    let y = box.y + padY;
    ctx.fillStyle = WHITE;
    ctx.font = `${titleSize}px ${HEADLINE_FONT}`;
    for (const line of titleLines) {
      ctx.fillText(line, box.x + bar + padX, y + titleSize * 0.575);
      y += titleSize * 1.15;
    }
    y += gap;
    ctx.fillStyle = GOLD;
    ctx.font = `${subtitleSize}px ${HEADLINE_FONT}`;
    for (const line of subtitleLines) {
      ctx.fillText(line, box.x + bar + padX, y + subtitleSize * 0.6);
      y += subtitleSize * 1.2;
    }
  });
}

/**
 * Draw one output frame.
 *
 * @param ctx      2D context of the target canvas (preview or export)
 * @param frame    what to draw at this moment:
 *                   time    -- seconds into the finished video
 *                   source  -- seconds into the main video, or null once it has ended
 *                   main    -- { image, width, height } of the main video, or null
 *                   layers  -- Map(clip id -> { image, width, height }) for video and picture clips
 * @param project  the edit (project.js, tracks.js)
 * @param assets   from loadAssets()
 */
export function drawFrame(ctx, frame, project, assets) {
  const { width, height } = ctx.canvas;
  const unit = Math.min(width, height) / 1080;
  const layout = LAYOUT[project.format] || LAYOUT['9:16'];
  const off = project.trackOff || {};
  const { time } = frame;

  ctx.save();
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, width, height);

  const main = frame.main;
  if (main && main.width && main.height && !off[MAIN_TRACK]) {
    if (project.framing === 'crop') {
      const cover = fit(main.width, main.height, width, height, 'cover');
      ctx.drawImage(main.image, cover.x, cover.y, cover.width, cover.height);
    } else {
      drawBlurredBackground(ctx, main.image, main.width, main.height, width, height);
      const contain = fit(main.width, main.height, width, height, 'contain');
      ctx.drawImage(main.image, contain.x, contain.y, contain.width, contain.height);
    }
    const join = joinEffectAt(project, time);
    if (join) {
      ctx.globalAlpha = join.amount;
      ctx.fillStyle = join.color;
      ctx.fillRect(0, 0, width, height);
      ctx.globalAlpha = 1;
    }
  }
  ctx.restore();

  // V2 up to V8: each higher track draws over the ones below it.
  for (const track of VIDEO_TRACKS) {
    if (off[track]) continue;
    for (const clip of clipsOn(project, track)) {
      if (!isActive(clip, time)) continue;
      if (clip.kind === 'text') {
        drawLowerThird(ctx, clip, time, width, height, unit, layout);
      } else if (clip.kind === 'card') {
        drawCard(ctx, clip, time, width, height, unit, assets, project);
      } else if (clip.kind === 'callout') {
        drawCallout(ctx, clip, time, width, height, unit, layout);
      } else if (clip.kind === 'progress') {
        drawProgress(ctx, clip, time, width, unit);
      } else {
        const layer = frame.layers?.get(clip.id);
        if (layer?.image && layer.width && layer.height) drawLayer(ctx, clip, layer, time, width, height, unit, layout);
      }
    }
  }

  const logo = project.logo !== 'none' ? assets?.logos?.[project.logo] : null;
  const logoWidth = 150 * unit;
  const logoMargin = (project.format === '9:16' ? 60 : 40) * unit;

  const headline = (project.headline || '').trim();
  const headlineFrom = project.headlineFrom || 0;
  // Like the captions, the headline belongs to the main video: it leaves before an end card.
  const mainShowing = frame.source !== null && frame.source !== undefined;
  if (headline && time >= headlineFrom && mainShowing) {
    // Ease the band in over a quarter second (after any opening hook card).
    const alpha = Math.min(1, Math.max(0, (time - headlineFrom) / 0.25));
    const reserve = logo && layout.logoBesideHeadline ? logoWidth + logoMargin : 0;
    drawHeadline(ctx, headline, width, height, unit, layout, reserve, alpha);
  }

  // Captions follow the main video's words, so they end when it does. They
  // wait for an opening hook card to finish, so the two never stack.
  if (frame.source !== null && frame.source !== undefined && time >= (project.captionsFrom || 0)) {
    drawCaptions(ctx, { width, height, unit, layout, times: { source: frame.source, output: time } }, project.captions);
  }

  if (logo) {
    const logoHeight = logoWidth * (logo.naturalHeight / logo.naturalWidth);
    const top = layout.logoTop * height;
    ctx.drawImage(logo, width - logoWidth - logoMargin, top, logoWidth, logoHeight);
  }
}
