// Vérifie que l'utilisateur connecté est ADMIN. À utiliser APRÈS le middleware auth.
function admin(req, res, next) {
  if (!req.user || req.user.role !== 'ADMIN') {
    return res.status(403).json({ erreur: 'Accès réservé à l\'administrateur.' });
  }
  next();
}

module.exports = admin;
