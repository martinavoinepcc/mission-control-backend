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
  // ───── Famille ─────
  {
    slug: 'maison',
    name: 'Contrôle Maison',
    description: 'Dashboard Hubitat — température, éclairage, sécurité.',
    icon: 'house',
    color: '#3B82F6',
    isMockup: false,
    realm: 'FAMILY',
  },
  {
    slug: 'chalet',
    name: 'Contrôle Chalet',
    description: 'Dashboard Hubitat du chalet — préchauffe avant d\'arriver.',
    icon: 'mountain-sun',
    color: '#F59E0B',
    isMockup: false,
    realm: 'FAMILY',
  },
  {
    slug: 'assistant',
    name: 'Assistant IA',
    description: 'Assistant personnel propulsé par l\'IA.',
    icon: 'robot',
    color: '#8B5CF6',
    isMockup: true,
    realm: 'FAMILY',
  },
  {
    slug: 'educatif',
    name: 'Éducatif',
    description: "Coder, créer, apprendre — le coin d'apprentissage.",
    icon: 'graduation-cap',
    color: '#10B981',
    isMockup: false,
    realm: 'FAMILY',
  },
  // ───── Impro (Alizée + admin) ─────
  {
    slug: 'improv',
    name: 'Impro Engine',
    description: 'Pratique + match d\'improvisation théâtrale — LNI style.',
    icon: 'masks-theater',
    color: '#DC2626',
    isMockup: false,
    realm: 'FAMILY',
  },
  // ───── Travail (admin uniquement) ─────
  {
    slug: 'logifox',
    name: 'Logifox',
    description: 'Espace de travail Logifox — bientôt.',
    icon: 'briefcase',
    color: '#64748B',
    isMockup: true,
    realm: 'WORK',
  },
  {
    slug: 'qscale',
    name: 'QScale',
    description: 'Projet QScale — bientôt.',
    icon: 'chart-line',
    color: '#0EA5E9',
    isMockup: true,
    realm: 'WORK',
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
        realm: a.realm,
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

  // Impro Engine : Alizée uniquement (Martin l'a via la loop admin)
  const improv = createdApps['improv'];
  if (improv) {
    await prisma.userApp.upsert({
      where: { userId_appId: { userId: createdUsers['alizee@my-mission-control.com'].id, appId: improv.id } },
      update: { hasAccess: true },
      create: { userId: createdUsers['alizee@my-mission-control.com'].id, appId: improv.id, hasAccess: true },
    });
  }

  // Impro Engine — seed catégories + thèmes + contraintes LNI-style (idempotent)
  await seedImprov(prisma);

  console.log('✅ Seed terminé. Aucun module backend — MCreator Academy est full-frontend.');
}

// ============ IMPRO ENGINE SEED ============

const IMPROV_CATEGORIES = [
  { slug: 'mixte-libre',     name: 'Mixte libre',       shortDescription: 'Les deux équipes improvisent ensemble, librement.',       allowedNatures: ['MIXTE'],              defaultDurationSec: 180, defaultCaucusSec: 20, difficulty: 'EASY',   tags: ['classique'] },
  { slug: 'comparee-libre',  name: 'Comparée libre',    shortDescription: 'Chaque équipe présente sa version, puis vote.',            allowedNatures: ['COMPAREE'],           defaultDurationSec: 120, defaultCaucusSec: 20, difficulty: 'EASY',   tags: ['classique'], practiceCompatible: false },
  { slug: 'chantee',         name: 'Chantée',           shortDescription: 'Tout le dialogue doit être chanté.',                       allowedNatures: ['MIXTE','COMPAREE'],   defaultDurationSec: 120, defaultCaucusSec: 25, difficulty: 'MEDIUM', tags: ['musicale','style'] },
  { slug: 'rimee',           name: 'Rimée',             shortDescription: 'Chaque réplique doit rimer avec la précédente.',           allowedNatures: ['MIXTE','COMPAREE'],   defaultDurationSec: 180, defaultCaucusSec: 25, difficulty: 'MEDIUM', tags: ['style'] },
  { slug: 'sans-paroles',    name: 'Sans paroles',      shortDescription: 'Aucune parole. Tout passe par le corps et les sons.',      allowedNatures: ['MIXTE','COMPAREE'],   defaultDurationSec: 120, defaultCaucusSec: 20, difficulty: 'MEDIUM', tags: ['physique'] },
  { slug: 'silencieuse',     name: 'Silencieuse',       shortDescription: 'Aucun son du tout. Mime complet.',                         allowedNatures: ['MIXTE','COMPAREE'],   defaultDurationSec: 120, defaultCaucusSec: 20, difficulty: 'HARD',   tags: ['physique'] },
  { slug: 'doublee',         name: 'Doublée',           shortDescription: 'Deux joueurs bougent, deux autres parlent (voix off).',    allowedNatures: ['MIXTE','COMPAREE'],   defaultDurationSec: 150, defaultCaucusSec: 25, difficulty: 'HARD',   tags: ['coordination'], minPlayers: 4 },
  { slug: 'un-seul-mot',     name: 'À un seul mot',     shortDescription: 'Chaque joueur ne dit qu\'un seul mot à la fois.',           allowedNatures: ['MIXTE','COMPAREE'],   defaultDurationSec: 150, defaultCaucusSec: 25, difficulty: 'HARD',   tags: ['style'] },
  { slug: 'a-rebours',       name: 'À rebours',         shortDescription: 'La scène commence par la fin et se joue à l\'envers.',      allowedNatures: ['MIXTE','COMPAREE'],   defaultDurationSec: 180, defaultCaucusSec: 30, difficulty: 'HARD',   tags: ['structurel'] },
  { slug: 'rappee',          name: 'Rappée',            shortDescription: 'Tout le dialogue doit être rappé en rythme.',              allowedNatures: ['MIXTE','COMPAREE'],   defaultDurationSec: 120, defaultCaucusSec: 25, difficulty: 'MEDIUM', tags: ['musicale','style'] },
  { slug: 'mimee',           name: 'Mimée',             shortDescription: 'Version mime pure, sans accessoires ni parole.',           allowedNatures: ['MIXTE','COMPAREE'],   defaultDurationSec: 120, defaultCaucusSec: 20, difficulty: 'MEDIUM', tags: ['physique'] },
  { slug: 'commentee',       name: 'Commentée',         shortDescription: 'Un narrateur commente pendant que l\'équipe joue.',         allowedNatures: ['MIXTE'],              defaultDurationSec: 180, defaultCaucusSec: 20, difficulty: 'MEDIUM', tags: ['narratif'], minPlayers: 2 },
  { slug: 'defi',            name: 'Défi',              shortDescription: 'L\'autre équipe lance un défi à respecter pendant la scène.', allowedNatures: ['MIXTE','COMPAREE'], defaultDurationSec: 150, defaultCaucusSec: 15, difficulty: 'MEDIUM', tags: ['challenge'] },
  { slug: 'avec-accent',     name: 'Avec accent',       shortDescription: 'Tous les joueurs adoptent un accent régional imposé.',     allowedNatures: ['MIXTE','COMPAREE'],   defaultDurationSec: 150, defaultCaucusSec: 20, difficulty: 'MEDIUM', tags: ['style'] },
  { slug: 'tout-terrain',    name: 'Tout-terrain',      shortDescription: 'Catégorie libre, tout est permis.',                        allowedNatures: ['MIXTE','COMPAREE'],   defaultDurationSec: 180, defaultCaucusSec: 20, difficulty: 'EASY',   tags: ['libre'] },
];

const IMPROV_THEMES = [
  { slug: 'premier-rendez-vous',       name: 'Premier rendez-vous',                difficulty: 'EASY',   tags: ['classique'] },
  { slug: 'panne-electricite',         name: 'Panne d\'électricité',                 difficulty: 'EASY',   tags: ['quotidien'] },
  { slug: 'match-hockey',              name: 'Match de hockey',                    difficulty: 'EASY',   tags: ['quebec','sport'] },
  { slug: 'epicerie-dimanche',         name: 'Épicerie du dimanche',               difficulty: 'EASY',   tags: ['quotidien'] },
  { slug: 'cauchemar-enfant',          name: 'Cauchemar d\'enfant',                 difficulty: 'MEDIUM', tags: ['onirique'] },
  { slug: 'voyage-dans-le-temps',      name: 'Voyage dans le temps',               difficulty: 'HARD',   tags: ['fantastique'] },
  { slug: 'grand-maman-mots-croises',  name: 'Grand-maman qui fait ses mots croisés', difficulty: 'EASY', tags: ['quotidien'] },
  { slug: 'reunion-famille',           name: 'Réunion de famille',                 difficulty: 'EASY',   tags: ['quotidien'] },
  { slug: 'chez-le-dentiste',          name: 'Chez le dentiste',                   difficulty: 'EASY',   tags: ['quotidien'] },
  { slug: 'perdu-en-foret',            name: 'Perdu dans la forêt',                difficulty: 'MEDIUM', tags: ['aventure'] },
  { slug: 'audition-star-academie',    name: 'Audition de Star Académie',          difficulty: 'MEDIUM', tags: ['quebec','showbiz'] },
  { slug: 'tempete-neige',             name: 'Tempête de neige',                   difficulty: 'MEDIUM', tags: ['quebec','meteo'] },
  { slug: 'prehistoire',               name: 'Préhistoire',                        difficulty: 'MEDIUM', tags: ['historique'] },
  { slug: 'voyage-autobus',            name: 'Voyage en autobus',                  difficulty: 'EASY',   tags: ['quotidien'] },
  { slug: 'camping-sauvage',           name: 'Camping sauvage',                    difficulty: 'MEDIUM', tags: ['nature'] },
  { slug: 'telephone-sonne',           name: 'Le téléphone sonne',                 difficulty: 'EASY',   tags: ['quotidien'] },
  { slug: 'pire-cafe-du-monde',        name: 'Le pire café du monde',              difficulty: 'MEDIUM', tags: ['absurde'] },
  { slug: 'extraterrestre',            name: 'Rencontre avec un extraterrestre',   difficulty: 'HARD',   tags: ['fantastique'] },
  { slug: 'examen-maths',              name: 'Examen de mathématiques',            difficulty: 'EASY',   tags: ['ecole'] },
  { slug: 'demenagement',              name: 'Déménagement',                       difficulty: 'EASY',   tags: ['quotidien'] },
  { slug: 'urgence-hopital',           name: 'Attente à l\'urgence',                difficulty: 'MEDIUM', tags: ['quotidien'] },
  { slug: 'match-curling',             name: 'Match de curling',                   difficulty: 'MEDIUM', tags: ['quebec','sport'] },
  { slug: 'chantier-construction',     name: 'Chantier de construction',           difficulty: 'MEDIUM', tags: ['metier'] },
  { slug: 'visite-zoo',                name: 'Visite au zoo',                      difficulty: 'EASY',   tags: ['sortie'] },
  { slug: 'tribunal',                  name: 'Au tribunal',                        difficulty: 'HARD',   tags: ['serieux'] },
  { slug: 'devoirs-ecole',             name: 'Devoirs de l\'école',                 difficulty: 'EASY',   tags: ['ecole'] },
  { slug: 'chasse-bonbons',            name: 'Chasse aux bonbons à l\'Halloween',    difficulty: 'EASY',   tags: ['fete','quebec'] },
  { slug: 'veille-noel',               name: 'La veille de Noël',                  difficulty: 'MEDIUM', tags: ['fete'] },
  { slug: 'visite-musee',              name: 'Visite au musée',                    difficulty: 'MEDIUM', tags: ['sortie'] },
  { slug: 'spectacle-fin-annee',       name: 'Spectacle de fin d\'année',           difficulty: 'MEDIUM', tags: ['ecole'] },
  { slug: 'cabane-a-sucre',            name: 'Cabane à sucre',                     difficulty: 'EASY',   tags: ['quebec','fete'] },
  { slug: 'premiere-neige',            name: 'La première neige',                  difficulty: 'EASY',   tags: ['quebec','meteo'] },
];

const IMPROV_CONSTRAINTS = [
  { slug: 'sans-se-toucher',     name: 'Sans jamais se toucher',      description: 'Les joueurs ne peuvent pas entrer en contact physique.',  difficulty: 'MEDIUM' },
  { slug: 'en-chantant',         name: 'En chantant chaque mot',       description: 'Chaque réplique doit être chantée, même les plus banales.', difficulty: 'HARD' },
  { slug: 'sans-regarder',       name: 'Sans regarder l\'autre',       description: 'Les joueurs ne peuvent pas se regarder dans les yeux.',   difficulty: 'MEDIUM' },
  { slug: 'en-rimes',            name: 'En rimes',                     description: 'Chaque réplique doit rimer avec la précédente.',          difficulty: 'HARD' },
  { slug: 'yeux-fermes',         name: 'Les yeux fermés',              description: 'Tous les joueurs gardent les yeux fermés.',               difficulty: 'HARD' },
  { slug: 'en-chuchotant',       name: 'En chuchotant',                description: 'Impossible de parler fort.',                              difficulty: 'EASY' },
  { slug: 'gibberish',           name: 'En gibberish',                 description: 'Sons inventés uniquement — pas de mots réels.',           difficulty: 'HARD' },
  { slug: 'un-mot-en-anglais',   name: 'Avec un mot en anglais à chaque réplique', description: 'Chaque phrase contient au moins un mot anglais.', difficulty: 'MEDIUM' },
  { slug: 'un-joueur-a-la-fois', name: 'Un seul joueur bouge à la fois', description: 'Les autres restent figés.',                              difficulty: 'MEDIUM' },
  { slug: 'repliques-courtes',   name: 'Répliques de 3 mots max',      description: 'Jamais plus de 3 mots à la fois.',                        difficulty: 'HARD' },
];

async function seedImprov(prisma) {
  console.log('🎭 Seed Impro Engine...');
  for (const c of IMPROV_CATEGORIES) {
    await prisma.improvCategory.upsert({
      where: { slug: c.slug },
      update: {
        name: c.name,
        shortDescription: c.shortDescription,
        allowedNatures: c.allowedNatures,
        minPlayers: c.minPlayers ?? 1,
        maxPlayers: c.maxPlayers ?? 6,
        defaultDurationSec: c.defaultDurationSec ?? 180,
        defaultCaucusSec: c.defaultCaucusSec ?? 20,
        difficulty: c.difficulty ?? 'MEDIUM',
        practiceCompatible: c.practiceCompatible ?? true,
        gameCompatible: c.gameCompatible ?? true,
        tags: c.tags ?? [],
      },
      create: {
        slug: c.slug,
        name: c.name,
        shortDescription: c.shortDescription,
        allowedNatures: c.allowedNatures,
        minPlayers: c.minPlayers ?? 1,
        maxPlayers: c.maxPlayers ?? 6,
        defaultDurationSec: c.defaultDurationSec ?? 180,
        defaultCaucusSec: c.defaultCaucusSec ?? 20,
        difficulty: c.difficulty ?? 'MEDIUM',
        practiceCompatible: c.practiceCompatible ?? true,
        gameCompatible: c.gameCompatible ?? true,
        tags: c.tags ?? [],
      },
    });
  }
  for (const t of IMPROV_THEMES) {
    await prisma.improvTheme.upsert({
      where: { slug: t.slug },
      update: { name: t.name, difficulty: t.difficulty, tags: t.tags ?? [] },
      create: { slug: t.slug, name: t.name, difficulty: t.difficulty, tags: t.tags ?? [] },
    });
  }
  for (const k of IMPROV_CONSTRAINTS) {
    await prisma.improvConstraint.upsert({
      where: { slug: k.slug },
      update: { name: k.name, description: k.description, difficulty: k.difficulty },
      create: { slug: k.slug, name: k.name, description: k.description, difficulty: k.difficulty },
    });
  }
  console.log(`✓ Impro: ${IMPROV_CATEGORIES.length} cat + ${IMPROV_THEMES.length} thèmes + ${IMPROV_CONSTRAINTS.length} contraintes`);
}

main()
  .catch((e) => {
    console.error('❌ Erreur seed :', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
