'use strict';

const API = window.LEAGUE_API_URL;
const HOUR = 3600 * 1000, DAY = 24 * HOUR;
const COLOURS = ['Yellow', 'Green', 'Brown', 'Blue', 'Pink', 'Black'];
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, session) { try { return (session ? sessionStorage : localStorage).getItem(k) || ''; } catch { return ''; } },
  set(k, v, session) { try { (session ? sessionStorage : localStorage).setItem(k, v); } catch { /* ignore */ } }
};

let state = null;
let me = store.get('leagueMe');
let adminPin = store.get('leagueAdmin', true);
let tab = store.get('leagueTab');
let seasonId = new URLSearchParams(location.search).get('season') || '';
let adminCache = null;

const dateOf = d => new Date(d + 'T12:00:00Z');
const fmtDay = d => dateOf(d).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const fmtLong = d => dateOf(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const fmtTime = t => new Date(t).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });
const pinField = (label = 'Your 4-digit PIN', name = 'pin') =>
  `<label>${label}<input name="${name}" type="password" inputmode="numeric" pattern="\\d{4}" maxlength="4" required autocomplete="off"></label>`;
const today = () => new Date().toISOString().slice(0, 10);

/* ---------- Server ---------- */

async function load() {
  if (!API) throw new Error('The league is not connected yet. Add the web app URL to config.js.');
  const r = await fetch(API + '?season=' + encodeURIComponent(seasonId));
  const j = await r.json();
  if (!j.ok) throw new Error(j.error);
  setState(j.state);
}

async function post(body) {
  let j;
  try {
    const r = await fetch(API, { method: 'POST', body: JSON.stringify(Object.assign({ seasonId: state?.season?.id }, body)) });
    j = await r.json();
  } catch {
    throw new Error('Could not reach the league. Check your connection and try again.');
  }
  if (j.state) setState(j.state);
  if (!j.ok) throw new Error(j.error);
  return j;
}

function setState(s) {
  state = s;
  seasonId = s.season ? s.season.id : '';
  if (location.hash.startsWith('#admin')) renderAdmin(); else render();
}

/* ---------- Modal ---------- */

function modal({ title, body, ok = 'OK', cancel = 'Cancel', onOk, wide }) {
  const d = $('#modal');
  d.style.width = wide ? 'min(640px, calc(100vw - 32px))' : '';
  d.innerHTML = `<form novalidate><h3>${esc(title)}</h3><div>${body}</div><p class="err"></p>
    <div class="actions">${cancel ? `<button type="button" class="secondary" data-close>${cancel}</button>` : ''}
    ${ok ? `<button class="primary">${ok}</button>` : ''}</div></form>`;
  const form = d.querySelector('form'), err = d.querySelector('.err');
  d.querySelectorAll('[data-close]').forEach(b => { b.onclick = () => d.close(); });
  form.onsubmit = async e => {
    e.preventDefault();
    if (!form.reportValidity()) return;
    if (!onOk) return d.close();
    const btn = form.querySelector('.primary');
    btn.disabled = true;
    err.textContent = '';
    try {
      const next = await onOk(new FormData(form), form);
      d.close();
      if (typeof next === 'function') next();
    } catch (x) {
      err.textContent = x.message;
    } finally {
      btn.disabled = false;
    }
  };
  d.showModal();
  const first = d.querySelector('input, select, textarea');
  if (first) first.focus();
  return form;
}

const notice = (title, body) => modal({ title, body, ok: 'Close', cancel: '' });

/* ---------- League maths ---------- */

const player = id => state.players.find(p => p.id === id);
const nameOf = id => player(id)?.name || '?';
const FINAL = { id: 'final', name: 'Play-off final', colour: 'black', playerIds: [], withdrawn: [] };
const divOf = id => (id === 'final' ? FINAL : state.divisions.find(d => d.id === id));
const finalFx = () => state.fixtures.find(f => f.divisionId === 'final');
const finalNames = f => f.homeId ? [nameOf(f.homeId), nameOf(f.awayId)] : state.divisions.slice(0, 2).map(d => d.name.replace(' Division', '') + ' winner');
const weekOf = n => state.season.weeks.find(w => w.n === n);
const isOver = () => state.season?.status !== 'active';
const opponent = (f, id) => (f.homeId === id ? f.awayId : f.homeId);

function standings(div) {
  const s = state.settings, rows = {};
  div.playerIds.forEach(id => { rows[id] = { id, p: 0, w: 0, l: 0, f: 0, a: 0, pts: 0, form: [], gone: div.withdrawn.includes(id) }; });
  state.fixtures.filter(f => f.divisionId === div.id && f.status === 'confirmed')
    .sort((x, y) => (x.confirmedAt || '').localeCompare(y.confirmedAt || ''))
    .forEach(f => {
      [[f.homeId, f.homeFrames, f.awayFrames], [f.awayId, f.awayFrames, f.homeFrames]].forEach(([id, mine, theirs]) => {
        const r = rows[id];
        if (!r) return;
        const won = mine > theirs;
        r.p++; r.f += mine; r.a += theirs;
        r[won ? 'w' : 'l']++;
        r.pts += mine * s.pointsPerFrame + (won ? s.pointsPerWin : 0);
        r.form.push(won ? 'W' : 'L');
      });
    });
  return Object.values(rows).sort((x, y) => (x.gone - y.gone) || (y.pts - x.pts) || ((y.f - y.a) - (x.f - x.a)) ||
    (y.w - x.w) || (y.f - x.f) || nameOf(x.id).localeCompare(nameOf(y.id)));
}

function currentWeek() {
  const t = today(), w = state.season?.weeks || [];
  return w.find(x => x.date <= t && t < new Date(dateOf(x.date).getTime() + 7 * DAY).toISOString().slice(0, 10));
}

/* ---------- Player view ---------- */

function render() {
  $('#adminView').hidden = true;
  $('#playerView').hidden = false;
  $('#ladderLink').href = window.LADDER_URL;
  const s = state.season;

  $('#seasonPick').innerHTML = state.seasons.length
    ? state.seasons.map(x => `<option value="${x.id}" ${s && x.id === s.id ? 'selected' : ''}>${esc(x.name)}${x.status === 'archived' ? ' (finished)' : ''}</option>`).join('')
    : '<option>No seasons yet</option>';
  if (!s) {
    $('#seasonName').textContent = '';
    $('#division').innerHTML = '<p class="muted">The first season has not been set up yet.</p>';
    $('#meBar').hidden = true;
    return;
  }
  $('#seasonName').textContent = s.name;
  document.title = s.name + ' – Snooker League';
  const w = s.weeks;
  $('#seasonDates').textContent = w.length ? `w/c ${fmtLong(w[0].date)} – w/c ${fmtLong(w[w.length - 1].date)}` : '';
  $('#banner').innerHTML = isOver() ? `<div class="banner">${esc(s.name)} has finished. These are the final tables and results.</div>` : '';

  const inSeason = state.players.filter(p => state.divisions.some(d => d.playerIds.includes(p.id) && !d.withdrawn.includes(p.id)))
    .sort((a, b) => a.name.localeCompare(b.name));
  $('#meBar').hidden = isOver();
  if (me && !inSeason.some(p => p.id === me)) me = isOver() ? me : '';
  $('#me').innerHTML = '<option value="">Choose your name…</option>' +
    inSeason.map(p => `<option value="${p.id}" ${p.id === me ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
  $('#meHint').textContent = me ? 'Your matches are shown below and highlighted in blue. Your PIN is only needed to enter or confirm a score.'
    : 'Choose your name to see your matches and enter scores. Anyone can view the tables and fixtures.';

  renderMine();
  renderPending();
  renderTabs();
  renderRules();
}

function scoreText(f) {
  return `${esc(nameOf(f.homeId))} <b>${f.homeFrames}–${f.awayFrames}</b> ${esc(nameOf(f.awayId))}`;
}

function statusLine(f) {
  if (f.status === 'pending') return `Entered by ${esc(f.enteredBy === 'admin' ? 'Adam' : nameOf(f.enteredBy))}, awaiting confirmation`;
  if (f.status === 'disputed') return '<span class="warn">Disputed. Adam will sort it out, or enter the correct score.</span>';
  if (f.status === 'void') return 'Does not count (player withdrew)';
  return '';
}

function renderMine() {
  const mine = me && !isOver() ? state.fixtures.filter(f => f.homeId === me || f.awayId === me) : [];
  $('#mineSection').hidden = !mine.length;
  if (!mine.length) return;
  const todo = mine.filter(f => f.status !== 'confirmed' && f.status !== 'void').sort((a, b) => a.week - b.week);
  const done = mine.filter(f => f.status === 'confirmed').length;
  const div = divOf((mine.find(f => f.divisionId !== 'final') || mine[0]).divisionId);
  const cw = currentWeek();
  const cards = todo.map(f => {
      const wk = weekOf(f.week), opp = player(opponent(f, me));
      const late = cw && wk && wk.date < cw.date && !f.status;
      let actions = '';
      if (f.status === 'pending' && f.enteredBy !== me) {
        actions = `<button class="primary" data-act="confirm" data-id="${f.id}">Confirm</button>
          <button class="danger" data-act="dispute" data-id="${f.id}">Dispute</button>`;
      } else {
        actions = `<button class="${f.status ? 'secondary' : 'primary'}" data-act="score" data-id="${f.id}">${f.status ? 'Correct score' : 'Enter score'}</button>`;
      }
      if (opp?.phone) actions += ` <a class="btn whatsapp" target="_blank" rel="noopener" href="https://wa.me/${esc(opp.phone)}?text=${encodeURIComponent(`Hi ${opp.name.split(' ')[0]}, when shall we play our league match?`)}">WhatsApp</a>`;
      return `<article class="card d-${div.colour} ${f.status}" style="border-left-color:var(--div-bar)">
        <div class="vs">${f.status ? scoreText(f) : `${esc(nameOf(f.homeId))} <small>v</small> ${esc(nameOf(f.awayId))}`}</div>
        <div class="muted">${f.divisionId === 'final' ? '<b>Play-off final</b> · ' : ''}Week ${f.week}${wk ? ` · w/c ${fmtDay(wk.date)}` : ''}${late ? ' · <span class="warn">catch-up needed</span>' : ''}</div>
        ${f.status ? `<div>${statusLine(f)}</div>` : ''}
        <div class="actions">${actions}</div></article>`;
    });
  $('#mine').innerHTML = `<p class="muted">${done} of ${mine.length - mine.filter(f => f.status === 'void').length} played and confirmed.</p>` +
    cards.slice(0, 3).join('') + (cards.length > 3 ? `<details><summary class="link" style="cursor:pointer">Show my other ${cards.length - 3} matches</summary>${cards.slice(3).join('')}</details>` : '');
}

function renderPending() {
  const list = state.fixtures.filter(f => f.status === 'pending' || f.status === 'disputed');
  $('#pendingSection').hidden = !list.length || isOver();
  $('#pending').innerHTML = list.map(f => `<article class="card ${f.status}">
      <div class="vs">${scoreText(f)} <span class="pill d-${divOf(f.divisionId).colour}">${esc(divOf(f.divisionId).name)}</span></div>
      <div class="muted">${statusLine(f)}${f.enteredAt ? ' · ' + fmtTime(f.enteredAt) : ''}</div></article>`).join('');
}

function renderTabs() {
  const divs = state.divisions;
  if (!divs.some(d => d.id === tab)) tab = divs[0]?.id || '';
  $('#tabs').innerHTML = divs.length > 1 ? divs.map(d =>
    `<button class="d-${d.colour} ${d.id === tab ? 'on' : ''}" data-tab="${d.id}">${esc(d.name)}</button>`).join('') : '';
  const div = divOf(tab);
  if (!div) { $('#division').innerHTML = ''; return; }
  const s = state.settings, cw = currentWeek();
  const rows = standings(div);
  const table = `<div class="table-wrap standings"><table>
    <thead><tr><th>#</th><th>Player</th><th class="n">P</th><th class="n">W</th><th class="n">L</th>
      <th class="n wide-only">F</th><th class="n wide-only">A</th><th class="n">+/−</th><th class="n">Pts</th><th class="wide-only">Form</th></tr></thead>
    <tbody>${rows.map((r, i) => `<tr class="${r.id === me ? 'is-me' : ''} ${r.gone ? 'gone' : ''}">
      <td><span class="pos">${r.gone ? '–' : i + 1}</span></td><td>${esc(nameOf(r.id))}${r.gone ? ' <small>(withdrawn)</small>' : ''}</td>
      <td class="n">${r.p}</td><td class="n">${r.w}</td><td class="n">${r.l}</td>
      <td class="n wide-only">${r.f}</td><td class="n wide-only">${r.a}</td><td class="n">${r.f - r.a > 0 ? '+' : ''}${r.f - r.a}</td>
      <td class="pts">${r.pts}</td><td class="wide-only"><span class="form">${r.form.slice(-5).map(x => `<i class="${x}">${x}</i>`).join('')}</span></td></tr>`).join('')}
    </tbody></table></div>
    <p class="muted" style="font-size:.85rem">${s.pointsPerFrame} point per frame won and ${s.pointsPerWin} points for winning the match. Only confirmed results count.</p>`;

  const fixtures = state.fixtures.filter(f => f.divisionId === div.id);
  const lastWeek = Math.max(0, ...fixtures.map(f => f.week));
  const weeks = state.season.weeks.filter(w => w.type !== 'play' || w.n <= lastWeek);
  const weekCards = weeks.map(w => {
    const now = cw && cw.date === w.date && !isOver() ? ' now' : '';
    if (w.type === 'break') return `<div class="week off${now}"><h4><span>No matches</span><span>w/c ${fmtDay(w.date)}</span></h4><p>${esc(w.label)}</p></div>`;
    if (w.type === 'final') {
      const f = finalFx();
      const body = f && f.homeId ? fxRow(f) : `<div class="fx"><span class="h">${esc(finalNames(f || {})[0])}</span><span class="sc vs">v</span><span>${esc(finalNames(f || {})[1])}</span></div>`;
      return `<div class="week final${now}"><h4><span>🏆 Play-off final</span><span>w/c ${fmtDay(w.date)}</span></h4>${body}</div>`;
    }
    if (w.type === 'catchup' || w.n > lastWeek) return `<div class="week off${now}"><h4><span>Week ${w.n}</span><span>w/c ${fmtDay(w.date)}</span></h4><p>Catch-up week</p></div>`;
    const list = fixtures.filter(f => f.week === w.n);
    const playing = new Set(list.flatMap(f => [f.homeId, f.awayId]));
    const bye = div.playerIds.filter(id => !playing.has(id) && !div.withdrawn.includes(id));
    return `<div class="week${now}"><h4><span>Week ${w.n}${now ? ' · this week' : ''}</span><span>w/c ${fmtDay(w.date)}</span></h4>
      ${list.map(fxRow).join('')}${bye.length ? `<p>Bye: ${bye.map(id => esc(nameOf(id))).join(', ')}</p>` : ''}</div>`;
  }).join('');

  $('#division').innerHTML = `<div class="d-${div.colour}"><h2 class="div-title">${esc(div.name)}</h2>${table}
    <h2 class="div-title" style="margin-top:20px">Fixtures and results</h2>
    <p class="muted" style="font-size:.85rem">Matches can be played any time; the week is a guide. The player on the left is the home player.${me && !isOver() ? ' Tap one of your matches to enter its score.' : ''}</p>
    <div class="weeks">${weekCards}</div></div>`;
}

function fxRow(f) {
  const played = f.homeFrames !== null && f.status !== '';
  const hw = played && f.homeFrames > f.awayFrames, aw = played && f.awayFrames > f.homeFrames;
  const mine = me && (f.homeId === me || f.awayId === me);
  const tag = f.status === 'pending' ? '<span class="st pending">to confirm</span>' : f.status === 'disputed' ? '<span class="st disputed">disputed</span>' : '';
  const inner = `<span class="h ${hw ? 'won' : ''}">${esc(nameOf(f.homeId))}</span>
    <span class="sc ${played ? '' : 'vs'}">${played ? `${f.homeFrames}–${f.awayFrames}` : 'v'}${tag}</span>
    <span class="${aw ? 'won' : ''}">${esc(nameOf(f.awayId))}</span>`;
  const cls = `fx${mine ? ' mine' : ''}${f.status === 'void' ? ' void' : ''}`;
  return mine && !isOver() && f.status !== 'confirmed' && f.status !== 'void'
    ? `<button class="${cls}" data-act="${f.status === 'pending' && f.enteredBy !== me ? 'confirm' : 'score'}" data-id="${f.id}">${inner}</button>`
    : `<div class="${cls}">${inner}</div>`;
}

function renderRules() {
  const s = state.settings, n = s.framesPerMatch;
  $('#rulesList').innerHTML = [
    'You play everyone in your division twice: once as the home player (on the left) and once as the away player.',
    `Each match is ${n} frames and all ${n} frames are played.`,
    `You get <b>${s.pointsPerFrame} point for each frame</b> you win and <b>${s.pointsPerWin} extra points for winning the match</b>.`,
    'Ties in the table are split by frame difference, then matches won, then frames won.',
    'Fixtures are shown week by week as a guide. Arrange the match with your opponent; you can play it early or catch up later.',
    'After the match, either player chooses their name, taps the match and enters the score with their PIN.',
    `The other player then confirms it (or Adam does). ${s.autoConfirmHours ? `If nobody disputes it, it is confirmed automatically after ${s.autoConfirmHours} hours.` : ''} Only confirmed results count in the table.`,
    'If a score is wrong, dispute it or enter the correct score. Once confirmed, only Adam can change it.',
    'If a player withdraws, all of their matches are removed from the table.'
  ].map(x => `<li>${x}</li>`).join('');
}

/* ---------- Player actions ---------- */

function scoreOptions(f) {
  const n = state.settings.framesPerMatch, out = [];
  for (let h = n; h >= 0; h--) if (h !== n - h) out.push([h, n - h]);
  return out.map(([h, a], i) => `<label><input type="radio" name="score" value="${h}-${a}" required ${i === 0 ? '' : ''}>
    ${esc(nameOf(f.homeId))} <b>${h}–${a}</b> ${esc(nameOf(f.awayId))}</label>`).join('');
}

function enterScore(f) {
  modal({
    title: 'Enter score',
    body: `<p class="muted">Week ${f.week}: ${esc(nameOf(f.homeId))} (home) v ${esc(nameOf(f.awayId))} (away)</p>
      <fieldset class="score-opts"><legend>Frames won</legend>${scoreOptions(f)}</fieldset>${pinField()}`,
    ok: 'Submit score',
    onOk: async fd => {
      const [h, a] = String(fd.get('score') || '').split('-');
      if (h === undefined || a === undefined) throw new Error('Please choose the score.');
      await post({ action: 'result', playerId: me, pin: fd.get('pin'), fixtureId: f.id, homeFrames: h, awayFrames: a });
      return () => notice('Score entered', `<p>Thanks. ${esc(nameOf(opponent(f, me)))} (or Adam) now needs to confirm it.</p>`);
    }
  });
}

function confirmScore(f) {
  modal({
    title: 'Confirm result',
    body: `<p>${scoreText(f)}</p><p class="muted">Entered by ${esc(nameOf(f.enteredBy))}.</p>${pinField()}`,
    ok: 'Confirm',
    onOk: fd => post({ action: 'confirm', playerId: me, pin: fd.get('pin'), fixtureId: f.id })
  });
}

function disputeScore(f) {
  modal({
    title: 'Dispute result',
    body: `<p>${scoreText(f)}</p><p>Adam will be asked to sort it out. You can also enter the correct score afterwards.</p>${pinField()}`,
    ok: 'Dispute',
    onOk: fd => post({ action: 'dispute', playerId: me, pin: fd.get('pin'), fixtureId: f.id })
  });
}

document.addEventListener('click', e => {
  const b = e.target.closest('[data-act]');
  if (b && !$('#playerView').hidden) {
    const f = state.fixtures.find(x => x.id === b.dataset.id);
    if (!f) return;
    ({ score: enterScore, confirm: confirmScore, dispute: disputeScore })[b.dataset.act]?.(f);
  }
  const t = e.target.closest('[data-tab]');
  if (t) { tab = t.dataset.tab; store.set('leagueTab', tab); renderTabs(); }
});

$('#me').onchange = e => { me = e.target.value; store.set('leagueMe', me); render(); };
$('#seasonPick').onchange = e => {
  seasonId = e.target.value;
  history.replaceState(null, '', seasonId === state.currentId ? location.pathname : '?season=' + seasonId);
  load().catch(x => notice('Problem', esc(x.message)));
};
$('#changePin').onclick = () => {
  if (!me) return notice('Change my PIN', '<p>Choose your name first.</p>');
  modal({
    title: 'Change my PIN',
    body: pinField('Current PIN') + pinField('New 4-digit PIN', 'newPin'),
    ok: 'Change PIN',
    onOk: async fd => {
      await post({ action: 'changePin', playerId: me, pin: fd.get('pin'), newPin: fd.get('newPin') });
      return () => notice('PIN changed', '<p>Your new PIN is ready to use.</p>');
    }
  });
};

/* ---------- Admin ---------- */

async function adminCall(body) {
  const j = await post(Object.assign({ adminPin }, body));
  return j;
}

async function renderAdmin() {
  $('#playerView').hidden = true;
  const v = $('#adminView');
  v.hidden = false;
  if (!adminPin) {
    v.innerHTML = `<div class="panel"><h2>Admin</h2><form id="adminLogin"><label>Admin PIN
      <input name="pin" type="password" inputmode="numeric" required autocomplete="off"></label>
      <p class="err"></p><button class="primary">Log in</button> <a href="#">Back to the league</a></form></div>`;
    $('#adminLogin').onsubmit = async e => {
      e.preventDefault();
      try {
        adminPin = new FormData(e.target).get('pin');
        await adminCall({ action: 'adminLogin' });
        store.set('leagueAdmin', adminPin, true);
        adminCache = null;
        renderAdmin();
      } catch (x) {
        adminPin = '';
        e.target.querySelector('.err').textContent = x.message;
      }
    };
    return;
  }
  if (!adminCache) {
    try { adminCache = await adminCall({ action: 'adminData' }); }
    catch (x) { adminPin = ''; store.set('leagueAdmin', '', true); return renderAdmin(); }
  }
  const a = adminCache, s = state.season;
  v.innerHTML = `
    <div class="top-bar"><h2>League admin</h2><span><a href="#">Back to the league</a> · <button class="secondary sm" id="logout">Log out</button></span></div>

    <div class="panel"><h3>Seasons</h3>
      <div class="table-wrap"><table><tr><th>Season</th><th>Starts</th><th>Status</th><th></th></tr>
      ${state.seasons.map(x => `<tr><td>${esc(x.name)}</td><td>${fmtDay(x.startDate)} ${x.startDate.slice(0, 4)}</td><td>${x.status === 'active' ? 'Running' : 'Finished (archived)'}</td>
        <td><div class="actions"><button class="sm secondary" data-a="view" data-id="${x.id}">Manage</button>
        <button class="sm secondary" data-a="archive" data-id="${x.id}">${x.status === 'active' ? 'Finish and archive' : 'Reopen'}</button>
        <button class="sm danger" data-a="delSeason" data-id="${x.id}">Delete</button></div></td></tr>`).join('') || '<tr><td colspan="4" class="muted">No seasons yet.</td></tr>'}
      </table></div>
      <p><button class="primary" id="newSeason">Set up a new season</button></p>
    </div>

    ${s ? `<div class="panel"><h3>${esc(s.name)}: results</h3>
      <p class="muted">Results needing attention are listed first. Setting a score here confirms it straight away.</p>
      <label>Show <select id="fxFilter"><option value="todo">Needs confirming or disputed</option><option value="open">Not yet played</option><option value="all">All matches</option></select></label>
      <div id="fxAdmin" class="table-wrap" style="margin-top:10px"></div></div>

    <div class="panel"><h3>${esc(s.name)}: divisions</h3>
      ${state.divisions.map(d => `<p><b class="d-${d.colour}" style="color:var(--div)">${esc(d.name)}</b><br>${d.playerIds.map(id => {
        const out = d.withdrawn.includes(id);
        return `${out ? '<s>' : ''}${esc(nameOf(id))}${out ? '</s>' : ''} <button class="sm ${out ? 'secondary' : 'danger'}" data-a="withdraw" data-div="${d.id}" data-id="${id}" data-back="${out ? 1 : ''}">${out ? 'Reinstate' : 'Withdraw'}</button>`;
      }).join(' · ')}</p>`).join('')}
    </div>` : ''}

    <div class="panel"><h3>Players</h3>
      <div class="table-wrap"><table><tr><th>Name</th><th>PIN</th><th>Mobile</th><th>Alert topic</th><th></th></tr>
      ${a.players.map(p => `<tr><td>${esc(p.name)}</td><td><code>${esc(p.pin)}</code>${p.onLadder ? ' <small class="muted">ladder</small>' : ''}</td><td>${esc(p.phone)}</td><td><code>${esc(p.ntfy)}</code></td>
        <td><div class="actions"><button class="sm secondary" data-a="edit" data-id="${p.id}">Edit</button>
        <button class="sm secondary" data-a="pin" data-id="${p.id}">New PIN</button>
        <button class="sm danger" data-a="remove" data-id="${p.id}">Remove</button></div></td></tr>`).join('') || '<tr><td colspan="5" class="muted">Players are added when you set up a season, or here.</td></tr>'}
      </table></div>
      <p><button class="secondary" id="addPlayer">Add a player</button></p>
    </div>

    <div class="panel"><h3>Settings</h3><form id="settings" class="form-grid">
      <label>Frames per match<input name="framesPerMatch" type="number" min="1" max="21" value="${esc(a.settings.framesPerMatch)}"></label>
      <label>Points per frame won<input name="pointsPerFrame" type="number" min="0" max="10" value="${esc(a.settings.pointsPerFrame)}"></label>
      <label>Points for a match win<input name="pointsPerWin" type="number" min="0" max="10" value="${esc(a.settings.pointsPerWin)}"></label>
      <label>Auto-confirm after (hours, 0 = never)<input name="autoConfirmHours" type="number" min="0" max="720" value="${esc(a.settings.autoConfirmHours)}"></label>
      <label>Ladder Google Sheet ID (shares PINs)<input name="ladderSheetId" value="${esc(a.settings.ladderSheetId || '')}"></label>
      <label>League site address<input name="siteUrl" value="${esc(a.settings.siteUrl)}" placeholder="https://…/league.html"></label>
      <label>New admin PIN (optional)<input name="newAdminPin" type="password" inputmode="numeric" autocomplete="off"></label>
      <button class="primary">Save settings</button></form><p class="err" id="setErr"></p></div>

    <div class="panel"><h3>Activity log</h3><div class="log">${a.log.map(l => `<div><b>${fmtTime(l.time)}</b> ${esc(l.event)}</div>`).join('')}</div></div>`;

  if (s) { $('#fxFilter').onchange = renderFxAdmin; renderFxAdmin(); }
  $('#logout').onclick = () => { adminPin = ''; store.set('leagueAdmin', '', true); location.hash = ''; };
  $('#newSeason').onclick = newSeasonForm;
  $('#addPlayer').onclick = () => modal({
    title: 'Add a player',
    body: '<label>Name<input name="name" required></label><label>Mobile (optional)<input name="phone" inputmode="tel"></label>',
    ok: 'Add',
    onOk: async fd => {
      const j = await adminCall({ action: 'adminAddPlayer', name: fd.get('name'), phone: fd.get('phone') });
      adminCache = null;
      return () => { renderAdmin(); notice('Player added', `<p>Their PIN is:</p><p class="big-pin">${esc(j.pin)}</p>`); };
    }
  });
  $('#settings').onsubmit = async e => {
    e.preventDefault();
    try {
      await adminCall(Object.assign({ action: 'adminSettings' }, Object.fromEntries(new FormData(e.target))));
      adminCache = null;
      renderAdmin();
    } catch (x) { $('#setErr').textContent = x.message; }
  };
}

function renderFxAdmin() {
  const mode = $('#fxFilter').value;
  const list = state.fixtures.filter(f => mode === 'all' || f.divisionId === 'final' ? true : mode === 'open' ? !f.status : f.status === 'pending' || f.status === 'disputed')
    .sort((x, y) => x.week - y.week || divOf(x.divisionId).name.localeCompare(divOf(y.divisionId).name));
  $('#fxAdmin').innerHTML = list.length ? `<table><tr><th>Wk</th><th>Division</th><th>Home</th><th>Score</th><th>Away</th><th>Status</th><th></th></tr>
    ${list.map(f => `<tr><td>${f.week}</td><td>${esc(divOf(f.divisionId).name.replace(' Division', ''))}</td><td>${esc(f.homeId ? nameOf(f.homeId) : finalNames(f)[0])}</td>
      <td>${f.homeFrames !== null ? `${f.homeFrames}–${f.awayFrames}` : ''}</td><td>${esc(f.awayId ? nameOf(f.awayId) : finalNames(f)[1])}</td>
      <td>${f.status || 'not played'}</td>
      <td><div class="actions">${f.divisionId === 'final' ? `<button class="sm secondary" data-a="finalists" data-id="${f.id}">Choose finalists</button>` : ''}
      ${f.homeId ? `<button class="sm primary" data-a="setScore" data-id="${f.id}">Set score</button>` : ''}
      ${f.status === 'pending' || f.status === 'disputed' ? `<button class="sm secondary" data-a="confirm" data-id="${f.id}">Confirm</button>` : ''}
      ${f.status && f.status !== 'void' ? `<button class="sm danger" data-a="clear" data-id="${f.id}">Clear</button>` : ''}</div></td></tr>`).join('')}</table>`
    : '<p class="muted">Nothing to show.</p>';
}

function newSeasonForm() {
  const last = state.season;
  const nextSunday = (() => { const d = new Date(); d.setDate(d.getDate() + ((7 - d.getDay()) % 7)); return d.toISOString().slice(0, 10); })();
  const form = modal({
    title: 'Set up a new season',
    wide: true,
    body: `<label>Season name<input name="name" required placeholder="Winter 2026-27"></label>
      <label>Start date (the Sunday of the first week)<input name="startDate" type="date" required value="${nextSunday}"></label>
      <label>Player names, one per line (top division first)<textarea name="names" rows="10" required style="width:100%;font:inherit"></textarea></label>
      ${last ? '<p><button type="button" class="secondary sm" id="copyLast">Copy players and divisions from the season shown</button></p>' : ''}
      <div class="form-grid">
        <label>Number of divisions<select name="divCount">${COLOURS.map((c, i) => `<option value="${i + 1}">${i + 1}</option>`).join('')}</select></label>
        <label>Catch-up weeks at the end<input name="catchUp" type="number" min="0" max="6" value="1"></label>
        <label><span><input name="final" type="checkbox" checked> Play-off final between the Yellow and Green winners</span></label>
      </div>
      <div id="sizes" class="form-grid"></div>
      <label>Weeks with no matches (optional): one per line, the Sunday date then a note<textarea name="breaks" rows="3" style="width:100%;font:inherit" placeholder="2026-12-20 Christmas\n2026-12-27 New Year"></textarea></label>
      <div id="preview" class="panel" style="margin:10px 0"></div>`,
    ok: 'Create season and fixtures',
    onOk: async fd => {
      const p = plan(fd);
      if (p.error) throw new Error(p.error);
      const j = await adminCall({ action: 'adminCreateSeason', name: fd.get('name'), startDate: fd.get('startDate'),
        catchUp: fd.get('catchUp'), final: !!fd.get('final'), breaks: fd.get('breaks'), divisions: p.divs });
      seasonId = j.seasonId;
      adminCache = null;
      return () => {
        renderAdmin();
        notice('Season created', j.newPins.length
          ? `<p>These new players have been given PINs. Send each one their PIN privately.</p><table>${j.newPins.map(x => `<tr><td>${esc(x.name)}</td><td><b>${esc(x.pin)}</b></td></tr>`).join('')}</table>`
          : '<p>All the players already had PINs.</p>');
      };
    }
  });

  const sizes = form.querySelector('#sizes');
  const names = () => form.names.value.split('\n').map(x => x.trim()).filter(Boolean);
  const drawSizes = (preset) => {
    const n = Number(form.divCount.value), total = names().length;
    sizes.innerHTML = Array.from({ length: n }, (_, i) => {
      const v = preset ? preset[i] : Math.floor(total / n) + (i < total % n ? 1 : 0);
      return `<label class="d-${COLOURS[i].toLowerCase()}">${COLOURS[i]} players<input name="size${i}" type="number" min="2" value="${v || 2}"></label>`;
    }).join('');
    update();
  };
  const update = () => {
    const p = plan(new FormData(form));
    form.querySelector('#preview').innerHTML = p.error ? `<p class="err">${esc(p.error)}</p>` :
      p.divs.map((d, i) => `<p><b>${COLOURS[i]} Division</b> (${d.length} players, ${(d.length - (d.length % 2 ? 0 : 1)) * 2} weeks of matches): ${d.map(esc).join(', ')}</p>`).join('') +
      `<p>Last week: <b>w/c ${fmtLong(p.weeks[p.weeks.length - 1].date)}</b> (${p.weeks.length} weeks in all)</p>`;
  };
  form.divCount.onchange = () => drawSizes();
  form.names.oninput = () => drawSizes();
  form.addEventListener('input', e => { if (e.target !== form.names && e.target !== form.divCount) update(); });
  const copy = form.querySelector('#copyLast');
  if (copy) copy.onclick = () => {
    const ds = state.divisions.map(d => d.playerIds.filter(id => !d.withdrawn.includes(id) && player(id)?.active).map(nameOf));
    form.names.value = ds.flat().join('\n');
    form.divCount.value = String(ds.length);
    drawSizes(ds.map(d => d.length));
  };
  drawSizes();
}

// Splits the names into divisions and works out the weeks, to preview before creating.
function plan(fd) {
  const names = String(fd.get('names') || '').split('\n').map(x => x.trim()).filter(Boolean);
  const n = Number(fd.get('divCount')), sizes = Array.from({ length: n }, (_, i) => Number(fd.get('size' + i)) || 0);
  const start = fd.get('startDate');
  if (!names.length) return { error: 'Type or paste the player names.' };
  if (!start || dateOf(start).getUTCDay() !== 0) return { error: 'The start date must be a Sunday.' };
  if (sizes.some(x => x < 2)) return { error: 'Each division needs at least 2 players.' };
  const total = sizes.reduce((x, y) => x + y, 0);
  if (total !== names.length) return { error: `The division sizes add up to ${total} but there are ${names.length} names.` };
  const lower = names.map(x => x.toLowerCase());
  const dupe = names.find((x, i) => lower.indexOf(x.toLowerCase()) !== i);
  if (dupe) return { error: dupe + ' is listed twice.' };
  const breaks = String(fd.get('breaks') || '').split('\n').map(x => x.trim()).filter(Boolean).map(x => x.slice(0, 10));
  if (breaks.some(b => !/^\d{4}-\d{2}-\d{2}$/.test(b) || dateOf(b).getUTCDay() !== 0)) return { error: 'Each week with no matches must start with a Sunday date, e.g. 2026-12-27 Christmas.' };
  let k = 0;
  const divs = sizes.map(sz => names.slice(k, k += sz));
  const play = Math.max(...divs.map(d => (d.length % 2 ? d.length : d.length - 1) * 2));
  const total2 = play + (Number(fd.get('catchUp')) || 0) + (fd.get('final') && n > 1 ? 1 : 0), weeks = [];
  for (let t = dateOf(start).getTime(), c = 0; c < total2; t += 7 * DAY) {
    const date = new Date(t).toISOString().slice(0, 10);
    weeks.push({ date });
    if (!breaks.includes(date)) c++;
  }
  return { divs, weeks };
}

document.addEventListener('click', async e => {
  const b = e.target.closest('[data-a]');
  if (!b || $('#adminView').hidden) return;
  const id = b.dataset.id, f = state.fixtures.find(x => x.id === id);
  const p = adminCache?.players.find(x => x.id === id), season = state.seasons.find(x => x.id === id);
  const run = async (body, after) => {
    try { const j = await adminCall(body); adminCache = null; await renderAdmin(); if (after) after(j); }
    catch (x) { notice('Problem', `<p>${esc(x.message)}</p>`); }
  };
  switch (b.dataset.a) {
    case 'view': seasonId = id; return load();
    case 'archive':
      return modal({
        title: season.status === 'active' ? 'Finish and archive' : 'Reopen season',
        body: season.status === 'active' ? `<p>${esc(season.name)} will be marked as finished. The tables stay on the site for anyone to look back at, and players can no longer enter scores.</p>`
          : `<p>Reopen ${esc(season.name)} so scores can be entered again?</p>`,
        onOk: async () => { await adminCall({ action: 'adminArchiveSeason', seasonId: id, reopen: season.status !== 'active' }); adminCache = null; return renderAdmin; }
      });
    case 'delSeason':
      return modal({
        title: 'Delete season',
        body: `<p>This deletes <b>${esc(season.name)}</b> with all its fixtures and results. It cannot be undone. To keep it for looking back, use <b>Finish and archive</b> instead.</p>
          <label>Type the season name to confirm<input name="confirmName" required></label>`,
        ok: 'Delete',
        onOk: async fd => { await adminCall({ action: 'adminDeleteSeason', seasonId: id, confirmName: fd.get('confirmName') }); seasonId = ''; adminCache = null; await load(); }
      });
    case 'setScore':
      return modal({
        title: 'Set score',
        body: `<p class="muted">Week ${f.week}</p><div class="form-grid">
          <label>${esc(nameOf(f.homeId))} (home)<input name="h" type="number" min="0" required value="${f.homeFrames ?? ''}"></label>
          <label>${esc(nameOf(f.awayId))} (away)<input name="a" type="number" min="0" required value="${f.awayFrames ?? ''}"></label></div>`,
        ok: 'Save and confirm',
        onOk: async fd => { await adminCall({ action: 'adminResult', fixtureId: id, homeFrames: fd.get('h'), awayFrames: fd.get('a') }); adminCache = null; return renderAdmin; }
      });
    case 'finalists': {
      const lead = state.divisions.slice(0, 2).map(d => standings(d)[0]?.id);
      const opts = sel => state.players.filter(x => x.active).sort((x, y) => x.name.localeCompare(y.name))
        .map(x => `<option value="${x.id}" ${x.id === sel ? 'selected' : ''}>${esc(x.name)}</option>`).join('');
      return modal({
        title: 'Choose finalists',
        body: `<p class="muted">Filled in with the current division leaders.</p>
          <label>Home (left)<select name="h">${opts(f.homeId || lead[0])}</select></label>
          <label>Away (right)<select name="a">${opts(f.awayId || lead[1])}</select></label>`,
        ok: 'Save',
        onOk: async fd => { await adminCall({ action: 'adminSetFinal', fixtureId: id, homeId: fd.get('h'), awayId: fd.get('a') }); adminCache = null; return renderAdmin; }
      });
    }
    case 'confirm': return run({ action: 'adminConfirm', fixtureId: id });
    case 'clear':
      return modal({ title: 'Clear result', body: `<p>Clear the score for ${esc(nameOf(f.homeId))} v ${esc(nameOf(f.awayId))}?</p>`,
        onOk: async () => { await adminCall({ action: 'adminClearResult', fixtureId: id }); adminCache = null; return renderAdmin; } });
    case 'withdraw':
      return modal({
        title: b.dataset.back ? 'Reinstate player' : 'Withdraw player',
        body: b.dataset.back ? `<p>Reinstate ${esc(nameOf(id))}? Their matches will count again.</p>`
          : `<p>Withdraw ${esc(nameOf(id))} from this season? All their matches (played or not) will be removed from the table.</p>`,
        onOk: async () => { await adminCall({ action: 'adminWithdraw', divisionId: b.dataset.div, playerId: id, reinstate: !!b.dataset.back }); adminCache = null; return renderAdmin; }
      });
    case 'edit':
      return modal({
        title: 'Edit player',
        body: `<label>Name<input name="name" required value="${esc(p.name)}"></label>
          <label>Mobile<input name="phone" inputmode="tel" value="${esc(p.phone)}"></label>
          <label>Alert topic<input name="ntfy" value="${esc(p.ntfy)}"></label>
          <label>PIN (4 digits; you could match their ladder PIN)<input name="pin" inputmode="numeric" pattern="\\d{4}" maxlength="4" value="${esc(p.pin)}"></label>`,
        ok: 'Save',
        onOk: async fd => { await adminCall(Object.assign({ action: 'adminUpdatePlayer', id }, Object.fromEntries(fd))); adminCache = null; return renderAdmin; }
      });
    case 'pin': return run({ action: 'adminResetPin', id }, j => notice('New PIN', `<p>${esc(p.name)}'s new PIN is:</p><p class="big-pin">${esc(j.pin)}</p>`));
    case 'remove':
      return modal({ title: 'Remove player', body: `<p>Remove ${esc(p.name)} from the player list? Their past results are kept. To take them out of the current season, use <b>Withdraw</b> instead.</p>`,
        onOk: async () => { await adminCall({ action: 'adminRemovePlayer', id }); adminCache = null; return renderAdmin; } });
  }
});

/* ---------- Start ---------- */

window.addEventListener('hashchange', () => { if (state) setState(state); });
load().catch(x => { $('#division').innerHTML = `<p class="err">${esc(x.message)}</p>`; });
setInterval(() => { if (!document.hidden && !location.hash.startsWith('#admin')) load().catch(() => {}); }, 5 * 60 * 1000);
