// Kaz chat route — tuteur live pour Jackson dans les leçons Kaz & Moi.
// POST /kaz/chat  (SSE streaming)
// Model: Claude Haiku 4.5 (rapide, économique, bon persona-follower)

const express = require('express');
const { PrismaClient } = require('@prisma/client');
const Anthropic = require('@anthropic-ai/sdk');
const auth = require('../middleware/auth');

const prisma = new PrismaClient();
const router = express.Router();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

router.use(auth);

const DAILY_LIMIT = 50;
const MAX_HISTORY_MESSAGES = 20; // garde les N derniers pour le contexte conversationnel
const MAX_TOKENS_OUT = 300;
const MODEL = 'claude-haiku-4-5-20251001';

function kazSystemPrompt(ctx = {}) {
  const lessonName = ctx.lessonName || 'leçon en cours';
  const concept = ctx.concept || '';
  const actIndex = ctx.actIndex != null ? `ACT ${ctx.actIndex}` : '';
  const jackState = ctx.jackState || {};
  const extra = ctx.lastEvent ? `Dernière action de JaX : ${ctx.lastEvent}.` : '';

  return `Tu es Kaz, streamer Twitch montréalais fictif. Tu coach JaX (Jackson, 10 ans) en direct pendant qu'il apprend à coder en Java.

TON :
- Cool, chill, décontracté. Vrai streamer qui sait de quoi il parle.
- Québécois naturel : "t'sais", "genre", "check", "c'est clean", "let's go", "heille", "c'est ça là".
- ZÉRO infantilisation. JaX est un cool kid, pas un bébé. Parle-lui comme à un gars qui veut comprendre.
- Énergique mais pas faux-enthousiaste. Hype seulement quand c'est VRAIMENT bien. Good is good, great is only when actually great.
- Sweet au cœur — tu veilles sur JaX sans le traiter comme fragile.

RÈGLE CARDINALE :
- Tu ne donnes JAMAIS la réponse directe à un exercice. Tu guides autant qu'il veut, mais par indices, reformulations, contre-questions.
- Si JaX insiste pour la réponse, tu gardes ta ligne : "Je t'aide à trouver, pas à copier. On check ensemble : ..."

FOCUS :
- Leçon courante (${lessonName}${concept ? ' — ' + concept : ''}) d'abord. Questions code adjacentes : OK brièvement.
- Si JaX devient conversationnel hors sujet (lunch, famille, random), redirige cool : "On jase de ça tantôt, focus sur [le cookie/la condition/l'exercice] pour l'instant."

FORMAT :
- Réponses courtes : 1 à 3 phrases max. Style bulle chat, pas dissertation.
- Pas de markdown, pas de listes. Phrase coulée naturelle.
- Vocabulaire du jeu : HP, cookie, potion, zombie, life, etc.

SAFETY :
- Contenu safe pour 10 ans. Aucun contenu violent/sexuel/haineux.
- Question inappropriée → redirige sans drama.

CONTEXTE ACTUEL :
- ${actIndex}${actIndex ? ' · ' : ''}${lessonName}
- État JaX : HP=${jackState.hp ?? '?'}, cookies=${jackState.cookieQty ?? '?'}, potions=${jackState.potionQty ?? '?'}
${extra}

Rappel : tu ES Kaz, pas Claude. Tu parles en Kaz, tu réfléchis en Kaz. Si tu t'oublies, relis ton ton.`;
}

// Helper: start-of-day UTC
function startOfDayUTC() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

// POST /kaz/chat
// Body: {
//   lessonSlug: string,       // ex "survie-xp-s2"
//   message: string,          // le user input
//   context?: {
//     lessonName, concept, actIndex, jackState, lastEvent
//   }
// }
// Streams SSE events: { type: "delta", text: "..." } | { type: "done" } | { type: "error", error }
router.post('/chat', async (req, res) => {
  const { lessonSlug, message, context } = req.body || {};

  if (!lessonSlug || !message || typeof message !== 'string') {
    return res.status(400).json({ erreur: 'lessonSlug et message requis.' });
  }
  if (message.length > 1000) {
    return res.status(400).json({ erreur: 'Message trop long (max 1000 caractères).' });
  }

  try {
    // Rate limit: 50 user-messages/day/user
    const since = startOfDayUTC();
    const count = await prisma.kazChatMessage.count({
      where: {
        role: 'user',
        createdAt: { gte: since },
        session: { userId: req.user.id },
      },
    });
    if (count >= DAILY_LIMIT) {
      return res.status(429).json({ erreur: `Limite quotidienne atteinte (${DAILY_LIMIT} messages). Reviens demain.` });
    }

    // Find or create session for this user + lesson
    let session = await prisma.kazChatSession.findUnique({
      where: { userId_lessonSlug: { userId: req.user.id, lessonSlug } },
    });
    if (!session) {
      session = await prisma.kazChatSession.create({
        data: { userId: req.user.id, lessonSlug },
      });
    }

    // Store user message immediately
    await prisma.kazChatMessage.create({
      data: {
        sessionId: session.id,
        role: 'user',
        content: message,
        actIndex: context?.actIndex ?? null,
      },
    });

    // Load last N messages for conversational memory
    const historyDb = await prisma.kazChatMessage.findMany({
      where: { sessionId: session.id },
      orderBy: { createdAt: 'asc' },
      take: MAX_HISTORY_MESSAGES,
    });
    const msgs = historyDb.map((m) => ({ role: m.role, content: m.content }));

    // Set SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();

    function sse(event) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }

    let full = '';
    try {
      const stream = await anthropic.messages.stream({
        model: MODEL,
        max_tokens: MAX_TOKENS_OUT,
        system: kazSystemPrompt(context),
        messages: msgs,
      });

      for await (const chunk of stream) {
        if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta') {
          const delta = chunk.delta.text || '';
          full += delta;
          sse({ type: 'delta', text: delta });
        }
      }
    } catch (err) {
      console.error('Anthropic error:', err);
      sse({ type: 'error', error: 'Kaz est AFK 2 sec. Reviens tantôt.' });
      res.end();
      return;
    }

    // Save assistant response
    const saved = await prisma.kazChatMessage.create({
      data: {
        sessionId: session.id,
        role: 'assistant',
        content: full,
        actIndex: context?.actIndex ?? null,
      },
    });

    sse({ type: 'done', messageId: saved.id, remaining: Math.max(0, DAILY_LIMIT - (count + 1)) });
    res.end();
  } catch (err) {
    console.error('POST /kaz/chat', err);
    if (!res.headersSent) {
      return res.status(500).json({ erreur: 'Erreur serveur.' });
    }
    try { res.write(`data: ${JSON.stringify({ type: 'error', error: 'Server error' })}\n\n`); res.end(); } catch {}
  }
});

// GET /kaz/chat/history?lessonSlug=... — retourne l'historique (pour review / resume)
router.get('/chat/history', async (req, res) => {
  try {
    const lessonSlug = req.query.lessonSlug;
    if (!lessonSlug) return res.status(400).json({ erreur: 'lessonSlug requis.' });

    const session = await prisma.kazChatSession.findUnique({
      where: { userId_lessonSlug: { userId: req.user.id, lessonSlug } },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
    if (!session) return res.json({ messages: [], remaining: DAILY_LIMIT });

    const since = startOfDayUTC();
    const todayCount = await prisma.kazChatMessage.count({
      where: { role: 'user', createdAt: { gte: since }, session: { userId: req.user.id } },
    });

    return res.json({
      sessionId: session.id,
      messages: session.messages.map((m) => ({
        role: m.role, content: m.content, actIndex: m.actIndex, createdAt: m.createdAt,
      })),
      remaining: Math.max(0, DAILY_LIMIT - todayCount),
    });
  } catch (err) {
    console.error('GET /kaz/chat/history', err);
    return res.status(500).json({ erreur: 'Erreur serveur.' });
  }
});

module.exports = router;
