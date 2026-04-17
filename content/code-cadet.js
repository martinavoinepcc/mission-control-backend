// Content pack : Code Cadet · Minecraft Protocol — Module 1 (v2.0.0, Silica-aligned)
// 9 missions en 3 chapitres, alignées sur le curriculum du camp Silica Studio été 2026.
//
// CHAPITRE 1 — Cours 0 Minecraft (3) : prépare Jackson à être autonome en jeu.
// CHAPITRE 2 — Fondations Redstone (5) : mirroir 1:1 des modules du camp.
// CHAPITRE 3 — Défi Master Codeur (1) : boss final.
//
// Avatar : Commandant Rex (QC, francophone).
//
// Structure du champ `data` (identique à v1.0.0) :
// {
//   briefing: { text, avatarClip? },
//   world: { tileset, cols, rows, start, goal, items[], obstacles[], backgroundMusic },
//   toolbox: { categories: [{ name, colour, blocks: [{ type, params? }] }] },
//   starter: { xml } | null,
//   success: { type: 'reachGoal'|'collectAll'|'customCondition', rules, maxBlocks? },
//   hints: [string, string, string, string],
//   xpMax: number,
//   stars: { gold: {...}, silver: {...}, bronze: {...} },
//   rexLines: { intro, onSuccess, onError }
// }
//
// CONTRAINTES MOTEUR (respectées partout) :
//   Blocs : event_start, rex_say, rex_move_forward, rex_turn_right, rex_turn_left, rex_repeat
//   Tilesets : plaine, foret, grotte, pont
//   Items : crystal (cyan|green|purple|gold), flag
//   Obstacles : water

const module1 = {
  module: {
    slug: 'code-cadet',
    title: 'Code Cadet',
    subtitle: 'Minecraft Protocol',
    description:
      "Prépare-toi au camp Silica Studio. Avec le Commandant Rex, tu apprends les bases du code (Cours 0) puis les Fondations Redstone : source, puissance, logique ET/OU, pistons, mise en commun. Rien ne bouge tant que TU n'écris pas le code.",
    coverColor: '#4ADE80',
    coverIcon: 'cube',
    version: '2.0.0',
    language: 'fr-CA',
    avatarKey: 'rex-commandant',
    order: 1,
    status: 'ACTIVE',
  },
  lessons: [
    // ============================================================
    // CHAPITRE 1 — COURS 0 MINECRAFT
    // ============================================================

    // === MISSION 1 — BOUGER DANS LE MONDE ===
    {
      slug: 'cours0-bouger',
      chapter: 1,
      order: 1,
      kind: 'QUEST',
      title: 'Bouger dans le monde',
      subtitle: "Ton tout premier ordre : avancer.",
      conceptKey: 'sequence',
      data: {
        briefing: {
          text:
            "Salut cadet. Bienvenue au Cours 0. Au camp Silica, la première chose qu'on apprend c'est BOUGER. Ici tu vas me donner l'ordre d'avancer d'une case vers le cristal bleu. Un bloc Au début, un bloc Avancer. Go.",
          avatarClip: 'rex-intro-c0m1',
        },
        world: {
          tileset: 'plaine',
          cols: 5,
          rows: 3,
          start: { x: 1, y: 1, dir: 'east' },
          goal: { x: 2, y: 1 },
          items: [{ type: 'crystal', x: 2, y: 1, color: 'cyan' }],
          obstacles: [],
          backgroundMusic: 'plaine-calm',
        },
        toolbox: {
          categories: [
            { name: 'Événements', colour: '#F59E0B', blocks: [{ type: 'event_start' }] },
            {
              name: 'Mouvement',
              colour: '#60A5FA',
              blocks: [{ type: 'rex_move_forward' }],
            },
          ],
        },
        starter: null,
        success: {
          type: 'reachGoal',
          rules: { reach: { x: 2, y: 1 } },
          maxBlocks: 2,
        },
        hints: [
          "Commence par le bloc orange Au début. C'est toujours la 1re pièce.",
          "Maintenant le bloc bleu Avancer, collé dessous.",
          "Rex regarde vers l'est (→). Un seul Avancer suffit pour toucher le cristal.",
          "Solution : Au début + Avancer. 2 blocs. Clic ▶ Jouer.",
        ],
        xpMax: 20,
        stars: {
          gold: { maxBlocks: 2 },
          silver: { maxBlocks: 3 },
          bronze: { maxBlocks: 5 },
        },
        rexLines: {
          intro: "Premier ordre. Avance d'une case vers le cristal bleu.",
          onSuccess: "Bravo cadet. Tu viens de contrôler un personnage avec du code. Comme à Silica.",
          onError: "Presque. Compte les cases : une seule suffit.",
        },
      },
    },

    // === MISSION 2 — POSER ET CASSER (simulé par navigation) ===
    {
      slug: 'cours0-poser-casser',
      chapter: 1,
      order: 2,
      kind: 'QUEST',
      title: 'Poser et casser',
      subtitle: "Tourner pour atteindre deux cristaux.",
      conceptKey: 'action',
      data: {
        briefing: {
          text:
            "Au camp Silica, tu apprendras à poser et casser des blocs. Ici, on simule ça avec des cristaux à collecter. Deux cristaux : un devant, un à ta droite. Va les chercher tous les deux.",
          avatarClip: 'rex-intro-c0m2',
        },
        world: {
          tileset: 'plaine',
          cols: 5,
          rows: 5,
          start: { x: 1, y: 2, dir: 'east' },
          goal: { x: 2, y: 3 },
          items: [
            { type: 'crystal', x: 2, y: 2, color: 'green' },
            { type: 'crystal', x: 2, y: 3, color: 'cyan' },
          ],
          obstacles: [],
          backgroundMusic: 'plaine-calm',
        },
        toolbox: {
          categories: [
            { name: 'Événements', colour: '#F59E0B', blocks: [{ type: 'event_start' }] },
            {
              name: 'Mouvement',
              colour: '#60A5FA',
              blocks: [
                { type: 'rex_move_forward' },
                { type: 'rex_turn_right' },
                { type: 'rex_turn_left' },
              ],
            },
          ],
        },
        starter: null,
        success: {
          type: 'collectAll',
          rules: { collect: ['crystal-2-2', 'crystal-2-3'] },
          maxBlocks: 4,
        },
        hints: [
          "Rex regarde vers l'est. Le 1er cristal (vert) est juste devant.",
          "Après le 1er, tourne à droite pour faire face au sud, puis avance.",
          "Ordre : Avancer (prend le vert) → Tourner à droite → Avancer (prend le bleu).",
          "Solution : Au début + Avancer + Tourner à droite + Avancer. 4 blocs.",
        ],
        xpMax: 25,
        stars: {
          gold: { maxBlocks: 4 },
          silver: { maxBlocks: 5 },
          bronze: { maxBlocks: 7 },
        },
        rexLines: {
          intro: "Deux cristaux à ramasser. Pense à tourner.",
          onSuccess: "Excellent. Tu combines déjà plusieurs ordres. C'est ça le code.",
          onError: "Rex rate un cristal. Vérifie l'ordre des blocs.",
        },
      },
    },

    // === MISSION 3 — INTERAGIR AVEC L'ENVIRONNEMENT ===
    {
      slug: 'cours0-interagir',
      chapter: 1,
      order: 3,
      kind: 'QUEST',
      title: 'Interagir avec l\'environnement',
      subtitle: "Ta 1re boucle : répéter pour aller loin.",
      conceptKey: 'repetition',
      data: {
        briefing: {
          text:
            "À Silica on répète souvent la même action. Au lieu de poser 3 fois Avancer, on utilise une BOUCLE : Répéter 3 fois. Essaie-la ici — le cristal doré est à 3 cases devant.",
          avatarClip: 'rex-intro-c0m3',
        },
        world: {
          tileset: 'foret',
          cols: 6,
          rows: 3,
          start: { x: 0, y: 1, dir: 'east' },
          goal: { x: 3, y: 1 },
          items: [{ type: 'crystal', x: 3, y: 1, color: 'gold' }],
          obstacles: [],
          backgroundMusic: 'foret-mysterieux',
        },
        toolbox: {
          categories: [
            { name: 'Événements', colour: '#F59E0B', blocks: [{ type: 'event_start' }] },
            {
              name: 'Mouvement',
              colour: '#60A5FA',
              blocks: [{ type: 'rex_move_forward' }],
            },
            {
              name: 'Boucles',
              colour: '#A855F7',
              blocks: [{ type: 'rex_repeat', params: { times: 3 } }],
            },
          ],
        },
        starter: null,
        success: {
          type: 'reachGoal',
          rules: { reach: { x: 3, y: 1 } },
          maxBlocks: 5,
        },
        hints: [
          "Tu peux faire 3 Avancer collés — ça marche mais c'est long.",
          "Essaie le bloc violet Répéter 3 fois. Mets Avancer à l'intérieur.",
          "Règle le nombre de répétitions à 3.",
          "Solution optimale : Au début + Répéter 3 fois { Avancer }. 3 blocs, 3 étoiles.",
        ],
        xpMax: 30,
        stars: {
          gold: { maxBlocks: 3 },
          silver: { maxBlocks: 4 },
          bronze: { maxBlocks: 6 },
        },
        rexLines: {
          intro: "3 cases. Utilise Répéter pour économiser du code.",
          onSuccess: "BOUCLE maîtrisée. Tu viens de découvrir un des super-pouvoirs des codeurs.",
          onError: "Compte les cases : exactement 3 Avancer, ni plus ni moins.",
        },
      },
    },

    // ============================================================
    // CHAPITRE 2 — FONDATIONS REDSTONE
    // ============================================================

    // === MISSION 4 — RS·M1 : DÉCOUVERTE (source → fil → cible) ===
    {
      slug: 'redstone-m1-decouverte',
      chapter: 2,
      order: 1,
      kind: 'QUEST',
      title: 'RS·M1 — Découverte Redstone',
      subtitle: "Le signal voyage : source → fil → cible.",
      conceptKey: 'redstone-signal',
      data: {
        briefing: {
          text:
            "Bienvenue dans les Fondations Redstone. En Minecraft, un circuit a 3 parties : une SOURCE (ex: levier), un FIL (poussière de redstone), une CIBLE (ex: lampe). Le signal voyage de la source jusqu'à la cible. Toi, tu es le signal. Pars de la source (là où tu es) et touche la cible (le cristal rouge).",
          avatarClip: 'rex-intro-rsm1',
        },
        world: {
          tileset: 'grotte',
          cols: 5,
          rows: 3,
          start: { x: 0, y: 1, dir: 'east' },
          goal: { x: 4, y: 1 },
          items: [{ type: 'crystal', x: 4, y: 1, color: 'gold' }],
          obstacles: [],
          backgroundMusic: 'grotte-redstone',
        },
        toolbox: {
          categories: [
            { name: 'Événements', colour: '#F59E0B', blocks: [{ type: 'event_start' }] },
            {
              name: 'Mouvement',
              colour: '#60A5FA',
              blocks: [{ type: 'rex_move_forward' }],
            },
            {
              name: 'Boucles',
              colour: '#A855F7',
              blocks: [{ type: 'rex_repeat', params: { times: 4 } }],
            },
          ],
        },
        starter: null,
        success: {
          type: 'reachGoal',
          rules: { reach: { x: 4, y: 1 } },
          maxBlocks: 5,
        },
        hints: [
          "Le fil fait 4 cases de long. Compte-les.",
          "Option courte : 4 Avancer collés. Option smart : 1 Répéter 4 fois.",
          "Utilise Répéter 4 fois { Avancer } pour un code propre.",
          "Solution 3 étoiles : Au début + Répéter 4 fois { Avancer }. 3 blocs.",
        ],
        xpMax: 35,
        stars: {
          gold: { maxBlocks: 3 },
          silver: { maxBlocks: 5 },
          bronze: { maxBlocks: 7 },
        },
        rexLines: {
          intro: "Source à gauche, cible à droite. Sois le signal.",
          onSuccess: "Signal transmis. Tu viens de simuler ton premier circuit Redstone.",
          onError: "Le signal n'est pas arrivé. Vérifie que tu avances assez.",
        },
      },
    },

    // === MISSION 5 — RS·M2 : PUISSANCE (long fil, boucle obligatoire) ===
    {
      slug: 'redstone-m2-puissance',
      chapter: 2,
      order: 2,
      kind: 'QUEST',
      title: 'RS·M2 — Puissance du courant',
      subtitle: "Un signal doit voyager plus loin. Utilise une boucle.",
      conceptKey: 'redstone-distance',
      data: {
        briefing: {
          text:
            "En vrai Minecraft, la poussière de redstone perd sa puissance après 15 cases. Ici on teste ta puissance de code : 6 cases en ligne droite. Utilise une boucle — sinon ça fait beaucoup de blocs.",
          avatarClip: 'rex-intro-rsm2',
        },
        world: {
          tileset: 'grotte',
          cols: 8,
          rows: 3,
          start: { x: 0, y: 1, dir: 'east' },
          goal: { x: 6, y: 1 },
          items: [{ type: 'crystal', x: 6, y: 1, color: 'gold' }],
          obstacles: [],
          backgroundMusic: 'grotte-redstone',
        },
        toolbox: {
          categories: [
            { name: 'Événements', colour: '#F59E0B', blocks: [{ type: 'event_start' }] },
            {
              name: 'Mouvement',
              colour: '#60A5FA',
              blocks: [{ type: 'rex_move_forward' }],
            },
            {
              name: 'Boucles',
              colour: '#A855F7',
              blocks: [{ type: 'rex_repeat', params: { times: 6 } }],
            },
          ],
        },
        starter: null,
        success: {
          type: 'reachGoal',
          rules: { reach: { x: 6, y: 1 } },
          maxBlocks: 4,
        },
        hints: [
          "6 cases à parcourir. 6 Avancer, ça fait 7 blocs avec Au début. Trop.",
          "Boucle obligatoire : Répéter 6 fois { Avancer }.",
          "Le chiffre dans le bloc violet doit être 6, pas 3.",
          "Solution : Au début + Répéter 6 fois { Avancer }. 3 blocs, 3 étoiles.",
        ],
        xpMax: 40,
        stars: {
          gold: { maxBlocks: 3 },
          silver: { maxBlocks: 5 },
          bronze: { maxBlocks: 8 },
        },
        rexLines: {
          intro: "Fil long. Code court. Utilise la boucle.",
          onSuccess: "Puissance maximale. Ton code est aussi élégant qu'un vrai circuit Silica.",
          onError: "Tu es court ou tu dépasses. Vérifie le chiffre de la boucle.",
        },
      },
    },

    // === MISSION 6 — RS·M3 : LOGIQUE (ET — deux cibles à activer) ===
    {
      slug: 'redstone-m3-logique',
      chapter: 2,
      order: 3,
      kind: 'QUEST',
      title: 'RS·M3 — Logique ET',
      subtitle: "Active DEUX cibles pour gagner.",
      conceptKey: 'redstone-logic-and',
      data: {
        briefing: {
          text:
            "En Redstone, la logique ET veut dire : il faut activer UNE source ET UNE AUTRE pour que la cible s'allume. Ici, tu dois toucher les DEUX cristaux (vert ET or) avant de finir. Le vert est au nord, l'or au sud.",
          avatarClip: 'rex-intro-rsm3',
        },
        world: {
          tileset: 'grotte',
          cols: 5,
          rows: 5,
          start: { x: 2, y: 2, dir: 'north' },
          goal: { x: 2, y: 4 },
          items: [
            { type: 'crystal', x: 2, y: 0, color: 'green' },
            { type: 'crystal', x: 2, y: 4, color: 'gold' },
          ],
          obstacles: [],
          backgroundMusic: 'grotte-redstone',
        },
        toolbox: {
          categories: [
            { name: 'Événements', colour: '#F59E0B', blocks: [{ type: 'event_start' }] },
            {
              name: 'Mouvement',
              colour: '#60A5FA',
              blocks: [
                { type: 'rex_move_forward' },
                { type: 'rex_turn_right' },
                { type: 'rex_turn_left' },
              ],
            },
            {
              name: 'Boucles',
              colour: '#A855F7',
              blocks: [{ type: 'rex_repeat', params: { times: 2 } }],
            },
          ],
        },
        starter: null,
        success: {
          type: 'collectAll',
          rules: { collect: ['crystal-2-0', 'crystal-2-4'] },
          maxBlocks: 7,
        },
        hints: [
          "Rex regarde vers le nord. Le cristal vert est à 2 cases devant.",
          "Va chercher le vert en premier, puis fais demi-tour.",
          "Demi-tour = 2 × Tourner à droite (ou à gauche, pareil).",
          "Solution : Avancer×2 (vert) → Tourner à droite × 2 → Avancer×4 (or). Tu peux utiliser Répéter pour les avances.",
        ],
        xpMax: 50,
        stars: {
          gold: { maxBlocks: 7 },
          silver: { maxBlocks: 9 },
          bronze: { maxBlocks: 12 },
        },
        rexLines: {
          intro: "Deux cristaux. Tous les deux. C'est ça la logique ET.",
          onSuccess: "Logique ET validée. Tu gères déjà du code ramifié.",
          onError: "Il manque un cristal. Relis bien la mission.",
        },
      },
    },

    // === MISSION 7 — RS·M4 : PISTONS & TIMING (éviter la lave) ===
    {
      slug: 'redstone-m4-timing',
      chapter: 2,
      order: 4,
      kind: 'QUEST',
      title: 'RS·M4 — Pistons et timing',
      subtitle: "Traverse le pont sans tomber dans la lave.",
      conceptKey: 'redstone-timing',
      data: {
        briefing: {
          text:
            "En Redstone avancé, les pistons font bouger des blocs au bon moment — question de TIMING. Ici tu traverses un pont étroit : 5 cases au-dessus de la lave. Un faux pas et c'est le bain. Précision obligatoire.",
          avatarClip: 'rex-intro-rsm4',
        },
        world: {
          tileset: 'pont',
          cols: 7,
          rows: 3,
          start: { x: 0, y: 1, dir: 'east' },
          goal: { x: 5, y: 1 },
          items: [{ type: 'crystal', x: 5, y: 1, color: 'gold' }],
          obstacles: [
            { type: 'water', x: 1, y: 0 },
            { type: 'water', x: 1, y: 2 },
            { type: 'water', x: 2, y: 0 },
            { type: 'water', x: 2, y: 2 },
            { type: 'water', x: 3, y: 0 },
            { type: 'water', x: 3, y: 2 },
            { type: 'water', x: 4, y: 0 },
            { type: 'water', x: 4, y: 2 },
            { type: 'water', x: 6, y: 0 },
            { type: 'water', x: 6, y: 1 },
            { type: 'water', x: 6, y: 2 },
          ],
          backgroundMusic: 'boss-tension',
        },
        toolbox: {
          categories: [
            { name: 'Événements', colour: '#F59E0B', blocks: [{ type: 'event_start' }] },
            {
              name: 'Mouvement',
              colour: '#60A5FA',
              blocks: [{ type: 'rex_move_forward' }],
            },
            {
              name: 'Boucles',
              colour: '#A855F7',
              blocks: [{ type: 'rex_repeat', params: { times: 5 } }],
            },
          ],
        },
        starter: null,
        success: {
          type: 'reachGoal',
          rules: { reach: { x: 5, y: 1 } },
          maxBlocks: 4,
        },
        hints: [
          "Le pont fait 5 cases vers l'est. Tout écart = lave.",
          "Pas besoin de tourner. Juste Avancer × 5.",
          "Utilise Répéter 5 fois { Avancer }.",
          "Solution 3 étoiles : Au début + Répéter 5 fois { Avancer }. 3 blocs.",
        ],
        xpMax: 60,
        stars: {
          gold: { maxBlocks: 3 },
          silver: { maxBlocks: 5 },
          bronze: { maxBlocks: 8 },
        },
        rexLines: {
          intro: "Pont étroit. Lave des 2 côtés. Ne dépasse pas.",
          onSuccess: "Timing parfait. Tu viens de gérer un risque — compétence clé en Redstone.",
          onError: "Splash. Compte les cases : exactement 5, pas 6.",
        },
      },
    },

    // === MISSION 8 — RS·M5 : MISE EN COMMUN (tout ensemble) ===
    {
      slug: 'redstone-m5-mise-en-commun',
      chapter: 2,
      order: 5,
      kind: 'QUEST',
      title: 'RS·M5 — Mise en commun',
      subtitle: "Assemble tout : tourner + boucles + deux cibles.",
      conceptKey: 'redstone-composition',
      data: {
        briefing: {
          text:
            "Dernière mission des Fondations. Tu as appris : signal, puissance, logique ET, timing. Maintenant on assemble tout. Deux cristaux à collecter, un parcours qui tourne. Pense comme un ingénieur Redstone.",
          avatarClip: 'rex-intro-rsm5',
        },
        world: {
          tileset: 'grotte',
          cols: 6,
          rows: 5,
          start: { x: 0, y: 2, dir: 'east' },
          goal: { x: 4, y: 4 },
          items: [
            { type: 'crystal', x: 3, y: 2, color: 'green' },
            { type: 'crystal', x: 4, y: 4, color: 'gold' },
          ],
          obstacles: [],
          backgroundMusic: 'grotte-redstone',
        },
        toolbox: {
          categories: [
            { name: 'Événements', colour: '#F59E0B', blocks: [{ type: 'event_start' }] },
            {
              name: 'Mouvement',
              colour: '#60A5FA',
              blocks: [
                { type: 'rex_move_forward' },
                { type: 'rex_turn_right' },
                { type: 'rex_turn_left' },
              ],
            },
            {
              name: 'Boucles',
              colour: '#A855F7',
              blocks: [{ type: 'rex_repeat', params: { times: 3 } }],
            },
          ],
        },
        starter: null,
        success: {
          type: 'collectAll',
          rules: { collect: ['crystal-3-2', 'crystal-4-4'] },
          maxBlocks: 8,
        },
        hints: [
          "Rex regarde vers l'est. Le cristal vert est 3 cases devant.",
          "Une fois le vert pris, tourne à droite (→ sud) pour viser le or.",
          "Du vert au or : 1 case à droite (est) puis 2 en bas (sud).",
          "Solution : Répéter 3 fois { Avancer } → Tourner à droite → Répéter 2 fois { Avancer } → Tourner à gauche → Avancer.",
        ],
        xpMax: 70,
        stars: {
          gold: { maxBlocks: 8 },
          silver: { maxBlocks: 11 },
          bronze: { maxBlocks: 15 },
        },
        rexLines: {
          intro: "Tout ce que tu as appris. Utilise-le.",
          onSuccess: "Ingénieur Redstone confirmé. Tu es prêt pour le Défi Master Codeur.",
          onError: "Re-séquence ton code. Cristal vert d'abord, puis or.",
        },
      },
    },

    // ============================================================
    // CHAPITRE 3 — DÉFI MASTER CODEUR
    // ============================================================

    // === MISSION 9 — BOSS : DÉFI MASTER CODEUR ===
    {
      slug: 'defi-master-codeur',
      chapter: 3,
      order: 1,
      kind: 'BOSS',
      title: 'Défi Master Codeur',
      subtitle: "Boss final : collecter 3 cristaux dans un labyrinthe.",
      conceptKey: 'boss-master',
      data: {
        briefing: {
          text:
            "Boss final, cadet. 3 cristaux à collecter : un à l'ouest, un au nord, un à l'est. Et entre toi et chacun, de la lave. Tu DOIS utiliser Répéter — sinon le code explose. Prouve-moi que tu es Master Codeur.",
          avatarClip: 'rex-intro-boss',
        },
        world: {
          tileset: 'pont',
          cols: 7,
          rows: 5,
          start: { x: 3, y: 2, dir: 'east' },
          goal: { x: 0, y: 2 },
          items: [
            { type: 'crystal', x: 6, y: 2, color: 'purple' },
            { type: 'crystal', x: 3, y: 0, color: 'green' },
            { type: 'crystal', x: 0, y: 2, color: 'gold' },
          ],
          obstacles: [
            { type: 'water', x: 1, y: 0 },
            { type: 'water', x: 5, y: 0 },
            { type: 'water', x: 1, y: 4 },
            { type: 'water', x: 3, y: 4 },
            { type: 'water', x: 5, y: 4 },
          ],
          backgroundMusic: 'boss-tension',
        },
        toolbox: {
          categories: [
            { name: 'Événements', colour: '#F59E0B', blocks: [{ type: 'event_start' }] },
            {
              name: 'Mouvement',
              colour: '#60A5FA',
              blocks: [
                { type: 'rex_move_forward' },
                { type: 'rex_turn_right' },
                { type: 'rex_turn_left' },
              ],
            },
            {
              name: 'Boucles',
              colour: '#A855F7',
              blocks: [{ type: 'rex_repeat', params: { times: 3 } }],
            },
          ],
        },
        starter: null,
        success: {
          type: 'collectAll',
          rules: {
            collect: ['crystal-6-2', 'crystal-3-0', 'crystal-0-2'],
            mustUseBlock: 'rex_repeat',
          },
          maxBlocks: 12,
        },
        hints: [
          "Plan : 1) va à l'est (3 cases), 2) reviens à ton point de départ, 3) tourne au nord (2 cases), 4) reviens, 5) tourne à l'ouest (3 cases).",
          "Chaque trajet de 3 cases = Répéter 3 fois { Avancer }. Utilise cette formule.",
          "Entre chaque cristal, fais demi-tour = 2× Tourner à droite.",
          "Solution : Répéter 3 fois { Avancer } → demi-tour → Répéter 3 fois { Avancer } → Tourner à droite → Répéter 2 fois { Avancer } → demi-tour → Répéter 2 fois { Avancer } → Tourner à droite → Répéter 3 fois { Avancer }. Long mais ça marche.",
        ],
        xpMax: 120,
        stars: {
          gold: { maxBlocks: 12, mustUse: ['rex_repeat'] },
          silver: { maxBlocks: 16 },
          bronze: { maxBlocks: 22 },
        },
        rexLines: {
          intro: "Boss final. 3 cristaux. Respire, planifie, code.",
          onSuccess: "MASTER CODEUR. Bienvenue dans le club. Tu es prêt pour Silica.",
          onError: "Un cristal manque. Re-planifie ton trajet.",
        },
      },
    },
  ],
};

module.exports = { module1 };
