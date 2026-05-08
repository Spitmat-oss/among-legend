const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

const PORT = Number(process.env.PORT) || 3000;

// ── Sert les fichiers statiques depuis la racine du projet ────────────────────
app.use(express.static(path.join(__dirname)));
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'hub.html'));
});

// ── État global des lobbies (partagé entre tous les clients) ──────────────────
// Structure : Map<lobbyId, lobbyData>
const lobbies = new Map();

let lobbyCounter = 1;

function createLobbyId() {
  return `AL-${Date.now().toString(36).toUpperCase().slice(-4)}-${lobbyCounter++}`;
}

function serializeLobby(lobby) {
  return {
    id:         lobby.id,
    name:       lobby.name,
    host:       lobby.host,
    season:     lobby.season,
    players:    lobby.players.size,
    maxPlayers: lobby.maxPlayers,
    status:     lobby.gameStarted ? 'started' : lobby.players.size >= lobby.maxPlayers ? 'full' : 'open',
    createdAt:  lobby.createdAt,
    playerNames: [...lobby.players.keys()],
  };
}

function broadcastLobbyList() {
  const list = [...lobbies.values()]
    .filter(l => !l.gameStarted)
    .map(serializeLobby);
  io.emit('lobby_list', list);
}

function broadcastLobbyUpdate(lobby) {
  io.to(lobby.id).emit('lobby_update', serializeLobby(lobby));
  broadcastLobbyList();
}

// ── Nettoyage des lobbies vides ou inactifs (toutes les 5 min) ────────────────
setInterval(() => {
  const now = Date.now();
  for (const [id, lobby] of lobbies) {
    const age = now - lobby.createdAt;
    // Supprimer si vide depuis plus de 2 min ou inactif depuis plus de 2h
    if ((lobby.players.size === 0 && age > 2 * 60 * 1000) || age > 2 * 60 * 60 * 1000) {
      lobbies.delete(id);
      console.log(`[CLEANUP] Lobby ${id} supprimé.`);
    }
  }
  broadcastLobbyList();
}, 5 * 60 * 1000);

// ── Socket.io ─────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[CONNECT] ${socket.id}`);

  // ── Envoyer la liste des lobbies dès la connexion ──────────────────────────
  const list = [...lobbies.values()]
    .filter(l => !l.gameStarted)
    .map(serializeLobby);
  socket.emit('lobby_list', list);

  // ── Créer un lobby ─────────────────────────────────────────────────────────
  socket.on('create_lobby', ({ name, host, season }, callback) => {
    if (!name || !host) return callback({ error: 'Données manquantes.' });
    if (name.length > 40 || host.length > 20) return callback({ error: 'Données trop longues.' });

    const id = createLobbyId();
    const lobby = {
      id,
      name:        name.trim(),
      host:        host.trim(),
      season:      season || 's1',
      maxPlayers:  10,
      gameStarted: false,
      createdAt:   Date.now(),
      players:     new Map(),   // username → { socketId, isMaster }
      roles:       {},
      readyPlayers: new Set(),
    };

    // L'hôte rejoint automatiquement
    lobby.players.set(host.trim(), { socketId: socket.id, isMaster: true });
    socket.data.lobbyId  = id;
    socket.data.username = host.trim();
    socket.join(id);

    lobbies.set(id, lobby);
    console.log(`[LOBBY] Créé: ${id} — "${name}" par ${host}`);

    broadcastLobbyList();
    callback({ success: true, lobby: serializeLobby(lobby) });
  });

  // ── Rejoindre un lobby ─────────────────────────────────────────────────────
  socket.on('join_lobby', ({ lobbyId, username }, callback) => {
    username = (username || '').trim();
    if (!username) return callback({ error: "Nom d'utilisateur vide." });

    const lobby = lobbies.get(lobbyId);
    if (!lobby)                            return callback({ error: 'Lobby introuvable.' });
    if (lobby.gameStarted)                 return callback({ error: 'La partie a déjà commencé.' });
    if (lobby.players.has(username))       return callback({ error: 'Ce nom est déjà pris dans ce lobby.' });
    if (lobby.players.size >= lobby.maxPlayers) return callback({ error: `Le lobby est plein (${lobby.maxPlayers}/${lobby.maxPlayers}).` });

    lobby.players.set(username, { socketId: socket.id, isMaster: false });
    socket.data.lobbyId  = lobbyId;
    socket.data.username = username;
    socket.join(lobbyId);

    console.log(`[LOBBY] ${username} a rejoint ${lobbyId}`);
    broadcastLobbyUpdate(lobby);
    callback({ success: true, lobby: serializeLobby(lobby) });
  });

  // ── Quitter un lobby ───────────────────────────────────────────────────────
  socket.on('leave_lobby', () => {
    handleLeave(socket);
  });

  // ── Kick un joueur (hôte seulement) ───────────────────────────────────────
  socket.on('kick_player', ({ targetUsername }) => {
    const lobbyId = socket.data.lobbyId;
    const me      = socket.data.username;
    const lobby   = lobbies.get(lobbyId);
    if (!lobby) return;

    const myData = lobby.players.get(me);
    if (!myData?.isMaster) return;
    if (!lobby.players.has(targetUsername)) return;
    if (targetUsername === me) return;

    const targetData = lobby.players.get(targetUsername);
    lobby.players.delete(targetUsername);

    const targetSocket = io.sockets.sockets.get(targetData.socketId);
    if (targetSocket) {
      targetSocket.emit('kicked', { reason: "Vous avez été expulsé du lobby." });
      targetSocket.leave(lobbyId);
      targetSocket.data.lobbyId  = null;
      targetSocket.data.username = null;
    }

    broadcastLobbyUpdate(lobby);
  });

  // ── Lancer la partie (hôte seulement) ─────────────────────────────────────
  socket.on('start_game', (callback) => {
    const lobbyId = socket.data.lobbyId;
    const me      = socket.data.username;
    const lobby   = lobbies.get(lobbyId);
    if (!lobby) return;

    const myData = lobby.players.get(me);
    if (!myData?.isMaster)      return callback?.({ error: 'Seul le maître peut lancer.' });
    if (lobby.players.size < 2) return callback?.({ error: 'Il faut au moins 2 joueurs.' });

    lobby.gameStarted = true;
    const playerNames = [...lobby.players.keys()];
    lobby.roles       = assignRoles(playerNames, lobby.season);

    console.log(`[GAME] Partie lancée dans ${lobbyId} — ${playerNames.length} joueurs`);

    for (const [username, playerData] of lobby.players) {
      const pSocket = io.sockets.sockets.get(playerData.socketId);
      if (pSocket) pSocket.emit('game_started', { role: lobby.roles[username] });
    }

    broadcastLobbyList();
    callback?.({ success: true });
  });

  // ── Déconnexion ────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log(`[DISCONNECT] ${socket.id}`);
    handleLeave(socket);
  });
});

// ── Gestion départ d'un joueur ────────────────────────────────────────────────
function handleLeave(socket) {
  const lobbyId  = socket.data.lobbyId;
  const username = socket.data.username;
  if (!lobbyId || !username) return;

  const lobby = lobbies.get(lobbyId);
  if (!lobby) return;

  if (lobby.gameStarted) {
    // En partie : on garde la place, juste on note la déconnexion
    const playerData = lobby.players.get(username);
    if (playerData) playerData.socketId = null;
    return;
  }

  const wasHost = lobby.players.get(username)?.isMaster;
  lobby.players.delete(username);

  if (lobby.players.size === 0) {
    lobbies.delete(lobbyId);
    console.log(`[LOBBY] ${lobbyId} supprimé (vide).`);
    broadcastLobbyList();
    return;
  }

  // Transférer le statut d'hôte si nécessaire
  if (wasHost) {
    const newHost = lobby.players.values().next().value;
    if (newHost) {
      newHost.isMaster = true;
      const newHostSocket = io.sockets.sockets.get(newHost.socketId);
      if (newHostSocket) newHostSocket.emit('promoted_host');
    }
  }

  socket.data.lobbyId  = null;
  socket.data.username = null;
  broadcastLobbyUpdate(lobby);
}

// ── Attribution des rôles ─────────────────────────────────────────────────────
const ROLES_S1 = {
  SAFE:   ['heros','farmeur','gardien','traqueur','afk','meneur','bebe_dragon'],
  EVIL:   ['assassin','metteur_en_scene','enfant_de_la_jungle'],
  NEUTRE: ['mouton','noob','bipolaire','drama_queen','imitateur','bad_guy','elu'],
};

const ROLE_LABELS_S1 = {
  heros:               'Héros',
  farmeur:             'Farmeur',
  gardien:             'Gardien',
  traqueur:            'Traqueur',
  afk:                 'AFK',
  meneur:              'Meneur',
  bebe_dragon:         'Bébé Dragon',
  assassin:            'Assassin',
  metteur_en_scene:    'Metteur en Scène',
  enfant_de_la_jungle: 'Enfant de la Jungle',
  mouton:              'Mouton',
  noob:                'Noob',
  bipolaire:           'Bipolaire',
  drama_queen:         'Drama Queen',
  imitateur:           'Imitateur',
  bad_guy:             'Bad Guy',
  elu:                 'L\'Élu',
};

const TYPE_POINTS = {
  SAFE:   { safe:  1.0, evil: -0.8 },
  EVIL:   { safe: -1.0, evil:  0.8 },
  NEUTRE: { safe:  0.0, evil:  0.0 },
};

function assignRoles(playerNames, season = 's1') {
  const roles   = ROLES_S1;
  const labels  = ROLE_LABELS_S1;
  const allRoles = [];
  for (const [type, names] of Object.entries(roles)) {
    for (const name of names) allRoles.push({ name, type });
  }

  const n = playerNames.length;
  let picked = null;

  for (let attempt = 0; attempt < 2000; attempt++) {
    const pool = [...allRoles];
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const candidate = pool.slice(0, n);
    let safe = 0, evil = 0;
    for (const r of candidate) {
      safe += TYPE_POINTS[r.type].safe;
      evil += TYPE_POINTS[r.type].evil;
    }
    if (safe >= -1 && safe <= 1 && evil >= -1 && evil <= 1) {
      picked = candidate;
      break;
    }
  }

  if (!picked) {
    picked = playerNames.map(() => ({ name: 'drama_queen', type: 'NEUTRE' }));
    console.warn('[WARN] assignRoles: fallback NEUTRE.');
  }

  const result = {};
  playerNames.forEach((name, i) => {
    result[name] = {
      id:    picked[i].name,
      type:  picked[i].type,
      label: labels[picked[i].name] ?? picked[i].name,
    };
  });
  return result;
}

// ── Démarrage ─────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`✔ Among Legend — Serveur lancé sur http://localhost:${PORT}`);
});
