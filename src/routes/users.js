// Routes utilisateur :
//  - GET    /users/me              profil + apps + avatarData
//  - GET    /users                 liste des users de la messagerie (pour le picker)
//  - POST   /users/me/avatar       upload d'une photo de profil (base64 data URL)
//  - DELETE /users/me/avatar       retire la photo

const express = require('express');
const { PrismaClient } = require('@prisma/client');
const auth = require('../middleware/auth');

const prisma = new PrismaClient();
const router = express.Router();

// Limite taille avatar (base64 inclus) — ~100 KB, safe pour Postgres TEXT + payload JSON
const MAX_AVATAR_BASE64_BYTES = 120 * 1024;

// GET /users/:id/avatar — sert l'avatar comme binaire (pour push notification icon).
// Publique (pas d'auth) car les services push et le OS fetchent l'icon sans contexte auth.
// Retourne 404 si l'user n'a pas d'avatar (le SW / Firefox afficheront alors l'icon PWA par défaut).
router.get('/:id/avatar', async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).end();

    const user = await prisma.user.findUnique({
      where: { id },
      select: { avatarData: true },
    });
    if (!user || !user.avatarData) return res.status(404).end();

    // Parse data URL: "data:image/webp;base64,AAAA..."
    const match = /^data:(image\/[\w+.-]+);base64,(.+)$/.exec(user.avatarData);
    if (!match) return res.status(500).end();
    const mime = match[1];
    const buf = Buffer.from(match[2], 'base64');

    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'public, max-age=60'); // short cache; avatar might change
    res.setHeader('Content-Length', String(buf.length));
    return res.end(buf);
  } catch (err) {
    console.error('GET /users/:id/avatar error:', err);
    return res.status(500).end();
  }
});

// GET /users/me — profil + apps auxquelles l'utilisateur a accès
router.get('/me', auth, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      include: {
        apps: {
          where: { hasAccess: true },
          include: { app: true },
        },
      },
    });

    if (!user) return res.status(404).json({ erreur: 'Utilisateur introuvable.' });

    const apps = user.apps.map((ua) => ({
      id: ua.app.id,
      slug: ua.app.slug,
      name: ua.app.name,
      description: ua.app.description,
      icon: ua.app.icon,
      color: ua.app.color,
      url: ua.app.url,
      isMockup: ua.app.isMockup,
      isActive: ua.app.isActive,
      realm: ua.app.realm,
    }));

    return res.json({
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        firstName: user.firstName,
        role: user.role,
        profile: user.profile,
        mustChangePassword: user.mustChangePassword,
        avatarData: user.avatarData || null,
        avatarUpdatedAt: user.avatarUpdatedAt,
      },
      apps,
    });
  } catch (err) {
    console.error('GET /users/me error:', err);
    return res.status(500).json({ erreur: 'Erreur interne du serveur.' });
  }
});

// GET /users — liste publique restreinte (id, firstName, avatar) des users
// ayant accès à l'app messagerie. Sert au picker "Nouvelle conversation".
router.get('/', auth, async (req, res) => {
  try {
    const messagerieApp = await prisma.app.findUnique({ where: { slug: 'messagerie' } });
    if (!messagerieApp) return res.json({ users: [] });

    const accesses = await prisma.userApp.findMany({
      where: { appId: messagerieApp.id, hasAccess: true },
      include: {
        user: {
          select: {
            id: true,
            firstName: true,
            username: true,
            avatarData: true,
            avatarUpdatedAt: true,
          },
        },
      },
      orderBy: { user: { firstName: 'asc' } },
    });

    const users = accesses.map((a) => ({
      id: a.user.id,
      firstName: a.user.firstName,
      username: a.user.username,
      avatarData: a.user.avatarData || null,
    }));
    return res.json({ users });
  } catch (err) {
    console.error('GET /users error:', err);
    return res.status(500).json({ erreur: 'Erreur interne du serveur.' });
  }
});

// POST /users/me/avatar — set/update avatar. Body: { data: "data:image/webp;base64,..." }
// Le frontend DOIT resize + compress avant d'envoyer (cible ~25 KB).
router.post('/me/avatar', auth, async (req, res) => {
  try {
    const { data } = req.body || {};
    if (typeof data !== 'string' || !data.startsWith('data:image/')) {
      return res.status(400).json({ erreur: 'Données image invalides (data URL attendue).' });
    }
    if (data.length > MAX_AVATAR_BASE64_BYTES) {
      return res.status(413).json({
        erreur: `Avatar trop volumineux (${Math.round(data.length / 1024)} KB). Max ~${Math.round(MAX_AVATAR_BASE64_BYTES / 1024)} KB.`,
      });
    }

    const updated = await prisma.user.update({
      where: { id: req.user.id },
      data: { avatarData: data, avatarUpdatedAt: new Date() },
      select: { id: true, avatarData: true, avatarUpdatedAt: true },
    });

    return res.json({ ok: true, avatarData: updated.avatarData, avatarUpdatedAt: updated.avatarUpdatedAt });
  } catch (err) {
    console.error('POST /users/me/avatar error:', err);
    return res.status(500).json({ erreur: 'Erreur interne du serveur.' });
  }
});

// DELETE /users/me/avatar — retire la photo
router.delete('/me/avatar', auth, async (req, res) => {
  try {
    await prisma.user.update({
      where: { id: req.user.id },
      data: { avatarData: null, avatarUpdatedAt: new Date() },
    });
    return res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /users/me/avatar error:', err);
    return res.status(500).json({ erreur: 'Erreur interne du serveur.' });
  }
});

module.exports = router;
