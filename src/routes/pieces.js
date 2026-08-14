// Routes /pieces — « Notre Chalet · pièce par pièce ».
//
// Contenu vivant par pièce du futur chalet (requis cochables, commentaires,
// inspirations avec photo). Les 17 pièces (metadata + dimensions extraites des
// plans TALO) sont définies côté frontend — ici on ne stocke que les entrées.
// Toutes les routes sont protégées par auth + adultOnly (Martin + Marie-Josée).
//
// - GET    /pieces/entries            -> toutes les entrées (sans photoData, flag hasPhoto)
// - GET    /pieces/photo/:id          -> photo binaire (supporte ?token= pour <img>)
// - POST   /pieces/entries            -> { pieceId, kind, text?, photoData? }
// - PATCH  /pieces/entries/:id        -> { done?, text? }
// - POST   /pieces/entries/:id/like   -> toggle le prénom du user dans likes
// - POST   /pieces/entries/:id/reply  -> { text }
// - DELETE /pieces/entries/:id

const express = require('express');
const { PrismaClient } = require('@prisma/client');
const auth = require('../middleware/auth');

const prisma = new PrismaClient();
const router = express.Router();

function adultOnly(req, res, next) {
  if (req.user && req.user.profile === 'CHILD') {
    return res.status(403).json({ erreur: 'Accès réservé aux parents.' });
  }
  next();
}

router.use(auth, adultOnly);

const KINDS = ['REQUIS', 'COMMENTAIRE', 'INSPIRATION'];

// Prénom court affiché/enregistré (Marie-Josée -> MJ pour rester compact).
function authorName(req) {
  const first = (req.user && req.user.firstName) || 'Inconnu';
  return first === 'Marie-Josée' ? 'MJ' : first;
}

const ENTRY_SELECT = {
  id: true, pieceId: true, kind: true, text: true, author: true,
  done: true, likes: true, replies: true, createdAt: true, updatedAt: true,
};

function serialize(e, hasPhoto) {
  return { ...e, hasPhoto: !!hasPhoto };
}

// ============ LISTE ============

router.get('/entries', async (req, res) => {
  try {
    const rows = await prisma.pieceEntry.findMany({
      select: ENTRY_SELECT,
      orderBy: { createdAt: 'asc' },
    });
    // hasPhoto sans rapatrier le base64 : requête légère sur les ids à photo.
    const withPhoto = await prisma.pieceEntry.findMany({
      where: { photoData: { not: null } },
      select: { id: true },
    });
    const photoIds = new Set(withPhoto.map((r) => r.id));
    res.json(rows.map((e) => serialize(e, photoIds.has(e.id))));
  } catch (err) {
    console.error('GET /pieces/entries:', err);
    res.status(500).json({ erreur: 'Erreur au chargement des entrées.' });
  }
});

// ============ PHOTO ============

router.get('/photo/:id', async (req, res) => {
  try {
    const e = await prisma.pieceEntry.findUnique({
      where: { id: parseInt(req.params.id, 10) || 0 },
      select: { photoData: true },
    });
    if (!e || !e.photoData) return res.status(404).json({ erreur: 'Photo introuvable.' });
    const m = e.photoData.match(/^data:([^;]+);base64,(.+)$/s);
    if (!m) return res.status(500).json({ erreur: 'Format de photo invalide.' });
    const buf = Buffer.from(m[2], 'base64');
    res.setHeader('Content-Type', m[1]);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.send(buf);
  } catch (err) {
    console.error('GET /pieces/photo:', err);
    res.status(500).json({ erreur: 'Erreur au chargement de la photo.' });
  }
});

// ============ CRÉATION ============

router.post('/entries', async (req, res) => {
  try {
    const { pieceId, kind, text, photoData } = req.body || {};
    if (!pieceId || typeof pieceId !== 'string' || pieceId.length > 60) {
      return res.status(400).json({ erreur: 'pieceId manquant ou invalide.' });
    }
    if (!KINDS.includes(kind)) {
      return res.status(400).json({ erreur: 'kind invalide.' });
    }
    const cleanText = typeof text === 'string' ? text.trim().slice(0, 2000) : '';
    let cleanPhoto = null;
    if (photoData) {
      if (typeof photoData !== 'string' || !photoData.startsWith('data:image/') || photoData.length > 2_500_000) {
        return res.status(400).json({ erreur: 'Photo invalide ou trop lourde (max ~1,8 Mo).' });
      }
      cleanPhoto = photoData;
    }
    if (!cleanText && !cleanPhoto) {
      return res.status(400).json({ erreur: 'Texte ou photo requis.' });
    }
    const e = await prisma.pieceEntry.create({
      data: { pieceId, kind, text: cleanText, author: authorName(req), photoData: cleanPhoto },
      select: ENTRY_SELECT,
    });
    res.status(201).json(serialize(e, !!cleanPhoto));
  } catch (err) {
    console.error('POST /pieces/entries:', err);
    res.status(500).json({ erreur: "Erreur à l'ajout." });
  }
});

// ============ MAJ (done / texte) ============

router.patch('/entries/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10) || 0;
    const data = {};
    if (typeof req.body.done === 'boolean') data.done = req.body.done;
    if (typeof req.body.text === 'string') data.text = req.body.text.trim().slice(0, 2000);
    if (!Object.keys(data).length) return res.status(400).json({ erreur: 'Rien à modifier.' });
    const e = await prisma.pieceEntry.update({ where: { id }, data, select: ENTRY_SELECT });
    res.json(serialize(e, false));
  } catch (err) {
    console.error('PATCH /pieces/entries:', err);
    res.status(500).json({ erreur: 'Erreur à la mise à jour.' });
  }
});

// ============ VOTE « Moi aussi ! » ============

router.post('/entries/:id/like', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10) || 0;
    const e = await prisma.pieceEntry.findUnique({ where: { id }, select: { likes: true } });
    if (!e) return res.status(404).json({ erreur: 'Entrée introuvable.' });
    const me = authorName(req);
    const likes = Array.isArray(e.likes) ? e.likes.filter((x) => typeof x === 'string') : [];
    const i = likes.indexOf(me);
    if (i >= 0) likes.splice(i, 1);
    else likes.push(me);
    const updated = await prisma.pieceEntry.update({ where: { id }, data: { likes }, select: ENTRY_SELECT });
    res.json(serialize(updated, false));
  } catch (err) {
    console.error('POST /pieces/like:', err);
    res.status(500).json({ erreur: 'Erreur au vote.' });
  }
});

// ============ RÉPONSE ============

router.post('/entries/:id/reply', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10) || 0;
    const text = typeof req.body.text === 'string' ? req.body.text.trim().slice(0, 1000) : '';
    if (!text) return res.status(400).json({ erreur: 'Texte requis.' });
    const e = await prisma.pieceEntry.findUnique({ where: { id }, select: { replies: true } });
    if (!e) return res.status(404).json({ erreur: 'Entrée introuvable.' });
    const replies = Array.isArray(e.replies) ? e.replies : [];
    replies.push({ t: text, by: authorName(req), ts: new Date().toISOString() });
    const updated = await prisma.pieceEntry.update({ where: { id }, data: { replies }, select: ENTRY_SELECT });
    res.json(serialize(updated, false));
  } catch (err) {
    console.error('POST /pieces/reply:', err);
    res.status(500).json({ erreur: "Erreur à l'ajout de la réponse." });
  }
});

// ============ SUPPRESSION ============

router.delete('/entries/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10) || 0;
    await prisma.pieceEntry.delete({ where: { id } });
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /pieces/entries:', err);
    res.status(500).json({ erreur: 'Erreur à la suppression.' });
  }
});

module.exports = router;
