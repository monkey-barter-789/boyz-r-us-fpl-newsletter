"use strict";

/* =========================================================================
   CONFIG - fill this in after deploying cors-proxy-worker.js (see README)
   ========================================================================= */
const PROXY_BASE = "https://fpl-proxy.deepdhandhania99.workers.dev"; // <-- change me
/* =========================================================================
   Low-level fetch helpers
   ========================================================================= */
async function fplGet(path) {
  const res = await fetch(PROXY_BASE + path);
  if (!res.ok) throw new Error(`FPL request failed (${res.status}): ${path}`);
  return res.json();
}
const getBootstrap = () => fplGet("/api/bootstrap-static/");
const getFixtures = (eventId) => fplGet(`/api/fixtures/?event=${eventId}`);
const getPicks = (entryId, eventId) => fplGet(`/api/entry/${entryId}/event/${eventId}/picks/`);
const getLiveEvent = (eventId) => fplGet(`/api/event/${eventId}/live/`);

async function getStandings(leagueId) {
  let page = 1, league = null, results = [];
  while (page <= 6) {
    const data = await fplGet(`/api/leagues-classic/${leagueId}/standings/?page_standings=${page}`);
    if (page === 1) league = data.league;
    results = results.concat(data.standings.results);
    if (!data.standings.has_next) break;
    page++;
  }
  return { league, results };
}

async function getCurrentEvent(bootstrap) {
  // A match that's over long enough ago must be finished, even if FPL's
  // own "finished" flag hasn't caught up yet. 2.5 hours from kickoff
  // comfortably covers 90 minutes, stoppage time, and extra time -
  // while still correctly treating a match in progress right now as
  // NOT over (this is a time check, not just "has it started").
  const MATCH_DURATION_BUFFER_MS = 2.5 * 60 * 60 * 1000;

  const finished = bootstrap.events.filter((e) => e.finished);
  let current;
  if (finished.length === 0) {
    current = bootstrap.events.find((e) => e.is_current) || bootstrap.events[0];
  } else {
    current = finished[finished.length - 1];
  }

  const now = Date.now();
  for (let i = 0; i < 3; i++) {
    const candidate = bootstrap.events.find((e) => e.id === current.id + 1);
    if (!candidate) break;
    const fixtures = await getFixtures(candidate.id);
    if (!fixtures.length) break;
    const surelyOver = (fx) => {
      if (!fx.kickoff_time) return false;
      return now >= new Date(fx.kickoff_time).getTime() + MATCH_DURATION_BUFFER_MS;
    };
    if (fixtures.every(surelyOver)) {
      current = candidate;
      continue;
    }
    break;
  }
  return current;
}

function applyAutosubsAndViceCaptaincy(squad, automaticSubs) {
  const subsOut = new Set((automaticSubs || []).map((s) => s.element_out));
  const subsIn = new Set((automaticSubs || []).map((s) => s.element_in));
  const byId = {};
  squad.forEach((line) => (byId[line.id] = line));

  for (const pid of subsOut) {
    const line = byId[pid];
    if (line) { line.multiplier = 0; line.final_points = 0; }
  }
  for (const pid of subsIn) {
    const line = byId[pid];
    if (line && line.multiplier === 0) { line.multiplier = 1; line.final_points = line.raw_points; }
  }

  const captain = squad.find((l) => l.is_captain);
  const vice = squad.find((l) => l.is_vice_captain);
  if (captain && vice && captain.minutes === 0 && vice.minutes > 0) {
    const armband = captain.multiplier >= 2 ? captain.multiplier : 2;
    captain.multiplier = subsOut.has(captain.id) ? 0 : Math.min(captain.multiplier, 1);
    captain.final_points = captain.raw_points * captain.multiplier;
    captain.is_captain = false;
    vice.multiplier = armband;
    vice.final_points = vice.raw_points * armband;
    vice.is_captain = true;
  }
  return squad;
}

/* =========================================================================
   Snapshot: pull everything needed for one league / one gameweek
   ========================================================================= */
async function buildLeagueSnapshot(leagueId, onProgress) {
  const bootstrap = await getBootstrap();
  const event = await getCurrentEvent(bootstrap);
  const eventId = event.id;

  const { league, results } = await getStandings(leagueId);
  if (!league) throw new Error("Could not find that league. Check the league code and that it's public or you have access.");
  if (results.length < 2) throw new Error("This league doesn't have enough managers to analyse yet.");
  if (results.length > 60) throw new Error(`This league has ${results.length} managers - to keep things fast, this tool supports leagues up to 60 managers.`);

  const playersById = {};
  bootstrap.elements.forEach((p) => (playersById[p.id] = p));
  const teamsById = {};
  bootstrap.teams.forEach((t) => (teamsById[t.id] = t));

  const live = await getLiveEvent(eventId);
  const livePoints = {};
  live.elements.forEach((row) => (livePoints[row.id] = row.stats));

  const managers = [];
  let done = 0;
  for (const row of results) {
    // A single manager's picks can legitimately 404 (e.g. they joined the
    // league after this gameweek) - that shouldn't take down the whole
    // page. Fall back to their official standings row (still correct)
    // with an empty squad, so they show up in the table but just don't
    // contribute to squad-level stats like captain/bench/star players.
    let picksData;
    try {
      picksData = await getPicks(row.entry, eventId);
    } catch (err) {
      console.warn(`Skipping squad detail for entry ${row.entry} (${row.entry_name}): ${err.message}`);
      picksData = { picks: [], automatic_subs: [] };
    }
    const squad = [];
    for (const pick of picksData.picks || []) {
      const p = playersById[pick.element] || {};
      const stats = livePoints[pick.element] || {};
      const pts = stats.total_points || 0;
      const line = {
        id: pick.element,
        name: p.web_name || "Unknown",
        code: p.code,
        initials: playerInitials(p),
        team: (teamsById[p.team] || {}).short_name || "",
        multiplier: pick.multiplier,
        is_captain: pick.is_captain,
        is_vice_captain: pick.is_vice_captain,
        raw_points: pts,
        final_points: pts * pick.multiplier,
        minutes: stats.minutes || 0,
      };
      squad.push(line);
    }

    // Correct for FPL reporting the pre-gameweek selection rather than
    // the final post-autosub XI, and for a blanking captain, before
    // totting anything up.
    applyAutosubsAndViceCaptaincy(squad, picksData.automatic_subs || []);

    let captainPoints = 0;
    let benchPoints = 0;
    for (const line of squad) {
      if (line.is_captain) captainPoints = line.final_points;
      if (line.multiplier === 0) benchPoints += line.raw_points;
    }
    managers.push({
      entry_id: row.entry,
      manager_name: row.player_name,
      team_name: row.entry_name,
      rank: row.rank,
      last_rank: row.last_rank,
      total_points: row.total,
      event_total: row.event_total,
      squad,
      captain_points: captainPoints,
      bench_points: benchPoints,
    });
    done++;
    if (onProgress) onProgress(done, results.length);
  }

  return {
    league_id: leagueId,
    league_name: league.name,
    event_id: eventId,
    average_score: event.average_entry_score,
    managers,
    bootstrap,
    teamsById,
    playersById,
    livePoints,
    photo_folder: photoFolderFromBootstrap(bootstrap),
  };
}

/* =========================================================================
   Awards: the stats every story/title is built from
   ========================================================================= */
function computeOwnership(managers) {
  const counts = {};
  for (const m of managers) {
    const seen = new Set();
    for (const line of m.squad) {
      if (seen.has(line.id)) continue;
      seen.add(line.id);
      counts[line.id] = (counts[line.id] || 0) + 1;
    }
  }
  return counts;
}

function sheepRating(manager, ownership, leagueSize) {
  const starters = manager.squad.filter((l) => l.multiplier > 0);
  if (starters.length === 0) return 0;
  const threshold = leagueSize / 2;
  const templatey = starters.filter((l) => (ownership[l.id] || 0) >= threshold).length;
  return Math.round((100 * templatey) / starters.length);
}

function rankMove(m) {
  return m.last_rank ? m.last_rank - m.rank : 0;
}

function buildAwards(snapshot) {
  const managers = snapshot.managers;
  const leagueSize = managers.length;
  const ownership = computeOwnership(managers);

  const byGwPoints = [...managers].sort((a, b) => b.event_total - a.event_total);
  const byCaptain = [...managers].sort((a, b) => b.captain_points - a.captain_points);
  const byBench = [...managers].sort((a, b) => b.bench_points - a.bench_points);
  const byClimb = [...managers].sort((a, b) => rankMove(b) - rankMove(a));
  const byFall = [...managers].sort((a, b) => rankMove(a) - rankMove(b));

  const sheepScores = managers.map((m) => [m, sheepRating(m, ownership, leagueSize)]);
  const bySheep = [...sheepScores].sort((a, b) => b[1] - a[1]);

  const diffs = [];
  for (const m of managers) {
    const starters = m.squad.filter((l) => l.multiplier > 0);
    if (starters.length === 0) continue;
    const best = starters.reduce((a, b) => (a.final_points >= b.final_points ? a : b));
    const ownedBy = ownership[best.id] || 1;
    diffs.push([m, best, ownedBy]);
  }
  diffs.sort((a, b) => a[2] - b[2] || b[1].final_points - a[1].final_points);

  return {
    motm: byGwPoints[0] || null,
    flop: byGwPoints[byGwPoints.length - 1] || null,
    best_captain: byCaptain[0] || null,
    worst_captain: byCaptain[byCaptain.length - 1] || null,
    biggest_riser: byClimb[0] || null,
    biggest_faller: byFall[0] || null,
    biggest_sheep: bySheep.length ? bySheep[0][0] : null,
    biggest_maverick: bySheep.length ? bySheep[bySheep.length - 1][0] : null,
    bench_flop: byBench[0] || null,
    differential_hero: diffs[0] || null,
    league_average: snapshot.average_score,
    ownership,
    sheep_scores: Object.fromEntries(sheepScores.map(([m, s]) => [m.entry_id, s])),
  };
}

/* =========================================================================
   Stories: tabloid headlines written from the awards, template + randomness
   ========================================================================= */
function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}
function ordinalSuffix(n) {
  if (n % 100 >= 10 && n % 100 <= 20) return "th";
  return { 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th";
}

function motmStory(a) {
  const m = a.motm;
  if (!m) return null;
  const lead = pick([
    `${m.team_name} put on a clinic this gameweek, and ${m.manager_name} is this week's Manager of the Match after a monster ${m.event_total} points.`,
    `Take a bow, ${m.manager_name}. ${m.team_name} smashed the gameweek with ${m.event_total} points - top score in the entire league.`,
    `${m.manager_name} turned ${m.team_name} into a scoring machine this week, racking up ${m.event_total} points to top the gameweek charts.`,
  ]);
  const cap = m.squad.find((l) => l.is_captain);
  const capLine = cap ? ` The armband went to ${cap.name}, who paid it back with ${cap.final_points} points.` : "";
  return { headline: `${m.manager_name.toUpperCase()} TOPS THE GAMEWEEK`, kicker: "MANAGER OF THE MATCH", body: lead + capLine, manager: m };
}

function flopStory(a) {
  const m = a.flop;
  if (!m) return null;
  let avgLine = "";
  if (a.league_average) {
    const gap = a.league_average - m.event_total;
    if (gap > 0) avgLine = ` That's ${gap} points shy of the league average.`;
  }
  const lead = pick([
    `It was a week to forget for ${m.manager_name}. ${m.team_name} limped to just ${m.event_total} points, bottom of the gameweek pile.`,
    `${m.team_name} had a nightmare gameweek - ${m.manager_name} could only muster ${m.event_total} points, the lowest score in the league.`,
  ]);
  return { headline: `${m.team_name.toUpperCase()} HIT ROCK BOTTOM`, kicker: "STINKER OF THE WEEK", body: lead + avgLine, manager: m };
}

function captainStory(a) {
  const best = a.best_captain, worst = a.worst_captain;
  if (!best || !worst) return null;
  const bestCap = best.squad.find((l) => l.is_captain);
  const worstCap = worst.squad.find((l) => l.is_captain);
  if (!bestCap || !worstCap) return null;
  const body = `${best.manager_name}'s armband landed perfectly on ${bestCap.name}, banking ${bestCap.final_points} points from the captaincy alone. Spare a thought for ${worst.manager_name}, whose faith in ${worstCap.name} returned only ${worstCap.final_points}.`;
  return { headline: `${best.manager_name.toUpperCase()} NAILS THE ARMBAND`, kicker: "CAPTAINCY WATCH", body, manager: best };
}

function rankMovementStory(a) {
  const riser = a.biggest_riser, faller = a.biggest_faller;
  if (!riser || !faller) return null;
  const move = riser.last_rank ? riser.last_rank - riser.rank : 0;
  const fall = faller.last_rank ? faller.rank - faller.last_rank : 0;
  if (move <= 0 && fall <= 0) return null;
  const lines = [];
  if (move > 0) lines.push(`${riser.manager_name} climbed ${move} place${move !== 1 ? "s" : ""} up the table, now sitting ${riser.rank}${ordinalSuffix(riser.rank)}.`);
  if (fall > 0) lines.push(`${faller.manager_name} wasn't so lucky, sliding ${fall} place${fall !== 1 ? "s" : ""} down to ${faller.rank}${ordinalSuffix(faller.rank)}.`);
  return { headline: `${riser.manager_name.toUpperCase()} ON THE RISE`, kicker: "TABLE TALK", body: lines.join(" "), manager: riser };
}

function sheepStory(a) {
  const sheep = a.biggest_sheep, maverick = a.biggest_maverick;
  if (!sheep || !maverick) return null;
  const sScore = a.sheep_scores[sheep.entry_id] || 0;
  const mScore = a.sheep_scores[maverick.entry_id] || 0;
  const body = `${sScore}% of ${sheep.manager_name}'s starting XI is straight off the template - the most copy-paste line-up in the league this week. On the other end of the spectrum, ${maverick.manager_name} went it alone with a lineup only ${mScore}% template. Braver, or just wrong?`;
  return { headline: `${sheep.manager_name.toUpperCase()} BAA-RELY ORIGINAL`, kicker: "TEMPLATE WATCH", body, manager: sheep };
}

function benchStory(a) {
  const m = a.bench_flop;
  if (!m || m.bench_points < 8) return null;
  const body = `${m.manager_name} left a painful ${m.bench_points} points warming the bench this week. Selection is a skill, and this week it went missing at ${m.team_name}.`;
  return { headline: `${m.bench_points} POINTS LEFT ON THE BENCH`, kicker: "SELECTION BLUNDER", body, manager: m };
}

function differentialStory(a) {
  const trio = a.differential_hero;
  if (!trio) return null;
  const [m, player, ownedBy] = trio;
  if (ownedBy > 1) return null;
  const body = `While the rest of the league followed the crowd, ${m.manager_name} stood alone on ${player.name}, who returned ${player.final_points} points as the league's loneliest - and smartest - pick this week.`;
  return { headline: `${m.manager_name.toUpperCase()}'S LONE WOLF PICK PAYS OFF`, kicker: "DIFFERENTIAL OF THE WEEK", body, manager: m };
}

function buildAllStories(awards, maxStories = 8) {
  const builders = [motmStory, captainStory, rankMovementStory, sheepStory, differentialStory, benchStory, flopStory];
  const stories = [];
  for (const b of builders) {
    try {
      const s = b(awards);
      if (s) stories.push(s);
    } catch (e) {
      /* skip a story that couldn't be built rather than break the page */
    }
  }
  return stories.slice(0, maxStories);
}

/* =========================================================================
   Weekly team titles
   ========================================================================= */
const TITLE_BANKS = {
  top_scorer: { titles: ["The Untouchables", "Gameweek Royalty", "Boss Mode: Activated", "Nailed It"], blurb: "Top score in the league this week. Nothing more to say." },
  bottom_scorer: { titles: ["Comic Relief", "Wooden Spoon Watch", "Rebuild Starts Now", "Bring Back VAR"], blurb: "Bottom of the gameweek pile. Every league needs one." },
  best_captain: { titles: ["Armband Assassin", "The Puppet Master", "Captain Fantastic"], blurb: "Got the armband call spot on." },
  worst_captain: { titles: ["Captain Regret", "Armband Amnesia", "The Ex-Captain (Effective Immediately)"], blurb: "The captaincy call that will haunt the group chat." },
  bench_flop: { titles: ["Bench Warmers Local 401", "Parking Points", "The Substitutes' Union"], blurb: "Left a small fortune of points warming the bench." },
  big_riser: { titles: ["Fast & Furious", "Rocket Ship", "The Comeback Kid"], blurb: "Climbing the table at pace." },
  big_faller: { titles: ["Free Falling", "Elevator Going Down", "The Great Collapse"], blurb: "A rough week for the league table." },
  biggest_sheep: { titles: ["Chief Copycat", "Captain Template", "One Of The Flock"], blurb: "Playing it extremely safe with the template XI." },
  biggest_maverick: { titles: ["Lone Wolf", "The Rebel", "Differential Energy"], blurb: "Doing their own thing, for better or worse." },
  top_third: { titles: ["The Contenders", "Form Team", "Cruising"], blurb: "Sitting pretty near the top of the table." },
  mid_table: { titles: ["Steady Eddie", "Comfortably Mid", "The Quiet Achiever"], blurb: "Not making headlines, not making disasters either." },
  bottom_third: { titles: ["Project Next Season", "The Rebuild", "Character Building"], blurb: "Games in hand. Plenty of them." },
};

function assignTitles(managers, awards) {
  const n = managers.length;
  const topThirdCutoff = Math.max(1, Math.round(n / 3));
  const bottomThirdCutoff = n - topThirdCutoff;

  const motmId = awards.motm ? awards.motm.entry_id : null;
  const flopId = awards.flop ? awards.flop.entry_id : null;
  const bestCapId = awards.best_captain ? awards.best_captain.entry_id : null;
  const worstCapId = awards.worst_captain ? awards.worst_captain.entry_id : null;
  const benchId = awards.bench_flop && awards.bench_flop.bench_points >= 8 ? awards.bench_flop.entry_id : null;
  const sheepId = awards.biggest_sheep ? awards.biggest_sheep.entry_id : null;
  const maverickId = awards.biggest_maverick ? awards.biggest_maverick.entry_id : null;

  const titles = {};
  for (const m of managers) {
    const eid = m.entry_id;
    const move = m.last_rank ? m.last_rank - m.rank : 0;
    let category;
    if (eid === motmId) category = "top_scorer";
    else if (eid === flopId) category = "bottom_scorer";
    else if (eid === bestCapId && bestCapId !== motmId) category = "best_captain";
    else if (eid === worstCapId && worstCapId !== flopId) category = "worst_captain";
    else if (eid === benchId) category = "bench_flop";
    else if (move >= 2) category = "big_riser";
    else if (move <= -2) category = "big_faller";
    else if (eid === sheepId) category = "biggest_sheep";
    else if (eid === maverickId) category = "biggest_maverick";
    else if (m.rank <= topThirdCutoff) category = "top_third";
    else if (m.rank > bottomThirdCutoff) category = "bottom_third";
    else category = "mid_table";

    const bank = TITLE_BANKS[category];
    titles[eid] = { title: pick(bank.titles), category, blurb: bank.blurb };
  }
  return titles;
}

/* =========================================================================
   Scout report: next gameweek fixtures, watchlist, transfers, injury watch
   ========================================================================= */
const STATUS_TEXT = { a: "Available", d: "Doubtful", i: "Injured", s: "Suspended", u: "Unavailable", n: "Not in squad" };
const POSITION_NAME = { 1: "GKP", 2: "DEF", 3: "MID", 4: "FWD" };

async function buildNextGwPreview(snapshot) {
  const bootstrap = snapshot.bootstrap;
  const teamsById = snapshot.teamsById;
  const elementsById = snapshot.playersById;

  // Normally event_id + 1 is the gameweek to preview. But if every match
  // in that gameweek has already been played (real time can run ahead of
  // FPL flipping its own "gameweek finished" flag, which lags behind the
  // actual final whistle), there's nothing left to preview there - so
  // keep looking forward until a gameweek with fixtures still to come is
  // found, rather than showing an empty section.
  let nextEvent = null;
  let fixtures = [];
  for (let offset = 1; offset <= 4; offset++) {
    const candidate = bootstrap.events.find((e) => e.id === snapshot.event_id + offset);
    if (!candidate) break;
    const candidateFixtures = await getFixtures(candidate.id);
    const stillUpcoming = candidateFixtures.some((fx) => !fx.started && !fx.finished);
    if (stillUpcoming) {
      nextEvent = candidate;
      fixtures = candidateFixtures;
      break;
    }
  }
  if (!nextEvent) return null;

  // A gameweek can be "not finished" overall while some of its individual
  // matches have already kicked off or finished (e.g. Friday/Saturday
  // fixtures done, Sunday/Monday still to come). Only preview matches
  // that genuinely haven't started yet.
  const upcomingFixtures = fixtures.filter((fx) => !fx.started && !fx.finished);

  const teamFixtures = {};
  for (const fx of upcomingFixtures) {
    for (const [side, oppSide, isHome] of [["team_h", "team_a", true], ["team_a", "team_h", false]]) {
      const teamId = fx[side];
      const oppId = fx[oppSide];
      const difficulty = isHome ? fx.team_h_difficulty : fx.team_a_difficulty;
      if (!teamFixtures[teamId]) teamFixtures[teamId] = [];
      teamFixtures[teamId].push({
        opponent: (teamsById[oppId] || {}).name || "?",
        difficulty,
        venue: isHome ? "H" : "A",
      });
    }
  }

  const fixtureRows = Object.entries(teamFixtures).map(([teamId, fxList]) => ({
    team: (teamsById[teamId] || {}).name || "?",
    fixtures: fxList,
    avg_difficulty: fxList.reduce((s, f) => s + f.difficulty, 0) / fxList.length,
    is_double: fxList.length > 1,
  }));
  fixtureRows.sort((a, b) => a.avg_difficulty - b.avg_difficulty);
  const bestFixtures = fixtureRows.slice(0, 5);
  const worstFixtures = fixtureRows.slice(-5).reverse();

  const easyTeamIds = new Set(Object.entries(teamFixtures).filter(([, fx]) => Math.min(...fx.map((f) => f.difficulty)) <= 2).map(([id]) => Number(id)));
  const candidates = bootstrap.elements.filter((p) => p.status === "a" && parseFloat(p.form || 0) > 0).sort((a, b) => parseFloat(b.form) - parseFloat(a.form));
  const watchlist = [];
  for (const p of candidates) {
    if (watchlist.length >= 6) break;
    if (easyTeamIds.has(p.team) || watchlist.length < 3) {
      const fx = teamFixtures[p.team] || [];
      const opp = fx.length ? fx.map((f) => `${f.opponent} (${f.venue})`).join(", ") : "no fixture";
      watchlist.push({ name: p.web_name, team: (teamsById[p.team] || {}).short_name || "", position: POSITION_NAME[p.element_type] || "", form: p.form, price: (p.now_cost / 10).toFixed(1), next_fixture: opp });
    }
  }

  const transfersIn = [...bootstrap.elements].filter((p) => p.status === "a").sort((a, b) => (b.transfers_in_event || 0) - (a.transfers_in_event || 0)).slice(0, 6)
    .map((p) => ({ name: p.web_name, team: (teamsById[p.team] || {}).short_name || "", position: POSITION_NAME[p.element_type] || "", form: p.form, price: (p.now_cost / 10).toFixed(1) }));

  const transfersOut = [...bootstrap.elements].filter((p) => p.status !== "a" || parseFloat(p.form || 0) < 2).sort((a, b) => (b.transfers_out_event || 0) - (a.transfers_out_event || 0)).slice(0, 6)
    .map((p) => ({ name: p.web_name, team: (teamsById[p.team] || {}).short_name || "", position: POSITION_NAME[p.element_type] || "", status: STATUS_TEXT[p.status] || p.status, news: p.news || "" }));

  // Injury Watch should reflect what's actionable right now, not who
  // was owned back when the reporting gameweek (possibly a week or more
  // behind) was last confirmed. Fetch each manager's CURRENT picks -
  // for the gameweek actually being previewed - purely for this section.
  const injuryWatch = [];
  const seen = new Set();
  for (const m of snapshot.managers) {
    let currentPicks;
    try {
      currentPicks = await getPicks(m.entry_id, nextEvent.id);
    } catch (err) {
      console.warn(`Skipping injury watch for entry ${m.entry_id} (${m.team_name}): ${err.message}`);
      continue;
    }
    const ownedIds = new Set((currentPicks.picks || []).map((p) => p.element));
    for (const pid of ownedIds) {
      const p = elementsById[pid];
      if (!p) continue;
      const status = p.status || "a";
      const chance = p.chance_of_playing_next_round;
      const flagged = status !== "a" || (chance !== null && chance !== undefined && chance < 100);
      if (!flagged) continue;
      const key = `${m.entry_id}-${pid}`;
      if (seen.has(key)) continue;
      seen.add(key);
      injuryWatch.push({ manager_name: m.manager_name, team_name: m.team_name, player_name: p.web_name, status: STATUS_TEXT[status] || status, chance_of_playing: chance, news: p.news || "" });
    }
  }

  return { event_id: nextEvent.id, best_fixtures: bestFixtures, worst_fixtures: worstFixtures, watchlist, transfers_in: transfersIn, transfers_out: transfersOut, injury_watch: injuryWatch };
}

/* =========================================================================
   Star players: this gameweek's standout performers, with photos
   ========================================================================= */
const TEAM_COLORS = {
  ARS: ["#EF0107", "#023474"], AVL: ["#670E36", "#95BFE5"],
  BOU: ["#DA291C", "#000000"], BRE: ["#E30613", "#1A1A1A"],
  BHA: ["#0057B8", "#1B1B1B"], CHE: ["#034694", "#0A2A53"],
  COV: ["#78D0F7", "#1B1B1B"], CRY: ["#1B458F", "#C4122E"],
  EVE: ["#003399", "#274488"], FUL: ["#000000", "#CC0000"],
  HUL: ["#F5A12D", "#000000"], IPS: ["#0044A9", "#00296B"],
  LEE: ["#FFCD00", "#00285E"], LIV: ["#C8102E", "#00285E"],
  MCI: ["#6CABDD", "#1C2C5B"], MUN: ["#DA291C", "#8A1B12"],
  NEW: ["#111111", "#3A3A3A"], NFO: ["#DD0000", "#8A0000"],
  TOT: ["#132257", "#1E3A7A"], SUN: ["#EB172B", "#211E1F"],
};
const DEFAULT_TEAM_COLORS = ["#0B3D24", "#1F6B3F"];
function teamColors(shortName) {
  return TEAM_COLORS[shortName] || DEFAULT_TEAM_COLORS;
}

function playerInitials(p) {
  const first = (p.first_name || "").trim();
  const second = (p.second_name || "").trim();
  if (first && second) return (first[0] + second[0]).toUpperCase();
  const web = (p.web_name || "").trim();
  const parts = web.replace(".", " ").split(/\s+/).filter(Boolean);
  return parts.length ? parts.slice(0, 2).map((w) => w[0]).join("").toUpperCase() : "?";
}

function photoFolderFromBootstrap(bootstrap) {
  const url = (bootstrap.game_config && bootstrap.game_config.settings && bootstrap.game_config.settings.static_content_url) || "";
  const m = url.match(/(\d{4})_(\d{2})/);
  if (m) return `premierleague${m[1].slice(2)}`;
  return "premierleague";
}

function playerPhotoUrls(code, photoFolder) {
  if (!code) return [null, null];
  const primary = `https://resources.premierleague.com/${photoFolder}/photos/players/110x140/${code}.png`;
  const fallback = `https://resources.premierleague.com/premierleague/photos/players/110x140/p${code}.png`;
  return [primary, fallback];
}

function buildStarPlayers(snapshot, topN = 6) {
  const bestById = {};
  const ownedBy = {};
  for (const m of snapshot.managers) {
    const seen = new Set();
    for (const line of m.squad) {
      if (!seen.has(line.id)) {
        seen.add(line.id);
        ownedBy[line.id] = (ownedBy[line.id] || 0) + 1;
      }
    }
    for (const line of m.squad) {
      if (line.multiplier <= 0) continue;
      const existing = bestById[line.id];
      if (!existing || line.final_points > existing[0].final_points) bestById[line.id] = [line, m];
    }
  }
  const ranked = Object.values(bestById).sort((a, b) => b[0].final_points - a[0].final_points).slice(0, topN);
  const photoFolder = snapshot.photo_folder || "premierleague";
  const multiplierLabels = { 2: "Captained (\u00d72)", 3: "Triple Captain (\u00d73)" };
  return ranked.map(([line, manager]) => {
    const [c1, c2] = teamColors(line.team);
    const [photoUrl, photoFallback] = playerPhotoUrls(line.code, photoFolder);
    return {
      name: line.name,
      initials: line.initials || "?",
      team: line.team,
      points: line.final_points,
      raw_points: line.raw_points,
      multiplier: line.multiplier,
      multiplier_label: multiplierLabels[line.multiplier] || "Started (\u00d71)",
      manager_name: manager.manager_name,
      fantasy_team_name: manager.team_name,
      photo_url: photoUrl,
      photo_url_fallback: photoFallback,
      owned_by: ownedBy[line.id] || 1,
      league_size: snapshot.managers.length,
      color1: c1,
      color2: c2,
    };
  });
}

/* =========================================================================
   Highest raw scorers league-wide, independent of your league's ownership
   ========================================================================= */
function buildTopScorers(snapshot, topN = 6) {
  const playersById = snapshot.playersById;
  const teamsById = snapshot.teamsById;
  const livePoints = snapshot.livePoints || {};
  const photoFolder = snapshot.photo_folder || "premierleague";

  const ownedBy = {};
  for (const m of snapshot.managers) {
    const seen = new Set();
    for (const line of m.squad) {
      if (!seen.has(line.id)) {
        seen.add(line.id);
        ownedBy[line.id] = (ownedBy[line.id] || 0) + 1;
      }
    }
  }

  const scored = [];
  for (const [pidStr, stats] of Object.entries(livePoints)) {
    const pid = Number(pidStr);
    const pts = stats.total_points || 0;
    if (pts <= 0 || (stats.minutes || 0) <= 0) continue;
    const p = playersById[pid];
    if (!p) continue;
    scored.push({ pid, p, pts });
  }
  scored.sort((a, b) => b.pts - a.pts);
  const top = scored.slice(0, topN);

  return top.map(({ pid, p, pts }) => {
    const teamShort = (teamsById[p.team] || {}).short_name || "";
    const [c1, c2] = teamColors(teamShort);
    const [photoUrl, photoFallback] = playerPhotoUrls(p.code, photoFolder);
    return {
      name: p.web_name || "Unknown",
      initials: playerInitials(p),
      team: teamShort,
      points: pts,
      owned_by: ownedBy[pid] || 0,
      league_size: snapshot.managers.length,
      photo_url: photoUrl,
      photo_url_fallback: photoFallback,
      color1: c1,
      color2: c2,
    };
  });
}

/* =========================================================================
   Rendering
   ========================================================================= */
function buildStandingsView(managers, titles) {
  const maxPts = Math.max(1, ...managers.map((m) => m.event_total));
  return managers.map((m) => {
    const move = m.last_rank ? m.last_rank - m.rank : 0;
    let moveLabel, moveClass;
    if (move > 0) { moveLabel = `▲${move}`; moveClass = "up"; }
    else if (move < 0) { moveLabel = `▼${Math.abs(move)}`; moveClass = "down"; }
    else { moveLabel = "–"; moveClass = "same"; }
    const t = titles[m.entry_id] || {};
    return { ...m, bar_pct: Math.round((100 * m.event_total) / maxPts), move_label: moveLabel, move_class: moveClass, rank_suffix: ordinalSuffix(m.rank), title: t.title || "", title_blurb: t.blurb || "" };
  });
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function renderPage(snapshot, awards, stories, standings, scout, starPlayers, topScorers) {
  const hero = stories[0];
  const rest = stories.slice(1);
  const generatedDate = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "2-digit", month: "long", year: "numeric" });

  const tickerItems = [];
  if (awards.motm) tickerItems.push(`${esc(awards.motm.manager_name)} tops the gameweek`);
  const funniest = standings.find((r) => r.title);
  if (funniest) tickerItems.push(`${esc(funniest.manager_name)} crowned &quot;${esc(funniest.title)}&quot; this week`);

  const heroHtml = hero
    ? `<div class="hero">
        <div>
          <div class="kicker">${esc(hero.kicker)}</div>
          <h2>${esc(hero.headline)}</h2>
          <p>${esc(hero.body)}</p>
        </div>
        <div class="stat-block">
          <div class="big-number">${hero.manager.event_total}</div>
          <div class="label">Points this gameweek</div>
          <div class="name">${esc(hero.manager.manager_name)}</div>
          <div class="team">${esc(hero.manager.team_name)}</div>
        </div>
      </div>`
    : "";

  const storiesHtml = rest.map((s) => `
    <div class="story">
      <div class="kicker">${esc(s.kicker)}</div>
      <h3>${esc(s.headline)}</h3>
      <p>${esc(s.body)}</p>
    </div>`).join("");

  const starPlayersHtml = (starPlayers || []).map((p, i) => `
    <div class="star-card">
      <div class="photo-frame" style="--c1:${p.color1};--c2:${p.color2};">
        ${i === 0 ? '<div class="rank-flag">BEST RETURN</div>' : ""}
        <div class="initials-badge">${esc(p.initials)}</div>
        ${p.photo_url ? `<img class="real-photo" src="${p.photo_url}" alt="" data-fallback="${p.photo_url_fallback || ""}" onload="this.classList.add('loaded');" onerror="if(this.dataset.fallback &amp;&amp; this.src !== this.dataset.fallback){ this.src = this.dataset.fallback; this.dataset.fallback = ''; } else { this.remove(); }">` : ""}
      </div>
      <div class="info">
        <div class="pts">${p.points}</div>
        <div class="pmult">${esc(p.multiplier_label)} &middot; ${p.raw_points} raw</div>
        <div class="pname">${esc(p.name)}</div>
        <div class="pmeta">${esc(p.team)} &middot; owned by ${p.owned_by}/${p.league_size}</div>
        <div class="pmanager">for ${esc(p.manager_name)} (${esc(p.fantasy_team_name)})</div>
      </div>
    </div>`).join("");

  const topScorersHtml = (topScorers || []).map((p, i) => `
    <div class="star-card">
      <div class="photo-frame" style="--c1:${p.color1};--c2:${p.color2};">
        ${i === 0 ? '<div class="rank-flag">TOP SCORER</div>' : ""}
        <div class="initials-badge">${esc(p.initials)}</div>
        ${p.photo_url ? `<img class="real-photo" src="${p.photo_url}" alt="" data-fallback="${p.photo_url_fallback || ""}" onload="this.classList.add('loaded');" onerror="if(this.dataset.fallback &amp;&amp; this.src !== this.dataset.fallback){ this.src = this.dataset.fallback; this.dataset.fallback = ''; } else { this.remove(); }">` : ""}
      </div>
      <div class="info">
        <div class="pts">${p.points}</div>
        <div class="pname">${esc(p.name)}</div>
        <div class="pmeta">${esc(p.team)} ${p.owned_by === 0 ? "&middot; owned by no one in your league" : `&middot; owned by ${p.owned_by}/${p.league_size}`}</div>
      </div>
    </div>`).join("");

  const powerHtml = standings.map((m) => `
    <div class="power-card">
      <div class="rank-tag">${m.rank}${m.rank_suffix} in the table</div>
      <div class="title">${esc(m.title)}</div>
      <div class="who">${esc(m.team_name)} <span>&middot; ${esc(m.manager_name)}</span></div>
      <div class="blurb">${esc(m.title_blurb)}</div>
    </div>`).join("");

  const standingsHtml = standings.map((m) => `
    <div class="standing-row">
      <div class="rank">${m.rank}</div>
      <div class="names">
        <div class="team-name">${esc(m.team_name)}</div>
        <div class="manager-name">${esc(m.manager_name)}</div>
        <div class="title-badge">${esc(m.title)}</div>
      </div>
      <div class="pts-col">
        <div class="num">${m.total_points}</div>
        <div class="label">Total</div>
      </div>
      <div class="pts-col week">
        <div class="num">${m.event_total}</div>
        <div class="label">GW${snapshot.event_id}</div>
      </div>
      <div class="move ${m.move_class}">${m.move_label}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${m.bar_pct}%"></div></div>
    </div>`).join("");

  function cardsHtml() {
    const cards = [];
    if (awards.league_average != null) cards.push({ emoji: "📊", title: "League Average This Week", value: `${awards.league_average} pts` });
    const add = (emoji, title, m) => { if (m) cards.push({ emoji, title, value: `${esc(m.manager_name)} — ${esc(m.team_name)}` }); };
    add("🥇", "Manager of the Match", awards.motm);
    add("🥶", "Stinker of the Week", awards.flop);
    add("🎯", "Best Captaincy", awards.best_captain);
    add("🪑", "Bench Flop", awards.bench_flop);
    add("🐑", "Biggest Sheep", awards.biggest_sheep);
    add("🦄", "Biggest Maverick", awards.biggest_maverick);
    return cards.map((c) => `
      <div class="card">
        <div class="emoji">${c.emoji}</div>
        <div class="title">${esc(c.title)}</div>
        <div class="value">${c.value}</div>
      </div>`).join("");
  }

  function scoutHtml() {
    if (!scout) return "";
    const fxRow = (f) => `
      <div class="fixture-row">
        <span>${esc(f.team)}${f.is_double ? ' <span class="opp">(DGW)</span>' : ""}</span>
        <span class="opp">${f.fixtures.map((fx) => `${esc(fx.opponent)} (${fx.venue})`).join(", ")}</span>
        <span class="diff-chip diff-${f.fixtures[0].difficulty}">FDR ${f.avg_difficulty.toFixed(1)}</span>
      </div>`;
    const playerRow = (p, statLabel) => `
      <div class="player-row">
        <div>
          <div class="pname">${esc(p.name)} <span class="pmeta">${p.position} &middot; ${esc(p.team)}</span></div>
          ${p.next_fixture ? `<div class="pmeta">Next: ${esc(p.next_fixture)}</div>` : ""}
          ${p.news ? `<div class="pmeta">${esc(p.news)}</div>` : ""}
        </div>
        <div class="pstat">${statLabel}</div>
      </div>`;
    const injuryHtml = scout.injury_watch.map((inj) => `
      <div class="injury-box">
        <span class="who">${esc(inj.player_name)}</span> (owned by ${esc(inj.manager_name)} — ${esc(inj.team_name)})
        is <span class="status">${esc(inj.status)}</span>${inj.chance_of_playing != null ? ` — ${inj.chance_of_playing}% chance of playing` : ""}.
        ${inj.news ? `<div class="news">${esc(inj.news)}</div>` : ""}
      </div>`).join("");

    return `
    <div class="section-head">Scout Report — Gameweek ${scout.event_id} Preview</div>
    <p class="scout-intro">A look ahead before the next deadline: who's got the kind fixtures, who's in form, and who's carrying an injury doubt in your league right now.</p>
    <div class="fdr-explainer">
      <div class="label">What is FDR?</div>
      Fixture Difficulty Rating is FPL's own 1-to-5 score for how tough a match looks,
      worked out from each side's attack, defence and home/away form. 1 means an
      easy fixture, 5 means a brutal one. Every match gets two ratings, one for
      each team, since the same game is a different challenge depending which
      side you're on. Low FDR is a green light to captain or bring in that
      team's players; high FDR is a reason to think about benching them.
      <div class="swatches">
        <span class="swatch diff-1">1-2 Easy</span>
        <span class="swatch diff-3">3 Average</span>
        <span class="swatch diff-4">4-5 Hard</span>
      </div>
    </div>
    <div class="scout-columns">
      <div>
        <div class="scout-subhead">Best Fixtures Coming Up</div>
        ${scout.best_fixtures.map(fxRow).join("")}
      </div>
      <div>
        <div class="scout-subhead">Toughest Fixtures Coming Up</div>
        ${scout.worst_fixtures.map(fxRow).join("")}
      </div>
    </div>
    <div class="scout-columns" style="margin-top:30px;">
      <div>
        <div class="scout-subhead">Players To Watch</div>
        ${scout.watchlist.map((p) => playerRow(p, `Form ${p.form}<br>£${p.price}m`)).join("")}
      </div>
      <div>
        <div class="scout-subhead">Trending In</div>
        ${scout.transfers_in.map((p) => playerRow(p, `Form ${p.form}<br>£${p.price}m`)).join("")}
        <div class="scout-subhead" style="margin-top:22px;">Think Twice About</div>
        ${scout.transfers_out.map((p) => playerRow(p, esc(p.status))).join("")}
      </div>
    </div>
    ${scout.injury_watch.length ? `<div class="scout-subhead" style="margin-top:30px;">Injury Watch — Your League's Gameweek ${scout.event_id} Squads</div><p style="font-size:13.5px;color:var(--ink-soft);margin:-6px 0 12px;">Reflects each manager's current squad ahead of Gameweek ${scout.event_id}.</p>${injuryHtml}` : ""}`;
  }

  return `
  <div class="masthead">
    <div class="masthead-inner">
      <div class="strap">
        <span>${generatedDate}</span>
        <span>Gameweek ${snapshot.event_id} &middot; ${esc(snapshot.league_name)}</span>
      </div>
      <h1>${esc(snapshot.league_name)}</h1>
      <div class="sub">The ${esc(snapshot.league_name)} Weekly — a mini-league tabloid, printed fresh every gameweek</div>
    </div>
  </div>
  ${tickerItems.length ? `<div class="ticker"><span class="tag">This Week</span><span>${tickerItems.join("   &bull;   ")}</span></div>` : ""}
  <div class="wrap">
    ${heroHtml}
    <div class="section-head">This Week's Stories</div>
    <div class="story-grid">${storiesHtml}</div>
    ${starPlayers && starPlayers.length ? `<div class="section-head">Biggest Returns This Week</div><p class="scout-intro">The best result any manager in your league actually got from a player this gameweek — including their captain call. This is about who benefited, not who played best.</p><div class="star-grid">${starPlayersHtml}</div>` : ""}
    ${topScorers && topScorers.length ? `<div class="section-head">Highest Scoring Players This Week</div><p class="scout-intro">The best individual performances across the whole gameweek, full stop — whether or not anyone in your league happens to own them.</p><div class="star-grid">${topScorersHtml}</div>` : ""}
    <div class="section-head">This Week's Power Rankings</div>
    <div class="power-grid">${powerHtml}</div>
    <div class="section-head">League Table — Gameweek ${snapshot.event_id}</div>
    <div class="standings">${standingsHtml}</div>
    <div class="section-head">The Numbers That Matter</div>
    <div class="cards">${cardsHtml()}</div>
    ${scoutHtml()}
    <div class="footer-note">Fan-made and unofficial. Not affiliated with the Premier League or Fantasy Premier League. Generated live in your browser on ${generatedDate}.</div>
  </div>`;
}

/* =========================================================================
   UI wiring
   ========================================================================= */
async function generateForLeague(leagueId) {
  const statusEl = document.getElementById("status");
  const resultEl = document.getElementById("result");
  const formEl = document.getElementById("league-form");
  resultEl.innerHTML = "";
  formEl.querySelector("button").disabled = true;

  try {
    statusEl.textContent = "Fetching league standings…";
    const snapshot = await buildLeagueSnapshot(leagueId, (done, total) => {
      statusEl.textContent = `Reading squads… ${done}/${total} managers`;
    });
    statusEl.textContent = "Working out this week's stats…";
    const awards = buildAwards(snapshot);
    const stories = buildAllStories(awards);
    const titles = assignTitles(snapshot.managers, awards);
    const standings = buildStandingsView(snapshot.managers, titles);
    const starPlayers = buildStarPlayers(snapshot);
    const topScorers = buildTopScorers(snapshot);
    statusEl.textContent = "Pulling next gameweek's fixtures…";
    const scout = await buildNextGwPreview(snapshot).catch(() => null);

    statusEl.textContent = "";
    resultEl.innerHTML = renderPage(snapshot, awards, stories, standings, scout, starPlayers, topScorers);
    resultEl.scrollIntoView({ behavior: "smooth", block: "start" });
    const shareRow = document.getElementById("share-row");
    if (shareRow) shareRow.style.display = "flex";
  } catch (err) {
    statusEl.textContent = "";
    resultEl.innerHTML = `<div class="error-box">Couldn't build the paper: ${esc(err.message || err)}</div>`;
    const shareRow = document.getElementById("share-row");
    if (shareRow) shareRow.style.display = "none";
  } finally {
    formEl.querySelector("button").disabled = false;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("league-form");
  const shareRow = document.getElementById("share-row");
  const whatsappBtn = document.getElementById("share-whatsapp");
  const copyBtn = document.getElementById("share-copy");
  const pdfBtn = document.getElementById("export-pdf");

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const leagueId = document.getElementById("league-code").value.trim();
    if (!leagueId) return;
    generateForLeague(leagueId);
  });

  if (whatsappBtn) {
    whatsappBtn.addEventListener("click", () => {
      const leagueName = (document.querySelector("#result .masthead h1") || {}).textContent || "our mini-league";
      const message = `This week's ${leagueName.trim()} newspaper is up: ${window.location.href}`;
      window.open(`https://wa.me/?text=${encodeURIComponent(message)}`, "_blank");
    });
  }
  if (copyBtn) {
    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(window.location.href);
        copyBtn.textContent = "Copied!";
        setTimeout(() => (copyBtn.textContent = "Copy Link"), 1500);
      } catch (e) {
        window.prompt("Copy this link:", window.location.href);
      }
    });
  }

  if (pdfBtn) {
    pdfBtn.addEventListener("click", () => {
      // The browser's own "Save as PDF" print destination gives a clean,
      // properly-paginated PDF using the real fonts and layout - no extra
      // library needed. print.css (in styles.css) hides the input form
      // and share buttons and adjusts colours/page-breaks for print.
      const original = document.title;
      const leagueName = (document.querySelector("#result .masthead h1") || {}).textContent || "FPL Weekly";
      const editionLine = (document.querySelector("#result .strap span:last-child") || {}).textContent || "";
      document.title = `${leagueName.trim()} ${editionLine.trim()}`.trim();
      window.print();
      document.title = original;
    });
  }

  if (PROXY_BASE.includes("YOUR-WORKER-SUBDOMAIN")) {
    document.getElementById("status").innerHTML =
      'Set <code>PROXY_BASE</code> at the top of app.js to your deployed worker URL first — see README.md.';
    return;
  }

  // A pre-filled league code means this page is meant to load straight
  // into that league's current edition - no click needed, so whoever
  // opens the shared link always sees this week's paper immediately.
  const codeInput = document.getElementById("league-code");
  if (codeInput && codeInput.value.trim()) {
    generateForLeague(codeInput.value.trim());
  }
});
