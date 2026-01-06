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

// 属性相性（5すくみ + 光/闇相互弱点）
function getAffinity(attackerAttr, defenderAttr) {
  const strongAgainst = {
    fire: 'earth',
    earth: 'wind',
    wind: 'thunder',
    thunder: 'water',
    water: 'fire',
    light: 'dark',
    dark: 'light'
  };

  const atk = (attackerAttr || '').toLowerCase();
  const def = (defenderAttr || '').toLowerCase();

  if (strongAgainst[atk] === def) {
    return { multiplier: 2.0, relation: 'advantage', isEffective: true };
  }
  if (strongAgainst[def] === atk) {
    return { multiplier: 0.5, relation: 'disadvantage', isEffective: false };
  }
  return { multiplier: 1.0, relation: 'neutral', isEffective: false };
}

// =====================================
// ダメージ計算関数（属性相性2.0倍対応）
// =====================================
function calculateDamage(attackCard, defenseCard, attacker, defender, defenseFailed = false) {
  const chart = {
    fire: { earth: 2.0, water: 0.5 },
    earth: { wind: 2.0, fire: 0.5 },
    wind: { thunder: 2.0, earth: 0.5 },
    thunder: { water: 2.0, wind: 0.5 },
    water: { fire: 2.0, thunder: 0.5 },
    light: { dark: 2.0 },
    dark: { light: 2.0 }
  };

  // 攻撃力補正（ブースト適用）
  let finalAttack = attackCard.attack;
  if (attacker.attackBoost > 0) {
    finalAttack = Math.round(finalAttack * (1 + attacker.attackBoost / 100));
    attacker.attackBoost = 0;
  }

  // 属性相性補正
  let multiplier = 1.0;
  const atk = (attackCard.attribute || '').toLowerCase();
  const def = (defenseCard.attribute || '').toLowerCase();
  if (chart[atk] && chart[atk][def]) {
    multiplier = chart[atk][def];
  }
  finalAttack = Math.round(finalAttack * multiplier);

  // ダメージ計算
  let damage = 0;
  if (defenseFailed) {
    damage = finalAttack;
  } else {
    let finalDefense = defenseCard.defense;
    if (defender.defenseBoost > 0) {
      finalDefense = Math.round(finalDefense * (1 + defender.defenseBoost / 100));
      defender.defenseBoost = 0;
    }
    damage = Math.max(5, finalAttack - finalDefense);
  }

  return Math.floor(damage);
}

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
  
  const prompt = `あなたは伝説的なカードゲームの創造主であり、冷徹かつ公平な審判です。
入力された言葉に対し、以下の思考プロセスを経て、完全に独自のステータスを生成してください。

【思考プロセス】
1. 言葉の全方位分析：
   - 材質（硬い、柔らかい、重い、鋭い）
   - 歴史・神話・サブカルチャーでの役割（聖剣なら神聖、ローブなら魔力）
   - 日常的なイメージ（サボテンならトゲ、盾なら守護）
2. テンプレートの破壊：
   - 「攻撃力10」などのキリの良い数字を避け、13や27など、理由に基づいたリアルな数値を設定せよ。
   - すべての言葉に、その単語ならではの「固有の効果名」を付けよ。
3. ロールの厳格な解釈：
   - 【Attack】: 殺傷力、衝撃力があるもの。
   - 【Defense】: 盾、鎧、壁だけでなく「避ける」「耐える」「覆う」もの（服、マント、霧など）も含む。
   - 【Support】: 回復、増強、妨害、特殊状態。特に「最大HPを増やす」「HPを継続回復」「属性耐性を付与」など。

【出力JSON形式】
{
  "attack": 数値,
  "defense": 数値,
  "attribute": "fire/water/wind/earth/thunder/light/darkから1つ",
  "role": "Attack/Defense/Support",
  "specialEffect": "効果名：具体的な効果内容の説明",
  "effectType": "heal/buff/debuff/damage/hpMaxUp/counter", 
  "effectValue": 数値,
  "judgeComment": "語源や材質から導き出した査定の全論理（200文字程度で熱く語れ）"
}`;

  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    const result = await model.generateContent(prompt);
    let responseText = result.response.text().trim();
    
    // JSONマークダウン装飾を削除
    responseText = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    
    const cardData = JSON.parse(responseText);

    // 必須フィールドのチェック（新形式に対応）
    if (cardData.attack === undefined || cardData.defense === undefined || !cardData.specialEffect || !cardData.judgeComment) {
      throw new Error('必須フィールドが不足しています');
    }

    const attackVal = Math.max(0, Math.min(100, Math.round(cardData.attack)));
    const defenseVal = Math.max(0, Math.min(100, Math.round(cardData.defense)));
    
    // role の正規化（Attack/Defense/Support → attack/defense/support）
    let role = 'attack';
    if (cardData.role) {
      const roleLower = cardData.role.toLowerCase();
      if (roleLower === 'attack' || roleLower === 'defense' || roleLower === 'support') {
        role = roleLower;
      } else if (roleLower === 'heal') {
        role = 'heal';
      }
    }
    
    const supportType = cardData.supportEffect || cardData.supportType || null;
    const attribute = cardData.attribute || 'earth';
    const specialEffect = (cardData.specialEffect && 
                           cardData.specialEffect !== 'none' && 
                           cardData.specialEffect.trim() !== '' &&
                           cardData.specialEffect !== 'なし' &&
                           cardData.specialEffect !== '特になし' &&
                           !cardData.specialEffect.match(/攻撃力.*\+|防御力.*\+/)) 
                           ? cardData.specialEffect 
                           : '【微弱反射】被ダメージの3%を反射';
    const hasReflect = cardData.hasReflect === true || /反射/.test(specialEffect) || /cactus|サボテン/.test(original);
    const tier = cardData.tier || (attackVal >= 80 ? 'mythical' : attackVal >= 50 ? 'weapon' : 'common');

    return {
      word: original,  // 入力された元の単語を使用
      attribute,
      attack: attackVal,
      defense: defenseVal,
      effect: role,
      tier,
      supportType,
      specialEffect,
      hasReflect,
      judgeComment: cardData.judgeComment || '審判のコメントなし',
      description: `${attribute.toUpperCase()} [${tier.toUpperCase()}] / ATK:${attackVal} DEF:${defenseVal} / ${role}${supportType ? ' (' + supportType + ')' : ''} / ${specialEffect}${hasReflect ? ' / hasReflect' : ''}`
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
  
  // 特殊効果判定（特殊能力特化型・【】命名規則）
  let specialEffect = '【微弱反射】被ダメージの3%を反射';
  if (/サボテン|cactus/.test(lower)) specialEffect = '【トゲの反射】受けたダメージの20%を反射するトゲの呪い';
  else if (/毒|poison|ヘビ|蛇/.test(lower)) specialEffect = '【猛毒】3ターンの間、毎ターンHP-3';
  else if (/氷|ice|凍/.test(lower)) specialEffect = '【凍結】相手次ターン行動不能（確率20%）';
  else if (/雷|thunder|電/.test(lower)) specialEffect = '【麻痺】相手の回避不能化（1ターン）';
  else if (/火|fire|炎/.test(lower)) specialEffect = '【火傷】2ターンの間、毎ターンHP-2';
  else if (/吸血|vampire|ドレイン/.test(lower)) specialEffect = '【吸血】与ダメージの25%をHP回復';
  else if (/盾|shield|防/.test(lower)) specialEffect = '【頑強】被ダメージ-15%';
  else if (/鏡|mirror|反射/.test(lower)) specialEffect = '【完全反射】被ダメージの12%を反射';
  else if (/トゲ|針|spike/.test(lower)) specialEffect = '【刺反射】被ダメージの8%を反射';
  else if (/霧|fog|煙/.test(lower)) specialEffect = '【視界妨害】相手の命中率-15%';
  else if (/風|wind/.test(lower)) specialEffect = '【回避上昇】自身の回避率+12%';
  else if (/重|gravity|圧/.test(lower)) specialEffect = '【重圧】相手の全ステータス-8%（1ターン）';

  const hasReflect = /サボテン|cactus/.test(lower) || /反射/.test(specialEffect);
  
  return {
    word,
    attribute,
    attack: strength,
    defense: defVal,
    effect: 'attack',
    tier,
    supportType: null,
    judgeComment: 'フォールバック: 簡易推定。特性不明のため汎用反射効果を付与。物質的特徴から【】命名。',
    specialEffect,
    hasReflect,
    description: `[${tier.toUpperCase()}] ATK:${strength} DEF:${defVal} / ${specialEffect}`
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
  if (!room || !room.started || !room.pendingAttack) {
    console.log('⚠️ 防御エラー: 無効な状態', { roomId, started: room?.started, pendingAttack: !!room?.pendingAttack });
    socket.emit('errorMessage', { message: '防御できる状態ではありません' });
    return;
  }
  if (room.pendingAttack.defenderId !== socket.id) {
    console.log('⚠️ 防御エラー: 防御者不一致', { expected: room.pendingAttack.defenderId, actual: socket.id });
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

  console.log('🛡️ 防御処理開始:', { roomId, defender: socket.id, word: cleanWord });

  const attacker = findPlayer(room, room.pendingAttack.attackerId);
  const defender = findPlayer(room, socket.id);
  if (!attacker || !defender) {
    console.log('⚠️ 防御エラー: プレイヤーが見つかりません');
    return;
  }

  const attackCard = room.pendingAttack.card;
  
  // 非同期で防御カードを生成
  generateCard(cleanWord, 'defense').then(defenseCard => {
    console.log('🛡️ 防御カード生成完了:', defenseCard);
    room.usedWordsGlobal.add(lower);
    defender.usedWords.add(lower);

    // 防御失敗ロジック：防御フェーズで攻撃カードを出した場合
    let defenseFailed = false;
    if (defenseCard.effect === 'attack') {
      defenseFailed = true;
    }

    // ダメージ計算（属性相性2.0倍対応）
    const affinity = getAffinity(attackCard.attribute, defenseCard.attribute);
    const damage = calculateDamage(attackCard, defenseCard, attacker, defender, defenseFailed);

    // カウンターダメージ処理（トゲ系）
    let counterDamage = 0;
    if (defenseCard.counterDamage && !defenseFailed) {
      counterDamage = defenseCard.counterDamage;
      attacker.hp = Math.max(0, attacker.hp - counterDamage);
      console.log(`🌵 カウンターダメージ発動: ${defenseCard.counterDamage}ダメージを攻撃者に与えた`);
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
    } else if (attacker.hp <= 0) {
      winnerId = defender.id;
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
      counterDamage,
      affinity,
      hp,
      defenseFailed,
      nextTurn: winnerId ? null : room.players[room.turnIndex].id,
      winnerId
    });

    console.log('✅ ターン解決完了:', { damage, counterDamage, winnerId, nextTurn: room.players[room.turnIndex].id });

    if (winnerId) {
      updateStatus(roomId, `${attacker.name} の勝利！`);
    } else {
      updateStatus(roomId, `${room.players[room.turnIndex].name} のターンです`);
    }
  }).catch(error => {
    console.error('❌ 防御カード生成エラー:', error);
    socket.emit('errorMessage', { message: 'エラーが発生しました。もう一度お試しください。' });
    // エラー時は攻撃をキャンセルして次のターンへ
    room.pendingAttack = null;
    room.turnIndex = (room.turnIndex + 1) % room.players.length;
    updateStatus(roomId, `エラーが発生しました。${room.players[room.turnIndex].name} のターンです`);
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
