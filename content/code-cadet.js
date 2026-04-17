// Content pack : Code Cadet · Minecraft Protocol — Module 1
// 5 missions (4 quests + 1 boss) pour la préparation au camp d'été 2026.
// Avatar : Commandant Rex (QC, francophone).
// Concepts couverts : séquence, action, direction, répétition (boucle).
//
// Structure du champ `data` de chaque lesson :
// {
//   briefing: { text, avatarClip? },
//   world: { tileset, cols, rows, start: {x,y,dir}, goal: {x,y}, items[], obstacles[] },
//   toolbox: { categories: [{ name, colour, blocks: [{ type, params? }] }] },
//   starter: { xml } | null,          // XML Blockly pré-chargé
//   success: { type: 'reachGoal'|'collectAll'|'customCondition', rules, maxBlocks?, maxCommands? },
//   hints: [string, string, string, string],   // 4 niveaux : indice → solution
//   xpMax: number,
//   stars: { gold: { maxBlocks }, silver: {...}, bronze: {...} },
//   concept: string,
//   rexLines: { intro, onSuccess, onError }    // micro-dialogues (TTS fallback)
// }

const module1 = {
  module: {
    slug: 'code-cadet',
    title: 'Code Cadet',
    subtitle: 'Minecraft Protocol',
    description:
      "Prépare-toi au camp de programmation Minecraft. Avec le Commandant Rex, tu apprends à donner des ordres à ton avatar dans la Zone Cube : marcher, tourner, répéter, résoudre des énigmes. Rien ne bouge tant que TU n'écris pas le code.",
    coverColor: '#4ADE80',
    coverIcon: 'cube',
    version: '1.0.0',
    language: 'fr-CA',
    avatarKey: 'rex-commandant',
    order: 1,
    status: 'ACTIVE',
  },
  lessons: [
    // === MISSION 1 — RÉVEILLER REX ===
    {
      slug: 'reveiller-rex',
      chapter: 1,
      order: 1,
      kind: 'QUEST',
      title: 'Réveiller Rex',
      subtitle: "La toute première ligne de code de ta vie.",
      conceptKey: 'sequence',
      data: {
        briefing: {
          text:
            "Salut, cadet. Je suis le Commandant Rex. Pour me réveiller, tu vas glisser UN bloc « Au début » et UN bloc « Dire ». C'est ton tout premier ordre. Prêt ?",
          avatarClip: 'rex-intro-mission-1',
        },
        world: {
          tileset: 'plaine',
          cols: 5,
          rows: 5,
          start: { x: 2, y: 2, dir: 'south' },
          goal: null,
          items: [],
          obstacles: [],
          backgroundMusic: 'plaine-calm',
        },
        toolbox: {
          categories: [
            {
              name: 'Événements',
              colour: '#F59E0B',
              blocks: [{ type: 'event_start' }],
            },
            {
              name: 'Actions',
              colour: '#4ADE80',
              blocks: [{ type: 'rex_say', params: { text: 'Bonjour Rex!' } }],
            },
          ],
        },
        starter: null,
        success: {
          type: 'customCondition',
          rules: { containsBlock: ['event_start', 'rex_say'], chainedUnderStart: true },
          maxBlocks: 2,
        },
        hints: [
          "Commence par le bloc orange « Au début ». C'est le déclencheur.",
          "Glisse maintenant le bloc vert « Dire » SOUS le bloc orange pour qu'ils se collent.",
          "Les deux blocs doivent être accrochés ensemble comme un train. Puis clique ▶ Jouer.",
          "Voici la solution : 1) bloc orange « Au début » en haut. 2) bloc vert « Dire Bonjour Rex! » collé dessous. 3) clic sur ▶ Jouer.",
        ],
        xpMax: 20,
        stars: {
          gold: { maxBlocks: 2 },
          silver: { maxBlocks: 3 },
          bronze: { maxBlocks: 5 },
        },
        rexLines: {
          intro: "Réveille-moi avec un Bonjour, cadet !",
          onSuccess: "Bien joué. Tu viens d'écrire ta première ligne de code.",
          onError: "Pas encore. On est une équipe — réessaie, tu es proche.",
        },
      },
    },

    // === MISSION 2 — PREMIER PAS ===
    {
      slug: 'premier-pas',
      chapter: 1,
      order: 2,
      kind: 'QUEST',
      title: 'Premier pas',
      subtitle: "Un ordre de mouvement. Rex avance d'une case.",
      conceptKey: 'action',
      data: {
        briefing: {
          text:
            "Vois-tu ce cristal brillant devant moi ? Je dois le toucher. Donne-moi l'ordre d'avancer d'UNE case.",
          avatarClip: 'rex-intro-mission-2',
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
          "« Au début » + UN bloc mouvement, ça devrait suffire.",
          "Le bloc bleu « Avancer » fait bouger Rex d'une case dans la direction où il regarde.",
          "Rex regarde vers l'est (→). Une seule avance suffit pour atteindre le cristal.",
          "Solution : « Au début » + « Avancer d'une case ». C'est tout.",
        ],
        xpMax: 25,
        stars: {
          gold: { maxBlocks: 2 },
          silver: { maxBlocks: 3 },
          bronze: { maxBlocks: 5 },
        },
        rexLines: {
          intro: "Un pas. Juste un. Tu peux le faire.",
          onSuccess: "Parfait. Tu viens de contrôler un personnage avec du code.",
          onError: "Presque. Vérifie le nombre de cases — Rex a peut-être trop marché.",
        },
      },
    },

    // === MISSION 3 — TOURNER ===
    {
      slug: 'tourner',
      chapter: 1,
      order: 3,
      kind: 'QUEST',
      title: 'Tourner',
      subtitle: "Changer de direction avant d'avancer.",
      conceptKey: 'direction',
      data: {
        briefing: {
          text:
            "Le cristal est à ma droite cette fois. Je regarde devant. Tu vas m'ordonner de TOURNER À DROITE puis d'avancer.",
          avatarClip: 'rex-intro-mission-3',
        },
        world: {
          tileset: 'plaine',
          cols: 5,
          rows: 5,
          start: { x: 2, y: 2, dir: 'north' },
          goal: { x: 3, y: 2 },
          items: [{ type: 'crystal', x: 3, y: 2, color: 'green' }],
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
          type: 'reachGoal',
          rules: { reach: { x: 3, y: 2 } },
          maxBlocks: 3,
        },
        hints: [
          "Rex regarde vers le haut (N). Le cristal est à sa droite (E).",
          "« Tourner à droite » change la direction sans bouger Rex.",
          "Ordre des blocs : tourner à droite, PUIS avancer.",
          "Solution : « Au début » + « Tourner à droite » + « Avancer ».",
        ],
        xpMax: 30,
        stars: {
          gold: { maxBlocks: 3 },
          silver: { maxBlocks: 4 },
          bronze: { maxBlocks: 6 },
        },
        rexLines: {
          intro: "Tourne, avance. Deux ordres. Dans cet ordre.",
          onSuccess: "Excellent. Tu gères maintenant la direction.",
          onError: "Vérifie l'ordre : tourner d'abord, avancer ensuite.",
        },
      },
    },

    // === MISSION 4 — TROIS PAS ===
    {
      slug: 'trois-pas',
      chapter: 1,
      order: 4,
      kind: 'QUEST',
      title: 'Trois pas',
      subtitle: "Répéter un ordre pour aller plus loin.",
      conceptKey: 'repetition',
      data: {
        briefing: {
          text:
            "Le cristal est à 3 cases devant moi. Tu peux poser 3 blocs « Avancer »… ou découvrir un SECRET : le bloc « Répéter ».",
          avatarClip: 'rex-intro-mission-4',
        },
        world: {
          tileset: 'foret',
          cols: 6,
          rows: 3,
          start: { x: 0, y: 1, dir: 'east' },
          goal: { x: 3, y: 1 },
          items: [{ type: 'crystal', x: 3, y: 1, color: 'purple' }],
          obstacles: [],
          backgroundMusic: 'foret-mysterieux',
        },
        toolbox: {
          categories: [
            { name: 'Événements', colour: '#F59E0B', blocks: [{ type: 'event_start' }] },
            {
              name: 'Mouvement',
              colour: '#60A5FA',
              blocks: [{ type: 'rex_move_forward' }, { type: 'rex_turn_right' }, { type: 'rex_turn_left' }],
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
          "Tu peux faire 3 « Avancer » collés. Ça marche mais c'est long.",
          "Essaie le bloc violet « Répéter ». Mets « Avancer » à l'intérieur.",
          "Règle le nombre de répétitions à 3.",
          "Solution optimale : « Au début » + « Répéter 3 fois { Avancer } ». 3 blocs au total pour 3 étoiles.",
        ],
        xpMax: 40,
        stars: {
          gold: { maxBlocks: 3 }, // avec boucle
          silver: { maxBlocks: 4 },
          bronze: { maxBlocks: 6 },
        },
        rexLines: {
          intro: "Répéter, c'est la magie du code. Essaie le bloc violet.",
          onSuccess: "Boum — tu viens de découvrir les BOUCLES. C'est énorme.",
          onError: "Compte les cases : exactement 3 avances, ni plus ni moins.",
        },
      },
    },

    // === MISSION 5 — BOSS DU PONT ===
    {
      slug: 'boss-du-pont',
      chapter: 1,
      order: 5,
      kind: 'BOSS',
      title: 'Boss du Pont',
      subtitle: "Traverse 5 cases de pont sans tomber. Avec une boucle.",
      conceptKey: 'repetition-applied',
      data: {
        briefing: {
          text:
            "Premier boss, cadet. Ce pont fait 5 cases. Tu DOIS utiliser une boucle « Répéter 5 fois » — sinon tombe à l'eau. Prouve-moi que tu maîtrises.",
          avatarClip: 'rex-intro-boss-pont',
        },
        world: {
          tileset: 'pont',
          cols: 7,
          rows: 3,
          start: { x: 0, y: 1, dir: 'east' },
          goal: { x: 5, y: 1 },
          items: [{ type: 'flag', x: 5, y: 1, color: 'gold' }],
          obstacles: [
            { type: 'water', x: 1, y: 0 },
            { type: 'water', x: 1, y: 2 },
            { type: 'water', x: 2, y: 0 },
            { type: 'water', x: 2, y: 2 },
            { type: 'water', x: 3, y: 0 },
            { type: 'water', x: 3, y: 2 },
            { type: 'water', x: 4, y: 0 },
            { type: 'water', x: 4, y: 2 },
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
          rules: { reach: { x: 5, y: 1 }, mustUseBlock: 'rex_repeat' },
          maxBlocks: 4,
        },
        hints: [
          "Le pont fait 5 cases. Compte bien.",
          "Le bloc violet « Répéter » est obligatoire pour gagner 3 étoiles (et pour passer le boss).",
          "Mets « Avancer » à l'intérieur du « Répéter 5 fois ».",
          "Solution : « Au début » + « Répéter 5 fois { Avancer } ». 3 blocs, 3 étoiles, boss battu.",
        ],
        xpMax: 80,
        stars: {
          gold: { maxBlocks: 3, mustUse: ['rex_repeat'] },
          silver: { maxBlocks: 4 },
          bronze: { maxBlocks: 6 },
        },
        rexLines: {
          intro: "Premier boss. Respire. Utilise la boucle.",
          onSuccess: "BOSS BATTU. Tu viens d'entrer dans le club des codeurs, cadet.",
          onError: "Rex est tombé à l'eau. C'est pas grave — réessaie. Pense BOUCLE.",
        },
      },
    },
  ],
};

module.exports = { module1 };
