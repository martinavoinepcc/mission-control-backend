// FRIDAY bridge — pont chat entre Mission Control et l'agent Hermes domestique.
// Architecture : Mission Control reçoit un message du user (Martin), forward
// vers FRIDAY via webhook HTTP signé HMAC, stream la réponse retour en SSE.
//
// FRIDAY peut répondre :
//   A) JSON synchrone     → { reply: "...", metadata?: {...} }
//   B) SSE streaming      → data: {type:"delta",text:"..."} ... {type:"done"}
//
// Le client web reçoit toujours du SSE, peu importe le format de FRIDAY.
//
// Identité : chaque requête vers FRIDAY contient le user complet (id, role,
// firstName, isOwner) pour que FRIDAY décide quoi répondre selon qui parle.
//
// Sécurité :
//   - JWT user-side
//   - Phase 1 : admin uniquement (Martin)
//   - HMAC-SHA256 signature outbound, anti-replay via timestamp
//   - HMAC-SHA256 signature inbound (webhook proactif depuis FRIDAY)

const express = require('express');
const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');
const auth = require('../middleware/auth');

const prisma = new PrismaClient();
const router = express.Router();

// ───────── Configuration ─────────
const FRIDAY_WEBHOOK_URL = process.env.FRIDAY_WEBHOOK_URL || '';
const FRIDAY_HMAC_SECRET = process.env.FRIDAY_HMAC_SECRET || '';
const FRIDAY_TIMEOUT_MS = Number(process.env.FRIDAY_TIMEOUT_MS) || 90000;
const FRIDAY_MAX_HISTORY = Number(process.env.FRIDAY_MAX_HISTORY) || 30;
const FRIDAY_VERSION = '1.0';
const REPLAY_WINDOW_MS = 5 * 60 * 1000; // 5 min anti-replay

// ───────── Auth admin-only (Phase 1) ─────────
// Phase 2 (futur) : retirer ce middleware ou le rendre conditionnel pour donner
// accès aux enfants. FRIDAY décidera quoi répondre selon le user payload.
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
function signPayload(timestampMs, bodyString) {
  if (!FRIDAY_HMAC_SECRET) return '';
  const h = crypto.createHmac('sha256', FRIDAY_HMAC_SECRET);
  h.update(`${timestampMs}.${bodyString}`);
  return `sha256=${h.digest('hex')}`;
}

function verifyInboundSignature(timestampMs, bodyString, sigHeader) {
  if (!FRIDAY_HMAC_SECRET || !sigHeader) return false;
  const expected = signPayload(timestampMs, bodyString);
  if (expected.length !== sigHeader.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sigHeader));
}

// ───────── Helpers ─────────
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
  // Titre simple : 50 premiers chars de la 1re ligne, trim ponctuation.
  const firstLine = (text || '').split('\n')[0].trim();
  if (!firstLine) return 'Nouvelle conversation';
  const truncated = firstLine.length > 50 ? firstLine.slice(0, 50).trim() + '…' : firstLine;
  return truncated.replace(/[.!?…]+$/, '') || 'Nouvelle conversation';
}

// ───────── Routes : conversations CRUD ─────────

// GET /friday/conversations — liste les conversations de l'utilisateur
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
        configured: !!FRIDAY_WEBHOOK_URL && !!FRIDAY_HMAC_SECRET,
      },
    });
  } catch (err) {
    console.error('GET /friday/conversations', err);
    res.status(500).json({ erreur: 'Erreur serveur.' });
  }
});

// POST /friday/conversations — crée une nouvelle conversation
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

// GET /friday/conversations/:id — détails + messages
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

// PATCH /friday/conversations/:id — rename / pin / archive
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

// DELETE /friday/conversations/:id
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

// ───────── Route : envoi message + forward FRIDAY ─────────
// POST /friday/conversations/:id/messages
// Body : { content: string }
// Stream SSE : { type:"user-saved", message } | { type:"delta", text } | { type:"done", message } | { type:"error", error }
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
      data: {
        conversationId,
        role: 'user',
        content,
      },
    });

    // 2. Auto-titre si c'est le 1er message
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
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }

    sse({ type: 'user-saved', message: shapeMessage(userMsg) });
    if (titleUpdated) sse({ type: 'title', title: titleUpdated });

    // 5. Si bridge non configuré → message d'erreur friendly
    if (!FRIDAY_WEBHOOK_URL || !FRIDAY_HMAC_SECRET) {
      const fallbackText =
        "FRIDAY n'est pas encore branchée. Configure FRIDAY_WEBHOOK_URL + FRIDAY_HMAC_SECRET dans Render pour activer le pont. " +
        '(Voir le guide de branchement.)';
      const saved = await prisma.fridayMessage.create({
        data: {
          conversationId,
          role: 'assistant',
          content: fallbackText,
          errorMessage: 'BRIDGE_NOT_CONFIGURED',
        },
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

    // 6. Build payload to FRIDAY
    const timestamp = Date.now();
    const payload = {
      version: FRIDAY_VERSION,
      timestamp,
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
    const bodyString = JSON.stringify(payload);
    const signature = signPayload(timestamp, bodyString);

    // 7. Forward to FRIDAY with timeout
    let fullText = '';
    let metadata = null;
    let assistantSaved = null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FRIDAY_TIMEOUT_MS);

    try {
      const upstream = await fetch(FRIDAY_WEBHOOK_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream, application/json',
          'X-MC-Signature': signature,
          'X-MC-Timestamp': String(timestamp),
          'X-MC-Version': FRIDAY_VERSION,
          'User-Agent': 'mission-control-bridge/1.0',
        },
        body: bodyString,
        signal: controller.signal,
      });

      if (!upstream.ok) {
        const errText = await upstream.text().catch(() => '');
        throw new Error(`FRIDAY ${upstream.status}: ${errText.slice(0, 200)}`);
      }

      const ct = (upstream.headers.get('content-type') || '').toLowerCase();

      if (ct.includes('text/event-stream') && upstream.body) {
        // Stream-forward: parse SSE lines, re-emit deltas
        const reader = upstream.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buffer.indexOf('\n\n')) !== -1) {
            const rawEvent = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const lines = rawEvent.split('\n');
            for (const line of lines) {
              if (!line.startsWith('data:')) continue;
              const dataStr = line.slice(5).trim();
              if (!dataStr) continue;
              try {
                const ev = JSON.parse(dataStr);
                if (ev.type === 'delta' && typeof ev.text === 'string') {
                  fullText += ev.text;
                  sse({ type: 'delta', text: ev.text });
                } else if (ev.type === 'done') {
                  metadata = ev.metadata || null;
                } else if (ev.type === 'error') {
                  throw new Error(ev.error || 'FRIDAY error');
                } else {
                  // forward inconnu (ex: thinking, tool-use)
                  sse(ev);
                }
              } catch (parseErr) {
                // pas du JSON valide — ignore (peut-être un keepalive)
              }
            }
          }
        }
      } else {
        // JSON synchrone
        const data = await upstream.json();
        const text = (data.reply || data.content || '').toString();
        if (!text) throw new Error('Réponse FRIDAY vide.');
        fullText = text;
        metadata = data.metadata || null;
        // Émet en un seul delta pour cohérence client
        sse({ type: 'delta', text });
      }
    } catch (err) {
      clearTimeout(timer);
      const errMsg = err.name === 'AbortError'
        ? 'FRIDAY a pris trop de temps à répondre (timeout).'
        : `Erreur FRIDAY : ${err.message || err}`;
      console.error('[friday bridge]', errMsg);
      const saved = await prisma.fridayMessage.create({
        data: {
          conversationId,
          role: 'assistant',
          content: fullText || 'FRIDAY est temporairement injoignable. Réessaie dans un instant.',
          errorMessage: errMsg.slice(0, 500),
          metadata: metadata || null,
        },
      });
      await prisma.fridayConversation.update({
        where: { id: conversationId },
        data: { lastMessageAt: saved.createdAt },
      });
      sse({ type: 'error', error: errMsg, message: shapeMessage(saved) });
      res.end();
      return;
    }
    clearTimeout(timer);

    // 8. Sauve la réponse de FRIDAY
    assistantSaved = await prisma.fridayMessage.create({
      data: {
        conversationId,
        role: 'assistant',
        content: fullText,
        metadata: metadata || null,
      },
    });
    await prisma.fridayConversation.update({
      where: { id: conversationId },
      data: { lastMessageAt: assistantSaved.createdAt },
    });

    sse({ type: 'done', message: shapeMessage(assistantSaved) });
    res.end();
  } catch (err) {
    console.error('POST /friday/conversations/:id/messages', err);
    if (!res.headersSent) {
      return res.status(500).json({ erreur: 'Erreur serveur.' });
    }
    try {
      res.write(`data: ${JSON.stringify({ type: 'error', error: 'Server error' })}\n\n`);
      res.end();
    } catch {}
  }
});

// ───────── Route inbound : FRIDAY peut pousser un message proactif ─────────
// POST /friday/inbound  (HMAC verified, pas de JWT — c'est FRIDAY qui appelle)
// Body : {
//   userId: number,                 // qui doit recevoir le message
//   conversationId?: number,        // si null → crée une nouvelle convo
//   conversationTitle?: string,
//   content: string,                // le message
//   metadata?: any
// }
router.post('/inbound', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
  // Note : c'est mounté APRÈS les middlewares auth/requireOwner ci-dessus, mais
  // Express n'applique pas un router-level use à des routes après — sauf si elles
  // sont déclarées sur le même router. Donc auth s'applique. On bypasse en
  // déclarant ce handler dans un sous-routeur ou en vérifiant manuellement.
  // Pour simplicité : ce handler ne sera pas atteint par les clients web (pas
  // de JWT), donc auth retournera 401. SOLUTION : on déplace cet endpoint dans
  // un router séparé monté avant requireOwner. Voir ci-dessous (inboundRouter).
  res.status(501).json({ erreur: 'Use /friday-inbound endpoint.' });
});

module.exports = router;

// ───────── Sous-routeur INBOUND (pas d'auth JWT, HMAC seulement) ─────────
// À monter dans index.js sur un path différent OU avant le requireOwner.
const inboundRouter = express.Router();

inboundRouter.post('/', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
  try {
    if (!FRIDAY_HMAC_SECRET) return res.status(503).json({ erreur: 'Bridge non configuré.' });

    const sig = req.headers['x-mc-signature'] || '';
    const tsStr = req.headers['x-mc-timestamp'] || '';
    const ts = Number.parseInt(tsStr, 10);
    if (!Number.isFinite(ts)) return res.status(400).json({ erreur: 'timestamp manquant.' });
    if (Math.abs(Date.now() - ts) > REPLAY_WINDOW_MS) {
      return res.status(401).json({ erreur: 'timestamp expiré.' });
    }

    const rawBody = req.body instanceof Buffer ? req.body.toString('utf8') : '';
    if (!verifyInboundSignature(ts, rawBody, sig)) {
      return res.status(401).json({ erreur: 'signature invalide.' });
    }

    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return res.status(400).json({ erreur: 'JSON invalide.' });
    }

    const userId = Number(payload.userId);
    const content = (payload.content || '').toString().trim();
    if (!Number.isFinite(userId) || !content) {
      return res.status(400).json({ erreur: 'userId + content requis.' });
    }

    // Find or create conversation
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

    return res.json({
      ok: true,
      conversationId: convo.id,
      messageId: msg.id,
    });
  } catch (err) {
    console.error('POST /friday-inbound', err);
    return res.status(500).json({ erreur: 'Erreur serveur.' });
  }
});

module.exports.inboundRouter = inboundRouter;
