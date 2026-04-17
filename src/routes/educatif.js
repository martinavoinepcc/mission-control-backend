// Routes Éducatif — modules, lessons, progression.
// Auth : tout utilisateur connecté. Accès filtré par ModuleAccess.
const express = require('express');
const { PrismaClient } = require('@prisma/client');
const auth = require('../middleware/auth');

const prisma = new PrismaClient();
const router = express.Router();

router.use(auth);

// GET /educatif/modules — liste des modules accessibles au user connecté
router.get('/modules', async (req, res) => {
  try {
    const accesses = await prisma.moduleAccess.findMany({
      where: { userId: req.user.id, hasAccess: true },
      include: { module: true },
    });

    const activeModules = accesses
      .filter((a) => a.module.status === 'ACTIVE')
      .map((a) => a.module);

    // Compute progression summary per module
    const moduleIds = activeModules.map((m) => m.id);
    const progresses = await prisma.progress.findMany({
      where: {
        userId: req.user.id,
        lesson: { moduleId: { in: moduleIds.length ? moduleIds : [-1] } },
      },
      include: { lesson: { select: { moduleId: true } } },
    });
    const lessonCounts = await prisma.lesson.groupBy({
      by: ['moduleId'],
      where: { moduleId: { in: moduleIds.length ? moduleIds : [-1] } },
      _count: { _all: true },
    });
    const countMap = Object.fromEntries(lessonCounts.map((l) => [l.moduleId, l._count._all]));
    const doneByModule = {};
    for (const p of progresses) {
      const m = p.lesson.moduleId;
      if (!doneByModule[m]) doneByModule[m] = { completed: 0, stars: 0, xp: 0 };
      if (p.status === 'COMPLETED') {
        doneByModule[m].completed += 1;
        doneByModule[m].stars += p.stars;
        doneByModule[m].xp += p.xpEarned;
      }
    }

    const result = activeModules
      .sort((a, b) => a.order - b.order)
      .map((m) => ({
        id: m.id,
        slug: m.slug,
        title: m.title,
        subtitle: m.subtitle,
        description: m.description,
        coverColor: m.coverColor,
        coverIcon: m.coverIcon,
        version: m.version,
        avatarKey: m.avatarKey,
        totalLessons: countMap[m.id] || 0,
        completedLessons: doneByModule[m.id]?.completed || 0,
        starsEarned: doneByModule[m.id]?.stars || 0,
        xpEarned: doneByModule[m.id]?.xp || 0,
      }));

    return res.json({ modules: result });
  } catch (err) {
    console.error('GET /educatif/modules error:', err);
    return res.status(500).json({ erreur: 'Erreur interne du serveur.' });
  }
});

// GET /educatif/modules/:slug — détail module + toutes ses lessons (avec statut user)
router.get('/modules/:slug', async (req, res) => {
  try {
    const mod = await prisma.module.findUnique({
      where: { slug: req.params.slug },
      include: { lessons: { orderBy: [{ chapter: 'asc' }, { order: 'asc' }] } },
    });
    if (!mod) return res.status(404).json({ erreur: 'Module introuvable.' });

    // Vérifie l'accès
    const access = await prisma.moduleAccess.findUnique({
      where: { userId_moduleId: { userId: req.user.id, moduleId: mod.id } },
    });
    if (!access || !access.hasAccess) {
      return res.status(403).json({ erreur: 'Accès non autorisé à ce module.' });
    }

    // Progression de l'utilisateur pour ce module
    const progresses = await prisma.progress.findMany({
      where: { userId: req.user.id, lesson: { moduleId: mod.id } },
    });
    const progMap = Object.fromEntries(progresses.map((p) => [p.lessonId, p]));

    // Détermine quelles lessons sont déverrouillées : la 1re du chapitre 1 + suivantes si la précédente est COMPLETED
    const lessons = mod.lessons;
    const unlockedIds = new Set();
    let prevDone = true;
    for (const l of lessons) {
      const p = progMap[l.id];
      const isDone = p?.status === 'COMPLETED';
      if (prevDone) unlockedIds.add(l.id);
      prevDone = isDone;
    }

    const lessonList = lessons.map((l) => {
      const p = progMap[l.id];
      const isUnlocked = unlockedIds.has(l.id);
      return {
        id: l.id,
        slug: l.slug,
        chapter: l.chapter,
        order: l.order,
        kind: l.kind,
        title: l.title,
        subtitle: l.subtitle,
        conceptKey: l.conceptKey,
        status: p?.status || (isUnlocked ? 'UNLOCKED' : 'LOCKED'),
        stars: p?.stars || 0,
        xpEarned: p?.xpEarned || 0,
        isUnlocked,
      };
    });

    return res.json({
      module: {
        id: mod.id,
        slug: mod.slug,
        title: mod.title,
        subtitle: mod.subtitle,
        description: mod.description,
        coverColor: mod.coverColor,
        coverIcon: mod.coverIcon,
        version: mod.version,
        avatarKey: mod.avatarKey,
      },
      lessons: lessonList,
    });
  } catch (err) {
    console.error('GET /educatif/modules/:slug error:', err);
    return res.status(500).json({ erreur: 'Erreur interne du serveur.' });
  }
});

// GET /educatif/lessons/:id — détail complet d'une lesson (pour la jouer)
router.get('/lessons/:id', async (req, res) => {
  try {
    const lessonId = parseInt(req.params.id, 10);
    if (!lessonId) return res.status(400).json({ erreur: 'ID invalide.' });

    const lesson = await prisma.lesson.findUnique({
      where: { id: lessonId },
      include: { module: true },
    });
    if (!lesson) return res.status(404).json({ erreur: 'Mission introuvable.' });

    // Vérifie l'accès au module
    const access = await prisma.moduleAccess.findUnique({
      where: { userId_moduleId: { userId: req.user.id, moduleId: lesson.moduleId } },
    });
    if (!access || !access.hasAccess) {
      return res.status(403).json({ erreur: 'Accès non autorisé.' });
    }

    // Progression courante
    const progress = await prisma.progress.findUnique({
      where: { userId_lessonId: { userId: req.user.id, lessonId: lesson.id } },
    });

    return res.json({
      lesson: {
        id: lesson.id,
        slug: lesson.slug,
        chapter: lesson.chapter,
        order: lesson.order,
        kind: lesson.kind,
        title: lesson.title,
        subtitle: lesson.subtitle,
        conceptKey: lesson.conceptKey,
        data: lesson.data,
      },
      module: {
        slug: lesson.module.slug,
        title: lesson.module.title,
        avatarKey: lesson.module.avatarKey,
        coverColor: lesson.module.coverColor,
      },
      progress: progress
        ? {
            status: progress.status,
            stars: progress.stars,
            hintsUsed: progress.hintsUsed,
            attempts: progress.attempts,
            xpEarned: progress.xpEarned,
            savedCode: progress.savedCode,
          }
        : null,
    });
  } catch (err) {
    console.error('GET /educatif/lessons/:id error:', err);
    return res.status(500).json({ erreur: 'Erreur interne du serveur.' });
  }
});

// POST /educatif/progress — enregistre un événement de progression
// Body: { lessonId, event: 'start' | 'attempt' | 'hint' | 'save_code' | 'complete', payload?: {...} }
router.post('/progress', async (req, res) => {
  try {
    const { lessonId, event, payload } = req.body || {};
    if (!lessonId || !event) {
      return res.status(400).json({ erreur: 'lessonId et event requis.' });
    }

    const lesson = await prisma.lesson.findUnique({ where: { id: parseInt(lessonId, 10) } });
    if (!lesson) return res.status(404).json({ erreur: 'Mission introuvable.' });

    const access = await prisma.moduleAccess.findUnique({
      where: { userId_moduleId: { userId: req.user.id, moduleId: lesson.moduleId } },
    });
    if (!access || !access.hasAccess) {
      return res.status(403).json({ erreur: 'Accès non autorisé.' });
    }

    // Upsert progress row
    let progress = await prisma.progress.findUnique({
      where: { userId_lessonId: { userId: req.user.id, lessonId: lesson.id } },
    });
    if (!progress) {
      progress = await prisma.progress.create({
        data: {
          userId: req.user.id,
          lessonId: lesson.id,
          status: 'IN_PROGRESS',
          lastPlayedAt: new Date(),
        },
      });
    }

    const now = new Date();
    const updates = { lastPlayedAt: now, updatedAt: now };

    switch (event) {
      case 'start':
        if (progress.status === 'LOCKED') updates.status = 'IN_PROGRESS';
        updates.attempts = progress.attempts + 1;
        break;
      case 'attempt':
        updates.attempts = progress.attempts + 1;
        break;
      case 'hint':
        updates.hintsUsed = progress.hintsUsed + 1;
        break;
      case 'save_code':
        if (payload?.code) updates.savedCode = String(payload.code).slice(0, 20000);
        break;
      case 'complete': {
        const stars = Math.max(0, Math.min(3, parseInt(payload?.stars, 10) || 1));
        const xp = Math.max(0, parseInt(payload?.xp, 10) || 10);
        updates.status = 'COMPLETED';
        updates.stars = Math.max(progress.stars, stars); // on garde le meilleur
        updates.xpEarned = Math.max(progress.xpEarned, xp);
        if (!progress.firstDoneAt) updates.firstDoneAt = now;
        break;
      }
      default:
        return res.status(400).json({ erreur: 'Event inconnu.' });
    }

    const updated = await prisma.progress.update({
      where: { id: progress.id },
      data: updates,
    });

    return res.json({ progress: updated });
  } catch (err) {
    console.error('POST /educatif/progress error:', err);
    return res.status(500).json({ erreur: 'Erreur interne du serveur.' });
  }
});

// GET /educatif/me — progression globale (total XP, rang, badges, streak)
router.get('/me', async (req, res) => {
  try {
    const progresses = await prisma.progress.findMany({
      where: { userId: req.user.id, status: 'COMPLETED' },
    });
    const badges = await prisma.userBadge.findMany({
      where: { userId: req.user.id },
      include: { badge: true },
    });

    const totalXp = progresses.reduce((acc, p) => acc + p.xpEarned, 0);
    const totalStars = progresses.reduce((acc, p) => acc + p.stars, 0);

    // Rangs : simple mapping par XP
    const rank = computeRank(totalXp);

    return res.json({
      totalXp,
      totalStars,
      rank,
      completedCount: progresses.length,
      badges: badges.map((ub) => ({
        slug: ub.badge.slug,
        title: ub.badge.title,
        icon: ub.badge.icon,
        earnedAt: ub.earnedAt,
      })),
    });
  } catch (err) {
    console.error('GET /educatif/me error:', err);
    return res.status(500).json({ erreur: 'Erreur interne du serveur.' });
  }
});

function computeRank(xp) {
  const ranks = [
    { slug: 'recrue', label: 'Recrue', minXp: 0 },
    { slug: 'cadet', label: 'Cadet', minXp: 100 },
    { slug: 'specialiste', label: 'Spécialiste', minXp: 300 },
    { slug: 'technicien', label: 'Technicien', minXp: 600 },
    { slug: 'commandant', label: 'Commandant', minXp: 1000 },
  ];
  let current = ranks[0];
  for (const r of ranks) {
    if (xp >= r.minXp) current = r;
  }
  return current;
}

module.exports = router;
