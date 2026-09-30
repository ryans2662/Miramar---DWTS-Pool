// Ballroom Pool API — Cloudflare Worker + D1
// Storage: one table `kv` (k TEXT PRIMARY KEY, v TEXT JSON).
//   'state'          -> league state {currentWeek, locked, cast, scores, locks, finaleWeek, champion, champBonus, lockAt:{week: ISO|null},
//                       lockedAt:{week: ISO}, scoreSource:{week: 'manual'|'wikipedia'}, pull:{week, at, ok, note},
//                       preview:{week, theme, format, couples:{id: [{dance, song}]}, at}}
//   'player:<id>'    -> {id, name, pinHash|null, weeks:{ "3": {top,mid,low,at} | {open:[id,id],at} (+champ in the finale) }}

const TIERS = ['top', 'mid', 'low'];
const OPEN_AT = 6; // at or below this many active couples, tiers drop and players pick any two

export default {
  async fetch(req, env) {
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'content-type',
    };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    let status = 200, body;
    try {
      body = await route(req, env);
    } catch (e) {
      status = e.status || 500;
      body = { error: e.status ? e.message : 'Server error' };
      if (!e.status) console.error(e);
    }
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...cors } });
  },
  // Cron (wrangler.toml): locks on time even with no visitors, then pulls the week's results.
  async scheduled(event, env, ctx) { ctx.waitUntil(autoPull(env)); },
};

const fail = (status, message) => { const e = new Error(message); e.status = status; throw e; };

async function route(req, env) {
  const { pathname } = new URL(req.url);
  if (req.method === 'GET' && pathname === '/api/state') return publicView(env);
  if (req.method !== 'POST') fail(404, 'Not found');
  const b = await req.json().catch(() => fail(400, 'Bad request'));
  switch (pathname) {
    case '/api/join': return join(env, b);
    case '/api/login': return login(env, b);
    case '/api/picks': return submitPicks(env, b);
    case '/api/admin': return adminAction(env, b);
  }
  fail(404, 'Not found');
}

/* ---------- storage ---------- */
async function getKV(env, k) {
  const row = await env.DB.prepare('SELECT v FROM kv WHERE k = ?').bind(k).first();
  return row ? JSON.parse(row.v) : null;
}
async function putKV(env, k, v) {
  await env.DB.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
    .bind(k, JSON.stringify(v)).run();
}
async function getState(env) {
  const S = { finaleWeek: null, champion: null, champBonus: 25, lockAt: {}, lockedAt: {}, scoreSource: {}, pull: null,
    ...((await getKV(env, 'state')) || { currentWeek: 1, locked: false, cast: [], scores: {}, locks: {} }) };
  const w = String(S.currentWeek);
  let dirty = false;
  // A week with no lock time yet gets the next live show; null means the commissioner locks by hand.
  if (!(w in S.lockAt)) { S.lockAt[w] = nextShowtime(new Date()).toISOString(); dirty = true; }
  if (!S.locked && S.lockAt[w] && Date.now() >= Date.parse(S.lockAt[w])) { await lockWeek(env, S); dirty = true; }
  if (dirty) await putKV(env, 'state', S);
  return S;
}
async function lockWeek(env, S) {
  const w = String(S.currentWeek), snap = {};
  for (const p of await getPlayers(env)) { const pk = p.weeks?.[w]; if (pk) { const { at, ...pick } = pk; snap[p.id] = { name: p.name, ...pick }; } }
  S.locks[w] = snap; S.locked = true; S.lockedAt[w] = new Date().toISOString();
}
async function getPlayers(env) {
  const { results } = await env.DB.prepare("SELECT v FROM kv WHERE k LIKE 'player:%'").all();
  return results.map(r => JSON.parse(r.v));
}

/* ---------- showtime ---------- */
// Season 35 airs live coast to coast at 8:00 PM Eastern, usually on Tuesdays (the fallback when
// Wikipedia's episode list has no upcoming date).
const SHOW = { day: 'Tue', hour: 20, tz: 'America/New_York' };
function zoned(date, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', weekday: 'short',
    year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }).formatToParts(date).map(x => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, min: +p.minute, day: p.weekday };
}
// 8:00 PM Eastern on the given calendar day.
function showtimeOn(y, m, d) {
  const guess = Date.UTC(y, m - 1, d, SHOW.hour), g = zoned(new Date(guess), SHOW.tz);
  return new Date(guess - (Date.UTC(g.y, g.m - 1, g.d, g.h, g.min) - guess)); // shift by the zone's UTC offset
}
function nextShowtime(now) {
  for (let i = 0; i < 8; i++) {
    const z = zoned(new Date(now.getTime() + i * 86400000), SHOW.tz);
    if (z.day !== SHOW.day) continue;
    const t = showtimeOn(z.y, z.m, z.d);
    if (t > now) return t;
  }
}

/* ---------- results from Wikipedia ---------- */
// The season article's "Scoring chart" holds each couple's weekly judges' total, and marks the
// eliminated couple's cell. Rows are "Celebrity & Pro" first names; columns are weeks.
const WIKI_RAW = 'https://en.wikipedia.org/w/index.php?title=Dancing_with_the_Stars_(American_TV_series)_season_35&action=raw';

// Drop every {{template}} whose name is in `names`, handling nested braces.
function dropTemplates(s, names) {
  let out = '', i = 0;
  while (i < s.length) {
    const m = s.startsWith('{{', i) && /^\{\{\s*([^|}]+)/.exec(s.slice(i));
    if (m && names.includes(m[1].trim().toLowerCase())) {
      let depth = 0, j = i;
      for (; j < s.length; j++) {
        if (s.startsWith('{{', j)) { depth++; j++; } else if (s.startsWith('}}', j)) { depth--; j++; if (!depth) break; }
      }
      i = j + 1; continue;
    }
    out += s[i++];
  }
  return out;
}
// Split "attrs | content" on the first pipe outside {{ }} and [[ ]].
function splitCell(s) {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.startsWith('{{', i) || s.startsWith('[[', i)) { depth++; i++; }
    else if (s.startsWith('}}', i) || s.startsWith(']]', i)) { depth--; i++; }
    else if (s[i] === '|' && !depth && /=/.test(s.slice(0, i))) return { attrs: s.slice(0, i), text: s.slice(i + 1) };
  }
  return { attrs: '', text: s };
}
function cleanText(s) {
  s = s.replace(/<ref[^>]*\/>/g, '').replace(/<ref[^>]*>[\s\S]*?<\/ref>/g, '');
  s = dropTemplates(s, ['efn', 'dagger', 'double-dagger']);
  s = s.replace(/\{\{\s*(?:fontcolor|nowrap)\s*\|(?:[^|}]*\|)?([^{}]*)\}\}/gi, '$1');
  return s.replace(/'{2,}/g, '').replace(/\{\{[^{}]*\}\}/g, '').trim();
}
function cellValue(t) {
  t = t.replace(/\s+/g, '');
  let m = /=(\d+)$/.exec(t); if (m) return +m[1];
  if (/^\d+(\+\d+)*$/.test(t)) return t.split('+').reduce((a, b) => a + +b, 0);
  return null;
}
function parseScoringChart(raw) {
  const start = raw.indexOf('== Scoring chart ==');
  if (start < 0) return null;
  const end = raw.indexOf('\n|}', start);
  const lines = raw.slice(start, end).split('\n');
  const firstRow = lines.findIndex(l => /^!.*scope="row"/.test(l));
  // Week headers are the column headers whose text is a number, e.g. "[[#Week 1: Premiere|1]]" or "4".
  const weeks = lines.slice(0, firstRow).filter(l => l.startsWith('!') &&
    /^\d+$/.test(cleanText(splitCell(l.slice(1)).text).replace(/^\[\[[^|\]]*\|([^\]]*)\]\]$/, '$1'))).length;
  const rows = [];
  let cur = null, placeRowsLeft = 0; // rows still covered by a rowspan'd Place cell above them
  for (const line of lines.slice(firstRow)) {
    if (/^!.*scope="row"/.test(line)) {
      const name = cleanText(splitCell(line.replace(/^!\s*/, '')).text);
      const [celeb, pro] = name.split('&').map(x => x.trim().split(/\s+/)[0]);
      cur = { celeb, pro, cells: [], ownPlace: placeRowsLeft <= 0 }; rows.push(cur);
      if (!cur.ownPlace) placeRowsLeft--;
      continue;
    }
    if (!cur || !line.startsWith('|') || /^\|[-}+]/.test(line)) continue;
    if (cur.ownPlace && !cur.cells.length) placeRowsLeft = +(/rowspan="?(\d+)/.exec(line)?.[1] || 1) - 1;
    const { attrs, text } = splitCell(line.slice(1));
    const span = +(/colspan="?(\d+)/.exec(attrs)?.[1] || 1);
    const cell = { v: cellValue(cleanText(text)), out: /f4c7b8/i.test(attrs) || /eliminat|withdr/i.test(text) };
    for (let k = 0; k < span; k++) cur.cells.push(k ? { v: null, out: false } : cell);
  }
  // Skip the Place cell (only on rows that have their own; the still-dancing couples share one
  // rowspan'd cell) and read weeks from the left, so an over-wide grey filler after an
  // elimination (an easy Wikipedia edit slip) cannot shift a couple's scores into the wrong week.
  for (const r of rows) { const s = r.ownPlace ? 1 : 0; r.cells = r.cells.slice(s, s + weeks); delete r.ownPlace; }
  return { weeks, rows };
}
// A week's results for the pool, or a reason they are not ready.
function resultsFor(S, chart, w) {
  if (!chart || w > chart.weeks) return { error: 'The scoring chart could not be read.' };
  const first = s => String(s || '').split(/\s+/)[0].toLowerCase();
  const scores = {}, out = [], missing = [];
  for (const c of activeIn(S, w)) {
    const r = chart.rows.find(r => first(r.celeb) === first(c.name) && first(r.pro) === first(c.pro));
    const cell = r?.cells[w - 1];
    if (!cell || cell.v == null || cell.v < 0 || cell.v > 200) { missing.push(c.name); continue; }
    scores[c.id] = cell.v;
    if (cell.out) out.push(c.id);
  }
  if (missing.length) return { error: `No week ${w} score yet for ${missing.join(', ')}.` };
  return { scores, out };
}
// The season's episodes from the article's Episodes list (up to the next heading, so specials
// like the After Party are left out), e.g. "| Title = Finale" and
// "| OriginalAirDate = {{Start date|2026|11|24}}", as {title, y, m, d}. Pool weeks don't match
// episode numbers (the premiere ran two nights), so episodes are matched to weeks by air date.
function parseEpisodes(raw) {
  const a = raw.indexOf('== Episodes =='), b = raw.indexOf('\n==', a + 1);
  if (a < 0) return [];
  const eps = [];
  for (const ep of raw.slice(a, b < 0 ? undefined : b).split('{{#invoke:Episode list').slice(1)) {
    const title = cleanText(/\|\s*Title\s*=\s*(.*)/.exec(ep)?.[1] || '');
    const d = /\|\s*OriginalAirDate\s*=\s*\{\{\s*Start date\s*\|\s*(\d{4})\s*\|\s*(\d{1,2})\s*\|\s*(\d{1,2})/i.exec(ep);
    if (d) eps.push({ title, y: +d[1], m: +d[2], d: +d[3] });
  }
  return eps;
}
// The first episode still to air, locked at 8:00 PM Eastern that night; null if the list has none.
function nextAiring(eps, now) {
  const times = eps.map(e => showtimeOn(e.y, e.m, e.d)).filter(t => t > now);
  return times.length ? new Date(Math.min(...times)) : null;
}
function finaleDate(eps) {
  const f = eps.find(e => /\bfinale\b/i.test(e.title) && !/semi/i.test(e.title));
  return f ? Date.UTC(f.y, f.m - 1, f.d) : null;
}
// What's known about week w before it airs, from its "=== Week w: Theme ===" section: the theme,
// the section's first sentence (the night's format), and each couple's dance and song once
// announced. The Music cell is the one quoted ("Song" — Artist) and the Dance cell sits just
// before it, which holds up when a week drops the Scores or Result column.
const linkText = s => s.replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, '$1');
function parseWeekPreview(raw, w, S) {
  const h = new RegExp(`^===\\s*Week ${w}(?::\\s*(.*?))?\\s*===\\s*$`, 'm').exec(raw);
  if (!h) return null;
  const rest = raw.slice(h.index + h[0].length), end = rest.search(/\n==/);
  const sec = (end < 0 ? rest : rest.slice(0, end)).replace(/<ref[^>]*\/>/g, '').replace(/<ref[^>]*>[\s\S]*?<\/ref>/g, '').replace(/<!--[\s\S]*?-->/g, '');
  const intro = linkText(cleanText(sec.trim().split('\n')[0] || ''));
  const format = /^[^{|!;]/.test(intro) ? (/^.*?[.!?](?=\s|$)/.exec(intro)?.[0] || intro) : '';
  const first = s => String(s || '').split(/\s+/)[0].toLowerCase();
  const couples = {};
  for (const row of sec.split(/\n\|-/)) {
    const hd = /^!.*scope="row".*$/m.exec(row); if (!hd) continue;
    const [celeb, pro] = cleanText(splitCell(hd[0].replace(/^!\s*/, '')).text).split('&').map(x => x.trim());
    const c = S.cast.find(c => first(c.name) === first(celeb) && first(c.pro) === first(pro)); if (!c) continue;
    const cells = row.split('\n').filter(l => /^\|(?![-}+])/.test(l)).map(l => linkText(cleanText(splitCell(l.slice(1)).text)));
    const m = cells.findIndex(x => /^["“]/.test(x));
    const dance = m > 0 ? cells[m - 1] : '', song = m >= 0 ? cells[m].replace(/\s+/g, ' ') : '';
    if (dance || song) (couples[c.id] ||= []).push({ dance: dance.slice(0, 80), song: song.slice(0, 160) });
  }
  return { week: w, theme: linkText(cleanText(h[1] || '')).slice(0, 80), format: format.slice(0, 300), couples };
}
async function fetchChart() {
  try {
    const r = await fetch(WIKI_RAW, { headers: { 'user-agent': 'miramar-dwts-pool/1.0 (private office pool; ballroom-pool.ryans2662.workers.dev)' } });
    if (!r.ok) return { error: `Wikipedia returned ${r.status}.` };
    const raw = await r.text(), chart = parseScoringChart(raw);
    return chart ? { ...chart, episodes: parseEpisodes(raw), raw } : { error: 'The scoring chart could not be read.' };
  } catch { return { error: 'Could not reach Wikipedia.' }; }
}
function applyScores(S, wk, sc, outIds) {
  if (Object.keys(sc).length) S.scores[wk] = sc; else delete S.scores[wk];
  const out = new Set(outIds);
  for (const c of S.cast) { if (out.has(c.id)) c.outWeek = wk; else if (c.outWeek === wk) c.outWeek = null; }
}
// Applies Wikipedia's results for week wk to S when every couple still dancing has a score.
async function pullResults(S, wk, chart) {
  chart ??= await fetchChart();
  const r = chart.error ? chart : resultsFor(S, chart, wk);
  S.pull = { week: wk, at: new Date().toISOString(), ok: !r.error, note: r.error || null };
  if (r.error) return r;
  applyScores(S, wk, r.scores, r.out);
  S.scoreSource[wk] = 'wikipedia';
  return r;
}
const PULL_FOR_MS = 48 * 3600e3; // keep picking up Wikipedia corrections for two days after the lock
// The week the cron should pull: the locked current week, or, once the next week has opened, the
// week just finished while its correction window lasts. Hand-entered weeks are never pulled.
function pullWeek(S) {
  const w = S.locked ? S.currentWeek : S.currentWeek - 1, at = S.lockedAt[w];
  if (w < 1 || S.scoreSource[w] === 'manual') return null;
  if (at ? Date.now() - Date.parse(at) > PULL_FOR_MS : w !== S.currentWeek) return null;
  return w;
}
// The next week opens on its own once the locked week has complete results (a successful
// Wikipedia pull or scores saved by hand). The finale week never advances.
const readyForNextWeek = S => S.locked && !!S.scoreSource[S.currentWeek] && S.finaleWeek !== S.currentWeek &&
  activeIn(S, S.currentWeek + 1).length >= 2;
// Opens the next week. Picks lock at 8:00 PM Eastern on the next air date in Wikipedia's episode
// list, so an off-night show (a Monday Disney Night) locks on time; without one, next Tuesday.
// When that show is within a few days of the Finale episode, the week is marked as the finale
// before anyone can pick. The commissioner can still change either.
async function startNextWeek(S, chart) {
  chart ??= await fetchChart();
  const eps = chart.episodes || [], now = new Date(), lock = nextAiring(eps, now) || nextShowtime(now);
  S.currentWeek += 1; S.locked = false; S.lockAt[S.currentWeek] = lock.toISOString();
  const z = zoned(lock, SHOW.tz), fin = finaleDate(eps);
  if (fin != null && Math.abs(Date.UTC(z.y, z.m - 1, z.d) - fin) <= 3 * 86400e3) S.finaleWeek = S.currentWeek;
}
// The season is over once the finale's champion is saved; until then the cron also refreshes
// the "This week" preview of the current week from the same article fetch.
const seasonOver = S => S.finaleWeek != null && S.champion != null;
async function autoPull(env) {
  let S = await getState(env); // getState also locks the week once its showtime passes
  if (seasonOver(S) && pullWeek(S) == null) return;
  const chart = await fetchChart();
  S = await getState(env); // re-read so a commissioner change made during the fetch is kept
  const before = JSON.stringify(S), w = pullWeek(S);
  if (w != null) await pullResults(S, w, chart);
  if (readyForNextWeek(S)) await startNextWeek(S, chart);
  const pv = chart.raw && parseWeekPreview(chart.raw, S.currentWeek, S);
  const { at, ...prev } = S.preview || {}; // `at` is when the preview last changed
  if (pv && JSON.stringify(pv) !== JSON.stringify(prev)) S.preview = { ...pv, at: new Date().toISOString() };
  if (JSON.stringify(S) !== before) await putKV(env, 'state', S);
}

/* ---------- league logic (mirrors the page) ---------- */
function activeIn(S, w) { return S.cast.filter(c => c.outWeek == null || c.outWeek >= w); }
// Tiers rank by a weighted average of the weeks before w, each week weighted by its number
// (week 1 x1, week 2 x2, ...), so a couple's improvement or slump counts more than their start.
// `last` is their most recent score, the first tiebreak.
function formBefore(S, id, w) {
  let sum = 0, wt = 0, last = null;
  for (const k of Object.keys(S.scores).map(Number).sort((a, b) => a - b)) if (k < w) {
    const v = S.scores[k]?.[id]; if (typeof v === 'number') { sum += v * k; wt += k; last = v; }
  }
  return wt ? { avg: sum / wt, last } : { avg: null, last: null };
}
function tiersFor(S, w) {
  const act = activeIn(S, w).map(c => ({ c, ...formBefore(S, c.id, w) }));
  act.sort((a, b) => {
    if ((a.avg == null) !== (b.avg == null)) return a.avg == null ? 1 : -1;
    if (a.avg != null && b.avg !== a.avg) return b.avg - a.avg;
    if (a.last != null && b.last !== a.last) return b.last - a.last;
    return S.cast.indexOf(a.c) - S.cast.indexOf(b.c);
  });
  const ids = act.map(x => x.c.id), n = ids.length, t = Math.ceil(n / 3), m = Math.ceil((n - t) / 2);
  return { top: ids.slice(0, t), mid: ids.slice(t, t + m), low: ids.slice(t + m) };
}
function validatePick(S, pick) {
  const w = S.currentWeek, act = activeIn(S, w).map(c => c.id);
  let out;
  if (act.length <= OPEN_AT) {
    const o = pick?.open;
    if (!Array.isArray(o) || o.length !== 2 || o[0] === o[1] || !o.every(id => act.includes(id)))
      fail(400, 'Pick two different couples still in the competition.');
    out = { open: [o[0], o[1]] };
  } else {
    const T = tiersFor(S, w);
    for (const k of TIERS) if (!pick?.[k] || !T[k].includes(pick[k])) fail(400, 'Each pick must come from its tier for this week.');
    out = { top: pick.top, mid: pick.mid, low: pick.low };
  }
  if (S.finaleWeek === w) {
    if (!act.includes(pick?.champ)) fail(400, 'Pick a champion for the finale.');
    out.champ = pick.champ;
  }
  return { ...out, at: new Date().toISOString() };
}

/* ---------- players ---------- */
async function hashPin(id, pin) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(id + ':' + pin));
  return [...new Uint8Array(buf)].map(x => x.toString(16).padStart(2, '0')).join('');
}
const cleanName = n => String(n || '').trim().replace(/\s+/g, ' ').slice(0, 40);
const checkPin = p => { if (!/^\d{4,8}$/.test(String(p || ''))) fail(400, 'PIN must be 4 to 8 digits.'); };

async function publicView(env) {
  const [state, players] = await Promise.all([getState(env), getPlayers(env)]);
  const w = String(state.currentWeek);
  return {
    state,
    players: players.map(p => ({ id: p.id, name: p.name, picked: !!p.weeks?.[w], managed: !p.pinHash }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}
async function join(env, { name, pin }) {
  name = cleanName(name); if (!name) fail(400, 'Enter a name.'); checkPin(pin);
  const players = await getPlayers(env);
  if (players.some(p => p.name.toLowerCase() === name.toLowerCase())) fail(409, 'That name is taken. Sign in instead, or pick another name.');
  const id = crypto.randomUUID().slice(0, 12);
  const p = { id, name, pinHash: await hashPin(id, pin), weeks: {} };
  await putKV(env, 'player:' + id, p);
  return { id, name, weeks: {} };
}
async function authPlayer(env, { name, id, pin }) {
  checkPin(pin);
  let p = id ? await getKV(env, 'player:' + id) : null;
  if (!p && name) p = (await getPlayers(env)).find(x => x.name.toLowerCase() === cleanName(name).toLowerCase());
  if (!p || !p.pinHash || p.pinHash !== await hashPin(p.id, pin)) fail(401, 'Name or PIN is incorrect.');
  return p;
}
async function login(env, b) {
  const p = await authPlayer(env, b);
  return { id: p.id, name: p.name, weeks: p.weeks || {} };
}
async function submitPicks(env, b) {
  const p = await authPlayer(env, b);
  const S = await getState(env);
  if (S.locked) fail(409, `Week ${S.currentWeek} picks are locked.`);
  p.weeks = { ...(p.weeks || {}), [S.currentWeek]: validatePick(S, b.pick) };
  await putKV(env, 'player:' + p.id, p);
  return { id: p.id, name: p.name, weeks: p.weeks };
}

/* ---------- commissioner ---------- */
const slug = s => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

async function adminAction(env, b) {
  if (!env.ADMIN_PASSWORD || b.password !== env.ADMIN_PASSWORD) fail(401, 'Wrong commissioner password.');
  const S = await getState(env);
  const w = String(S.currentWeek);
  let dirty = true;
  switch (b.action) {
    case 'check': dirty = false; break;
    case 'lock': await lockWeek(env, S); break;
    case 'unlock': {
      S.locked = false;
      if (S.lockAt[w] && Date.now() >= Date.parse(S.lockAt[w])) S.lockAt[w] = null; // a passed lock time would relock at once
      break;
    }
    case 'nextWeek': await startNextWeek(S); break;
    case 'lockAt': {
      if (b.at !== null && !isFinite(Date.parse(b.at))) fail(400, 'Bad lock time.');
      S.lockAt[w] = b.at === null ? null : new Date(b.at).toISOString();
      break;
    }
    case 'scores': {
      const wk = Number(b.week); if (!(wk >= 1 && wk <= S.currentWeek)) fail(400, 'Bad week.');
      const sc = {};
      for (const [id, v] of Object.entries(b.scores || {})) if (typeof v === 'number' && isFinite(v)) sc[id] = v;
      applyScores(S, wk, sc, b.out || []);
      S.scoreSource[wk] = 'manual'; // hand-entered scores are never overwritten by the automatic pull
      break;
    }
    case 'pull': {
      const wk = Number(b.week); if (!(wk >= 1 && wk <= S.currentWeek)) fail(400, 'Bad week.');
      const r = await pullResults(S, wk);
      if (r.error) fail(409, r.error);
      break;
    }
    case 'cast': {
      const old = Object.fromEntries(S.cast.map(c => [c.id, c]));
      S.cast = (b.cast || []).filter(c => c?.name).map(c => {
        const id = slug(c.name), photo = String(c.photo || '');
        return { id, name: String(c.name).slice(0, 60), pro: String(c.pro || '').slice(0, 60),
          photo: photo.length <= 500 && /^https:\/\/[^\s"'<>]+$/.test(photo) ? photo : '', outWeek: old[id]?.outWeek ?? null };
      });
      break;
    }
    case 'finale': {
      if (b.isFinale != null && !S.locked) {
        if (b.isFinale) S.finaleWeek = S.currentWeek;
        else if (S.finaleWeek === S.currentWeek) S.finaleWeek = null;
      }
      if (b.bonus != null) {
        const n = Number(b.bonus); if (!(isFinite(n) && n >= 0)) fail(400, 'Bonus must be zero or more.');
        S.champBonus = Math.round(n);
      }
      if (b.champion !== undefined) {
        if (b.champion !== null && !S.cast.some(c => c.id === b.champion)) fail(400, 'Unknown champion.');
        S.champion = b.champion;
      }
      break;
    }
    case 'addPlayer': {
      const name = cleanName(b.name); if (!name) fail(400, 'Enter a name.');
      if ((await getPlayers(env)).some(p => p.name.toLowerCase() === name.toLowerCase())) fail(409, 'That name is taken.');
      const id = crypto.randomUUID().slice(0, 12);
      await putKV(env, 'player:' + id, { id, name, pinHash: null, weeks: {} });
      dirty = false; break;
    }
    case 'resetPin': {
      // Sets a new PIN for a player who lost theirs; their picks and points are untouched.
      checkPin(b.pin);
      const p = await getKV(env, 'player:' + b.id); if (!p) fail(404, 'Player not found.');
      p.pinHash = await hashPin(p.id, String(b.pin));
      await putKV(env, 'player:' + p.id, p);
      dirty = false; break;
    }
    case 'removePlayer': {
      await env.DB.prepare('DELETE FROM kv WHERE k = ?').bind('player:' + b.id).run();
      dirty = false; break;
    }
    case 'setPicks': {
      if (S.locked) fail(409, 'Reopen picks before changing them.');
      const p = await getKV(env, 'player:' + b.id); if (!p) fail(404, 'Player not found.');
      p.weeks = { ...(p.weeks || {}), [w]: validatePick(S, b.pick) };
      await putKV(env, 'player:' + p.id, p);
      dirty = false; break;
    }
    default: fail(400, 'Unknown action.');
  }
  if (dirty) await putKV(env, 'state', S);
  const view = await publicView(env);
  // Commissioner also gets every player's current-week pick (for entering or fixing picks).
  const all = await getPlayers(env);
  view.adminPicks = Object.fromEntries(all.map(p => [p.id, p.weeks?.[String(view.state.currentWeek)] || null]));
  return view;
}
