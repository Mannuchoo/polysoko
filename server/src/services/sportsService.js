const API_FOOTBALL_BASE = 'https://v3.football.api-sports.io';
const cache = new Map();
const sportsDbTeamCache = new Map();
const CACHE_TTL = 15 * 60 * 1000;
const SPORTS_DB_TEAM_TTL = 6 * 60 * 60 * 1000;

function configuredSportsDbKey() {
    return [process.env.SPORTS_DB_KEY, process.env.SPORTSDB_KEY, process.env.SPORTSDB_API_KEY, process.env.SPORTS_DB_API_KEY,
        process.env.THESPORTSDB_KEY, process.env.THESPORTSDB_API_KEY, process.env.THE_SPORTS_DB_KEY, process.env.THE_SPORTS_DB_API_KEY]
        .map(value => String(value || '').trim()).find(Boolean) || '';
}

async function sportsDbTeam(teamName, apiKey) {
    if (!apiKey || !teamName) return null;
    const cacheKey = normalizeTeam(teamName);
    const cached = sportsDbTeamCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.team;
    try {
        const url = new URL(`https://www.thesportsdb.com/api/v1/json/${encodeURIComponent(apiKey)}/searchteams.php`);
        url.searchParams.set('t', teamName);
        const response = await fetch(url, { signal: AbortSignal.timeout(7000) });
        if (!response.ok) return null;
        const payload = await response.json();
        const record = payload?.teams?.[0];
        const team = record ? { name: record.strTeam || teamName, badge: record.strBadge || null, id: record.idTeam || null } : null;
        sportsDbTeamCache.set(cacheKey, { team, expiresAt: Date.now() + SPORTS_DB_TEAM_TTL });
        return team;
    } catch {
        return null;
    }
}

async function sportsDbBadges(homeName, awayName, apiKey) {
    if (!apiKey) return {};
    const [home, away] = await Promise.all([sportsDbTeam(homeName, apiKey), sportsDbTeam(awayName, apiKey)]);
    return { home: home?.badge || null, away: away?.badge || null };
}

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

const normalizeTeam = value => String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

async function getSportMonksAnalytics(match, apiKey, sportsDbKey) {
    if (!apiKey || !match?.homeTeam || !match?.awayTeam || !match?.startTime) return null;
    const get = async (path, params = {}) => {
        const query = new URLSearchParams({ api_token: apiKey, ...params });
        const response = await fetch(`https://api.sportmonks.com/v3/football/${path}?${query}`, { signal: AbortSignal.timeout(10000) });
        if (!response.ok) throw new Error(`SportMonks request failed (${response.status})`);
        const payload = await response.json();
        if (payload?.message && !payload?.data) throw new Error('SportMonks match data unavailable');
        return payload?.data;
    };
    try {
        const homeName = normalizeTeam(match.homeTeam), awayName = normalizeTeam(match.awayTeam);
        const date = new Date(match.startTime).toISOString().slice(0, 10);
        const results = await get(`fixtures/search/${encodeURIComponent(`${match.homeTeam} vs ${match.awayTeam}`)}`, {
            include: 'participants;lineups;formations', per_page: '50', order: 'desc'
        });
        const fixtures = Array.isArray(results) ? results : results ? [results] : [];
        const targetTime = new Date(match.startTime).getTime();
        const fixture = fixtures.filter(item => {
            const name = normalizeTeam(item?.name);
            const itemTime = Number(item?.starting_at_timestamp) ? Number(item.starting_at_timestamp) * 1000 : Date.parse(`${item?.starting_at || ''}Z`);
            return name.includes(homeName) && name.includes(awayName) && Number.isFinite(itemTime) && Math.abs(itemTime - targetTime) <= 36 * 60 * 60 * 1000;
        }).sort((a, b) => {
            const time = item => Number(item?.starting_at_timestamp) ? Number(item.starting_at_timestamp) * 1000 : Date.parse(`${item?.starting_at || ''}Z`);
            return Math.abs(time(a) - targetTime) - Math.abs(time(b) - targetTime);
        })[0];
        if (!fixture) return {
            homeTeamForm: [], awayTeamForm: [], lineups: { home: [], away: [] }, starPlayer: null,
            teamBadges: {}, errors: { fixture: 'Fixture not found in the configured SportsMonks subscription' }
        };
        const participants = fixture.participants || [];
        const homeParticipant = participants.find(item => normalizeTeam(item?.name) === homeName || item?.meta?.location === 'home');
        const awayParticipant = participants.find(item => normalizeTeam(item?.name) === awayName || item?.meta?.location === 'away');
        const homeId = homeParticipant?.id;
        const awayId = awayParticipant?.id;
        const players = (teamId) => (fixture.lineups || []).filter(item => Number(item?.team_id) === Number(teamId) && Number(item?.type_id) === 11)
            .sort((a, b) => Number(a.formation_position || 99) - Number(b.formation_position || 99))
            .map(item => ({ name: item.player_name || 'Player', number: item.jersey_number ?? null, position: '' }));
        const fromDate = new Date(Date.parse(`${date}T00:00:00Z`) - 45 * 86400000).toISOString().slice(0, 10);
        const toDate = date;
        const recent = async teamId => {
            if (!teamId) return [];
            try {
                const rows = await get(`fixtures/between/${fromDate}/${toDate}/${teamId}`, { include: 'participants', order: 'desc', per_page: '50' });
                return (Array.isArray(rows) ? rows : []).filter(row => row.id !== fixture.id && row.result_info).slice(0, 5).map(row => {
                    const summary = normalizeTeam(row.result_info);
                    if (summary.includes('draw')) return 'D';
                    const teamName = normalizeTeam(row.participants?.find(p => Number(p.id) === Number(teamId))?.name);
                    if (teamName && summary.includes(teamName)) return 'W';
                    if (summary.includes('won after') || summary.includes('won')) return 'L';
                    return null;
                }).filter(Boolean);
            } catch { return []; }
        };
        const [homeTeamForm, awayTeamForm] = await Promise.all([recent(homeId), recent(awayId)]);
        const badges = await sportsDbBadges(match.homeTeam, match.awayTeam, sportsDbKey);
        return {
            homeTeamForm, awayTeamForm,
            lineups: { home: players(homeId), away: players(awayId) },
            starPlayer: null,
            teamBadges: { home: badges.home || homeParticipant?.image_path || null, away: badges.away || awayParticipant?.image_path || null },
            errors: { starPlayer: 'Player statistics are unavailable from the configured provider.' }
        };
    } catch (error) {
        return {
            homeTeamForm: [], awayTeamForm: [], lineups: { home: [], away: [] }, starPlayer: null,
            teamBadges: {}, errors: { fixture: error.message || 'SportsMonks analytics unavailable' }
        };
    }
}

/** Fetches optional football match analytics. Provider failures are isolated per section. */
export async function getFootballAnalytics(fixtureId, {
    apiFootballKey = process.env.API_FOOTBALL_KEY || process.env.API_SPORTS_KEY || process.env.FOOTBALL_API_KEY,
    sportsMonksKey = process.env.SPORTS_API_KEY,
    sportsDbKey = configuredSportsDbKey(),
    match,
    request
} = {}) {
    const id = String(fixtureId || '').replace(/^fb_/, '');
    if (!/^\d+$/.test(id)) throw new Error('Invalid fixture ID');
    const cached = readCache(id);
    if (cached) return cached;
    if ((!apiFootballKey || typeof request !== 'function') && sportsMonksKey) {
        const result = await getSportMonksAnalytics(match, sportsMonksKey, sportsDbKey);
        if (result) return writeCache(id, result);
    }
    if (!apiFootballKey || typeof request !== 'function') {
        return { homeTeamForm: [], awayTeamForm: [], lineups: { home: [], away: [] }, starPlayer: null, teamBadges: {}, errors: { fixture: 'No configured football data provider is available.' } };
    }

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
        if (sportsMonksKey && match) {
            const result = await getSportMonksAnalytics(match, sportsMonksKey, sportsDbKey);
            if (result) return writeCache(id, result);
        }
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
    const dbBadges = await sportsDbBadges(home.name, away.name, sportsDbKey);
    const result = {
        homeTeamForm: formFromFixtures(homeRecent, home.id),
        awayTeamForm: formFromFixtures(awayRecent, away.id),
        lineups: normalizeLineups(lineupRows, home.id, away.id),
        starPlayer: candidate,
        teamBadges: { home: dbBadges.home || home.logo || null, away: dbBadges.away || away.logo || null },
        errors
    };
    return writeCache(id, result);
}
