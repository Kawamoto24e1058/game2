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
  cors: { origin: '*' }
});

const PORT = process.env.PORT || 3000;
const STARTING_HP = 120;

// ========================================
// グローバル変数
// ========================================
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error('⚠️ GEMINI_API_KEY が設定されていません');
  process.exit(1);
}
const genAI = new GoogleGenerativeAI(apiKey);

const waitingPlayers = new Map(); // パスワード => [{ socket, name }, ...]
const rooms = new Map(); // roomId => { id, players: [...], started, currentTurn, pendingAttack, usedWords, fieldEffect }

// ========================================
// 属性相性関数
// ========================================
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

// ========================================
// ダメージ計算関数
// ========================================
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

  let finalAttack = attackCard.attack || 0;
  if (attacker.attackBoost > 0) {
    finalAttack = Math.round(finalAttack * (1 + attacker.attackBoost / 100));
    attacker.attackBoost = 0;
  }

  let multiplier = 1.0;
  const atk = (attackCard.attribute || '').toLowerCase();
  const def = (defenseCard.attribute || '').toLowerCase();
  if (chart[atk] && chart[atk][def]) {
    multiplier = chart[atk][def];
  }
  finalAttack = Math.round(finalAttack * multiplier);

  let damage = 0;
  if (defenseFailed) {
    let baseAttack = attackCard.attack || 0;
    if (attacker.attackBoost > 0) {
      baseAttack = Math.round(baseAttack * (1 + attacker.attackBoost / 100));
      attacker.attackBoost = 0;
    }
    damage = baseAttack;
    const maxEvasion = 50;
    const evasionChance = Math.min(maxEvasion, (defenseCard.evasion || 0)) / 100;
    if (Math.random() < evasionChance) {
      damage = 0;
    }
  } else {
    let finalDefense = defenseCard.defense || 0;
    if (defender.defenseBoost > 0) {
      finalDefense = Math.round(finalDefense * (1 + defender.defenseBoost / 100));
      defender.defenseBoost = 0;
    }
    damage = Math.max(5, finalAttack - finalDefense);
  }

  return Math.floor(damage);
}

// ========================================
// Gemini API カード生成（厳格定義モード）
// ========================================
async function generateCard(word, intent = 'neutral') {
  const original = word;
  
  const prompt = `あなたは歴史・科学・経済に詳しい熟練のゲームデザイナーです。入力単語から以下のJSONを生成せよ。

【数値の不規則化（必須）】
10、20、30、50などのキリの良い数字の使用を厳禁とする。具体的でバラバラな数値（例: 14、31、47、82）を設定せよ。

【役割(role)の絶対定義】

Defense: 盾、鎧、衣類、壁、ドーム、バリア、回避に関わる言葉。attackは必ず0にせよ。

Attack: 武器、魔法、暴力、攻撃に関わる言葉。defenseは必ず0にせよ。

Support: 状態変化、環境変化、回復、増強。attackとdefenseは共に必ず0にせよ。

【サポートの多様化】
supportTypeを設定せよ。以下から選択：
- fireBuff（炎強化: 炎属性ダメージ1.5倍）
- waterBuff（水強化: 水属性ダメージ1.5倍）
- heal（回復: HP+30）
- weatherChange（天候変化: 3ターン継続）
- debuff（弱体化: 相手攻撃-20%）
- staminaRecover（スタミナ回復: 25回復）
- magicRecover（魔力回復: 25回復）

【JSON構造（必須）】
{
  "role": "Attack|Defense|Support",
  "attack": 数値,
  "defense": 数値,
  "attribute": "fire|water|wind|earth|thunder|light|dark",
  "supportType": "fireBuff|waterBuff|heal|weatherChange|debuff|staminaRecover|magicRecover",
  "supportMessage": "効果説明（Support時に画面表示）",
  "specialEffect": "特殊効果説明",
  "staminaCost": 数値,
  "magicCost": 数値,
  "judgeComment": "100文字以上の根拠説明"
}

単語: ${original}
`;

  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    const result = await model.generateContent(prompt);
    let responseText = result.response.text().trim();
    
    responseText = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    
    const cardData = JSON.parse(responseText);

    if (cardData.attack === undefined || cardData.defense === undefined || !cardData.specialEffect || !cardData.judgeComment) {
      throw new Error('必須フィールドが不足しています');
    }

    let attackVal = Math.max(0, Math.min(100, Math.round(cardData.attack)));
    let defenseVal = Math.max(0, Math.min(100, Math.round(cardData.defense)));

    let role = 'attack';
    if (cardData.role) {
      const roleLower = cardData.role.toLowerCase();
      if (roleLower === 'attack' || roleLower === 'defense' || roleLower === 'support') {
        role = roleLower;
      } else if (roleLower === 'heal') {
        role = 'support';
      }
    }
    
    // 役割絶対主義: 数値をロールで0固定
    if (role === 'defense') {
      attackVal = 0;
    } else if (role === 'attack') {
      defenseVal = 0;
    } else if (role === 'support') {
      attackVal = 0;
      defenseVal = 0;
    }
    
    const supportType = cardData.supportType || null;
    const staminaCost = cardData.staminaCost !== undefined ? Number(cardData.staminaCost) : 0;
    const magicCost = cardData.magicCost !== undefined ? Number(cardData.magicCost) : 0;
    const attribute = cardData.attribute || 'earth';
    const specialEffect = cardData.specialEffect && cardData.specialEffect.trim() !== '' ? cardData.specialEffect : '【基本効果】標準的な効果';
    
    const supportMessage = (cardData.supportMessage && cardData.supportMessage.trim() !== '') 
                           ? cardData.supportMessage 
                           : '';
    
    const tier = cardData.tier || (attackVal >= 80 ? 'mythical' : attackVal >= 50 ? 'weapon' : 'common');

    return {
      word: original,
      attribute,
      attack: attackVal,
      defense: defenseVal,
      role,
      tier,
      supportType,
      supportMessage,
      specialEffect,
      staminaCost,
      magicCost,
      evasion: cardData.evasion || 0,
      judgeComment: cardData.judgeComment || '審判のコメント'
    };
  } catch (error) {
    console.error('❌ Gemini API エラー:', error);
    throw error;
  }
}

// ========================================
// リソースコスト適用
// ========================================
function applyResourceCost(player, card) {
  if (!player) return { card, shortage: false, staminaShort: false, magicShort: false };
  
  const staminaCost = Number(card.staminaCost) || 0;
  const magicCost = Number(card.magicCost) || 0;
  const beforeSt = player.stamina || 0;
  const beforeMp = player.magic || 0;
  
  const staminaShort = beforeSt < staminaCost;
  const magicShort = beforeMp < magicCost;
  const shortage = staminaShort || magicShort;

  player.stamina = Math.max(0, beforeSt - staminaCost);
  player.magic = Math.max(0, beforeMp - magicCost);

  const adjusted = { ...card };
  if (shortage) {
    adjusted.attack = Math.round((adjusted.attack || 0) * 0.5);
    adjusted.defense = Math.round((adjusted.defense || 0) * 0.5);
  }

  return { card: adjusted, shortage, staminaShort, magicShort };
}

// ========================================
// 状態異常処理
// ========================================
function tickStatusEffects(room) {
  if (!room || !room.players) return { ticks: [] };
  const ticks = [];
  room.players.forEach(p => {
    if (!p.statusAilments) p.statusAilments = [];
    let dot = 0;
    p.statusAilments.forEach(a => {
      const effectType = (a.effectType || '').toLowerCase();
      const val = Number(a.value) || 0;
      if (effectType === 'dot' && val > 0) {
        dot += Math.max(0, Math.round(val));
      }
      a.turns = Math.max(0, (Number(a.turns) || 0) - 1);
    });
    if (dot > 0) {
      p.hp = Math.max(0, p.hp - dot);
    }
    p.statusAilments = p.statusAilments.filter(a => a.turns > 0);
    if (dot > 0) {
      ticks.push({ playerId: p.id, dot, remaining: p.statusAilments });
    }
  });
  return { ticks };
}

// ========================================
// ユーティリティ関数
// ========================================
function findPlayer(room, socketId) {
  return room.players ? room.players.find(p => p.id === socketId) : null;
}

function updateStatus(roomId, message) {
  io.to(roomId).emit('statusUpdate', { message });
}

function getOpponent(room, socketId) {
  return room.players.find(p => p.id !== socketId);
}

function applyStatus(sourceCard, targetPlayer, appliedList) {
  if (!sourceCard || !sourceCard.statusAilment || !targetPlayer) return { dot: 0 };
  if (!targetPlayer.statusAilments) targetPlayer.statusAilments = [];
  const list = Array.isArray(sourceCard.statusAilment) ? sourceCard.statusAilment : [sourceCard.statusAilment];
  let dot = 0;
  for (const sa of list) {
    if (!sa || !sa.name) continue;
    if (targetPlayer.statusAilments.length >= 3) break;
    const turns = Number(sa.turns) || 1;
    const value = Number(sa.value) || 0;
    const effectType = (sa.effectType || '').toLowerCase();
    targetPlayer.statusAilments.push({ name: sa.name, turns, effectType, value });
    appliedList.push({ targetId: targetPlayer.id, name: sa.name, turns, effectType, value });
    if (effectType === 'dot' && value > 0) {
      dot += Math.max(0, Math.round(value));
    }
  }
  return { dot };
}

// ========================================
// 防御ハンドラー
// ========================================
function handleDefend(roomId, socket, word) {
  const room = rooms.get(roomId);
  if (!room || !room.started || !room.pendingAttack) {
    socket.emit('errorMessage', { message: '防御できる状態ではありません' });
    return;
  }
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

  console.log('🛡️ 防御処理開始:', { roomId, defender: socket.id, word: cleanWord });

  const attacker = findPlayer(room, room.pendingAttack.attackerId);
  const defender = findPlayer(room, socket.id);
  if (!attacker || !defender) {
    console.log('⚠️ 防御エラー: プレイヤーが見つかりません');
    return;
  }

  const statusTick = tickStatusEffects(room);
  let preWinner = null;
  const maybeWinner = room.players.find(p => p.hp <= 0);
  if (maybeWinner) {
    const survivor = room.players.find(p => p.hp > 0);
    preWinner = survivor?.id || null;
  }
  if (preWinner) {
    const hp = {};
    const maxHpMap = {};
    room.players.forEach(p => {
      hp[p.id] = p.hp;
      maxHpMap[p.id] = p.maxHp || STARTING_HP;
    });
    io.to(roomId).emit('turnResolved', {
      attackerId: attacker.id,
      defenderId: defender.id,
      attackCard: room.pendingAttack.card,
      defenseCard: null,
      damage: 0,
      counterDamage: 0,
      dotDamage: statusTick.ticks.reduce((s, t) => s + (t.dot || 0), 0),
      affinity: null,
      hp,
      maxHp: maxHpMap,
      defenseFailed: false,
      appliedStatus: [],
      fieldEffect: room.fieldEffect,
      statusTick,
      nextTurn: null,
      winnerId: preWinner
    });
    updateStatus(roomId, `${room.players.find(p => p.id === preWinner)?.name || 'プレイヤー'} の勝利！`);
    room.pendingAttack = null;
    return;
  }

  const attackCard = room.pendingAttack.card;
  const atkResource = applyResourceCost(attacker, attackCard);
  
  generateCard(cleanWord, 'defense').then(defenseCard => {
    console.log('🛡️ 防御カード生成完了:', defenseCard);
    room.usedWordsGlobal.add(lower);
    defender.usedWords.add(lower);

    const defResource = applyResourceCost(defender, defenseCard);

    // 防御失敗ロジック: role が 'defense' でない場合は失敗
    let defenseFailed = false;
    const defRole = (defenseCard.role || '').toLowerCase();
    if (defRole !== 'defense') {
      defenseFailed = true;
    }

    const affinity = getAffinity(atkResource.card.attribute, defResource.card.attribute);
    let damage = calculateDamage(atkResource.card, defResource.card, attacker, defender, defenseFailed);
    const appliedStatus = [];
    let dotDamage = 0;

    const attackerMaxHp = attacker.maxHp || STARTING_HP;
    const defenderMaxHp = defender.maxHp || STARTING_HP;

    // Support役のサポート効果（攻撃側）
    if (atkResource.card.role === 'support') {
      const atkSupportType = (atkResource.card.supportType || '').toLowerCase();
      switch (atkSupportType) {
        case 'heal':
          attacker.hp = Math.min(attackerMaxHp, attacker.hp + 30);
          break;
        case 'weatherchange':
          if (atkResource.card.attribute) {
            room.fieldEffect = { 
              name: `${atkResource.card.attribute}の天候`, 
              attribute: atkResource.card.attribute,
              turns: 3,
              multiplier: 1.5
            };
          }
          break;
        case 'firebuff':
          attacker.attackBoost = (attacker.attackBoost || 0) + 30;
          room.fieldEffect = { name: '炎強化', attribute: 'fire', turns: 3, multiplier: 1.5 };
          break;
        case 'waterbuff':
          attacker.attackBoost = (attacker.attackBoost || 0) + 30;
          room.fieldEffect = { name: '水強化', attribute: 'water', turns: 3, multiplier: 1.5 };
          break;
        case 'staminarecover':
          attacker.stamina = Math.min(attacker.maxStamina || 100, attacker.stamina + 25);
          break;
        case 'magicrecover':
          attacker.magic = Math.min(attacker.maxMagic || 100, attacker.magic + 25);
          break;
        case 'debuff':
          defender.attackBoost = Math.max(-50, (defender.attackBoost || 0) - 20);
          break;
      }
      damage = 0;
    }

    // Support役のサポート効果（防御側）
    if (defResource.card.role === 'support' && !defenseFailed) {
      const defSupportType = (defResource.card.supportType || '').toLowerCase();
      switch (defSupportType) {
        case 'heal':
          defender.hp = Math.min(defenderMaxHp, defender.hp + 30);
          break;
        case 'weatherchange':
          if (defResource.card.attribute) {
            room.fieldEffect = { 
              name: `${defResource.card.attribute}の天候`, 
              attribute: defResource.card.attribute,
              turns: 3,
              multiplier: 1.5
            };
          }
          break;
        case 'debuff':
          attacker.attackBoost = Math.max(-50, (attacker.attackBoost || 0) - 20);
          break;
        case 'staminarecover':
          defender.stamina = Math.min(defender.maxStamina || 100, defender.stamina + 25);
          break;
        case 'magicrecover':
          defender.magic = Math.min(defender.maxMagic || 100, defender.magic + 25);
          break;
      }
    }

    defender.hp = Math.max(0, defender.hp - damage);

    const shortageWarnings = [];
    if (atkResource.shortage) {
      const reason = atkResource.staminaShort && atkResource.magicShort
        ? 'スタミナ・魔力不足！威力が低下'
        : atkResource.staminaShort
          ? 'スタミナ不足！威力が低下'
          : '魔力不足！威力が低下';
      shortageWarnings.push({ playerId: attacker.id, message: reason });
    }
    if (defResource.shortage) {
      const reason = defResource.staminaShort && defResource.magicShort
        ? 'スタミナ・魔力不足！防御力低下'
        : defResource.staminaShort
          ? 'スタミナ不足！防御力低下'
          : '魔力不足！防御力低下';
      shortageWarnings.push({ playerId: defender.id, message: reason });
    }

    let winnerId = null;
    if (defender.hp <= 0) {
      winnerId = attacker.id;
    } else if (attacker.hp <= 0) {
      winnerId = defender.id;
    }

    room.pendingAttack = null;

    const hp = {};
    const maxHpMap = {};
    const resources = {};
    room.players.forEach(p => {
      hp[p.id] = p.hp;
      maxHpMap[p.id] = p.maxHp || STARTING_HP;
      resources[p.id] = {
        stamina: p.stamina,
        magic: p.magic,
        maxStamina: p.maxStamina || 100,
        maxMagic: p.maxMagic || 100
      };
    });

    io.to(roomId).emit('turnResolved', {
      attackerId: attacker.id,
      defenderId: defender.id,
      attackCard: atkResource.card,
      defenseCard: defResource.card,
      damage,
      counterDamage: 0,
      dotDamage,
      appliedStatus,
      fieldEffect: room.fieldEffect,
      hp,
      maxHp: maxHpMap,
      resources,
      defenseFailed,
      affinity,
      shortageWarnings,
      nextTurn: !winnerId ? (attacker.id === room.currentTurn ? defender.id : attacker.id) : null,
      winnerId,
      statusTick
    });

    if (!winnerId) {
      room.currentTurn = attacker.id === room.currentTurn ? defender.id : attacker.id;
    }

  }).catch(error => {
    console.error('❌ カード生成エラー:', error);
    socket.emit('errorMessage', { message: 'カード生成に失敗しました' });
  });
}

// ========================================
// Socket.io イベントハンドラ
// ========================================
io.on('connection', (socket) => {
  console.log('👤 ユーザー接続:', socket.id);

  socket.on('join', (password) => {
    const passKey = (password || '').trim().toLowerCase();
    if (!passKey) {
      socket.emit('errorMessage', { message: 'パスワードを入力してください' });
      return;
    }

    if (!waitingPlayers.has(passKey)) {
      waitingPlayers.set(passKey, []);
    }
    const queue = waitingPlayers.get(passKey);

    const playerEntry = { socket, id: socket.id, name: 'Player' };
    queue.push(playerEntry);

    console.log(`⏳ プレイヤー ${socket.id} がマッチング待機: パスワード="${passKey}"`);

    if (queue.length === 1) {
      socket.emit('statusUpdate', { message: '相手を待機中...' });
      return;
    }

    // 2人目が来た場合、対戦開始
    const player1 = queue.shift();
    const player2 = queue.shift();

    const roomId = crypto.randomBytes(8).toString('hex');
    const room = {
      id: roomId,
      players: [
        {
          id: player1.socket.id,
          name: player1.name,
          hp: STARTING_HP,
          maxHp: STARTING_HP,
          stamina: 100,
          magic: 100,
          maxStamina: 100,
          maxMagic: 100,
          statusAilments: [],
          usedWords: new Set(),
          attackBoost: 0,
          defenseBoost: 0
        },
        {
          id: player2.socket.id,
          name: player2.name,
          hp: STARTING_HP,
          maxHp: STARTING_HP,
          stamina: 100,
          magic: 100,
          maxStamina: 100,
          maxMagic: 100,
          statusAilments: [],
          usedWords: new Set(),
          attackBoost: 0,
          defenseBoost: 0
        }
      ],
      started: true,
      currentTurn: player1.socket.id,
      pendingAttack: null,
      usedWordsGlobal: new Set(),
      fieldEffect: null
    };

    rooms.set(roomId, room);
    player1.socket.join(roomId);
    player2.socket.join(roomId);

    io.to(roomId).emit('battleStart', {
      roomId,
      players: room.players,
      currentTurn: room.currentTurn
    });

    console.log(`🎮 バトル開始: ${roomId} (${player1.socket.id} vs ${player2.socket.id})`);

    if (queue.length === 0) {
      waitingPlayers.delete(passKey);
    }
  });

  socket.on('attackWord', async ({ word }) => {
    const roomId = Array.from(socket.rooms).find(r => r !== socket.id);
    if (!roomId || !rooms.has(roomId)) {
      socket.emit('errorMessage', { message: 'ルームが見つかりません' });
      return;
    }

    const room = rooms.get(roomId);
    if (!room.started) {
      socket.emit('errorMessage', { message: 'バトルが開始していません' });
      return;
    }

    if (room.currentTurn !== socket.id) {
      socket.emit('errorMessage', { message: 'あなたのターンではありません' });
      return;
    }

    if (room.pendingAttack) {
      socket.emit('errorMessage', { message: 'まだ前のターンが終了していません' });
      return;
    }

    const cleanWord = (word || '').trim();
    if (!cleanWord) {
      socket.emit('errorMessage', { message: '攻撃の言葉を入力してください' });
      return;
    }

    const lower = cleanWord.toLowerCase();
    if (room.usedWordsGlobal.has(lower)) {
      socket.emit('errorMessage', { message: 'その言葉は既に使用されています' });
      return;
    }

    console.log('⚔️ 攻撃処理開始:', { roomId, attacker: socket.id, word: cleanWord });

    try {
      const attackCard = await generateCard(cleanWord, 'attack');
      room.usedWordsGlobal.add(lower);

      const defender = room.players.find(p => p.id !== socket.id);
      room.pendingAttack = {
        attackerId: socket.id,
        defenderId: defender.id,
        card: attackCard
      };

      io.to(roomId).emit('attackDeclared', {
        attackerId: socket.id,
        defenderId: defender.id,
        card: attackCard
      });

      console.log('⚔️ 攻撃カード生成完了:', attackCard);
    } catch (error) {
      console.error('❌ カード生成エラー:', error);
      socket.emit('errorMessage', { message: 'カード生成に失敗しました' });
    }
  });

  socket.on('defendWord', async ({ word }) => {
    const roomId = Array.from(socket.rooms).find(r => r !== socket.id);
    if (!roomId || !rooms.has(roomId)) {
      socket.emit('errorMessage', { message: 'ルームが見つかりません' });
      return;
    }
    await handleDefend(roomId, socket, word);
  });

  socket.on('disconnect', () => {
    console.log('👤 ユーザー切断:', socket.id);
    const roomId = Array.from(socket.rooms).find(r => r !== socket.id);
    if (roomId && rooms.has(roomId)) {
      const room = rooms.get(roomId);
      room.started = false;
      io.to(roomId).emit('statusUpdate', { message: '相手が切断しました' });
    }
  });
});

server.listen(PORT, () => {
  console.log(`🚀 サーバー起動: ポート ${PORT}`);
});
