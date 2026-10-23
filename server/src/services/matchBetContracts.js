const normalize = value => String(value || '').trim().toLowerCase().replace(/[^a-z0-9.+/ -]/g, '').replace(/\s+/g, ' ');

export function classifyProviderMarket(marketName) {
    const name = normalize(marketName);
    if (/match winner|full.?time result|1x2|match result/.test(name)) return 'match_result';
    if (/double chance/.test(name)) return 'double_chance';
    if (/both teams?(?: to)? score|gg ?\/ ?ng|btts/.test(name)) return 'both_teams_score';
    if (/over\/under|total goals|match goals|goals over|goal line/.test(name)) return 'total_goals';
    if (/first (team )?to score|1st (team )?to score|first goal|1st goal/.test(name)) return 'first_goal';
    return null;
}

function isHome(label, homeName) {
    const value = normalize(label);
    return ['home', 'home team', 'home 1', '1', 'team 1', normalize(homeName)].includes(value) || /^home(?: team)?(?: 1)?$/.test(value) || (homeName && value === normalize(homeName));
}
function isAway(label, awayName) {
    const value = normalize(label);
    return ['away', 'away team', 'away 2', '2', 'team 2', normalize(awayName)].includes(value) || /^away(?: team)?(?: 2)?$/.test(value) || (awayName && value === normalize(awayName));
}
function isDraw(label) { const value = normalize(label); return ['draw', 'draw x', 'x'].includes(value); }

export function providerOutcomeWins({ contractType, marketName, selection, homeName, awayName, goals, events = [] }) {
    const type = contractType || classifyProviderMarket(marketName);
    const home = Number(goals?.home), away = Number(goals?.away);
    if (!Number.isFinite(home) || !Number.isFinite(away)) return null;
    const pick = normalize(selection);
    if (type === 'match_result') return isHome(pick, homeName) ? home > away : isDraw(pick) ? home === away : isAway(pick, awayName) ? away > home : null;
    if (type === 'double_chance') {
        const hasHome = /home|\b1\b/.test(pick), hasDraw = /draw|\bx\b/.test(pick), hasAway = /away|\b2\b/.test(pick);
        if (hasHome && hasDraw) return home >= away;
        if (hasDraw && hasAway) return away >= home;
        if (hasHome && hasAway) return home !== away;
        return null;
    }
    if (type === 'both_teams_score') {
        if (/yes|gg|both teams.*yes/.test(pick)) return home > 0 && away > 0;
        if (/no|ng|both teams.*no/.test(pick)) return home === 0 || away === 0;
        return null;
    }
    if (type === 'total_goals') {
        const lineMatch = String(marketName).match(/(?:over|under|total|goals?)\D{0,12}(\d+(?:\.\d+)?)/i) || String(selection).match(/\d+(?:\.\d+)?/);
        if (!lineMatch) return null;
        const threshold = Number(lineMatch[1]);
        if (!Number.isFinite(threshold)) return null;
        const total = home + away;
        if (/over|more/.test(pick)) return total === threshold && Number.isInteger(threshold) ? 'push' : total > threshold;
        if (/under|less/.test(pick)) return total === threshold && Number.isInteger(threshold) ? 'push' : total < threshold;
        return null;
    }
    if (type === 'first_goal') {
        const firstGoal = events.filter(event => event?.type === 'Goal')
            .sort((a, b) => (Number(a.time?.elapsed || 0) * 100 + Number(a.time?.extra || 0)) - (Number(b.time?.elapsed || 0) * 100 + Number(b.time?.extra || 0)))[0];
        let side = firstGoal?.team?.name;
        if (side && /own goal/i.test(String(firstGoal.detail || ''))) side = normalize(side) === normalize(homeName) ? awayName : homeName;
        if (!side) return /no goal/.test(pick) ? home + away === 0 : null;
        return isHome(pick, homeName) ? normalize(side) === normalize(homeName) : isAway(pick, awayName) ? normalize(side) === normalize(awayName) : null;
    }
    return null;
}
