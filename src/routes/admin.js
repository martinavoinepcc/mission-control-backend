// Routes admin — accès réservé à ADMIN.
// Permet à Martin de créer des membres, modifier leur accès aux apps, réinitialiser leur mot de passe.
const express = require('express');
const bcrypt = require('bcrypt');
const { PrismaClient } = require('@prisma/client');
const auth = require('../middleware/auth');
const admin = require('../middleware/admin');

const prisma = new PrismaClient();
const router = express.Router();

// Toutes les routes ci-dessous exigent auth + admin
router.use(auth, admin);

// GET /admin/users — liste des membres de la famille avec leurs apps
router.get('/users', async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      orderBy: { id: 'asc' },
      include: { apps: { include: { app: true } } },
    });

    const result = users.map((u) => ({
      id: u.id,
      email: u.email,
      firstName: u.firstName,
      role: u.role,
      profile: u.profile,
      mustChangePassword: u.mustChangePassword,
      createdAt: u.createdAt,
      apps: u.apps.map((ua) => ({
        appId: ua.app.id,
        slug: ua.app.slug,
        name: ua.app.name,
        icon: ua.app.icon,
        color: ua.app.color,
        hasAccess: ua.hasAccess,
      })),
    }));

    return res.json({ users: result });
  } catch (err) {
    console.error('GET /admin/users error:', err);
    return res.status(500).json({ erreur: 'Erreur interne du serveur.' });
  }
});

// GET /admin/apps — liste complète des apps
router.get('/apps', async (req, res) => {
  try {
    const apps = await prisma.app.findMany({ orderBy: { id: 'asc' } });
    return res.json({ apps });
  } catch (err) {
    console.error('GET /admin/apps error:', err);
    return res.status(500).json({ erreur: 'Erreur interne du serveur.' });
  }
});

// POST /admin/users — créer un nouveau membre
router.post('/users', async (req, res) => {
  try {
    const { email, firstName, password, role, profile } = req.body || {};
    if (!email || !firstName || !password) {
      return res.status(400).json({ erreur: 'Courriel, prénom et mot de passe requis.' });
    }
    if (password.length < 8) {
      return res.status(400).json({ erreur: 'Le mot de passe doit avoir au moins 8 caractères.' });
    }

    const exists = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
    if (exists) return res.status(409).json({ erreur: 'Ce courriel est déjà utilisé.' });

    const hashed = await bcrypt.hash(password, 12);
    const user = await prisma.user.create({
      data: {
        email: email.toLowerCase().trim(),
        firstName,
        password: hashed,
        role: role === 'ADMIN' ? 'ADMIN' : 'MEMBER',
        profile: profile === 'CHILD' ? 'CHILD' : 'ADULT',
        mustChangePassword: true,
      },
    });

    return res.status(201).json({
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        role: user.role,
        profile: user.profile,
      },
    });
  } catch (err) {
    console.error('POST /admin/users error:', err);
    return res.status(500).json({ erreur: 'Erreur interne du serveur.' });
  }
});

// POST /admin/users/:id/apps — définit l'accès d'un membre à une app (toggle)
// Body: { appId: number, hasAccess: boolean }
router.post('/users/:id/apps', async (req, res) => {
  try {
    const userId = parseInt(req.params.id, 10);
    const { appId, hasAccess } = req.body || {};
    if (!userId || !appId || typeof hasAccess !== 'boolean') {
      return res.status(400).json({ erreur: 'userId, appId et hasAccess (true/false) requis.' });
    }

    await prisma.userApp.upsert({
      where: { userId_appId: { userId, appId } },
      update: { hasAccess },
      create: { userId, appId, hasAccess },
    });

    return res.json({ message: hasAccess ? 'Accès accordé.' : 'Accès retiré.' });
  } catch (err) {
    console.error('POST /admin/users/:id/apps error:', err);
    return res.status(500).json({ erreur: 'Erreur interne du serveur.' });
  }
});

// POST /admin/users/:id/password — réinitialisation du mot de passe d'un membre
// Body: { newPassword: string }
router.post('/users/:id/password', async (req, res) => {
  try {
    const userId = parseInt(req.params.id, 10);
    const { newPassword } = req.body || {};
    if (!userId || !newPassword) {
      return res.status(400).json({ erreur: 'userId et newPassword requis.' });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ erreur: 'Le mot de passe doit avoir au moins 8 caractères.' });
    }

    const hashed = await bcrypt.hash(newPassword, 12);
    await prisma.user.update({
      where: { id: userId },
      data: { password: hashed, mustChangePassword: true },
    });

    return res.json({ message: 'Mot de passe réinitialisé. Le membre devra le changer à sa prochaine connexion.' });
  } catch (err) {
    console.error('POST /admin/users/:id/password error:', err);
    return res.status(500).json({ erreur: 'Erreur interne du serveur.' });
  }
});

// DELETE /admin/users/:id — supprimer un membre (sauf admin)
router.delete('/users/:id', async (req, res) => {
  try {
    const userId = parseInt(req.params.id, 10);
    if (!userId) return res.status(400).json({ erreur: 'userId requis.' });

    const target = await prisma.user.findUnique({ where: { id: userId } });
    if (!target) return res.status(404).json({ erreur: 'Utilisateur introuvable.' });
    if (target.role === 'ADMIN') {
      return res.status(403).json({ erreur: 'Impossible de supprimer un administrateur.' });
    }

    await prisma.user.delete({ where: { id: userId } });
    return res.json({ message: 'Membre supprimé.' });
  } catch (err) {
    console.error('DELETE /admin/users/:id error:', err);
    return res.status(500).json({ erreur: 'Erreur interne du serveur.' });
  }
});

module.exports = router;
