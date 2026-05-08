// Routes /heimdall/* — gestion des drops (modules pousses par FRIDAY ou crees admin).
//
// Workflow :
// - Admin (ou FRIDAY via HMAC dans v2) cree un Drop.
// - Admin grant access par user via DropAccess.
// - User voit ses drops via GET /me/drops + ouvre /drops/:slug pour le HTML.
//
// Pour MVP : routes admin only (pas encore de FRIDAY HMAC). FRIDAY pourra etre cable plus tard.

const express = require('express');
const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');
const auth = require('../middleware/auth');

const prisma = new PrismaClient();
const router = express.Router();

// Router separe pour l'inbound HMAC FRIDAY (mont avant express.json globale dans index.js
// pour avoir acces au raw body). Meme pattern que fridayPullRouter.
const inboundRouter = express.Router();

const FRIDAY_HMAC_SECRET = process.env.FRIDAY_HMAC_SECRET || '';
const REPLAY_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

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

function adminOnly(req, res, next) {
  if (!req.user || req.user.role !== 'ADMIN') {
    return res.status(403).json({ erreur: 'Admin requis.' });
  }
  next();
}

// GET /heimdall/drops — liste tous les drops (admin)
router.get('/drops', auth, adminOnly, async (req, res) => {
  try {
    const drops = await prisma.drop.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        accesses: {
          include: { user: { select: { id: true, firstName: true, profile: true } } },
        },
      },
    });
    return res.json({
      drops: drops.map((d) => ({
        id: d.id,
        slug: d.slug,
        title: d.title,
        description: d.description,
        iconEmoji: d.iconEmoji,
        realm: d.realm,
        status: d.status,
        source: d.source,
        hasContent: !!d.htmlContent,
        contentSize: d.htmlContent ? d.htmlContent.length : 0,
        createdAt: d.createdAt,
        approvedAt: d.approvedAt,
        accesses: d.accesses.map((a) => ({
          userId: a.userId,
          firstName: a.user.firstName,
          profile: a.user.profile,
          grantedAt: a.grantedAt,
        })),
      })),
    });
  } catch (err) {
    console.error('GET /heimdall/drops error:', err);
    return res.status(500).json({ erreur: 'Erreur interne du serveur.' });
  }
});

// POST /heimdall/drops — cree un drop manuellement (admin)
// Body: { slug, title, description?, htmlContent?, iconEmoji?, realm?, source? }
router.post('/drops', auth, adminOnly, async (req, res) => {
  try {
    const b = req.body || {};
    const slug = String(b.slug || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 80);
    if (!slug) return res.status(400).json({ erreur: 'slug requis.' });
    const title = String(b.title || '').trim().slice(0, 120);
    if (!title) return res.status(400).json({ erreur: 'title requis.' });

    const drop = await prisma.drop.upsert({
      where: { slug },
      create: {
        slug,
        title,
        description: b.description ? String(b.description).slice(0, 2000) : null,
        htmlContent: b.htmlContent ? String(b.htmlContent) : null,
        iconEmoji: b.iconEmoji ? String(b.iconEmoji).slice(0, 8) : '📦',
        realm: b.realm && ['FAMILY', 'WORK', 'EDUCATIF'].includes(b.realm) ? b.realm : 'FAMILY',
        source: b.source ? String(b.source).slice(0, 40) : 'manual',
        status: b.status === 'APPROVED' ? 'APPROVED' : 'PENDING',
        approvedAt: b.status === 'APPROVED' ? new Date() : null,
      },
      update: {
        title,
        description: b.description ? String(b.description).slice(0, 2000) : null,
        htmlContent: b.htmlContent ? String(b.htmlContent) : undefined,
        iconEmoji: b.iconEmoji ? String(b.iconEmoji).slice(0, 8) : undefined,
        realm: b.realm && ['FAMILY', 'WORK', 'EDUCATIF'].includes(b.realm) ? b.realm : undefined,
      },
    });
    return res.json({
      id: drop.id,
      slug: drop.slug,
      title: drop.title,
      status: drop.status,
    });
  } catch (err) {
    console.error('POST /heimdall/drops error:', err);
    return res.status(500).json({ erreur: 'Erreur interne du serveur.' });
  }
});

// POST /heimdall/drops/:id/approve — admin approve un drop pending
router.post('/drops/:id/approve', auth, adminOnly, async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const drop = await prisma.drop.update({
      where: { id },
      data: { status: 'APPROVED', approvedAt: new Date() },
    });
    return res.json({ id: drop.id, status: drop.status });
  } catch (err) {
    console.error('approve error:', err);
    return res.status(500).json({ erreur: 'Erreur.' });
  }
});

// POST /heimdall/drops/:id/disable — admin desactive un drop
router.post('/drops/:id/disable', auth, adminOnly, async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const drop = await prisma.drop.update({
      where: { id },
      data: { status: 'DISABLED' },
    });
    return res.json({ id: drop.id, status: drop.status });
  } catch (err) {
    console.error('disable error:', err);
    return res.status(500).json({ erreur: 'Erreur.' });
  }
});

// POST /heimdall/drops/:id/access — admin toggle access pour un user
// Body: { userId }
router.post('/drops/:id/access', auth, adminOnly, async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const userId = Number.parseInt(req.body && req.body.userId, 10);
    if (!Number.isFinite(userId) || userId <= 0) {
      return res.status(400).json({ erreur: 'userId requis.' });
    }
    const drop = await prisma.drop.findUnique({ where: { id } });
    if (!drop) return res.status(404).json({ erreur: 'Drop introuvable.' });
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ erreur: 'User introuvable.' });

    const existing = await prisma.dropAccess.findUnique({
      where: { dropId_userId: { dropId: id, userId } },
    });
    if (existing) {
      await prisma.dropAccess.delete({ where: { id: existing.id } });
      return res.json({ dropId: id, userId, hasAccess: false });
    }
    await prisma.dropAccess.create({ data: { dropId: id, userId } });
    return res.json({ dropId: id, userId, hasAccess: true });
  } catch (err) {
    console.error('toggle access error:', err);
    return res.status(500).json({ erreur: 'Erreur.' });
  }
});

// DELETE /heimdall/drops/:id — admin
router.delete('/drops/:id', auth, adminOnly, async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    await prisma.drop.delete({ where: { id } });
    return res.json({ ok: true });
  } catch (err) {
    console.error('delete drop error:', err);
    return res.status(500).json({ erreur: 'Erreur.' });
  }
});

// Middleware auth qui accepte aussi token en query string (pour iframes qui peuvent
// pas envoyer headers custom). Fallback vers le middleware auth standard si pas de query.
function authQueryOrHeader(req, res, next) {
  const queryToken = req.query && req.query.token;
  if (queryToken) {
    // Injecte dans Authorization header pour que auth() le trouve
    req.headers.authorization = `Bearer ${queryToken}`;
  }
  return auth(req, res, next);
}

// GET /heimdall/drops/:slug/content — sert le HTML d'un drop
// Auth required + DropAccess required (sauf admin qui voit tout).
// Accepte token via header Authorization OU query string ?token=... (pour iframes).
router.get('/drops/:slug/content', authQueryOrHeader, async (req, res) => {
  try {
    const slug = String(req.params.slug).trim();
    const drop = await prisma.drop.findUnique({ where: { slug } });
    if (!drop || drop.status !== 'APPROVED' || !drop.htmlContent) {
      return res.status(404).send('<!DOCTYPE html><html><body style="font-family:sans-serif;padding:2rem;background:#0a0a14;color:#fff;">Drop introuvable ou non approuve.</body></html>');
    }
    if (req.user.role !== 'ADMIN') {
      const access = await prisma.dropAccess.findUnique({
        where: { dropId_userId: { dropId: drop.id, userId: req.user.id } },
      });
      if (!access) {
        return res.status(403).send('<!DOCTYPE html><html><body style="font-family:sans-serif;padding:2rem;background:#0a0a14;color:#fff;">Pas d\'acces a ce drop. Demande a Martin de t\'ajouter.</body></html>');
      }
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.send(drop.htmlContent);
  } catch (err) {
    console.error('drop content error:', err);
    return res.status(500).send('Erreur.');
  }
});

// GET /me/drops — liste les drops accessibles a l'user courant (kids portal)
router.get('/me/drops', auth, async (req, res) => {
  try {
    const accesses = await prisma.dropAccess.findMany({
      where: { userId: req.user.id, drop: { status: 'APPROVED' } },
      include: {
        drop: {
          select: {
            id: true, slug: true, title: true, description: true,
            iconEmoji: true, realm: true,
          },
        },
      },
      orderBy: { grantedAt: 'desc' },
    });
    return res.json({
      drops: accesses.map((a) => ({
        id: a.drop.id,
        slug: a.drop.slug,
        title: a.drop.title,
        description: a.drop.description,
        iconEmoji: a.drop.iconEmoji,
        realm: a.drop.realm,
      })),
    });
  } catch (err) {
    console.error('GET /me/drops error:', err);
    return res.status(500).json({ erreur: 'Erreur interne.' });
  }
});

// ===== INBOUND HMAC FRIDAY =====
// POST /api/heimdall/drops/inbound — FRIDAY pousse un drop signe HMAC.
// Headers : X-MC-Timestamp (unix millis), X-MC-Signature (sha256=<hex>).
// Signature = HMAC-SHA256(FRIDAY_HMAC_SECRET, "${timestamp}.${raw_body}").
// Anti-replay : 5 min.
// Body (JSON) :
//   { slug, title, description?, htmlContent?, iconEmoji?, realm?, source? }
// Le drop est cree en status PENDING (admin approve manuellement apres).
inboundRouter.post('/drops/inbound', express.raw({ type: 'application/json', limit: '8mb' }), async (req, res) => {
  try {
    if (!FRIDAY_HMAC_SECRET) {
      return res.status(503).json({ erreur: 'FRIDAY_HMAC_SECRET non configure cote backend.' });
    }
    const sig = (req.headers['x-mc-signature'] || '').toString();
    const tsStr = (req.headers['x-mc-timestamp'] || '').toString();
    const ts = Number.parseInt(tsStr, 10);
    if (!Number.isFinite(ts)) return res.status(400).json({ erreur: 'X-MC-Timestamp manquant ou invalide.' });
    if (!checkTimestamp(ts)) return res.status(401).json({ erreur: 'timestamp expire (>5min).' });

    const rawBody = req.body instanceof Buffer ? req.body.toString('utf8') : '';
    if (!verifySignature(ts, rawBody, sig)) {
      return res.status(401).json({ erreur: 'signature HMAC invalide.' });
    }

    let payload;
    try { payload = JSON.parse(rawBody); }
    catch { return res.status(400).json({ erreur: 'JSON invalide.' }); }

    const slug = String(payload.slug || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 80);
    if (!slug) return res.status(400).json({ erreur: 'slug requis.' });
    const title = String(payload.title || '').trim().slice(0, 120);
    if (!title) return res.status(400).json({ erreur: 'title requis.' });

    const drop = await prisma.drop.upsert({
      where: { slug },
      create: {
        slug,
        title,
        description: payload.description ? String(payload.description).slice(0, 2000) : null,
        htmlContent: payload.htmlContent ? String(payload.htmlContent) : null,
        iconEmoji: payload.iconEmoji ? String(payload.iconEmoji).slice(0, 8) : '📦',
        realm: payload.realm && ['FAMILY', 'WORK', 'EDUCATIF'].includes(payload.realm) ? payload.realm : 'FAMILY',
        source: 'friday',
        status: 'PENDING',
      },
      update: {
        title,
        description: payload.description ? String(payload.description).slice(0, 2000) : undefined,
        htmlContent: payload.htmlContent ? String(payload.htmlContent) : undefined,
        iconEmoji: payload.iconEmoji ? String(payload.iconEmoji).slice(0, 8) : undefined,
        realm: payload.realm && ['FAMILY', 'WORK', 'EDUCATIF'].includes(payload.realm) ? payload.realm : undefined,
        source: 'friday',
        // Re-pending sur update pour que admin re-approuve la nouvelle version
        status: 'PENDING',
        approvedAt: null,
      },
    });

    return res.json({
      id: drop.id,
      slug: drop.slug,
      title: drop.title,
      status: drop.status,
      message: 'Drop recu, en attente d\'approbation admin dans /apps/heimdall/drops/.',
    });
  } catch (err) {
    console.error('inbound drop error:', err);
    return res.status(500).json({ erreur: 'Erreur interne.' });
  }
});

module.exports = router;
module.exports.inboundRouter = inboundRouter;
