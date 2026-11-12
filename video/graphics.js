/**
 * Ngoma's design vocabulary: which emoji and icon go with which spoken word,
 * and the moments in a transcript worth turning into a graphic.
 *
 *   matchWord(text)            -> { key, emoji, icon } for a word Ngoma can illustrate
 *   lexiconHits(words, a, b)   -> those words, timed, between source times a and b
 *   findStats(words, a, b)     -> spoken numbers: "grew 70%", "UGX 2 million", "3 years"
 *   findLists(words, a, b)     -> enumerations: "first ... second ... third ..."
 *   iconFor(text)              -> the best icon for a short phrase
 *   loadGraphics(project, a)   -> loads the emoji pictures a project uses into assets.emoji
 *   drawIcon / drawEmoji       -> paint them, the same in the preview and the export
 *
 * Emoji pictures: Noto Emoji (Apache-2.0), in ./emoji. Icons: Lucide (ISC),
 * as path data in ./icons.js. Both ship with the site; nothing is fetched
 * from elsewhere while editing.
 */

import { ICONS } from './icons.js';

/**
 * Each entry: words (a trailing * matches any ending), the emoji (Unicode
 * code points, as the file in ./emoji is named) and the Lucide icon.
 * Earlier entries win, so the specific ones come first.
 */
export const LEXICON = [
  { key: 'growth', words: 'grow* grew increas* rise rises rising rose scale* scaling expand* boost* doubl* tripl* surg*', emoji: '1F4C8', icon: 'trending-up' },
  { key: 'decline', words: 'declin* drop* fell fall* falling decreas* shrink* lost loss losses', emoji: '1F4C9', icon: 'trending-down' },
  { key: 'money', words: 'money revenue* profit* income cash sales salary salaries price* pricing pay paid paying earn* dollar* shilling* ugx kes usd budget* fund* funding', emoji: '1F4B0', icon: 'banknote' },
  { key: 'invest', words: 'invest* bank* finance* financial savings saving loan* capital', emoji: '1F3E6', icon: 'landmark' },
  { key: 'idea', words: 'idea* insight* innovat* creativ* invent* imagin*', emoji: '1F4A1', icon: 'lightbulb' },
  { key: 'team', words: 'team* together collaborat* partner* partnership* teamwork', emoji: '1F91D', icon: 'users' },
  { key: 'trust', words: 'trust* honest* integrity transparen* credib* reliab*', emoji: '1F91D', icon: 'shield-check' },
  { key: 'goal', words: 'goal* target* focus* aim aims vision mission objective*', emoji: '1F3AF', icon: 'target' },
  { key: 'time', words: 'time hour* minute* clock* schedul* daily weekly monthly', emoji: '23F0', icon: 'clock' },
  { key: 'calendar', words: 'calendar dates deadline* quarterly anniversar*', emoji: '1F4C5', icon: 'calendar' },
  { key: 'listen', words: 'listen* hear* heard', emoji: '1F442', icon: 'ear' },
  { key: 'speak', words: 'speak* speech* talk* voice* communicat* message* pitch* present* storytell* story stories', emoji: '1F5E3', icon: 'mic' },
  { key: 'love', words: 'love* care* caring passion* heart*', emoji: '2764', icon: 'heart' },
  { key: 'fire', words: 'fire hot amazing powerful incredible unstoppable', emoji: '1F525', icon: 'flame' },
  { key: 'risk', words: 'risk* warning* danger* mistake* problem* threat* crisis', emoji: '26A0', icon: 'triangle-alert' },
  { key: 'africa', words: 'africa* kenya* uganda* nairobi kampala tanzania* rwanda* nigeria* ghana* world global* international continent', emoji: '1F30D', icon: 'globe' },
  { key: 'win', words: 'win wins winning won success* succeed* achiev* victory champion*', emoji: '1F3C6', icon: 'trophy' },
  { key: 'learn', words: 'learn* school* educat* study studying student* teach* train* lesson*', emoji: '1F4DA', icon: 'graduation-cap' },
  { key: 'data', words: 'data research* analy* numbers statistic* metric* measur* result*', emoji: '1F4CA', icon: 'chart-column' },
  { key: 'people', words: 'customer* client* people audience* communit* member* user* followers', emoji: '1F465', icon: 'users-round' },
  { key: 'launch', words: 'launch* start* begin* rocket* startup* takeoff', emoji: '1F680', icon: 'rocket' },
  { key: 'think', words: 'think* mind* brain* strateg* decid* decision*', emoji: '1F9E0', icon: 'brain' },
  { key: 'question', words: 'question* why how what', emoji: '2753', icon: 'circle-question-mark' },
  { key: 'yes', words: 'yes right correct agree* true', emoji: '2705', icon: 'circle-check' },
  { key: 'no', words: 'never wrong stop false', emoji: '274C', icon: 'circle-x' },
  { key: 'lead', words: 'lead leads leader* leadership boss ceo* founder* manag* executive*', emoji: '1F451', icon: 'crown' },
  { key: 'work', words: 'work* job* business* compan* career* office* industr*', emoji: '1F4BC', icon: 'briefcase' },
  { key: 'phone', words: 'phone* mobile* call* whatsapp sms', emoji: '1F4F1', icon: 'smartphone' },
  { key: 'online', words: 'online internet digital* social website* app apps tech* technolog* ai', emoji: '1F310', icon: 'globe' },
  { key: 'happy', words: 'happy happiness joy* smile* fun funny laugh*', emoji: '1F604', icon: 'face-slightly-smiling' },
  { key: 'hard', words: 'hard difficult struggl* tough challeng* pain*', emoji: '1F613', icon: 'face-slightly-frowning' },
  { key: 'wow', words: 'wow surpris* shock* unbelievable', emoji: '1F62E', icon: 'zap' },
  { key: 'strong', words: 'strong* strength* power energy energi* resilien* confiden*', emoji: '1F4AA', icon: 'zap' },
  { key: 'health', words: 'health* wellness doctor* hospital* medic*', emoji: '1FA7A', icon: 'heart-pulse' },
  { key: 'farm', words: 'farm* agricultur* crop* grow-food food harvest* seed*', emoji: '1F331', icon: 'sprout' },
  { key: 'home', words: 'home* house* family families', emoji: '1F3E0', icon: 'house' },
  { key: 'sun', words: 'solar sun sunny', emoji: '2600', icon: 'sun' },
  { key: 'key', words: 'key secret* unlock*', emoji: '1F511', icon: 'key-round' },
  { key: 'plan', words: 'plan* step* process* roadmap* journey', emoji: '1F5FA', icon: 'map' },
  { key: 'write', words: 'writ* book* blog* content', emoji: '270D', icon: 'pen-line' },
  { key: 'video', words: 'video* camera* film* youtube tiktok reels', emoji: '1F3AC', icon: 'clapperboard' },
  { key: 'music', words: 'music song* sing*', emoji: '1F3B5', icon: 'list-music' },
  { key: 'celebrate', words: 'celebrat* party congratulat*', emoji: '1F389', icon: 'party-popper' },
  { key: 'best', words: 'best first top number-one excellen* great greatest', emoji: '1F947', icon: 'medal' },
  { key: 'star', words: 'star* quality excellent', emoji: '2B50', icon: 'star' },
  { key: 'list', words: 'checklist list* tips', emoji: '1F4DD', icon: 'clipboard-list' },
  { key: 'look', words: 'look* see seeing watch* visib*', emoji: '1F440', icon: 'eye' },
  { key: 'thanks', words: 'thank* grateful gratitude', emoji: '1F64F', icon: 'heart-handshake' },
  { key: 'gift', words: 'gift* free bonus', emoji: '1F381', icon: 'gift' },
  { key: 'search', words: 'search* seo google find finding discover*', emoji: '1F50D', icon: 'search' },
  { key: 'secure', words: 'secur* safe* protect* privacy', emoji: '1F512', icon: 'lock' },
  { key: 'shop', words: 'shop* buy* sell* market* brand* product*', emoji: '1F6D2', icon: 'shopping-cart' },
  { key: 'announce', words: 'announc* news launch-day', emoji: '1F4E3', icon: 'megaphone' },
  { key: 'chat', words: 'conversation* chat* discuss* feedback', emoji: '1F4AC', icon: 'message-circle' },
  { key: 'puzzle', words: 'solution* solve* puzzle* fix*', emoji: '1F9E9', icon: 'puzzle' },
  { key: 'perfect', words: 'perfect* hundred percent', emoji: '1F4AF', icon: 'badge-check' },
];

// A few emojis Ngoma uses on its own: sparkle for a hook, pointing for a key point.
export const EXTRA_EMOJI = { sparkle: '2728', point: '1F449', clap: '1F44F', diamond: '1F48E' };

const ENTRIES = LEXICON.map((entry) => {
  const exact = new Set();
  const stems = [];
  for (const word of entry.words.split(/\s+/)) {
    if (word.endsWith('*')) stems.push(word.slice(0, -1));
    else exact.add(word);
  }
  return { ...entry, exact, stems };
});

// Short words that look like matches but carry no meaning on their own.
const NEVER = new Set(['how', 'what', 'why', 'right', 'true', 'first', 'top', 'great', 'free', 'see', 'look', 'call', 'start', 'step', 'list',
  'key', 'work', 'time', 'plan', 'care', 'lead', 'pay']);
// …unless they are said on their own as the point (they still work for icons of whole phrases).

export const normalizeWord = (text) => String(text || '').toLowerCase().replace(/[^\p{L}\p{N}'-]+/gu, '').replace(/'s$/, '');

/** The lexicon entry for one word, or null. strict: skip the vague words (for captions and stickers). */
export function matchWord(text, { strict = true } = {}) {
  const word = normalizeWord(text);
  if (word.length < 2 || (strict && NEVER.has(word))) return null;
  for (const entry of ENTRIES) {
    if (entry.exact.has(word) || entry.stems.some((stem) => word.startsWith(stem) && word.length - stem.length <= 6)) {
      return { key: entry.key, emoji: entry.emoji, icon: entry.icon };
    }
  }
  return null;
}

/** Every illustratable word between source times from and to: [{ time, end, text, key, emoji, icon }]. */
export function lexiconHits(words, from = 0, to = Infinity) {
  const hits = [];
  for (const word of words) {
    if (word.start < from || word.start >= to) continue;
    const match = matchWord(word.text);
    if (match) hits.push({ time: word.start, end: word.end, text: word.text, ...match });
  }
  return hits;
}

/** The best icon for a short phrase: the first word that has one, else a sparkle. */
export function iconFor(text) {
  for (const word of String(text || '').split(/\s+/)) {
    const match = matchWord(word, { strict: false });
    if (match) return match.icon;
  }
  return 'sparkles';
}

export function emojiFor(text) {
  for (const word of String(text || '').split(/\s+/)) {
    const match = matchWord(word, { strict: false });
    if (match) return match.emoji;
  }
  return EXTRA_EMOJI.sparkle;
}

// --- Numbers ------------------------------------------------------------------------

const STOP = new Set(('a an the and or but so to of in on at for by with from as is are was were be been being it its this that these those ' +
  'we our us you your i me my he she they them their his her there here than then just very really about over under into out up down ' +
  'um uh like have has had do does did will would can could should not no yes also more most less only even still every each all').split(' '));

const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twenty: 20, thirty: 30, forty: 40, fifty: 50, hundred: 100 };
const SCALE = { thousand: 1e3, k: 1e3, million: 1e6, m: 1e6, billion: 1e9, bn: 1e9 };
const CURRENCY = { ugx: 'UGX ', kes: 'KES ', ksh: 'KSh ', usd: '$', tzs: 'TZS ', rwf: 'RWF ', shillings: ' shillings', dollars: '$' };
const UNITS = /^(percent|per-cent|%|years?|months?|weeks?|days?|hours?|minutes?|times|x|people|clients|customers|members|schools|students|users|followers|countries|kids|children|women|men|farmers|jobs)$/;

const plain = (text) => String(text || '').toLowerCase().replace(/[,"“”()]/g, '');

/** "1,200" "70%" "2.5" "$5" -> { value, prefix, suffix } or null. */
function readNumber(raw) {
  const text = plain(raw).replace(/[.!?;:]+$/, '');
  const match = text.match(/^(\$|ugx|kes|ksh)?(\d+(?:\.\d+)?)(%|k|m|bn)?$/);
  if (match) {
    return {
      value: Number(match[2]),
      prefix: match[1] === '$' ? '$' : match[1] ? `${match[1].toUpperCase()} ` : '',
      suffix: match[3] === '%' ? '%' : match[3] ? match[3].toUpperCase() : '',
    };
  }
  if (NUMBER_WORDS[text] && NUMBER_WORDS[text] >= 2) return { value: NUMBER_WORDS[text], prefix: '', suffix: '' };
  return null;
}

/** "UGX 2 million", "70%", "$5K", "3 years" -- value may be a counting-up number. */
export function formatStat({ prefix = '', suffix = '', decimals = 0 }, value) {
  const number = Number(value).toLocaleString('en', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  const tail = /^[A-Za-z]{2,}/.test(suffix) ? ` ${suffix}` : suffix;
  return `${prefix}${number}${tail}`;
}

const titleCase = (words) => words.map((word) => word.replace(/^\p{L}/u, (letter) => letter.toUpperCase())).join(' ');

/**
 * Spoken figures worth a stat graphic: a percentage, money, or a count with a
 * unit ("3 years", "500 farmers"). Small bare numbers ("2 things") are left alone.
 * Each: { time, end, value, prefix, suffix, decimals, label }.
 */
export function findStats(words, from = 0, to = Infinity) {
  const stats = [];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (word.start < from || word.start >= to) continue;
    const number = readNumber(word.text);
    if (!number) continue;
    let { value, prefix, suffix } = number;
    let last = index;
    const next = plain(words[index + 1]?.text).replace(/[.!?;:]+$/, '');
    const after = plain(words[index + 2]?.text).replace(/[.!?;:]+$/, '');
    const before = plain(words[index - 1]?.text).replace(/[.!?;:]+$/, '');
    if (SCALE[next]) { suffix = `${suffix}${next === 'k' ? 'K' : ` ${next}`}`.trim(); last += 1; }
    const unitWord = SCALE[next] ? after : next;
    if (CURRENCY[before] && !prefix) prefix = CURRENCY[before].endsWith(' ') || CURRENCY[before] === '$' ? CURRENCY[before] : '';
    if (CURRENCY[unitWord]) {
      if (CURRENCY[unitWord].startsWith(' ')) suffix = `${suffix}${CURRENCY[unitWord]}`; else prefix = CURRENCY[unitWord];
      last += 1;
    } else if (/^(percent|per-cent)$/.test(unitWord)) {
      suffix = '%'; last += 1;
    } else if (UNITS.test(unitWord)) {
      suffix = `${suffix} ${unitWord}`.trim(); last += 1;
    }
    const meaningful = suffix.includes('%') || prefix || /million|billion|K\b|shillings/.test(suffix) || (UNITS.test(unitWord) && value >= 2) || value >= 100;
    if (!meaningful || (value < 2 && !suffix.includes('%'))) continue;
    if (/^(19|20)\d\d$/.test(String(value)) && !suffix && !prefix) continue; // a year, not a figure

    // The label: the content words of the same sentence, nearest the number.
    const around = [];
    for (let back = index - 1; back >= Math.max(0, index - 8); back -= 1) {
      if (/[.!?]$/.test(words[back].text)) break;
      around.unshift(words[back]);
    }
    for (let ahead = last + 1; ahead < Math.min(words.length, last + 6); ahead += 1) {
      around.push(words[ahead]);
      if (/[.!?]$/.test(words[ahead].text)) break;
    }
    const content = around.map((item) => plain(item.text).replace(/[.!?;:]+$/, ''))
      .filter((text) => text && !STOP.has(text) && !readNumber(text) && !CURRENCY[text] && !SCALE[text] && !/^(percent|per-cent)$/.test(text));
    const label = titleCase(content.slice(-4).length > 1 ? content.slice(-4) : content.slice(0, 4));
    const decimals = String(value).includes('.') ? String(value).split('.')[1].length : 0;
    stats.push({ time: word.start, end: words[last].end, value, prefix, suffix, decimals, label });
    index = last;
  }
  return stats;
}

// --- Lists --------------------------------------------------------------------------

const ORDINALS = [
  /^(first|firstly|one|number-one)$/,
  /^(second|secondly|two|number-two|next)$/,
  /^(third|thirdly|three|number-three|finally|lastly)$/,
  /^(fourth|fourthly|four|number-four|finally|lastly)$/,
  /^(fifth|fifthly|five|number-five|finally|lastly)$/,
];

/**
 * Enumerations: "first ... second ... third ...", or "number one ... number two".
 * At least two items, each within 45 s of the last. Each list:
 * { time, end, items: [{ time, text }] } with 2-4 word item texts.
 */
export function findLists(words, from = 0, to = Infinity) {
  const lists = [];
  const tokens = words.map((word, index) => {
    let text = plain(word.text).replace(/[.!?;:]+$/, '');
    if (text === 'number' && words[index + 1]) text = `number-${plain(words[index + 1].text).replace(/[.!?;:]+$/, '')}`;
    return text;
  });
  const itemAfter = (index) => {
    const picked = [];
    for (let at = index + 1; at < Math.min(words.length, index + 12) && picked.length < 4; at += 1) {
      const text = plain(words[at].text).replace(/[.!?;:]+$/, '');
      if (/^number$|^(one|two|three|four|five)$/.test(text) && at === index + 1) continue;
      if (text && !STOP.has(text) && !/^(is|thing|things|point|step|tip|lesson|rule)$/.test(text)) picked.push(words[at].text.replace(/[.!?;:,]+$/, ''));
      if (/[.!?;:]$/.test(words[at].text) && picked.length) break;
    }
    return titleCase(picked.slice(0, 4).map((text) => text.toLowerCase()));
  };
  let index = 0;
  while (index < words.length) {
    if (words[index].start < from || words[index].start >= to || !/^(first|firstly|number-one)$/.test(tokens[index])) { index += 1; continue; }
    const items = [{ time: words[index].start, text: itemAfter(index), at: index }];
    let look = index + 1;
    while (items.length < 5 && look < words.length) {
      const wanted = ORDINALS[items.length];
      if (words[look].start - items[items.length - 1].time > 45 || words[look].start >= to) break;
      if (wanted.test(tokens[look]) && !(tokens[look] === 'next' && items.length !== 1)) {
        items.push({ time: words[look].start, text: itemAfter(look), at: look });
      }
      look += 1;
    }
    const good = items.filter((item) => item.text);
    if (good.length >= 2) {
      const lastWord = words[Math.min(words.length - 1, good[good.length - 1].at + 8)];
      lists.push({ time: good[0].time, end: lastWord.end, items: good.map(({ time, text }) => ({ time, text })) });
      index = good[good.length - 1].at + 1;
    } else {
      index += 1;
    }
  }
  return lists;
}

// --- Drawing ------------------------------------------------------------------------

const HERE = new URL('.', import.meta.url).href;
export const emojiUrl = (code) => `${HERE}emoji/${code}.svg`;

const loading = new Map();

function loadEmoji(code) {
  if (!loading.has(code)) {
    loading.set(code, (async () => {
      const image = new Image();
      image.src = emojiUrl(code);
      await image.decode();
      return image;
    })().catch(() => null));
  }
  return loading.get(code);
}

/** Every emoji a project draws: in its captions and its clips. */
export function emojisIn(project) {
  const codes = new Set();
  for (const segment of project.captions?.segments || []) {
    for (const word of segment.words || []) if (word.emoji) codes.add(word.emoji);
  }
  for (const clip of project.clips || []) if (clip.data?.emoji) codes.add(clip.data.emoji);
  return [...codes];
}

/** Load the project's emoji pictures into assets.emoji (shared, so each loads once). */
export async function loadGraphics(project, assets) {
  if (!assets) return;
  assets.emoji = assets.emoji || {};
  const codes = emojisIn(project).filter((code) => !assets.emoji[code]);
  const images = await Promise.all(codes.map(loadEmoji));
  codes.forEach((code, index) => { if (images[index]) assets.emoji[code] = images[index]; });
}

/** A Lucide icon centred on (x, y), size pixels wide, as a stroked line drawing. */
export function drawIcon(ctx, name, x, y, size, color = '#16233f', weight = 2.2) {
  const paths = ICONS[name] || ICONS.sparkles;
  if (!paths) return;
  ctx.save();
  ctx.translate(x - size / 2, y - size / 2);
  ctx.scale(size / 24, size / 24);
  ctx.lineWidth = weight;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = color;
  for (const data of paths) ctx.stroke(new Path2D(data));
  ctx.restore();
}

/** An emoji picture centred on (x, y). Nothing is drawn until it has loaded. */
export function drawEmoji(ctx, assets, code, x, y, size) {
  const image = assets?.emoji?.[code];
  if (!image) return false;
  ctx.drawImage(image, x - size / 2, y - size / 2, size, size);
  return true;
}

export const ICON_NAMES = Object.keys(ICONS);
