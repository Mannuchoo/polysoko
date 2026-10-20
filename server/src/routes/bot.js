import express from 'express';
import { processUserBotMessage } from '../services/userBotService.js';

export function createBotRouter({ dbAll, authenticate }) {
  const router = express.Router();
  router.post('/bot/chat', authenticate, async (req, res) => {
    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    if (!message) return res.status(400).json({ success: false, message: 'Enter a message for PolySoko AI.' });
    if (message.length > 2000) return res.status(400).json({ success: false, message: 'Message must be 2,000 characters or fewer.' });
    try {
      const result = await processUserBotMessage({ message, history: req.body?.history, dbAll });
      return res.json({ success: true, engine: 'groq', model: result.model, reply: result.reply });
    } catch (error) {
      console.error('[sokobot] request failed:', error.message);
      const missingKey = error.message === 'GROQ_API_KEY is not configured.';
      return res.status(missingKey ? 503 : 502).json({
        success: false,
        message: missingKey
          ? 'PolySoko AI is not configured on the backend. Set GROQ_API_KEY in the server environment.'
          : 'PolySoko AI is temporarily unavailable. Please try again shortly.'
      });
    }
  });
  return router;
}
