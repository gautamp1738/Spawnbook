const { test } = require('node:test');
const assert = require('node:assert/strict');
global.window = global;
require('../public/valuation.js');
require('../public/finder-match.js');
require('../public/data.js');
require('../public/history.js');
const earn = BR.META.earn;
const match = (box = {}, goal = 'balanced', board = BR.BOARD, history = HX) => SBFinder.match(board, earn, box, goal, history);
test('real board yields finite, deterministic scores and shared valuations', () => {
  const rows = match(); assert.ok(rows.length > 0); assert.deepEqual(rows, match());
  for (const r of rows) { assert.ok(r.score >= 0 && r.score <= 100); assert.deepEqual(r.value, SBV.value(SBV.boardInput(r.row, earn), earn)); assert.ok(r.reasons.length && r.risks.length); }
});
test('all hard filters apply without relaxing empty results', () => {
  assert.equal(match({ maxPrice: 1 }).length, 0);
  assert.equal(match({ minPlayers: 1e9 }).length, 0);
  assert.equal(match({ genres: ['nonexistent'] }).length, 0);
  assert.equal(match({ maxAgeDays: 1 }).length, 0);
  assert.equal(match({ minRevenue: 1e12 }).length, 0);
  const row = BR.BOARD[0], box = { genres: [row[4]], minPlayers: row[7], maxPlayers: row[7], maxAgeDays: row[6] };
  assert.ok(match(box).some(r => r.row === row));
  assert.ok(match({ avoid: row[1] }).every(r => r.row !== row));
});
test('budget boundary uses upper range, not midpoint', () => {
  const row = BR.BOARD[0], v = SBV.value(SBV.boardInput(row, earn), earn);
  assert.equal(match({ maxPrice: v.mid }, 'balanced', [row]).length, 0);
  assert.equal(match({ maxPrice: Math.ceil(v.hi) }, 'balanced', [row]).length, 1);
});
test('lifetime visits require a current reading; unknown never means zero', () => {
  assert.equal(match({ maxVisits: 1e11 }, 'balanced', BR.BOARD, { games: {}, dates: ['today'] }).length, 0);
  const rows = match({ maxVisits: 1e11 }); assert.ok(rows.length > 0);
  for (const r of rows) { const data = HX.games[r.uid][8].at(-1); assert.equal(data[0], HX.dates.length - 1); assert.ok(data[2] <= 1e11); }
});
test('missing growth is explicit, negative growth warns, ties are stable', () => {
  const r = structuredClone(BR.BOARD[0]); r[26].trend.d7 = null;
  const m = match({}, 'growth', [r])[0]; assert.equal(m.score, Math.round(r[24] * .7)); assert.ok(m.risks.some(s => s.includes('unknown')));
  r[26].trend.d7 = { players: -25, days: 7 };
  assert.ok(match({}, 'growth', [r])[0].risks.some(s => s.includes('declined')));
  assert.equal(match({}, 'balanced', [])[0], undefined);
});
