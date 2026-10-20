const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash'];

const OUTPUT_SCHEMA = {
  type: 'OBJECT',
  properties: {
    subject: { type: 'STRING' },
    actionEvent: { type: 'STRING', description: 'A concise bare verb phrase in base form that follows "Will [subject]" grammatically. Example: "threaten to revoke", never "threatens to revoke" or "will threaten to revoke".' },
    condition: { type: 'STRING', description: 'A concise context phrase that reads naturally after the action, preferably introduced by a preposition such as at, in, for, under, or during. Do not repeat the deadline.' },
    deadline: { type: 'STRING', description: 'An exact future ISO 8601 timestamp with timezone, preferably YYYY-MM-DDTHH:mm:ss.sssZ.' },
    resolutionCriteria: { type: 'STRING' },
    imageUrl: { type: 'STRING', description: 'Use an empty string when there is no supported image URL.' },
    videoUrl: { type: 'STRING', description: 'Use an empty string when there is no supported video URL.' }
  },
  required: ['subject', 'actionEvent', 'condition', 'deadline', 'resolutionCriteria', 'imageUrl', 'videoUrl']
};

const clean = value => typeof value === 'string' ? value.trim() : '';

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
  const fields = [subject, actionEvent, condition, deadlineAt].map(value => clean(value));
  if (fields.some(value => !value)) throw new Error('Strict market title requires action/event, subject, condition, and exact deadline.');
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
  const conditionText = condition.replace(/[?!.]+$/, '');
  return `Will ${subjectText} ${actionText} ${conditionText} by ${deadlineAt}?`;
}

export async function generateMarketFromNews(rawArticleData) {
  if (!process.env.GOOGLE_API_KEY) throw new Error('GOOGLE_API_KEY is not configured.');
  const article = rawArticleData && typeof rawArticleData === 'object' ? rawArticleData : {};
  const title = clean(article.title || article.headline);
  const body = clean(article.body || article.content || article.description);
  if (!title || !body) throw new Error('News payload must include a title and body.');

  const media = article.media && typeof article.media === 'object' ? article.media : {};
  const suppliedImage = validHttpUrl(article.imageUrl || article.image_url || article.urlToImage || media.imageUrl || media.image_url);
  const suppliedVideo = validHttpUrl(article.videoUrl || article.video_url || media.videoUrl || media.video_url || media.embedUrl);
  const suppliedDeadline = clean(article.requiredDeadline);
  const required = suppliedDeadline ? validateDeadline(suppliedDeadline) : null;
  const prompt = `Extract one objectively resolvable prediction market from this source. Use only facts supported by the source. Extract all four required components in this order: [Action/Event], [Subject], [Condition], [Exact Timestamp/Deadline]. The displayed title will be phrased as a natural, grammatically correct Yes/No question: "Will [Subject] [Action/Event] [Condition] by [Exact Timestamp/Deadline]?" Use the subject before its action in that question. The action/event must be a bare verb phrase in base form after "Will" ("threaten to revoke", never "threatens to revoke" and never "will threaten"). The condition must be a short phrase that reads naturally after the action, preferably beginning with a preposition such as "at", "in", "for", "under", or "during". Keep the event and condition concise, avoid duplicated subjects or deadlines, and use correct capitalization, possessives, articles, and punctuation. The deadline must be an exact future ISO 8601 timestamp with timezone. If no trusted deadline is supplied and the source does not support an explicit future deadline, return an empty deadline. ${required ? `Use this trusted deadline exactly, without changing it: ${required.timestamp}.` : ''} Condition must name the relevant context or resolution source; do not leave it empty. Resolution criteria must define one observable Yes/No rule and the source/event used to settle it. Do not make up media links; return supplied media URLs only. If the subject/action/context cannot be grounded in the source or the result is not definitively resolvable, return empty mandatory fields.\n\nSource title: ${title}\nSource body: ${body}\nTrusted deadline: ${required?.timestamp || 'none'}\nImage URL: ${suppliedImage || ''}\nVideo URL: ${suppliedVideo || ''}`;

  let result;
  let lastError;
  for (const model of GEMINI_MODELS) {
    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(process.env.GOOGLE_API_KEY)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.1,
            responseMimeType: 'application/json',
            responseSchema: OUTPUT_SCHEMA
          }
        })
      });
      if (!response.ok) {
        const detail = await response.text();
        const error = new Error(`Gemini API request failed (${response.status}): ${detail.slice(0, 500)}`);
        if ([400, 404].includes(response.status)) { lastError = error; continue; }
        throw error;
      }
      const payload = await response.json();
      const text = payload.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('');
      if (!text) throw new Error('Gemini returned an empty structured response.');
      result = JSON.parse(text);
      break;
    } catch (error) {
      lastError = error;
      if (error instanceof SyntaxError) break;
      if (String(error.message).includes('(400)') || String(error.message).includes('(404)')) continue;
      throw error;
    }
  }
  if (!result) throw lastError || new Error('Gemini could not generate a market.');

  const subject = clean(result.subject);
  const actionEvent = clean(result.actionEvent);
  const condition = clean(result.condition);
  const resolutionCriteria = clean(result.resolutionCriteria);
  if (!subject || !actionEvent || !condition || !resolutionCriteria) {
    throw new Error('Gemini output is missing an action event, subject, condition, or resolution criteria.');
  }
  if (resolutionCriteria.length < 15 || /\b(might|could|possibly|perhaps|likely|unlikely|depends)\b/i.test(resolutionCriteria)) {
    throw new Error('The generated resolution rule must settle to a definitive Yes or No.');
  }
  const deadline = validateDeadline(result.deadline);
  if (required && deadline.timestamp !== required.timestamp) throw new Error('Gemini changed the supplied exact deadline; the market was not accepted.');
  const imageUrl = suppliedImage || validHttpUrl(result.imageUrl);
  const videoUrl = suppliedVideo || validHttpUrl(result.videoUrl);

  return {
    title: formatStrictMarketTitle({ actionEvent, subject, condition, deadlineAt: deadline.timestamp }),
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
