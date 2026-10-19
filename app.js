// app.js — UI for Gridiron IQ
import {
  sleeper, buildModel, rerank, addStub, optimizeLineup, computeTradeValues, winProb, lineupSd,
  SLOT_ELIG, SLOT_LABEL, scoringLabel, clearCache, mean, sum, clamp, range, INJ_NOW,
} from './engine.js';
import { buildGameModel, analyzeParlay, betTier, fmtAm, fairAm, normCdf } from './games.js';
import { buildProps, propLabel } from './props.js';
import { fetchEspnLeague, adaptEspn, parseLeagueId } from './espn.js';
import { fetchGameClock, freshSleeperMatchups, freshStatPoints, liveSide, liveWinProb, anyGameOn, weekStarted, kickoffDue } from './live.js';

// ---------- helpers ----------
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const f1 = x => (Number.isFinite(x) ? x : 0).toFixed(1);
const pct = x => (x == null ? '—' : `${Math.round(x * 100)}%`);
const fmtK = n => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));
const ordinal = n => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

const DEFAULT_SLOTS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DEF'];
const OUT = ['Out', 'IR', 'PUP', 'Sus', 'NA', 'DNR', 'COV'];

const S = {
  cfg: store.get('giq_cfg', null),
  tab: store.get('giq_tab', 'team'),
  setup: { step: 'start' },
  nfl: null, model: null, league: null, rosters: [], users: [], matchups: [],
  owner: new Map(), slots: DEFAULT_SLOTS,
  rank: { pos: 'ALL', mode: 'week', q: '', avail: 'all' },
  wvPos: 'ALL', tvPos: 'ALL',
  compare: [], trade: { give: [], get: [], partner: null },
  live: null,
  gm: null, gmError: null, props: null, propsError: null, propMkt: 'ALL', parlay: store.get('giq_parlay', []),
};
const saveParlay = () => store.set('giq_parlay', S.parlay);
// setup is kept in this browser AND on the PC running the app, so it survives cleared storage or a new address
const deviceHeaders = () => { const d = store.get('giq_device', null); return d ? { 'X-Giq-Device': d } : {}; };
function syncSetup() {
  fetch('/api/setup', { method: 'POST', headers: { 'Content-Type': 'application/json', ...deviceHeaders() }, body: JSON.stringify({ cfg: S.cfg }) }).catch(() => {});
}
async function restoreSetup() {
  try {
    const r = await fetch('/api/setup', { headers: deviceHeaders() });
    if (!r.ok) return null;
    return (await r.json()).cfg || null;
  } catch { return null; }
}
const saveCfg = () => { store.set('giq_cfg', S.cfg); syncSetup(); };
const P = id => S.model?.players.get(String(id));
const isLeague = () => S.cfg?.mode === 'sleeper' || S.cfg?.mode === 'espn';
const platformName = () => (S.cfg?.mode === 'espn' ? 'ESPN' : 'Sleeper');

// ---------- rosters ----------
const myId = () => (isLeague() ? S.cfg.rosterId : 'me');
const allRosters = () => (isLeague() ? S.rosters : [{ roster_id: 'me', players: S.cfg.roster || [], starters: [], reserve: [] }]);
const rosterById = rid => allRosters().find(r => r.roster_id === rid);
const myRoster = () => rosterById(myId());
const activePlayers = r => (r?.players || [])
  .filter(id => !(r.reserve || []).includes(id) && !(r.taxi || []).includes(id))
  .map(P).filter(Boolean);
const reservePlayers = r => (r?.reserve || []).map(P).filter(Boolean);
function teamName(rid) {
  if (rid === 'me') return 'My Team';
  const r = rosterById(rid);
  const u = S.users.find(x => x.user_id === r?.owner_id);
  return u?.metadata?.team_name || u?.display_name || `Team ${rid}`;
}
function buildOwners() {
  S.owner = new Map();
  for (const r of allRosters()) for (const id of r.players || []) S.owner.set(String(id), r.roster_id);
}
function currentLineup(r) {
  if (!isLeague() || !r.starters?.length) return optimizeLineup(activePlayers(r), S.slots).lineup;
  const startSlots = S.league.roster_positions.filter(s => !['BN', 'IR', 'TAXI'].includes(s));
  return startSlots
    .map((s, i) => ({ slot: s, player: r.starters[i] && r.starters[i] !== '0' ? P(r.starters[i]) : null }))
    .filter(l => SLOT_ELIG[l.slot]);
}
const rosterCap = () => (isLeague() ? S.league.roster_positions.filter(s => !['IR', 'TAXI'].includes(s)).length : 16);

// ---------- small UI atoms ----------
const avatar = p => {
  const src = p.pos === 'DEF'
    ? `https://sleepercdn.com/images/team_logos/nfl/${String(p.id).toLowerCase()}.png`
    : `https://sleepercdn.com/content/nfl/players/thumb/${p.id}.jpg`;
  const ini = p.pos === 'DEF' ? p.id : `${(p.first || '?')[0]}${(p.last || '')[0] || ''}`;
  return `<div class="av ${p.pos === 'DEF' ? 'def' : ''}">${esc(ini)}<img loading="lazy" alt="" src="${src}" onerror="this.remove()"></div>`;
};
function injTag(p) {
  if (!p.inj) return '';
  const cls = p.inj === 'Questionable' ? 'Q' : p.inj === 'Doubtful' ? 'D' : 'O';
  const label = p.inj === 'Questionable' ? 'Q' : p.inj === 'Doubtful' ? 'D' : p.inj === 'Out' ? 'OUT' : p.inj.toUpperCase();
  return `<span class="inj ${cls}" title="${esc(p.inj)}${p.injPart ? ' — ' + esc(p.injPart) : ''}">${label}</span>`;
}
// "L. Jackson" on phones; defenses go by nickname ("Panthers")
const shortName = p => p.pos === 'DEF' ? (p.last || p.name) : p.first && p.last ? `${p.first[0]}. ${p.last}` : p.name;
const plCell = (p, extra = '') => p ? `<div class="pl" data-player="${p.id}">${avatar(p)}<div style="min-width:0"><div class="pl-name"><span class="nm-full">${esc(p.name)}</span><span class="nm-short">${esc(shortName(p))}</span> ${injTag(p)}</div><div class="pl-meta"><span class="pos ${p.pos}">${p.pos}</span>${esc(p.team || 'FA')}<span class="m-only">${p.bye ? '· BYE' : p.opp ? `· vs ${esc(p.opp)}` : ''}</span>${extra}</div></div></div>`
  : `<span class="muted">Empty</span>`;
const oppText = (p, w = S.model.week) => { const wk = p?.weeks[w]; return !wk ? '—' : wk.bye ? '<span class="muted">BYE</span>' : wk.opp ? `vs ${wk.opp}` : '—'; };
const muBadge = (p, w = S.model.week) => {
  const m = p?.weeks[w]?.mu;
  return m ? `<span class="grade ${m.grade}" title="${m.opp} is the ${ordinal(m.rank)} most generous defense to ${p.pos}s">${m.grade}</span>` : '<span class="muted">—</span>';
};
const trendCell = p => p.adds > p.drops && p.adds > 50 ? `<span class="trend up">▲ ${fmtK(p.adds)}</span>`
  : p.drops > 50 ? `<span class="trend down">▼ ${fmtK(p.drops)}</span>` : '<span class="muted">—</span>';
const rankLabel = (p, key = 'posRank') => (p[key] ? `${p.pos}${p[key]}` : '—');
function ownerChip(p) {
  const o = S.owner.get(p.id);
  if (o === myId()) return '<span class="chip me">Mine</span>';
  if (o != null) return `<span class="chip" title="${esc(teamName(o))}">${esc(teamName(o).slice(0, 14))}</span>`;
  return isLeague() ? '<span class="chip fa">FA</span>' : '';
}
const slotTag = s => `<span class="slot">${SLOT_LABEL[s] || s}</span>`;
const seg = (act, cur, opts) => `<div class="seg">${opts.map(([v, l]) => `<button data-act="${act}" data-v="${v}" class="${v === cur ? 'on' : ''}">${l}</button>`).join('')}</div>`;
const searchBox = (target, ph) => `<div class="search" data-search="${target}"><input class="input" placeholder="${ph}" autocomplete="off"><div class="results"></div></div>`;
const heat = (rank, n) => {
  const t = n > 1 ? (rank - 1) / (n - 1) : 0;
  const hue = 140 - t * 140;
  return `<span class="heat" style="background:hsl(${hue} 70% 45% / .18);color:hsl(${hue} 75% 62%)">${ordinal(rank)}</span>`;
};

// ---------- boot ----------
async function init() {
  renderChrome();
  try {
    S.nfl = await sleeper.state();
  } catch (e) {
    return renderError('Could not reach the Sleeper API. Check your internet connection.', e);
  }
  navigator.storage?.persist?.().catch(() => {});
  if (!S.cfg) {
    S.cfg = await restoreSetup();
    if (S.cfg) store.set('giq_cfg', S.cfg);
  } else if (isLocalhost() || store.get('giq_device', null)) syncSetup();
  if (!S.cfg) { await serverInfo(); return renderSetup(); }
  await loadAll();
}

async function loadAll() {
  renderLoading('Loading your league');
  try {
    const season = S.nfl.season;
    const week = clamp(S.nfl.season_type === 'regular' ? S.nfl.display_week || S.nfl.week || 1 : 1, 1, 18);
    let scoring = null;
    if (S.cfg.mode === 'espn') {
      const [raw, db] = await Promise.all([fetchEspnLeague({ leagueId: S.cfg.leagueId, season, s2: S.cfg.s2, swid: S.cfg.swid }), sleeper.allPlayers()]);
      const a = adaptEspn(raw, db, S.cfg.swid);
      if (a.unmatched.length) console.info('ESPN players not matched:', a.unmatched);
      Object.assign(S, { league: a.league, rosters: a.rosters, users: a.users, matchups: a.matchups });
      scoring = a.league.scoring_settings;
      S.slots = a.league.roster_positions;
    } else if (isLeague()) {
      const id = S.cfg.leagueId;
      const [league, rosters, users, matchups] = await Promise.all([
        sleeper.league(id), sleeper.rosters(id), sleeper.users(id), sleeper.matchups(id, week).catch(() => []),
      ]);
      Object.assign(S, { league, rosters, users, matchups: matchups || [] });
      scoring = league.scoring_settings;
      S.slots = league.roster_positions;
    } else {
      Object.assign(S, { league: null, rosters: [], users: [], matchups: [] });
      S.slots = DEFAULT_SLOTS;
    }
    S.model = await buildModel({ season, week, scoring, preset: S.cfg.preset || 'ppr', onStep: renderLoading });
    buildOwners();
    const missing = [...S.owner.keys()].filter(id => !S.model.players.has(id));
    if (missing.length) {
      renderLoading('Looking up the rest of your roster');
      const db = await sleeper.allPlayers().catch(() => ({}));
      for (const id of missing) addStub(S.model, id, db[id]);
      rerank(S.model);
    }
    computeTradeValues(S.model, S.league?.total_rosters || 12, S.slots);
    S.gm = null; S.gmError = null; S.props = null; S.propsError = null; gmPromise = null;
    S.loadedAt = new Date();
    S.live = null;
    render();
    refreshLive();
  } catch (e) {
    renderError('Something went wrong loading data.', e);
  }
}

// ---------- chrome ----------
const TABS = [['team', 'My Team'], ['coach', '🧠 Coach'], ['startsit', 'Start / Sit'], ['matchup', 'Matchup'], ['picks', '🔒 Picks & Parlays'], ['rankings', 'Rankings'], ['waivers', 'Waivers'], ['trade', 'Trade Analyzer'], ['league', 'League']];
function renderChrome() {
  const m = S.model;
  $('#brandSub').textContent = m
    ? [`Week ${m.week} · ${m.season}`, scoringLabel(m.scoring, m.preset), S.league?.name].filter(Boolean).join(' · ')
    : 'Fantasy football analyzer';
  const phoneBtn = isStandalone() ? '' : '<button class="btn sm" data-act="phone" title="Put Gridiron IQ on your phone">📱 Phone app</button>';
  $('#topActions').innerHTML = !m ? phoneBtn : phoneBtn + `
    ${!isLeague() ? seg('preset', S.cfg.preset || 'ppr', [['ppr', 'PPR'], ['half', 'Half'], ['std', 'Std']]) : ''}
    <button class="btn sm" data-act="refresh" title="Refresh data">↻ Refresh</button>
    <button class="btn sm ghost" data-act="switch" title="Switch league">⇄ ${isLeague() ? 'League' : 'Setup'}</button>`;
  const tabs = TABS.filter(([k]) => isLeague() || !['matchup', 'league'].includes(k));
  if (!tabs.some(([k]) => k === S.tab)) S.tab = 'team';
  $('#tabs').innerHTML = m ? tabs.map(([k, l]) => `<button class="tab ${S.tab === k ? 'active' : ''}" data-tab="${k}">${l}</button>`).join('') : '';
  $('#tabs').style.display = m ? '' : 'none';
}
const ICON = {
  team: '<path d="M16 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1"/><circle cx="9" cy="7" r="4"/><path d="M22 19v-1a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>',
  coach: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V3h6v1M9 10h6M9 14h6M9 18h3"/>',
  picks: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.2"/>',
  rankings: '<path d="M4 20V11M10 20V5M16 20v-6M21 20H3"/>',
  more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
};
const svg = k => `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${ICON[k]}</svg>`;
const BOTTOM = [['team', 'Team'], ['coach', 'Coach'], ['picks', 'Picks'], ['rankings', 'Ranks']];
function renderBottomBar() {
  const bar = $('#bottombar');
  if (!S.model) { bar.innerHTML = ''; return; }
  const inMore = !BOTTOM.some(([k]) => k === S.tab);
  bar.innerHTML = BOTTOM.map(([k, l]) => `<button class="bb ${S.tab === k ? 'on' : ''}" data-tab="${k}">${svg(k)}<span>${l}</span></button>`).join('')
    + `<button class="bb ${inMore ? 'on' : ''}" data-act="more">${svg('more')}<span>${inMore ? (TABS.find(([k]) => k === S.tab)?.[1] || 'More').replace(/^\W+\s*/, '').split(' ')[0] : 'More'}</span></button>`;
  const fab = $('#slipFab');
  fab.hidden = S.tab !== 'picks';
  fab.innerHTML = `🎟 Slip${S.parlay.length ? ` <b>${S.parlay.length}</b>` : ''}`;
}
function openMore() {
  S.sheet = 'more';
  const tabs = TABS.filter(([k]) => !BOTTOM.some(([b]) => b === k) && (isLeague() || !['matchup', 'league'].includes(k)));
  $('#modalCard').innerHTML = `<div class="sheet-grab"></div>
    <div class="more-grid">${tabs.map(([k, l]) => `<button class="more-item ${S.tab === k ? 'on' : ''}" data-tab="${k}">${esc(l.replace(/^\W+\s*/, ''))}</button>`).join('')}</div>
    <div class="more-list">
      ${!isLeague() ? `<div class="more-row"><span>Scoring</span>${seg('preset', S.cfg.preset || 'ppr', [['ppr', 'PPR'], ['half', 'Half'], ['std', 'Std']])}</div>` : ''}
      <button class="more-row" data-act="refresh"><span>↻ Refresh data</span><em>${S.loadedAt ? 'updated ' + S.loadedAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''}</em></button>
      ${!isStandalone() ? '<button class="more-row" data-act="phone"><span>📱 Add to home screen</span><em>›</em></button>' : ''}
      <button class="more-row" data-act="switch"><span>⇄ ${isLeague() ? 'Switch league' : 'Change setup'}</span><em>${esc(S.league?.name || '')}</em></button>
    </div>`;
  $('#modal').hidden = false;
}
function openSlip() {
  S.sheet = 'slip';
  $('#modalCard').innerHTML = `<div class="sheet-grab"></div>${parlayPanel().replace('class="card slip"', 'class="slip-sheet"')}`;
  $('#modal').hidden = false;
}

function render() {
  renderChrome();
  renderBottomBar();
  const view = { team: viewTeam, startsit: viewStartSit, matchup: viewMatchup, picks: viewPicks, coach: viewCoach, rankings: viewRankings, waivers: viewWaivers, trade: viewTrade, league: viewLeague }[S.tab] || viewTeam;
  $('#view').innerHTML = view() + `<div class="foot">Data: Sleeper public API · projections blended with recent form, matchup & injury status · updated ${S.loadedAt?.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) || ''}</div>`;
  if (S.tab === 'rankings') renderRankTable();
  if (S.openGameId && !$('#modal').hidden) openGame(S.openGameId);
  else if (S.sheet === 'slip' && !$('#modal').hidden) openSlip();
}
function renderLoading(msg) {
  if ($('#bottombar')) $('#bottombar').innerHTML = '';
  S.model = S.model && msg === 'Loading your league' ? null : S.model;
  renderChrome();
  $('#view').innerHTML = `<div class="center"><div style="text-align:center"><div class="spinner"></div><div style="font-weight:700">${esc(msg)}…</div><div class="muted" style="margin-top:4px">Pulling the latest stats, projections & injuries</div></div></div>`;
}
function renderError(msg, e) {
  console.error(e);
  $('#view').innerHTML = `<div class="center"><div class="card setup" style="text-align:center"><h3>${esc(msg)}</h3><div class="sub">${esc(e?.message || '')}</div><div class="row" style="justify-content:center"><button class="btn primary" data-act="retry">Try again</button><button class="btn" data-act="switch">Change setup</button></div></div></div>`;
}

// ---------- setup ----------
function renderSetup() {
  S.model = null;
  renderChrome();
  const st = S.setup;
  let body = '';
  if (st.step === 'start') {
    body = `
      <h1>Win your week.</h1>
      <p class="lead">Weekly projections, start/sit calls, waiver targets, trade grades, rankings and betting picks — built from live NFL stats and your league's exact scoring.</p>
      <button class="opt" data-act="espnStart"><div class="oi" style="background:#ef44441f;color:#f87171">E</div><div><b>Connect ESPN league</b><small>Paste your league link — roster, lineup, scoring, matchups & real free agents</small></div></button>
      <div class="muted" style="text-align:center;margin:14px 0 10px;font-size:12px">— or use Sleeper —</div>
      <form data-form="user">
        <label class="muted" style="font-size:12px;font-weight:600">SLEEPER USERNAME</label>
        <div class="row" style="margin-top:6px"><input class="input" name="u" placeholder="e.g. fantasyking22" value="${esc(st.username || '')}" autofocus><button class="btn primary" ${st.busy ? 'disabled' : ''}>${st.busy ? 'Finding…' : 'Connect'}</button></div>
        ${st.error ? `<div class="err">${esc(st.error)}</div>` : ''}
      </form>
      <div class="muted" style="text-align:center;margin:18px 0 12px;font-size:12px">— or —</div>
      <button class="opt" data-act="manual"><div class="oi">+</div><div><b>Yahoo or another app</b><small>Add your players by hand — every feature except league matchups works</small></div></button>
      ${S.server?.cloud ? '<button class="opt" data-act="loginStart"><div class="oi">🔒</div><div><b>This is my app — unlock</b><small>Enter your owner passcode to bring back your saved league</small></div></button>' : ''}
      ${!isLocalhost() ? '<button class="opt" data-act="pairStart"><div class="oi">⇆</div><div><b>Copy setup from my computer</b><small>Enter the 6-digit code from the 📱 Phone app button on your PC</small></div></button>' : ''}
      <button class="opt" data-act="browse"><div class="oi">☰</div><div><b>Just browse rankings</b><small>Weekly & rest-of-season rankings, waivers and trade values</small></div></button>`;
  } else if (st.step === 'pair') {
    body = `<h1>Copy your setup</h1>
      <p class="lead">On your computer, open Gridiron IQ, tap <b>📱 Phone app</b> and then <b>Make pairing code</b>. Enter the 6-digit code here.</p>
      <form data-form="pair"><input class="input pair-input" name="code" inputmode="numeric" maxlength="7" placeholder="000000" autocomplete="one-time-code" autofocus>
        <button class="btn primary block" ${st.busy ? 'disabled' : ''}>${st.busy ? 'Copying…' : 'Copy setup'}</button>
        ${st.error ? `<div class="err">${esc(st.error)}</div>` : ''}</form>
      <button class="btn ghost mt" data-act="setupBack">← Back</button>`;
  } else if (st.step === 'login') {
    body = `<h1>Unlock your app</h1>
      <p class="lead">Enter the owner passcode you chose when you put Gridiron IQ online. This device will stay unlocked.</p>
      <form data-form="login"><input class="input" type="password" name="passcode" placeholder="Owner passcode" autocomplete="current-password" autofocus>
        <button class="btn primary block mt" ${st.busy ? 'disabled' : ''}>${st.busy ? 'Unlocking… (can take a minute if the app was asleep)' : 'Unlock'}</button>
        ${st.error ? `<div class="err">${esc(st.error)}</div>` : ''}</form>
      <button class="btn ghost mt" data-act="setupBack">← Back</button>`;
  } else if (st.step === 'espn') {
    body = `<h1>Connect ESPN</h1>
      <p class="lead">Open your league on the ESPN Fantasy website, copy the link from the address bar and paste it here (or just the league ID).</p>
      <form data-form="espn">
        <label class="muted" style="font-size:12px;font-weight:600">LEAGUE LINK OR ID</label>
        <input class="input" name="lid" style="margin-top:6px" placeholder="https://fantasy.espn.com/football/team?leagueId=123456&teamId=1" value="${esc(st.lid || '')}" autofocus>
        ${st.needCookies ? `<div class="alert info mt"><div class="ico">★</div><div><div><b>Easiest fix:</b> make the league public — no codes needed.</div>
          <div class="t">On ESPN open your league → <b>League</b> → <b>Settings</b> → <b>Edit Settings</b> (League Manager) → set <b>Make League Viewable to Public</b> to <b>Yes</b> → Save. Not the commissioner? Ask them to flip it. Then press Connect again.</div></div></div>` : ''}
        <details class="mt" ${st.needCookies || st.s2 ? 'open' : ''}><summary style="cursor:pointer;font-weight:650">${st.needCookies ? 'Or keep it private: copy 2 codes from ESPN' : 'Private league? Add your ESPN cookies'}</summary>
          <ol class="muted" style="font-size:12.5px;line-height:1.7;padding-left:18px">
            <li>On your <b>computer</b>, open <b>Chrome</b> and log in at <b>fantasy.espn.com</b>.</li>
            <li>Press the <b>F12</b> key. A panel opens on the side.</li>
            <li>At the top of that panel click <b>Application</b> (if hidden, click <b>»</b> to find it).</li>
            <li>On its left side open <b>Cookies</b> and click <b>https://fantasy.espn.com</b>.</li>
            <li>Type <b>espn_s2</b> in the panel's filter box, double-click the long text in the <b>Value</b> column, copy it (Ctrl+C) and paste it in the first box below.</li>
            <li>Do the same for <b>SWID</b> (it looks like <b>{1A2B3C4D-…}</b>) and paste it in the second box.</li>
          </ol>
          <input class="input" name="s2" placeholder="espn_s2 (long code)" value="${esc(st.s2 || '')}" autocomplete="off">
          <input class="input" name="swid" style="margin-top:8px" placeholder="SWID — looks like {1A2B3C4D-...}" value="${esc(st.swid || '')}" autocomplete="off">
          <div class="muted" style="font-size:11.5px;margin-top:6px">Saved only in this browser and only sent to ESPN through your own Gridiron IQ server. They also let us find your team automatically.</div>
        </details>
        <button class="btn primary block" ${st.busy ? 'disabled' : ''}>${st.busy ? 'Connecting…' : 'Connect ESPN league'}</button>
        ${st.error ? `<div class="err">${esc(st.error)}</div>` : ''}
      </form>
      <button class="btn ghost mt" data-act="setupBack">← Back</button>`;
  } else if (st.step === 'leagues') {
    body = `<h1>Pick a league</h1><p class="lead">Signed in as <b>${esc(st.user.display_name)}</b> · ${S.nfl.season} season</p>
      ${st.leagues.length ? st.leagues.map(l => `<button class="opt" data-act="pickLeague" data-id="${l.league_id}"><div class="oi">${l.total_rosters}</div><div><b>${esc(l.name)}</b><small>${l.total_rosters} teams · ${scoringLabel(l.scoring_settings)} · ${l.roster_positions.filter(s => s !== 'BN').length} starters</small></div></button>`).join('')
        : '<div class="empty">No NFL leagues found for this season.</div>'}
      ${st.error ? `<div class="err">${esc(st.error)}</div>` : ''}
      <button class="btn ghost mt" data-act="setupBack">← Back</button>`;
  } else if (st.step === 'team') {
    body = `<h1>Which team is yours?</h1><p class="lead">We couldn't match your account to a roster automatically.</p>
      ${st.rosters.map(r => { const u = st.users.find(x => x.user_id === r.owner_id); return `<button class="opt" data-act="pickRoster" data-id="${r.roster_id}"><div class="oi">${r.roster_id}</div><div><b>${esc(u?.metadata?.team_name || u?.display_name || 'Team ' + r.roster_id)}</b><small>${r.settings?.wins ?? 0}-${r.settings?.losses ?? 0}</small></div></button>`; }).join('')}
      <button class="btn ghost mt" data-act="setupBack">← Back</button>`;
  }
  $('#view').innerHTML = `<div class="center"><div class="card setup" style="padding:28px">${body}</div></div>`;
}

async function connectUser(name) {
  const st = S.setup;
  st.username = name.trim();
  if (!st.username) return;
  st.busy = true; st.error = null; renderSetup();
  try {
    const user = await sleeper.user(st.username);
    if (!user) throw new Error(`No Sleeper user named "${st.username}"`);
    const leagues = await sleeper.leagues(user.user_id, S.nfl.season);
    Object.assign(st, { user, leagues: leagues || [], step: 'leagues' });
  } catch (e) { st.error = e.message; }
  st.busy = false;
  renderSetup();
}
async function connectEspn(form) {
  const st = S.setup;
  const fd = new FormData(form);
  Object.assign(st, { lid: String(fd.get('lid') || '').trim(), s2: String(fd.get('s2') || '').trim(), swid: String(fd.get('swid') || '').trim() });
  const leagueId = parseLeagueId(st.lid);
  if (!leagueId) { st.error = 'Paste your ESPN league link or the number after "leagueId=".'; return renderSetup(); }
  if (st.swid && !/^\{?[0-9a-f-]{30,}\}?$/i.test(st.swid)) { st.error = 'That SWID looks off — it should look like {1A2B3C4D-...}.'; return renderSetup(); }
  st.busy = true; st.error = null; renderSetup();
  try {
    const [raw, db] = await Promise.all([fetchEspnLeague({ leagueId, season: S.nfl.season, s2: st.s2, swid: st.swid }), sleeper.allPlayers()]);
    const a = adaptEspn(raw, db, st.swid);
    const cfg = { mode: 'espn', leagueId, s2: st.s2, swid: st.swid };
    st.busy = false;
    if (a.myRosterId != null) return finishSetup({ ...cfg, rosterId: a.myRosterId });
    Object.assign(st, { step: 'team', platform: cfg, rosters: a.rosters, users: a.users });
    return renderSetup();
  } catch (e) {
    st.error = e.message;
    st.needCookies = /private/i.test(e.message);
  }
  st.busy = false;
  renderSetup();
}
async function pickLeague(id) {
  const st = S.setup;
  try {
    const [rosters, users] = await Promise.all([sleeper.rosters(id), sleeper.users(id)]);
    const mine = rosters.find(r => r.owner_id === st.user.user_id || (r.co_owners || []).includes(st.user.user_id));
    const cfg = { mode: 'sleeper', leagueId: id, username: st.username };
    if (mine) return finishSetup({ ...cfg, rosterId: mine.roster_id });
    Object.assign(st, { step: 'team', platform: cfg, rosters, users });
    renderSetup();
  } catch (e) { st.error = e.message; renderSetup(); }
}
function finishSetup(cfg) {
  S.cfg = { preset: 'ppr', roster: [], ...S.cfg, ...cfg };
  saveCfg();
  S.tab = 'team';
  S.compare = []; S.trade = { give: [], get: [], partner: null };
  loadAll();
}

// =====================================================================
// MY TEAM
// =====================================================================
function viewTeam() {
  const r = myRoster();
  const ps = activePlayers(r);
  if (!ps.length) return emptyTeam();
  const opt = optimizeLineup(ps, S.slots, 'pred');
  const cur = currentLineup(r);
  const curTotal = sum(cur.map(l => l.player?.pred || 0));
  const gain = opt.total - curTotal;
  const mu = myMatchup();
  const strength = teamStrength();
  const me = strength.find(t => t.rid === myId());
  const rec = isLeague() ? r.settings : null;

  const stats = `
  <div class="grid g4">
    <div class="card stat"><div class="label">Projected · Wk ${S.model.week}</div><div class="value">${f1(curTotal)}</div><div class="hint">Best possible lineup: ${f1(opt.total)}</div></div>
    ${wpCard(mu)}
    <div class="card stat"><div class="label">Lineup upgrade</div><div class="value ${gain > 0.05 ? 'warn' : 'good'}">${gain > 0.05 ? '+' + f1(gain) : 'Optimal ✓'}</div><div class="hint">${gain > 0.05 ? '<a href="#" data-tab="startsit">See recommended swaps →</a>' : 'Your starters are the best plays'}</div></div>
    <div class="card stat"><div class="label">${rec ? 'Record' : 'ROS strength'}</div><div class="value">${rec ? `${rec.wins}-${rec.losses}${rec.ties ? '-' + rec.ties : ''}` : f1(me?.ros)}</div><div class="hint">${rec ? `Power rank ${ordinal(me.power)} of ${strength.length} · ${f1(rec.fpts + (rec.fpts_decimal || 0) / 100)} PF` : 'Projected pts/week, next 5 weeks'}</div></div>
  </div>`;

  const groups = [['Starters', cur.map(l => ({ slot: l.slot, p: l.player }))]];
  const startIds = new Set(cur.map(l => l.player?.id));
  groups.push(['Bench', ps.filter(p => !startIds.has(p.id)).sort((a, b) => b.pred - a.pred).map(p => ({ slot: 'BN', p }))]);
  const ir = reservePlayers(r);
  if (ir.length) groups.push(['Injured reserve', ir.map(p => ({ slot: 'IR', p }))]);

  const rows = groups.map(([title, items]) => `<tr class="group-row"><td colspan="12">${title}</td></tr>` + items.map(({ slot, p }) => p ? `
    <tr>
      <td>${slotTag(slot)}</td><td>${plCell(p)}</td><td>${oppText(p)}</td><td>${muBadge(p)}</td>
      <td class="num big">${f1(p.pred)}</td><td class="num range">${f1(p.floor)}–${f1(p.ceil)}</td>
      <td class="num">${f1(p.avg)}</td><td class="num">${f1(p.last3)}</td><td class="num">${rankLabel(p)}</td>
      <td class="num">${f1(p.value)}</td><td>${trendCell(p)}</td>
      <td>${!isLeague() ? `<button class="btn sm ghost" data-act="rmRoster" data-id="${p.id}" title="Remove">✕</button>` : ''}</td>
    </tr>` : `<tr><td>${slotTag(slot)}</td><td colspan="11"><span class="bad">Empty slot — fill it!</span></td></tr>`).join('')).join('');

  return `
  <h1 class="section-title">${esc(teamName(myId()))}</h1>
  <p class="section-sub">Your week ${S.model.week} game plan at a glance.</p>
  ${stats}
  <div class="grid g-main mt">
    <div class="card">
      <div class="card-head"><div><h3>Roster</h3><div class="sub">Projections use ${scoringLabel(S.model.scoring, S.model.preset)} scoring. Click any player for details.</div></div>
      ${!isLeague() ? `<div style="width:260px">${searchBox('roster', 'Add a player to your roster…')}</div>` : ''}</div>
      <div class="table-wrap"><table class="t-roster">
        <thead><tr><th>Slot</th><th>Player</th><th>Opp</th><th title="Matchup grade">Mu</th><th class="num">Proj</th><th class="num">Range</th><th class="num">Avg</th><th class="num">L3</th><th class="num">Rank</th><th class="num" title="Rest-of-season trade value (0-100)">Value</th><th>Trend</th><th></th></tr></thead>
        <tbody>${rows}</tbody></table></div>
    </div>
    <div>
      <div class="card"><h3>This week's alerts</h3><div class="sub">What needs your attention before kickoff</div>${alerts(cur, opt, gain)}</div>
      <div class="card mt"><h3>Position strength</h3><div class="sub">${isLeague() ? 'Your starters vs. the rest of the league (rest of season)' : 'Rest-of-season rank of your starters'}</div>${posStrength(strength)}</div>
    </div>
  </div>`;
}

function emptyTeam() {
  return `<div class="center"><div class="card setup" style="padding:28px">
    <h1 style="font-size:24px">Build your roster</h1>
    <p class="lead">Search and add your players. Your roster is saved in this browser.</p>
    ${searchBox('roster', 'Search players — e.g. Bijan, Chase, Lamb…')}
    <p class="muted mt" style="font-size:12px">Tip: add your defense by team name (e.g. "Seahawks").</p>
  </div></div>`;
}

function alerts(cur, opt, gain) {
  const out = [];
  const add = (type, ico, title, text = '') => out.push(`<div class="alert ${type}"><div class="ico">${ico}</div><div><div>${title}</div>${text ? `<div class="t">${text}</div>` : ''}</div></div>`);
  for (const l of cur) {
    const p = l.player;
    if (!p) { add('bad', '!', `<b>${SLOT_LABEL[l.slot] || l.slot}</b> slot is empty`, 'Free points on the table — fill it.'); continue; }
    if (p.bye) add('bad', '!', `<b>${esc(p.name)}</b> is on a BYE`, 'Bench him this week.');
    else if (OUT.includes(p.inj)) add('bad', '!', `<b>${esc(p.name)}</b> is ${esc(p.inj)}`, p.injPart ? esc(p.injPart) : 'Do not start.');
    else if (p.inj === 'Doubtful') add('warn', '?', `<b>${esc(p.name)}</b> is Doubtful`, 'Have a pivot ready.');
    else if (p.inj === 'Questionable') add('warn', '?', `<b>${esc(p.name)}</b> is Questionable`, `${esc(p.injPart || 'Check status before kickoff')}${isLateGame(p) ? '' : ''}`);
  }
  if (gain > 0.05) add('info', '↑', `Lineup can gain <b class="gain">+${f1(gain)} pts</b>`, '<a href="#" data-tab="startsit">Open Start / Sit for the swaps</a>');
  const w = isLeague() && waiverSuggestions().filter(s => s.gain > 0.3)[0];
  if (w) add('good', '+', `Waiver target: <b>${esc(w.p.name)}</b> (${w.p.pos})`, `+${f1(w.gain)} pts/week to your lineup${w.drop ? ` · drop ${esc(w.drop.name)}` : ''}`);
  const hot = activePlayers(myRoster()).filter(p => p.drops > 1000 && p.drops > p.adds).sort((a, b) => b.drops - a.drops)[0];
  if (hot) add('warn', '▼', `<b>${esc(hot.name)}</b> is being dropped widely`, `${fmtK(hot.drops)} drops in 48h — consider moving on.`);
  return out.length ? out.join('') : `<div class="alert good"><div class="ico">✓</div><div><div>You're all set</div><div class="t">No injuries, byes or better options detected.</div></div></div>`;
}
const isLateGame = () => false;

// per-team strength (rest of season) — used for power ranks + position grades
function teamStrength() {
  const rows = allRosters().map(r => {
    const ps = activePlayers(r);
    const opt = optimizeLineup(ps, S.slots, 'ros');
    const pos = { QB: 0, RB: 0, WR: 0, TE: 0 };
    for (const l of opt.lineup) if (l.player && pos[l.player.pos] != null) pos[l.player.pos] += l.player.ros;
    const st = r.settings || {};
    const games = (st.wins || 0) + (st.losses || 0) + (st.ties || 0);
    const pf = (st.fpts || 0) + (st.fpts_decimal || 0) / 100;
    return { rid: r.roster_id, r, ros: opt.total, week: optimizeLineup(ps, S.slots, 'pred').total, pos, pf, ppg: games ? pf / games : opt.total, wins: st.wins || 0, losses: st.losses || 0, ties: st.ties || 0 };
  });
  const n = rows.length;
  for (const k of ['QB', 'RB', 'WR', 'TE']) [...rows].sort((a, b) => b.pos[k] - a.pos[k]).forEach((t, i) => ((t.posRank ||= {})[k] = i + 1));
  rows.forEach(t => (t.score = 0.65 * t.ros + 0.35 * t.ppg + 1.5 * (t.wins - t.losses) / Math.max(1, n / 4)));
  [...rows].sort((a, b) => b.score - a.score).forEach((t, i) => (t.power = i + 1));
  return rows;
}
function posStrength(strength) {
  const me = strength.find(t => t.rid === myId());
  const ps = activePlayers(myRoster());
  const opt = optimizeLineup(ps, S.slots, 'ros');
  return ['QB', 'RB', 'WR', 'TE'].map(pos => {
    const starters = opt.lineup.filter(l => l.player?.pos === pos).map(l => l.player);
    let label, frac;
    if (isLeague() && strength.length > 1) {
      const rk = me.posRank[pos];
      frac = 1 - (rk - 1) / (strength.length - 1);
      label = `${ordinal(rk)} of ${strength.length}`;
    } else {
      const avgRk = mean(starters.map(p => p.rosRank || 99));
      frac = starters.length ? clamp(1 - (avgRk - 1) / 40, 0.05, 1) : 0;
      label = starters.length ? `avg ${pos}${Math.round(avgRk)}` : 'none';
    }
    const color = frac > 0.66 ? 'var(--good)' : frac > 0.33 ? 'var(--warn)' : 'var(--bad)';
    return `<div style="margin-bottom:12px">
      <div style="display:flex;justify-content:space-between;margin-bottom:6px"><span><span class="pos ${pos}">${pos}</span> <span class="muted" style="font-size:12px">${starters.map(p => esc(p.last || p.name)).join(', ') || '—'}</span></span><b style="color:${color};font-size:12px">${label}</b></div>
      <div class="bar"><i style="width:${Math.round(frac * 100)}%;background:${color}"></i></div></div>`;
  }).join('');
}

// =====================================================================
// START / SIT
// =====================================================================
function viewStartSit() {
  const r = myRoster();
  const ps = activePlayers(r);
  const opt = optimizeLineup(ps, S.slots, 'pred');
  const cur = currentLineup(r);
  const curIds = new Set(cur.map(l => l.player?.id).filter(Boolean));
  const optIds = new Set(opt.lineup.map(l => l.player?.id).filter(Boolean));
  const ins = opt.lineup.map(l => l.player).filter(p => p && !curIds.has(p.id)).sort((a, b) => b.pred - a.pred);
  const outs = cur.filter(l => !l.player || !optIds.has(l.player.id)).map(l => l.player).sort((a, b) => (a?.pred || 0) - (b?.pred || 0));
  const gain = opt.total - sum(cur.map(l => l.player?.pred || 0));

  const moves = isLeague() && ins.length ? ins.map((p, i) => {
    const o = outs[i];
    return `<div class="move"><div>${plCell(p, ` · <b class="accent">${f1(p.pred)}</b>`)}</div><div class="arrow">START ⇄ SIT</div><div>${o ? plCell(o, ` · ${f1(o.pred)}`) : '<span class="muted">Empty slot</span>'}</div><div class="gain">+${f1(p.pred - (o?.pred || 0))}</div></div>`;
  }).join('') : `<div class="alert good"><div class="ico">✓</div><div><div>${isLeague() ? 'Your lineup is already optimal' : 'This is your optimal lineup'}</div><div class="t">${isLeague() ? 'No swaps needed this week.' : 'Set these players as starters in your app.'}</div></div></div>`;

  const optRows = opt.lineup.map(l => {
    const p = l.player;
    return `<tr><td>${slotTag(l.slot)}</td><td>${plCell(p, p && isLeague() && !curIds.has(p.id) ? ' · <span class="chip fa">NEW</span>' : '')}</td><td>${p ? oppText(p) : ''}</td><td>${p ? muBadge(p) : ''}</td><td class="num big">${p ? f1(p.pred) : ''}</td><td class="num range">${p ? `${f1(p.floor)}–${f1(p.ceil)}` : ''}</td></tr>`;
  }).join('');

  const bench = opt.bench.filter(p => ['RB', 'WR', 'TE', 'QB'].includes(p.pos)).slice(0, 6);
  return `
  <h1 class="section-title">Start / Sit</h1>
  <p class="section-sub">The optimizer fills your league's exact lineup slots with the highest projected players.</p>
  <div class="grid g2">
    <div class="card">
      <div class="card-head"><div><h3>Recommended moves</h3><div class="sub">${gain > 0.05 ? `Making these swaps adds <b class="gain">+${f1(gain)}</b> projected points` : isLeague() ? `Compared with your current ${platformName()} lineup` : 'Starters vs. bench'}</div></div></div>
      ${moves}
    </div>
    <div class="card">
      <h3>Optimal lineup · ${f1(opt.total)} pts</h3><div class="sub">Week ${S.model.week} projections</div>
      <div class="table-wrap"><table class="t-opt"><thead><tr><th>Slot</th><th>Player</th><th>Opp</th><th>Mu</th><th class="num">Proj</th><th class="num">Range</th></tr></thead><tbody>${optRows}</tbody></table></div>
    </div>
  </div>
  <div class="card mt">
    <div class="card-head"><div><h3>Who should I start?</h3><div class="sub">Compare up to 4 players head-to-head</div></div>
      <div style="width:280px">${searchBox('compare', 'Add a player to compare…')}</div></div>
    ${bench.length ? `<div class="filters"><span class="muted" style="font-size:12px">Quick add:</span>${bench.concat(opt.lineup.filter(l => ['FLEX', 'WRRB_FLEX', 'REC_FLEX', 'SUPER_FLEX'].includes(l.slot)).map(l => l.player).filter(Boolean)).map(p => `<button class="chip" style="cursor:pointer" data-act="cmpAdd" data-id="${p.id}">+ ${esc(p.name)}</button>`).join('')}</div>` : ''}
    ${compareCards()}
  </div>`;
}

function compareCards() {
  const ps = S.compare.map(P).filter(Boolean);
  if (!ps.length) return '<div class="empty">Add two or more players to get a start/sit verdict.</div>';
  const sorted = [...ps].sort((a, b) => b.pred - a.pred);
  const best = sorted[0], second = sorted[1];
  const conf = second ? winProb(best.pred, second.pred, best.psd, second.psd) : null;
  const verdict = second ? `<div class="alert good" style="margin-bottom:14px"><div class="ico">★</div><div><div>Start <b>${esc(best.name)}</b> — ${pct(conf)} chance to outscore ${esc(second.name)}</div><div class="t">${conf < 0.58 ? 'Close call: lean on matchup and ceiling.' : conf < 0.72 ? 'Solid edge.' : 'Easy call.'}</div></div></div>` : '';
  return verdict + `<div class="cmp">${ps.map(p => `
    <div class="cmp-card ${second && p === best ? 'best' : ''}">
      ${second && p === best ? '<div class="crown">START</div>' : ''}
      <button class="btn sm ghost x" data-act="cmpRm" data-id="${p.id}">✕</button>
      ${plCell(p)}
      <div style="font-size:30px;font-weight:800;margin:12px 0 4px">${f1(p.pred)}</div>
      <div class="range" style="margin-bottom:10px">Range ${f1(p.floor)}–${f1(p.ceil)}</div>
      <div class="kv"><span>Matchup</span><b>${oppText(p)} ${muBadge(p)}</b></div>
      <div class="kv"><span>Week rank</span><b>${rankLabel(p)}</b></div>
      <div class="kv"><span>Last 3 avg</span><b>${f1(p.last3)}</b></div>
      <div class="kv"><span>Season avg</span><b>${f1(p.avg)}</b></div>
      <div class="kv"><span>Snap share</span><b>${pct(p.snap)}</b></div>
      <div class="kv"><span>Target share</span><b>${pct(p.tgtShare)}</b></div>
      <div class="kv"><span>Status</span><b>${p.inj ? esc(p.inj) : '<span class="good">Healthy</span>'}</b></div>
    </div>`).join('')}</div>`;
}

// =====================================================================
// MATCHUP
// =====================================================================
function myMatchup() {
  if (!isLeague()) return null;
  const me = S.matchups.find(m => m.roster_id === S.cfg.rosterId);
  if (!me || me.matchup_id == null) return null;
  const opp = S.matchups.find(m => m.matchup_id === me.matchup_id && m.roster_id !== me.roster_id);
  if (!opp) return null;
  const myR = rosterById(me.roster_id), oppR = rosterById(opp.roster_id);
  const myL = currentLineup(myR), oppL = currentLineup(oppR);
  const myProj = sum(myL.map(l => l.player?.pred || 0)), oppProj = sum(oppL.map(l => l.player?.pred || 0));
  const wp = winProb(myProj, oppProj, lineupSd(myL.map(l => l.player)), lineupSd(oppL.map(l => l.player)));
  const optMine = optimizeLineup(activePlayers(myR), S.slots);
  const wpOpt = winProb(optMine.total, oppProj, lineupSd(optMine.lineup.map(l => l.player)), lineupSd(oppL.map(l => l.player)));
  let live = null;
  if (S.live && weekStarted(S.live.clock)) {
    const a = liveSide(myL, me, S.live.clock, S.live.statPts), b = liveSide(oppL, opp, S.live.clock, S.live.statPts);
    live = { me: a, opp: b, wp: liveWinProb(a, b), on: anyGameOn(S.live.clock) };
  }
  return { me, opp, myR, oppR, myL, oppL, myProj, oppProj, wp, wpOpt, optTotal: optMine.total, live };
}

// ---------- live game day ----------
let liveBusy = false, liveTimer = null;
const wpKey = () => `giq_wph_${S.model.season}_${S.model.week}_${S.cfg.leagueId}`;
async function refreshLive() {
  if (!isLeague() || !S.model || liveBusy) return;
  liveBusy = true;
  try {
    const { season, week } = S.model;
    const clock = await fetchGameClock(season, week);
    let statPts = S.live?.statPts || null;
    if (weekStarted(clock)) {
      if (S.cfg.mode === 'espn') {
        const [raw, db] = await Promise.all([fetchEspnLeague({ leagueId: S.cfg.leagueId, season, s2: S.cfg.s2, swid: S.cfg.swid }), sleeper.allPlayers()]);
        const a = adaptEspn(raw, db, S.cfg.swid);
        Object.assign(S, { matchups: a.matchups, rosters: a.rosters });
        buildOwners();
      } else {
        S.matchups = await freshSleeperMatchups(S.cfg.leagueId, week);
      }
      const mine = S.matchups.find(m => m.roster_id === S.cfg.rosterId);
      if (!mine || !Object.keys(mine.players_points || {}).length) statPts = await freshStatPoints(season, week, S.model.score).catch(() => statPts);
    }
    S.live = { clock, statPts, at: new Date() };
    const m = myMatchup();
    if (m?.live) {
      const h = store.get(wpKey(), []);
      if (!h.length || Math.abs(h.at(-1)[1] - m.live.wp) >= 0.005) { h.push([Date.now(), Math.round(m.live.wp * 1000) / 1000]); store.set(wpKey(), h.slice(-300)); }
    }
    paintLive(m);
  } catch (e) {
    console.warn('live update failed', e);
  } finally {
    liveBusy = false;
    scheduleLive();
  }
}
// every minute while games are on; every 10 minutes otherwise so we notice kickoff
function scheduleLive() {
  clearTimeout(liveTimer);
  const c = S.live?.clock;
  if (!c || !isLeague()) return;
  const busy = anyGameOn(c) || kickoffDue(c);
  liveTimer = setTimeout(() => (document.hidden ? scheduleLive() : refreshLive()), busy ? 60_000 : 600_000);
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && S.live && Date.now() - S.live.at > 60_000) refreshLive();
});
function paintLive(m) {
  if ($('#modal') && !$('#modal').hidden) return;
  if (S.tab === 'matchup') return render();
  const el = $('#wpCard');
  if (S.tab === 'team' && el && m) el.outerHTML = wpCard(m);
}
function wpCard(mu) {
  if (!mu) return `<div class="card stat" id="wpCard"><div class="label">Win probability</div><div class="value">—</div><div class="hint">${isLeague() ? 'No matchup this week' : 'Connect your ESPN or Sleeper league for matchups'}</div></div>`;
  const L = mu.live;
  const wp = L ? L.wp : mu.wp;
  return `<div class="card stat" id="wpCard" data-tab="matchup" style="cursor:pointer"><div class="label">${L?.on ? '<span class="live-dot"></span>Live win probability' : L ? 'Win probability · live' : 'Win probability'}</div>
    <div class="value ${wp >= 0.5 ? 'good' : 'bad'}">${pct(wp)}</div>
    <div class="hint">${L ? `<b>${f1(L.me.points)}</b> – ${f1(L.opp.points)} vs ${esc(teamName(mu.oppR.roster_id))}` : `vs ${esc(teamName(mu.oppR.roster_id))} (${f1(mu.oppProj)})`}</div></div>`;
}
const gameTag = g => !g ? '<span class="gtag">BYE</span>'
  : g.state === 'in' ? `<span class="gtag on">${esc(g.detail)}</span>`
  : g.state === 'post' ? '<span class="gtag done">Final</span>'
  : `<span class="gtag">${g.date.toLocaleDateString([], { weekday: 'short' })} ${g.date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>`;
function wpSpark() {
  const h = store.get(wpKey(), []);
  if (h.length < 2) return '';
  const t0 = h[0][0], t1 = h.at(-1)[0] || t0 + 1, W = 300, H = 60;
  const pts = h.map(([t, p]) => `${((t - t0) / (t1 - t0 || 1) * W).toFixed(1)},${((1 - p) * H).toFixed(1)}`).join(' ');
  return `<div class="spark"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-label="Win probability over time"><line x1="0" x2="${W}" y1="${H / 2}" y2="${H / 2}" class="mid"/><polyline points="${pts}"/></svg><div class="muted" style="font-size:11px;display:flex;justify-content:space-between"><span>Win % since kickoff</span><span>50% line</span></div></div>`;
}

function viewMatchup() {
  const m = myMatchup();
  if (!m) return `<div class="card empty">No head-to-head matchup found for week ${S.model.week}.</div>`;
  const L = m.live;
  const wp = L ? L.wp : m.wp;
  const sideRows = (lineup, liveSide) => (liveSide ? liveSide.rows : lineup).map(r => {
    const p = r.player;
    if (!liveSide) return `<tr><td>${slotTag(r.slot)}</td><td>${plCell(p)}</td><td>${p ? muBadge(p) : ''}</td><td class="num big">${p ? f1(p.pred) : '0.0'}</td></tr>`;
    const playing = r.game?.state === 'in';
    return `<tr class="${playing ? 'row-live' : ''}"><td>${slotTag(r.slot)}</td><td>${plCell(p)}</td><td>${p ? gameTag(r.game) : ''}</td>
      <td class="num big ${playing ? 'accent' : ''}">${f1(r.pts)}</td><td class="num muted">${p ? f1(r.pts + r.rem) : '—'}</td></tr>`;
  }).join('');
  const head = L ? '<th></th><th>Player</th><th>Game</th><th class="num">Pts</th><th class="num" title="Points now + what they should still score">Proj</th>' : '<th></th><th>Player</th><th>Mu</th><th class="num">Proj</th>';
  const status = s => `<div class="muted" style="font-size:12px">${s.playing ? `<span class="live-dot"></span>${s.playing} playing · ` : ''}${s.toPlay} yet to play</div>`;
  const team = (rid, proj, s) => `<div class="team"><div class="muted" style="font-weight:600">${esc(teamName(rid))}</div>
      ${s ? `<div class="score">${f1(s.points)}</div><div class="accent" style="font-size:13px">Proj ${f1(s.final)}</div>${status(s)}` : `<div class="score">${f1(proj)}</div><div class="muted" style="font-size:12px">projected</div>`}</div>`;
  const pos = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'].map(k => {
    const a = sum(m.myL.filter(l => l.player?.pos === k).map(l => l.player.pred));
    const b = sum(m.oppL.filter(l => l.player?.pos === k).map(l => l.player.pred));
    return `<tr><td><span class="pos ${k}">${k}</span></td><td class="num ${a > b ? 'good' : ''}">${f1(a)}</td><td class="num ${b > a ? 'bad' : ''}">${f1(b)}</td><td class="num ${a - b >= 0 ? 'good' : 'bad'}">${a - b >= 0 ? '+' : ''}${f1(a - b)}</td></tr>`;
  }).join('');
  const updated = S.live ? `Updated ${S.live.at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}${L?.on ? ' · refreshes every minute' : ''}` : 'Checking live scores…';
  return `
  <div style="display:flex;align-items:flex-end;justify-content:space-between;gap:12px;flex-wrap:wrap">
    <div><h1 class="section-title">Week ${S.model.week} Matchup ${L?.on ? '<span class="live-pill"><span class="live-dot"></span>LIVE</span>' : ''}</h1>
    <p class="section-sub">${L ? 'Live win probability = points already scored + what each starter should still score in the time left.' : "Win probability simulates both lineups' projected scoring ranges."}</p></div>
    <button class="btn sm" data-act="liveNow">↻ ${esc(updated)}</button>
  </div>
  <div class="card">
    <div class="vs ${L ? 'vs-live' : ''}">
      ${team(m.myR.roster_id, m.myProj, L?.me)}
      <div><div class="ring" style="--p:${Math.round(wp * 100)}"><div><div><b>${pct(wp)}</b><span>${L?.on ? 'live to win' : 'to win'}</span></div></div></div>
        ${L ? `<div class="muted" style="font-size:11.5px;text-align:center;margin-top:6px">Before kickoff: ${pct(m.wp)}</div>` : ''}</div>
      ${team(m.oppR.roster_id, m.oppProj, L?.opp)}
    </div>
    ${L ? wpSpark() : ''}
    ${!L && m.optTotal - m.myProj > 0.05 ? `<div class="alert info mt"><div class="ico">↑</div><div><div>Set your optimal lineup to raise your odds to <b class="good">${pct(m.wpOpt)}</b></div><div class="t"><a href="#" data-tab="startsit">See the swaps</a></div></div></div>` : ''}
  </div>
  <div class="grid g-main mt">
    <div class="grid g2" style="gap:16px">
      <div class="card"><h3>You</h3><div class="sub">${L ? 'Live lineup' : 'Current lineup'}</div><div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${sideRows(m.myL, L?.me)}</tbody></table></div></div>
      <div class="card"><h3>Opponent</h3><div class="sub">${L ? 'Live lineup' : 'Current lineup'}</div><div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${sideRows(m.oppL, L?.opp)}</tbody></table></div></div>
    </div>
    <div class="card"><h3>Edge by position</h3><div class="sub">Pre-game projected points</div><table><thead><tr><th>Pos</th><th class="num">You</th><th class="num">Opp</th><th class="num">Edge</th></tr></thead><tbody>${pos}</tbody></table></div>
  </div>`;
}

// =====================================================================
// RANKINGS
// =====================================================================
function viewRankings() {
  const { pos, mode, avail, q } = S.rank;
  return `
  <h1 class="section-title">${mode === 'week' ? `Week ${S.model.week}` : 'Rest-of-Season'} Rankings</h1>
  <p class="section-sub">${mode === 'week' ? 'Projected points for this week with tiers, matchup grades and usage.' : `Average projected points per game over weeks ${S.model.future[0]}–${S.model.future.at(-1)}, plus trade value.`}</p>
  <div class="card">
    <div class="filters">
      ${seg('rankMode', mode, [['week', 'This week'], ['ros', 'Rest of season']])}
      ${seg('rankPos', pos, ['ALL', 'QB', 'RB', 'WR', 'TE', 'FLEX', 'K', 'DEF'].map(x => [x, x]))}
      ${seg('rankAvail', avail, [['all', 'All'], ['fa', isLeague() ? 'Free agents' : 'Not mine'], ['mine', 'My team']])}
      <input class="input" id="rankQ" placeholder="Search player or team…" value="${esc(q)}" autocomplete="off">
    </div>
    <div class="table-wrap" id="rankTable"></div>
  </div>`;
}
function renderRankTable() {
  const el = $('#rankTable');
  if (!el) return;
  const { pos, mode, q, avail } = S.rank;
  const key = mode === 'week' ? 'pred' : 'ros';
  let list = S.model.list.filter(p => p[key] > 0);
  if (pos === 'FLEX') list = list.filter(p => ['RB', 'WR', 'TE'].includes(p.pos));
  else if (pos !== 'ALL') list = list.filter(p => p.pos === pos);
  if (avail === 'fa') list = list.filter(p => !S.owner.has(p.id));
  if (avail === 'mine') list = list.filter(p => S.owner.get(p.id) === myId());
  if (q) { const ql = q.toLowerCase(); list = list.filter(p => p.name.toLowerCase().includes(ql) || (p.team || '').toLowerCase() === ql); }
  list.sort((a, b) => b[key] - a[key]);
  list = list.slice(0, 200);
  const showTiers = !['ALL', 'FLEX'].includes(pos) && !q && avail === 'all';
  const tierKey = mode === 'week' ? 'tier' : 'rosTier';
  const mine = myId();
  let lastTier = null;
  const weeks = S.model.future;
  const head = mode === 'week'
    ? `<tr><th>#</th><th>Player</th><th>Opp</th><th>Mu</th><th class="num">Proj</th><th class="num">Range</th><th class="num">Avg</th><th class="num">L3</th><th class="num">Snap</th><th class="num">Tgt%</th><th>Owner</th><th>Trend</th></tr>`
    : `<tr><th>#</th><th>Player</th><th class="num">ROS/g</th>${weeks.map(w => `<th class="num">W${w}</th>`).join('')}<th class="num">Value</th><th>Owner</th><th>Trend</th></tr>`;
  const body = list.map((p, i) => {
    let tierRow = '';
    if (showTiers && p[tierKey] !== lastTier) { lastTier = p[tierKey]; tierRow = `<tr class="tier-row"><td colspan="${mode === 'week' ? 12 : 6 + weeks.length}">Tier ${lastTier}</td></tr>`; }
    const rk = pos === 'ALL' || pos === 'FLEX' ? `${i + 1}<div class="muted" style="font-size:11px">${rankLabel(p, mode === 'week' ? 'posRank' : 'rosRank')}</div>` : i + 1;
    const cls = S.owner.get(p.id) === mine ? 'mine' : '';
    if (mode === 'week') return tierRow + `<tr class="${cls}"><td class="big">${rk}</td><td>${plCell(p)}</td><td>${oppText(p)}</td><td>${muBadge(p)}</td><td class="num big">${f1(p.pred)}</td><td class="num range">${f1(p.floor)}–${f1(p.ceil)}</td><td class="num">${f1(p.avg)}</td><td class="num">${f1(p.last3)}</td><td class="num">${pct(p.snap)}</td><td class="num">${pct(p.tgtShare)}</td><td>${ownerChip(p)}</td><td>${trendCell(p)}</td></tr>`;
    return tierRow + `<tr class="${cls}"><td class="big">${rk}</td><td>${plCell(p)}</td><td class="num big">${f1(p.ros)}</td>${weeks.map(w => { const wk = p.weeks[w]; return `<td class="num" title="${wk?.opp ? 'vs ' + wk.opp : 'BYE'}">${wk?.bye ? '<span class="muted">BYE</span>' : `<span class="${wk?.mu ? 'g-' + wk.mu.grade : ''}">${f1(wk?.pts)}</span>`}</td>`; }).join('')}<td class="num">${f1(p.value)}</td><td>${ownerChip(p)}</td><td>${trendCell(p)}</td></tr>`;
  }).join('');
  el.innerHTML = list.length ? `<table class="t-rank-${mode}"><thead>${head}</thead><tbody>${body}</tbody></table>` : '<div class="empty">No players match.</div>';
}

// =====================================================================
// WAIVERS
// =====================================================================
let wvCache = null;
function waiverSuggestions() {
  if (wvCache?.model === S.model && wvCache.ownerSize === S.owner.size) return wvCache.list;
  const mine = activePlayers(myRoster());
  const base = optimizeLineup(mine, S.slots, 'ros');
  const benchIds = new Set(base.bench.map(p => p.id));
  const openSpot = mine.length < rosterCap();
  const drops = mine.filter(p => benchIds.has(p.id)).sort((a, b) => a.ros - b.ros).slice(0, 6);
  // without a league we can't see real ownership: assume the top of each position is rostered in a 12-team league
  const ROSTERED = { QB: 16, RB: 40, WR: 50, TE: 14, K: 12, DEF: 14 };
  const likelyFree = p => isLeague() || !p.rosRank || p.rosRank > ROSTERED[p.pos];
  const fas = S.model.list
    .filter(p => !S.owner.has(p.id) && likelyFree(p) && p.ros > 0.5 && !['IR', 'PUP', 'Sus'].includes(p.inj))
    .sort((a, b) => b.ros - a.ros).slice(0, 90);
  const list = fas.map(p => {
    let best = { drop: null, total: -1 };
    const options = openSpot ? [null] : drops.length ? drops : [null];
    for (const d of options) {
      const pool = mine.filter(x => x !== d).concat(p);
      const t = optimizeLineup(pool, S.slots, 'ros').total;
      if (t > best.total + 1e-9) best = { drop: d, total: t };
    }
    return { p, drop: best.drop, gain: best.total - base.total, depth: p.ros - (best.drop?.ros || 0) };
  });
  wvCache = { model: S.model, ownerSize: S.owner.size, list };
  return list;
}
function faabBid(s) {
  if (!isLeague() || S.league.settings?.waiver_type !== 2) return null;
  const budget = S.league.settings.waiver_budget || 100;
  const left = budget - (myRoster().settings?.waiver_budget_used || 0);
  const frac = clamp(s.gain * 0.05 + (s.p.adds > 20000 ? 0.06 : s.p.adds > 5000 ? 0.03 : 0), 0.01, 0.45);
  return Math.max(s.gain > 0 ? 1 : 0, Math.round(left * frac));
}
function viewWaivers() {
  const all = waiverSuggestions();
  const top = [...all].filter(s => s.gain > 0.15).sort((a, b) => b.gain - a.gain).slice(0, 3);
  const pos = S.wvPos;
  const list = all.filter(s => pos === 'ALL' || s.p.pos === pos).slice(0, 60);
  const showFaab = isLeague() && S.league.settings?.waiver_type === 2;
  const topCards = top.length ? top.map((s, i) => `
    <div class="card" style="position:relative">
      <div class="muted" style="font-size:11px;font-weight:800;letter-spacing:.08em">#${i + 1} PRIORITY ADD</div>
      <div class="mt">${plCell(s.p)}</div>
      <div style="display:flex;gap:18px;margin-top:14px">
        <div><div class="muted" style="font-size:11px">LINEUP GAIN</div><div class="gain" style="font-size:22px">+${f1(s.gain)}<span class="muted" style="font-size:12px;font-weight:600">/wk</span></div></div>
        <div><div class="muted" style="font-size:11px">ROS / GAME</div><div style="font-size:22px;font-weight:800">${f1(s.p.ros)}</div></div>
        ${showFaab ? `<div><div class="muted" style="font-size:11px">FAAB BID</div><div style="font-size:22px;font-weight:800" class="accent">$${faabBid(s)}</div></div>` : ''}
      </div>
      <div class="muted mt" style="font-size:12px">${s.drop ? `Drop <b style="color:var(--text)">${esc(s.drop.name)}</b> (${f1(s.drop.ros)} ROS/g)` : 'You have an open roster spot'}</div>
    </div>`).join('') : `<div class="card"><div class="alert good" style="margin:0"><div class="ico">✓</div><div><div>No free agent beats your current lineup</div><div class="t">Look below for depth and stash candidates.</div></div></div></div>`;

  const trendRows = (key) => S.model.list.filter(p => p[key] > 0).sort((a, b) => b[key] - a[key]).slice(0, 10).map(p => `
    <tr><td>${plCell(p)}</td><td class="num"><span class="trend ${key === 'adds' ? 'up' : 'down'}">${key === 'adds' ? '▲' : '▼'} ${fmtK(p[key])}</span></td><td>${ownerChip(p)}</td></tr>`).join('');

  return `
  <h1 class="section-title">Waiver Wire</h1>
  <p class="section-sub">Every ${isLeague() ? 'free agent in your league' : 'player likely available in a 12-team league (connect your league for exact free agents)'}, scored by how much they'd improve your best lineup over the next 5 weeks.</p>
  <div class="grid g3">${topCards}</div>
  <div class="grid g-main mt">
    <div class="card">
      <div class="card-head"><div><h3>Best available</h3><div class="sub">Sorted by rest-of-season points per game</div></div>${seg('wvPos', pos, ['ALL', 'QB', 'RB', 'WR', 'TE', 'K', 'DEF'].map(x => [x, x]))}</div>
      <div class="table-wrap"><table class="t-wv">
        <thead><tr><th>Player</th><th class="num">Wk ${S.model.week}</th><th class="num">ROS/g</th><th class="num">Gain</th><th>Suggested drop</th>${showFaab ? '<th class="num">Bid</th>' : ''}<th>Trend</th></tr></thead>
        <tbody>${list.map(s => `<tr><td>${plCell(s.p)}</td><td class="num">${f1(s.p.pred)}</td><td class="num big">${f1(s.p.ros)}</td>
          <td class="num">${s.gain > 0.05 ? `<span class="gain">+${f1(s.gain)}</span>` : s.depth > 0 ? '<span class="muted">depth</span>' : '<span class="muted">—</span>'}</td>
          <td>${s.gain > 0.05 || s.depth > 0 ? (s.drop ? `<span class="muted">${esc(s.drop.name)}</span>` : '<span class="muted">open spot</span>') : ''}</td>
          ${showFaab ? `<td class="num">${s.gain > 0.05 ? '$' + faabBid(s) : ''}</td>` : ''}<td>${trendCell(s.p)}</td></tr>`).join('')}</tbody>
      </table></div>
    </div>
    <div>
      <div class="card"><h3>🔥 Most added</h3><div class="sub">Across Sleeper, last 48 hours</div><table><tbody>${trendRows('adds')}</tbody></table></div>
      <div class="card mt"><h3>Most dropped</h3><div class="sub">Across Sleeper, last 48 hours</div><table><tbody>${trendRows('drops')}</tbody></table></div>
    </div>
  </div>`;
}

// =====================================================================
// TRADE ANALYZER
// =====================================================================
function viewTrade() {
  const t = S.trade;
  const mine = activePlayers(myRoster()).concat(reservePlayers(myRoster())).sort((a, b) => b.value - a.value);
  const partners = isLeague() ? S.rosters.filter(r => r.roster_id !== myId()) : [];
  if (isLeague() && !t.partner && partners.length) t.partner = partners[0].roster_id;
  const theirs = isLeague() ? activePlayers(rosterById(t.partner)).concat(reservePlayers(rosterById(t.partner))).sort((a, b) => b.value - a.value) : [];
  const pickRow = (p, list, act) => `<label class="pick"><input type="checkbox" data-act="${act}" data-id="${p.id}" ${list.includes(p.id) ? 'checked' : ''}>${avatar(p)}<div><div class="pl-name">${esc(p.name)} ${injTag(p)}</div><div class="pl-meta"><span class="pos ${p.pos}">${p.pos}</span>${esc(p.team || 'FA')} · ${rankLabel(p, 'rosRank')}</div></div><span class="v">${f1(p.value)}</span></label>`;

  const getSide = isLeague()
    ? `<select class="input" id="partner" style="margin-bottom:10px">${partners.map(r => `<option value="${r.roster_id}" ${r.roster_id === t.partner ? 'selected' : ''}>${esc(teamName(r.roster_id))}</option>`).join('')}</select>
       <div class="pick-list">${theirs.map(p => pickRow(p, t.get, 'tget')).join('')}</div>`
    : `${searchBox('get', 'Search players you would receive…')}<div class="pick-list mt">${t.get.map(P).filter(Boolean).map(p => pickRow(p, t.get, 'tget')).join('') || '<div class="empty">Add players you would get.</div>'}</div>`;

  const tvList = S.model.list.filter(p => p.value > 0 && (S.tvPos === 'ALL' || p.pos === S.tvPos)).sort((a, b) => b.value - a.value).slice(0, 100);
  return `
  <h1 class="section-title">Trade Analyzer</h1>
  <p class="section-sub">Grades trades by rest-of-season value over replacement <i>and</i> how they change your best starting lineup.</p>
  <div class="grid g3">
    <div class="card"><h3>You give</h3><div class="sub">${esc(teamName(myId()))}</div><div class="pick-list">${mine.map(p => pickRow(p, t.give, 'tgive')).join('')}</div></div>
    <div class="card"><h3>You get</h3><div class="sub">${isLeague() ? 'Pick a trade partner' : 'Any player'}</div>${getSide}</div>
    <div class="card">${tradeResult()}</div>
  </div>
  ${tradeIdeasCard()}
  <div class="card mt">
    <div class="card-head"><div><h3>Trade value chart</h3><div class="sub">0–100 scale · rest-of-season value over a replacement-level starter in a ${S.league?.total_rosters || 12}-team league</div></div>${seg('tvPos', S.tvPos, ['ALL', 'QB', 'RB', 'WR', 'TE'].map(x => [x, x]))}</div>
    <div class="table-wrap"><table class="t-tv"><thead><tr><th>#</th><th>Player</th><th class="num">Value</th><th style="width:30%"></th><th class="num">ROS/g</th><th class="num">ROS rank</th><th>Owner</th></tr></thead>
    <tbody>${tvList.map((p, i) => `<tr class="${S.owner.get(p.id) === myId() ? 'mine' : ''}"><td class="big">${i + 1}</td><td>${plCell(p)}</td><td class="num big">${f1(p.value)}</td><td><div class="bar"><i style="width:${p.value}%"></i></div></td><td class="num">${f1(p.ros)}</td><td class="num">${rankLabel(p, 'rosRank')}</td><td>${ownerChip(p)}</td></tr>`).join('')}</tbody></table></div>
  </div>`;
}
function tradeResult() {
  const t = S.trade;
  const give = t.give.map(P).filter(Boolean), get = t.get.map(P).filter(Boolean);
  if (!give.length && !get.length) return `<h3>Verdict</h3><div class="sub">Select players on both sides</div><div class="empty">Check the players you'd send and receive.</div>`;
  const mine = activePlayers(myRoster());
  const before = optimizeLineup(mine, S.slots, 'ros').total;
  const after = optimizeLineup(mine.filter(p => !t.give.includes(p.id)).concat(get), S.slots, 'ros').total;
  const lineupGain = after - before;
  const valGive = sum(give.map(p => p.value)), valGet = sum(get.map(p => p.value));
  const valDiff = valGet - valGive;
  let theirGain = null;
  if (isLeague() && t.partner) {
    const th = activePlayers(rosterById(t.partner));
    theirGain = optimizeLineup(th.filter(p => !t.get.includes(p.id)).concat(give), S.slots, 'ros').total - optimizeLineup(th, S.slots, 'ros').total;
  }
  const score = lineupGain + valDiff * 0.06;
  const [cls, title, msg] = score > 1.2 ? ['good', 'Accept ✅', 'This trade makes your team better.']
    : score > -0.4 ? ['warn', 'Fair trade ⚖️', 'Roughly even — decide on need and risk.']
    : ['bad', 'Decline ❌', 'You give up more than you get back.'];
  const rosterNote = get.length > give.length ? `<div class="muted mt" style="font-size:12px">You'd receive ${get.length - give.length} more player(s) than you send — you may need to drop someone.</div>` : '';
  return `<h3>Verdict</h3><div class="sub">Rest-of-season analysis</div>
    <div class="verdict ${cls}"><div class="v-title">${title}</div><div class="muted" style="margin-top:4px">${msg}</div></div>
    <div class="mt">
      <div class="kv"><span>Value you give</span><b>${f1(valGive)}</b></div>
      <div class="kv"><span>Value you get</span><b>${f1(valGet)}</b></div>
      <div class="kv"><span>Value difference</span><b class="${valDiff >= 0 ? 'good' : 'bad'}">${valDiff >= 0 ? '+' : ''}${f1(valDiff)}</b></div>
      <div class="kv"><span>Your lineup, pts/week</span><b class="${lineupGain >= 0 ? 'good' : 'bad'}">${f1(before)} → ${f1(after)} (${lineupGain >= 0 ? '+' : ''}${f1(lineupGain)})</b></div>
      ${theirGain != null ? `<div class="kv"><span>Their lineup change</span><b class="${theirGain >= 0 ? 'good' : 'bad'}">${theirGain >= 0 ? '+' : ''}${f1(theirGain)} pts/wk</b></div>
      <div class="kv"><span>Will they accept?</span><b>${theirGain > 0.3 ? '<span class="good">Likely</span>' : theirGain > -0.5 ? '<span class="warn">Maybe</span>' : '<span class="bad">Unlikely</span>'}</b></div>` : ''}
    </div>${rosterNote}
    <button class="btn sm ghost mt" data-act="tclear">Clear trade</button>`;
}

// =====================================================================
// PHONE APP (home screen install + pairing)
// =====================================================================
function isLocalhost() { return ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname); }
function isStandalone() { return window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true; }
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
let installPrompt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installPrompt = e; });
if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('sw.js').catch(() => {});

function loadQrLib() {
  if (window.QRCode) return Promise.resolve();
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
    s.onload = res; s.onerror = rej;
    document.head.appendChild(s);
  });
}
const installSteps = () => `
  <div class="install-steps">
    <div class="istep"><div class="inum"></div><div><b>iPhone</b> — open the link in <b>Safari</b>, tap <b>Share</b> <span class="kbd">⬆︎</span> then <b>Add to Home Screen</b>.</div></div>
    <div class="istep"><div class="inum"></div><div><b>Android</b> — open it in <b>Chrome</b>, tap <b>⋮</b> then <b>Add to Home screen</b> (or <b>Install app</b>).</div></div>
  </div>`;

let serverInfoP = null;
function serverInfo() {
  serverInfoP ||= fetch('/api/info').then(r => (r.ok ? r.json() : {})).catch(() => ({}));
  return serverInfoP.then(i => (S.server = i));
}
const qrBlock = (url, note) => `
  <div class="phone-grid">
    <div class="qr-box"><div id="qr"></div><div class="muted" style="font-size:12px;margin-top:8px">Scan with your phone camera</div></div>
    <div>
      <div class="muted" style="font-size:11px;font-weight:700;letter-spacing:.08em">OR OPEN THIS LINK ON YOUR PHONE</div>
      <div class="link-box"><code>${esc(url)}</code><button class="btn sm" data-act="copyLink" data-v="${esc(url)}">Copy</button></div>
      ${installSteps()}
      ${note || ''}
    </div>
  </div>`;
const pairCard = where => `
  <div class="card mt" style="padding:14px"><div class="card-head" style="margin:0"><div><h3>Bring your league along</h3><div class="sub">Your phone keeps its own settings. Make a one-time code, then on the phone choose <b>Copy setup from my ${where}</b>.</div></div>
    <button class="btn primary" data-act="makePair">Make pairing code</button></div><div id="pairOut"></div></div>`;
async function drawQr(url) {
  try {
    await loadQrLib();
    new window.QRCode($('#qr'), { text: url, width: 180, height: 180, colorDark: '#0a0f1e', colorLight: '#ffffff', correctLevel: window.QRCode.CorrectLevel.M });
  } catch { $('#qr').innerHTML = '<div class="muted">QR unavailable offline — use the link.</div>'; }
}

async function openPhone() {
  $('#modalCard').innerHTML = `<div class="pm-head"><div class="logo" style="width:52px;height:52px;font-size:20px">IQ</div><div style="flex:1"><h2>Get the phone app</h2><div class="muted">Add Gridiron IQ to your home screen — it opens full-screen like a real app.</div></div><button class="btn sm" data-act="close">✕</button></div><div id="phoneBody"><div class="spinner"></div></div>`;
  $('#modal').hidden = false;
  const body = $('#phoneBody');
  const info = await serverInfo();
  const canPair = S.cfg && (S.cfg.mode !== 'manual' || S.cfg.roster?.length);
  const installHere = `${installPrompt ? '<button class="btn primary block" data-act="installNow">⬇ Install Gridiron IQ</button>' : ''}
    ${isIOS() ? `<div class="alert info"><div class="ico">⬆︎</div><div><div>Tap <b>Share</b> at the bottom of Safari, scroll and choose <b>Add to Home Screen</b>, then <b>Add</b>.</div><div class="t">If you're in another browser, open this page in Safari first.</div></div></div>` : ''}`;
  if (info.cloud) {
    // the online copy: the same link works everywhere, on cellular data too
    const url = info.publicUrl || location.origin;
    body.innerHTML = `${installHere}${qrBlock(url, '<div class="alert info"><div class="ico">✓</div><div><div>Works anywhere — Wi-Fi or cellular data, even with your PC off.</div><div class="t">If nobody used it for a while, the first load can take up to a minute while the server wakes up.</div></div></div>')}
      ${canPair && store.get('giq_device', null) ? pairCard('other device') : ''}`;
    return drawQr(url);
  }
  if (!isLocalhost()) {
    // already on the phone over Wi-Fi: just show how to add it
    body.innerHTML = installHere.trim() || installSteps();
    return;
  }
  let lan = { ips: [], port: location.port || 5190 };
  try { lan = await fetch('/api/lan').then(r => r.json()); } catch { /* old server */ }
  const ip = lan.ips?.[0];
  const lanUrl = ip ? `http://${ip}:${lan.port}` : null;
  const cloudForm = `
    <details class="card mt" style="padding:14px" ${info.cloudUrl ? '' : 'open'}><summary style="cursor:pointer;font-weight:650">${info.cloudUrl ? 'Change your online app' : 'Use it anywhere (cellular data, PC off)'}</summary>
      <p class="muted" style="font-size:12.5px">Once Gridiron IQ is online, paste its address and your owner passcode. Your league setup is sent there and kept up to date.</p>
      <form data-form="cloud">
        <input class="input" name="url" placeholder="https://gridiron-iq.onrender.com" value="${esc(info.cloudUrl || '')}" autocomplete="off">
        <input class="input" style="margin-top:8px" type="password" name="passcode" placeholder="Owner passcode" autocomplete="off">
        <button class="btn primary block mt">Link my online app</button><div id="cloudOut"></div>
      </form></details>`;
  if (info.cloudUrl) {
    body.innerHTML = `${qrBlock(info.cloudUrl, `<div class="alert info"><div class="ico">✓</div><div><div>Works anywhere — Wi-Fi or cellular data, even with this PC off.</div><div class="t">On the phone choose <b>This is my app — unlock</b> and enter your owner passcode.${lanUrl ? ` At home you can also use <code>${esc(lanUrl)}</code>.` : ''}</div></div></div>`)}${cloudForm}`;
    return drawQr(info.cloudUrl);
  }
  if (!lanUrl) {
    body.innerHTML = `<div class="alert warn"><div class="ico">!</div><div><div>Phone access isn't on</div><div class="t">Close this window and start the app with <b>Start Gridiron IQ.bat</b>, then try again.</div></div></div>${cloudForm}`;
    return;
  }
  body.innerHTML = `
    ${qrBlock(lanUrl, lan.ips.length > 1 ? `<div class="muted" style="font-size:12px">Not loading? Try: ${lan.ips.slice(1).map(x => `<code>http://${esc(x)}:${lan.port}</code>`).join(' ')}</div>` : '')}
    ${canPair ? pairCard('computer') : ''}
    <div class="alert warn mt"><div class="ico">!</div><div><div>Your phone and this PC must be on the <b>same Wi-Fi</b>, and the app must be running here.</div><div class="t">The first time, Windows may ask to let Python through the firewall — choose <b>Allow</b> (private networks). School or work Wi-Fi often blocks phone-to-PC connections; home Wi-Fi works best.</div></div></div>
    ${cloudForm}`;
  drawQr(lanUrl);
}
async function makePair() {
  const out = $('#pairOut');
  try {
    const r = await fetch('/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json', ...deviceHeaders() }, body: JSON.stringify(S.cfg) }).then(x => x.json());
    if (!r.code) throw new Error(r.error || 'failed');
    out.innerHTML = `<div class="pair-code">${r.code.slice(0, 3)} ${r.code.slice(3)}</div><div class="muted" style="text-align:center;font-size:12px">Enter this on your phone · works once · expires in 10 minutes</div>`;
  } catch (e) { out.innerHTML = `<div class="err">Couldn't make a code: ${esc(e.message)}</div>`; }
}
async function linkCloud(form) {
  const out = $('#cloudOut');
  const fd = new FormData(form);
  out.innerHTML = '<div class="muted mt">Connecting… (can take a minute if the online app was asleep)</div>';
  try {
    const r = await fetch('/api/cloud', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: fd.get('url'), passcode: fd.get('passcode') }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'failed');
    serverInfoP = null;
    return openPhone();
  } catch (e) { out.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
}
async function loginOwner(form) {
  const st = S.setup;
  const passcode = String(new FormData(form).get('passcode') || '');
  if (!passcode) return;
  st.busy = true; st.error = null; renderSetup();
  try {
    const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passcode }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'That passcode did not work.');
    store.set('giq_device', j.device);
    if (j.cfg) { S.setup = { step: 'start' }; return finishSetup(j.cfg); }
    S.setup = { step: 'start' };
    renderSetup();
    $('#view .lead')?.insertAdjacentHTML('afterend', '<div class="alert info"><div class="ico">✓</div><div><div>Unlocked — no saved league here yet</div><div class="t">Connect your league below, or on your PC open 📱 Phone app → <b>Use it anywhere</b> to send your setup here.</div></div></div>');
    return;
  } catch (e) { st.error = e.message; }
  st.busy = false;
  renderSetup();
}
async function claimPair(form) {
  const st = S.setup;
  const code = String(new FormData(form).get('code') || '').replace(/\D/g, '');
  if (code.length !== 6) { st.error = 'Enter all 6 digits.'; return renderSetup(); }
  st.busy = true; st.error = null; renderSetup();
  try {
    const r = await fetch('/api/claim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
    const j = await r.json();
    if (!r.ok || !j.cfg) throw new Error(j.error || 'That code did not work.');
    if (j.device) store.set('giq_device', j.device);
    S.setup = { step: 'start' };
    return finishSetup(j.cfg);
  } catch (e) { st.error = e.message; }
  st.busy = false;
  renderSetup();
}

// =====================================================================
// GAME BREAKDOWN (tap a game)
// =====================================================================
function tdPick(p) {
  if (!p) return null;
  const lam = 0.82 * (p.weeks[S.model.week]?.td || 0) * (INJ_NOW[p.inj] ?? 1);
  const prob = 1 - Math.exp(-lam);
  return { p, lam, prob, fair: fairAm(prob), key: `td:${p.id}` };
}
function sameGameParlay(gameId) {
  const g = gameById(gameId);
  if (!g) return;
  const legs = [];
  const used = new Set();
  for (const b of [...g.bets].sort((a, b2) => b2.ev - a.ev)) {
    if (legs.length >= 2 || b.ev <= 0 || used.has(b.type)) continue;
    used.add(b.type); legs.push({ key: b.key, label: b.label, odds: b.odds, p: b.p, gameId: b.gameId, game: b.game });
  }
  const prop = (S.props || []).filter(x => x.gameId === gameId && x.ev > 0).sort((a, b) => b.ev - a.ev)[0];
  if (prop) legs.push(propLeg(prop, prop.side));
  for (const l of legs) if (!S.parlay.some(x => x.key === l.key)) S.parlay.push(l);
  saveParlay();
  render();
}
function openGame(id) {
  const g = gameById(id);
  if (!g) return;
  S.sheet = null;
  S.openGameId = id;
  const md = g.model, m = g.mkt;
  const teams = [g.home, g.away];
  const bets = [...g.bets].sort((a, b) => b.ev - a.ev);
  const props = (S.props || []).filter(x => x.gameId === id).sort((a, b) => b.ev - a.ev).slice(0, 8);
  const tds = S.model.list.filter(p => teams.includes(p.team) && ['QB', 'RB', 'WR', 'TE'].includes(p.pos) && !['Out', 'IR', 'PUP', 'Sus', 'Doubtful'].includes(p.inj))
    .map(tdPick).filter(t => t.prob > 0.15).sort((a, b) => b.prob - a.prob).slice(0, 6);
  const stars = S.model.list.filter(p => teams.includes(p.team) && p.pred > 5 && p.pos !== 'K').sort((a, b) => b.pred - a.pred).slice(0, 8);
  const tt = teamTotals();
  const done = g.state !== 'pre';
  const on = key => S.parlay.some(l => l.key === key);
  const sp = v => (v == null ? '—' : v > 0 ? `+${v}` : v === 0 ? 'PK' : `${v}`);
  const best = bets.find(b => b.ev > 0);
  $('#modalCard').innerHTML = `
    <div style="display:flex;justify-content:flex-end"><button class="btn sm" data-act="close">✕</button></div>
    <div class="gm-head">
      <div class="gm-team">${logo(g.awayLogo, g.away, 64)}<b>${esc(g.awayName)}</b><span>${esc(g.awayRec || '')}</span><div class="gm-score">${done ? g.awayScore : md.away.toFixed(1)}</div></div>
      <div class="gm-mid"><div class="eyebrow">${done ? (g.state === 'in' ? 'LIVE · ' + esc(g.detail) : 'FINAL') : kick(g.date)}</div>
        <div class="gm-vs">@</div>
        <div class="wp-bar" style="width:140px;margin:8px auto"><i style="width:${Math.round((1 - md.pHome) * 100)}%"></i></div>
        <div class="muted" style="font-size:12px">${esc(g.away)} ${pct(1 - md.pHome)} · ${esc(g.home)} ${pct(md.pHome)}</div></div>
      <div class="gm-team">${logo(g.homeLogo, g.home, 64)}<b>${esc(g.homeName)}</b><span>${esc(g.homeRec || '')}</span><div class="gm-score">${done ? g.homeScore : md.home.toFixed(1)}</div></div>
    </div>
    <div class="g-lines mt">
      <div><span>Spread (${esc(g.home)})</span><b>${sp(m?.homeSpread)}</b><em>model ${sp(+(-md.margin).toFixed(1))}</em></div>
      <div><span>Total</span><b>${m?.total ?? '—'}</b><em>model ${md.total.toFixed(1)}</em></div>
      <div><span>Implied team pts</span><b>${esc(g.away)} ${tt[g.away]?.toFixed(1) ?? '—'} · ${esc(g.home)} ${tt[g.home]?.toFixed(1) ?? '—'}</b><em>from the betting line</em></div>
    </div>
    ${best && !done ? `<div class="alert good mt"><div class="ico">★</div><div><div>Best bet: <b>${esc(best.label)}</b> ${fmtAm(best.odds)} — ${pct(best.p)} model vs ${pct(best.implied)} book</div><div class="t">${esc(best.note)}</div></div></div>` : ''}
    ${!done ? `<button class="btn primary block" data-act="sgp" data-game="${g.id}">⚡ Add best same-game parlay to my slip</button>` : ''}

    <h3 class="mt">Game bets</h3>
    <div class="table-wrap"><table class="t-gbets"><thead><tr><th>Pick</th><th class="num">Odds</th><th class="num">Model</th><th class="num">Book</th><th class="num">EV</th><th>Grade</th><th></th></tr></thead><tbody>
    ${bets.map(b => { const [tier, cls] = betTier(b); return `<tr><td><b>${esc(b.label)}</b><div class="muted" style="font-size:11px">${esc(b.note)}</div></td><td class="num big">${fmtAm(b.odds)}</td><td class="num">${pct(b.p)}</td><td class="num muted">${pct(b.implied)}</td><td class="num ${b.ev >= 0 ? 'good' : 'muted'}">${signed(b.ev * 100)}%</td><td><span class="tier ${cls}">${tier}</span></td><td>${done ? '' : `<button class="btn sm ${on(b.key) ? 'primary' : ''}" data-act="addLeg" data-key="${b.key}">${on(b.key) ? '✓' : '+'}</button>`}</td></tr>`; }).join('') || '<tr><td colspan="7" class="empty">No lines posted yet.</td></tr>'}
    </tbody></table></div>

    <h3 class="mt">Player props</h3>
    ${!S.props ? '<div class="empty">Props are loading…</div>' : props.length ? `<div class="table-wrap"><table class="t-gprops"><thead><tr><th>Player</th><th>Pick</th><th class="num">Model</th><th class="num">Hit %</th><th class="num">EV</th><th></th></tr></thead><tbody>
    ${props.map(x => `<tr><td>${plCell(x.p)}</td><td><b class="${x.side === 'over' ? 'good' : 'bad'}">${x.side === 'over' ? 'O' : 'U'} ${x.line}</b> <span class="muted">${esc(x.market)}</span></td><td class="num">${x.mu.toFixed(1)}</td><td class="num">${pct(x.prob)}</td><td class="num ${x.ev >= 0 ? 'good' : 'muted'}">${signed(x.ev * 100)}%</td><td>${done ? '' : `<button class="btn sm ${on(`${x.key}:${x.side}`) ? 'primary' : ''}" data-act="addProp" data-key="${x.key}" data-side="${x.side}">${on(`${x.key}:${x.side}`) ? '✓' : '+'}</button>`}</td></tr>`).join('')}
    </tbody></table></div>` : '<div class="empty">No props for this game yet.</div>'}

    <div class="grid g2 mt">
      <div><h3>Anytime TD</h3><table><tbody>${tds.map(t => `<tr><td>${plCell(t.p)}</td><td class="num big">${pct(t.prob)}</td><td class="num muted">${fmtAm(t.fair)}</td><td>${done ? '' : `<button class="btn sm ${on(t.key) ? 'primary' : ''}" data-act="addTd" data-id="${t.p.id}">${on(t.key) ? '✓' : '+'}</button>`}</td></tr>`).join('')}</tbody></table></div>
      <div><h3>Fantasy angle</h3><table><tbody>${stars.map(p => { const c = coachRead(p, tt); return `<tr><td>${plCell(p)}</td><td class="num big">${f1(p.pred)}</td><td>${c.boom >= 0.3 ? '<span class="chip hot">💥 boom</span>' : c.bust >= 0.4 ? '<span class="chip">🧊 risky</span>' : ''}</td></tr>`; }).join('')}</tbody></table></div>
    </div>`;
  $('#modal').hidden = false;
}

// =====================================================================
// COACH
// =====================================================================
const BOOM_AT = { QB: 26, RB: 21, WR: 21, TE: 15, K: 12, DEF: 12 };
const BUST_AT = { QB: 13, RB: 6, WR: 6, TE: 4, K: 5, DEF: 3 };
function teamTotals() {
  const out = {};
  for (const g of S.gm?.games || []) {
    const k = g.mkt;
    const ok = k?.homeSpread != null && k.total;
    out[g.home] = ok ? (k.total - k.homeSpread) / 2 : g.model.home;
    out[g.away] = ok ? (k.total + k.homeSpread) / 2 : g.model.away;
  }
  return out;
}
function coachRead(p, tt) {
  const sd = Math.max(p.psd || 0, 0.3 * p.pred, 2);
  const boom = p.pred > 0 ? 1 - normCdf((BOOM_AT[p.pos] - p.pred) / sd) : 0;
  const bust = p.pred > 0 ? normCdf((BUST_AT[p.pos] - p.pred) / sd) : 1;
  const ups = [], downs = [];
  const mu = p.mu;
  if (mu?.grade === 'A') ups.push(`Smash spot vs ${mu.opp} (${ordinal(mu.rank)} softest vs ${p.pos})`);
  else if (mu?.grade === 'F') downs.push(`Brutal matchup vs ${mu.opp}`);
  else if (mu?.grade === 'D') downs.push(`Tough matchup vs ${mu.opp}`);
  const t = tt[p.team];
  if (t >= 26) ups.push(`${p.team} implied for ${t.toFixed(1)} pts`);
  else if (t && t <= 18.5) downs.push(`${p.team} implied for only ${t.toFixed(1)}`);
  if (p.gp >= 3 && p.avg > 3) {
    const r = p.last3 / p.avg;
    if (r >= 1.2) ups.push(`Heating up: ${f1(p.last3)} last 3 (avg ${f1(p.avg)})`);
    else if (r <= 0.75) downs.push(`Cooling off: ${f1(p.last3)} last 3 (avg ${f1(p.avg)})`);
  }
  const snaps = p.games.map(g => g.snap).filter(x => x != null);
  if (snaps.length >= 4) {
    const early = mean(snaps.slice(0, -2)), late = mean(snaps.slice(-2));
    if (late - early >= 0.1) ups.push(`Role growing: snaps ${pct(early)} → ${pct(late)}`);
    else if (early - late >= 0.12) downs.push(`Role shrinking: snaps ${pct(early)} → ${pct(late)}`);
  }
  if (p.tgtShare >= 0.25) ups.push(`Target hog: ${pct(p.tgtShare)} of team targets`);
  if (p.adds > 5000) ups.push(`🔥 ${fmtK(p.adds)} adds in 48h`);
  if (p.inj === 'Questionable') downs.push('Questionable — check before kickoff');
  if (p.inj === 'Doubtful') downs.push('Doubtful to play');
  if (p.bye) downs.push('On bye');
  return { boom, bust, ups, downs, boomScore: boom * 100 + ups.length * 4 - downs.length * 5, bustScore: bust * 100 + downs.length * 7 - ups.length * 3 };
}
const coachRow = (p, c, mode) => `
  <div class="coach-row">
    <div class="coach-main">${plCell(p)}<div class="coach-proj"><b>${f1(p.pred)}</b><span>${f1(p.floor)}–${f1(p.ceil)}</span></div></div>
    <div class="coach-meter"><span>${mode === 'bust' ? 'Bust risk' : 'Boom chance'}</span><div class="bar"><i style="width:${Math.round((mode === 'bust' ? c.bust : c.boom) * 100)}%;${mode === 'bust' ? 'background:linear-gradient(90deg,#fb923c,#ef4444)' : ''}"></i></div><b>${pct(mode === 'bust' ? c.bust : c.boom)}</b></div>
    <div class="coach-tags">${c.ups.map(x => `<span class="tag up">▲ ${esc(x)}</span>`).join('')}${c.downs.map(x => `<span class="tag down">▼ ${esc(x)}</span>`).join('')}${mode !== 'mine' ? ownerChip(p) : ''}</div>
  </div>`;

function coachVerdict(p, c, isStarter) {
  if (p.bye || OUT.includes(p.inj)) return ['SIT', 'bad', 'Not playing this week.'];
  if (isStarter && c.boom >= 0.3 && c.downs.length === 0) return ['MUST START', 'good', 'Lock it in — top ceiling this week.'];
  if (isStarter && (c.bust >= 0.35 || c.downs.length >= 2)) return ['RISKY START', 'warn', 'Starting, but have a pivot ready.'];
  if (isStarter) return ['START', 'good', 'Solid play.'];
  if (c.boom >= 0.25) return ['UPSIDE BENCH', 'warn', 'High ceiling waiting on the bench.'];
  return ['BENCH', 'muted', 'Depth this week.'];
}

function coachSpeech({ mu, opt, gain, mine, tt }) {
  const lines = [];
  const starters = opt.lineup.map(l => l.player).filter(p => p && !['K', 'DEF'].includes(p.pos));
  const reads = starters.map(p => ({ p, c: coachRead(p, tt) }));
  const engine = [...reads].sort((a, b) => b.c.boomScore - a.c.boomScore)[0];
  const worry = [...reads].sort((a, b) => b.c.bustScore - a.c.bustScore)[0];
  if (mu) lines.push(`We're projected <b>${f1(mu.myProj)}–${f1(mu.oppProj)}</b> against ${esc(teamName(mu.oppR.roster_id))}. That's a <b>${pct(mu.wp)}</b> shot — ${mu.wp >= 0.6 ? "we're the favorite" : mu.wp >= 0.45 ? 'basically a coin flip' : "we're the underdog"}.`);
  else lines.push(`Our best lineup projects for <b>${f1(opt.total)}</b> this week.`);
  if (engine) lines.push(`Our engine is <b>${esc(engine.p.name)}</b>: ${pct(engine.c.boom)} chance to go off${engine.c.ups[0] ? ` — ${esc(engine.c.ups[0].toLowerCase())}` : ''}.`);
  if (worry && worry.c.downs.length) lines.push(`Keep an eye on <b>${esc(worry.p.name)}</b>: ${esc(worry.c.downs[0].toLowerCase())}.`);
  if (gain > 0.05) lines.push(`Lineup isn't set right — fixing it is worth <b>+${f1(gain)}</b>. <a href="#" data-tab="startsit">Make the swaps.</a>`);
  const w = isLeague() ? waiverSuggestions().filter(s => s.gain > 0.3)[0] : null;
  if (w) lines.push(`Go get <b>${esc(w.p.name)}</b> off waivers (+${f1(w.gain)} pts/week).`);
  const wp = mu?.wp;
  lines.push(wp == null ? 'Play the matchups and trust the process.' : wp >= 0.65 ? "Don't overthink it. Play it safe — floors win games we're supposed to win." : wp >= 0.4 ? 'This one is close. Ceiling wins coin flips — lean into our boom plays.' : "We're underdogs. Swing big: start the high-ceiling guys and take shots.");
  return lines;
}

function viewCoach() {
  if (!S.gm && !S.gmError) loadGames();
  const tt = teamTotals();
  const r = myRoster();
  const mine = activePlayers(r);
  const mu = myMatchup();
  const opt = optimizeLineup(mine, S.slots, 'pred');
  const cur = currentLineup(r);
  const gain = opt.total - sum(cur.map(l => l.player?.pred || 0));
  const minPred = { QB: 14, RB: 9, WR: 9, TE: 6 };
  const pool = S.model.list.filter(p => minPred[p.pos] && p.pred >= minPred[p.pos] && !p.bye);
  const reads = new Map(pool.map(p => [p.id, coachRead(p, tt)]));
  const beasts = [...pool].sort((a, b) => reads.get(b.id).boomScore - reads.get(a.id).boomScore).slice(0, 10);
  const topRank = { QB: 12, RB: 24, WR: 30, TE: 12 };
  const fades = pool.filter(p => p.posRank && p.posRank <= topRank[p.pos] && reads.get(p.id).downs.length)
    .sort((a, b) => reads.get(b.id).bustScore - reads.get(a.id).bustScore).slice(0, 8);
  const ROSTERED = { QB: 16, RB: 40, WR: 50, TE: 14 };
  const sleepers = S.model.list.filter(p => minPred[p.pos] && p.pred >= 6 && !S.owner.has(p.id) && (isLeague() || !p.rosRank || p.rosRank > ROSTERED[p.pos]))
    .map(p => [p, coachRead(p, tt)]).sort((a, b) => b[1].boomScore - a[1].boomScore).slice(0, 6);
  const startIds = new Set(opt.lineup.map(l => l.player?.id));
  const myRows = mine.filter(p => p.pos !== 'K' && p.pos !== 'DEF' || startIds.has(p.id))
    .sort((a, b) => (startIds.has(b.id) - startIds.has(a.id)) || b.pred - a.pred)
    .map(p => {
      const c = coachRead(p, tt);
      const [v, cls, why] = coachVerdict(p, c, startIds.has(p.id));
      return `<div class="verdict-row"><span class="vbadge ${cls}">${v}</span>${coachRow(p, c, 'mine')}<div class="muted vwhy">${why}</div></div>`;
    }).join('');
  return `
  <div class="hero coach-hero">
    <div class="eyebrow">Week ${S.model.week} · pre-game talk</div>
    <h1 class="hero-title">Coach's Corner</h1>
    <div class="speech">${coachSpeech({ mu, opt, gain, mine, tt }).map(l => `<p>${l}</p>`).join('')}</div>
    ${!S.gm ? '<div class="muted" style="font-size:12px;margin-top:8px">Loading Vegas lines to sharpen the reads…</div>' : ''}
  </div>
  ${mine.length ? `<div class="card"><h3>Your roster — coach's call</h3><div class="sub">Who to trust, who to worry about, and why</div>${myRows}</div>` : ''}
  <div class="grid g2 mt">
    <div class="card"><h3>💥 Beast mode watch</h3><div class="sub">Players across the NFL most likely to explode this week</div>${beasts.map(p => coachRow(p, reads.get(p.id), 'boom')).join('')}</div>
    <div>
      <div class="card"><h3>🧊 Fade alerts</h3><div class="sub">Big names with red flags — the contrarian read</div>${fades.map(p => coachRow(p, reads.get(p.id), 'bust')).join('') || '<div class="empty">No major red flags this week.</div>'}</div>
      <div class="card mt"><h3>🎯 Sleepers</h3><div class="sub">${isLeague() ? 'Free agents in your league' : 'Likely available'} who could crack your lineup</div>${sleepers.map(([p, c]) => coachRow(p, c, 'boom')).join('') || '<div class="empty">No sleepers worth the add.</div>'}</div>
    </div>
  </div>`;
}

// =====================================================================
// TRADE IDEAS
// =====================================================================
let tiCache = null;
function tradeIdeas() {
  const key = `${S.model.week}|${S.owner.size}|${S.cfg.mode}`;
  if (tiCache?.key === key && tiCache.model === S.model) return tiCache.list;
  const mine = activePlayers(myRoster());
  const base = optimizeLineup(mine, S.slots, 'ros').total;
  const myGive = mine.filter(p => p.value > 0).sort((a, b) => b.value - a.value).slice(0, 14);
  const benchIds = new Set(optimizeLineup(mine, S.slots, 'ros').bench.map(p => p.id));
  const bench = myGive.filter(p => benchIds.has(p.id)).slice(0, 7);
  const out = [];
  const others = isLeague() ? S.rosters.filter(r => r.roster_id !== myId()) : [null];
  for (const r of others) {
    const theirs = r ? activePlayers(r) : [];
    const tBase = r ? optimizeLineup(theirs, S.slots, 'ros').total : 0;
    const targets = (r ? theirs : S.model.list.filter(p => !S.owner.has(p.id) && p.value > 0 && p.rosRank && p.rosRank <= ({ QB: 16, RB: 40, WR: 50, TE: 14 }[p.pos] || 0)))
      .filter(p => p.value > 0).sort((a, b) => b.value - a.value).slice(0, r ? 16 : 60);
    const evalTrade = (give, get) => {
      const giveIds = new Set(give.map(x => x.id)), getIds = new Set(get.map(x => x.id));
      const me = optimizeLineup(mine.filter(p => !giveIds.has(p.id)).concat(get), S.slots, 'ros').total - base;
      const them = r ? optimizeLineup(theirs.filter(p => !getIds.has(p.id)).concat(give), S.slots, 'ros').total - tBase : null;
      const vGive = sum(give.map(x => x.value)), vGet = sum(get.map(x => x.value));
      if (me < 0.4) return;
      if (r && them < -0.3) return;          // they'd get worse — won't accept
      if (vGive < vGet * 0.85) return;      // looks lopsided in our favor — won't accept
      out.push({ partner: r?.roster_id ?? null, give, get, me, them, vGive, vGet, score: me + (them ?? 0) * 0.5 });
    };
    for (const g of myGive) for (const t of targets) evalTrade([g], [t]);
    for (let i = 0; i < bench.length; i++) for (let k = i + 1; k < bench.length; k++) for (const t of targets) evalTrade([bench[i], bench[k]], [t]);
  }
  out.sort((a, b) => b.score - a.score);
  const perTeam = {}, list = [];
  const usedGet = new Set();
  for (const t of out) {
    const pk = t.partner ?? 'any';
    if ((perTeam[pk] || 0) >= 2 || usedGet.has(t.get[0].id)) continue;
    perTeam[pk] = (perTeam[pk] || 0) + 1; usedGet.add(t.get[0].id);
    list.push(t);
    if (list.length >= 8) break;
  }
  tiCache = { key, model: S.model, list };
  return list;
}
function tradeIdeasCard() {
  const ideas = tradeIdeas();
  S.tradeIdeas = ideas;
  const names = xs => xs.map(p => `<span class="ti-pl"><span class="pos ${p.pos}">${p.pos}</span> ${esc(p.name)}</span>`).join('<span class="muted"> + </span>');
  return `<div class="card mt">
    <div class="card-head"><div><h3>💡 Trade ideas</h3><div class="sub">${isLeague() ? 'Win-win offers: they improve your lineup and the other team gains too, so they might actually accept.' : 'Upgrade targets to shop for in your league, paid for with your depth.'}</div></div></div>
    ${ideas.length ? ideas.map((t, i) => `
      <div class="ti">
        <div class="ti-side"><div class="ti-label">You give</div>${names(t.give)}</div>
        <div class="ti-arrow">⇄</div>
        <div class="ti-side"><div class="ti-label">You get${t.partner != null ? ` · ${esc(teamName(t.partner))}` : ''}</div>${names(t.get)}</div>
        <div class="ti-stats"><b class="gain">+${f1(t.me)}</b><span>pts/wk for you</span>${t.them != null ? `<em class="${t.them >= 0 ? 'good' : 'warn'}">${t.them >= 0 ? '+' : ''}${f1(t.them)} for them</em>` : ''}</div>
        <button class="btn sm primary" data-act="loadTrade" data-i="${i}">Load into analyzer</button>
      </div>`).join('') : '<div class="empty">No trades found that help both sides right now — your roster is well balanced.</div>'}
  </div>`;
}

// =====================================================================
// PICKS & PARLAYS
// =====================================================================
let gmPromise = null;
function loadGames() {
  if (gmPromise) return;
  gmPromise = buildGameModel(S.model)
    .then(gm => {
      S.gm = gm;
      buildProps(S.model, gm)
        .then(list => { S.props = list; })
        .catch(e => { S.propsError = e.message || 'Could not load props'; })
        .finally(() => { if (['picks', 'coach'].includes(S.tab)) render(); });
    })
    .catch(e => { S.gmError = e.message || 'Could not load games'; })
    .finally(() => { if (['picks', 'coach'].includes(S.tab)) render(); });
}
const kick = d => d.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
const logo = (src, t, size = 28) => `<img class="tlogo" src="${esc(src || `https://a.espncdn.com/i/teamlogos/nfl/500/${String(t).toLowerCase()}.png`)}" alt="${esc(t)}" width="${size}" height="${size}" onerror="this.style.visibility='hidden'">`;
const gameById = id => S.gm?.games.find(g => g.id === id);
const signed = (x, d = 1) => `${x >= 0 ? '+' : ''}${x.toFixed(d)}`;

function betLogos(b) {
  const g = gameById(b.gameId);
  if (!g) return '';
  if (b.type === 'total') return `<span class="logo-pair">${logo(g.awayLogo, g.away, 30)}${logo(g.homeLogo, g.home, 30)}</span>`;
  return b.side === 'home' ? logo(g.homeLogo, g.home, 36) : logo(g.awayLogo, g.away, 36);
}
function lockCard(b, i) {
  const [tier, cls] = betTier(b);
  const g = gameById(b.gameId);
  const inSlip = S.parlay.some(l => l.key === b.key);
  return `<div class="lock-card ${cls}">
    <div class="lock-rank">${i + 1}</div>
    <div class="lock-top"><span class="tier ${cls}">${tier}</span><span class="muted">${esc(b.game)} · ${g ? kick(g.date) : ''}</span></div>
    <div class="lock-pick">${betLogos(b)}<div><div class="lock-label">${esc(b.label)}</div><div class="muted" style="font-size:12px">${esc(b.note)}</div></div><div class="odds-pill">${fmtAm(b.odds)}</div></div>
    <div class="meter"><i style="width:${Math.round(b.p * 100)}%"></i><b style="left:${Math.round(b.implied * 100)}%" title="Book implied"></b></div>
    <div class="lock-stats">
      <div><span>Model</span><b>${pct(b.p)}</b></div>
      <div><span>Book</span><b>${pct(b.implied)}</b></div>
      <div><span>Edge</span><b class="good">${signed(b.edge * 100)}%</b></div>
      <div><span>EV / $100</span><b class="good">${b.ev >= 0 ? '+' : '-'}$${Math.abs(b.ev * 100).toFixed(0)}</b></div>
    </div>
    <button class="btn ${inSlip ? '' : 'primary'} block" data-act="addLeg" data-key="${b.key}">${inSlip ? '✓ In parlay' : '+ Add to parlay'}</button>
  </div>`;
}

function gameCard(g) {
  const md = g.model, m = g.mkt;
  const live = g.state === 'in', final = g.status === 'STATUS_FINAL';
  const best = type => [...g.bets.filter(b => b.type === type)].sort((a, b) => b.ev - a.ev)[0];
  const chips = ['spread', 'total', 'ml'].map(best).filter(b => b && b.ev > 0).map(b => {
    const [tier, cls] = betTier(b);
    const inSlip = S.parlay.some(l => l.key === b.key);
    return `<button class="pick-chip ${cls} ${inSlip ? 'on' : ''}" data-act="addLeg" data-key="${b.key}" title="${esc(b.note)} · EV ${signed(b.ev * 100)}%"><span>${tier}</span>${esc(b.label)} <em>${fmtAm(b.odds)}</em></button>`;
  }).join('');
  const sp = v => (v == null ? '—' : v > 0 ? `+${v.toFixed(1)}` : v === 0 ? 'PK' : v.toFixed(1));
  const modelHomeSpread = -md.margin;
  const row = (side) => {
    const t = side === 'home' ? g.home : g.away;
    const p = side === 'home' ? md.pHome : 1 - md.pHome;
    const pts = side === 'home' ? md.home : md.away;
    const score = side === 'home' ? g.homeScore : g.awayScore;
    return `<div class="g-row">${logo(side === 'home' ? g.homeLogo : g.awayLogo, t, 34)}
      <div class="g-team"><b>${esc(side === 'home' ? g.homeName : g.awayName)}</b><span>${esc(t)} · ${esc((side === 'home' ? g.homeRec : g.awayRec) || '')}${side === 'home' ? ' · home' : ''}</span></div>
      ${live || final ? `<div class="g-score">${score}</div>` : `<div class="g-proj">${pts.toFixed(1)}</div>`}
      <div class="g-wp ${p >= 0.5 ? 'fav' : ''}">${pct(p)}</div></div>`;
  };
  return `<div class="game tap" data-game="${g.id}" title="Tap for every pick in this game">
    <div class="g-head"><span>${live ? '<span class="live-dot"></span>LIVE · ' + esc(g.detail) : final ? 'FINAL' : kick(g.date)}</span><span class="muted">${m ? esc(m.book) : 'No line yet'}</span></div>
    ${row('away')}${row('home')}
    <div class="wp-bar"><i style="width:${Math.round((1 - md.pHome) * 100)}%"></i></div>
    <div class="g-lines">
      <div><span>Spread (${esc(g.home)})</span><b>${sp(m?.homeSpread)}</b><em class="${m?.homeSpread != null && Math.abs(modelHomeSpread - m.homeSpread) >= 2 ? 'accent' : ''}">model ${sp(modelHomeSpread)}</em></div>
      <div><span>Total</span><b>${m?.total ?? '—'}</b><em class="${m?.total && Math.abs(md.total - m.total) >= 3 ? 'accent' : ''}">model ${md.total.toFixed(1)}</em></div>
      <div><span>Moneyline</span><b>${fmtAm(m?.awayML)} / ${fmtAm(m?.homeML)}</b><em>fair ${fmtAm(Math.round(md.pHome >= 0.5 ? -100 * md.pHome / (1 - md.pHome) : 100 * (1 - md.pHome) / md.pHome))} ${esc(g.home)}</em></div>
    </div>
    ${!live && !final && chips ? `<div class="g-picks">${chips}</div>` : ''}
  </div>`;
}

function parlayPanel() {
  const legs = S.parlay;
  const a = analyzeParlay(legs);
  const legRows = legs.map((l, i) => `<div class="leg">
      <div style="min-width:0"><div class="leg-label">${esc(l.label)}</div><div class="muted" style="font-size:11px">${esc(l.game || '')} · model ${pct(l.p)}</div></div>
      <input class="leg-odds" data-leg="${i}" value="${fmtAm(l.odds)}" title="Edit to match your sportsbook's price">
      <button class="btn sm ghost" data-act="rmLeg" data-i="${i}">✕</button></div>`).join('');
  const gradeCls = a ? (a.grade.startsWith('A') ? 'good' : a.grade === 'B' ? 'good' : a.grade === 'C' ? 'warn' : 'bad') : '';
  return `<div class="card slip">
    <div class="card-head"><div><h3>Parlay analyzer</h3><div class="sub">${legs.length ? `${legs.length}-leg ticket` : 'Add legs from any pick on this page'}</div></div>
      <div class="row"><button class="btn sm" data-act="autoParlay">⚡ Build best</button>${legs.length ? '<button class="btn sm ghost" data-act="clearParlay">Clear</button>' : ''}</div></div>
    ${legs.length ? legRows : '<div class="empty">Tap <b>+ Add to parlay</b> on a lock, a game pick or a TD scorer — or hit <b>Build best</b>.</div>'}
    ${a ? `
      <div class="slip-grade ${gradeCls}"><div class="g-letter">${a.grade}</div><div><b>${a.ev > 0.03 ? 'Positive expected value' : a.ev > -0.03 ? 'Roughly fair price' : 'Book has the edge'}</b><div class="muted" style="font-size:12px">${a.ev > 0 ? 'Model likes this ticket' : `Weakest leg: ${esc(a.weakest.label)}`}</div></div></div>
      <div class="slip-stats">
        <div><span>Payout odds</span><b>${fmtAm(a.am)}</b></div>
        <div><span>$10 pays</span><b>$${(a.dec * 10).toFixed(2)}</b></div>
        <div><span>Model hit %</span><b>${(a.p * 100).toFixed(1)}%</b></div>
        <div><span>Book implied</span><b>${(a.implied * 100).toFixed(1)}%</b></div>
        <div><span>EV per $100</span><b class="${a.ev >= 0 ? 'good' : 'bad'}">${a.ev >= 0 ? '+' : '-'}$${Math.abs(a.ev * 100).toFixed(2)}</b></div>
        <div><span>Suggested stake</span><b>${a.kelly > 0 ? `${(a.kelly * 100).toFixed(1)}% of bankroll` : 'Pass'}</b></div>
      </div>
      ${a.sameGame ? '<div class="alert warn" style="margin-top:12px"><div class="ico">!</div><div><div>Same-game legs</div><div class="t">These outcomes are correlated, so the real hit rate can differ from the product shown.</div></div></div>' : ''}` : ''}
  </div>`;
}

function viewPicks() {
  if (!S.gm) {
    loadGames();
    return S.gmError
      ? `<div class="card empty">Couldn't load this week's games: ${esc(S.gmError)} <button class="btn sm" data-act="reloadGames">Retry</button></div>`
      : `<div class="center"><div style="text-align:center"><div class="spinner"></div><div style="font-weight:700">Simulating week ${S.model.week}…</div><div class="muted" style="margin-top:4px">Pulling lines, scores & injuries for every game</div></div></div>`;
  }
  const gm = S.gm;
  const seen = new Set();
  const locks = [];
  for (const min of [0.56, 0.5]) for (const b of gm.bets) {
    if (locks.length >= 3) break;
    if (b.ev > 0 && b.p >= min && !seen.has(b.gameId)) { seen.add(b.gameId); locks.push(b); }
  }
  const topEdges = gm.bets.filter(b => b.ev > 0).slice(0, 12);
  const games = [...gm.games].sort((a, b) => a.date - b.date);
  const tdRows = gm.tdPicks.slice(0, 15).map(t => {
    const inSlip = S.parlay.some(l => l.key === t.key);
    return `<tr><td>${plCell(t.p)}</td><td>${oppText(t.p)}</td><td class="num">${t.lam.toFixed(2)}</td>
      <td style="min-width:120px"><div class="bar"><i style="width:${Math.round(t.prob * 100)}%"></i></div></td><td class="num big">${pct(t.prob)}</td>
      <td class="num">${fmtAm(t.fair)}</td><td><button class="btn sm ${inSlip ? '' : 'primary'}" data-act="addTd" data-id="${t.p.id}">${inSlip ? '✓' : '+'}</button></td></tr>`;
  }).join('');
  const power = gm.power.slice(0, 32);
  return `
  <div class="hero">
    <div><div class="eyebrow">Week ${gm.week} · ${games.length} games</div><h1 class="hero-title">Locks of the Week</h1>
    <p class="section-sub" style="margin:0">Our model blends team power ratings, injury-adjusted player projections and the market, then hunts for prices the sportsbook got wrong.</p></div>
  </div>
  <div class="grid g3">${locks.length ? locks.map(lockCard).join('') : '<div class="card empty">No positive-value bets left this week — the lines are sharp.</div>'}</div>
  <div class="grid g-main mt">
    <div>
      <div class="card">
        <div class="card-head"><div><h3>Every edge on the board</h3><div class="sub">All spreads, moneylines and totals where the model beats the book · sorted by expected value</div></div></div>
        <div class="table-wrap"><table class="t-edges"><thead><tr><th>Pick</th><th>Game</th><th class="num">Odds</th><th class="num">Model</th><th class="num">Book</th><th class="num">EV</th><th>Grade</th><th></th></tr></thead><tbody>
        ${topEdges.map(b => { const [tier, cls] = betTier(b); const on = S.parlay.some(l => l.key === b.key); return `<tr><td><b>${esc(b.label)}</b><div class="muted" style="font-size:11px">${esc(b.note)}</div></td><td><a href="#" class="game-link" data-game="${b.gameId}">${esc(b.game)}</a></td><td class="num big">${fmtAm(b.odds)}</td><td class="num">${pct(b.p)}</td><td class="num muted">${pct(b.implied)}</td><td class="num good">${signed(b.ev * 100)}%</td><td><span class="tier ${cls}">${tier}</span></td><td><button class="btn sm ${on ? '' : 'primary'}" data-act="addLeg" data-key="${b.key}">${on ? '✓' : '+'}</button></td></tr>`; }).join('') || '<tr><td colspan="8" class="empty">No edges found.</td></tr>'}
        </tbody></table></div>
      </div>
      ${propsCard()}
      <h2 class="h2 mt">Game board</h2>
      <div class="games">${games.map(gameCard).join('')}</div>
    </div>
    <div>
      ${parlayPanel()}
      <div class="card mt"><h3>Anytime TD scorers</h3><div class="sub">Probability from projected touchdowns · fair odds = no-vig price. Bet only if your book pays more.</div>
        <div class="table-wrap"><table class="t-td"><thead><tr><th>Player</th><th>Opp</th><th class="num">xTD</th><th></th><th class="num">Prob</th><th class="num">Fair</th><th></th></tr></thead><tbody>${tdRows}</tbody></table></div></div>
      <div class="card mt"><h3>Power ratings</h3><div class="sub">Points vs. average team on a neutral field, from ${S.model.week - 1} weeks of scores</div>
        <div class="table-wrap"><table><thead><tr><th>#</th><th>Team</th><th class="num">Off</th><th class="num">Def</th><th class="num">Net</th></tr></thead><tbody>
        ${power.map((t, i) => `<tr><td class="big">${i + 1}</td><td><span class="row" style="align-items:center">${logo(null, t.team, 22)}<b>${esc(t.team)}</b></span></td><td class="num ${t.off >= 0 ? 'good' : 'bad'}">${signed(t.off)}</td><td class="num ${t.def >= 0 ? 'good' : 'bad'}">${signed(t.def)}</td><td class="num big">${signed(t.net)}</td></tr>`).join('')}
        </tbody></table></div></div>
    </div>
  </div>
  <p class="foot">Lines via ESPN (DraftKings). Picks are model estimates, not guarantees — even sharp bettors win ~55%. Bet responsibly, 21+.</p>`;
}

// ---------- player props ----------
function propLeg(x, side) {
  const p = side === 'over' ? x.over : x.under;
  return { key: `${x.key}:${side}`, label: propLabel(x, side), odds: x.odds, p, ev: p * (1 + 100 / 110) - 1, gameId: x.gameId, game: x.game };
}
function propsCard() {
  const head = `<div class="card-head"><div><h3>🎯 Player props</h3><div class="sub">DraftKings lines vs. our stat projections · priced at -110 (edit the odds in your slip to match your book)</div></div>`;
  if (S.propsError) return `<div class="card mt">${head}</div><div class="empty">Couldn't load props: ${esc(S.propsError)}</div></div>`;
  if (!S.props) return `<div class="card mt">${head}</div><div class="empty"><div class="spinner" style="width:28px;height:28px;margin-bottom:8px"></div>Loading player props for every game…</div></div>`;
  const markets = [...new Set(S.props.map(x => x.market))].sort();
  const sel = S.propMkt;
  const list = S.props.filter(x => sel === 'ALL' || x.market === sel).slice(0, 40);
  const best = S.props.filter(x => x.ev > 0).slice(0, 3);
  const btn = (x, side) => {
    const on = S.parlay.some(l => l.key === `${x.key}:${side}`);
    const pick = x.side === side;
    return `<button class="btn sm ${on ? 'primary' : pick ? '' : 'ghost'}" data-act="addProp" data-key="${x.key}" data-side="${side}" title="Add ${side} to parlay">${on ? '✓ ' : ''}${side === 'over' ? 'O' : 'U'} ${pct(side === 'over' ? x.over : x.under)}</button>`;
  };
  const move = x => x.open != null && x.open !== x.line ? `<div class="muted" style="font-size:11px">opened ${x.open} ${x.line > x.open ? '▲' : '▼'}</div>` : '';
  return `<div class="card mt">${head}
      <select class="input" id="propMkt" style="width:200px"><option value="ALL">All markets (${S.props.length})</option>${markets.map(m => `<option ${m === sel ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select></div>
    ${best.length ? `<div class="prop-best">${best.map(x => { const [tier, cls] = x.ev >= 0.15 ? ["LOCK", "lock"] : x.ev >= 0.07 ? ["STRONG", "strong"] : ["LEAN", "lean"]; return `<div class="prop-card">
      <div class="lock-top" style="margin-bottom:10px"><span class="tier ${cls}">${tier}</span><span class="muted">${esc(x.game)}</span></div>
      ${plCell(x.p)}
      <div class="prop-line">${x.side === 'over' ? 'OVER' : 'UNDER'} ${x.line} <span>${esc(x.market)}</span></div>
      <div class="muted" style="font-size:12px">Model projects <b style="color:var(--text)">${x.mu.toFixed(1)}</b> · ${pct(x.prob)} to hit · EV ${x.ev >= 0 ? '+' : ''}${(x.ev * 100).toFixed(1)}%</div>
      ${btn(x, x.side).replace('btn sm', 'btn block')}</div>`; }).join('')}</div>` : ''}
    <div class="table-wrap mt"><table class="t-props"><thead><tr><th>Player</th><th>Market</th><th class="num">Line</th><th class="num">Model</th><th class="num">Diff</th><th>Pick</th><th class="num">EV</th><th>Add to parlay</th></tr></thead><tbody>
    ${list.map(x => { const d = x.mu - x.line; return `<tr><td>${plCell(x.p)}</td><td class="muted">${esc(x.market)}</td><td class="num big">${x.line}${move(x)}</td><td class="num">${x.mu.toFixed(1)}</td>
      <td class="num ${d >= 0 ? 'good' : 'bad'}">${d >= 0 ? '+' : ''}${d.toFixed(1)}</td><td><b class="${x.side === 'over' ? 'good' : 'bad'}">${x.side === 'over' ? 'OVER' : 'UNDER'}</b><span class="m-only muted m-sub">${x.line} ${esc(x.market)}</span></td>
      <td class="num ${x.ev >= 0 ? 'good' : 'muted'}">${x.ev >= 0 ? '+' : ''}${(x.ev * 100).toFixed(1)}%</td><td><div class="row">${btn(x, 'over')}${btn(x, 'under')}</div></td></tr>`; }).join('') || '<tr><td colspan="8" class="empty">No props posted yet for this market.</td></tr>'}
    </tbody></table></div></div>`;
}

// =====================================================================
// LEAGUE
// =====================================================================
function viewLeague() {
  const rows = teamStrength().sort((a, b) => a.power - b.power);
  const n = rows.length;
  return `
  <h1 class="section-title">League Power Rankings</h1>
  <p class="section-sub">Blends rest-of-season roster strength, points scored and record.</p>
  <div class="card"><div class="table-wrap"><table class="t-league">
    <thead><tr><th>#</th><th>Team</th><th>Record</th><th class="num">PF</th><th class="num">Proj Wk ${S.model.week}</th><th class="num">ROS/wk</th><th>QB</th><th>RB</th><th>WR</th><th>TE</th></tr></thead>
    <tbody>${rows.map(t => `<tr class="${t.rid === myId() ? 'mine' : ''}"><td class="big">${t.power}</td><td><b>${esc(teamName(t.rid))}</b></td><td>${t.wins}-${t.losses}${t.ties ? '-' + t.ties : ''}</td><td class="num">${f1(t.pf)}</td><td class="num">${f1(t.week)}</td><td class="num big">${f1(t.ros)}</td>${['QB', 'RB', 'WR', 'TE'].map(k => `<td>${heat(t.posRank[k], n)}</td>`).join('')}</tr>`).join('')}</tbody>
  </table></div></div>`;
}

// =====================================================================
// PLAYER MODAL
// =====================================================================
function gameLine(p, l) {
  const v = x => x ?? 0;
  switch (p.pos) {
    case 'QB': return `${v(l.cmp)}/${v(l.att)}, ${v(l.py)} yd, ${v(l.ptd)} TD, ${v(l.int)} INT · ${v(l.ra)}-${v(l.ry)} rush`;
    case 'RB': return `${v(l.ra)}-${v(l.ry)}-${v(l.rtd)} rush · ${v(l.rec)}/${v(l.tg)}, ${v(l.rcy)} yd${l.rctd ? `, ${l.rctd} TD` : ''}`;
    case 'WR': case 'TE': return `${v(l.rec)}/${v(l.tg)}, ${v(l.rcy)} yd, ${v(l.rctd)} TD${l.ra ? ` · ${l.ra}-${l.ry} rush` : ''}`;
    case 'K': return `${v(l.fgm)}/${v(l.fga)} FG · ${v(l.xpm)} XP`;
    case 'DEF': return `${v(l.sack)} sacks · ${v(l.dint)} INT · ${v(l.pa)} pts allowed`;
    default: return '';
  }
}
function chartSvg(p) {
  const m = S.model;
  const weeks = range(1, Math.min(18, m.future.at(-1)));
  const vals = weeks.map(w => (w < m.week ? p.games.find(g => g.w === w)?.pts ?? null : p.weeks[w]?.pts ?? null));
  const max = Math.max(10, ...vals.filter(v => v != null));
  const W = 700, H = 170, pad = 22, bw = (W - pad) / weeks.length;
  const bars = weeks.map((w, i) => {
    const v = vals[i];
    const x = pad + i * bw + bw * 0.18, wdt = bw * 0.64;
    const future = w >= m.week;
    if (v == null) return `<text x="${x + wdt / 2}" y="${H - 22}" text-anchor="middle">${p.weeks[w]?.bye ? 'BYE' : '–'}</text><text x="${x + wdt / 2}" y="${H - 4}" text-anchor="middle">W${w}</text>`;
    const h = (v / max) * (H - 50);
    return `<rect x="${x}" y="${H - 18 - h}" width="${wdt}" height="${Math.max(1, h)}" rx="4" fill="${future ? 'transparent' : 'url(#gr)'}" stroke="${future ? 'var(--accent)' : 'none'}" stroke-dasharray="${future ? '3 3' : ''}"/>
      <text x="${x + wdt / 2}" y="${H - 22 - h}" text-anchor="middle" style="fill:var(--text);font-weight:700">${f1(v)}</text>
      <text x="${x + wdt / 2}" y="${H - 4}" text-anchor="middle">W${w}</text>`;
  }).join('');
  const avgY = H - 18 - (p.avg / max) * (H - 50);
  return `<svg class="chart" viewBox="0 0 ${W} ${H}"><defs><linearGradient id="gr" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#22d3a6"/><stop offset="1" stop-color="#1b8f8a"/></linearGradient></defs>
    ${p.gp ? `<line x1="${pad}" x2="${W}" y1="${avgY}" y2="${avgY}" stroke="#ffffff30" stroke-dasharray="4 4"/><text x="2" y="${avgY + 3}">avg</text>` : ''}${bars}</svg>`;
}
function openPlayer(id) {
  S.openGameId = null; S.sheet = null;
  const p = P(id);
  if (!p) return;
  const m = S.model;
  const owner = S.owner.get(p.id);
  const tiles = [
    ['Proj · Wk ' + m.week, f1(p.pred)], ['Range', `${f1(p.floor)}–${f1(p.ceil)}`], ['Week rank', rankLabel(p)], ['ROS rank', rankLabel(p, 'rosRank')],
    ['Season avg', f1(p.avg)], ['Last 3', f1(p.last3)], [p.pos === 'K' || p.pos === 'DEF' ? 'Games' : 'Snap share', p.pos === 'K' || p.pos === 'DEF' ? p.gp : pct(p.snap)], ['Trade value', f1(p.value)],
  ];
  $('#modalCard').innerHTML = `
    <div class="pm-head">${avatar(p)}<div style="flex:1;min-width:0"><h2>${esc(p.name)} ${injTag(p)}</h2>
      <div class="pl-meta" style="margin-top:4px"><span class="pos ${p.pos}">${p.pos}</span>${esc(p.team || 'Free agent')}${p.yrs != null ? ` · ${p.yrs ? p.yrs + ' yr exp' : 'Rookie'}` : ''} · ${owner != null ? esc(teamName(owner)) : 'Free agent'}</div></div>
      <button class="btn sm" data-act="close">✕</button></div>
    ${!isLeague() && owner === 'me' ? `<button class="btn sm ghost m-only-block" data-act="rmRoster" data-id="${p.id}" style="margin:-8px 0 12px">Remove from my roster</button>` : ''}
    ${p.inj ? `<div class="alert ${OUT.includes(p.inj) ? 'bad' : 'warn'}"><div class="ico">+</div><div><div><b>${esc(p.inj)}</b>${p.injPart ? ` — ${esc(p.injPart)}` : ''}</div>${p.injNotes ? `<div class="t">${esc(p.injNotes)}</div>` : ''}</div></div>` : ''}
    <div class="pm-stats">${tiles.map(([l, v]) => `<div><div class="l">${l}</div><div class="v">${v}</div></div>`).join('')}</div>
    <h3 style="margin:0 0 8px">Fantasy points by week</h3><div class="muted" style="font-size:12px;margin-bottom:6px">Solid = actual · dashed = projected</div>
    ${chartSvg(p)}
    <div class="grid g2 mt">
      <div><h3 style="margin:0 0 8px">Upcoming schedule</h3><table><thead><tr><th>Wk</th><th>Opp</th><th>Mu</th><th class="num">Proj</th></tr></thead><tbody>
        ${m.future.map(w => `<tr><td>${w}</td><td>${oppText(p, w)}</td><td>${muBadge(p, w)}</td><td class="num">${p.weeks[w]?.bye ? '—' : f1(p.weeks[w]?.pts)}</td></tr>`).join('')}</tbody></table></div>
      <div><h3 style="margin:0 0 8px">Game log</h3>${p.games.length ? `<table><thead><tr><th>Wk</th><th>Opp</th><th>Line</th><th class="num">Pts</th></tr></thead><tbody>
        ${[...p.games].reverse().map(g => `<tr><td>${g.w}</td><td>${esc(g.opp || '')}</td><td class="muted" style="font-size:12px;white-space:normal">${gameLine(p, g.line)}</td><td class="num big">${f1(g.pts)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No games played yet.</div>'}</div>
    </div>`;
  $('#modal').hidden = false;
}
const closeModal = () => { $('#modal').hidden = true; S.openGameId = null; S.sheet = null; };

// =====================================================================
// EVENTS
// =====================================================================
function searchResults(q, target) {
  if (!q || q.trim().length < 2) return '';
  const ql = q.trim().toLowerCase();
  const list = S.model.list
    .filter(p => (p.name.toLowerCase().includes(ql) || (p.pos === 'DEF' && p.id.toLowerCase() === ql)) && (p.ros > 0 || p.gp > 0))
    .sort((a, b) => b.ros - a.ros).slice(0, 8);
  return list.map(p => `<button class="res" data-act="pick" data-target="${target}" data-id="${p.id}">${avatar(p)}<div><div class="pl-name">${esc(p.name)} ${injTag(p)}</div><div class="pl-meta"><span class="pos ${p.pos}">${p.pos}</span>${esc(p.team || 'FA')}</div></div><span class="r">${f1(p.pred)} proj</span></button>`).join('')
    || '<div class="res muted">No players found</div>';
}

function onPick(target, id) {
  if (target === 'compare') { if (!S.compare.includes(id)) S.compare = [...S.compare, id].slice(-4); }
  else if (target === 'roster') { if (!S.cfg.roster.includes(id)) { S.cfg.roster.push(id); saveCfg(); buildOwners(); } }
  else if (target === 'get') { if (!S.trade.get.includes(id)) S.trade.get.push(id); }
  render();
}

document.addEventListener('click', e => {
  const t = e.target;
  if (!t.closest('.search')) document.querySelectorAll('.search .results').forEach(r => (r.innerHTML = ''));
  if (t.id === 'modal') return closeModal();
  const tab = t.closest('[data-tab]');
  if (tab) { e.preventDefault(); S.tab = tab.dataset.tab; store.set('giq_tab', S.tab); closeModal(); render(); window.scrollTo(0, 0); return; }
  const a = t.closest('[data-act]');
  if (a) {
    const { act, id, v } = a.dataset;
    switch (act) {
      case 'close': return closeModal();
      case 'refresh': closeModal(); clearCache(); wvCache = null; return loadAll();
      case 'phone': S.sheet = null; return openPhone();
      case 'more': return openMore();
      case 'slip': return openSlip();
      case 'makePair': return makePair();
      case 'liveNow': return refreshLive();
      case 'pairStart': S.setup = { step: 'pair' }; return renderSetup();
      case 'loginStart': S.setup = { step: 'login' }; return renderSetup();
      case 'installNow': installPrompt?.prompt(); installPrompt = null; return closeModal();
      case 'copyLink': navigator.clipboard?.writeText(v).then(() => { a.textContent = 'Copied ✓'; }).catch(() => {}); return;
      case 'retry': return S.cfg ? loadAll() : init();
      case 'switch': closeModal(); S.setup = { step: 'start' }; return serverInfo().then(renderSetup);
      case 'manual': return finishSetup({ mode: 'manual', roster: S.cfg?.mode === 'manual' ? S.cfg.roster : [] });
      case 'browse': S.tab = 'rankings'; return finishSetup({ mode: 'manual', roster: S.cfg?.mode === 'manual' ? S.cfg.roster : [] });
      case 'setupBack': S.setup = { step: 'start', username: S.setup.username }; return renderSetup();
      case 'pickLeague': return pickLeague(id);
      case 'pickRoster': return finishSetup({ ...S.setup.platform, rosterId: Number(id) });
      case 'espnStart': S.setup = { step: 'espn' }; return renderSetup();
      case 'preset': closeModal(); S.cfg.preset = v; saveCfg(); wvCache = null; return loadAll();
      case 'pick': return onPick(a.dataset.target, id);
      case 'rmRoster': S.cfg.roster = S.cfg.roster.filter(x => x !== id); saveCfg(); buildOwners(); closeModal(); return render();
      case 'cmpAdd': return onPick('compare', id);
      case 'cmpRm': S.compare = S.compare.filter(x => x !== id); return render();
      case 'rankMode': S.rank.mode = v; return render();
      case 'rankPos': S.rank.pos = v; return render();
      case 'rankAvail': S.rank.avail = v; return render();
      case 'wvPos': S.wvPos = v; return render();
      case 'tvPos': S.tvPos = v; return render();
      case 'tgive': case 'tget': {
        const key = act === 'tgive' ? 'give' : 'get';
        const list = S.trade[key];
        S.trade[key] = list.includes(id) ? list.filter(x => x !== id) : [...list, id];
        return render();
      }
      case 'tclear': S.trade.give = []; S.trade.get = []; return render();
      case 'addLeg': {
        const key = a.dataset.key;
        if (S.parlay.some(l => l.key === key)) S.parlay = S.parlay.filter(l => l.key !== key);
        else {
          const b = S.gm?.bets.find(x => x.key === key) || S.gm?.games.flatMap(g => g.bets).find(x => x.key === key);
          if (b) S.parlay.push({ key, label: b.label, odds: b.odds, p: b.p, gameId: b.gameId, game: b.game });
        }
        saveParlay(); return render();
      }
      case 'addTd': {
        const t = tdPick(P(id));
        if (!t) return;
        if (S.parlay.some(l => l.key === t.key)) S.parlay = S.parlay.filter(l => l.key !== t.key);
        else {
          const g = S.gm.games.find(x => x.home === t.p.team || x.away === t.p.team);
          S.parlay.push({ key: t.key, label: `${t.p.name} anytime TD`, odds: t.fair, p: t.prob, gameId: g?.id, game: g ? `${g.away} @ ${g.home}` : '' });
        }
        saveParlay(); return render();
      }
      case 'rmLeg': S.parlay.splice(Number(a.dataset.i), 1); saveParlay(); return render();
      case 'clearParlay': S.parlay = []; saveParlay(); return render();
      case 'addProp': {
        const x = S.props?.find(y => y.key === a.dataset.key);
        if (!x) return;
        const side = a.dataset.side, key = `${x.key}:${side}`;
        if (S.parlay.some(l => l.key === key)) S.parlay = S.parlay.filter(l => l.key !== key);
        else S.parlay.push(propLeg(x, side));
        saveParlay(); return render();
      }
      case 'autoParlay': {
        const seen = new Set();
        const picks = [];
        const pool = [...(S.gm?.bets || []), ...(S.props || []).map(x => propLeg(x, x.side))].sort((x, y) => y.ev - x.ev);
        for (const b of pool) {
          if (picks.length >= 3) break;
          if (b.ev > 0 && b.p >= 0.55 && !seen.has(b.gameId)) { seen.add(b.gameId); picks.push(b); }
        }
        S.parlay = picks.map(b => ({ key: b.key, label: b.label, odds: b.odds, p: b.p, gameId: b.gameId, game: b.game }));
        saveParlay(); return render();
      }
      case 'sgp': return sameGameParlay(a.dataset.game);
      case 'loadTrade': {
        const idea = S.tradeIdeas?.[Number(a.dataset.i)];
        if (!idea) return;
        S.trade = { give: idea.give.map(x => x.id), get: idea.get.map(x => x.id), partner: idea.partner ?? S.trade.partner };
        render(); window.scrollTo({ top: 0, behavior: 'smooth' }); return;
      }
      case 'reloadGames': S.gmError = null; gmPromise = null; return render();
    }
  }
  const gameEl = t.closest('[data-game]');
  if (gameEl && !t.closest('[data-player]')) { e.preventDefault(); return openGame(gameEl.dataset.game); }
  const pl = t.closest('[data-player]');
  if (pl) openPlayer(pl.dataset.player);
});

document.addEventListener('input', e => {
  const box = e.target.closest('[data-search]');
  if (box) { $('.results', box).innerHTML = searchResults(e.target.value, box.dataset.search); return; }
  if (e.target.id === 'rankQ') { S.rank.q = e.target.value; renderRankTable(); }
});
document.addEventListener('change', e => {
  if (e.target.id === 'propMkt') { S.propMkt = e.target.value; render(); }
  if (e.target.id === 'partner') { S.trade.partner = Number(e.target.value); S.trade.get = []; render(); }
  if (e.target.dataset.leg != null) {
    const v = e.target.value.trim().toUpperCase() === 'EVEN' ? 100 : parseFloat(e.target.value.replace(/[^\d.+-]/g, ''));
    const leg = S.parlay[Number(e.target.dataset.leg)];
    if (leg && Number.isFinite(v) && Math.abs(v) >= 100) { leg.odds = Math.round(v); saveParlay(); }
    render();
  }
});
document.addEventListener('submit', e => {
  if (e.target.dataset.form === 'pair') { e.preventDefault(); claimPair(e.target); }
  if (e.target.dataset.form === 'login') { e.preventDefault(); loginOwner(e.target); }
  if (e.target.dataset.form === 'cloud') { e.preventDefault(); linkCloud(e.target); }
  if (e.target.dataset.form === 'espn') { e.preventDefault(); connectEspn(e.target); }
  if (e.target.dataset.form === 'user') { e.preventDefault(); connectUser(new FormData(e.target).get('u') || ''); }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeModal(); document.querySelectorAll('.search .results').forEach(r => (r.innerHTML = '')); }
  if (e.key === 'Enter' && e.target.closest('[data-search]')) {
    const first = $('.res[data-act="pick"]', e.target.closest('[data-search]'));
    if (first) first.click();
  }
});

init();
