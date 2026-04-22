// Routes utilisateur : profil de l'utilisateur connecté.
const express = require('express');
const { PrismaClient } = require('@prisma/client');
const auth = require('../middleware/auth');

const prisma = new PrismaClient();
const router = express.Router();

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
      },
      apps,
    });
  } catch (err) {
    console.error('GET /users/me error:', err);
    return res.status(500).json({ erreur: 'Erreur interne du serveur.' });
  }
});

module.exports = router;
