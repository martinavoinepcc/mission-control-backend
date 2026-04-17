// Seed initial — crée les comptes famille, les apps mockup ET le module Éducatif "Code Cadet".
// Idempotent : peut être relancé sans doublons grâce aux upsert.
// v2.0.0 (2026-04-17) : nettoyage auto des lessons obsolètes (curriculum Silica-aligned).
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');
const { module1: codeCadet } = require('../content/code-cadet');

const prisma = new PrismaClient();

// Convention temporaire (Martin gérera ça plus tard) :
// mot de passe = première lettre du prénom (minuscule) + année de naissance.
const FAMILY = [
  {
    email: 'martin@logifox.io',
    firstName: 'Martin',
    password: 'Mm7632362$', // admin — mot de passe original conserve
    role: 'ADMIN',
    profile: 'ADULT',
    mustChangePassword: false,
  },
  {
    email: 'marie-josee@my-mission-control.com',
    firstName: 'Marie-Josée',
    password: 'm1979',
    role: 'MEMBER',
    profile: 'ADULT',
    mustChangePassword: false,
  },
  {
    email: 'alizee@my-mission-control.com',
    firstName: 'Alizée',
    password: 'a2013',
    role: 'MEMBER',
    profile: 'CHILD',
    mustChangePassword: false,
  },
  {
    email: 'jackson@my-mission-control.com',
    firstName: 'Jackson',
    password: 'j2015',
    role: 'MEMBER',
    profile: 'CHILD',
    mustChangePassword: false,
  },
];

const APPS = [
  {
    slug: 'maison',
    name: 'Contrôle Maison',
    description: 'Dashboard Hubitat — température, éclairage, sécurité.',
    icon: 'house',
    color: '#3B82F6',
    isMockup: false, // App vivante : redirige vers /apps/maison
  },
  {
    slug: 'chalet',
    name: 'Contrôle Chalet',
    description: 'Dashboard Hubitat du chalet — préchauffe avant d\'arriver.',
    icon: 'mountain-sun',
    color: '#F59E0B',
    isMockup: false, // App vivante : redirige vers /apps/chalet
  },
  {
    slug: 'assistant',
    name: 'Assistant IA',
    description: 'Assistant personnel propulsé par l\'IA.',
    icon: 'robot',
    color: '#8B5CF6',
    isMockup: true,
  },
  {
    slug: 'educatif',
    name: 'Éducatif',
    description: 'Code Cadet · Minecraft Protocol — prépare-toi au camp.',
    icon: 'graduation-cap',
    color: '#10B981',
    isMockup: false, // App vivante : redirige vers /apps/educatif
  },
];

async function main() {
  console.log('🌱 Seed démarré...');

  // 1. Users
  const createdUsers = {};
  for (const u of FAMILY) {
    const hashed = await bcrypt.hash(u.password, 12);
    const user = await prisma.user.upsert({
      where: { email: u.email },
      update: {
        firstName: u.firstName,
        role: u.role,
        profile: u.profile,
        password: hashed,
        mustChangePassword: u.mustChangePassword,
      },
      create: {
        email: u.email,
        firstName: u.firstName,
        password: hashed,
        role: u.role,
        profile: u.profile,
        mustChangePassword: u.mustChangePassword,
      },
    });
    createdUsers[u.email] = user;
    console.log(`✓ User: ${user.email} (${user.role})`);
  }

  // 2. Apps
  const createdApps = {};
  for (const a of APPS) {
    const app = await prisma.app.upsert({
      where: { slug: a.slug },
      update: {
        name: a.name,
        description: a.description,
        icon: a.icon,
        color: a.color,
        isMockup: a.isMockup,
      },
      create: a,
    });
    createdApps[a.slug] = app;
    console.log(`✓ App : ${app.name}`);
  }

  // 3. Accès par défaut
  // Martin : accès à tout
  for (const app of Object.values(createdApps)) {
    await prisma.userApp.upsert({
      where: { userId_appId: { userId: createdUsers['martin@logifox.io'].id, appId: app.id } },
      update: { hasAccess: true },
      create: { userId: createdUsers['martin@logifox.io'].id, appId: app.id, hasAccess: true },
    });
  }

  // Maison + Chalet : Martin + Marie-Josée (parents seulement)
  for (const slug of ['maison', 'chalet']) {
    const app = createdApps[slug];
    if (!app) continue;
    await prisma.userApp.upsert({
      where: { userId_appId: { userId: createdUsers['marie-josee@my-mission-control.com'].id, appId: app.id } },
      update: { hasAccess: true },
      create: { userId: createdUsers['marie-josee@my-mission-control.com'].id, appId: app.id, hasAccess: true },
    });
  }

  // Éducatif : enfants uniquement (pas Marie-Josée — app dédiée aux kids)
  const educatif = createdApps['educatif'];
  for (const email of ['alizee@my-mission-control.com', 'jackson@my-mission-control.com']) {
    await prisma.userApp.upsert({
      where: { userId_appId: { userId: createdUsers[email].id, appId: educatif.id } },
      update: { hasAccess: true },
      create: { userId: createdUsers[email].id, appId: educatif.id, hasAccess: true },
    });
  }

  // 4. Éducatif — Module Code Cadet + missions
  console.log('📚 Seed éducatif : module Code Cadet...');
  const modPayload = codeCadet.module;
  const mod = await prisma.module.upsert({
    where: { slug: modPayload.slug },
    update: {
      title: modPayload.title,
      subtitle: modPayload.subtitle,
      description: modPayload.description,
      coverColor: modPayload.coverColor,
      coverIcon: modPayload.coverIcon,
      version: modPayload.version,
      language: modPayload.language,
      avatarKey: modPayload.avatarKey,
      order: modPayload.order,
      status: modPayload.status,
    },
    create: {
      slug: modPayload.slug,
      title: modPayload.title,
      subtitle: modPayload.subtitle,
      description: modPayload.description,
      coverColor: modPayload.coverColor,
      coverIcon: modPayload.coverIcon,
      version: modPayload.version,
      language: modPayload.language,
      avatarKey: modPayload.avatarKey,
      order: modPayload.order,
      status: modPayload.status,
    },
  });
  console.log(`✓ Module : ${mod.title} (v${mod.version})`);

  // 4.1 Nettoyage : supprime les lessons dont le slug n'existe plus dans le nouveau content.
  //     (cascade delete sur Progress grâce au schema.prisma).
  const newSlugs = codeCadet.lessons.map((l) => l.slug);
  const obsolete = await prisma.lesson.findMany({
    where: { moduleId: mod.id, slug: { notIn: newSlugs } },
    select: { id: true, slug: true },
  });
  if (obsolete.length > 0) {
    console.log(`🧹 Missions obsolètes à nettoyer : ${obsolete.map((o) => o.slug).join(', ')}`);
    const del = await prisma.lesson.deleteMany({
      where: { moduleId: mod.id, slug: { notIn: newSlugs } },
    });
    console.log(`✓ ${del.count} missions supprimées (+ progressions associées en cascade)`);
  } else {
    console.log('✓ Aucune mission obsolète à nettoyer.');
  }

  // 4.2 Upsert des lessons du nouveau curriculum.
  let missionsCreated = 0;
  let missionsUpdated = 0;
  for (const l of codeCadet.lessons) {
    const existing = await prisma.lesson.findUnique({
      where: { moduleId_slug: { moduleId: mod.id, slug: l.slug } },
    });
    const data = {
      chapter: l.chapter,
      order: l.order,
      kind: l.kind,
      title: l.title,
      subtitle: l.subtitle,
      conceptKey: l.conceptKey,
      data: l.data,
    };
    if (existing) {
      await prisma.lesson.update({ where: { id: existing.id }, data });
      missionsUpdated += 1;
    } else {
      await prisma.lesson.create({ data: { moduleId: mod.id, slug: l.slug, ...data } });
      missionsCreated += 1;
    }
  }
  console.log(`✓ Missions : ${missionsCreated} créées, ${missionsUpdated} mises à jour (total ${codeCadet.lessons.length})`);

  // 5. Accès module : Jackson + Alizée (pas Marie-Josée — enfants seulement)
  for (const email of ['jackson@my-mission-control.com', 'alizee@my-mission-control.com']) {
    await prisma.moduleAccess.upsert({
      where: { userId_moduleId: { userId: createdUsers[email].id, moduleId: mod.id } },
      update: { hasAccess: true },
      create: { userId: createdUsers[email].id, moduleId: mod.id, hasAccess: true },
    });
  }
  // Martin aussi (admin, pour voir le contenu)
  await prisma.moduleAccess.upsert({
    where: { userId_moduleId: { userId: createdUsers['martin@logifox.io'].id, moduleId: mod.id } },
    update: { hasAccess: true },
    create: { userId: createdUsers['martin@logifox.io'].id, moduleId: mod.id, hasAccess: true },
  });
  console.log('✓ Accès module assignés (Jackson + Alizée + Martin)');

  console.log('✅ Seed terminé.');
}

main()
  .catch((e) => {
    console.error('❌ Erreur seed :', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
