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
// Gemini 応答待ちの最大時間（ms）
const GEMINI_TIMEOUT_MS = 7000;

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
// 属性ユーティリティと相性ロジック（刷新）
// =====================================
function attributeToElementJP(attr) {
  switch ((attr || '').toLowerCase()) {
    case 'fire': return '火';
    case 'water': return '水';
    case 'wind': return '風';
    case 'earth': return '土';
    case 'thunder': return '雷';
    case 'light': return '光';
    case 'dark': return '闇';
    default: return null;
  }
}

function getAffinityByElement(attackerElem, defenderElem) {
  const beats = { '火': '草', '草': '土', '土': '雷', '雷': '水', '水': '火' };
  const atk = attackerElem || null;
  const def = defenderElem || null;
  
  // カスタム属性（金/魂/夢/虚無 等）や未定義の属性は等倍（1.0）として処理
  if (!atk || !def) return { multiplier: 1.0, relation: 'neutral', isEffective: false };

  // 既存の属性相性計算に該当しない場合も等倍（1.0）
  const knownAttributes = ['火', '水', '風', '土', '雷', '光', '闇', '草'];
  if (!knownAttributes.includes(atk) || !knownAttributes.includes(def)) {
    return { multiplier: 1.0, relation: 'neutral', isEffective: false };
  }

  // 光⇄闇 は互いに弱点
  if ((atk === '光' && def === '闇') || (atk === '闇' && def === '光')) {
    return { multiplier: 0.75, relation: 'disadvantage', isEffective: false };
  }

  // 有利（1.5倍）/ 不利（0.75倍）/ 中立（1.0倍）
  if (beats[atk] === def) {
    return { multiplier: 1.5, relation: 'advantage', isEffective: true };
  }
  if (beats[def] === atk) {
    return { multiplier: 0.75, relation: 'disadvantage', isEffective: false };
  }
  return { multiplier: 1.0, relation: 'neutral', isEffective: false };
}

// =====================================
// フォールバックカードとタイムアウト保護
// =====================================
function createDefaultAttackCard(word = '通常攻撃') {
  const baseWord = word && word.trim() ? word.trim() : '通常攻撃';
  return {
    role: 'Attack',
    word: baseWord,
    name: baseWord,
    attribute: 'earth',
    element: '土',
    attack: 52,
    defense: 0,
    specialEffect: '【基本攻撃】AI遅延時の代替攻撃',
    judgeComment: 'Gemini応答遅延/エラー時のデフォルト攻撃カード',
    description: `EARTH [ATTACK] ATK:52 DEF:0 / 【基本攻撃】AI遅延時の代替攻撃`
  };
}

async function generateCardWithTimeout(word, intent = 'attack', fallbackCard) {
  const fallback = fallbackCard || (intent === 'attack' ? createDefaultAttackCard(word) : generateCardFallback(word));
  try {
    const card = await Promise.race([
      generateCard(word, intent),
      new Promise(resolve => setTimeout(() => {
        console.warn(`⏱️ Gemini応答タイムアウト: intent=${intent}, word=${word}`);
        resolve(fallback);
      }, GEMINI_TIMEOUT_MS))
    ]);
    return card || fallback;
  } catch (error) {
    console.error(`❌ generateCardWithTimeout エラー intent=${intent}`, error);
    return fallback;
  }
}

// =====================================
// ダメージ計算関数（刷新相性ロジック対応）
// =====================================
function calculateDamage(attackCard, defenseCard, attacker, defender, defenseFailed = false, room = null) {

  // 攻撃力（未定義は0）
  const baseAttack = Number(attackCard?.attack) || 0;
  let finalAttack = baseAttack;
  
  // 古い attackBoost システムを継続サポート
  const attackBoost = Number(attacker?.attackBoost) || 0;
  if (attackBoost > 0) {
    finalAttack = Math.round(finalAttack * (1 + attackBoost / 100));
    attacker.attackBoost = 0;
  }
  
  // 新しい atkMultiplier システム（バフ優先）
  const atkMultiplier = Number(attacker?.atkMultiplier) || 1.0;
  if (atkMultiplier !== 1.0) {
    finalAttack = Math.round(finalAttack * atkMultiplier);
  }

  // 属性相性補正
  const atkElem = attackCard.element || attributeToElementJP(attackCard.attribute);
  const defElem = (defenseCard && defenseCard.element) || attributeToElementJP(defenseCard?.attribute);
  const affinity = getAffinityByElement(atkElem, defElem);
  let affinityMultiplier = affinity.multiplier || 1.0;
  finalAttack = Math.round(finalAttack * affinityMultiplier);

  // フィールド効果補正（永続フィールドを最優先）
  // Damage = Math.max(0, (Attack * Affinity * (FieldMatch ? 1.5 : 1.0)) - Defense)
  let fieldMultiplier = 1.0;
  if (room && room.field && room.field.element && room.field.remainingTurns > 0) {
    // 永続フィールド: element が一致すれば 1.5 倍
    if (atkElem === room.field.element) {
      fieldMultiplier = 1.5;
      console.log(`🌍 フィールドバフ適用: ${atkElem} === ${room.field.element} → x1.5 (残り${room.field.remainingTurns}ターン)`);
    }
  } else if (room && room.currentField && room.currentField.name && room.currentField.turns > 0) {
    // 互換性: currentField が有効な場合
    if (atkElem === room.currentField.name) {
      fieldMultiplier = room.currentField.multiplier || 1.5;
    }
  } else if (room && room.fieldEffect && room.fieldEffect.name) {
    // 互換性: 旧 fieldEffect が有効な場合
    if (atkElem === room.fieldEffect.name) {
      fieldMultiplier = room.fieldEffect.multiplier || 1.5;
    }
  }
  finalAttack = Math.round(finalAttack * fieldMultiplier);

  // ダメージ計算式: Damage = max(0, (Attack × Affinity × FieldMultiplier) - Defense)
  // ※ Affinity と FieldMultiplier は既に finalAttack に乗算済み
  let damage = 0;
  // 防御値（未定義は0）
  let finalDefense = Number(defenseCard?.defense) || 0;
  // 防御補正（ブースト + 乗数）
  if (finalDefense > 0) {
    const defenseBoost = Number(defender?.defenseBoost) || 0;
    const defMultiplier = Number(defender?.defMultiplier) || 1.0;
    finalDefense = Math.round(finalDefense * (1 + defenseBoost / 100) * defMultiplier);
    // ブーストは使用時に消費
    if (defenseBoost > 0) defender.defenseBoost = 0;
  }

  // 予約防御（前ターンのDefense適用）
  const reservedDefense = Number(defender?.reservedDefense) || 0;
  let totalDefense = finalDefense + reservedDefense;

  if (defenseFailed) {
    // 防御失敗でも予約防御は確実に差し引く
    damage = Math.max(0, finalAttack - reservedDefense);
  } else {
    // 新式: (Attack × Affinity × FieldMultiplier) - Defense
    damage = Math.max(0, finalAttack - totalDefense);
  }
  // 予約防御は消費
  if (reservedDefense > 0) defender.reservedDefense = 0;

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
  
  const prompt = `あなたは博学なゲームマスターです。入力された言葉を深く分析し、歴史・科学・文化的背景から本質を抽出し、固定観念にとらわれない独創的なカードデータをJSON形式で生成してください。

【概念深層分析ロジック】

1. **固定観念の破壊：属性を言葉の本質から決定**
   - 「火/水/風/土/雷/光/闇/草」の8属性に縛られず、言葉の本質的性質から最も近い属性を選ぶ
   - 例：「インフレ」→ 経済膨張 → 風（拡散）または火（熱）
   - 例：「AI」→ 思考の抽象化 → 光（知）または闇（不可視性）
   - 例：「原爆」→ 核分裂エネルギー → 火（破壊熱）
   - カスタム属性も許可：「金」「魂」「夢」「虚無」などを element に設定可能（attribute は既存8種から選択）

2. **動的エフェクト生成：既存リストから選ばず、言葉の特徴から創造**
   - specialEffect は既存の効果名をコピーせず、言葉固有の現象を表現
   - 例：「GPS」→【測地座標拘束】相手の次行動を89%予測し、回避率を向上させる
   - 例：「ペニシリン」→【抗菌連鎖】HP を61回復し、状態異常を無効化（3ターン）
   - 例：「ストライキ」→【労働停止】相手の次ターン攻撃力を-47、防御力を-39

3. **数値のセマンティック生成：意味のある不規則な数値**
   - 歴史的年代、科学的定数、文化的数値から導出
   - 例：「原爆」→ 1945年 → attack: 54（45の逆数＋9）、防御無視率19%（1945末尾）
   - 例：「フランス革命」→ 1789年 → attack: 89、defense: 17（年代分解）
   - 例：「絶対零度」→ -273.15℃ → defense: 73、冷凍持続ターン: 3
   - 例：「π」→ 3.14159... → attack: 31, 特殊効果で41%の追加ダメージ
   - **禁止数値**：10, 20, 30, 40, 50, 60, 70, 80, 90, 100（キリの良い数字は意味が薄い）
   - **推奨数値**：13, 27, 34, 46, 58, 61, 73, 82, 89, 91, 97
   - **厳守**：数値は13, 27, 46, 82など、言葉の意味に基づく不規則な値にせよ。5の倍数や10の倍数は原則使用禁止

4. **役割判定の柔軟性**
   - Attack：破壊・加害・侵略・爆発・斬撃・撃破
   - Defense：防御・保護・耐久・遮蔽・反射・吸収
   - Support：治療・強化・弱体化・環境変化・状態操作
   - 天候・環境ワード（晴れ/雨/嵐/砂漠/雷雲/月光 等）は必ず role: "Support", supportType: "fieldChange"
   
   **【重要：fieldChange の厳格ルール】**
   - 環境・気象・地形・状態に関する言葉（例：「晴れ」「雨」「嵐」「砂嵐」「月光」「朝焼け」「極寒」「灼熱」「干ばつ」等）は必ず supportType: "fieldChange" とせよ
   - fieldChange 生成時は以下を **絶対に省略するな**：
     * supportMessage（必須）: 「日差しが強まり火属性が1.5倍になる！（4ターン）」のように、どの属性がどう強化されるかを明示
     * fieldEffect（必須）: 強化される属性名（火/水/風/土/雷/光/闇/草 または カスタム属性）
     * fieldMultiplier（必須）: 1.5 を推奨（1.3～1.5 の範囲で設定可）
     * fieldTurns（必須）: 3, 4, 5 などの不規則な値（3～5ターンを推奨）
   - 言葉の本質から属性を自由に判断せよ：
     * 「朝焼け」→ 火属性（光と熱の融合）
     * 「霧」→ 水属性（水蒸気）
     * 「極寒」→ 水属性（凍結イメージ）
     * 「砂嵐」→ 土属性または風属性（砂と風の複合）
     * 「月光」→ 光属性（柔らかな光）
     * 既存の枠に囚われず、その言葉が最も強く連想させる属性を選べ

5. **視覚的表現：visual フィールド追加**
   - 各カードに視覚的な CSS gradient や色コードを付与
   - 例：「原爆」→ visual: "linear-gradient(135deg, #ff4500, #ffd700, #8b0000)"
   - 例：「深海」→ visual: "radial-gradient(circle, #001f3f, #003366)"
   - 例：「虹」→ visual: "linear-gradient(90deg, red, orange, yellow, green, blue, indigo, violet)"

---

【出力形式】

**Attack の場合：**
\`\`\`json
{
  "role": "Attack",
  "name": "カード名（30字以内）",
  "element": "火" | "水" | "風" | "土" | "雷" | "光" | "闇" | "草" | カスタム（例："金", "魂", "虚無"）,
  "attack": （意味のある不規則な数値、1-99、10の倍数禁止）,
  "attribute": "fire" | "water" | "wind" | "earth" | "thunder" | "light" | "dark",
  "specialEffect": "【独自効果名】具体的な効果文（既存テンプレート禁止）",
  "judgeComment": "言葉の歴史的・科学的・文化的背景分析（150字程度、数値の根拠を自然に含めてもよい）",
  "visual": "CSS gradient または色コード"
}
\`\`\`

**Defense の場合：**
\`\`\`json
{
  "role": "Defense",
  "name": "カード名（30字以内）",
  "element": "火" | "水" | "風" | "土" | "雷" | "光" | "闇" | "草" | カスタム,
  "defense": （意味のある不規則な数値、1-99、10の倍数禁止）,
  "attribute": "fire" | "water" | "wind" | "earth" | "thunder" | "light" | "dark",
  "supportMessage": "防御効果の説明（軽減率、持続ターン等、具体的数値を含む）",
  "specialEffect": "【独自効果名】具体的な効果文",
  "judgeComment": "言葉の背景分析（150字程度）",
  "visual": "CSS gradient または色コード"
}
\`\`\`

**Support の場合：**
\`\`\`json
{
  "role": "Support",
  "name": "カード名（30字以内）",
  "element": "火" | "水" | "風" | "土" | "雷" | "光" | "闇" | "草" | カスタム,
  "supportType": "heal" | "hpMaxUp" | "staminaRecover" | "magicRecover" | "defenseBuff" | "poison" | "burn" | "allStatBuff" | "debuff" | "cleanse" | "counter" | "fieldChange" | カスタム,
  "supportMessage": "効果説明（具体的数値必須、意味のある不規則な値）【fieldChange時は「○○属性が1.5倍になる！（Xターン）」形式を厳守】",
  "attribute": "fire" | "water" | "wind" | "earth" | "thunder" | "light" | "dark",
  "fieldEffect": "火" | "水" | "風" | "土" | "雷" | "光" | "闇" | "草" | カスタム属性名 | null（fieldChange時は必ず設定せよ、他はnull）,
  "fieldMultiplier": 1.3-1.5（fieldChange時は必ず1.5を推奨、他は省略可）,
  "fieldTurns": 3-5（fieldChange時は必ず3, 4, 5 などの不規則な値を設定、他は省略可）,
  "specialEffect": "【独自効果名】具体的な効果文",
  "judgeComment": "言葉の背景分析（150字程度）",
  "visual": "CSS gradient または色コード"
}
\`\`\`

---

【厳守事項】
1. 数値は言葉の意味から導出し、10の倍数や5の倍数は原則禁止
2. specialEffect は既存のテンプレートをコピーせず、言葉の本質から創造
3. element はカスタム属性も許可（「金」「魂」「夢」「虚無」等）
4. judgeComment には歴史・科学・文化的背景を含める
5. visual フィールドは必須（CSS gradient または色コード）
6. 天候・環境ワードは必ず supportType: "fieldChange" に設定
7. **【最重要】fieldChange 時は以下を絶対に省略するな：**
   - supportMessage: 「日差しが強まり火属性が1.5倍になる！（4ターン）」のように属性名・倍率・ターン数を明示
   - fieldEffect: 強化される属性名（火/水/風/土/雷/光/闇/草 または カスタム属性名）を必ず設定
   - fieldMultiplier: 1.5 を推奨（省略禁止）
   - fieldTurns: 3, 4, 5 などの不規則な値を必ず設定（省略禁止）
8. 属性判断は言葉の本質から自由に決定せよ（既存の枠に囚われるな）
   - 「霧」→ 水属性、「朝焼け」→ 火属性、「極寒」→ 水属性、「砂嵐」→ 土または風属性
   - その言葉が最も強く連想させる属性を選べ

${intentNote}`;

  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    const result = await model.generateContent(prompt);
    let responseText = result.response.text().trim();
    
    // JSONマークダウン装飾を削除
    responseText = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    
    const cardData = JSON.parse(responseText);

    const role = (cardData.role || 'attack').toLowerCase();
    
    // 役割別の必須フィールドチェック
    if (role === 'attack') {
      if (cardData.attack === undefined || !cardData.specialEffect) {
        throw new Error('Attack: attack と specialEffect は必須');
      }
    } else if (role === 'defense') {
      if (cardData.defense === undefined || !cardData.supportMessage || !cardData.specialEffect) {
        throw new Error('Defense: defense, supportMessage, specialEffect は必須');
      }
    } else if (role === 'support') {
      if (!cardData.supportMessage || !cardData.specialEffect || !cardData.supportType) {
        throw new Error('Support: supportMessage, specialEffect, supportType は必須');
      }
    } else {
      throw new Error(`不正な role: ${role}`);
    }

    let attack = role === 'attack' ? Math.max(0, Math.min(99, Math.round(cardData.attack))) : 0;
    let defense = role === 'defense' ? Math.max(0, Math.min(99, Math.round(cardData.defense))) : 0;
    
    const supportType = cardData.supportType || null;
    const supportMessage = cardData.supportMessage || '';
    // 日本語 element → エンジン属性へマッピング（後方互換で attribute を優先）
    const elementJP = (cardData.element || '').trim();
    const mapElementToAttribute = (el) => {
      switch (el) {
        case '火': return 'fire';
        case '水': return 'water';
        case '風': return 'wind';
        case '土': return 'earth';
        case '雷': return 'thunder';
        case '光': return 'light';
        case '闇': return 'dark';
        case '草': return 'earth'; // 暫定: 草は土にマップ（後で拡張可能）
        default: return null;
      }
    };
    let attribute = (cardData.attribute || '').toLowerCase();
    if (!attribute) {
      const mapped = mapElementToAttribute(elementJP);
      attribute = (mapped || 'earth').toLowerCase();
    }
    const specialEffect = cardData.specialEffect || '【基本効果】標準的な効果';
    const judgeComment = cardData.judgeComment || '判定コメントなし';

    return {
      word: original,
      attribute,
      element: elementJP || undefined,
      attack,
      defense,
      effect: role,
      tier: attack >= 70 || defense >= 70 ? 'mythical' : attack >= 40 || defense >= 40 ? 'weapon' : 'common',
      supportType,
      supportMessage,
      specialEffect,
      judgeComment,
      role,
         // ★【Support時のフィールド常時含有】fieldEffect は fieldChange でなくても常に含める
         ...(role === 'support' ? {
           fieldEffect: (supportType === 'fieldchange' ? cardData.fieldEffect : '') || '',
           fieldMultiplier: (supportType === 'fieldchange' ? cardData.fieldMultiplier : 1.0) || 1.0,
           fieldTurns: (supportType === 'fieldchange' ? cardData.fieldTurns : 0) || 0
         } : {}),
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
      word: word,
      name: word,
      attack: 71,
      attribute,
      element: (attr => ({ fire:'火', water:'水', wind:'風', earth:'土', thunder:'雷', light:'光', dark:'闇' }[attr] || '土'))(attribute),
      specialEffect: '【基本攻撃】入力単語からの標準攻撃',
      judgeComment: 'フォールバック時の汎用攻撃カード。入力単語の特性から独立した基本値として機能。'
    };
  } else if (role === 'defense') {
    return {
      role: 'Defense',
      word: word,
      name: word,
      defense: 67,
      attribute,
      element: (attr => ({ fire:'火', water:'水', wind:'風', earth:'土', thunder:'雷', light:'光', dark:'闇' }[attr] || '土'))(attribute),
      supportMessage: '被ダメージ39%軽減（2ターン有効）',
      specialEffect: '【基本防御】入力単語からの標準防御',
      judgeComment: 'フォールバック時の汎用防御カード。防護性能を重視した基本値として機能。'
    };
  } else {
    // Support
    let supportType = 'heal';
    let supportMessage = 'HP を43回復';
    // フィールド効果のデフォルト初期化（常にスコープ内で定義）
    let fieldEffect = '';
    let fieldMultiplier = 1.0;
    let fieldTurns = 0;
    
    if (/毒|poison|ヘビ|蛇|沼/.test(lower)) {
      supportType = 'poison';
      supportMessage = '相手に毒を付与。3ターン継続、毎ターンHP-7';
    } else if (/焼|灼|焙|熱波|炎炎/.test(lower)) {
      supportType = 'burn';
      supportMessage = '相手に焼けを付与。3ターン継続、毎ターンHP-8';
    } else if (/修行|進化|強鍛|耐性|体質/.test(lower)) {
      supportType = 'hpMaxUp';
      supportMessage = '最大HP +36';
    } else if (/睡眠|瞑想|呼吸|休息|リラック/.test(lower)) {
      supportType = 'staminaRecover';
      supportMessage = 'スタミナを48回復';
    } else if (/祈|秘儀|魔法陣|集中/.test(lower)) {
      supportType = 'magicRecover';
      supportMessage = '魔力を31回復';
    } else if (/堅牢|鉄壁|要塞|強固|不動/.test(lower)) {
      supportType = 'defenseBuff';
      supportMessage = '次ターン被ダメージ-44%';
    } else if (/呪|制限|弱体|縛|衰弱/.test(lower)) {
      supportType = 'debuff';
      supportMessage = '相手の攻撃力 -29';
    } else if (/浄|祓|リセット|清|新生/.test(lower)) {
      supportType = 'cleanse';
      supportMessage = '状態異常をすべてクリア';
    } else if (/反撃|カウンター|先読|受け流|跳ね返/.test(lower)) {
      supportType = 'counter';
      supportMessage = '次ターン受けたダメージを反射';
    } else if (/嵐|地震|津波|竜巻|雷鳴|台風|晴|曇|雨|風|雲|月|光|砂|炎|水|電|冷|冬|夏|春|秋|季節|天候|気候/.test(lower)) {
      supportType = 'fieldChange';
      // 環境判定に基づいて fieldEffect を決定
      fieldEffect = '火';
      fieldMultiplier = 1.5;
      fieldTurns = 3;
      
      if (/晴|太陽|日中|昼間|光|明る|ひ/.test(lower)) {
        fieldEffect = '火';
        fieldMultiplier = 1.5;
        fieldTurns = 4;
        supportMessage = '日差しが強まった！火属性が1.5倍になる！（4ターン）';
      } else if (/雨|水|洪水|豪雨|濡れ|水浸し|雫|潮/.test(lower)) {
        fieldEffect = '水';
        fieldMultiplier = 1.5;
        fieldTurns = 3;
        supportMessage = '大雨が降った！水属性が1.5倍になる！（3ターン）';
      } else if (/砂|砂嵐|砂漠|埃|黄砂|土|地面|大地/.test(lower)) {
        fieldEffect = '土';
        fieldMultiplier = 1.5;
        fieldTurns = 5;
        supportMessage = '砂嵐が吹き荒れる！土属性が1.5倍になる！（5ターン）';
      } else if (/雷|電|雷鳴|雷雲|稲光|ピカッ/.test(lower)) {
        fieldEffect = '雷';
        fieldMultiplier = 1.5;
        fieldTurns = 4;
        supportMessage = '雷が激しくなった！雷属性の威力が1.5倍になる！（4ターン）';
      } else if (/月|夜|暗い|闇|影|星|銀色/.test(lower)) {
        fieldEffect = '光';
        fieldMultiplier = 1.5;
        fieldTurns = 3;
        supportMessage = '月光が射し込む！光属性が1.5倍になる！（3ターン）';
      } else if (/風|空気|大気|そよ風|台風|竜巻/.test(lower)) {
        fieldEffect = '風';
        fieldMultiplier = 1.5;
        fieldTurns = 4;
        supportMessage = '強風が吹き荒れる！風属性が1.5倍になる！（4ターン）';
      } else {
        fieldEffect = '火';
        fieldMultiplier = 1.5;
        fieldTurns = 3;
        supportMessage = 'フィールド効果を発動：該当属性が1.5倍！（3ターン）';
      }
    } else if (/アーサー|ナポレオン|孫子|天才|英雄/.test(lower)) {
      supportType = 'allStatBuff';
      supportMessage = '全ステータス +23（1ターン）';
    } else {
      supportType = 'heal';
      supportMessage = 'HP を43回復';
    }
    
    // Support フォールバック時の fieldChange は外部で fieldEffect を定義
    let fieldEffectData = null;
    let fieldMultiplierData = 1.0;
    let fieldTurnsData = 0;
    
    if (supportType === 'fieldChange') {
      // 既に上で fieldEffect/fieldMultiplier/fieldTurns が決まっている
      fieldEffectData = fieldEffect;
      fieldMultiplierData = fieldMultiplier;
      fieldTurnsData = fieldTurns;
    }
    
    return {
      role: 'Support',
      word: word,
      name: word,
      supportType,
      attribute,
      element: (attr => ({ fire:'火', water:'水', wind:'風', earth:'土', thunder:'雷', light:'光', dark:'闇' }[attr] || '土'))(attribute),
      supportMessage,
      specialEffect: `【${supportType}】フォールバック効果`,
      judgeComment: 'フォールバック時のサポートカード。supportType自動判定から生成。',
      // ★【常に含める】fieldEffect 関連フィールドは undefined でなく、常にデフォルト値を含める
      fieldEffect: supportType === 'fieldChange' ? fieldEffect : '',
      fieldMultiplier: supportType === 'fieldChange' ? fieldMultiplier : 1.0,
      fieldTurns: supportType === 'fieldChange' ? fieldTurns : 0
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
      reservedDefense: 0,              // 前ターンの防御予約値
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
    fieldEffect: null,
    // 永続フィールド情報（属性と残ターンを記憶）
    field: {
      element: null,
      remainingTurns: 0
    },
    // 新しい環境管理オブジェクト
    currentField: {
      name: null,         // 属性名（火、水、雷等）
      multiplier: 1.0,    // 属性威力倍率
      turns: 0,          // 残り持続ターン数
      originalTurns: 0   // 元のターン数（表示用）
    }
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
    p.reservedDefense = 0;
    p.statusAilments = [];
    p.buffs = { atkUp: 0, defUp: 0, allStatUp: 0 };
    p.usedWords.clear();
    p.supportUsed = 0;
  });
  
  room.fieldEffect = null;
  room.field = { element: null, remainingTurns: 0 };
  room.currentField = {
    name: null,
    multiplier: 1.0,
    turns: 0,
    originalTurns: 0
  };

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
  
  // フィールド効果のターン数を減少（旧フィールド効果）
  if (room.fieldEffect && room.fieldEffect.turns && room.fieldEffect.turns > 0) {
    room.fieldEffect.turns--;
    if (room.fieldEffect.turns <= 0) {
      console.log(`🌍 フィールド効果が消滅: ${room.fieldEffect.name}属性バフ終了`);
      room.fieldEffect = null;
    } else {
      console.log(`🌍 フィールド効果継続: ${room.fieldEffect.name}属性 x${room.fieldEffect.multiplier} (残り ${room.fieldEffect.turns}ターン)`);
    }
  }

  // 永続フィールド情報のターン減少
  if (room.field && room.field.remainingTurns && room.field.remainingTurns > 0) {
    room.field.remainingTurns -= 1;
    if (room.field.remainingTurns <= 0) {
      room.field = { element: null, remainingTurns: 0 };
      console.log('🌐 永続フィールドが終了');
    } else {
      console.log(`🌐 永続フィールド継続: ${room.field.element} (残り ${room.field.remainingTurns}ターン)`);
    }
  }
  
  // 新しい環境管理オブジェクトも同時に管理
  if (room.currentField && room.currentField.turns && room.currentField.turns > 0) {
    room.currentField.turns--;
    if (room.currentField.turns <= 0) {
      console.log(`🌐 環境効果が消滅: ${room.currentField.name}属性バフ終了`);
      room.currentField = {
        name: null,
        multiplier: 1.0,
        turns: 0,
        originalTurns: 0
      };
    } else {
      console.log(`🌐 環境効果継続: ${room.currentField.name}属性 x${room.currentField.multiplier} (残り ${room.currentField.turns}ターン)`);
    }
  }
  
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
  try {
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

    // 非同期でカード生成（エラー/タイムアウト時はフォールバック使用）
    generateCardWithTimeout(cleanWord, 'attack', createDefaultAttackCard(cleanWord))
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
      })
      .catch(error => {
        console.error('❌ handlePlayWord 内部エラー:', error);
        // エラー時もデフォルトカードで続行
        const defaultCard = createDefaultAttackCard(cleanWord);
        room.usedWordsGlobal.add(lower);
        attacker.usedWords.add(lower);
        room.pendingAttack = { attackerId: attacker.id, defenderId: defender.id, card: defaultCard };
        room.phase = 'defense';

        io.to(roomId).emit('attackDeclared', {
          attackerId: attacker.id,
          defenderId: defender.id,
          card: defaultCard
        });
        updateStatus(roomId, `${attacker.name} の攻撃！ 防御の言葉を入力してください。`);
      });
  } catch (error) {
    console.error('❌ handlePlayWord エラー:', error);
    socket.emit('errorMessage', { message: '攻撃処理中にエラーが発生しました' });
  }
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
  generateCardWithTimeout(cleanWord, 'defense', generateCardFallback(cleanWord))
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
    
    // 属性相性計算（element優先）
    const atkElem = attackCard.element || attributeToElementJP(attackCard.attribute);
    const defElem = defenseCard.element || attributeToElementJP(defenseCard.attribute);
    const affinity = getAffinityByElement(atkElem, defElem);

    // === Attack vs Defense 標準バトル ===
    if (attackRole === 'attack' && defenseRole === 'defense') {
      console.log('⚔️ 【標準バトル】Attack vs Defense: ダメージ計算フェーズ');
      damage = calculateDamage(attackCard, defenseCard, attacker, defender, false, room);
      // 次ターン用の防御予約（前ターンに確実適用）
      defender.reservedDefense = Number(defenseCard?.defense) || 0;
      defender.hp = Math.max(0, defender.hp - damage);
    }
    
    // === Attack vs Attack 衝突 ===
    else if (attackRole === 'attack' && defenseRole === 'attack') {
      console.log('⚔️ 【衝突】Attack vs Attack: 双方ダメージ');
      damage = calculateDamage(attackCard, defenseCard, attacker, defender, false, room);
      counterDamage = calculateDamage(defenseCard, attackCard, defender, attacker, false, room);
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
      damage = calculateDamage(attackCard, defenseCard, attacker, defender, false, room);
      // Defense ロール（攻撃側）のdifference フィールドは攻撃力がないため最小ダメージ
      defenseRole === 'attack' && 
        ((damage = calculateDamage(attackCard, defenseCard, attacker, defender, false, room)));
      attacker.hp = Math.max(0, attacker.hp - counterDamage);
    }
    
    // === Defense vs Defense: 両防御 ===
    else if (attackRole === 'defense' && defenseRole === 'defense') {
      console.log('🛡️ 【両防御】Defense vs Defense: ダメージなし');
      damage = 0;
      counterDamage = 0;
      // 双方、次ターンに防御値を予約
      attacker.reservedDefense = Number(attackCard?.defense) || 0;
      defender.reservedDefense = Number(defenseCard?.defense) || 0;
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
      damage = calculateDamage(attackCard, defenseCard, attacker, defender, false, room);
      defender.hp = Math.max(0, defender.hp - damage);
    }
    
    // === Support vs Defense: 防御態勢 ===
    else if (attackRole === 'support' && defenseRole === 'defense') {
      console.log('🛡️ 【防御態勢】Support vs Defense: 防御力適用、サポートなし');
      damage = 0;
      // 防御カードの値を次ターンに予約
      defender.reservedDefense = Number(defenseCard?.defense) || 0;
    }
    
    // === Support vs Support: 両者サポート ===
    else if (attackRole === 'support' && defenseRole === 'support') {
      console.log('📦 【相互サポート】Support vs Support: ダメージなし');
      damage = 0;
    }
    
    // === デフォルト（未想定） ===
    else {
      console.log(`⚠️ 未想定の役割組み合わせ: Attack[${attackRole}] vs Defense[${defenseRole}]`);
      damage = calculateDamage(attackCard, defenseCard, attacker, defender, false, room);
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

// =====================================
// 新規カード判定API
// =====================================
app.post('/api/judgeCard', async (req, res) => {
  try {
    const { cardName } = req.body;
    
    if (!cardName || typeof cardName !== 'string' || cardName.trim().length === 0) {
      console.error(`❌ /api/judgeCard: cardName が無効 (受け取り値: ${JSON.stringify(cardName)})`);
      return res.status(400).json({
        error: 'cardName は必須です',
        ...getDefaultCardJudgement('デフォルト')
      });
    }

    const cleanName = cardName.trim();
    console.log(`🃏 カード判定リクエスト: "${cleanName}"`);

    // Gemini APIに投げる
    const aiResponse = await judgeCardByAI(cleanName);
    
    if (!aiResponse || aiResponse.error) {
      console.warn(`⚠️ AI判定失敗 [${cleanName}]: ${aiResponse?.message || '原因不明'} → デフォルト値を返却`);
      return res.json(getDefaultCardJudgement(cleanName));
    }

    // finalValue をそのまま使用（既に0～100の範囲）
    const responseData = {
      success: true,
      cardName: cleanName,
      type: aiResponse.type,
      finalValue: aiResponse.finalValue,
      specialEffectName: aiResponse.specialEffectName,
      specialEffectDescription: aiResponse.specialEffectDescription,
      effectTarget: aiResponse.effectTarget
    };
    
    console.log(`✅ /api/judgeCard 応答完了: ${JSON.stringify(responseData)}`);
    res.json(responseData);

  } catch (error) {
    console.error(`❌ /api/judgeCard エラー: ${error.message}`);
    console.error(`   スタックトレース: ${error.stack}`);
    res.status(500).json({
      error: `サーバーエラー: ${error.message}`,
      ...getDefaultCardJudgement(req.body?.cardName || 'エラー')
    });
  }
});

// Gemini APIでカード判定
async function judgeCardByAI(cardName) {
  const prompt = `【超重要】あなたは JSON 出力専用のゲーム判定エンジンです。

『${cardName}』の言葉の意味を分析し、以下の JSON **のみ** を返してください。

【絶対ルール】
- 出力するのは JSON オブジェクト 1 つだけ
- テキスト説明は一切不要
- マークダウン（\`\`\`json など）で囲まない
- 改行は含めない
- コメントは含めない
- JSON 以外の文字は一切含めない
- 有効な JSON として、JSON.parse() できる形式で返す

【必須キー（すべて必ず含める）】
1. type: "attack" | "defense" | "support"
2. finalValue: 0～100の整数（この値が直接、最終ダメージ/防御力/効果値として使われます）
3. effectTarget: 以下から正確に1つ選択
   - attack の場合：必ず "enemy_hp"
   - defense の場合：必ず "player_defense"
   - support の場合：必ず "player_hp" | "player_attack" | "enemy_attack" | "player_speed" のいずれか
4. specialEffectName: カード固有の特殊効果名（10文字以内、日本語推奨）
5. specialEffectDescription: 効果内容の説明（30文字以内、簡潔に）

【キーのフォーマット】
- キーは必ずダブルクォート（"）で囲む
- シングルクォートは絶対禁止
- 値も必ずダブルクォートで囲む（文字列の場合）
- finalValue は整数のみ（小数点は入れない）

【正確な出力例】（括弧内は説明、出力には含めない）
{"type":"attack","finalValue":65,"effectTarget":"enemy_hp","specialEffectName":"火だるま","specialEffectDescription":"敵を毎ターン燃やす"}
{"type":"support","finalValue":42,"effectTarget":"player_hp","specialEffectName":"聖なる癒やし","specialEffectDescription":"HP を回復"}
{"type":"defense","finalValue":58,"effectTarget":"player_defense","specialEffectName":"絶対障壁","specialEffectDescription":"ダメージを軽減"}

【禁止事項】
❌ \`\`\`json で囲む
❌ 説明文や前置きを加える
❌ 複数行に分割する
❌ シングルクォートを使う
❌ コメントを含める
❌ JSON 以外のテキストを含める
❌ 複数の JSON を返す

以下の言葉を判定し、JSON のみを返してください：「${cardName}」`;

  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    const result = await Promise.race([
      model.generateContent(prompt),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), GEMINI_TIMEOUT_MS))
    ]);
    
    let responseText = result.response.text().trim();
    console.log(`📝 Gemini raw response: ${responseText}`);
    
    // ★【厳密な JSON 抽出】複数のマークダウン装飾パターンに対応
    // 1. ```json...``` ブロックの削除
    responseText = responseText.replace(/```json\n?/gi, '').replace(/```\n?/gi, '');
    
    // 2. HTML タグやその他の装飾を削除（万一に備えて）
    responseText = responseText.replace(/<[^>]*>/g, '');
    
    // 3. 改行・タブを完全に削除（複数行JSON に対応）
    responseText = responseText.replace(/\r?\n/g, '').replace(/\t/g, '');
    
    // 4. 余分なスペースをトリム
    responseText = responseText.trim();
    
    // 5. JSON の前後にあるテキストを削除（"{"と"}"の間だけ抽出）
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      responseText = jsonMatch[0];
    }
    
    console.log(`🔍 Cleaned JSON: ${responseText}`);
    
    // JSON パース
    let parsed;
    try {
      parsed = JSON.parse(responseText);
    } catch (parseError) {
      console.error(`❌ JSON パースエラー: ${parseError.message}`);
      console.error(`   入力文字列: ${responseText}`);
      throw new Error(`JSON パースに失敗: ${parseError.message}`);
    }
    
    // バリデーション：必須キーの確認
    if (!parsed.type || !parsed.finalValue === undefined || !parsed.effectTarget || !parsed.specialEffectName || !parsed.specialEffectDescription) {
      const missing = [];
      if (!parsed.type) missing.push('type');
      if (parsed.finalValue === undefined) missing.push('finalValue');
      if (!parsed.effectTarget) missing.push('effectTarget');
      if (!parsed.specialEffectName) missing.push('specialEffectName');
      if (!parsed.specialEffectDescription) missing.push('specialEffectDescription');
      
      const errorMsg = `❌ 必須キーが不足: ${missing.join(', ')} | パース済み: ${JSON.stringify(parsed)}`;
      console.error(errorMsg);
      throw new Error(errorMsg);
    }
    
    // type のバリデーション
    const validTypes = ['attack', 'defense', 'support'];
    if (!validTypes.includes(parsed.type)) {
      const errorMsg = `❌ 無効な type: "${parsed.type}" (有効値: ${validTypes.join(', ')})`;
      console.error(errorMsg);
      throw new Error(errorMsg);
    }
    
    const finalValue = Math.max(0, Math.min(100, parseInt(parsed.finalValue, 10) || 50));
    
    // effectTarget のバリデーション（厳格な制限）
    const validTargetsByType = {
      'attack': ['enemy_hp'],
      'defense': ['player_defense'],
      'support': ['player_hp', 'player_attack', 'enemy_attack', 'player_speed']
    };
    
    const allowedTargets = validTargetsByType[parsed.type] || [];
    let effectTarget = parsed.effectTarget;
    
    if (!allowedTargets.includes(effectTarget)) {
      const errorMsg = `⚠️ 無効な effectTarget: "${effectTarget}" (type: "${parsed.type}", 有効値: ${allowedTargets.join(', ')}) → デフォルト値を使用`;
      console.warn(errorMsg);
      effectTarget = parsed.type === 'attack' ? 'enemy_hp' 
                   : parsed.type === 'defense' ? 'player_defense' 
                   : 'player_hp';
    }
    
    console.log(`✅ judgeCardByAI 成功: type="${parsed.type}", finalValue=${finalValue}, effectTarget="${effectTarget}", name="${parsed.specialEffectName.substring(0, 10)}"`);
    
    return {
      type: parsed.type,
      finalValue: finalValue,
      specialEffectName: (parsed.specialEffectName || 'カード効果').toString().substring(0, 20),
      specialEffectDescription: (parsed.specialEffectDescription || '特殊効果').toString().substring(0, 50),
      effectTarget: effectTarget
    };
    
  } catch (error) {
    console.error(`❌ judgeCardByAI エラー [${cardName}]: ${error.message}`);
    console.error(`   スタックトレース: ${error.stack}`);
    return { error: true, message: error.message };
  }
}

// デフォルトのカード判定結果
function getDefaultCardJudgement(cardName) {
  const lower = (cardName || '').toLowerCase();
  let type = 'attack';
  let effectTarget = 'enemy_hp';
  let baseValue = 50;
  let specialEffectName = 'デフォルト攻撃';
  let specialEffectDescription = 'カード名から判断して必要なダメージ';
  
  // 簡易的なキーワードマッチング
  if (/盾|防|守|壁|鎧|ガード|防御/.test(lower)) {
    type = 'defense';
    effectTarget = 'player_defense';
    baseValue = 45;
    specialEffectName = '絶対障壁';
    specialEffectDescription = '次の受けるダメージを軽減する';
  } else if (/回復|癒|光|聖|治療|ヒール|HP/.test(lower)) {
    type = 'support';
    effectTarget = 'player_hp';
    baseValue = 40;
    specialEffectName = '聖なる癒やし';
    specialEffectDescription = 'プレイヤーのHPを回復する';
  } else if (/バフ|強化|鼓舞|応援|パワー|アップ|攻撃力/.test(lower)) {
    type = 'support';
    effectTarget = 'player_attack';
    baseValue = 35;
    specialEffectName = '戦闘の鼓舞';
    specialEffectDescription = 'プレイヤーの攻撃力を上昇させる';
  } else if (/晴|雨|雷|風|環境|天候|スピード|速度|速/.test(lower)) {
    type = 'support';
    effectTarget = 'player_speed';
    baseValue = 55;
    specialEffectName = '瞬足の風';
    specialEffectDescription = 'プレイヤーの速度を上昇させる';
  } else if (/弱体|デバフ|敵|減/.test(lower)) {
    type = 'support';
    effectTarget = 'enemy_attack';
    baseValue = 30;
    specialEffectName = '敵勢削弱';
    specialEffectDescription = '敵の攻撃力を減少させる';
  } else {
    // デフォルトは攻撃
    specialEffectName = `${cardName}アタック`;
    specialEffectDescription = `${cardName}の力で敵に攻撃を仕かける`;
  }
  
  // baseValue に (Math.random() * 0.4 + 0.8) を掛けて最終値を算出（±20%の振幅）
  const randomMultiplier = Math.random() * 0.4 + 0.8;
  const finalValue = Math.floor(baseValue * randomMultiplier);
  
  console.log(`⚠️ デフォルトカード使用: ${cardName} -> type=${type}, finalValue=${finalValue}`);
  
  return {
    isDefault: true,
    cardName: cardName,
    type: type,
    finalValue: finalValue,
    specialEffectName: specialEffectName,
    specialEffectDescription: specialEffectDescription,
    effectTarget: effectTarget
  };
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
    try {
      const roomId = socket.data.roomId;
      await handlePlayWord(roomId, socket, word);
    } catch (error) {
      console.error('❌ playWord エラー:', error);
      const roomId = socket.data.roomId;
      const room = rooms.get(roomId);
      if (room && room.started) {
        // エラー時もターンを進める（デフォルトカードで攻撃）
        const attacker = findPlayer(room, socket.id);
        const defender = getOpponent(room, socket.id);
        if (attacker && defender) {
          const defaultCard = createDefaultAttackCard('エラー');
          room.pendingAttack = { attackerId: attacker.id, defenderId: defender.id, card: defaultCard };
          io.to(roomId).emit('attackDeclared', {
            attackerId: attacker.id,
            defenderId: defender.id,
            card: defaultCard
          });
          updateStatus(roomId, `${attacker.name} の攻撃！ 防御の言葉を入力してください。`);
        }
      }
      socket.emit('errorMessage', { message: 'エラーが発生しました。デフォルト行動で続行します。' });
    }
  });

  socket.on('defendWord', async ({ word }) => {
    try {
      const roomId = socket.data.roomId;
      await handleDefend(roomId, socket, word);
    } catch (error) {
      console.error('❌ defendWord エラー:', error);
      const roomId = socket.data.roomId;
      const room = rooms.get(roomId);
      if (room && room.started && room.pendingAttack) {
        // エラー時もターンを進める（デフォルトカードで防御）
        const attacker = findPlayer(room, room.pendingAttack.attackerId);
        const defender = findPlayer(room, socket.id);
        if (attacker && defender) {
          const defaultDefenseCard = createDefaultDefenseCard('エラー');
          const attackCard = room.pendingAttack.card;
          const damage = calculateDamage(attackCard, defaultDefenseCard, attacker, defender, false, room);
          defender.hp = Math.max(0, defender.hp - damage);
          
          const hp = {};
          room.players.forEach(p => { hp[p.id] = p.hp; });
          
          let winnerId = null;
          if (defender.hp <= 0) winnerId = attacker.id;
          
          if (!winnerId) {
            tickBuffEffects(room);
            room.turnIndex = (room.turnIndex + 1) % room.players.length;
          }
          
          room.pendingAttack = null;
          room.phase = 'waiting';
          
          io.to(roomId).emit('battleResult', {
            attackCard,
            defenseCard: defaultDefenseCard,
            attackerId: attacker.id,
            defenderId: defender.id,
            damage,
            hp,
            winnerId,
            nextTurn: winnerId ? null : room.players[room.turnIndex].id
          });
          
          if (!winnerId) {
            const nextPlayer = room.players[room.turnIndex];
            io.to(roomId).emit('turnUpdate', {
              activePlayer: nextPlayer.id,
              activePlayerName: nextPlayer.name,
              turnIndex: room.turnIndex
            });
          }
        }
      }
      socket.emit('errorMessage', { message: 'エラーが発生しました。デフォルト行動で続行します。' });
    }
  });

  socket.on('supportAction', async ({ word }) => {
    try {
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
      const card = await generateCardWithTimeout(cleanWord, 'support', generateCardFallback(cleanWord));
      room.usedWordsGlobal.add(lower);
      player.usedWords.add(lower);
      player.supportUsed++;

      // 【サポート効果の物理的反映】
      // AIが生成した supportType に基づいて、プレイヤーのステータスを実際に変更
      const supportTypeRaw = (card.supportType || '').toLowerCase();
      const supportMessage = card.supportMessage || '';
      const maxHp = player.maxHp || STARTING_HP;
      const opponent = getOpponent(room, socket.id);
      const appliedStatus = [];

      // ★【fieldEffect の安全な初期化】
      let fieldEffect = card.fieldEffect || '';
      let fieldMultiplier = card.fieldMultiplier || 1.0;
      let fieldTurns = card.fieldTurns || 0;
       
      // supportMessage から数値を抽出するヘルパー関数
      const extractNumber = (text, defaultVal = 0) => {
        const match = text.match(/(\d+)/);
        return match ? parseInt(match[1], 10) : defaultVal;
      };

      // 【各サポートタイプの処理】
      switch (supportTypeRaw) {
        case 'heal': {
          // heal: HP即座回復
          const healAmount = extractNumber(supportMessage, 25);
          const actualHeal = Math.min(maxHp - player.hp, healAmount);
          player.hp = Math.min(maxHp, player.hp + healAmount);
          console.log(`🏥 ${player.name}: heal 発動 → HP +${actualHeal} (${player.hp}/${maxHp})`);
          break;
        }
        case 'hpmaxup': {
          // hpMaxUp: 最大HP永続増加
          const gain = extractNumber(supportMessage, 20);
          player.maxHp = Math.min(999, player.maxHp + gain);
          player.hp = Math.min(player.maxHp, player.hp + gain); // 即座にHP回復も
          console.log(`💪 ${player.name}: hpMaxUp 発動 → 最大HP +${gain} (${player.maxHp}), HP +${gain}`);
          break;
        }
        case 'staminarecover': {
          // staminaRecover: スタミナ即座回復
          if (!player.stamina) player.stamina = 0;
          if (!player.maxStamina) player.maxStamina = 100;
          const staminaGain = extractNumber(supportMessage, 37);
          const oldStamina = player.stamina;
          player.stamina = Math.min(player.maxStamina, player.stamina + staminaGain);
          console.log(`⚡ ${player.name}: staminaRecover 発動 → ST +${player.stamina - oldStamina} (${player.stamina}/${player.maxStamina})`);
          break;
        }
        case 'magicrecover': {
          // magicRecover: 魔力即座回復
          if (!player.mp) player.mp = 0;
          if (!player.maxMp) player.maxMp = 100;
          const mpGain = extractNumber(supportMessage, 29);
          const oldMp = player.mp;
          player.mp = Math.min(player.maxMp, player.mp + mpGain);
          console.log(`✨ ${player.name}: magicRecover 発動 → MP +${player.mp - oldMp} (${player.mp}/${player.maxMp})`);
          break;
        }
        case 'defensebuff': {
          // defenseBuff: 防御力強化（次ターン被ダメージ軽減）
          const defIncrease = extractNumber(supportMessage, 34);
          player.defenseBoost = Math.max(player.defenseBoost || 0, defIncrease);
          player.defMultiplier = Math.min(2.0, (player.defMultiplier || 1.0) + (defIncrease / 100));
          if (!player.buffs) player.buffs = {};
          player.buffs.defUp = 2; // 2ターン有効
          console.log(`🛡️ ${player.name}: defenseBuff 発動 → 防御力 +${defIncrease}%, defMultiplier: ${player.defMultiplier.toFixed(2)}x, 2ターン有効`);
          break;
        }
        case 'poison': {
          // poison: 相手へ継続ダメージ毒付与
          if (opponent && opponent.statusAilments) {
            if (opponent.statusAilments.length < 3) {
              const dotValue = extractNumber(supportMessage, 3);
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
              console.log(`☠️ ${opponent.name}: poison 適用 → 毒付与 (3ターン継続, ${dotValue}ダメージ/ターン)`);
            }
          }
          break;
        }
        case 'burn': {
          // burn: 相手へ継続ダメージ焼け付与
          if (opponent && opponent.statusAilments) {
            if (opponent.statusAilments.length < 3) {
              const dotValue = extractNumber(supportMessage, 3);
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
              console.log(`🔥 ${opponent.name}: burn 適用 → 焼け付与 (3ターン継続, ${dotValue}ダメージ/ターン)`);
            }
          }
          break;
        }
        case 'allstatbuff': {
          // allStatBuff: 全ステータス微増（英雄・偉人効果）
          const boost = extractNumber(supportMessage, 19);
          player.atkMultiplier = Math.min(2.0, (player.atkMultiplier || 1.0) + (boost / 100));
          player.defMultiplier = Math.min(2.0, (player.defMultiplier || 1.0) + (boost / 100));
          const healBonus = Math.round(boost * 1.5);
          player.hp = Math.min(maxHp, player.hp + healBonus);
          if (!player.buffs) player.buffs = {};
          player.buffs.allStatUp = 3; // 3ターン有効
          console.log(`👑 ${player.name}: allStatBuff 発動 → 攻撃/防御 +${boost}%, HP +${healBonus}, atkMultiplier: ${player.atkMultiplier.toFixed(2)}x, defMultiplier: ${player.defMultiplier.toFixed(2)}x, 3ターン有効`);
          break;
        }
        case 'debuff': {
          // debuff: 相手の攻撃力/防御力を弱体化
          if (opponent) {
            const debuffAmount = extractNumber(supportMessage, 25);
            opponent.atkMultiplier = Math.max(0.5, (opponent.atkMultiplier || 1.0) - (debuffAmount / 100));
            opponent.defMultiplier = Math.max(0.5, (opponent.defMultiplier || 1.0) - (debuffAmount / 100));
            console.log(`📉 ${opponent.name}: debuff 適用 → 攻撃/防御 -${debuffAmount}% (atkMultiplier: ${opponent.atkMultiplier.toFixed(2)}x, defMultiplier: ${opponent.defMultiplier.toFixed(2)}x)`);
          }
          break;
        }
        case 'cleanse': {
          // cleanse: 自身の状態異常をすべてクリア
          if (!player.statusAilments) player.statusAilments = [];
          const cleansedCount = player.statusAilments.length;
          player.statusAilments = [];
          console.log(`💧 ${player.name}: cleanse 発動 → 状態異常クリア (${cleansedCount}個削除)`);
          break;
        }
        case 'counter': {
          // counter: 反撃・カウンター効果
          player.counterActive = true;
          if (!player.buffs) player.buffs = {};
          player.buffs.counterUp = 2; // 2ターン有効
          console.log(`⚔️ ${player.name}: counter 発動 → カウンター効果有効 (2ターン)`);
          break;
        }
        case 'fieldchange': {
          // fieldChange: 天候や地形の変化
          const fieldElem = card.fieldEffect || '火'; // 属性を抽出（デフォルト火）
          const fieldMult = card.fieldMultiplier || 1.5; // 倍率（デフォルト1.5）
          const fieldTurns = card.fieldTurns || 3; // ターン数（デフォルト3）
          const persistedTurns = Number.isFinite(Number(fieldTurns)) ? Math.max(1, Math.round(Number(fieldTurns))) : (Math.random() < 0.5 ? 3 : 5);
          const fieldElementName = (fieldElem && typeof fieldElem === 'object') ? (fieldElem.name || fieldElem.element || null) : fieldElem;
          
          // 旧フィールド効果（互換性）
          room.fieldEffect = {
            name: fieldElementName,
            multiplier: fieldMult,
            turns: fieldTurns,
            originalTurns: fieldTurns,
            visual: `linear-gradient(135deg, rgba(200, 100, 100, 0.4), rgba(100, 100, 200, 0.4))`
          };
          
          // 新しい環境管理オブジェクト
          room.currentField = {
            name: fieldElementName,
            multiplier: fieldMult,
            turns: fieldTurns,
            originalTurns: fieldTurns
          };

          // 永続フィールド情報に保存
          room.field = {
            element: fieldElementName,
            remainingTurns: persistedTurns
          };
          
          console.log(`🌍 ${player.name}: fieldChange 発動 → フィールド効果発動: ${fieldElem}属性 x${fieldMult} (${fieldTurns}ターン継続)`);
          io.to(roomId).emit('fieldEffectUpdate', { fieldEffect: room.fieldEffect });
          break;
        }
        default: {
          // 未知の supportType → ロギングのみ
          console.log(`⚠️ ${player.name}: 未知のサポートタイプ [${supportTypeRaw}] → ${supportMessage}`);
        }
      }

      // フィールド効果更新
      if (card.fieldEffect && card.fieldEffect.name) {
        room.fieldEffect = card.fieldEffect;
        const persistedTurns = Number.isFinite(Number(card.fieldEffect.fieldTurns || card.fieldTurns))
          ? Math.max(1, Math.round(Number(card.fieldEffect.fieldTurns || card.fieldTurns)))
          : (Math.random() < 0.5 ? 3 : 5);
        const persistedElement = card.fieldEffect.name || card.fieldEffect.element || card.fieldEffect;
        room.field = { element: persistedElement, remainingTurns: persistedTurns };
               // ★【安全な fieldEffect チェック】card.fieldEffect が存在し、かつ文字列か name プロパティを持つ場合のみ適用
               if (supportTypeRaw === 'fieldchange' && (card.fieldEffect || fieldEffect)) {
                 const safeFieldEffect = card.fieldEffect || fieldEffect;
                 const safeFieldMult = card.fieldMultiplier || fieldMultiplier || 1.5;
                 const safeTurns = card.fieldTurns || fieldTurns || 3;
         
                 room.fieldEffect = {
                   name: typeof safeFieldEffect === 'object' ? safeFieldEffect.name : safeFieldEffect,
                   multiplier: safeFieldMult,
                   turns: safeTurns,
                   originalTurns: safeTurns,
                   visual: `linear-gradient(135deg, rgba(200, 100, 100, 0.4), rgba(100, 100, 200, 0.4))`
                 };
                 io.to(roomId).emit('fieldEffectUpdate', { fieldEffect: room.fieldEffect });
               }
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

      // サポートカード情報を構造化（supportMessage の確実な伝送 + 統一フィールド付与）
      const targetMap = {
        'heal': 'player_hp',
        'hpmaxup': 'player_hp',
        'staminarecover': 'player_hp',
        'magicrecover': 'player_hp',
        'defensebuff': 'player_attack',
        'poison': 'enemy_attack',
        'burn': 'enemy_attack',
        'allstatbuff': 'player_attack',
        'debuff': 'enemy_attack',
        'cleanse': 'player_hp',
        'counter': 'player_attack',
        'fieldchange': 'player_attack'
      };
      const effectTargetUnified = targetMap[supportTypeRaw] || 'player_hp';
      const finalValueUnified = extractNumber(supportMessage, 0);

      const cardData = {
        ...card,
        supportMessage: card.supportMessage || '', // 明示的に含める
        word: card.word,
        supportType: card.supportType || '',
        specialEffect: card.specialEffect || '',
        role: card.role || '',
        // ★ 新フォーマット（常に含める）
        type: 'support',
        finalValue: finalValueUnified,
        effectTarget: effectTargetUnified,
        specialEffectName: card.specialEffect || '',
        specialEffectDescription: card.supportMessage || ''
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
    } catch (outerError) {
      console.error('❌ supportAction 外部エラー:', outerError);
      socket.emit('errorMessage', { message: 'エラーが発生しました。' });
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
