// Routes /carriere — veille emploi + suivi des candidatures (app privée de Martin).
//
// Deux portes d'entrée :
//   1. Martin (JWT) : il faut l'app `carriere` dans UserApp (Martin seulement au seed)
//      ET les données sont filtrées par ownerId = req.user.id. Un autre membre à qui
//      on donnerait l'app verrait un dossier vide, jamais celui de Martin.
//   2. La VEILLE (tâche Claude planifiée) : en-tête X-Carriere-Token = env
//      CARRIERE_VEILLE_TOKEN. Elle écrit dans le dossier de Martin (martin@logifox.io).
//
// Règles métier (mandat Martin 2026-10-07) :
//   - Les actions manuelles de Martin priment : tout champ qu'il modifie entre dans
//     `verrous` et la veille ne l'écrase plus jamais.
//   - La veille ne touche JAMAIS à l'étape de la démarche, aux notes, documents,
//     candidature, contacts, entrevues ni à la prochaine action.
//   - Une annonce expirée ne ferme pas une candidature : seules les offres encore
//     à REPEREE / A_ANALYSER sont archivées automatiquement.
//   - Les étapes « envoyée » et suivantes exigent une confirmation écrite (preuve).
//   - Rien n'est supprimé : corrections = événements annulés + nouvel événement.
//
// Martin (JWT) :
//   GET    /carriere/offres                 -> { offres, journal }
//   GET    /carriere/offres/:id             -> { offre }
//   POST   /carriere/offres                 -> création manuelle (409 si doublon)
//   PATCH  /carriere/offres/:id             -> modification (verrouille les champs touchés)
//   POST   /carriere/offres/:id/etape       -> { etape, date?, confirmation?, note? }
//   POST   /carriere/offres/:id/evenements  -> { type: NOTE|ECHANGE|ENTREVUE, date?, details }
//   PATCH  /carriere/evenements/:id         -> { date?, annule?, raison? } (correction)
//   GET    /carriere/export                 -> dossier complet (JSON)
// Veille (X-Carriere-Token) :
//   GET    /carriere/veille/contexte        -> offres connues (clés de déduplication)
//   POST   /carriere/veille/offres          -> { offres: [...] } upsert dédupliqué
//   POST   /carriere/veille/journal         -> { texte, details } rapport de couverture

const express = require('express');
const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');
const auth = require('../middleware/auth');

const prisma = new PrismaClient();
const router = express.Router();

const APP_SLUG = 'carriere';
const MARTIN_EMAIL = 'martin@logifox.io';

const ETAPES = [
  'REPEREE', 'A_ANALYSER', 'RETENUE', 'EN_PREPARATION', 'ENVOYEE', 'PRESELECTION',
  'ENTREVUE', 'EVALUATION', 'OFFRE', 'NEGOCIATION', 'ACCEPTEE', 'REFUS_EMPLOYEUR', 'RETIREE_MOI',
];
// Étapes qui affirment un fait externe : preuve écrite obligatoire.
const ETAPES_PREUVE = new Set(['ENVOYEE', 'PRESELECTION', 'ENTREVUE', 'EVALUATION', 'OFFRE', 'NEGOCIATION', 'ACCEPTEE', 'REFUS_EMPLOYEUR']);
const DISPOS = ['A_VERIFIER', 'ACTIVE', 'EXPIREE', 'RETIREE', 'INCONNUE'];
const PERTINENCES = ['PRIORITAIRE', 'A_CLARIFIER', 'EXPLORATION', 'ECART', 'HORS_RECO'];

// Champs que la veille peut alimenter (jamais les champs de démarche).
const CHAMPS_VEILLE = [
  'employeur', 'titre', 'lieu', 'url', 'annonceId', 'description', 'exigences', 'salaire',
  'salaireMin', 'salaireMax', 'contrat', 'formule', 'deplacements', 'analyse', 'pertinence',
  'dispo', 'dispoPreuve', 'derniereVerif', 'echeance',
];
// Changements à signaler explicitement dans l'historique.
const CHAMPS_IMPORTANTS = new Set(['salaire', 'salaireMin', 'salaireMax', 'contrat', 'formule', 'deplacements', 'echeance', 'dispo', 'lieu', 'titre']);
// Champs modifiables par Martin.
const CHAMPS_MANUELS = [
  ...CHAMPS_VEILLE, 'documents', 'candidature', 'contacts', 'entrevues', 'notes',
  'prochaineAction', 'actionResponsable', 'actionDate', 'archive', 'decouverteLe',
];
const CHAMPS_DATE = new Set(['derniereVerif', 'echeance', 'actionDate', 'decouverteLe']);
const CHAMPS_INT = new Set(['salaireMin', 'salaireMax']);
const CHAMPS_JSON = new Set(['analyse', 'dispoPreuve', 'documents', 'candidature', 'contacts', 'entrevues']);

/* ───────── utilitaires ───────── */

function norm(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\(e\)|\(ere\)|\(euse\)|\(trice\)|\(ne\)/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
function cleDe(employeur, titre) {
  return `${norm(employeur)}|${norm(titre)}`;
}

// « 2026-10-14 » -> midi UTC (évite les décalages de fuseau d'un jour).
function toDate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return new Date(`${v}T12:00:00Z`);
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

// Date d'un événement : « aujourd'hui » (date seule) garde l'heure réelle pour
// conserver l'ordre chronologique; une date passée/future = midi UTC.
function dateEvenement(v) {
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const ajd = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    if (v === ajd) return new Date();
  }
  return toDate(v) || new Date();
}

function coerce(champ, v) {
  if (CHAMPS_DATE.has(champ)) return toDate(v);
  if (CHAMPS_INT.has(champ)) {
    if (v === null || v === '' || v === undefined) return null;
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? n : undefined;
  }
  if (CHAMPS_JSON.has(champ)) return v === undefined ? undefined : v;
  if (champ === 'archive') return Boolean(v);
  if (v === null) return null;
  if (v === undefined) return undefined;
  return String(v).slice(0, 20000);
}

function same(a, b) {
  if (a instanceof Date || b instanceof Date) {
    const ta = a ? new Date(a).getTime() : null;
    const tb = b ? new Date(b).getTime() : null;
    return ta === tb;
  }
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function court(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 300 ? `${s.slice(0, 297)}...` : s;
}

function valider(champ, v) {
  if (champ === 'dispo' && v !== null && !DISPOS.includes(v)) return `Disponibilité invalide : ${v}`;
  if (champ === 'pertinence' && v !== null && !PERTINENCES.includes(v)) return `Pertinence invalide : ${v}`;
  if (v === undefined) return `Valeur invalide pour ${champ}`;
  return null;
}

function tokenOk(req) {
  const attendu = process.env.CARRIERE_VEILLE_TOKEN;
  if (!attendu) return null;
  const a = Buffer.from(String(req.headers['x-carriere-token'] || ''));
  const b = Buffer.from(attendu);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ───────── VEILLE (jeton) — monté AVANT l'auth JWT ───────── */

const veille = express.Router();

veille.use(async (req, res, next) => {
  const ok = tokenOk(req);
  if (ok === null) return res.status(503).json({ erreur: 'Veille non configurée (CARRIERE_VEILLE_TOKEN manquant).' });
  if (!ok) return res.status(401).json({ erreur: 'Jeton de veille invalide.' });
  try {
    const martin = await prisma.user.findUnique({ where: { email: MARTIN_EMAIL }, select: { id: true } });
    if (!martin) return res.status(500).json({ erreur: 'Propriétaire introuvable.' });
    req.ownerId = martin.id;
    next();
  } catch (e) {
    console.error('carriere veille owner', e);
    res.status(500).json({ erreur: 'Erreur serveur.' });
  }
});

veille.get('/contexte', async (req, res) => {
  try {
    const offres = await prisma.carriereOffre.findMany({
      where: { ownerId: req.ownerId },
      select: {
        id: true, cle: true, employeur: true, titre: true, lieu: true, url: true, annonceId: true,
        sources: true, dispo: true, etape: true, pertinence: true, echeance: true, salaire: true,
        derniereVerif: true, archive: true, verrous: true,
      },
      orderBy: { id: 'asc' },
    });
    res.json({ offres, etapes: ETAPES, dispos: DISPOS, pertinences: PERTINENCES });
  } catch (e) {
    console.error('carriere contexte', e);
    res.status(500).json({ erreur: 'Erreur serveur.' });
  }
});

// Trouve l'offre existante correspondant à une publication entrante.
function trouver(existantes, o) {
  const srcs = Array.isArray(o.sources) ? o.sources : [];
  const ids = new Set(srcs.filter((s) => s && s.id).map((s) => `${norm(s.source)}:${String(s.id).trim()}`));
  const urls = new Set([o.url, ...srcs.map((s) => s && s.url)].filter(Boolean).map((u) => String(u).trim()));
  if (o.annonceId) ids.add(`*:${String(o.annonceId).trim()}`);

  // 1. Même identifiant d'annonce ou même URL => même publication.
  for (const e of existantes) {
    const es = Array.isArray(e.sources) ? e.sources : [];
    if (e.url && urls.has(e.url)) return { offre: e, motif: 'url' };
    for (const s of es) {
      if (s && s.url && urls.has(String(s.url).trim())) return { offre: e, motif: 'url' };
      if (s && s.id && (ids.has(`${norm(s.source)}:${String(s.id).trim()}`) || ids.has(`*:${String(s.id).trim()}`))) return { offre: e, motif: 'identifiant' };
    }
    if (e.annonceId && (ids.has(`*:${String(e.annonceId).trim()}`))) return { offre: e, motif: 'identifiant' };
  }
  // 2. Même employeur + même titre => même poste publié ailleurs, sauf si l'ancienne
  //    fiche est fermée et que celle-ci est une NOUVELLE publication distincte.
  const cle = o.cle || cleDe(o.employeur, o.titre);
  const memes = existantes.filter((e) => e.cle === cle || e.cle.startsWith(`${cle}#`));
  const ouverte = memes.find((e) => !e.archive && !['EXPIREE', 'RETIREE'].includes(e.dispo));
  if (ouverte) return { offre: ouverte, motif: 'employeur+titre' };
  if (memes.length) return { offre: null, republication: memes[memes.length - 1], cle: `${cle}#${memes.length + 1}` };
  return { offre: null, cle };
}

function fusionSources(anciennes, nouvelles) {
  const out = Array.isArray(anciennes) ? [...anciennes] : [];
  for (const s of Array.isArray(nouvelles) ? nouvelles : []) {
    if (!s) continue;
    const k = `${norm(s.source)}|${s.id || ''}|${s.url || ''}`;
    const i = out.findIndex((x) => `${norm(x.source)}|${x.id || ''}|${x.url || ''}` === k);
    if (i >= 0) out[i] = { ...out[i], ...s };
    else out.push(s);
  }
  return out;
}

veille.post('/offres', async (req, res) => {
  const liste = Array.isArray(req.body && req.body.offres) ? req.body.offres : null;
  if (!liste) return res.status(400).json({ erreur: 'Champ offres (tableau) requis.' });
  if (liste.length > 200) return res.status(400).json({ erreur: 'Maximum 200 offres par envoi.' });

  const rapport = { creees: [], misesAJour: [], inchangees: [], erreurs: [] };
  try {
    const existantes = await prisma.carriereOffre.findMany({ where: { ownerId: req.ownerId } });

    for (const o of liste) {
      try {
        if (!o || !o.employeur || !o.titre) throw new Error('employeur et titre requis');
        const data = {};
        for (const champ of CHAMPS_VEILLE) {
          if (!(champ in o)) continue;
          const v = coerce(champ, o[champ]);
          const err = valider(champ, v);
          if (err) throw new Error(err);
          data[champ] = v;
        }
        const t = trouver(existantes, o);

        if (!t.offre) {
          // Nouvelle opportunité : toujours à l'étape REPEREE, jamais plus loin.
          const creee = await prisma.carriereOffre.create({
            data: {
              ...data,
              ownerId: req.ownerId,
              cle: t.cle,
              sources: fusionSources([], o.sources),
              etape: 'REPEREE',
              archive: ['EXPIREE', 'RETIREE'].includes(data.dispo),
              evenements: {
                create: [{
                  type: 'DECOUVERTE', a: 'REPEREE', auteur: 'Veille',
                  details: {
                    motif: o.motifDecouverte || null,
                    republicationDe: t.republication ? t.republication.id : null,
                  },
                }],
              },
            },
          });
          existantes.push(creee);
          rapport.creees.push({ id: creee.id, employeur: creee.employeur, titre: creee.titre, republicationDe: t.republication ? t.republication.id : null });
          continue;
        }

        const e = t.offre;
        const verrous = new Set(Array.isArray(e.verrous) ? e.verrous : []);
        const maj = {};
        const changements = [];
        for (const [champ, v] of Object.entries(data)) {
          if (verrous.has(champ)) continue; // Martin a la priorité
          if (champ === 'employeur' || champ === 'titre') continue; // identité de la fiche (clé de déduplication)
          if (v === null && e[champ] !== null && champ !== 'dispoPreuve') continue; // ne pas effacer une info connue
          if (same(e[champ], v)) continue;
          maj[champ] = v;
          if (champ !== 'derniereVerif' && champ !== 'dispoPreuve') {
            changements.push({ champ, de: court(e[champ]), a: court(v), important: CHAMPS_IMPORTANTS.has(champ) });
          }
        }
        const src = fusionSources(e.sources, o.sources);
        if (!same(src, e.sources)) maj.sources = src;

        // Annonce fermée : on n'archive que si la démarche n'a pas commencé.
        const dispoFinale = maj.dispo || e.dispo;
        if (['EXPIREE', 'RETIREE'].includes(dispoFinale) && ['REPEREE', 'A_ANALYSER'].includes(e.etape) && !e.archive && !verrous.has('archive')) {
          maj.archive = true;
          changements.push({ champ: 'archive', de: 'false', a: 'true', important: true });
        }

        if (!Object.keys(maj).length) {
          rapport.inchangees.push({ id: e.id });
          continue;
        }
        const evts = changements.map((c) => ({
          type: c.champ === 'dispo' ? 'DISPO' : 'VEILLE_MODIF',
          de: c.de, a: c.a, auteur: 'Veille',
          details: { champ: c.champ, important: c.important, motif: t.motif },
        }));
        const u = await prisma.carriereOffre.update({
          where: { id: e.id },
          data: { ...maj, ...(evts.length ? { evenements: { create: evts } } : {}) },
        });
        Object.assign(e, u);
        rapport.misesAJour.push({ id: e.id, motif: t.motif, changements });
      } catch (err) {
        rapport.erreurs.push({ employeur: o && o.employeur, titre: o && o.titre, erreur: err.message });
      }
    }
    res.json(rapport);
  } catch (e) {
    console.error('carriere veille offres', e);
    res.status(500).json({ erreur: 'Erreur serveur.', rapport });
  }
});

veille.post('/journal', async (req, res) => {
  const texte = String((req.body && req.body.texte) || '').trim();
  if (!texte) return res.status(400).json({ erreur: 'texte requis.' });
  try {
    const j = await prisma.carriereJournal.create({
      data: { ownerId: req.ownerId, type: String(req.body.type || 'VEILLE').slice(0, 30), texte: texte.slice(0, 20000), details: req.body.details ?? null },
    });
    res.json({ id: j.id });
  } catch (e) {
    console.error('carriere journal', e);
    res.status(500).json({ erreur: 'Erreur serveur.' });
  }
});

router.use('/veille', veille);

/* ───────── MARTIN (JWT) ───────── */

async function accesCarriere(req, res, next) {
  try {
    if (!req.user || req.user.profile === 'CHILD' || req.user.profile === 'GUEST') {
      return res.status(403).json({ erreur: 'Accès réservé.' });
    }
    const ua = await prisma.userApp.findFirst({
      where: { userId: req.user.id, hasAccess: true, app: { slug: APP_SLUG } },
      select: { id: true },
    });
    if (!ua) return res.status(403).json({ erreur: 'Accès réservé.' });
    next();
  } catch (e) {
    console.error('carriere acces', e);
    res.status(500).json({ erreur: 'Erreur serveur.' });
  }
}

router.use(auth, accesCarriere);

const INCLURE = { evenements: { orderBy: [{ date: 'asc' }, { id: 'asc' }] } };

async function charger(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) { res.status(400).json({ erreur: 'Identifiant invalide.' }); return null; }
  const o = await prisma.carriereOffre.findFirst({ where: { id, ownerId: req.user.id }, include: INCLURE });
  if (!o) { res.status(404).json({ erreur: 'Opportunité introuvable.' }); return null; }
  return o;
}

router.get('/offres', async (req, res) => {
  try {
    const [offres, journal] = await Promise.all([
      prisma.carriereOffre.findMany({ where: { ownerId: req.user.id }, include: INCLURE, orderBy: { id: 'asc' } }),
      prisma.carriereJournal.findMany({ where: { ownerId: req.user.id }, orderBy: { createdAt: 'desc' }, take: 30 }),
    ]);
    res.json({ offres, journal, etapes: ETAPES });
  } catch (e) {
    console.error('carriere list', e);
    res.status(500).json({ erreur: 'Erreur serveur.' });
  }
});

router.get('/offres/:id', async (req, res) => {
  try {
    const o = await charger(req, res);
    if (o) res.json({ offre: o });
  } catch (e) {
    console.error('carriere get', e);
    res.status(500).json({ erreur: 'Erreur serveur.' });
  }
});

function lireChamps(body, liste) {
  const data = {};
  for (const champ of liste) {
    if (!(champ in body)) continue;
    const v = coerce(champ, body[champ]);
    const err = valider(champ, v);
    if (err) throw Object.assign(new Error(err), { status: 400 });
    data[champ] = v;
  }
  return data;
}

router.post('/offres', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.employeur || !b.titre) return res.status(400).json({ erreur: 'Employeur et titre requis.' });
    const data = lireChamps(b, CHAMPS_MANUELS);
    const cle = cleDe(b.employeur, b.titre);
    const dup = await prisma.carriereOffre.findFirst({ where: { ownerId: req.user.id, cle }, select: { id: true } });
    if (dup) return res.status(409).json({ erreur: 'Cette opportunité existe déjà.', id: dup.id });
    const etape = ETAPES.includes(b.etape) && !ETAPES_PREUVE.has(b.etape) ? b.etape : 'REPEREE';
    const o = await prisma.carriereOffre.create({
      data: {
        ...data,
        ownerId: req.user.id,
        cle,
        etape,
        sources: Array.isArray(b.sources) ? b.sources : (b.url ? [{ source: 'manuel', url: b.url, id: b.annonceId || null }] : []),
        verrous: Object.keys(data), // tout ce que Martin saisit lui appartient
        evenements: { create: [{ type: 'CREATION', a: etape, auteur: req.user.firstName || 'Martin' }] },
      },
      include: INCLURE,
    });
    res.status(201).json({ offre: o });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ erreur: e.message });
    console.error('carriere create', e);
    res.status(500).json({ erreur: 'Erreur serveur.' });
  }
});

router.patch('/offres/:id', async (req, res) => {
  try {
    const o = await charger(req, res);
    if (!o) return;
    const b = req.body || {};
    if ('etape' in b) return res.status(400).json({ erreur: "Utiliser /etape pour changer l'étape." });
    const data = lireChamps(b, CHAMPS_MANUELS);
    const verrous = new Set(Array.isArray(o.verrous) ? o.verrous : []);
    const evts = [];
    const maj = {};
    for (const [champ, v] of Object.entries(data)) {
      if (same(o[champ], v)) continue;
      maj[champ] = v;
      verrous.add(champ);
      evts.push({
        type: champ === 'dispo' ? 'DISPO' : 'MODIF', de: court(o[champ]), a: court(v),
        auteur: req.user.firstName || 'Martin', details: { champ, important: CHAMPS_IMPORTANTS.has(champ) },
      });
    }
    if (!Object.keys(maj).length) return res.json({ offre: o });
    if (b.employeur || b.titre) {
      const cle = cleDe(maj.employeur || o.employeur, maj.titre || o.titre);
      const base = o.cle.split('#')[0];
      if (cle !== base) {
        const dup = await prisma.carriereOffre.findFirst({ where: { ownerId: req.user.id, cle, NOT: { id: o.id } }, select: { id: true } });
        if (dup) return res.status(409).json({ erreur: 'Une autre fiche porte déjà cet employeur et ce titre.', id: dup.id });
        maj.cle = cle;
      }
    }
    const u = await prisma.carriereOffre.update({
      where: { id: o.id },
      data: { ...maj, verrous: [...verrous], evenements: { create: evts } },
      include: INCLURE,
    });
    res.json({ offre: u });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ erreur: e.message });
    console.error('carriere patch', e);
    res.status(500).json({ erreur: 'Erreur serveur.' });
  }
});

router.post('/offres/:id/etape', async (req, res) => {
  try {
    const o = await charger(req, res);
    if (!o) return;
    const b = req.body || {};
    if (!ETAPES.includes(b.etape)) return res.status(400).json({ erreur: 'Étape invalide.' });
    if (b.etape === o.etape) return res.json({ offre: o });
    const confirmation = String(b.confirmation || '').trim();
    if (ETAPES_PREUVE.has(b.etape) && !confirmation) {
      return res.status(400).json({ erreur: 'Cette étape exige une confirmation (ex. courriel reçu, date d’envoi, invitation).' });
    }
    const date = dateEvenement(b.date);
    const extra = {};
    if (b.etape === 'ENVOYEE') {
      const c = (o.candidature && typeof o.candidature === 'object') ? o.candidature : {};
      if (!c.date) extra.candidature = { ...c, date: date.toISOString().slice(0, 10) };
    }
    if (o.archive && !['REFUS_EMPLOYEUR', 'RETIREE_MOI'].includes(b.etape)) extra.archive = false;
    const u = await prisma.carriereOffre.update({
      where: { id: o.id },
      data: {
        etape: b.etape,
        ...extra,
        evenements: {
          create: [{
            type: 'ETAPE', de: o.etape, a: b.etape, date, auteur: req.user.firstName || 'Martin',
            details: { confirmation: confirmation || null, note: b.note ? String(b.note).slice(0, 4000) : null },
          }],
        },
      },
      include: INCLURE,
    });
    res.json({ offre: u });
  } catch (e) {
    console.error('carriere etape', e);
    res.status(500).json({ erreur: 'Erreur serveur.' });
  }
});

router.post('/offres/:id/evenements', async (req, res) => {
  try {
    const o = await charger(req, res);
    if (!o) return;
    const b = req.body || {};
    const type = ['NOTE', 'ECHANGE', 'ENTREVUE'].includes(b.type) ? b.type : null;
    if (!type) return res.status(400).json({ erreur: 'Type invalide (NOTE, ECHANGE ou ENTREVUE).' });
    const date = dateEvenement(b.date);
    const u = await prisma.carriereOffre.update({
      where: { id: o.id },
      data: { evenements: { create: [{ type, date, auteur: req.user.firstName || 'Martin', details: b.details ?? null }] } },
      include: INCLURE,
    });
    res.status(201).json({ offre: u });
  } catch (e) {
    console.error('carriere evenement', e);
    res.status(500).json({ erreur: 'Erreur serveur.' });
  }
});

// Correction d'un événement : date corrigée, ou annulation. Annuler le DERNIER
// changement d'étape remet la fiche à l'étape précédente. Rien n'est effacé.
router.patch('/evenements/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const ev = await prisma.carriereEvenement.findFirst({ where: { id, offre: { ownerId: req.user.id } }, include: { offre: true } });
    if (!ev) return res.status(404).json({ erreur: 'Événement introuvable.' });
    const b = req.body || {};
    const qui = req.user.firstName || 'Martin';
    const raison = b.raison ? String(b.raison).slice(0, 2000) : null;
    const ops = [];
    const data = {};
    if ('date' in b) {
      const d = toDate(b.date);
      if (!d) return res.status(400).json({ erreur: 'Date invalide.' });
      data.date = d;
      ops.push({ type: 'CORRECTION', auteur: qui, details: { evenementId: ev.id, champ: 'date', de: ev.date.toISOString(), a: d.toISOString(), raison } });
    }
    let nouvelleEtape = null;
    if (b.annule === true && !ev.annule) {
      data.annule = true;
      ops.push({ type: 'CORRECTION', auteur: qui, details: { evenementId: ev.id, action: 'annulation', raison } });
      if (ev.type === 'ETAPE') {
        const dernier = await prisma.carriereEvenement.findFirst({
          where: { offreId: ev.offreId, type: 'ETAPE', annule: false }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        });
        if (!dernier || dernier.id !== ev.id) return res.status(409).json({ erreur: "Seul le dernier changement d'étape peut être annulé." });
        nouvelleEtape = ev.de || 'REPEREE';
      }
    }
    if (!Object.keys(data).length) return res.status(400).json({ erreur: 'Rien à corriger.' });
    await prisma.$transaction([
      prisma.carriereEvenement.update({ where: { id: ev.id }, data }),
      prisma.carriereOffre.update({
        where: { id: ev.offreId },
        data: { ...(nouvelleEtape ? { etape: nouvelleEtape } : {}), evenements: { create: ops } },
      }),
    ]);
    const o = await prisma.carriereOffre.findUnique({ where: { id: ev.offreId }, include: INCLURE });
    res.json({ offre: o });
  } catch (e) {
    console.error('carriere correction', e);
    res.status(500).json({ erreur: 'Erreur serveur.' });
  }
});

router.get('/export', async (req, res) => {
  try {
    const [offres, journal] = await Promise.all([
      prisma.carriereOffre.findMany({ where: { ownerId: req.user.id }, include: INCLURE, orderBy: { id: 'asc' } }),
      prisma.carriereJournal.findMany({ where: { ownerId: req.user.id }, orderBy: { createdAt: 'asc' } }),
    ]);
    res.setHeader('Content-Disposition', `attachment; filename="carriere-export-${new Date().toISOString().slice(0, 10)}.json"`);
    res.json({ exporteLe: new Date().toISOString(), version: 1, offres, journal });
  } catch (e) {
    console.error('carriere export', e);
    res.status(500).json({ erreur: 'Erreur serveur.' });
  }
});

module.exports = router;
module.exports._interne = { norm, cleDe, trouver, ETAPES };
