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

  // 攻撃力が存在しない場合は最小ダメージ
  if (attackCard.attack === undefined || attackCard.attack === null) {
    return 5; // Support カードなど攻撃力がない場合の最小ダメージ
  }

  // 攻撃力補正（ブースト + 乗数適用）
  let finalAttack = attackCard.attack;
  
  // 古い attackBoost システムを継続サポート
  if (attacker.attackBoost > 0) {
    finalAttack = Math.round(finalAttack * (1 + attacker.attackBoost / 100));
    attacker.attackBoost = 0;
  }
  
  // 新しい atkMultiplier システム（バフ優先）
  if (attacker.atkMultiplier && attacker.atkMultiplier !== 1.0) {
    finalAttack = Math.round(finalAttack * attacker.atkMultiplier);
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
    // 防御力が存在しない場合（Support カード）の処理
    let finalDefense = defenseCard.defense !== undefined ? defenseCard.defense : 0;
    
    // 防御力補正（ブースト + 乗数適用）
    if (finalDefense > 0) {
      if (defender.defenseBoost > 0) {
        finalDefense = Math.round(finalDefense * (1 + defender.defenseBoost / 100));
        defender.defenseBoost = 0;
      }
      
      // 新しい defMultiplier システム（バフ優先）
      if (defender.defMultiplier && defender.defMultiplier !== 1.0) {
        finalDefense = Math.round(finalDefense * defender.defMultiplier);
      }
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
        ? '現在はサポート用途。回復・強化・弱体化・環境変化を優先ロールとせよ。'
        : '通常査定。文脈から最適な役割を選べ。';
  
  const prompt = `あなたは厳格なゲームシステム設計者です。入力単語から以下のいずれか1つの形式でJSONを生成せよ。

【役割別パラメータ完全隔離仕様】

【1. Attack の場合】
出力形式：
{
  "role": "Attack",
  "name": "...",
  "attack": （17, 34, 52, 81 等の不規則な数値）,
  "attribute": "fire" | "water" | "wind" | "earth" | "thunder" | "light" | "dark",
  "specialEffect": "【固有効果名】具体的な効果文",
  "judgeComment": "単語の意味分析（150字程度）"
}
※ "defense" は絶対に含めるな
※ 攻撃力は言葉の『鋭さ・殺傷力・破壊力・スピード・希少価値』から独自に分析し、バラバラな値を設定する
例：剣=71, 矢=29, 炎=44, 隕石=87, 毒=36

【2. Defense の場合】
出力形式：
{
  "role": "Defense",
  "name": "...",
  "defense": （14, 46, 63, 78 等の不規則な数値）,
  "attribute": "fire" | "water" | "wind" | "earth" | "thunder" | "light" | "dark",
  "supportMessage": "防御効果の説明（〇〇%軽減、〇ターン有効など）",
  "specialEffect": "【固有効果名】具体的な効果文",
  "judgeComment": "単語の意味分析（150字程度）"
}
※ "attack" は絶対に含めるな
※ 防御力は言葉の『硬さ・耐久性・物理的強度・歴史的防御価値』から独自に分析し、バラバラな値を設定する
例：盾=65, 鎧=78, 氷壁=42, バリア=55, 城壁=82

【3. Support の場合】
出力形式：
{
  "role": "Support",
  "name": "...",
  "supportType": "heal" | "hpMaxUp" | "staminaRecover" | "magicRecover" | "defenseBuff" | "poison" | "burn" | "allStatBuff" | "debuff" | "cleanse" | "counter" | "fieldChange",
  "supportMessage": "効果説明・数値（heal=回復量、防御buff=軽減率、毒/焼け=継続ターン数など）",
  "attribute": "fire" | "water" | "wind" | "earth" | "thunder" | "light" | "dark",
  "specialEffect": "【固有効果名】具体的な効果文",
  "judgeComment": "単語の意味分析（150字程度）"
}
※ "attack" と "defense" は絶対に含めるな
※ supportType は以下の12種類から1つだけ選択：
  - heal: HP即座回復（医療・薬学・治癒関連）例: 薬草、ポーション、聖水
  - hpMaxUp: 最大HP永続増加（強化・進化・成長）例: 修行、進化、強鍛錬
  - staminaRecover: スタミナ即座回復（休息・回復）例: 睡眠、瞑想、休息
  - magicRecover: 魔力即座回復（魔法・祈り・集中）例: 祈祷、秘儀、魔法陣
  - defenseBuff: 次ターン被ダメージ軽減（防御強化・堅牢）例: 堅牢化、鉄壁、要塞
  - poison: 相手へ継続ダメージ毒付与（毒性・汚染）例: 毒、劇毒、ヴェノム
  - burn: 相手へ継続ダメージ焼け付与（火傷・高温）例: 炎、灼熱、焦熱
  - allStatBuff: 全ステータス微増（英雄・偉人・伝説）例: アーサー王、孫子、天才
  - debuff: 相手攻撃力/防御力を弱体化（弱化・呪い）例: 呪い、制限、衰弱
  - cleanse: 自身の状態異常をクリア（浄化・除去）例: 浄化、祓い、清水
  - counter: 反撃・カウンター効果（反撃・返し・予測）例: 反撃、カウンター、先読み
  - fieldChange: 天候や地形の変化（環境・地形・気象）例: 嵐、地震、津波

【共通ルール】
1. 数値は言葉の意味から独自に分析してバラバラな値を設定すること。テンプレート使用厳禁。
2. 数値は 1-99 範囲内（10, 20, 30 等のテンプレ値禁止）
3. specialEffect は【】で囲むこと
4. attribute は小文字統一（fire, water など）
5. 各role で指定されたキーだけを含める（余分なキーは含めるな）

${intentNote}`;

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
  
  // 役割判定ロジック
  let role = 'attack';
  if (/盾|shield|防|鎧|バリア|壁|要塞|城|砦|盔甲/.test(lower)) {
    role = 'defense';
  } else if (/毒|poison|回復|heal|support|サポート|環境|field|薬|医|祈|呪|弱|焼|灼|光|神|英雄|偉人|修行|進化|癒/.test(lower)) {
    role = 'support';
  }
  
  // 属性判定
  let attribute = 'earth';
  if (/fire|炎|爆|熱|マグマ|焼/.test(lower)) attribute = 'fire';
  else if (/water|水|海|氷|雨|波/.test(lower)) attribute = 'water';
  else if (/wind|風|竜巻|嵐|翼/.test(lower)) attribute = 'wind';
  else if (/thunder|雷|電|lightning|プラズマ/.test(lower)) attribute = 'thunder';
  else if (/light|光|聖|天使|神/.test(lower)) attribute = 'light';
  else if (/dark|闇|死|呪|影/.test(lower)) attribute = 'dark';
  
  // 役割別フォールバック返却
  if (role === 'attack') {
    return {
      role: 'Attack',
      name: word,
      attack: 56,
      attribute,
      specialEffect: '【基本攻撃】入力単語からの標準攻撃',
      judgeComment: 'フォールバック時の汎用攻撃カード。入力単語の特性から独立した基本値として機能。'
    };
  } else if (role === 'defense') {
    return {
      role: 'Defense',
      name: word,
      defense: 73,
      attribute,
      supportMessage: '被ダメージ35%軽減（2ターン有効）',
      specialEffect: '【基本防御】入力単語からの標準防御',
      judgeComment: 'フォールバック時の汎用防御カード。防護性能を重視した基本値として機能。'
    };
  } else {
    // Support
    let supportType = 'heal';
    let supportMessage = 'HP を40回復';
    
    if (/毒|poison|ヘビ|蛇|沼/.test(lower)) {
      supportType = 'poison';
      supportMessage = '相手に毒を付与。3ターン継続、毎ターンHP-3';
    } else if (/焼|灼|焙|熱波|炎炎/.test(lower)) {
      supportType = 'burn';
      supportMessage = '相手に焼けを付与。3ターン継続、毎ターンHP-3';
    } else if (/修行|進化|強鍛|耐性|体質/.test(lower)) {
      supportType = 'hpMaxUp';
      supportMessage = '最大HP +38';
    } else if (/睡眠|瞑想|呼吸|休息|リラック/.test(lower)) {
      supportType = 'staminaRecover';
      supportMessage = 'スタミナを44回復';
    } else if (/祈|秘儀|魔法陣|集中/.test(lower)) {
      supportType = 'magicRecover';
      supportMessage = '魔力を32回復';
    } else if (/堅牢|鉄壁|要塞|強固|不動/.test(lower)) {
      supportType = 'defenseBuff';
      supportMessage = '次ターン被ダメージ-39%';
    } else if (/呪|制限|弱体|縛|衰弱/.test(lower)) {
      supportType = 'debuff';
      supportMessage = '相手の攻撃力 -22';
    } else if (/浄|祓|リセット|清|新生/.test(lower)) {
      supportType = 'cleanse';
      supportMessage = '状態異常をすべてクリア';
    } else if (/反撃|カウンター|先読|受け流|跳ね返/.test(lower)) {
      supportType = 'counter';
      supportMessage = '次ターン受けたダメージを反射';
    } else if (/嵐|地震|津波|竜巻|雷鳴|台風/.test(lower)) {
      supportType = 'fieldChange';
      supportMessage = 'フィールド効果を発動（2ターン）';
    } else if (/アーサー|ナポレオン|孫子|天才|英雄/.test(lower)) {
      supportType = 'allStatBuff';
      supportMessage = '全ステータス +26（1ターン）';
    } else {
      supportType = 'heal';
      supportMessage = 'HP を40回復';
    }
    
    return {
      role: 'Support',
      name: word,
      supportType,
      attribute,
      supportMessage,
      specialEffect: `【${supportType}】フォールバック効果`,
      judgeComment: 'フォールバック時のサポートカード。supportType自動判定から生成。'
    };
  }
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
      stamina: 100,                    // スタミナ（0-100）
      maxStamina: 100,
      mp: 50,                          // マジックポイント（0-100）
      maxMp: 50,
      usedWords: new Set(),
      isHost: idx === 0,
      supportUsed: 0,
      attackBoost: 0,
      defenseBoost: 0,
      atkMultiplier: 1.0,              // 攻撃力乗数
      defMultiplier: 1.0,              // 防御力乗数
      statusAilments: [],
      buffs: {                         // バフ管理
        atkUp: 0,                       // ターン数
        defUp: 0,
        allStatUp: 0
      }
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
  
  // プレイヤーステータス完全リセット
  room.players.forEach(p => {
    p.hp = STARTING_HP;
    p.maxHp = STARTING_HP;
    p.stamina = 100;
    p.maxStamina = 100;
    p.mp = 50;
    p.maxMp = 50;
    p.attackBoost = 0;
    p.defenseBoost = 0;
    p.atkMultiplier = 1.0;
    p.defMultiplier = 1.0;
    p.statusAilments = [];
    p.buffs = { atkUp: 0, defUp: 0, allStatUp: 0 };
    p.usedWords.clear();
    p.supportUsed = 0;
  });
  
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

// バフの毎ターン減衰処理
function tickBuffEffects(room) {
  if (!room || !room.players) return;
  room.players.forEach(p => {
    if (!p.buffs) p.buffs = { atkUp: 0, defUp: 0, allStatUp: 0, counterUp: 0 };
    
    // 攻撃力バフの減衰
    if (p.buffs.atkUp > 0) {
      p.buffs.atkUp--;
      if (p.buffs.atkUp <= 0) {
        p.atkMultiplier = Math.max(1.0, p.atkMultiplier - 0.5);  // バフ解除時に乗数を戻す
        console.log(`⏰ ${p.name}: 攻撃力バフが消滅 (乗数: ${p.atkMultiplier.toFixed(2)}x)`);
      }
    }
    
    // 防御力バフの減衰
    if (p.buffs.defUp > 0) {
      p.buffs.defUp--;
      if (p.buffs.defUp <= 0) {
        p.defenseBoost = Math.max(0, p.defenseBoost - 34);  // バフ解除時に防御力を戻す
        console.log(`⏰ ${p.name}: 防御力バフが消滅 (防御: ${p.defenseBoost})`);
      }
    }
    
    // 全能力バフの減衰
    if (p.buffs.allStatUp > 0) {
      p.buffs.allStatUp--;
      if (p.buffs.allStatUp <= 0) {
        p.atkMultiplier = Math.max(1.0, p.atkMultiplier - 0.19);
        p.defMultiplier = Math.max(1.0, p.defMultiplier - 0.19);
        console.log(`⏰ ${p.name}: 全能力バフが消滅`);
      }
    }
    
    // カウンター効果の減衰
    if (p.buffs.counterUp > 0) {
      p.buffs.counterUp--;
      if (p.buffs.counterUp <= 0) {
        p.counterActive = false;
        console.log(`⏰ ${p.name}: カウンター能力が消滅`);
      }
    }
  });
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

  // 非同期でカード生成（エラー時はフォールバック使用）
  generateCard(cleanWord, 'attack')
    .catch(error => {
      console.error('❌ 攻撃カード生成エラー:', error);
      return generateCardFallback(cleanWord);
    })
    .then(card => {
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
    // バフ減衰処理（ゲーム終了なので実行しない）
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
  
  // 非同期で防御カードを生成（エラー時はフォールバック使用）
  generateCard(cleanWord, 'defense')
    .catch(error => {
      console.error('❌ 防御カード生成エラー:', error);
      return generateCardFallback(cleanWord);
    })
    .then(defenseCard => {
      console.log('🛡️ 防御カード生成完了:', defenseCard);
      room.usedWordsGlobal.add(lower);
      defender.usedWords.add(lower);

    // 【役割別バトルロジック】 - 文字列ベースの役割判定
    const attackRole = (attackCard.role || '').toLowerCase();
    const defenseRole = (defenseCard.role || '').toLowerCase();
    
    let damage = 0;
    let counterDamage = 0;
    let dotDamage = 0;
    let defenseFailed = false;
    const appliedStatus = [];
    const attackerMaxHp = attacker.maxHp || STARTING_HP;
    const defenderMaxHp = defender.maxHp || STARTING_HP;
    
    // 属性相性計算（基本）
    const affinity = getAffinity(attackCard.attribute, defenseCard.attribute);

    // === Attack vs Defense 標準バトル ===
    if (attackRole === 'attack' && defenseRole === 'defense') {
      console.log('⚔️ 【標準バトル】Attack vs Defense: ダメージ計算フェーズ');
      damage = calculateDamage(attackCard, defenseCard, attacker, defender, false);
      
      // Defense ロール時のダメージ減衰（防御値で減衰）
      const defenseValue = defenseCard.defense || 0;
      if (defenseValue > 0) {
        const damageReduction = Math.round(damage * (defenseValue / 100));
        damage = Math.max(5, damage - damageReduction);
        console.log(`🛡️ Defense ロール防御適用: ダメージ減衰: ${defenseValue}% → ${damage}に軽減`);
      }
      defender.hp = Math.max(0, defender.hp - damage);
    }
    
    // === Attack vs Attack 衝突 ===
    else if (attackRole === 'attack' && defenseRole === 'attack') {
      console.log('⚔️ 【衝突】Attack vs Attack: 双方ダメージ');
      damage = calculateDamage(attackCard, defenseCard, attacker, defender, false);
      counterDamage = calculateDamage(defenseCard, attackCard, defender, attacker, false);
      defender.hp = Math.max(0, defender.hp - damage);
      attacker.hp = Math.max(0, attacker.hp - counterDamage);
    }
    
    // === Attack vs Support: 攻撃がサポートを突破 ===
    else if (attackRole === 'attack' && defenseRole === 'support') {
      console.log('📦 【サポート突破】Attack が Support を突破: ダメージなし、サポート効果なし');
      damage = 0;
      // サポート効果は無視（攻撃で完全に遮断）
    }
    
    // === Defense vs Attack: 防御態勢フェーズ ===
    else if (attackRole === 'defense' && defenseRole === 'attack') {
      console.log('🛡️ 【防御態勢】Defense が攻撃判定をスキップ: 防御力を適用');
      damage = calculateDamage(attackCard, defenseCard, attacker, defender, false);
      // Defense ロール（攻撃側）のdifference フィールドは攻撃力がないため最小ダメージ
      defenseRole === 'attack' && 
        ((damage = calculateDamage(attackCard, defenseCard, attacker, defender, false)));
      attacker.hp = Math.max(0, attacker.hp - counterDamage);
    }
    
    // === Defense vs Defense: 両防御 ===
    else if (attackRole === 'defense' && defenseRole === 'defense') {
      console.log('🛡️ 【両防御】Defense vs Defense: ダメージなし');
      damage = 0;
      counterDamage = 0;
    }
    
    // === Defense vs Support: 防御フェーズ ===
    else if (attackRole === 'defense' && defenseRole === 'support') {
      console.log('📦 【防御+サポート】Defense vs Support: ダメージなし');
      damage = 0;
      // サポート効果も無視
    }
    
    // === Support vs Attack: サポート対攻撃 ===
    else if (attackRole === 'support' && defenseRole === 'attack') {
      console.log('📦 【サポート対攻撃】Support vs Attack: 攻撃がサポートを押し通す');
      damage = calculateDamage(attackCard, defenseCard, attacker, defender, false);
      defender.hp = Math.max(0, defender.hp - damage);
    }
    
    // === Support vs Defense: 防御態勢 ===
    else if (attackRole === 'support' && defenseRole === 'defense') {
      console.log('🛡️ 【防御態勢】Support vs Defense: 防御力適用、サポートなし');
      damage = 0;
    }
    
    // === Support vs Support: 両者サポート ===
    else if (attackRole === 'support' && defenseRole === 'support') {
      console.log('📦 【相互サポート】Support vs Support: ダメージなし');
      damage = 0;
    }
    
    // === デフォルト（未想定） ===
    else {
      console.log(`⚠️ 未想定の役割組み合わせ: Attack[${attackRole}] vs Defense[${defenseRole}]`);
      damage = calculateDamage(attackCard, defenseCard, attacker, defender, false);
      defender.hp = Math.max(0, defender.hp - damage);
    }

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

    // ターン終了時のバフ減衰処理
    if (!winnerId) {
      tickBuffEffects(room);
      room.turnIndex = (room.turnIndex + 1) % room.players.length;
    }

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

    // 【完全同期】ターン交代と turnUpdate emit を確約
    if (!winnerId) {
      const nextPlayer = room.players[room.turnIndex];
      io.to(roomId).emit('turnUpdate', {
        activePlayer: nextPlayer.id,
        activePlayerName: nextPlayer.name,
        turnIndex: room.turnIndex,
        players: room.players.map(p => ({ id: p.id, name: p.name, hp: p.hp, maxHp: p.maxHp || STARTING_HP }))
      });
    }
    })
    .catch(error => {
      console.error('❌ 防御カード生成エラー（フォールバック利用）:', error);
      // エラー時もターン交代を実行してゲームを進行させる
      room.usedWordsGlobal.add(lower);
      defender.usedWords.add(lower);
      
      // フォールバック防御カード
      const fallbackDefenseCard = generateCardFallback(cleanWord);
      console.log('🛡️ フォールバック防御カード使用:', fallbackDefenseCard);
      
      // 簡易ダメージ計算（フォールバック時）
      const fallbackDamage = 10; // 基本ダメージ
      defender.hp = Math.max(0, defender.hp - fallbackDamage);
      
      room.pendingAttack = null;
      room.turnIndex = (room.turnIndex + 1) % room.players.length;
      
      const hp = {};
      room.players.forEach(p => { hp[p.id] = p.hp; });

      io.to(roomId).emit('turnResolved', {
        attackerId: attacker.id,
        defenderId: defender.id,
        attackCard: attackCard,
        defenseCard: fallbackDefenseCard,
        damage: fallbackDamage,
        counterDamage: 0,
        dotDamage: 0,
        affinity: null,
        hp,
        defenseFailed: true,
        appliedStatus: [],
        statusTick: tickStatusEffects(room),
        fieldEffect: room.fieldEffect,
        nextTurn: room.players[room.turnIndex].id,
        winnerId: null
      });

      // 【完全同期】フォールバック時もターン交代と turnUpdate を emit
      const nextPlayer = room.players[room.turnIndex];
      io.to(roomId).emit('turnUpdate', {
        activePlayer: nextPlayer.id,
        activePlayerName: nextPlayer.name,
        turnIndex: room.turnIndex,
        players: room.players.map(p => ({ id: p.id, name: p.name, hp: p.hp, maxHp: p.maxHp || STARTING_HP }))
      });
      
      updateStatus(roomId, `${nextPlayer.name} のターンです（カード生成エラーで処理スキップ）`);
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
          // 最大HP永続増加
          const gain = effectValue && effectValue > 0 ? effectValue : 20;
          player.maxHp = Math.min(999, player.maxHp + gain);  // キャップ999
          player.hp = Math.min(player.maxHp, player.hp + gain);
          console.log(`💪 ${player.name}: ${card.supportMessage || '最大HP増加'} (最大HP+${gain}→${player.maxHp}, HP+${gain}→${player.hp})`);
          break;
        }
        case 'heal': {
          // HP即座回復
          const heal = effectValue && effectValue > 0 ? effectValue : 25;
          const healAmount = Math.min(maxHp, player.hp + heal) - player.hp;
          player.hp = Math.min(maxHp, player.hp + heal);
          console.log(`🏥 ${player.name}: ${card.supportMessage || 'HP回復'} (+${healAmount}, ${player.hp}/${maxHp})`);
          break;
        }
        case 'staminarecover': {
          // スタミナ即座回復
          const staminaGain = effectValue && effectValue > 0 ? effectValue : 37;
          const oldStamina = player.stamina;
          player.stamina = Math.min(player.maxStamina, player.stamina + staminaGain);
          console.log(`⚡ ${player.name}: ${card.supportMessage || 'スタミナ回復'} (+${player.stamina - oldStamina}, ${player.stamina}/${player.maxStamina})`);
          break;
        }
        case 'magicrecover': {
          // 魔力即座回復
          const mpGain = effectValue && effectValue > 0 ? effectValue : 29;
          const oldMp = player.mp;
          player.mp = Math.min(player.maxMp, player.mp + mpGain);
          console.log(`✨ ${player.name}: ${card.supportMessage || '魔力回復'} (+${player.mp - oldMp}, ${player.mp}/${player.maxMp})`);
          break;
        }
        case 'defensebuff': {
          // 防御力強化（次ターン被ダメージ軽減）
          const defIncrease = effectValue && effectValue > 0 ? effectValue : 34;
          player.defenseBoost = Math.max(player.defenseBoost, defIncrease);  // より高い値を採用
          player.buffs.defUp = 2;  // 2ターン有効
          console.log(`🛡️ ${player.name}: ${card.supportMessage || '防御強化'} (軽減率+${defIncrease}%, 2ターン有効)`);
          break;
        }
        case 'allstatbuff': {
          // 全ステータス微増（英雄・偉人効果）
          const boost = effectValue && effectValue > 0 ? effectValue : 19;
          player.atkMultiplier = Math.min(2.0, player.atkMultiplier + (boost / 100));
          player.defMultiplier = Math.min(2.0, player.defMultiplier + (boost / 100));
          const healBonus = Math.round(boost * 1.5);
          player.hp = Math.min(maxHp, player.hp + healBonus);
          player.buffs.allStatUp = 3;  // 3ターン有効
          console.log(`👑 ${player.name}: ${card.supportMessage || '全能力強化'} (攻撃/防御+${boost}%, HP+${healBonus}, 3ターン有効)`);
          break;
        }
        case 'buff':
        case 'attack_boost': {
          // 攻撃力強化
          const atkIncrease = effectValue && effectValue > 0 ? effectValue : 50;
          player.atkMultiplier = Math.min(2.0, player.atkMultiplier + (atkIncrease / 100));
          player.buffs.atkUp = 2;  // 2ターン有効
          console.log(`⬆️ ${player.name}: 攻撃力強化 ${atkIncrease}% (乗数: ${player.atkMultiplier.toFixed(2)}x), 2ターン有効`);
          break;
        }
        case 'defense_boost': {
          // 防御力強化
          const defIncrease = effectValue && effectValue > 0 ? effectValue : 40;
          player.defenseBoost = Math.max(player.defenseBoost, defIncrease);
          player.buffs.defUp = 2;
          console.log(`🛡️ ${player.name}: 防御力強化 +${defIncrease}%, 2ターン有効`);
          break;
        }
        case 'poison': {
          // 相手に毒付与（3ターン継続ダメージ）
          if (opponent && opponent.statusAilments) {
            if (opponent.statusAilments.length < 3) {
              const dotValue = effectValue && effectValue > 0 ? effectValue : 3;
              opponent.statusAilments.push({
                name: '毒',
                turns: 3,
                effectType: 'dot',
                value: dotValue
              });
              appliedStatus.push({
                targetId: opponent.id,
                name: '毒',
                turns: 3,
                effectType: 'dot',
                value: dotValue
              });
              console.log(`☠️ ${opponent.name}: ${card.supportMessage || '毒付与'} (3ターン継続, ${dotValue}ダメージ/ターン)`);
            }
          }
          break;
        }
        case 'burn': {
          // 相手に焼け付与（3ターン継続ダメージ）
          if (opponent && opponent.statusAilments) {
            if (opponent.statusAilments.length < 3) {
              const dotValue = effectValue && effectValue > 0 ? effectValue : 3;
              opponent.statusAilments.push({
                name: '焼け',
                turns: 3,
                effectType: 'dot',
                value: dotValue
              });
              appliedStatus.push({
                targetId: opponent.id,
                name: '焼け',
                turns: 3,
                effectType: 'dot',
                value: dotValue
              });
              console.log(`🔥 ${opponent.name}: ${card.supportMessage || '焼け付与'} (3ターン継続, ${dotValue}ダメージ/ターン)`);
            }
          }
          break;
        }
        case 'debuff': {
          // 相手の攻撃力または防御力を弱体化
          if (opponent) {
            const debuffAmount = effectValue && effectValue > 0 ? effectValue : 25;
            opponent.atkMultiplier = Math.max(0.5, opponent.atkMultiplier - (debuffAmount / 100));
            opponent.defMultiplier = Math.max(0.5, opponent.defMultiplier - (debuffAmount / 100));
            console.log(`📉 ${opponent.name}: ${card.supportMessage || '弱体化'} (攻撃/防御 -${debuffAmount}%)`);
          }
          break;
        }
        case 'enemy_debuff': {
          // 相手へ直接ダメージ
          if (opponent) {
            const dmg = effectValue && effectValue > 0 ? effectValue : 15;
            opponent.hp = Math.max(0, opponent.hp - dmg);
            console.log(`💢 ${opponent.name}: ダメージ ${dmg} (HP: ${opponent.hp})`);
          }
          break;
        }
        case 'counter': {
          // カウンター効果：次ターン攻撃を受けると自動で反撃
          player.counterActive = true;
          player.buffs.counterUp = 2;  // 2ターン有効
          console.log(`⚔️ ${player.name}: ${card.supportMessage || 'カウンター能力発動'} (2ターン有効)`);
          break;
        }
        case 'fieldchange': {
          // フィールド効果発動
          room.fieldEffect = {
            name: card.supportMessage || '環境変化',
            visual: 'linear-gradient(135deg, rgba(255, 100, 100, 0.3), rgba(100, 100, 255, 0.3))'
          };
          console.log(`🌍 フィールド効果: 【${card.word}】: ${room.fieldEffect.name}`);
          io.to(roomId).emit('fieldEffectUpdate', { fieldEffect: room.fieldEffect });
          break;
        }
        case 'cleanse': {
          // 自身の状態異常をすべてクリア
          const cleansedCount = player.statusAilments.length;
          player.statusAilments = [];
          console.log(`💧 ${player.name}: ${card.supportMessage || '浄化'} (${cleansedCount}個の状態異常をクリア)`);
          break;
        }
        case 'damage': {
          // 相手へ直接ダメージ
          if (opponent) {
            const dmg = effectValue && effectValue > 0 ? effectValue : 20;
            opponent.hp = Math.max(0, opponent.hp - dmg);
            console.log(`💥 ${opponent.name}: ダメージ ${dmg} (HP: ${opponent.hp})`);
          }
          break;
        }
        default: {
          // 旧サポート種別との後方互換
          if (card.supportType === 'heal_boost') {
            const heal = 30;
            player.hp = Math.min(maxHp, player.hp + heal);
            console.log(`🏥 ${player.name}: 回復ブースト +${heal} (HP: ${player.hp})`);
          } else if (card.supportType === 'attack_boost') {
            player.attackBoost = 50;
            console.log(`⬆️ ${player.name}: 攻撃力ブースト 50%`);
          } else if (card.supportType === 'defense_boost') {
            player.defenseBoost = 40;
            console.log(`🛡️ ${player.name}: 防御力ブースト 40%`);
          } else if (card.supportType === 'enemy_debuff') {
            if (opponent) {
              opponent.hp = Math.max(0, opponent.hp - 15);
              console.log(`💢 ${opponent.name}: 敵弱体化ダメージ 15`);
            }
          } else {
            const heal = 20;
            player.hp = Math.min(maxHp, player.hp + heal);
            console.log(`🏥 ${player.name}: デフォルト回復 +${heal}`);
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
        // ターン終了時のバフ減衰処理
        tickBuffEffects(room);
        room.turnIndex = (room.turnIndex + 1) % room.players.length;
      }

      // サポートカード情報を構造化（supportMessage の確実な伝送）
      const cardData = {
        ...card,
        supportMessage: card.supportMessage || '', // 明示的に含める
        word: card.word,
        supportType: card.supportType || '',
        specialEffect: card.specialEffect || '',
        role: card.role || ''
      };

      // バトルログに サポート発動記録を追加
      const supportLog = `✨ 【${card.word}】: ${card.supportMessage || '効果を発動'}`;
      console.log(`📋 バトルログ: ${supportLog}`);

      io.to(roomId).emit('supportUsed', {
        playerId: player.id,
        card: cardData,
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

      // 【完全同期】supportAction 後も必ずターン交代と turnUpdate を emit
      if (!winnerId) {
        const nextPlayer = room.players[room.turnIndex];
        io.to(roomId).emit('turnUpdate', {
          activePlayer: nextPlayer.id,
          activePlayerName: nextPlayer.name,
          turnIndex: room.turnIndex,
          players: room.players.map(p => ({ id: p.id, name: p.name, hp: p.hp, maxHp: p.maxHp || STARTING_HP }))
        });
      }
    } catch (error) {
      console.error('❌ サポートカード生成エラー:', error);
      // エラー時もターン交代を実行（フロントエンド同期のため）
      const fallbackCard = generateCardFallback(cleanWord);
      room.usedWordsGlobal.add(lower);
      player.usedWords.add(lower);
      player.supportUsed++;

      console.log(`⚠️ サポート処理: フォールバックカード使用`);
      socket.emit('errorMessage', { message: 'サポート効果を発動しました（カード生成エラー時の代替）' });

      // 【完全同期】エラー時もターン交代と turnUpdate を emit
      if (!room.players.some(p => p.hp <= 0)) { // 誰も倒れていない場合のみ
        room.turnIndex = (room.turnIndex + 1) % room.players.length;
        const nextPlayer = room.players[room.turnIndex];
        io.to(roomId).emit('turnUpdate', {
          activePlayer: nextPlayer.id,
          activePlayerName: nextPlayer.name,
          turnIndex: room.turnIndex,
          players: room.players.map(p => ({ id: p.id, name: p.name, hp: p.hp, maxHp: p.maxHp || STARTING_HP }))
        });
        updateStatus(roomId, `${nextPlayer.name} のターンです（サポート生成エラー）`);
      }
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
