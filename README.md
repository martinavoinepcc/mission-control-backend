# Mission Control — Backend API

API Express + Prisma + PostgreSQL pour le portail familial My Mission Control.

## Démarrage local

```bash
npm install
cp .env.example .env    # puis remplir DATABASE_URL et JWT_SECRET
npx prisma migrate deploy
npm run seed
npm start
```

## Routes principales

| Méthode | Route | Auth | Description |
|---------|-------|------|-------------|
| POST | `/auth/login` | public | Connexion par email + mdp |
| POST | `/auth/change-password` | user | Changer son propre mdp |
| GET | `/users/me` | user | Profil + apps accessibles |
| GET | `/admin/users` | admin | Lister les membres |
| POST | `/admin/users` | admin | Créer un membre |
| POST | `/admin/users/:id/apps` | admin | Toggle accès à une app |
| POST | `/admin/users/:id/password` | admin | Reset mdp d'un membre |
| DELETE | `/admin/users/:id` | admin | Supprimer un membre |

## Déploiement Render

- Build command : `npm install && npx prisma generate && npx prisma migrate deploy`
- Start command : `npm start`
- Env vars requises : `DATABASE_URL`, `JWT_SECRET`, `FRONTEND_URL`, `NODE_ENV=production`
- Après le premier déploiement : lancer `node prisma/seed.js` une fois (Render Shell)
