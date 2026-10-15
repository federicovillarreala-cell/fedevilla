// espn.js — ESPN Fantasy league adapter: turns ESPN's league data into the app's league shape
const PRO_TEAM = {
  1: 'ATL', 2: 'BUF', 3: 'CHI', 4: 'CIN', 5: 'CLE', 6: 'DAL', 7: 'DEN', 8: 'DET', 9: 'GB', 10: 'TEN', 11: 'IND', 12: 'KC',
  13: 'LV', 14: 'LAR', 15: 'MIA', 16: 'MIN', 17: 'NE', 18: 'NO', 19: 'NYG', 20: 'NYJ', 21: 'PHI', 22: 'ARI', 23: 'PIT',
  24: 'LAC', 25: 'SF', 26: 'SEA', 27: 'TB', 28: 'WAS', 29: 'CAR', 30: 'JAX', 33: 'BAL', 34: 'HOU',
};
const POS_ID = { 1: 'QB', 2: 'RB', 3: 'WR', 4: 'TE', 5: 'K', 16: 'DEF' };
const SLOT = { 0: 'QB', 2: 'RB', 3: 'WRRB_FLEX', 4: 'WR', 5: 'REC_FLEX', 6: 'TE', 7: 'SUPER_FLEX', 16: 'DEF', 17: 'K', 23: 'FLEX', 20: 'BN', 21: 'IR' };
const START_ORDER = [0, 2, 4, 6, 3, 5, 23, 7, 16, 17];
// ESPN scoring stat ids -> Sleeper scoring keys (offense; K/DEF fall back to preset scoring)
const STAT = { 3: 'pass_yd', 4: 'pass_td', 19: 'pass_2pt', 20: 'pass_int', 24: 'rush_yd', 25: 'rush_td', 26: 'rush_2pt', 42: 'rec_yd', 43: 'rec_td', 44: 'rec_2pt', 53: 'rec', 72: 'fum_lost' };

const norm = s => String(s || '').toLowerCase().replace(/[.'’-]/g, '').replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '').replace(/\s+/g, ' ').trim();
const swidNorm = s => String(s || '').replace(/[{}]/g, '').toLowerCase();

// accepts a league id or any ESPN league URL containing leagueId=
export function parseLeagueId(input) {
  const s = String(input || '').trim();
  const m = s.match(/leagueId=(\d+)/i) || s.match(/^(\d{3,})$/);
  return m ? m[1] : null;
}

export async function fetchEspnLeague({ leagueId, season, s2, swid }) {
  const views = ['mTeam', 'mRoster', 'mSettings', 'mMatchupScore', 'mStatus'].map(v => `view=${v}`).join('&');
  let r;
  try {
    r = await fetch(`/espn/seasons/${season}/segments/0/leagues/${leagueId}?${views}`, { headers: { 'X-Espn-S2': s2 || '', 'X-Swid': swid || '' } });
  } catch {
    throw new Error('Could not reach the local server. Open the app with "Start Gridiron IQ.bat".');
  }
  const json = (r.headers.get('content-type') || '').includes('json');
  if (!json) throw new Error('The ESPN connector is not running. Close this tab and open the app with "Start Gridiron IQ.bat".');
  if (r.status === 401 || r.status === 403) throw new Error('This ESPN league is private. Add your espn_s2 and SWID cookies below.');
  if (r.status === 404) throw new Error(`League ${leagueId} wasn't found for the ${season} season. Double-check the league ID.`);
  if (!r.ok) throw new Error(`ESPN returned an error (${r.status}). Try again in a minute.`);
  return r.json();
}

// db = Sleeper's full player database (has espn_id for most players)
export function adaptEspn(d, db, swid) {
  // Sleeper's espn_id coverage is incomplete, so fall back to name (+ position, + NFL team) matching,
  // preferring players currently on an NFL team over retired namesakes
  const byEspn = new Map(), byName = new Map();
  const better = (a, b) => !a || (!db[a].team && db[b].team) || (db[b].active && !db[a].active);
  for (const [id, p] of Object.entries(db || {})) {
    if (p.espn_id) byEspn.set(String(p.espn_id), id);
    const name = p.full_name || `${p.first_name || ''} ${p.last_name || ''}`;
    if (!p.position || !name.trim()) continue;
    for (const key of [`${norm(name)}|${p.position}|${p.team || ''}`, `${norm(name)}|${p.position}`, `${norm(name)}|`]) {
      if (better(byName.get(key), id)) byName.set(key, id);
    }
  }
  const toId = e => {
    const pid = e.playerId;
    if (pid < 0) return PRO_TEAM[-pid - 16000] || null;
    const hit = byEspn.get(String(pid));
    if (hit) return hit;
    const pl = e.playerPoolEntry?.player;
    if (!pl) return null;
    const n = norm(pl.fullName), pos = POS_ID[pl.defaultPositionId] || '', team = PRO_TEAM[pl.proTeamId] || '';
    return byName.get(`${n}|${pos}|${team}`) || byName.get(`${n}|${pos}`) || byName.get(`${n}|`) || null;
  };

  const counts = d.settings?.rosterSettings?.lineupSlotCounts || {};
  const startSlotIds = START_ORDER.flatMap(id => Array(counts[id] || 0).fill(id));
  const roster_positions = [...startSlotIds.map(id => SLOT[id]), ...Array(counts[20] || 0).fill('BN'), ...Array(counts[21] || 0).fill('IR')];

  const scoring = {};
  for (const it of d.settings?.scoringSettings?.scoringItems || []) if (STAT[it.statId]) scoring[STAT[it.statId]] = it.points;
  if (scoring.rec == null) scoring.rec = 0;

  const unmatched = [];
  const rosters = (d.teams || []).map(t => {
    const players = [], reserve = [], bySlot = {};
    for (const e of t.roster?.entries || []) {
      const id = toId(e);
      if (!id) { unmatched.push(e.playerPoolEntry?.player?.fullName || e.playerId); continue; }
      players.push(id);
      if (e.lineupSlotId === 21) reserve.push(id);
      (bySlot[e.lineupSlotId] ||= []).push(id);
    }
    const used = {};
    const starters = startSlotIds.map(id => { const k = used[id] || 0; used[id] = k + 1; return bySlot[id]?.[k] || '0'; });
    const rec = t.record?.overall || {};
    const pf = rec.pointsFor || 0;
    return {
      roster_id: t.id, owner_id: `espn-${t.id}`, owners: (t.owners || []).map(swidNorm), players, starters, reserve,
      settings: { wins: rec.wins || 0, losses: rec.losses || 0, ties: rec.ties || 0, fpts: Math.floor(pf), fpts_decimal: Math.round((pf % 1) * 100), waiver_budget_used: t.transactionCounter?.acquisitionBudgetSpent || 0 },
    };
  });
  const members = new Map((d.members || []).map(m => [swidNorm(m.id), m]));
  const users = (d.teams || []).map(t => {
    const m = members.get(swidNorm(t.primaryOwner || t.owners?.[0]));
    return { user_id: `espn-${t.id}`, display_name: m?.displayName || m?.firstName || `Team ${t.id}`, metadata: { team_name: t.name || [t.location, t.nickname].filter(Boolean).join(' ') || t.abbrev } };
  });

  const period = d.status?.currentMatchupPeriod || d.scoringPeriodId;
  const matchups = [];
  (d.schedule || []).filter(m => m.matchupPeriodId === period).forEach((m, i) => {
    for (const side of [m.home, m.away]) if (side) matchups.push({ roster_id: side.teamId, matchup_id: i + 1, points: side.totalPointsLive ?? side.totalPoints ?? 0, players_points: {} });
  });

  const acq = d.settings?.acquisitionSettings || {};
  const league = {
    name: d.settings?.name || `ESPN League ${d.id}`, total_rosters: rosters.length, roster_positions, scoring_settings: scoring,
    settings: { waiver_type: acq.isUsingAcquisitionBudget || acq.acquisitionType === 'FAAB' ? 2 : 0, waiver_budget: acq.acquisitionBudget || 100 },
  };
  const me = swid ? rosters.find(r => r.owners.includes(swidNorm(swid))) : null;
  return { league, rosters, users, matchups, myRosterId: me?.roster_id ?? null, unmatched };
}
