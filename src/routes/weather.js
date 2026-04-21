// Mission Control — /weather
// Proxy Open-Meteo pour la météo Trois-Rives / Lac Mékinac.
// - Zéro clé API requise (Open-Meteo gratuit)
// - Cache in-memory 10 min pour éviter de hammer l'API
// - Renvoie un format normalisé utilisable par le frontend.

const express = require('express');

const router = express.Router();

// Lac Mékinac (secteur Trois-Rives, QC). Coordonnées approximatives du plan d'eau.
const LAT = 46.8707;
const LON = -72.8094;
const LOCATION_LABEL = 'Lac Mékinac · Trois-Rives';

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
let cache = { ts: 0, payload: null };

// Code WMO → { label, iconSlug }
// iconSlug est un identifiant libre que le frontend mappe vers un icône FontAwesome.
function decodeWeatherCode(code) {
  const c = Number(code);
  if (c === 0) return { label: 'Ciel clair', iconSlug: 'sun' };
  if (c === 1) return { label: 'Principalement clair', iconSlug: 'sun' };
  if (c === 2) return { label: 'Partiellement nuageux', iconSlug: 'cloud-sun' };
  if (c === 3) return { label: 'Couvert', iconSlug: 'cloud' };
  if (c === 45 || c === 48) return { label: 'Brouillard', iconSlug: 'smog' };
  if (c >= 51 && c <= 57) return { label: 'Bruine', iconSlug: 'cloud-rain' };
  if (c >= 61 && c <= 67) return { label: 'Pluie', iconSlug: 'cloud-showers-heavy' };
  if (c >= 71 && c <= 77) return { label: 'Neige', iconSlug: 'snowflake' };
  if (c >= 80 && c <= 82) return { label: 'Averses', iconSlug: 'cloud-showers-heavy' };
  if (c >= 85 && c <= 86) return { label: 'Averses de neige', iconSlug: 'snowflake' };
  if (c === 95) return { label: 'Orage', iconSlug: 'bolt' };
  if (c === 96 || c === 99) return { label: 'Orage + grêle', iconSlug: 'bolt' };
  return { label: 'Inconnu', iconSlug: 'cloud' };
}

async function fetchFromOpenMeteo() {
  // Endpoint doc: https://open-meteo.com/en/docs
  const params = new URLSearchParams({
    latitude: String(LAT),
    longitude: String(LON),
    timezone: 'America/Toronto',
    current: [
      'temperature_2m',
      'apparent_temperature',
      'relative_humidity_2m',
      'wind_speed_10m',
      'wind_direction_10m',
      'weather_code',
      'is_day',
    ].join(','),
    hourly: [
      'temperature_2m',
      'weather_code',
      'precipitation_probability',
    ].join(','),
    forecast_hours: '24',
    wind_speed_unit: 'kmh',
    temperature_unit: 'celsius',
  });

  const url = 'https://api.open-meteo.com/v1/forecast?' + params.toString();
  const res = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' } });
  if (!res.ok) {
    throw new Error('Open-Meteo a répondu ' + res.status);
  }
  return res.json();
}

function normalize(raw) {
  const current = raw.current || {};
  const hourly = raw.hourly || {};
  const currentInfo = decodeWeatherCode(current.weather_code);

  const forecast = [];
  const len = Math.min((hourly.time || []).length, 24);
  for (let i = 0; i < len; i++) {
    forecast.push({
      time: hourly.time[i],
      tempC: typeof hourly.temperature_2m?.[i] === 'number' ? hourly.temperature_2m[i] : null,
      weatherCode: hourly.weather_code?.[i] ?? null,
      weatherLabel: decodeWeatherCode(hourly.weather_code?.[i]).label,
      iconSlug: decodeWeatherCode(hourly.weather_code?.[i]).iconSlug,
      precipProbability: hourly.precipitation_probability?.[i] ?? null,
    });
  }

  return {
    location: {
      label: LOCATION_LABEL,
      lat: LAT,
      lon: LON,
    },
    current: {
      tempC: current.temperature_2m ?? null,
      feelsLikeC: current.apparent_temperature ?? null,
      humidity: current.relative_humidity_2m ?? null,
      windKmh: current.wind_speed_10m ?? null,
      windDir: current.wind_direction_10m ?? null,
      weatherCode: current.weather_code ?? null,
      weatherLabel: currentInfo.label,
      iconSlug: currentInfo.iconSlug,
      isDay: current.is_day === 1 || current.is_day === true,
      observedAt: current.time || new Date().toISOString(),
    },
    forecast,
    fetchedAt: new Date().toISOString(),
    source: 'open-meteo',
  };
}

router.get('/trois-rives', async (req, res) => {
  try {
    const now = Date.now();
    if (cache.payload && now - cache.ts < CACHE_TTL_MS) {
      return res.json({ ...cache.payload, cached: true });
    }
    const raw = await fetchFromOpenMeteo();
    const normalized = normalize(raw);
    cache = { ts: now, payload: normalized };
    return res.json({ ...normalized, cached: false });
  } catch (err) {
    console.error('[weather] échec Open-Meteo:', err.message);
    // Si on a un cache stale, on le ressort en mode dégradé.
    if (cache.payload) {
      return res.json({ ...cache.payload, cached: true, stale: true });
    }
    return res.status(502).json({ erreur: 'Météo indisponible pour le moment.' });
  }
});

module.exports = router;
