// live.js — game-day tracking: NFL game clocks + in-progress fantasy scoring and live win probability
import { API, sum, clamp, winProb } from './engine.js';

const SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
const ABBR = { WSH: 'WAS' }; // ESPN -> Sleeper
const ab = a => ABBR[a] || a;

// live data must skip the app's request memo and the browser cache
export function fresh(url, opts) {
  return fetch(`${url}${url.includes('?') ? '&' : '?'}_=${Date.now()}`, { cache: 'no-store', ...opts }).then(r => {
    if (!r.ok) throw new Error(`Request failed (${r.status})`);
    return r.json();
  });
}
export const freshSleeperMatchups = (leagueId, week) => fresh(`${API}/v1/league/${leagueId}/matchups/${week}`);
// fallback when the league doesn't report per-player points: score Sleeper's live box scores ourselves
export async function freshStatPoints(season, week, score) {
  const pos = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'].map(p => `position[]=${p}`).join('&');
  const rows = await fresh(`${API}/stats/nfl/${season}/${week}?season_type=regular&${pos}`);
  return Object.fromEntries((rows || []).map(e => [String(e.player_id), score(e.stats)]));
}

// team -> { state: pre|in|post, left: share of the game still to play (0-1), detail, date }
export async function fetchGameClock(season, week) {
  const d = await fresh(`${SCOREBOARD}?seasontype=2&week=${week}&dates=${season}`);
  const teams = {};
  for (const e of d.events || []) {
    const c = e.competitions?.[0];
    if (!c) continue;
    const st = c.status || {};
    const state = st.type?.state || 'pre';
    const period = st.period || 1, clock = Number(st.clock) || 0; // clock = seconds left in the quarter
    const left = state === 'pre' ? 1 : state === 'post' ? 0 : period > 4 ? 0.02 : clamp(((4 - period) * 900 + clock) / 3600, 0.01, 1);
    const sides = c.competitors.map(t => ({ team: ab(t.team.abbreviation), score: Number(t.score) || 0 }));
    for (const [i, s] of sides.entries()) {
      const o = sides[1 - i];
      teams[s.team] = { state, left, detail: st.type?.shortDetail || '', date: new Date(e.date), score: s.score, opp: o?.team, oppScore: o?.score || 0 };
    }
  }
  return teams;
}

// one side of a matchup: points banked so far + what the rest of the lineup should still add
export function liveSide(lineup, mm, clock, statPts) {
  const rows = lineup.map(l => {
    const p = l.player;
    if (!p) return { ...l, pts: 0, left: 0, rem: 0, v: 0, game: null };
    const game = clock[p.team || p.id] || null; // no game this week = bye
    const left = game ? game.left : 0;
    const pts = mm?.players_points?.[p.id] ?? statPts?.[p.id] ?? 0;
    return { ...l, pts, left, rem: (p.pred || 0) * left, v: (p.psd || 0) ** 2 * left, game };
  });
  const banked = sum(rows.map(r => r.pts));
  const points = Math.max(mm?.points || 0, banked);
  const count = s => rows.filter(r => r.player && r.game?.state === s).length;
  return { rows, points, final: points + sum(rows.map(r => r.rem)), sd: Math.sqrt(sum(rows.map(r => r.v))), toPlay: count('pre'), playing: count('in'), done: count('post') };
}

export function liveWinProb(a, b) {
  if (a.sd + b.sd < 0.01) return a.final > b.final ? 1 : a.final < b.final ? 0 : 0.5; // everyone is done
  return winProb(a.final, b.final, a.sd, b.sd);
}

export const anyGameOn = clock => Object.values(clock || {}).some(g => g.state === 'in');
export const weekStarted = clock => Object.values(clock || {}).some(g => g.state !== 'pre');
// a game should have kicked off but the scoreboard still says "pre"
export const kickoffDue = clock => Object.values(clock || {}).some(g => g.state === 'pre' && g.date <= new Date());
