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
    slug: 'chantier',
    name: 'Chantier Chalet',
    description: 'Gestion de la reconstruction — jalons, soumissions, contacts, budget, photos.',
    icon: 'helmet-safety',
    color: '#D97706',
    isMockup: false,
    realm: 'FAMILY',
  },
  {
    slug: 'budget',
    name: 'Budget familial',
    description: 'Revenus, dépenses, prévisions et calculateur d\'hypothèque — le portrait financier de la famille.',
    icon: 'sack-dollar',
    color: '#0C6B4F',
    isMockup: false,
    realm: 'FAMILY',
  },
  {
    slug: 'assistant',
    name: 'BIFROST',
    description: 'Pont vers HEIMDALL — cockpit Aion UI, agents FRIDAY, drops modules.',
    icon: 'eye',
    color: '#29D0FE',
    isMockup: false,
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

  // Maison + Chalet + Chantier + Budget : Martin + Marie-Josée (parents)
  for (const slug of ['maison', 'chalet', 'chantier', 'budget']) {
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

  // Chantier Chalet — projet + metiers + pre-jalons + photos du terrain
  await seedChantier(prisma);

  console.log('✅ Seed terminé. Aucun module backend — MCreator Academy est full-frontend.');
}

// ============ CHANTIER CHALET SEED ============
// Idempotent : le projet est upsert (jamais clobber). Metiers / jalons / photos
// ne sont seedes QUE si le projet est vierge (count === 0), pour ne pas ecraser
// les ajouts/suppressions de Martin.

const CHANTIER_TRADES = [
  'Excavation', 'Fondation', 'Charpente', 'Toiture', 'Fenêtres et portes',
  'Plomberie', 'Électricité', 'Isolation', 'Gypse et tirage de joints',
  'Planchers', 'Armoires et cuisine', 'Peinture', 'Finition intérieure', 'Paysagement',
];

// Pre-jalons phase PRE_CONSTRUCTION (order 1..11). Voir memoire projet + regles
// municipales Trois-Rives / MRC Mekinac + bande riveraine (lac Mekinac).
const CHANTIER_PRE_JALONS = [
  { name: 'Plan 1 — consultation', description: 'Première version des plans avec l\'architecte / designer.' },
  { name: 'Plan modifié', description: 'Itération des plans après commentaires.' },
  { name: 'Plan final', description: 'Version finale déposée pour permis.' },
  { name: 'Arpentage / certificat de localisation', description: 'Arpenteur-géomètre.' },
  { name: 'Test de sol / étude géotechnique', description: 'Capacité portante du sol.' },
  { name: 'Abattage d\'arbres / déboisement', description: 'Permis requis — attention bande riveraine du lac.' },
  { name: 'Permis de construction (Trois-Rives / MRC)', description: 'Inspecteur municipal Trois-Rives / MRC de Mékinac.' },
  { name: 'Certificat d\'autorisation bande riveraine', description: 'Si intervention près du lac Mékinac (PPRLPI). À confirmer avec la municipalité.' },
  { name: 'Installation septique (Q-2, r.22)', description: 'Permis d\'installation d\'un système de traitement des eaux usées.' },
  { name: 'Puits / captage d\'eau', description: 'Permis de forage / captage d\'eau potable.' },
  { name: 'Implantation / piquetage', description: 'Localisation exacte du bâtiment sur le terrain.' },
];

// Categories budgetaires de l'estime CDH (Construction Denis Hamel, juillet 2026,
// soumission prix coutant majore 1 247 888 $ + taxes = 1 434 759 $). Sync par nom :
// renomme les vieux metiers generiques vers les categories CDH, cree les manquantes,
// et ne touche budgetPrevu QUE s'il est encore a 0 (jamais clobber Martin).
const CDH_CATEGORIES = [
  { name: 'Démolition et excavation', budget: 70000, renameFrom: 'Excavation' },
  { name: 'Fosse septique et champ d\'épuration', budget: 52500 },
  { name: 'Fondation', budget: 72500 },
  { name: 'Charpente et structure', budget: 162000, renameFrom: 'Charpente' },
  { name: 'Portes et fenêtres', budget: 64600, renameFrom: 'Fenêtres et portes' },
  { name: 'Isolation / étanchéité', budget: 69300, renameFrom: 'Isolation' },
  { name: 'Gypse et joints', budget: 48650, renameFrom: 'Gypse et tirage de joints' },
  { name: 'Revêtement de plancher (béton, époxy)', budget: 40600, renameFrom: 'Planchers' },
  { name: 'Finition intérieure', budget: 9900 },
  { name: 'Peinture', budget: 17700 },
  { name: 'Escalier intérieur (acier, béton)', budget: 21500 },
  { name: 'Ébénisterie (mobilier fixe)', budget: 62800, renameFrom: 'Armoires et cuisine' },
  { name: 'Maçonnerie extérieure', budget: 24200 },
  { name: 'Finition extérieure (revêtement bois)', budget: 86000 },
  { name: 'Balcons, dalles et rampes de verre', budget: 49500 },
  { name: 'Électricité (domotique, plancher chauffant)', budget: 72650, renameFrom: 'Électricité' },
  { name: 'Plomberie', budget: 46600 },
  { name: 'CVAC / climatisation centrale', budget: 21702 },
  { name: 'Exigences générales / gestion', budget: 92620 },
  { name: 'Administration CDH (8 %)', budget: 86826 },
  { name: 'Profit CDH (7 %)', budget: 75973 },
];

// Grille d'inspection progressive de la banque (institution financiere QC).
// Poids en % du projet — somme = 100. C'est l'avancement OFFICIEL qui
// declenche les debourses.
const GRILLE_BANQUE = [
  // Stade 1 — Fondation et charpente (38,4 %)
  { stade: 1, name: 'Architecte et plans', weight: 0.7 },
  { stade: 1, name: 'Permis, arpentage, garantie du propriétaire', weight: 1.7 },
  { stade: 1, name: 'Raccordements des services', weight: 1.6 },
  { stade: 1, name: 'Défrichement, excavation, remblayage', weight: 2.5 },
  { stade: 1, name: 'Semelles, fondation, plancher du sous-sol', weight: 6.0 },
  { stade: 1, name: 'Alimentation en eau, évacuation des déchets', weight: 0.6 },
  { stade: 1, name: 'Charpente', weight: 18.0 },
  { stade: 1, name: 'Toiture', weight: 3.0 },
  { stade: 1, name: 'Fenêtres', weight: 3.1 },
  { stade: 1, name: 'Portes extérieures', weight: 1.2 },
  // Stade 2 — Systèmes et recouvrements (29,4 %)
  { stade: 2, name: 'Finition extérieure', weight: 8.2 },
  { stade: 2, name: 'Soffites, gouttières et bordures de toit', weight: 0.8 },
  { stade: 2, name: 'Plomberie brute', weight: 2.6 },
  { stade: 2, name: 'Filage brut', weight: 3.8 },
  { stade: 2, name: 'Chauffage et climatisation', weight: 4.5 },
  { stade: 2, name: 'Isolation', weight: 2.2 },
  { stade: 2, name: 'Placoplâtre (gypse)', weight: 6.2 },
  { stade: 2, name: 'Foyer et cheminées', weight: 1.1 },
  // Stade 3 — Finition (32,2 %)
  { stade: 3, name: 'Appareils de plomberie', weight: 3.7 },
  { stade: 3, name: 'Appareils d\'éclairage', weight: 1.0 },
  { stade: 3, name: 'Couvre-planchers', weight: 4.5 },
  { stade: 3, name: 'Cabinets, vanités, lavabos', weight: 4.8 },
  { stade: 3, name: 'Finition intérieure', weight: 5.5 },
  { stade: 3, name: 'Peinture', weight: 3.8 },
  { stade: 3, name: 'Portes intérieures', weight: 1.6 },
  { stade: 3, name: 'Carrelage', weight: 1.0 },
  { stade: 3, name: 'Encastrés', weight: 2.1 },
  { stade: 3, name: 'Portes et ouvre-portes de garage', weight: 1.2 },
  { stade: 3, name: 'Terrasses, trottoirs et patios', weight: 1.5 },
  { stade: 3, name: 'Entrée de cour, aménagement paysager', weight: 1.5 },
];

// Debourses progressifs — division naturelle selon les 3 stades de la grille,
// proportionnels au montant total du projet CDH (1 434 759 $ taxes incluses).
const DEBOURSES_BANQUE = [
  { label: 'Déboursé 1 — Stade 1 : fondation et charpente', amount: 550950, condition: 'Grille banque stade 1 complétée (38,4 % du projet) + inspection', order: 1 },
  { label: 'Déboursé 2 — Stade 2 : systèmes et recouvrements', amount: 421820, condition: 'Grille banque stade 2 complétée (67,8 % cumulé) + inspection', order: 2 },
  { label: 'Déboursé 3 — Stade 3 : finition et livraison', amount: 461990, condition: 'Grille banque 100 % + inspection finale', order: 3 },
];

// Photos du terrain deja presentes dans le repo frontend (public/images/*).
// Seedees comme docs PHOTO via fileUrl (pas de base64 en DB pour celles-la).
const CHANTIER_SEED_PHOTOS = [
  { title: 'Terrain — vue du site 1', file: 'Site1.jpeg' },
  { title: 'Terrain — vue du site 2', file: 'Site2.jpeg' },
  { title: 'Terrain — vue du site 3', file: 'Site3.jpeg' },
  { title: 'Terrain — bord du lac', file: 'Shore.jpeg' },
  { title: 'Terrain — façade', file: 'Front.jpeg' },
  { title: 'Terrain — le lac', file: 'lake.jpeg' },
];

async function seedChantier(prisma) {
  console.log('🏗️  Seed Chantier Chalet...');

  const project = await prisma.chantierProject.upsert({
    where: { slug: 'chalet' },
    update: {}, // jamais clobber — Martin controle budget/adresse/statut apres coup
    create: {
      slug: 'chalet',
      name: 'Chantier Chalet',
      address: '396 chemin du lac Mékinac, Trois-Rives',
      budgetTotal: 0,
      status: 'EN_COURS',
    },
  });

  const tradeCount = await prisma.trade.count({ where: { projectId: project.id } });
  if (tradeCount === 0) {
    for (let i = 0; i < CHANTIER_TRADES.length; i++) {
      await prisma.trade.create({
        data: { projectId: project.id, name: CHANTIER_TRADES[i], order: i + 1, icon: 'hammer', color: '#D97706' },
      });
    }
    console.log(`✓ ${CHANTIER_TRADES.length} corps de métier seedés`);
  }

  const jalonCount = await prisma.jalon.count({ where: { projectId: project.id } });
  if (jalonCount === 0) {
    for (let i = 0; i < CHANTIER_PRE_JALONS.length; i++) {
      const j = CHANTIER_PRE_JALONS[i];
      await prisma.jalon.create({
        data: {
          projectId: project.id,
          name: j.name,
          description: j.description,
          phase: 'PRE_CONSTRUCTION',
          status: 'A_VENIR',
          order: i + 1,
        },
      });
    }
    console.log(`✓ ${CHANTIER_PRE_JALONS.length} pré-jalons seedés`);
  }

  // Sync categories CDH (additif, jamais clobber les montants edites par Martin)
  const allTrades = await prisma.trade.findMany({ where: { projectId: project.id } });
  let cdhOrder = allTrades.length;
  for (let i = 0; i < CDH_CATEGORIES.length; i++) {
    const c = CDH_CATEGORIES[i];
    let t = allTrades.find((x) => x.name === c.name);
    if (!t && c.renameFrom) {
      const old = allTrades.find((x) => x.name === c.renameFrom);
      if (old) {
        t = await prisma.trade.update({
          where: { id: old.id },
          data: { name: c.name, ...(old.budgetPrevu === 0 ? { budgetPrevu: c.budget } : {}) },
        });
      }
    } else if (t && t.budgetPrevu === 0) {
      t = await prisma.trade.update({ where: { id: t.id }, data: { budgetPrevu: c.budget } });
    }
    if (!t) {
      await prisma.trade.create({
        data: { projectId: project.id, name: c.name, budgetPrevu: c.budget, order: ++cdhOrder, icon: 'hammer', color: '#D97706' },
      });
    }
  }
  console.log('✓ Catégories CDH synchronisées');

  // Grille d'avancement banque (26 postes) — seulement si vierge
  const avCount = await prisma.avancementItem.count({ where: { projectId: project.id } });
  if (avCount === 0) {
    for (let i = 0; i < GRILLE_BANQUE.length; i++) {
      const g = GRILLE_BANQUE[i];
      await prisma.avancementItem.create({
        data: { projectId: project.id, stade: g.stade, name: g.name, weight: g.weight, pct: 0, order: i + 1 },
      });
    }
    console.log(`✓ ${GRILLE_BANQUE.length} postes de la grille banque seedés`);
  }

  // Debourses banque — seulement si vierge
  const debCount = await prisma.debourseBanque.count({ where: { projectId: project.id } });
  if (debCount === 0) {
    for (const d of DEBOURSES_BANQUE) {
      await prisma.debourseBanque.create({ data: { projectId: project.id, ...d } });
    }
    console.log(`✓ ${DEBOURSES_BANQUE.length} déboursés banque seedés`);
  }

  // Budget total projet = estime CDH taxes incluses, seulement si encore a 0
  if ((project.budgetTotal || 0) === 0) {
    await prisma.chantierProject.update({ where: { id: project.id }, data: { budgetTotal: 1434759 } });
    console.log('✓ Budget total initialisé à 1 434 759 $ (CDH taxes incluses)');
  }

  const photoCount = await prisma.chantierDoc.count({ where: { projectId: project.id } });
  if (photoCount === 0) {
    for (const p of CHANTIER_SEED_PHOTOS) {
      await prisma.chantierDoc.create({
        data: {
          projectId: project.id,
          kind: 'PHOTO',
          title: p.title,
          fileUrl: `https://my-mission-control.com/images/${p.file}`,
          mimeType: 'image/jpeg',
        },
      });
    }
    console.log(`✓ ${CHANTIER_SEED_PHOTOS.length} photos du terrain seedées`);
  }

  console.log('✓ Chantier Chalet prêt');
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
