// Tools the agent can call. Add yours here (or ask Claude Code: /add-tool).
// Three edits per tool: the function, an entry in HANDLERS, a schema in SCHEMAS.
import fs from "node:fs";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { RUNS_DIR, here } from "./env";

const MEMORY = path.join(RUNS_DIR, "memory.json");
// Tracked in git (unlike runs/, which is gitignored) so the scoreboard page can read it
// straight from GitHub. The loop writes here, you commit and push, the page picks it up.
const SEASON = path.join(here, "..", "data", "season.json");

export function getTime(): string {
  return new Date().toISOString();
}

export async function fetchUrl({ url }: { url: string }): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  return (await res.text()).slice(0, 20_000);
}

export function remember({ key, value }: { key: string; value: string }): string {
  const data = load();
  data[key] = value;
  fs.mkdirSync(RUNS_DIR, { recursive: true });
  fs.writeFileSync(MEMORY, JSON.stringify(data, null, 2));
  return `stored ${key}`;
}

export function recall({ key }: { key: string }): string {
  return load()[key] ?? `nothing stored under ${key}`;
}

function load(): Record<string, string> {
  return fs.existsSync(MEMORY) ? JSON.parse(fs.readFileSync(MEMORY, "utf8")) : {};
}

type Fixture = {
  matchday: number;
  date: string;
  home: string;
  away: string;
  home_form?: string;
  away_form?: string;
  predicted_result?: "home_win" | "draw" | "away_win";
  predicted_score?: string;
  reasoning?: string;
  predicted_at?: string;
  actual_home_score?: number;
  actual_away_score?: number;
  actual_result?: "home_win" | "draw" | "away_win";
  correct?: boolean;
  scored_at?: string;
};

function fixtureKey(matchday: number, home: string, away: string): string {
  // team names sometimes arrive HTML-escaped (e.g. "Brighton &amp; Hove Albion FC") — decode
  // before slugifying so the key matches regardless of which form the caller used.
  const slug = (s: string) =>
    s
      .replace(/&amp;/gi, "&")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");
  return `md${matchday}-${slug(home)}-${slug(away)}`;
}

function loadSeason(): Record<string, Fixture> {
  return fs.existsSync(SEASON) ? JSON.parse(fs.readFileSync(SEASON, "utf8")).fixtures ?? {} : {};
}

function saveSeason(fixtures: Record<string, Fixture>): void {
  fs.mkdirSync(path.dirname(SEASON), { recursive: true });
  fs.writeFileSync(SEASON, JSON.stringify({ fixtures }, null, 2));
}

export function recordPrediction({
  matchday,
  date,
  home,
  away,
  predicted_result,
  predicted_score,
  home_form,
  away_form,
  reasoning,
}: {
  matchday: number;
  date: string;
  home: string;
  away: string;
  predicted_result: "home_win" | "draw" | "away_win";
  predicted_score?: string;
  home_form?: string;
  away_form?: string;
  reasoning?: string;
}): string {
  const fixtures = loadSeason();
  const key = fixtureKey(matchday, home, away);
  fixtures[key] = {
    ...fixtures[key],
    matchday,
    date,
    home,
    away,
    predicted_result,
    predicted_score,
    home_form,
    away_form,
    reasoning,
    predicted_at: new Date().toISOString(),
  };
  saveSeason(fixtures);
  return `recorded prediction ${key}: ${predicted_result}${predicted_score ? ` (${predicted_score})` : ""}`;
}

export function recordResult({
  matchday,
  home,
  away,
  actual_home_score,
  actual_away_score,
}: {
  matchday: number;
  home: string;
  away: string;
  actual_home_score: number;
  actual_away_score: number;
}): string {
  const fixtures = loadSeason();
  const key = fixtureKey(matchday, home, away);
  const fixture = fixtures[key];
  if (!fixture || !fixture.predicted_result) {
    return `no prior prediction found for ${key} — call record_prediction first, or check matchday/home/away spelling.`;
  }
  const actual_result: Fixture["actual_result"] =
    actual_home_score > actual_away_score ? "home_win" : actual_home_score < actual_away_score ? "away_win" : "draw";
  fixture.actual_home_score = actual_home_score;
  fixture.actual_away_score = actual_away_score;
  fixture.actual_result = actual_result;
  fixture.correct = actual_result === fixture.predicted_result;
  fixture.scored_at = new Date().toISOString();
  saveSeason(fixtures);
  return (
    `recorded result ${key}: ${actual_home_score}-${actual_away_score} (${actual_result}). ` +
    `Prediction was ${fixture.predicted_result} — ${fixture.correct ? "correct" : "wrong"}.`
  );
}

export function getSeasonState({ matchday }: { matchday?: number }): string {
  const fixtures = Object.values(loadSeason()).filter((f) => matchday === undefined || f.matchday === matchday);
  if (fixtures.length === 0) return matchday === undefined ? "no fixtures recorded yet." : `no fixtures recorded for matchday ${matchday}.`;
  return JSON.stringify(fixtures, null, 2);
}

// Free-tier football-data.org caps at 10 requests/minute. A matchday-wide run makes many
// overlapping requests (head-to-head and recent-form for the same team hit the same
// underlying endpoint), so this caches per-URL for the life of the process and retries
// 429s with backoff instead of surfacing them as a tool error the model has to work around.
const fdCache = new Map<string, Promise<any>>();

async function footballDataFetch(pathname: string): Promise<any> {
  const cached = fdCache.get(pathname);
  if (cached) return cached;
  const promise = footballDataFetchUncached(pathname).catch((e) => {
    fdCache.delete(pathname);
    throw e;
  });
  fdCache.set(pathname, promise);
  return promise;
}

async function footballDataFetchUncached(pathname: string): Promise<any> {
  const key = process.env.FOOTBALL_DATA_API_KEY;
  if (!key) throw new Error("FOOTBALL_DATA_API_KEY not set in .env");
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`https://api.football-data.org/v4${pathname}`, {
      headers: { "X-Auth-Token": key },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 429 && attempt < 5) {
      const retryAfter = Number(res.headers.get("retry-after")) || 7;
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      continue;
    }
    if (!res.ok) throw new Error(`football-data.org ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }
}

type PLTeam = { id: number; name: string; shortName: string; tla: string };
let plTeamsCache: PLTeam[] | null = null;

async function resolveTeamId(name: string): Promise<PLTeam> {
  if (!plTeamsCache) {
    const data = await footballDataFetch("/competitions/PL/teams");
    plTeamsCache = data.teams.map((t: any) => ({ id: t.id, name: t.name, shortName: t.shortName, tla: t.tla }));
  }
  const needle = name.trim().toLowerCase();
  const teams = plTeamsCache!;
  const match =
    teams.find((t) => t.name.toLowerCase() === needle || t.shortName.toLowerCase() === needle || t.tla.toLowerCase() === needle) ??
    teams.find((t) => t.name.toLowerCase().includes(needle) || t.shortName.toLowerCase().includes(needle));
  if (!match) throw new Error(`no current EPL team matching "${name}"`);
  return match;
}

function shiftDate(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86_400_000);
}

// Unofficial, undocumented ESPN endpoint. No key needed, but no SLA either — schema can
// change without notice. Used here only for lineup/formation data the free football-data.org
// tier does not have.
async function espnFetch(pathname: string): Promise<any> {
  const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1${pathname}`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`espn ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function fetchLineupSection(team: string, match_date: string): Promise<string> {
  const needle = team.trim().toLowerCase();
  const board = await espnFetch(`/scoreboard?dates=${match_date.replace(/-/g, "")}`);
  const event = (board.events as any[] | undefined)?.find((e) =>
    e.competitions[0].competitors.some(
      (c: any) => c.team.displayName.toLowerCase().includes(needle) || c.team.shortDisplayName.toLowerCase().includes(needle),
    ),
  );
  if (!event) return `lineup: no EPL fixture found on ${match_date} involving a team matching "${team}" (ESPN scoreboard).`;

  const summary = await espnFetch(`/summary?event=${event.id}`);
  const rosters = summary.rosters as any[] | undefined;
  if (!rosters || rosters.length === 0) {
    return `lineup: not yet published for ${event.name} on ${match_date} — ESPN publishes lineups shortly before kickoff.`;
  }
  const roster = rosters.find(
    (r) => r.team?.displayName?.toLowerCase().includes(needle) || r.team?.shortDisplayName?.toLowerCase().includes(needle),
  );
  if (!roster) return `lineup: ESPN returned data for this fixture but no roster matched "${team}".`;

  const starters = (roster.roster as any[])
    .filter((p) => p.starter)
    .map((p) => `${p.position?.abbreviation ?? "?"} ${p.athlete?.displayName ?? "unknown"}`);
  if (starters.length === 0) return `lineup: ESPN roster for ${roster.team?.displayName ?? team} has no starters marked yet for ${event.name}.`;
  return `lineup: ${roster.team.displayName} starting XI${roster.formation ? ` (${roster.formation})` : ""}: ${starters.join(", ")}`;
}

function resultLetter(m: any, teamId: number): "W" | "D" | "L" {
  const isHome = m.homeTeam.id === teamId;
  const gf = isHome ? m.score.fullTime.home : m.score.fullTime.away;
  const ga = isHome ? m.score.fullTime.away : m.score.fullTime.home;
  return gf > ga ? "W" : gf < ga ? "L" : "D";
}

function matchLine(m: any, teamId: number): string {
  const isHome = m.homeTeam.id === teamId;
  const opp = isHome ? m.awayTeam.name : m.homeTeam.name;
  const venue = isHome ? "home" : "away";
  return `${m.utcDate.slice(0, 10)} vs ${opp} (${venue}) ${m.score.fullTime.home}-${m.score.fullTime.away}`;
}

// One football-data.org call per team (all competitions, cached for the run) plus one ESPN
// lineup call, bundled into a single tool response: recent EPL form, fixture congestion, and
// (if opponent is given) head-to-head — all derived locally from that one fetch instead of
// separate API calls each. Keeps a matchday-wide run's request count to ~2 per team instead
// of ~4, which matters against football-data.org's free-tier 10-requests/minute cap.
export async function getTeamData({
  team,
  match_date,
  opponent,
}: {
  team: string;
  match_date: string;
  opponent?: string;
}): Promise<string> {
  const t = await resolveTeamId(team);
  const sections: string[] = [];

  try {
    const data = await footballDataFetch(`/teams/${t.id}/matches?status=FINISHED&limit=100`);
    const before = (data.matches as any[])
      .filter((m) => m.utcDate.slice(0, 10) < match_date)
      .sort((x, y) => x.utcDate.localeCompare(y.utcDate));

    const plForm = before.filter((m) => m.competition?.code === "PL").slice(-5);
    sections.push(
      plForm.length === 0
        ? `recent EPL form: no finished EPL matches found for ${t.name} before ${match_date}.`
        : `recent EPL form before ${match_date} (oldest to newest): ${plForm.map((m) => resultLetter(m, t.id)).join("")}\n` +
          plForm.map((m) => matchLine(m, t.id)).join("\n"),
    );

    const from = shiftDate(match_date, -4);
    const to = shiftDate(match_date, -1);
    const congestion = before.filter((m) => {
      const d = m.utcDate.slice(0, 10);
      return d >= from && d <= to;
    });
    sections.push(
      congestion.length === 0
        ? `fixture congestion: no match (any competition) in the 4 days before ${match_date} — rested.`
        : `fixture congestion: ${congestion.length} match(es) across all competitions in the 4 days before ${match_date}, ` +
          `${daysBetween(congestion[congestion.length - 1].utcDate.slice(0, 10), match_date)} day(s) rest since the most recent.\n` +
          congestion
            .map((m) => `${m.utcDate.slice(0, 10)} ${m.competition?.name ?? "?"}: ${m.homeTeam.name} ${m.score.fullTime.home}-${m.score.fullTime.away} ${m.awayTeam.name}`)
            .join("\n"),
    );

    if (opponent) {
      const o = await resolveTeamId(opponent);
      const h2h = before.filter((m) => m.competition?.code === "PL" && (m.homeTeam.id === o.id || m.awayTeam.id === o.id)).slice(-10);
      if (h2h.length === 0) {
        sections.push(`head-to-head vs ${o.name}: no finished EPL meetings found before ${match_date}.`);
      } else {
        let w = 0;
        let d = 0;
        let l = 0;
        const lines = h2h.map((m) => {
          const r = resultLetter(m, t.id);
          if (r === "W") w++;
          else if (r === "D") d++;
          else l++;
          return matchLine(m, t.id);
        });
        sections.push(`head-to-head vs ${o.name}, last ${h2h.length} EPL meetings: ${t.name} ${w}W ${d}D ${l}L.\n${lines.join("\n")}`);
      }
    }
  } catch (e) {
    sections.push(`football-data.org lookup failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  try {
    sections.push(await fetchLineupSection(team, match_date));
  } catch (e) {
    sections.push(`lineup lookup failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  return `${t.name} — data before ${match_date}:\n\n${sections.join("\n\n")}`;
}

export async function getMatchdayFixtures({
  matchday,
  status,
}: {
  matchday?: number;
  status?: string;
}): Promise<string> {
  let md = matchday;
  if (md === undefined) {
    const comp = await footballDataFetch("/competitions/PL");
    md = comp.currentSeason?.currentMatchday;
    if (md === undefined) throw new Error("could not determine the current EPL matchday from the competition endpoint");
  }
  const statusParam = status ? `&status=${status}` : "";
  const data = await footballDataFetch(`/competitions/PL/matches?matchday=${md}${statusParam}`);
  const matches = data.matches as any[];
  if (matches.length === 0) {
    return `no EPL fixtures found for matchday ${md}${status ? ` with status ${status}` : ""} — season may not have reached or may be past this matchday.`;
  }
  const lines = matches.map((m) => {
    const score = m.status === "FINISHED" ? ` ${m.score.fullTime.home}-${m.score.fullTime.away}` : "";
    return `${m.utcDate.slice(0, 10)} ${m.homeTeam.name} vs ${m.awayTeam.name} [${m.status}]${score}`;
  });
  return `EPL matchday ${md}${status ? ` (${status})` : ""}, ${matches.length} fixture(s):\n${lines.join("\n")}`;
}

type Handler = (args: any) => string | Promise<string>;

export const HANDLERS: Record<string, Handler> = {
  get_time: getTime,
  fetch_url: fetchUrl,
  remember,
  recall,
  get_team_data: getTeamData,
  get_matchday_fixtures: getMatchdayFixtures,
  record_prediction: recordPrediction,
  record_result: recordResult,
  get_season_state: getSeasonState,
};

// the description is the only thing the model reads when deciding to call a tool. write it for the model.
export const SCHEMAS: Anthropic.Tool[] = [
  {
    name: "get_time",
    description: "Current UTC time as ISO 8601.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "fetch_url",
    description: "HTTP GET a public URL. Returns the first 20KB of the body as text.",
    input_schema: {
      type: "object",
      properties: { url: { type: "string", description: "Absolute http(s) URL." } },
      required: ["url"],
    },
  },
  {
    name: "remember",
    description: "Persist a key/value so a future run can read it with recall.",
    input_schema: {
      type: "object",
      properties: { key: { type: "string" }, value: { type: "string" } },
      required: ["key", "value"],
    },
  },
  {
    name: "recall",
    description: "Read a value stored by remember in this or an earlier run.",
    input_schema: {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
    },
  },
  {
    name: "get_team_data",
    description:
      "Everything about one EPL team going into a match, in one call: recent EPL form (last 5 matches " +
      "before match_date), fixture congestion (any match, any competition, in the 4 days before match_date), " +
      "and starting lineup/formation (from ESPN, may not be published yet). Pass opponent to also get " +
      "head-to-head history between the two teams. Call this once per team (not per fact) — it already " +
      "bundles everything a prediction needs for that team.",
    input_schema: {
      type: "object",
      properties: {
        team: { type: "string", description: "EPL team name, e.g. 'Arsenal FC' or 'Arsenal'." },
        match_date: { type: "string", description: "ISO date (YYYY-MM-DD) of the match being predicted. Only data strictly before this date is used." },
        opponent: { type: "string", description: "Optional. The team they're playing on match_date, to also get head-to-head history." },
      },
      required: ["team", "match_date"],
    },
  },
  {
    name: "get_matchday_fixtures",
    description:
      "List EPL fixtures for one matchday (gameweek). Omit matchday to use whatever the competition's current " +
      "matchday is. Filter status=SCHEDULED to see what needs predicting before the matchweek, or " +
      "status=FINISHED to see actual results after it. Omit status to see everything for that matchday.",
    input_schema: {
      type: "object",
      properties: {
        matchday: { type: "number", description: "EPL matchday number, 1-38. Omit for the current matchday." },
        status: {
          type: "string",
          description: "Optional filter: SCHEDULED, TIMED, FINISHED, POSTPONED, or IN_PLAY.",
        },
      },
    },
  },
  {
    name: "record_prediction",
    description:
      "Save a match prediction to the tracked season scoreboard (data/season.json), keyed by matchday+home+away. " +
      "Call this once per fixture after predicting it, in matchday-batch tasks and single-match tasks alike — " +
      "the scoreboard page reads from here, not from remember/recall.",
    input_schema: {
      type: "object",
      properties: {
        matchday: { type: "number", description: "EPL matchday number, 1-38." },
        date: { type: "string", description: "ISO date (YYYY-MM-DD) of the match." },
        home: { type: "string", description: "Home team name." },
        away: { type: "string", description: "Away team name." },
        predicted_result: { type: "string", enum: ["home_win", "draw", "away_win"] },
        predicted_score: { type: "string", description: "Optional predicted scoreline, e.g. '2-1'." },
        home_form: { type: "string", description: "Optional W/D/L letters for the home team, oldest to newest, as returned by get_team_data." },
        away_form: { type: "string", description: "Optional W/D/L letters for the away team, oldest to newest, as returned by get_team_data." },
        reasoning: { type: "string", description: "One or two sentences on why, for display on the scoreboard." },
      },
      required: ["matchday", "date", "home", "away", "predicted_result"],
    },
  },
  {
    name: "record_result",
    description:
      "Save a match's actual score against an existing prediction (matchday+home+away must already have one " +
      "from record_prediction). Computes and stores whether the prediction was correct.",
    input_schema: {
      type: "object",
      properties: {
        matchday: { type: "number", description: "EPL matchday number, 1-38." },
        home: { type: "string", description: "Home team name, matching what record_prediction used." },
        away: { type: "string", description: "Away team name, matching what record_prediction used." },
        actual_home_score: { type: "number" },
        actual_away_score: { type: "number" },
      },
      required: ["matchday", "home", "away", "actual_home_score", "actual_away_score"],
    },
  },
  {
    name: "get_season_state",
    description:
      "Read back recorded fixtures from the season scoreboard, optionally filtered to one matchday. Use this " +
      "to check what's already been predicted or scored before redoing work, or to review recent accuracy.",
    input_schema: {
      type: "object",
      properties: {
        matchday: { type: "number", description: "Optional. Omit to get every recorded fixture all season." },
      },
    },
  },
];

export async function dispatch(name: string, args: unknown): Promise<string> {
  const fn = HANDLERS[name];
  if (!fn) return `error: unknown tool ${name}`;
  try {
    return String(await fn(args));
  } catch (e) {
    // errors go back to the model as text so it can recover
    return `error: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`;
  }
}
