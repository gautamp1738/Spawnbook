(function () {
  'use strict';
  var T = window.SBT;
  var $ = function (id) { return document.getElementById(id); }, form = $('questionnaire'), steps = Array.from(form.querySelectorAll('[data-step]')), step = 0, saved = {}, watched = new Set(), member = false;
  var fields = ['maxPrice', 'minRevenue', 'minPlayers', 'maxPlayers', 'maxAgeDays', 'maxVisits', 'deal', 'avoid'];
  function api(path, body) {
    return fetch(path, { credentials: 'same-origin', method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }).then(function (r) {
      if (!r.ok) throw new Error(r.status === 401 ? 'Sign in with active access to use this action.' : 'Request failed. Please try again.');
      return r.json();
    }).then(function (j) { if (j.error) throw new Error('Could not save. Please try again.'); return j; });
  }
  function showStep() {
    steps.forEach(function (s, i) { s.hidden = i !== step; });
    $('back').hidden = step === 0; $('next').hidden = step === 2; $('submit').hidden = step !== 2;
    $('progress').textContent = 'Step ' + (step + 1) + ' of 3';
  }
  function valid() {
    var inputs = Array.from(steps[step].querySelectorAll('input,select'));
    for (var input of inputs) if (!input.reportValidity()) return false;
    var min = Number(form.elements.minPlayers.value), max = Number(form.elements.maxPlayers.value);
    if (step === 2 && min && max && min > max) { $('error').textContent = 'Minimum players must not exceed maximum players.'; form.elements.minPlayers.focus(); return false; }
    $('error').textContent = ''; return true;
  }
  function move(n) { step = n; showStep(); steps[step].querySelector('input,select').focus(); }
  $('back').onclick = function () { move(step - 1); };
  $('next').onclick = function () { if (valid()) move(step + 1); };
  $('edit').onclick = function () { $('results').hidden = true; form.hidden = false; move(0); };
  function read() {
    var box = Object.assign({}, saved);
    fields.forEach(function (key) { var v = form.elements[key].value; box[key] = form.elements[key].type === 'number' ? (v ? Number(v) : null) : v; });
    box.genres = Array.from($('genres').querySelectorAll('input:checked')).map(function (i) { return i.value; }); return box;
  }
  function list(parent, title, items) {
    parent.appendChild(T.el('h4', null, title)); var ul = T.el('ul'); items.forEach(function (s) { ul.appendChild(T.el('li', null, s)); }); parent.appendChild(ul);
  }
  function render(box) {
    var rows = SBFinder.match(BR.BOARD, BR.META.earn, box, form.elements.goal.value, HX);
    $('matches').textContent = '';
    var date = HX.dates[HX.dates.length - 1], age = Date.now() - Date.parse(HX.times[HX.times.length - 1]);
    $('summary').textContent = rows.length + ' matches from ' + BR.BOARD.length + ' scored board games. Showing up to 20. Data: ' + date + '.' + (age > 48 * 3600000 ? ' Data is more than 48 hours old; refresh your research before proceeding.' : '') + (rows.length ? '' : ' No games meet all your limits. Edit your answers to broaden them.');
    rows.slice(0, 20).forEach(function (m) {
      var card = T.el('article', 'finder-card'), r = m.row, v = m.value;
      card.appendChild(T.el('p', 'small', m.score + '/100 fit · ' + r[4])); card.appendChild(T.el('h3', null, r[1]));
      card.appendChild(T.el('p', null, 'Estimated price ' + SBV.rangeText(v) + ' · ' + SBV.confLabel(v) + '.'));
      card.appendChild(T.el('p', null, 'Estimated monthly revenue: ' + SBV.money(v.rev.mid) + '. ' + SBV.revenueWhy(v)));
      list(card, 'Why it fits', m.reasons); list(card, 'Check before buying', m.risks);
      var detail = T.el('a', 'link', 'View evidence & history'); detail.href = 'game?pid=' + r[0]; card.appendChild(detail);
      var lookup = T.el('a', 'link', 'Check current numbers'); lookup.href = 'lookup?u=' + m.uid; card.appendChild(lookup);
      var btn = T.el('button', null, watched.has(m.uid) ? 'On your watchlist' : 'Add to watchlist'), status = T.el('p', 'small'); status.setAttribute('role', 'status'); btn.type = 'button'; btn.disabled = watched.has(m.uid) || !member;
      if (!member) status.textContent = 'Sign in with active access to save games to your watchlist.';
      btn.onclick = function () { btn.disabled = true; api('/api/watch', { action: 'add', uid: m.uid, pid: r[0], name: r[1] }).then(function () { watched.add(m.uid); btn.textContent = 'On your watchlist'; status.textContent = 'Saved to your watchlist.'; }).catch(function (e) { status.textContent = e.message; btn.disabled = false; }); };
      card.appendChild(btn); card.appendChild(status); $('matches').appendChild(card);
    });
    form.hidden = true; $('results').hidden = false; $('results').focus();
  }
  form.onsubmit = async function (e) {
    e.preventDefault(); if (step < 2) { if (valid()) move(step + 1); return; } if (!valid()) return;
    var box = read(); $('submit').disabled = true;
    try { if ($('save').checked) { var j = await api('/api/buybox', box); saved = j.box || box; } render(box); }
    catch (err) { $('error').textContent = err.message; }
    finally { $('submit').disabled = false; }
  };
  var genres = ['Action', 'Adventure', 'Entertainment', 'Obby & Platformer', 'Party & Casual', 'Puzzle', 'Roleplay & Avatar Sim', 'RPG', 'Shooter', 'Shopping', 'Simulation', 'Social', 'Sports & Racing', 'Strategy', 'Survival'];
  genres.forEach(function (g) { var label = T.el('label'), input = T.el('input'); input.type = 'checkbox'; input.value = g; label.appendChild(input); label.appendChild(document.createTextNode(g)); $('genres').appendChild(label); });
  Promise.all([api('/api/me'), api('/api/buybox').catch(function () { $('load').textContent = 'Saved preferences unavailable. You can still match games; sign in to save answers.'; return null; }), api('/api/watch').catch(function () { return { rows: [] }; })]).then(function (all) {
    if (!window.BR || !Array.isArray(BR.BOARD) || !window.HX) throw new Error('Board data unavailable. Refresh the page or check your access.');
    member = Boolean(all[0].email && all[0].access === 'active');
    $('save').disabled = !all[0].email || !all[1];
    saved = all[1] && all[1].box || {};
    fields.forEach(function (key) { if (saved[key] != null) form.elements[key].value = saved[key]; });
    if (!form.elements.deal.value) form.elements.deal.value = 'either';
    $('genres').querySelectorAll('input').forEach(function (i) { i.checked = (saved.genres || []).includes(i.value); });
    (all[2].rows || []).forEach(function (r) { watched.add(Number(r.uid)); });
    if (all[1]) $('load').textContent = all[0].email ? 'Your saved buyer preferences are loaded. Changes are saved only if you choose to save them.' : 'Try matching games. Sign in to save preferences and games.';
    form.hidden = false; showStep();
  }).catch(function (err) { $('load').textContent = err.message; });
})();
