// Impro Engine — routes API.
// GET /improv/categories — list actives
// GET /improv/themes — list actives
// GET /improv/constraints — list actives
// POST /improv/generate — moteur: retourne une carte improv
// POST /improv/sessions — créer une session (practice ou game)
// POST /improv/sessions/:id/rounds — enregistrer un round joué

const express = require('express');
const { PrismaClient } = require('@prisma/client');
const Anthropic = require('@anthropic-ai/sdk');
const auth = require('../middleware/auth');

const _anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;

// Fallback horoscopes par signe (3 par signe) — utilisés si Anthropic down.
const ZODIAC_SIGNS = ['Bélier','Taureau','Gémeaux','Cancer','Lion','Vierge','Balance','Scorpion','Sagittaire','Capricorne','Verseau','Poissons'];
const HOROSCOPE_FALLBACKS = {
  'Bélier':      ["Ton feu intérieur bouillonne. Une décision audacieuse avant midi va tout changer. Attention à ne pas écraser les orteils des autres.", "L'univers te pousse à dire ce que tu penses vraiment. Jour idéal pour commencer quelque chose. Bois beaucoup d'eau.", "Tu rayonnes. Une vieille connaissance va refaire surface. Reste curieux de tout."],
  'Taureau':     ["Ta patience légendaire va payer aujourd'hui. Un plaisir inattendu t'attend au coin de la rue. Écoute ton instinct gourmand.", "L'argent et le confort sont au rendez-vous. Prends soin de ton dos. Savoure chaque bouchée.", "Un ami fidèle a besoin de toi. Sois présent mais ne te laisse pas submerger."],
  'Gémeaux':     ["Deux opportunités se présentent. Choisis la moins évidente. Ta curiosité va te mener loin aujourd'hui.", "Parle moins, écoute plus. Un message important va arriver en fin de journée. Souris sans raison.", "Tu jongles avec trop de choses. Pose-en une pour mieux attraper les autres."],
  'Cancer':      ["Tes émotions sont à fleur de peau. C'est une force, pas une faiblesse. Quelqu'un pense à toi très fort.", "Un souvenir d'enfance va te revenir. Laisse-toi porter. Ta maison est ton sanctuaire aujourd'hui.", "Protège ton cœur mais n'oublie pas de l'ouvrir à la bonne personne."],
  'Lion':        ["Tu brilles — les gens te suivent naturellement. Utilise ce pouvoir pour le bien. Une reconnaissance méritée arrive.", "Ton charisme est à son pic. Ose demander ce que tu veux. Mais reste humble dans la victoire.", "Un défi à la hauteur de ton orgueil se profile. Relève-le sans arrogance."],
  'Vierge':      ["Ton sens du détail va sauver quelqu'un aujourd'hui. Sois moins dur avec toi-même. La perfection n'existe pas.", "Range quelque chose — physiquement ou mentalement. Clarté = paix. Un compliment inattendu va te toucher.", "Tu analyses trop. Fais confiance à ton premier instinct pour une fois."],
  'Balance':     ["Un choix difficile entre deux options équivalentes. Laisse parler ton cœur, pas ta tête. L'harmonie règne chez toi.", "Tu cherches le juste milieu partout — aujourd'hui, prends position. Les astres soutiennent les audacieux.", "Une rencontre va équilibrer ta semaine. Sois ouvert."],
  'Scorpion':    ["Ton intuition est laser aujourd'hui. Tu perces les secrets d'un coup d'œil. Ne sois pas cruel avec cette info.", "Une transformation profonde commence. Laisse mourir ce qui doit mourir. La phoenix se lève.", "Quelqu'un te ment. Tu le sens. Attends le bon moment pour confronter."],
  'Sagittaire':  ["L'aventure t'appelle. Réserve un billet — même symbolique. Ton optimisme contagieux va inspirer.", "Tu as raison sur quelque chose mais tu as tort sur la façon de le dire. Adoucis le ton.", "Un voyage intérieur aujourd'hui. Lis un chapitre qui te fait peur."],
  'Capricorne':  ["Ton travail acharné porte ses fruits. Profite du moment sans déjà planifier le suivant. Rire fort aujourd'hui.", "Une montagne à gravir — tu as les outils. Un mentor va apparaître si tu demandes.", "Relâche le contrôle sur une petite chose. Le ciel ne tombera pas."],
  'Verseau':     ["Une idée révolutionnaire germe. Note-la avant qu'elle s'envole. Une amitié va s'approfondir.", "Tu veux changer le monde — commence par changer une habitude. Les astres applaudissent.", "Ta différence est ta force. Arrête de t'excuser d'être toi."],
  'Poissons':    ["Tes rêves essaient de te dire quelque chose. Note-les au réveil. Une créativité fluide t'habite.", "Tu absorbes les énergies des autres. Met des limites douces. Un art va te guérir.", "La magie est dans les petites coïncidences. Remarque-les. Quelqu'un te voit vraiment."]
};

async function generateHoroscope(forceFallback = false) {
  const sign = ZODIAC_SIGNS[Math.floor(Math.random() * ZODIAC_SIGNS.length)];
  if (!forceFallback && _anthropic) {
    try {
      const msg = await _anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 150,
        system: 'Tu es un astrologue québécois charismatique. Écris UN horoscope du jour (3-4 phrases) pour le signe demandé, avec un ton légèrement dramatique mais joyeux. Inclus OBLIGATOIREMENT : (1) un trait de caractère évoqué, (2) un événement imminent, (3) un conseil concret. Pas de markdown. Français québécois naturel.',
        messages: [{ role: 'user', content: `Horoscope du jour pour le signe ${sign}.` }],
      });
      const text = (msg.content && msg.content[0] && msg.content[0].text) || '';
      if (text) return { sign, text, source: 'ai' };
    } catch (e) {
      console.warn('Horoscope AI failed, fallback:', e.message);
    }
  }
  const pool = HOROSCOPE_FALLBACKS[sign] || ['Les astres sont silencieux aujourd\'hui.'];
  const text = pool[Math.floor(Math.random() * pool.length)];
  return { sign, text, source: 'fallback' };
}

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

    // Constraints (skipped if forceNoConstraints)
    let constraints = [];
    if (!body.forceNoConstraints && chosen.constraintsAllowed) {
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
        rulesDescription: chosen.rulesDescription,
        difficulty: chosen.difficulty,
      },
      theme: theme ? { slug: theme.slug, name: theme.name } : null,
      constraints: constraints.map((k) => ({ slug: k.slug, name: k.name, description: k.description, difficulty: k.difficulty })),
      players: { teams, playersPerTeam, total: totalPlayers },
      durationSec,
      caucusSec,
    };

    // Auto-attach horoscope if category is 'horoscope'
    if (chosen.slug === 'horoscope') {
      try {
        card.horoscope = await generateHoroscope();
      } catch (e) {
        card.horoscope = { sign: '?', text: 'Les astres sont muets.', source: 'error' };
      }
    }

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

// POST /improv/horoscope — standalone (tirage manuel si besoin)
router.post('/horoscope', async (req, res) => {
  try {
    const h = await generateHoroscope();
    return res.json(h);
  } catch (e) {
    console.error('POST /improv/horoscope', e);
    return res.status(500).json({ erreur: 'Les astres sont en maintenance.' });
  }
});

module.exports = router;
