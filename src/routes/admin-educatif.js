// Routes admin pour le volet Éducatif.
// Permet à Martin de :
//  - voir tous les modules installés + leurs stats
//  - créer / mettre à jour / archiver un module manuellement
//  - gérer l'accès granulaire (qui voit quel module)
//  - importer un content pack (JSON) — structure : { module, lessons[] }
//  - voir la progression de chaque enfant
const express = require('express');
const { PrismaClient } = require('@prisma/client');
const auth = require('../middleware/auth');
const admin = require('../middleware/admin');

const prisma = new PrismaClient();
const router = express.Router();

router.use(auth, admin);

// GET /admin/educatif/modules — liste de tous les modules + résumé
router.get('/modules', async (req, res) => {
  try {
    const modules = await prisma.module.findMany({
      orderBy: [{ order: 'asc' }, { id: 'asc' }],
      include: {
        _count: { select: { lessons: true, accesses: true } },
      },
    });
    return res.json({
      modules: modules.map((m) => ({
        id: m.id,
        slug: m.slug,
        title: m.title,
        subtitle: m.subtitle,
        description: m.description,
        coverColor: m.coverColor,
        coverIcon: m.coverIcon,
        version: m.version,
        language: m.language,
        avatarKey: m.avatarKey,
        status: m.status,
        order: m.order,
        lessonCount: m._count.lessons,
        accessCount: m._count.accesses,
        createdAt: m.createdAt,
        updatedAt: m.updatedAt,
      })),
    });
  } catch (err) {
    console.error('GET /admin/educatif/modules error:', err);
    return res.status(500).json({ erreur: 'Erreur interne du serveur.' });
  }
});

// GET /admin/educatif/modules/:id — détail d'un module + liste accès + lessons
router.get('/modules/:id', async (req, res) => {
  try {
    const moduleId = parseInt(req.params.id, 10);
    if (!moduleId) return res.status(400).json({ erreur: 'ID invalide.' });

    const mod = await prisma.module.findUnique({
      where: { id: moduleId },
      include: {
        lessons: { orderBy: [{ chapter: 'asc' }, { order: 'asc' }] },
        accesses: { include: { user: true } },
      },
    });
    if (!mod) return res.status(404).json({ erreur: 'Module introuvable.' });

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
        language: mod.language,
        avatarKey: mod.avatarKey,
        status: mod.status,
        order: mod.order,
      },
      lessons: mod.lessons.map((l) => ({
        id: l.id,
        slug: l.slug,
        chapter: l.chapter,
        order: l.order,
        kind: l.kind,
        title: l.title,
        subtitle: l.subtitle,
        conceptKey: l.conceptKey,
      })),
      accesses: mod.accesses.map((a) => ({
        id: a.id,
        userId: a.userId,
        userFirstName: a.user.firstName,
        userEmail: a.user.email,
        hasAccess: a.hasAccess,
        unlockedAt: a.unlockedAt,
      })),
    });
  } catch (err) {
    console.error('GET /admin/educatif/modules/:id error:', err);
    return res.status(500).json({ erreur: 'Erreur interne du serveur.' });
  }
});

// POST /admin/educatif/modules/:id/access — toggle accès d'un user à un module
// Body: { userId, hasAccess }
router.post('/modules/:id/access', async (req, res) => {
  try {
    const moduleId = parseInt(req.params.id, 10);
    const { userId, hasAccess } = req.body || {};
    if (!moduleId || !userId || typeof hasAccess !== 'boolean') {
      return res.status(400).json({ erreur: 'moduleId, userId et hasAccess requis.' });
    }

    await prisma.moduleAccess.upsert({
      where: { userId_moduleId: { userId, moduleId } },
      update: { hasAccess },
      create: { userId, moduleId, hasAccess },
    });

    return res.json({ message: hasAccess ? 'Accès accordé.' : 'Accès retiré.' });
  } catch (err) {
    console.error('POST /admin/educatif/modules/:id/access error:', err);
    return res.status(500).json({ erreur: 'Erreur interne du serveur.' });
  }
});

// PATCH /admin/educatif/modules/:id — modifie métadonnées (status, order, title, etc.)
router.patch('/modules/:id', async (req, res) => {
  try {
    const moduleId = parseInt(req.params.id, 10);
    if (!moduleId) return res.status(400).json({ erreur: 'ID invalide.' });

    const allowed = [
      'title',
      'subtitle',
      'description',
      'coverColor',
      'coverIcon',
      'version',
      'language',
      'avatarKey',
      'status',
      'order',
    ];
    const data = {};
    for (const k of allowed) if (req.body?.[k] !== undefined) data[k] = req.body[k];
    if (!Object.keys(data).length) {
      return res.status(400).json({ erreur: 'Aucun champ à mettre à jour.' });
    }

    const updated = await prisma.module.update({ where: { id: moduleId }, data });
    return res.json({ module: updated });
  } catch (err) {
    console.error('PATCH /admin/educatif/modules/:id error:', err);
    return res.status(500).json({ erreur: 'Erreur interne du serveur.' });
  }
});

// DELETE /admin/educatif/modules/:id — archive un module (soft delete via status)
router.delete('/modules/:id', async (req, res) => {
  try {
    const moduleId = parseInt(req.params.id, 10);
    if (!moduleId) return res.status(400).json({ erreur: 'ID invalide.' });
    await prisma.module.update({ where: { id: moduleId }, data: { status: 'ARCHIVED' } });
    return res.json({ message: 'Module archivé.' });
  } catch (err) {
    console.error('DELETE /admin/educatif/modules/:id error:', err);
    return res.status(500).json({ erreur: 'Erreur interne du serveur.' });
  }
});

// POST /admin/educatif/packs/import — import d'un content pack JSON
// Body: {
//   module: { slug, title, subtitle, description, coverColor, coverIcon, version, language, avatarKey, order },
//   lessons: [{ slug, chapter, order, kind, title, subtitle, conceptKey, data }]
// }
// Idempotent : upsert sur slug. Si le module existe déjà, les lessons sont upsertées sur (moduleId, slug).
router.post('/packs/import', async (req, res) => {
  try {
    const { module: modPayload, lessons } = req.body || {};
    if (!modPayload || !modPayload.slug || !modPayload.title) {
      return res.status(400).json({ erreur: 'module.slug et module.title requis.' });
    }
    if (!Array.isArray(lessons)) {
      return res.status(400).json({ erreur: 'lessons doit être un array.' });
    }

    // 1. Upsert module
    const mod = await prisma.module.upsert({
      where: { slug: modPayload.slug },
      update: {
        title: modPayload.title,
        subtitle: modPayload.subtitle || null,
        description: modPayload.description || null,
        coverColor: modPayload.coverColor || null,
        coverIcon: modPayload.coverIcon || null,
        version: modPayload.version || '1.0.0',
        language: modPayload.language || 'fr-CA',
        avatarKey: modPayload.avatarKey || null,
        order: typeof modPayload.order === 'number' ? modPayload.order : 0,
        status: modPayload.status || 'ACTIVE',
      },
      create: {
        slug: modPayload.slug,
        title: modPayload.title,
        subtitle: modPayload.subtitle || null,
        description: modPayload.description || null,
        coverColor: modPayload.coverColor || null,
        coverIcon: modPayload.coverIcon || null,
        version: modPayload.version || '1.0.0',
        language: modPayload.language || 'fr-CA',
        avatarKey: modPayload.avatarKey || null,
        order: typeof modPayload.order === 'number' ? modPayload.order : 0,
        status: modPayload.status || 'ACTIVE',
      },
    });

    // 2. Upsert lessons
    let created = 0;
    let updated = 0;
    for (const l of lessons) {
      if (!l.slug || !l.title) continue;
      const existing = await prisma.lesson.findUnique({
        where: { moduleId_slug: { moduleId: mod.id, slug: l.slug } },
      });
      const payload = {
        chapter: l.chapter || 1,
        order: typeof l.order === 'number' ? l.order : 0,
        kind: l.kind || 'QUEST',
        title: l.title,
        subtitle: l.subtitle || null,
        conceptKey: l.conceptKey || null,
        data: l.data || {},
      };
      if (existing) {
        await prisma.lesson.update({ where: { id: existing.id }, data: payload });
        updated += 1;
      } else {
        await prisma.lesson.create({ data: { moduleId: mod.id, slug: l.slug, ...payload } });
        created += 1;
      }
    }

    return res.json({
      message: 'Pack importé.',
      module: { id: mod.id, slug: mod.slug, title: mod.title, version: mod.version },
      lessons: { created, updated, total: lessons.length },
    });
  } catch (err) {
    console.error('POST /admin/educatif/packs/import error:', err);
    return res.status(500).json({ erreur: 'Erreur interne du serveur: ' + err.message });
  }
});

// GET /admin/educatif/progress — vue d'ensemble progression par enfant
router.get('/progress', async (req, res) => {
  try {
    const children = await prisma.user.findMany({
      where: { profile: 'CHILD' },
      orderBy: { firstName: 'asc' },
    });

    const result = [];
    for (const kid of children) {
      const progresses = await prisma.progress.findMany({
        where: { userId: kid.id },
        include: { lesson: { include: { module: true } } },
      });

      const byModule = {};
      for (const p of progresses) {
        const mid = p.lesson.moduleId;
        if (!byModule[mid]) {
          byModule[mid] = {
            moduleId: mid,
            moduleSlug: p.lesson.module.slug,
            moduleTitle: p.lesson.module.title,
            started: 0,
            completed: 0,
            stars: 0,
            xp: 0,
          };
        }
        byModule[mid].started += 1;
        if (p.status === 'COMPLETED') {
          byModule[mid].completed += 1;
          byModule[mid].stars += p.stars;
          byModule[mid].xp += p.xpEarned;
        }
      }

      const totalXp = progresses.reduce((a, p) => a + (p.xpEarned || 0), 0);
      const totalStars = progresses.reduce((a, p) => a + (p.stars || 0), 0);

      result.push({
        userId: kid.id,
        firstName: kid.firstName,
        email: kid.email,
        totalXp,
        totalStars,
        modules: Object.values(byModule),
      });
    }

    return res.json({ children: result });
  } catch (err) {
    console.error('GET /admin/educatif/progress error:', err);
    return res.status(500).json({ erreur: 'Erreur interne du serveur.' });
  }
});

module.exports = router;
