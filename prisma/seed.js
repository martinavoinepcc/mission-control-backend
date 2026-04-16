// Seed initial — crée les 4 comptes famille et les 3 apps mockup.
// Idempotent : peut être relancé sans doublons grâce aux upsert.
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');

const prisma = new PrismaClient();

const FAMILY = [
  {
    email: 'martin@logifox.io',
    firstName: 'Martin',
    password: 'Mm7632362$',
    role: 'ADMIN',
    profile: 'ADULT',
    mustChangePassword: false,
  },
  {
    email: 'marie-josee@my-mission-control.com',
    firstName: 'Marie-Josée',
    password: 'MissionControl2024!',
    role: 'MEMBER',
    profile: 'ADULT',
    mustChangePassword: true,
  },
  {
    email: 'alizee@my-mission-control.com',
    firstName: 'Alizée',
    password: 'MissionControl2024!',
    role: 'MEMBER',
    profile: 'CHILD',
    mustChangePassword: true,
  },
  {
    email: 'jackson@my-mission-control.com',
    firstName: 'Jackson',
    password: 'MissionControl2024!',
    role: 'MEMBER',
    profile: 'CHILD',
    mustChangePassword: true,
  },
];

const APPS = [
  {
    slug: 'maison',
    name: 'Maison Intelligente',
    description: 'Contrôle et suivi de la maison connectée.',
    icon: '🏠',
    color: '#3B82F6',
    isMockup: true,
  },
  {
    slug: 'assistant',
    name: 'Assistant IA',
    description: 'Assistant personnel propulsé par l\'IA.',
    icon: '🤖',
    color: '#8B5CF6',
    isMockup: true,
  },
  {
    slug: 'educatif',
    name: 'Éducatif',
    description: 'Programmes éducatifs pour enfants.',
    icon: '📚',
    color: '#10B981',
    isMockup: true,
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
        // on ne ré-hash le mot de passe que si inexistant à la 1re seed
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

  // Les 3 autres : accès à Éducatif seulement
  const educatif = createdApps['educatif'];
  for (const email of ['marie-josee@my-mission-control.com', 'alizee@my-mission-control.com', 'jackson@my-mission-control.com']) {
    await prisma.userApp.upsert({
      where: { userId_appId: { userId: createdUsers[email].id, appId: educatif.id } },
      update: { hasAccess: true },
      create: { userId: createdUsers[email].id, appId: educatif.id, hasAccess: true },
    });
  }

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
