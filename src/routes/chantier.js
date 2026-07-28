// Routes /chantier — gestion du chantier de reconstruction du chalet.
//
// Un seul projet actif (slug 'chalet') pour l'instant, mais le modele supporte
// plusieurs projets. Toutes les routes sont protegees par auth + adultOnly
// (les enfants n'ont pas acces au chantier).
//
// Structure :
// - GET    /chantier/overview                 -> projet + rollups (budget, avancement, prochains jalons, photos recentes)
// - GET    /chantier/project                  -> projet seul
// - PATCH  /chantier/project                  -> maj projet (budget, adresse, nom, date, statut)  [admin]
// - GET    /chantier/trades                    | POST /chantier/trades
// - PATCH  /chantier/trades/:id               | DELETE /chantier/trades/:id
// - GET    /chantier/contacts                  | POST /chantier/contacts
// - PATCH  /chantier/contacts/:id             | DELETE /chantier/contacts/:id
// - GET    /chantier/jalons                    | POST /chantier/jalons
// - GET    /chantier/jalons/:id  (fiche complete: soumissions+contact, depenses, docs)
// - PATCH  /chantier/jalons/:id              | DELETE /chantier/jalons/:id
// - GET    /chantier/soumissions               | POST /chantier/soumissions
// - PATCH  /chantier/soumissions/:id  (accept -> fixe budget engage du metier)
// - DELETE /chantier/soumissions/:id
// - GET    /chantier/depenses                  | POST /chantier/depenses | DELETE /chantier/depenses/:id
// - GET    /chantier/docs                       | POST /chantier/docs | DELETE /chantier/docs/:id
// - GET    /chantier/docs/:id/raw  (binaire, supporte ?token= pour <img>)

const express = require('express');
const { PrismaClient } = require('@prisma/client');
const auth = require('../middleware/auth');

const prisma = new PrismaClient();
const router = express.Router();

// Les enfants (profile CHILD) n'ont pas acces au chantier.
function adultOnly(req, res, next) {
  if (req.user && req.user.profile === 'CHILD') {
    return res.status(403).json({ erreur: 'Acces reserve aux parents.' });
  }
  next();
}

function adminOnly(req, res, next) {
  if (!req.user || req.user.role !== 'ADMIN') {
    return res.status(403).json({ erreur: "Acces reserve a l'administrateur." });
  }
  next();
}

router.use(auth, adultOnly);

const PROJECT_SLUG = 'chalet';

// Recupere (ou cree) le projet chalet unique. Le seed le cree deja, mais on
// garde un filet de securite ici.
async function getProject() {
  let project = await prisma.chantierProject.findUnique({ where: { slug: PROJECT_SLUG } });
  if (!project) {
    project = await prisma.chantierProject.create({
      data: {
        slug: PROJECT_SLUG,
        name: 'Chantier Chalet',
        address: '396 chemin du lac Mekinac, Trois-Rives',
        budgetTotal: 0,
      },
    });
  }
  return project;
}

function toInt(v, def = 0) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

function parseDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Progression effective d'un jalon (0-100) pour le calcul global.
function jalonProgress(j) {
  if (j.status === 'COMPLETE') return 100;
  if (j.status === 'A_VENIR' || j.status === 'BLOQUE') return Math.max(0, j.progress || 0);
  // EN_COURS / EN_RETARD : on prend le champ progress, min 5 pour montrer que ca bouge
  return Math.max(j.progress || 0, j.status === 'EN_COURS' ? 5 : 0);
}

// ============ OVERVIEW ============

router.get('/overview', async (req, res) => {
  try {
    const project = await getProject();
    const [trades, jalons, soumissions, depenses, contactsCount, debourses, docs] = await Promise.all([
      prisma.trade.findMany({ where: { projectId: project.id }, orderBy: { order: 'asc' } }),
      prisma.jalon.findMany({ where: { projectId: project.id }, orderBy: [{ order: 'asc' }, { dueDate: 'asc' }] }),
      prisma.soumission.findMany({ where: { projectId: project.id } }),
      prisma.depense.findMany({ where: { projectId: project.id } }),
      prisma.contact.count({ where: { projectId: project.id } }),
      prisma.debourseBanque.findMany({ where: { projectId: project.id }, orderBy: [{ order: 'asc' }] }),
      prisma.chantierDoc.findMany({
        where: { projectId: project.id, kind: 'PHOTO' },
        orderBy: { createdAt: 'desc' },
        take: 8,
        select: { id: true, title: true, mimeType: true, createdAt: true, jalonId: true },
      }),
    ]);

    const engage = soumissions
      .filter((s) => s.status === 'ACCEPTEE')
      .reduce((acc, s) => acc + (s.amount || 0), 0);
    const paye = depenses.reduce((acc, d) => acc + (d.amount || 0), 0);
    const restant = (project.budgetTotal || 0) - engage;

    const globalProgress = jalons.length
      ? Math.round(jalons.reduce((acc, j) => acc + jalonProgress(j), 0) / jalons.length)
      : 0;

    const nextJalons = jalons
      .filter((j) => j.status !== 'COMPLETE')
      .sort((a, b) => {
        const da = a.dueDate ? new Date(a.dueDate).getTime() : Infinity;
        const db = b.dueDate ? new Date(b.dueDate).getTime() : Infinity;
        if (da !== db) return da - db;
        return (a.order || 0) - (b.order || 0);
      })
      .slice(0, 5);

    const soumStatus = {
      total: soumissions.length,
      recue: soumissions.filter((s) => s.status === 'RECUE').length,
      enAnalyse: soumissions.filter((s) => s.status === 'EN_ANALYSE').length,
      acceptee: soumissions.filter((s) => s.status === 'ACCEPTEE').length,
      refusee: soumissions.filter((s) => s.status === 'REFUSEE').length,
    };

    // Statut roll-up par metier
    const tradesSummary = trades.map((t) => {
      const tJalons = jalons.filter((j) => j.tradeId === t.id);
      const tSoum = soumissions.filter((s) => s.tradeId === t.id);
      let statut = 'A_VENIR';
      if (tJalons.some((j) => j.status === 'EN_COURS' || j.status === 'EN_RETARD')) statut = 'EN_COURS';
      if (tJalons.length && tJalons.every((j) => j.status === 'COMPLETE')) statut = 'TERMINE';
      else if (tSoum.some((s) => s.status === 'ACCEPTEE')) statut = 'ATTRIBUE';
      else if (tSoum.length) statut = 'SOUMISSIONS';
      return {
        id: t.id,
        name: t.name,
        icon: t.icon,
        color: t.color,
        budgetPrevu: t.budgetPrevu,
        soumissionsCount: tSoum.length,
        statut,
      };
    });

    res.json({
      project,
      budget: {
        total: project.budgetTotal || 0,
        engage,
        paye,
        restant,
      },
      banque: {
        totalPrevu: debourses.reduce((acc, d) => acc + (d.amount || 0), 0),
        totalRecu: debourses.filter((d) => d.recu).reduce((acc, d) => acc + (d.amount || 0), 0),
        count: debourses.length,
        countRecu: debourses.filter((d) => d.recu).length,
        prochain: debourses.find((d) => !d.recu) || null,
      },
      avancementBanque: await prisma.avancementItem.findMany({ where: { projectId: project.id }, select: { weight: true, pct: true } })
        .then((items) => Math.round(items.reduce((acc, it) => acc + (it.weight * it.pct) / 100, 0) * 10) / 10),
      globalProgress,
      counts: {
        trades: trades.length,
        contacts: contactsCount,
        jalons: jalons.length,
        jalonsComplete: jalons.filter((j) => j.status === 'COMPLETE').length,
        jalonsRetard: jalons.filter((j) => j.status === 'EN_RETARD').length,
        soumissions: soumStatus,
        photos: await prisma.chantierDoc.count({ where: { projectId: project.id, kind: 'PHOTO' } }),
      },
      nextJalons,
      trades: tradesSummary,
      recentPhotos: docs,
    });
  } catch (e) {
    console.error('chantier/overview', e);
    res.status(500).json({ erreur: 'Erreur lors du chargement du chantier.' });
  }
});

// ============ PROJECT ============

router.get('/project', async (req, res) => {
  const project = await getProject();
  res.json({ project });
});

router.patch('/project', adminOnly, async (req, res) => {
  try {
    const project = await getProject();
    const { name, address, budgetTotal, startDate, status } = req.body || {};
    const updated = await prisma.chantierProject.update({
      where: { id: project.id },
      data: {
        ...(name !== undefined ? { name: String(name) } : {}),
        ...(address !== undefined ? { address: address ? String(address) : null } : {}),
        ...(budgetTotal !== undefined ? { budgetTotal: toInt(budgetTotal) } : {}),
        ...(startDate !== undefined ? { startDate: parseDate(startDate) } : {}),
        ...(status !== undefined ? { status: String(status) } : {}),
      },
    });
    res.json({ project: updated });
  } catch (e) {
    console.error('chantier/project PATCH', e);
    res.status(500).json({ erreur: 'Erreur lors de la mise a jour du projet.' });
  }
});

// ============ TRADES (corps de metier) ============

router.get('/trades', async (req, res) => {
  const project = await getProject();
  const trades = await prisma.trade.findMany({
    where: { projectId: project.id },
    orderBy: { order: 'asc' },
  });
  res.json({ trades });
});

router.post('/trades', async (req, res) => {
  try {
    const project = await getProject();
    const { name, icon, color, budgetPrevu, order } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ erreur: 'Le nom du metier est requis.' });
    const max = await prisma.trade.aggregate({ where: { projectId: project.id }, _max: { order: true } });
    const trade = await prisma.trade.create({
      data: {
        projectId: project.id,
        name: String(name).trim(),
        icon: icon ? String(icon) : 'hammer',
        color: color ? String(color) : '#BA7517',
        budgetPrevu: toInt(budgetPrevu),
        order: order !== undefined ? toInt(order) : (max._max.order || 0) + 1,
      },
    });
    res.status(201).json({ trade });
  } catch (e) {
    console.error('chantier/trades POST', e);
    res.status(500).json({ erreur: 'Erreur lors de la creation du metier.' });
  }
});

router.patch('/trades/:id', async (req, res) => {
  try {
    const id = toInt(req.params.id);
    const { name, icon, color, budgetPrevu, order } = req.body || {};
    const trade = await prisma.trade.update({
      where: { id },
      data: {
        ...(name !== undefined ? { name: String(name).trim() } : {}),
        ...(icon !== undefined ? { icon: String(icon) } : {}),
        ...(color !== undefined ? { color: String(color) } : {}),
        ...(budgetPrevu !== undefined ? { budgetPrevu: toInt(budgetPrevu) } : {}),
        ...(order !== undefined ? { order: toInt(order) } : {}),
      },
    });
    res.json({ trade });
  } catch (e) {
    console.error('chantier/trades PATCH', e);
    res.status(500).json({ erreur: 'Erreur lors de la mise a jour du metier.' });
  }
});

router.delete('/trades/:id', async (req, res) => {
  try {
    await prisma.trade.delete({ where: { id: toInt(req.params.id) } });
    res.json({ ok: true });
  } catch (e) {
    console.error('chantier/trades DELETE', e);
    res.status(500).json({ erreur: 'Erreur lors de la suppression du metier.' });
  }
});

// ============ CONTACTS ============

router.get('/contacts', async (req, res) => {
  const project = await getProject();
  const contacts = await prisma.contact.findMany({
    where: { projectId: project.id },
    orderBy: { company: 'asc' },
    include: { soumissions: { select: { id: true, amount: true, status: true } } },
  });
  res.json({ contacts });
});

router.post('/contacts', async (req, res) => {
  try {
    const project = await getProject();
    const { company, person, phone, email, website, facebook, instagram, address, rbq, trade, status, notes } = req.body || {};
    if (!company || !String(company).trim()) return res.status(400).json({ erreur: "Le nom de l'entreprise est requis." });
    const contact = await prisma.contact.create({
      data: {
        projectId: project.id,
        company: String(company).trim(),
        person: person ? String(person) : null,
        phone: phone ? String(phone) : null,
        email: email ? String(email) : null,
        website: website ? String(website) : null,
        facebook: facebook ? String(facebook) : null,
        instagram: instagram ? String(instagram) : null,
        address: address ? String(address) : null,
        rbq: rbq ? String(rbq) : null,
        trade: trade ? String(trade) : null,
        status: status ? String(status) : 'PRESSENTI',
        notes: notes ? String(notes) : null,
      },
    });
    res.status(201).json({ contact });
  } catch (e) {
    console.error('chantier/contacts POST', e);
    res.status(500).json({ erreur: 'Erreur lors de la creation du contact.' });
  }
});

router.patch('/contacts/:id', async (req, res) => {
  try {
    const id = toInt(req.params.id);
    const { company, person, phone, email, website, facebook, instagram, address, rbq, trade, status, notes } = req.body || {};
    const contact = await prisma.contact.update({
      where: { id },
      data: {
        ...(company !== undefined ? { company: String(company).trim() } : {}),
        ...(person !== undefined ? { person: person ? String(person) : null } : {}),
        ...(phone !== undefined ? { phone: phone ? String(phone) : null } : {}),
        ...(email !== undefined ? { email: email ? String(email) : null } : {}),
        ...(website !== undefined ? { website: website ? String(website) : null } : {}),
        ...(facebook !== undefined ? { facebook: facebook ? String(facebook) : null } : {}),
        ...(instagram !== undefined ? { instagram: instagram ? String(instagram) : null } : {}),
        ...(address !== undefined ? { address: address ? String(address) : null } : {}),
        ...(rbq !== undefined ? { rbq: rbq ? String(rbq) : null } : {}),
        ...(trade !== undefined ? { trade: trade ? String(trade) : null } : {}),
        ...(status !== undefined ? { status: String(status) } : {}),
        ...(notes !== undefined ? { notes: notes ? String(notes) : null } : {}),
      },
    });
    res.json({ contact });
  } catch (e) {
    console.error('chantier/contacts PATCH', e);
    res.status(500).json({ erreur: 'Erreur lors de la mise a jour du contact.' });
  }
});

router.delete('/contacts/:id', async (req, res) => {
  try {
    await prisma.contact.delete({ where: { id: toInt(req.params.id) } });
    res.json({ ok: true });
  } catch (e) {
    console.error('chantier/contacts DELETE', e);
    res.status(500).json({ erreur: 'Erreur lors de la suppression du contact.' });
  }
});

// ============ JALONS ============

router.get('/jalons', async (req, res) => {
  const project = await getProject();
  const jalons = await prisma.jalon.findMany({
    where: { projectId: project.id },
    orderBy: [{ phase: 'asc' }, { order: 'asc' }, { dueDate: 'asc' }],
    include: {
      trade: { select: { id: true, name: true, color: true } },
      _count: { select: { soumissions: true, docs: true, depenses: true } },
    },
  });
  res.json({ jalons });
});

router.get('/jalons/:id', async (req, res) => {
  try {
    const id = toInt(req.params.id);
    const jalon = await prisma.jalon.findUnique({
      where: { id },
      include: {
        trade: { select: { id: true, name: true, color: true } },
        soumissions: {
          orderBy: { amount: 'asc' },
          include: { contact: { select: { id: true, company: true, person: true, phone: true, email: true } } },
        },
        depenses: { orderBy: { createdAt: 'desc' } },
        docs: {
          orderBy: { createdAt: 'desc' },
          select: { id: true, kind: true, title: true, mimeType: true, fileUrl: true, createdAt: true },
        },
      },
    });
    if (!jalon) return res.status(404).json({ erreur: 'Jalon introuvable.' });
    res.json({ jalon });
  } catch (e) {
    console.error('chantier/jalons/:id', e);
    res.status(500).json({ erreur: 'Erreur lors du chargement du jalon.' });
  }
});

router.post('/jalons', async (req, res) => {
  try {
    const project = await getProject();
    const { name, description, phase, status, progress, dueDate, doneDate, tradeId, order } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ erreur: 'Le nom du jalon est requis.' });
    const max = await prisma.jalon.aggregate({ where: { projectId: project.id }, _max: { order: true } });
    const jalon = await prisma.jalon.create({
      data: {
        projectId: project.id,
        name: String(name).trim(),
        description: description ? String(description) : null,
        phase: phase === 'PRE_CONSTRUCTION' ? 'PRE_CONSTRUCTION' : 'CONSTRUCTION',
        status: status || 'A_VENIR',
        progress: Math.min(100, Math.max(0, toInt(progress))),
        dueDate: parseDate(dueDate),
        doneDate: parseDate(doneDate),
        tradeId: tradeId ? toInt(tradeId) : null,
        order: order !== undefined ? toInt(order) : (max._max.order || 0) + 1,
      },
    });
    res.status(201).json({ jalon });
  } catch (e) {
    console.error('chantier/jalons POST', e);
    res.status(500).json({ erreur: 'Erreur lors de la creation du jalon.' });
  }
});

router.patch('/jalons/:id', async (req, res) => {
  try {
    const id = toInt(req.params.id);
    const { name, description, phase, status, progress, dueDate, doneDate, tradeId, order } = req.body || {};
    // Auto : si on passe COMPLETE sans doneDate, on met aujourd'hui + progress 100
    const data = {
      ...(name !== undefined ? { name: String(name).trim() } : {}),
      ...(description !== undefined ? { description: description ? String(description) : null } : {}),
      ...(phase !== undefined ? { phase: phase === 'PRE_CONSTRUCTION' ? 'PRE_CONSTRUCTION' : 'CONSTRUCTION' } : {}),
      ...(status !== undefined ? { status: String(status) } : {}),
      ...(progress !== undefined ? { progress: Math.min(100, Math.max(0, toInt(progress))) } : {}),
      ...(dueDate !== undefined ? { dueDate: parseDate(dueDate) } : {}),
      ...(doneDate !== undefined ? { doneDate: parseDate(doneDate) } : {}),
      ...(tradeId !== undefined ? { tradeId: tradeId ? toInt(tradeId) : null } : {}),
      ...(order !== undefined ? { order: toInt(order) } : {}),
    };
    if (status === 'COMPLETE') {
      if (data.progress === undefined) data.progress = 100;
      if (dueDate === undefined && doneDate === undefined) data.doneDate = new Date();
    }
    const jalon = await prisma.jalon.update({ where: { id }, data });
    res.json({ jalon });
  } catch (e) {
    console.error('chantier/jalons PATCH', e);
    res.status(500).json({ erreur: 'Erreur lors de la mise a jour du jalon.' });
  }
});

router.delete('/jalons/:id', async (req, res) => {
  try {
    await prisma.jalon.delete({ where: { id: toInt(req.params.id) } });
    res.json({ ok: true });
  } catch (e) {
    console.error('chantier/jalons DELETE', e);
    res.status(500).json({ erreur: 'Erreur lors de la suppression du jalon.' });
  }
});

// ============ SOUMISSIONS ============

router.get('/soumissions', async (req, res) => {
  const project = await getProject();
  const where = { projectId: project.id };
  if (req.query.jalonId) where.jalonId = toInt(req.query.jalonId);
  if (req.query.tradeId) where.tradeId = toInt(req.query.tradeId);
  const soumissions = await prisma.soumission.findMany({
    where,
    orderBy: [{ amount: 'asc' }],
    include: {
      contact: { select: { id: true, company: true, person: true, phone: true, email: true } },
      trade: { select: { id: true, name: true, color: true } },
      jalon: { select: { id: true, name: true } },
    },
  });
  res.json({ soumissions });
});

router.post('/soumissions', async (req, res) => {
  try {
    const project = await getProject();
    const { label, amount, status, receivedAt, notes, tradeId, jalonId, contactId } = req.body || {};
    const soumission = await prisma.soumission.create({
      data: {
        projectId: project.id,
        label: label ? String(label) : null,
        amount: toInt(amount),
        status: status || 'RECUE',
        receivedAt: parseDate(receivedAt) || new Date(),
        notes: notes ? String(notes) : null,
        tradeId: tradeId ? toInt(tradeId) : null,
        jalonId: jalonId ? toInt(jalonId) : null,
        contactId: contactId ? toInt(contactId) : null,
      },
      include: {
        contact: { select: { id: true, company: true, person: true, phone: true } },
      },
    });
    // Si un contact est rattache, on le marque "soumission recue" (sauf s'il est deja retenu)
    if (soumission.contactId) {
      await prisma.contact.updateMany({
        where: { id: soumission.contactId, status: 'PRESSENTI' },
        data: { status: 'SOUMISSION_RECUE' },
      });
    }
    res.status(201).json({ soumission });
  } catch (e) {
    console.error('chantier/soumissions POST', e);
    res.status(500).json({ erreur: 'Erreur lors de la creation de la soumission.' });
  }
});

router.patch('/soumissions/:id', async (req, res) => {
  try {
    const id = toInt(req.params.id);
    const { label, amount, status, receivedAt, notes, tradeId, jalonId, contactId } = req.body || {};
    const soumission = await prisma.soumission.update({
      where: { id },
      data: {
        ...(label !== undefined ? { label: label ? String(label) : null } : {}),
        ...(amount !== undefined ? { amount: toInt(amount) } : {}),
        ...(status !== undefined ? { status: String(status) } : {}),
        ...(receivedAt !== undefined ? { receivedAt: parseDate(receivedAt) } : {}),
        ...(notes !== undefined ? { notes: notes ? String(notes) : null } : {}),
        ...(tradeId !== undefined ? { tradeId: tradeId ? toInt(tradeId) : null } : {}),
        ...(jalonId !== undefined ? { jalonId: jalonId ? toInt(jalonId) : null } : {}),
        ...(contactId !== undefined ? { contactId: contactId ? toInt(contactId) : null } : {}),
      },
    });
    // Accepter une soumission : fixe le budget prevu du metier + marque le contact RETENU
    // + refuse les autres soumissions concurrentes du meme jalon.
    if (status === 'ACCEPTEE') {
      if (soumission.tradeId) {
        await prisma.trade.update({
          where: { id: soumission.tradeId },
          data: { budgetPrevu: soumission.amount },
        });
      }
      if (soumission.contactId) {
        await prisma.contact.update({ where: { id: soumission.contactId }, data: { status: 'RETENU' } });
      }
      if (soumission.jalonId) {
        await prisma.soumission.updateMany({
          where: { jalonId: soumission.jalonId, id: { not: soumission.id }, status: { in: ['RECUE', 'EN_ANALYSE'] } },
          data: { status: 'REFUSEE' },
        });
      }
    }
    res.json({ soumission });
  } catch (e) {
    console.error('chantier/soumissions PATCH', e);
    res.status(500).json({ erreur: 'Erreur lors de la mise a jour de la soumission.' });
  }
});

router.delete('/soumissions/:id', async (req, res) => {
  try {
    await prisma.soumission.delete({ where: { id: toInt(req.params.id) } });
    res.json({ ok: true });
  } catch (e) {
    console.error('chantier/soumissions DELETE', e);
    res.status(500).json({ erreur: 'Erreur lors de la suppression de la soumission.' });
  }
});

// ============ DEPENSES ============

router.get('/depenses', async (req, res) => {
  const project = await getProject();
  const depenses = await prisma.depense.findMany({
    where: { projectId: project.id },
    orderBy: { createdAt: 'desc' },
    include: {
      trade: { select: { id: true, name: true } },
      jalon: { select: { id: true, name: true } },
    },
  });
  res.json({ depenses });
});

router.post('/depenses', async (req, res) => {
  try {
    const project = await getProject();
    const { label, amount, type, method, paidAt, notes, tradeId, jalonId, soumissionId } = req.body || {};
    const depense = await prisma.depense.create({
      data: {
        projectId: project.id,
        label: label ? String(label) : null,
        amount: toInt(amount),
        type: type || 'PARTIEL',
        method: method ? String(method) : null,
        paidAt: parseDate(paidAt) || new Date(),
        notes: notes ? String(notes) : null,
        tradeId: tradeId ? toInt(tradeId) : null,
        jalonId: jalonId ? toInt(jalonId) : null,
        soumissionId: soumissionId ? toInt(soumissionId) : null,
      },
    });
    res.status(201).json({ depense });
  } catch (e) {
    console.error('chantier/depenses POST', e);
    res.status(500).json({ erreur: 'Erreur lors de la creation de la depense.' });
  }
});

router.delete('/depenses/:id', async (req, res) => {
  try {
    await prisma.depense.delete({ where: { id: toInt(req.params.id) } });
    res.json({ ok: true });
  } catch (e) {
    console.error('chantier/depenses DELETE', e);
    res.status(500).json({ erreur: 'Erreur lors de la suppression de la depense.' });
  }
});

// ============ DOCS (plans / permis / photos) ============

// Liste : metadata seulement (jamais fileData, trop lourd).
router.get('/docs', async (req, res) => {
  const project = await getProject();
  const where = { projectId: project.id };
  if (req.query.kind) where.kind = String(req.query.kind);
  if (req.query.jalonId) where.jalonId = toInt(req.query.jalonId);
  const docs = await prisma.chantierDoc.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, kind: true, title: true, mimeType: true, fileUrl: true,
      width: true, height: true, takenAt: true, createdAt: true, jalonId: true, tradeId: true,
    },
  });
  res.json({ docs });
});

router.post('/docs', async (req, res) => {
  try {
    const project = await getProject();
    const { kind, title, fileData, fileUrl, mimeType, width, height, takenAt, jalonId, tradeId, soumissionId } = req.body || {};
    if (!title || !String(title).trim()) return res.status(400).json({ erreur: 'Le titre du document est requis.' });
    if (!fileData && !fileUrl) return res.status(400).json({ erreur: 'Un fichier ou un lien est requis.' });
    // Limite base64 ~60 MB (express.json limit 80mb) — permet les plans PDF complets
    if (fileData && String(fileData).length > 60 * 1024 * 1024) {
      return res.status(413).json({ erreur: 'Fichier trop volumineux (max ~40 Mo).' });
    }
    const doc = await prisma.chantierDoc.create({
      data: {
        projectId: project.id,
        kind: kind || 'AUTRE',
        title: String(title).trim(),
        fileData: fileData ? String(fileData) : null,
        fileUrl: fileUrl ? String(fileUrl) : null,
        mimeType: mimeType ? String(mimeType) : null,
        width: width ? toInt(width) : null,
        height: height ? toInt(height) : null,
        takenAt: parseDate(takenAt),
        jalonId: jalonId ? toInt(jalonId) : null,
        tradeId: tradeId ? toInt(tradeId) : null,
        soumissionId: soumissionId ? toInt(soumissionId) : null,
      },
      select: { id: true, kind: true, title: true, mimeType: true, createdAt: true, jalonId: true },
    });
    res.status(201).json({ doc });
  } catch (e) {
    console.error('chantier/docs POST', e);
    res.status(500).json({ erreur: 'Erreur lors du televersement du document.' });
  }
});

// Binaire : sert le fichier. Supporte ?token= (middleware auth) pour <img>/<a>.
router.get('/docs/:id/raw', async (req, res) => {
  try {
    const doc = await prisma.chantierDoc.findUnique({ where: { id: toInt(req.params.id) } });
    if (!doc) return res.status(404).json({ erreur: 'Document introuvable.' });
    if (doc.fileUrl && !doc.fileData) return res.redirect(doc.fileUrl);
    if (!doc.fileData) return res.status(404).json({ erreur: 'Aucun fichier.' });
    const m = /^data:([^;]+);base64,(.*)$/s.exec(doc.fileData);
    if (!m) return res.status(500).json({ erreur: 'Format de fichier invalide.' });
    const mime = m[1];
    const buf = Buffer.from(m[2], 'base64');
    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.send(buf);
  } catch (e) {
    console.error('chantier/docs/:id/raw', e);
    res.status(500).json({ erreur: 'Erreur lors du chargement du fichier.' });
  }
});

router.delete('/docs/:id', async (req, res) => {
  try {
    await prisma.chantierDoc.delete({ where: { id: toInt(req.params.id) } });
    res.json({ ok: true });
  } catch (e) {
    console.error('chantier/docs DELETE', e);
    res.status(500).json({ erreur: 'Erreur lors de la suppression du document.' });
  }
});

// ============ GRILLE D'AVANCEMENT BANQUE (inspection progressive) ============

router.get('/avancement', async (req, res) => {
  const project = await getProject();
  const items = await prisma.avancementItem.findMany({
    where: { projectId: project.id },
    orderBy: [{ stade: 'asc' }, { order: 'asc' }],
  });
  const global = Math.round(items.reduce((acc, it) => acc + (it.weight * it.pct) / 100, 0) * 10) / 10;
  res.json({ items, global });
});

router.patch('/avancement/:id', async (req, res) => {
  try {
    const id = toInt(req.params.id);
    const { pct } = req.body || {};
    const clamped = Math.max(0, Math.min(100, toInt(pct)));
    const item = await prisma.avancementItem.update({ where: { id }, data: { pct: clamped } });
    res.json({ item });
  } catch (e) {
    console.error('chantier/avancement PATCH', e);
    res.status(500).json({ erreur: "Erreur lors de la mise à jour de l'avancement." });
  }
});

// ============ DEBOURSES BANQUE (financement progressif) ============

router.get('/debourses', async (req, res) => {
  const project = await getProject();
  const debourses = await prisma.debourseBanque.findMany({
    where: { projectId: project.id },
    orderBy: [{ order: 'asc' }, { datePrevue: 'asc' }],
  });
  res.json({ debourses });
});

router.post('/debourses', async (req, res) => {
  try {
    const project = await getProject();
    const { label, amount, condition, datePrevue, order } = req.body || {};
    if (!label || !String(label).trim()) return res.status(400).json({ erreur: 'Le nom du déboursé est requis.' });
    const max = await prisma.debourseBanque.aggregate({ where: { projectId: project.id }, _max: { order: true } });
    const debourse = await prisma.debourseBanque.create({
      data: {
        projectId: project.id,
        label: String(label).trim(),
        amount: toInt(amount),
        condition: condition ? String(condition) : null,
        datePrevue: parseDate(datePrevue),
        order: order !== undefined ? toInt(order) : (max._max.order || 0) + 1,
      },
    });
    res.status(201).json({ debourse });
  } catch (e) {
    console.error('chantier/debourses POST', e);
    res.status(500).json({ erreur: 'Erreur lors de la création du déboursé banque.' });
  }
});

router.patch('/debourses/:id', async (req, res) => {
  try {
    const id = toInt(req.params.id);
    const { label, amount, condition, datePrevue, dateRecu, recu, order } = req.body || {};
    const debourse = await prisma.debourseBanque.update({
      where: { id },
      data: {
        ...(label !== undefined ? { label: String(label).trim() } : {}),
        ...(amount !== undefined ? { amount: toInt(amount) } : {}),
        ...(condition !== undefined ? { condition: condition ? String(condition) : null } : {}),
        ...(datePrevue !== undefined ? { datePrevue: parseDate(datePrevue) } : {}),
        ...(dateRecu !== undefined ? { dateRecu: parseDate(dateRecu) } : {}),
        ...(recu !== undefined ? { recu: !!recu, ...(recu && !dateRecu ? { dateRecu: new Date() } : {}) } : {}),
        ...(order !== undefined ? { order: toInt(order) } : {}),
      },
    });
    res.json({ debourse });
  } catch (e) {
    console.error('chantier/debourses PATCH', e);
    res.status(500).json({ erreur: 'Erreur lors de la mise à jour du déboursé banque.' });
  }
});

router.delete('/debourses/:id', async (req, res) => {
  try {
    await prisma.debourseBanque.delete({ where: { id: toInt(req.params.id) } });
    res.json({ ok: true });
  } catch (e) {
    console.error('chantier/debourses DELETE', e);
    res.status(500).json({ erreur: 'Erreur lors de la suppression du déboursé banque.' });
  }
});

module.exports = router;
