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

const waitingPlayersByPass = new Map(); // key -> [{ socket, name, password }]
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
    // 防御失敗: 相性倍率を外した基礎攻撃力をそのまま使用（相性は攻撃ダメージには含めない）
    let baseAttack = attackCard.attack;
    if (attacker.attackBoost > 0) {
      baseAttack = Math.round(baseAttack * (1 + attacker.attackBoost / 100));
      attacker.attackBoost = 0;
    }
    damage = baseAttack; // 防御失敗時は基礎ダメージのみ
    
    // 回避判定：defenseCard.evasion に基づく（値が大きいほど回避確率が高い）
    const maxEvasion = 50; // 最大50%まで回避可能
    const evasionChance = Math.min(maxEvasion, (defenseCard.evasion || 0)) / 100;
    if (Math.random() < evasionChance) {
      damage = 0; // 回避成功時は完全に回避（0ダメージ）
    }
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
  
  const prompt = `あなたは歴史や経済に精通したゲームマスターです。以下のルールでJSONを生成せよ：

${intentNote}

【数値の不規則化】
10の倍数（10, 20, 30...）や5の倍数の使用を厳禁とする。必ず 13, 27, 41, 58 のような中途半端で具体的な数値を、言葉の材質・希少性・歴史的価値から算出せよ。

【役割の絶対化】
1. Attack: defense は必ず 0。攻撃・破壊・加害を主目的とする語のみ。
2. Defense: attack は必ず 0。盾や『風のドーム』『水の壁』等の守護概念は100%これに分類せよ。
3. Support: attack と defense は必ず 0。回復だけでなく『日本晴れ(炎バフ)』『砂嵐(継続ダメ)』『インフレ(コスト増)』等の概念を生成せよ。

【サポート効果の具体化】
- supportType: "weather"（天候系）/ "buff"（強化） / "debuff"（弱体） / "heal"（回復） / "field"（フィールド） / "cost"（コスト変動）から選択
- supportMessage: 「〇〇が△△した結果、□□が★★に変わった」という具体的な因果関係を説明
- 例：「日本晴れが降り注ぎ、火属性攻撃が30%上昇し、水属性が50%低下した」

【数値生成の原則】
- 物質の密度・希少性・歴史的記録から数値を逆算する
- 例：ダイアモンド→レアリティ極高→attack 89, steel→一般的→attack 34, wind→自由→attack 41
- 常識外の組み合わせを避け、言葉の本質を数値化する

【JSON構造（必須）】
{
  "role": "Attack" | "Defense" | "Support",
  "attack": 数値（roleで0固定される場合がある）,
  "defense": 数値（roleで0固定される場合がある）,
  "attribute": "fire/water/wind/earth/thunder/light/dark",
  "supportType": "weather/buff/debuff/heal/field/cost/damage/其の他",
  "supportMessage": "何が起きたか、どう変化したか（Support時のみ必須）",
  "specialEffect": "【効果名】詳細説明",
  "staminaCost": 数値,
  "magicCost": 数値,
  "judgeComment": "言葉の本質と数値化の根拠を100文字以上で説明"
}

単語: ${original}
`;

  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash-latest' });
    const result = await model.generateContent(prompt);
    let responseText = result.response.text().trim();
    
    // JSONマークダウン装飾を削除
    responseText = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    
    const cardData = JSON.parse(responseText);

    // 必須フィールドのチェック（新形式に対応）
    if (cardData.attack === undefined || cardData.defense === undefined || !cardData.specialEffect || !cardData.judgeComment) {
      throw new Error('必須フィールドが不足しています');
    }

    let attackVal = Math.max(0, Math.min(100, Math.round(cardData.attack)));
    let defenseVal = Math.max(0, Math.min(100, Math.round(cardData.defense)));

    // role の正規化（Attack/Defense/Support → attack/defense/support）
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
    
    const supportType = cardData.supportType || cardData.supportEffect || null;
    const effectType = cardData.effectType || supportType || null;
    const effectValue = cardData.effectValue !== undefined ? Number(cardData.effectValue) : null;
    const staminaCost = cardData.staminaCost !== undefined ? Number(cardData.staminaCost) : 0;
    const magicCost = cardData.magicCost !== undefined ? Number(cardData.magicCost) : 0;
    const attackType = cardData.attackType || (role === 'attack' ? 'physical' : 'other');
    const attribute = cardData.attribute || 'earth';
    const specialEffect = (cardData.specialEffect && 
                           cardData.specialEffect !== 'none' && 
                           cardData.specialEffect.trim() !== '' &&
                           cardData.specialEffect !== 'なし' &&
                           cardData.specialEffect !== '特になし') 
                           ? cardData.specialEffect 
                           : '【基本効果】標準的な効果';
    
    // Support 時は supportMessage を優先して使用
    const supportMessage = (cardData.supportMessage && cardData.supportMessage.trim() !== '') 
                           ? cardData.supportMessage 
                           : (cardData.supportDetail && cardData.supportDetail.trim() !== '') 
                             ? cardData.supportDetail 
                             : '';
    
    const hasReflect = cardData.hasReflect === true || /反射/.test(specialEffect) || /cactus|サボテン/.test(original);
    const counterDamage = cardData.counterDamage !== undefined
      ? Number(cardData.counterDamage)
      : (effectType && effectType.toLowerCase() === 'counter' ? Number(effectValue || 0) : 0);
    const hasCounter = cardData.hasCounter === true || counterDamage > 0;
    const fieldEffect = cardData.fieldEffect && cardData.fieldEffect.name ? cardData.fieldEffect : null;
    const statusAilment = Array.isArray(cardData.statusAilment) ? cardData.statusAilment : (cardData.statusAilment ? [cardData.statusAilment] : []);
    const tier = cardData.tier || (attackVal >= 80 ? 'mythical' : attackVal >= 50 ? 'weapon' : 'common');

    return {
      word: original,
      attribute,
      attack: attackVal,
      defense: defenseVal,
      role,
      effect: role,
      tier,
      supportType,
      effectType,
      effectValue,
      fieldEffect,
      statusAilment,
      supportMessage,
      supportDetail: supportMessage,  // supportMessage と同期
      specialEffect,
      hasReflect,
      hasCounter,
      counterDamage,
      attackType,
      staminaCost,
      magicCost,
      evasion: cardData.evasion || 0,
      judgeComment: cardData.judgeComment || '審判のコメント',
      description: `${attribute.toUpperCase()} [${tier.toUpperCase()}] / ATK:${attackVal} DEF:${defenseVal} / ${role}${effectType ? ' (' + effectType + ')' : ''} / ${specialEffect}${hasReflect ? ' / hasReflect' : ''}${hasCounter ? ` / counter:${counterDamage}` : ''}`
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
    role: 'attack',
    effect: 'attack',
    tier,
    supportType: null,
    attackType: 'physical',
    staminaCost: 10,
    magicCost: 0,
    evasion: 0,  // フォールバックは回避なし
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
      maxHp: STARTING_HP,
      stamina: 100,
      maxStamina: 100,
      magic: 100,
      maxMagic: 100,
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
  room.players.forEach(p => {
    p.maxHp = STARTING_HP;
    p.hp = p.maxHp;
    p.statusAilments = [];
    p.maxStamina = p.maxStamina || 100;
    p.maxMagic = p.maxMagic || 100;
    p.stamina = p.maxStamina;
    p.magic = p.maxMagic;
  });
  room.fieldEffect = null;

  const resources = {};
  room.players.forEach(p => {
    resources[p.id] = { stamina: p.stamina, magic: p.magic, maxStamina: p.maxStamina, maxMagic: p.maxMagic };
  });

  io.to(roomId).emit('battleStarted', {
    roomId,
    players: room.players.map(p => ({ id: p.id, name: p.name, hp: p.hp, maxHp: p.maxHp })),
    turn: room.players[room.turnIndex].id,
    resources
  });
  updateStatus(roomId, `バトル開始！先攻: ${room.players[room.turnIndex].name}`);
}

function updateStatus(roomId, message) {
  io.to(roomId).emit('status', { message });
}

function getOpponent(room, socketId) {
  return room.players.find(p => p.id !== socketId);
}

function getWaitingQueue(passwordKey) {
  const key = passwordKey || '__RANDOM__';
  if (!waitingPlayersByPass.has(key)) waitingPlayersByPass.set(key, []);
  return waitingPlayersByPass.get(key);
}

function applyResourceCost(player, card) {
  if (!player) return { card, shortage: false };
  if (typeof player.maxStamina !== 'number') player.maxStamina = 100;
  if (typeof player.maxMagic !== 'number') player.maxMagic = 100;
  if (typeof player.stamina !== 'number') player.stamina = player.maxStamina;
  if (typeof player.magic !== 'number') player.magic = player.maxMagic;

  const staminaCost = Number(card.staminaCost) || 0;
  const magicCost = Number(card.magicCost) || 0;
  const beforeStamina = player.stamina;
  const beforeMagic = player.magic;
  const staminaShort = beforeStamina < staminaCost;
  const magicShort = beforeMagic < magicCost;
  const shortage = staminaShort || magicShort;

  player.stamina = Math.max(0, beforeStamina - staminaCost);
  player.magic = Math.max(0, beforeMagic - magicCost);

  const adjusted = { ...card };
  if (shortage) {
    adjusted.attack = Math.round((adjusted.attack || 0) * 0.5);
    adjusted.defense = Math.round((adjusted.defense || 0) * 0.5);
  }
  return {
    card: adjusted,
    shortage,
    staminaShort,
    magicShort,
    staminaCost,
    magicCost,
    beforeStamina,
    beforeMagic,
    afterStamina: player.stamina,
    afterMagic: player.magic
  };
}

function regenResources(room) {
  if (!room || !room.players) return;
  room.players.forEach(p => {
    const maxSt = p.maxStamina || 100;
    const maxMp = p.maxMagic || 100;
    p.stamina = Math.min(maxSt, (typeof p.stamina === 'number' ? p.stamina : maxSt) + 5);
    p.magic = Math.min(maxMp, (typeof p.magic === 'number' ? p.magic : maxMp) + 5);
  });
}

// 毎ターンの状態異常処理（ターン減少とDoT適用）
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
    const before = p.statusAilments.length;
    p.statusAilments = p.statusAilments.filter(a => a.turns > 0);
    if (dot > 0 || before !== p.statusAilments.length) {
      ticks.push({ playerId: p.id, dot, remaining: p.statusAilments });
    }
  });
  return { ticks };
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

    const defResource = applyResourceCost(defender, defenseCard);

    // 防御失敗ロジック：防御フェーズで Defense 以外のロールは失敗扱い
    let defenseFailed = false;
    const defRole = (defenseCard.role || defenseCard.effect || '').toLowerCase();
    if (defRole !== 'defense') {
      defenseFailed = true;
    }

    // ダメージ計算（属性相性2.0倍対応）
    const affinity = getAffinity(atkResource.card.attribute, defResource.card.attribute);
    let damage = calculateDamage(atkResource.card, defResource.card, attacker, defender, defenseFailed);
    const appliedStatus = [];
    let dotDamage = 0;

    // カウンターダメージ処理（トゲ系）
    let counterDamage = 0;
    if (defResource.card.counterDamage && !defenseFailed) {
      counterDamage = defResource.card.counterDamage;
      attacker.hp = Math.max(0, attacker.hp - counterDamage);
      console.log(`🌵 カウンターダメージ発動: ${defResource.card.counterDamage}ダメージを攻撃者に与えた`);
    }

    const attackerMaxHp = attacker.maxHp || STARTING_HP;
    const defenderMaxHp = defender.maxHp || STARTING_HP;

    if (atkResource.card.effect === 'heal') {
      attacker.hp = Math.min(attackerMaxHp, attacker.hp + Math.round(atkResource.card.attack * 0.6));
      damage = 0;
    }
    if (defResource.card.effect === 'heal' && !defenseFailed) {
      defender.hp = Math.min(defenderMaxHp, defender.hp + Math.round(defResource.card.defense * 0.5));
    }

    defender.hp = Math.max(0, defender.hp - damage);

    // 状態異常付与と即時DoT適用
    const res1 = applyStatus(atkResource.card, defender, appliedStatus); dotDamage += res1.dot;
    const res2 = applyStatus(defResource.card, attacker, appliedStatus); dotDamage += res2.dot;
    if (dotDamage > 0) {
      defender.hp = Math.max(0, defender.hp - res1.dot);
      attacker.hp = Math.max(0, attacker.hp - res2.dot);
    }

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
    room.turnIndex = (room.turnIndex + 1) % room.players.length;

    const hp = {};
    const maxHpMap = {};
    room.players.forEach(p => {
      hp[p.id] = p.hp;
      maxHpMap[p.id] = p.maxHp || STARTING_HP;
    });

    regenResources(room);

    const resources = {};
    room.players.forEach(p => {
      resources[p.id] = { stamina: p.stamina, magic: p.magic, maxStamina: p.maxStamina, maxMagic: p.maxMagic };
    });

    io.to(roomId).emit('turnResolved', {
      attackerId: attacker.id,
      defenderId: defender.id,
      attackCard: atkResource.card,
      defenseCard: defResource.card,
      damage,
      counterDamage,
      dotDamage,
      affinity,
      hp,
      maxHp: maxHpMap,
      defenseFailed,
      appliedStatus,
      statusTick,
      fieldEffect: room.fieldEffect,
      resources,
      shortageWarnings,
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
  let removed = false;
  waitingPlayersByPass.forEach((queue, key) => {
    const idx = queue.findIndex(p => p.socket.id === socketId);
    if (idx >= 0) {
      const player = queue.splice(idx, 1)[0];
      removed = true;
      console.log(`✅ プレイヤー ${player.name} (${socketId}) を待機リスト(${key})から削除しました`);
    }
    if (queue.length === 0) {
      waitingPlayersByPass.delete(key);
    }
  });

  for (const [roomId, room] of rooms) {
    if (room && room.players.some(p => p.id === socketId) && !room.started) {
      room.players = room.players.filter(p => p.id !== socketId);
      if (room.hostId === socketId) {
        room.hostId = room.players[0]?.id || null;
      }
      broadcastWaiting(roomId);
      if (room.players.length === 0) {
        rooms.delete(roomId);
      }
    }
  }

  if (removed) {
    broadcastWaitingQueues();
  }
}

function handleDisconnect(socket) {
  removeFromWaiting(socket.id);
  socket.data.matchPassword = null;
  const roomId = socket.data.roomId;
  if (!roomId) return;
  const room = rooms.get(roomId);
  if (!room) return;

  room.players = room.players.filter(p => p.id !== socket.id);

  if (!room.started) {
    broadcastWaiting(roomId);
    if (room.players.length === 0) {
      rooms.delete(roomId);
    }
    return;
  }

  const remaining = room.players[0];
  if (remaining) {
    io.to(roomId).emit('opponentLeft', { winnerId: remaining.id, message: `${remaining.name} の勝利 (相手離脱)` });
  }
  rooms.delete(roomId);
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
  socket.data.matchPassword = null;
  
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

function broadcastWaitingQueue(key) {
  const queue = waitingPlayersByPass.get(key);
  if (!queue) return;
  const password = key === '__RANDOM__' ? null : key;
  const payload = {
    players: queue.map(p => ({ id: p.socket.id, name: p.name })),
    canStart: false,
    hostId: null,
    password
  };
  queue.forEach(p => p.socket.emit('waitingUpdate', payload));
}

function broadcastWaitingQueues() {
  waitingPlayersByPass.forEach((_, key) => broadcastWaitingQueue(key));
}

io.on('connection', (socket) => {
  socket.on('startMatching', ({ name, mode, password }) => {
    const playerName = (name || '').trim();
    if (!playerName) {
      socket.emit('errorMessage', { message: 'プレイヤー名を入力してください' });
      return;
    }

    const isPasswordMode = mode === 'password';
    const passwordKey = isPasswordMode ? (password || '').trim() : '__RANDOM__';
    if (isPasswordMode && !passwordKey) {
      socket.emit('errorMessage', { message: 'パスワードを入力してください' });
      return;
    }

    const playerEntry = { socket, name: playerName, password: passwordKey };

    // 二重登録防止（既に待機中の場合は削除）
    console.log(`🔄 ${playerName} (${socket.id}) がマッチング開始`);
    removeFromWaiting(socket.id);

    // 以前のルーム所属をクリア
    if (socket.data.roomId) {
      socket.leave(socket.data.roomId);
      socket.data.roomId = null;
    }

    socket.data.matchPassword = passwordKey;

    const queue = getWaitingQueue(passwordKey);
    if (queue.length > 0) {
      const opponent = queue.shift();
      socket.data.matchPassword = null;
      opponent.socket.data.matchPassword = null;
      createRoom([opponent, playerEntry], isPasswordMode ? 'password' : 'random', isPasswordMode ? passwordKey : null);
      broadcastWaitingQueue(passwordKey);
    } else {
      queue.push(playerEntry);
      broadcastWaitingQueue(passwordKey);
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
      const hpTick = {}; const resourcesTick = {}; const maxHpTick = {};
      room.players.forEach(p => {
        hpTick[p.id] = p.hp;
        resourcesTick[p.id] = { stamina: p.stamina, magic: p.magic, maxStamina: p.maxStamina, maxMagic: p.maxMagic };
        maxHpTick[p.id] = p.maxHp || STARTING_HP;
      });
      io.to(roomId).emit('supportUsed', {
        playerId: player.id,
        card: null,
        hp: hpTick,
        maxHp: maxHpTick,
        supportRemaining: 3 - player.supportUsed,
        winnerId: survivor?.id || null,
        nextTurn: null,
        appliedStatus: [],
        fieldEffect: room.fieldEffect,
        statusTick,
        resources: resourcesTick,
        shortageWarnings: []
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

      const resCost = applyResourceCost(player, card);
      const effectiveCard = resCost.card;

      const cardRole = (effectiveCard.role || effectiveCard.effect || '').toLowerCase();
      const supportDetail = (effectiveCard.supportDetail || card.supportDetail || '').trim();
      const roleIsSupport = cardRole === 'support';
      if (cardRole && !roleIsSupport) {
        console.log('⚠️ Supportロール不一致', { word: cleanWord, role: cardRole });
      }

      const detailParts = supportDetail ? [supportDetail] : [];

      const effectTypeRaw = (effectiveCard.effectType || effectiveCard.supportType || effectiveCard.supportEffect || '').toLowerCase();
      const effectValNum = Number(effectiveCard.effectValue);
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
          detailParts.push(`最大HPを${gain}増加`);
          break;
        }
        case 'heal': {
          const heal = effectValue && effectValue > 0 ? effectValue : 25;
          player.hp = Math.min(maxHp, player.hp + heal);
          detailParts.push(`HPを${heal}回復`);
          break;
        }
        case 'recover': {
          const amount = effectValue && effectValue > 0 ? effectValue : 20;
          const stMax = player.maxStamina || 100;
          const mpMax = player.maxMagic || 100;
          player.stamina = Math.min(stMax, (player.stamina ?? stMax) + amount);
          player.magic = Math.min(mpMax, (player.magic ?? mpMax) + amount);
          detailParts.push(`スタミナ・魔力をそれぞれ最大${amount}回復`);
          break;
        }
        case 'buff':
        case 'attack_boost': {
          player.attackBoost = effectValue && effectValue > 0 ? effectValue : 50;
          detailParts.push(`攻撃ブーストを付与 (+${player.attackBoost}%)`);
          break;
        }
        case 'defense_boost': {
          player.defenseBoost = effectValue && effectValue > 0 ? effectValue : 40;
          detailParts.push(`防御ブーストを付与 (+${player.defenseBoost}%)`);
          break;
        }
        case 'debuff':
        case 'enemy_debuff': {
          if (opponent) {
            const dmg = effectValue && effectValue > 0 ? effectValue : 15;
            opponent.hp = Math.max(0, opponent.hp - dmg);
            detailParts.push(`相手に${dmg}のデバフダメージ`);
          }
          break;
        }
        case 'damage': {
          if (opponent) {
            const dmg = effectValue && effectValue > 0 ? effectValue : 20;
            opponent.hp = Math.max(0, opponent.hp - dmg);
            detailParts.push(`相手に${dmg}の直接ダメージ`);
          }
          break;
        }
        case 'cleanse': {
          player.statusAilments = [];
          detailParts.push('自身の状態異常を全て解除');
          break;
        }
        case 'field': {
          if (effectiveCard.fieldEffect && effectiveCard.fieldEffect.name) {
            room.fieldEffect = effectiveCard.fieldEffect;
            io.to(roomId).emit('fieldEffectUpdate', { fieldEffect: room.fieldEffect });
            detailParts.push(`フィールド「${room.fieldEffect.name}」を展開`);
          }
          break;
        }
        default: {
          // 旧サポート種別との後方互換
          if (card.supportType === 'heal_boost') {
            player.hp = Math.min(maxHp, player.hp + 30);
            detailParts.push('HPを30回復');
          } else if (card.supportType === 'attack_boost') {
            player.attackBoost = 50;
            detailParts.push('攻撃ブースト(+50%)');
          } else if (card.supportType === 'defense_boost') {
            player.defenseBoost = 40;
            detailParts.push('防御ブースト(+40%)');
          } else if (card.supportType === 'enemy_debuff') {
            if (opponent) opponent.hp = Math.max(0, opponent.hp - 15);
            detailParts.push('相手に15のデバフダメージ');
          } else {
            player.hp = Math.min(maxHp, player.hp + 20);
            detailParts.push('汎用回復: HPを20回復');
          }
        }
      }

      // サポート由来の状態異常付与（例えば毒フィールドなど）
      if (opponent) {
        const res = applyStatus(effectiveCard, opponent);
        if (res.dot > 0) opponent.hp = Math.max(0, opponent.hp - res.dot);
        if (res.dot > 0) detailParts.push(`状態異常の即時ダメージ ${res.dot}`);
      }

      // フィールド効果更新
      if (effectiveCard.fieldEffect && effectiveCard.fieldEffect.name) {
        room.fieldEffect = effectiveCard.fieldEffect;
        io.to(roomId).emit('fieldEffectUpdate', { fieldEffect: room.fieldEffect });
      }

      const hp = {};
      const maxHpMap = {};
      room.players.forEach(p => {
        hp[p.id] = p.hp;
        maxHpMap[p.id] = p.maxHp || STARTING_HP;
      });

      let winnerId = null;
      if (room.players.some(p => p.hp <= 0)) {
        const defeated = room.players.find(p => p.hp <= 0);
        const survivor = room.players.find(p => p.hp > 0);
        winnerId = survivor?.id || null;
      }

      if (!winnerId) {
        room.turnIndex = (room.turnIndex + 1) % room.players.length;
      }

      regenResources(room);

      const resources = {};
      room.players.forEach(p => {
        resources[p.id] = { stamina: p.stamina, magic: p.magic, maxStamina: p.maxStamina, maxMagic: p.maxMagic };
      });

      const shortageWarnings = [];
      if (resCost.shortage) {
        const reason = resCost.staminaShort && resCost.magicShort
          ? 'スタミナ・魔力不足！効果が減衰'
          : resCost.staminaShort
            ? 'スタミナ不足！効果が減衰'
            : '魔力不足！効果が減衰';
        shortageWarnings.push({ playerId: player.id, message: reason });
      }

      io.to(roomId).emit('supportUsed', {
        playerId: player.id,
        card: effectiveCard,
        supportDetail: (detailParts.length ? detailParts.join(' / ') : supportDetail) || null,
        hp,
        maxHp: maxHpMap,
        supportRemaining: 3 - player.supportUsed,
        winnerId,
        nextTurn: winnerId ? null : room.players[room.turnIndex].id,
        appliedStatus,
        fieldEffect: room.fieldEffect,
        statusTick,
        resources,
        shortageWarnings
      });

      if (winnerId) {
        const winnerName = room.players.find(p => p.id === winnerId)?.name || 'プレイヤー';
        updateStatus(roomId, `${winnerName} の勝利！`);
      } else {
        const resolvedDetail = detailParts.length ? detailParts.join(' / ') : supportDetail;
        const detailText = resolvedDetail ? `${player.name} のサポート: ${resolvedDetail}` : `${player.name} のサポートが発動`;
        updateStatus(roomId, `${detailText} → ${room.players[room.turnIndex].name} のターンです`);
      }
    } catch (error) {
      console.error('サポートカード生成エラー:', error);
      socket.emit('errorMessage', { message: 'エラーが発生しました' });
    }
  });

  socket.on('cancelMatching', () => {
    handleCancelMatch(socket);
    broadcastWaitingQueues();
  });

  // 後方互換
  socket.on('cancelMatch', () => {
    handleCancelMatch(socket);
    broadcastWaitingQueues();
  });

  socket.on('disconnect', () => {
    handleDisconnect(socket);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
