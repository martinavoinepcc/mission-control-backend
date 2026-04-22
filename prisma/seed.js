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
    color: '#6366F1',
    isMockup: true,
    realm: 'FAMILY',
  },
  {
    slug: 'educatif',
    name: 'Éducatif',
    description: "Coder, créer, apprendre — le coin d'apprentissage.",
    icon: 'graduation-cap',
    color: '#14B8A6',
    isMockup: false,
    realm: 'FAMILY',
  },
  {
    slug: 'messagerie',
    name: 'Messagerie',
    description: 'Fil de discussion familial avec notifications push.',
    icon: 'comments',
    color: '#06B6D4',
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
    description: 'OPSEC Mission Control — plateforme sécurité privée.',
    icon: 'chart-line',
    color: '#0EA5E9',
    isMockup: false,
    realm: 'WORK',
    url: 'https://qscale-opsec.onrender.com',
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
        url: a.url ?? null,
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

  // Messagerie : tous les membres famille (les 4)
  const messagerie = createdApps['messagerie'];
  if (messagerie) {
    for (const email of [
      'marie-josee@my-mission-control.com',
      'alizee@my-mission-control.com',
      'jackson@my-mission-control.com',
    ]) {
      await prisma.userApp.upsert({
        where: { userId_appId: { userId: createdUsers[email].id, appId: messagerie.id } },
        update: { hasAccess: true },
        create: { userId: createdUsers[email].id, appId: messagerie.id, hasAccess: true },
      });
    }
  }

  // Impro Engine vit sous /apps/educatif/impro/ — accès implicite via l'app Éducatif.
  // Seed catégories/thèmes/contraintes LNI (idempotent).
  await seedImprov(prisma);

  // Convo seed "Famille" avec les 4 membres + un welcome message de Martin
  await seedFamilyConversation(prisma, createdUsers);

  console.log('✅ Seed terminé. Aucun module backend — MCreator Academy est full-frontend.');
}

// ============ MESSAGERIE SEED ============

async function seedFamilyConversation(prisma, createdUsers) {
  const famille = await prisma.conversation.upsert({
    where: { slug: 'famille' },
    update: { title: 'Famille' },
    create: {
      slug: 'famille',
      title: 'Famille',
      createdById: createdUsers['martin@logifox.io'].id,
      lastMessageAt: new Date(),
    },
  });

  const emails = [
    'martin@logifox.io',
    'marie-josee@my-mission-control.com',
    'alizee@my-mission-control.com',
    'jackson@my-mission-control.com',
  ];

  for (const email of emails) {
    const u = createdUsers[email];
    if (!u) continue;
    await prisma.conversationParticipant.upsert({
      where: { conversationId_userId: { conversationId: famille.id, userId: u.id } },
      update: {},
      create: { conversationId: famille.id, userId: u.id },
    });
  }

  // Welcome message — créé seulement si la convo est vide (pas d'override des vrais messages)
  const count = await prisma.message.count({ where: { conversationId: famille.id } });
  if (count === 0) {
    const welcome = await prisma.message.create({
      data: {
        conversationId: famille.id,
        authorId: createdUsers['martin@logifox.io'].id,
        body:
          'Bienvenue dans la messagerie familiale 💬 ' +
          "Écrivez-vous ici — les notifications arriveront directement sur vos téléphones.",
      },
    });
    await prisma.conversation.update({
      where: { id: famille.id },
      data: { lastMessageAt: welcome.createdAt },
    });
  }
  console.log('✓ Convo Famille seedée (4 participants)');
}

// ============ IMPRO ENGINE SEED ============

const IMPROV_CATEGORIES = [
  // ── Natures de base ──
  { slug: 'mixte-libre',     name: 'Mixte libre',       shortDescription: 'Les deux équipes improvisent ensemble, librement.',           allowedNatures: ['MIXTE'],            defaultDurationSec: 180, defaultCaucusSec: 20, difficulty: 'EASY',   tags: ['classique'] },
  { slug: 'comparee-libre',  name: 'Comparée libre',    shortDescription: 'Chaque équipe présente sa version, puis vote.',                allowedNatures: ['COMPAREE'],         defaultDurationSec: 120, defaultCaucusSec: 20, difficulty: 'EASY',   tags: ['classique'], practiceCompatible: false },
  // ── Styles musicaux / rythmés ──
  { slug: 'chantee',         name: 'Chantée',           shortDescription: 'Tout le dialogue doit être chanté.',                           allowedNatures: ['MIXTE','COMPAREE'], defaultDurationSec: 120, defaultCaucusSec: 25, difficulty: 'MEDIUM', tags: ['musicale','style'] },
  { slug: 'rimee',           name: 'Rimée',             shortDescription: 'Chaque réplique doit rimer avec la précédente.',               allowedNatures: ['MIXTE','COMPAREE'], defaultDurationSec: 180, defaultCaucusSec: 25, difficulty: 'MEDIUM', tags: ['style'] },
  { slug: 'rappee',          name: 'Rappée',            shortDescription: 'Tout le dialogue doit être rappé en rythme.',                  allowedNatures: ['MIXTE','COMPAREE'], defaultDurationSec: 120, defaultCaucusSec: 25, difficulty: 'MEDIUM', tags: ['musicale','style'] },
  { slug: 'comedie-musicale', name: 'Comédie musicale', shortDescription: 'La scène est présentée à la Broadway, chants et chorégraphies.', allowedNatures: ['MIXTE','COMPAREE'], defaultDurationSec: 180, defaultCaucusSec: 30, difficulty: 'HARD',   tags: ['musicale','genre'] },
  { slug: 'poetique',        name: 'Poétique',          shortDescription: 'Registre lyrique, images et métaphores obligées.',             allowedNatures: ['MIXTE','COMPAREE'], defaultDurationSec: 150, defaultCaucusSec: 25, difficulty: 'MEDIUM', tags: ['style'] },
  // ── Parole limitée ──
  { slug: 'sans-paroles',    name: 'Sans paroles',      shortDescription: 'Aucune parole. Sons et mouvement uniquement.',                 allowedNatures: ['MIXTE','COMPAREE'], defaultDurationSec: 120, defaultCaucusSec: 20, difficulty: 'MEDIUM', tags: ['physique'] },
  { slug: 'silencieuse',     name: 'Silencieuse',       shortDescription: 'Aucun son du tout. Mime pur.',                                 allowedNatures: ['MIXTE','COMPAREE'], defaultDurationSec: 120, defaultCaucusSec: 20, difficulty: 'HARD',   tags: ['physique'] },
  { slug: 'un-seul-mot',     name: 'À un seul mot',     shortDescription: 'Chaque joueur ne dit qu\'un mot à la fois.',                    allowedNatures: ['MIXTE','COMPAREE'], defaultDurationSec: 150, defaultCaucusSec: 25, difficulty: 'HARD',   tags: ['style'] },
  { slug: 'mimee',           name: 'Mimée',             shortDescription: 'Version mime avec sons permis, sans accessoires.',             allowedNatures: ['MIXTE','COMPAREE'], defaultDurationSec: 120, defaultCaucusSec: 20, difficulty: 'MEDIUM', tags: ['physique'] },
  // ── Coordination ──
  { slug: 'doublee',         name: 'Doublée',           shortDescription: 'Deux joueurs bougent, deux autres parlent en voix off.',       allowedNatures: ['MIXTE','COMPAREE'], defaultDurationSec: 150, defaultCaucusSec: 25, difficulty: 'HARD',   tags: ['coordination'], minPlayers: 4 },
  { slug: 'en-fusion',       name: 'En fusion',         shortDescription: 'Deux joueurs forment un seul personnage (mots alternés).',     allowedNatures: ['MIXTE','COMPAREE'], defaultDurationSec: 150, defaultCaucusSec: 25, difficulty: 'HARD',   tags: ['coordination'], minPlayers: 2 },
  // ── Structure ──
  { slug: 'a-rebours',       name: 'À rebours',         shortDescription: 'La scène commence par la fin et remonte.',                     allowedNatures: ['MIXTE','COMPAREE'], defaultDurationSec: 180, defaultCaucusSec: 30, difficulty: 'HARD',   tags: ['structurel'] },
  { slug: 'chronologique',   name: 'Chronologique',     shortDescription: 'La scène saute dans le temps à intervalles annoncés.',         allowedNatures: ['MIXTE','COMPAREE'], defaultDurationSec: 180, defaultCaucusSec: 25, difficulty: 'MEDIUM', tags: ['structurel'] },
  // ── Genres cinéma/radio ──
  { slug: 'film-noir',       name: 'Film noir',         shortDescription: 'Ambiance années 40, narration cynique, détective.',            allowedNatures: ['MIXTE','COMPAREE'], defaultDurationSec: 180, defaultCaucusSec: 25, difficulty: 'MEDIUM', tags: ['genre','cinema'] },
  { slug: 'film-muet',       name: 'Film muet',         shortDescription: 'Style cinéma muet, gestes exagérés, intertitres.',             allowedNatures: ['MIXTE','COMPAREE'], defaultDurationSec: 150, defaultCaucusSec: 25, difficulty: 'HARD',   tags: ['genre','cinema'] },
  { slug: 'film-horreur',    name: 'Film d\'horreur',     shortDescription: 'Tension, jump-scares, atmosphère angoissante.',                allowedNatures: ['MIXTE','COMPAREE'], defaultDurationSec: 150, defaultCaucusSec: 25, difficulty: 'MEDIUM', tags: ['genre','cinema'] },
  { slug: 'tele-serie',      name: 'Télé-série',        shortDescription: 'Épisode soap/drame québécois, cliffhanger à la fin.',          allowedNatures: ['MIXTE','COMPAREE'], defaultDurationSec: 180, defaultCaucusSec: 25, difficulty: 'MEDIUM', tags: ['genre','quebec'] },
  { slug: 'radiophonique',   name: 'Radiophonique',     shortDescription: 'Joué comme à la radio : dos au public, ambiance sonore.',      allowedNatures: ['MIXTE','COMPAREE'], defaultDurationSec: 150, defaultCaucusSec: 25, difficulty: 'MEDIUM', tags: ['genre','radio'] },
  { slug: 'conte-de-fees',   name: 'Conte de fées',     shortDescription: 'Style conte avec narrateur, princes, monstres.',               allowedNatures: ['MIXTE','COMPAREE'], defaultDurationSec: 180, defaultCaucusSec: 25, difficulty: 'MEDIUM', tags: ['genre','narratif'] },
  { slug: 'dramatique',      name: 'Dramatique',        shortDescription: 'Registre sérieux, émotions fortes, pas d\'humour.',             allowedNatures: ['MIXTE','COMPAREE'], defaultDurationSec: 180, defaultCaucusSec: 25, difficulty: 'HARD',   tags: ['registre'] },
  { slug: 'biographique',    name: 'Biographique',      shortDescription: 'Raconte un moment de vie d\'un personnage imposé.',              allowedNatures: ['MIXTE','COMPAREE'], defaultDurationSec: 180, defaultCaucusSec: 30, difficulty: 'MEDIUM', tags: ['narratif'] },
  // ── Narration / jeu ──
  { slug: 'commentee',       name: 'Commentée',         shortDescription: 'Un narrateur externe commente l\'action en direct.',            allowedNatures: ['MIXTE'],            defaultDurationSec: 180, defaultCaucusSec: 20, difficulty: 'MEDIUM', tags: ['narratif'], minPlayers: 2 },
  { slug: 'defi',            name: 'Défi',              shortDescription: 'L\'équipe adverse impose un défi pendant la scène.',             allowedNatures: ['MIXTE','COMPAREE'], defaultDurationSec: 150, defaultCaucusSec: 15, difficulty: 'MEDIUM', tags: ['challenge'] },
  // ── Accents / voix ──
  { slug: 'avec-accent',     name: 'Avec accent',       shortDescription: 'Accent régional imposé (québécois, marseillais, suisse, etc.).', allowedNatures: ['MIXTE','COMPAREE'], defaultDurationSec: 150, defaultCaucusSec: 20, difficulty: 'MEDIUM', tags: ['style','voix'] },
  { slug: 'avec-titre-impose', name: 'Avec titre imposé', shortDescription: 'Un titre de scène est donné et doit être honoré.',            allowedNatures: ['MIXTE','COMPAREE'], defaultDurationSec: 180, defaultCaucusSec: 25, difficulty: 'MEDIUM', tags: ['classique'] },
  // ── Facile / de repli ──
  // ── Nouvelles catégories v2 (avril 2026) — proposées par Alizée ──
  {
    slug: 'fusillade',         name: 'Fusillade',
    shortDescription: 'Impro courte et rapide, 45 sec à 1 min.',
    rulesDescription: 'Les deux équipes s\'affrontent dans des impros ultra-courtes de 45 secondes à 1 minute chacune. Pas de temps pour penser — rapidité, réflexes, enchaînement direct. Souvent plusieurs fusillades dans une même session pour tester l\'adaptabilité des équipes.',
    allowedNatures: ['MIXTE','COMPAREE'], minDurationSec: 45, maxDurationSec: 75, defaultDurationSec: 60, defaultCaucusSec: 10,
    difficulty: 'MEDIUM', tags: ['rapide','classique','v2']
  },
  {
    slug: 'zapping',           name: 'Zapping',
    shortDescription: 'Scènes qui changent rapidement au signal.',
    rulesDescription: 'Les joueurs improvisent une scène. Au signal du maître de jeu (cloche ou mot-clé), ils doivent CHANGER de scène instantanément. Ils peuvent revenir aux scènes précédentes plus tard — il faut se souvenir des personnages, lieux, intrigues laissés en suspens. Fluidité et mémoire obligatoires.',
    allowedNatures: ['MIXTE'], defaultDurationSec: 210, defaultCaucusSec: 25,
    difficulty: 'HARD', tags: ['rapide','meta','v2']
  },
  {
    slug: 'horoscope',         name: 'Horoscope',
    shortDescription: "Le maître de jeu lit un horoscope. La scène s'inspire du signe tiré.",
    rulesDescription: "Un signe du zodiaque est tiré au hasard et son horoscope du jour est lu aux joueurs (généré par l\'IA ou tiré de la banque). L\'impro doit s\'inspirer DIRECTEMENT de l\'horoscope : un trait de caractère évoqué, un événement prédit, un conseil donné. Tous les éléments doivent apparaître dans la scène.",
    allowedNatures: ['MIXTE','COMPAREE'], defaultDurationSec: 150, defaultCaucusSec: 30,
    difficulty: 'MEDIUM', tags: ['ai','inspiration','v2']
  },
  {
    slug: 'videoway',          name: 'Vidéoway',
    shortDescription: 'Quatre chaînes TV (F1-F4), le maître de jeu zappe.',
    rulesDescription: "Impro MIXTE à 4 canaux de télévision identifiés F1, F2, F3, F4, avec un contenu DIFFÉRENT pour chacun. Il faut un improvisateur de chaque troupe par canal. Le maître de jeu saute d\'un canal à l\'autre sans ordre prédéterminé. Quand il REVIENT sur un canal, les improvisateurs doivent faire l\'effort d\'AVANCER dans le temps comme si l\'on zappait en temps réel à la télé.",
    allowedNatures: ['MIXTE'], defaultDurationSec: 240, defaultCaucusSec: 40,
    minPlayers: 4, maxPlayers: 8, difficulty: 'HARD', tags: ['coordination','tv','v2']
  },
  {
    slug: 'abecedaire',        name: 'Abécédaire',
    shortDescription: 'Chaque mot suit l\'ordre alphabétique, un mot par joueur.',
    rulesDescription: "Trois personnes par équipe répondent à quelqu\'un qui pose des questions. Chaque joueur dit UN SEUL mot, et chaque mot doit commencer par la lettre alphabétique SUIVANTE. Exemple : « Au bar, Catherine devait enregistrer... » (A-B-C-D-E-...). Discipline, vocabulaire, patience.",
    allowedNatures: ['MIXTE','COMPAREE'], defaultDurationSec: 180, defaultCaucusSec: 20,
    minPlayers: 3, maxPlayers: 6, difficulty: 'HARD', tags: ['structure','vocabulaire','v2']
  },
  {
    slug: 'deja-vu',           name: 'Déjà vu',
    shortDescription: 'Scène libre puis on reprend avec une variation imposée.',
    rulesDescription: "L\'improvisation débute comme une libre. À mi-temps (ou quand le maître de jeu le décide), les joueurs doivent RECOMMENCER la même improvisation en changeant soit le STYLE, l\'AMBIANCE, un ÉLÉMENT de l\'histoire, en modifiant les PERSONNAGES, en imposant des HANDICAPS ou autres. La deuxième version doit conserver la trame mais tout transformer.",
    allowedNatures: ['MIXTE','COMPAREE'], defaultDurationSec: 240, defaultCaucusSec: 25,
    difficulty: 'MEDIUM', tags: ['structure','meta','v2']
  },
  { slug: 'tout-terrain',    name: 'Tout-terrain',      shortDescription: 'Catégorie libre, tout est permis. Carte sécurité.',            allowedNatures: ['MIXTE','COMPAREE'], defaultDurationSec: 180, defaultCaucusSec: 20, difficulty: 'EASY',   tags: ['libre'] },
];

const IMPROV_THEMES = [
  // ── Quotidien / ordinaire ──
  { slug: 'premier-rendez-vous',       name: 'Premier rendez-vous',              difficulty: 'EASY',   tags: ['classique'] },
  { slug: 'panne-electricite',         name: 'Panne d\'électricité',              difficulty: 'EASY',   tags: ['quotidien'] },
  { slug: 'epicerie-dimanche',         name: 'Épicerie du dimanche',             difficulty: 'EASY',   tags: ['quotidien'] },
  { slug: 'telephone-sonne',           name: 'Le téléphone sonne',               difficulty: 'EASY',   tags: ['quotidien'] },
  { slug: 'reunion-famille',           name: 'Réunion de famille',               difficulty: 'EASY',   tags: ['quotidien'] },
  { slug: 'chez-le-dentiste',          name: 'Chez le dentiste',                 difficulty: 'EASY',   tags: ['quotidien'] },
  { slug: 'chez-le-barbier',           name: 'Chez le barbier',                  difficulty: 'EASY',   tags: ['quotidien'] },
  { slug: 'aeroport',                  name: 'À l\'aéroport',                     difficulty: 'MEDIUM', tags: ['quotidien'] },
  { slug: 'banque',                    name: 'À la banque',                      difficulty: 'MEDIUM', tags: ['quotidien'] },
  { slug: 'permis-conduire',           name: 'Examen du permis de conduire',     difficulty: 'MEDIUM', tags: ['quotidien'] },
  { slug: 'entrevue-emploi',           name: 'Entrevue d\'emploi',                difficulty: 'MEDIUM', tags: ['quotidien'] },
  { slug: 'premier-emploi',            name: 'Premier jour au travail',          difficulty: 'MEDIUM', tags: ['quotidien'] },
  { slug: 'demenagement',              name: 'Déménagement',                     difficulty: 'EASY',   tags: ['quotidien'] },
  { slug: 'urgence-hopital',           name: 'Attente à l\'urgence',              difficulty: 'MEDIUM', tags: ['quotidien'] },
  { slug: 'restaurant',                name: 'Au restaurant',                    difficulty: 'EASY',   tags: ['quotidien'] },
  { slug: 'cours-yoga',                name: 'Cours de yoga',                    difficulty: 'EASY',   tags: ['loisir'] },
  { slug: 'club-lecture',              name: 'Club de lecture',                  difficulty: 'MEDIUM', tags: ['loisir'] },
  { slug: 'cabine-essayage',           name: 'Dans la cabine d\'essayage',        difficulty: 'EASY',   tags: ['quotidien'] },
  { slug: 'appel-conference',          name: 'Appel-conférence de travail',      difficulty: 'MEDIUM', tags: ['quotidien'] },
  { slug: 'piscine-municipale',        name: 'Piscine municipale',               difficulty: 'EASY',   tags: ['loisir'] },
  // ── Québec / fêtes / saisons ──
  { slug: 'cabane-a-sucre',            name: 'Cabane à sucre',                   difficulty: 'EASY',   tags: ['quebec','fete'] },
  { slug: 'tempete-neige',             name: 'Tempête de neige',                 difficulty: 'MEDIUM', tags: ['quebec','meteo'] },
  { slug: 'premiere-neige',            name: 'La première neige',                difficulty: 'EASY',   tags: ['quebec','meteo'] },
  { slug: 'veille-noel',               name: 'La veille de Noël',                difficulty: 'MEDIUM', tags: ['fete'] },
  { slug: 'chasse-bonbons',            name: 'Chasse aux bonbons à l\'Halloween', difficulty: 'EASY',   tags: ['fete','quebec'] },
  { slug: 'saint-jean',                name: 'Feux de la Saint-Jean',            difficulty: 'MEDIUM', tags: ['fete','quebec'] },
  { slug: 'festival-jazz',             name: 'Festival de jazz de Montréal',     difficulty: 'MEDIUM', tags: ['quebec','culture'] },
  { slug: 'vendredi-fou',              name: 'Grande vente du Vendredi Fou',     difficulty: 'MEDIUM', tags: ['quebec'] },
  { slug: 'brouillard-autoroute',      name: 'Brouillard sur l\'autoroute 20',    difficulty: 'MEDIUM', tags: ['quebec','meteo'] },
  // ── Sport ──
  { slug: 'match-hockey',              name: 'Match de hockey',                  difficulty: 'EASY',   tags: ['quebec','sport'] },
  { slug: 'match-curling',             name: 'Match de curling',                 difficulty: 'MEDIUM', tags: ['quebec','sport'] },
  { slug: 'cours-natation',            name: 'Cours de natation',                difficulty: 'EASY',   tags: ['sport'] },
  { slug: 'coaching-sportif',          name: 'Session de coaching sportif',      difficulty: 'MEDIUM', tags: ['sport'] },
  { slug: 'course-matinale',           name: 'Course à pied matinale',           difficulty: 'EASY',   tags: ['sport'] },
  // ── École / enfance ──
  { slug: 'examen-maths',              name: 'Examen de mathématiques',          difficulty: 'EASY',   tags: ['ecole'] },
  { slug: 'devoirs-ecole',             name: 'Devoirs de l\'école',               difficulty: 'EASY',   tags: ['ecole'] },
  { slug: 'spectacle-fin-annee',       name: 'Spectacle de fin d\'année',         difficulty: 'MEDIUM', tags: ['ecole'] },
  { slug: 'cour-ecole',                name: 'Récréation dans la cour',          difficulty: 'EASY',   tags: ['ecole','enfance'] },
  { slug: 'cauchemar-enfant',          name: 'Cauchemar d\'enfant',               difficulty: 'MEDIUM', tags: ['onirique'] },
  { slug: 'bataille-polochon',         name: 'Bataille d\'oreillers',             difficulty: 'EASY',   tags: ['enfance'] },
  { slug: 'cabane-arbre',              name: 'Cabane dans l\'arbre',              difficulty: 'EASY',   tags: ['enfance'] },
  { slug: 'grand-maman-mots-croises',  name: 'Grand-maman qui fait ses mots croisés', difficulty: 'EASY', tags: ['quotidien'] },
  // ── Aventure / voyage ──
  { slug: 'perdu-en-foret',            name: 'Perdu dans la forêt',              difficulty: 'MEDIUM', tags: ['aventure'] },
  { slug: 'camping-sauvage',           name: 'Camping sauvage',                  difficulty: 'MEDIUM', tags: ['nature'] },
  { slug: 'camping-vr',                name: 'Camping en VR',                    difficulty: 'MEDIUM', tags: ['quebec','voyage'] },
  { slug: 'voyage-autobus',            name: 'Voyage en autobus',                difficulty: 'EASY',   tags: ['voyage'] },
  { slug: 'ruelle-sombre',             name: 'Ruelle sombre le soir',            difficulty: 'MEDIUM', tags: ['mystere'] },
  // ── Fantastique / absurde ──
  { slug: 'voyage-dans-le-temps',      name: 'Voyage dans le temps',             difficulty: 'HARD',   tags: ['fantastique'] },
  { slug: 'extraterrestre',            name: 'Rencontre avec un extraterrestre', difficulty: 'HARD',   tags: ['fantastique'] },
  { slug: 'prehistoire',               name: 'Préhistoire',                      difficulty: 'MEDIUM', tags: ['historique'] },
  { slug: 'pire-cafe-du-monde',        name: 'Le pire café du monde',            difficulty: 'MEDIUM', tags: ['absurde'] },
  // ── Showbiz ──
  { slug: 'audition-star-academie',    name: 'Audition de Star Académie',        difficulty: 'MEDIUM', tags: ['quebec','showbiz'] },
  { slug: 'talk-show',                 name: 'Talk-show télé',                   difficulty: 'MEDIUM', tags: ['showbiz'] },
  { slug: 'nouvelles-18h',             name: 'Nouvelles du 18h',                 difficulty: 'MEDIUM', tags: ['showbiz'] },
  // ── Sérieux ──
  { slug: 'tribunal',                  name: 'Au tribunal',                      difficulty: 'HARD',   tags: ['serieux'] },
  { slug: 'funerailles',               name: 'Aux funérailles',                  difficulty: 'HARD',   tags: ['serieux'] },
  { slug: 'mariage',                   name: 'Au mariage',                       difficulty: 'MEDIUM', tags: ['fete'] },
  // ── Sorties ──
  { slug: 'visite-zoo',                name: 'Visite au zoo',                    difficulty: 'EASY',   tags: ['sortie'] },
  { slug: 'visite-musee',              name: 'Visite au musée',                  difficulty: 'MEDIUM', tags: ['sortie'] },
  { slug: 'foire-agricole',            name: 'Foire agricole',                   difficulty: 'MEDIUM', tags: ['sortie','quebec'] },
  { slug: 'chantier-construction',     name: 'Chantier de construction',         difficulty: 'MEDIUM', tags: ['metier'] },
];

const IMPROV_CONSTRAINTS = [
  { slug: 'sans-se-toucher',     name: 'Sans jamais se toucher',        description: 'Aucun contact physique entre les joueurs.',              difficulty: 'MEDIUM' },
  { slug: 'en-chantant',         name: 'En chantant chaque mot',         description: 'Chaque réplique doit être chantée.',                    difficulty: 'HARD' },
  { slug: 'sans-regarder',       name: 'Sans se regarder',              description: 'Aucun contact visuel direct entre joueurs.',            difficulty: 'MEDIUM' },
  { slug: 'en-rimes',            name: 'En rimes',                      description: 'Chaque réplique doit rimer avec la précédente.',        difficulty: 'HARD' },
  { slug: 'yeux-fermes',         name: 'Les yeux fermés',               description: 'Jouer les yeux fermés, sauf pour la sécurité.',          difficulty: 'HARD' },
  { slug: 'en-chuchotant',       name: 'En chuchotant',                 description: 'Impossible de parler fort ou normalement.',              difficulty: 'EASY' },
  { slug: 'gibberish',           name: 'En gibberish',                  description: 'Sons inventés seulement — aucun mot réel.',              difficulty: 'HARD' },
  { slug: 'mot-anglais',         name: 'Un mot en anglais par réplique', description: 'Glisser au moins un mot anglais à chaque tirade.',      difficulty: 'MEDIUM' },
  { slug: 'un-joueur-a-la-fois', name: 'Un joueur bouge à la fois',     description: 'Les autres restent figés.',                              difficulty: 'MEDIUM' },
  { slug: 'repliques-courtes',   name: 'Répliques de 3 mots maximum',    description: 'Jamais plus de 3 mots par réplique.',                    difficulty: 'HARD' },
  { slug: 'dos-au-public',       name: 'Dos au public',                 description: 'Les joueurs donnent le dos à l\'auditoire.',              difficulty: 'MEDIUM' },
  { slug: 'sur-un-pied',         name: 'Sur un pied',                   description: 'Tout le monde reste sur un pied.',                       difficulty: 'HARD' },
  { slug: 'tout-en-pleurant',    name: 'Tout en pleurant',              description: 'Chaque réplique est accompagnée de pleurs.',             difficulty: 'MEDIUM' },
  { slug: 'tout-en-riant',       name: 'Tout en riant',                 description: 'Impossible de ne pas rire en parlant.',                  difficulty: 'MEDIUM' },
  { slug: 'sous-eau',            name: 'Comme sous l\'eau',              description: 'Gestes et voix ralentis, comme sous-marins.',            difficulty: 'MEDIUM' },
  { slug: 'comme-robots',        name: 'Comme des robots',              description: 'Gestes saccadés, voix monocorde.',                       difficulty: 'MEDIUM' },
  { slug: 'en-cowboy',           name: 'Comme des cowboys',              description: 'Accent, démarche et attitude western obligatoires.',     difficulty: 'EASY' },
  { slug: 'dos-a-dos',           name: 'Dos à dos',                     description: 'Les joueurs jouent toujours dos à dos, pas face à face.', difficulty: 'MEDIUM' },
];

async function seedImprov(prisma) {
  console.log('🎭 Seed Impro Engine...');
  for (const c of IMPROV_CATEGORIES) {
    await prisma.improvCategory.upsert({
      where: { slug: c.slug },
      update: {
        name: c.name,
        shortDescription: c.shortDescription,
        rulesDescription: c.rulesDescription ?? null,
        allowedNatures: c.allowedNatures,
        minPlayers: c.minPlayers ?? 1,
        maxPlayers: c.maxPlayers ?? 6,
        minDurationSec: c.minDurationSec ?? 60,
        maxDurationSec: c.maxDurationSec ?? 300,
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
        rulesDescription: c.rulesDescription ?? null,
        allowedNatures: c.allowedNatures,
        minPlayers: c.minPlayers ?? 1,
        maxPlayers: c.maxPlayers ?? 6,
        minDurationSec: c.minDurationSec ?? 60,
        maxDurationSec: c.maxDurationSec ?? 300,
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
