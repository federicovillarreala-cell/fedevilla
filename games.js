// games.js — NFL game model: power ratings + projection-implied scores vs. the betting market
import { getJSON, range, mean, clamp, INJ_NOW } from './engine.js';

const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
const ABBR = { WSH: 'WAS' }; // ESPN -> Sleeper
const ab = a => ABBR[a] || a;
const MARGIN_SD = 13.2; // NFL final margin std-dev around the expectation
const TOTAL_SD = 13.0;
const HFA = 1.6;

export const scoreboard = (season, week) => getJSON(`${ESPN}?seasontype=2&week=${week}&dates=${season}`);

// ---------- odds math ----------
export const amToDec = am => (am > 0 ? 1 + am / 100 : 1 + 100 / -am);
export const decToAm = d => (d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1)));
export const fairAm = p => decToAm(1 / clamp(p, 0.01, 0.99));
export const fmtAm = am => (am == null || !Number.isFinite(am) ? '—' : am > 0 ? `+${am}` : `${am}`);
const num = s => { const n = parseFloat(String(s ?? '').replace(/[^\d.+-]/g, '')); return Number.isFinite(n) ? n : null; };
const amOdds = s => (s === 'EVEN' ? 100 : num(s));
export function normCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

function parseGame(e) {
  const c = e.competitions?.[0];
  if (!c) return null;
  const home = c.competitors.find(t => t.homeAway === 'home'), away = c.competitors.find(t => t.homeAway === 'away');
  const g = {
    id: e.id, date: new Date(e.date), status: c.status?.type?.name, state: c.status?.type?.state, detail: c.status?.type?.shortDetail,
    home: ab(home.team.abbreviation), away: ab(away.team.abbreviation),
    homeName: home.team.shortDisplayName || home.team.name, awayName: away.team.shortDisplayName || away.team.name,
    homeLogo: home.team.logo, awayLogo: away.team.logo,
    homeScore: Number(home.score) || 0, awayScore: Number(away.score) || 0,
    homeRec: home.records?.[0]?.summary, awayRec: away.records?.[0]?.summary,
  };
  const o = c.odds?.[0];
  if (o) {
    const ps = o.pointSpread, ml = o.moneyline, tot = o.total;
    let hs = num(ps?.home?.close?.line);
    if (hs == null && o.details && o.details !== 'EVEN') {
      const [fav, line] = o.details.split(' ');
      const v = Math.abs(num(line) || 0);
      hs = ab(fav) === g.home ? -v : v;
    }
    if (hs == null && o.details === 'EVEN') hs = 0;
    g.mkt = {
      book: o.provider?.name || 'Sportsbook',
      homeSpread: hs, homeSpreadOdds: amOdds(ps?.home?.close?.odds) ?? -110, awaySpreadOdds: amOdds(ps?.away?.close?.odds) ?? -110,
      homeML: amOdds(ml?.home?.close?.odds), awayML: amOdds(ml?.away?.close?.odds),
      total: num(tot?.over?.close?.line) ?? o.overUnder ?? null,
      overOdds: amOdds(tot?.over?.close?.odds) ?? -110, underOdds: amOdds(tot?.under?.close?.odds) ?? -110,
      openHomeML: amOdds(ml?.home?.open?.odds),
    };
  }
  return g;
}

// offense/defense ratings from final scores (ridge-shrunk toward league average)
function rateTeams(games) {
  const fin = games.filter(g => g.status === 'STATUS_FINAL');
  if (!fin.length) return { off: {}, def: {}, avg: 22, n: {} };
  const avg = mean(fin.flatMap(g => [g.homeScore, g.awayScore]));
  const off = {}, def = {}, n = {};
  for (const g of fin) for (const t of [g.home, g.away]) { off[t] = 0; def[t] = 0; n[t] = (n[t] || 0) + 1; }
  const K = 2.5;
  for (let it = 0; it < 60; it++) {
    const so = {}, sd = {};
    for (const g of fin) {
      so[g.home] = (so[g.home] || 0) + (g.homeScore - HFA / 2 - avg + def[g.away]);
      so[g.away] = (so[g.away] || 0) + (g.awayScore + HFA / 2 - avg + def[g.home]);
      sd[g.home] = (sd[g.home] || 0) + (avg + off[g.away] - (g.awayScore + HFA / 2));
      sd[g.away] = (sd[g.away] || 0) + (avg + off[g.home] - (g.homeScore - HFA / 2));
    }
    for (const t in off) { off[t] = so[t] / (n[t] + K); def[t] = sd[t] / (n[t] + K); }
  }
  return { off, def, avg, n };
}

// team points implied by Sleeper player projections (TDs + kicking), injury-adjusted
function projectedTeamPoints(model, week) {
  const td = {}, kick = {};
  for (const p of model.players.values()) {
    const wk = p.weeks[week];
    if (!wk || wk.bye || !p.team) continue;
    const f = INJ_NOW[p.inj] ?? 1;
    td[p.team] = (td[p.team] || 0) + (wk.td || 0) * f;
    if (p.pos === 'K' && (wk.fgm || wk.xpm)) {
      const cur = kick[p.team];
      const v = { fgm: wk.fgm * f, xpm: wk.xpm * f };
      if (!cur || v.fgm + v.xpm > cur.fgm + cur.xpm) kick[p.team] = v;
    }
  }
  const out = {};
  for (const t in td) {
    const k = kick[t];
    out[t] = 6 * td[t] + (k ? k.xpm + 3 * k.fgm : td[t] * 0.95 + 1.7 * 3);
  }
  return out;
}

export async function buildGameModel(model) {
  const { season, week } = model;
  const boards = await Promise.all(range(1, week).map(w => scoreboard(season, w).catch(() => ({ events: [] }))));
  const all = boards.map((b, i) => (b.events || []).map(parseGame).filter(Boolean).map(g => ({ ...g, week: i + 1 })));
  const past = all.slice(0, -1).flat();
  const cur = all.at(-1) || [];
  const R = rateTeams(past);
  const proj = projectedTeamPoints(model, week);

  // backtest ratings ATS on past weeks is too noisy early on, so weights are fixed priors
  const games = cur.map(g => {
    const ratHome = R.avg + (R.off[g.home] || 0) - (R.def[g.away] || 0) + HFA / 2;
    const ratAway = R.avg + (R.off[g.away] || 0) - (R.def[g.home] || 0) - HFA / 2;
    const parts = [];
    if (proj[g.home] && proj[g.away]) parts.push([0.45, proj[g.home] + HFA / 2, proj[g.away] - HFA / 2]);
    if (past.length) parts.push([0.35, ratHome, ratAway]);
    const m = g.mkt;
    if (m?.homeSpread != null && m.total) parts.push([0.2, (m.total - m.homeSpread) / 2, (m.total + m.homeSpread) / 2]);
    const wsum = parts.reduce((s, x) => s + x[0], 0) || 1;
    const home = parts.reduce((s, x) => s + x[0] * x[1], 0) / wsum;
    const away = parts.reduce((s, x) => s + x[0] * x[2], 0) / wsum;
    const margin = home - away, total = home + away;
    const pHome = normCdf(margin / MARGIN_SD);
    const out = { ...g, model: { home, away, margin, total, pHome, ratHome, ratAway, projHome: proj[g.home], projAway: proj[g.away] } };
    out.bets = m ? buildBets(out) : [];
    return out;
  });
  const done = s => s === 'STATUS_FINAL' || s === 'STATUS_IN_PROGRESS' || s === 'STATUS_HALFTIME' || s === 'STATUS_END_PERIOD';
  const open = games.filter(g => !done(g.status));
  const bets = open.flatMap(g => g.bets).sort((a, b) => b.ev - a.ev);
  return { week, games, bets, ratings: R, power: powerTable(R), tdPicks: tdPicks(model, week, open) };
}

function buildBets(g) {
  const m = g.mkt, md = g.model, out = [];
  // shrink model probability toward the no-vig market price — books are sharp, so only big disagreements survive
  const mk = (type, side, label, odds, pModel, note, otherOdds) => {
    if (odds == null || pModel == null) return;
    const dec = amToDec(odds);
    const fair = otherOdds != null ? (1 / dec) / (1 / dec + 1 / amToDec(otherOdds)) : 1 / dec;
    const w = type === 'ml' && Math.abs(odds) >= 250 ? 0.45 : 0.6;
    const p = w * pModel + (1 - w) * fair;
    out.push({ key: `${g.id}:${type}:${side}`, gameId: g.id, game: `${g.away} @ ${g.home}`, type, side, label, odds, p, implied: 1 / dec, ev: p * dec - 1, edge: p - 1 / dec, note });
  };
  if (m.homeSpread != null) {
    const pH = normCdf((md.margin + m.homeSpread) / MARGIN_SD);
    const sp = v => (v > 0 ? `+${v}` : v === 0 ? 'PK' : `${v}`);
    mk('spread', 'home', `${g.home} ${sp(m.homeSpread)}`, m.homeSpreadOdds, pH, `Model: ${md.margin >= 0 ? g.home : g.away} by ${Math.abs(md.margin).toFixed(1)}`, m.awaySpreadOdds);
    mk('spread', 'away', `${g.away} ${sp(-m.homeSpread)}`, m.awaySpreadOdds, 1 - pH, `Model: ${md.margin >= 0 ? g.home : g.away} by ${Math.abs(md.margin).toFixed(1)}`, m.homeSpreadOdds);
  }
  mk('ml', 'home', `${g.home} ML`, m.homeML, md.pHome, `Model win prob ${Math.round(md.pHome * 100)}%`, m.awayML);
  mk('ml', 'away', `${g.away} ML`, m.awayML, 1 - md.pHome, `Model win prob ${Math.round((1 - md.pHome) * 100)}%`, m.homeML);
  if (m.total) {
    const pO = normCdf((md.total - m.total) / TOTAL_SD);
    mk('total', 'over', `${g.away}/${g.home} O ${m.total}`, m.overOdds, pO, `Model total ${md.total.toFixed(1)}`, m.underOdds);
    mk('total', 'under', `${g.away}/${g.home} U ${m.total}`, m.underOdds, 1 - pO, `Model total ${md.total.toFixed(1)}`, m.overOdds);
  }
  return out;
}

function powerTable(R) {
  return Object.keys(R.off).map(t => ({ team: t, off: R.off[t], def: R.def[t], net: R.off[t] + R.def[t], gp: R.n[t] }))
    .sort((a, b) => b.net - a.net);
}

// anytime TD probability from projected TDs (Poisson)
function tdPicks(model, week, openGames) {
  const teams = new Set(openGames.flatMap(g => [g.home, g.away]));
  return model.list
    .filter(p => ['RB', 'WR', 'TE', 'QB'].includes(p.pos) && teams.has(p.team) && !['Out', 'IR', 'PUP', 'Sus', 'Doubtful'].includes(p.inj))
    .map(p => {
      // projection feeds run TD-hot vs. real scoring rates; 0.82 calibrates toward market anytime-TD prices
      const lam = 0.82 * (p.weeks[week]?.td || 0) * (INJ_NOW[p.inj] ?? 1);
      const prob = 1 - Math.exp(-lam);
      return { p, lam, prob, fair: fairAm(prob), key: `td:${p.id}` };
    })
    .filter(x => x.prob > 0.2)
    .sort((a, b) => b.prob - a.prob)
    .slice(0, 30);
}

// ---------- confidence labels ----------
export function betTier(b) {
  if (b.ev >= 0.06 && b.p >= 0.56) return ['LOCK', 'lock'];
  if (b.ev >= 0.03) return ['STRONG', 'strong'];
  if (b.ev > 0) return ['LEAN', 'lean'];
  return ['PASS', 'pass'];
}

// ---------- parlay math ----------
export function analyzeParlay(legs) {
  if (!legs.length) return null;
  const dec = legs.reduce((d, l) => d * amToDec(l.odds), 1);
  const p = legs.reduce((x, l) => x * l.p, 1);
  const implied = 1 / dec;
  const ev = p * dec - 1;
  const b = dec - 1;
  const kelly = Math.max(0, (b * p - (1 - p)) / b) / 4;
  const games = legs.map(l => l.gameId).filter(Boolean);
  const sameGame = games.length !== new Set(games).size;
  const grade = ev > 0.15 ? 'A+' : ev > 0.08 ? 'A' : ev > 0.03 ? 'B' : ev > -0.03 ? 'C' : ev > -0.12 ? 'D' : 'F';
  return { dec, am: decToAm(dec), p, implied, ev, kelly, sameGame, grade, weakest: [...legs].sort((a, b2) => (a.p * amToDec(a.odds)) - (b2.p * amToDec(b2.odds)))[0] };
}
