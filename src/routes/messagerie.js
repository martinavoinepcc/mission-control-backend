// Routes /conversations — messagerie familiale.
//
// Architecture :
// - GET  /conversations                     → liste des convos (+ last msg + unread + avatars)
// - GET  /conversations/:id                 → détails d'une convo + participants (+ avatars)
// - POST /conversations                     → crée une convo (body: { title?, participantIds })
// - GET  /conversations/:id/messages        → liste les messages (?limit=50&before=<id>)
// - POST /conversations/:id/messages        → envoie un message + push auto. Body: { body, image? }
// - POST /conversations/:id/read            → reset lastReadAt

const express = require('express');
const { PrismaClient } = require('@prisma/client');
const auth = require('../middleware/auth');
const pushModule = require('./push');

const prisma = new PrismaClient();
const router = express.Router();

const sendPushToUser = pushModule && pushModule.sendPushToUser;

// Limite taille image message (base64 data URL). 2 MB laisse de la marge pour les photos iPhone
// qui sortent parfois ~1-1.5 MB même après compression webp qualité 0.5.
const MAX_IMAGE_BASE64_BYTES = 2 * 1024 * 1024;

// Base URL pour les avatars dans les push icon (doit être absolue).
const PUBLIC_API_URL =
  process.env.PUBLIC_API_URL || 'https://api.my-mission-control.com';

async function ensureParticipant(userId, conversationId) {
  if (!Number.isFinite(conversationId) || conversationId <= 0) return null;
  return prisma.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId, userId } },
  });
}

// GET /conversations — liste
router.get('/', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const participations = await prisma.conversationParticipant.findMany({
      where: { userId },
      include: {
        conversation: {
          include: {
            participants: {
              include: {
                user: {
                  select: {
                    id: true, firstName: true, username: true, avatarData: true,
                    avatarUpdatedAt: true,
                  },
                },
              },
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
            hasAvatar: !!cp.user.avatarData,
            avatarUpdatedAt: cp.user.avatarUpdatedAt,
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

// GET /conversations/:id
router.get('/:id', auth, async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const p = await ensureParticipant(req.user.id, id);
    if (!p) return res.status(404).json({ erreur: 'Conversation introuvable.' });

    const convo = await prisma.conversation.findUnique({
      where: { id },
      include: {
        participants: {
          include: {
            user: {
              select: {
                id: true, firstName: true, username: true,
                avatarData: true, avatarUpdatedAt: true,
              },
            },
          },
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
        hasAvatar: !!cp.user.avatarData,
        avatarUpdatedAt: cp.user.avatarUpdatedAt,
      })),
    });
  } catch (err) {
    console.error('GET /conversations/:id error:', err);
    return res.status(500).json({ erreur: 'Erreur interne du serveur.' });
  }
});

// POST /conversations — crée
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

    const users = await prisma.user.findMany({ where: { id: { in: sanitized } } });
    if (users.length !== sanitized.length) {
      return res.status(400).json({ erreur: 'Un ou plusieurs utilisateurs introuvables.' });
    }

    const cleanTitle = typeof title === 'string' && title.trim() ? title.trim().slice(0, 80) : null;

    // DM dedup : si c'est une conversation 1-à-1 sans titre, réutiliser la convo existante
    // entre ces 2 users si elle existe (évite les doublons de DM).
    if (sanitized.length === 2 && !cleanTitle) {
      const otherId = sanitized.find((id) => id !== req.user.id);
      const myParticipations = await prisma.conversationParticipant.findMany({
        where: { userId: req.user.id },
        include: {
          conversation: {
            include: {
              participants: {
                include: {
                  user: {
                    select: {
                      id: true, firstName: true, username: true,
                      avatarData: true, avatarUpdatedAt: true,
                    },
                  },
                },
              },
            },
          },
        },
      });
      const match = myParticipations.find(
        (p) =>
          p.conversation.title === null &&
          p.conversation.participants.length === 2 &&
          p.conversation.participants.some((cp) => cp.userId === otherId)
      );
      if (match) {
        const convo = match.conversation;
        return res.json({
          id: convo.id,
          slug: convo.slug,
          title: convo.title,
          createdAt: convo.createdAt,
          reused: true,
          participants: convo.participants.map((cp) => ({
            id: cp.user.id,
            firstName: cp.user.firstName,
            hasAvatar: !!cp.user.avatarData,
            avatarUpdatedAt: cp.user.avatarUpdatedAt,
          })),
        });
      }
    }

    const convo = await prisma.conversation.create({
      data: {
        title: cleanTitle,
        createdById: req.user.id,
        participants: { create: sanitized.map((uid) => ({ userId: uid })) },
      },
      include: {
        participants: {
          include: {
            user: {
              select: {
                id: true, firstName: true,
                avatarData: true, avatarUpdatedAt: true,
              },
            },
          },
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
        hasAvatar: !!cp.user.avatarData,
        avatarUpdatedAt: cp.user.avatarUpdatedAt,
      })),
    });
  } catch (err) {
    console.error('POST /conversations error:', err);
    return res.status(500).json({ erreur: 'Erreur interne du serveur.' });
  }
});

// GET /conversations/:id/messages
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
      imageData: m.imageData || null,
      imageWidth: m.imageWidth || null,
      imageHeight: m.imageHeight || null,
      createdAt: m.createdAt,
      editedAt: m.editedAt,
    }));

    return res.json({ messages, hasMore: recent.length === limit });
  } catch (err) {
    console.error('GET /conversations/:id/messages error:', err);
    return res.status(500).json({ erreur: 'Erreur interne du serveur.' });
  }
});

// POST /conversations/:id/messages — envoie un message (texte et/ou image) + push auto
router.post('/:id/messages', auth, async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const p = await ensureParticipant(req.user.id, id);
    if (!p) return res.status(404).json({ erreur: 'Conversation introuvable.' });

    const raw = (req.body && req.body.body) || '';
    const body = String(raw).trim();
    const image = req.body && req.body.image; // { data, width, height } or undefined

    if (!body && !image) {
      return res.status(400).json({ erreur: 'Message vide (texte ou image requis).' });
    }
    if (body.length > 4000) {
      return res.status(400).json({ erreur: 'Message trop long (max 4000 caractères).' });
    }

    let imageData = null;
    let imageWidth = null;
    let imageHeight = null;
    if (image && typeof image.data === 'string') {
      if (!image.data.startsWith('data:image/')) {
        return res.status(400).json({ erreur: 'Image invalide (data URL attendue).' });
      }
      if (image.data.length > MAX_IMAGE_BASE64_BYTES) {
        return res.status(413).json({
          erreur: `Image trop volumineuse (${Math.round(image.data.length / 1024)} KB). Max ~${Math.round(MAX_IMAGE_BASE64_BYTES / 1024)} KB.`,
        });
      }
      imageData = image.data;
      imageWidth = Number.isFinite(image.width) ? Math.max(1, Math.floor(image.width)) : null;
      imageHeight = Number.isFinite(image.height) ? Math.max(1, Math.floor(image.height)) : null;
    }

    const now = new Date();
    const [msg] = await prisma.$transaction([
      prisma.message.create({
        data: {
          conversationId: id,
          authorId: req.user.id,
          body,
          imageData,
          imageWidth,
          imageHeight,
          createdAt: now,
        },
        include: { author: { select: { id: true, firstName: true, avatarData: true } } },
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
          const authorName = msg.author.firstName;
          const title = convo && convo.title
            ? `${convo.title} · ${authorName}`
            : authorName;
          let preview;
          if (body && imageData) preview = `📷 ${body.length > 80 ? body.slice(0, 77) + '…' : body}`;
          else if (imageData) preview = '📷 a envoyé une photo';
          else preview = body.length > 100 ? body.slice(0, 97) + '…' : body;

          const hasAvatar = !!msg.author.avatarData;
          const iconUrl = hasAvatar
            ? `${PUBLIC_API_URL}/users/${msg.author.id}/avatar`
            : '/icons/icon-192.png';

          const payload = {
            title,
            body: preview,
            url: `/apps/messagerie/thread/?id=${id}`,
            tag: `convo-${id}`,
            icon: iconUrl,
            // Large preview image (Android expanded notif + iOS long-press).
            // iOS forces the PWA icon on the lock-screen thumbnail no matter what,
            // so this is the only way to surface the sender's photo on iPhone.
            ...(hasAvatar ? { image: iconUrl } : {}),
          };
          await Promise.all(
            otherParticipants.map((op) =>
              sendPushToUser(op.userId, payload).catch((e) => {
                console.warn('[messagerie] push fail for user', op.userId, e && e.message);
              })
            )
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
      imageData: msg.imageData || null,
      imageWidth: msg.imageWidth || null,
      imageHeight: msg.imageHeight || null,
      createdAt: msg.createdAt,
    });
  } catch (err) {
    console.error('POST /conversations/:id/messages error:', err);
    return res.status(500).json({ erreur: 'Erreur interne du serveur.' });
  }
});

// POST /conversations/:id/read
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

// DELETE /conversations/:id — supprime la conversation pour tout le monde.
// Seul un participant peut supprimer (sinon 404). Cascade supprime messages + participants.
// Note : la convo "famille" peut être supprimée ; elle sera re-seedée vide au prochain
// deploy backend (seed idempotent avec upsert sur slug). Intentionnel.
router.delete('/:id', auth, async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const p = await ensureParticipant(req.user.id, id);
    if (!p) return res.status(404).json({ erreur: 'Conversation introuvable.' });

    // Cascade delete via Prisma schema (Message + ConversationParticipant onDelete: Cascade)
    await prisma.conversation.delete({ where: { id } });
    return res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /conversations/:id error:', err);
    return res.status(500).json({ erreur: 'Erreur interne du serveur.' });
  }
});

module.exports = router;
