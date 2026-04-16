// Keep-alive / heartbeat auto-ping.
//
// Render Free plan suspend un service web après ~15 min sans requête externe.
// On auto-pique via l'URL externe (pas localhost) pour que la requête passe
// par le load balancer Render et reset le minuteur d'inactivité.
//
// Cette stratégie maintient le serveur chaud TANT qu'il est éveillé. Combinée
// au cron externe (GitHub Actions), elle garantit une disponibilité continue.
// Seule, elle évite au moins les cold-starts pendant une session active.
//
// Activée uniquement si KEEP_ALIVE_URL est défini (ex: via Render env var).

const DEFAULT_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const DEFAULT_TIMEOUT_MS = 20 * 1000;       // 20 s

function log(msg) {
  console.log(`[keep-alive] ${new Date().toISOString()} ${msg}`);
}

async function pingOnce(url, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': 'mc-keep-alive/1.0' },
      signal: ctrl.signal,
    });
    log(`ping ${url} → ${res.status}`);
    return res.ok;
  } catch (err) {
    log(`ping ${url} FAILED: ${err.message}`);
    return false;
  } finally {
    clearTimeout(t);
  }
}

function start() {
  const url = process.env.KEEP_ALIVE_URL;
  if (!url) {
    log('KEEP_ALIVE_URL non défini — heartbeat interne désactivé');
    return;
  }
  const interval = Number(process.env.KEEP_ALIVE_INTERVAL_MS) || DEFAULT_INTERVAL_MS;
  const timeout = Number(process.env.KEEP_ALIVE_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  log(`activé — ${url} toutes les ${Math.round(interval / 1000)}s`);

  // Petit délai initial pour laisser le serveur finir son boot + premier
  // trafic user avant de commencer à se piquer lui-même.
  setTimeout(() => {
    pingOnce(url, timeout); // premier ping
    setInterval(() => pingOnce(url, timeout), interval).unref();
  }, 30 * 1000);
}

module.exports = { start };
