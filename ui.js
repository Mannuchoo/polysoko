const savedCategory = localStorage.getItem("last_category") || "all";
window.state = window.state || {
    allMarkets: [],
    filteredMarkets: [],
    category: savedCategory === "football" ? "sports" : savedCategory,
    sportsType: savedCategory === "football" ? "football" : (savedCategory === "sports" ? (localStorage.getItem("last_sports_type") || "") : ""),
    sportsCategories: [],
    search: "",
    loading: true,
    lastUpdate: null,
    currentHistoryTab: "active"
};

const state = window.state;

function syncMarketMap(markets) {
    window.marketMap = {};
    (markets || []).forEach((market) => {
        if (market?.id) window.marketMap[market.id] = market;
    });
}

function normalizeCategory(cat) {
    if (!cat) return "unknown";
    return cat.toString().toLowerCase().trim();
}

function getMarketDisplayCategory(market) {
    const category = normalizeCategory(market?.category);
    if (['news', 'tech', 'politics'].includes(category)) return category;

    // Older generated news rows can arrive without a usable category. Their
    // stable ID prefix still identifies which tab should display them.
    const id = String(market?.id || '');
    if (/^tech_/i.test(id)) return 'tech';
    if (/^geo_/i.test(id)) return 'politics';
    if (/^news_/i.test(id)) return 'news';
    return category;
}

function titleCase(value) {
    if (!value) return "";
    return value.toString().trim().replace(/\w\S*/g, txt => txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase());
}

function normalizeSportLabel(value) {
    const raw = String(value || '').trim();
    if (!raw) return "";
    const lower = raw.toLowerCase();
    if (lower === 'soccer') return "Football";
    if (['nba', 'nfl', 'f1', 'afl', 'mma'].includes(lower)) return lower.toUpperCase();
    return titleCase(raw.replace(/[_-]+/g, ' '));
}

function getMarketSide(market, side) {
    const lowerKey = side.toLowerCase();
    return market?.[side] ?? market?.[lowerKey] ?? '';
}

// --- THREE-WAY SPORTS MARKETS -----------------------------------------------
//
// A football fixture settles on three outcomes, so its market exposes three
// buttons: the home team, a draw, and the away team. Every other market
// keeps the binary YES/NO model. A market qualifies for the three-way model
// when it names a draw side and prices it.

const THREE_WAY_SIDE_KEYS = ['HOME', 'DRAW', 'AWAY'];

function marketSupportsDraw(market) {
    const label = String(getMarketSide(market, 'sideC') || '').trim();
    const odds = Number(getMarketSide(market, 'oddsC') || 0);
    return Boolean(label) && Number.isFinite(odds) && odds > 1;
}

function isThreeWayMarket(market) {
    return Boolean(market) && marketSupportsDraw(market);
}

// The outcomes a market exposes, in display order. Each entry carries the
// side key the server understands, the label to show and the price.
function getMarketOutcomes(market) {
    if (!isThreeWayMarket(market)) {
        return [
            { key: 'YES', label: 'Yes', odds: Number(getMarketSide(market, 'oddsA') || 1.9) },
            { key: 'NO', label: 'No', odds: Number(getMarketSide(market, 'oddsB') || 1.9) }
        ];
    }
    return [
        { key: 'HOME', label: String(getMarketSide(market, 'sideA') || 'Home').trim(), odds: Number(getMarketSide(market, 'oddsA') || 1.9) },
        { key: 'DRAW', label: String(getMarketSide(market, 'sideC') || 'Draw').trim(), odds: Number(getMarketSide(market, 'oddsC') || 1.9) },
        { key: 'AWAY', label: String(getMarketSide(market, 'sideB') || 'Away').trim(), odds: Number(getMarketSide(market, 'oddsB') || 1.9) }
    ];
}

// The colour a side is drawn in. Home is green, the draw is amber and away is
// red, so a three-way bar reads the same way as the two-way one.
function outcomeAccent(key) {
    if (key === 'DRAW') return '#ffc857';
    if (key === 'AWAY' || key === 'NO') return '#ff6b6b';
    return '#00ff88';
}

// Escapes a value for use inside an inline JS string in an HTML attribute.
function jsArg(value) {
    return String(value == null ? '' : value)
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e');
}

// The betting buttons for a market. A three-way sports market shows the two
// teams and the draw; every other market shows YES and NO. The pick sent to
// the server is the outcome key, which the server maps back to the market's
// own labels.
function renderOutcomeButtons(market, { compact = false } = {}) {
    const outcomes = getMarketOutcomes(market);
    const id = jsArg(market?.id || '');
    const title = jsArg(market?.title || market?.betQuestion || 'Market');

    const buttons = outcomes.map(outcome => {
        const accent = outcomeAccent(outcome.key);
        const label = escapeHtml(outcome.label);
        const odds = Number(outcome.odds);
        const price = Number.isFinite(odds) && odds > 0 ? ` (${odds.toFixed(2)})` : '';
        return `
        <button class="bet-btn" data-id="${escapeHtml(market?.id || '')}" data-choice="${escapeHtml(outcome.key)}" data-title="${escapeHtml(title)}"
                onclick="event.stopPropagation(); openBetModal('${id}', '${title}', '${outcome.key}')"
                style="flex:1; min-width:0; color:${accent}; border-color:${accent}33; background:${accent}14;">
            ${label}${compact ? '' : price}
        </button>`;
    }).join('');

    return `<div class="betting-row" style="display:flex; gap:8px; margin-top:15px;">${buttons}</div>`;
}

function isInvalidSportsMarket(m) {
    const cat = normalizeCategory(m?.category);
    const sportKeys = ['sports', 'football', 'nba', 'nfl', 'basketball', 'baseball', 'hockey', 'volleyball', 'rugby', 'handball', 'cricket', 'tennis', 'mma', 'afl'];
    const isSportsMarket = sportKeys.includes(cat) || m?.id?.startsWith("sp_") || m?.id?.startsWith("fb_");
    if (!isSportsMarket) return false;
    const title = String(m?.title || "").toLowerCase().trim();
    const sideA = String(getMarketSide(m, 'sideA')).toLowerCase().trim();
    const sideB = String(getMarketSide(m, 'sideB')).toLowerCase().trim();
    return !title ||
        ["home vs away", "unknown vs unknown"].includes(title) ||
        ["home", "away", "unknown", ""].includes(sideA) ||
        ["home", "away", "unknown", ""].includes(sideB);
}

function isNewsLikeMarket(m) {
    return ['news', 'tech', 'politics'].includes(getMarketDisplayCategory(m)) || isFootballNewsMarket(m);
}

function isCryptoMarket(m) {
    return normalizeCategory(m?.category) === 'crypto';
}

function isFootballFixtureMarket(m) {
    const cat = normalizeCategory(m?.category);
    if (/^fb_/i.test(m?.id || "")) return true;
    if (cat !== "sports" && cat !== "football" && cat !== "soccer") return false;
    const titleLooksLikeFixture = /\s+vs\s+/i.test(String(m?.title || ""));
    const sidesLookLikeTeams = !["yes", "no", "likely", "unlikely", "home", "away", "unknown", ""].includes(String(getMarketSide(m, 'sideA')).toLowerCase()) &&
        !["yes", "no", "likely", "unlikely", "home", "away", "unknown", ""].includes(String(getMarketSide(m, 'sideB')).toLowerCase());
    return titleLooksLikeFixture && (normalizeCategory(m?.sport) === "football" || cat === "football" || cat === "soccer" || sidesLookLikeTeams);
}

function isFootballNewsMarket(m) {
    const cat = normalizeCategory(m?.category);
    return cat === "football" && !isFootballFixtureMarket(m);
}

const REAL_SPORT_LABELS = new Set([
    'sports', 'football', 'soccer', 'nba', 'nfl', 'basketball', 'baseball', 'hockey',
    'volleyball', 'rugby', 'handball', 'cricket', 'tennis', 'mma', 'afl', 'f1', 'golf'
]);

function isElectronicGameMarket(m) {
    const text = `${m?.title || ''} ${m?.sport || ''} ${m?.league || ''} ${m?.id || ''}`.toLowerCase();
    return /\b(e-?football|ea sports fc|pes|pro evolution soccer|nba 2k\d*|madden nfl|nhl 2\d|mlb the show|valorant|league of legends|dota 2|counter[- ]?strike|cs2|rocket league|fifa\s*(?:online|esports|pro clubs|2\d|20[2-9]\d))\b/i.test(text);
}

function isRealSportMarket(m) {
    const cat = normalizeCategory(m?.category);
    const sport = normalizeCategory(m?.sport);
    const league = normalizeCategory(m?.league);
    return /^sp_/i.test(m?.id || '') || /^fb_/i.test(m?.id || '') ||
        REAL_SPORT_LABELS.has(cat) || REAL_SPORT_LABELS.has(sport) ||
        /\b(baseball|hockey|mlb|nhl|nba|nfl|basketball|cricket|rugby|tennis|volleyball|handball|formula 1|ufc|afl|pga)\b/i.test(league);
}

function isGamingMarket(m) {
    const cat = normalizeCategory(m?.category);
    const sport = normalizeCategory(m?.sport || "");
    const league = normalizeCategory(m?.league || "");
    const gamingLabels = ['esports','gaming','csgo','cs:go','cs2','counter strike','counter-strike','dota 2','dota2','valorant','league of legends','leagueoflegends','lol','rocket league'];
    if (isElectronicGameMarket(m)) return true;
    if (isRealSportMarket(m)) return false;
    return cat === 'gaming' || cat === 'esports' ||
        gamingLabels.includes(sport) ||
        league.includes('esport') || league.includes('gaming');
}

function isSportsMarket(m) {
    if (isElectronicGameMarket(m)) return false;
    const cat = normalizeCategory(m?.category);
    const sport = normalizeCategory(m?.sport);
    const sportKeys = ['sports', 'football', 'nba', 'nfl', 'basketball', 'baseball', 'hockey', 'volleyball', 'rugby', 'handball', 'cricket', 'tennis', 'mma', 'afl'];
    const isFootballNews = isFootballNewsMarket(m);
    return ((sportKeys.includes(cat) || REAL_SPORT_LABELS.has(sport)) && !isFootballNews) ||
        /^sp_/i.test(m?.id || "") || /^fb_/i.test(m?.id || "") || isFootballFixtureMarket(m);
}

window.setCategory = function (category) {
    if (!window.state) {
        console.warn("state not ready yet");
        return;
    }

    const requested = normalizeCategory(category || "all");
    const active = requested === "football" ? "sports" : requested;
    window.state.category = active;
    window.state.sportsType = requested === "football" ? "football" : "";
    localStorage.removeItem("last_sports_type");
    localStorage.setItem("last_category", active);
    if (requested === "football") localStorage.setItem("last_sports_type", "football");
    document.querySelectorAll('.category-filter-row .pill').forEach(pill => {
        pill.classList.remove('active');
        const pillCat = normalizeCategory(pill.dataset.cat || pill.innerText);
        if (pillCat === active) {
            pill.classList.add('active');
        }
    });

    applyStateAndRender();
};

window.setSportsType = function (sport) {
    window.state.category = "sports";
    window.state.sportsType = normalizeCategory(sport || "");
    localStorage.setItem("last_category", "sports");
    if (window.state.sportsType) {
        localStorage.setItem("last_sports_type", window.state.sportsType);
    } else {
        localStorage.removeItem("last_sports_type");
    }
    document.querySelectorAll('.category-filter-row .pill').forEach(pill => {
        const pillCat = normalizeCategory(pill.dataset.cat || pill.innerText);
        pill.classList.toggle('active', pillCat === "sports");
    });
    applyStateAndRender();
};

function applyStateAndRender() {
    let filtered = (state.allMarkets || []).filter(m => !isInvalidSportsMarket(m));
    const active = state.category || "all";
    
    if (active === "all") {
        // "all" intentionally includes sports — see Sports pill for clickable subcategories
    } else {
        filtered = filtered.filter(m => {
            const cat = getMarketDisplayCategory(m);
            if (active === "football") {
                return isFootballFixtureMarket(m) || isFootballNewsMarket(m);
            }
            if (active === "gaming") {
                return isGamingMarket(m);
            }
            if (active === "sports") {
                return isSportsMarket(m);
            }
            if (active === "news") {
                return cat === "news";
            }
            return cat === active;
        });
    }
    
    if (state.search) {
        filtered = filtered.filter(m => 
            (m.title || "").toLowerCase().includes(state.search) ||
            (m.description || "").toLowerCase().includes(state.search)
        );
    }

    state.filteredMarkets = filtered;
    if (document.getElementById("marketsList") || document.getElementById("ongoing")) {
        renderFilteredMarkets();
        renderTrending(); // Now independent of filtered data
    }
}

window.applyStateAndRender = applyStateAndRender;

function renderApp() {
    renderFilteredMarkets();
    renderTrending();
    if (document.getElementById("greetingText")) {
        loadGreeting();
    }
    // The balance display is now handled by renderBalanceDisplay in app.js
    // which uses renderBalanceCard.
}

// New function to render the "floating and sexy" balance card
function renderBalanceCard(balance) {
    const formattedBalance = Number(balance).toFixed(2);
    return `
            <div class="balance-copy">
                <div class="balance-label">Your Balance</div>
                <div class="balance-value">
                    ${formattedBalance} <span class="balance-unit">sKES</span>
                </div>
            </div>
            <div class="balance-actions">
                <button class="balance-action-btn" onclick="window.closeWalletModal?.(); window.triggerDeposit()">Deposit</button>
                <button class="balance-action-btn" onclick="window.closeWalletModal?.(); window.toggleWithdrawModal()">Withdraw</button>
            </div>
    `;
}
/**
 * TRENDING
 */
function renderTrending() {
    const container = document.getElementById('ongoing');
    if (!container) return;

    // Keep CHECK OUT populated across category changes with current news markets
    // and European football fixtures. News cards use the same market card links
    // and bet modal as the main list.
    const source = (state.allMarkets || []).filter(m => {
        const cat = getMarketDisplayCategory(m);
        if (isGamingMarket(m)) return false;
        if (isNewsLikeMarket(m)) return true;
        if (isSportsMarket(m) && !isFootballFixtureMarket(m)) return false;
        
        // European Football logic: Check league/country meta for European identifiers
        if (cat === 'football' || m.id?.startsWith('fb_')) {
            const text = `${m.league || ''} ${m.country || ''}`.toLowerCase();
            const euroKeywords = [
                'england', 'spain', 'germany', 'italy', 'france', 'portugal', 'netherlands', 'belgium', 'europe',
                'premier league', 'la liga', 'bundesliga', 'serie a', 'ligue 1', 'champions league', 'europa league', 'euro',
                'gb', 'es', 'de', 'it', 'fr', 'pt', 'nl', 'be'
            ];
            return euroKeywords.some(key => text.includes(key));
        }
        return false;
    });
    
    const top = source
        .filter(m => m?.id)
        .sort((a, b) => {
            // Rank live, high volume, and current tech/news markets first.
            const score = (m) => {
                const vol = marketTotalVolume(m);
                const maxOdds = Math.max(Number(m.oddsA || 0), Number(m.oddsB || 0));
                const category = getMarketDisplayCategory(m);
                const isTopical = ['news', 'politics', 'tech'].includes(category) ? 30000 : 0;
                const isLive = m.status === 'live' ? 100000 : 0;
                const publishedAt = Date.parse(m.timestamp || m.publishedAt || m.event_start_time || '');
                const ageHours = Number.isFinite(publishedAt) ? Math.max(0, (Date.now() - publishedAt) / 3600000) : 24;
                const recency = ['news', 'politics', 'tech'].includes(category) ? Math.max(0, 24 - ageHours) * 300 : 0;
                
                return isLive + isTopical + recency + vol + (maxOdds * 500);
            };
            return score(b) - score(a);
        }); // Removed .slice() to make it "endless"

    container.innerHTML = top.map(m => {
        return `
        <div class="ongoing-card" data-id="${m.id}" onclick="openTrendingMarket('${m.id}')">
            <div class="category-tag">🔥 HOT</div>
            <div class="ongoing-title">${escapeHtml(m.title || m.betQuestion || 'Market')}</div>

            ${renderOutcomeButtons(m, { compact: true })}
        </div>
    `}).join('');
}

function openTrendingMarket(id) {
    const market = window.marketMap?.[id];
    if (!market) return;

    const marketCategory = getMarketDisplayCategory(market);
    const category = isSportsMarket(market) ? 'sports' : isGamingMarket(market) ? 'gaming' : marketCategory;
    if (category && category !== 'unknown') setCategory(category);

    openMarket(id);
}

/**
 * MARKET LIST
 */
function renderFilteredMarkets() {
    const mainGrid = document.getElementById("marketsList");
    if (!mainGrid) return;

    const allMarkets = (state.filteredMarkets || []).filter(m => !isInvalidSportsMarket(m));

    if (state.category === "sports") {
        renderSportsPage(mainGrid, allMarkets);
        return;
    }

    // 1. Split into groups. Crypto markets are pulled out of the generic
    // "upcoming" bucket so coins like BNB are not buried under hundreds of
    // sports fixtures (they all share country "Global", which sorted them into
    // an arbitrary spot far down the list).
    const live = allMarkets.filter(m => m.status === 'live');
    const crypto = allMarkets.filter(m => m.status !== 'live' && isCryptoMarket(m));
    const movies = allMarkets.filter(m => m.status !== 'live' && normalizeCategory(m.category) === 'movies');
    const news = allMarkets.filter(m => isNewsLikeMarket(m));
    const upcoming = allMarkets.filter(m => m.status !== 'live' && !isNewsLikeMarket(m) && !isCryptoMarket(m) && normalizeCategory(m.category) !== 'movies')
        .sort((a, b) => (a.country || "Z").localeCompare(b.country || "Z"));

    let html = "";

    // Add Back Button if a specific category is active
    if (state.category !== "all") {
        html += `<button class="pill" onclick="window.setCategory('all')" style="margin-bottom:15px; background:#333; color:white; border:none; padding:8px 15px; border-radius:20px; cursor:pointer;">← Back to All Markets</button>`;
    }

    // 2. Render Live Football Section
    if (live.length > 0) {
        html += `<div class="main-category-label" style="color: #ff4d4d; font-weight: 800; padding: 10px 0;">🔴 LIVE NOW</div>`;
        live.forEach(m => html += createMarketCard(m));
    }

    // 2b. Render Crypto Section (surfaced early so BNB & co. are easy to find)
    if (crypto.length > 0) {
        html += `<div class="main-category-label" style="color:#f0b90b; font-weight:800; padding:20px 0 10px 0;">🪙 CRYPTO PRICES</div>`;
        crypto
            .slice()
            .sort((a, b) => String(a.title || "").localeCompare(String(b.title || "")))
            .forEach(m => html += createMarketCard(m));
    }

    if (movies.length > 0) {
        html += `<div class="main-category-label" style="color:#b8a3ff;font-weight:800;padding:20px 0 10px 0;">🎬 MOVIES &amp; FILMS</div>`;
        movies.forEach(m => html += createMarketCard(m));
    }

    // 3. Render News Feed (compact cards only; expanded feed loads on demand)
    if (news.length > 0) {
        const newsHeading = ['news', 'tech', 'politics'].includes(state.category)
            ? `${state.category.toUpperCase()} HEADLINES`
            : 'LATEST NEWS';
        html += `<div class="main-category-label" style="color: #00ff88; font-weight: 800; padding: 20px 0 10px 0;">📰 ${newsHeading}</div>`;
        news.forEach(m => html += createMarketCard(m));
        // Collapsible news feed (hidden by default to avoid showing extra content)
        html += `
            <div id="newsFeedContainer" style="margin-top:12px; display:none;">
                ${renderNewsFeed(news)}
            </div>
            <div style="margin-top:10px;">
                <button id="toggleNewsFeedBtn" class="pill" onclick="(function(){
                    const c = document.getElementById('newsFeedContainer');
                    const b = document.getElementById('toggleNewsFeedBtn');
                    if (!c) return;
                    if (c.style.display === 'none') { c.style.display = 'block'; b.innerText = 'Hide News Feed'; }
                    else { c.style.display = 'none'; b.innerText = 'Show News Feed'; }
                })()">Show News Feed</button>
            </div>
        `;
    }

    // 4. Render Upcoming Football Section
    if (upcoming.length > 0) {
        html += `<div class="main-category-label" style="color: #aaa; font-weight: 800; padding: 20px 0 10px 0;">📅 UPCOMING MATCHES</div>`;
        let lastCountry = "";
        upcoming.forEach(m => {
            const country = m.country || "GLOBAL";
            if (country !== lastCountry) {
                html += `<div class="section-label" style="font-size:0.7rem; color:#666; margin-top:10px;">— ${country.toUpperCase()} —</div>`;
                lastCountry = country;
            }
            html += createMarketCard(m);
        });
    }

    if (!allMarkets.length && ['news', 'politics', 'tech', 'movies'].includes(state.category)) {
        const emptyLabel = state.category === 'movies' ? 'movies and films' : `${escapeHtml(state.category)} headlines`;
        html += `<div class="empty-state" style="padding:24px;">No ${emptyLabel} are available right now.</div>`;
    }
    mainGrid.innerHTML = html || `<div style="padding:20px;">No markets found. Searching for elite aura...</div>`;
}

function renderSportsPage(container, sportsMarkets) {
    const sportsCatalog = ["Football", "NBA", "NFL", "Basketball", "Baseball", "Hockey", "Volleyball", "Rugby", "Handball", "Tennis", "MMA", "F1", "Cricket", "Golf", "AFL"];
    const source = (sportsMarkets || [])
        .filter(m => isSportsMarket(m))
        .filter(m => !isInvalidSportsMarket(m));
    const selected = normalizeCategory(state.sportsType || "");
    
    // Determine sport type from: m.sport field, league hints, or category
    const sportLabelFor = (m) => {
        const sportValue = normalizeSportLabel(m.sport || '');
        if (sportValue && normalizeCategory(sportValue) !== 'other') return sportValue;
        const cat = normalizeCategory(m.category);
        const idSport = String(m.id || '').match(/^sp_([a-z0-9-]+)_/i)?.[1];
        if (cat === "football" || cat === 'soccer' || m.id?.startsWith("fb_")) return "Football";
        if (idSport) return normalizeSportLabel(idSport);
        if (["nba", "nfl", "basketball", "baseball", "hockey", "volleyball", "rugby", "handball", "cricket", "tennis", "mma", "afl", "f1", "golf"].includes(cat)) return normalizeSportLabel(cat);
        // Fallback: detect football fixtures by "Team A vs Team B" title pattern
        if ((cat === "sports" || cat === "football") && isFootballFixtureMarket(m)) return "Football";
        const league = (m.league || "").toLowerCase();
        if (league.includes("nba") || league.includes("basketball")) return "Basketball";
        if (league.includes("nfl") || league.includes("american football")) return "NFL";
        if (league.includes("nhl") || league.includes("hockey")) return "Hockey";
        if (league.includes("mlb") || league.includes("baseball")) return "Baseball";
        if (league.includes("tennis") || league.includes("atp") || league.includes("wta")) return "Tennis";
        if (league.includes("f1") || league.includes("formula")) return "F1";
        if (league.includes("mma") || league.includes("ufc")) return "MMA";
        if (league.includes("cricket") || league.includes("ipl")) return "Cricket";
        if (league.includes("rugby")) return "Rugby";
        if (league.includes("volleyball")) return "Volleyball";
        if (league.includes("handball")) return "Handball";
        if (league.includes("afl")) return "AFL";
        return "Other";
    };
    
    const apiSports = Array.isArray(state.sportsCategories) ? state.sportsCategories : [];
    const apiSportNames = apiSports
        .map(item => normalizeSportLabel(item?.sport))
        .filter(Boolean);
    const apiSportCounts = new Map(apiSports.map(item => [normalizeCategory(item?.sport), Number(item?.count || 0)]));
    const sportNames = [...new Set([...apiSportNames, ...source.map(sportLabelFor)])]
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b));
    const countForSport = (name) => {
        const normalized = normalizeCategory(name);
        const sourceCount = source.filter(m => normalizeCategory(sportLabelFor(m)) === normalized).length;
        const apiCount = apiSportCounts.get(normalized) || 0;
        return Math.max(sourceCount, apiCount);
    };
    const orderedSports = [...new Set([...sportsCatalog, ...sportNames])];
    
    const renderSportsCategoryGrid = () => `
        <div class="main-category-label" style="color:#00ff88;font-weight:800;padding:10px 0;">ALL SPORTS</div>
        <div class="sports-category-grid">
            ${orderedSports.map(name => {
                const normalized = normalizeCategory(name);
                const count = countForSport(name);
                const isActive = selected === normalized;
                return `
                    <button class="sports-category-card${isActive ? ' active' : ''}" onclick="window.setSportsType('${escapeHtml(normalized)}')">
                        <span>${escapeHtml(name)}</span>
                        <small>${count ? `${count} match${count !== 1 ? 'es' : ''}` : '0 matches'}</small>
                    </button>
                `;
            }).join('')}
        </div>
    `;

    let html = `
        <div class="sports-page">
            <div class="sports-page-header">
                <button class="pill" onclick="window.setCategory('all')" style="background:#333;color:white;border:none;">← Back to All Markets</button>
                ${selected ? `<button class="pill active" onclick="window.setSportsType('')">All Sports</button>` : ''}
            </div>
    `;

    if (!selected) {
        html += `
            ${renderSportsCategoryGrid()}
            ${source.length ? `<div style="padding:16px; color:#888; font-size:0.8rem;">${source.length} total matches across ${orderedSports.length} sports</div>` : `<div class="empty-state" style="padding:24px;">No sports markets available yet.</div>`}
        </div>`;
        container.innerHTML = html;
        return;
    }

    const label = orderedSports.find(name => normalizeCategory(name) === selected) || selected;
    const matches = source
        .filter(m => normalizeCategory(sportLabelFor(m)) === selected)
        .sort((a, b) => `${a.league || ""} ${a.title || ""}`.localeCompare(`${b.league || ""} ${b.title || ""}`));

    html += `
        ${renderSportsCategoryGrid()}
        <div class="main-category-label" style="color:#00ff88;font-weight:800;padding:18px 0 10px 0;">${escapeHtml(label).toUpperCase()} MATCHES</div>
    `;

    let lastLeague = "";
    if (!matches.length) {
        html += `<div class="empty-state" style="padding:24px;">${escapeHtml(label)} matches will appear here once synced.</div>`;
    }
    matches.forEach(m => {
        const league = m.league || "General";
        if (league !== lastLeague) {
            html += `<div class="section-label" style="font-size:0.7rem;color:#777;margin-top:12px;">${escapeHtml(league.toUpperCase())}</div>`;
            lastLeague = league;
        }
        html += createMarketCard(m);
    });

container.innerHTML = `${html}</div>`;
}

// Derive a short coin label (e.g. "BNB") for crypto cards. Market ids look like
// "crypto_<coingecko-id>_<date>", e.g. "crypto_binancecoin_2026-10-05".
const COIN_LABELS = {
    binancecoin: 'BNB', bitcoin: 'BTC', ethereum: 'ETH', solana: 'SOL', ripple: 'XRP',
    cardano: 'ADA', dogecoin: 'DOGE', tron: 'TRX', polkadot: 'DOT', chainlink: 'LINK',
    avalanche: 'AVAX', litecoin: 'LTC', uniswap: 'UNI', stellar: 'XLM',
    'bitcoin-cash': 'BCH', 'internet-computer': 'ICP', filecoin: 'FIL',
    hedera: 'HBAR', aptos: 'APT', near: 'NEAR', arbitrum: 'ARB', optimism: 'OP',
    cosmos: 'ATOM', vechain: 'VET', algorand: 'ALGO',
    'polygon-ecosystem-token': 'POL', 'injective-protocol': 'INJ'
};

function coinLabelFor(m) {
    const match = String(m?.id || '').match(/^crypto_([a-z0-9-]+?)_\d{4}-\d{2}-\d{2}$/i);
    if (!match) return m?.symbol || m?.coin || '';
    const key = match[1].toLowerCase();
    return COIN_LABELS[key] || String(key).replace(/-/g, ' ').toUpperCase();
}

function createMarketCard(m) {
    const isFootball = isFootballFixtureMarket(m);
    const isSports = isSportsMarket(m);
    const isNews = isNewsLikeMarket(m);
    const isCrypto = isCryptoMarket(m);
    const isMovies = normalizeCategory(m.category) === 'movies';
    const sourceHeadline = isNews ? String(m.displayHeadline || m.rawHeadline || '').trim() : '';
    const titleFallback = m.sideA && m.sideB ? `${m.sideA} vs ${m.sideB}` : "";
    const rawDisplayTitle = isNews ? (m.betQuestion || m.title) : (m.title || titleFallback);
    const safeTitle = (rawDisplayTitle || "").replace(/'/g, "\\'");
    const displayTitle = escapeHtml(rawDisplayTitle) || 'Market';

    // Determine badge and color — show actual location/league info
    let badgeText;
    if (isSports) {
        const parts = [m.country, m.league || m.sport].filter(Boolean);
        badgeText = (parts.length ? parts.join(' — ') : 'Sports').toUpperCase();
    } else if (isNews) {
        badgeText = (m.source || m.country || 'NEWS').toUpperCase();
    } else if (isCrypto) {
        // Crypto markets carry no league/source, so label them with the coin
        // itself (e.g. "BNB") instead of a meaningless "GLOBAL" tag.
        badgeText = (coinLabelFor(m) || 'CRYPTO').toUpperCase();
    } else if (isMovies) {
        badgeText = 'MOVIES & FILMS';
    } else {
        badgeText = (m.league || m.source || "GLOBAL").toUpperCase();
    }
    let badgeColor = isNews ? "#00ff88" : (isSports ? "#00d1ff" : (isCrypto ? "#f0b90b" : (isMovies ? "#b8a3ff" : "#888")));
    const boostBadge = Number(m.is_boosted) === 1 ? `<span style="background: rgba(255, 214, 0, 0.12); color:#ffd60a; border:1px solid rgba(255,214,0,0.2); padding:4px 10px; border-radius:999px; font-size:0.68rem; font-weight:700;">BOOSTED +10%</span>` : '';

    // For news items we show a compact card; full content only in modal
    const textSnippet = escapeHtml((m.description || m.content || '').slice(0, 120));
    const mediaPreview = '';
    const miniProbBar = isNews ? renderMiniProbBar(m) : '';
    const sparkline = isNews ? renderNewsSparkline(m.id) : '';
    // Crypto cards get their coin icon so assets like BNB are instantly recognisable.
    const cryptoLogo = (isCrypto && m.media_url)
        ? `<img src="${escapeHtml(m.media_url)}" alt="" loading="lazy" referrerpolicy="no-referrer"
                 style="width:16px; height:16px; border-radius:50%; object-fit:cover; flex:0 0 auto;"
                 onerror="this.style.display='none';" />`
        : '';

    const sportsAnalytics = isFootball ? `
        <section class="sports-analytics" data-fixture="${escapeHtml(m.id)}" style="margin:10px 0 4px; padding:10px; border:1px solid #25313b; border-radius:10px; background:#0c1218;" onclick="event.stopPropagation();">
            <div style="display:flex;justify-content:space-between;gap:8px;align-items:center;flex-wrap:wrap;">
                <span style="font-size:.72rem;color:#aab6c2;">MATCH RESULT · ${escapeHtml(m.sideA || '')} vs ${escapeHtml(m.sideB || '')}${m.startTime ? ` · ${escapeHtml(new Date(m.startTime).toISOString())}` : ''}</span>
                <button type="button" class="sports-analytics-toggle" data-fixture="${escapeHtml(m.id)}" onclick="window.toggleSportsAnalytics(event, this)" style="border:1px solid #00d1ff66;background:#00d1ff12;color:#8ceaff;border-radius:7px;padding:5px 8px;font-size:.7rem;cursor:pointer;">View form & lineups</button>
            </div>
            <div class="sports-analytics-content" hidden style="padding-top:9px;font-size:.78rem;color:#d5dce3;"></div>
        </section>` : '';

    return `
<div class="market-card ${isNews ? 'news-style' : ''}" 
     data-id="${m.id}" 
     onclick="openMarket('${m.id}')"
     style="border-left: 3px solid ${isNews ? '#00ff88' : 'transparent'};">
     
    <div class="market-card-toprow">
        <span class="league-tag" style="color:${badgeColor}; border-color:${badgeColor}; font-size:0.6rem; display:inline-flex; align-items:center; gap:6px; min-width:0;">
            ${cryptoLogo}
            <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${badgeText}</span>
        </span>
        <div style="display:flex; align-items:center; gap:10px; flex:0 0 auto;">
            ${boostBadge}
            <span class="live-dot" style="font-size:0.65rem; white-space:nowrap; color: ${m.status === 'live' ? '#ff4d4d' : '#555'}">
                ● ${m.status === "live" ? "LIVE" : isNews ? "NEWS" : isCrypto ? "OPEN" : "UPCOMING"}
            </span>
        </div>
    </div>

    ${isFootball || isSports 
        ? `
        <div style="display:flex; align-items:center; gap:12px; margin:10px 0;">
            <div class="team-abbr">${(m.title.split(" vs ")[0] || "??").substring(0,3).toUpperCase()}</div>
            <div style="flex:1; font-weight:700; font-size:0.95rem; color:white;">${displayTitle}</div>
        </div>
        `
        : `
        <div style="margin:10px 0;">
            <h3 style="font-size:0.95rem; color:white; line-height:1.3;">${displayTitle}</h3>
            ${isNews ? `<div style="color:#9ca3af; font-size:0.78rem; margin-top:6px; line-height:1.35;"><span style="color:#7c8796; font-size:0.65rem; text-transform:uppercase; letter-spacing:.04em;">Source headline</span><br>${sourceHeadline ? escapeHtml(sourceHeadline) : 'Open for story context'}</div>` : ''}
        </div>
        `
    }

    ${sportsAnalytics}

    <div style="display:flex; align-items:center; gap:12px; margin-top:8px;">
        ${miniProbBar}
        ${sparkline || ''}
    </div>

    ${renderOutcomeButtons(m)}
    ${renderPolymarketBar(m)}
</div>
`;
}

window.toggleSportsAnalytics = async function(event, button) {
    event?.stopPropagation();
    const panel = button?.closest('.sports-analytics');
    const content = panel?.querySelector('.sports-analytics-content');
    if (!panel || !content) return;
    if (!content.hidden) {
        content.hidden = true;
        button.textContent = 'View form & lineups';
        return;
    }
    content.hidden = false;
    button.textContent = 'Loading analytics…';
    if (content.dataset.loaded === '1') {
        button.textContent = 'Hide analytics';
        return;
    }
    content.innerHTML = '<span style="color:#82909d;">Loading recent form and available lineups…</span>';
    try {
        const response = await fetch(window.apiUrl(`/api/football/analytics/${encodeURIComponent(button.dataset.fixture || '')}`));
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Analytics unavailable');
        const formRow = (label, values) => `<div style="display:flex;align-items:center;gap:5px;margin:6px 0;"><strong style="width:62px;color:#aab6c2;">${label}</strong>${(values || []).length ? values.map(value => {
            const color = value === 'W' ? '#16a34a' : value === 'D' ? '#d49b22' : '#dc3d4b';
            return `<span title="${value === 'W' ? 'Win' : value === 'D' ? 'Draw' : 'Loss'}" style="display:inline-grid;place-items:center;width:22px;height:22px;border-radius:5px;background:${color};color:white;font-weight:800;">${value}</span>`;
        }).join('') : '<span style="color:#78838e;">Form unavailable</span>'}</div>`;
        const lineup = (label, players) => `<div style="min-width:180px;flex:1;"><strong style="display:block;color:#aab6c2;margin:6px 0;">${label}</strong>${players?.length ? `<ol style="margin:0;padding-left:20px;">${players.map(player => `<li>${escapeHtml(player.name)}${player.position ? ` <small style="color:#77838e;">${escapeHtml(player.position)}</small>` : ''}</li>`).join('')}</ol>` : '<span style="color:#78838e;">Starting XI has not been published.</span>'}</div>`;
        const star = data.starPlayer ? `<div style="margin-top:9px;padding:7px 9px;border-radius:7px;background:#f5c84218;color:#f5d976;">⭐ Player to watch: <strong>${escapeHtml(data.starPlayer.name)}</strong>${data.starPlayer.team ? ` · ${escapeHtml(data.starPlayer.team)}` : ''}${data.starPlayer.goals || data.starPlayer.assists ? ` · ${Number(data.starPlayer.goals || 0)} goals, ${Number(data.starPlayer.assists || 0)} assists` : ''}</div>` : '';
        const badge = (url, label) => url ? `<img src="${escapeHtml(url)}" alt="${label} badge" loading="lazy" referrerpolicy="no-referrer" style="width:22px;height:22px;object-fit:contain;vertical-align:middle;margin-right:5px;" onerror="this.remove();">` : '';
        const badges = `<div style="display:flex;gap:12px;align-items:center;margin-bottom:6px;">${badge(data.teamBadges?.home, 'Home')}${badge(data.teamBadges?.away, 'Away')}</div>`;
        content.innerHTML = `${badges}${formRow('Home', data.homeTeamForm)}${formRow('Away', data.awayTeamForm)}${star}<details style="margin-top:9px;"><summary style="cursor:pointer;color:#8ceaff;">View lineups</summary><div style="display:flex;gap:14px;flex-wrap:wrap;padding-top:7px;">${lineup('Home starting 11', data.lineups?.home)}${lineup('Away starting 11', data.lineups?.away)}</div></details>`;
        content.dataset.loaded = '1';
        button.textContent = 'Hide analytics';
    } catch (error) {
        content.innerHTML = `<span style="color:#e5a2a2;">${escapeHtml(error.message || 'Match analytics are temporarily unavailable.')}</span>`;
        button.textContent = 'Retry analytics';
    }
};

// The implied probability of every outcome on a market, as whole percents
// that add up to 100. A three-way market reports home/draw/away; a binary
// one reports yes/no.
function getMarketImpliedProbabilities(market) {
    const outcomes = getMarketOutcomes(market);

    let total = 0;
    const values = outcomes.map(outcome => {
        const odds = Number(outcome.odds);
        const value = Number.isFinite(odds) && odds > 0 ? 1 / odds : 0;
        total += value;
        return { ...outcome, value };
    });
    if (!(total > 0)) {
        const even = Math.floor(100 / values.length);
        return Object.fromEntries(values.map(v => [v.key, even]));
    }

    // Round each outcome, then hand the rounding difference to the largest
    // one so the bars always add up to exactly 100.
    const probabilities = {};
    let assigned = 0;
    let leader = values[0];
    for (const outcome of values) {
        const percent = Math.max(2, Math.min(96, Math.round((outcome.value / total) * 100)));
        probabilities[outcome.key] = percent;
        assigned += percent;
        if (outcome.value > leader.value) leader = outcome;
    }
    probabilities[leader.key] += 100 - assigned;

    return probabilities;
}

// A horizontal bar split across the market's outcomes.
function renderOutcomeBar(market, { height = 10, radius = '999px' } = {}) {
    const outcomes = getMarketOutcomes(market);
    const probabilities = getMarketImpliedProbabilities(market);

    const segments = outcomes.map(outcome => {
        const percent = Math.max(0, Number(probabilities[outcome.key] || 0));
        const accent = outcomeAccent(outcome.key);
        return `<div style="width:${percent}%; background: ${accent};"></div>`;
    }).join('');

    const legend = outcomes.map(outcome => {
        const percent = Math.max(0, Number(probabilities[outcome.key] || 0));
        return `<span style="color:${outcomeAccent(outcome.key)};">${escapeHtml(outcome.label)} ${percent}%</span>`;
    }).join('');

    return `
        <div style="display:flex; justify-content:space-between; gap:8px; font-size:0.72rem; color:#bbb; margin-bottom:6px; flex-wrap:wrap;">
            ${legend}
        </div>
        <div style="height:${height}px; border-radius:${radius}; overflow:hidden; background:#111; display:flex;">
            ${segments}
        </div>
    `;
}

function marketTotalVolume(market) {
    return Number(
        (market?.home_volume || 0) +
        (market?.draw_volume || 0) +
        (market?.away_volume || 0) ||
        market?.volume || market?.total_volume || 0
    );
}

function renderPolymarketBar(market) {
    const volume = marketTotalVolume(market);

    return `
        <div style="margin-top: 14px;">
            ${renderOutcomeBar(market)}
            ${volume ? `<div style="font-size:0.7rem; color:#777; margin-top:8px;">Volume: sKES ${volume.toFixed(0)}</div>` : ''}
        </div>
    `;
}

function renderOrderBookShell(market) {
    return `
        <div class="order-book-panel" style="margin: 18px 0; padding: 14px; border: 1px solid #1f2937; border-radius: 10px; background: #0d1117;">
            <div style="display:flex; justify-content:space-between; align-items:center; gap:12px; margin-bottom:12px;">
                <h4 style="margin:0; color:#e5e7eb; font-size:0.85rem; text-transform:uppercase; letter-spacing:0.5px;">Order Book</h4>
                <span style="color:#71767b; font-size:0.72rem;">Live active orders</span>
            </div>
            <div id="order-book-${escapeHtml(market.id)}" style="color:#71767b; font-size:0.82rem;">
                Loading order book...
            </div>
        </div>
    `;
}

function renderOrderBookSide(label, side, accent) {
    const levels = Array.isArray(side?.levels) ? side.levels : [];
    const totalVolume = Number(side?.volume || 0);
    const maxVolume = Math.max(...levels.map(level => Number(level.volume || 0)), 1);

    return `
        <div style="min-width:0;">
            <div style="display:flex; justify-content:space-between; gap:10px; margin-bottom:8px; color:${accent}; font-weight:800; font-size:0.78rem;">
                <span>${label}</span>
                <span>sKES ${totalVolume.toFixed(2)}</span>
            </div>
            ${levels.length ? levels.slice(0, 8).map(level => {
                const width = Math.max(8, Math.round((Number(level.volume || 0) / maxVolume) * 100));
                return `
                    <div style="position:relative; overflow:hidden; border-radius:6px; background:#111827; margin-bottom:6px;">
                        <div style="position:absolute; inset:0 auto 0 0; width:${width}%; background:${accent}; opacity:0.12;"></div>
                        <div style="position:relative; display:grid; grid-template-columns: 1fr 1fr 1fr; gap:6px; padding:7px 8px; font-size:0.76rem; color:#d1d5db;">
                            <span>@${Number(level.odds || 0).toFixed(2)}</span>
                            <span style="text-align:center;">${Number(level.orders || 0)} orders</span>
                            <span style="text-align:right;">${Number(level.volume || 0).toFixed(2)}</span>
                        </div>
                    </div>
                `;
            }).join('') : `<div style="color:#4b5563; font-size:0.78rem; padding:8px 0;">No active ${label} orders yet.</div>`}
        </div>
    `;
}


async function loadOrderBook(marketId) {
    const container = document.getElementById(`order-book-${marketId}`);
    if (!container || typeof apiFetch !== 'function') return;

    try {
        const data = await apiFetch(`markets/${marketId}/order-book`);
        if (!data?.success) throw new Error(data?.message || "Order book unavailable");

        // A three-way sports market reports home/draw/away buckets; every
        // other market keeps the legacy yes/no buckets.
        const isThreeWay = Boolean(data.market?.sideC) && Array.isArray(data.orderBook?.home);
        const sides = isThreeWay
            ? [
                { label: data.market?.sideA || 'Home', key: 'home', accent: '#00ff88' },
                { label: data.market?.sideC || 'Draw', key: 'draw', accent: '#ffc857' },
                { label: data.market?.sideB || 'Away', key: 'away', accent: '#ff6b6b' }
            ]
            : [
                { label: data.market?.sideA || 'YES', key: 'yes', accent: '#00ff88' },
                { label: data.market?.sideB || 'NO', key: 'no', accent: '#ff6b6b' }
            ];

        const totalVolume = sides.reduce((sum, side) => sum + Number(data.orderBook?.[side.key]?.volume || 0), 0);

        container.innerHTML = `
            <div style="display:grid; grid-template-columns: repeat(${sides.length}, minmax(0, 1fr)); gap:12px;">
                ${sides.map(side => renderOrderBookSide(escapeHtml(side.label), data.orderBook?.[side.key], side.accent)).join('')}
            </div>
            <div style="display:flex; justify-content:space-between; gap:10px; margin-top:10px; padding-top:10px; border-top:1px solid #1f2937; color:#9ca3af; font-size:0.76rem;">
                <span>Total active depth</span>
                <span>sKES ${totalVolume.toFixed(2)}</span>
            </div>
        `;
    } catch (err) {
        container.innerHTML = `<div style="color:#71767b;">Order book unavailable right now.</div>`;
        throw err;
    }
}

function renderProbabilityChart(market) {
    const volume = marketTotalVolume(market);
    const outcomes = getMarketOutcomes(market);
    const probabilities = getMarketImpliedProbabilities(market);
    // "Confidence" reads the favourite's share of the market.
    const leader = outcomes.reduce((best, outcome) => {
        const percent = Number(probabilities[outcome.key] || 0);
        return percent > best.percent ? { percent, outcome } : best;
    }, { percent: 0, outcome: null });

    return `
        <div style="margin: 18px 0 8px; padding: 14px; border: 1px solid #222; border-radius: 12px; background: rgba(255,255,255,0.02);">
            ${renderOutcomeBar(market)}
            <div style="display:flex; justify-content:space-between; margin-top:10px; font-size:0.72rem; color:#777;">
                <span>Volume: sKES ${volume.toFixed(0)}</span>
                <span>Confidence: ${Math.max(1, leader.percent)}%</span>
            </div>
        </div>
    `;
}

function renderMiniProbBar(market) {
    const outcomes = getMarketOutcomes(market);
    const probabilities = getMarketImpliedProbabilities(market);
    const legend = outcomes.map(outcome => `${outcome.label} ${Number(probabilities[outcome.key] || 0)}%`).join(' • ');

    return `
        <div style="margin-top:8px;">
            <div style="height:8px; border-radius:999px; overflow:hidden; background:#0b0c10; display:flex; width:120px;">
                ${outcomes.map(outcome => `<div style="width:${Math.max(0, Number(probabilities[outcome.key] || 0))}%; background: ${outcomeAccent(outcome.key)};"></div>`).join('')}
            </div>
            <div style="font-size:0.7rem; color:#777; margin-top:6px;">${escapeHtml(legend)}</div>
        </div>
    `;
}

function renderNewsSparkline(id) {
    // deterministic pseudo-random generator from id
    let h = 0;
    for (let i = 0; i < id.length; i++) h = ((h << 5) - h) + id.charCodeAt(i);
    h = Math.abs(h);
    const points = 12;
    const vals = new Array(points).fill(0).map((_, i) => {
        // mix hash with index for variety
        const v = ((h >> (i % 16)) & 0xff) / 255;
        // scale to [0.1,0.9]
        return 0.1 + (v * 0.8);
    });

    const width = 80, height = 24;
    const step = width / (points - 1);
    const coords = vals.map((v, i) => `${(i * step).toFixed(1)},${(height - v * height).toFixed(1)}`).join(' ');

    return `
        <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" style="display:block;">
            <polyline fill="none" stroke="#00ff88" stroke-width="1.6" points="${coords}" stroke-linecap="round" stroke-linejoin="round" />
            <polyline fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="6" points="${coords}" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
    `;
}

function renderNewsFeed(news = []) {
    if (!news.length) return '';
    return `
        <div style="margin-top:16px; padding:16px; border:1px solid #222; border-radius:14px; background:#080b10;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
                <span style="color:#00ff88; font-size:0.8rem; font-weight:700; letter-spacing:0.5px;">LATEST API NEWS</span>
                <span style="color:#777; font-size:0.72rem;">Powered by NewsAPI</span>
            </div>
            ${news.slice(0, 5).map(item => `
                <a href="${escapeHtml(item.url || '#')}" target="_blank" rel="noopener noreferrer" style="display:block; color:#fff; text-decoration:none; margin-bottom:12px;">
                    <strong style="font-size:0.92rem;">${escapeHtml(item.title || item.betQuestion || item.displayHeadline || item.description || 'News item')}</strong>
                    <div style="font-size:0.72rem; color:#999; margin-top:4px;">${escapeHtml(item.source || item.country || 'Source')}${item.url ? ` · ${new Date(item.timestamp || item.publishedAt || Date.now()).toLocaleDateString()}` : ''}</div>
                </a>
            `).join('')}
        </div>
    `;
}

window.escapeHtml = function(text) {
    if (text === null || text === undefined) return ""; // Fix: Return empty string if null
    return text.toString()
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function linkify(text) {
    if (!text) return "";
    const urlPattern = /(\b(https?|ftp|file):\/\/[-A-Z0-9+&@#\/%?=~_|!:,.;]*[-A-Z0-9+&@#\/%=~_|])/ig;
    return text.replace(urlPattern, (url) => {
        return `<a href="${url}" target="_blank" style="color: #00ff88; text-decoration: underline;">${url}</a>`;
    });
}

function getYouTubeEmbedUrl(url) {
    if (!url) return null;

    try {
        const parsed = new URL(url);
        const host = parsed.hostname.replace(/^www\./, "");

        if (host === "youtu.be") {
            const id = parsed.pathname.split("/").filter(Boolean)[0];
            return id ? `https://www.youtube.com/embed/${id}` : null;
        }

        if (host === "youtube.com" || host === "m.youtube.com") {
            const id = parsed.searchParams.get("v");
            if (id) return `https://www.youtube-nocookie.com/embed/${id}`;

            const parts = parsed.pathname.split("/").filter(Boolean);
            const embedIndex = parts.findIndex(part => ["embed", "shorts", "live"].includes(part));
            if (embedIndex >= 0 && parts[embedIndex + 1]) {
                return `https://www.youtube-nocookie.com/embed/${parts[embedIndex + 1]}`;
            }
        }
    } catch {
        return null;
    }

    return null;
}

function renderMarketMedia(m) {
    const legacyMedia = (m.media_url || '').trim();
    const legacyLooksVideo = (m.media_type || '').toLowerCase() === 'video' || /\.(mp4|webm|ogg|mov)(\?.*)?$/i.test(legacyMedia);
    const imageUrl = (m.image_url || (!legacyLooksVideo ? legacyMedia : '') || "").trim();
    const videoUrl = (m.video_url || (legacyLooksVideo ? legacyMedia : '') || "").trim();
    if (!imageUrl && !videoUrl) return "";

    const renderVideo = (url) => {
        const safeUrl = escapeHtml(url);
        const youtubeEmbed = getYouTubeEmbedUrl(url);
        if (youtubeEmbed) return `
            <div class="market-media market-media-video">
                <iframe
                    src="${escapeHtml(youtubeEmbed)}"
                    title="Market video"
                    loading="lazy"
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                    allowfullscreen>
                </iframe>
            </div>
        `;
        return `
            <video class="market-media" controls playsinline preload="metadata">
                <source src="${safeUrl}">
                Your browser cannot play this video.
            </video>
        `;
    };
    return `
        <div class="market-media-stack">
            ${imageUrl ? `<img class="market-media" src="${escapeHtml(imageUrl)}" alt="Market news" loading="lazy">` : ''}
            ${videoUrl ? renderVideo(videoUrl) : ''}
        </div>
    `;
}

function renderMarketLiveInfo(m) {
    const updatedAt = m.timestamp
        ? new Date(m.timestamp).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })
        : "Live";
    const category = normalizeCategory(m.category);
    const startValue = m.event_start_time || m.startTime || m.timestamp;
    const startDate = m.startTime ? new Date(m.startTime) : null;
    const eventDurationHours = ['sports', 'football', 'soccer'].includes(category) ? 2
        : ['gaming', 'esports'].includes(category) ? 3 : 0;
    const inferredClose = startDate && Number.isFinite(startDate.getTime())
        ? new Date(startDate.getTime() + eventDurationHours * 60 * 60 * 1000).toISOString()
        : m.timestamp ? new Date(new Date(m.timestamp).getTime() + 24 * 60 * 60 * 1000).toISOString() : null;
    const closeValue = m.event_end_time || m.endTime || m.expiryTime || inferredClose;
    const formatTime = (value) => {
        const date = value ? new Date(value) : null;
        return date && Number.isFinite(date.getTime())
            ? date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" })
            : "Unavailable";
    };

    return `
        <div class="market-live-panel">
            <div>
                <span>Status</span>
                <strong>${escapeHtml((m.status || "open").toUpperCase())}</strong>
            </div>
            <div>
                <span>Starts</span>
                <strong>${escapeHtml(formatTime(startValue))}</strong>
            </div>
            <div>
                <span>Closes</span>
                <strong>${escapeHtml(formatTime(closeValue))}</strong>
            </div>
            <div>
                <span>Odds</span>
                <strong>YES ${Number(m.oddsA || 1.9).toFixed(2)} / NO ${Number(m.oddsB || 1.9).toFixed(2)}</strong>
            </div>
            <div>
                <span>Volume</span>
                <strong>${Number(m.home_volume || m.volume || 0).toFixed(0)} / ${Number(m.away_volume || 0).toFixed(0)} sKES</strong>
            </div>
            <div>
                <span>Updated</span>
                <strong>${escapeHtml(updatedAt)}</strong>
            </div>
        </div>
    `;
}

function extractStatsValue(stats, statNames) {
    if (!Array.isArray(stats)) return { home: null, away: null };
    const normalize = (value) => {
        if (value === null || value === undefined) return 0;
        if (typeof value === 'string') return Number(value.replace('%', '')) || 0;
        return Number(value) || 0;
    };
    const names = Array.isArray(statNames) ? statNames : [statNames];
    for (const name of names) {
        const home = stats[0]?.statistics?.find(item => item.type?.toLowerCase() === name.toLowerCase())?.value;
        const away = stats[1]?.statistics?.find(item => item.type?.toLowerCase() === name.toLowerCase())?.value;
        if (home != null || away != null) {
            return { home: normalize(home), away: normalize(away) };
        }
    }
    return { home: null, away: null };
}

function renderStatsBar(stats) {
    if (!Array.isArray(stats) || stats.length < 2) {
        return `<div style="color:#777; font-size:0.85rem; margin-top:10px;">No live statistics are available yet.</div>`;
    }
    const possession = extractStatsValue(stats, ['Ball Possession', 'Ball possession', 'possession']);
    const shotsOnTarget = extractStatsValue(stats, ['Shots on Goal', 'Shots on Target', 'Shots on target', 'shots_on_target']);
    const totalShots = extractStatsValue(stats, ['Total Shots', 'Total shots', 'Shots Total', 'total_shots']);
    const fouls = extractStatsValue(stats, ['Fouls', 'fouls']);
    const corners = extractStatsValue(stats, ['Corner Kicks', 'Corner kicks', 'Corners', 'corners']);
    const yellowCards = extractStatsValue(stats, ['Yellow Cards', 'Yellow cards', 'yellowcards']);
    const possessionLeft = Math.max(0, Math.min(100, possession.home || 0));
    const possessionRight = Math.max(0, Math.min(100, possession.away || 0));
    const hasAnyData = possession.home || shotsOnTarget.home || totalShots.home || corners.home;

    if (!hasAnyData) {
        return `<div style="color:#777; font-size:0.85rem; margin-top:10px;">No live statistics are available yet.</div>`;
    }

    const teamHome = stats[0]?.team?.name || 'Home';
    const teamAway = stats[1]?.team?.name || 'Away';

    const renderStatRow = (label, homeVal, awayVal) => `
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">
            <span style="flex:1; text-align:right; font-size:0.78rem; color:#ccc; font-weight:600;">${homeVal ?? '-'}</span>
            <span style="flex:0 0 auto; font-size:0.65rem; color:#666; text-transform:uppercase; min-width:70px; text-align:center;">${label}</span>
            <span style="flex:1; text-align:left; font-size:0.78rem; color:#ccc; font-weight:600;">${awayVal ?? '-'}</span>
        </div>
    `;

    return `
        <div style="background:#0d1117; padding:14px; border-radius:12px; border:1px solid #222;">
            <div style="display:flex; justify-content:space-between; font-size:0.75rem; color:#999; margin-bottom:10px; padding-bottom:8px; border-bottom:1px solid #1a2030;">
                <span style="font-weight:700; color:#ccc;">${escapeHtml(teamHome)}</span>
                <span style="text-transform:uppercase; letter-spacing:0.5px; font-size:0.65rem;">Statistics</span>
                <span style="font-weight:700; color:#ccc;">${escapeHtml(teamAway)}</span>
            </div>
            ${possession.home != null ? `
            <div style="margin-bottom:14px;">
                <div style="display:flex; justify-content:space-between; font-size:0.7rem; color:#888; margin-bottom:4px;">
                    <span>${possessionLeft}%</span><span>Possession</span><span>${possessionRight}%</span>
                </div>
                <div style="height:8px; background:#1a1a2e; border-radius:999px; overflow:hidden; display:flex;">
                    <div style="width:${possessionLeft}%; background:linear-gradient(90deg,#00ff88,#00d17a); transition:width 0.5s;"></div>
                    <div style="width:${possessionRight}%; background:linear-gradient(90deg,#ff4d4d,#d12020); transition:width 0.5s;"></div>
                </div>
            </div>` : ''}
            ${renderStatRow('Shots on Target', shotsOnTarget.home, shotsOnTarget.away)}
            ${renderStatRow('Total Shots', totalShots.home, totalShots.away)}
            ${corners.home != null ? renderStatRow('Corners', corners.home, corners.away) : ''}
            ${fouls.home != null ? renderStatRow('Fouls', fouls.home, fouls.away) : ''}
            ${yellowCards.home != null ? renderStatRow('Yellow Cards', yellowCards.home, yellowCards.away) : ''}
        </div>
    `;
}

function renderLineups(lineups) {
    if (!Array.isArray(lineups) || lineups.length === 0) {
        return `<p style="color:#777; font-size:0.85rem;">Lineup information is not available for this fixture.</p>`;
    }

    const renderTeamLineup = (team) => {
        if (!team) return '';
        const title = team.team?.name || team.name || 'Team';
        const formation = team.formation ? escapeHtml(team.formation) : '';
        const starters = Array.isArray(team.startXI) ? team.startXI : (Array.isArray(team.starting_eleven) ? team.starting_eleven : []);
        const bench = Array.isArray(team.substitutes) ? team.substitutes : (Array.isArray(team.substitute) ? team.substitute : []);

        const renderPlayer = (player, idx) => {
            if (!player) return '';
            const p = player.player || player;
            const name = p.name || p.short_name || p.player_name || 'Unknown';
            const number = player.number || p.number || '';
            const pos = p.pos || player.position || '';
            return `<div style="display:flex; align-items:center; gap:6px; padding:2px 0;">
                <span style="color:#555; font-size:0.65rem; min-width:14px;">${number}</span>
                <span style="color:#ccc; font-size:0.74rem;">${escapeHtml(name)}</span>
                ${pos ? `<span style="color:#555; font-size:0.6rem;">(${escapeHtml(pos)})</span>` : ''}
            </div>`;
        };

        return `
            <div style="flex:1; min-width:160px;">
                <div style="font-size:0.82rem; color:#aaa; margin-bottom:6px; font-weight:700;">
                    ${escapeHtml(title)} ${formation ? `• <span style="color:#00ff88">${formation}</span>` : ''}
                </div>
                <div style="line-height:1.3;">
                    ${starters.length ? starters.map(renderPlayer).join('') : '<div style="color:#555; font-size:0.72rem;">No lineup data</div>'}
                </div>
                ${bench.length ? `
                <div style="margin-top:8px; padding-top:6px; border-top:1px solid #1a2030;">
                    <div style="font-size:0.68rem; color:#555; margin-bottom:4px; font-weight:600;">BENCH</div>
                    <div style="font-size:0.7rem; color:#666;">${bench.map(p => escapeHtml((p.player || p)?.name || p.short_name || '?')).join(', ')}</div>
                </div>` : ''}
            </div>
        `;
    };

    return `
        <div style="display:flex; gap:18px; flex-wrap:wrap;">
            ${renderTeamLineup(lineups[0])}
            ${renderTeamLineup(lineups[1])}
        </div>
    `;
}

function renderResolutionInfo(m) {
    const category = (m.category || "market").toLowerCase();
    
    // Updated sourceMap to reflect API-Football for the Active account
    const sourceMap = {
        football: "API-Football match data and official match records",
        crypto: "CoinGecko market data",
        news: "Major public news sources",
        weather: "WeatherAPI forecast and historical weather data",
        politics: "Publicly verifiable official announcements"
    };
    let yesRule = '';
    if (category === 'weather') {
        yesRule = 'YES resolves if the forecast for the specified date matches the observed weather on that date.';
    } else if (category === 'football') {
        yesRule = 'YES resolves if the selected outcome is confirmed by the official final match record.';
    } else {
        yesRule = `YES resolves if the statement in this market is confirmed by ${sourceMap[category] || "a reliable public source"}.`;
    }

    return `
        <div class="resolution-panel" style="background: rgba(255,255,255,0.05); padding: 12px; border-radius: 8px; margin: 15px 0; border: 1px solid #333;">
            <div style="margin-bottom: 8px;">
                <span style="color: #888; text-transform: uppercase; font-size: 0.7rem; letter-spacing: 0.5px; display: block;">Resolution Source</span>
                <strong style="color: #ddd; font-size: 0.85rem;">${escapeHtml(sourceMap[category] || "Reliable public source")}</strong>
            </div>
            <p style="font-size: 0.8rem; color: #bbb; margin: 8px 0;">${escapeHtml(yesRule)}</p>
            <small style="color: #666; font-size: 0.7rem; display: block; line-height: 1.2;">
                Markets may be voided if the event is cancelled, materially changed, or cannot be verified.
            </small>
        </div>
    `;
}

window.renderTransactionItem = function(item) {
    if (!item || typeof item !== 'object') return '';
    const itemType = (item.type || '').trim().toLowerCase();
    const isDeposit = ['stk_request', 'deposit', 'referral_bonus', 'crypto'].includes(itemType);
    const accentColor = isDeposit ? '#00ff88' : '#ff4444';
    const displayDate = item.timestamp || item.created_at; 
    const status = (item.status || 'pending').toLowerCase();
    
    const label = itemType === 'referral_bonus' ? '🎁 BONUS' : 
                  (itemType === 'crypto' ? '🪙 CRYPTO' :
                  (isDeposit ? '💰 DEPOSIT' : '💸 WITHDRAWAL'));

    return `
        <div class="transaction-item" style="margin-bottom: 12px; border-left: 4px solid ${accentColor}; background: #1a1b23; padding: 15px; border-radius: 12px; display: flex; justify-content: space-between; align-items: center;">
            <div>
                <div style="font-size:0.65rem; color:gray; text-transform: uppercase; margin-bottom: 4px;">${label}</div>
                <div style="font-weight:bold; color: white; font-family: monospace; font-size: 0.85rem; margin-bottom: 4px;">${item.reference || '---'}</div>
                <div style="color: #6b7280; font-size: 0.7rem;">
                    ${new Date(displayDate || Date.now()).toLocaleString([], {dateStyle:'medium', timeStyle:'short'})}
                </div>
            </div>
            <div style="text-align: right;">
                <div style="font-weight:bold; color: white; font-size: 1rem; margin-bottom: 4px;">
                    ${isDeposit ? '+' : ''}${item.amount || 0} <small style="color: #6b7280;">sKES</small> 
                </div>
                <div style="color: ${status === 'completed' || status === 'approved' ? '#00ff88' : '#fbbf24'}; font-size: 0.7rem; font-weight: bold; text-transform: uppercase;">
                    ● ${status}
                </div>
            </div>
        </div>
    `;
};

/**
 * BET CARD
 */
window.renderBetCard = function(bet) {
    // Show when the user placed the bet. commence_time is the event start,
    // which can be missing and is not the time the bet was submitted.
    const placedAt = bet.created_at || bet.createdAt || bet.timestamp;
    const parsedPlacedAt = placedAt ? new Date(placedAt) : null;
    const time = parsedPlacedAt && !Number.isNaN(parsedPlacedAt.getTime())
        ? parsedPlacedAt.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
        : "Time unavailable";

    const status = (bet.status || "").toLowerCase();

    const colors = {
        won: "#00ff88",
        lost: "#ff4444",
        active: "#00ccff",
        pending: "#00ccff",
        cancelled: "#ffaa00"
    };

    return `
        <div class="bet-card ${status}" style="margin-bottom: 12px; background: #1a1b23; padding: 15px; border-radius: 12px; border-left: 4px solid ${colors[status] || '#3b82f6'}; display: flex; justify-content: space-between; align-items: center;">
            <div class="bet-main-info">
                <span class="event-name" style="color: #9ca3af; font-size: 0.75rem; display: block; margin-bottom: 4px;">
                    ${bet.event || bet.market_name || bet.marketTitle || "Market Prediction"}
                </span>

                <span class="selection-text" style="color: white; font-size: 1.1rem; font-weight: bold; display: block; margin-bottom: 4px;">
                    Picked: ${bet.picked || bet.side} •
                    Stake: sKES ${bet.amount || bet.stake}
                </span>

                <span class="selection-text" style="color:#777">
                    📅 ${time}
                </span>
            </div>

            <div style="text-align:right;">
                <div class="bet-odds">
                    @${bet.odds || bet.price || "-"}
                </div>

                <small style="color:${colors[status] || "#888"}; font-weight:700;">
                    ${(bet.status || "UNKNOWN").toUpperCase()}
                </small>
            </div>
        </div>
    `;
}

function applyFilters(source) {
    let data = source || state.allMarkets;

    const active = (state.category || "all").toLowerCase() === "football" ? "sports" : (state.category || "all").toLowerCase();
    const search = (state.search || "").toLowerCase();

    let filtered = data.filter(m => {
        if (active === "all") return true;

        const cat = (m.category || "").toLowerCase();

        if (active === "football") {
            return isSportsMarket(m);
        }

        if (active === "sports") {
            return isSportsMarket(m);
        }

        return cat === active;
    });

    if (search) {
        filtered = filtered.filter(m =>
            (m.title || "").toLowerCase().includes(search)
        );
    }

    return filtered;
}
const renderMatchCenter = (data) => {
    const score = data?.score || null;
    const fixture = data?.fixture || null;
    const stats = data?.stats || data?.response?.[0]?.statistics || null;
    const lineups = data?.lineups || data?.response?.[0]?.lineups || null;
    const events = data?.events || data?.response?.[0]?.events || [];
    const predictions = data?.predictions || data?.response?.[0]?.predictions || [];
    const sectionErrors = data?.sectionErrors || {};
    const scoreView = score ? `
        <div style="display:flex;align-items:center;justify-content:center;gap:16px;padding:14px;margin-bottom:16px;background:#0d1117;border:1px solid #222;border-radius:12px;">
            <strong style="flex:1;text-align:right;color:#eee;">${escapeHtml(fixture?.teams?.home?.name || 'Home')}</strong>
            <span style="font-size:1.35rem;font-weight:900;color:#00ff88;white-space:nowrap;">${score.home ?? '–'} : ${score.away ?? '–'}</span>
            <strong style="flex:1;color:#eee;">${escapeHtml(fixture?.teams?.away?.name || 'Away')}</strong>
        </div>
        <div style="text-align:center;color:#84909d;font-size:.72rem;margin:-8px 0 14px;">${escapeHtml(score.status?.long || 'Fixture score')}</div>`
        : `<div style="padding:10px;margin-bottom:15px;color:#9ca8b5;background:#10151b;border-radius:8px;">${escapeHtml(sectionErrors.fixture || 'Score data is not available for this fixture yet.')}</div>`;
    
    // 1. Live Events (Goals/Cards)
    const safeEvents = Array.isArray(events) ? events : [];
    const eventTimeline = safeEvents.length ? safeEvents.map(e => {
        const elapsed = e?.time?.elapsed || e?.time?.extra || '?';
        const playerName = e?.player?.name || 'Unknown';
        const teamName = e?.team?.name || '';
        const isGoal = e?.type === 'Goal';
        const isYellow = e?.detail === 'Yellow Card';
        const isRed = e?.detail === 'Red Card';
        return `
        <div style="display:flex; align-items:center; gap:10px; margin-bottom:8px; font-size:0.78rem;">
            <span style="color:#888; min-width:30px; font-size:0.72rem;">${elapsed}'</span>
            <span style="color:${isGoal ? '#00ff88' : isRed ? '#ff4444' : '#ffaa00'}">${isGoal ? '⚽' : isYellow ? '🟨' : isRed ? '🟥' : '📋'}</span>
            <span style="color:#ccc;">${escapeHtml(playerName)} ${teamName ? `<span style="color:#666;">(${escapeHtml(teamName)})</span>` : ''}</span>
        </div>`;
    }).join('') : '<p style="color:#444; font-size:0.78rem;">No major events yet.</p>';

    // 2. Win Probability (Predictions)
    const pred = Array.isArray(predictions) ? (predictions[0]?.predictions?.winner || null) : null;
    const probHtml = pred ? `
        <div style="background:#0d1117; padding:10px; border-radius:8px; margin-bottom:15px; border-left:4px solid #00ff88;">
            <small style="color:#888; display:block; margin-bottom:4px; font-size:0.65rem; text-transform:uppercase;">Win Probability</small>
            <div style="font-weight:bold; font-size:0.85rem; color:#ccc;">
                ${pred.comment || 'N/A'}
            </div>
        </div>
    ` : '';

    return `
        <div class="livescore-view" style="margin-top:16px;">
            ${scoreView}
            ${probHtml}
            ${safeEvents.length ? `
            <div style="margin-bottom:20px;">
                <h4 style="font-size:0.68rem; color:#888; text-transform:uppercase; margin-bottom:10px; letter-spacing:0.5px;">Match Timeline</h4>
                ${eventTimeline}
            </div>` : ''}
            ${stats ? renderStatsBar(stats) : ''}
            ${lineups ? `
            <div style="margin-top:20px;">
                <h4 style="font-size:0.68rem; color:#888; text-transform:uppercase; margin-bottom:10px; letter-spacing:0.5px;">Starting XI</h4>
                ${sectionErrors.lineups ? `<p style="color:#a9a077;font-size:.82rem;">${escapeHtml(sectionErrors.lineups)}</p>` : renderLineups(lineups)}
            </div>` : ''}
        </div>
    `;
};

function renderRelatedMatchNews(news = []) {
    if (!Array.isArray(news) || news.length === 0) {
        return `<div style="color:#777; font-size:0.85rem; margin-top:20px; padding:12px 14px; border:1px solid #222; border-radius:10px;">No related match news available.</div>`;
    }

    return `
        <div style="margin-top:20px; padding:14px; border:1px solid #222; border-radius:12px; background:#0f1117;">
            <h4 style="font-size:0.85rem; color:#00ff88; text-transform:uppercase; margin-bottom:14px;">Related Match News</h4>
            ${news.slice(0, 5).map(article => `
                <a href="${escapeHtml(article.url)}" target="_blank" rel="noopener noreferrer" style="display:block; margin-bottom:12px; text-decoration:none; color:#fff;">
                    <strong style="font-size:0.95rem; display:block; margin-bottom:6px;">${escapeHtml(article.title)}</strong>
                    <span style="color:#999; font-size:0.78rem;">${escapeHtml(article.source || 'Unknown source')} — ${escapeHtml(article.description || '').substring(0, 80)}...</span>
                </a>
            `).join('')}
        </div>
    `;
}

async function fetchMatchDetails(fixtureId) {
    try {
        const cleanId = fixtureId.replace('fb_', '');
        const response = await fetch(window.apiUrl(`/api/football/details/${cleanId}`));
        
        if (!response.ok) throw new Error('API request failed');
        
        return await response.json();
    } catch (e) {
        console.error("❌ Frontend Fetch Error:", e);
        return null;
    }
}


function requireAuth() {
    const authCard = document.querySelector('.auth-card');
    if (authCard) {
        authCard.scrollIntoView({ behavior: 'smooth' });
        authCard.classList.add('shake-highlight');
        setTimeout(() => authCard.classList.remove('shake-highlight'), 1000);
        return true;
    }
    return false;
}

async function openMarket(id, openInNewTab = false) {
    if (!localStorage.getItem("token")) {
        if (requireAuth()) return;
    }

    const m = window.marketMap?.[id];
    if (!m) return;

    // Sports fixtures have a shareable, full-screen route. News and other
    // markets retain their existing detail modal.
    if (isSportsMarket(m) && (isFootballFixtureMarket(m) || /^fb_/i.test(id))) {
        localStorage.setItem("last_market_id", id);
        window.location.hash = `#match/${encodeURIComponent(id)}`;
        return;
    }

    const body = document.getElementById("modalBody");
    if (!body) return;
    
    localStorage.setItem("last_market_id", id);

    // Open Modal with smooth animation
    const modal = document.getElementById("richModal");
    modal.style.display = "flex";
    modal.classList.add("active");
    document.body.classList.add("modal-open");
    document.body.style.overflow = "hidden";
    
    // 1. Initial Render: UI structure + Betting Buttons
    body.innerHTML = isNewsLikeMarket(m)
        ? renderNewsModal(m, renderMarketMedia(m))
        : renderDefaultModal(m, m.content || m.description, renderMarketMedia(m));

    // Add "Open in New Page" button for news
    if (isNewsLikeMarket(m)) {
        const newsHeader = body.querySelector('.story-mode');
        if (newsHeader) {
            const newPageBtn = document.createElement('button');
            newPageBtn.className = 'btn-open-new-page';
            newPageBtn.style.cssText = `
                display: inline-block;
                margin-top: 12px;
                padding: 8px 12px;
                background: rgba(0, 255, 136, 0.15);
                border: 1px solid rgba(0, 255, 136, 0.3);
                border-radius: 6px;
                color: #00ff88;
                font-size: 0.75rem;
                font-weight: 600;
                cursor: pointer;
                transition: all 0.2s ease;
            `;
            newPageBtn.innerText = '🔗 Open Full Page';
            newPageBtn.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                window.location.href = "index.html";
            };
            newsHeader.parentElement.insertBefore(newPageBtn, newsHeader.nextSibling);
        }
    }

    let centerContainer = document.getElementById("match-center-container");
    
    if (!centerContainer) {
        const newContainer = document.createElement('div');
        newContainer.id = "match-center-container";
        body.appendChild(newContainer);
        centerContainer = newContainer;
    }

    // 3. Live Football Data (Stats, Lineups, Ratings)
    if (isFootballFixtureMarket(m) || id.startsWith("fb_")) {
        const statsLoader = document.createElement('div');
        statsLoader.innerHTML = `<div style="text-align:center; padding:15px; color:#666; font-size:0.75rem;">🔍 Scouting live data & ratings...</div>`;
        centerContainer.appendChild(statsLoader);

        try {
            const data = await fetchMatchDetails(id);
            statsLoader.remove();

            if (data && !data.error) {
                centerContainer.insertAdjacentHTML('beforeend', renderMatchCenter(data));
            } else if (data?.error?.includes('429')) {
                centerContainer.insertAdjacentHTML('beforeend', `<div style="color:#ffaa00; font-size:0.75rem; padding:10px; border:1px dashed #444;">Rate limit reached. Live ratings paused.</div>`);
            }
        } catch (err) {
            statsLoader.innerHTML = ""; 
            console.error("Match Center failed to load", err);
        }
    }

    loadOrderBook(id).catch((err) => console.warn("Order book failed:", err.message));
}

let activeMatchDetails = null;
let activeMatchDetailsId = null;
let matchCountdownTimer = null;
window.renderMatchView = async function renderMatchView(marketId) {
    const root = document.getElementById('matchView');
    if (!root) return;
    const market = window.marketMap?.[marketId] || state.allMarkets?.find(item => String(item.id) === String(marketId));
    if (!market) {
        root.innerHTML = `<section class="match-view-shell"><button class="match-back" onclick="window.location.hash=''">← All markets</button><p>Match data is still loading…</p></section>`;
        return;
    }
    if (activeMatchDetailsId !== marketId) { activeMatchDetails = null; activeMatchDetailsId = marketId; }
    const home = market.sideA || String(market.title || '').split(/\s+vs\s+/i)[0] || 'Home';
    const away = market.sideB || String(market.title || '').split(/\s+vs\s+/i)[1] || 'Away';
    const kickoff = market.startTime || market.event_start_time || market.eventStartTime;
    const kickoffDate = kickoff ? new Date(kickoff) : null;
    const kickoffLabel = kickoffDate && !Number.isNaN(kickoffDate.getTime()) ? kickoffDate.toLocaleString(undefined, { dateStyle:'full', timeStyle:'short' }) : 'Kickoff time unavailable';
    const category = [market.sport || 'Soccer', market.country, market.league].filter(Boolean).map(escapeHtml).join(' | ');
    const title = escapeHtml(market.betQuestion || market.title || `${home} vs ${away}`);
    root.innerHTML = `
      <div class="match-view-shell">
        <header class="match-view-header"><button class="match-back" onclick="window.location.hash=''">← Sports</button><span>${category}</span><span class="match-view-status">${escapeHtml(String(market.status || 'upcoming').toUpperCase())}</span></header>
        <section class="match-hero"><div class="match-meta">${category}</div><h1>${escapeHtml(home)} <span>vs</span> ${escapeHtml(away)}</h1><p>${kickoffLabel}</p><strong id="matchCountdown">${market.status === 'live' ? 'LIVE NOW' : 'Kickoff countdown loading…'}</strong></section>
        <section class="match-center-banner"><div class="pitch-art" aria-hidden="true"><span>⚽</span></div><div class="match-center-info"><small>MATCH CENTER</small><b>${escapeHtml(home)} vs ${escapeHtml(away)}</b><span id="matchBannerCountdown">${kickoffLabel}</span></div></section>
        <nav class="match-info-tabs" aria-label="Match information"><button class="active" data-match-tab="match">Match</button><button data-match-tab="head-to-head">Head to Head</button><button data-match-tab="standings">Standings</button><button data-match-tab="lineups">Lineups</button></nav>
        <section id="matchInfoContent" class="match-content-panel"><p class="match-loading">Loading match details…</p></section>
        <section class="match-markets"><h2>Match markets</h2><div class="match-market-grid" id="matchMarketGrid"></div></section>
        <section class="match-interaction"><nav><button class="active" data-interaction-tab="markets">Markets</button><button data-interaction-tab="builder">Bet Builder</button><button data-interaction-tab="chat">Chat</button></nav><div id="matchInteractionContent"></div></section>
      </div>`;
    root.onclick = async (event) => {
        const infoTab = event.target.closest('[data-match-tab]');
        const interactionTab = event.target.closest('[data-interaction-tab]');
        if (infoTab) {
            root.querySelectorAll('[data-match-tab]').forEach(btn => btn.classList.toggle('active', btn === infoTab));
            renderMatchInfoTab(infoTab.dataset.matchTab, market, activeMatchDetails);
        }
        if (interactionTab) {
            root.querySelectorAll('[data-interaction-tab]').forEach(btn => btn.classList.toggle('active', btn === interactionTab));
            renderMatchInteractionTab(interactionTab.dataset.interactionTab, market);
        }
        const providerBtn = event.target.closest('.provider-odds-btn');
        if (providerBtn) {
            event.stopPropagation();
            window.selectOutcome(providerBtn.dataset.id, providerBtn.dataset.option, Number(providerBtn.dataset.odds));
            return;
        }
        const betBtn = event.target.closest('.bet-btn');
        if (betBtn) { event.stopPropagation(); window.selectOutcome(betBtn.dataset.id, betBtn.dataset.choice, Number(betBtn.dataset.odds)); }
    };
    document.body.classList.add('match-view-open');
    renderMatchMarketGrid(market, activeMatchDetails?.odds);
    renderMatchInteractionTab('markets', market);
    root.querySelectorAll('[data-match-tab]').forEach(btn => btn.classList.toggle('active', btn.dataset.matchTab === 'match'));
    renderMatchInfoTab('match', market, activeMatchDetails);
    if (matchCountdownTimer) clearInterval(matchCountdownTimer);
    const updateCountdown = () => {
        const el = document.getElementById('matchCountdown');
        const banner = document.getElementById('matchBannerCountdown');
        if (!el || !kickoffDate || Number.isNaN(kickoffDate.getTime())) return;
        const remaining = kickoffDate.getTime() - Date.now();
        if (remaining <= 0) { el.textContent = market.status === 'live' ? 'LIVE NOW' : 'Kickoff time reached'; return; }
        const days = Math.floor(remaining / 86400000), hours = Math.floor(remaining % 86400000 / 3600000), minutes = Math.floor(remaining % 3600000 / 60000), seconds = Math.floor(remaining % 60000 / 1000);
        const value = `Kickoff in ${days}d ${hours}h ${minutes}m ${seconds}s`;
        el.textContent = value; if (banner) banner.textContent = value;
    };
    updateCountdown(); matchCountdownTimer = setInterval(updateCountdown, 1000);
    try {
        const data = await fetchMatchDetails(marketId);
        if (window.location.hash !== `#match/${encodeURIComponent(marketId)}`) return;
        activeMatchDetails = data;
        const activeTab = root.querySelector('[data-match-tab].active')?.dataset.matchTab || 'match';
        renderMatchMarketGrid(market, data?.odds);
        renderMatchInfoTab(activeTab, market, data);
    } catch (error) { renderMatchInfoTab('match', market, null); }
};

function renderMatchInfoTab(tab, market, data) {
    const panel = document.getElementById('matchInfoContent'); if (!panel) return;
    if (!data) { panel.innerHTML = `<p class="match-loading">Match information is temporarily unavailable.</p>`; return; }
    if (tab === 'lineups') {
        const rows = data.lineups;
        const teams = Array.isArray(rows) ? rows : [];
        const fixture = data.fixture || {};
        const details = fixture.fixture?.referee || fixture.referee;
        const managers = teams.map(team => team.coach?.name).filter(Boolean);
        panel.innerHTML = `<h2>Starting lineups</h2>${teams.length ? renderLineups(teams) : `<p>${escapeHtml(data.sectionErrors?.lineups || 'Starting lineups have not been published yet.')}</p>`}<div class="match-officials"><span>Managers</span><b>${escapeHtml(managers.join(' · ') || 'Not announced')}</b></div><div class="match-officials"><span>Referee</span><b>${escapeHtml(details || 'Not announced')}</b></div>`;
        return;
    }
    if (tab === 'head-to-head') {
        const rows = data.headToHead || [];
        panel.innerHTML = `<h2>Head to head</h2>${rows.length ? rows.map(row => `<div class="match-data-row">${escapeHtml(row.fixture?.date ? new Date(row.fixture.date).toLocaleDateString() : '')}<b>${escapeHtml(row.teams?.home?.name || '')} ${row.goals?.home ?? '-'} : ${row.goals?.away ?? '-'} ${escapeHtml(row.teams?.away?.name || '')}</b></div>`).join('') : '<p>Recent head-to-head results are not available.</p>'}`;
        return;
    }
    if (tab === 'standings') {
        const rows = data.standings || [];
        panel.innerHTML = `<h2>${escapeHtml(data.fixture?.league?.name || market.league || 'League')} standings</h2>${rows.length ? `<div class="match-data-row match-table-heading"><span>#</span><span>Club</span><span>Pts</span></div>${rows.map(row => `<div class="match-data-row match-table-row"><span>${row.rank ?? ''}</span><span>${escapeHtml(row.team?.name || '')}</span><b>${row.points ?? ''}</b></div>`).join('')}` : '<p>Standings are not available for this fixture.</p>'}`;
        return;
    }
    panel.innerHTML = renderMatchCenter(data);
}

function renderMatchMarketGrid(market, providerOdds = []) {
    const grid = document.getElementById('matchMarketGrid'); if (!grid) return;
    const platformMarket = `<article class="match-contract-card"><h3>PolySoko · Match Result</h3><div class="match-contract-outcomes">${getMarketOutcomes(market).map(outcome => `<button class="bet-btn" data-id="${escapeHtml(market.id)}" data-choice="${escapeHtml(outcome.key)}" data-odds="${Number(outcome.odds)}" data-title="${escapeHtml(market.betQuestion || market.title)}"><span>${escapeHtml(outcome.label)}</span><b>${Number(outcome.odds).toFixed(2)}</b></button>`).join('')}</div></article>`;
    const offers = Array.isArray(providerOdds) ? providerOdds : [];
    const providerCards = offers.map(offer => {
        const type = providerContractType(offer.market);
        return `<article class="match-contract-card match-provider-card"><div class="match-provider-meta"><span>${escapeHtml(offer.source || 'Provider')}</span><span>${escapeHtml(offer.bookmaker || 'Bookmaker')}${offer.live ? ' · LIVE' : ''}</span></div><h3>${escapeHtml(offer.market || 'Market')}</h3><div class="match-provider-outcomes">${(offer.outcomes || []).map(outcome => {
            const option = JSON.stringify({ type, market: offer.market, selection: outcome.label, source: offer.source, bookmaker: offer.bookmaker });
            const choice = type && !outcome.suspended
                ? `<button type="button" class="match-provider-outcome provider-odds-btn" data-id="${escapeHtml(market.id)}" data-option="${escapeHtml(option)}" data-odds="${Number(outcome.price)}"><span>${escapeHtml(outcome.label || '—')}</span><b>${Number(outcome.price).toFixed(2)}</b></button>`
                : `<span class="match-provider-outcome ${outcome.suspended ? 'suspended' : ''}"><span>${escapeHtml(outcome.label || '—')}</span><b>${Number(outcome.price).toFixed(2)}</b>${outcome.suspended ? '<small>Suspended</small>' : ''}</span>`;
            return choice;
        }).join('')}</div></article>`;
    }).join('');
    const error = activeMatchDetails?.sectionErrors?.odds;
    grid.innerHTML = platformMarket + `<div class="match-provider-section"><div class="match-provider-heading"><h3>All provider odds</h3><small>${offers.length ? `${offers.length} bookmaker markets` : error ? escapeHtml(error) : 'Loading provider quotes…'}</small></div><div class="match-provider-grid">${providerCards || `<div class="match-provider-empty">${error ? escapeHtml(error) : 'No bookmaker odds are available from the configured feeds for this fixture.'}</div>`}</div></div>`;
}

function providerContractType(marketName) {
    const name = String(marketName || '').toLowerCase();
    if (/match winner|full.?time result|1x2|match result/.test(name)) return 'match_result';
    if (/double chance/.test(name)) return 'double_chance';
    if (/both teams? to score|gg\s*\/\s*ng|\bbtts\b/.test(name)) return 'both_teams_score';
    if (/over\/under|total goals|match goals|goals over|goal line/.test(name)) return 'total_goals';
    if (/first (team )?to score|1st (team )?to score|first goal|1st goal/.test(name)) return 'first_goal';
    return null;
}

window.selectOutcome = function(marketId, optionType, oddsValue) {
    if (!localStorage.getItem('token')) {
        requireAuth();
        return false;
    }
    const market = window.marketMap?.[marketId];
    if (!market) return alert('This match is no longer available. Refresh the match list.');
    let contract = null;
    let pick = String(optionType || '');
    try {
        const parsed = JSON.parse(pick);
        if (parsed && typeof parsed === 'object') {
            contract = { ...parsed, price: Number(oddsValue) };
            pick = parsed.selection;
        }
    } catch { /* Native market outcome key. */ }
    const nativeOutcome = getMarketOutcomes(market).find(item => item.key === pick || item.label.toLowerCase() === pick.toLowerCase());
    if (!contract && !nativeOutcome) return alert('That selection is not available on PolySoko.');
    const title = contract ? `${market.title || market.betQuestion} · ${contract.market}` : (market.betQuestion || market.title || 'Match Result');
    window.openBetModal(marketId, title, nativeOutcome?.key || pick, Number(oddsValue), contract);
    return true;
};

window.updateMatchProviderOdds = function(marketId, odds) {
    if (window.location.hash !== `#match/${encodeURIComponent(marketId)}`) return;
    activeMatchDetails = { ...(activeMatchDetails || {}), odds: Array.isArray(odds) ? odds : [] };
    if (pendingBet?.marketId === marketId && pendingBet.contract) {
        const currentOffer = activeMatchDetails.odds.find(offer => offer.market === pendingBet.contract.market && offer.source === pendingBet.contract.source && offer.bookmaker === pendingBet.contract.bookmaker);
        const currentOutcome = currentOffer?.outcomes?.find(outcome => outcome.label === pendingBet.contract.selection && !outcome.suspended);
        if (currentOutcome && Number(currentOutcome.price) > 1) {
            pendingBet.price = Number(currentOutcome.price);
            pendingBet.contract.price = pendingBet.price;
            const pickEl = document.getElementById('modal-pick-display');
            if (pickEl) pickEl.innerText = `Your Pick: ${pendingBet.contract.selection} · Odds @${pendingBet.price.toFixed(2)} (${(100 / pendingBet.price).toFixed(1)}% implied)`;
        }
    }
    const market = window.marketMap?.[marketId];
    if (market) renderMatchMarketGrid(market, activeMatchDetails.odds);
};

function renderMatchInteractionTab(tab, market) {
    const panel = document.getElementById('matchInteractionContent'); if (!panel) return;
    if (tab === 'markets') panel.innerHTML = '<p>Select an outcome in Match markets above to place a bet.</p>';
    else if (tab === 'builder') panel.innerHTML = '<p>Choose available match outcomes above to build your bet slip.</p>';
    else panel.innerHTML = `<p>Ask about ${escapeHtml(market.title || 'this match')} in PolySoko chat.</p><button type="button" class="match-chat-open" onclick="document.getElementById('assistantToggle')?.click()">Open match chat</button>`;
}

window.updateMatchMarket = function(id) {
    const market = window.marketMap?.[id];
    if (!market || window.location.hash !== `#match/${encodeURIComponent(id)}`) return;
    renderMatchMarketGrid(market, activeMatchDetails?.odds);
    renderMatchInteractionTab(document.querySelector('[data-interaction-tab].active')?.dataset.interactionTab || 'markets', market);
};
function closeMarket() {
    const modal = document.getElementById("richModal");
    const body = document.getElementById("modalBody");

    localStorage.removeItem("last_market_id");
    
    if (modal) {
        modal.classList.remove("active");
        modal.style.display = "none";
    }
    if (body) body.innerHTML = "";

    document.body.classList.remove("modal-open");
    document.body.style.overflow = "auto";
}
// Modal content is replaced dynamically, so delegate YES/NO clicks from the body.
document.getElementById("modalBody")?.addEventListener("click", (e) => {
    const btn = e.target.closest(".bet-btn");
    if (!btn) return;

    e.stopPropagation();
    const id = btn.dataset.id;
    const choice = btn.dataset.choice;
    const title = btn.dataset.title || "Market";

    if (id && choice) {
        window.openBetModal(id, title, choice);
    }
});
/**
 * MODAL CONTENT
 */
function renderNewsModal(m, media = "") {
    const safeTitle = escapeHtml(m.betQuestion || m.title || "");
    const storyContent = m.content || m.description || "The full story is being updated...";

    return `
        <div class="news-modal-content" style="padding:5px;">
            ${media}

            <h2 style="color:white; font-size: 1.5rem; font-weight: 900; margin: 20px 0 16px 0; line-height: 1.3;">
                ${escapeHtml(m.betQuestion || m.title)}
            </h2>

            <!-- 📖 ENHANCED STORY MODE -->
            <div class="story-mode" style="background: linear-gradient(135deg, rgba(0,255,136,0.05) 0%, rgba(0,200,100,0.02) 100%); border: 1px solid rgba(0,255,136,0.15); padding: 22px; border-radius: 12px; margin-bottom: 25px; line-height: 1.8; color: #e5e7eb;">
                <div style="color: #00ff88; font-size: 0.7rem; font-weight: 900; margin-bottom: 12px; text-transform: uppercase; letter-spacing: 1.2px; display: flex; justify-content: space-between; align-items: center;">
                    <span>📰 Full Story</span>
                    <span style="background: rgba(0, 255, 136, 0.2); color: #00ff88; padding: 3px 8px; border-radius: 4px; font-size: 0.6rem;">LIVE</span>
                </div>
                <div style="font-size: 0.95rem; white-space: pre-wrap; word-break: break-word;">
                    ${linkify(escapeHtml(storyContent))}
                </div>
                ${m.url ? `
                <div style="margin-top: 16px; padding-top: 16px; border-top: 1px solid rgba(0,255,136,0.1); text-align: center;">
                    <a href="${escapeHtml(m.url)}" target="_blank" style="color: #00ff88; font-size: 0.8rem; text-decoration: none; font-weight: 700; display: inline-flex; align-items: center; gap: 6px; padding: 8px 12px; background: rgba(0,255,136,0.1); border-radius: 6px; transition: all 0.2s ease;">
                        📖 Read Original Story ↗
                    </a>
                </div>` : ''}
            </div>

            <!-- BETTING SECTION -->
            <div class="betting-section" style="margin-bottom: 25px;">
                <div style="color: #888; font-size: 0.7rem; font-weight: 700; margin-bottom: 12px; text-transform: uppercase; letter-spacing: 0.5px;">Place Your Prediction</div>
                <div class="betting-row" style="display:flex; gap:12px; margin-bottom: 0;">
                    ${getMarketOutcomes(m).map(outcome => {
                        const accent = outcomeAccent(outcome.key);
                        return `
                        <button class="bet-btn" style="flex:1; min-width:0; padding: 18px; font-weight: 800; font-size: 1rem; background:${accent}22; border: 1px solid ${accent}66; color:${accent}; border-radius: 10px; cursor: pointer; transition: all 0.2s ease;"
                            data-id="${escapeHtml(m.id)}" data-choice="${escapeHtml(outcome.key)}" data-title="${safeTitle}">${escapeHtml(outcome.label)}</button>`;
                    }).join('')}
                </div>
            </div>

            ${renderProbabilityChart(m)}
            ${renderOrderBookShell(m)}

            <div style="border-top: 1px solid rgba(0,255,136,0.1); padding-top: 18px; margin-top: 20px;">
                ${m.displayHeadline || m.title ? `<p style="color:#999; font-size: 0.85rem; margin-bottom: 18px; background: rgba(100,100,100,0.1); padding: 12px; border-left: 3px solid #00ff88; border-radius: 6px;">
                    <strong style="color:#00ff88;">Headline:</strong> ${escapeHtml(m.displayHeadline || m.title)}
                </p>` : ''}
                ${renderMarketLiveInfo(m)}
                ${renderResolutionInfo(m)}
            </div>

            <div id="match-center-container"></div>
        </div>

        <style>
            @keyframes pulse {
                0% { opacity: 1; transform: scale(1); }
                50% { opacity: 0.4; transform: scale(1.2); }
                100% { opacity: 1; transform: scale(1); }
            }
        </style>
    `;
}

function renderDefaultModal(m, info, media) {
    const safeTitle = escapeHtml(m.title || "");
    const boostLabel = Number(m.is_boosted) === 1 ? `<div style="margin-top:10px; display:inline-block; padding:8px 12px; border-radius:999px; background: rgba(255,214,0,0.12); color:#ffd60a; border:1px solid rgba(255,214,0,0.2); font-size:0.75rem; font-weight:700;">Elite Boosted Market +10%</div>` : '';
    
    return `
        ${media}
        <h2 style="color:white; font-weight:800; margin-top: 15px;">${escapeHtml(m.title)}</h2>
        ${boostLabel}
        
        <div id="persona-transmission-container"></div>

        <div class="betting-row" style="display:flex; gap:10px; margin: 20px 0;">
            ${getMarketOutcomes(m).map(outcome => {
                const accent = outcomeAccent(outcome.key);
                const odds = Number(outcome.odds);
                return `
                <button class="bet-btn" style="flex:1; min-width:0; color:${accent}; border-color:${accent}44; background:${accent}18;"
                    data-id="${escapeHtml(m.id)}" data-choice="${escapeHtml(outcome.key)}" data-title="${safeTitle}">
                    ${escapeHtml(outcome.label)}${Number.isFinite(odds) && odds > 0 ? ` (${odds.toFixed(2)})` : ''}
                </button>`;
            }).join('')}
        </div>

        <div id="match-center-container"></div>

        <div style="margin-top: 25px;">
            ${renderMarketLiveInfo(m)}
            ${renderProbabilityChart(m)}
            ${renderOrderBookShell(m)}
            <p style="color:#71767b; line-height:1.5; font-size: 0.9rem; margin-bottom: 20px;">${linkify(escapeHtml(info))}</p>
            ${m.url ? `<p style="color:#999; font-size:0.85rem; margin-top: 10px;">Source: <a href="${escapeHtml(m.url)}" target="_blank" rel="noopener noreferrer" style="color:#00ff88; text-decoration:none;">${escapeHtml(m.source || m.url)}</a></p>` : ''}
            ${renderResolutionInfo(m)}
        </div>
    `;
}

async function quickBet(id, choice, btn) {
    const card = btn.closest('.market-card');
    const amountInput = card.querySelector('.bet-amount');
    const stake = parseFloat(amountInput.value);

    if (isNaN(stake) || stake < 1) {
        alert("Please enter a valid stake (Min 1 sKES)");
        return;
    }

    try {
        const response = await window.placeBet(id, choice, stake);

        if (response) {
            if (typeof renderUserHistory === "function") {
                await renderUserHistory(); 
            }
            
            console.log("Bet successfully reflected in history.");
        }
    } catch (error) {
        console.error("Bet placement failed:", error);
    }
}
function handleOutsideClick(e) {
    const betModal = document.getElementById('bet-modal');
    if (betModal && betModal.style.display === 'flex') {
        if (e.target === betModal) {
            window.closeBetModal();
            return; 
        }
    }

    const historyCenter = document.getElementById('historyCenter');
    if (historyCenter && historyCenter.classList.contains('active')) {
        const historyWindow = historyCenter.querySelector('.history-window');
        if (e.target === historyCenter) {
            toggleHistory();
        }
    }

    const accountCenter = document.getElementById('accountCenter');
    const accountCard = document.querySelector(".account-card");

    if (accountCenter && accountCenter.style.display !== 'none') {
        if (e.target === accountCenter || (accountCard && !accountCard.contains(e.target))) {
            toggleAccountCenter();
        }
    }
}

window.handleOutsideClick = handleOutsideClick;

document.addEventListener("click", (e) => {
    if (e.target.closest('#matchView')) return;
    const modal = document.getElementById('bet-modal');
    if (modal && modal.style.display === 'flex') return;

    const marketCard = e.target.closest(".market-card");
    if (marketCard && !e.target.closest(".bet-btn")) {
        const id = marketCard.dataset.id;
        if (id) openMarket(id);
    }

    const betBtn = e.target.closest(".bet-btn");
    if (betBtn) {
        const id = betBtn.dataset.id;
        const choice = betBtn.dataset.choice;
        const title = betBtn.dataset.title; // Make sure this is added to your HTML
        
        if (id && choice) {
            window.openBetModal(id, title || "New Bet", choice);
        }
    }
});

document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;

    const marketCard = e.target.closest?.(".market-card");
    if (!marketCard || e.target.closest(".bet-btn")) return;

    e.preventDefault();
    const id = marketCard.dataset.id;
    if (id) openMarket(id);
});

window.renderHistory = function() {
    // Target the specific list view inside the tab, not the whole container
    const container = document.getElementById("predictions-list-view") || 
                      document.getElementById("bet-container");
                      
    if (!container) return;

    const bets = window.allBets || [];
    if (!bets.length) {
        container.innerHTML = `<div class="empty-state">No predictions found...</div>`;
        return;
    }

   const filtered = bets.filter(bet => {
    const status = (bet.status || "").toLowerCase();

    if (window.state.currentHistoryTab === "active")
        return ["pending", "active", "open"].includes(status);

    if (window.state.currentHistoryTab === "won")
        return ["won", "win"].includes(status);

    if (window.state.currentHistoryTab === "lost")
        return ["lost", "lose"].includes(status);

    if (window.state.currentHistoryTab === "cancelled")
        return ["cancelled", "void"].includes(status);

    return true;
});

    if (!filtered.length) {
        container.innerHTML = `<div class="empty-state">No ${window.state.currentHistoryTab} bets</div>`;
        return;
    }

    container.innerHTML = filtered.map(renderBetCard).join("");
console.log("Statuses:", allBets.map(b => b.status));
}


let pendingBet = null;

window.openBetModal = function (marketId, title, pick, price = null, contract = null) {
    if (!localStorage.getItem("token")) {
        if (requireAuth()) return;
    }

    pendingBet = {
        marketId,
        title: title || "Market",
        pick,
        price: Number.isFinite(Number(price)) ? Number(price) : null,
        contract
    };

    const titleEl = document.getElementById('modal-market-title');
    const pickEl = document.getElementById('modal-pick-display');

    // Show the outcome's own label (the team name on a sports market) rather
    // than the internal key.
    const market = window.marketMap?.[marketId];
    const outcome = market ? getMarketOutcomes(market).find(item => item.key === pick) : null;
    const pickLabel = outcome ? outcome.label : pick;

    if (titleEl) titleEl.innerText = pendingBet.title;
    if (pickEl) {
        const terms = pendingBet.price && pendingBet.price > 1
            ? ` · Odds @${pendingBet.price.toFixed(2)} (${(100 / pendingBet.price).toFixed(1)}% implied)` : '';
        pickEl.innerText = `Your Pick: ${contract?.selection || pickLabel}${terms}`;
    }

    const input = document.getElementById('bet-amount-input');
    if (input) input.value = 10;

    const modal = document.getElementById('bet-modal');
    if (modal) modal.style.display = 'flex';
};
function closeBetModal() {
    const modal = document.getElementById("bet-modal");
    if (modal) modal.style.display = "none";
    pendingBet = null;
}
async function processConfirmedBet() {
    if (!pendingBet) {
        alert("No market selected");
        return;
    }

    const amountInput = document.getElementById('bet-amount-input');
    const amount = parseFloat(amountInput.value);

    if (!amount || amount <= 0) {
        alert("Please enter a valid amount");
        return;
    }

    const btn = document.getElementById('confirm-proceed-btn');
    btn.disabled = true;
    btn.innerText = "Placing Bet...";

    try {
        const succeeded = await window.placeBet({
            marketId: pendingBet.marketId,
            outcome: pendingBet.pick,
            amount,
            price: pendingBet.price,
            contract: pendingBet.contract
        });

        if (succeeded) {
            closeBetModal();
        }
    } catch (err) {
        console.error("Bet error:", err);
        alert("Connection error. Try again.");
    } finally {
        btn.disabled = false;
        btn.innerText = "Proceed";
    }
}

function toggleHistory() {
    const el = document.getElementById("historyCenter");
    if (!el) return;

    const isOpening = !el.classList.contains("active");

    el.classList.toggle("active");

    if (isOpening) {
        loadHistory();
    }
}

function openHistory() {
    const el = document.getElementById("historyCenter");
    if (!el) return;

    el.classList.add("active");
    loadHistory();
}

function loadHistory() {
    const currentTab = window.state?.currentHistoryTab || "active";
    if (typeof window.switchBetTab === "function") {
        window.switchBetTab(currentTab);
    }
}

function closeHistory() {
    const el = document.getElementById("historyCenter");
    if (!el) return;

    el.classList.remove("active");
}

window.toggleHistory = toggleHistory;
window.openHistory = openHistory;
window.closeHistory = closeHistory;
window.loadHistory = loadHistory;

function closeModal() {
    closeMarket();
    closeBetModal();
}

window.closeBetModal = closeBetModal;
window.processConfirmedBet = processConfirmedBet;

/**
 * CLEANUP ON LOAD
 */
document.addEventListener('DOMContentLoaded', () => {
    const withdrawBtn = document.getElementById('confirmWithdrawBtn');
    if (withdrawBtn) {
        // Only attach if the element actually exists
        console.log("Withdrawal listener attached safely.");
    }
    if (window.API && typeof window.API.switchBetTab === 'function') {
        window.API.switchBetTab('active');
    } else if (typeof switchBetTab === 'function') {
        switchBetTab('active');
    }
});
async function loadMarketsFallback() {
    try {
        const res = await fetch(window.apiUrl('/api/markets'));
        const data = await res.json();

        const markets =
            data?.markets ||
            data?.data ||
            (Array.isArray(data) ? data : []);

        state.allMarkets = markets;
        state.filteredMarkets = markets;
        window.allMarketsSource = markets;
        syncMarketMap(markets);

        if (typeof renderFilteredMarkets === "function") {
            renderFilteredMarkets();
        }

        if (typeof renderTrending === "function") {
            renderTrending();
        }

    } catch (err) {
        console.error("Fallback market load failed:", err);
    }
}
async function loadGreeting() {
    const greetingEl = document.getElementById("greetingText");
    const metaEl = document.getElementById("greetingMeta");
    const wrapper = document.querySelector(".greeting-wrapper");

    // Time-based greeting
    const hour = Number(new Intl.DateTimeFormat("en-GB", {
        timeZone: "Africa/Nairobi",
        hour: "2-digit",
        hour12: false
    }).format(new Date()));
    let greeting = "Hello";

    if (hour < 12) greeting = "Good morning ☀️";
    else if (hour < 17) greeting = "Good afternoon 🌤️";
    else greeting = "Good evening 🌙";

    greetingEl.textContent = greeting;

    try {
        const position = await new Promise((resolve, reject) => {
            if (!navigator.geolocation) return reject(new Error("No geolocation"));
            navigator.geolocation.getCurrentPosition(resolve, reject, {
                enableHighAccuracy: true,
                timeout: 8000,
                maximumAge: 10 * 60 * 1000
            });
        });

        const { latitude, longitude } = position.coords;
        const contextRes = await fetch(window.apiUrl(`/api/user/context?lat=${latitude}&lon=${longitude}`));
        const context = await contextRes.json();
        let gpsPlace = "";

        try {
            const reverseRes = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${latitude}&lon=${longitude}`);
            const reverse = await reverseRes.json();
            gpsPlace = reverse.address?.city ||
                reverse.address?.town ||
                reverse.address?.suburb ||
                reverse.address?.county ||
                "";
        } catch {
            gpsPlace = "";
        }

        if (context?.city && context.city !== "Unknown") {
            const weather = context.temp && context.temp !== "--"
                ? ` • ${context.temp}°C • ${context.condition || "Current weather"}`
                : "";
            metaEl.textContent = `📍 ${gpsPlace || context.city}${context.country ? `, ${context.country}` : ""}${weather}`;
        } else {
            throw new Error("Server location unavailable");
        }

    } catch (e) {
        try {
            const contextRes = await fetch(window.apiUrl("/api/user/context"));
            const context = await contextRes.json();
            if (context?.city) {
                const weather = context.temp && context.temp !== "--"
                    ? ` • ${context.temp}°C • ${context.condition || "Current weather"}`
                    : "";
                metaEl.textContent = `📍 ${context.city}${context.country ? `, ${context.country}` : ""}${weather}`;
            } else {
                throw new Error("Browser location unavailable");
            }
        } catch {
            const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "Africa/Nairobi";
            metaEl.textContent = `📍 ${zone.replace("_", " ")}`;
        }
    }
    // 🔥 Trigger animation AFTER content is set
    setTimeout(() => {
        wrapper.classList.add("greeting-show");
    }, 50);
}
window.fetchMarkets = async function() {
    try {
        const marketResult = await apiFetch('/api/markets');

        const marketResponse = marketResult?.data || marketResult;
        const markets = Array.isArray(marketResponse) ? marketResponse :
            (Array.isArray(marketResponse?.markets) ? marketResponse.markets :
            (Array.isArray(marketResponse?.data) ? marketResponse.data : []));
        let supplementalMarkets = [];

        const mergeAndRender = (newsMarkets = []) => {
            const newsById = new Map(supplementalMarkets.filter(item => item?.id).map(item => [item.id, item]));
            for (const item of newsMarkets) {
                if (item?.id && !newsById.has(item.id)) newsById.set(item.id, item);
            }
            supplementalMarkets = [...newsById.values()];

            const marketsById = new Map();
            for (const item of markets) {
                if (item?.id) marketsById.set(item.id, item);
            }
            for (const item of supplementalMarkets) {
                if (!item?.id) continue;
                const isGeneratedNews = /^(news_|tech_|geo_)/i.test(String(item.id));
                // News sync can refresh an article's category or title while
                // /api/markets is loading. Prefer that updated article row so it
                // appears under the correct News or Politics filter.
                if (!marketsById.has(item.id) || isGeneratedNews) marketsById.set(item.id, item);
            }
            const merged = [...marketsById.values()];

            state.allMarkets = merged;
            state.filteredMarkets = merged;
            window.allMarketsSource = merged;
            syncMarketMap(merged);

            if (document.getElementById("marketsList") || document.getElementById("ongoing")) {
                applyStateAndRender();
                renderTrending();
                if (document.getElementById("greetingText")) { loadGreeting(); }
            }
            return merged;
        };

        const merged = mergeAndRender();

        apiFetch('/api/sports/categories').then(sportsResponse => {
            const categoryResult = sportsResponse?.data || sportsResponse;
            state.sportsCategories = Array.isArray(categoryResult?.sports) ? categoryResult.sports : [];
            // The backend can recover an empty football cache while loading
            // categories; merge those freshly synced fixtures into this page
            // even though the initial /api/markets request already completed.
            mergeAndRender(Array.isArray(categoryResult?.footballMarkets) ? categoryResult.footballMarkets : []);
        }).catch(error => console.warn("Sports categories deferred:", error.message));

        // The main market board should never wait on the external news provider.
        apiFetch('/api/news/everything').then(newsResponse => {
            const responseData = newsResponse?.data || newsResponse;
            const newsMarkets = Array.isArray(responseData?.articles) ? responseData.articles :
                (Array.isArray(responseData?.markets) ? responseData.markets :
                (Array.isArray(responseData?.data) ? responseData.data : []));
            if (newsMarkets.length) mergeAndRender(newsMarkets);
        }).catch(error => console.warn("News sync deferred:", error.message));

        return { markets: state.allMarkets || merged };

    } catch (err) {
        console.error("❌ Elite Fetch failed:", err);
        return { markets: window.state.allMarkets || [] };
    }
}

