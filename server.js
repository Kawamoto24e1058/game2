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
  
  const prompt = `あなたはカードゲームのAIです。ユーザーが入力した言葉から、そのカードの能力値を決定してください。

【入力】${original}

【出力形式】以下のJSON形式で、絶対にこの形式を守って出力してください：
{
  "word": "ユーザーの入力した言葉",
  "attack": 0-100の数値（攻撃力）,
  "defense": 0-100の数値（防御力）,
  "attribute": "light/dark/fire/water/thunder/earth/wind/heal のいずれか",
  "effect": "attack/defense/heal/support のいずれか",
  "supportType": "heal_boost/attack_boost/defense_boost/enemy_debuff/general_boost/null のいずれか",
  "tier": "common/weapon/mythical のいずれか"
}

【評価ルール】
1. 【主語が強くても述語が弱ければ弱くする】
   - 例：「ドラゴンのため息」→ ドラゴン(強い)だが、ため息(弱い)なので、全体的に弱い（攻撃力15程度）
   - 例：「神の祝福」→ 神(強い)＋祝福(サポート効果)で、support（防御力が高い）

2. 【フレーズ全体のニュアンスを読み取る】
   - 「つぶやき」「ため息」「あくび」「寝ぼけ」「なでる」などが含まれると、全体的に弱くしてください（5-15）
   - 「古い」「錆びた」「壊れた」などが含まれると、本来の強さから-15程度

3. 【tier の判定】
   - mythical: 神話級・伝説級（excalibur, 神, ドラゴン, 大黒ホール, ビッグバンなど）→ 攻撃力80-100
   - weapon: 現代兵器・強者（日本刀, 戦車, 魔法, 炎, 雷など）→ 攻撃力50-79
   - common: 日用品・一般的な物（棒, 石, 拳, 本など）→ 攻撃力10-49

4. 【effect の判定】
   - "attack": 攻撃的な言葉（斬る, 爆発, 猛火など）
   - "defense": 防御的な言葉（盾, ガード, 壁など）
   - "heal": 回復的な言葉（癒し, 回復, 薬など）
   - "support": サポート的な言葉（祝福, 応援, 強化など）

5. 【supportType の判定】（effect が "support" の場合のみ）
   - "heal_boost": HP回復系（癒し, 回復, 薬など）
   - "attack_boost": 攻撃強化系（強化, 力, パワーなど）
   - "defense_boost": 防御強化系（守る, 保護, 盾など）
   - "enemy_debuff": 敵弱体化系（呪い, 弱体化, 封印など）
   - "general_boost": 汎用系

6. 【attribute の判定】
   - "light": 光、聖、神聖、天使など
   - "dark": 闇、影、呪いなど
   - "fire": 炎、火、燃焼など
   - "water": 水、氷、冷凍など
   - "thunder": 雷、電撃、稲妻など
   - "earth": 土、岩、地面など
   - "wind": 風、空気、吹き飛ばすなど
   - "heal": 治癒、回復など

7. 【数値の決定】
   - attack: effect が "attack" の場合に高い値。防御的だと低い
   - defense: 防御効果が強いほど高い値。攻撃的だと低い
   - サポート系は attack=60, defense=70 程度

【例）**絶対にこのJSON形式に従ってください**
入力：「ドラゴンのため息」
出力：{
  "word": "ドラゴンのため息",
  "attack": 12,
  "defense": 8,
  "attribute": "wind",
  "effect": "attack",
  "supportType": null,
  "tier": "common"
}

入力：「聖なる光の盾」
出力：{
  "word": "聖なる光の盾",
  "attack": 20,
  "defense": 85,
  "attribute": "light",
  "effect": "defense",
  "supportType": null,
  "tier": "weapon"
}

入力：「神の祝福」
出力：{
  "word": "神の祝福",
  "attack": 30,
  "defense": 80,
  "attribute": "light",
  "effect": "support",
  "supportType": "defense_boost",
  "tier": "mythical"
}

【JSON だけを出力してください。説明文やマークダウンは一切含めないでください】`;

  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    const result = await model.generateContent(prompt);
    const responseText = result.response.text().trim();
    
    // JSONをパース
    const cardData = JSON.parse(responseText);
    
    // 必須フィールドの検証
    if (!cardData.word || cardData.attack === undefined || cardData.defense === undefined) {
      throw new Error('必須フィールドが不足しています');
    }

    // レスポンス形成
    return {
      word: cardData.word,
      attribute: cardData.attribute || 'neutral',
      attack: Math.max(0, Math.min(100, Math.round(cardData.attack))),
      defense: Math.max(0, Math.min(100, Math.round(cardData.defense))),
      effect: cardData.effect || 'attack',
      tier: cardData.tier || 'common',
      supportType: cardData.supportType || null,
      description: `${(cardData.attribute || 'NEUTRAL').toUpperCase()} [${(cardData.tier || 'common').toUpperCase()}] / ATK:${cardData.attack} DEF:${cardData.defense} / ${cardData.effect}${cardData.supportType ? ' (' + cardData.supportType + ')' : ''}`
    };
  } catch (error) {
    console.error('❌ Gemini API エラー:', error);
    // フォールバック: 簡単な強さ判定
    return generateCardFallback(original);
  }
}

// フォールバック関数（APIエラー時）
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

  socket.on('disconnect', () => {
    handleDisconnect(socket);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
