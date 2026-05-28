// Vérifie le JWT dans l'en-tête Authorization: Bearer <token>
const jwt = require('jsonwebtoken');

function auth(req, res, next) {
  const header = req.headers.authorization || '';
  let token = header.startsWith('Bearer ') ? header.slice(7) : null;
  // Fallback: <img src>/<audio src> ne peuvent pas porter un header Authorization,
  // donc on accepte aussi ?token=<jwt> pour les routes binaires (images, audio, avatars).
  if (!token && req.query && typeof req.query.token === 'string' && req.query.token) {
    token = req.query.token;
  }

  if (!token) {
    return res.status(401).json({ erreur: 'Authentification requise.' });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload;
    next();
  } catch (err) {
    return res.status(401).json({ erreur: 'Session expirée ou invalide.' });
  }
}

module.exports = auth;
