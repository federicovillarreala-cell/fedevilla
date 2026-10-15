// props.js — player props: DraftKings lines (via ESPN) vs. our stat projections
import { getJSON, mean, clamp } from './engine.js';
import { normCdf, amToDec } from './games.js';

const CORE = 'https://sports.core.api.espn.com/v2/sports/football/leagues/nfl';
const SITE = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl';
const DK = 100; // DraftKings provider id
const STD_ODDS = -110; // the feed carries lines but not prices; standard juice assumed (editable in the slip)

// market name -> how to model it. dist: logn (yardage, right-skewed), norm, pois (counts)
export const MARKETS = {
  'Total Passing Yards (incl. overtime)': { key: 'py', label: 'Pass Yds', stat: s => s.pass_yd, hist: l => l.py, dist: 'logn', cv: 0.3 },
  'Total Passing Touchdowns (incl. overtime)': { key: 'ptd', label: 'Pass TDs', stat: s => s.pass_td, hist: l => l.ptd, dist: 'pois' },
  'Total Pass Completions (incl. overtime)': { key: 'cmp', label: 'Completions', stat: s => s.pass_cmp, hist: l => l.cmp, dist: 'norm', cv: 0.2 },
  'Total Passing Attempts (incl. overtime)': { key: 'att', label: 'Pass Attempts', stat: s => s.pass_att, hist: l => l.att, dist: 'norm', cv: 0.18 },
  'Total Passing Interceptions (incl. overtime)': { key: 'int', label: 'Interceptions', stat: s => s.pass_int, hist: l => l.int, dist: 'pois' },
  'Total Passing Plus Rushing Yards (incl. overtime)': { key: 'pry', label: 'Pass+Rush Yds', stat: s => s.pass_yd + s.rush_yd, hist: l => (l.py || 0) + (l.ry || 0), dist: 'logn', cv: 0.27 },
  'Total Rushing Yards (incl. overtime)': { key: 'ry', label: 'Rush Yds', stat: s => s.rush_yd, hist: l => l.ry, dist: 'logn', cv: 0.55 },
  'Total Carries (incl. overtime)': { key: 'car', label: 'Carries', stat: s => s.rush_att, hist: l => l.ra, dist: 'norm', cv: 0.3 },
  'Total Receiving Yards (incl. overtime)': { key: 'rcy', label: 'Rec Yds', stat: s => s.rec_yd, hist: l => l.rcy, dist: 'logn', cv: 0.65 },
  'Total Receptions (incl. overtime)': { key: 'rec', label: 'Receptions', stat: s => s.rec, hist: l => l.rec, dist: 'pois' },
  'Total Rushing Plus Receiving Yards (incl. overtime)': { key: 'rry', label: 'Rush+Rec Yds', stat: s => s.rush_yd + s.rec_yd, hist: l => (l.ry || 0) + (l.rcy || 0), dist: 'logn', cv: 0.45 },
};

const norm = s => String(s || '').toLowerCase().replace(/[.'’-]/g, '').replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '').replace(/\s+/g, ' ').trim();
const espnAbbr = t => (t === 'WAS' ? 'wsh' : t.toLowerCase());

function poisCdf(k, lam) {
  let term = Math.exp(-lam), s = term;
  for (let i = 1; i <= k; i++) { term *= lam / i; s += term; }
  return s;
}
// P(stat > line)
function pOver(mk, mu, line) {
  if (mu <= 0) return 0;
  if (mk.dist === 'pois') return 1 - poisCdf(Math.floor(line), mu);
  if (mk.dist === 'norm') return 1 - normCdf((line - mu) / Math.max(0.5, mk.cv * mu));
  const s2 = Math.log(1 + mk.cv ** 2), m = Math.log(mu) - s2 / 2;
  return 1 - normCdf((Math.log(Math.max(0.5, line)) - m) / Math.sqrt(s2));
}

async function fetchProps(gameId) {
  const base = `${CORE}/events/${gameId}/competitions/${gameId}/odds/${DK}/propBets?limit=1000`;
  const first = await getJSON(base).catch(() => null);
  if (!first?.items) return [];
  const rest = await Promise.all(Array.from({ length: Math.max(0, (first.pageCount || 1) - 1) }, (_, i) => getJSON(`${base}&page=${i + 2}`).catch(() => ({ items: [] }))));
  return first.items.concat(...rest.map(r => r.items || []));
}

export async function buildProps(model, gm) {
  const week = model.week;
  const open = gm.games.filter(g => g.state === 'pre');
  const teams = [...new Set(open.flatMap(g => [g.home, g.away]))];

  // ESPN athlete id -> our player (match on name + team)
  const index = new Map();
  for (const p of model.list) if (p.team) index.set(`${norm(p.name)}|${p.team}`, p);
  const rosters = await Promise.all(teams.map(t => getJSON(`${SITE}/teams/${espnAbbr(t)}/roster`).then(r => [t, r]).catch(() => [t, null])));
  const espnToPlayer = new Map();
  for (const [t, r] of rosters) for (const grp of r?.athletes || []) for (const a of grp.items || []) {
    const p = index.get(`${norm(a.fullName)}|${t}`);
    if (p) espnToPlayer.set(String(a.id), p);
  }

  const all = await Promise.all(open.map(g => fetchProps(g.id).then(items => [g, items])));
  const out = [];
  for (const [g, items] of all) {
    const seen = new Set();
    for (const it of items) {
      const mk = MARKETS[it.type?.name];
      const line = it.current?.target?.value;
      if (!mk || line == null) continue;
      const aid = it.athlete?.$ref?.match(/athletes\/(\d+)/)?.[1];
      const p = espnToPlayer.get(aid);
      if (!p || seen.has(`${aid}:${mk.key}`)) continue;
      seen.add(`${aid}:${mk.key}`);
      const wk = p.weeks[week];
      if (!wk?.s || p.bye) continue;
      const proj = mk.stat(wk.s);
      if (!(proj > 0)) continue;
      // blend the projection with recent games, bounded so one big game can't swing it
      const recent = p.games.slice(-3).map(x => mk.hist(x.line)).filter(v => v != null);
      let mu = proj;
      if (recent.length >= 2) mu = clamp(0.7 * proj + 0.3 * mean(recent), proj * 0.8, proj * 1.2);
      if (p.inj === 'Questionable') mu *= 0.95;
      // Books hang balanced (~-110) lines near the median. Tiny yardage lines (e.g. a WR's rush yds O 0.5) and
      // lines far from our projection are juiced or reflect news we don't have — assuming -110 there invents edges.
      if (mk.dist === 'logn' && line < 9.5) continue;
      if (Math.abs(mu - line) / Math.max(mu, line) > 0.4) continue;
      const raw = pOver(mk, mu, line);
      // prop markets are sharp: our projection gets 35% weight against the book's ~50/50 line
      const over = 0.35 * raw + 0.65 * 0.5;
      const dec = amToDec(STD_ODDS);
      const side = over >= 0.5 ? 'over' : 'under';
      const prob = side === 'over' ? over : 1 - over;
      out.push({
        key: `prop:${aid}:${mk.key}`, p, market: mk.label, mkey: mk.key, line, open: it.open?.target?.value ?? null, mu,
        over, under: 1 - over, side, prob, odds: STD_ODDS, ev: prob * dec - 1, edge: prob - 1 / dec,
        gameId: g.id, game: `${g.away} @ ${g.home}`, date: g.date,
      });
    }
  }
  return out.sort((a, b) => b.ev - a.ev);
}

export const propLabel = (x, side = x.side) => `${x.p.name} ${side === 'over' ? 'O' : 'U'} ${x.line} ${x.market}`;
