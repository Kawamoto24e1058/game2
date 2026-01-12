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
const io = new Server(server, { cors: { origin: '*' } });

// ★【環境変数を優先】Render、Heroku、Vercel対応
const PORT = process.env.PORT || 3000;

// ★ グローバル状態（マッチング・ルーム・初期値）
const waitingQueue = [];
const rooms = new Map();
const passwordRooms = new Map();
const STARTING_HP = 100;
const GEMINI_TIMEOUT_MS = 8000;

const API_KEY = process.env.GEMINI_API_KEY || 'YOUR_API_KEY_HERE';
const genAI = new GoogleGenerativeAI(API_KEY);

// ★【ヘルパー関数：baseValueからRankを算出】
function deriveRankFromValue(baseValue) {
  if (baseValue >= 999) return 'EX';
  if (baseValue >= 96) return 'S';
  if (baseValue >= 86) return 'A';
  if (baseValue >= 61) return 'B';
  if (baseValue >= 31) return 'C';
  if (baseValue >= 11) return 'D';
  return 'E';
}

// ★ フォールバック: 最低限のサポートカードを生成
function createBasicSupportFallback(word = 'サポート') {
  return {
    word,
    name: '予備サポート',
    cardName: '予備サポート',
    rank: 'E',
    attribute: 'light',
    element: '光',
    // 旧/新判定に両対応
    role: 'support',
    effect: 'support',
    type: 'heal',
    cardType: 'heal',
    supportType: 'heal',
    supportMessage: 'AI失敗: HPを30回復',
    specialEffect: '緊急手当',
    effectName: '緊急手当',
    description: 'AIの生成に失敗したため、基本的な手当を行います。',
    creativeDescription: 'AI失敗時の緊急処置。即時にHPを30回復する。',
    mechanicType: 'stat_boost',
    targetStat: 'hp',
    duration: 0,
    logic: { target: 'player', actionType: 'heal', value: 30, duration: 0 },
    // 後続処理のための数値類
    baseValue: 30,
    finalValue: 30,
    hitRate: 100,
    cost: 0
  };
}

// カード生成タイムアウト付きラッパー
async function generateCardWithTimeout(original, role, fallback, timeout = 8000) {
  try {
    const result = await Promise.race([
      generateCard(original, role),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), timeout))
    ]);
    
    // ★【重要：サポートモードの厳格フォールバック/整形】
    if (role === 'support') {
      const isSupportLike = (c) => {
        const t = (c?.cardType || c?.type || '').toLowerCase();
        const r = (c?.role || '').toLowerCase();
        return r === 'support' || t === 'heal' || t === 'buff' || t === 'enchant' || !!c?.supportType;
      };
      if (!isSupportLike(result)) {
        console.warn(`⚠️ AI結果がサポート非適合のため置換: role=${result?.role}, type=${result?.type}`);
        return createBasicSupportFallback(original);
      }
      // 役割・型の整合性を補正し、最低限のフィールドを保証
      result.role = 'support';
      result.effect = 'support';
      if (!result.cardType && result.type) result.cardType = result.type;
      if (!result.type) result.type = result.cardType || 'heal';
      if (!result.supportType) result.supportType = (result.cardType || result.type || 'heal').toLowerCase();
      if (!result.supportMessage && result.supportType === 'heal') {
        result.supportMessage = '基本サポート: HPを30回復';
        if (!result.logic) result.logic = { target: 'player', actionType: 'heal', value: 30, duration: 0 };
      }
      if (!result.effectName && result.specialEffect) result.effectName = result.specialEffect;
      if (!result.effectName) result.effectName = '基本サポート';
      if (typeof result.finalValue !== 'number' || !Number.isFinite(result.finalValue)) {
        result.finalValue = 30;
      }
      if (typeof result.baseValue !== 'number' || !Number.isFinite(result.baseValue)) {
        result.baseValue = result.finalValue;
      }
      return result;
    }
    
    return result;
  } catch (e) {
    console.warn(`⚠️ カード生成失敗（${original}）、フォールバック使用:`, e.message);
    // ★ 役割別の確実なフォールバック
    if (role === 'support') {
      return createBasicSupportFallback(original);
    }
    return fallback || generateCardFallback(original);
  }
}

// =====================================
// JSON抽出ヘルパー関数
// =====================================
function extractJSON(text) {
  // 文字列の中から最初の '{' と 最後の '}' を見つけて切り抜く
  const match = text.match(/\{[\s\S]*\}/);
  return match ? match[0] : null;
}

// ★【AI創作呪文】Gemini APIによる高度なカード生成
async function generateCard(original, role = 'attack') {
  const intentNote = role === 'attack' ? '攻撃カードを生成せよ。' : role === 'defense' ? '防御カードを生成せよ。' : 'サポートカードを生成せよ。';
  
  // ★【重要：サポートモード時の厳格な指示】
  const supportModeNote = role === 'support' ? `
【★重大指示★】
ユーザーは『サポートモード』を選択しました。入力された言葉（例：嵐、剣、爆発）がどれほど攻撃的であっても、直接攻撃ではなく『バフ・デバフ・フィールド効果・回復・強化・弱体化』のいずれかに変換して解釈してください。絶対に「attack」「magic」「summon」を返してはいけません。

【例】
- 『嵐』→ 攻撃ではなく「フィールドを風属性に変える」「相手の命中率を下げる」「自分の素早さを上げる」
- 『剣』→ 攻撃ではなく「自分の攻撃力を上げるバフ効果」
- 『爆発』→ 攻撃ではなく「相手にデバフを付与する」「フィールド効果を発動」
- 『愛』→「回復効果」「全体バフ」「状態異常を治す」

【必須】
- role は必ず "Support" に設定すること
- type は必ず "heal" または "buff" または "enchant" のいずれかに設定すること
- 絶対に "attack", "magic", "summon" を返さないこと
` : '';
  
  // ★【新規：防御モード時のバランス調整】
  const defenseModeNote = role === 'defense' ? `
【★防御モード：バランス調整ルール★】
ユーザーの入力した単語『${original}』から防御カードを生成してください。
ただし、以下のゲームバランス制約を厳守すること：

1. **防御力とコストのトレードオフ**:
   - 強い防御（power: 70～100, ダメージカット率75～95%）ほど、高いコスト（cost: 40～70）を設定すること。
   - 中程度の防御（power: 40～69）なら、cost: 15～39。
   - 弱い防御（power: 10～39）なら、cost: 0～14。

2. **強すぎる言葉へのペナルティ**:
   - 『無敵』『絶対』『完璧』などの強すぎる言葉には、成功率（hitRate）を下げる（例: 30～60%）か、コストを非常に高くするペナルティを与えること。
   - 普通の言葉（『盾』『壁』『銃』）ならhitRate: 85～100%。

3. **データ構造**:
   - type: "defense" (必須)
   - element: "physics" または "earth" (基本)
   - power: 10～100 (防御力を表す)
   - cost: 0～70 (powerに応じて調整)
   - hitRate: 30～100 (強すぎる言葉は低く)
   - role: "Defense" (必須)

4. **具体例**:
   - 『盾』→ power:50, cost:10, hitRate:95
   - 『無敵』→ power:95, cost:60, hitRate:40
   - 『壁』→ power:60, cost:20, hitRate:90
` : '';
  
  const prompt = `【あなたの役割】
あなたはベテランのファンタジーRPGゲームデザイナーです。
入力された言葉の「概念」「物理法則」「ロマン」を解釈し、ゲームデータに変換してください。

【思考プロセス】
1. 「ブラックホール」なら → 威力999だが、cost=100（最大）、hitRate=10（ほぼ当たらない）、属性void（虚無）、type=physics
2. 「ただのパンチ」なら → 威力10、cost=0、hitRate=100、属性physics（物理）
3. 「愛」なら → 威力0、type=heal（回復）、属性light
4. 言葉が持つ「代償」を必ず考慮せよ。タダで最強の力は手に入らない。

${supportModeNote}
${defenseModeNote}

【入力された言葉】
"${original}"

【JSON出力フォーマット】
{
  "cardName": "入力された名前",
  "rank": "EX" | "S" | "A" | "B" | "C" | "D" | "E",
  "element": "fire" | "water" | "wind" | "earth" | "light" | "dark" | "void" | "physics",
  "type": "attack" | "magic" | "heal" | "buff" | "summon" | "enchant" | "defense" | "support",
  "power": 0〜999,
  "cost": 0〜100,
  "hitRate": 0〜100,
  "flavorText": "20文字以内のカッコいい説明文",
  "isForbidden": true | false,
  "role": "Attack" | "Defense" | "Support"
}

【ランク基準】
- EX（規格外）: ブラックホール、無限、神、宇宙創造など物理法則超越（power=999, isForbidden=true, cost=100, hitRate=10）
- S（神話/超越）: 96〜100 例: 創世の光、竜王の咆哮
- A（伝説/最強）: 86〜95 例: 核爆発、隕石落下
- B（強力/強）: 61〜85 例: ミサイル、ドラゴンの炎
- C（実用/中）: 31〜60 例: 鉄の剣、雷撃魔法
- D（一般/弱）: 11〜30 例: 石投げ、小さな火球
- E（ゴミ/最弱）: 1〜10 例: 木の棒、弱い風

【属性ガイド】
- fire: 炎、爆発、熱
- water: 水、氷、流動
- wind: 風、竜巻、気流
- earth: 土、岩、重力
- light: 光、聖、回復
- dark: 闇、呪い、毒
- void: 虚無、消滅、時空歪曲
- physics: 物理攻撃、打撃、切断

【typeガイド】
- attack: 物理攻撃
- magic: 魔法攻撃
- heal: 回復
- buff: 強化
- summon: 召喚
- enchant: 付与
- defense: 防御
- support: サポート

【重要】
- powerが高いほど、costとhitRateにペナルティを課すこと
- flavorTextは必ず20文字以内で、その技の本質を表現すること
- JSON以外の文字は一切出力しないこと

${intentNote}`;

  let responseText = '';
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash-001' });
    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.8, maxOutputTokens: 2048 }
    });
    
    // 生テキスト（デバッグ用に保持）
    responseText = (result?.response?.text?.() || '').trim();
    responseText = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    
    // ★【JSON抽出処理】マークダウンやテキスト装飾を除去してJSONだけを取り出す
    const jsonText = extractJSON(responseText);
    if (!jsonText) {
      console.error('❌ JSONが見つかりませんでした');
      console.log('Raw AI Output:', responseText);
      throw new Error('JSONが見つかりませんでした: ' + responseText.substring(0, 100));
    }
    
    let cardData;
    try {
      cardData = JSON.parse(jsonText);
    } catch (parseErr) {
      console.error('❌ JSON.parse 失敗 (generateCard):', parseErr.message);
      console.log('Raw AI Output:', responseText);
      console.error('   ↳ Extracted JSON:', jsonText);
      // 二重try-catchの内側で失敗: 役割別フォールバック
      if (role === 'support') return createBasicSupportFallback(original);
      if (role === 'defense') {
        // ★【防御モード用フォールバック】標準的な防御カードを返す
        return {
          word: original,
          name: 'とっさの防御',
          cardName: 'とっさの防御',
          role: 'defense',
          effect: 'defense',
          cardType: 'defense',
          type: 'defense',
          element: 'physics',
          attribute: 'earth',
          power: 30,
          defense: 30,
          baseValue: 30,
          finalValue: 30,
          cost: 0,
          hitRate: 100,
          flavorText: 'とっさに身を守る基本防御。',
          specialEffect: '【基本防御】ダメージ30%カット',
          judgeComment: 'AIパース失敗のため標準防御を使用',
          logic: { target: 'self', actionType: 'buff', effect: 'damageReduction', value: 0.3, duration: 1 }
        };
      }
      return {
        word: original,
        name: original,
        role: 'attack',
        effect: 'attack',
        cardType: 'attack',
        attribute: 'earth',
        element: '土',
        baseValue: 10,
        finalValue: 10,
        attack: 10,
        specialEffect: '【基本攻撃】入力単語からの標準攻撃',
        judgeComment: 'AIパース失敗のため最低攻撃値を使用'
      };
    }
    
    // ★【AI創作呪文パラメータ受け取り】
    const cardName = cardData?.cardName || original;
    const rank = (cardData?.rank || 'C').toString().toUpperCase();
    const element = cardData?.element || 'earth';
    const type = cardData?.type || 'attack';
    const power = Math.max(0, Math.min(999, parseInt(cardData?.power) || 50));
    const cost = Math.max(0, Math.min(100, parseInt(cardData?.cost) || 0));
    const hitRate = Math.max(0, Math.min(100, parseInt(cardData?.hitRate) || 95));
    const flavorText = cardData?.flavorText || '【呪文】未知の力';
    const isForbidden = cardData?.isForbidden === true || rank === 'EX';
    
    console.log(`🎴 AI創作カード生成: ${cardName} | Rank ${rank} | Power ${power} | Cost ${cost} | Hit ${hitRate}%`);
    console.log(`   → Element: ${element}, Type: ${type}, Flavor: ${flavorText}`);
    
    // ★【代償システム: costによる命中率補正】
    // cost が高いほど、命中率を下げる（リスク = 報酬）
    let adjustedHitRate = hitRate;
    if (cost > 50) {
      const penalty = Math.floor((cost - 50) * 0.5); // cost 51-100 → 0-25% ペナルティ
      adjustedHitRate = Math.max(10, hitRate - penalty);
      console.log(`   ⚠️ 高コスト補正: Hit ${hitRate}% → ${adjustedHitRate}% (cost ${cost})`);
    }
    
    // ★【Rank EX特殊処理】
    let finalPower = power;
    if (isForbidden || rank === 'EX') {
      finalPower = 999;
      console.log(`   ⚠️ Rank EX検出: ${original} → power=999, cost=100, hitRate=${adjustedHitRate}%`);
    }
    
    // ランダム補正（±3）
    const variance = isForbidden ? 0 : (Math.floor(Math.random() * 7) - 3);
    let finalValue = Math.max(1, Math.min(999, finalPower + variance));
    
    if (!Number.isFinite(finalValue)) finalValue = 50;
    
    // 役割判定（後方互換性のため）
    const cardRole = (cardData?.role || type).toLowerCase();
    const isAttack = cardRole.includes('attack') || type === 'attack' || type === 'magic' || type === 'summon';
    const isDefense = cardRole.includes('defense') || type === 'defense';
    const isSupport = cardRole.includes('support') || type === 'heal' || type === 'buff' || type === 'enchant';
    
    let attack = isAttack ? finalValue : 0;
    let defense = isDefense ? finalValue : 0;
    
    // 属性マッピング（日本語変換）
    const elementMap = {
      fire: '火', water: '水', wind: '風', earth: '土', 
      light: '光', dark: '闇', thunder: '雷',
      void: '虚無', physics: '物理'
    };
    const elementJP = elementMap[element] || '土';
    
    // attributeフィールド（旧システム互換性）
    const legacyAttribute = element === 'void' ? 'dark' : element === 'physics' ? 'earth' : element;
    
    return {
      word: original,
      name: cardName,
      attribute: legacyAttribute,
      element: elementJP,
      attack,
      defense,
      baseValue: finalPower,
      finalValue,
      rank,
      isForbidden,
      // ★【新パラメータ】
      cardType: type,
      power: finalPower,
      cost,
      hitRate: adjustedHitRate,
      flavorText,
      // 旧システム互換
      effect: isSupport ? 'support' : isAttack ? 'attack' : 'defense',
      role: isSupport ? 'support' : isAttack ? 'attack' : 'defense',
      tier: finalValue >= 70 ? 'mythical' : finalValue >= 40 ? 'weapon' : 'common',
      specialEffect: flavorText,
      judgeComment: `AI解析: ${type}タイプ、${elementJP}属性、cost=${cost}`,
      description: `${elementJP} [${type}] Power:${finalValue} Cost:${cost} Hit:${adjustedHitRate}% / ${flavorText}`
    };
  } catch (error) {
    console.error('❌ Gemini API/解析 エラー:', error.message);
    console.error('   ↳ Raw AI text (generateCard):', responseText);
    // 外側try-catchで失敗: 役割別フォールバック
    if (role === 'support') return createBasicSupportFallback(original);
    return {
      word: original,
      name: original,
      role: 'attack',
      effect: 'attack',
      cardType: 'attack',
      attribute: 'earth',
      element: '土',
      baseValue: 10,
      finalValue: 10,
      attack: 10,
      specialEffect: '【基本攻撃】入力単語からの標準攻撃',
      judgeComment: 'AI失敗のため最低攻撃値を使用'
    };
  }
}

/*
  "role": "Attack",
  "name": "カード名（30字以内）",
 
  - water（水）：妨害・浄化・流動・緩和の力。障害を与える効果に使う
  - earth（土）：堅牢・固定・安定。防御や基盤系の属性
  - thunder（雷）：速度・迅速・電撃。スピード感のある効果
  - wind（風）：流動・拡散・疾風。広域効果や移動系に使う
  - dark（闇）：非可視・呪い・影。デバフやネガティブ効果

2. **【タイプ優先順位（絶対に守れ）】** 以下を優先順序で守れ：
  - 「場所・環境・自然現象」を示す単語 → support（field_change）を最優先
  - 「人物・英雄・偉人」 → support（stat_boost）を優先
  - 「破壊・斬撃・爆発」を示す単語 → attack を最優先
  - 「防御・盾・保護」を示す単語 → defense を最優先
  例：『マグマ』→ support(field_change, 火属性), 『閃光』→ support(光属性目くらまし), 『斬撃』→ attack(無属性)

3. **【ランク制（Tier System）で baseValue を必ず決定せよ】**
  - ランクS (神話/超越): 96〜100 例: 創世、神話存在、世界級の力
  - ランクA (伝説/最強): 86〜95  例: 核兵器、エクスカリバー、神の裁き
  - ランクB (強力/強): 61〜85  例: ミサイル、勇者の剣、ドラゴン
  - ランクC (実用/中): 31〜60  例: 鉄の剣、炎の魔法、ライフル
  - ランクD (一般/弱): 11〜30  例: ナイフ、こん棒、練習用の剣
  - ランクE (ゴミ/最弱): 1〜10  例: 木の棒、小石、雑草、空き缶
  **【最重要】ランクEがランクDを超える数値になることは絶対に禁止。格（スケール）を厳守せよ。**
  **【超重要】0.01単位の小数点まで含めて査定せよ（例: attack: 23.47）。**
  - 出力JSONに rank フィールドを必ず含め、S/A/B/C/D/E のいずれかを設定せよ（tier を併記してもよい）。

4. 数値は言葉の意味から導出し、10の倍数や5の倍数は原則禁止
5. specialEffect は既存のテンプレートをコピーせず、言葉の本質から創造
6. element はカスタム属性も許可（「金」「魂」「夢」「虚無」等）
7. judgeComment には歴史・科学・文化的背景を含める
8. visual フィールドは必須（CSS gradient または色コード）
9. 天候・環境ワードは必ず supportType: "fieldChange" に設定
10. **【最重要】fieldChange 時は以下を絶対に省略するな：**
   - supportMessage: 「日差しが強まり火属性が1.5倍になる！（4ターン）」のように属性名・倍率・ターン数を明示
   - fieldEffect: 強化される属性名（火/水/風/土/雷/光/闇/草 または カスタム属性名）を必ず設定
   - fieldMultiplier: 1.5 を推奨（省略禁止）
   - fieldTurns: 3, 4, 5 などの不規則な値を必ず設定（省略禁止）
11. **【超重要：AI効果設計図（logic）】Support 生成時には必ず logic オブジェクトを含めよ：**
   - **target**: "player" または "enemy"（効果対象）を必ず指定
   - **actionType**: "heal" | "buff" | "debuff" | "skip_turn" | "dot"（5種から必ず1つ選択）
   - **targetStat**: "hp" | "atk" | "def" | "spd"（影響するステータス）
   - **value**: 0〜100 の数値（効果の強度）
   - **duration**: 0〜3 のターン数（0=即座、1=1ターン等）
   - **例：「猛毒」** → logic: { target: "enemy", actionType: "dot", targetStat: "hp", value: 15, duration: 3 }
   - **例：「時止め」** → logic: { target: "enemy", actionType: "skip_turn", targetStat: "spd", value: 100, duration: 1 }
   - **例：「鉄壁」** → logic: { target: "player", actionType: "buff", targetStat: "def", value: 50, duration: 2 }
12. **【AI創造的効果名】Support カード生成時には以下を必ず含めよ：**
   - **effectName**: カード名から独自の効果名をAIが創造（既存概念にとらわれるな）
     例：「光」→ 「【聖域光臨】」、「量子」→ 「【確率収束制御】」、「雨」→ 「【水流治癒波】」
   - **creativeDescription**: AIが考えた効果の詳細説明（100-200字、具体的な効果メカニズムを含む）
     例：「対象の全ステータスを量子的に再構成し、3ターンの間、被ダメージを43%軽減する」
   - **mechanicType**: プログラム処理用分類（stat_boost | status_ailment | field_change | turn_manipulation | special）
   - **targetStat**: 影響を与えるステータス（hp | atk | def | spd | field_element | turn_count | special）
   - **duration**: 効果持続ターン数（2, 3, 4, 5 など意味のある不規則な値）
8. 属性判断は言葉の本質から自由に決定せよ（既存の枠に囚われるな）
   - 「霧」→ 水属性、「朝焼け」→ 火属性、「極寒」→ 水属性、「砂嵐」→ 土または風属性
   - その言葉が最も強く連想させる属性を選べ
9. **【AI創造的サポート効果システム】Support カード生成時の特別ルール：**
   - **effectName**: カード名から独自の効果名をAIが創造せよ（既存概念にとらわれるな）
     例：「光」→ 【聖域光臨】、「量子」→ 【確率収束制御】、「雨」→ 【水流治癒波】
   - **creativeDescription**: AIが考えた効果の詳細説明を記述せよ（100-200字、具体的な効果内容を含む）
     例：「対象の全ステータスを量子的に再構成し、3ターンの間、被ダメージを43%軽減する」
   - **mechanicType**: プログラムが処理するための分類。以下から1つ選べ：
     * stat_boost: ステータス強化（HP、攻撃、防御、速度等の数値上昇）
     * status_ailment: 状態異常付与（毒、火傷、麻痺等）
     * field_change: フィールド効果変化（属性強化、環境変化）
     * turn_manipulation: ターン操作（追加行動、スキップ等）
     * special: 上記に当てはまらない特殊効果
   - **targetStat**: 影響を与えるステータス。以下から1つ選べ：
     * hp: HP回復・最大HP増加
     * atk: 攻撃力強化・低下
     * def: 防御力強化・低下
     * spd: 速度強化・低下
     * field_element: フィールド属性変化（mechanicType が field_change の場合に使用）
     * turn_count: ターン数操作
     * special: 特殊効果（上記に当てはまらない場合）
   - **duration**: 効果持続ターン数（2, 3, 4, 5 など意味のある不規則な値）
   - **フィールド効果判定の厳守**: 言葉の定義を厳守せよ（光は光、火は火、雨は水）
     * mechanicType が "field_change" で targetStat が "field_element" の場合、fieldEffect に属性名を必ず設定
     * 例：「光」なら fieldEffect: "光"、mechanicType: "field_change"、targetStat: "field_element"

${intentNote}`;

  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash-001' });
    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 2048
      }
    });
    let responseText = result.response.text().trim();
    
    // JSONマークダウン装飾を削除 + 強力クリーニング
    responseText = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    let cleanText = responseText;
    const firstBrace = cleanText.indexOf('{');
    const lastBrace = cleanText.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1) {
      cleanText = cleanText.substring(firstBrace, lastBrace + 1);
    }
    
    let cardData;
    try {
      cardData = JSON.parse(cleanText);
    } catch (parseErr) {
      console.error('❌ JSON.parse 失敗 (generateCard 強力洗浄後):', parseErr.message);
      console.error('   ↳ Raw AI text:', responseText);
      // 役割別の絶対安全フォールバック（returnせず続行）
      if (role === 'support') {
        cardData = {
          cardName: '予備サポート',
          rank: 'E',
          element: 'light',
          type: 'heal',
          flavorText: 'AI失敗時の緊急処置',
          logic: { target: 'player', actionType: 'heal', value: 30, duration: 0 }
        };
      } else {
        cardData = {
          cardName: 'エラー修復カード',
          rank: 'E',
          element: 'physics',
          type: 'attack',
          power: 10,
          flavorText: 'データの乱れを修正し、物理で殴ることにした。',
          logic: { target: 'enemy', actionType: 'attack' }
        };
      }
    }

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

    // ★【finalValue 動的計算】AI の baseValue に対して変動値を適用
    // 【言葉の規模感に応じた動的 baseValue】：AI が 5～100 の範囲で設定した値を活かす
    // ★【finalValue 計算】AI の baseValue に対して加算型の微小誤差を適用（ランクの壁を越えにくくする）
    // 【言葉の規模感に応じた動的 baseValue】：AI が 5～100 の範囲で設定した値を活かす（小数点含む）
    let baseValue = role === 'attack' ? Math.max(5, Math.min(100, parseFloat(cardData.attack) || 50)) : role === 'defense' ? Math.max(5, Math.min(100, parseFloat(cardData.defense) || 50)) : 50;
    
    // ★【加算型ばらつき】倍率ではなく加算式に変更（-3〜+3）
    const variance = Math.floor(Math.random() * 6) - 3; // -3 ～ +3
    let finalValue = Math.floor(baseValue + variance);
    if (finalValue < 1) finalValue = 1;
    if (finalValue > 100) finalValue = 100;

    // ★【超重要：finalValue 異常値ガード】NaN, Infinity, undefined, null を検知して修正
    if (!Number.isFinite(finalValue) || finalValue === null || finalValue === undefined) {
      console.log(`⚠️ 異常な finalValue を検知: ${finalValue} (baseValue: ${baseValue}) → デフォルト値50に修正します`);
      finalValue = 50;
    }
    // baseValue の異常チェック（念のため）
    if (!Number.isFinite(baseValue) || baseValue === null || baseValue === undefined) {
      console.log(`⚠️ 異常な baseValue を検知: ${baseValue} → デフォルト値50に修正します`);
      baseValue = 50;
      finalValue = 50;
    }

    // ★ ランク決定（AIが返したrank/tierがあれば優先、無ければbaseValueから判定）
    const aiRank = (cardData.rank || cardData.tier || deriveRankFromValue(baseValue)).toString().toUpperCase();
    const cardName = original || cardData.name || cardData.word || 'unknown';
    console.log(`カード: ${cardName} -> ランク判定: ${aiRank} -> 基準値: ${baseValue} -> 最終値: ${finalValue}`);
    
    let attack = role === 'attack' ? finalValue : 0;
    let defense = role === 'defense' ? finalValue : 0;
    
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
    console.log('【属性確認】', cardName, ':', elementJP || attribute);
    const specialEffect = cardData.specialEffect || '【基本効果】標準的な効果';
    const judgeComment = cardData.judgeComment || '判定コメントなし';
    
    // ★【AI創造的サポート効果】新フィールドを取得
    const effectName = cardData.effectName || specialEffect; // effectNameがなければspecialEffectで代用
    const creativeDescription = cardData.creativeDescription || supportMessage; // creativeDescriptionがなければsupportMessageで代用
    const mechanicType = cardData.mechanicType || (supportType === 'fieldChange' ? 'field_change' : 'stat_boost');
    const targetStat = cardData.targetStat || 'hp';
    const duration = cardData.duration || 3;

    return {
      word: original,
      attribute,
      element: elementJP || undefined,
      attack,
      defense,
      baseValue,
      finalValue,
      rank: aiRank,
      effect: role,
      tier: attack >= 70 || defense >= 70 ? 'mythical' : attack >= 40 || defense >= 40 ? 'weapon' : 'common',
      supportType,
      supportMessage,
      specialEffect,
      judgeComment,
      role,
      // ★【AI創造的サポート効果】新フィールドを含める
      ...(role === 'support' ? {
        effectName,
        creativeDescription,
        mechanicType,
        targetStat,
        duration,
        fieldEffect: (supportType === 'fieldChange' || mechanicType === 'field_change') ? (cardData.fieldEffect || '') : '',
        fieldMultiplier: (supportType === 'fieldChange' || mechanicType === 'field_change') ? (cardData.fieldMultiplier || 1.5) : 1.0,
        fieldTurns: (supportType === 'fieldChange' || mechanicType === 'field_change') ? (cardData.fieldTurns || duration || 3) : 0
      } : {}),
      description: `${attribute.toUpperCase()} [${role.toUpperCase()}] ATK:${attack} DEF:${defense} / ${specialEffect}`
    };
  } catch (error) {
    console.error('❌ Gemini API エラー:', error);
    return generateCardFallback(original);
  }
}
*/
function generateCardFallback(word) {
  const lower = word.toLowerCase();
  
  // ★【Rank EX判定】禁断の言葉チェック
  const isForbidden = /ブラックホール|無限|神|宇宙創造|時間停止|全知全能|blackhole|infinity|omnipotent/.test(lower);
  
  // 役割判定ロジック
  let role = 'attack';
  if (/盾|shield|防|鎧|バリア|壁|要塞|城|砦|盔甲/.test(lower)) {
    role = 'defense';
  } else if (/毒|poison|回復|heal|support|サポート|環境|field|薬|医|祈|呪|弱|焼|灼|光|神|英雄|偉人|修行|進化|癒|晴|雨|雷|風|雲|溶岩|マグマ|砂嵐|極寒|灼熱|干ばつ|朝焼け|月光/.test(lower)) {
    role = 'support';
  }
  
  // ★【属性判定】光と火を明確に区別
  let attribute = 'earth';
  if (/light|光|聖|天使|希望|知|知恵/.test(lower)) attribute = 'light'; // 光を最優先
  else if (/fire|炎|爆|熱|マグマ|焼|溶岩/.test(lower)) attribute = 'fire';
  else if (/water|水|海|氷|雨|波/.test(lower)) attribute = 'water';
  else if (/wind|風|竜巻|嵐|翼/.test(lower)) attribute = 'wind';
  else if (/thunder|雷|電|lightning|プラズマ/.test(lower)) attribute = 'thunder';
  else if (/dark|闇|死|呪|影/.test(lower)) attribute = 'dark';
  
  // 役割別フォールバック返却
  if (role === 'attack') {
    // ★【Rank EX対応】禁断の言葉は999、それ以外は通常値
    const baseAttack = isForbidden ? 999 : (30 + Math.floor(Math.random() * 40));
    const variance = isForbidden ? 0 : (Math.floor(Math.random() * 6) - 3);
    let finalAttack = baseAttack + variance;
    if (finalAttack < 1) finalAttack = 1;
    if (finalAttack > 999) finalAttack = 999;
    
    return {
      role: 'Attack',
      word: word,
      name: word,
      baseValue: baseAttack,
      finalValue: finalAttack,
      rank: isForbidden ? 'EX' : deriveRankFromValue(baseAttack),
      isForbidden: isForbidden,
      attack: finalAttack,
      attribute,
      element: (attr => ({ fire:'火', water:'水', wind:'風', earth:'土', thunder:'雷', light:'光', dark:'闇' }[attr] || '土'))(attribute),
      specialEffect: isForbidden ? '【禁断の力】制御不能な破壊力' : '【基本攻撃】入力単語からの標準攻撃',
      judgeComment: isForbidden ? 'Rank EX: 物理法則を超越した概念。使用には高リスクが伴う。' : 'フォールバック時の汎用攻撃カード。入力単語の特性から独立した基本値として機能。'
    };
  } else if (role === 'defense') {
    // ★【Rank EX対応】禁断の言葉は999、それ以外は通常値
    const baseDefense = isForbidden ? 999 : (25 + Math.floor(Math.random() * 40));
    const variance = isForbidden ? 0 : (Math.floor(Math.random() * 6) - 3);
    let finalDefense = baseDefense + variance;
    if (finalDefense < 1) finalDefense = 1;
    if (finalDefense > 999) finalDefense = 999;
    
    return {
      role: 'Defense',
      word: word,
      name: word,
      baseValue: baseDefense,
      finalValue: finalDefense,
      rank: isForbidden ? 'EX' : deriveRankFromValue(baseDefense),
      isForbidden: isForbidden,
      defense: finalDefense,
      attribute,
      element: (attr => ({ fire:'火', water:'水', wind:'風', earth:'土', thunder:'雷', light:'光', dark:'闇' }[attr] || '土'))(attribute),
      supportMessage: isForbidden ? '制御不能な絶対防御' : '被ダメージ軽減効果',
      specialEffect: isForbidden ? '【禁断の盾】物理法則を超えた防御' : '【基本防御】入力単語からの標準防御',
      judgeComment: isForbidden ? 'Rank EX: 時空を歪める防御。使用には高リスクが伴う。' : 'フォールバック時の汎用防御カード。防護性能を重視した基本値として機能。'
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
    
    // ★【AI創造的サポート効果】フォールバック時のデフォルト値を生成
    const effectName = `【${supportType}効果】`;
    const creativeDescription = supportMessage;
    const mechanicType = supportType === 'fieldChange' ? 'field_change' : supportType === 'heal' ? 'stat_boost' : 'special';
    const targetStat = supportType === 'heal' ? 'hp' : supportType === 'fieldChange' ? 'field_element' : 'special';
    const duration = supportType === 'fieldChange' ? fieldTurns : 3;
    
    // ★【Support の baseValue/finalValue も動的化】
    const baseValue = 30 + Math.floor(Math.random() * 30); // 30～60
    const variance = Math.floor(Math.random() * 6) - 3; // -3 ～ +3
    let finalValue = baseValue + variance;
    if (finalValue < 1) finalValue = 1;
    if (finalValue > 100) finalValue = 100;
    
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
      baseValue,
      finalValue,
      rank: deriveRankFromValue(baseValue),
      // ★【常に含める】fieldEffect 関連フィールドは undefined でなく、常にデフォルト値を含める
      fieldEffect: supportType === 'fieldChange' ? fieldEffect : '',
      fieldMultiplier: supportType === 'fieldChange' ? fieldMultiplier : 1.0,
      fieldTurns: supportType === 'fieldChange' ? fieldTurns : 0,
      // ★【AI創造的サポート効果】フォールバック時も新フィールドを含める
      effectName,
      creativeDescription,
      mechanicType,
      targetStat,
      duration
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
      activeEffects: [],               // ★ 持続効果（バフ・デバフ）
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
        allStatUp: 0,
        counterUp: 0
      },
      skipTurns: 0,
      canAction: true
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

// ★ 持続効果（activeEffects）の毎ターン減衰処理
function tickActiveEffects(room, finishedPlayerId) {
  if (!room || !room.players || !finishedPlayerId) return [];
  const p = room.players.find(x => x.id === finishedPlayerId);
  if (!p) return [];
  if (!Array.isArray(p.activeEffects)) p.activeEffects = [];

  const expired = [];
  p.activeEffects.forEach(e => {
    if (typeof e.duration === 'number') {
      e.duration -= 1;
    }
    if (!e.duration || e.duration <= 0) {
      expired.push(e.name || '効果');
    }
  });

  // 期限切れを削除
  p.activeEffects = p.activeEffects.filter(e => e.duration > 0);

  // UI/ログ用に返す
  if (expired.length > 0) {
    return [{ playerId: p.id, expired }];
  }
  return [];
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

    // ★【非同期でカード生成＆エラー時強制進行】
    generateCardWithTimeout(cleanWord, 'attack', createDefaultAttackCard(cleanWord))
      .then(card => {
        try {
          // ★【finalValue の最終チェック】
          if (!Number.isFinite(card.finalValue) || card.finalValue === null || card.finalValue === undefined) {
            console.log(`⚠️ 攻撃カードの finalValue が異常: ${card.finalValue} → 修正します`);
            card.finalValue = card.baseValue || 50;
          }
          if (card.finalValue > 100) card.finalValue = 100;
          if (card.finalValue < 1) card.finalValue = 1;
          
          // ★【MP不足時の救済処理】
          if (!attacker.mp) attacker.mp = 50;
          const cardCost = card.cost || 0;
          let costMessage = '';
          let powerReduction = false;
          
          if (attacker.mp < cardCost) {
            // MP不足：威力半減、MP使い切り
            powerReduction = true;
            card.power = Math.floor((card.power || 0) / 2);
            card.finalValue = Math.floor((card.finalValue || 0) / 2);
            costMessage = `(消費: ${cardCost}, 残MP: 0) ※エネルギー不足により威力が半減した！`;
            attacker.mp = 0;
            console.log(`⚠️ MP不足: ${attacker.name} (MP: ${attacker.mp} < コスト: ${cardCost}) → 威力半減`);
          } else {
            // MP十分：通常消費
            attacker.mp = Math.max(0, attacker.mp - cardCost);
            costMessage = `(消費: ${cardCost}, 残MP: ${attacker.mp})`;
          }
          
          // flavorText にコスト情報を追記
          if (card.flavorText) {
            card.flavorText = `${card.flavorText} ${costMessage}`;
          } else {
            card.flavorText = costMessage;
          }
          
          room.usedWordsGlobal.add(lower);
          attacker.usedWords.add(lower);
          room.pendingAttack = { attackerId: attacker.id, defenderId: defender.id, card };
          room.phase = 'defense';
          // ★【フラグ設定】防御待機中なので、攻撃後のターン交代は「実行しない」
          room.isWaitingForDefense = true;

          // ★【ステータス更新通知】攻撃発動直後にHP/MPを通知
          const statusUpdate = {
            players: room.players.map(p => ({
              id: p.id,
              name: p.name,
              hp: p.hp,
              maxHp: p.maxHp || STARTING_HP,
              mp: p.mp || 50,
              maxMp: p.maxMp || 50
            }))
          };
          io.to(roomId).emit('statusUpdate', statusUpdate);

          io.to(roomId).emit('attackDeclared', {
            attackerId: attacker.id,
            defenderId: defender.id,
            card
          });
          updateStatus(roomId, `${attacker.name} の攻撃！ 防御の言葉を入力してください。`);
        } catch (innerError) {
          console.error('❌ attackDeclared処理中エラー:', innerError);
          // 内部エラーでも強制的にターン進行
          socket.emit('errorMessage', { message: 'エネルギーが暴走して不発になった！（エラー）' });
          
          // エラー時は強制的にターンを進行
          if (room && room.turnIndex !== undefined) {
            room.turnIndex = (room.turnIndex + 1) % room.players.length;
            const nextPlayer = room.players[room.turnIndex];
            room.phase = 'playing';
            updateStatus(roomId, `${nextPlayer?.name || '次のプレイヤー'} のターンです。`);
            io.to(roomId).emit('turnChanged', {
              playerId: nextPlayer?.id,
              playerName: nextPlayer?.name,
              turnIndex: room.turnIndex
            });
          }
        }
      })
      .catch(error => {
        console.error('❌ handlePlayWord 内部エラー:', error);
        // ★【エラー時のクライアント通知＆強制進行】
        socket.emit('errorMessage', { message: 'エネルギーが暴走して不発になった！（エラー）' });
        io.to(roomId).emit('log', { message: '⚠️ エラーが発生しました。ターンを進行します。', type: 'error' });
        
        // エラー時は強制的にターンを進行（相手のターンへ）
        if (room && room.turnIndex !== undefined) {
          advanceTurnIndexWithSkips(room);
          const nextPlayer = room.players[room.turnIndex];
          room.phase = 'playing';
          updateStatus(roomId, `${nextPlayer?.name || '次のプレイヤー'} のターンです。`);
          io.to(roomId).emit('turnChanged', {
            playerId: nextPlayer?.id,
            playerName: nextPlayer?.name
          });
        }
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
  
  // ★【非同期で防御カード生成＆エラー時強制進行】
  generateCardWithTimeout(cleanWord, 'defense', generateCardFallback(cleanWord))
    .then(defenseCard => {
      try {
        console.log('🛡️ 防御カード生成完了:', defenseCard);
        
        // ★【MP不足時の救済処理】
        if (!defender.mp) defender.mp = 50;
        const cardCost = defenseCard.cost || 0;
        let costMessage = '';
        let powerReduction = false;
        
        if (defender.mp < cardCost) {
          // MP不足：防御力半減、MP使い切り
          powerReduction = true;
          defenseCard.defense = Math.floor((defenseCard.defense || 0) / 2);
          if (defenseCard.logic && defenseCard.logic.value) {
            defenseCard.logic.value = Math.max(0.1, defenseCard.logic.value / 2);
          }
          costMessage = `(消費: ${cardCost}, 残MP: 0) ※エネルギー不足により防御力が半減した！`;
          defender.mp = 0;
          console.log(`⚠️ MP不足: ${defender.name} (MP: ${defender.mp} < コスト: ${cardCost}) → 防御力半減`);
        } else {
          // MP十分：通常消費
          defender.mp = Math.max(0, defender.mp - cardCost);
          costMessage = `(消費: ${cardCost}, 残MP: ${defender.mp})`;
        }
        
        // flavorText にコスト情報を追記
        if (defenseCard.flavorText) {
          defenseCard.flavorText = `${defenseCard.flavorText} ${costMessage}`;
        } else {
          defenseCard.flavorText = costMessage;
        }
        
        // ★【防御モード強制処理】AIの判定に関わらず防御成功として扱う
        console.log('🛡️ 防御モード: 強制的に防御用データに上書きします');
        defenseCard.type = "defense";
        defenseCard.cardType = "defense";
        defenseCard.role = "defense";
        defenseCard.effect = "defense";
        defenseCard.element = "physics"; // 属性は物理で固定（汎用性のため）
        defenseCard.power = 0; // 防御に威力は不要
        defenseCard.hitRate = 100; // 絶対に成功させる
        
        // ロジックも防御用に強制固定
        defenseCard.logic = {
          target: "self",
          actionType: "buff",
          effect: "damageReduction",
          value: powerReduction ? 0.25 : 0.5, // MP不足時は25%カット、通常時は50%カット
          duration: 1
        };

        // もしAIが「失敗」系のフレーバーテキストを出していたら書き換える
        if (defenseCard.flavorText && (defenseCard.flavorText.includes("失敗") || defenseCard.flavorText.includes("暴発") || defenseCard.flavorText.includes("暴走"))) {
          defenseCard.flavorText = `${cleanWord}により、堅牢な守りを展開した！`;
        }
        
        // ★【防御カードの finalValue チェック】
        if (!Number.isFinite(defenseCard.finalValue) || defenseCard.finalValue === null || defenseCard.finalValue === undefined) {
          console.log(`⚠️ 防御カードの finalValue が異常: ${defenseCard.finalValue} → 修正します`);
          defenseCard.finalValue = defenseCard.baseValue || 50;
        }
        if (defenseCard.finalValue > 100) defenseCard.finalValue = 100;
        if (defenseCard.finalValue < 1) defenseCard.finalValue = 1;

        room.usedWordsGlobal.add(lower);
        defender.usedWords.add(lower);

        // 【役割別バトルロジック】 - 文字列ベースの役割判定
        const attackRole = (attackCard.role || '').toLowerCase();
        const defenseRole = (defenseCard.role || '').toLowerCase();
        
        let damage = 0;
        let counterDamage = 0;
        let dotDamage = 0;
        let isCritical = false;
        let affinity = null;
        let defenseFailed = false;
        const appliedStatus = [];
        const attackerMaxHp = attacker.maxHp || STARTING_HP;
        const defenderMaxHp = defender.maxHp || STARTING_HP;
        
        // 属性相性計算（element優先）
        const atkElem = attackCard.element || attributeToElementJP(attackCard.attribute);
        const defElem = defenseCard.element || attributeToElementJP(defenseCard.attribute);
        affinity = getAffinityByElement(atkElem, defElem);

        // ★【Rank EX特殊処理: 10%命中、90%自爆】
        if (attackCard.isForbidden === true || attackCard.rank === 'EX') {
          console.log('⚠️ Rank EX発動判定:', attackCard.word || attackCard.name);
          const hitRoll = Math.random();
          const didHit = hitRoll < 0.1; // 10%の確率で成功
          
          if (!didHit) {
            // 90%の確率で自爆: 自分のHPが50%減る
            const backlashDamage = Math.floor(attacker.hp * 0.5);
            attacker.hp = Math.max(0, attacker.hp - backlashDamage);
            attackCard.finalValue = 0;
            attackCard.attack = 0;
            attackCard.hitLog = '⚡ 禁断の力が暴走した！自らに反動ダメージ！';
            attackCard.backlashDamage = backlashDamage;
            console.log(`💥 Rank EX自爆: ${backlashDamage}ダメージ (${attacker.hp}HP残存)`);
            
            // 自爆で死亡した場合、相手の勝利
            if (attacker.hp <= 0) {
              const hp = {};
              room.players.forEach(p => { hp[p.id] = p.hp; });
              io.to(roomId).emit('turnResolved', {
                attackerId: attacker.id,
                defenderId: defender.id,
                attackCard,
                defenseCard: null,
                damage: 0,
                counterDamage: 0,
                dotDamage: 0,
                affinity: null,
                hp,
                defenseFailed: false,
                appliedStatus: [],
                fieldEffect: room.fieldEffect,
                statusTick: {},
                nextTurn: null,
                winnerId: defender.id,
                backlashDamage
              });
              updateStatus(roomId, `${defender.name} の勝利！（相手が自爆）`);
              room.pendingAttack = null;
              return;
            }
          } else {
            // 10%の確率で成功: 999ダメージ確定
            attackCard.finalValue = 999;
            attackCard.attack = 999;
            attackCard.hitLog = '🔥 禁断の力が発動！圧倒的破壊力！';
            console.log('🔥 Rank EX命中: 999ダメージ確定');
          }
          
          attackCard.hitRate = 0.1;
          attackCard.critRate = 0;
        }
        // ★【AI創作呪文: hitRateによる命中判定】
        else if (attackRole === 'attack') {
          let hitLog = attackCard.hitLog || '';
          
          // ★【AI指定のhitRateを優先使用】
          const aiHitRate = attackCard.hitRate;
          const normalizedRank = String(attackCard.rank || attackCard.tier || 'C').toUpperCase();
          
          // デフォルト命中率（ランクベース）
          const hitRateMap = { S: 0.6, A: 0.6, B: 0.8, C: 0.95, D: 1.0, E: 1.0 };
          const critRateMap = { S: 0.1, A: 0.1, B: 0.1, C: 0.1, D: 0.3, E: 0.3 };
          
          // ★【AI創作呪文: hitRateがあればそれを使用、なければランクベース】
          let hitRate = aiHitRate !== undefined ? (aiHitRate / 100) : (hitRateMap[normalizedRank] ?? hitRateMap.C);
          const critRate = critRateMap[normalizedRank] ?? 0.1;
          
          console.log(`🎯 命中判定: Rank ${normalizedRank}, AI hitRate=${aiHitRate}%, 最終=${Math.floor(hitRate * 100)}%`);

          const baseAttackVal = Number(attackCard.finalValue ?? attackCard.attack ?? 0);
          const hitRoll = Math.random();
          const didHit = hitRoll < hitRate;

          if (!didHit) {
            attackCard.finalValue = 0;
            attackCard.attack = 0;
            hitLog = 'ミス！攻撃が当たらなかった！';
          } else {
            const critRoll = Math.random();
            const isCrit = critRoll < critRate;
            if (isCrit) {
              const boosted = Math.round(baseAttackVal * 1.5);
              const clamped = Math.min(100, Math.max(0, boosted));
              attackCard.finalValue = clamped;
              attackCard.attack = clamped;
              hitLog = 'クリティカルヒット！';
            } else {
              attackCard.finalValue = baseAttackVal;
              attackCard.attack = baseAttackVal;
              hitLog = 'ヒット';
            }
          }

          attackCard.hitRate = hitRate;
          attackCard.critRate = critRate;
          attackCard.hitLog = hitLog;
          console.log('🎯 命中判定', { rank: normalizedRank, hitRate, critRate, hitRoll, hitLog, finalValue: attackCard.finalValue });
        }

        // === Attack vs Defense 標準バトル ===
        if (attackRole === 'attack' && defenseRole === 'defense') {
          console.log('⚔️ 【標準バトル】Attack vs Defense: ダメージ計算フェーズ');
          const dmgResult = calculateDamage(attackCard, defenseCard, attacker, defender, false, room);
          damage = dmgResult.damage;
          affinity = dmgResult.affinity;
          isCritical = dmgResult.isCritical;
          // 次ターン用の防御予約（前ターンに確実適用）
          defender.reservedDefense = Number(defenseCard?.defense) || 0;
          defender.hp = Math.max(0, defender.hp - damage);
        }
        
        // === Attack vs Attack 衝突 ===
        else if (attackRole === 'attack' && defenseRole === 'attack') {
          console.log('⚔️ 【衝突】Attack vs Attack: 双方ダメージ');
          const dmgResult1 = calculateDamage(attackCard, defenseCard, attacker, defender, false, room);
          damage = dmgResult1.damage;
          const dmgResult2 = calculateDamage(defenseCard, attackCard, defender, attacker, false, room);
          counterDamage = dmgResult2.damage;
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
          const dmgResult = calculateDamage(attackCard, defenseCard, attacker, defender, false, room);
          damage = dmgResult.damage;
          // Defense ロール（攻撃側）のdifference フィールドは攻撃力がないため最小ダメージ
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
          const dmgResult = calculateDamage(attackCard, defenseCard, attacker, defender, false, room);
          damage = dmgResult.damage;
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

        const hp = {};
        room.players.forEach(p => { hp[p.id] = p.hp; });

        const players = room.players.map(p => ({
          id: p.id,
          name: p.name,
          hp: p.hp,
          maxHp: p.maxHp || STARTING_HP,
          statusAilments: p.statusAilments || [],
          activeEffects: p.activeEffects || []
        }));

        // ターン開始時の状態異常処理
        const statusTick = tickStatusEffects(room);

        // ★【修正】防御完了後のターン交代処理
        if (!winnerId) {
          tickBuffEffects(room);
          
          // ★【重要】防御側が次の攻撃者になるようターン交代
          // 防御側のインデックスを新しいターンインデックスとする
          room.turnIndex = room.players.findIndex(p => p.id === defender.id);
          room.phase = 'playing';
          
          // 現在のターン開始プレイヤーの持続効果を減衰
          const effectsExpired = tickActiveEffects(room, defender.id);
          
          console.log(`🔄 防御完了後のターン交代: 次は ${room.players[room.turnIndex].name} (防御側) のターン`);
          
          // ★【フラグクリア】防御待機終了
          room.isWaitingForDefense = false;
        }

        // ★ finishedIndex計算（ターン交代後）
        const finishedIndex = (room.turnIndex - 1 + room.players.length) % room.players.length;
        const finishedPlayerId = room.players[finishedIndex]?.id;
        const effectsExpired = tickActiveEffects(room, finishedPlayerId);

        // ★【ステータス更新通知】アクション直後にHP/MP情報を送信
        const statusUpdate = {
          players: room.players.map(p => ({
            id: p.id,
            name: p.name,
            hp: p.hp,
            maxHp: p.maxHp || STARTING_HP,
            mp: p.mp || 50,
            maxMp: p.maxMp || 50
          }))
        };
        io.to(roomId).emit('statusUpdate', statusUpdate);

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
          winnerId,
          effectsExpired,
          hitLog: attackCard.hitLog || hitLog || '',
          isWeakness: affinity?.isWeakness || false,
          isResistance: affinity?.isResistance || false,
          isCritical: isCritical || false,
          element: affinity?.element || 'physics'
        });

        console.log('✅ ターン解決完了:', { damage, counterDamage, dotDamage, winnerId, nextTurn: room.players[room.turnIndex]?.id, appliedStatus });
        
        // ★【必須】ゲーム継続中の場合、turnChangedイベントを送信してUIを更新（ターン交代を確実に反映）
        if (!winnerId) {
          const nextPlayer = room.players[room.turnIndex];
          const logMsg = `${nextPlayer.name} のターンです。`;
          updateStatus(roomId, logMsg);
          
          // ★【重要】全プレイヤーに対してターン更新を通知
          io.to(roomId).emit('turnUpdate', {
            playerId: nextPlayer.id,
            playerName: nextPlayer.name,
            turnIndex: room.turnIndex,
            message: logMsg
          });
          
          // 後方互換性のため turnChanged も送信
          io.to(roomId).emit('turnChanged', {
            playerId: nextPlayer.id,
            playerName: nextPlayer.name,
            turnIndex: room.turnIndex
          });
          
          console.log(`📢 turnUpdate イベント送信: 次ターンプレイヤー = ${nextPlayer.name} (ID: ${nextPlayer.id}, Index: ${room.turnIndex})`);
        }
      } catch (innerError) {
        console.error('❌ 防御処理中エラー:', innerError);
        // ★【エラー時のクライアント通知＆強制進行】
        socket.emit('errorMessage', { message: 'エネルギーが暴走して不発になった！（エラー）' });
        io.to(roomId).emit('log', { message: '⚠️ 防御処理でエラーが発生しました。ターンを進行します。', type: 'error' });
        
        // エラー時は強制的にターンを進行（相手のターンへ）
        if (room && room.turnIndex !== undefined) {
          advanceTurnIndexWithSkips(room);
          const nextPlayer = room.players[room.turnIndex];
          room.phase = 'playing';
          updateStatus(roomId, `${nextPlayer?.name || '次のプレイヤー'} のターンです。`);
          io.to(roomId).emit('turnChanged', {
            playerId: nextPlayer?.id,
            playerName: nextPlayer?.name
          });
        }
      }
    })
}

function removeFromWaiting(socketId) {
  // 待機プレイヤーリストから削除
  const idx = waitingQueue.findIndex(p => p.socket.id === socketId);
  if (idx >= 0) {
    const removed = waitingQueue.splice(idx, 1)[0];
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
    players: waitingQueue.map(p => ({ id: p.socket.id, name: p.name })),
    canStart: false,
    hostId: null
  };
  waitingQueue.forEach(p => p.socket.emit('waitingUpdate', payload));
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
  const prompt = `【超重要】あなたは JSON 出力専用のゲーム判定エンジンです。必ず以下の指示に従え：

【属性・タイプの厳格ガイドライン】
1. **属性定義（絶対に混同するな）**：
   - light（光）：聖なる回復・浄化・希望の力（火と混同禁止）
   - fire（火）：破壊・爆発・熱による加害（光と区別）
   - water（水）：妨害・浄化・流動・緩和
   - earth（土）：堅牢・安定・基盤
   - thunder（雷）：速度・迅速・電撃
   - wind（風）：流動・拡散・疾風
   - dark（闇）：非可視・呪い・影

2. **タイプ判定の優先順位**：
   - 「場所・環境・自然現象」→ support（field_change）最優先
   - 「人物・英雄」→ support（stat_boost）優先
   - 「破壊・斬撃・爆発」→ attack 優先
   - 「防御・盾」→ defense 優先
   例：『マグマ』→support(field_change,火), 『閃光』→support(光目くらまし), 『斬撃』→attack(無属性)

【JSON 形式（絶対に守れ）】

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
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash-001' });
    const result = await Promise.race([
      model.generateContent({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 1024
        }
      }),
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
  
  // ★【finalValue 動的計算】baseValue に対して (0.8 + Math.random() * 0.4) を掛ける
  const randomMultiplier = 0.8 + Math.random() * 0.4; // 0.8 ～ 1.2
  const finalValue = Math.floor(baseValue * randomMultiplier);
  
  console.log(`⚠️ デフォルトカード使用: ${cardName} -> type=${type}, baseValue=${baseValue}, finalValue=${finalValue}`);
  
  return {
    isDefault: true,
    cardName: cardName,
    type: type,
    baseValue: baseValue,
    finalValue: finalValue,
    specialEffectName: specialEffectName,
    specialEffectDescription: specialEffectDescription,
    effectTarget: effectTarget
  };
}

// =====================================
// デフォルトカード生成ヘルパー関数
// =====================================

// 攻撃用のデフォルトカード生成
function createDefaultAttackCard(word) {
  return {
    word: word || "ミス",
    name: word || "ミス",
    cardName: word || "ミス",
    rank: "E",
    element: "physics",
    attribute: "earth",
    type: "attack",
    cardType: "attack",
    role: "attack",
    effect: "attack",
    power: 10,
    attack: 10,
    baseValue: 10,
    finalValue: 10,
    cost: 0,
    hitRate: 100,
    flavorText: "解析不能により、弱々しい物理攻撃が発生した。",
    specialEffect: "【基本攻撃】解析失敗時の最低攻撃",
    judgeComment: "デフォルトカード: AI生成失敗のため最低値を使用",
    logic: { target: "enemy", actionType: "attack" }
  };
}

// 防御用のデフォルトカード生成
function createDefaultDefenseCard(word) {
  return {
    word: word || "防御",
    name: word || "防御",
    cardName: word || "防御",
    rank: "E",
    element: "earth",
    attribute: "earth",
    type: "defense",
    cardType: "defense",
    role: "defense",
    effect: "defense",
    defense: 15,
    baseValue: 15,
    finalValue: 15,
    cost: 0,
    hitRate: 100,
    flavorText: "解析不能により、弱々しい防御が発生した。",
    specialEffect: "【基本防御】解析失敗時の最低防御",
    supportMessage: "被ダメージを少し軽減",
    judgeComment: "デフォルトカード: AI生成失敗のため最低値を使用"
  };
}

// サポート用のデフォルトカード生成
function createDefaultSupportCard(word) {
  return {
    word: word || "手当",
    name: word || "手当",
    cardName: word || "手当",
    rank: "E",
    element: "light",
    attribute: "light",
    type: "heal",
    cardType: "heal",
    role: "support",
    effect: "support",
    supportType: "heal",
    supportMessage: "HPを30回復",
    baseValue: 30,
    finalValue: 30,
    cost: 0,
    hitRate: 100,
    effectName: "応急処置",
    specialEffect: "【基本回復】解析失敗時の最低回復",
    flavorText: "解析不能により、最低限の回復を行います。",
    creativeDescription: "AI失敗時の緊急処置。即時にHPを30回復する。",
    mechanicType: "stat_boost",
    targetStat: "hp",
    duration: 0,
    judgeComment: "デフォルトカード: AI生成失敗のため最低値を使用",
    logic: { target: "player", actionType: "heal", value: 30, duration: 0 }
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
          stamina: 100,
          maxStamina: 100,
          mp: 50,
          maxMp: 50,
          usedWords: new Set(),
          isHost: false,
          supportUsed: 0,
          attackBoost: 0,
          defenseBoost: 0,
          atkMultiplier: 1.0,
          defMultiplier: 1.0,
          reservedDefense: 0,
          statusAilments: [],
          activeEffects: [],
          buffs: { atkUp: 0, defUp: 0, allStatUp: 0, counterUp: 0 },
          skipTurns: 0,
          canAction: true
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
    if (waitingQueue.length > 0) {
      const opponent = waitingQueue.shift();
      createRoom([opponent, playerEntry], 'random', null);
    } else {
      waitingQueue.push(playerEntry);
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
          const dmgResult = calculateDamage(attackCard, defaultDefenseCard, attacker, defender, false, room);
          const damage = dmgResult.damage;
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

      const statusTick = tickStatusEffects(room);
      const tickWinner = room.players.find(p => p.hp <= 0);
      if (tickWinner) {
        const survivor = room.players.find(p => p.hp > 0);
        const hpTick = {}; room.players.forEach(p => { hpTick[p.id] = p.hp; });
        const playersTick = room.players.map(p => ({ id: p.id, name: p.name, hp: p.hp, maxHp: p.maxHp || STARTING_HP, statusAilments: p.statusAilments || [], activeEffects: p.activeEffects || [] }));
        io.to(roomId).emit('supportUsed', { playerId: player.id, card: null, hp: hpTick, players: playersTick, supportRemaining: 3 - player.supportUsed, winnerId: survivor?.id || null, nextTurn: null, appliedStatus: [], fieldEffect: room.fieldEffect, fieldState: room.fieldState, statusTick, effectsExpired: [] });
        updateStatus(roomId, `${(survivor?.name || tickWinner.name)} の勝利！`);
        return;
      }

      if (player.supportUsed >= 3) { socket.emit('errorMessage', { message: 'サポートは1試合に3回までです' }); return; }

      const cleanWord = (word || '').trim();
      if (!cleanWord) { socket.emit('errorMessage', { message: '言葉を入力してください' }); return; }
      const lower = cleanWord.toLowerCase();
      if (room.usedWordsGlobal.has(lower) || player.usedWords.has(lower)) { socket.emit('errorMessage', { message: 'その言葉は既に使用されています' }); return; }

      try {
        const card = await generateCardWithTimeout(cleanWord, 'support', generateCardFallback(cleanWord));
        if (card.baseValue && !Number.isFinite(card.baseValue)) { card.baseValue = 50; }

        // ★【MP不足時の救済処理】
        if (!player.mp) player.mp = 50;
        const cardCost = card.cost || 0;
        let costMessage = '';
        let powerReduction = false;
        
        if (player.mp < cardCost) {
          // MP不足：効果値半減、MP使い切り
          powerReduction = true;
          card.baseValue = Math.floor((card.baseValue || 0) / 2);
          card.finalValue = Math.floor((card.finalValue || 0) / 2);
          costMessage = `(消費: ${cardCost}, 残MP: 0) ※エネルギー不足により効果が半減した！`;
          player.mp = 0;
          console.log(`⚠️ MP不足: ${player.name} (MP: ${player.mp} < コスト: ${cardCost}) → 効果半減`);
        } else {
          // MP十分：通常消費
          player.mp = Math.max(0, player.mp - cardCost);
          costMessage = `(消費: ${cardCost}, 残MP: ${player.mp})`;
        }
        
        // supportMessage にコスト情報を追記
        if (card.supportMessage) {
          card.supportMessage = `${card.supportMessage} ${costMessage}`;
        } else {
          card.supportMessage = costMessage;
        }

        // ★【重要：サポートモード確認】
        console.log(`🎯 supportAction実行: word="${cleanWord}", card.type="${card.cardType || card.type}", card.role="${card.role}"`);
        
        // ★【強制確認】サポートモード時はHP削減を絶対に禁止
        const isSupportMode = card.role === 'support' || (card.cardType || card.type) === 'heal' || (card.cardType || card.type) === 'buff' || (card.cardType || card.type) === 'enchant';
        if (!isSupportMode) {
          console.error(`⚠️ サポートモード異常: card.type="${card.cardType || card.type}" はサポートではありません。強制的にsupport型に変換します`);
          card.role = 'support';
          card.effect = 'support';
          card.cardType = 'buff';
          card.type = 'buff';
        }

        room.usedWordsGlobal.add(lower);
        player.usedWords.add(lower);
        player.supportUsed++;

        const opponent = getOpponent(room, socket.id);
        const appliedStatus = [];
        const maxHp = player.maxHp || STARTING_HP;
        
        // ★【HP操作ガード：プレイヤーのHP初期値をバックアップ】
        const playerHpBeforeSupport = player.hp;
        const opponentHpBeforeSupport = opponent?.hp || 0;

        const extractNumber = (text, defaultVal = 0) => {
          if (!text || typeof text !== 'string') return defaultVal;
          const m = text.match(/(\d+)/);
          return m ? parseInt(m[1], 10) : defaultVal;
        };

        let aiEffectResult = { message: '', appliedStatus: [], activeEffects: [] };
        if (card?.logic && typeof card.logic === 'object') {
          const meta = { effectName: card?.effectName || card?.specialEffect || 'AI効果', description: card?.creativeDescription || '' };
          try {
            aiEffectResult = applyAiEffect(player, opponent, card.logic, meta);
            appliedStatus.push(...(aiEffectResult?.appliedStatus || []));
          } catch (e) {
            console.error('❌ applyAiEffect 実行エラー:', e.message);
          }
        }

        const supportTypeRaw = (card?.supportType || '').toLowerCase();
        const supportMessage = card?.supportMessage || '';

        switch (supportTypeRaw) {
          case 'heal': {
            const healAmount = extractNumber(supportMessage, 25);
            const actualHeal = Math.min(maxHp - player.hp, healAmount);
            player.hp = Math.min(maxHp, player.hp + healAmount);
            break;
          }
          case 'hpmaxup': {
            const gain = extractNumber(supportMessage, 20);
            player.maxHp = Math.min(999, player.maxHp + gain);
            player.hp = Math.min(player.maxHp, player.hp + gain);
            break;
          }
          case 'staminarecover': {
            if (!player.stamina) player.stamina = 0;
            if (!player.maxStamina) player.maxStamina = 100;
            const staminaGain = extractNumber(supportMessage, 37);
            const oldStamina = player.stamina;
            player.stamina = Math.min(player.maxStamina, player.stamina + staminaGain);
            break;
          }
          case 'magicrecover': {
            if (!player.mp) player.mp = 0;
            if (!player.maxMp) player.maxMp = 100;
            const mpGain = extractNumber(supportMessage, 29);
            const oldMp = player.mp;
            player.mp = Math.min(player.maxMp, player.mp + mpGain);
            break;
          }
          case 'defensebuff': {
            const defIncrease = extractNumber(supportMessage, 34);
            player.defenseBoost = Math.max(player.defenseBoost || 0, defIncrease);
            player.defMultiplier = Math.min(2.0, (player.defMultiplier || 1.0) + (defIncrease / 100));
            if (!player.buffs) player.buffs = {};
            player.buffs.defUp = 2;
            break;
          }
          case 'poison': {
            if (opponent && opponent.statusAilments) {
              if (opponent.statusAilments.length < 3) {
                const dotValue = extractNumber(supportMessage, 3);
                opponent.statusAilments.push({ name: '毒', turns: 3, effectType: 'dot', value: dotValue });
                appliedStatus.push({ targetId: opponent.id, name: '毒', turns: 3, effectType: 'dot', value: dotValue });
              }
            }
            break;
          }
          case 'burn': {
            if (opponent && opponent.statusAilments) {
              if (opponent.statusAilments.length < 3) {
                const dotValue = extractNumber(supportMessage, 3);
                opponent.statusAilments.push({ name: '焼け', turns: 3, effectType: 'dot', value: dotValue });
                appliedStatus.push({ targetId: opponent.id, name: '焼け', turns: 3, effectType: 'dot', value: dotValue });
              }
            }
            break;
          }
          case 'allstatbuff': {
            const boost = extractNumber(supportMessage, 19);
            player.atkMultiplier = Math.min(2.0, (player.atkMultiplier || 1.0) + (boost / 100));
            player.defMultiplier = Math.min(2.0, (player.defMultiplier || 1.0) + (boost / 100));
            const healBonus = Math.round(boost * 1.5);
            player.hp = Math.min(maxHp, player.hp + healBonus);
            if (!player.buffs) player.buffs = {};
            player.buffs.allStatUp = 3;
            break;
          }
          case 'debuff': {
            if (opponent) {
              const debuffAmount = extractNumber(supportMessage, 25);
              opponent.atkMultiplier = Math.max(0.5, (opponent.atkMultiplier || 1.0) - (debuffAmount / 100));
              opponent.defMultiplier = Math.max(0.5, (opponent.defMultiplier || 1.0) - (debuffAmount / 100));
            }
            break;
          }
          case 'cleanse': {
            if (!player.statusAilments) player.statusAilments = [];
            const cleansedCount = player.statusAilments.length;
            player.statusAilments = [];
            break;
          }
          case 'counter': {
            player.counterActive = true;
            if (!player.buffs) player.buffs = {};
            player.buffs.counterUp = 2;
            break;
          }
          case 'fieldchange': {
            const fieldElem = card.fieldEffect || '火';
            const fieldMult = card.fieldMultiplier || 1.5;
            const fieldTurns = card.fieldTurns || 3;
            const persistedTurns = Number.isFinite(Number(fieldTurns)) ? Math.max(1, Math.round(Number(fieldTurns))) : (Math.random() < 0.5 ? 3 : 5);
            const fieldElementName = (fieldElem && typeof fieldElem === 'object') ? (fieldElem.name || fieldElem.element || null) : fieldElem;
            const elementMap = { '火': 'fire', '水': 'water', '風': 'wind', '土': 'earth', '雷': 'thunder', 'fire': 'fire', 'water': 'water', 'wind': 'wind', 'earth': 'earth', 'thunder': 'thunder', '光': 'light', '闇': 'dark', 'light': 'light', 'dark': 'dark' };
            currentFieldElement = elementMap[fieldElementName] || 'neutral';
            room.fieldEffect = { name: fieldElementName, multiplier: fieldMult, turns: fieldTurns, originalTurns: fieldTurns, visual: `linear-gradient(135deg, rgba(200, 100, 100, 0.4), rgba(100, 100, 200, 0.4))` };
            room.currentField = { name: fieldElementName, multiplier: fieldMult, turns: fieldTurns, originalTurns: fieldTurns };
            room.field = { element: fieldElementName, remainingTurns: persistedTurns };
            room.fieldState = { element: fieldElementName, multiplier: fieldMult, turns: fieldTurns, mechanicType: card.mechanicType || 'field_change', targetStat: card.targetStat || 'field_element', duration: card.duration || fieldTurns };
            io.to(roomId).emit('fieldEffectUpdate', { fieldEffect: room.fieldEffect, currentFieldElement });
            break;
          }
          default: {
            console.log(`⚠️ ${player.name}: 未知のサポートタイプ [${supportTypeRaw}] → ${supportMessage}`);
          }
        }

        try {
          const effectName = card.effectName || card.specialEffect || '効果';
          const mechanicType = card.mechanicType || null;
          const durationVal = Number.isFinite(Number(card.duration)) ? Math.max(0, Math.round(Number(card.duration))) : 0;
          if (mechanicType && durationVal > 0) {
            const effectObj = { name: effectName, duration: durationVal, type: mechanicType };
            const goesToOpponent = ['poison','burn','debuff'].includes(supportTypeRaw);
            const targetPlayer = goesToOpponent ? opponent : player;
            if (targetPlayer) {
              if (!Array.isArray(targetPlayer.activeEffects)) targetPlayer.activeEffects = [];
              targetPlayer.activeEffects.push(effectObj);
            }
          }
        } catch (e) {
          console.warn('⚠️ activeEffects 登録に失敗:', e);
        }

        const hp = {}; room.players.forEach(p => { hp[p.id] = p.hp; });
        const players = room.players.map(p => ({ id: p.id, name: p.name, hp: p.hp, maxHp: p.maxHp || STARTING_HP, statusAilments: p.statusAilments || [], activeEffects: p.activeEffects || [] }));

        // ★【重要：HP保全チェック】サポート使用中はプレイヤーのHP減少を禁止
        // AIが誤った計算をしている場合、HPを強制的に復元
        if (player.hp < playerHpBeforeSupport) {
          console.warn(`⚠️ サポート使用中にプレイヤーHPが低下: ${playerHpBeforeSupport} → ${player.hp} (HP削減禁止)`);
          player.hp = playerHpBeforeSupport;
          hp[player.id] = playerHpBeforeSupport;
          const playerIdx = players.findIndex(p => p.id === player.id);
          if (playerIdx >= 0) players[playerIdx].hp = playerHpBeforeSupport;
        }
        
        // 相手へのHP操作は許可（デバフなど）するが、念のためサニタイズ
        if (opponent && opponent.hp < 0) {
          opponent.hp = 0;
          hp[opponent.id] = 0;
          const opponentIdx = players.findIndex(p => p.id === opponent.id);
          if (opponentIdx >= 0) players[opponentIdx].hp = 0;
        }

        let winnerId = null;
        if (room.players.some(p => p.hp <= 0)) {
          const survivor = room.players.find(p => p.hp > 0);
          winnerId = survivor?.id || null;
        }

        if (!winnerId) { tickBuffEffects(room); room.turnIndex = (room.turnIndex + 1) % room.players.length; }

        const targetMap = { 'heal': 'player_hp', 'hpmaxup': 'player_hp', 'staminarecover': 'player_hp', 'magicrecover': 'player_hp', 'defensebuff': 'player_def', 'poison': 'enemy_atk', 'burn': 'enemy_atk', 'allstatbuff': 'player_atk', 'debuff': 'enemy_atk', 'cleanse': 'player_hp', 'counter': 'player_atk', 'fieldchange': 'player_attack' };
        const effectTargetUnified = targetMap[supportTypeRaw] || 'player_hp';
        const finalValueUnified = extractNumber(supportMessage, 0);

        const cardData = { ...card, supportMessage: card.supportMessage || '', word: card.word, supportType: card.supportType || '', specialEffect: card.specialEffect || '', role: card.role || '', type: 'support', finalValue: finalValueUnified, effectTarget: effectTargetUnified, specialEffectName: card.specialEffect || '', specialEffectDescription: card.supportMessage || '', logic: card.logic || {}, effectName: card.effectName || card.specialEffect || '効果', creativeDescription: card.creativeDescription || card.supportMessage || '効果を発動', mechanicType: card.mechanicType || 'special', targetStat: card.targetStat || 'hp', duration: card.duration || 0 };

        const finishedPlayerId = player.id;
        const effectsExpired = tickActiveEffects(room, finishedPlayerId);

        // ★【ステータス更新通知】サポート使用直後にHP/MP情報を送信
        const statusUpdate = {
          players: room.players.map(p => ({
            id: p.id,
            name: p.name,
            hp: p.hp,
            maxHp: p.maxHp || STARTING_HP,
            mp: p.mp || 50,
            maxMp: p.maxMp || 50
          }))
        };
        io.to(roomId).emit('statusUpdate', statusUpdate);

        io.to(roomId).emit('supportUsed', { playerId: player.id, card: cardData, hp, players, supportRemaining: 3 - player.supportUsed, winnerId, nextTurn: winnerId ? null : room.players[room.turnIndex].id, appliedStatus, fieldEffect: room.fieldEffect, fieldState: room.fieldState, statusTick, effectsExpired });

        if (winnerId) { const winnerName = room.players.find(p => p.id === winnerId)?.name || 'プレイヤー'; updateStatus(roomId, `${winnerName} の勝利！`); }
        else { updateStatus(roomId, `${room.players[room.turnIndex].name} のターンです`); }

        if (!winnerId) {
          const nextPlayer = room.players[room.turnIndex];
          io.to(roomId).emit('turnUpdate', { activePlayer: nextPlayer.id, activePlayerName: nextPlayer.name, turnIndex: room.turnIndex, players: room.players.map(p => ({ id: p.id, name: p.name, hp: p.hp, maxHp: p.maxHp || STARTING_HP, activeEffects: p.activeEffects || [] })), effectsExpired });
        }
      } catch (error) {
        console.error('❌ サポート処理エラー:', error?.message || error);
        io.to(roomId).emit('log', { message: `⚠️ サポート処理でエラー: ${error?.message || '詳細不明'}`, type: 'error' });
        socket.emit('errorMessage', { message: 'エネルギーが暴走して不発になった！（エラー）' });
        room.usedWordsGlobal.add(lower);
        player.usedWords.add(lower);
        player.supportUsed++;
        if (!room.players.some(p => p.hp <= 0)) {
          room.turnIndex = (room.turnIndex + 1) % room.players.length;
          const nextPlayer = room.players[room.turnIndex];
          io.to(roomId).emit('turnUpdate', { activePlayer: nextPlayer.id, activePlayerName: nextPlayer.name, turnIndex: room.turnIndex, players: room.players.map(p => ({ id: p.id, name: p.name, hp: p.hp, maxHp: p.maxHp || STARTING_HP })) });
          updateStatus(roomId, `${nextPlayer.name} のターンです（エラーリカバリー）`);
        }
      }
    } catch (outerError) {
      console.error('❌ supportAction 外部エラー:', outerError);
      socket.emit('errorMessage', { message: 'エネルギーが暴走して不発になった！（エラー）' });
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

// =====================================
// 属性相性の計算関数（拡張版）
// =====================================
/**
 * 属性相性を判定し、ダメージ倍率と弱点/耐性フラグを返す
 * @param {string} attackEl - 攻撃側の属性 (fire, wood, water, light, dark, physics)
 * @param {string} defenseEl - 防御側の属性
 * @returns {object} { mult: 倍率, isWeakness: boolean, isResistance: boolean }
 */
function getAffinityByElement(attackEl, defenseEl) {
  if (!attackEl || !defenseEl) return { mult: 1.0, isWeakness: false, isResistance: false, relation: 'normal' };
  
  // 正規化
  const atkNorm = String(attackEl || '').toLowerCase().trim();
  const defNorm = String(defenseEl || '').toLowerCase().trim();
  
  // 属性ループ: fire > wood > water > fire
  const affinity = {
    'fire': 'wood',    // 火は森に強い
    'wood': 'water',   // 森は水に強い
    'water': 'fire',   // 水は火に強い
    'light': 'dark',   // 光は闇に強い
    'dark': 'light'    // 闇は光に強い
  };
  
  // 同じ属性なら耐性
  if (atkNorm === defNorm) {
    return { mult: 0.5, isWeakness: false, isResistance: true, relation: 'resistant' };
  }
  
  // 弱点チェック
  if (affinity[atkNorm] === defNorm) {
    return { mult: 1.5, isWeakness: true, isResistance: false, relation: 'weakness' };
  }
  
  // 物理属性は相性なし
  if (atkNorm === 'physics' || defNorm === 'physics') {
    return { mult: 1.0, isWeakness: false, isResistance: false, relation: 'normal' };
  }
  
  // それ以外は等倍
  return { mult: 1.0, isWeakness: false, isResistance: false, relation: 'normal' };
}

/**
 * ダメージ計算関数（属性相性と防御貫通ロジック対応）
 * @param {object} attackCard - 攻撃カード
 * @param {object} defenseCard - 防御カード
 * @param {object} attacker - 攻撃者プレイヤー
 * @param {object} defender - 防御者プレイヤー
 * @param {boolean} isCounter - カウンター判定
 * @param {object} room - ゲームルーム
 * @returns {object} { damage, affinity, isWeakness, isCritical }
 */
function calculateDamage(attackCard, defenseCard, attacker, defender, isCounter, room) {
  // 基本値の取得
  const basePower = Number(attackCard?.power || attackCard?.finalValue || attackCard?.baseValue || 0) || 0;
  const baseDefense = Number(defenseCard?.defense || defenseCard?.finalValue || defenseCard?.baseValue || 0) || 0;
  
  // 攻撃倍率（プレイヤーのatkMultiplier）
  const atkMult = (attacker?.atkMultiplier || 1.0);
  const adjustedPower = basePower * atkMult;
  
  // 防御倍率（プレイヤーのdefMultiplier）
  const defMult = (defender?.defMultiplier || 1.0);
  const adjustedDefense = baseDefense * defMult;
  
  // 属性相性計算
  const atkElem = attackCard?.element || 'physics';
  const defElem = defenseCard?.element || 'physics';
  const affinityData = getAffinityByElement(atkElem, defElem);
  const affinityMult = affinityData.mult;
  const isWeakness = affinityData.isWeakness;
  const isResistance = affinityData.isResistance;
  
  // 防御貫通ロジック（Guard Break System）
  let finalDefense = adjustedDefense;
  let isCritical = false;
  
  // 防御カードが防御モード(type === 'defense')の場合
  if (defenseCard?.type === 'defense' && defenseCard?.logic?.effect === 'damageReduction') {
    const baseDamageReduction = defenseCard?.logic?.value || 0.5; // デフォルト50%カット
    
    if (isWeakness) {
      // 弱点を突いた場合：防御効果を半減させる
      finalDefense = baseDamageReduction * 0.5; // 元の50%なら25%に
      isCritical = true;
    } else if (isResistance) {
      // 耐性属性で攻撃された場合：防御効果を1.2倍にする
      finalDefense = Math.min(0.9, baseDamageReduction * 1.2); // 最大90%カット
    } else if (atkElem === 'physics' || defElem === 'physics') {
      // 物理vs魔法またはその逆：防御効果を0.8倍にする
      finalDefense = baseDamageReduction * 0.8;
    }
  } else {
    // 防御モード以外の場合、防御数値をそのまま使う
    finalDefense = adjustedDefense / 100; // 正規化（0～1の範囲）
  }
  
  // ダメージ計算式
  // Damage = AttackPower * affinityMult * (1 - FinalDefense)
  let damage = Math.max(0, Math.round(adjustedPower * affinityMult * (1 - Math.min(0.95, finalDefense))));
  
  // 最小ダメージを1に（完全に無効化は避ける）
  if (damage < 1 && adjustedPower > 0) {
    damage = 1;
  }
  
  console.log(`💥 ダメージ計算: power=${basePower}, defense=${baseDefense}, affinityMult=${affinityMult}, finalDefense=${finalDefense}, damage=${damage}, isWeakness=${isWeakness}, isCritical=${isCritical}`);
  
  return {
    damage,
    affinity: affinityData,
    isWeakness,
    isResistance,
    isCritical,
    element: atkElem
  };
}

// =====================================
// スキップ判定付きターン進行関数
// =====================================
function advanceTurnIndexWithSkips(room) {
  // まずターンを1つ進める
  let nextIndex = (room.turnIndex + 1) % room.players.length;
  let nextPlayer = room.players[nextIndex];

  // もし次のプレイヤーが「行動不能（canAction: false）」なら、さらに飛ばす
  if (nextPlayer.canAction === false) {
    console.log(`Player ${nextPlayer.id} is skipped due to inability to act.`);
    // スキップしたことを通知（必要なら）
    // スキップされたのでフラグを戻して、さらに次の人へ
    nextPlayer.canAction = true; 
    nextIndex = (nextIndex + 1) % room.players.length;
  }

  room.turnIndex = nextIndex;
  return room.turnIndex;
}

// =====================================
// 利用可能なモデル一覧を取得（デバッグ用）
// =====================================
async function listAvailableModels() {
  try {
    console.log('📋 Gemini APIで利用可能なモデル一覧を取得中...');
    const modelList = await genAI.listModels();
    console.log('✅ 利用可能なモデル一覧:');
    modelList.models.forEach(model => {
      console.log(`   - ${model.name}`);
    });
  } catch (e) {
    console.error('❌ モデル一覧取得失敗:', e.message);
  }
}

// ★【Render対応：環境変数を優先、グレースフルシャットダウン対応】
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  // サーバー起動時にモデル一覧を出力
  listAvailableModels();
});
