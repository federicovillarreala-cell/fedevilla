// engine.js — data loading (Sleeper public API) + projection / ranking model
export const API = 'https://api.sleeper.app';
export const POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];
const posQS = POSITIONS.map(p => `position[]=${p}`).join('&');

const memo = new Map();
export function getJSON(url) {
  if (memo.has(url)) return memo.get(url);
  const p = fetch(url).then(r => {
    if (!r.ok) throw new Error(`Request failed (${r.status})`);
    return r.json();
  });
  memo.set(url, p);
  p.catch(() => memo.delete(url));
  return p;
}
export const clearCache = () => memo.clear();

export const sleeper = {
  state: () => getJSON(`${API}/v1/state/nfl`),
  user: name => getJSON(`${API}/v1/user/${encodeURIComponent(name)}`),
  leagues: (uid, season) => getJSON(`${API}/v1/user/${uid}/leagues/nfl/${season}`),
  league: id => getJSON(`${API}/v1/league/${id}`),
  rosters: id => getJSON(`${API}/v1/league/${id}/rosters`),
  users: id => getJSON(`${API}/v1/league/${id}/users`),
  matchups: (id, w) => getJSON(`${API}/v1/league/${id}/matchups/${w}`),
  projections: (s, w) => getJSON(`${API}/projections/nfl/${s}/${w}?season_type=regular&${posQS}`),
  stats: (s, w) => getJSON(`${API}/stats/nfl/${s}/${w}?season_type=regular&${posQS}`),
  trending: type => getJSON(`${API}/v1/players/nfl/trending/${type}?lookback_hours=48&limit=200`),
  allPlayers: () => getJSON(`${API}/v1/players/nfl`),
};

// ---------- small math helpers ----------
export const range = (a, b) => { const r = []; for (let i = a; i <= b; i++) r.push(i); return r; };
export const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
export const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
export const sum = a => a.reduce((s, x) => s + x, 0);
export const stdev = a => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(mean(a.map(x => (x - m) ** 2)));
};

// ---------- scoring ----------
// With a league's scoring_settings we score every stat exactly like Sleeper does;
// otherwise fall back to the preset fantasy point totals Sleeper ships.
const PRESET_KEY = { ppr: 'pts_ppr', half: 'pts_half_ppr', std: 'pts_std' };
export function makeScorer(scoring, preset = 'ppr') {
  const fallback = scoring
    ? (scoring.rec >= 1 ? 'pts_ppr' : scoring.rec >= 0.5 ? 'pts_half_ppr' : 'pts_std')
    : PRESET_KEY[preset] || 'pts_ppr';
  return stats => {
    if (!stats) return 0;
    if (scoring) {
      let s = 0;
      for (const k in scoring) {
        const v = stats[k];
        if (typeof v === 'number') s += v * scoring[k];
      }
      if (s !== 0 || !stats[fallback]) return s;
    }
    return stats[fallback] || 0;
  };
}
export const scoringLabel = (scoring, preset) => {
  const rec = scoring ? scoring.rec ?? 0 : { ppr: 1, half: 0.5, std: 0 }[preset];
  return rec >= 1 ? 'PPR' : rec >= 0.5 ? 'Half-PPR' : 'Standard';
};

// raw projected stats kept per week for player-prop modeling
const PROP_KEYS = ['pass_yd', 'pass_td', 'pass_cmp', 'pass_att', 'pass_int', 'rush_yd', 'rush_att', 'rec', 'rec_yd', 'rec_tgt'];

// Game-status multipliers for the current week
export const INJ_NOW = { Out: 0, IR: 0, PUP: 0, Sus: 0, NA: 0, DNR: 0, COV: 0, Doubtful: 0.3, Questionable: 0.88 };

const GRADES = ['A', 'B', 'C', 'D', 'F'];
const gradeOf = (rank, n) => GRADES[Math.min(4, Math.floor(((rank - 1) / Math.max(1, n)) * 5))];

// ---------- the model ----------
export async function buildModel({ season, week, scoring, preset = 'ppr', horizon = 4, onStep = () => {} }) {
  const score = makeScorer(scoring, preset);
  const past = range(1, week - 1);
  const future = range(week, Math.min(18, week + horizon));

  onStep('Pulling weekly stats & projections');
  const [statsWeeks, projWeeks, adds, drops] = await Promise.all([
    Promise.all(past.map(w => sleeper.stats(season, w).catch(() => []))),
    Promise.all(future.map(w => sleeper.projections(season, w).catch(() => []))),
    sleeper.trending('add').catch(() => []),
    sleeper.trending('drop').catch(() => []),
  ]);
  onStep('Running the projection model');

  const players = new Map();
  const touch = e => {
    const id = String(e.player_id);
    let p = players.get(id);
    if (!p) {
      const info = e.player || {};
      p = {
        id, pos: info.position, team: e.team || info.team || null,
        name: `${info.first_name || ''} ${info.last_name || ''}`.trim() || id,
        first: info.first_name || '', last: info.last_name || '',
        yrs: info.years_exp, games: [], weeks: {}, adds: 0, drops: 0,
        inj: info.injury_status || null, injPart: info.injury_body_part || null, injNotes: info.injury_notes || null,
      };
      players.set(id, p);
    }
    return p;
  };

  // --- history: per-player game logs + defense-vs-position tables ---
  const dvp = {};   // defense team -> { QB:[pts allowed], ... }
  const defVs = {}; // offense team -> [fantasy pts scored by opposing DEFs]
  statsWeeks.forEach((entries, i) => {
    const w = past[i];
    const teamTgt = {};
    for (const e of entries) if (e.stats?.rec_tgt) teamTgt[e.team] = (teamTgt[e.team] || 0) + e.stats.rec_tgt;
    for (const e of entries) {
      const st = e.stats || {};
      const pos = e.player?.position;
      if (!POSITIONS.includes(pos)) continue;
      if (pos === 'DEF' && st.gp) {
        const d = (dvp[e.team] ||= { QB: [], RB: [], WR: [], TE: [], K: [] });
        for (const k in d) {
          const v = st[`fan_pts_allow_${k.toLowerCase()}`];
          if (typeof v === 'number') d[k].push(v);
        }
        if (e.opponent) (defVs[e.opponent] ||= []).push(score(st));
      }
      if (!st.gp && !st.off_snp) continue;
      const p = touch(e);
      if (e.team) p.team = e.team;
      p.games.push({
        w, opp: e.opponent, pts: score(st),
        snap: st.tm_off_snp ? (st.off_snp || 0) / st.tm_off_snp : null,
        tgt: st.rec_tgt || 0,
        tgtShare: teamTgt[e.team] ? (st.rec_tgt || 0) / teamTgt[e.team] : null,
        line: {
          cmp: st.pass_cmp, att: st.pass_att, py: st.pass_yd, ptd: st.pass_td, int: st.pass_int,
          ra: st.rush_att, ry: st.rush_yd, rtd: st.rush_td, rec: st.rec, tg: st.rec_tgt, rcy: st.rec_yd, rctd: st.rec_td,
          fgm: st.fgm, fga: st.fga, xpm: st.xpm, sack: st.sack, dint: st.int, pa: st.pts_allow,
        },
      });
    }
  });

  // matchup tables: rank 1 = most generous (easiest) defense
  const mtbl = {};
  for (const pos of ['QB', 'RB', 'WR', 'TE', 'K']) {
    const rows = Object.keys(dvp).filter(t => dvp[t][pos].length).map(t => ({ t, v: mean(dvp[t][pos]), n: dvp[t][pos].length }));
    const avg = mean(rows.map(r => r.v));
    rows.sort((a, b) => b.v - a.v);
    mtbl[pos] = {};
    rows.forEach((r, i) => (mtbl[pos][r.t] = { ratio: avg ? 1 + (r.v / avg - 1) * Math.min(1, r.n / 5) : 1, rank: i + 1, n: rows.length, allowed: r.v }));
  }
  {
    const rows = Object.keys(defVs).map(t => ({ t, v: mean(defVs[t]), n: defVs[t].length }));
    const avg = mean(rows.map(r => r.v));
    rows.sort((a, b) => b.v - a.v);
    mtbl.DEF = {};
    rows.forEach((r, i) => (mtbl.DEF[r.t] = { ratio: avg ? 1 + (r.v / avg - 1) * Math.min(1, r.n / 5) : 1, rank: i + 1, n: rows.length, allowed: r.v }));
  }
  const matchup = (pos, opp) => {
    const m = mtbl[pos]?.[opp];
    return m ? { ...m, opp, grade: gradeOf(m.rank, m.n) } : null;
  };

  for (const p of players.values()) {
    p.games.sort((a, b) => a.w - b.w);
    const pts = p.games.map(g => g.pts);
    p.gp = pts.length;
    p.total = sum(pts);
    p.avg = mean(pts);
    p.last3 = mean(pts.slice(-3));
    p.sd = stdev(pts);
    const recent = p.games.slice(-3);
    const snaps = recent.map(g => g.snap).filter(x => x != null);
    const shares = recent.map(g => g.tgtShare).filter(x => x != null);
    p.snap = snaps.length ? mean(snaps) : null;
    p.tgtShare = shares.length && ['WR', 'TE', 'RB'].includes(p.pos) ? mean(shares) : null;
  }

  // --- projections for this week + the next few ---
  const oppByWeek = future.map(() => ({}));
  projWeeks.forEach((entries, i) => {
    const w = future[i];
    for (const e of entries) {
      const info = e.player || {};
      if (!POSITIONS.includes(info.position)) continue;
      if (e.team && e.opponent) oppByWeek[i][e.team] = e.opponent;
      const p = touch(e);
      if (i === 0) {
        if (e.team) p.team = e.team;
        p.inj = info.injury_status || null;
        p.injPart = info.injury_body_part || null;
        p.injNotes = info.injury_notes || null;
      }
      const st = e.stats || {};
      p.weeks[w] = {
        raw: score(st), opp: e.opponent, td: (st.rush_td || 0) + (st.rec_td || 0), fgm: st.fgm || 0, xpm: st.xpm || 0,
        s: Object.fromEntries(PROP_KEYS.map(k => [k, st[k] || 0])),
      };
    }
  });

  for (const a of adds) { const p = players.get(String(a.player_id)); if (p) p.adds = a.count; }
  for (const d of drops) { const p = players.get(String(d.player_id)); if (p) p.drops = d.count; }

  const predictAll = p => {
    const hist = p.gp ? (2 * p.last3 + p.avg) / 3 : 0;
    const cv = p.gp >= 3 && p.avg > 1 ? clamp(p.sd / p.avg, 0.2, 0.9) : 0.45;
    const ros = [];
    future.forEach((w, i) => {
      const opp = oppByWeek[i][p.team];
      if (!opp) { p.weeks[w] = { bye: true, pts: 0, floor: 0, ceil: 0, sd: 0 }; return; }
      const wk = p.weeks[w] || { raw: 0, opp };
      let pts = wk.raw;
      // blend the consensus projection with recent form (bounded so a role change isn't overridden)
      if (p.gp >= 2 && pts > 0) pts = clamp(0.7 * pts + 0.3 * hist, pts * 0.75, pts * 1.25);
      const mu = matchup(p.pos, opp);
      if (mu && pts > 0) pts *= clamp(1 + 0.35 * (mu.ratio - 1), 0.92, 1.08);
      if (i === 0) pts *= INJ_NOW[p.inj] ?? 1;
      else if (i === 1 && p.inj === 'Out') pts *= 0.7;
      const vol = pts * (0.5 * cv + 0.5 * 0.4);
      p.weeks[w] = { ...wk, opp, pts, sd: vol, floor: Math.max(0, pts - vol), ceil: pts + 1.25 * vol, mu };
      ros.push(pts);
    });
    const cur = p.weeks[week];
    Object.assign(p, { pred: cur.pts, floor: cur.floor, ceil: cur.ceil, psd: cur.sd, opp: cur.opp, bye: !!cur.bye, mu: cur.mu, ros: mean(ros) });
  };
  for (const p of players.values()) predictAll(p);

  const model = { season, week, future, players, score, matchup, scoring, preset, predictAll, oppByWeek };
  rerank(model);
  return model;
}

// assign positional ranks + tiers for the week and rest-of-season
export function rerank(model) {
  model.list = [...model.players.values()].filter(p => POSITIONS.includes(p.pos));
  const byPos = key => POSITIONS.map(pos => model.list.filter(p => p.pos === pos && p[key] > 0).sort((a, b) => b[key] - a[key]));
  for (const p of model.list) { p.posRank = p.rosRank = p.tier = p.rosTier = p.ovr = null; }
  for (const list of byPos('pred')) { list.forEach((p, i) => (p.posRank = i + 1)); assignTiers(list, 'pred', 'tier'); }
  for (const list of byPos('ros')) { list.forEach((p, i) => (p.rosRank = i + 1)); assignTiers(list, 'ros', 'rosTier'); }
  model.list.filter(p => ['RB', 'WR', 'TE'].includes(p.pos) && p.pred > 0).sort((a, b) => b.pred - a.pred).forEach((p, i) => (p.ovr = i + 1));
}

function assignTiers(list, key, tierKey) {
  const gaps = list.slice(1).map((p, i) => list[i][key] - p[key]);
  const top = gaps.slice(0, 36);
  const thr = Math.max(0.45, mean(top) + 0.8 * stdev(top));
  let t = 1;
  list.forEach((p, i) => { if (i > 0 && gaps[i - 1] > thr) t++; p[tierKey] = t; });
}

// add a placeholder for a rostered player the projection feeds don't know (e.g. long-term IR)
export function addStub(model, id, info) {
  if (model.players.has(id) || !info) return;
  const p = {
    id, pos: info.position, team: info.team, name: `${info.first_name || ''} ${info.last_name || ''}`.trim(),
    first: info.first_name, last: info.last_name, games: [], weeks: {}, adds: 0, drops: 0,
    inj: info.injury_status || null, injPart: info.injury_body_part, injNotes: info.injury_notes,
    gp: 0, avg: 0, last3: 0, sd: 0, total: 0, snap: null, tgtShare: null,
  };
  model.players.set(id, p);
  model.predictAll(p);
}

// ---------- lineup optimizer ----------
export const SLOT_ELIG = {
  QB: ['QB'], RB: ['RB'], WR: ['WR'], TE: ['TE'], K: ['K'], DEF: ['DEF'],
  FLEX: ['RB', 'WR', 'TE'], WRRB_FLEX: ['RB', 'WR'], REC_FLEX: ['WR', 'TE'], SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'],
};
export const SLOT_LABEL = { FLEX: 'FLEX', WRRB_FLEX: 'W/R', REC_FLEX: 'W/T', SUPER_FLEX: 'SFLX' };

export function optimizeLineup(players, slots, key = 'pred') {
  const starting = slots.filter(s => SLOT_ELIG[s]);
  const order = starting.map((s, i) => ({ s, i })).sort((a, b) => SLOT_ELIG[a.s].length - SLOT_ELIG[b.s].length);
  const pool = [...players].sort((a, b) => (b[key] || 0) - (a[key] || 0));
  const used = new Set();
  const lineup = new Array(starting.length);
  for (const { s, i } of order) {
    const pick = pool.find(p => !used.has(p.id) && SLOT_ELIG[s].includes(p.pos));
    if (pick) used.add(pick.id);
    lineup[i] = { slot: s, player: pick || null };
  }
  const total = sum(lineup.map(l => l.player?.[key] || 0));
  return { lineup, bench: pool.filter(p => !used.has(p.id)), total };
}

export const lineupSd = players => Math.sqrt(sum(players.map(p => (p?.psd || 0) ** 2)));

// ---------- trade values (value over replacement, rest of season) ----------
const SLOT_SHARE = {
  QB: { QB: 1 }, RB: { RB: 1 }, WR: { WR: 1 }, TE: { TE: 1 }, K: { K: 1 }, DEF: { DEF: 1 },
  FLEX: { RB: 0.45, WR: 0.45, TE: 0.1 }, WRRB_FLEX: { RB: 0.5, WR: 0.5 }, REC_FLEX: { WR: 0.8, TE: 0.2 },
  SUPER_FLEX: { QB: 0.85, RB: 0.05, WR: 0.07, TE: 0.03 },
};
export function computeTradeValues(model, teams, slots) {
  const need = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DEF: 0 };
  for (const s of slots) { const e = SLOT_SHARE[s]; if (e) for (const k in e) need[k] += e[k]; }
  const repl = {};
  for (const pos in need) {
    const list = model.list.filter(p => p.pos === pos && p.ros > 0).sort((a, b) => b.ros - a.ros);
    repl[pos] = list[Math.min(list.length - 1, Math.round(need[pos] * teams))]?.ros ?? 0;
  }
  let max = 0;
  for (const p of model.list) { p.vor = Math.max(0, (p.ros || 0) - (repl[p.pos] ?? 0)); max = Math.max(max, p.vor); }
  for (const p of model.list) p.value = max ? Math.round((p.vor / max) * 1000) / 10 : 0;
  model.repl = repl;
}

// ---------- win probability ----------
function erf(x) {
  const s = Math.sign(x); x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}
export function winProb(a, b, sdA, sdB) {
  const s = Math.sqrt(sdA ** 2 + sdB ** 2) || 1;
  return 0.5 * (1 + erf((a - b) / s / Math.SQRT2));
}
