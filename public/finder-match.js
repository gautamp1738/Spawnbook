/* Deterministic buyer matching over the scored daily board. Uses the shared price model. */
(function (root) {
  function match(board, earn, box, goal) {
    box = box || {};
    return board.flatMap(function (r) {
      var x = r[26] || {}, trend = x.trend || {}, week = trend.d7 && trend.d7.players;
      if (!Number.isSafeInteger(x.uid) || !Number.isSafeInteger(r[0])) return [];
      var v = root.SBV.value(root.SBV.boardInput(r, earn), earn);
      var genres = box.genres || [];
      if (genres.length && !genres.includes(r[4]) && !genres.includes(r[5])) return [];
      if (box.minPlayers && r[7] < box.minPlayers || box.maxPlayers && r[7] > box.maxPlayers) return [];
      if (box.maxAgeDays && (r[6] == null || r[6] > box.maxAgeDays)) return [];
      // Budget is deliberately conservative: the entire estimated range must fit.
      if (box.maxPrice && (!Number.isFinite(v.hi) || v.hi > box.maxPrice)) return [];
      if (box.minRevenue && (v.rev.basis === 'unknown' || v.rev.mid < box.minRevenue)) return [];
      var avoid = String(box.avoid || '').split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
      if (avoid.some(function (s) { return [r[1], r[2], r[4], r[5]].join(' ').toLowerCase().includes(s); })) return [];
      var quality = Math.max(0, Math.min(100, Number(r[24]) || 0));
      var signal = goal === 'growth' ? (week == null ? 0 : Math.max(0, Math.min(100, week))) : goal === 'established' ? Math.min(100, r[6] / 1.8) : quality;
      var score = Math.round(quality * 0.7 + signal * 0.3);
      var reasons = [r[4] + (genres.length ? ' matches your selected genres.' : ' is open under your genre preferences.'), r[7].toLocaleString('en-US') + ' players at the latest reading; age ' + r[6] + ' days.', 'Board quality score ' + quality + '/100.'];
      if (box.maxPrice) reasons.push('Estimated upper price $' + Math.ceil(v.hi).toLocaleString('en-US') + ' fits your budget.');
      if (week != null) reasons.push('Players changed ' + (week > 0 ? '+' : '') + week + '% over ' + trend.d7.days + ' days.');
      var risks = ['Owner willingness, deal structure and actual revenue require verification.'];
      if (week == null) risks.push('No comparable week of player history; growth is unknown.');
      else if (week < 0) risks.push('Players declined over the measured week.');
      if (v.conf === 'low') risks.push('Low confidence price estimate.');
      return [{ row: r, uid: x.uid, value: v, score: score, reasons: reasons, risks: risks }];
    }).sort(function (a, b) { return b.score - a.score || a.uid - b.uid; });
  }
  root.SBFinder = { match: function (board, earn, box, goal, history) {
    var filtered = board;
    if (box && box.maxVisits) filtered = board.filter(function (r) {
      var g = history && history.games[(r[26] || {}).uid], readings = g && g[8], last = readings && readings[readings.length - 1];
      return last && last[0] === history.dates.length - 1 && Number.isFinite(last[2]) && last[2] <= box.maxVisits;
    });
    return match(filtered, earn, Object.assign({}, box, { maxVisits: null }), goal);
  } };
})(typeof globalThis !== 'undefined' ? globalThis : this);
