// Impro Engine — routes API.
// GET /improv/categories — list actives
// GET /improv/themes — list actives
// GET /improv/constraints — list actives
// POST /improv/generate — moteur: retourne une carte improv
// POST /improv/sessions — créer une session (practice ou game)
// POST /improv/sessions/:id/rounds — enregistrer un round joué

const express = require('express');
const { PrismaClient } = require('@prisma/client');
const auth = require('../middleware/auth');

const prisma = new PrismaClient();
const router = express.Router();

router.use(auth);

// Utilitaires
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function pickOrNull(arr) { return arr.length ? pick(arr) : null; }

function difficultyRank(d) {
  return d === 'EASY' ? 0 : d === 'MEDIUM' ? 1 : 2;
}

// GET /improv/categories
router.get('/categories', async (req, res) => {
  try {
    const cats = await prisma.improvCategory.findMany({
      where: { active: true },
      orderBy: { name: 'asc' },
    });
    return res.json({ categories: cats });
  } catch (e) {
    console.error('GET /improv/categories', e);
    return res.status(500).json({ erreur: 'Erreur serveur.' });
  }
});

// GET /improv/themes
router.get('/themes', async (req, res) => {
  try {
    const themes = await prisma.improvTheme.findMany({
      where: { active: true },
      orderBy: { name: 'asc' },
    });
    return res.json({ themes });
  } catch (e) {
    console.error('GET /improv/themes', e);
    return res.status(500).json({ erreur: 'Erreur serveur.' });
  }
});

// GET /improv/constraints
router.get('/constraints', async (req, res) => {
  try {
    const constraints = await prisma.improvConstraint.findMany({
      where: { active: true },
      orderBy: { name: 'asc' },
    });
    return res.json({ constraints });
  } catch (e) {
    console.error('GET /improv/constraints', e);
    return res.status(500).json({ erreur: 'Erreur serveur.' });
  }
});

// POST /improv/generate
// Body (practice): {
//   mode: 'PRACTICE' | 'GAME',
//   generation: 'AUTO' | 'STEP' | 'CUSTOM',
//   teams: 1 | 2,
//   playersPerTeam: number,
//   difficulty: 'EASY'|'MEDIUM'|'HARD',
//   nature?: 'MIXTE'|'COMPAREE',
//   categorySlug?: string,
//   themeSlug?: string,
//   durationSec?: number,
//   caucusSec?: number,
//   constraintsSlugs?: string[],
// }
// Response: {
//   card: { nature, category, theme, players, durationSec, caucusSec, constraints }
// }
router.post('/generate', async (req, res) => {
  try {
    const body = req.body || {};
    const mode = (body.mode || 'PRACTICE').toUpperCase();
    const gen = (body.generation || 'AUTO').toUpperCase();
    const teams = Math.max(1, Math.min(2, Number(body.teams) || 1));
    const playersPerTeam = Math.max(1, Math.min(8, Number(body.playersPerTeam) || 2));
    const totalPlayers = teams * playersPerTeam;
    const difficulty = (body.difficulty || 'MEDIUM').toUpperCase();

    // Eligible categories: active + fits mode + fits player count + respects difficulty ceiling
    const allCats = await prisma.improvCategory.findMany({ where: { active: true } });
    const maxRank = difficultyRank(difficulty);
    let eligible = allCats.filter((c) => {
      if (mode === 'PRACTICE' && !c.practiceCompatible) return false;
      if (mode === 'GAME' && !c.gameCompatible) return false;
      if (totalPlayers < c.minPlayers || totalPlayers > c.maxPlayers) return false;
      if (difficultyRank(c.difficulty) > maxRank) return false;
      if (mode === 'GAME' && teams === 2) {
        // Comparee needs 2 teams; both are fine.
      } else {
        // In practice with 1 team, only MIXTE-compatible categories make sense.
        if (!c.allowedNatures.includes('MIXTE')) return false;
      }
      return true;
    });

    // Constraint by explicit inputs
    let chosen = null;
    if (body.categorySlug) {
      chosen = allCats.find((c) => c.slug === body.categorySlug) || null;
      if (!chosen) return res.status(400).json({ erreur: 'Catégorie introuvable.' });
    } else {
      if (eligible.length === 0) return res.status(400).json({ erreur: 'Aucune catégorie compatible avec ces paramètres.' });
      chosen = pick(eligible);
    }

    // Nature
    let nature;
    if (body.nature) {
      nature = body.nature;
    } else if (teams === 1 || mode === 'PRACTICE') {
      nature = 'MIXTE';
    } else {
      nature = pick(chosen.allowedNatures);
    }

    // Theme
    let theme = null;
    if (chosen.themeRequired) {
      if (body.themeSlug) {
        theme = await prisma.improvTheme.findUnique({ where: { slug: body.themeSlug } });
      } else {
        const themes = await prisma.improvTheme.findMany({
          where: {
            active: true,
            AND: [
              { OR: [{ categoryId: chosen.id }, { categoryId: null }] },
            ],
          },
        });
        // Prefer themes with matching difficulty or lower
        const filtered = themes.filter((t) => difficultyRank(t.difficulty) <= maxRank);
        theme = pickOrNull(filtered.length ? filtered : themes);
      }
    }

    // Constraints
    let constraints = [];
    if (chosen.constraintsAllowed) {
      if (Array.isArray(body.constraintsSlugs) && body.constraintsSlugs.length) {
        constraints = await prisma.improvConstraint.findMany({
          where: { slug: { in: body.constraintsSlugs }, active: true },
        });
      } else if (gen === 'AUTO' && maxRank >= 1) {
        // Medium/Hard: 0-2 random constraints
        const pool = await prisma.improvConstraint.findMany({
          where: { active: true },
        });
        const eligibleK = pool.filter((k) => difficultyRank(k.difficulty) <= maxRank);
        const howMany = difficulty === 'HARD' ? (Math.random() < 0.6 ? 2 : 1) : (Math.random() < 0.4 ? 1 : 0);
        const shuffled = eligibleK.sort(() => Math.random() - 0.5);
        constraints = shuffled.slice(0, howMany);
      }
    }

    // Duration
    const durationSec = Number(body.durationSec) ||
      (chosen.minDurationSec + Math.floor(Math.random() * (chosen.maxDurationSec - chosen.minDurationSec + 1))) ||
      chosen.defaultDurationSec;
    const caucusSec = body.caucusSec != null ? Number(body.caucusSec) : (chosen.caucusAllowed ? chosen.defaultCaucusSec : 0);

    const card = {
      nature,
      category: {
        slug: chosen.slug,
        name: chosen.name,
        shortDescription: chosen.shortDescription,
        difficulty: chosen.difficulty,
      },
      theme: theme ? { slug: theme.slug, name: theme.name } : null,
      constraints: constraints.map((k) => ({ slug: k.slug, name: k.name, description: k.description, difficulty: k.difficulty })),
      players: { teams, playersPerTeam, total: totalPlayers },
      durationSec,
      caucusSec,
    };

    return res.json({ card });
  } catch (e) {
    console.error('POST /improv/generate', e);
    return res.status(500).json({ erreur: 'Erreur de génération.' });
  }
});

// POST /improv/sessions
router.post('/sessions', async (req, res) => {
  try {
    const mode = (req.body?.mode || 'PRACTICE').toUpperCase();
    const s = await prisma.improvSession.create({
      data: { userId: req.user.id, mode },
    });
    return res.status(201).json({ session: s });
  } catch (e) {
    console.error('POST /improv/sessions', e);
    return res.status(500).json({ erreur: 'Erreur serveur.' });
  }
});

// POST /improv/sessions/:id/rounds
router.post('/sessions/:id/rounds', async (req, res) => {
  try {
    const sessionId = parseInt(req.params.id, 10);
    const ownership = await prisma.improvSession.findUnique({ where: { id: sessionId } });
    if (!ownership || ownership.userId !== req.user.id) return res.status(404).json({ erreur: 'Session introuvable.' });
    const r = await prisma.improvRound.create({
      data: {
        sessionId,
        orderIndex: Number(req.body?.orderIndex) || 0,
        cardData: req.body?.cardData || {},
        voteResult: req.body?.voteResult || null,
        startedAt: req.body?.startedAt ? new Date(req.body.startedAt) : null,
        endedAt: req.body?.endedAt ? new Date(req.body.endedAt) : null,
      },
    });
    return res.status(201).json({ round: r });
  } catch (e) {
    console.error('POST /improv/sessions/:id/rounds', e);
    return res.status(500).json({ erreur: 'Erreur serveur.' });
  }
});

module.exports = router;
