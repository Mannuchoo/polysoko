const API_FOOTBALL_BASE = 'https://v3.football.api-sports.io';
const cache = new Map();
const CACHE_TTL = 15 * 60 * 1000;

function readCache(key) {
    const entry = cache.get(key);
    if (!entry || entry.expiresAt <= Date.now()) return null;
    return entry.value;
}

function writeCache(key, value) {
    cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL });
    if (cache.size > 500) cache.delete(cache.keys().next().value);
    return value;
}

function formFromFixtures(fixtures, teamId) {
    return fixtures.slice(0, 5).map(item => {
        const home = Number(item?.teams?.home?.id) === Number(teamId);
        const teamGoals = home ? item?.goals?.home : item?.goals?.away;
        const opponentGoals = home ? item?.goals?.away : item?.goals?.home;
        if (!Number.isFinite(Number(teamGoals)) || !Number.isFinite(Number(opponentGoals))) return null;
        return Number(teamGoals) > Number(opponentGoals) ? 'W' : Number(teamGoals) < Number(opponentGoals) ? 'L' : 'D';
    }).filter(Boolean);
}

function normalizeLineups(rows, homeId, awayId) {
    const byTeam = (id) => {
        const team = rows.find(row => Number(row?.team?.id) === Number(id));
        return (team?.startXI || []).map(({ player }) => ({
            name: player?.name || 'Player', number: player?.number ?? null, position: player?.pos || ''
        }));
    };
    return { home: byTeam(homeId), away: byTeam(awayId) };
}

function starPlayerFromRows(rows, teamId) {
    const players = rows.filter(row => Number(row?.statistics?.[0]?.team?.id) === Number(teamId));
    players.sort((a, b) => {
        const aStats = a.statistics?.[0], bStats = b.statistics?.[0];
        return Number(bStats?.goals?.total || 0) - Number(aStats?.goals?.total || 0) ||
            Number(bStats?.games?.rating || 0) - Number(aStats?.games?.rating || 0);
    });
    const player = players[0];
    if (!player) return null;
    const stats = player.statistics?.[0] || {};
    return {
        name: player.player?.name || '',
        team: stats.team?.name || '',
        goals: Number(stats.goals?.total || 0),
        assists: Number(stats.goals?.assists || 0),
        rating: stats.games?.rating || null
    };
}

/** Fetches optional football match analytics. Provider failures are isolated per section. */
export async function getFootballAnalytics(fixtureId, {
    apiFootballKey = process.env.API_FOOTBALL_KEY || process.env.API_SPORTS_KEY || process.env.FOOTBALL_API_KEY,
    request
} = {}) {
    const id = String(fixtureId || '').replace(/^fb_/, '');
    if (!/^\d+$/.test(id)) throw new Error('Invalid fixture ID');
    const cached = readCache(id);
    if (cached) return cached;
    if (!apiFootballKey || typeof request !== 'function') throw new Error('Football analytics are not configured');

    const call = async (url, params) => {
        const result = await request(url, params);
        if (result?.error) throw new Error(result.error);
        return Array.isArray(result?.data) ? result.data : [];
    };

    const errors = {};
    let fixture = null;
    try { fixture = (await call(`${API_FOOTBALL_BASE}/fixtures`, { id }))[0] || null; }
    catch { errors.fixture = 'Match data unavailable'; }
    const home = fixture?.teams?.home, away = fixture?.teams?.away;
    const league = fixture?.league;
    if (!fixture || !home?.id || !away?.id) {
        return writeCache(id, { homeTeamForm: [], awayTeamForm: [], lineups: { home: [], away: [] }, starPlayer: null, teamBadges: {}, errors: { ...errors, fixture: errors.fixture || 'Match data unavailable' } });
    }

    const season = league?.season;
    const [homeRecent, awayRecent, lineupRows, scorerRows] = await Promise.all([
        call(`${API_FOOTBALL_BASE}/fixtures`, { team: home.id, last: 5, status: 'FT' }).catch(() => { errors.homeForm = 'Recent form unavailable'; return []; }),
        call(`${API_FOOTBALL_BASE}/fixtures`, { team: away.id, last: 5, status: 'FT' }).catch(() => { errors.awayForm = 'Recent form unavailable'; return []; }),
        call(`${API_FOOTBALL_BASE}/fixtures/lineups`, { fixture: id }).catch(() => { errors.lineups = 'Lineups are not published yet'; return []; }),
        season && league?.id ? call(`${API_FOOTBALL_BASE}/players/topscorers`, { league: league.id, season }).catch(() => []) : Promise.resolve([])
    ]);
    const candidate = starPlayerFromRows(scorerRows, home.id) || starPlayerFromRows(scorerRows, away.id);
    const result = {
        homeTeamForm: formFromFixtures(homeRecent, home.id),
        awayTeamForm: formFromFixtures(awayRecent, away.id),
        lineups: normalizeLineups(lineupRows, home.id, away.id),
        starPlayer: candidate,
        teamBadges: { home: home.logo || null, away: away.logo || null },
        errors
    };
    return writeCache(id, result);
}
