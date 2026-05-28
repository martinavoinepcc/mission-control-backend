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
const rateLimit = require('express-rate-limit');
const { PrismaClient } = require('@prisma/client');
const auth = require('../middleware/auth');
const pushModule = require('./push');

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

const prisma = new PrismaClient();
const router = express.Router();

const sendPushToUser = pushModule && pushModule.sendPushToUser;

// Limite taille image message (base64 data URL). 2 MB laisse de la marge pour les photos iPhone
// qui sortent parfois ~1-1.5 MB même après compression webp qualité 0.5.
const MAX_IMAGE_BASE64_BYTES = 2 * 1024 * 1024;
// Limite taille audio (MP3 et autres formats audio). 6 MB en base64 ≈ 4.5 MB MP3 ≈ ~5min de speech.
const MAX_AUDIO_BASE64_BYTES = 6 * 1024 * 1024;
// Types audio acceptes (whitelist stricte).
const ALLOWED_AUDIO_TYPES = ['audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/m4a', 'audio/aac', 'audio/wav', 'audio/webm', 'audio/ogg'];
// Emojis autorisees pour reactions (whitelist pour eviter les injections / abus).
const ALLOWED_REACTION_EMOJIS = ['👍','❤️','😂','😮','😢','🔥'];

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

    // IMPORTANT : on n'inclut PAS imageData/audioData ici (payloads base64 lourds).
    // Le client charge les binaires via GET /:id/messages/:msgId/image|audio en lazy
    // (cf. V1.1). On expose juste les flags hasImage / hasAudio + meta dimensions.
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
        // Astuce Postgres : projection booleenne sans charger le blob.
        // Prisma ne supporte pas `{ field: { _not_null: true } }` en select, donc on
        // recupere les flags via un raw SELECT supplementaire ci-dessous.
        author: { select: { id: true, firstName: true } },
        replyTo: {
          select: {
            id: true, body: true, authorId: true, audioName: true,
            author: { select: { id: true, firstName: true } },
          },
        },
        reactions: { select: { emoji: true, userId: true } },
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

    // Agrege les reactions par emoji pour chaque message
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
      return {
        id: m.id,
        authorId: m.authorId,
        authorFirstName: m.author ? m.author.firstName : null,
        body: m.body,
        hasImage: flags.hasImage,
        imageWidth: m.imageWidth || null,
        imageHeight: m.imageHeight || null,
        hasAudio: flags.hasAudio,
        audioType: m.audioType || null,
        audioName: m.audioName || null,
        replyTo: m.replyTo ? {
          id: m.replyTo.id,
          body: m.replyTo.body,
          authorId: m.replyTo.authorId,
          authorFirstName: m.replyTo.author ? m.replyTo.author.firstName : null,
          hasImage: !!(replyFlags && replyFlags.hasImage),
          hasAudio: !!(replyFlags && replyFlags.hasAudio),
          audioName: m.replyTo.audioName || null,
        } : null,
        reactions: aggregateReactions(m.reactions, req.user.id),
        createdAt: m.createdAt,
        editedAt: m.editedAt,
      };
    });

    return res.json({ messages, hasMore: recent.length === limit });
  } catch (err) {
    console.error('GET /conversations/:id/messages error:', err);
    return res.status(500).json({ erreur: 'Erreur interne du serveur.' });
  }
});

// POST /conversations/:id/messages — envoie un message (texte et/ou image) + push auto
router.post('/:id/messages', auth, messageLimiter, async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const p = await ensureParticipant(req.user.id, id);
    if (!p) return res.status(404).json({ erreur: 'Conversation introuvable.' });

    const raw = (req.body && req.body.body) || '';
    const body = String(raw).trim();
    const image = req.body && req.body.image; // { data, width, height } or undefined
    const audio = req.body && req.body.audio; // { data, type, name } or undefined
    const replyToIdRaw = req.body && req.body.replyToId;

    if (!body && !image && !audio) {
      return res.status(400).json({ erreur: 'Message vide (texte, image ou audio requis).' });
    }

    // Valide replyToId si fourni (le message cite doit appartenir a la meme convo)
    let replyToId = null;
    if (replyToIdRaw !== undefined && replyToIdRaw !== null) {
      const candidate = Number.parseInt(replyToIdRaw, 10);
      if (Number.isFinite(candidate) && candidate > 0) {
        const target = await prisma.message.findUnique({
          where: { id: candidate },
          select: { conversationId: true },
        });
        if (target && target.conversationId === id) {
          replyToId = candidate;
        }
        // Sinon on ignore silencieusement (pas d'erreur — le message s'envoie quand meme)
      }
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
      // Extrait le mime depuis le data URL si type non fourni
      const mimeMatch = audio.data.match(/^data:(audio\/[^;]+)/);
      const mime = declaredType || (mimeMatch ? mimeMatch[1] : null);
      if (!mime || !ALLOWED_AUDIO_TYPES.some(t => mime.startsWith(t.split('/')[0] + '/') && (t === mime || mime === 'audio/mpeg' || mime === 'audio/mp3'))) {
        // Plus permissif : accepte tout audio/* sur la whitelist large
        if (!mime || !mime.startsWith('audio/')) {
          return res.status(400).json({ erreur: 'Type audio non supporte.' });
        }
      }
      audioData = audio.data;
      audioType = mime;
      const rawName = (typeof audio.name === 'string' && audio.name) ? audio.name : 'audio.mp3';
      // Sanitize filename : alphanum/dot/dash/underscore, max 80
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
              id: true, body: true, authorId: true, audioName: true,
              imageData: true, audioData: true, // pour calcul hasImage/hasAudio uniquement
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

          const payload = {
            title,
            body: preview,
            url: `/apps/messagerie/thread/?id=${id}`,
            tag: `convo-${id}`,
            icon: iconUrl,
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
      // Pas de payload base64 dans la reponse (le client lit via les routes binaires lazy).
      hasImage: !!msg.imageData,
      imageWidth: msg.imageWidth || null,
      imageHeight: msg.imageHeight || null,
      hasAudio: !!msg.audioData,
      audioType: msg.audioType || null,
      audioName: msg.audioName || null,
      replyTo: msg.replyTo ? {
        id: msg.replyTo.id,
        body: msg.replyTo.body,
        authorId: msg.replyTo.authorId,
        authorFirstName: msg.replyTo.author ? msg.replyTo.author.firstName : null,
        hasImage: !!msg.replyTo.imageData,
        hasAudio: !!msg.replyTo.audioData,
        audioName: msg.replyTo.audioName || null,
      } : null,
      reactions: [],
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

    // Verifie que le message existe dans cette convo
    const msg = await prisma.message.findUnique({
      where: { id: msgId },
      select: { conversationId: true },
    });
    if (!msg || msg.conversationId !== id) {
      return res.status(404).json({ erreur: 'Message introuvable.' });
    }

    // Toggle : si la reaction existe pour ce user/emoji on la supprime, sinon on la cree
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

    // Renvoie l'etat agrege a jour pour ce message
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
    return res.json({ messageId: msgId, reactions: Array.from(byEmoji.values()) });
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
  // base64 marker
  const isB64 = /;base64,/.test(dataUrl.slice(0, dataUrl.indexOf(',') + 1));
  try {
    const buffer = isB64 ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload), 'utf-8');
    return { mime, buffer };
  } catch {
    return null;
  }
}

// GET /conversations/:id/messages/:msgId/image
// Sert le binaire image en lazy. Accepte JWT via header OU ?token= (img src ne peut pas
// porter de header Authorization). Verifie participant + appartenance du message.
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
      where: { id: msgId, conversationId: id },
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
      where: { id: msgId, conversationId: id },
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
