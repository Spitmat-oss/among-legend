# Among Legend — V1.0 · Saison 1 : L'Aube des Légendes

Jeu de rôles secret sur League of Legends pour 2 à 10 joueurs.

---

## Installation

### Prérequis
- Node.js (v16 ou supérieur) — https://nodejs.org

### Lancement
```bash
# 1. Dans le dossier du projet, installer les dépendances
npm install

# 2. Lancer le serveur
npm start
# ou
node server.js
```

Le serveur se lance sur **http://localhost:3000**

---

## Hébergement local (LAN)

Pour que tous les joueurs accèdent au site depuis le même réseau Wi-Fi :

1. Lance le serveur sur ton PC avec `node server.js`
2. Trouve ton IP locale (Windows : `ipconfig` → IPv4 Address, Mac/Linux : `ifconfig`)
3. Partage l'adresse : **http://TON_IP:3000** à tous les joueurs
4. Tous se connectent depuis leur téléphone ou PC sur cette adresse

---

## Hébergement en ligne (optionnel)

Pour jouer à distance, tu peux héberger sur :
- **Railway** (railway.app) — gratuit, déploiement Git
- **Render** (render.com) — gratuit
- **Heroku** — payant

Il suffit de pousser le dossier sur Git et de configurer `npm start` comme commande de démarrage.

---

## Structure des fichiers

```
AmongLegend/
├── server.js         ← Serveur Node.js (Socket.io + Express)
├── package.json      ← Dépendances Node
├── index.html        ← Page d'accueil (splash screen)
├── hub.html          ← Hub principal (onglets + lobbies)
├── img/              ← Images des rôles
│   ├── heros.png
│   ├── assassin.png
│   ├── farmeur.png
│   └── ... (17 images)
└── README.md
```

---

## Comment jouer

1. **Tout le monde se connecte** sur le site
2. **L'hôte crée un lobby** (bouton ⚔ Jouer)
3. **Tous les joueurs rejoignent** le lobby avec leur pseudo
4. **L'hôte lance la partie** quand tout le monde est là
5. **Chaque joueur reçoit son rôle** sur son écran — à mémoriser en secret
6. **La partie LoL commence** — chacun joue selon son contrat
7. **À la fin de la partie** — phase de vote : devinez les rôles des autres

---

## Scoring

- **SAFE** : +1 Victoire (équipe gagne) + +1 Contrat (rempli) + +1 Discrétion (non découvert)
- **MÉCHANT** : +1 Défaite (équipe perd) + +1 Contrat (rempli) + +1 Manipulation (non découvert)
- **NEUTRE** : +1 Destin (automatique) + +1 Objectif (rempli) + +1 Mystère (rôle non deviné)

---

## Règles générales

- Ton rôle est secret. Ne le révèle à personne.
- Pas de triche hors jeu. Joue ton rôle, pas celui des autres.
- Respecte les joueurs et le Maître du Jeu. Le toxic = out.
- Les contrats et objectifs doivent être respectés. Les assists comptent (sauf précision contraire).

---

Règles créées par **RBXIT** et toute la team.
