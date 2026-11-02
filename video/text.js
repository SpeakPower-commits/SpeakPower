/**
 * Fonts and line-wrapping shared by every on-video graphic.
 *
 * Its own module so the renderer and the captions can both use it without
 * importing each other.
 */

// Registered from the bundled Inter files by renderer.loadAssets(). Custom
// names, so a system copy of Inter (or its absence) can never change the look.
export const HEADLINE_FONT = 'StudioInterExtraBold';
export const CAPTION_FONT = 'StudioInterBlack';

/** Break text into lines no wider than maxWidth with the context's current font. */
export function wrapLines(ctx, text, maxWidth) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(candidate).width > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}
