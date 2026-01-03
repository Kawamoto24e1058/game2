const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');
const { GoogleGenerativeAI } = require('@google/generative-ai');

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

// Gemini API初期化
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error('⚠️ GEMINI_API_KEY が設定されていません');
  process.exit(1);
}
const genAI = new GoogleGenerativeAI(apiKey);

const randomQueue = [];
const passwordRooms = new Map(); // password -> roomId
const rooms = new Map(); // roomId -> room state

// =====================================
// Gemini APIを使ったカード生成（非同期）
// =====================================
async function generateCard(word) {
  const original = word;
  
  const prompt = `あなたは世界一厳しいカードゲームの「冷徹な審判」です。感情を排し、言葉全体の文脈を解剖し、物理的・化学的・生物学的特徴からゲーム効果を生成してください。甘い評価は禁止。

評価対象ワード: "${original}"

【分析手順】
1. 構成要素の抽出と特徴調査：「${original}」を構成する名詞・素材・生物・概念を分解し、物理的・化学的・生物学的・概念的性質を特定する。
  - 例: サボテン → 多肉質でトゲがある → 防御低め＋トゲ反射5%。
  - 例: ゴム → 電気を通しにくい → 雷無効。
  - 例: 氷 → 冷却し凍結させる → 次ターン相手を凍結(行動不能)。
  - 例: 盾(サボテン製) → 植物素材で柔らかい → 防御力を通常より低く、トゲ反射付与。
  - 例: ライオンの毛 → 本体でないため攻防は極めて低い。
2. シナジー評価：複合語の組み合わせが実際に与える効果を厳密に算定し、響きの強さだけで誇張しない。
3. 役割判定：攻撃=破壊・加害、 防御=遮断・吸収、 サポート=回復・強化/弱体化。文脈から最も自然な役割を選ぶ。
4. 数値化ポリシー：
   0-10   : 日常品／ゴミ／弱気（ため息・垢・毛など）
   11-40  : 一般武器・小動物・初級魔法
   41-70  : 伝説武器・大型モンスター・中級魔法・自然現象
   71-90  : 神話級存在・究極魔法・天変地異
   91-100 : 世界崩壊・概念的死・時空破壊（極稀）
5. 防御失敗ポリシー：防御フェーズで攻撃的／破壊的な語は必ず role: "attack" と判定し、防御失敗の原因となること。

【出力フォーマット】必ず JSON のみで出力。キーは固定：
{
  "word": "入力文字列",
  "attack": 0-100 の整数,
  "defense": 0-100 の整数,
  "supportEffect": "heal_boost/attack_boost/defense_boost/enemy_debuff/general_boost/null",
  "specialEffect": "言葉固有のユニーク効果（例: トゲ反射5%、雷無効、凍結など）",
  "attribute": "light/dark/fire/water/thunder/earth/wind/neutral",
  "role": "attack/defense/heal/support",
  "judgeComment": "物理・化学・生物特徴から数値と効果を導いた理由を20-80文字で冷徹に説明"
}

【重要】
- JSON のみを返す。説明文やマークダウンは禁止。
- 構成要素の物理・化学・生物特徴を踏まえた specialEffect を必ず付与。`;

  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    const result = await model.generateContent(prompt);
    const responseText = result.response.text().trim();
    const cardData = JSON.parse(responseText);

    if (!cardData.word || cardData.attack === undefined || cardData.defense === undefined) {
      throw new Error('必須フィールドが不足しています');
    }

    const attackVal = Math.max(0, Math.min(100, Math.round(cardData.attack)));
    const defenseVal = Math.max(0, Math.min(100, Math.round(cardData.defense)));
    const role = (cardData.role || cardData.effect || 'attack').toLowerCase();
    const supportType = cardData.supportEffect || cardData.supportType || null;
    const attribute = cardData.attribute || 'neutral';
    const specialEffect = cardData.specialEffect || 'none';
    const tier = cardData.tier || (attackVal >= 80 ? 'mythical' : attackVal >= 50 ? 'weapon' : 'common');

    return {
      word: cardData.word,
      attribute,
      attack: attackVal,
      defense: defenseVal,
      effect: role,
      tier,
      supportType,
      specialEffect,
      judgeComment: cardData.judgeComment || '審判のコメントなし',
      description: `${attribute.toUpperCase()} [${tier.toUpperCase()}] / ATK:${attackVal} DEF:${defenseVal} / ${role}${supportType ? ' (' + supportType + ')' : ''} / ${specialEffect}`
    };
  } catch (error) {
    console.error('❌ Gemini API エラー:', error);
    return generateCardFallback(original);
  }
}
function generateCardFallback(word) {
  const lower = word.toLowerCase();
  let strength = 30;
  let tier = 'common';
  
  if (/dragon|神|excalibur|phoenix/i.test(lower)) {
    strength = 90;
    tier = 'mythical';
  } else if (/katana|sword|wizard|thunder|fire/i.test(lower)) {
    strength = 65;
    tier = 'weapon';
  }
  
  if (/ため息|whisper|gentle/i.test(lower)) strength = Math.min(15, strength * 0.3);
  
  return {
    word,
    attribute: /fire|炎/.test(lower) ? 'fire' : 'neutral',
    attack: strength,
    defense: Math.round(strength * 0.7),
    effect: 'attack',
    tier,
    supportType: null,
    judgeComment: 'フォールバック: 簡易推定',
    specialEffect: 'none',
    description: `[${tier.toUpperCase()}] ATK:${strength} DEF:${Math.round(strength * 0.7)}`
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
  if (!room || !room.started) return;
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

  // 非同期でカード生成
  generateCard(cleanWord).then(card => {
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
  }).catch(error => {
    console.error('カード生成エラー:', error);
    socket.emit('errorMessage', { message: 'エラーが発生しました' });
  });
}

function handleDefend(roomId, socket, word) {
  const room = rooms.get(roomId);
  if (!room || !room.started || !room.pendingAttack) return;
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
  
  // 非同期で防御カードを生成
  generateCard(cleanWord).then(defenseCard => {
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
      attacker.attackBoost = 0;
    }

    let damage = 0;
    if (defenseFailed) {
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
    room.turnIndex = (room.turnIndex + 1) % room.players.length;

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
  }).catch(error => {
    console.error('防御カード生成エラー:', error);
    socket.emit('errorMessage', { message: 'エラーが発生しました' });
  });
}

function removeFromQueues(socketId) {
  const idx = randomQueue.findIndex(p => p.socket.id === socketId);
  if (idx >= 0) randomQueue.splice(idx, 1);

  const processedRooms = new Set();

  for (const [pwd, roomId] of passwordRooms) {
    const room = rooms.get(roomId);
    if (room && room.players.some(p => p.id === socketId) && !room.started) {
      room.players = room.players.filter(p => p.id !== socketId);
      if (room.hostId === socketId) {
        room.hostId = room.players[0]?.id || null;
      }
      broadcastWaiting(roomId);
      processedRooms.add(roomId);
      if (room.players.length === 0) {
        rooms.delete(roomId);
        passwordRooms.delete(pwd);
      }
    }
  }

  for (const [roomId, room] of rooms) {
    if (processedRooms.has(roomId)) continue;
    if (room && room.players.some(p => p.id === socketId) && !room.started) {
      room.players = room.players.filter(p => p.id !== socketId);
      if (room.hostId === socketId) {
        room.hostId = room.players[0]?.id || null;
      }
      broadcastWaiting(roomId);
      if (room.players.length === 0) {
        rooms.delete(roomId);
        if (room.password) passwordRooms.delete(room.password);
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

function handleCancelMatch(socket) {
  const roomId = socket.data.roomId;
  const room = roomId ? rooms.get(roomId) : null;
  if (room && room.started) {
    socket.emit('errorMessage', { message: 'バトル開始後はキャンセルできません' });
    return;
  }

  removeFromQueues(socket.id);
  if (roomId) {
    socket.leave(roomId);
    socket.data.roomId = null;
  }

  socket.emit('matchCancelled', { message: 'マッチングをキャンセルしました' });
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

  socket.on('playWord', async ({ word }) => {
    const roomId = socket.data.roomId;
    await handlePlayWord(roomId, socket, word);
  });

  socket.on('defendWord', async ({ word }) => {
    const roomId = socket.data.roomId;
    await handleDefend(roomId, socket, word);
  });

  socket.on('supportAction', async ({ word }) => {
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

    try {
      const card = await generateCard(cleanWord);
      room.usedWordsGlobal.add(lower);
      player.usedWords.add(lower);
      player.supportUsed++;

      // サポート効果適用
      if (card.supportType === 'heal_boost') {
        player.hp = Math.min(STARTING_HP, player.hp + 30);
      } else if (card.supportType === 'attack_boost') {
        player.attackBoost = 50;
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

      room.turnIndex = (room.turnIndex + 1) % room.players.length;
      updateStatus(roomId, `${room.players[room.turnIndex].name} のターンです`);
    } catch (error) {
      console.error('サポートカード生成エラー:', error);
      socket.emit('errorMessage', { message: 'エラーが発生しました' });
    }
  });

  socket.on('cancelMatch', () => {
    handleCancelMatch(socket);
  });

  socket.on('disconnect', () => {
    handleDisconnect(socket);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
