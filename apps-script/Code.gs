/**
 * Patteson Social Club Snooker League – back end (Google Apps Script).
 *
 * 1. Create a Google Sheet, open Extensions > Apps Script and paste this file in.
 * 2. Run setup() once (it creates the tabs, settings and hourly timer).
 * 3. Deploy > New deployment > Web app (Execute as: Me, Who has access: Anyone).
 * See README.md for full instructions.
 */

// Optional: put a PIN here before running setup(). Leave blank for a random 6-digit PIN.
const ADMIN_PIN = '';

// The ladder's Google Sheet ID (the long code in its address). Players on both use their ladder PIN
// and alert topic for the league too, and changing a PIN on either site changes both.
const LADDER_SHEET_ID = '';

// Created by setup(). Names are in division order: the first 6 are Yellow, the next 6 Green.
const INITIAL_SEASON = {
  name: 'Winter 2026-27',
  startDate: '2026-11-22',
  divisions: [
    ['Adam Gibson', 'Sean Curtis', 'Steve Curtis', 'Jon Walker', 'Roberto Facchini', 'Stuart Curtis'],
    ['Robert Curtis', 'John Butler', 'Steve Cotten', 'Terry Lemmon', 'Kevin Knights', 'Jeff Smith']
  ],
  breaks: '2026-12-20 Christmas\n2026-12-27 New Year',
  catchUp: 1,
  final: true
};

const SHEETS = {
  Players: ['id', 'name', 'active', 'pin', 'phone', 'ntfy'],
  Seasons: ['id', 'name', 'startDate', 'status', 'weeks', 'createdAt', 'archivedAt'],
  Divisions: ['id', 'seasonId', 'order', 'name', 'colour', 'playerIds', 'withdrawn'],
  Fixtures: ['id', 'seasonId', 'divisionId', 'week', 'homeId', 'awayId', 'homeFrames', 'awayFrames',
    'status', 'enteredBy', 'enteredAt', 'confirmedBy', 'confirmedAt'],
  Settings: ['key', 'value'],
  Log: ['time', 'event']
};
const COLOURS = ['Yellow', 'Green', 'Brown', 'Blue', 'Pink', 'Black'];
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const TZ = 'Europe/London';

/* ---------- Setup and entry points ---------- */

function setup() {
  const ss = SpreadsheetApp.getActive();
  Object.keys(SHEETS).forEach(name => {
    const sh = ss.getSheetByName(name) || ss.insertSheet(name);
    sh.getRange('A:Z').setNumberFormat('@');
  });
  if (readTable('Settings').length) throw new Error('The league is already set up.');
  ['Players', 'Seasons', 'Divisions', 'Fixtures'].forEach(n => writeTable(n, []));
  writeTable('Settings', [
    { key: 'clubName', value: 'Patteson Social Club Snooker League' },
    { key: 'framesPerMatch', value: '3' },
    { key: 'pointsPerFrame', value: '1' },
    { key: 'pointsPerWin', value: '2' },
    { key: 'autoConfirmHours', value: '0' },
    { key: 'siteUrl', value: '' },
    { key: 'ladderSheetId', value: LADDER_SHEET_ID },
    { key: 'adminPin', value: ADMIN_PIN || randomPin(6) }
  ]);
  writeTable('Log', [{ time: iso(Date.now()), event: 'League set up' }]);
  if (INITIAL_SEASON) {
    const db = load();
    const out = createSeason(db, INITIAL_SEASON);
    save(db);
    Logger.log('Created ' + INITIAL_SEASON.name + '. League-only players and their PINs: ' +
      (out.newPins.map(x => x.name + ' ' + x.pin).join(', ') || 'none'));
  }
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('hourly').timeBased().everyHours(1).create();
  const sh = ss.getSheetByName('Sheet1');
  if (sh && ss.getSheets().length > 1) ss.deleteSheet(sh);
}

function hourly() {
  withLock(() => {
    const db = load();
    if (processDue(db)) save(db);
  });
}

function doGet(e) {
  return respond(() => {
    const db = load();
    if (processDue(db)) save(db);
    return { state: publicState(db, e && e.parameter && e.parameter.season) };
  });
}

function doPost(e) {
  return respond(() => {
    const req = JSON.parse(e.postData.contents);
    const action = ACTIONS[req.action];
    if (!action) fail('Unknown action.');
    const db = load();
    processDue(db);
    const result = action(db, req) || {};
    save(db);
    result.state = publicState(db, result.seasonId || req.seasonId);
    return result;
  });
}

function respond(fn) {
  let out;
  try {
    out = withLock(fn);
    out.ok = true;
  } catch (err) {
    out = { ok: false, error: err.message || String(err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function withLock(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

/* ---------- Actions ---------- */

const ACTIONS = {
  result(db, r) {
    const { me, fx, other } = party(db, r);
    if (fx.status === 'confirmed') fail('This result is already confirmed. Please ask Adam if it needs changing.');
    if (fx.status === 'void') fail('This match no longer counts.');
    const [h, a] = frames(db, r, false);
    Object.assign(fx, { homeFrames: h, awayFrames: a, status: 'pending', enteredBy: me.id, enteredAt: iso(Date.now()), confirmedBy: '', confirmedAt: '' });
    const text = `${nameOf(db, fx.homeId)} ${h}–${a} ${nameOf(db, fx.awayId)}`;
    log(db, `${me.name} entered ${text} (awaiting confirmation)`);
    notify(db, other, 'Please confirm your league result', `${me.name} entered ${text}. Please confirm or dispute it on the league site.`);
    return { seasonId: fx.seasonId };
  },

  confirm(db, r) {
    const { me, fx } = party(db, r);
    if (fx.status !== 'pending') fail('This result has changed. Please refresh the page.');
    if (fx.enteredBy === me.id) fail('Your opponent (or Adam) needs to confirm this result.');
    confirmFixture(db, fx, me.id, me.name);
    return { seasonId: fx.seasonId };
  },

  dispute(db, r) {
    const { me, fx, other } = party(db, r);
    if (fx.status !== 'pending') fail('This result has changed. Please refresh the page.');
    if (fx.enteredBy === me.id) fail('You entered this result. Enter it again if it needs correcting.');
    fx.status = 'disputed';
    log(db, `${me.name} disputed ${fixtureText(db, fx)}`);
    notify(db, other, 'League result disputed', `${me.name} disputed the score you entered. Adam will sort it out, or you can enter the correct score.`);
    return { seasonId: fx.seasonId };
  },

  changePin(db, r) {
    const me = auth(db, r.playerId, r.pin);
    if (!/^\d{4}$/.test(String(r.newPin))) fail('The new PIN must be 4 digits.');
    setPin(db, me, String(r.newPin));
    log(db, `${me.name} changed their PIN${link(db, me) ? ' (ladder PIN changed too)' : ''}`);
  },

  adminLogin(db, r) { admin(db, r); },

  adminData(db, r) {
    admin(db, r);
    const s = db.settings;
    return {
      players: db.players.filter(p => p.active).sort(byName).map(p => ({
        id: p.id, name: p.name, pin: pinOf(db, p), phone: p.phone, ntfy: topicOf(db, p), onLadder: !!link(db, p)
      })),
      settings: {
        siteUrl: s.siteUrl, ladderSheetId: s.ladderSheetId, framesPerMatch: s.framesPerMatch, pointsPerFrame: s.pointsPerFrame,
        pointsPerWin: s.pointsPerWin, autoConfirmHours: s.autoConfirmHours
      },
      log: readTable('Log').slice(-150).reverse()
    };
  },

  adminAddPlayer(db, r) {
    admin(db, r);
    const p = addPlayer(db, cleanName(r.name), cleanPhone(r.phone));
    log(db, `Admin added ${p.name}`);
    return { pin: p.pin };
  },

  adminUpdatePlayer(db, r) {
    admin(db, r);
    const p = findPlayer(db, r.id);
    const name = cleanName(r.name);
    if (db.players.some(x => x.active && x.id !== p.id && same(x.name, name))) fail('Another player already has that name.');
    p.name = name;
    p.phone = cleanPhone(r.phone);
    p.ntfy = String(r.ntfy || '').trim();
    if (r.pin) {
      if (!/^\d{4}$/.test(String(r.pin))) fail('A player PIN must be 4 digits.');
      if (String(r.pin) !== pinOf(db, p)) setPin(db, p, String(r.pin));
    }
    log(db, `Admin updated ${p.name}`);
  },

  adminResetPin(db, r) {
    admin(db, r);
    const p = findPlayer(db, r.id);
    setPin(db, p, randomPin(4));
    log(db, `Admin reset PIN for ${p.name}`);
    return { pin: p.pin };
  },

  adminRemovePlayer(db, r) {
    admin(db, r);
    const p = findPlayer(db, r.id);
    p.active = false;
    log(db, `Admin removed ${p.name} from the player list (past results are kept)`);
  },

  adminCreateSeason(db, r) {
    admin(db, r);
    return createSeason(db, r);
  },

  adminSetFinal(db, r) {
    admin(db, r);
    const fx = findFixture(db, r.fixtureId);
    if (fx.divisionId !== 'final') fail('This is not the final.');
    if (!r.homeId || !r.awayId || r.homeId === r.awayId) fail('Please choose two different players.');
    findPlayer(db, r.homeId); findPlayer(db, r.awayId);
    Object.assign(fx, { homeId: r.homeId, awayId: r.awayId });
    log(db, `Admin set the play-off final: ${nameOf(db, r.homeId)} v ${nameOf(db, r.awayId)}`);
    return { seasonId: fx.seasonId };
  },

  adminArchiveSeason(db, r) {
    admin(db, r);
    const s = findSeason(db, r.seasonId);
    s.status = r.reopen ? 'active' : 'archived';
    s.archivedAt = r.reopen ? '' : iso(Date.now());
    log(db, `Admin ${r.reopen ? 'reopened' : 'archived'} ${s.name}`);
    return { seasonId: s.id };
  },

  adminDeleteSeason(db, r) {
    admin(db, r);
    const s = findSeason(db, r.seasonId);
    if (String(r.confirmName || '').trim() !== s.name) fail('Type the season name exactly to delete it.');
    db.seasons = db.seasons.filter(x => x.id !== s.id);
    db.divisions = db.divisions.filter(x => x.seasonId !== s.id);
    db.fixtures = db.fixtures.filter(x => x.seasonId !== s.id);
    log(db, `Admin deleted ${s.name}`);
  },

  adminResult(db, r) {
    admin(db, r);
    const fx = findFixture(db, r.fixtureId);
    const [h, a] = frames(db, r, true);
    Object.assign(fx, { homeFrames: h, awayFrames: a, enteredBy: 'admin', enteredAt: iso(Date.now()) });
    confirmFixture(db, fx, 'admin', 'Adam');
    return { seasonId: fx.seasonId };
  },

  adminConfirm(db, r) {
    admin(db, r);
    const fx = findFixture(db, r.fixtureId);
    if (!['pending', 'disputed'].includes(fx.status)) fail('There is no result to confirm.');
    confirmFixture(db, fx, 'admin', 'Adam');
    return { seasonId: fx.seasonId };
  },

  adminClearResult(db, r) {
    admin(db, r);
    const fx = findFixture(db, r.fixtureId);
    Object.assign(fx, { homeFrames: '', awayFrames: '', status: '', enteredBy: '', enteredAt: '', confirmedBy: '', confirmedAt: '' });
    log(db, `Admin cleared the result of ${nameOf(db, fx.homeId)} v ${nameOf(db, fx.awayId)}`);
    return { seasonId: fx.seasonId };
  },

  adminWithdraw(db, r) {
    admin(db, r);
    const div = db.divisions.find(d => d.id === r.divisionId);
    if (!div) fail('Division not found.');
    const ids = list(div.withdrawn), back = !!r.reinstate;
    div.withdrawn = (back ? ids.filter(x => x !== r.playerId) : ids.concat(r.playerId)).join(',');
    db.fixtures.filter(f => f.divisionId === div.id && (f.homeId === r.playerId || f.awayId === r.playerId)).forEach(f => {
      if (back && f.status === 'void') f.status = f.homeFrames !== '' ? 'confirmed' : '';
      else if (!back) f.status = 'void';
    });
    log(db, `Admin ${back ? 'reinstated' : 'withdrew'} ${nameOf(db, r.playerId)} ${back ? 'in' : 'from'} ${div.name}${back ? '' : '; their matches no longer count'}`);
    return { seasonId: div.seasonId };
  },

  adminSettings(db, r) {
    admin(db, r);
    const s = db.settings;
    s.siteUrl = String(r.siteUrl || '').trim();
    s.ladderSheetId = String(r.ladderSheetId || '').trim().replace(/^.*\/d\/([^/]+).*$/, '$1');
    db.ladder = null;
    if (s.ladderSheetId && !ladder(db).length) fail('Could not read the ladder sheet. Check the ID.');
    [['framesPerMatch', 1, 21], ['pointsPerFrame', 0, 10], ['pointsPerWin', 0, 10], ['autoConfirmHours', 0, 720]].forEach(([k, lo, hi]) => {
      const n = parseInt(r[k], 10);
      if (isNaN(n) || n < lo || n > hi) fail(`${k} must be between ${lo} and ${hi}.`);
      s[k] = String(n);
    });
    if (r.newAdminPin) {
      if (!/^\d{4,8}$/.test(String(r.newAdminPin))) fail('The admin PIN must be 4–8 digits.');
      s.adminPin = String(r.newAdminPin);
    }
    log(db, 'Admin updated settings');
  }
};

/* ---------- League rules ---------- */

function createSeason(db, r) {
  const name = cleanName(r.name);
  if (db.seasons.some(s => same(s.name, name))) fail('There is already a season called ' + name + '.');
  const start = String(r.startDate || '');
  if (!isSunday(start)) fail('The start date must be a Sunday.');
  const breaks = parseBreaks(r.breaks);
  const divs = (r.divisions || []).map(d => (d || []).map(cleanName));
  if (!divs.length || divs.length > COLOURS.length) fail(`Please have between 1 and ${COLOURS.length} divisions.`);
  divs.forEach((d, i) => { if (d.length < 2) fail(`${COLOURS[i]} Division needs at least 2 players.`); });
  const all = [].concat.apply([], divs);
  all.forEach((n, i) => { if (all.findIndex(x => same(x, n)) !== i) fail(n + ' is listed twice.'); });

  const season = { id: uid(), name, startDate: start, status: 'active', createdAt: iso(Date.now()), archivedAt: '' };
  const newPins = [];
  const rounds = divs.map(names => {
    const ids = names.map(n => {
      let p = db.players.find(x => x.active && same(x.name, n));
      if (!p) {
        p = addPlayer(db, n, '');
        if (!link(db, p)) newPins.push({ name: p.name, pin: p.pin });
      }
      return p.id;
    });
    return { ids, rounds: doubleRoundRobin(ids) };
  });
  const playWeeks = Math.max.apply(null, rounds.map(x => x.rounds.length));
  const final = !!r.final && divs.length > 1;
  const weeks = buildWeeks(start, playWeeks, Math.max(0, parseInt(r.catchUp, 10) || 0), breaks, final);
  season.weeks = JSON.stringify(weeks);
  db.seasons.push(season);

  rounds.forEach((d, i) => {
    const div = { id: uid(), seasonId: season.id, order: i + 1, name: COLOURS[i] + ' Division', colour: COLOURS[i].toLowerCase(), playerIds: d.ids.join(','), withdrawn: '' };
    db.divisions.push(div);
    d.rounds.forEach((round, w) => round.forEach(([h, a]) => db.fixtures.push({
      id: uid(), seasonId: season.id, divisionId: div.id, week: w + 1, homeId: h, awayId: a,
      homeFrames: '', awayFrames: '', status: '', enteredBy: '', enteredAt: '', confirmedBy: '', confirmedAt: ''
    })));
  });
  if (final) db.fixtures.push({
    id: uid(), seasonId: season.id, divisionId: 'final', week: weeks[weeks.length - 1].n, homeId: '', awayId: '',
    homeFrames: '', awayFrames: '', status: '', enteredBy: '', enteredAt: '', confirmedBy: '', confirmedAt: ''
  });
  log(db, `Created ${name}: ${divs.map((d, i) => `${COLOURS[i]} (${d.length})`).join(', ')}, starting ${start}`);
  return { seasonId: season.id, newPins };
}


// Circle method. Each player meets every other once in the first half and once more,
// with home and away swapped, in the second half. An odd number of players gives each a bye.
function doubleRoundRobin(ids) {
  const arr = ids.slice();
  if (arr.length % 2) arr.push(null);
  const m = arr.length, first = [];
  for (let r = 0; r < m - 1; r++) {
    const round = [];
    for (let i = 0; i < m / 2; i++) {
      let h = arr[i], a = arr[m - 1 - i];
      if (i === 0 && r % 2) [h, a] = [a, h];
      if (h && a) round.push([h, a]);
    }
    first.push(round);
    arr.splice(1, 0, arr.pop());
  }
  return first.concat(first.map(round => round.map(([h, a]) => [a, h])));
}

// Week list: playing weeks, then catch-up weeks; break weeks are slotted in by date.
function buildWeeks(start, playWeeks, catchUp, breaks, final) {
  const weeks = [], total = playWeeks + catchUp + (final ? 1 : 0);
  let t = Date.parse(start + 'T12:00:00Z'), n = 0;
  while (n < total) {
    const date = new Date(t).toISOString().slice(0, 10);
    const br = breaks.find(b => b.date === date);
    if (br) weeks.push({ date, type: 'break', label: br.label || 'No matches' });
    else {
      n++;
      weeks.push({ date, n, type: n <= playWeeks ? 'play' : final && n === total ? 'final' : 'catchup' });
    }
    t += 7 * DAY;
  }
  return weeks;
}

function parseBreaks(text) {
  return String(text || '').split(/\n/).map(l => l.trim()).filter(Boolean).map(l => {
    const m = l.match(/^(\d{4}-\d{2}-\d{2})\s*(.*)$/);
    if (!m || !isSunday(m[1])) fail('Each week off must start with the Sunday date, e.g. 2026-12-27 Christmas.');
    return { date: m[1], label: m[2].trim() };
  });
}

function frames(db, r, byAdmin) {
  const h = Number(r.homeFrames), a = Number(r.awayFrames), n = Number(db.settings.framesPerMatch);
  if (![h, a].every(x => Number.isInteger(x) && x >= 0)) fail('Please enter the frames each player won.');
  if (h === a) fail('There must be a winner.');
  if (byAdmin ? h + a > n || Math.max(h, a) <= n / 2 : h + a !== n) fail(`All ${n} frames are played, so the frames must add up to ${n}.`);
  return [h, a];
}

function confirmFixture(db, fx, byId, byName) {
  fx.status = 'confirmed';
  fx.confirmedBy = byId;
  fx.confirmedAt = iso(Date.now());
  log(db, `${byName} confirmed ${fixtureText(db, fx)}`);
}

// Auto-confirms results after autoConfirmHours (if that setting is above 0).
function processDue(db) {
  const hours = Number(db.settings.autoConfirmHours);
  if (!hours) return false;
  const due = db.fixtures.filter(f => f.status === 'pending' && Date.parse(f.enteredAt) + hours * HOUR <= Date.now());
  due.forEach(f => confirmFixture(db, f, 'auto', `Auto (after ${hours} hours)`));
  return due.length > 0;
}

/* ---------- Ladder link ---------- */

// Active players on the ladder sheet, read once per request.
function ladder(db) {
  if (db.ladder) return db.ladder;
  db.ladder = [];
  if (!db.settings.ladderSheetId) return db.ladder;
  try {
    const sh = SpreadsheetApp.openById(db.settings.ladderSheetId).getSheetByName('Players');
    const v = sh.getDataRange().getValues(), head = v[0].map(String), c = k => head.indexOf(k);
    db.ladderSheet = sh;
    db.ladderPinCol = c('pin') + 1;
    db.ladder = v.slice(1).map((r, i) => ({
      row: i + 2, name: String(r[c('name')]).trim(), pin: String(r[c('pin')]), ntfy: String(r[c('ntfy')]),
      active: String(r[c('active')]).toUpperCase() === 'TRUE'
    })).filter(x => x.active && x.name);
  } catch (e) { db.ladder = []; }
  return db.ladder;
}

function link(db, p) { return ladder(db).find(x => same(x.name, p.name)); }
function pinOf(db, p) { const l = link(db, p); return l ? l.pin : String(p.pin); }
function topicOf(db, p) { const l = link(db, p); return (l && l.ntfy) || p.ntfy; }

function setPin(db, p, pin) {
  p.pin = pin;
  const l = link(db, p);
  if (l) {
    db.ladderSheet.getRange(l.row, db.ladderPinCol).setNumberFormat('@').setValue(pin);
    l.pin = pin;
  }
}

/* ---------- Helpers ---------- */

function addPlayer(db, name, phone) {
  if (db.players.some(x => x.active && same(x.name, name))) fail(name + ' is already a player.');
  const p = { id: uid(), name, active: true, pin: randomPin(4), phone, ntfy: newTopic() };
  db.players.push(p);
  return p;
}

function byName(a, b) { return a.name.localeCompare(b.name); }
function same(a, b) { return String(a).trim().toLowerCase() === String(b).trim().toLowerCase(); }
function list(s) { return String(s || '').split(',').filter(Boolean); }
function byId(db, id) { return db.players.find(p => p.id === id); }
function nameOf(db, id) { return (byId(db, id) || { name: '?' }).name; }
function fixtureText(db, f) { return `${nameOf(db, f.homeId)} ${f.homeFrames}–${f.awayFrames} ${nameOf(db, f.awayId)}`; }
function isSunday(d) { return /^\d{4}-\d{2}-\d{2}$/.test(d) && new Date(d + 'T12:00:00Z').getUTCDay() === 0; }

function findPlayer(db, id) {
  const p = db.players.find(x => x.id === id && x.active);
  if (!p) fail('Player not found.');
  return p;
}

function findSeason(db, id) {
  const s = db.seasons.find(x => x.id === id);
  if (!s) fail('Season not found.');
  return s;
}

function findFixture(db, id) {
  const f = db.fixtures.find(x => x.id === id);
  if (!f) fail('Match not found.');
  return f;
}

function party(db, r) {
  const me = auth(db, r.playerId, r.pin);
  const fx = findFixture(db, r.fixtureId);
  if (fx.homeId !== me.id && fx.awayId !== me.id) fail('Only the two players in this match can do that.');
  if (findSeason(db, fx.seasonId).status !== 'active') fail('This season has finished.');
  return { me, fx, other: byId(db, me.id === fx.homeId ? fx.awayId : fx.homeId) };
}

// Five wrong PINs locks that player (or the admin) out for 15 minutes.
function checkPin(key, correct) {
  const cache = CacheService.getScriptCache(), k = 'fail_' + key, n = Number(cache.get(k) || 0);
  if (n >= 5) fail('Too many wrong PINs. Please try again in 15 minutes.');
  if (!correct) {
    cache.put(k, String(n + 1), 900);
    fail('Incorrect PIN.');
  }
}

function auth(db, id, pin) {
  const p = findPlayer(db, id);
  checkPin(id, String(pin) === pinOf(db, p));
  return p;
}

function admin(db, r) { checkPin('admin', String(r.adminPin) === String(db.settings.adminPin)); }

function notify(db, p, title, message) {
  if (!p || !topicOf(db, p)) return;
  try {
    const headers = { Title: title, Tags: '8ball' };
    if (db.settings.siteUrl) headers.Click = db.settings.siteUrl;
    UrlFetchApp.fetch('https://ntfy.sh/' + encodeURIComponent(topicOf(db, p)), { method: 'post', payload: message, headers, muteHttpExceptions: true });
  } catch (e) { /* alerts are best effort */ }
}

// The current season is the newest active one; otherwise the newest archived one.
function publicState(db, seasonId) {
  const s = db.settings;
  const seasons = db.seasons.slice().sort((a, b) => b.startDate.localeCompare(a.startDate));
  const current = seasons.find(x => x.status === 'active') || seasons[0];
  const season = seasons.find(x => x.id === seasonId) || current;
  const divisions = season ? db.divisions.filter(d => d.seasonId === season.id).sort((a, b) => a.order - b.order) : [];
  const ids = {};
  divisions.forEach(d => list(d.playerIds).forEach(id => { ids[id] = true; }));
  return {
    now: iso(Date.now()),
    settings: {
      clubName: s.clubName, framesPerMatch: Number(s.framesPerMatch), pointsPerFrame: Number(s.pointsPerFrame),
      pointsPerWin: Number(s.pointsPerWin), autoConfirmHours: Number(s.autoConfirmHours)
    },
    seasons: seasons.map(x => ({ id: x.id, name: x.name, status: x.status, startDate: x.startDate })),
    currentId: current ? current.id : '',
    season: season ? { id: season.id, name: season.name, status: season.status, startDate: season.startDate, weeks: JSON.parse(season.weeks || '[]') } : null,
    divisions: divisions.map(d => ({ id: d.id, name: d.name, colour: d.colour, playerIds: list(d.playerIds), withdrawn: list(d.withdrawn) })),
    players: db.players.filter(p => ids[p.id]).map(p => ({ id: p.id, name: p.name, phone: p.phone, active: p.active })),
    fixtures: season ? db.fixtures.filter(f => f.seasonId === season.id).map(f => ({
      id: f.id, divisionId: f.divisionId, week: Number(f.week), homeId: f.homeId, awayId: f.awayId,
      homeFrames: f.homeFrames === '' ? null : Number(f.homeFrames), awayFrames: f.awayFrames === '' ? null : Number(f.awayFrames),
      status: f.status, enteredBy: f.enteredBy, enteredAt: f.enteredAt, confirmedAt: f.confirmedAt
    })) : []
  };
}

function cleanName(name) {
  const n = String(name || '').trim().replace(/\s+/g, ' ');
  if (!n) fail('Please enter a name.');
  return n;
}

function cleanPhone(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  return d.startsWith('0') ? '44' + d.slice(1) : d;
}

function fail(msg) { throw new Error(msg); }
function uid() { return Utilities.getUuid().replace(/-/g, '').slice(0, 10); }
function iso(t) { return new Date(t).toISOString(); }
function randomPin(len) { let s = ''; while (s.length < len) s += Math.floor(Math.random() * 10); return s; }
function newTopic() { return 'psc-league-' + Utilities.getUuid().replace(/-/g, '').slice(0, 12); }
function log(db, event) { db.logs.push({ time: iso(Date.now()), event }); }

/* ---------- Sheet storage ---------- */

function load() {
  const settings = {};
  readTable('Settings').forEach(r => { settings[r.key] = String(r.value); });
  return {
    settings,
    players: readTable('Players').map(p => Object.assign(p, { active: String(p.active).toUpperCase() === 'TRUE' })),
    seasons: readTable('Seasons'),
    divisions: readTable('Divisions').map(d => Object.assign(d, { order: Number(d.order) })),
    fixtures: readTable('Fixtures'),
    logs: []
  };
}

function save(db) {
  writeTable('Players', db.players.map(p => Object.assign({}, p, { active: p.active ? 'TRUE' : 'FALSE' })));
  writeTable('Seasons', db.seasons);
  writeTable('Divisions', db.divisions);
  writeTable('Fixtures', db.fixtures);
  writeTable('Settings', Object.keys(db.settings).map(key => ({ key, value: db.settings[key] })));
  if (db.logs.length) {
    const sh = SpreadsheetApp.getActive().getSheetByName('Log');
    const rows = db.logs.map(l => [l.time, l.event]);
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, 2).setNumberFormat('@').setValues(rows);
  }
}

function readTable(name) {
  const values = SpreadsheetApp.getActive().getSheetByName(name).getDataRange().getValues();
  const head = values.shift() || [];
  return values.filter(r => r[0] !== '').map(r => {
    const o = {};
    head.forEach((h, i) => { o[h] = r[i] instanceof Date ? r[i].toISOString() : String(r[i]); });
    return o;
  });
}

function writeTable(name, rows) {
  const sh = SpreadsheetApp.getActive().getSheetByName(name), head = SHEETS[name];
  const data = [head].concat(rows.map(r => head.map(h => (r[h] === undefined || r[h] === null ? '' : String(r[h])))));
  sh.clearContents();
  sh.getRange(1, 1, data.length, head.length).setNumberFormat('@').setValues(data);
  sh.setFrozenRows(1);
}
