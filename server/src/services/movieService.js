import axios from 'axios';
import { generateMarketFromNews, sanitizeMarketQuestionTitle } from './marketGenerator.js';

const TMDB_BASE = 'https://api.themoviedb.org/3';
const DEFAULT_MILESTONE = 1_000_000_000;
const clean = value => String(value ?? '').trim();
let trendingCache = null;
let trendingCacheUntil = 0;
let trendingRequest = null;

export function isMovieDataConfigured() {
  return Boolean(clean(process.env.MOVIE_API_KEY || process.env.TMDB_API_KEY || process.env.TMDB_READ_ACCESS_TOKEN));
}

function tmdbAuth() {
  const apiKey = clean(process.env.MOVIE_API_KEY || process.env.TMDB_API_KEY);
  const token = clean(process.env.TMDB_READ_ACCESS_TOKEN);
  if (!apiKey && !token) throw new Error('TMDB credentials are not configured on the running backend. Set MOVIE_API_KEY, TMDB_API_KEY, or TMDB_READ_ACCESS_TOKEN, then redeploy.');
  return {
    params: apiKey ? { api_key: apiKey } : {},
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    timeout: 12000
  };
}

async function tmdbGet(path, params = {}) {
  const auth = tmdbAuth();
  const response = await axios.get(`${TMDB_BASE}${path}`, { ...auth, params: { ...auth.params, language: 'en-US', ...params } });
  return response.data;
}

function calculateHype(movie) {
  const popularity = Math.max(0, Number(movie.popularity) || 0);
  const voteAverage = Math.max(0, Math.min(10, Number(movie.vote_average) || 0));
  const voteCount = Math.max(0, Number(movie.vote_count) || 0);
  // TMDB popularity is not a probability. This normalized composite is only a
  // comparative badge, using provider popularity plus rating and vote depth.
  const popularityScore = Math.min(100, Math.log1p(popularity) / Math.log(301) * 100);
  const ratingScore = voteCount ? voteAverage * 10 : 0;
  const voteDepthScore = Math.min(100, Math.log1p(voteCount) / Math.log(10001) * 100);
  const hypeScore = Math.round(popularityScore * 0.55 + ratingScore * 0.30 + voteDepthScore * 0.15);
  return { hypeScore, hypeLabel: hypeScore >= 75 ? 'High hype' : hypeScore >= 45 ? 'Rising' : 'Steady', popularity, voteAverage, voteCount, hypeSource: 'TMDB popularity and vote metrics' };
}

function serializeVideos(videoRows = []) {
  return (Array.isArray(videoRows) ? videoRows : [])
    .filter(video => video?.key && ['YouTube', 'Vimeo'].includes(video.site) && ['Trailer', 'Teaser', 'Clip', 'Featurette', 'Behind the Scenes'].includes(video.type))
    .map(video => {
      const isYouTube = video.site === 'YouTube';
      const encodedKey = encodeURIComponent(video.key);
      return {
        id: clean(video.id),
        name: clean(video.name) || video.type,
        type: video.type,
        site: video.site,
        official: Boolean(video.official),
        publishedAt: video.published_at || null,
        watchUrl: isYouTube ? `https://www.youtube.com/watch?v=${encodedKey}` : `https://vimeo.com/${encodedKey}`,
        embedUrl: isYouTube ? `https://www.youtube-nocookie.com/embed/${encodedKey}` : null
      };
    })
    .sort((a, b) => Number(b.official) - Number(a.official) || (a.type === 'Trailer' ? -1 : 0) - (b.type === 'Trailer' ? -1 : 0))
    .slice(0, 12);
}

function serializeMovie(movie) {
  const hype = calculateHype(movie);
  return {
    id: Number(movie.id),
    title: clean(movie.title || movie.original_title),
    overview: clean(movie.overview),
    releaseDate: movie.release_date || null,
    posterUrl: movie.poster_path ? `https://image.tmdb.org/t/p/w500${movie.poster_path}` : null,
    backdropUrl: movie.backdrop_path ? `https://image.tmdb.org/t/p/w780${movie.backdrop_path}` : null,
    videos: serializeVideos(movie.videos?.results),
    ...hype
  };
}

export async function getTrendingMovies({ limit = 12 } = {}) {
  if (trendingCache && trendingCacheUntil > Date.now()) return trendingCache.slice(0, Math.max(1, Math.min(Number(limit) || 12, 20)));
  if (trendingRequest) return (await trendingRequest).slice(0, Math.max(1, Math.min(Number(limit) || 12, 20)));
  trendingRequest = (async () => {
    const data = await tmdbGet('/trending/movie/week', { page: 1 });
    const items = (Array.isArray(data.results) ? data.results : []).slice(0, 12);
    const enriched = await Promise.all(items.map(async item => {
      try { return serializeMovie(await tmdbGet(`/movie/${encodeURIComponent(item.id)}`, { append_to_response: 'videos' })); }
      catch { return serializeMovie(item); }
    }));
    trendingCache = enriched.filter(movie => movie.id && movie.title);
    trendingCacheUntil = Date.now() + 15 * 60 * 1000;
    return trendingCache;
  })();
  try { return (await trendingRequest).slice(0, Math.max(1, Math.min(Number(limit) || 12, 20))); }
  finally { trendingRequest = null; }
}

export async function getMovieDetails(movieId) {
  const id = String(movieId ?? '').trim();
  if (!/^\d{1,12}$/.test(id)) throw new Error('A valid movie ID is required.');
  let movie;
  try {
    movie = await tmdbGet(`/movie/${encodeURIComponent(id)}`, { append_to_response: 'videos' });
  } catch {
    movie = await tmdbGet(`/movie/${encodeURIComponent(id)}`);
    movie.videos = await tmdbGet(`/movie/${encodeURIComponent(id)}/videos`).catch(() => ({ results: [] }));
  }
  const videos = serializeVideos(movie.videos?.results);
  const trailer = videos.find(item => item.type === 'Trailer' && item.official) || videos.find(item => item.type === 'Trailer') || videos.find(item => item.type === 'Teaser');
  return {
    ...serializeMovie(movie),
    revenue: Number(movie.revenue) || 0,
    budget: Number(movie.budget) || 0,
    status: movie.status || null,
    homepage: movie.homepage || null,
    tmdbUrl: `https://www.themoviedb.org/movie/${id}`,
    trailerUrl: trailer?.watchUrl || null
  };
}

function targetDeadline(movie, now = new Date()) {
  const release = movie.releaseDate && /^\d{4}-\d{2}-\d{2}$/.test(movie.releaseDate)
    ? new Date(`${movie.releaseDate}T00:00:00.000Z`)
    : null;
  const futureRelease = release && release > now ? release : null;
  const deadline = new Date((futureRelease || now).getTime() + (futureRelease ? 90 : 180) * 24 * 60 * 60 * 1000);
  deadline.setUTCHours(23, 59, 59, 0);
  return deadline.toISOString();
}

export async function generateMovieMarketDraft(movieId, { dbGet, dbRun, creator } = {}) {
  if (typeof dbGet !== 'function' || typeof dbRun !== 'function') throw new TypeError('Movie market generation requires database helpers.');
  const movie = await getMovieDetails(movieId);
  const threshold = DEFAULT_MILESTONE;
  if (movie.revenue >= threshold) throw new Error('This movie has already passed the selected box office milestone; choose another market milestone.');
  const deadlineAt = targetDeadline(movie);
  const dateLabel = deadlineAt.slice(0, 10);
  const existing = await dbGet(`SELECT id FROM markets WHERE category='movies' AND content LIKE ? LIMIT 1`, [`%"tmdbMovieId":${movie.id}%`]);
  if (existing) return { created: false, movie, market: existing, message: 'A draft for this movie is already in the admin review queue.' };

  const sourceBody = [
    `TMDB movie ID: ${movie.id}.`,
    `Title: ${movie.title}.`,
    `Overview: ${movie.overview || 'No overview provided by TMDB.'}`,
    `Release date: ${movie.releaseDate || 'not announced'}.`,
    `Current cumulative box office revenue reported by TMDB: ${movie.revenue}.`,
    `Contract: determine whether cumulative worldwide box office revenue will be greater than USD ${threshold} by ${dateLabel}.`,
    `Resolution source: TMDB movie details revenue field, checked after the contract deadline. Popularity score: ${movie.popularity}; vote average: ${movie.voteAverage}; vote count: ${movie.voteCount}.`
  ].join('\n');
  const generated = await generateMarketFromNews({
    title: `${movie.title} worldwide box office milestone`,
    body: sourceBody,
    marketTopic: 'movies and film',
    country: 'International',
    requiredDeadline: deadlineAt,
    imageUrl: movie.posterUrl,
    videoUrl: movie.trailerUrl
  });
  const question = sanitizeMarketQuestionTitle(`Will ${movie.title} gross over $1B worldwide by ${dateLabel}?`);
  const id = `movie_${movie.id}_${dateLabel.replace(/-/g, '')}`;
  const resolutionCriteria = `YES if TMDB reports cumulative worldwide movie revenue above USD ${threshold} after ${deadlineAt}; otherwise NO. Check the TMDB movie details revenue field for movie ${movie.id}.`;
  const content = JSON.stringify({
    marketHeader: generated.marketHeader,
    actionEvent: 'gross over $1B',
    subject: movie.title,
    condition: `worldwide box office revenue by ${dateLabel}`,
    deadlineAt,
    resolutionCriteria,
    tmdbMovieId: movie.id,
    boxOfficeOracle: { provider: 'TMDB', threshold, currency: 'USD', comparison: 'greater-than', checkAfter: deadlineAt },
    movie: { title: movie.title, releaseDate: movie.releaseDate, popularity: movie.popularity, voteAverage: movie.voteAverage, voteCount: movie.voteCount, hypeScore: movie.hypeScore, tmdbUrl: movie.tmdbUrl, trailerUrl: movie.trailerUrl }
  });
  const mediaUrl = movie.posterUrl || movie.backdropUrl;
  const result = await dbRun(`INSERT INTO markets (id, title, description, content, category, country, sideA, sideB, startTime, event_start_time, event_end_time, status, media_url, media_type, image_url, video_url, creator, ai_generated, ai_headline_generated, admin_verified)
    VALUES (?, ?, ?, ?, 'movies', 'International', 'YES', 'NO', ?, CURRENT_TIMESTAMP, ?, 'draft', ?, ?, ?, ?, ?, 1, 1, 0)
    ON CONFLICT(id) DO NOTHING`, [id, question, resolutionCriteria, content, deadlineAt, deadlineAt, mediaUrl, movie.trailerUrl ? 'video' : 'image', mediaUrl, movie.trailerUrl, creator || 'movie-market-generator']);
  return { created: result?.changes !== 0, movie, market: { id, title: question, description: resolutionCriteria, category: 'movies', status: 'draft', deadlineAt, hypeScore: movie.hypeScore, content } };
}

export async function resolveMovieBoxOffice(market) {
  let contract;
  try { contract = typeof market.content === 'string' ? JSON.parse(market.content) : market.content; }
  catch { return null; }
  const oracle = contract?.boxOfficeOracle;
  const movieId = contract?.tmdbMovieId;
  if (String(oracle?.provider || '').toLowerCase() !== 'tmdb' || !movieId || !Number.isFinite(Number(oracle.threshold))) return null;
  const deadline = Date.parse(oracle.checkAfter || market.event_end_time || market.startTime || '');
  if (!Number.isFinite(deadline) || deadline > Date.now()) return null;
  try {
    const details = await getMovieDetails(movieId);
    if (!details.revenue || details.revenue < 0) return null;
    return details.revenue > Number(oracle.threshold) ? 'YES' : 'NO';
  } catch (error) {
    console.warn(`[movie settlement] TMDB lookup failed for ${movieId}:`, error.message);
    return null;
  }
}
