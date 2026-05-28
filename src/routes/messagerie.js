// Routes /conversations — messagerie familiale.
//
// Architecture :
// - GET  /conversations                     → liste des convos (+ last msg + unread + avatars)
// - GET  /conversations/:id                 → détails d'une convo + participants (+ avatars)
// - POST /conversations                     → crée une convo (body: { title?, participantIds })
// - GET  /conversations/:id/messages        → liste les messages (?limit=50&before=<id>)
// - POST /conversations/:id/messages        → envoie un message + push auto. Body: { body, image? }
// - POST /conversations/:id/read            → reset lastReadAt + MessageRead bulk + broadcast SSE
// - POST /conversations/:id/typing          → broadcast SSE 'typing' (pas de DB)
// - PATCH/DELETE /conversations/:id/messages/:msgId → edit (<=3min) / soft-delete
//
// V2.6 : chaque mutation broadcast un event SSE aux participants concernes.
// V2.7 : typing + MessageRead par message.
// V2.8 : edit (auteur, <=3min) + soft-delete (auteur ou admin).
// V2.10 : badge count global non-lus dans le payload push.

const express = require('express');
const rateLimit = require('express-rate-limit');
const { PrismaClient } = require('@prisma/client');
const auth = require('../middleware/auth');
const pushModule = require('./push');
const sseModule = require('./messagerie-sse');

// V1.3 : limites par userId (pas IP — Render est derriere un NAT, sinon tous
// les users seraient penalises ensemble). keyGenerator fallback sur IP si pas auth.
const messageLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  keyGenerator: (req) => String((req.user && req.user.id) || req.ip),
  message: { erreur: 'Trop de messages, ralentis un peu 😅' },
  standardHeaders: true,
  legacyHeaders: false,
});

const reactionLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  keyGenerator: (req) => String((req.user && req.user.id) || req.ip),
  message: { erreur: 'Trop de reactions, ralentis 😅' },
  standardHeaders: true,
  legacyHeaders: false,
});

// V2.7 : typing rate-limit 20/min/user pour eviter le spam de keystrokes.
const typingLimiter = rateLimit({
  windowMs: 60_000,
  max: 20,
  keyGenerator: (req) => String((req.user && req.user.id) || req.ip),
  message: { erreur: 'Trop de signaux typing.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const prisma = new PrismaClient();
const router = express.Router();

const sendPushToUser = pushModule && pushModule.sendPushToUser;
const broadcastToConversation = sseModule && sseModule.broadcastToConversation;
const broadcastToUser = sseModule && sseModule.broadcastToUser;

// Limite taille image message (base64 data URL). 2 MB laisse de la marge pour les photos iPhone
// qui sortent parfois ~1-1.5 MB même après compression webp qualité 0.5.
const MAX_IMAGE_BASE64_BYTES = 2 * 1024 * 1024;
// Limite taille audio (MP3 et autres formats audio). 6 MB en base64 ≈ 4.5 MB MP3 ≈ ~5min de speech.
const MAX_AUDIO_BASE64_BYTES = 6 * 1024 * 1024;
// Types audio acceptes (whitelist stricte). audio/webm pour l'enregistrement vocal in-app V2.9.
const ALLOWED_AUDIO_TYPES = ['audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/m4a', 'audio/aac', 'audio/wav', 'audio/webm', 'audio/ogg'];
// Emojis autorisees pour reactions (whitelist pour eviter les injections / abus).
const ALLOWED_REACTION_EMOJIS = ['👍','❤️','😂','😮','😢','🔥'];

// V2.8 : fenetre d'edition d'un message (3 min apres envoi).
const EDIT_WINDOW_MS = 3 * 60 * 1000;

// Base URL pour les avatars dans les push icon (doit être absolue).
const PUBLIC_API_URL =
  process.env.PUBLIC_API_URL || 'https://api.my-mission-control.com';

async function ensureParticipant(userId, conversationId) {
  if (!Number.isFinite(conversationId) || conversationId <= 0) return null;
  return prisma.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId, userId } },
  });
}

// V2.10 : compte global de messages non-lus pour un user (toutes convos confondues).
// Utilise pour le badge SW push-driven.
async function getUnreadCountForUser(userId) {
  try {
    const rows = await prisma.$queryRaw`
      SELECT COUNT(m.id)::int AS n
      FROM "ConversationParticipant" cp
      JOIN "Message" m ON m."conversationId" = cp."conversationId"
      WHERE cp."userId" = ${userId}
        AND m."createdAt" > cp."lastReadAt"
        AND m."authorId" != ${userId}
        AND m."deletedAt" IS NULL
    `;
    return Number((rows && rows[0] && rows[0].n) || 0);
  } catch (err) {
    console.warn('[messagerie] getUnreadCountForUser failed:', err && err.message);
    return 0;
  }
}

// GET /conversations — liste
// V1.5 fixes :
//  - N+1 unreadCount : remplace par UN raw query groupBy.
//  - Leak avatarData : on ne select plus le blob ; flag hasAvatar via une query separee.
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
                    id: true, firstName: true, username: true,
                    avatarUpdatedAt: true,
                    // PAS avatarData (blob lourd inutile).
                  },
                },
              },
            },
            messages: {
              orderBy: { createdAt: 'desc' },
              take: 1,
              // V2.8 : exclut les messages soft-deleted du "last message" affiche
              where: { deletedAt: null },
              include: { author: { select: { id: true, firstName: true } } },
            },
          },
        },
      },
    });

    // V1.5 N+1 fix : un seul raw query pour calculer les unread par convo.
    // V2.8 : exclut les messages soft-deleted.
    const unreadMap = new Map();
    if (participations.length > 0) {
      const rows = await prisma.$queryRaw`
        SELECT cp."conversationId" AS "convoId", COUNT(m.id)::int AS "unread"
        FROM "ConversationParticipant" cp
        LEFT JOIN "Message" m
          ON m."conversationId" = cp."conversationId"
         AND m."createdAt" > cp."lastReadAt"
         AND m."authorId" != cp."userId"
         AND m."deletedAt" IS NULL
        WHERE cp."userId" = ${userId}
        GROUP BY cp."conversationId"
      `;
      for (const r of rows) {
        unreadMap.set(Number(r.convoId), Number(r.unread) || 0);
      }
    }

    // V1.5 avatar leak fix
    const allParticipantIds = new Set();
    for (const p of participations) {
      for (const cp of p.conversation.participants) {
        allParticipantIds.add(cp.user.id);
      }
    }
    const avatarOwners = allParticipantIds.size > 0
      ? await prisma.user.findMany({
          where: { id: { in: Array.from(allParticipantIds) }, NOT: { avatarData: null } },
          select: { id: true },
        })
      : [];
    const hasAvatarSet = new Set(avatarOwners.map((u) => u.id));

    const results = participations.map((p) => {
      const convo = p.conversation;
      const lastMsg = convo.messages[0] || null;
      return {
        id: convo.id,
        slug: convo.slug,
        title: convo.title,
        lastMessageAt: convo.lastMessageAt,
        unreadCount: unreadMap.get(convo.id) || 0,
        participants: convo.participants.map((cp) => ({
          id: cp.user.id,
          firstName: cp.user.firstName,
          hasAvatar: hasAvatarSet.has(cp.user.id),
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
    });

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
                avatarUpdatedAt: true,
              },
            },
          },
        },
      },
    });
    if (!convo) return res.status(404).json({ erreur: 'Conversation introuvable.' });

    const partIds = convo.participants.map((cp) => cp.user.id);
    const avatarOwners = partIds.length
      ? await prisma.user.findMany({
          where: { id: { in: partIds }, NOT: { avatarData: null } },
          select: { id: true },
        })
      : [];
    const hasAvatarSet = new Set(avatarOwners.map((u) => u.id));

    return res.json({
      id: convo.id,
      slug: convo.slug,
      title: convo.title,
      createdAt: convo.createdAt,
      createdById: convo.createdById,
      lastMessageAt: convo.lastMessageAt,
      participants: convo.participants.map((cp) => ({
        id: cp.user.id,
        firstName: cp.user.firstName,
        username: cp.user.username,
        hasAvatar: hasAvatarSet.has(cp.user.id),
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

    // DM dedup
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
                      avatarUpdatedAt: true,
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
        const partIds = convo.participants.map((cp) => cp.user.id);
        const avatarOwners = await prisma.user.findMany({
          where: { id: { in: partIds }, NOT: { avatarData: null } },
          select: { id: true },
        });
        const hasAvatarSet = new Set(avatarOwners.map((u) => u.id));
        return res.json({
          id: convo.id,
          slug: convo.slug,
          title: convo.title,
          createdAt: convo.createdAt,
          reused: true,
          participants: convo.participants.map((cp) => ({
            id: cp.user.id,
            firstName: cp.user.firstName,
            hasAvatar: hasAvatarSet.has(cp.user.id),
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
                avatarUpdatedAt: true,
              },
            },
          },
        },
      },
    });

    const partIds = convo.participants.map((cp) => cp.user.id);
    const avatarOwners = await prisma.user.findMany({
      where: { id: { in: partIds }, NOT: { avatarData: null } },
      select: { id: true },
    });
    const hasAvatarSet = new Set(avatarOwners.map((u) => u.id));

    return res.json({
      id: convo.id,
      slug: convo.slug,
      title: convo.title,
      createdAt: convo.createdAt,
      participants: convo.participants.map((cp) => ({
        id: cp.user.id,
        firstName: cp.user.firstName,
        hasAvatar: hasAvatarSet.has(cp.user.id),
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

    // V2.7 : on inclut MessageRead pour chaque message (filtres aux autres users).
    const recent = await prisma.message.findMany({
      where,
      orderBy: { id: 'desc' },
      take: limit,
      select: {
        id: true,
        authorId: true,
        body: true,
        imageWidth: true,
        imageHeight: true,
        audioType: true,
        audioName: true,
        replyToId: true,
        createdAt: true,
        editedAt: true,
        deletedAt: true,
        author: { select: { id: true, firstName: true } },
        replyTo: {
          select: {
            id: true, body: true, authorId: true, audioName: true, deletedAt: true,
            author: { select: { id: true, firstName: true } },
          },
        },
        reactions: { select: { emoji: true, userId: true } },
        reads: { select: { userId: true, readAt: true } },
      },
    });

    // Calcule hasImage / hasAudio sans rapatrier les blobs (un seul raw query).
    const msgIds = recent.map((m) => m.id);
    const replyIds = recent.map((m) => m.replyToId).filter((x) => Number.isFinite(x));
    const allIds = Array.from(new Set([...msgIds, ...replyIds]));
    const flagsMap = new Map();
    if (allIds.length > 0) {
      const rows = await prisma.$queryRawUnsafe(
        `SELECT id, ("imageData" IS NOT NULL) AS "hasImage", ("audioData" IS NOT NULL) AS "hasAudio" FROM "Message" WHERE id IN (${allIds.map((_, i) => '$' + (i + 1)).join(',')})`,
        ...allIds
      );
      for (const r of rows) {
        flagsMap.set(Number(r.id), { hasImage: !!r.hasImage, hasAudio: !!r.hasAudio });
      }
    }

    function aggregateReactions(rxs, currentUserId) {
      const byEmoji = new Map();
      for (const r of rxs || []) {
        if (!byEmoji.has(r.emoji)) byEmoji.set(r.emoji, { emoji: r.emoji, count: 0, mine: false, userIds: [] });
        const e = byEmoji.get(r.emoji);
        e.count++;
        e.userIds.push(r.userId);
        if (r.userId === currentUserId) e.mine = true;
      }
      return Array.from(byEmoji.values());
    }

    const messages = recent.reverse().map((m) => {
      const flags = flagsMap.get(m.id) || { hasImage: false, hasAudio: false };
      const replyFlags = m.replyTo ? (flagsMap.get(m.replyTo.id) || { hasImage: false, hasAudio: false }) : null;
      const isDeleted = !!m.deletedAt;
      // V2.7 : filtre les reads aux participants autres que l'auteur (l'auteur a
      // lu par definition). On garde tous les reads des autres pour pouvoir
      // afficher les mini-avatars sous les messages.
      const reads = (m.reads || [])
        .filter((r) => r.userId !== m.authorId)
        .map((r) => ({ userId: r.userId, readAt: r.readAt }));
      return {
        id: m.id,
        authorId: m.authorId,
        authorFirstName: m.author ? m.author.firstName : null,
        // V2.8 : body vidé si soft-deleted (par securite, aussi cote serveur).
        body: isDeleted ? '' : m.body,
        hasImage: !isDeleted && flags.hasImage,
        imageWidth: isDeleted ? null : (m.imageWidth || null),
        imageHeight: isDeleted ? null : (m.imageHeight || null),
        hasAudio: !isDeleted && flags.hasAudio,
        audioType: isDeleted ? null : (m.audioType || null),
        audioName: isDeleted ? null : (m.audioName || null),
        replyTo: m.replyTo ? {
          id: m.replyTo.id,
          body: m.replyTo.deletedAt ? '' : m.replyTo.body,
          authorId: m.replyTo.authorId,
          authorFirstName: m.replyTo.author ? m.replyTo.author.firstName : null,
          hasImage: !m.replyTo.deletedAt && !!(replyFlags && replyFlags.hasImage),
          hasAudio: !m.replyTo.deletedAt && !!(replyFlags && replyFlags.hasAudio),
          audioName: m.replyTo.deletedAt ? null : (m.replyTo.audioName || null),
          deletedAt: m.replyTo.deletedAt || null,
        } : null,
        reactions: isDeleted ? [] : aggregateReactions(m.reactions, req.user.id),
        reads,
        createdAt: m.createdAt,
        editedAt: m.editedAt,
        deletedAt: m.deletedAt || null,
      };
    });

    return res.json({ messages, hasMore: recent.length === limit });
  } catch (err) {
    console.error('GET /conversations/:id/messages error:', err);
    return res.status(500).json({ erreur: 'Erreur interne du serveur.' });
  }
});

// Formatte un message pour SSE / response API (sans imageData/audioData).
function formatMessageForBroadcast(msg, hasImage, hasAudio) {
  return {
    id: msg.id,
    authorId: msg.authorId,
    authorFirstName: msg.author ? msg.author.firstName : null,
    body: msg.body,
    hasImage: !!hasImage,
    imageWidth: msg.imageWidth || null,
    imageHeight: msg.imageHeight || null,
    hasAudio: !!hasAudio,
    audioType: msg.audioType || null,
    audioName: msg.audioName || null,
    replyTo: msg.replyTo ? {
      id: msg.replyTo.id,
      body: msg.replyTo.deletedAt ? '' : msg.replyTo.body,
      authorId: msg.replyTo.authorId,
      authorFirstName: msg.replyTo.author ? msg.replyTo.author.firstName : null,
      hasImage: !msg.replyTo.deletedAt && !!msg.replyTo.imageData,
      hasAudio: !msg.replyTo.deletedAt && !!msg.replyTo.audioData,
      audioName: msg.replyTo.deletedAt ? null : (msg.replyTo.audioName || null),
      deletedAt: msg.replyTo.deletedAt || null,
    } : null,
    reactions: [],
    reads: [],
    createdAt: msg.createdAt,
    editedAt: msg.editedAt || null,
    deletedAt: msg.deletedAt || null,
  };
}

// POST /conversations/:id/messages — envoie un message (texte et/ou image) + push auto
router.post('/:id/messages', auth, messageLimiter, async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const p = await ensureParticipant(req.user.id, id);
    if (!p) return res.status(404).json({ erreur: 'Conversation introuvable.' });

    const raw = (req.body && req.body.body) || '';
    const body = String(raw).trim();
    const image = req.body && req.body.image;
    const audio = req.body && req.body.audio;
    const replyToIdRaw = req.body && req.body.replyToId;

    if (!body && !image && !audio) {
      return res.status(400).json({ erreur: 'Message vide (texte, image ou audio requis).' });
    }

    let replyToId = null;
    if (replyToIdRaw !== undefined && replyToIdRaw !== null) {
      const candidate = Number.parseInt(replyToIdRaw, 10);
      if (!Number.isFinite(candidate) || candidate <= 0) {
        return res.status(400).json({ erreur: 'replyToId invalide.' });
      }
      const target = await prisma.message.findFirst({
        where: { id: candidate, conversationId: id },
        select: { id: true },
      });
      if (!target) {
        return res.status(400).json({ erreur: 'replyTo introuvable dans cette conversation.' });
      }
      replyToId = candidate;
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

    let audioData = null;
    let audioType = null;
    let audioName = null;
    if (audio && typeof audio.data === 'string') {
      if (!audio.data.startsWith('data:audio/')) {
        return res.status(400).json({ erreur: 'Audio invalide (data URL audio attendue).' });
      }
      if (audio.data.length > MAX_AUDIO_BASE64_BYTES) {
        return res.status(413).json({
          erreur: `Audio trop volumineux (${Math.round(audio.data.length / 1024)} KB). Max ~${Math.round(MAX_AUDIO_BASE64_BYTES / 1024)} KB (~5 min MP3).`,
        });
      }
      const declaredType = (typeof audio.type === 'string' && audio.type) ? audio.type.toLowerCase() : null;
      const mimeMatch = audio.data.match(/^data:(audio\/[^;]+)/);
      // V2.9 : MediaRecorder produit "audio/webm;codecs=opus" — split sur ; pour
      // garder uniquement le mime sans les codecs.
      const rawMime = declaredType || (mimeMatch ? mimeMatch[1].toLowerCase() : null);
      const mime = rawMime ? rawMime.split(';')[0].trim() : null;
      if (!mime || !ALLOWED_AUDIO_TYPES.includes(mime)) {
        return res.status(400).json({
          erreur: `Type audio non supporte (${mime || 'inconnu'}). Formats acceptes : ${ALLOWED_AUDIO_TYPES.join(', ')}.`,
        });
      }
      audioData = audio.data;
      audioType = mime;
      const rawName = (typeof audio.name === 'string' && audio.name) ? audio.name : 'audio.mp3';
      audioName = rawName.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'audio.mp3';
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
          audioData,
          audioType,
          audioName,
          replyToId,
          createdAt: now,
        },
        include: {
          author: { select: { id: true, firstName: true, avatarData: true } },
          replyTo: {
            select: {
              id: true, body: true, authorId: true, audioName: true, deletedAt: true,
              imageData: true, audioData: true,
              author: { select: { id: true, firstName: true } },
            },
          },
        },
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

    // V2.6 : broadcast SSE 'message:new' aux autres participants.
    if (typeof broadcastToConversation === 'function') {
      const broadcastMsg = formatMessageForBroadcast(msg, !!imageData, !!audioData);
      broadcastToConversation(id, 'message:new', {
        conversationId: id,
        message: broadcastMsg,
      }, req.user.id).catch(() => {});
    }

    // Push fan-out + badge V2.10
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
          if (body && audioData) preview = `🎵 ${body.length > 80 ? body.slice(0, 77) + '…' : body}`;
          else if (audioData) preview = '🎵 a envoyé un audio';
          else if (body && imageData) preview = `📷 ${body.length > 80 ? body.slice(0, 77) + '…' : body}`;
          else if (imageData) preview = '📷 a envoyé une photo';
          else preview = body.length > 100 ? body.slice(0, 97) + '…' : body;

          const iconUrl = msg.author.avatarData
            ? `${PUBLIC_API_URL}/users/${msg.author.id}/avatar`
            : '/icons/icon-192.png';

          await Promise.all(
            otherParticipants.map(async (op) => {
              // V2.10 : badge global non-lus pour cet user (apres l'insert).
              const badge = await getUnreadCountForUser(op.userId);
              const payload = {
                title,
                body: preview,
                url: `/apps/messagerie/thread/?id=${id}`,
                tag: `convo-${id}`,
                icon: iconUrl,
                badge,
              };
              return sendPushToUser(op.userId, payload).catch((e) => {
                console.warn('[messagerie] push fail for user', op.userId, e && e.message);
              });
            })
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
      hasImage: !!msg.imageData,
      imageWidth: msg.imageWidth || null,
      imageHeight: msg.imageHeight || null,
      hasAudio: !!msg.audioData,
      audioType: msg.audioType || null,
      audioName: msg.audioName || null,
      replyTo: msg.replyTo ? {
        id: msg.replyTo.id,
        body: msg.replyTo.deletedAt ? '' : msg.replyTo.body,
        authorId: msg.replyTo.authorId,
        authorFirstName: msg.replyTo.author ? msg.replyTo.author.firstName : null,
        hasImage: !msg.replyTo.deletedAt && !!msg.replyTo.imageData,
        hasAudio: !msg.replyTo.deletedAt && !!msg.replyTo.audioData,
        audioName: msg.replyTo.deletedAt ? null : (msg.replyTo.audioName || null),
        deletedAt: msg.replyTo.deletedAt || null,
      } : null,
      reactions: [],
      reads: [],
      createdAt: msg.createdAt,
      editedAt: msg.editedAt || null,
      deletedAt: msg.deletedAt || null,
    });
  } catch (err) {
    console.error('POST /conversations/:id/messages error:', err);
    return res.status(500).json({ erreur: 'Erreur interne du serveur.' });
  }
});

// POST /conversations/:id/read — V2.7 : reset lastReadAt + cree MessageRead bulk + broadcast SSE
router.post('/:id/read', auth, async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const p = await ensureParticipant(req.user.id, id);
    if (!p) return res.status(404).json({ erreur: 'Conversation introuvable.' });

    const now = new Date();
    await prisma.conversationParticipant.update({
      where: { conversationId_userId: { conversationId: id, userId: req.user.id } },
      data: { lastReadAt: now },
    });

    // V2.7 : insere des MessageRead pour TOUS les messages de la convo dont
    // createdAt <= now ET pas l'auteur (pas besoin de "se lire soi-meme") ET
    // pas deja lu (skipDuplicates). createMany est plus efficient que des inserts
    // un par un, surtout si la convo a beaucoup de messages.
    try {
      const msgsToMark = await prisma.message.findMany({
        where: {
          conversationId: id,
          createdAt: { lte: now },
          authorId: { not: req.user.id },
          deletedAt: null,
          // Pas de MessageRead deja pour cet user
          reads: { none: { userId: req.user.id } },
        },
        select: { id: true },
        take: 500, // garde-fou
      });
      if (msgsToMark.length > 0) {
        await prisma.messageRead.createMany({
          data: msgsToMark.map((m) => ({
            messageId: m.id,
            userId: req.user.id,
            readAt: now,
          })),
          skipDuplicates: true,
        });
      }
    } catch (err) {
      console.warn('[messagerie] MessageRead bulk insert failed:', err && err.message);
    }

    // V2.6 : broadcast SSE 'read' aux autres participants.
    if (typeof broadcastToConversation === 'function') {
      broadcastToConversation(id, 'read', {
        conversationId: id,
        userId: req.user.id,
        lastReadAt: now,
      }, req.user.id).catch(() => {});
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('POST /conversations/:id/read error:', err);
    return res.status(500).json({ erreur: 'Erreur interne du serveur.' });
  }
});

// POST /conversations/:id/typing — V2.7 : broadcast SSE 'typing' (pas de DB)
router.post('/:id/typing', auth, typingLimiter, async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const p = await ensureParticipant(req.user.id, id);
    if (!p) return res.status(404).json({ erreur: 'Conversation introuvable.' });

    if (typeof broadcastToConversation === 'function') {
      const me = await prisma.user.findUnique({
        where: { id: req.user.id },
        select: { firstName: true },
      });
      const now = Date.now();
      broadcastToConversation(id, 'typing', {
        conversationId: id,
        userId: req.user.id,
        displayName: me ? me.firstName : 'Quelqu\'un',
        expiresAt: now + 4000,
      }, req.user.id).catch(() => {});
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('POST /conversations/:id/typing error:', err);
    return res.status(500).json({ erreur: 'Erreur interne du serveur.' });
  }
});

// PATCH /conversations/:id/messages/:msgId — V2.8 edit (auteur, <=3min)
router.patch('/:id/messages/:msgId', auth, async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const msgId = Number.parseInt(req.params.msgId, 10);
    if (!Number.isFinite(id) || !Number.isFinite(msgId)) {
      return res.status(400).json({ erreur: 'Identifiants invalides.' });
    }
    const p = await ensureParticipant(req.user.id, id);
    if (!p) return res.status(404).json({ erreur: 'Conversation introuvable.' });

    const msg = await prisma.message.findFirst({
      where: { id: msgId, conversationId: id },
      select: { id: true, authorId: true, createdAt: true, deletedAt: true },
    });
    if (!msg) return res.status(404).json({ erreur: 'Message introuvable.' });
    if (msg.deletedAt) return res.status(410).json({ erreur: 'Message supprimé.' });
    if (msg.authorId !== req.user.id) {
      return res.status(403).json({ erreur: 'Seul l\'auteur peut modifier ce message.' });
    }
    const age = Date.now() - new Date(msg.createdAt).getTime();
    if (age > EDIT_WINDOW_MS) {
      return res.status(403).json({
        erreur: 'Modification possible seulement dans les 3 minutes après l\'envoi.',
      });
    }

    const raw = (req.body && req.body.body) || '';
    const newBody = String(raw).trim();
    if (!newBody) return res.status(400).json({ erreur: 'Le message ne peut pas être vide.' });
    if (newBody.length > 4000) {
      return res.status(400).json({ erreur: 'Message trop long (max 4000 caractères).' });
    }

    const now = new Date();
    await prisma.message.update({
      where: { id: msgId },
      data: { body: newBody, editedAt: now },
    });

    if (typeof broadcastToConversation === 'function') {
      broadcastToConversation(id, 'message:edit', {
        conversationId: id,
        messageId: msgId,
        body: newBody,
        editedAt: now,
      }).catch(() => {});
    }

    return res.json({ ok: true, messageId: msgId, body: newBody, editedAt: now });
  } catch (err) {
    console.error('PATCH /conversations/:id/messages/:msgId error:', err);
    return res.status(500).json({ erreur: 'Erreur interne du serveur.' });
  }
});

// DELETE /conversations/:id/messages/:msgId — V2.8 soft-delete
router.delete('/:id/messages/:msgId', auth, async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const msgId = Number.parseInt(req.params.msgId, 10);
    if (!Number.isFinite(id) || !Number.isFinite(msgId)) {
      return res.status(400).json({ erreur: 'Identifiants invalides.' });
    }
    const p = await ensureParticipant(req.user.id, id);
    if (!p) return res.status(404).json({ erreur: 'Conversation introuvable.' });

    const msg = await prisma.message.findFirst({
      where: { id: msgId, conversationId: id },
      select: { id: true, authorId: true, deletedAt: true },
    });
    if (!msg) return res.status(404).json({ erreur: 'Message introuvable.' });
    if (msg.deletedAt) return res.json({ ok: true }); // idempotent

    const isAdmin = req.user.role === 'ADMIN';
    const isAuthor = msg.authorId === req.user.id;
    if (!isAdmin && !isAuthor) {
      return res.status(403).json({ erreur: 'Seul l\'auteur ou un admin peut supprimer.' });
    }

    const now = new Date();
    // Soft-delete : vide body + blobs pour liberer la place + set deletedAt.
    await prisma.message.update({
      where: { id: msgId },
      data: {
        deletedAt: now,
        body: '',
        imageData: null,
        audioData: null,
      },
    });

    if (typeof broadcastToConversation === 'function') {
      broadcastToConversation(id, 'message:delete', {
        conversationId: id,
        messageId: msgId,
      }).catch(() => {});
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /conversations/:id/messages/:msgId error:', err);
    return res.status(500).json({ erreur: 'Erreur interne du serveur.' });
  }
});

// DELETE /conversations/:id — supprime la conversation pour TOUS les participants.
router.delete('/:id', auth, async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const p = await ensureParticipant(req.user.id, id);
    if (!p) return res.status(404).json({ erreur: 'Conversation introuvable.' });

    const convo = await prisma.conversation.findUnique({
      where: { id },
      select: { createdById: true },
    });
    if (!convo) return res.status(404).json({ erreur: 'Conversation introuvable.' });

    const isAdmin = req.user.role === 'ADMIN';
    const isCreator = convo.createdById === req.user.id;
    if (!isAdmin && !isCreator) {
      return res.status(403).json({
        erreur: "Seul Martin ou le createur peut supprimer une conversation. Utilise plutot /leave pour te retirer.",
      });
    }

    // V2.6 : broadcast SSE 'conversation:deleted' avant la suppression (on a
    // encore acces aux participants en DB).
    if (typeof broadcastToUser === 'function') {
      try {
        const parts = await prisma.conversationParticipant.findMany({
          where: { conversationId: id },
          select: { userId: true },
        });
        for (const part of parts) {
          broadcastToUser(part.userId, 'conversation:deleted', { conversationId: id });
        }
      } catch (e) { /* silencieux */ }
    }

    await prisma.conversation.delete({ where: { id } });
    return res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /conversations/:id error:', err);
    return res.status(500).json({ erreur: 'Erreur interne du serveur.' });
  }
});

// POST /conversations/:id/leave
router.post('/:id/leave', auth, async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const p = await ensureParticipant(req.user.id, id);
    if (!p) return res.status(404).json({ erreur: 'Conversation introuvable.' });

    const me = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { firstName: true },
    });
    const others = await prisma.conversationParticipant.findMany({
      where: { conversationId: id, userId: { not: req.user.id } },
      select: { userId: true },
    });

    await prisma.conversationParticipant.delete({
      where: { conversationId_userId: { conversationId: id, userId: req.user.id } },
    });

    // V2.6 : broadcast SSE
    if (typeof broadcastToConversation === 'function') {
      broadcastToConversation(id, 'participant:leave', {
        conversationId: id,
        userId: req.user.id,
      }).catch(() => {});
    }
    if (typeof broadcastToUser === 'function') {
      broadcastToUser(req.user.id, 'conversation:deleted', { conversationId: id });
    }

    if (typeof sendPushToUser === 'function' && me && others.length) {
      const authorName = me.firstName || 'Quelqu\'un';
      const payload = {
        title: 'Mission Control',
        body: `${authorName} a quitte la conversation`,
        url: `/apps/messagerie/thread/?id=${id}`,
        tag: `convo-${id}-leave`,
      };
      Promise.all(
        others.map((op) =>
          sendPushToUser(op.userId, payload).catch((e) => {
            console.warn('[messagerie/leave] push fail user', op.userId, e && e.message);
          })
        )
      ).catch(() => {});
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('POST /conversations/:id/leave error:', err);
    return res.status(500).json({ erreur: 'Erreur interne du serveur.' });
  }
});

// POST /conversations/:id/messages/:msgId/reactions — toggle reaction emoji
router.post('/:id/messages/:msgId/reactions', auth, reactionLimiter, async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const msgId = Number.parseInt(req.params.msgId, 10);
    const p = await ensureParticipant(req.user.id, id);
    if (!p) return res.status(404).json({ erreur: 'Conversation introuvable.' });

    const emoji = req.body && typeof req.body.emoji === 'string' ? req.body.emoji.trim() : '';
    if (!ALLOWED_REACTION_EMOJIS.includes(emoji)) {
      return res.status(400).json({ erreur: 'Emoji non autorise.' });
    }

    const msg = await prisma.message.findUnique({
      where: { id: msgId },
      select: { conversationId: true, deletedAt: true },
    });
    if (!msg || msg.conversationId !== id) {
      return res.status(404).json({ erreur: 'Message introuvable.' });
    }
    if (msg.deletedAt) {
      return res.status(410).json({ erreur: 'Message supprimé.' });
    }

    const existing = await prisma.messageReaction.findUnique({
      where: { messageId_userId_emoji: { messageId: msgId, userId: req.user.id, emoji } },
    });
    if (existing) {
      await prisma.messageReaction.delete({ where: { id: existing.id } });
    } else {
      await prisma.messageReaction.create({
        data: { messageId: msgId, userId: req.user.id, emoji },
      });
    }

    const all = await prisma.messageReaction.findMany({
      where: { messageId: msgId },
      select: { emoji: true, userId: true },
    });
    const byEmoji = new Map();
    for (const r of all) {
      if (!byEmoji.has(r.emoji)) byEmoji.set(r.emoji, { emoji: r.emoji, count: 0, mine: false, userIds: [] });
      const e = byEmoji.get(r.emoji);
      e.count++;
      e.userIds.push(r.userId);
      if (r.userId === req.user.id) e.mine = true;
    }
    const reactionsAgg = Array.from(byEmoji.values());

    // V2.6 : broadcast SSE 'message:reaction' a tous les participants (incluant
    // l'auteur de la reaction pour que ses autres devices voient l'update).
    if (typeof broadcastToConversation === 'function') {
      broadcastToConversation(id, 'message:reaction', {
        conversationId: id,
        messageId: msgId,
        reactions: reactionsAgg,
      }).catch(() => {});
    }

    return res.json({ messageId: msgId, reactions: reactionsAgg });
  } catch (err) {
    console.error('POST /reactions error:', err);
    return res.status(500).json({ erreur: 'Erreur interne du serveur.' });
  }
});

// Parse "data:image/xxx;base64,...." -> { mime, buffer } ou null si invalide.
function parseDataUrl(dataUrl, expectedPrefix) {
  if (!dataUrl || typeof dataUrl !== 'string') return null;
  if (!dataUrl.startsWith(expectedPrefix)) return null;
  const match = dataUrl.match(/^data:([^;,]+)(?:;[^,]*)?,(.*)$/s);
  if (!match) return null;
  const mime = match[1];
  const payload = match[2];
  const isB64 = /;base64,/.test(dataUrl.slice(0, dataUrl.indexOf(',') + 1));
  try {
    const buffer = isB64 ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload), 'utf-8');
    return { mime, buffer };
  } catch {
    return null;
  }
}

// GET /conversations/:id/messages/:msgId/image
router.get('/:id/messages/:msgId/image', auth, async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const msgId = Number.parseInt(req.params.msgId, 10);
    if (!Number.isFinite(id) || !Number.isFinite(msgId)) {
      return res.status(400).json({ erreur: 'Identifiants invalides.' });
    }
    const p = await ensureParticipant(req.user.id, id);
    if (!p) return res.status(404).json({ erreur: 'Conversation introuvable.' });

    const msg = await prisma.message.findFirst({
      where: { id: msgId, conversationId: id, deletedAt: null },
      select: { imageData: true },
    });
    if (!msg || !msg.imageData) return res.status(404).json({ erreur: 'Image introuvable.' });

    const parsed = parseDataUrl(msg.imageData, 'data:image/');
    if (!parsed) return res.status(500).json({ erreur: 'Image illisible.' });

    res.setHeader('Content-Type', parsed.mime);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    if (req.query.download) {
      res.setHeader('Content-Disposition', `attachment; filename="image-${msgId}.${(parsed.mime.split('/')[1] || 'bin').replace(/[^a-z0-9]/gi, '')}"`);
    }
    return res.end(parsed.buffer);
  } catch (err) {
    console.error('GET /messages/:msgId/image error:', err);
    return res.status(500).json({ erreur: 'Erreur interne du serveur.' });
  }
});

// GET /conversations/:id/messages/:msgId/audio
router.get('/:id/messages/:msgId/audio', auth, async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const msgId = Number.parseInt(req.params.msgId, 10);
    if (!Number.isFinite(id) || !Number.isFinite(msgId)) {
      return res.status(400).json({ erreur: 'Identifiants invalides.' });
    }
    const p = await ensureParticipant(req.user.id, id);
    if (!p) return res.status(404).json({ erreur: 'Conversation introuvable.' });

    const msg = await prisma.message.findFirst({
      where: { id: msgId, conversationId: id, deletedAt: null },
      select: { audioData: true, audioName: true, audioType: true },
    });
    if (!msg || !msg.audioData) return res.status(404).json({ erreur: 'Audio introuvable.' });

    const parsed = parseDataUrl(msg.audioData, 'data:audio/');
    if (!parsed) return res.status(500).json({ erreur: 'Audio illisible.' });

    const safeName = (msg.audioName || `audio-${msgId}.mp3`).replace(/[^A-Za-z0-9._-]/g, '_');
    res.setHeader('Content-Type', msg.audioType || parsed.mime);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    const disposition = req.query.download ? 'attachment' : 'inline';
    res.setHeader('Content-Disposition', `${disposition}; filename="${safeName}"`);
    return res.end(parsed.buffer);
  } catch (err) {
    console.error('GET /messages/:msgId/audio error:', err);
    return res.status(500).json({ erreur: 'Erreur interne du serveur.' });
  }
});

module.exports = router;
