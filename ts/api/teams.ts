// 201: public read-only endpoint for the drag-and-drop UI (index.html).
// GET /api/teams -> { currentMatchday, teams: [{ name, status, matchday, date, opponent, venue, prediction }] }
//
// Keeps FOOTBALL_DATA_API_KEY server-side (never sent to the browser) and combines it with
// the season scoreboard, which is fetched fresh from GitHub raw content each request so this
// never needs a redeploy to see new predictions/results.
import type { VercelRequest, VercelResponse } from "@vercel/node";

const SEASON_URL = "https://raw.githubusercontent.com/prasenjitChak/will_manu_win/main/ts/data/season.json";
const WINDOW = 3; // "next 3 weeks"

async function footballData(pathname: string): Promise<any> {
  const key = process.env.FOOTBALL_DATA_API_KEY;
  if (!key) throw new Error("FOOTBALL_DATA_API_KEY not set");
  const res = await fetch(`https://api.football-data.org/v4${pathname}`, { headers: { "X-Auth-Token": key } });
  if (!res.ok) throw new Error(`football-data.org ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

function fixtureKey(matchday: number, home: string, away: string): string {
  const slug = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  return `md${matchday}-${slug(home)}-${slug(away)}`;
}

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  try {
    const [teamsData, comp] = await Promise.all([footballData("/competitions/PL/teams"), footballData("/competitions/PL")]);
    const allTeamNames: string[] = teamsData.teams.map((t: any) => t.name);
    const crestByName: Record<string, string> = Object.fromEntries(teamsData.teams.map((t: any) => [t.name, t.crest]));

    // The API's own "currentMatchday" can lag behind — it may point at a matchday whose
    // games already finished. Walk forward to the first one that still has an unplayed
    // fixture and treat that as "this week".
    let currentMatchday: number = comp.currentSeason?.currentMatchday;
    let anchorMatches: any[] = (await footballData(`/competitions/PL/matches?matchday=${currentMatchday}`)).matches;
    for (let i = 0; i < 5 && anchorMatches.length > 0 && anchorMatches.every((m) => m.status === "FINISHED"); i++) {
      currentMatchday++;
      anchorMatches = (await footballData(`/competitions/PL/matches?matchday=${currentMatchday}`)).matches;
    }

    const matchdays = [currentMatchday, currentMatchday + 1, currentMatchday + 2, currentMatchday + 3];
    const fixturesByMatchday = [
      { matches: anchorMatches },
      ...(await Promise.all(
        matchdays.slice(1).map((md) => footballData(`/competitions/PL/matches?matchday=${md}`).catch(() => ({ matches: [] }))),
      )),
    ];

    let season: { fixtures: Record<string, any> } = { fixtures: {} };
    try {
      const seasonRes = await fetch(`${SEASON_URL}?_=${Date.now()}`);
      if (seasonRes.ok) season = await seasonRes.json();
    } catch {
      // scoreboard not reachable — teams still resolve, just without predictions
    }

    const teams = allTeamNames.map((name) => {
      for (let i = 0; i < matchdays.length; i++) {
        const md = matchdays[i];
        const fixture = (fixturesByMatchday[i].matches as any[] | undefined)?.find(
          (m) => m.homeTeam.name === name || m.awayTeam.name === name,
        );
        if (!fixture) continue;

        const isHome = fixture.homeTeam.name === name;
        const opponent = isHome ? fixture.awayTeam.name : fixture.homeTeam.name;
        const key = fixtureKey(md, fixture.homeTeam.name, fixture.awayTeam.name);
        const prediction = season.fixtures[key] ?? null;
        const form = prediction ? (isHome ? prediction.home_form : prediction.away_form) ?? null : null;

        return {
          name,
          crest: crestByName[name] ?? null,
          status: i === 0 ? "this_week" : "next_3",
          matchday: md,
          date: fixture.utcDate.slice(0, 10),
          opponent,
          opponentCrest: crestByName[opponent] ?? null,
          venue: isHome ? "home" : "away",
          prediction,
          form,
        };
      }
      return {
        name,
        crest: crestByName[name] ?? null,
        status: "none",
        matchday: null,
        date: null,
        opponent: null,
        opponentCrest: null,
        venue: null,
        prediction: null,
        form: null,
      };
    });

    res.setHeader("Cache-Control", "s-maxage=120, stale-while-revalidate=300");
    return res.status(200).json({ currentMatchday, windowWeeks: WINDOW, teams });
  } catch (e) {
    return res.status(502).json({ error: e instanceof Error ? e.message : String(e) });
  }
}
