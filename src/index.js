// My Mission Control — API Express
// Point d'entrée du backend.

require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const adminRoutes = require('./routes/admin');
const keepAlive = require('./keep-alive');

const app = express();
const PORT = process.env.PORT || 3000;

// Sécurité
app.use(helmet());

// CORS — autorise le frontend public + Render .onrender.com
const allowedOrigins = [
  process.env.FRONTEND_URL || 'https://my-mission-control.com',
  'https://my-mission-control.com',
  'https://www.my-mission-control.com',
  'https://app.my-mission-control.com',
];

app.use(
  cors({
    origin: (origin, cb) => {
      // Autorise les calls sans origin (curl, mobile app) et les origines explicites
      if (!origin) return cb(null, true);
      if (allowedOrigins.includes(origin)) return cb(null, true);
      // Autorise tous les .onrender.com en preview
      if (origin.endsWith('.onrender.com')) return cb(null, true);
      return cb(new Error('Origine CORS non autorisée: ' + origin));
    },
    credentials: true,
  })
);

app.use(express.json({ limit: '1mb' }));

// Healthcheck
app.get('/', (req, res) => {
  res.json({ service: 'mission-control-api', status: 'ok', version: '0.1.0' });
});
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// Routes
app.use('/auth', authRoutes);
app.use('/users', userRoutes);
app.use('/admin', adminRoutes);

// 404
app.use((req, res) => {
  res.status(404).json({ erreur: 'Route introuvable.' });
});

// Handler d'erreur global
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ erreur: 'Erreur interne du serveur.' });
});

app.listen(PORT, () => {
  console.log(`🚀