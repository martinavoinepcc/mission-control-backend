// Routes /budget — budget familial partage (Martin + Marie-Josee).
//
// Un seul etat JSON partage (slug 'famille') : revenus, depenses, categories,
// parametres de previsions. Le frontend statique (public/budget-app.html)
// fait GET au chargement et PUT a chaque sauvegarde (last-write-wins).
//
// IMPORTANT : les donnees par defaut (montants reels de la famille) vivent ICI,
// derriere l'auth — jamais dans le HTML public du frontend.
//
// - GET    /budget  -> { data, updatedAt, updatedBy } (defaults si DB vierge)
// - PUT    /budget  -> { data } sauvegarde l'etat complet
// - DELETE /budget  -> reset aux defaults (le prochain GET les retourne)

const express = require('express');
const { PrismaClient } = require('@prisma/client');
const auth = require('../middleware/auth');

const prisma = new PrismaClient();
const router = express.Router();

// Les enfants (profile CHILD) n'ont pas acces au budget.
function adultOnly(req, res, next) {
  if (req.user && req.user.profile === 'CHILD') {
    return res.status(403).json({ erreur: 'Acces reserve aux parents.' });
  }
  next();
}

router.use(auth, adultOnly);

const SLUG = 'famille';

/* ───────── Donnees par defaut (source : Budget_Dépense_annuel.ods) ─────────
   Champs par depense :
   - freq    : 'mensuel' | 'bihebdo' | 'annuel'
   - montant : montant paye a cette frequence
   - echeance: prochaine date de paiement/renouvellement (optionnelle)
   - fin     : date de fin de la depense (optionnelle) — utilisee par les previsions
   - idx     : true = indexee a l'inflation dans les previsions
               (false pour les paiements fixes : hypotheques, financements,
                plans de traitement, primes vie nivelees, cotisations choisies) */

const D = (id, nom, cat, freq, montant, note, opts = {}) => ({
  id, nom, cat, freq, montant,
  note: note || '',
  echeance: opts.echeance || '',
  fin: opts.fin || '',
  idx: opts.idx !== undefined ? opts.idx : true,
});

const DEFAULT_STATE = {
  version: 2,
  seq: 100,
  categories: [
    { id: 'habitation',   nom: 'Habitation',             hex: '#0C6B4F' },
    { id: 'enfants',      nom: 'Enfants & éducation',    hex: '#2E7DA1' },
    { id: 'alimentation', nom: 'Alimentation',           hex: '#C99A2E' },
    { id: 'vehicules',    nom: 'Véhicules & transport',  hex: '#7A5CA8' },
    { id: 'loisirs',      nom: 'Loisirs & plein air',    hex: '#B4553B' },
    { id: 'assurances',   nom: 'Assurances & protection', hex: '#4C8A57' },
    { id: 'sante',        nom: 'Santé',                  hex: '#8A6A4F' },
    { id: 'epargne',      nom: 'Épargne',                hex: '#476178' },
    { id: 'autre',        nom: 'Autre',                  hex: '#5A5F6E' },
  ],
  revenus: [
    { id: 'r1', nom: 'MJB',    montant: 9000, note: 'Paye nette déposée aux 2 semaines.' },
    { id: 'r2', nom: 'Martin', montant: 2500, note: 'Paye nette déposée aux 2 semaines.' },
  ],
  previsions: {
    inflation: 2.5,     // % annuel applique aux depenses indexees
    croissance: 2.0,    // % annuel applique aux revenus
    horizon: 10,        // annees projetees
  },
  depenses: [
    /* ── ANNUELLES ── */
    D('d1', 'Taxes municipales — Maison', 'habitation', 'annuel', 4462.28, "Facture annuelle de la municipalité : services, voirie, collecte, etc. Souvent payable en versements."),
    D('d2', 'Taxes municipales — Chalet', 'habitation', 'annuel', 1963.15, "Taxes de la municipalité de Trois-Rives pour le chalet du Lac Mékinac. Les taxes du futur chalet ne sont pas incluses ici."),
    D('d3', 'Taxes scolaires — Maison', 'habitation', 'annuel', 345.62, "Facturée chaque année par le centre de services scolaire, calculée sur la valeur de la propriété."),
    D('d4', 'Taxes scolaires — Chalet', 'habitation', 'annuel', 249, "Taxe scolaire du chalet — même principe que la maison, basée sur l'évaluation."),
    D('d5', 'Électricité — Maison', 'habitation', 'annuel', 4433, "Somme des 6 factures Hydro-Québec de l'année (498 + 465 + 680 + 797 + 1209 + 784). Le montant grimpe l'hiver à cause du chauffage."),
    D('d6', 'Électricité — Chalet', 'habitation', 'annuel', 1437, "Somme des 6 factures Hydro-Québec du chalet (165 + 141 + 120 + 239 + 475 + 297)."),
    D('d7', 'Déneigement — Maison', 'habitation', 'annuel', 500, 'Contrat saisonnier de déneigement de l’entrée.'),
    D('d8', 'Déneigement — Chalet', 'habitation', 'annuel', 832, "Déneigement du chemin d'accès au chalet."),
    D('d9', 'Entretien du gazon', 'habitation', 'annuel', 349, "Contrat saisonnier d'entretien de la pelouse."),
    D('d10', 'Fournitures scolaires — Alizée', 'enfants', 'annuel', 1000, 'Rentrée scolaire : matériel, effets et frais de début d’année.'),
    D('d11', 'Fournitures scolaires — Jax', 'enfants', 'annuel', 1000, 'Rentrée scolaire : matériel, effets et frais de début d’année.'),
    D('d12', 'Camp Lac-en-Cœur (1re inscription)', 'enfants', 'annuel', 1200, 'Camp de vacances estival.'),
    D('d13', 'Camp Lac-en-Cœur (2e inscription)', 'enfants', 'annuel', 1200, "Deuxième montant de 1 200 $ inscrit au fichier sans étiquette — interprété comme une 2e inscription au camp. Corrigez au besoin."),
    D('d14', 'Camps et activités — autres', 'enfants', 'annuel', 3000, "Enveloppe pour les autres camps, sorties et activités de l'année."),
    D('d15', 'Vêtements des enfants', 'enfants', 'annuel', 5000, "Enveloppe annuelle pour l'habillement des enfants, toutes saisons."),
    D('d16', 'Location d’équipement de ski', 'loisirs', 'annuel', 1000, "Location saisonnière de l'équipement de ski."),
    D('d17', 'Ski — billets et abonnements', 'loisirs', 'annuel', 2000, 'Billets de remontée, abonnements et sorties de ski de la saison.'),
    D('d18', 'Assurance — Auto', 'vehicules', 'annuel', 4545, "Prime annuelle d'assurance pour les véhicules."),
    D('d19', 'Assurance — Côte-à-côte', 'loisirs', 'annuel', 580, 'Prime annuelle du véhicule côte-à-côte (side-by-side).'),
    D('d20', 'Assurance — Bateau', 'loisirs', 'annuel', 5000, "Prime annuelle d'assurance du bateau."),
    D('d21', 'Pneus', 'vehicules', 'annuel', 2500, 'Achat et pose de pneus (été/hiver) pour les véhicules.'),
    D('d22', 'Changements d’huile', 'vehicules', 'annuel', 1500, "Entretien mécanique courant des véhicules sur l'année."),

    /* ── AUX 2 SEMAINES ── */
    D('d23', 'Hypothèque — Maison', 'habitation', 'bihebdo', 800, 'Paiement hypothécaire aux 2 semaines : 26 paiements par année. Fixez une date de fin dans Prévisions pour voir l’effet de la fin de l’hypothèque.', { idx: false }),
    D('d24', 'Paiement — Bateau', 'loisirs', 'bihebdo', 1425, 'Financement du bateau, payé aux 2 semaines (26 paiements/an, soit 37 050 $ par année).', { idx: false }),
    D('d25', 'Épicerie & nourriture', 'alimentation', 'bihebdo', 1000, "Budget d'épicerie estimé à environ 1 000 $ aux 2 semaines."),

    /* ── MENSUELLES ── */
    D('d26', 'Hypothèque — Chalet', 'habitation', 'mensuel', 1550, 'Paiement hypothécaire mensuel du chalet du Lac Mékinac (12 paiements par année).', { idx: false }),
    D('d27', 'École Vision — Scolarité', 'enfants', 'mensuel', 1400, "Frais de scolarité mensuels de l'école privée Vision."),
    D('d28', 'École Vision — Orthopédagogie', 'enfants', 'mensuel', 400, 'Suivi en orthopédagogie : soutien aux apprentissages (lecture, écriture, méthodes de travail).'),
    D('d29', 'École Vision — Orthophonie', 'enfants', 'mensuel', 1020, "Suivi en orthophonie : rééducation du langage et de la communication. Une partie peut être admissible au crédit d'impôt pour frais médicaux."),
    D('d30', 'École Vision — Service de garde', 'enfants', 'mensuel', 200, 'Service de garde avant/après les classes.'),
    D('d31', 'École SJE — Scolarité', 'enfants', 'mensuel', 650, 'Frais de scolarité mensuels de la 2e école.'),
    D('d32', 'Dixversion (danse)', 'enfants', 'mensuel', 900, 'Cours et activités de danse — école Dixversion.'),
    D('d33', 'Denturologiste — plan 1', 'sante', 'mensuel', 214, "Paiement mensuel d'un plan de traitement chez le denturologiste. Fixez la date de fin du plan dans Prévisions.", { idx: false }),
    D('d34', 'Denturologiste — plan 2', 'sante', 'mensuel', 250, 'Deuxième plan de traitement chez le denturologiste.', { idx: false }),
    D('d35', 'Promutuel — Maison + Chalet', 'assurances', 'mensuel', 381.91, "Prime mensuelle d'assurance habitation couvrant la maison et le chalet."),
    D('d36', 'Assurance vie — MJB', 'assurances', 'mensuel', 23.40, "Prime mensuelle d'assurance vie. Protège la famille en versant un capital au décès.", { idx: false }),
    D('d37', 'Assurance vie — Jax', 'assurances', 'mensuel', 34.61, "Prime mensuelle d'assurance vie pour Jax.", { idx: false }),
    D('d38', 'Assurance vie — Ali', 'assurances', 'mensuel', 32.45, "Prime mensuelle d'assurance vie pour Alizée.", { idx: false }),
    D('d39', 'Assurance invalidité', 'assurances', 'mensuel', 475, "Remplace une partie du revenu si l'un de vous devient incapable de travailler — une protection clé quand le train de vie repose sur deux revenus.", { idx: false }),
    D('d40', 'REEE (épargne-études)', 'epargne', 'mensuel', 500, 'Régime enregistré d’épargne-études : chaque dépôt attire au moins 30 % de subventions gouvernementales (SCEE 20 % + IQEE 10 %). C’est une « dépense » qui revient aux enfants.', { idx: false }),
    D('d41', 'Essence', 'vehicules', 'mensuel', 600, "Carburant mensuel pour l'ensemble des véhicules."),
    D('d42', 'Internet — Maison', 'habitation', 'mensuel', 100, 'Forfait Internet résidentiel.'),
    D('d43', 'Internet — Chalet', 'habitation', 'mensuel', 135, 'Forfait Internet du chalet (souvent plus cher en région éloignée).'),
  ],
};

/* ───────── Routes ───────── */

// GET /budget — etat courant (ou defaults si jamais sauvegarde).
router.get('/', async (req, res) => {
  try {
    const row = await prisma.budgetState.findUnique({ where: { slug: SLUG } });
    if (!row) {
      return res.json({ data: DEFAULT_STATE, updatedAt: null, updatedBy: null, isDefault: true });
    }
    return res.json({ data: row.data, updatedAt: row.updatedAt, updatedBy: row.updatedBy, isDefault: false });
  } catch (err) {
    console.error('GET /budget:', err);
    return res.status(500).json({ erreur: 'Erreur interne du serveur.' });
  }
});

// PUT /budget — sauvegarde de l'etat complet (last-write-wins).
router.put('/', async (req, res) => {
  try {
    const { data } = req.body || {};
    if (!data || typeof data !== 'object' || !Array.isArray(data.depenses) || !Array.isArray(data.revenus)) {
      return res.status(400).json({ erreur: 'Format de budget invalide.' });
    }
    const updatedBy = (req.user && req.user.firstName) || null;
    const row = await prisma.budgetState.upsert({
      where: { slug: SLUG },
      update: { data, updatedBy },
      create: { slug: SLUG, data, updatedBy },
    });
    return res.json({ ok: true, updatedAt: row.updatedAt, updatedBy: row.updatedBy });
  } catch (err) {
    console.error('PUT /budget:', err);
    return res.status(500).json({ erreur: 'Erreur interne du serveur.' });
  }
});

// DELETE /budget — reset : efface l'etat sauvegarde, le prochain GET
// retourne les donnees par defaut du fichier d'origine.
router.delete('/', async (req, res) => {
  try {
    await prisma.budgetState.deleteMany({ where: { slug: SLUG } });
    return res.json({ ok: true, data: DEFAULT_STATE });
  } catch (err) {
    console.error('DELETE /budget:', err);
    return res.status(500).json({ erreur: 'Erreur interne du serveur.' });
  }
});

module.exports = router;
