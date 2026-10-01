// Contrôle d'accès « Projet chalet » — qui voit quoi, tuile par tuile.
//
// Deux sortes de personnes :
//   - PROPRIÉTAIRE : admin, ou adulte de la famille qui a l'app « projet-chalet »
//     dans UserApp (Martin, Marie-Josée). Voit et modifie tout.
//   - INVITÉ : compte de profil GUEST relié à une ligne ChaletMembre active.
//     Ne voit QUE les tuiles cochées pour lui (ChaletMembreTuile), en lecture
//     seule (il peut seulement déposer dans la boîte de dépôt).
// Tout le reste (enfants, adultes sans l'app) est refusé.
//
// Utilisation (APRÈS le middleware auth) :
//   router.use(auth, chargerAcces)            -> remplit req.chalet
//   router.get('/x', exigerTuile('plans'), …) -> 403 si invité sans cette tuile
//   router.use(lectureSeuleInvite)            -> 403 sur POST/PATCH/DELETE d'un invité
//
// req.chalet = { proprio: bool, invite: bool, membreId, tuiles: Set<slug>, nom }

const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const APP_SLUG = 'projet-chalet';

async function calculerAcces(user) {
  if (!user) return null;
  const nom = user.firstName === 'Marie-Josée' ? 'MJ' : (user.firstName || 'Inconnu');

  if (user.role === 'ADMIN') return { proprio: true, invite: false, membreId: null, tuiles: null, nom };

  if (user.profile === 'ADULT') {
    const ua = await prisma.userApp.findFirst({
      where: { userId: user.id, hasAccess: true, app: { slug: APP_SLUG } },
      select: { id: true },
    });
    if (ua) return { proprio: true, invite: false, membreId: null, tuiles: null, nom };
    return null;
  }

  if (user.profile === 'GUEST') {
    const m = await prisma.chaletMembre.findUnique({
      where: { userId: user.id },
      include: { tuiles: true },
    });
    if (!m || !m.actif) return null;
    if (m.expireLe && m.expireLe.getTime() < Date.now()) return null;
    return { proprio: false, invite: true, membreId: m.id, tuiles: new Set(m.tuiles.map((t) => t.slug)), nom: m.nom };
  }

  return null; // CHILD ou autre
}

// Remplit req.chalet ; 403 si la personne n'a aucun accès au projet.
async function chargerAcces(req, res, next) {
  try {
    const acces = await calculerAcces(req.user);
    if (!acces) return res.status(403).json({ erreur: 'Accès au Projet chalet refusé.' });
    req.chalet = acces;
    next();
  } catch (e) {
    console.error('projet-chalet acces', e);
    res.status(500).json({ erreur: "Erreur lors de la vérification de l'accès." });
  }
}

// Le propriétaire passe toujours ; l'invité doit avoir AU MOINS une des tuiles.
function aTuile(req, ...slugs) {
  if (!req.chalet) return false;
  if (req.chalet.proprio) return true;
  return slugs.some((s) => req.chalet.tuiles.has(s));
}

function exigerTuile(...slugs) {
  return (req, res, next) => {
    if (aTuile(req, ...slugs)) return next();
    return res.status(403).json({ erreur: "Cette section n'est pas partagée avec toi." });
  };
}

function exigerProprio(req, res, next) {
  if (req.chalet && req.chalet.proprio) return next();
  return res.status(403).json({ erreur: 'Réservé aux propriétaires.' });
}

// Invités = lecture seule sur les données du chantier.
function lectureSeuleInvite(req, res, next) {
  if (req.chalet && req.chalet.invite && req.method !== 'GET') {
    return res.status(403).json({ erreur: 'Accès en lecture seulement.' });
  }
  next();
}

module.exports = { APP_SLUG, calculerAcces, chargerAcces, aTuile, exigerTuile, exigerProprio, lectureSeuleInvite };
