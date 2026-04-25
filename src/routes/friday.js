// FRIDAY bridge — pont chat Mission Control ↔ agent Hermes domestique.
//
// MODE : PULL (FRIDAY initie toutes les connexions sortantes).
//   - FRIDAY long-polls GET /api/friday/poll (HMAC) → reçoit le prochain message user.
//   - FRIDAY traite, POST /api/friday/webhook (HMAC) avec { pendingId, content, metadata }.
//   - Mission Control match la réponse au SSE en attente du browser et le complète.
//
// FRIDAY n'est JAMAIS exposée publiquement. Aucun tunnel requis.
//
// Sécurité :
//   - Browser-side : JWT + admin-only via requireOwner (Phase 1, Martin seulement).
//   - FRIDAY-side  : HMAC-SHA256 sur "<timestamp>.<payload>" + anti-replay 5 min.
//
// HMAC formules :
//   - Pour le poll (GET /api/friday/poll?req=<uuid>) : payload = uuid de la query.
//   - Pour le webhook (POST /api/friday/webhook)     : payload = raw body string.

const express = require('express');
const crypto = require('crypto');
const EventEmitter = require('events');
const { PrismaClient } = require('@prisma/client');
const auth = require('../middleware/auth');

const prisma = new PrismaClient();
const router = express.Router();

// ───────── Configuration ─────────
const FRIDAY_HMAC_SECRET = process.env.FRIDAY_HMAC_SECRET || '';
const FRIDAY_TIMEOUT_MS = Number(process.env.FRIDAY_TIMEOUT_MS) || 90000;
const FRIDAY_MAX_HISTORY = Number(process.env.FRIDAY_MAX_HISTORY) || 30;
const FRIDAY_VERSION = '1.0';
const REPLAY_WINDOW_MS = 5 * 60 * 1000; // 5 min anti-replay
const POLL_TIMEOUT_MS = 25_000;          // long-poll côté FRIDAY (sub-30s pour être < timeout proxy)

// EventEmitter in-process — matchmaking entre poll/webhook/SSE.
// Render backend = 1 worker → in-memory OK. Si on scale, passer à Redis pubsub.
const fridayEvents = new EventEmitter();
fridayEvents.setMaxListeners(200);

// Track last successful poll (pour le statut UI "FRIDAY active").
let lastPollAt = 0;

// ───────── Auth admin-only (Phase 1) ─────────
async function requireOwner(req, res, next) {
  try {
    if (!req.user || req.user.role !== 'ADMIN') {
      return res.status(403).json({ erreur: 'Accès réservé.' });
    }
    next();
  } catch (err) {
    return res.status(500).json({ erreur: 'Erreur serveur.' });
  }
}

router.use(auth);
router.use(requireOwner);

// ───────── HMAC helpers ─────────
function computeSignature(timestampMs, payloadString) {
  if (!FRIDAY_HMAC_SECRET) return '';
  const h = crypto.createHmac('sha256', FRIDAY_HMAC_SECRET);
  h.update(`${timestampMs}.${payloadString}`);
  return `sha256=${h.digest('hex')}`;
}

function verifySignature(timestampMs, payloadString, sigHeader) {
  if (!FRIDAY_HMAC_SECRET || !sigHeader) return false;
  const expected = computeSignature(timestampMs, payloadString);
  if (!expected || expected.length !== sigHeader.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sigHeader));
  } catch {
    return false;
  }
}

function checkTimestamp(ts) {
  if (!Number.isFinite(ts)) return false;
  return Math.abs(Date.now() - ts) <= REPLAY_WINDOW_MS;
}

// ───────── Shape helpers ─────────
function shapeUser(user) {
  return {
    id: user.id,
    username: user.username || null,
    firstName: user.firstName,
    email: user.email,
    role: user.role,
    profile: user.profile,
    isOwner: user.email === 'martin@logifox.io',
  };
}

function shapeConversationSummary(c) {
  return {
    id: c.id,
    title: c.title,
    pinned: c.pinned,
    archivedAt: c.archivedAt,
    lastMessageAt: c.lastMessageAt,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    messageCount: c._count?.messages ?? undefined,
  };
}

function shapeMessage(m) {
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    metadata: m.metadata || null,
    errorMessage: m.errorMessage || null,
    createdAt: m.createdAt,
  };
}

async function autoTitleFromFirstMessage(text) {
  const firstLine = (text || '').split('\n')[0].trim();
  if (!firstLine) return 'Nouvelle conversation';
  const truncated = firstLine.length > 50 ? firstLine.slice(0, 50).trim() + '…' : firstLine;
  return truncated.replace(/[.!?…]+$/, '') || 'Nouvelle conversation';
}

// ───────── Pull-mode plumbing ─────────

// Tente de claim atomiquement le prochain pending non-claimed et non-respondu.
async function claimNextPending() {
  // Étape 1 : trouver le candidat le plus ancien
  const candidate = await prisma.fridayPendingMessage.findFirst({
    where: { claimedAt: null, respondedAt: null },
    orderBy: { createdAt: 'asc' },
  });
  if (!candidate) return null;
  // Étape 2 : claim atomique (updateMany avec where strict pour éviter race)
  const r = await prisma.fridayPendingMessage.updateMany({
    where: { id: candidate.id, claimedAt: null, respondedAt: null },
    data: { claimedAt: new Date() },
  });
  if (r.count === 0) return null; // un autre poll a claim entre-temps
  return prisma.fridayPendingMessage.findUnique({ where: { id: candidate.id } });
}

async function tryClaimById(pendingId) {
  const r = await prisma.fridayPendingMessage.updateMany({
    where: { id: pendingId, claimedAt: null, respondedAt: null },
    data: { claimedAt: new Date() },
  });
  if (r.count === 0) return null;
  return prisma.fridayPendingMessage.findUnique({ where: { id: pendingId } });
}

function buildPollPayload(pending) {
  return {
    pendingId: pending.id,
    ...(pending.payload || {}),
  };
}

// Attend la réponse FRIDAY pour un pendingId, avec timeout.
function waitForFridayResponse(pendingId, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    const handler = (payload) => {
      if (done) return;
      done = true;
      cleanup();
      resolve(payload);
    };
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      cleanup();
      reject(new Error('timeout'));
    }, timeoutMs);
    function cleanup() {
      clearTimeout(timer);
      fridayEvents.off(`response:${pendingId}`, handler);
    }
    fridayEvents.once(`response:${pendingId}`, handler);
  });
}

// ───────── Routes : conversations CRUD ─────────

router.get('/conversations', async (req, res) => {
  try {
    const includeArchived = req.query.archived === '1';
    const list = await prisma.fridayConversation.findMany({
      where: {
        userId: req.user.id,
        ...(includeArchived ? {} : { archivedAt: null }),
      },
      orderBy: [{ pinned: 'desc' }, { lastMessageAt: 'desc' }],
      include: { _count: { select: { messages: true } } },
      take: 200,
    });
    res.json({
      conversations: list.map(shapeConversationSummary),
      bridge: {
        configured: !!FRIDAY_HMAC_SECRET,
        // Active = FRIDAY a poll dans les 60 dernières secondes
        active: !!FRIDAY_HMAC_SECRET && (Date.now() - lastPollAt) < 60_000,
        lastPollAt: lastPollAt ? new Date(lastPollAt).toISOString() : null,
        mode: 'pull',
      },
    });
  } catch (err) {
    console.error('GET /friday/conversations', err);
    res.status(500).json({ erreur: 'Erreur serveur.' });
  }
});

router.post('/conversations', async (req, res) => {
  try {
    const title = (req.body?.title || 'Nouvelle conversation').toString().slice(0, 200);
    const c = await prisma.fridayConversation.create({
      data: { userId: req.user.id, title },
    });
    res.json({ conversation: shapeConversationSummary(c) });
  } catch (err) {
    console.error('POST /friday/conversations', err);
    res.status(500).json({ erreur: 'Erreur serveur.' });
  }
});

router.get('/conversations/:id', async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ erreur: 'id invalide.' });
    const c = await prisma.fridayConversation.findFirst({
      where: { id, userId: req.user.id },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
    if (!c) return res.status(404).json({ erreur: 'Conversation introuvable.' });
    res.json({
      conversation: shapeConversationSummary(c),
      messages: c.messages.map(shapeMessage),
    });
  } catch (err) {
    console.error('GET /friday/conversations/:id', err);
    res.status(500).json({ erreur: 'Erreur serveur.' });
  }
});

router.patch('/conversations/:id', async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ erreur: 'id invalide.' });
    const owned = await prisma.fridayConversation.findFirst({ where: { id, userId: req.user.id } });
    if (!owned) return res.status(404).json({ erreur: 'Conversation introuvable.' });
    const data = {};
    if (typeof req.body?.title === 'string') data.title = req.body.title.slice(0, 200);
    if (typeof req.body?.pinned === 'boolean') data.pinned = req.body.pinned;
    if (req.body?.archived === true) data.archivedAt = new Date();
    if (req.body?.archived === false) data.archivedAt = null;
    const updated = await prisma.fridayConversation.update({ where: { id }, data });
    res.json({ conversation: shapeConversationSummary(updated) });
  } catch (err) {
    console.error('PATCH /friday/conversations/:id', err);
    res.status(500).json({ erreur: 'Erreur serveur.' });
  }
});

router.delete('/conversations/:id', async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ erreur: 'id invalide.' });
    const owned = await prisma.fridayConversation.findFirst({ where: { id, userId: req.user.id } });
    if (!owned) return res.status(404).json({ erreur: 'Conversation introuvable.' });
    await prisma.fridayConversation.delete({ where: { id } });
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /friday/conversations/:id', err);
    res.status(500).json({ erreur: 'Erreur serveur.' });
  }
});

// ───────── Route : envoi message + attente réponse FRIDAY (pull-mode) ─────────
// POST /friday/conversations/:id/messages
// Body : { content: string }
// Stream SSE : { type:"user-saved", message } | { type:"title", title } |
//              { type:"delta", text } | { type:"done", message } | { type:"error", error }
router.post('/conversations/:id/messages', async (req, res) => {
  const conversationId = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(conversationId)) return res.status(400).json({ erreur: 'id invalide.' });
  const content = (req.body?.content || '').toString().trim();
  if (!content) return res.status(400).json({ erreur: 'content requis.' });
  if (content.length > 8000) return res.status(400).json({ erreur: 'Message trop long (max 8000 caractères).' });

  try {
    const convo = await prisma.fridayConversation.findFirst({
      where: { id: conversationId, userId: req.user.id },
    });
    if (!convo) return res.status(404).json({ erreur: 'Conversation introuvable.' });

    const userRow = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!userRow) return res.status(404).json({ erreur: 'Utilisateur introuvable.' });

    // 1. Sauve le message user
    const userMsg = await prisma.fridayMessage.create({
      data: { conversationId, role: 'user', content },
    });

    // 2. Auto-titre 1er message
    const msgCount = await prisma.fridayMessage.count({ where: { conversationId } });
    let titleUpdated = null;
    if (msgCount === 1 && convo.title === 'Nouvelle conversation') {
      const t = await autoTitleFromFirstMessage(content);
      const upd = await prisma.fridayConversation.update({
        where: { id: conversationId },
        data: { title: t, lastMessageAt: new Date() },
      });
      titleUpdated = upd.title;
    } else {
      await prisma.fridayConversation.update({
        where: { id: conversationId },
        data: { lastMessageAt: new Date() },
      });
    }

    // 3. Charge l'historique
    const historyDb = await prisma.fridayMessage.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'asc' },
      take: FRIDAY_MAX_HISTORY,
    });
    const history = historyDb.map((m) => ({
      role: m.role,
      content: m.content,
      createdAt: m.createdAt,
    }));

    // 4. Set up SSE
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();
    function sse(event) {
      try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch {}
    }
    sse({ type: 'user-saved', message: shapeMessage(userMsg) });
    if (titleUpdated) sse({ type: 'title', title: titleUpdated });

    // 5. Si HMAC pas configuré → fallback friendly
    if (!FRIDAY_HMAC_SECRET) {
      const fallbackText =
        "FRIDAY n'est pas encore branchée. Configure FRIDAY_HMAC_SECRET dans Render et démarre la boucle de poll côté FRIDAY.";
      const saved = await prisma.fridayMessage.create({
        data: { conversationId, role: 'assistant', content: fallbackText, errorMessage: 'BRIDGE_NOT_CONFIGURED' },
      });
      await prisma.fridayConversation.update({
        where: { id: conversationId },
        data: { lastMessageAt: saved.createdAt },
      });
      sse({ type: 'delta', text: fallbackText });
      sse({ type: 'done', message: shapeMessage(saved) });
      res.end();
      return;
    }

    // 6. Build payload + crée pending en DB
    const fridayPayload = {
      version: FRIDAY_VERSION,
      user: shapeUser(userRow),
      conversation: {
        id: convo.id,
        title: titleUpdated || convo.title,
        createdAt: convo.createdAt,
      },
      message: {
        id: userMsg.id,
        content,
        createdAt: userMsg.createdAt,
      },
      history,
      context: {
        source: 'mission-control-web',
        mode: 'chat',
        tags: userRow.role === 'ADMIN' ? ['owner'] : ['member'],
      },
    };
    const pending = await prisma.fridayPendingMessage.create({
      data: {
        userId: userRow.id,
        conversationId,
        payload: fridayPayload,
      },
    });

    // 7. Setup waiter AVANT de notifier (race-free)
    const waitPromise = waitForFridayResponse(pending.id, FRIDAY_TIMEOUT_MS);

    // 8. Notifie les pollers en attente
    fridayEvents.emit('pending', pending.id);

    // 9. Cleanup si client disconnect
    let clientDisconnected = false;
    req.on('close', () => { clientDisconnected = true; });

    // 10. Attend la réponse
    let fullText = '';
    let metadata = null;
    let assistantSaved = null;
    try {
      const response = await waitPromise;
      // response = { messageId, content, metadata }
      fullText = response.content || '';
      metadata = response.metadata || null;
      assistantSaved = await prisma.fridayMessage.findUnique({ where: { id: response.messageId } });
      if (!clientDisconnected) {
        sse({ type: 'delta', text: fullText });
        sse({ type: 'done', message: shapeMessage(assistantSaved || { id: response.messageId, role: 'assistant', content: fullText, metadata, createdAt: new Date() }) });
      }
      res.end();
    } catch (err) {
      // Timeout — marque le pending en erreur (ne sera plus claim)
      try {
        await prisma.fridayPendingMessage.update({
          where: { id: pending.id },
          data: { errorMessage: 'TIMEOUT', respondedAt: new Date() },
        });
      } catch {}
      const errorText = "FRIDAY n'a pas répondu à temps. Vérifie que sa boucle de poll tourne.";
      const saved = await prisma.fridayMessage.create({
        data: {
          conversationId,
          role: 'assistant',
          content: errorText,
          errorMessage: 'FRIDAY_TIMEOUT',
        },
      });
      await prisma.fridayConversation.update({
        where: { id: conversationId },
        data: { lastMessageAt: saved.createdAt },
      });
      if (!clientDisconnected) {
        sse({ type: 'error', error: 'Timeout : FRIDAY n\'a pas répondu.', message: shapeMessage(saved) });
      }
      res.end();
    }
  } catch (err) {
    console.error('POST /friday/conversations/:id/messages', err);
    if (!res.headersSent) return res.status(500).json({ erreur: 'Erreur serveur.' });
    try {
      res.write(`data: ${JSON.stringify({ type: 'error', error: 'Server error' })}\n\n`);
      res.end();
    } catch {}
  }
});

module.exports = router;

// ═══════════════════════════════════════════════════════════════════════
// Sous-routeur PULL-MODE (HMAC seulement, pas de JWT) — pour FRIDAY agent
// ═══════════════════════════════════════════════════════════════════════
const pullRouter = express.Router();

// GET /api/friday/poll?req=<uuid>
// HMAC : signature sur "<timestamp>.<uuid>"
// Headers : X-MC-Signature, X-MC-Timestamp, X-MC-Version
//
// Retourne :
//   200 { pendingId, version, user, conversation, message, history, context } — message à traiter
//   204 No Content — timeout 25s, FRIDAY re-poll
//   400 — paramètres manquants
//   401 — signature invalide / timestamp expiré
//   503 — bridge non configuré (HMAC secret manquant)
pullRouter.get('/poll', async (req, res) => {
  if (!FRIDAY_HMAC_SECRET) return res.status(503).json({ erreur: 'Bridge non configuré.' });

  const sig = (req.headers['x-mc-signature'] || '').toString();
  const tsStr = (req.headers['x-mc-timestamp'] || '').toString();
  const ts = Number.parseInt(tsStr, 10);
  const reqId = (req.query.req || '').toString();

  if (!reqId) return res.status(400).json({ erreur: 'paramètre req requis.' });
  if (!Number.isFinite(ts)) return res.status(400).json({ erreur: 'X-MC-Timestamp manquant.' });
  if (!checkTimestamp(ts)) return res.status(401).json({ erreur: 'timestamp expiré.' });
  if (!verifySignature(ts, reqId, sig)) return res.status(401).json({ erreur: 'signature invalide.' });

  // Marque FRIDAY active
  lastPollAt = Date.now();

  // Tente claim immédiat
  const immediate = await claimNextPending();
  if (immediate) {
    return res.json(buildPollPayload(immediate));
  }

  // Long-poll
  let resolved = false;
  let timer;
  const onPending = async (pendingId) => {
    if (resolved) return;
    const claimed = await tryClaimById(pendingId);
    if (claimed && !resolved) {
      resolved = true;
      clearTimeout(timer);
      fridayEvents.off('pending', onPending);
      try { res.json(buildPollPayload(claimed)); } catch {}
    }
  };

  timer = setTimeout(() => {
    if (resolved) return;
    resolved = true;
    fridayEvents.off('pending', onPending);
    try { res.status(204).end(); } catch {}
  }, POLL_TIMEOUT_MS);

  fridayEvents.on('pending', onPending);

  req.on('close', () => {
    if (resolved) return;
    resolved = true;
    clearTimeout(timer);
    fridayEvents.off('pending', onPending);
  });
});

// POST /api/friday/webhook
// HMAC : signature sur "<timestamp>.<raw_body>"
// Body :
//   Mode 1 (réponse à un poll) : { pendingId, content, metadata? }
//   Mode 2 (push proactif)     : { userId, conversationId?, conversationTitle?, content, metadata? }
//
// On distingue par la présence de `pendingId`.
pullRouter.post('/webhook', express.raw({ type: 'application/json', limit: '4mb' }), async (req, res) => {
  try {
    if (!FRIDAY_HMAC_SECRET) return res.status(503).json({ erreur: 'Bridge non configuré.' });

    const sig = (req.headers['x-mc-signature'] || '').toString();
    const tsStr = (req.headers['x-mc-timestamp'] || '').toString();
    const ts = Number.parseInt(tsStr, 10);
    if (!Number.isFinite(ts)) return res.status(400).json({ erreur: 'X-MC-Timestamp manquant.' });
    if (!checkTimestamp(ts)) return res.status(401).json({ erreur: 'timestamp expiré.' });

    const rawBody = req.body instanceof Buffer ? req.body.toString('utf8') : '';
    if (!verifySignature(ts, rawBody, sig)) {
      return res.status(401).json({ erreur: 'signature invalide.' });
    }

    let payload;
    try { payload = JSON.parse(rawBody); }
    catch { return res.status(400).json({ erreur: 'JSON invalide.' }); }

    const content = (payload.content || '').toString().trim();
    if (!content) return res.status(400).json({ erreur: 'content requis.' });

    // ─── Mode 1 : réponse à un poll ───
    if (payload.pendingId != null) {
      const pendingId = Number(payload.pendingId);
      if (!Number.isFinite(pendingId)) return res.status(400).json({ erreur: 'pendingId invalide.' });

      const pending = await prisma.fridayPendingMessage.findUnique({ where: { id: pendingId } });
      if (!pending) return res.status(404).json({ erreur: 'pending introuvable.' });
      if (pending.respondedAt) return res.status(409).json({ erreur: 'pending déjà répondu.' });

      // Sauve la réponse FRIDAY
      const msg = await prisma.fridayMessage.create({
        data: {
          conversationId: pending.conversationId,
          role: 'assistant',
          content,
          metadata: payload.metadata || null,
        },
      });

      await prisma.fridayPendingMessage.update({
        where: { id: pendingId },
        data: { respondedAt: new Date() },
      });

      await prisma.fridayConversation.update({
        where: { id: pending.conversationId },
        data: { lastMessageAt: msg.createdAt },
      });

      // Réveille le SSE en attente (s'il y en a un)
      fridayEvents.emit(`response:${pendingId}`, {
        messageId: msg.id,
        content,
        metadata: payload.metadata || null,
      });

      return res.json({ ok: true, messageId: msg.id, conversationId: pending.conversationId });
    }

    // ─── Mode 2 : push proactif ───
    const userId = Number(payload.userId);
    if (!Number.isFinite(userId)) {
      return res.status(400).json({ erreur: 'userId requis (mode proactif) ou pendingId (mode réponse).' });
    }

    let convo;
    if (payload.conversationId) {
      convo = await prisma.fridayConversation.findFirst({
        where: { id: Number(payload.conversationId), userId },
      });
    }
    if (!convo) {
      convo = await prisma.fridayConversation.create({
        data: {
          userId,
          title: (payload.conversationTitle || 'FRIDAY (proactif)').toString().slice(0, 200),
        },
      });
    }

    const msg = await prisma.fridayMessage.create({
      data: {
        conversationId: convo.id,
        role: 'assistant',
        content,
        metadata: payload.metadata || null,
      },
    });
    await prisma.fridayConversation.update({
      where: { id: convo.id },
      data: { lastMessageAt: msg.createdAt },
    });

    return res.json({ ok: true, conversationId: convo.id, messageId: msg.id, mode: 'proactive' });
  } catch (err) {
    console.error('POST /api/friday/webhook', err);
    return res.status(500).json({ erreur: 'Erreur serveur.' });
  }
});

module.exports.pullRouter = pullRouter;
// Conserve l'export historique inboundRouter (alias pullRouter pour rétrocompat).
module.exports.inboundRouter = pullRouter;
