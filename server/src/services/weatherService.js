import axios from 'axios';
import { generateMarketFromNews } from './marketGenerator.js';

const WEATHER_API_BASE = 'https://api.weatherapi.com/v1';
const AGRICULTURE_REGIONS = [
  { id: 'kenya-coffee', name: 'Central Kenya coffee belt', city: 'Nyeri', crop: 'coffee', country: 'Kenya', lat: -0.4167, lon: 36.95 },
  { id: 'kenya-tea', name: 'Kenya Rift Valley tea belt', city: 'Kericho', crop: 'tea', country: 'Kenya', lat: -0.3676, lon: 35.2831 },
  { id: 'uganda-coffee', name: 'Uganda coffee belt', city: 'Mbale', crop: 'coffee', country: 'Uganda', lat: 1.0644, lon: 34.1794 },
  { id: 'ethiopia-coffee', name: 'Ethiopian coffee belt', city: 'Jimma', crop: 'coffee', country: 'Ethiopia', lat: 7.6667, lon: 36.8333 },
  { id: 'tanzania-coffee', name: 'Northern Tanzania coffee belt', city: 'Kilimanjaro', crop: 'coffee', country: 'Tanzania', lat: -3.0674, lon: 37.3556 },
  { id: 'brazil-coffee', name: 'Minas Gerais coffee belt', city: 'Varginha', crop: 'coffee', country: 'Brazil', lat: -21.5514, lon: -45.4303 },
  { id: 'vietnam-coffee', name: 'Central Highlands coffee belt', city: 'Buon Ma Thuot', crop: 'coffee', country: 'Vietnam', lat: 12.6667, lon: 108.05 },
  { id: 'india-tea', name: 'Assam tea belt', city: 'Dibrugarh', crop: 'tea', country: 'India', lat: 27.4728, lon: 94.912 },
  { id: 'kenya-maize', name: 'Kenya maize belt', city: 'Eldoret', crop: 'maize', country: 'Kenya', lat: 0.5143, lon: 35.2698 }
];
const LOCAL_CONTEXT_LOCATIONS = [
  { id: 'nairobi-kenya', name: 'Nairobi metropolitan area', city: 'Nairobi', country: 'Kenya', lat: -1.2864, lon: 36.8172 },
  { id: 'mombasa-kenya', name: 'Mombasa coast', city: 'Mombasa', country: 'Kenya', lat: -4.0435, lon: 39.6682 },
  { id: 'kisumu-kenya', name: 'Kisumu and Lake Victoria', city: 'Kisumu', country: 'Kenya', lat: -0.0917, lon: 34.768 },
  { id: 'kampala-uganda', name: 'Kampala metropolitan area', city: 'Kampala', country: 'Uganda', lat: 0.3476, lon: 32.5825 },
  { id: 'dar-es-salaam-tanzania', name: 'Dar es Salaam coast', city: 'Dar es Salaam', country: 'Tanzania', lat: -6.7924, lon: 39.2083 },
  { id: 'addis-ababa-ethiopia', name: 'Addis Ababa metropolitan area', city: 'Addis Ababa', country: 'Ethiopia', lat: 8.9806, lon: 38.7578 }
];
const WEATHER_OPERATIONAL_REGIONS = [
  {
    id: 'mombasa-coast', name: 'Mombasa coast', city: 'Mombasa', country: 'Kenya', lat: -4.0435, lon: 39.6682,
    activities: [
      { id: 'fishing', label: 'small-boat fishing', impact: 'High winds can restrict nearshore boat trips.', metric: 'high_wind', threshold: 35, unit: 'km/h', title: 'Will high winds disrupt small-boat fishing near Mombasa?' },
      { id: 'film-production', label: 'outdoor film production', impact: 'Rain can interrupt outdoor filming and equipment setup.', metric: 'rain', threshold: 1, unit: 'mm', title: 'Will rain disrupt outdoor film production near Mombasa?' },
      { id: 'content-creation', label: 'outdoor content creation', impact: 'Rain can interrupt outdoor shoots and live content production.', metric: 'rain', threshold: 1, unit: 'mm', title: 'Will rain disrupt outdoor content production near Mombasa?' },
      { id: 'open-air-market', label: 'open-air goods markets', impact: 'Rain can disrupt outdoor stalls and the movement of goods.', metric: 'rain', threshold: 1, unit: 'mm', title: 'Will rain disrupt open-air goods markets near Mombasa?' }
    ]
  },
  {
    id: 'kisumu-lake', name: 'Kisumu and Lake Victoria shore', city: 'Kisumu', country: 'Kenya', lat: -0.0917, lon: 34.768,
    activities: [
      { id: 'fishing', label: 'small-boat fishing', impact: 'High winds can restrict lake fishing trips.', metric: 'high_wind', threshold: 35, unit: 'km/h', title: 'Will high winds disrupt small-boat fishing near Kisumu?' },
      { id: 'film-production', label: 'outdoor film production', impact: 'Rain can interrupt outdoor filming and equipment setup.', metric: 'rain', threshold: 1, unit: 'mm', title: 'Will rain disrupt outdoor film production near Kisumu?' },
      { id: 'open-air-market', label: 'open-air goods markets', impact: 'Rain can disrupt outdoor stalls and the movement of goods.', metric: 'rain', threshold: 1, unit: 'mm', title: 'Will rain disrupt open-air goods markets near Kisumu?' }
    ]
  },
  {
    id: 'nairobi-metro', name: 'Nairobi metropolitan area', city: 'Nairobi', country: 'Kenya', lat: -1.2864, lon: 36.8172,
    activities: [
      { id: 'film-production', label: 'outdoor film production', impact: 'Rain can interrupt outdoor filming and equipment setup.', metric: 'rain', threshold: 1, unit: 'mm', title: 'Will rain disrupt outdoor film production in Nairobi?' },
      { id: 'content-creation', label: 'outdoor content creation', impact: 'Rain can interrupt outdoor shoots and live content production.', metric: 'rain', threshold: 1, unit: 'mm', title: 'Will rain disrupt outdoor content production in Nairobi?' },
      { id: 'open-air-market', label: 'open-air goods markets', impact: 'Rain can disrupt outdoor stalls and the movement of goods.', metric: 'rain', threshold: 1, unit: 'mm', title: 'Will rain disrupt open-air goods markets in Nairobi?' }
    ]
  },
  {
    id: 'turkana-mining', name: 'Turkana mining area', city: 'Lodwar', country: 'Kenya', lat: 3.1191, lon: 35.5973,
    activities: [
      { id: 'surface-mining', label: 'surface mining access', impact: 'Heavy rain can affect unpaved access roads and surface operations.', metric: 'rain', threshold: 20, unit: 'mm', title: 'Will heavy rain disrupt surface mining access in Turkana?' },
      { id: 'open-air-market', label: 'open-air goods markets', impact: 'Rain can disrupt outdoor stalls and the movement of goods.', metric: 'rain', threshold: 1, unit: 'mm', title: 'Will rain disrupt open-air goods markets in Lodwar?' }
    ]
  }
];

function getWeatherApiKey() {
  return String(process.env.WEATHER_API_KEY || '').trim();
}

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function summarizeForecast(region, data) {
  const forecastDays = (data.forecast?.forecastday || []).map(item => ({
    date: item.date,
    condition: item.day?.condition?.text || 'Forecast available',
    rainChance: toNumber(item.day?.daily_chance_of_rain),
    totalPrecipMm: toNumber(item.day?.totalprecip_mm),
    avgTempC: toNumber(item.day?.avgtemp_c),
    maxTempC: toNumber(item.day?.maxtemp_c),
    minTempC: toNumber(item.day?.mintemp_c),
    maxWindKph: toNumber(item.day?.maxwind_kph),
    humidity: toNumber(item.day?.avghumidity),
    icon: item.day?.condition?.icon ? `https:${item.day.condition.icon}` : null
  }));
  const avgRainChance = forecastDays.length
    ? forecastDays.reduce((sum, day) => sum + (day.rainChance || 0), 0) / forecastDays.length
    : null;
  const avgTemp = forecastDays.length
    ? forecastDays.reduce((sum, day) => sum + (day.avgTempC || 0), 0) / forecastDays.length
    : null;
  // This is a short-range forecast deviation, not a long-term climate anomaly.
  const anomalies = forecastDays.map(day => ({
    date: day.date,
    rainfallSignal: day.rainChance != null && avgRainChance != null
      ? (day.rainChance <= 15 && avgRainChance >= 35 ? 'below-forecast-window-average' : 'within-forecast-window-range')
      : 'unavailable',
    temperatureDeviationC: day.avgTempC != null && avgTemp != null ? Math.round((day.avgTempC - avgTemp) * 10) / 10 : null
  }));
  return {
    region: { id: region.id, name: region.name, city: region.city, crop: region.crop, country: region.country, lat: region.lat, lon: region.lon },
    observedAt: data.current?.last_updated || new Date().toISOString(),
    current: {
      condition: data.current?.condition?.text || null,
      tempC: toNumber(data.current?.temp_c),
      humidity: toNumber(data.current?.humidity),
      windKph: toNumber(data.current?.wind_kph),
      precipMm: toNumber(data.current?.precip_mm)
    },
    forecastDays,
    anomalies,
    alerts: Array.isArray(data.alerts?.alert) ? data.alerts.alert.map(alert => ({ headline: alert.headline, severity: alert.severity, effective: alert.effective, expires: alert.expires })) : [],
    provider: 'WeatherAPI'
  };
}

export async function fetchAgricultureWeather({ regionId, query, days = 3 } = {}) {
  const key = getWeatherApiKey();
  if (!key) throw new Error('WEATHER_API_KEY is not configured.');
  const region = AGRICULTURE_REGIONS.find(item => item.id === regionId)
    || AGRICULTURE_REGIONS.find(item => query && `${item.name} ${item.city} ${item.country} ${item.crop}`.toLowerCase().includes(String(query).toLowerCase()))
    || AGRICULTURE_REGIONS[0];
  const response = await axios.get(`${WEATHER_API_BASE}/forecast.json`, {
    params: { key, q: `${region.lat},${region.lon}`, days: Math.max(1, Math.min(Number(days) || 3, 7)), alerts: 'yes', aqi: 'no' },
    timeout: 12000
  });
  return summarizeForecast(region, response.data || {});
}

async function fetchRegionWeather(region, days = 3) {
  const key = getWeatherApiKey();
  if (!key) throw new Error('WEATHER_API_KEY is not configured.');
  const response = await axios.get(`${WEATHER_API_BASE}/forecast.json`, {
    params: { key, q: `${region.lat},${region.lon}`, days: Math.max(1, Math.min(Number(days) || 3, 7)), alerts: 'yes', aqi: 'no' },
    timeout: 12000
  });
  return summarizeForecast(region, response.data || {});
}

export async function getRegionalWeatherContext(query = '') {
  const text = String(query || '').toLowerCase();
  const local = WEATHER_OPERATIONAL_REGIONS.find(item => text.includes(item.city.toLowerCase()) || text.includes(item.name.toLowerCase()))
    || LOCAL_CONTEXT_LOCATIONS.find(item => text.includes(item.city.toLowerCase()));
  const region = AGRICULTURE_REGIONS.find(item => [item.city, item.country, item.crop, item.name].some(value => text.includes(value.toLowerCase()))) || AGRICULTURE_REGIONS[0];
  try {
    const target = local || region;
    const weather = await fetchRegionWeather(target, 3);
    const impacts = (target.activities || []).map(activity => {
      const affected = weather.forecastDays.some(day => activity.metric === 'high_wind'
        ? day.maxWindKph != null && day.maxWindKph >= activity.threshold
        : day.totalPrecipMm != null && day.totalPrecipMm >= activity.threshold);
      return affected ? `${activity.label}: ${activity.impact}` : '';
    }).filter(Boolean);
    return `Regional weather context from ${weather.provider}, fetched ${weather.observedAt}: ${weather.region.name} (${weather.region.city}, ${weather.region.country})${weather.region.crop ? `, important for ${weather.region.crop}` : ''}. Current ${weather.current.condition || 'conditions unavailable'}, ${weather.current.tempC ?? 'unknown'} C. ${weather.forecastDays.map(day => `${day.date}: ${day.condition}, ${day.rainChance ?? 'unknown'}% rain chance, ${day.totalPrecipMm ?? 'unknown'} mm forecast precipitation, ${day.maxWindKph ?? 'unknown'} km/h max wind, ${day.avgTempC ?? 'unknown'} C average`).join('; ')}.${impacts.length ? ` Potential weather-sensitive activity impacts based on forecast thresholds: ${impacts.join(' ')}` : ''} This is forecast context, not a commodity-price forecast.`;
  } catch (error) {
    console.warn('[weather] SokoBot context unavailable:', error.message);
    return '';
  }
}

function isMaterialAgricultureSignal(weather) {
  return weather.forecastDays.some(day => (day.rainChance != null && day.rainChance <= 10 && day.totalPrecipMm != null && day.totalPrecipMm < 1)
    || (day.maxTempC != null && day.maxTempC >= 36));
}

export async function syncWeatherCommodityDrafts({ dbGet, dbRun, onSynced } = {}) {
  if (typeof dbGet !== 'function' || typeof dbRun !== 'function') throw new TypeError('Weather draft sync requires database helpers.');
  const summary = { regions: 0, proposals: 0, skipped: 0, errors: 0 };
  for (const region of AGRICULTURE_REGIONS) {
    summary.regions++;
    try {
      const weather = await fetchAgricultureWeather({ regionId: region.id, days: 3 });
      if (!isMaterialAgricultureSignal(weather)) { summary.skipped++; continue; }
      const target = weather.forecastDays.find(day => (day.rainChance != null && day.rainChance <= 10 && day.totalPrecipMm != null && day.totalPrecipMm < 1) || (day.maxTempC != null && day.maxTempC >= 36));
      if (!target || new Date(`${target.date}T23:59:59.000Z`) <= new Date()) { summary.skipped++; continue; }
      const anomaly = weather.anomalies.find(item => item.date === target.date);
      const id = `weather_crop_${region.id}_${target.date.replace(/-/g, '')}`;
      if (await dbGet('SELECT id FROM markets WHERE id=?', [id])) { summary.skipped++; continue; }
      const deadlineAt = new Date(`${target.date}T23:59:59.000Z`).toISOString();
      const targetMetric = target.maxTempC != null && target.maxTempC >= 36 ? 'heat' : 'dry';
      const evidence = `${region.name} ${region.country} growing ${region.crop}. WeatherAPI forecast for ${target.date}: ${target.condition}; rain chance ${target.rainChance}%; expected total precipitation ${target.totalPrecipMm} mm; mean temperature ${target.avgTempC} C; maximum ${target.maxTempC} C. Within this short forecast window, rainfall signal is ${anomaly?.rainfallSignal || 'unavailable'} and average-temperature deviation is ${anomaly?.temperatureDeviationC ?? 'unavailable'} C; these are not long-term climate anomalies. This forecast indicates a ${targetMetric === 'heat' ? 'heat' : 'dry-weather'} risk to ${region.crop} production. Resolve against the WeatherAPI historical archive for the named location and date; do not infer a market price or price movement from weather.`;
      const generated = await generateMarketFromNews({
        title: `Weather risk to ${region.crop} in ${region.name}`,
        body: evidence,
        marketTopic: 'agriculture and commodities',
        country: region.country,
        requiredDeadline: deadlineAt,
        imageUrl: target.icon
      });
      const marketTitle = targetMetric === 'heat'
        ? `Will ${region.crop} in ${region.name} face heat stress?`
        : `Will ${region.crop} in ${region.name} face a dry spell?`;
      const resolutionCriteria = targetMetric === 'heat'
        ? `YES if the WeatherAPI historical archive lists a maximum temperature of at least 36 C in ${region.city}, ${region.country} on ${target.date}; otherwise NO.`
        : `YES if the WeatherAPI historical archive lists less than 1 mm total precipitation in ${region.city}, ${region.country} on ${target.date}; otherwise NO.`;
      const content = JSON.stringify({
        marketHeader: generated.marketHeader,
        actionEvent: generated.actionEvent,
        subject: generated.subject,
        condition: generated.condition,
        deadlineAt: generated.deadlineAt,
        resolutionCriteria,
        weatherOracle: { provider: 'WeatherAPI', location: region.city, country: region.country, date: target.date, crop: region.crop, metric: targetMetric, threshold: targetMetric === 'heat' ? { maxTempCMin: 36 } : { totalPrecipMmMax: 1 }, forecast: target },
        proposalType: 'weather-commodity-risk'
      });
      await dbRun(`INSERT INTO markets (id, title, description, content, media_url, media_type, category, country, sideA, sideB, startTime, event_start_time, event_end_time, status, creator, ai_generated, ai_headline_generated, admin_verified)
        VALUES (?, ?, ?, ?, ?, 'image', 'weather', ?, 'YES', 'NO', ?, CURRENT_TIMESTAMP, ?, 'draft', 'weather-worker', 1, 1, 0)
        ON CONFLICT(id) DO NOTHING`, [id, marketTitle, resolutionCriteria, content, target.icon, region.country, deadlineAt, deadlineAt]);
      summary.proposals++;
    } catch (error) {
      summary.errors++;
      console.warn(`[weather] draft proposal failed for ${region.name}:`, error.message);
    }
  }
  if (summary.proposals && typeof onSynced === 'function') await onSynced(summary);
  return summary;
}

export async function syncWeatherOperationalDrafts({ dbGet, dbRun, onSynced, maxProposals = Number(process.env.WEATHER_MAX_DAILY_DRAFTS) || 12 } = {}) {
  if (typeof dbGet !== 'function' || typeof dbRun !== 'function') throw new TypeError('Weather draft sync requires database helpers.');
  const summary = { regions: 0, proposals: 0, skipped: 0, errors: 0 };
  const cap = Math.max(1, Math.min(Number(maxProposals) || 12, 30));
  for (const region of WEATHER_OPERATIONAL_REGIONS) {
    if (summary.proposals >= cap) break;
    summary.regions++;
    try {
      const weather = await fetchRegionWeather(region, 3);
      for (const activity of region.activities) {
        if (summary.proposals >= cap) break;
        const target = weather.forecastDays.find(day => activity.metric === 'high_wind'
          ? day.maxWindKph != null && day.maxWindKph >= activity.threshold
          : day.totalPrecipMm != null && day.totalPrecipMm >= activity.threshold);
        if (!target || new Date(`${target.date}T23:59:59.000Z`) <= new Date()) { summary.skipped++; continue; }
        const id = `weather_impact_${region.id}_${activity.id}_${target.date.replace(/-/g, '')}`;
        if (await dbGet('SELECT id FROM markets WHERE id=?', [id])) { summary.skipped++; continue; }
        const deadlineAt = new Date(`${target.date}T23:59:59.000Z`).toISOString();
        const measured = activity.metric === 'high_wind' ? target.maxWindKph : target.totalPrecipMm;
        const condition = activity.metric === 'high_wind'
          ? `WeatherAPI historical archive lists maximum wind speed of at least ${activity.threshold} km/h in ${region.city}, ${region.country} on ${target.date}.`
          : `WeatherAPI historical archive lists total precipitation of at least ${activity.threshold} mm in ${region.city}, ${region.country} on ${target.date}.`;
        const resolutionCriteria = `YES if ${condition} This is a measurable weather proxy for the stated operational risk, not confirmation that a business actually stopped work; otherwise NO.`;
        const evidence = `${region.name}, ${region.country}. WeatherAPI forecast for ${target.date}: ${target.condition}; total precipitation ${target.totalPrecipMm} mm; rain chance ${target.rainChance}%; maximum wind ${target.maxWindKph} km/h; average temperature ${target.avgTempC} C. Forecast threshold signal for ${activity.label}: ${measured} ${activity.unit}, reaching at least ${activity.threshold} ${activity.unit}. Potential impact: ${activity.impact} Propose an objectively resolvable binary weather-risk market using only this forecast and resolve from the WeatherAPI historical archive. Do not claim that weather definitely stopped production.`;
        let generated;
        try {
          generated = await generateMarketFromNews({
            title: `${activity.label} weather outlook in ${region.name}`,
            body: evidence,
            marketTopic: 'regional weather and production outlook',
            country: region.country,
            requiredDeadline: deadlineAt,
            imageUrl: target.icon
          });
        } catch (error) {
          summary.errors++;
          console.warn(`[weather] operational draft rejected for ${activity.label} in ${region.name}:`, error.message);
          continue;
        }
        const content = JSON.stringify({
          marketHeader: generated.marketHeader,
          actionEvent: generated.actionEvent,
          subject: activity.label,
          condition: `weather risk in ${region.name} on ${target.date}`,
          deadlineAt,
          resolutionCriteria,
          weatherOracle: {
            provider: 'WeatherAPI', location: region.city, country: region.country, date: target.date,
            metric: activity.metric, threshold: activity.metric === 'high_wind' ? { maxWindKphMin: activity.threshold } : { totalPrecipMmMin: activity.threshold },
            activity: activity.label, impact: activity.impact, forecast: target
          },
          proposalType: 'regional-weather-operational-risk'
        });
        await dbRun(`INSERT INTO markets (id, title, description, content, media_url, media_type, category, country, sideA, sideB, startTime, event_start_time, event_end_time, status, creator, ai_generated, ai_headline_generated, admin_verified)
          VALUES (?, ?, ?, ?, ?, 'image', 'weather', ?, 'YES', 'NO', ?, CURRENT_TIMESTAMP, ?, 'draft', 'weather-worker', 1, 1, 0)
          ON CONFLICT(id) DO NOTHING`, [id, activity.title, resolutionCriteria, content, target.icon, region.country, deadlineAt, deadlineAt]);
        summary.proposals++;
      }
    } catch (error) {
      summary.errors++;
      console.warn(`[weather] operational forecast failed for ${region.name}:`, error.message);
    }
  }
  if (summary.proposals && typeof onSynced === 'function') await onSynced(summary);
  return summary;
}

export async function resolveWeatherImpactMarket(market) {
  let contract;
  try { contract = typeof market.content === 'string' ? JSON.parse(market.content) : market.content; }
  catch { return null; }
  const oracle = contract?.weatherOracle;
  if (oracle?.provider !== 'WeatherAPI' || !oracle.location || !oracle.date || !['dry', 'heat', 'rain', 'high_wind'].includes(oracle.metric)) return null;
  const deadline = Date.parse(contract.deadlineAt || market.event_end_time || market.startTime || '');
  if (!Number.isFinite(deadline) || deadline > Date.now()) return null;
  const key = getWeatherApiKey();
  if (!key) return null;
  try {
    // WeatherAPI describes history as archived forecast data, not verified station actuals.
    const response = await axios.get(`${WEATHER_API_BASE}/history.json`, {
      params: { key, q: `${oracle.location}, ${oracle.country || ''}`, dt: oracle.date },
      timeout: 12000
    });
    const day = response.data?.forecast?.forecastday?.[0]?.day;
    if (!day) return null;
    const observedValue = Number(oracle.metric === 'heat' ? day.maxtemp_c : oracle.metric === 'high_wind' ? day.maxwind_kph : day.totalprecip_mm);
    const threshold = Number(oracle.metric === 'heat' ? oracle.threshold?.maxTempCMin
      : oracle.metric === 'high_wind' ? oracle.threshold?.maxWindKphMin
        : oracle.metric === 'dry' ? oracle.threshold?.totalPrecipMmMax : oracle.threshold?.totalPrecipMmMin);
    if (!Number.isFinite(observedValue) || !Number.isFinite(threshold)) return null;
    if (oracle.metric === 'dry') return observedValue < threshold ? 'YES' : 'NO';
    return observedValue >= threshold ? 'YES' : 'NO';
  } catch (error) {
    console.warn(`[weather settlement] Historical observation unavailable for ${oracle.location} ${oracle.date}:`, error.message);
    return null;
  }
}

export const resolveWeatherCommodityMarket = resolveWeatherImpactMarket;

export { AGRICULTURE_REGIONS };
