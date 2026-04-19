// Routes d'authentification : login + changement de mot de passe.
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const router = express.Router();

// Rate limiter : max 10 tentatives de login par 15 min par IP
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { erreur: 'Trop de tentatives. Réessaie dans 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// POST /auth/login
// Accepte { identifier, password } (identifier = email ou username, case-insensitive)
// Backward-compat : accepte aussi { email, password } ou { username, password }.
router.post('/login', loginLimiter, async (req, res) => {
  try {
    const body = req.body || {};
    const raw = (body.identifier ?? body.email ?? body.username ?? '').toString().trim();
    const password = body.password;

    if (!raw || !password) {
      return res.status(400).json({ erreur: 'Identifiant et mot de passe requis.' });
    }

    let user = null;
    if (raw.includes('@')) {
      // Voie email (admin typiquement).
      user = await prisma.user.findUnique({ where: { email: raw.toLowerCase() } });
    } else {
      // Voie username (case-insensitive).
      user = await prisma.user.findFirst({
        where: { username: { equals: raw, mode: 'insensitive' } },
      });
    }

    if (!user) {
      return res.status(401).json({ erreur: 'Identifiant ou mot de passe invalide.' });
    }

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) {
      return res.status(401).json({ erreur: 'Identifiant ou mot de passe invalide.' });
    }

    const token = jwt.sign(
      {
        id: user.id,
        email: user.email,
        username: user.username,
        firstName: user.firstName,
        role: user.role,
        profile: user.profile,
      },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    return res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        firstName: user.firstName,
        role: user.role,
        profile: user.profile,
        mustChangePassword: user.mustChangePassword,
      },
    });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ erreur: 'Erreur interne du serveur.' });
  }
});

// POST /auth/change-password (utilisateur connecté, change son propre mdp)
const auth = require('../middleware/auth');
router.post('/change-password', auth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ erreur: 'Mot de passe actuel et nouveau mot de passe requis.' });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ erreur: 'Le nouveau mot de passe doit avoir au moins 8 caractères.' });
    }

    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user) return res.status(404).json({ erreur: 'Utilisateur introuvable.' });

    const ok = await bcrypt.compare(currentPassword, user.password);
    if (!ok) return res.status(401).json({ erreur: 'Mot de passe actuel incorrect.' });

    const hashed = await bcrypt.hash(newPassword, 12);
    await prisma.user.update({
      where: { id: user.id },
      data: { password: hashed, mustChangePassword: false },
    });

    return res.json({ message: 'Mot de passe mis à jour.' });
  } catch (err) {
    console.error('Change password error:', err);
    return res.status(500).json({ erreur: 'Erreur interne du serveur.' });
  }
});

module.exports = router;
