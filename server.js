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

const waitingPlayers = [];
const passwordRooms = new Map(); // password -> roomId
const rooms = new Map(); // roomId -> room state

// =====================================
// Gemini APIを使ったカード生成（非同期）
// =====================================
async function generateCard(word, intent = 'neutral') {
  const original = word;
  const intentNote = intent === 'defense'
    ? '現在は防御フェーズ。プレイヤーは防御目的で入力している。以下の基準で判定せよ：\n' +
      '【防御として扱う】攻撃的要素があっても、守る・防ぐ・耐える・遮る目的の語、または防御物質（盾/壁/鎧/バリア/シールド等）は必ず role: "defense" とする。\n' +
      '  例: スパイクシールド、炎の壁、爆発する盾、トゲの鎧、電撃バリア、溶岩の門、氷の壁、毒の盾 → 全て defense\n' +
      '【防御失敗】明らかに攻撃・破壊のみを目的とし、防御機能が一切ない語のみ role: "attack" とする。\n' +
      '  例: 核爆弾、斬撃、隕石落下、一刀両断、爆破、暗殺、破壊光線 → attack（防御失敗）\n' +
      '判断に迷ったら defense を優先せよ。'
    : intent === 'attack'
      ? '現在は攻撃フェーズ。破壊・加害を主目的とするロールを優先せよ。'
      : intent === 'support'
        ? '現在はサポート用途。回復・強化・弱体化を優先ロールとせよ。'
        : '通常査定。文脈から最適な役割を選べ。';
  
  const prompt = `あなたは世界一厳しいカードゲームの「冷徹な審判」です。感情を排し、言葉の「物質的・概念的特性」を深掘りし、その特性に即した数値と特殊効果を査定してください。

コンテキスト: ${intentNote}

評価対象ワード: "${original}"

【特性抽出と査定手順】
1. 物質的・概念的特性の抽出：「${original}」を構成する名詞・素材・生物・概念を分解し、物理的・化学的・生物学的・概念的性質を特定する。
   - 例: サボテン → 多肉質でトゲがある。
   - 例: ゴム → 電気を通しにくい絶縁体。
   - 例: 氷 → 冷却し滑りやすく凍結させる。
   - 例: 盾(サボテン製) → 植物素材で柔らかい。
   - 例: ライオンの毛 → 本体でないので攻防は極低。
2. 特殊効果設計（必須）：抽出した特性に基づいて specialEffect を必ず生成する。**"none" や空欄は絶対禁止。如何なる言葉にも必ず特殊効果を付与せよ。**
   - 物理的特性の例：
     * サボテン → 「トゲによる反射ダメージ 5%」
     * 氷 → 「凍結：相手次ターン行動不能 20%」
     * 鋼鉄の門 → 「物理ダメージ軽減 30%」
     * ゴム → 「雷属性完全無効」
     * 重い石 → 「衝撃ダメージ +15%」
     * 透明なガラス → 「光属性ダメージ +10%」
   - 生物的特性の例：
     * ライオンの毛 → 「威嚇：相手攻撃力 -5」
     * 毒蛇 → 「毒付与：毎ターン HP-3」
     * コウモリ → 「吸血：与ダメージの 20% HP回復」
     * 植物 → 「光合成：毎ターン HP+2」
   - 概念的特性の例：
     * 希望 → 「士気高揚：次ターン攻撃力 +15%」
     * 絶望 → 「沈静：相手防御力 -20%」
     * 時間 → 「時間停止：相手行動遅延 10%」
     * 夢 → 「幻惑：命中率 -10%」
   - 日常品でも必ず効果を：
     * ため息 → 「脅力付与：相手攻撃力 -3」
     * 紙 → 「軽量：回避率 +5%」
     * 水 → 「消火：火属性ダメージ -30%」
   - **いかなる場合でも、反射/回復/軽減/強化/弱体化/状態異常/属性ガード/確率変化などから必ず一つ選んで効果を生成せよ。**
3. 数値調整：特性に合わせて attack/defense を上下させる（例: サボテンの盾は柔らかいので防御を下げつつ反射効果を付与）。
4. 属性判定（必須）：言葉の物理的・概念的特性から最もふさわしい属性を必ず選択する。**選択肢は fire/water/wind/earth/thunder/light/dark のみ。neutral は禁止。**
   - fire（火）: 燃焼・高温・爆発・マグマ・太陽など（例: 火山、爆弾、フェニックス）
   - water（水）: 液体・海・氷・冷却・流動など（例: 津波、深海、氷河）
   - wind（風）: 気流・竜巻・速度・自由など（例: 暴風、疾風、翼）
   - earth（土）: 大地・岩石・植物・重量・安定など（例: 世界樹、山脈、岩盤）
   - thunder（雷）: 電気・稲妻・高速・麻痺など（例: 雷神、プラズマ、電撃）
   - light（光）: 神聖・浄化・癒し・輝きなど（例: 天使、聖剣、太陽光）
   - dark（闇）: 呪い・死・影・吸収など（例: 死神、暗黒魔法、奈落）
   - 複合的特性を持つ場合は、最も支配的な要素を選ぶ。
5. シナジー評価：複合語の組み合わせを厳密に評価し、響きだけで誇張しない。
6. 役割判定：攻撃=破壊・加害、防御=遮断・吸収・耐久、サポート=回復・強化/弱体化。
   - **防御フェーズ判定（重要）**：
     * 盾/壁/鎧/バリア/シールド/門/障壁/防壁など防御物質 → 必ず role: "defense"
     * 「守る」「防ぐ」「耐える」「遮る」意図を含む語 → 必ず role: "defense"
     * 攻撃的要素（トゲ、炎、電撃等）があっても防御目的なら → role: "defense"
     * 判断に迷う場合 → defense を優先
     * 明らかに攻撃・破壊のみで防御機能ゼロの語のみ → role: "attack"（防御失敗）
7. 数値化ポリシー：
   0-10   : 日常品／ゴミ／弱気（ため息・垢・毛など）
   11-40  : 一般武器・小動物・初級魔法
   41-70  : 伝説武器・大型モンスター・中級魔法・自然現象
   71-90  : 神話級存在・究極魔法・天変地異
   91-100 : 世界崩壊・概念的死・時空破壊（極稀）
8. 防御失敗ポリシー：防御フェーズで「純粋な攻撃・破壊のみ」で防御機能が一切ない語（核爆弾、斬撃、暗殺等）のみ role: "attack" と判定。

【出力フォーマット】必ず JSON のみで出力。キーは固定：
{
  "word": "入力文字列",
  "attack": 0-100 の整数,
  "defense": 0-100 の整数,
  "supportEffect": "heal_boost/attack_boost/defense_boost/enemy_debuff/general_boost/null",
  "specialEffect": "言葉固有のユニーク効果（例: トゲ反射5%、雷無効、凍結など）",
  "attribute": "fire/water/wind/earth/thunder/light/dark",
  "role": "attack/defense/heal/support",
  "judgeComment": "物理・化学・生物・概念特性から数値・属性・効果・specialEffect の全てを導いた理由を20-80文字で冷徹に説明"
}

【重要】
- JSON のみを返す。説明文やマークダウンは禁止。
- **specialEffect は "none" や空欄は絶対禁止。如何なる言葉でも必ず具体的でユニークな効果を生成すること。"none" や "なし" や "特になし" などは全て禁止。**
- judgeComment には、数値だけでなく specialEffect の根拠（なぜその効果なのか）も必ず含めること。`;

  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    const result = await model.generateContent(prompt);
    const responseText = result.response.text().trim();
    const cardData = JSON.parse(responseText);

    if (!cardData.word || cardData.attack === undefined || cardData.defense === undefined || !cardData.specialEffect || !cardData.judgeComment) {
      throw new Error('必須フィールドが不足しています');
    }

    const attackVal = Math.max(0, Math.min(100, Math.round(cardData.attack)));
    const defenseVal = Math.max(0, Math.min(100, Math.round(cardData.defense)));
    const role = (cardData.role || cardData.effect || 'attack').toLowerCase();
    const supportType = cardData.supportEffect || cardData.supportType || null;
    const attribute = cardData.attribute || 'earth';
    const specialEffect = (cardData.specialEffect && 
                           cardData.specialEffect !== 'none' && 
                           cardData.specialEffect.trim() !== '' &&
                           cardData.specialEffect !== 'なし' &&
                           cardData.specialEffect !== '特になし') 
                           ? cardData.specialEffect 
                           : '基礎効果：全ステータス +5%';
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
  
  const defVal = Math.round(strength * 0.7);
  
  // 属性判定
  let attribute = 'earth';
  if (/fire|炎|爆|熱|マグマ|焼/.test(lower)) attribute = 'fire';
  else if (/water|水|海|氷|雨|波/.test(lower)) attribute = 'water';
  else if (/wind|風|竜巻|嵐|翼/.test(lower)) attribute = 'wind';
  else if (/thunder|雷|電|lightning|プラズマ/.test(lower)) attribute = 'thunder';
  else if (/light|光|聖|天使|神/.test(lower)) attribute = 'light';
  else if (/dark|闇|死|呪|影/.test(lower)) attribute = 'dark';
  
  return {
    word,
    attribute,
    attack: strength,
    defense: defVal,
    effect: 'attack',
    tier,
    supportType: null,
    judgeComment: 'フォールバック: 簡易推定。特性不明のため汎用効果を付与。',
    specialEffect: '汎用強化：全ステータス+3%',
    description: `[${tier.toUpperCase()}] ATK:${strength} DEF:${defVal} / 汎用強化：全ステータス+3%`
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
  generateCard(cleanWord, 'attack').then(card => {
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
  generateCard(cleanWord, 'defense').then(defenseCard => {
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

function removeFromWaiting(socketId) {
  // 待機プレイヤーリストから削除
  const idx = waitingPlayers.findIndex(p => p.socket.id === socketId);
  if (idx >= 0) {
    const removed = waitingPlayers.splice(idx, 1)[0];
    console.log(`✅ プレイヤー ${removed.name} (${socketId}) を待機リストから削除しました`);
  }

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

  broadcastWaitingQueue();
}

function handleDisconnect(socket) {
  removeFromWaiting(socket.id);
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
  
  // バトル開始後はキャンセル不可
  if (room && room.started) {
    socket.emit('errorMessage', { message: 'バトル開始後はキャンセルできません' });
    return;
  }

  console.log(`🚫 マッチングキャンセル要求: ${socket.id}`);
  
  // 待機リストから削除
  removeFromWaiting(socket.id);
  
  // ルームから退出
  if (roomId) {
    socket.leave(roomId);
    socket.data.roomId = null;
    console.log(`  → ルーム ${roomId} から退出`);
  }

  // クライアントに通知
  socket.emit('matchCancelled', { message: 'マッチングをキャンセルしました' });
  console.log(`  → キャンセル完了`);
}

function broadcastWaitingQueue() {
  const payload = {
    players: waitingPlayers.map(p => ({ id: p.socket.id, name: p.name })),
    canStart: false,
    hostId: null
  };
  waitingPlayers.forEach(p => p.socket.emit('waitingUpdate', payload));
}

io.on('connection', (socket) => {
  socket.on('startMatching', ({ name, mode, password }) => {
    const playerName = (name || '').trim();
    if (!playerName) {
      socket.emit('errorMessage', { message: 'プレイヤー名を入力してください' });
      return;
    }

    const playerEntry = { socket, name: playerName };

    // 二重登録防止（既に待機中の場合は削除）
    console.log(`🔄 ${playerName} (${socket.id}) がマッチング開始`);
    removeFromWaiting(socket.id);

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

    // デフォルトはランダムマッチ
    if (waitingPlayers.length > 0) {
      const opponent = waitingPlayers.shift();
      createRoom([opponent, playerEntry], 'random', null);
    } else {
      waitingPlayers.push(playerEntry);
      broadcastWaitingQueue();
    }
  });

  // 後方互換: 旧イベント名も受け付ける
  socket.on('joinGame', (payload) => {
    socket.emit('errorMessage', { message: 'このクライアントは更新が必要です。再読込してください。' });
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
      const card = await generateCard(cleanWord, 'support');
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

  socket.on('cancelMatching', () => {
    handleCancelMatch(socket);
    broadcastWaitingQueue();
  });

  // 後方互換
  socket.on('cancelMatch', () => {
    handleCancelMatch(socket);
    broadcastWaitingQueue();
  });

  socket.on('disconnect', () => {
    handleDisconnect(socket);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
