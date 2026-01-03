const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
  }
});

const PORT = process.env.PORT || 3000;
const STARTING_HP = 120;

const randomQueue = [];
const passwordRooms = new Map(); // password -> roomId
const rooms = new Map(); // roomId -> room state

function generateCard(word) {
  const lower = word.toLowerCase();
  const len = word.length;

  // 言葉の意味の深い理解に基づく強度スコア算出
  const strengthMap = {
    // 最高峰（80-100）：神話的・宇宙規模
    'god': 95, 'goddess': 95, 'universe': 95, 'big bang': 95, '神': 95, 'dragon': 90, 'ドラゴン': 90,
    'phoenix': 88, 'nuke': 85, '核': 85, 'blackhole': 92, 'supernova': 90,
    // 高度（70-79）：伝説的・強力な存在
    'titan': 78, 'demon': 75, 'wizard': 72, 'sword': 70, 'ancient': 72, '魔法': 75, '騎士': 70,
    // 中程度（50-69）：一般的な強さ
    'fire': 60, 'water': 58, '炎': 60, '水': 58, 'shield': 55, '盾': 55, 'bow': 52, 'magic': 65,
    'thunder': 65, '雷': 65, 'earth': 55, '土': 55, 'wind': 60, '風': 60,
    // 低度（20-49）：日用品・弱い存在
    'stick': 15, '棒': 15, 'stone': 25, '石': 25, 'rope': 12, 'punch': 30, 'パンチ': 30,
    'slap': 10, 'poke': 8, '突く': 10,
    // 回復系（属性で判定）
    'heal': 0, '癒': 0, 'cure': 0, '回復': 0, 'medicine': 0,
    // 防御系
    'defend': 0, 'guard': 0, '守': 0, 'protect': 0, '保護': 0
  };

  // ベーススコア計算
  let baseStrength = 40;
  for (const [key, score] of Object.entries(strengthMap)) {
    if (lower.includes(key)) {
      baseStrength = score;
      break;
    }
  }

  // 複合語による微調整
  if (lower.includes('ancient') || lower.includes('old') || lower.includes('ancient')) baseStrength += 5;
  if (lower.includes('mega') || lower.includes('ultra')) baseStrength += 10;
  if (lower.includes('mini') || lower.includes('tiny')) baseStrength = Math.max(5, baseStrength - 15);

  // 属性判定
  const attributes = [
    { key: 'fire', match: /(火|炎|burn|fire|flame|lava|magma)/i },
    { key: 'water', match: /(水|氷|ice|aqua|water|freeze|tsunami)/i },
    { key: 'thunder', match: /(雷|電|thunder|shock|volt|lightning)/i },
    { key: 'earth', match: /(土|岩|stone|earth|rock|mountain|quake)/i },
    { key: 'wind', match: /(風|air|wind|storm|tornado)/i },
    { key: 'heal', match: /(癒|回復|heal|cure|restore|medicine)/i }
  ];

  let attribute = 'neutral';
  for (const attr of attributes) {
    if (attr.match.test(word)) {
      attribute = attr.key;
      break;
    }
  }

  // 効果判定
  let effect = 'attack';
  if (/heal|癒|回復|cure|medicine/i.test(word)) {
    effect = 'heal';
  } else if (/defend|guard|盾|shield|protect/i.test(word)) {
    effect = 'defense';
  } else if (/support|補助|boost|enhance|aid/i.test(word)) {
    effect = 'support';
  }

  // 攻撃力・防御力の計算
  let attack, defense;

  if (effect === 'heal') {
    attack = 0;
    defense = baseStrength * 0.6;
  } else if (effect === 'defense') {
    attack = Math.round(baseStrength * 0.5);
    defense = baseStrength * 1.2;
  } else if (effect === 'support') {
    attack = Math.round(baseStrength * 0.8);
    defense = Math.round(baseStrength * 0.8);
  } else {
    // 攻撃効果
    attack = baseStrength;
    defense = Math.round(baseStrength * 0.4);
  }

  attack = Math.min(100, Math.max(0, attack));
  defense = Math.min(100, Math.max(0, defense));

  return {
    word,
    attribute,
    attack: Math.round(attack),
    defense: Math.round(defense),
    effect,
    description: `${attribute.toUpperCase()} / ATK:${Math.round(attack)} DEF:${Math.round(defense)} / ${effect}`
  };
}

function createRoom(players, mode, password) {
  const roomId = crypto.randomUUID();
  const room = {
    id: roomId,
    mode,
    password: password || null,
    players: players.map((p, idx) => ({
      id: p.socket.id,
      name: p.name,
      socketId: p.socket.id,
      hp: STARTING_HP,
      usedWords: new Set(),
      isHost: idx === 0
    })),
    hostId: players[0].socket.id,
    started: false,
    turnIndex: 0,
    phase: 'waiting',
    pendingAttack: null,
    usedWordsGlobal: new Set()
  };

  rooms.set(roomId, room);
  players.forEach(({ socket }) => {
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.emit('joinedRoom', {
      roomId,
      players: room.players.map(pl => ({ id: pl.id, name: pl.name })),
      isHost: socket.id === room.hostId,
      playerId: socket.id
    });
  });

  broadcastWaiting(roomId);
  return room;
}

function broadcastWaiting(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  io.to(roomId).emit('waitingUpdate', {
    players: room.players.map(p => ({ id: p.id, name: p.name })),
    canStart: room.players.length >= 2,
    hostId: room.hostId
  });
}

function startBattle(roomId) {
  const room = rooms.get(roomId);
  if (!room || room.started || room.players.length < 2) return;
  room.started = true;
  room.phase = 'attack';
  room.turnIndex = Math.floor(Math.random() * room.players.length);
  room.players.forEach(p => { p.hp = STARTING_HP; });

  io.to(roomId).emit('battleStarted', {
    roomId,
    players: room.players.map(p => ({ id: p.id, name: p.name, hp: p.hp })),
    turn: room.players[room.turnIndex].id
  });
  updateStatus(roomId, `バトル開始！先攻: ${room.players[room.turnIndex].name}`);
}

function updateStatus(roomId, message) {
  io.to(roomId).emit('status', { message });
}

function getOpponent(room, socketId) {
  return room.players.find(p => p.id !== socketId);
}

function findPlayer(room, socketId) {
  return room.players.find(p => p.id === socketId);
}

function handlePlayWord(roomId, socket, word) {
  const room = rooms.get(roomId);
  if (!room || !room.started || room.phase !== 'attack') return;
  if (room.players[room.turnIndex].id !== socket.id) {
    socket.emit('errorMessage', { message: 'あなたのターンではありません' });
    return;
  }

  const cleanWord = (word || '').trim();
  if (!cleanWord) {
    socket.emit('errorMessage', { message: '言葉を入力してください' });
    return;
  }

  const lower = cleanWord.toLowerCase();
  if (room.usedWordsGlobal.has(lower)) {
    socket.emit('errorMessage', { message: 'その言葉は既に使用されています' });
    return;
  }

  const attacker = findPlayer(room, socket.id);
  const defender = getOpponent(room, socket.id);
  if (!attacker || !defender) return;

  const card = generateCard(cleanWord);
  room.usedWordsGlobal.add(lower);
  attacker.usedWords.add(lower);
  room.pendingAttack = { attackerId: attacker.id, defenderId: defender.id, card };
  room.phase = 'defense';

  io.to(roomId).emit('attackDeclared', {
    attackerId: attacker.id,
    defenderId: defender.id,
    card
  });
  updateStatus(roomId, `${attacker.name} の攻撃！ 防御の言葉を入力してください。`);
}

function handleDefend(roomId, socket, word) {
  const room = rooms.get(roomId);
  if (!room || !room.started || room.phase !== 'defense' || !room.pendingAttack) return;
  if (room.pendingAttack.defenderId !== socket.id) {
    socket.emit('errorMessage', { message: 'あなたの防御フェーズではありません' });
    return;
  }

  const cleanWord = (word || '').trim();
  if (!cleanWord) {
    socket.emit('errorMessage', { message: '防御の言葉を入力してください' });
    return;
  }

  const lower = cleanWord.toLowerCase();
  if (room.usedWordsGlobal.has(lower)) {
    socket.emit('errorMessage', { message: 'その言葉は既に使用されています' });
    return;
  }

  const attacker = findPlayer(room, room.pendingAttack.attackerId);
  const defender = findPlayer(room, socket.id);
  if (!attacker || !defender) return;

  const attackCard = room.pendingAttack.card;
  const defenseCard = generateCard(cleanWord);
  room.usedWordsGlobal.add(lower);
  defender.usedWords.add(lower);

  let damage = Math.max(0, attackCard.attack - defenseCard.defense);

  if (attackCard.effect === 'heal') {
    attacker.hp = Math.min(STARTING_HP, attacker.hp + Math.round(attackCard.attack * 0.6));
    damage = 0;
  }
  if (attackCard.effect === 'support') {
    damage += 5;
  }
  if (defenseCard.effect === 'heal') {
    defender.hp = Math.min(STARTING_HP, defender.hp + Math.round(defenseCard.defense * 0.5));
  }
  if (defenseCard.effect === 'support') {
    damage = Math.max(0, damage - 5);
  }

  defender.hp = Math.max(0, defender.hp - damage);

  let winnerId = null;
  if (defender.hp <= 0) {
    winnerId = attacker.id;
  }

  room.pendingAttack = null;
  room.phase = 'attack';
  room.turnIndex = room.players.findIndex(p => p.id === defender.id);

  const hp = {};
  room.players.forEach(p => { hp[p.id] = p.hp; });

  io.to(roomId).emit('turnResolved', {
    attackerId: attacker.id,
    defenderId: defender.id,
    attackCard,
    defenseCard,
    damage,
    hp,
    nextTurn: winnerId ? null : room.players[room.turnIndex].id,
    winnerId
  });

  if (winnerId) {
    updateStatus(roomId, `${attacker.name} の勝利！`);
  } else {
    updateStatus(roomId, `${room.players[room.turnIndex].name} のターンです`);
  }
}

function removeFromQueues(socketId) {
  const idx = randomQueue.findIndex(p => p.socket.id === socketId);
  if (idx >= 0) randomQueue.splice(idx, 1);

  for (const [pwd, roomId] of passwordRooms) {
    const room = rooms.get(roomId);
    if (room && room.players.some(p => p.id === socketId) && !room.started) {
      room.players = room.players.filter(p => p.id !== socketId);
      broadcastWaiting(roomId);
      if (room.players.length === 0) {
        rooms.delete(roomId);
        passwordRooms.delete(pwd);
      }
    }
  }
}

function handleDisconnect(socket) {
  removeFromQueues(socket.id);
  const roomId = socket.data.roomId;
  if (!roomId) return;
  const room = rooms.get(roomId);
  if (!room) return;

  room.players = room.players.filter(p => p.id !== socket.id);

  if (!room.started) {
    broadcastWaiting(roomId);
    if (room.players.length === 0) {
      rooms.delete(roomId);
      if (room.password) passwordRooms.delete(room.password);
    }
    return;
  }

  const remaining = room.players[0];
  if (remaining) {
    io.to(roomId).emit('opponentLeft', { winnerId: remaining.id, message: `${remaining.name} の勝利 (相手離脱)` });
  }
  rooms.delete(roomId);
  if (room.password) passwordRooms.delete(room.password);
}

io.on('connection', (socket) => {
  socket.on('joinGame', ({ name, mode, password }) => {
    const playerName = (name || '').trim();
    if (!playerName) {
      socket.emit('errorMessage', { message: 'プレイヤー名を入力してください' });
      return;
    }

    const playerEntry = { socket, name: playerName };

    if (mode === 'password' && password) {
      let roomId = passwordRooms.get(password);
      let room = roomId ? rooms.get(roomId) : null;
      if (!room) {
        room = createRoom([playerEntry], 'password', password);
        passwordRooms.set(password, room.id);
      } else if (room.started) {
        socket.emit('errorMessage', { message: 'このルームでは既にバトルが開始されています' });
        return;
      } else {
        room.players.push({
          id: socket.id,
          name: playerName,
          socketId: socket.id,
          hp: STARTING_HP,
          usedWords: new Set(),
          isHost: false
        });
        socket.join(room.id);
        socket.data.roomId = room.id;
        socket.emit('joinedRoom', {
          roomId: room.id,
          players: room.players.map(p => ({ id: p.id, name: p.name })),
          isHost: false,
          playerId: socket.id
        });
        broadcastWaiting(room.id);
      }
      return;
    }

    if (mode === 'random') {
      if (randomQueue.length > 0) {
        const opponent = randomQueue.shift();
        createRoom([opponent, playerEntry], 'random', null);
      } else {
        randomQueue.push(playerEntry);
        socket.emit('waitingUpdate', { players: [{ id: socket.id, name: playerName }], canStart: false });
      }
      return;
    }

    socket.emit('errorMessage', { message: 'マッチ方式を選択してください' });
  });

  socket.on('requestStart', () => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room) return;
    if (socket.id !== room.hostId) {
      socket.emit('errorMessage', { message: 'ホストのみ開始できます' });
      return;
    }
    if (room.players.length < 2) {
      socket.emit('errorMessage', { message: '2人以上で開始できます' });
      return;
    }
    startBattle(roomId);
  });

  socket.on('playWord', ({ word }) => {
    const roomId = socket.data.roomId;
    handlePlayWord(roomId, socket, word);
  });

  socket.on('defendWord', ({ word }) => {
    const roomId = socket.data.roomId;
    handleDefend(roomId, socket, word);
  });

  socket.on('disconnect', () => {
    handleDisconnect(socket);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
