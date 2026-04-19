// Seed initial — comptes famille + apps mockup. SCRAP Code Cadet (v3.0.0).
// MCreator Academy = static frontend route, plus de seed Module/Lesson backend nécessaire.
// Idempotent (upsert) + nettoyage explicite Code Cadet pour faire disparaitre l'ancien module.
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');

const prisma = new PrismaClient();

const FAMILY = [
  {
    email: 'martin@logifox.io',
    username: null, // admin login par email
    firstName: 'Martin',
    password: 'Mm7632362$',
    role: 'ADMIN',
    profile: 'ADULT',
    mustChangePassword: false,
  },
  {
    email: 'marie-josee@my-mission-control.com',
    username: 'MJ',
    firstName: 'Marie-Josée',
    password: 'm1979',
    role: 'MEMBER',
    profile: 'ADULT',
    mustChangePassword: false,
  },
  {
    email: 'alizee@my-mission-control.com',
    username: 'Ali',
    firstName: 'Alizée',
    password: 'a2013',
    role: 'MEMBER',
    profile: 'CHILD',
    mustChangePassword: false,
  },
  {
    email: 'jackson@my-mission-control.com',
    username: 'Jax',
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
    isMockup: false,
  },
  {
    slug: 'chalet',
    name: 'Contrôle Chalet',
    description: 'Dashboard Hubitat du chalet — préchauffe avant d\'arriver.',
    icon: 'mountain-sun',
    color: '#F59E0B',
    isMockup: false,
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
    description: "Coder, créer, apprendre — le coin d'apprentissage.",
    icon: 'graduation-cap',
    color: '#10B981',
    isMockup: false,
  },
];

async function main() {
  console.log('🌱 Seed démarré (v3.0.0 — sans Code Cadet)...');

  // 0. CLEANUP : SCRAP Code Cadet une fois pour toute.
  //    Cascade kills lessons + progress grâce au schema.prisma.
  try {
    const cc = await prisma.module.findUnique({ where: { slug: 'code-cadet' } });
    if (cc) {
      console.log('🧹 Suppression du module Code Cadet (legacy)…');
      // ModuleAccess + Progress doivent être nettoyés manuellement si pas en cascade
      await prisma.moduleAccess.deleteMany({ where: { moduleId: cc.id } }).catch(() => {});
      await prisma.lesson.deleteMany({ where: { moduleId: cc.id } }).catch(() => {});
      await prisma.module.delete({ where: { id: cc.id } });
      console.log('✓ Code Cadet scrapé.');
    } else {
      console.log('✓ Code Cadet déjà absent.');
    }
  } catch (e) {
    console.warn('⚠ Cleanup Code Cadet :', e.message);
  }

  // 1. Users
  const createdUsers = {};
  for (const u of FAMILY) {
    const hashed = await bcrypt.hash(u.password, 12);
    const user = await prisma.user.upsert({
      where: { email: u.email },
      update: {
        // NOTE: on NE remplace PAS password ni mustChangePassword à chaque deploy —
        // l'admin a le contrôle total sur les mdp. Le seed ne fait que créer initialement.
        username: u.username ?? null,
        firstName: u.firstName,
        role: u.role,
        profile: u.profile,
      },
      create: {
        email: u.email,
        username: u.username ?? null,
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

  // Maison + Chalet : Martin + Marie-Josée (parents)
  for (const slug of ['maison', 'chalet']) {
    const app = createdApps[slug];
    if (!app) continue;
    await prisma.userApp.upsert({
      where: { userId_appId: { userId: createdUsers['marie-josee@my-mission-control.com'].id, appId: app.id } },
      update: { hasAccess: true },
      create: { userId: createdUsers['marie-josee@my-mission-control.com'].id, appId: app.id, hasAccess: true },
    });
  }

  // Éducatif : enfants uniquement (pas Marie-Josée)
  const educatif = createdApps['educatif'];
  for (const email of ['alizee@my-mission-control.com', 'jackson@my-mission-control.com']) {
    await prisma.userApp.upsert({
      where: { userId_appId: { userId: createdUsers[email].id, appId: educatif.id } },
      update: { hasAccess: true },
      create: { userId: createdUsers[email].id, appId: educatif.id, hasAccess: true },
    });
  }

  console.log('✅ Seed terminé. Aucun module backend — MCreator Academy est full-frontend.');
}

main()
  .catch((e) => {
    console.error('❌ Erreur seed :', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
