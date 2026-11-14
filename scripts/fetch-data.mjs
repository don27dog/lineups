// Pulls this week's DraftKings NFL classic and Showdown slates, Sleeper projections and
// Daily Fantasy Fuel projections into OUT_DIR
// (default _site/data), which the workflow deploys straight to GitHub Pages.
// Nothing is committed to the repo, so no old weeks pile up in git history.
// Runs on GitHub's servers. Node 20+, no dependencies.
// DraftKings and Sleeper endpoints are public but unofficial: if one fails,
// the script copies the last good data from the live site (SITE_URL) instead.
import fs from 'node:fs/promises';
import path from 'node:path';

const OUT = path.resolve(process.env.OUT_DIR || '_site/data');
const SITE = (process.env.SITE_URL || '').replace(/\/$/, '');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*', 'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://www.draftkings.com/lobby', 'Origin': 'https://www.draftkings.com' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get(url, as = 'json', tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(url, { headers: as === 'text' ? { ...HEADERS, Accept: 'text/csv, text/plain, */*' } : HEADERS });
      if (!r.ok) { const e = new Error(`HTTP ${r.status}`); e.status = r.status; throw e; }
      return as === 'text' ? await r.text() : await r.json();
    } catch (e) {
      if (e.status === 403 || e.status === 404 || i >= tries) { e.message = `${e.message} for ${url}`; throw e; }
      await sleep(1500 * i);
    }
  }
}
export const getJSON = (url, tries) => get(url, 'json', tries);

// Last good data from the currently deployed site, used only when a source fails
let prevCache;
async function previous() {
  if (prevCache !== undefined) return prevCache;
  prevCache = null;
  if (SITE) { try { prevCache = await getJSON(`${SITE}/data/manifest.json`, 1); } catch { /* first deploy */ } }
  return prevCache;
}
async function copyPrevious(file) {
  const body = await getJSON(`${SITE}/data/${file}`, 2);
  await fs.writeFile(path.join(OUT, file), JSON.stringify(body));
}

// ---------- CSV ----------
export function parseCSV(text) {
  const rows = []; let row = [], f = '', q = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim() !== ''));
}

// "KC@BUF 11/15/2026 01:00PM ET" -> { away, home, startTime }
function gameInfo(s) {
  const m = String(s || '').match(/^([A-Z]{2,4})@([A-Z]{2,4})\s+(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) { const t = String(s || '').match(/^([A-Z]{2,4})@([A-Z]{2,4})/); return t ? { away: t[1], home: t[2], startTime: null } : {}; }
  let [, away, home, mo, d, y, h, mi, ap] = m; h = +h % 12 + (ap.toUpperCase() === 'PM' ? 12 : 0);
  const off = (+mo >= 4 && +mo <= 10) ? '-04:00' : '-05:00';
  const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:${mi}:00${off}`;
  return { away, home, startTime: new Date(iso).toISOString() };
}

// DraftKings salary CSV -> the same shape as the draftables API
export function csvToDraftables(text) {
  const rows = parseCSV(text);
  const hi = rows.findIndex(r => r.map(x => x.trim().toLowerCase()).includes('salary'));
  if (hi < 0) return [];
  const start = rows[hi].findIndex(x => x.trim() !== '');
  const H = rows[hi].slice(start).map(x => x.trim().toLowerCase());
  const col = n => H.indexOf(n);
  const iPos = col('position'), iName = col('name'), iId = col('id'), iRP = col('roster position'),
    iSal = col('salary'), iGame = col('game info'), iTeam = col('teamabbrev');
  const out = [];
  for (const raw of rows.slice(hi + 1)) {
    const r = raw.slice(start);
    const name = (r[iName] || '').trim(), team = (r[iTeam] || '').trim();
    if (!name) continue;
    const g = gameInfo(r[iGame]);
    out.push({
      draftableId: (r[iId] || '').trim(), playerId: name + '|' + team, displayName: name,
      position: (r[iPos] || '').trim(), salary: +String(r[iSal] || '').replace(/[$,]/g, '') || 0,
      teamAbbreviation: team, rosterSlotId: (r[iRP] || '').trim(),
      competition: { name: g.away ? `${g.away} @ ${g.home}` : '', startTime: g.startTime },
    });
  }
  return out;
}

// ---------- DraftKings ----------
export function parseDraftables(list) {
  // Classic: each player has one salary. Showdown: each player also has a CPT copy at 1.5x salary.
  // Tiers and other formats without salaries are skipped.
  const byPlayer = new Map();
  for (const x of list) {
    if (!(x.salary > 0)) continue;
    if (!byPlayer.has(x.playerId)) byPlayer.set(x.playerId, []);
    byPlayer.get(x.playerId).push(x);
  }
  if (!byPlayer.size) return null;
  const showdown = [...byPlayer.values()].some(v => new Set(v.map(x => x.salary)).size > 1);
  const players = [];
  for (const entries of byPlayer.values()) {
    const sorted = [...entries].sort((a, b) => a.salary - b.salary);
    const x = sorted[0], cpt = showdown ? sorted[sorted.length - 1] : null;
    const comp = x.competition || (x.competitions && x.competitions[0]) || {};
    const [away, home] = String(comp.name || '').split(' @ ').map(s => s.trim());
    const team = x.teamAbbreviation || '';
    const opp = team === away ? home : team === home ? away : '';
    const p = {
      id: String(x.draftableId),
      name: (x.displayName || `${x.firstName || ''} ${x.lastName || ''}`).trim(),
      pos: x.position, team, opp: opp || '', sal: x.salary,
      start: comp.startTime || null,
      status: x.status && x.status !== 'None' ? x.status : '',
    };
    if (cpt && cpt.salary > x.salary) { p.cptId = String(cpt.draftableId); p.cptSal = cpt.salary; }
    players.push(p);
  }
  if (!showdown && !players.some(p => p.pos === 'DST')) return null;
  return { type: showdown ? 'sd' : 'classic', players };
}

function slateLabel(g, players, type) {
  const games = new Set(players.map(p => [p.team, p.opp].sort().join('-'))).size;
  const starts = players.map(p => p.start).filter(Boolean).sort();
  const first = starts[0] ? new Date(starts[0]) : null;
  const day = first ? first.toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }) + ' ET' : '';
  if (type === 'sd') {
    const p = players.find(x => x.opp) || {};
    const matchup = [p.team, p.opp].filter(Boolean).join(' vs ');
    return `${matchup || 'Showdown'}${day ? `, ${day}` : ''}`;
  }
  const tag = String(g.ContestStartTimeSuffix || '').replace(/[()]/g, '').trim() || (g.DraftGroupTag === 'Featured' ? 'Main' : '');
  return `${tag || 'Slate'}: ${games} games${day ? `, starts ${day}` : ''}`;
}

// The api.draftkings.com player list blocks GitHub's servers, so after the first 403
// switch to the salary CSV on www.draftkings.com (the "Export to CSV" file).
let apiBlocked = false;
async function draftablesFor(g, id) {
  if (!apiBlocked) {
    try { return (await getJSON(`https://api.draftkings.com/draftgroups/v1/draftgroups/${id}/draftables`)).draftables || []; }
    catch (e) { if (e.status === 403) { apiBlocked = true; console.log('  DraftKings API blocked here, using the salary CSV instead'); } else throw e; }
  }
  const ct = g.ContestTypeId ?? g.contestTypeId;
  const url = `https://www.draftkings.com/lineup/getavailableplayerscsv?draftGroupId=${id}${ct ? `&contestTypeId=${ct}` : ''}`;
  return csvToDraftables(await get(url, 'text'));
}

async function fetchDraftKings() {
  const lobby = await getJSON('https://www.draftkings.com/lobby/getcontests?sport=NFL');
  const groups = lobby.DraftGroups || lobby.draftGroups || [];
  console.log(`DraftKings: ${groups.length} draft groups in lobby`);
  const slates = [], files = {}, seenPools = new Set();
  let failed = 0;
  for (const g of groups) {
    const id = g.DraftGroupId ?? g.draftGroupId;
    if (!id) continue;
    let list;
    try { list = await draftablesFor(g, id); }
    catch (e) { failed++; if (failed <= 3) console.warn(`  skip ${id}: ${e.message}`); continue; }
    const parsed = parseDraftables(list);
    if (!parsed) continue;
    const { type, players } = parsed;
    if (players.length < (type === 'sd' ? 10 : 20)) continue;
    const poolKey = type + ':' + players.map(p => p.name).sort().join('|');
    if (seenPools.has(poolKey)) continue; // same slate listed twice
    seenPools.add(poolKey);
    const file = `dk/${id}.json`;
    files[file] = { site: 'dk', id: String(id), players };
    slates.push({ id: String(id), type, label: slateLabel(g, players, type), start: players.map(p => p.start).filter(Boolean).sort()[0] || null, count: players.length, file, main: type === 'classic' && g.DraftGroupTag === 'Featured' });
    console.log(`  ${id}: ${slates.at(-1).label} (${players.length} players)`);
    await sleep(400);
  }
  if (failed > 3) console.warn(`  ...and ${failed - 3} more skipped`);
  slates.sort((a, b) => a.type.localeCompare(b.type) || (b.main - a.main) || String(a.start).localeCompare(String(b.start)));
  return { slates, files };
}

// ---------- Sleeper ----------
export function parseSleeper(rows, season, week) {
  const players = [];
  for (const r of rows) {
    const pl = r.player || {};
    let pos = pl.position || r.position || '';
    const st = r.stats || {};
    const ppr = st.pts_ppr, half = st.pts_half_ppr ?? st.pts_ppr;
    if (ppr == null || !(ppr > 0)) continue;
    let name = `${pl.first_name || ''} ${pl.last_name || ''}`.trim();
    let team = r.team || pl.team || '';
    if (pos === 'DEF') { pos = 'DST'; team = team || r.player_id; name = name || `${team} Defense`; }
    if (!['QB', 'RB', 'WR', 'TE', 'DST', 'K'].includes(pos) || !name) continue;
    players.push({ name, pos, team, ppr: +(+ppr).toFixed(2), half: +(+half).toFixed(2) });
  }
  return { season, week, players };
}

async function fetchSleeper() {
  const state = await getJSON('https://api.sleeper.app/v1/state/nfl');
  const season = state.season, week = state.display_week || state.week;
  const type = state.season_type === 'post' ? 'post' : 'regular';
  const pos = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'].map(p => `position[]=${p}`).join('&');
  const rows = await getJSON(`https://api.sleeper.app/projections/nfl/${season}/${week}?season_type=${type}&${pos}&order_by=ppr`);
  const out = parseSleeper(Array.isArray(rows) ? rows : [], season, week);
  console.log(`Sleeper: season ${season} week ${week}, ${out.players.length} players`);
  return out;
}

// ---------- Daily Fantasy Fuel ----------
// Their free projections page has a "Download Projections as CSV" link. The job reads the page,
// follows that link, and falls back to the table rows on the page if no link is found.
const DFF_PAGES = { dk: 'https://www.dailyfantasyfuel.com/nfl/projections/draftkings', fd: 'https://www.dailyfantasyfuel.com/nfl/projections/fanduel' };
const decode = s => String(s).replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

export function dffFromCSV(text) {
  const rows = parseCSV(text);
  if (rows.length < 2) return [];
  const H = rows[0].map(x => x.trim().toLowerCase());
  const at = (...n) => { for (const k of n) { const i = H.indexOf(k); if (i >= 0) return i; } return -1; };
  let iName = at('name', 'player', 'player_name', 'full_name');
  const iF = at('first_name', 'first name'), iL = at('last_name', 'last name');
  const iPos = at('position', 'pos'), iTeam = at('team', 'tm');
  let iProj = at('ppg_projection', 'projection', 'proj', 'fpts', 'projected_points');
  if (iProj < 0) iProj = H.findIndex(h => /proj/.test(h));
  if ((iName < 0 && (iF < 0 || iL < 0)) || iProj < 0) return [];
  const out = [];
  for (const r of rows.slice(1)) {
    const name = iName >= 0 ? (r[iName] || '').trim() : `${r[iF] || ''} ${r[iL] || ''}`.trim();
    const proj = parseFloat(r[iProj]);
    if (!name || isNaN(proj)) continue;
    out.push({ name, pos: iPos >= 0 ? (r[iPos] || '').trim() : '', team: iTeam >= 0 ? (r[iTeam] || '').trim() : '', proj: +proj.toFixed(2) });
  }
  return out;
}

export function dffFromHTML(html) {
  const out = [];
  for (const m of html.matchAll(/<tr\b([^>]*\bdata-[^>]*)>/gi)) {
    const attrs = {};
    for (const a of m[1].matchAll(/data-([\w-]+)\s*=\s*"([^"]*)"/g)) attrs[a[1].toLowerCase()] = decode(a[2]);
    const name = attrs.name || attrs.player || attrs['player-name'];
    const pk = Object.keys(attrs).find(k => k === 'ppg_proj') || Object.keys(attrs).find(k => /proj/.test(k) && !/own/.test(k));
    const proj = pk ? parseFloat(attrs[pk]) : NaN;
    if (!name || isNaN(proj)) continue;
    out.push({ name, pos: attrs.pos || attrs.position || '', team: attrs.team || '', proj: +proj.toFixed(2) });
  }
  return out;
}

async function fetchDFF(site) {
  const page = DFF_PAGES[site];
  const html = await get(page, 'text');
  const slate = (html.match(/<title>([^<]*)<\/title>/i) || [])[1] || '';
  const links = [...html.matchAll(/href\s*=\s*"([^"]+)"/gi)].map(m => decode(m[1]))
    .filter(u => /\.csv|csv|download|export/i.test(u));
  for (const l of links) {
    const url = new URL(l, page).toString();
    try {
      const players = dffFromCSV(await get(url, 'text', 2));
      if (players.length >= 20) { console.log(`DFF ${site}: ${players.length} players from CSV ${url}`); return { players, url }; }
    } catch (e) { console.log(`  DFF ${site}: CSV link failed (${e.message})`); }
  }
  const players = dffFromHTML(html);
  if (players.length >= 20) { console.log(`DFF ${site}: ${players.length} players from the page table`); return { players, url: page }; }
  console.log(`DFF ${site}: no projections found. Page ${html.length} chars, ${links.length} CSV-like links: ${links.slice(0, 5).join(' | ') || 'none'}; title: ${slate.trim().slice(0, 80)}`);
  return { players: [], url: page };
}

// ---------- main ----------
async function main() {
  await fs.mkdir(path.join(OUT, 'dk'), { recursive: true });
  const manifest = {};
  let ok = false;

  let dkDone = false;
  try {
    const { slates, files } = await fetchDraftKings();
    if (slates.length) {
      for (const [f, body] of Object.entries(files)) await fs.writeFile(path.join(OUT, f), JSON.stringify(body));
      manifest.dk = { updated: new Date().toISOString(), slates };
      ok = dkDone = true;
    } else console.log('DraftKings: no classic or Showdown slates found');
  } catch (e) { console.error('DraftKings failed:', e.message); }
  if (!dkDone) {
    const prev = await previous();
    if (prev && prev.dk) {
      try {
        for (const s of prev.dk.slates) await copyPrevious(s.file);
        manifest.dk = prev.dk;
        console.log(`DraftKings: kept last good data from ${prev.dk.updated}`);
      } catch (e) { console.error('Could not copy previous DraftKings data:', e.message); }
    }
  }

  let slDone = false;
  try {
    const sl = await fetchSleeper();
    if (sl.players.length) {
      await fs.writeFile(path.join(OUT, 'sleeper.json'), JSON.stringify({ ...sl, updated: new Date().toISOString() }));
      manifest.sleeper = { updated: new Date().toISOString(), week: sl.week, season: sl.season, count: sl.players.length, file: 'sleeper.json' };
      ok = slDone = true;
    } else console.log('Sleeper: no projections yet');
  } catch (e) { console.error('Sleeper failed:', e.message); }
  if (!slDone) {
    const prev = await previous();
    if (prev && prev.sleeper) {
      try { await copyPrevious(prev.sleeper.file); manifest.sleeper = prev.sleeper; console.log(`Sleeper: kept last good data from ${prev.sleeper.updated}`); }
      catch (e) { console.error('Could not copy previous Sleeper data:', e.message); }
    }
  }

  manifest.dff = {};
  for (const site of ['dk', 'fd']) {
    let done = false;
    try {
      const r = await fetchDFF(site);
      if (r.players.length) {
        const file = `dff-${site}.json`;
        await fs.writeFile(path.join(OUT, file), JSON.stringify({ site, updated: new Date().toISOString(), players: r.players }));
        manifest.dff[site] = { updated: new Date().toISOString(), count: r.players.length, file };
        done = true;
      }
    } catch (e) { console.error(`DFF ${site} failed:`, e.message); }
    if (!done) {
      const prev = await previous();
      const p = prev && prev.dff && prev.dff[site];
      if (p) {
        try { await copyPrevious(p.file); manifest.dff[site] = p; console.log(`DFF ${site}: kept last good data from ${p.updated}`); }
        catch (e) { console.error(`Could not copy previous DFF ${site} data:`, e.message); }
      }
    }
  }

  manifest.updated = new Date().toISOString();
  await fs.writeFile(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 1));
  // The site still deploys if both sources fail, so the app itself stays up.
  if (!ok) console.error('Both sources failed this run; deployed with the last good data, if any.');
}

if (import.meta.url === `file://${process.argv[1]}`) main();
