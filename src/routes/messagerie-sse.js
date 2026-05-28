// SSE realtime stream pour la messagerie familiale.
// V2.6 : remplace le polling 5s/15s du client par un EventSource keep-alive.
//
// Architecture :
// - sseClients : Map<userId, Set<express.Response>> — un user peut avoir plusieurs
//   onglets/devices ouverts simultanement, chacun a sa propre Response SSE.
// - broadcastToUser(userId, event, data) : envoie un event SSE a TOUTES les
//   connexions d'un user (fan-out par device).
// - broadcastToConversation(convoId, event, data, excludeUserId?) : fetch les
//   participants de la convo et broadcast a chacun (sauf l'exclu).
// - heartbeat 25s pour eviter que le proxy Cloudflare/Render ne coupe la connexion
//   en idle (limite typique : 60s sans trafic).
//
// IMPORTANT Render free tier : SSE = connexion long-lived. Le service ne dort
// plus tant qu'un client a un EventSource ouvert. Acceptable pour 4 users famille.

const express = require('express');
const { PrismaClient } = require('@prisma/client');
const auth = require('../middleware/auth');

const prisma = new PrismaClient();
const router = express.Router();

// Map<userId:number, Set<express.Response>>
const sseClients = new Map();

function broadcastToUser(userId, event, data) {
  const set = sseClients.get(Number(userId));
  if (!set || set.size === 0) return;
  let payload;
  try {
    payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  } catch (err) {
    console.warn('[sse] payload stringify failed:', err && err.message);
    return;
  }
  for (const res of set) {
    try {
      res.write(payload);
    } catch (err) {
      // res deja ferme — silencieux, le 'close' handler nettoiera.
    }
  }
}

async function broadcastToConversation(convoId, event, data, excludeUserId = null) {
  try {
    const participants = await prisma.conversationParticipant.findMany({
      where: { conversationId: Number(convoId) },
      select: { userId: true },
    });
    for (const p of participants) {
      if (excludeUserId != null && p.userId === Number(excludeUserId)) continue;
      broadcastToUser(p.userId, event, data);
    }
  } catch (err) {
    console.warn('[sse] broadcastToConversation failed:', err && err.message);
  }
}

// GET /conversations/stream — long-lived SSE pour realtime updates.
// Auth via Authorization header OU ?token=<jwt> (EventSource ne peut pas porter
// de header custom).
router.get('/stream', auth, async (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    // X-Accel-Buffering: no — desactive le buffering du proxy (Render utilise
    // Cloudflare en amont, ce header est honore par la plupart des proxies).
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write(': connected\n\n');

  const userId = Number(req.user.id);
  if (!sseClients.has(userId)) sseClients.set(userId, new Set());
  sseClients.get(userId).add(res);

  // Heartbeat 25s pour eviter que les proxies ne killent la connexion idle.
  const hb = setInterval(() => {
    try {
      res.write(': hb\n\n');
    } catch {
      // ignore
    }
  }, 25000);

  req.on('close', () => {
    clearInterval(hb);
    const set = sseClients.get(userId);
    if (set) {
      set.delete(res);
      if (set.size === 0) sseClients.delete(userId);
    }
  });
});

module.exports = router;
module.exports.broadcastToUser = broadcastToUser;
module.exports.broadcastToConversation = broadcastToConversation;
module.exports.sseClients = sseClients;
