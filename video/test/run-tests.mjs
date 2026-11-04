/**
 * Unit tests for Ngoma's plain logic (no browser needed):
 *   node video/test/run-tests.mjs
 */
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, LOOKS, parseInstruction } from '../autoedit.js';
import { findLists, findStats, formatStat, iconFor, lexiconHits, matchWord } from '../graphics.js';
import { ICONS } from '../icons.js';
import { LEXICON } from '../graphics.js';
import fs from 'node:fs';

let passed = 0;
let failed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; } catch (error) { failed += 1; console.log(`FAIL ${name}\n  ${error.message}`); }
};
const words = (text) => text.split(' ').map((word, index) => ({ text: word, start: index * 0.4, end: index * 0.4 + 0.3 }));

const USER_PROMPT = 'I want a modern output of the edit with Canva graphical designs as illustrations, e.g captions(not just simple subtitles), icons, emojis, and any other creative innovation of key points.';

test("the user's prompt asks for the Modern look with everything on", () => {
  const settings = parseInstruction(USER_PROMPT, DEFAULT_SETTINGS);
  assert.equal(settings.look, 'modern');
  assert.equal(settings.captionStyle, 'pill');
  for (const key of ['emojis', 'icons', 'keyPoints', 'stats', 'lists', 'zooms', 'stickers', 'captions']) assert.equal(settings[key], true, key);
});
test('"simple subtitles" gives the Clean look', () => {
  const settings = parseInstruction('Make 2 clips with simple subtitles.', DEFAULT_SETTINGS);
  assert.equal(settings.look, 'clean');
  assert.equal(settings.captionStyle, 'minimal');
  assert.equal(settings.emojis, false);
});
test('specific asks adjust a look', () => {
  const settings = parseInstruction('Modern clips, karaoke captions, no emojis, no zooms.', DEFAULT_SETTINGS);
  assert.equal(settings.captionStyle, 'karaoke');
  assert.equal(settings.emojis, false);
  assert.equal(settings.zooms, false);
  assert.equal(settings.keyPoints, true);
});
test('"no graphics" turns every designed graphic off', () => {
  const settings = parseInstruction('Modern style but no graphics.', DEFAULT_SETTINGS);
  for (const key of ['emojis', 'icons', 'keyPoints', 'stats', 'lists', 'zooms', 'stickers']) assert.equal(settings[key], false, key);
});
test('an instruction without style words keeps the classic look', () => {
  const settings = parseInstruction('Make 3 TikTok clips about leadership, 30-60 seconds.', DEFAULT_SETTINGS);
  assert.equal(settings.look, 'classic');
  assert.equal(settings.captionStyle, 'bold');
  assert.equal(settings.callouts, true);
});
test('emojis only', () => {
  const settings = parseInstruction('Add emojis to the captions.', DEFAULT_SETTINGS);
  assert.equal(settings.emojis, true);
  assert.equal(settings.look, 'classic');
});

test('stats: percentages, money and counts, with labels', () => {
  const stats = findStats(words('The market in Nairobi grew 70% last year. We raised UGX 2 million for the clinic. It grew by 45 percent. In 2024 we had 2 ideas.'));
  const shown = stats.map((stat) => formatStat(stat, stat.value));
  assert.deepEqual(shown, ['70%', 'UGX 2 million', '45%']);
  assert.match(stats[0].label, /Nairobi/);
});
test('lists: first, second, third', () => {
  const lists = findLists(words('There are three things. First, listen to your team. Second, build trust every day. Third, celebrate small wins.'));
  assert.equal(lists.length, 1);
  assert.deepEqual(lists[0].items.map((item) => item.text), ['Listen Team', 'Build Trust Day', 'Celebrate Small Wins']);
});
test('lists need at least two points', () => {
  assert.equal(findLists(words('First, we met. Then we talked for hours about nothing.')).length, 0);
});
test('lexicon: words, not look-alikes', () => {
  assert.equal(matchWord('growth').key, 'growth');
  assert.equal(matchWord('winning').key, 'win');
  assert.equal(matchWord('window'), null);
  assert.equal(matchWord('how'), null);
  assert.equal(iconFor('Clear goals drive growth'), 'target');
  assert.equal(iconFor('zzz'), 'sparkles');
  assert.ok(lexiconHits(words('Our team grew fast')).length >= 2);
});
test('every lexicon icon and emoji ships with the site', () => {
  for (const entry of LEXICON) {
    assert.ok(ICONS[entry.icon], `icon ${entry.icon}`);
    assert.ok(fs.existsSync(new URL(`../emoji/${entry.emoji}.svg`, import.meta.url)), `emoji ${entry.emoji}`);
  }
  assert.ok(ICONS.sparkles);
});
test('every look is complete', () => {
  for (const [name, look] of Object.entries(LOOKS)) {
    for (const key of ['captionStyle', 'callouts', 'emojis', 'icons', 'keyPoints', 'stats', 'lists', 'zooms']) assert.ok(key in look, `${name}.${key}`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
