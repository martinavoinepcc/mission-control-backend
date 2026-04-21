// Mission Control — /hubitat
// Routes de contrôle Hubitat.
//
// Modes :
//   - STUB (par défaut) : pas de HUBITAT_MAKER_TOKEN + HUBITAT_MAKER_URL en env.
//     Renvoie des devices simulés (2 thermostats chalet) avec data qui bougent
//     légèrement pour tester l'UI.
//   - LIVE : env vars set → proxy vers Hubitat Maker API Cloud.
//     (Implémentation câblée ci-dessous — il faut juste les env vars pour activer.)
//
// Pourquoi proxy côté backend plutôt que direct browser→Hubitat :
//   - Le token Maker ne doit jamais être exposé au client.
//   - On peut logger chaque appel pour la future couche AI (persistence à ajouter
//     quand Prisma sera câblé — round 2).

const express = require('express');

const router = express.Router();

// -------- Config --------
const MAKER_URL = process.env.HUBITAT_MAKER_URL || null; // ex: https://cloud.hubitat.com/api/{hubId}/apps/{appId}
const MAKER_TOKEN = process.env.HUBITAT_MAKER_TOKEN || null;
const LIVE = Boolean(MAKER_URL && MAKER_TOKEN);

// Mapping location → device IDs réels (à remplir quand Maker sera activé via env vars).
// Format env: HUBITAT_CHALET_THERMOSTATS="123,456"
function deviceIdsFor(location) {
  const key = location === 'CHALET' ? 'HUBITAT_CHALET_THERMOSTATS' : 'HUBITAT_MAISON_THERMOSTATS';
  const raw = process.env[key] || '';
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

// -------- STUB : state interne qui drift légèrement pour rendre l'UI vivante --------
// Pas de persistence (repart à chaque redeploy). Sera remplacé par Prisma quand LIVE.
const stubState = {
  CHALET: {
    devices: [
      {
        hubitatId: 'stub-chalet-salon',
        type: 'THERMOSTAT',
        label: 'Salon',
        room: 'Salon',
        currentTemp: 18.5,
        setpoint: 21,
        operatingState: 'heating',
        humidity: 45,
        mode: 'heat',
      },
      {
        hubitatId: 'stub-chalet-chambres',
        type: 'THERMOSTAT',
        label: 'Chambres',
        room: 'Chambres',
        currentTemp: 17.2,
        setpoint: 19,
        operatingState: 'heating',
        humidity: 48,
        mode: 'heat',
      },
    ],
    history: [], // { takenAt, deviceId, currentTemp, setpoint, operatingState, outdoorTemp }
    activePreset: null, // { slug, scheduledReturnAt, appliedAt }
  },
  MAISON: {
    devices: [
      {
        hubitatId: 'stub-maison-principal',
        type: 'THERMOSTAT',
        label: 'Principal',
        room: 'Principal',
        currentTemp: 20.1,
        setpoint: 21,
        operatingState: 'idle',
        humidity: 42,
        mode: 'heat',
      },
    ],
    history: [],
    activePreset: null,
  },
};

// Drift simulé : on fait bouger les températures vers leur setpoint à chaque call.
function driftStubTemps(location) {
  const s = stubState[location];
  if (!s) return;
  for (const d of s.devices) {
    const diff = d.setpoint - d.currentTemp;
    const step = Math.max(-0.3, Math.min(0.3, diff * 0.15 + (Math.random() - 0.5) * 0.1));
    d.currentTemp = Math.round((d.currentTemp + step) * 10) / 10;
    d.operatingState = Math.abs(diff) < 0.3 ? 'idle' : (diff > 0 ? 'heating' : 'cooling');
  }
}

function takeSnapshot(location, outdoorTemp) {
  const s = stubState[location];
  if (!s) return;
  const now = new Date().toISOString();
  for (const d of s.devices) {
    s.history.push({
      takenAt: now,
      deviceId: d.hubitatId,
      currentTemp: d.currentTemp,
      setpoint: d.setpoint,
      operatingState: d.operatingState,
      outdoorTemp: outdoorTemp ?? null,
    });
  }
  // Garde 7 jours max (600 points par device).
  if (s.history.length > 600 * s.devices.length) {
    s.history.splice(0, s.history.length - 600 * s.devices.length);
  }
}

// -------- Helpers LIVE (proxy vers Maker Cloud) --------
async function makerCall(path) {
  const url = MAKER_URL.replace(/\/$/, '') + path + (path.includes('?') ? '&' : '?') + 'access_token=' + encodeURIComponent(MAKER_TOKEN);
  const res = await fetch(url, { method: 'GET' });
  if (!res.ok) throw new Error('Maker API ' + res.status);
  return res.json();
}

// -------- Routes --------

// GET /hubitat/devices?location=CHALET
router.get('/devices', async (req, res) => {
  const location = (req.query.location || 'CHALET').toString().toUpperCase();
  if (!['MAISON', 'CHALET'].includes(location)) {
    return res.status(400).json({ erreur: 'location doit être MAISON ou CHALET.' });
  }

  try {
    if (LIVE) {
      const ids = deviceIdsFor(location);
      const devices = [];
      for (const id of ids) {
        try {
          const raw = await makerCall('/devices/' + id);
          devices.push({
            hubitatId: String(raw.id),
            type: 'THERMOSTAT',
            label: raw.label || raw.name || ('Thermostat ' + id),
            room: raw.room || '—',
            currentTemp: Number(raw.attributes?.find?.((a) => a.name === 'temperature')?.currentValue ?? null),
            setpoint: Number(raw.attributes?.find?.((a) => a.name === 'heatingSetpoint')?.currentValue ?? null),
            operatingState: raw.attributes?.find?.((a) => a.name === 'thermostatOperatingState')?.currentValue ?? 'idle',
            humidity: Number(raw.attributes?.find?.((a) => a.name === 'humidity')?.currentValue ?? null) || null,
            mode: raw.attributes?.find?.((a) => a.name === 'thermostatMode')?.currentValue ?? 'heat',
          });
        } catch (e) {
          console.error('[hubitat] device ' + id + ' fail:', e.message);
        }
      }
      return res.json({ mode: 'LIVE', location, devices, activePreset: null });
    }

    // STUB
    driftStubTemps(location);
    const s = stubState[location];
    return res.json({
      mode: 'STUB',
      location,
      devices: s.devices.map((d) => ({ ...d })),
      activePreset: s.activePreset,
      note: 'Mode simulation — active Maker API pour brancher les vraies valeurs (voir GUIDE-activer-maker-api-hubitat.md).',
    });
  } catch (err) {
    console.error('[hubitat] /devices error:', err.message);
    return res.status(500).json({ erreur: 'Impossible de lire les thermostats.' });
  }
});

// POST /hubitat/devices/:hubitatId/setpoint  { value, location }
router.post('/devices/:hubitatId/setpoint', async (req, res) => {
  const { value, location } = req.body || {};
  const loc = (location || 'CHALET').toString().toUpperCase();
  const setpoint = Number(value);
  if (!Number.isFinite(setpoint) || setpoint < 5 || setpoint > 30) {
    return res.status(400).json({ erreur: 'Consigne invalide (doit être 5–30 °C).' });
  }
  if (!['MAISON', 'CHALET'].includes(loc)) {
    return res.status(400).json({ erreur: 'location invalide.' });
  }

  try {
    if (LIVE) {
      await makerCall('/devices/' + encodeURIComponent(req.params.hubitatId) + '/setHeatingSetpoint/' + setpoint);
      return res.json({ mode: 'LIVE', ok: true });
    }
    // STUB
    const s = stubState[loc];
    const d = s?.devices.find((x) => x.hubitatId === req.params.hubitatId);
    if (!d) return res.status(404).json({ erreur: 'Thermostat introuvable.' });
    d.setpoint = setpoint;
    return res.json({ mode: 'STUB', ok: true, device: { ...d } });
  } catch (err) {
    console.error('[hubitat] setpoint error:', err.message);
    return res.status(500).json({ erreur: 'Impossible de pousser la consigne.' });
  }
});

// POST /hubitat/preset  { slug, location, scheduledReturnAt? }
// Presets intégrés (définis ici — peuvent migrer en DB plus tard).
const PRESETS = {
  confort: { label: 'Confort', setpoint: 21, mode: 'heat' },
  eco: { label: 'Éco', setpoint: 17, mode: 'heat' },
  soiree: { label: 'Soirée', setpoint: 20, mode: 'heat' },
  away: { label: 'Absence', setpoint: 12, mode: 'heat' },
  'away-horaire': { label: 'Absence horaire', setpoint: 14, mode: 'heat' }, // avec return scheduled
};

router.post('/preset', async (req, res) => {
  const { slug, location, scheduledReturnAt } = req.body || {};
  const loc = (location || 'CHALET').toString().toUpperCase();
  const preset = PRESETS[slug];
  if (!preset) return res.status(400).json({ erreur: 'Preset inconnu.' });
  if (!['MAISON', 'CHALET'].includes(loc)) return res.status(400).json({ erreur: 'location invalide.' });

  try {
    if (LIVE) {
      const ids = deviceIdsFor(loc);
      for (const id of ids) {
        await makerCall('/devices/' + id + '/setHeatingSetpoint/' + preset.setpoint);
      }
      return res.json({ mode: 'LIVE', ok: true, applied: { slug, setpoint: preset.setpoint, scheduledReturnAt: scheduledReturnAt || null } });
    }
    // STUB
    const s = stubState[loc];
    if (!s) return res.status(404).json({ erreur: 'Location introuvable.' });
    for (const d of s.devices) d.setpoint = preset.setpoint;
    s.activePreset = {
      slug,
      label: preset.label,
      setpoint: preset.setpoint,
      appliedAt: new Date().toISOString(),
      scheduledReturnAt: scheduledReturnAt || null,
    };
    return res.json({ mode: 'STUB', ok: true, applied: s.activePreset, devices: s.devices.map((d) => ({ ...d })) });
  } catch (err) {
    console.error('[hubitat] preset error:', err.message);
    return res.status(500).json({ erreur: 'Impossible d’appliquer le preset.' });
  }
});

// GET /hubitat/history?location=CHALET&hours=24
router.get('/history', async (req, res) => {
  const location = (req.query.location || 'CHALET').toString().toUpperCase();
  const hours = Math.max(1, Math.min(168, Number(req.query.hours) || 24));
  if (!['MAISON', 'CHALET'].includes(location)) {
    return res.status(400).json({ erreur: 'location invalide.' });
  }

  if (LIVE) {
    // Pas encore persisté en DB — à implémenter en round 2.
    return res.json({ mode: 'LIVE', location, hours, points: [], note: 'Historique en DB à venir (round 2 quand Prisma câblé).' });
  }

  // STUB : si l'historique est vide, on génère une courbe synthétique plausible sur 24h
  // pour que le graphe ait quelque chose à afficher.
  const s = stubState[location];
  if (!s) return res.status(404).json({ erreur: 'Location introuvable.' });
  if (s.history.length < 10) {
    const now = Date.now();
    const synthetic = [];
    for (let h = hours; h >= 0; h--) {
      const t = new Date(now - h * 3600 * 1000).toISOString();
      const baseOutdoor = -8 + 6 * Math.sin((h / 24) * Math.PI * 2);
      for (const d of s.devices) {
        synthetic.push({
          takenAt: t,
          deviceId: d.hubitatId,
          currentTemp: d.setpoint - 2 + Math.sin((h + d.hubitatId.length) / 3) * 0.8 + (Math.random() - 0.5) * 0.2,
          setpoint: d.setpoint,
          operatingState: Math.random() > 0.5 ? 'heating' : 'idle',
          outdoorTemp: baseOutdoor,
        });
      }
    }
    return res.json({ mode: 'STUB', location, hours, points: synthetic, synthetic: true });
  }

  const cutoff = Date.now() - hours * 3600 * 1000;
  const points = s.history.filter((p) => new Date(p.takenAt).getTime() >= cutoff);
  return res.json({ mode: 'STUB', location, hours, points });
});

// POST /hubitat/snapshot?location=CHALET  (endpoint interne — cron)
router.post('/snapshot', async (req, res) => {
  const location = (req.query.location || 'CHALET').toString().toUpperCase();
  if (!['MAISON', 'CHALET'].includes(location)) return res.status(400).json({ erreur: 'location invalide.' });
  if (!LIVE) {
    driftStubTemps(location);
    takeSnapshot(location, null);
    return res.json({ mode: 'STUB', ok: true });
  }
  return res.json({ mode: 'LIVE', ok: true, note: 'Snapshot persistance — à câbler en round 2 avec Prisma.' });
});

module.exports = router;
module.exports.LIVE = LIVE;
