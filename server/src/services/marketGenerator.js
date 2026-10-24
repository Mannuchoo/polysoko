import OpenAI from 'openai';
import { getGeminiApiKey, getGeminiModel, isGroqRateLimitError } from './aiProvider.js';

const DEFAULT_GROQ_MODEL = 'openai/gpt-oss-120b';

const clean = value => typeof value === 'string' ? value.trim() : '';

// Exact deadlines belong in event_end_time/deadlineAt. Keep ISO timestamps out
// of the human-facing question even when an upstream generator appends one.
export function sanitizeMarketQuestionTitle(value) {
  return String(value || '')
    .replace(/\s+by\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2}))\s*\??$/i, (_match, timestamp) => {
      const contractDate = new Date(`${timestamp.slice(0, 10)}T00:00:00.000Z`);
      if (!Number.isFinite(contractDate.getTime())) return '?';
      const displayDate = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(contractDate);
      return ` by ${displayDate}?`;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

// Reject common transitive verbs when the question supplies only a location
// or other preposition after the verb (for example, "restore in Ukraine").
// That construction has no observable object or outcome to settle.
const TRANSITIVE_ACTIONS_REQUIRING_OBJECT = new Set([
  'restore', 'rebuild', 'reconstruct', 'repair', 'fix', 'fund', 'finance',
  'provide', 'supply', 'deliver', 'bring', 'send', 'give', 'take', 'raise',
  'announce', 'confirm', 'cancel', 'approve', 'reject', 'release', 'deploy',
  'acquire', 'buy', 'sell', 'create', 'produce', 'make', 'sign', 'impose'
]);

export function inspectMarketQuestionTitle(value) {
  const title = sanitizeMarketQuestionTitle(value);
  const body = title.replace(/\?$/, '').trim();
  const actionPattern = new RegExp(`\\b(${[...TRANSITIVE_ACTIONS_REQUIRING_OBJECT].join('|')})\\s+(in|at|on|by|for|to|from|with|during|across|within)\\b`, 'i');
  const incomplete = body.match(actionPattern);
  if (incomplete) {
    return { valid: false, reason: `"${incomplete[1]}" needs a specific object or outcome before "${incomplete[2]}".` };
  }
  return { valid: true, reason: '' };
}

export function assertMarketQuestionTitle(value) {
  const inspection = inspectMarketQuestionTitle(value);
  if (!inspection.valid) throw new Error(`Market question is incomplete: ${inspection.reason}`);
  return sanitizeMarketQuestionTitle(value);
}

function validHttpUrl(value) {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function validateDeadline(value, now = new Date()) {
  const deadline = clean(value);
  const exactTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(deadline);
  if (!exactTimestamp) throw new Error('The generated market must include an exact ISO 8601 timestamp with timezone.');
  const parsed = new Date(deadline);
  const calendarDate = deadline.slice(0, 10);
  const [year, month, day] = calendarDate.split('-').map(Number);
  const validCalendarDate = Number.isInteger(year) && Number.isInteger(month) && Number.isInteger(day)
    && new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) === calendarDate;
  if (!validCalendarDate || !Number.isFinite(parsed.getTime()) || parsed <= now) {
    throw new Error('The generated market deadline must be a valid future date and time.');
  }
  return { date: parsed.toISOString().slice(0, 10), timestamp: parsed.toISOString() };
}

function formatStrictMarketTitle({ subject, actionEvent, condition, deadlineAt }) {
  const fields = [subject, actionEvent, condition].map(value => clean(value));
  if (fields.some(value => !value) || !clean(deadlineAt)) throw new Error('Strict market title requires action/event, subject, condition, and exact deadline.');
  if (/\b(might|could|possibly|perhaps|likely|unlikely|depends)\b/i.test(fields.slice(0, 3).join(' '))) {
    throw new Error('The generated market is not a definitive Yes/No outcome.');
  }
  if (fields.some(value => value.includes(' + '))) throw new Error('Market title fields cannot contain the title separator.');
  if (/^(?:will|shall|does|do|did|is|are|was|were|has|have)\b/i.test(actionEvent)) {
    throw new Error('The event must use a bare verb phrase after the subject, without an extra auxiliary verb.');
  }
  if (/\b(?:threatens|revokes|retains|reaches|announces|resigns|approves|rejects|becomes|remains|wins|loses)\b/i.test(actionEvent)) {
    throw new Error('The event verb must use its base form after "Will" so the headline is grammatical.');
  }
  const subjectText = subject.replace(/[?!.]+$/, '');
  const actionText = actionEvent.replace(/[?!.]+$/, '').replace(/^[A-Z]/, first => first.toLowerCase());
  // Groq may put the contract deadline into condition despite the prompt.
  // The title is a readable question; the exact cutoff remains in deadlineAt.
  const conditionText = condition
    .replace(/\s+by\s+(?:\d{4}-\d{2}-\d{2}\b.*|[A-Za-z]+\s+\d{1,2},?\s+\d{4}\b.*|\d{1,2}\s+[A-Za-z]+\s+\d{4}\b.*)$/i, '')
    .replace(/[?!.]+$/, '')
    .trim();
  return `Will ${subjectText} ${actionText} ${conditionText}?`;
}

export async function generateMarketFromNews(rawArticleData) {
  const apiKey = String(process.env.GROQ_API_KEY || '').trim();
  if (!apiKey) throw new Error('GROQ_API_KEY is not configured.');
  const article = rawArticleData && typeof rawArticleData === 'object' ? rawArticleData : {};
  const title = clean(article.title || article.headline);
  const body = clean(article.body || article.content || article.description);
  if (!title || !body) throw new Error('News payload must include a title and body.');

  const media = article.media && typeof article.media === 'object' ? article.media : {};
  const suppliedImage = validHttpUrl(article.imageUrl || article.image_url || article.urlToImage || media.imageUrl || media.image_url);
  const suppliedVideo = validHttpUrl(article.videoUrl || article.video_url || media.videoUrl || media.video_url || media.embedUrl);
  const suppliedDeadline = clean(article.requiredDeadline);
  const required = suppliedDeadline ? validateDeadline(suppliedDeadline) : null;
  const marketTopic = clean(article.marketTopic || article.topic || 'market');
  const country = clean(article.country || article.marketCountry || '');
  const source = clean(article.source?.name || article.source || '');
  const newsStory = /news|sports|politics|technology|developing/i.test(marketTopic);
  const topicGuidance = newsStory
    ? `This is ${marketTopic}${country ? ` coverage for ${country}` : ''}${source ? ` from ${source}` : ''}. Prefer a Kenya-specific developing story whenever the source is Kenyan; preserve the real people, institutions, places, and events named by the source. First decide whether the decisive event/outcome is still in the future. Reject stories whose election, match, award, vote, announcement, or other decisive event already happened, or whose result/winner is already known, even if the article is recent. Reporting about completed events is not a future prediction market. Use only concrete upcoming events or unresolved developing stories with an observable future result. Reject evergreen topics, opinion, vague speculation, and stories with no explicit future milestone supported by the source.`
    : `This is a ${marketTopic} market${country ? ` for ${country}` : ''}${source ? ` from ${source}` : ''}. Extract a concise, objectively resolvable event grounded in the supplied data.`;
  const horizonGuidance = newsStory ? 'News and sports news deadlines must be at least 48 hours from now.' : 'Use the trusted deadline exactly when one is supplied.';
  const prompt = `Extract one objectively resolvable prediction market from this source. Use only facts supported by the source. ${topicGuidance}\n\nReturn a concise marketHeader: a plain, short display headline of 4–9 words, no more than 72 characters, grounded in the source. It should name the subject and developing action, contain no filler or source attribution, and not be phrased as a question.\n\nAlso extract all four required resolution components in this order: [Action/Event], [Subject], [Condition], [Exact Timestamp/Deadline]. The question title must be a natural, grammatically correct Yes/No question: "Will [Subject] [Action/Event] [Condition]?" Never append a date, timestamp, time, or by-deadline phrase to the question title. Keep the exact deadline only in the separate deadline field and resolution criteria. Use the subject before its action in that question. The action/event must be a bare verb phrase in base form after "Will" ("pass the bill", never "passes the bill" and never "will pass the bill"). The condition must be a short phrase that reads naturally after the action and identifies the relevant context or resolution source. Keep all fields concise and avoid duplicated subjects or deadlines. The deadline must be an exact future ISO 8601 timestamp with timezone and must be the actual future milestone in the source, not a deadline invented from when the article was fetched. ${horizonGuidance} ${required ? `Use this trusted deadline exactly, without changing it: ${required.timestamp}.` : 'For news, use only a concrete future date/time explicitly supported by the supplied source. If the source does not establish an upcoming milestone with a deadline at least 48 hours from now, or if the decisive event/result already happened, return empty strings for marketHeader, subject, actionEvent, condition, deadline, and resolutionCriteria.'} Resolution criteria must define one observable Yes/No rule and the source/event used to settle it. Do not make up media links; return supplied media URLs only. If the subject, developing action, condition, or resolution cannot be grounded in the source, return empty mandatory fields.\n\nSource title: ${title}\nSource body: ${body}\nCountry/context: ${country || 'not specified'}\nTopic: ${marketTopic}\nTrusted deadline: ${required?.timestamp || 'none'}\nImage URL: ${suppliedImage || ''}\nVideo URL: ${suppliedVideo || ''}`;

  const client = new OpenAI({ apiKey, baseURL: 'https://api.groq.com/openai/v1', maxRetries: 0 });
  const request = {
    model: String(process.env.GROQ_MODEL || DEFAULT_GROQ_MODEL).trim(),
    temperature: 0.1,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: 'Extract one concise, source-grounded, objectively resolvable prediction market. For news and sports news, reject events already completed or outcomes already known. Never invent future milestones or deadlines to turn completed news into a market. If not marketable, return empty strings for marketHeader, subject, actionEvent, condition, deadline, and resolutionCriteria. Return only a JSON object with marketHeader, subject, actionEvent, condition, deadline, resolutionCriteria, imageUrl, and videoUrl fields. Every field must be a string. Keep marketHeader to 72 characters or fewer.' },
      { role: 'system', content: 'Do not attach the date, timestamp, time, or a by-deadline phrase to the question title. Keep the exact timestamp in the separate deadline field and resolution criteria.' },
      { role: 'user', content: prompt }
    ]
  };
  let response;
  try {
    response = await client.chat.completions.create(request);
  } catch (error) {
    const geminiKey = getGeminiApiKey();
    if (!isGroqRateLimitError(error) || !geminiKey) throw error;
    console.warn('[ai] Groq rate limit reached for market generation; retrying with Gemini.');
    response = await new OpenAI({ apiKey: geminiKey, baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/', maxRetries: 0 }).chat.completions.create({
      ...request,
      model: getGeminiModel()
    });
  }
  const text = response.choices?.[0]?.message?.content;
  if (!text) throw new Error('Groq returned an empty structured response.');
  let result;
  try { result = JSON.parse(text); }
  catch { throw new Error('Groq returned invalid JSON for the market context check.'); }

  const subject = clean(result.subject);
  const actionEvent = clean(result.actionEvent);
  const condition = clean(result.condition);
  const marketHeader = clean(result.marketHeader).replace(/\s+/g, ' ');
  const resolutionCriteria = clean(result.resolutionCriteria);
  const headerWords = marketHeader ? marketHeader.split(/\s+/).length : 0;
  if (marketHeader.length > 72 || headerWords < 4 || headerWords > 9 || marketHeader.includes('?')) {
    throw new Error('Groq output is missing a concise 4–9 word market header (maximum 72 characters, no question mark).');
  }
  if (!subject || !actionEvent || !condition || !resolutionCriteria) {
    throw new Error('Groq output is missing an action event, subject, condition, or resolution criteria.');
  }
  if (resolutionCriteria.length < 15 || /\b(might|could|possibly|perhaps|likely|unlikely|depends)\b/i.test(resolutionCriteria)) {
    throw new Error('The generated resolution rule must settle to a definitive Yes or No.');
  }
  const deadline = validateDeadline(result.deadline);
  if (newsStory && deadline.timestamp <= new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString()) {
    throw new Error('News markets require a source-supported future milestone at least 48 hours away.');
  }
  if (required && deadline.timestamp !== required.timestamp) throw new Error('Groq changed the supplied exact deadline; the market was not accepted.');
  const imageUrl = suppliedImage || validHttpUrl(result.imageUrl);
  const videoUrl = suppliedVideo || validHttpUrl(result.videoUrl);

  const questionTitle = assertMarketQuestionTitle(formatStrictMarketTitle({ actionEvent, subject, condition, deadlineAt: deadline.timestamp }));
  return {
    title: questionTitle,
    marketHeader,
    subject,
    actionEvent,
    condition,
    deadline: deadline.date,
    deadlineAt: deadline.timestamp,
    resolutionCriteria,
    imageUrl,
    videoUrl
  };
}

export { validateDeadline };
export { formatStrictMarketTitle };
