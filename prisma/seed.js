// Seed initial — crée les 4 comptes famille et les 3 apps mockup.
// Idempotent : peut être relancé sans doublons grâce aux upsert.
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');

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
    name: 'Maison Intelligente',
    description: 'Contrôle et suivi de la maison connectée.',
    icon: 'house',
    color: '#3B82F6',
    isMockup: true,
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
    description: 'Programmes éducatifs pour enfants.',
    icon: 'graduation-cap',
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

  // Éducatif : enfants uniquement (pas Marie-Josée — app dédiée aux kids)
  const educatif = createdApps['educatif'];
  for (const email of ['alizee@my-mission-control.com', 'jackson@my-mission-control.com']) {
    await prisma.userApp.upsert({
      where: { userId_appId: { userId: createdUsers[email].id, appId: educatif.id } },
      update: { hasAccess: true },
      create: { userId: createdUsers[email].id, appId: educatif.id, hasAccess: true },
    });
  }

  console.log('✅ Seed terminé.');
}

main()
