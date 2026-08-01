// Routes /voyage — état partagé de l'itinéraire Rocheuses & Glacier 2026.
//
// Même pattern que /budget : un seul état JSON partagé (BudgetState slug
// 'voyage'), GET au chargement, PUT last-write-wins. Toute la famille
// (enfants inclus) peut lire ET éditer — c'est le plan de voyage commun.
//
// Structure du data :
// { version: 1,
//   overrides: { "<date>#<index>": { time: "08:15" } },      // heures modifiées
//   comments:  { "<itemId>": [ { a: "Martin", t: "...", ts } ] },
//   extras:    { "<date>": [ { id, time, title, note, addr, by } ] },
//   done:      { "<cid>": { by: "Martin", ts } } }            // items cochés (masqués)

const express = require('express');
const { PrismaClient } = require('@prisma/client');
const auth = require('../middleware/auth');

const prisma = new PrismaClient();
const router = express.Router();

router.use(auth);

const SLUG = 'voyage';
const DEFAULT_STATE = { version: 1, overrides: {}, comments: {}, extras: {}, done: {} };

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// GET /voyage — état courant (ou défaut vide si jamais sauvegardé)
router.get('/', async (req, res) => {
  try {
    const row = await prisma.budgetState.findUnique({ where: { slug: SLUG } });
    if (!row) return res.json({ data: DEFAULT_STATE, updatedAt: null, updatedBy: null });
    return res.json({ data: row.data, updatedAt: row.updatedAt, updatedBy: row.updatedBy });
  } catch (err) {
    console.error('GET /voyage:', err);
    return res.status(500).json({ erreur: 'Erreur interne du serveur.' });
  }
});

// PUT /voyage — sauvegarde de l'état complet (last-write-wins)
router.put('/', async (req, res) => {
  try {
    const { data } = req.body || {};
    if (
      !isPlainObject(data) ||
      !isPlainObject(data.overrides) ||
      !isPlainObject(data.comments) ||
      !isPlainObject(data.extras) ||
      (data.done !== undefined && !isPlainObject(data.done))
    ) {
      return res.status(400).json({ erreur: 'Format d\'état voyage invalide.' });
    }
    if (data.done === undefined) data.done = {};
    const updatedBy = (req.user && req.user.firstName) || null;
    const row = await prisma.budgetState.upsert({
      where: { slug: SLUG },
      update: { data, updatedBy },
      create: { slug: SLUG, data, updatedBy },
    });
    return res.json({ ok: true, updatedAt: row.updatedAt, updatedBy: row.updatedBy });
  } catch (err) {
    console.error('PUT /voyage:', err);
    return res.status(500).json({ erreur: 'Erreur interne du serveur.' });
  }
});

module.exports = router;
