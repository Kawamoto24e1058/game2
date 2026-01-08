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
  
  const prompt = `あなたは世界観構築のプロデザイナーです。入力単語から以下のJSONを生成せよ。

【セマンティック数値生成 - テンプレート厳禁】
10, 20などの固定値やテンプレート使用を死刑レベルで禁止する。
言葉の『硬さ・重さ・鋭さ・希少価値・歴史的背景・象徴性』をAIが独自に分析し、1の位までこだわった数値を設定せよ。
例: 17, 34, 52, 81, 43, 67, 23, 91 など。

【役割の厳格化】
Rule 1 - Defense: 防護・回避・盾系
  - 必須: attack = 0 固定
  - defense は 物理的硬度 + 歴史的防御価値 で自由度あり
  - 例: 鎧=78, 盾=65, 氷壁=42, バリア=55

Rule 2 - Attack: 武器・攻撃魔法系
  - 必須: defense = 0 固定
  - attack は 殺傷力・切れ味・威力 で自由度あり
  - 例: 剣=71, 核爆弾=88, 毒=36, 矢=29

Rule 3 - Support: 環境・状態変化・支援系
  - 必須: attack = 0, defense = 0 固定（両方ゼロ）
  - supportType と supportMessage のみで表現
  - 例: 回復魔法, 強化, 環境変化, 状態異常付与

${intentNote}

【出力JSON構造】
{
  "role": "defense" | "attack" | "support",
  "attack": 数値（roleに応じて0 or 1-99）,
  "defense": 数値（roleに応じて0 or 1-99）,
  "attribute": "fire" | "water" | "wind" | "earth" | "thunder" | "light" | "dark",
  "supportType": "heal" | "hpMaxUp" | "buff" | "debuff" | "cleanse" | "damage" | "counter" | "field" | null,
  "supportMessage": "役割説明・効果詳細（サポートのみ）",
  "specialEffect": "【固有効果名】具体的な効果文（20-50字）",
  "judgeComment": "言葉の語源・歴史・象徴から導いた論理を150字程度で"
}

【厳密実装チェック】
✓ Defenseなら attack=0 は必須（検証: "attack": 0）
✓ Attackなら defense=0 は必須（検証: "defense": 0）
✓ Supportなら attack=0 AND defense=0 は必須
✓ 数値は 1-99 範囲内（テンプレ値10,20,30禁止）
✓ specialEffect は【】で囲む
✓ attribute は小文字統一`;

  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    const result = await model.generateContent(prompt);
    let responseText = result.response.text().trim();
    
    // JSONマークダウン装飾を削除
    responseText = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    
    const cardData = JSON.parse(responseText);

    // 必須フィールドのチェック
    if (cardData.attack === undefined || cardData.defense === undefined || !cardData.specialEffect) {
      throw new Error('必須フィールドが不足しています');
    }

    const role = (cardData.role || 'attack').toLowerCase();
    let attack = Math.max(0, Math.min(99, Math.round(cardData.attack || 0)));
    let defense = Math.max(0, Math.min(99, Math.round(cardData.defense || 0)));
    
    // 役割による厳格チェック
    if (role === 'defense') {
      attack = 0;  // Defense は必ず attack = 0
    } else if (role === 'attack') {
      defense = 0;  // Attack は必ず defense = 0
    } else if (role === 'support') {
      attack = 0;  // Support は両方ゼロ
      defense = 0;
    }
    
    const supportType = cardData.supportType || null;
    const supportMessage = cardData.supportMessage || '';
    const attribute = (cardData.attribute || 'earth').toLowerCase();
    const specialEffect = cardData.specialEffect || '【基本効果】標準的な効果';
    const judgeComment = cardData.judgeComment || '判定コメントなし';

    return {
      word: original,
      attribute,
      attack,
      defense,
      effect: role,
      tier: attack >= 70 || defense >= 70 ? 'mythical' : attack >= 40 || defense >= 40 ? 'weapon' : 'common',
      supportType,
      supportMessage,
      specialEffect,
      judgeComment,
      role,
      description: `${attribute.toUpperCase()} [${role.toUpperCase()}] ATK:${attack} DEF:${defense} / ${specialEffect}`
    };
  } catch (error) {
    console.error('❌ Gemini API エラー:', error);
    return generateCardFallback(original);
  }
}
function generateCardFallback(word) {
  const lower = word.toLowerCase();
  let strength = 37;  // テンプレート禁止：37（素数）
  let tier = 'common';
  
  if (/dragon|神|excalibur|phoenix/i.test(lower)) {
    strength = 89;  // テンプレート禁止：89
    tier = 'mythical';
  } else if (/katana|sword|wizard|thunder|fire/i.test(lower)) {
    strength = 63;  // 63
    tier = 'weapon';
  }
  
  if (/ため息|whisper|gentle/i.test(lower)) strength = Math.min(14, strength * 0.3);
  
  const defVal = Math.round(strength * 0.65);  // テンプレート値回避
  let role = 'attack';
  
  // 属性判定
  let attribute = 'earth';
  if (/fire|炎|爆|熱|マグマ|焼/.test(lower)) attribute = 'fire';
  else if (/water|水|海|氷|雨|波/.test(lower)) attribute = 'water';
  else if (/wind|風|竜巻|嵐|翼/.test(lower)) attribute = 'wind';
  else if (/thunder|雷|電|lightning|プラズマ/.test(lower)) attribute = 'thunder';
  else if (/light|光|聖|天使|神/.test(lower)) attribute = 'light';
  else if (/dark|闇|死|呪|影/.test(lower)) attribute = 'dark';
  
  // 役割判定（新ルール：Defense/Attack/Support）
  if (/盾|shield|防|鎧|バリア|壁|shield/.test(lower)) {
    role = 'defense';
  } else if (/毒|poison|回復|heal|support|サポート|環境|field/.test(lower)) {
    role = 'support';
  }
  
  // 役割に基づいて数値を厳格化
  let attack = strength;
  let defense = defVal;
  
  if (role === 'defense') {
    attack = 0;  // Defense は attack = 0
  } else if (role === 'support') {
    attack = 0;  // Support は両方 0
    defense = 0;
  }
  
  // 特殊効果判定
  let specialEffect = '【標準効果】基本的な性質';
  if (/サボテン|cactus/.test(lower)) specialEffect = '【トゲ反射】受けたダメージの18%を反射';
  else if (/毒|poison|ヘビ|蛇/.test(lower)) specialEffect = '【猛毒】3ターン継続、毎ターンHP-3';
  else if (/氷|ice|凍/.test(lower)) specialEffect = '【凍結】相手次ターン行動不能（確率22%）';
  else if (/盾|shield|防/.test(lower)) specialEffect = '【堅牢】被ダメージ-17%';
  
  return {
    word,
    attribute,
    attack,
    defense,
    effect: role,
    role,
    tier,
    supportType: role === 'support' ? 'cleanse' : null,
    supportMessage: role === 'support' ? '環境の状態を改善する' : '',
    specialEffect,
    judgeComment: 'フォールバック推定。言葉の物理的特性から簡易判定。',
    description: `${attribute.toUpperCase()} [${role.toUpperCase()}] ATK:${attack} DEF:${defense}`
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
      maxHp: STARTING_HP,
      usedWords: new Set(),
      isHost: idx === 0,
      supportUsed: 0,
      attackBoost: 0,
      defenseBoost: 0,
      statusAilments: []
    })),
    hostId: players[0].socket.id,
    started: false,
    turnIndex: 0,
    phase: 'waiting',
    pendingAttack: null,
    usedWordsGlobal: new Set(),
    fieldEffect: null
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
  room.players.forEach(p => { p.maxHp = STARTING_HP; p.hp = p.maxHp; p.statusAilments = []; });
  room.fieldEffect = null;

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

// 毎ターンの状態異常処理（ターン減少とDoT適用）
function tickStatusEffects(room) {
  if (!room || !room.players) return [];
  const ticks = [];
  room.players.forEach(p => {
    if (!p.statusAilments) p.statusAilments = [];
    const results = [];
    let dot = 0;
    
    p.statusAilments.forEach(a => {
      const effectType = (a.effectType || '').toLowerCase();
      const val = Number(a.value) || 0;
      
      // DoT ダメージを記録
      if (effectType === 'dot' && val > 0) {
        const dmg = Math.max(0, Math.round(val));
        dot += dmg;
        results.push({
          type: 'dot',
          ailmentName: a.name,
          value: dmg
        });
      }
      
      // ターン数を減少
      a.turns = Math.max(0, (Number(a.turns) || 0) - 1);
    });
    
    // DoT ダメージを適用
    if (dot > 0) {
      p.hp = Math.max(0, p.hp - dot);
    }
    
    // 消滅した状態異常を記録
    const before = [...p.statusAilments];
    p.statusAilments = p.statusAilments.filter(a => a.turns > 0);
    
    before.forEach(a => {
      if (a.turns <= 0 && p.statusAilments.find(x => x.name === a.name) === undefined) {
        results.push({
          type: 'expired',
          ailmentName: a.name
        });
      }
    });
    
    if (results.length > 0) {
      ticks.push({ playerId: p.id, results });
    }
  });
  return ticks;
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

  // ターン開始時の状態異常処理（DoT適用とターン減少）
  const statusTick = tickStatusEffects(room);
  let preWinner = null;
  const maybeWinner = room.players.find(p => p.hp <= 0);
  if (maybeWinner) {
    const survivor = room.players.find(p => p.hp > 0);
    preWinner = survivor?.id || null;
  }
  if (preWinner) {
    const hp = {};
    room.players.forEach(p => { hp[p.id] = p.hp; });
    io.to(roomId).emit('turnResolved', {
      attackerId: attacker.id,
      defenderId: defender.id,
      attackCard: room.pendingAttack.card,
      defenseCard: null,
      damage: 0,
      counterDamage: 0,
      dotDamage: 0,
      affinity: null,
      hp,
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
  const applyStatus = (sourceCard, targetPlayer, appliedList) => {
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
      targetPlayer.statusAilments.push({
        name: sa.name,
        turns,
        effectType,
        value
      });
      appliedList.push({ targetId: targetPlayer.id, name: sa.name, turns, effectType, value });
      if (effectType === 'dot' && value > 0) {
        dot += Math.max(0, Math.round(value));
      }
    }
    return { dot };
  };
  
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
    let damage = calculateDamage(attackCard, defenseCard, attacker, defender, defenseFailed);
    const appliedStatus = [];
    let dotDamage = 0;

    // カウンターダメージ処理（トゲ系）
    let counterDamage = 0;
    if (defenseCard.counterDamage && !defenseFailed) {
      counterDamage = defenseCard.counterDamage;
      attacker.hp = Math.max(0, attacker.hp - counterDamage);
      console.log(`🌵 カウンターダメージ発動: ${defenseCard.counterDamage}ダメージを攻撃者に与えた`);
    }

    const attackerMaxHp = attacker.maxHp || STARTING_HP;
    const defenderMaxHp = defender.maxHp || STARTING_HP;

    if (attackCard.effect === 'heal') {
      attacker.hp = Math.min(attackerMaxHp, attacker.hp + Math.round(attackCard.attack * 0.6));
      damage = 0;
    }
    if (defenseCard.effect === 'heal' && !defenseFailed) {
      defender.hp = Math.min(defenderMaxHp, defender.hp + Math.round(defenseCard.defense * 0.5));
    }

    defender.hp = Math.max(0, defender.hp - damage);

    // 状態異常付与と即時DoT適用
    const res1 = applyStatus(attackCard, defender, appliedStatus); dotDamage += res1.dot;
    const res2 = applyStatus(defenseCard, attacker, appliedStatus); dotDamage += res2.dot;
    if (dotDamage > 0) {
      defender.hp = Math.max(0, defender.hp - res1.dot);
      attacker.hp = Math.max(0, attacker.hp - res2.dot);
    }

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

    const players = room.players.map(p => ({
      id: p.id,
      name: p.name,
      hp: p.hp,
      maxHp: p.maxHp || STARTING_HP,
      statusAilments: p.statusAilments || []
    }));

    // ターン開始時の状態異常処理
    const statusTick = tickStatusEffects(room);

    io.to(roomId).emit('turnResolved', {
      attackerId: attacker.id,
      defenderId: defender.id,
      attackCard,
      defenseCard,
      damage,
      counterDamage,
      dotDamage,
      affinity,
      hp,
      players,
      defenseFailed,
      appliedStatus,
      statusTick,
      fieldEffect: room.fieldEffect,
      nextTurn: winnerId ? null : room.players[room.turnIndex].id,
      winnerId
    });

    console.log('✅ ターン解決完了:', { damage, counterDamage, dotDamage, winnerId, nextTurn: room.players[room.turnIndex].id, appliedStatus });

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
          maxHp: STARTING_HP,
          usedWords: new Set(),
          isHost: false,
          supportUsed: 0,
          attackBoost: 0,
          defenseBoost: 0,
          statusAilments: []
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

    // ターン開始時の状態異常処理
    const statusTick = tickStatusEffects(room);
    const tickWinner = room.players.find(p => p.hp <= 0);
    if (tickWinner) {
      const survivor = room.players.find(p => p.hp > 0);
      const hpTick = {}; room.players.forEach(p => { hpTick[p.id] = p.hp; });
      io.to(roomId).emit('supportUsed', {
        playerId: player.id,
        card: null,
        hp: hpTick,
        supportRemaining: 3 - player.supportUsed,
        winnerId: survivor?.id || null,
        nextTurn: null,
        appliedStatus: [],
        fieldEffect: room.fieldEffect,
        statusTick
      });
      updateStatus(roomId, `${room.players.find(p => p.id === (survivor?.id || tickWinner.id))?.name || 'プレイヤー'} の勝利！`);
      return;
    }

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

      const effectTypeRaw = (card.effectType || card.supportType || card.supportEffect || '').toLowerCase();
      const effectValNum = Number(card.effectValue);
      const effectValue = Number.isFinite(effectValNum) ? effectValNum : null;
      const maxHp = player.maxHp || STARTING_HP;
      const opponent = getOpponent(room, socket.id);
      const appliedStatus = [];

      const applyStatus = (sourceCard, targetPlayer) => {
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
          appliedStatus.push({ targetId: targetPlayer.id, name: sa.name, turns, effectType, value });
          if (effectType === 'dot' && value > 0) {
            dot += Math.max(0, Math.round(value));
          }
        }
        return { dot };
      };

      switch (effectTypeRaw) {
        case 'hpmaxup': {
          const gain = effectValue && effectValue > 0 ? effectValue : 20;
          player.maxHp = (player.maxHp || STARTING_HP) + gain;
          player.hp = player.hp + gain;
          break;
        }
        case 'heal': {
          const heal = effectValue && effectValue > 0 ? effectValue : 25;
          player.hp = Math.min(maxHp, player.hp + heal);
          break;
        }
        case 'buff':
        case 'attack_boost': {
          player.attackBoost = effectValue && effectValue > 0 ? effectValue : 50;
          break;
        }
        case 'defense_boost': {
          player.defenseBoost = effectValue && effectValue > 0 ? effectValue : 40;
          break;
        }
        case 'debuff':
        case 'enemy_debuff': {
          if (opponent) {
            const dmg = effectValue && effectValue > 0 ? effectValue : 15;
            opponent.hp = Math.max(0, opponent.hp - dmg);
          }
          break;
        }
        case 'damage': {
          if (opponent) {
            const dmg = effectValue && effectValue > 0 ? effectValue : 20;
            opponent.hp = Math.max(0, opponent.hp - dmg);
          }
          break;
        }
        case 'cleanse': {
          player.statusAilments = [];
          break;
        }
        default: {
          // 旧サポート種別との後方互換
          if (card.supportType === 'heal_boost') {
            player.hp = Math.min(maxHp, player.hp + 30);
          } else if (card.supportType === 'attack_boost') {
            player.attackBoost = 50;
          } else if (card.supportType === 'defense_boost') {
            player.defenseBoost = 40;
          } else if (card.supportType === 'enemy_debuff') {
            if (opponent) opponent.hp = Math.max(0, opponent.hp - 15);
          } else {
            player.hp = Math.min(maxHp, player.hp + 20);
          }
        }
      }

      // サポート由来の状態異常付与（例えば毒フィールドなど）
      if (opponent) {
        const res = applyStatus(card, opponent);
        if (res.dot > 0) opponent.hp = Math.max(0, opponent.hp - res.dot);
      }

      // フィールド効果更新
      if (card.fieldEffect && card.fieldEffect.name) {
        room.fieldEffect = card.fieldEffect;
        io.to(roomId).emit('fieldEffectUpdate', { fieldEffect: room.fieldEffect });
      }

      const hp = {};
      room.players.forEach(p => { hp[p.id] = p.hp; });

      const players = room.players.map(p => ({
        id: p.id,
        name: p.name,
        hp: p.hp,
        maxHp: p.maxHp || STARTING_HP,
        statusAilments: p.statusAilments || []
      }));

      let winnerId = null;
      if (room.players.some(p => p.hp <= 0)) {
        const defeated = room.players.find(p => p.hp <= 0);
        const survivor = room.players.find(p => p.hp > 0);
        winnerId = survivor?.id || null;
      }

      if (!winnerId) {
        room.turnIndex = (room.turnIndex + 1) % room.players.length;
      }

      io.to(roomId).emit('supportUsed', {
        playerId: player.id,
        card,
        hp,
        players,
        supportRemaining: 3 - player.supportUsed,
        winnerId,
        nextTurn: winnerId ? null : room.players[room.turnIndex].id,
        appliedStatus,
        fieldEffect: room.fieldEffect,
        statusTick
      });

      if (winnerId) {
        const winnerName = room.players.find(p => p.id === winnerId)?.name || 'プレイヤー';
        updateStatus(roomId, `${winnerName} の勝利！`);
      } else {
        updateStatus(roomId, `${room.players[room.turnIndex].name} のターンです`);
      }
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
