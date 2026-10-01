// Routes /projet-chalet — l'app unifiée « Projet chalet » (2026-10-01).
//
// Elle regroupe Chantier Chalet (/chantier) et Notre Chalet (/pieces). Les
// données du chantier restent servies par /chantier et /pieces ; ce fichier
// ajoute ce qui est NOUVEAU :
//
//   ACCUEIL & TUILES
//   - GET    /projet-chalet/accueil          bande projet + tuiles visibles + compteurs dépôt + activité
//   - GET    /projet-chalet/sections         tuiles visibles pour moi (table ChaletSection)
//   - PATCH  /projet-chalet/sections/:slug   [proprio] renommer / réordonner / changer icône
//   - GET    /projet-chalet/pieces           pièces du chalet (table Piece) + nb d'entrées par pièce
//   - GET    /projet-chalet/plans/categories catégories de Plans & devis (libellé + icône)
//   - GET|POST|PATCH|DELETE /projet-chalet/reglements[/:id]   Ville & règlements
//   - GET    /projet-chalet/activite         journal (filtré par tuiles pour un invité)
//   - GET    /projet-chalet/recherche?q=     recherche dans tout ce que je peux voir
//
//   BOÎTE DE DÉPÔT (classée par Claude à 8 h, 12 h, 18 h, 22 h — heure de Montréal)
//   - GET    /projet-chalet/depot            proprio : tout ; invité : ses dépôts
//   - POST   /projet-chalet/depot            { description, fileName?, mimeType?, fileData? (data URL) }
//   - GET    /projet-chalet/depot/:id/fichier
//   - POST   /projet-chalet/depot/:id/valider   [proprio] applique la proposition de Claude
//   - POST   /projet-chalet/depot/:id/corriger  [proprio] { consigne } -> repasse en attente avec la consigne
//   - DELETE /projet-chalet/depot/:id        annuler un dépôt pas encore classé
//
//   CLASSEUR (tâche Claude planifiée) — en-tête X-Classeur-Token = env CHALET_CLASSEUR_TOKEN
//   - GET    /projet-chalet/classeur/depots            dépôts en attente
//   - GET    /projet-chalet/classeur/depots/:id/fichier
//   - GET    /projet-chalet/classeur/contexte          séries+versions (avec empreintes), jalons, métiers, contacts, pièces...
//   - POST   /projet-chalet/classeur/depots/:id/resultat  { statut, destination, raison, confiance, action }
//   - POST   /projet-chalet/classeur/resume            { texte } -> une ligne d'activité
//
//   INVITÉS & PARTAGE
//   - GET    /projet-chalet/membres          [proprio] propriétaires + invités et leurs tuiles
//   - POST   /projet-chalet/membres          [proprio] { nom, detail?, tuiles[], expireLe? } -> code d'invitation
//   - PUT    /projet-chalet/membres/:id/tuiles [proprio] { tuiles[] }
//   - PATCH  /projet-chalet/membres/:id      [proprio] { nom?, detail?, actif?, expireLe? }
//   - GET    /projet-chalet/invitation/:code (public) aperçu de l'invitation
//   - POST   /projet-chalet/invitation/:code (public) { username, password } -> crée le compte invité
//   - POST   /projet-chalet/partages         [proprio] { docId, jours } -> lien qui expire
//   - GET    /projet-chalet/partages         [proprio]
//   - DELETE /projet-chalet/partages/:id     [proprio] révoque
//   - GET    /projet-chalet/partage/:token   (public) sert le document tant que le lien est valide
//
// Règle d'or : rien n'est écrasé ni supprimé par le classement. Une nouvelle
// version s'ajoute à sa série ; un doublon (même empreinte) est relié à
// l'existant au lieu de créer une copie.

const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');
const { PrismaClient } = require('@prisma/client');
const auth = require('../middleware/auth');
const { APP_SLUG, chargerAcces, aTuile, exigerTuile, exigerProprio } = require('../middleware/projet-chalet-acces');
const chantier = require('./chantier');

const prisma = new PrismaClient();
const router = express.Router();

const { PLAN_CATEGORIES, sha256DataUrl, dataUrlSize, tuileDuDoc, autoriserCadre } = chantier;
const PROJECT_SLUG = 'chalet';
const HEURES_CLASSEMENT = [8, 12, 18, 22]; // heure de Montréal
const MAX_FICHIER_B64 = 60 * 1024 * 1024; // ~40 Mo de fichier (même limite que /chantier/docs)

// Libellés et icônes des catégories de Plans & devis (une seule source pour le frontend).
const CATEGORIES_PLANS = {
  ARCHITECTURE: { nom: 'Architecture', icone: 'compass-drafting' },
  IMPLANTATION: { nom: 'Implantation', icone: 'map-location-dot' },
  DESIGN_INTERIEUR: { nom: 'Design intérieur', icone: 'couch' },
  STRUCTURE: { nom: 'Structure', icone: 'building' },
  ELECTRIQUE: { nom: 'Électrique', icone: 'bolt' },
  MECANIQUE: { nom: 'Plomberie & mécanique', icone: 'faucet-drip' },
  PERMIS: { nom: 'Permis & licences', icone: 'stamp' },
  DEVIS: { nom: 'Devis', icone: 'file-invoice-dollar' },
  RENDUS_3D: { nom: 'Rendus', icone: 'cube' },
  AUTRE: { nom: 'Autre', icone: 'folder' },
};

// ---------------------------------------------------------------- utilitaires

function toInt(v, def = 0) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}
function parseDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}
function str(v, max = 2000) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}
async function getProject() {
  return prisma.chantierProject.findUnique({ where: { slug: PROJECT_SLUG } });
}
async function journal(texte, icone, tuile, auteur) {
  try {
    await prisma.activite.create({ data: { texte: String(texte).slice(0, 500), icone: icone || 'circle-info', tuile: tuile || null, auteur: auteur || null } });
  } catch (e) {
    console.error('projet-chalet journal', e.message);
  }
}
// Prochaine heure de classement, calculée à l'heure de Montréal.
function prochainClassement(now = new Date()) {
  const h = Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', hour: 'numeric', hour12: false }).format(now)) % 24;
  const p = HEURES_CLASSEMENT.find((x) => x > h);
  return p ? `${p} h` : `${HEURES_CLASSEMENT[0]} h demain`;
}
// Envoie le binaire d'un data URL (avec un nom de fichier propre).
function envoyerDataUrl(res, dataUrl, nom, telecharger) {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl || '');
  if (!m) return res.status(500).json({ erreur: 'Format de fichier invalide.' });
  const base = String(nom || 'fichier').replace(/[\r\n"]/g, '');
  const ascii = base.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7e]/g, '_');
  autoriserCadre(res);
  res.setHeader('Content-Type', m[1]);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.setHeader('Content-Disposition', (telecharger ? 'attachment' : 'inline') + '; filename="' + ascii + '"; filename*=UTF-8\'\'' + encodeURIComponent(base));
  return res.send(Buffer.from(m[2], 'base64'));
}
async function avancementBanque(projectId) {
  const items = await prisma.avancementItem.findMany({ where: { projectId }, select: { weight: true, pct: true } });
  return Math.round(items.reduce((acc, it) => acc + (it.weight * it.pct) / 100, 0) * 10) / 10;
}
async function sectionsVisibles(req) {
  const toutes = await prisma.chaletSection.findMany({ where: { actif: true }, orderBy: { ordre: 'asc' } });
  return toutes.filter((s) => aTuile(req, s.slug));
}

// ================================================================ PUBLIC
// (avant router.use(auth) : ces routes n'exigent pas de connexion)

const limiteInvitation = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });

router.get('/invitation/:code', limiteInvitation, async (req, res) => {
  const m = await prisma.chaletMembre.findUnique({ where: { code: String(req.params.code).toUpperCase() } });
  if (!m || !m.actif || m.userId || (m.expireLe && m.expireLe < new Date())) {
    return res.status(404).json({ erreur: 'Invitation introuvable, déjà utilisée ou expirée.' });
  }
  res.json({ nom: m.nom, detail: m.detail });
});

router.post('/invitation/:code', limiteInvitation, async (req, res) => {
  try {
    const code = String(req.params.code).toUpperCase();
    const m = await prisma.chaletMembre.findUnique({ where: { code } });
    if (!m || !m.actif || m.userId || (m.expireLe && m.expireLe < new Date())) {
      return res.status(404).json({ erreur: 'Invitation introuvable, déjà utilisée ou expirée.' });
    }
    const username = str(req.body && req.body.username, 40);
    const password = req.body && req.body.password ? String(req.body.password) : '';
    if (!username || !/^[A-Za-z0-9._-]{3,40}$/.test(username)) {
      return res.status(400).json({ erreur: "Nom d'utilisateur : 3 à 40 caractères (lettres, chiffres, . _ -)." });
    }
    if (password.length < 8) return res.status(400).json({ erreur: 'Mot de passe : 8 caractères minimum.' });
    const pris = await prisma.user.findFirst({ where: { username: { equals: username, mode: 'insensitive' } } });
    if (pris) return res.status(409).json({ erreur: "Ce nom d'utilisateur est déjà pris." });

    const app = await prisma.app.findUnique({ where: { slug: APP_SLUG } });
    const user = await prisma.user.create({
      data: {
        email: `invite-${m.id}-${crypto.randomBytes(4).toString('hex')}@invites.my-mission-control.com`,
        username,
        firstName: m.nom.slice(0, 60),
        password: await bcrypt.hash(password, 12),
        role: 'MEMBER',
        profile: 'GUEST',
      },
    });
    if (app) await prisma.userApp.create({ data: { userId: user.id, appId: app.id, hasAccess: true } });
    await prisma.chaletMembre.update({ where: { id: m.id }, data: { userId: user.id } });
    await journal(`${m.nom} a accepté son invitation`, 'user-check', null, m.nom);
    res.status(201).json({ ok: true, username });
  } catch (e) {
    console.error('projet-chalet invitation POST', e);
    res.status(500).json({ erreur: "Erreur lors de la création du compte." });
  }
});

router.get('/partage/:token', async (req, res) => {
  try {
    const lien = await prisma.partageLien.findUnique({ where: { token: String(req.params.token) } });
    if (!lien || lien.revoque) return res.status(404).json({ erreur: 'Lien introuvable.' });
    if (lien.expireLe < new Date()) return res.status(410).json({ erreur: 'Ce lien a expiré.' });
    const doc = await prisma.chantierDoc.findUnique({ where: { id: lien.docId } });
    if (!doc) return res.status(404).json({ erreur: 'Document introuvable.' });
    await prisma.partageLien.update({ where: { id: lien.id }, data: { vues: { increment: 1 } } });
    if (doc.fileUrl && !doc.fileData) return res.redirect(doc.fileUrl);
    return envoyerDataUrl(res, doc.fileData, doc.fileName || doc.title, !!req.query.download);
  } catch (e) {
    console.error('projet-chalet partage GET', e);
    res.status(500).json({ erreur: 'Erreur lors du chargement du document.' });
  }
});

// ================================================================ CLASSEUR (tâche Claude)

function exigerClasseur(req, res, next) {
  const attendu = process.env.CHALET_CLASSEUR_TOKEN;
  if (!attendu) return res.status(503).json({ erreur: 'Classeur non configuré (CHALET_CLASSEUR_TOKEN manquant).' });
  const recu = String(req.headers['x-classeur-token'] || '');
  const a = Buffer.from(recu), b = Buffer.from(attendu);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ erreur: 'Jeton du classeur invalide.' });
  next();
}

const classeur = express.Router();
classeur.use(exigerClasseur);

classeur.get('/depots', async (req, res) => {
  const depots = await prisma.depotItem.findMany({ where: { statut: 'EN_ATTENTE' }, orderBy: { createdAt: 'asc' } });
  res.json({ depots, heure: prochainClassement() });
});

classeur.get('/depots/:id/fichier', async (req, res) => {
  const d = await prisma.depotItem.findUnique({ where: { id: toInt(req.params.id) } });
  if (!d || !d.docId) return res.status(404).json({ erreur: 'Aucun fichier pour ce dépôt.' });
  const doc = await prisma.chantierDoc.findUnique({ where: { id: d.docId } });
  if (!doc || !doc.fileData) return res.status(404).json({ erreur: 'Fichier introuvable.' });
  return envoyerDataUrl(res, doc.fileData, doc.fileName || d.fileName, false);
});

// Tout ce qu'il faut pour décider où va un dépôt. Les empreintes manquantes des
// anciens documents sont calculées au passage (20 par appel, pour rester léger).
classeur.get('/contexte', async (req, res) => {
  try {
    const project = await getProject();
    const sansEmpreinte = await prisma.chantierDoc.findMany({
      where: { projectId: project.id, sha256: null, fileData: { not: null } }, select: { id: true }, take: 20,
    });
    for (const { id } of sansEmpreinte) {
      const d = await prisma.chantierDoc.findUnique({ where: { id }, select: { fileData: true } });
      if (d && d.fileData) await prisma.chantierDoc.update({ where: { id }, data: { sha256: sha256DataUrl(d.fileData) } });
    }
    const [series, jalons, trades, contacts, pieces, reglements] = await Promise.all([
      prisma.planSerie.findMany({
        where: { projectId: project.id },
        orderBy: [{ category: 'asc' }, { order: 'asc' }],
        include: { docs: { orderBy: [{ versionDate: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }], select: { id: true, version: true, versionDate: true, fileName: true, title: true, author: true, sha256: true, createdAt: true } } },
      }),
      prisma.jalon.findMany({ where: { projectId: project.id }, orderBy: [{ phase: 'asc' }, { order: 'asc' }], select: { id: true, name: true, phase: true, status: true, tradeId: true } }),
      prisma.trade.findMany({ where: { projectId: project.id }, orderBy: { order: 'asc' }, select: { id: true, name: true } }),
      prisma.contact.findMany({ where: { projectId: project.id }, select: { id: true, company: true, person: true, trade: true } }),
      prisma.piece.findMany({ orderBy: { ordre: 'asc' }, select: { slug: true, nom: true, etage: true, numero: true } }),
      prisma.reglement.findMany({ orderBy: { ordre: 'asc' }, select: { id: true, titre: true } }),
    ]);
    const autresDocs = await prisma.chantierDoc.findMany({
      where: { projectId: project.id, serieId: null, sha256: { not: null } }, select: { id: true, title: true, kind: true, sha256: true },
    });
    res.json({ categories: CATEGORIES_PLANS, series, autresDocs, jalons, trades, contacts, pieces, reglements, heures: HEURES_CLASSEMENT });
  } catch (e) {
    console.error('classeur/contexte', e);
    res.status(500).json({ erreur: 'Erreur lors du chargement du contexte.' });
  }
});

classeur.post('/depots/:id/resultat', async (req, res) => {
  try {
    const d = await prisma.depotItem.findUnique({ where: { id: toInt(req.params.id) } });
    if (!d) return res.status(404).json({ erreur: 'Dépôt introuvable.' });
    if (d.statut === 'CLASSE') return res.status(409).json({ erreur: 'Déjà classé.' });
    const { statut, destination, raison, confiance, action } = req.body || {};
    if (!['CLASSE', 'A_VALIDER'].includes(statut)) return res.status(400).json({ erreur: 'statut = CLASSE ou A_VALIDER.' });
    const base = { destination: str(destination, 300), raison: str(raison, 3000), confiance: typeof confiance === 'number' ? confiance : null, classePar: 'Claude (' + prochainClassementCourant() + ')' };
    if (statut === 'A_VALIDER') {
      const maj = await prisma.depotItem.update({ where: { id: d.id }, data: { ...base, statut: 'A_VALIDER', proposition: action || null } });
      return res.json({ depot: maj });
    }
    const resultat = await appliquerAction(d, action || { type: 'note' });
    const maj = await prisma.depotItem.update({ where: { id: d.id }, data: { ...base, statut: 'CLASSE', resultat, proposition: action || null, classeLe: new Date(), correction: null } });
    await journal(`Classé : ${maj.destination || d.fileName || 'dépôt'}`, 'wand-magic-sparkles', resultat.tuile, 'Claude');
    res.json({ depot: maj });
  } catch (e) {
    console.error('classeur/resultat', e);
    res.status(e.status || 500).json({ erreur: e.message || "Erreur lors de l'application du classement." });
  }
});

classeur.post('/resume', async (req, res) => {
  const texte = str(req.body && req.body.texte, 500);
  if (!texte) return res.status(400).json({ erreur: 'texte requis.' });
  await journal(texte, 'wand-magic-sparkles', null, 'Claude');
  res.json({ ok: true });
});

// Libellé de l'heure de classement en cours (la plus proche passée), pour « classé par Claude (12 h) ».
function prochainClassementCourant(now = new Date()) {
  const h = Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', hour: 'numeric', hour12: false }).format(now)) % 24;
  const passees = HEURES_CLASSEMENT.filter((x) => x <= h);
  return passees.length ? `${passees[passees.length - 1]} h` : `${HEURES_CLASSEMENT[HEURES_CLASSEMENT.length - 1]} h`;
}

// ---------------------------------------------------------------- appliquer un classement
// Une « action » dit où va le dépôt. Elle est appliquée par le classeur (statut CLASSE)
// ou quand un propriétaire valide une proposition. Retourne { tuile, ...ids créés }.
//
//   { type:'version', serieId | nouvelleSerie:{nom, categorie}, version, versionDate?, auteur?, notes?, kind? }
//   { type:'doublon', docId }                   même empreinte qu'un document existant
//   { type:'photo', jalonId?, titre? }
//   { type:'document', kind, jalonId?, tradeId?, titre? }
//   { type:'soumission', montant, label?, jalonId?, tradeId?, contactId? }
//   { type:'depense', montant, label?, jalonId?, tradeId?, depenseType?, payeLe? }
//   { type:'inspiration'|'requis'|'commentaire', pieceSlug, texte }
//   { type:'contact', company, person?, phone?, email?, website?, trade?, notes? }
//   { type:'reglement', titre, source?, lien?, detail? }
//   { type:'note' }                             rien à ranger (ex. simple note)
function erreur(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

async function appliquerAction(depot, action) {
  const project = await getProject();
  const doc = depot.docId ? await prisma.chantierDoc.findUnique({ where: { id: depot.docId } }) : null;
  const noteDepot = `Dépôt #${depot.id} (${depot.auteurNom}) : ${depot.description}`;
  const majDoc = (data) => (doc ? prisma.chantierDoc.update({ where: { id: doc.id }, data: { notes: doc.notes || noteDepot, ...data } }) : null);
  const t = action && action.type;

  if (t === 'version') {
    if (!doc) throw erreur(400, 'Une version demande un fichier.');
    let serieId = toInt(action.serieId, 0);
    if (!serieId && action.nouvelleSerie) {
      const cat = PLAN_CATEGORIES.includes(action.nouvelleSerie.categorie) ? action.nouvelleSerie.categorie : 'AUTRE';
      const s = await prisma.planSerie.create({ data: { projectId: project.id, name: str(action.nouvelleSerie.nom, 200) || depot.fileName || 'Nouveau document', category: cat } });
      serieId = s.id;
    }
    const serie = await prisma.planSerie.findUnique({ where: { id: serieId } });
    if (!serie) throw erreur(400, 'Série introuvable.');
    const version = str(action.version, 60);
    if (!version) throw erreur(400, 'Numéro de version requis.');
    const existe = await prisma.chantierDoc.findFirst({ where: { serieId, version } });
    if (existe) throw erreur(409, `La version ${version} existe déjà dans « ${serie.name} ».`);
    await majDoc({
      serieId, version, versionDate: parseDate(action.versionDate), author: str(action.auteur, 120),
      kind: ['PLAN', 'PERMIS', 'CONTRAT', 'AUTRE'].includes(action.kind) ? action.kind : (serie.category === 'PERMIS' ? 'PERMIS' : serie.category === 'DEVIS' ? 'CONTRAT' : 'PLAN'),
      title: `${serie.name} — ${version}`, notes: str(action.notes, 2000) || noteDepot,
    });
    await prisma.planSerie.update({ where: { id: serieId }, data: { updatedAt: new Date() } });
    return { tuile: 'plans', serieId, docId: doc.id, version };
  }

  if (t === 'doublon') {
    const cible = await prisma.chantierDoc.findUnique({ where: { id: toInt(action.docId) } });
    if (!cible) throw erreur(400, 'Document existant introuvable.');
    // Sécurité zéro perte : on ne supprime la copie QUE si les empreintes sont identiques.
    const empCible = cible.sha256 || (cible.fileData ? sha256DataUrl(cible.fileData) : null);
    if (!doc || !depot.sha256 || empCible !== depot.sha256) throw erreur(409, "Les fichiers ne sont pas identiques : ce n'est pas un doublon.");
    if (doc.id !== cible.id) {
      await prisma.depotItem.update({ where: { id: depot.id }, data: { docId: cible.id } });
      await prisma.chantierDoc.delete({ where: { id: doc.id } });
    }
    return { tuile: tuileDuDoc(cible), docId: cible.id, doublon: true };
  }

  if (t === 'photo') {
    if (!doc) throw erreur(400, 'Une photo demande un fichier.');
    await majDoc({ kind: 'PHOTO', jalonId: action.jalonId ? toInt(action.jalonId) : null, title: str(action.titre, 200) || doc.title });
    return { tuile: 'photos', docId: doc.id };
  }

  if (t === 'document') {
    if (!doc) throw erreur(400, 'Aucun fichier à ranger.');
    const kind = ['PLAN', 'PERMIS', 'CONTRAT', 'PHOTO', 'RECU', 'AUTRE'].includes(action.kind) ? action.kind : 'AUTRE';
    await majDoc({ kind, jalonId: action.jalonId ? toInt(action.jalonId) : null, tradeId: action.tradeId ? toInt(action.tradeId) : null, title: str(action.titre, 200) || doc.title });
    return { tuile: tuileDuDoc({ kind, serieId: null }), docId: doc.id };
  }

  if (t === 'soumission') {
    const s = await prisma.soumission.create({
      data: {
        projectId: project.id, amount: toInt(action.montant), label: str(action.label, 200) || depot.description.slice(0, 200),
        jalonId: action.jalonId ? toInt(action.jalonId) : null, tradeId: action.tradeId ? toInt(action.tradeId) : null,
        contactId: action.contactId ? toInt(action.contactId) : null, receivedAt: new Date(), notes: noteDepot,
      },
    });
    if (doc) await majDoc({ kind: 'CONTRAT', soumissionId: s.id, jalonId: s.jalonId, tradeId: s.tradeId });
    return { tuile: 'soumissions', soumissionId: s.id, docId: doc && doc.id };
  }

  if (t === 'depense') {
    const types = ['DEPOT', 'PARTIEL', 'FINAL', 'EXTRA'];
    const dep = await prisma.depense.create({
      data: {
        projectId: project.id, amount: toInt(action.montant), label: str(action.label, 200) || depot.description.slice(0, 200),
        type: types.includes(action.depenseType) ? action.depenseType : 'PARTIEL', paidAt: parseDate(action.payeLe),
        jalonId: action.jalonId ? toInt(action.jalonId) : null, tradeId: action.tradeId ? toInt(action.tradeId) : null, notes: noteDepot,
      },
    });
    if (doc) await majDoc({ kind: 'RECU', jalonId: dep.jalonId, tradeId: dep.tradeId });
    return { tuile: 'budget', depenseId: dep.id, docId: doc && doc.id };
  }

  if (t === 'inspiration' || t === 'requis' || t === 'commentaire') {
    const piece = await prisma.piece.findUnique({ where: { slug: String(action.pieceSlug || '') } });
    if (!piece) throw erreur(400, 'Pièce introuvable.');
    const estImage = doc && doc.fileData && /^data:image\//.test(doc.fileData) && doc.fileData.length < 3 * 1024 * 1024;
    const e = await prisma.pieceEntry.create({
      data: {
        pieceId: piece.slug, kind: t.toUpperCase(), author: depot.auteurNom,
        text: str(action.texte, 4000) || depot.description, photoData: t === 'inspiration' && estImage ? doc.fileData : null,
      },
    });
    if (doc) await majDoc({ kind: estImage ? 'PHOTO' : doc.kind });
    return { tuile: 'pieces', pieceEntryId: e.id, pieceSlug: piece.slug, docId: doc && doc.id };
  }

  if (t === 'contact') {
    const company = str(action.company, 200);
    if (!company) throw erreur(400, "Nom de l'entreprise requis.");
    const c = await prisma.contact.create({
      data: {
        projectId: project.id, company, person: str(action.person, 200), phone: str(action.phone, 60), email: str(action.email, 200),
        website: str(action.website, 300), trade: str(action.trade, 120), notes: str(action.notes, 2000) || noteDepot,
      },
    });
    return { tuile: 'contacts', contactId: c.id, docId: doc && doc.id };
  }

  if (t === 'reglement') {
    const titre = str(action.titre, 300);
    if (!titre) throw erreur(400, 'Titre du règlement requis.');
    const r = await prisma.reglement.create({ data: { titre, source: str(action.source, 300), lien: str(action.lien, 500), detail: str(action.detail, 4000) || noteDepot } });
    if (doc) await majDoc({ kind: 'PERMIS' });
    return { tuile: 'reglements', reglementId: r.id, docId: doc && doc.id };
  }

  if (t === 'note') return { tuile: null, docId: doc && doc.id };

  throw erreur(400, `Type d'action inconnu : ${t}`);
}

router.use('/classeur', classeur);

// ================================================================ ROUTES CONNECTÉES

router.use(auth, chargerAcces);

// ---------- Accueil ----------
router.get('/accueil', async (req, res) => {
  try {
    const project = await getProject();
    const sections = await sectionsVisibles(req);
    const voitJalons = aTuile(req, 'jalons');
    const filtreDepot = req.chalet.proprio ? {} : { auteurId: req.user.id };
    const [enAttente, aValider, activite] = await Promise.all([
      prisma.depotItem.count({ where: { ...filtreDepot, statut: 'EN_ATTENTE' } }),
      prisma.depotItem.count({ where: { ...filtreDepot, statut: 'A_VALIDER' } }),
      prisma.activite.findMany({ orderBy: { createdAt: 'desc' }, take: 30 }),
    ]);
    res.json({
      projet: {
        nom: (await prisma.app.findUnique({ where: { slug: APP_SLUG }, select: { name: true } }))?.name || 'Projet chalet',
        adresse: project ? project.address : null,
        avancement: voitJalons && project ? await avancementBanque(project.id) : null,
      },
      moi: { nom: req.chalet.nom, proprio: req.chalet.proprio, invite: req.chalet.invite },
      sections,
      depot: { enAttente, aValider, prochainClassement: prochainClassement() },
      activite: activite.filter((a) => req.chalet.proprio || (a.tuile && aTuile(req, a.tuile))).slice(0, 5),
    });
  } catch (e) {
    console.error('projet-chalet/accueil', e);
    res.status(500).json({ erreur: "Erreur lors du chargement de l'accueil." });
  }
});

router.get('/sections', async (req, res) => {
  res.json({ sections: await sectionsVisibles(req) });
});

router.patch('/sections/:slug', exigerProprio, async (req, res) => {
  try {
    const { nom, icone, couleur, aide, ordre, prive, actif } = req.body || {};
    const data = {};
    if (nom !== undefined) data.nom = str(nom, 80);
    if (icone !== undefined) data.icone = str(icone, 60);
    if (couleur !== undefined) data.couleur = str(couleur, 20);
    if (aide !== undefined) data.aide = str(aide, 120);
    if (ordre !== undefined) data.ordre = toInt(ordre);
    if (prive !== undefined) data.prive = !!prive;
    if (actif !== undefined) data.actif = !!actif;
    const section = await prisma.chaletSection.update({ where: { slug: String(req.params.slug) }, data });
    res.json({ section });
  } catch (e) {
    res.status(404).json({ erreur: 'Tuile introuvable.' });
  }
});

// ---------- Pièces ----------
router.get('/pieces', exigerTuile('pieces'), async (req, res) => {
  const [pieces, entrees] = await Promise.all([
    prisma.piece.findMany({ orderBy: { ordre: 'asc' } }),
    prisma.pieceEntry.findMany({ select: { pieceId: true, kind: true, done: true } }),
  ]);
  const compte = {};
  for (const e of entrees) {
    const c = (compte[e.pieceId] = compte[e.pieceId] || { requisOuverts: 0, total: 0 });
    c.total++;
    if (e.kind === 'REQUIS' && !e.done) c.requisOuverts++;
  }
  res.json({ pieces: pieces.map((p) => ({ ...p, compte: compte[p.slug] || { requisOuverts: 0, total: 0 } })) });
});

// ---------- Catégories de plans ----------
router.get('/plans/categories', exigerTuile('plans'), (req, res) => {
  res.json({ categories: PLAN_CATEGORIES.map((cle) => ({ cle, ...CATEGORIES_PLANS[cle] })) });
});

// ---------- Ville & règlements ----------
router.get('/reglements', exigerTuile('reglements'), async (req, res) => {
  res.json({ reglements: await prisma.reglement.findMany({ orderBy: [{ ordre: 'asc' }, { createdAt: 'asc' }] }) });
});
router.post('/reglements', exigerProprio, async (req, res) => {
  const titre = str(req.body && req.body.titre, 300);
  if (!titre) return res.status(400).json({ erreur: 'Le titre est requis.' });
  const { source, lien, detail, statut } = req.body;
  const r = await prisma.reglement.create({ data: { titre, source: str(source, 300), lien: str(lien, 500), detail: str(detail, 4000), statut: statut || 'A_CONFIRMER' } });
  await journal(`Règlement ajouté : ${titre}`, 'scale-balanced', 'reglements', req.chalet.nom);
  res.status(201).json({ reglement: r });
});
router.patch('/reglements/:id', exigerProprio, async (req, res) => {
  try {
    const { titre, source, lien, detail, statut, ordre } = req.body || {};
    const data = {};
    if (titre !== undefined) data.titre = str(titre, 300);
    if (source !== undefined) data.source = str(source, 300);
    if (lien !== undefined) data.lien = str(lien, 500);
    if (detail !== undefined) data.detail = str(detail, 4000);
    if (statut !== undefined && ['A_CONFIRMER', 'CONFIRME', 'NON_APPLICABLE'].includes(statut)) data.statut = statut;
    if (ordre !== undefined) data.ordre = toInt(ordre);
    res.json({ reglement: await prisma.reglement.update({ where: { id: toInt(req.params.id) }, data }) });
  } catch (e) {
    res.status(404).json({ erreur: 'Règlement introuvable.' });
  }
});
router.delete('/reglements/:id', exigerProprio, async (req, res) => {
  try {
    await prisma.reglement.delete({ where: { id: toInt(req.params.id) } });
    res.json({ ok: true });
  } catch (e) {
    res.status(404).json({ erreur: 'Règlement introuvable.' });
  }
});

// ---------- Activité ----------
router.get('/activite', async (req, res) => {
  const rows = await prisma.activite.findMany({ orderBy: { createdAt: 'desc' }, take: 200 });
  res.json({ activite: rows.filter((a) => req.chalet.proprio || (a.tuile && aTuile(req, a.tuile))).slice(0, 100) });
});

// ---------- Boîte de dépôt ----------
router.get('/depot', async (req, res) => {
  const where = req.chalet.proprio ? {} : { auteurId: req.user.id };
  const depots = await prisma.depotItem.findMany({ where, orderBy: { createdAt: 'desc' }, take: 100 });
  res.json({ depots, prochainClassement: prochainClassement(), heures: HEURES_CLASSEMENT });
});

router.post('/depot', async (req, res) => {
  try {
    const { description, fileName, mimeType, fileData } = req.body || {};
    const desc = str(description, 2000);
    if (!desc && !fileData) return res.status(400).json({ erreur: 'Ajoute un fichier ou une description.' });
    if (fileData && !/^data:[^;]+;base64,/.test(String(fileData))) return res.status(400).json({ erreur: 'Fichier invalide (data URL attendu).' });
    if (fileData && String(fileData).length > MAX_FICHIER_B64) return res.status(413).json({ erreur: 'Fichier trop volumineux (max ~40 Mo).' });
    const project = await getProject();
    const nom = str(fileName, 200) || (fileData ? 'fichier' : null);
    const sha = fileData ? sha256DataUrl(fileData) : null;
    const taille = fileData ? dataUrlSize(fileData) : null;
    let docId = null;
    if (fileData) {
      // Le fichier est stocké UNE fois, comme document « à classer ». Le classement le déplacera.
      const doc = await prisma.chantierDoc.create({
        data: {
          projectId: project.id, kind: 'AUTRE', title: nom, fileName: nom, fileData: String(fileData),
          mimeType: str(mimeType, 100) || /^data:([^;]+);/.exec(fileData)[1], fileSize: taille, sha256: sha,
          notes: `Dépôt (${req.chalet.nom}) : ${desc || ''}`.trim(),
        },
        select: { id: true },
      });
      docId = doc.id;
    }
    const depot = await prisma.depotItem.create({
      data: {
        description: desc || '(sans description)', fileName: nom, mimeType: str(mimeType, 100), fileSize: taille, sha256: sha,
        docId, auteurId: req.user.id, auteurNom: req.chalet.nom,
      },
    });
    await journal(`${req.chalet.nom} a déposé « ${nom || desc.slice(0, 60)} »`, 'inbox', null, req.chalet.nom);
    res.status(201).json({ depot, prochainClassement: prochainClassement() });
  } catch (e) {
    console.error('projet-chalet/depot POST', e);
    res.status(500).json({ erreur: 'Erreur lors du dépôt.' });
  }
});

async function depotVisible(req) {
  const d = await prisma.depotItem.findUnique({ where: { id: toInt(req.params.id) } });
  if (!d) return null;
  if (!req.chalet.proprio && d.auteurId !== req.user.id) return null;
  return d;
}

router.get('/depot/:id/fichier', async (req, res) => {
  const d = await depotVisible(req);
  if (!d || !d.docId) return res.status(404).json({ erreur: 'Fichier introuvable.' });
  const doc = await prisma.chantierDoc.findUnique({ where: { id: d.docId } });
  if (!doc || !doc.fileData) return res.status(404).json({ erreur: 'Fichier introuvable.' });
  return envoyerDataUrl(res, doc.fileData, doc.fileName || d.fileName, !!req.query.download);
});

router.post('/depot/:id/valider', exigerProprio, async (req, res) => {
  try {
    const d = await prisma.depotItem.findUnique({ where: { id: toInt(req.params.id) } });
    if (!d) return res.status(404).json({ erreur: 'Dépôt introuvable.' });
    if (d.statut !== 'A_VALIDER' || !d.proposition) return res.status(409).json({ erreur: 'Rien à valider pour ce dépôt.' });
    const resultat = await appliquerAction(d, d.proposition);
    const maj = await prisma.depotItem.update({ where: { id: d.id }, data: { statut: 'CLASSE', resultat, classeLe: new Date(), classePar: req.chalet.nom } });
    await journal(`${req.chalet.nom} a confirmé : ${maj.destination || d.fileName}`, 'check', resultat.tuile, req.chalet.nom);
    res.json({ depot: maj });
  } catch (e) {
    console.error('projet-chalet/depot valider', e);
    res.status(e.status || 500).json({ erreur: e.message || 'Erreur lors de la validation.' });
  }
});

router.post('/depot/:id/corriger', exigerProprio, async (req, res) => {
  const consigne = str(req.body && req.body.consigne, 1000);
  if (!consigne) return res.status(400).json({ erreur: 'Dis où ça va, en une phrase.' });
  const d = await prisma.depotItem.findUnique({ where: { id: toInt(req.params.id) } });
  if (!d) return res.status(404).json({ erreur: 'Dépôt introuvable.' });
  if (d.statut === 'CLASSE') return res.status(409).json({ erreur: 'Déjà classé.' });
  const maj = await prisma.depotItem.update({ where: { id: d.id }, data: { statut: 'EN_ATTENTE', correction: consigne, proposition: null } });
  res.json({ depot: maj, prochainClassement: prochainClassement() });
});

router.delete('/depot/:id', async (req, res) => {
  const d = await depotVisible(req);
  if (!d) return res.status(404).json({ erreur: 'Dépôt introuvable.' });
  if (d.statut === 'CLASSE') return res.status(409).json({ erreur: 'Déjà classé : il ne peut plus être annulé ici.' });
  if (d.docId) {
    // On ne supprime le fichier que s'il n'a été rangé nulle part entre-temps.
    const doc = await prisma.chantierDoc.findUnique({ where: { id: d.docId }, select: { serieId: true, jalonId: true, soumissionId: true, kind: true } });
    if (doc && !doc.serieId && !doc.jalonId && !doc.soumissionId && doc.kind === 'AUTRE') await prisma.chantierDoc.delete({ where: { id: d.docId } });
  }
  await prisma.depotItem.delete({ where: { id: d.id } });
  res.json({ ok: true });
});

// ---------- Invités ----------
function codeInvitation() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sans 0/O/1/I
  let c = '';
  for (const b of crypto.randomBytes(8)) c += alphabet[b % alphabet.length];
  return 'CHALET-' + c;
}
async function slugsValides(liste) {
  const sections = await prisma.chaletSection.findMany({ select: { slug: true } });
  const ok = new Set(sections.map((s) => s.slug));
  return [...new Set((Array.isArray(liste) ? liste : []).map(String))].filter((s) => ok.has(s));
}

router.get('/membres', exigerProprio, async (req, res) => {
  const app = await prisma.app.findUnique({ where: { slug: APP_SLUG } });
  const proprios = app ? await prisma.userApp.findMany({
    where: { appId: app.id, hasAccess: true, user: { profile: 'ADULT' } }, include: { user: { select: { id: true, firstName: true } } },
  }) : [];
  const invites = await prisma.chaletMembre.findMany({ orderBy: { createdAt: 'asc' }, include: { tuiles: true } });
  res.json({
    proprietaires: proprios.map((p) => ({ userId: p.user.id, nom: p.user.firstName })),
    invites: invites.map((m) => ({
      id: m.id, nom: m.nom, detail: m.detail, actif: m.actif, expireLe: m.expireLe,
      compteCree: !!m.userId, code: m.userId ? null : m.code, tuiles: m.tuiles.map((t) => t.slug), createdAt: m.createdAt,
    })),
  });
});

router.post('/membres', exigerProprio, async (req, res) => {
  try {
    const nom = str(req.body && req.body.nom, 80);
    if (!nom) return res.status(400).json({ erreur: 'Le nom est requis.' });
    const tuiles = await slugsValides(req.body.tuiles);
    const m = await prisma.chaletMembre.create({
      data: {
        nom, detail: str(req.body.detail, 120), code: codeInvitation(), creePar: req.chalet.nom, expireLe: parseDate(req.body.expireLe),
        tuiles: { create: tuiles.map((slug) => ({ slug })) },
      },
      include: { tuiles: true },
    });
    await journal(`${req.chalet.nom} a invité ${nom} (${tuiles.length} tuile${tuiles.length > 1 ? 's' : ''})`, 'user-plus', null, req.chalet.nom);
    res.status(201).json({ membre: { id: m.id, nom: m.nom, detail: m.detail, code: m.code, tuiles } });
  } catch (e) {
    console.error('projet-chalet/membres POST', e);
    res.status(500).json({ erreur: "Erreur lors de la création de l'invitation." });
  }
});

router.put('/membres/:id/tuiles', exigerProprio, async (req, res) => {
  const id = toInt(req.params.id);
  const m = await prisma.chaletMembre.findUnique({ where: { id } });
  if (!m) return res.status(404).json({ erreur: 'Invité introuvable.' });
  const tuiles = await slugsValides(req.body && req.body.tuiles);
  await prisma.$transaction([
    prisma.chaletMembreTuile.deleteMany({ where: { membreId: id } }),
    prisma.chaletMembreTuile.createMany({ data: tuiles.map((slug) => ({ membreId: id, slug })) }),
  ]);
  await journal(`Accès de ${m.nom} modifiés (${tuiles.length} tuile${tuiles.length > 1 ? 's' : ''})`, 'user-lock', null, req.chalet.nom);
  res.json({ tuiles });
});

router.patch('/membres/:id', exigerProprio, async (req, res) => {
  try {
    const id = toInt(req.params.id);
    const { nom, detail, actif, expireLe } = req.body || {};
    const data = {};
    if (nom !== undefined) data.nom = str(nom, 80);
    if (detail !== undefined) data.detail = str(detail, 120);
    if (actif !== undefined) data.actif = !!actif;
    if (expireLe !== undefined) data.expireLe = parseDate(expireLe);
    const m = await prisma.chaletMembre.update({ where: { id }, data });
    // Retirer l'accès coupe aussi la tuile du dashboard ; rien de ce qu'il a déposé n'est supprimé.
    if (actif !== undefined && m.userId) {
      const app = await prisma.app.findUnique({ where: { slug: APP_SLUG } });
      if (app) await prisma.userApp.updateMany({ where: { userId: m.userId, appId: app.id }, data: { hasAccess: !!actif } });
    }
    if (actif === false) await journal(`Accès de ${m.nom} retiré`, 'user-xmark', null, req.chalet.nom);
    res.json({ membre: m });
  } catch (e) {
    res.status(404).json({ erreur: 'Invité introuvable.' });
  }
});

// ---------- Partage par lien ----------
router.post('/partages', exigerProprio, async (req, res) => {
  const docId = toInt(req.body && req.body.docId);
  const jours = Math.max(1, Math.min(90, toInt(req.body && req.body.jours, 7)));
  const doc = await prisma.chantierDoc.findUnique({ where: { id: docId }, select: { id: true, title: true, fileName: true } });
  if (!doc) return res.status(404).json({ erreur: 'Document introuvable.' });
  const lien = await prisma.partageLien.create({
    data: { token: crypto.randomBytes(18).toString('base64url'), docId, titre: doc.fileName || doc.title, expireLe: new Date(Date.now() + jours * 86400000), creePar: req.chalet.nom },
  });
  const base = process.env.API_PUBLIC_URL || 'https://api.my-mission-control.com';
  res.status(201).json({ partage: { ...lien, url: `${base}/projet-chalet/partage/${lien.token}` } });
});

router.get('/partages', exigerProprio, async (req, res) => {
  const base = process.env.API_PUBLIC_URL || 'https://api.my-mission-control.com';
  const liens = await prisma.partageLien.findMany({ orderBy: { createdAt: 'desc' }, take: 100 });
  res.json({ partages: liens.map((l) => ({ ...l, url: `${base}/projet-chalet/partage/${l.token}` })) });
});

router.delete('/partages/:id', exigerProprio, async (req, res) => {
  try {
    await prisma.partageLien.update({ where: { id: toInt(req.params.id) }, data: { revoque: true } });
    res.json({ ok: true });
  } catch (e) {
    res.status(404).json({ erreur: 'Lien introuvable.' });
  }
});

// ---------- Recherche ----------
router.get('/recherche', async (req, res) => {
  try {
    const q = str(req.query.q, 100);
    if (!q || q.length < 2) return res.json({ resultats: [] });
    const c = { contains: q, mode: 'insensitive' };
    const project = await getProject();
    const r = [];
    if (aTuile(req, 'pieces')) {
      const [pieces, entrees] = await Promise.all([
        prisma.piece.findMany({ where: { OR: [{ nom: c }, { qui: c }, { numero: c }] }, take: 8 }),
        prisma.pieceEntry.findMany({ where: { text: c }, take: 8, select: { id: true, pieceId: true, text: true, kind: true } }),
      ]);
      pieces.forEach((p) => r.push({ tuile: 'pieces', type: 'piece', titre: p.nom, sous: 'Pièce', cible: p.slug }));
      entrees.forEach((e) => r.push({ tuile: 'pieces', type: 'entree', titre: e.text.slice(0, 120), sous: 'Note de pièce', cible: e.pieceId }));
    }
    if (aTuile(req, 'plans')) {
      const series = await prisma.planSerie.findMany({ where: { projectId: project.id, OR: [{ name: c }, { docs: { some: { OR: [{ fileName: c }, { title: c }] } } }] }, take: 8 });
      series.forEach((s) => r.push({ tuile: 'plans', type: 'serie', titre: s.name, sous: 'Plans & devis · ' + (CATEGORIES_PLANS[s.category] || {}).nom, cible: String(s.id) }));
    }
    if (aTuile(req, 'contacts', 'soumissions')) {
      const contacts = await prisma.contact.findMany({ where: { projectId: project.id, OR: [{ company: c }, { person: c }, { trade: c }] }, take: 8 });
      contacts.forEach((x) => r.push({ tuile: 'contacts', type: 'contact', titre: x.company, sous: 'Contact' + (x.trade ? ' · ' + x.trade : ''), cible: String(x.id) }));
    }
    if (aTuile(req, 'jalons')) {
      const jalons = await prisma.jalon.findMany({ where: { projectId: project.id, name: c }, take: 8 });
      jalons.forEach((j) => r.push({ tuile: 'jalons', type: 'jalon', titre: j.name, sous: 'Jalon', cible: String(j.id) }));
    }
    if (aTuile(req, 'soumissions')) {
      const soum = await prisma.soumission.findMany({ where: { projectId: project.id, label: c }, take: 8 });
      soum.forEach((s) => r.push({ tuile: 'soumissions', type: 'soumission', titre: s.label, sous: 'Soumission', cible: String(s.id) }));
    }
    if (aTuile(req, 'reglements')) {
      const regs = await prisma.reglement.findMany({ where: { OR: [{ titre: c }, { detail: c }] }, take: 8 });
      regs.forEach((x) => r.push({ tuile: 'reglements', type: 'reglement', titre: x.titre, sous: 'Ville & règlements', cible: String(x.id) }));
    }
    res.json({ resultats: r.slice(0, 40) });
  } catch (e) {
    console.error('projet-chalet/recherche', e);
    res.status(500).json({ erreur: 'Erreur lors de la recherche.' });
  }
});

module.exports = router;
module.exports.appliquerAction = appliquerAction; // exporté pour les tests
module.exports.prochainClassement = prochainClassement;
