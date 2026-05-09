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
      teams:       null,
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
    if (!myData?.isMaster) return callback?.({ error: 'Seul le maître peut lancer.' });
    if (lobby.players.size < 2) {
      return callback?.({ error: 'Il faut au moins 2 joueurs pour lancer la partie.' });
    }

    lobby.gameStarted = true;
    const playerNames = [...lobby.players.keys()];
    const setup = assignRoles(playerNames, lobby.season);
    lobby.roles = setup.rolesByPlayer;
    lobby.teams = setup.teams;

    console.log(`[GAME] Partie lancée dans ${lobbyId} — ${playerNames.length} joueurs`);

    for (const [username, playerData] of lobby.players) {
      const pSocket = io.sockets.sockets.get(playerData.socketId);
      if (pSocket) {
        pSocket.emit('game_started', {
          role: lobby.roles[username],
          allPlayers: playerNames,
          teams: lobby.teams,
        });
      }
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
  heros:       "Le Héros",
  farmeur:     "Le Farmeur",
  gardien:     "Le Gardien",
  traqueur:    "Le Traqueur",
  mouton:      "Le Mouton",
  meneur:      "Le Meneur",
  assassin:    "L'Assassin",
  metteur:     "Le Metteur en Scène",
  enfant:      "L'Enfant de la Jungle",
  afk:         "L'AFK",
  noob:        "Le Noob",
  bad_guy:     "Le Bad Guy",
  drama:       "La Drama Queen",
  bipolaire:   "Le Bipolaire",
  bebe_dragon: "Le Bébé Dragon",
  elu:         "L'Élu",
};


const ROLE_FACTION_S1 = {
  heros:'SAFE', farmeur:'SAFE', gardien:'SAFE', traqueur:'SAFE', mouton:'SAFE', meneur:'SAFE',
  assassin:'MÉCHANT', metteur:'MÉCHANT', enfant:'MÉCHANT', afk:'MÉCHANT',
  noob:'NEUTRE', bad_guy:'NEUTRE', drama:'NEUTRE', bipolaire:'NEUTRE',
  bebe_dragon:'ÉVÉNEMENT', elu:'ÉVÉNEMENT',
};
const TYPE_POINTS = {
  SAFE: 1,
  EVIL: -1,
  NEUTRE: 0,
};

const SEASON_ROLE_POOLS = {
  s1: { roles: ROLES_S1, labels: ROLE_LABELS_S1 },
};

const LANE_KEYS = ['top', 'jungle', 'mid', 'adc', 'support'];
const LANE_LABELS = {
  top: 'Top',
  jungle: 'Jungle',
  mid: 'Mid',
  adc: 'ADC',
  support: 'Support',
};

// Extensible : ajouter ici les rôles forcés jungle des saisons futures.
const FORCED_JUNGLE_BY_SEASON = {
  s1: new Set(['bebe_dragon', 'enfant']),
};

function shuffle(arr) {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function isRoleSelectionBalanced(selection) {
  let evilCount = 0;
  let safeCount = 0;
  let score = 0;

  for (const role of selection) {
    score += TYPE_POINTS[role.type] ?? 0;
    if (role.type === 'EVIL') evilCount += 1;
    if (role.type === 'SAFE') safeCount += 1;
  }

  return (
    score >= -2 &&
    score <= 2 &&
    evilCount >= 2 &&
    evilCount <= 4 &&
    evilCount <= safeCount
  );
}

function pickBalancedRoles(playerCount, season = 's1') {
  const seasonPool = SEASON_ROLE_POOLS[season] || SEASON_ROLE_POOLS.s1;
  const allRoles = [];
  for (const [type, ids] of Object.entries(seasonPool.roles)) {
    for (const id of ids) allRoles.push({ id, type });
  }

  if (allRoles.length < playerCount) {
    throw new Error(`Pas assez de rôles pour ${playerCount} joueurs.`);
  }

  const forcedJungle = FORCED_JUNGLE_BY_SEASON[season] || new Set();

  for (let attempt = 0; attempt < 5000; attempt++) {
    const candidate = shuffle(allRoles).slice(0, playerCount);
    const forcedJungleCount = candidate.filter(r => forcedJungle.has(r.id)).length;
    if (forcedJungleCount > 2) continue;
    if (isRoleSelectionBalanced(candidate)) return candidate;
  }

  throw new Error("Impossible de générer une composition équilibrée avec les contraintes.");
}

function assignTeamsAndLanes(playerRoles, season = 's1') {
  const forcedJungle = FORCED_JUNGLE_BY_SEASON[season] || new Set();
  const allPlayers = shuffle(playerRoles);
  const forced = allPlayers.filter(p => forcedJungle.has(p.role.id));
  const free = allPlayers.filter(p => !forcedJungle.has(p.role.id));

  if (forced.length > 2) {
    throw new Error("Trop de rôles nécessitant la jungle dans cette composition.");
  }

  const blue = [];
  const red = [];

  if (forced.length === 2) {
    const [a, b] = shuffle(forced);
    blue.push(a);
    red.push(b);
  } else if (forced.length === 1) {
    const [only] = forced;
    (Math.random() < 0.5 ? blue : red).push(only);
  }

  for (const p of shuffle(free)) {
    if (blue.length < 5 && red.length < 5) {
      (Math.random() < 0.5 ? blue : red).push(p);
    } else if (blue.length < 5) {
      blue.push(p);
    } else {
      red.push(p);
    }
  }

  function withLanes(teamPlayers) {
    const team = [];
    const pool = shuffle(teamPlayers);
    const jungleIdx = pool.findIndex(p => forcedJungle.has(p.role.id));
    if (jungleIdx >= 0) {
      const [jungler] = pool.splice(jungleIdx, 1);
      team.push({ ...jungler, lane: 'jungle', laneLabel: LANE_LABELS.jungle });
    } else {
      const [jungler] = pool.splice(Math.floor(Math.random() * pool.length), 1);
      team.push({ ...jungler, lane: 'jungle', laneLabel: LANE_LABELS.jungle });
    }

    const remainingLanes = shuffle(LANE_KEYS.filter(l => l !== 'jungle'));
    for (let i = 0; i < remainingLanes.length; i++) {
      const lane = remainingLanes[i];
      const player = pool[i];
      team.push({ ...player, lane, laneLabel: LANE_LABELS[lane] });
    }
    return team;
  }

  return {
    blue: withLanes(blue),
    red: withLanes(red),
  };
}

function assignRoles(playerNames, season = 's1') {
  const seasonPool = SEASON_ROLE_POOLS[season] || SEASON_ROLE_POOLS.s1;
  const picked = pickBalancedRoles(playerNames.length, season);
  const shuffledPlayers = shuffle(playerNames);

  const playerRoles = shuffledPlayers.map((username, i) => {
    const r = picked[i];
    return {
      username,
      role: {
        id: r.id,
        type: r.type,
        label: seasonPool.labels[r.id] ?? r.id,
      },
    };
  });

  const teams = assignTeamsAndLanes(playerRoles, season);
  const result = {};

  for (const [teamKey, entries] of Object.entries(teams)) {
    for (const entry of entries) {
      result[entry.username] = {
        ...entry.role,
        team: teamKey,
        teamLabel: teamKey === 'blue' ? 'Blue' : 'Red',
        lane: entry.lane,
        laneLabel: entry.laneLabel,
      };
    }
  }

  return { rolesByPlayer: result, teams };
}


// ── Timer Élu : sacre à 15 min ────────────────────────────────────────────────
function scheduleEluSacre(lobbyId, lobby, io) {
  const eluPlayer = Object.entries(lobby.roles).find(([, r]) => r.id === 'elu')?.[0];
  if (!eluPlayer) return;
  console.log(`[ELU] Sacre programmé dans 15 min pour ${eluPlayer} (${lobbyId})`);
  setTimeout(() => {
    const currentLobby = lobbies.get(lobbyId);
    if (!currentLobby) return;
    const playerData = currentLobby.players.get(eluPlayer);
    if (!playerData?.socketId) return;
    const pSocket = io.sockets.sockets.get(playerData.socketId);
    if (pSocket) {
      pSocket.emit('elu_sacre', {
        message: "✦ Tu viens d'être sacré. Tu n'es plus qui tu étais.",
        detail:  "Ton ancien rôle disparaît. Joue désormais pour L'Élu uniquement. Marque cette partie de ton empreinte."
      });
      console.log(`[ELU] Sacre envoyé à ${eluPlayer}`);
    }
  }, 15 * 60 * 1000);
}

// ── Démarrage ─────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`✔ Among Legend — Serveur lancé sur http://localhost:${PORT}`);
});