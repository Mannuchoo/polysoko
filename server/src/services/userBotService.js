import OpenAI from 'openai';
import { getGeminiApiKey, getGeminiModel, isGroqRateLimitError } from './aiProvider.js';
import { getRegionalWeatherContext } from './weatherService.js';

// Groq retired the previous Llama default for developer-tier projects in
// August 2026. Keep this on a currently supported model unless overridden.
const DEFAULT_MODEL = 'openai/gpt-oss-120b';
const REQUEST_TIMEOUT_MS = 25000;
let groqClient;
let geminiClient;
function getGroqClient() {
  const apiKey = String(process.env.GROQ_API_KEY || '').trim();
  if (!apiKey) throw new Error('GROQ_API_KEY is not configured.');
  if (!groqClient) groqClient = new OpenAI({ apiKey, baseURL: 'https://api.groq.com/openai/v1', maxRetries: 0 });
  return groqClient;
}
function getGeminiClient() {
  const apiKey = getGeminiApiKey();
  if (!apiKey) throw new Error('Gemini fallback is not configured.');
  if (!geminiClient) geminiClient = new OpenAI({ apiKey, baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/', maxRetries: 0 });
  return geminiClient;
}
const MARKET_VISIBILITY = `
  status IN ('open', 'upcoming', 'live') AND COALESCE(settled, 0)=0
  AND (COALESCE(admin_verified, 0)=1 OR LOWER(COALESCE(category,'')) IN ('sports','football','soccer')
       OR LOWER(COALESCE(sport,'')) <> '' OR id LIKE 'sp_%' OR id LIKE 'fb_%' OR country='Football')
  AND (id NOT LIKE 'news_%' AND id NOT LIKE 'tech_%' AND id NOT LIKE 'geo_%'
       AND id NOT LIKE 'tmdb_%' AND id NOT LIKE 'crypto_%' AND id NOT LIKE 'env_%'
       OR COALESCE(ai_headline_generated,0)=1)`;

const YES_PRICE_SQL = `CASE
    WHEN UPPER(COALESCE(sideA,'')) IN ('YES','LIKELY') AND COALESCE(oddsA,0)+COALESCE(oddsB,0)>0
      THEN COALESCE(oddsB,0)/(oddsA+oddsB)
    WHEN UPPER(COALESCE(sideB,'')) IN ('YES','LIKELY') AND COALESCE(oddsA,0)+COALESCE(oddsB,0)>0
      THEN COALESCE(oddsA,0)/(oddsA+oddsB)
    ELSE NULL
  END`;
// A three-way sports market quotes three outcomes, so its "Yes price" is the
// favourite's share of the implied probability across all three.
const THREE_WAY_PRICE_SQL = `CASE
    WHEN COALESCE(sideC,'') <> '' AND COALESCE(oddsC,0) > 1
      AND COALESCE(oddsA,0) + COALESCE(oddsB,0) + COALESCE(oddsC,0) > 0
      THEN GREATEST(
        COALESCE(oddsA,0) * COALESCE(oddsB,0),
        COALESCE(oddsA,0) * COALESCE(oddsC,0),
        COALESCE(oddsB,0) * COALESCE(oddsC,0)
      ) / (COALESCE(oddsA,0) * COALESCE(oddsB,0)
         + COALESCE(oddsA,0) * COALESCE(oddsC,0)
         + COALESCE(oddsB,0) * COALESCE(oddsC,0))
    ELSE NULL
  END`;
const MARKET_FIELDS = `id, title, category, sideA, sideB, sideC, oddsA, oddsB, oddsC,
  COALESCE(home_volume,0) + COALESCE(away_volume,0) + COALESCE(draw_volume,0) AS volume,
  ${YES_PRICE_SQL} AS yes_price,
  ${THREE_WAY_PRICE_SQL} AS three_way_price`;

// A market is priced by whichever model applies to it: binary markets report
// their Yes price, three-way sports markets report their favourite's share.
const priceFor = row => (row.three_way_price != null ? Number(row.three_way_price) : (row.yes_price == null ? null : Number(row.yes_price)));

export async function getHighRiskMarkets(dbAll) {
  if (typeof dbAll !== 'function') throw new Error('Market database reader is required.');
  const rows = await dbAll(`SELECT ${MARKET_FIELDS} FROM markets WHERE ${MARKET_VISIBILITY}
    AND ((${YES_PRICE_SQL}) <= 0.20 OR (${YES_PRICE_SQL}) >= 0.80
         OR (${THREE_WAY_PRICE_SQL}) <= 0.20 OR (${THREE_WAY_PRICE_SQL}) >= 0.80)
    ORDER BY volume DESC, timestamp DESC LIMIT 12`);
  return rows.map(row => ({ ...row, yes_price: priceFor(row), volume: Number(row.volume) }));
}

export async function getTrendingMarkets(dbAll) {
  if (typeof dbAll !== 'function') throw new Error('Market database reader is required.');
  const rows = await dbAll(`SELECT ${MARKET_FIELDS} FROM markets WHERE ${MARKET_VISIBILITY}
    ORDER BY volume DESC, timestamp DESC LIMIT 12`);
  return rows.map(row => ({
    ...row,
    yes_price: priceFor(row),
    volume: Number(row.volume)
  }));
}

const marketTools = [
  { type: 'function', function: { name: 'getHighRiskMarkets', description: 'Find active verified Yes/No markets with a Yes price at or below 0.20 or at or above 0.80. Present these as higher-risk price extremes and explain that price is not a guarantee.', parameters: { type: 'object', properties: {}, additionalProperties: false } } },
  { type: 'function', function: { name: 'getTrendingMarkets', description: 'Find active verified markets ordered by combined trading volume.', parameters: { type: 'object', properties: {}, additionalProperties: false } } }
];

const systemPrompt = `You are PolySoko AI, also known as PolySoko Bot, the PolySoko prediction market assistant. Help users understand the platform and find markets using the supplied market tools. When discussing a market, use its exact title, category, Yes price when available, and trading volume; never invent market data or claim an outcome is certain. High-risk prices are informational, not financial advice or guaranteed payouts. Do not place bets, promise account actions, or request passwords, OTPs, payment details, or private keys. Keep responses concise and friendly. If a user asks for trending or high-odds/high-risk markets, call the matching tool.`;

export async function processUserBotMessage({ message, history = [], dbAll }) {
  const safeHistory = Array.isArray(history) ? history.slice(-8).map(item => ({
    role: item?.role === 'assistant' ? 'assistant' : 'user',
    content: String(item?.text || item?.content || '').slice(0, 1000)
  })).filter(item => item.content) : [];
  if (safeHistory.at(-1)?.role === 'user' && safeHistory.at(-1)?.content === String(message).slice(0, 1000)) safeHistory.pop();
  const userMessage = String(message).slice(0, 2000);
  const weatherRelevant = /\b(weather|rain|drought|flood|heat|storm|road|transport|logistic|supply chain|harvest|crop|coffee|tea|maize|economic|economy|local condition|event outlook|event|outlook|outdoor|travel condition)\b/i.test(userMessage);
  const weatherContext = weatherRelevant ? await getRegionalWeatherContext(userMessage) : '';
  const contextPrompt = weatherContext
    ? `${systemPrompt}\n\nUse this real-time regional weather context only when it helps answer the user's question. Distinguish observations from forecasts, state the location and dates, and do not infer commodity prices or logistics disruptions that the data does not establish.\n${weatherContext}`
    : systemPrompt;
  const messages = [{ role: 'system', content: contextPrompt }, ...safeHistory, { role: 'user', content: userMessage }];
  const toolHandlers = { getHighRiskMarkets: () => getHighRiskMarkets(dbAll), getTrendingMarkets: () => getTrendingMarkets(dbAll) };

  const runProvider = async ({ client, model, provider }) => {
    const providerMessages = messages.map(item => ({ ...item }));
    for (let turn = 0; turn < 4; turn++) {
      const payload = await client.chat.completions.create({
        model,
        messages: providerMessages,
        tools: marketTools,
        tool_choice: 'auto',
        temperature: 0.3,
        max_tokens: 600
      }, { timeout: REQUEST_TIMEOUT_MS });
      const choice = payload.choices?.[0];
      if (!choice?.message) throw new Error('Groq returned an empty chat response.');
      providerMessages.push(choice.message);
      const calls = choice.message.tool_calls || [];
      if (!calls.length) {
        const reply = String(choice.message.content || '').trim();
        if (!reply) throw new Error(`${provider} returned an empty chat response.`);
        return { reply, model: payload.model || model, provider };
      }
      for (const call of calls) {
        const name = call.function?.name;
        const handler = toolHandlers[name];
        const result = handler ? await handler() : { error: 'Unknown market tool.' };
        providerMessages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
      }
    }
    throw new Error(`${provider} could not finish the market lookup.`);
  };
  try {
    return await runProvider({ client: getGroqClient(), model: String(process.env.GROQ_MODEL || DEFAULT_MODEL).trim(), provider: 'Groq' });
  } catch (error) {
    const geminiKey = getGeminiApiKey();
    if (!isGroqRateLimitError(error) || !geminiKey) throw error;
    console.warn('[sokobot] Groq rate limit reached; retrying with Gemini.');
    return runProvider({ client: getGeminiClient(), model: getGeminiModel(), provider: 'Gemini' });
  }
}
