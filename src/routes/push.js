// Routes /push — inscription, désinscription et envoi de test pour les notifications Web Push.
//
// Modèle de données : table PushSubscription (userId × endpoint unique × p256dh × auth).
// Une subscription Web Push est créée côté client via navigator.serviceWorker → pushManager.subscribe,
// puis POSTée ici. Le backend utilise la lib `web-push` + les env vars VAPID_* pour envoyer un
// payload chiffré au push service du navigateur (FCM/Apple/Mozilla), qui le relaie au device.
//
// Pour envoyer un push depuis une autre route (ex: nouveau message dans la future messagerie),
// importer `sendPushToUser(userId, payload)` exposé plus bas via module.exports.

const express = require('express');
const webpush = require('web-push');
const { PrismaClient } = require('@prisma/client');
const auth = require('../middleware/auth');

const prisma = new PrismaClient();
const router = express.Router();

// --- Configuration VAPID ---
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:martin@logifox.io';

let vapidReady = false;
if (VAPID_PUBLIC && VAPID_PRIVATE) {
  try {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
    vapidReady = true;
  } catch (err) {
    console.error('VAPID setup failed:', err.message);
  }
} else {
  console.warn('[push] VAPID keys manquantes — routes disponibles mais aucun push ne partira.');
}

// --- Helper réutilisable par les autres routes (messagerie future, etc.) ---
async function sendPushToUser(userId, payload) {
  if (!vapidReady) {
    return { sent: 0, failed: 0, reason: 'VAPID not configured' };
  }

  const subs = await prisma.pushSubscription.findMany({ where: { userId } });
  if (subs.length === 0) return { sent: 0, failed: 0, reason: 'no subscriptions' };

  const json = JSON.stringify(payload);
  let sent = 0;
  let failed = 0;
  const staleIds = [];

  for (const sub of subs) {
    if (!sub.p256dh || !sub.auth) continue;
    const webSub = {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.p256dh, auth: sub.auth },
    };
    try {
      await webpush.sendNotification(webSub, json);
      sent += 1;
      // Touch lastSeenAt (best-effort)
      prisma.pushSubscription
        .update({ where: { id: sub.id }, data: { lastSeenAt: new Date() } })
        .catch(() => {});
    } catch (err) {
      failed += 1;
      // 404/410 = subscription expirée ou révoquée → cleanup DB
      if (err.statusCode === 404 || err.statusCode === 410) {
        staleIds.push(sub.id);
      } else {
        console.error('[push] send error', sub.id, err.statusCode, err.body);
      }
    }
  }

  if (staleIds.length > 0) {
    await prisma.pushSubscription
      .deleteMany({ where: { id: { in: staleIds } } })
      .catch(() => {});
  }

  return { sent, failed, pruned: staleIds.length };
}

// POST /push/subscribe
// Body : { endpoint, keys: { p256dh, auth }, userAgent? }
// Idempotent : upsert par endpoint (réabonnement du même device = update).
router.post('/subscribe', auth, async (req, res) => {
  try {
    const { endpoint, keys, userAgent } = req.body || {};
    if (!endpoint || typeof endpoint !== 'string') {
      return res.status(400).json({ erreur: 'Endpoint requis.' });
    }
    const p256dh = keys && keys.p256dh ? String(keys.p256dh) : null;
    const auth = keys && keys.auth ? String(keys.auth) : null;
    if (!p256dh || !auth) {
      return res.status(400).json({ erreur: 'Clés p256dh et auth requises.' });
    }

    const userId = req.user.id;
    const ua = typeof userAgent === 'string' ? userAgent.slice(0, 300) : null;

    const sub = await prisma.pushSubscription.upsert({
      where: { endpoint },
      update: {
        userId,
        p256dh,
        auth,
        userAgent: ua,
        lastSeenAt: new Date(),
      },
      create: {
        userId,
        endpoint,
        p256dh,
        auth,
        userAgent: ua,
      },
    });

    return res.json({ ok: true, id: sub.id, vapidConfigured: vapidReady });
  } catch (err) {
    console.error('POST /push/subscribe error:', err);
    return res.status(500).json({ erreur: 'Erreur interne du serveur.' });
  }
});

// POST /push/unsubscribe
// Body : { endpoint }
// Supprime la subscription si elle appartient à l'utilisateur connecté.
router.post('/unsubscribe', auth, async (req, res) => {
  try {
    const { endpoint } = req.body || {};
    if (!endpoint) return res.status(400).json({ erreur: 'Endpoint requis.' });

    await prisma.pushSubscription.deleteMany({
      where: { endpoint, userId: req.user.id },
    });
    return res.json({ ok: true });
  } catch (err) {
    console.error('POST /push/unsubscribe error:', err);
    return res.status(500).json({ erreur: 'Erreur interne du serveur.' });
  }
});

// GET /push/status
// Combien de subscriptions l'utilisateur a + si VAPID est configuré côté serveur.
router.get('/status', auth, async (req, res) => {
  try {
    const count = await prisma.pushSubscription.count({ where: { userId: req.user.id } });
    return res.json({ count, vapidConfigured: vapidReady });
  } catch (err) {
    console.error('GET /push/status error:', err);
    return res.status(500).json({ erreur: 'Erreur interne du serveur.' });
  }
});

// POST /push/test
// Envoie un push "hello world" à toutes les subscriptions de l'utilisateur connecté.
// Body optionnel : { title?, body? }.
router.post('/test', auth, async (req, res) => {
  try {
    const { title, body } = req.body || {};
    const payload = {
      title: typeof title === 'string' && title.trim() ? title.trim() : 'Mission Control',
      body:
        typeof body === 'string' && body.trim()
          ? body.trim()
          : 'Test de notification : si tu vois ça, les push fonctionnent 🎉',
      url: '/dashboard',
      tag: 'mc-test',
    };
    const result = await sendPushToUser(req.user.id, payload);
    return res.json({ ok: true, ...result });
  } catch (err) {
    console.error('POST /push/test error:', err);
    return res.status(500).json({ erreur: 'Erreur interne du serveur.' });
  }
});

module.exports = router;
module.exports.sendPushToUser = sendPushToUser;
