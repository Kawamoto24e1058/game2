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
  const original = word;

  // 【弱気な言葉の検出】フレーズ全体を評価
  const weaknessPhrases = [
    /ため息|溜息|あくび|欠伸|sigh|yawn/i,
    /つぶやき|ささやき|whisper|murmur/i,
    /かすり傷|scratch|graze/i,
    /軽い|弱い|小さい|tiny|weak|light|faint/i,
    /寝る|眠い|sleepy|tired|drowsy/i,
    /なでる|pat|stroke|gentle/i
  ];

  let weaknessDetected = false;
  for (const pattern of weaknessPhrases) {
    if (pattern.test(original)) {
      weaknessDetected = true;
      break;
    }
  }

  // 【神話級・伝説級】80-100：歴史的・神話的・宇宙規模の存在
  const mythicalTier = {
    'excalibur': 98, 'エクスカリバー': 98, 'mjolnir': 97, 'ムジョルニア': 97,
    'god': 95, 'goddess': 95, '神': 95, '女神': 95, 'zeus': 96, 'odin': 96,
    'dragon': 92, 'ドラゴン': 92, 'phoenix': 90, 'フェニックス': 90,
    'blackhole': 94, 'ブラックホール': 94, 'supernova': 93, '超新星': 93,
    'big bang': 99, 'ビッグバン': 99, 'universe': 95, '宇宙': 95,
    'nuke': 88, '核': 88, 'nuclear': 88, '原子爆弾': 88,
    'titan': 85, 'タイタン': 85, 'leviathan': 87, 'リヴァイアサン': 87
  };

  // 【現代兵器・強者】50-79：戦争・武術・強力な道具
  const weaponTier = {
    'katana': 72, '日本刀': 72, 'sword': 70, '剣': 70, 'longsword': 68,
    'tank': 75, '戦車': 75, 'cannon': 73, '大砲': 73,
    'gun': 65, '銃': 65, 'rifle': 67, 'ライフル': 67,
    'bomb': 70, '爆弾': 70, 'missile': 76, 'ミサイル': 76,
    'lightning': 68, '稲妻': 68, 'thunder': 66, '雷': 66,
    'tsunami': 74, '津波': 74, 'earthquake': 72, '地震': 72,
    'volcano': 71, '火山': 71, 'lava': 69, 'マグマ': 69,
    'tornado': 68, '竜巻': 68, 'hurricane': 70, 'ハリケーン': 70,
    'axe': 62, '斧': 62, 'hammer': 60, 'ハンマー': 60,
    'spear': 58, '槍': 58, 'bow': 55, '弓': 55, 'arrow': 53, '矢': 53,
    'wizard': 64, '魔法使い': 64, 'sorcerer': 66, '魔術師': 66,
    'knight': 63, '騎士': 63, 'warrior': 61, '戦士': 61,
    'demon': 68, '悪魔': 68, 'devil': 70, 'デビル': 70,
    'fire': 58, '炎': 58, 'flame': 56, 'blaze': 60,
    'ice': 57, '氷': 57, 'frost': 55, '霜': 55,
    'water': 52, '水': 52, 'ocean': 56, '海': 56,
    'wind': 54, '風': 54, 'gale': 56, '疾風': 56,
    'earth': 50, '土': 50, 'stone': 48, '石': 48
  };

  // 【日用品・一般】10-49：身近な物・弱い力
  const commonTier = {
    'stick': 18, '棒': 18, 'wooden stick': 15, '木の棒': 15,
    'branch': 12, '枝': 12, 'twig': 8, '小枝': 8,
    'rock': 22, '岩': 22, 'pebble': 10, '小石': 10,
    'rope': 14, '縄': 14, 'string': 8, '糸': 8,
    'punch': 28, 'パンチ': 28, 'kick': 30, 'キック': 30,
    'slap': 12, '平手打ち': 12, 'poke': 8, '突く': 8,
    'knife': 35, 'ナイフ': 35, 'dagger': 32, '短剣': 32,
    'club': 25, '棍棒': 25, 'bat': 28, 'バット': 28,
    'fist': 26, '拳': 26, 'hand': 15, '手': 15,
    'book': 10, '本': 10, 'paper': 5, '紙': 5,
    'pen': 6, 'ペン': 6, 'pencil': 5, '鉛筆': 5,
    'chair': 20, '椅子': 20, 'table': 22, 'テーブル': 22,
    'plate': 12, 'お皿': 12, 'tray': 14, 'お盆': 14,
    'broom': 16, 'ほうき': 16, 'mop': 15, 'モップ': 15
  };

  // ベーススコア計算（厳格な格付け）
  let baseStrength = 30; // デフォルト
  let tier = 'common';

  // 神話級チェック
  for (const [key, score] of Object.entries(mythicalTier)) {
    if (lower.includes(key)) {
      baseStrength = score;
      tier = 'mythical';
      break;
    }
  }

  // 武器級チェック
  if (tier === 'common') {
    for (const [key, score] of Object.entries(weaponTier)) {
      if (lower.includes(key)) {
        baseStrength = score;
        tier = 'weapon';
        break;
      }
    }
  }

  // 日用品級チェック
  if (tier === 'common') {
    for (const [key, score] of Object.entries(commonTier)) {
      if (lower.includes(key)) {
        baseStrength = score;
        break;
      }
    }
  }

  // 複合語・修飾語による微調整
  if (/ancient|legendary|sacred|holy|divine/i.test(word)) baseStrength = Math.min(100, baseStrength + 8);
  if (/cursed|dark|evil|forbidden/i.test(word)) baseStrength = Math.min(100, baseStrength + 6);
  if (/mega|ultra|super|hyper|giga/i.test(word)) baseStrength = Math.min(100, baseStrength + 12);
  if (/mini|tiny|small|weak/i.test(word)) baseStrength = Math.max(5, baseStrength - 18);
  if (/broken|rusty|old|damaged/i.test(word) && tier !== 'mythical') baseStrength = Math.max(5, baseStrength - 15);

  // 多角的属性判定（光・闇を追加）
  const attributes = [
    { key: 'light', match: /(光|聖|holy|sacred|divine|angel|天使)/i },
    { key: 'dark', match: /(闇|暗|dark|shadow|curse|evil|demon|悪魔)/i },
    { key: 'fire', match: /(火|炎|burn|fire|flame|lava|magma|blaze|volcano)/i },
    { key: 'water', match: /(水|氷|ice|aqua|water|freeze|tsunami|ocean|sea)/i },
    { key: 'thunder', match: /(雷|電|thunder|shock|volt|lightning|storm)/i },
    { key: 'earth', match: /(土|岩|stone|earth|rock|mountain|quake|ground)/i },
    { key: 'wind', match: /(風|air|wind|storm|tornado|gale|hurricane)/i },
    { key: 'heal', match: /(癒|回復|heal|cure|restore|medicine|potion|remedy)/i }
  ];

  let attribute = 'neutral';
  for (const attr of attributes) {
    if (attr.match.test(word)) {
      attribute = attr.key;
      break;
    }
  }

  // 効果判定（多角的分析 + サポート強化）
  let effect = 'attack';
  let supportType = null;

  if (/heal|癒|回復|cure|medicine|remedy|restore|regenerate|治療|薬/i.test(word)) {
    effect = 'heal';
  } else if (/defend|guard|盾|shield|protect|barrier|wall|armor|防|守/i.test(word)) {
    effect = 'defense';
  } else if (/support|補助|boost|enhance|aid|buff|strengthen|応援|祝福|blessing|prayer/i.test(word)) {
    effect = 'support';
    // サポートの種類を判定
    if (/heal|回復|cure|medicine/i.test(word)) {
      supportType = 'heal_boost';
    } else if (/power|強化|boost|enhance|strengthen/i.test(word)) {
      supportType = 'attack_boost';
    } else if (/protect|shield|guard|防/i.test(word)) {
      supportType = 'defense_boost';
    } else if (/weaken|弱体|curse|呪/i.test(word)) {
      supportType = 'enemy_debuff';
    } else {
      supportType = 'general_boost';
    }
  } else if (/attack|slash|strike|punch|kick|斬|撃|打/i.test(word)) {
    effect = 'attack';
  }

  // 弱気検出時の数値強制低下
  if (weaknessDetected) {
    baseStrength = Math.min(15, Math.max(5, baseStrength * 0.15));
    tier = 'common';
  }

  // 攻撃力・防御力の精密計算
  let attack, defense;

  if (effect === 'heal') {
    attack = 0;
    defense = Math.round(baseStrength * 0.7);
  } else if (effect === 'defense') {
    attack = Math.round(baseStrength * 0.45);
    defense = Math.round(baseStrength * 1.3);
  } else if (effect === 'support') {
    attack = Math.round(baseStrength * 0.6);
    defense = Math.round(baseStrength * 0.7);
  } else {
    // 攻撃効果（tier別で調整）
    if (tier === 'mythical') {
      attack = Math.round(baseStrength * 1.0);
      defense = Math.round(baseStrength * 0.35);
    } else if (tier === 'weapon') {
      attack = Math.round(baseStrength * 0.95);
      defense = Math.round(baseStrength * 0.4);
    } else {
      attack = Math.round(baseStrength * 0.9);
      defense = Math.round(baseStrength * 0.45);
    }
  }

  attack = Math.min(100, Math.max(0, attack));
  defense = Math.min(100, Math.max(0, defense));

  return {
    word,
    attribute,
    attack,
    defense,
    effect,
    tier,
    supportType,
    weaknessDetected,
    description: `${attribute.toUpperCase()} [${tier}] / ATK:${attack} DEF:${defense} / ${effect}${supportType ? ' (' + supportType + ')' : ''}`
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
      isHost: idx === 0,
      supportUsed: 0,
      attackBoost: 0,
      defenseBoost: 0
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

  // 防御失敗ロジック：防御フェーズで攻撃カードを出した場合
  let defenseFailed = false;
  if (defenseCard.effect === 'attack') {
    defenseFailed = true;
  }

  // 攻撃ブースト適用
  let finalAttack = attackCard.attack;
  if (attacker.attackBoost > 0) {
    finalAttack = Math.round(finalAttack * (1 + attacker.attackBoost / 100));
    attacker.attackBoost = 0; // 1回使用後リセット
  }

  let damage = 0;
  if (defenseFailed) {
    // 防御失敗：フルダメージ
    damage = finalAttack;
  } else {
    // 通常ダメージ計算
    let finalDefense = defenseCard.defense;
    if (defender.defenseBoost > 0) {
      finalDefense = Math.round(finalDefense * (1 + defender.defenseBoost / 100));
      defender.defenseBoost = 0;
    }
    damage = Math.max(0, finalAttack - finalDefense);
  }

  if (attackCard.effect === 'heal') {
    attacker.hp = Math.min(STARTING_HP, attacker.hp + Math.round(attackCard.attack * 0.6));
    damage = 0;
  }
  if (defenseCard.effect === 'heal' && !defenseFailed) {
    defender.hp = Math.min(STARTING_HP, defender.hp + Math.round(defenseCard.defense * 0.5));
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
    defenseFailed,
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

  socket.on('supportAction', ({ word }) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room || !room.started) return;
    if (room.players[room.turnIndex].id !== socket.id) {
      socket.emit('errorMessage', { message: 'あなたのターンではありません' });
      return;
    }

    const player = findPlayer(room, socket.id);
    if (!player) return;

    if (player.supportUsed >= 3) {
      socket.emit('errorMessage', { message: 'サポートは1試合に3回までです' });
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

    const card = generateCard(cleanWord);
    room.usedWordsGlobal.add(lower);
    player.usedWords.add(lower);
    player.supportUsed++;

    // サポート効果適用
    if (card.supportType === 'heal_boost') {
      player.hp = Math.min(STARTING_HP, player.hp + 30);
    } else if (card.supportType === 'attack_boost') {
      player.attackBoost = 50; // 次ターン攻撃力50%アップ
    } else if (card.supportType === 'defense_boost') {
      player.defenseBoost = 40;
    } else if (card.supportType === 'enemy_debuff') {
      const opponent = getOpponent(room, socket.id);
      if (opponent) opponent.hp = Math.max(0, opponent.hp - 15);
    } else {
      player.hp = Math.min(STARTING_HP, player.hp + 20);
    }

    const hp = {};
    room.players.forEach(p => { hp[p.id] = p.hp; });

    io.to(roomId).emit('supportUsed', {
      playerId: player.id,
      card,
      hp,
      supportRemaining: 3 - player.supportUsed
    });

    // ターン交代
    room.turnIndex = (room.turnIndex + 1) % room.players.length;
    updateStatus(roomId, `${room.players[room.turnIndex].name} のターンです`);
  });

  socket.on('disconnect', () => {
    handleDisconnect(socket);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
