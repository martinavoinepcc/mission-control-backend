// Routes /conversations — messagerie familiale.
//
// Architecture :
// - GET  /conversations                     → liste des convos de l'user (+ last msg + unread)
// - GET  /conversations/:id                 → détails d'une convo + participants
// - POST /conversations                     → crée une convo (body: { title?, participantIds })
// - GET  /conversations/:id/messages        → liste les messages (?limit=50&before=<id>)
// - POST /conversations/:id/messages        → envoie un message + push auto aux autres participants
// - POST /conversations/:id/read            → reset lastReadAt (clear unread badge)

const express = require('express');
const { PrismaClient } = require('@prisma/client');
const auth = require('../middleware/auth');
const pushModule = require('./push');

const prisma = new PrismaClient();
const router = express.Router();

// Helper importé depuis push.js (exporté comme propriété du router). Peut être undefined
// si push.js n'est pas encore chargé pour une raison quelconque — fallback silencieux.
const sendPushToUser = pushModule && pushModule.sendPushToUser;

// Utilitaire : vérifie que l'user est participant de la convo. Retourne le participant
// row (ou null). Factorise les checks 403 dans chaque route.
async function ensureParticipant(userId, conversationId) {
  if (!Number.isFinite(conversationId) || conversationId <= 0) return null;
  return prisma.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId, userId } },
  });
}

// GET /conversations — liste des convos de l'user
router.get('/', auth, async (req, res) => {
  try {
    const userId = req.user.id;

    const participations = await prisma.conversationParticipant.findMany({
      where: { userId },
      include: {
        conversation: {
          include: {
            participants: {
              include: { user: { select: { id: true, firstName: true, username: true } } },
            },
            messages: {
              orderBy: { createdAt: 'desc' },
              take: 1,
              include: { author: { select: { id: true, firstName: true } } },
            },
          },
        },
      },
    });

    // Compute unread count per convo (messages after lastReadAt, authored by someone else)
    const results = await Promise.all(
      participations.map(async (p) => {
        const convo = p.conversation;
        const unreadCount = await prisma.message.count({
          where: {
            conversationId: convo.id,
            createdAt: { gt: p.lastReadAt },
            authorId: { not: userId },
          },
        });
        const lastMsg = convo.messages[0] || null;
        return {
          id: convo.id,
          slug: convo.slug,
          title: convo.title,
          lastMessageAt: convo.lastMessageAt,
          unreadCount,
          participants: convo.participants.map((cp) => ({
            id: cp.user.id,
            firstName: cp.user.firstName,
          })),
          lastMessage: lastMsg
            ? {
                id: lastMsg.id,
                body: lastMsg.body,
                createdAt: lastMsg.createdAt,
                authorId: lastMsg.authorId,
                authorFirstName: lastMsg.author ? lastMsg.author.firstName : null,
              }
            : null,
        };
      })
    );

    results.sort((a, b) => new Date(b.lastMessageAt) - new Date(a.lastMessageAt));
    return res.json({ conversations: results });
  } catch (err) {
    console.error('GET /conversations error:', err);
    return res.status(500).json({ erreur: 'Erreur interne du serveur.' });
  }
});

// GET /conversations/:id — détails d'une convo (participants, title)
router.get('/:id', auth, async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const p = await ensureParticipant(req.user.id, id);
    if (!p) return res.status(404).json({ erreur: 'Conversation introuvable.' });

    const convo = await prisma.conversation.findUnique({
      where: { id },
      include: {
        participants: {
          include: { user: { select: { id: true, firstName: true, username: true } } },
        },
      },
    });
    if (!convo) return res.status(404).json({ erreur: 'Conversation introuvable.' });

    return res.json({
      id: convo.id,
      slug: convo.slug,
      title: convo.title,
      createdAt: convo.createdAt,
      lastMessageAt: convo.lastMessageAt,
      participants: convo.participants.map((cp) => ({
        id: cp.user.id,
        firstName: cp.user.firstName,
        username: cp.user.username,
      })),
    });
  } catch (err) {
    console.error('GET /conversations/:id error:', err);
    return res.status(500).json({ erreur: 'Erreur interne du serveur.' });
  }
});

// POST /conversations — crée une nouvelle convo
// body: { title?: string, participantIds: number[] }
// L'auteur est auto-ajouté s'il n'est pas dans participantIds.
router.post('/', auth, async (req, res) => {
  try {
    const { title, participantIds } = req.body || {};
    if (!Array.isArray(participantIds) || participantIds.length === 0) {
      return res.status(400).json({ erreur: 'participantIds requis (tableau non vide).' });
    }
    const sanitized = Array.from(
      new Set(
        [...participantIds.map((x) => Number.parseInt(x, 10)).filter(Number.isFinite), req.user.id]
      )
    );
    if (sanitized.length < 2) {
      return res.status(400).json({ erreur: 'Une conversation doit avoir au moins 2 participants.' });
    }

    // Vérifie que tous les participants existent
    const users = await prisma.user.findMany({ where: { id: { in: sanitized } } });
    if (users.length !== sanitized.length) {
      return res.status(400).json({ erreur: 'Un ou plusieurs utilisateurs introuvables.' });
    }

    const cleanTitle = typeof title === 'string' && title.trim() ? title.trim().slice(0, 80) : null;

    const convo = await prisma.conversation.create({
      data: {
        title: cleanTitle,
        createdById: req.user.id,
        participants: { create: sanitized.map((uid) => ({ userId: uid })) },
      },
      include: {
        participants: {
          include: { user: { select: { id: true, firstName: true } } },
        },
      },
    });

    return res.json({
      id: convo.id,
      slug: convo.slug,
      title: convo.title,
      createdAt: convo.createdAt,
      participants: convo.participants.map((cp) => ({
        id: cp.user.id,
        firstName: cp.user.firstName,
      })),
    });
  } catch (err) {
    console.error('POST /conversations error:', err);
    return res.status(500).json({ erreur: 'Erreur interne du serveur.' });
  }
});

// GET /conversations/:id/messages — liste les messages (oldest first, pour rendu direct en thread)
// ?limit=50&before=<messageId> pour pagination (charge des messages plus anciens)
router.get('/:id/messages', auth, async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const p = await ensureParticipant(req.user.id, id);
    if (!p) return res.status(404).json({ erreur: 'Conversation introuvable.' });

    let limit = Number.parseInt(req.query.limit, 10);
    if (!Number.isFinite(limit) || limit <= 0) limit = 50;
    if (limit > 200) limit = 200;

    const beforeId = Number.parseInt(req.query.before, 10);

    const where = { conversationId: id };
    if (Number.isFinite(beforeId) && beforeId > 0) where.id = { lt: beforeId };

    // On récupère les N derniers, puis on renverse pour retour oldest-first.
    const recent = await prisma.message.findMany({
      where,
      orderBy: { id: 'desc' },
      take: limit,
      include: { author: { select: { id: true, firstName: true } } },
    });

    const messages = recent.reverse().map((m) => ({
      id: m.id,
      authorId: m.authorId,
      authorFirstName: m.author ? m.author.firstName : null,
      body: m.body,
      createdAt: m.createdAt,
      editedAt: m.editedAt,
    }));

    return res.json({ messages, hasMore: recent.length === limit });
  } catch (err) {
    console.error('GET /conversations/:id/messages error:', err);
    return res.status(500).json({ erreur: 'Erreur interne du serveur.' });
  }
});

// POST /conversations/:id/messages — envoie un message + push auto
// body: { body: string }
router.post('/:id/messages', auth, async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const p = await ensureParticipant(req.user.id, id);
    if (!p) return res.status(404).json({ erreur: 'Conversation introuvable.' });

    const raw = (req.body && req.body.body) || '';
    const body = String(raw).trim();
    if (!body) return res.status(400).json({ erreur: 'Message vide.' });
    if (body.length > 4000) return res.status(400).json({ erreur: 'Message trop long (max 4000 caractères).' });

    const now = new Date();
    const [msg] = await prisma.$transaction([
      prisma.message.create({
        data: { conversationId: id, authorId: req.user.id, body, createdAt: now },
        include: { author: { select: { id: true, firstName: true } } },
      }),
      prisma.conversation.update({
        where: { id },
        data: { lastMessageAt: now },
      }),
      prisma.conversationParticipant.update({
        where: { conversationId_userId: { conversationId: id, userId: req.user.id } },
        data: { lastReadAt: now },
      }),
    ]);

    // Push auto à tous les autres participants, best-effort (pas bloquant pour la réponse)
    if (typeof sendPushToUser === 'function') {
      (async () => {
        try {
          const otherParticipants = await prisma.conversationParticipant.findMany({
            where: { conversationId: id, userId: { not: req.user.id } },
            select: { userId: true },
          });
          const convo = await prisma.conversation.findUnique({
            where: { id },
            select: { title: true, slug: true },
          });
          const title = convo && convo.title
            ? `${convo.title} · ${msg.author.firstName}`
            : `Mission Control · ${msg.author.firstName}`;
          const preview = body.length > 90 ? body.slice(0, 87) + '…' : body;
          const payload = {
            title,
            body: preview,
            url: `/apps/messagerie/thread/?id=${id}`,
            tag: `convo-${id}`,
          };
          await Promise.all(
            otherParticipants.map((op) => sendPushToUser(op.userId, payload).catch((e) => {
              console.warn('[messagerie] push fail for user', op.userId, e && e.message);
            }))
          );
        } catch (e) {
          console.warn('[messagerie] push dispatch failed:', e && e.message);
        }
      })();
    }

    return res.json({
      id: msg.id,
      authorId: msg.authorId,
      authorFirstName: msg.author ? msg.author.firstName : null,
      body: msg.body,
      createdAt: msg.createdAt,
    });
  } catch (err) {
    console.error('POST /conversations/:id/messages error:', err);
    return res.status(500).json({ erreur: 'Erreur interne du serveur.' });
  }
});

// POST /conversations/:id/read — marque la convo lue (réinitialise le unread badge)
router.post('/:id/read', auth, async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const p = await ensureParticipant(req.user.id, id);
    if (!p) return res.status(404).json({ erreur: 'Conversation introuvable.' });

    await prisma.conversationParticipant.update({
      where: { conversationId_userId: { conversationId: id, userId: req.user.id } },
      data: { lastReadAt: new Date() },
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error('POST /conversations/:id/read error:', err);
    return res.status(500).json({ erreur: 'Erreur interne du serveur.' });
  }
});

module.exports = router;
