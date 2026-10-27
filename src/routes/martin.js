// GET /api/martin/projets — tableau de bord « Martin » (lecture seule).
//
// Projets démarrés par Martin et son assistante FRIDAY. Le corps de la
// réponse est le fichier versionné src/data/martin-projets.json, tel quel
// ({ titre, mis_a_jour, source, etats_possibles, projets[] }).
//
// Protection, même politique que la tuile Carrière (« toujours Martin seul »,
// commit du 2026-10-07) :
//   - JWT du middleware auth partagé. Sans jeton, ou jeton invalide : 401.
//   - Seul martin@logifox.io passe. Un autre membre (adulte, enfant, invité)
//     reçoit 403, comme quand l'app `carriere` lui est refusée.
//   - La tuile du catalogue est l'app `martin` (seed, royaume WORK), accordée
//     au même compte seulement. Ce fichier n'est pas lu en base : rien n'est
//     servi sans authentification.

const express = require('express');
const fs = require('fs');
const path = require('path');
const auth = require('../middleware/auth');

const router = express.Router();

const MARTIN_EMAIL = 'martin@logifox.io';
const FICHIER = path.join(__dirname, '..', 'data', 'martin-projets.json');

function martinSeul(req, res, next) {
  if (!req.user || req.user.profile === 'CHILD' || req.user.profile === 'GUEST') {
    return res.status(403).json({ erreur: 'Accès réservé.' });
  }
  const email = typeof req.user.email === 'string' ? req.user.email.toLowerCase() : '';
  if (email !== MARTIN_EMAIL) {
    return res.status(403).json({ erreur: 'Accès réservé.' });
  }
  next();
}

router.use(auth, martinSeul);

router.get('/projets', (req, res) => {
  try {
    const data = JSON.parse(fs.readFileSync(FICHIER, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('forme inattendue');
    }
    res.json(data);
  } catch (e) {
    console.error('martin projets', e);
    res.status(500).json({ erreur: 'Erreur serveur.' });
  }
});

module.exports = router;
