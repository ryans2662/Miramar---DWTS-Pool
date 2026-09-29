// Ballroom Pool API — Cloudflare Worker + D1
// Storage: one table `kv` (k TEXT PRIMARY KEY, v TEXT JSON).
//   'state'          -> league state {currentWeek, locked, cast, scores, locks, finaleWeek, champion, champBonus}
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
  const S = (await getKV(env, 'state')) || { currentWeek: 1, locked: false, cast: [], scores: {}, locks: {} };
  return { finaleWeek: null, champion: null, champBonus: 25, ...S };
}
async function getPlayers(env) {
  const { results } = await env.DB.prepare("SELECT v FROM kv WHERE k LIKE 'player:%'").all();
  return results.map(r => JSON.parse(r.v));
}

/* ---------- league logic (mirrors the page) ---------- */
function activeIn(S, w) { return S.cast.filter(c => c.outWeek == null || c.outWeek >= w); }
function avgBefore(S, id, w) {
  let sum = 0, n = 0;
  for (const k of Object.keys(S.scores)) if (+k < w) { const v = S.scores[k]?.[id]; if (typeof v === 'number') { sum += v; n++; } }
  return n ? sum / n : null;
}
function tiersFor(S, w) {
  const act = activeIn(S, w).map(c => ({ c, avg: avgBefore(S, c.id, w) }));
  act.sort((a, b) => {
    if ((a.avg == null) !== (b.avg == null)) return a.avg == null ? 1 : -1;
    if (a.avg != null && b.avg !== a.avg) return b.avg - a.avg;
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
    case 'lock': {
      const snap = {};
      for (const p of await getPlayers(env)) { const pk = p.weeks?.[w]; if (pk) { const { at, ...pick } = pk; snap[p.id] = { name: p.name, ...pick }; } }
      S.locks[w] = snap; S.locked = true; break;
    }
    case 'unlock': S.locked = false; break;
    case 'nextWeek': S.currentWeek += 1; S.locked = false; break;
    case 'scores': {
      const wk = Number(b.week); if (!(wk >= 1 && wk <= S.currentWeek)) fail(400, 'Bad week.');
      const sc = {};
      for (const [id, v] of Object.entries(b.scores || {})) if (typeof v === 'number' && isFinite(v)) sc[id] = v;
      if (Object.keys(sc).length) S.scores[wk] = sc; else delete S.scores[wk];
      const out = new Set(b.out || []);
      for (const c of S.cast) { if (out.has(c.id)) c.outWeek = wk; else if (c.outWeek === wk) c.outWeek = null; }
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
