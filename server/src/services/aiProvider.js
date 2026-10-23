export function isGroqRateLimitError(error) {
  const status = Number(error?.status || error?.response?.status || error?.statusCode);
  const code = String(error?.code || error?.error?.code || error?.response?.data?.error?.code || '').toLowerCase();
  return status === 429 || code === 'rate_limit_exceeded';
}

export function getGeminiApiKey() {
  return String(process.env.GEMINI_CHAT_API_KEY || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim();
}

export function getGeminiModel() {
  return String(process.env.GEMINI_CHAT_MODEL || process.env.GEMINI_MODEL || 'gemini-3.8-flash').trim();
}
