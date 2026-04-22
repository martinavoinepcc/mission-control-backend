// My Mission Control - API Express

require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const adminRoutes = require('./routes/admin');
const educatifRoutes = require('./routes/educatif');
const adminEducatifRoutes = require('./routes/admin-educatif');
const improvRoutes = require('./routes/improv');
const kazRoutes = require('./routes/kaz');
const weatherRoutes = require('./routes/weather');
const hubitatRoutes = require('./routes/hubitat');
const pushRoutes = require('./routes/push');
const messagerieRoutes = require('./routes/messagerie');
const keepAlive = require('./keep-alive');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(helmet());

const allowedOrigins = [
  process.env.FRONTEND_URL || 'https://my-mission-control.com',
  'https://my-mission-control.com',
  'https://www.my-mission-control.com',
  'https://app.my-mission-control.com',
];

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (allowedOrigins.includes(origin)) return cb(null, true);
      if (origin.endsWith('.onrender.com')) return cb(null, true);
      return cb(new Error('Origine CORS non autorisee: ' + origin));
    },
    credentials: true,
  })
);

app.use(express.json({ limit: '1mb' }));

app.get('/', (req, res) => {
  res.json({ service: 'mission-control-api', status: 'ok', version: '0.1.0' });
});
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

app.use('/auth', authRoutes);
app.use('/users', userRoutes);
app.use('/admin', adminRoutes);
app.use('/educatif', educatifRoutes);
app.use('/admin/educatif', adminEducatifRoutes);
app.use('/improv', improvRoutes);
app.use('/kaz', kazRoutes);
app.use('/weather', weatherRoutes);
app.use('/hubitat', hubitatRoutes);
app.use('/push', pushRoutes);
app.use('/conversations', messagerieRoutes);

app.use((req, res) => {
  res.status(404).json({ erreur: 'Route introuvable.' });
});

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ erreur: 'Erreur interne du serveur.' });
});

app.listen(PORT, () => {
  console.log('API demarree sur le port ' + PORT);
  keepAlive.start();
});
