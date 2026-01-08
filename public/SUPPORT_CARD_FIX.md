# サポートカードフリーズ修正ドキュメント

## 問題の原因
サポートカード発動時にゲームが フリーズする不具合の原因は、以下の3点でした：

### 1. **Gemini API からの不正なJSON形式**
- AIから返されるレスポンスが複数行だったり、マークダウン装飾が含まれていたりした
- キー名が統一されていなかった（baseValue, value, effecName など混在）
- 必須フィールドが不足していることがあった

### 2. **フロントエンドのエラーハンドリング不足**
- APIエラーが try-catch で捕捉できない場合がある
- 不正なデータに対する防御的プログラミングが不十分
- 要素の存在確認なしに DOM 操作を行っていた

### 3. **サーバーの応答フォーマットの曖昧性**
- 複数の応答形式が混在していた
- エラー時の デフォルト処理が一貫していなかった

---

## 実装した修正内容

### 【バックエンド修正】Node.js の judgeCardByAI 関数

#### 1. Gemini プロンプトの厳格化
```javascript
const prompt = `【重要】あなたは JSON 出力専用のゲーム判定エンジンです。
...
【禁止事項】
- マークダウンの装飾記号を使わない
- 説明文を加えない
- 複数行に分割しない
- シングルクォートを使わない
- JSON 以外のテキストを含めない
`;
```

#### 2. 統一されたキー名
API が必ず返すキー：
```json
{
  "type": "attack|defense|support",
  "finalValue": 0-100,
  "effectTarget": "enemy_hp|player_defense|player_hp|player_attack|enemy_attack|player_speed",
  "specialEffectName": "カード独自の効果名",
  "specialEffectDescription": "効果の説明"
}
```

#### 3. レスポンス処理の厳格化
```javascript
// JSON マークダウン装飾を削除
responseText = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

// 複数行のJSON整形に対応（改行を削除）
responseText = responseText.replace(/\n/g, '').replace(/\r/g, '');

// 必須キーの確認
if (!parsed.type || !parsed.finalValue || !parsed.effectTarget || 
    !parsed.specialEffectName || !parsed.specialEffectDescription) {
  throw new Error('必須キーが不足しています');
}
```

#### 4. バリデーション
```javascript
// effectTarget の厳格なバリデーション
const validTargetsByType = {
  'attack': ['enemy_hp'],
  'defense': ['player_defense'],
  'support': ['player_hp', 'player_attack', 'enemy_attack', 'player_speed']
};

const allowedTargets = validTargetsByType[parsed.type] || [];
if (!allowedTargets.includes(effectTarget)) {
  // デフォルト値を使用
  effectTarget = parsed.type === 'attack' ? 'enemy_hp' 
               : parsed.type === 'defense' ? 'player_defense' 
               : 'player_hp';
}
```

#### 5. /api/judgeCard エンドポイント
```javascript
app.post('/api/judgeCard', async (req, res) => {
  try {
    const aiResponse = await judgeCardByAI(cleanName);
    
    if (!aiResponse || aiResponse.error) {
      // AI失敗時もデフォルトで対応
      return res.json(getDefaultCardJudgement(cleanName));
    }

    res.json({
      success: true,
      cardName: cleanName,
      type: aiResponse.type,
      finalValue: aiResponse.finalValue,        // 0-100
      specialEffectName: aiResponse.specialEffectName,
      specialEffectDescription: aiResponse.specialEffectDescription,
      effectTarget: aiResponse.effectTarget
    });
  } catch (error) {
    // エラー時も必ずレスポンスを返す
    res.status(500).json({
      error: 'サーバーエラー',
      ...getDefaultCardJudgement(req.body?.cardName || 'エラー')
    });
  }
});
```

### 【フロントエンド修正】JavaScript の API 呼び出し

#### 1. 完全な try-catch ラッピング（test-judge.html）
```javascript
async function judgeCard() {
  const cardName = input.value.trim();
  
  if (!cardName) {
    alert('カード名を入力してください');
    return;
  }
  
  judgeBtn.disabled = true;
  loading.style.display = 'block';
  resultDiv.classList.remove('show');
  resultDiv.innerHTML = '';
  
  try {
    const response = await fetch('/api/judgeCard', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cardName })
    });
    
    const data = await response.json();
    
    // エラーチェック
    if (data.error) {
      throw new Error(data.error);
    }
    
    console.log('📊 API レスポンス:', data);  // ★ デバッグ用ログ
    
    // type === "support" の場合の処理
    if (data.type === 'support') {
      applySupport(data);
    }
    
    displayResult(data);
    
  } catch (error) {
    console.error('❌ 判定エラー:', error);
    resultDiv.innerHTML = `<div class="error">エラーが発生しました: ${error.message}</div>`;
    resultDiv.classList.add('show');
  } finally {
    judgeBtn.disabled = false;
    loading.style.display = 'none';
  }
}
```

#### 2. データ確認用 console.log
```javascript
console.log('📊 API レスポンス:', data);
```
- サーバーから返されたデータの形式を確認できます
- ブラウザの開発者ツール（F12）の Console タブで確認可能

#### 3. support 処理での要素存在確認
```javascript
function applySupport(data) {
  const value = data.finalValue;
  const target = data.effectTarget;
  const effectName = data.specialEffectName || 'サポート効果';
  
  // ★ 各要素が存在するか確認
  switch (target) {
    case 'player_hp':
      gameState.playerHp += value;
      gameState.playerHp = Math.min(gameState.playerHp, 999);
      // ★ UI 更新前に要素の存在確認
      const hpElement = document.getElementById('playerHp');
      if (hpElement) hpElement.textContent = gameState.playerHp;
      break;
      
    case 'player_attack':
      gameState.playerAttack += value;
      const atkElement = document.getElementById('playerAttack');
      if (atkElement) atkElement.textContent = gameState.playerAttack;
      break;
      
    // ... その他の effectTarget
  }
}
```

---

## エラーが起きた場合の動作

### シナリオ 1：Gemini API が不正なデータを返した
```
1. server.js の JSON.parse() がエラーをキャッチ
2. catch ブロックで console.error() により詳細ログを記録
3. getDefaultCardJudgement() でデフォルト値を使用して対応
4. APIレスポンス：デフォルト card オブジェクト（成功）
5. ゲーム続行（不発扱い）
```

### シナリオ 2：通信が失敗した
```
1. fetch() のエラーハンドリング
2. try-catch で捕捉
3. ユーザーに「エラーが発生しました」と表示
4. ゲームの状態は変わらない（不発扱い）
```

### シナリオ 3：API が effectTarget の値を間違えた
```
1. judgeCardByAI() の effectTarget バリデーション
2. 無効な値を検出して console.warn() を出力
3. デフォルト値に置き換え（例：attack → "enemy_hp"）
4. 修正されたデータを返却してゲーム継続
```

---

## デバッグ方法

### 1. ブラウザコンソールでの確認
F12キーを押して Developer Tools を開く → Console タブ
```
📝 Gemini raw response: {...}   ← サーバーログから Gemini の生データ
📊 API レスポンス: {...}        ← フロントから送信されたレスポンス
❌ judgeCardByAI エラー: ...   ← エラー内容
```

### 2. Network タブでの確認
API レスポンスのヘッダーと body を確認
```json
{
  "success": true,
  "cardName": "光",
  "type": "support",
  "finalValue": 42,
  "effectTarget": "player_hp",
  "specialEffectName": "聖なる癒やし",
  "specialEffectDescription": "プレイヤーのHPを回復"
}
```

### 3. サーバーログでの確認
サーバーを実行している端末で確認
```
📝 Gemini raw response: {...}      ← AI生レスポンス
✅ judgeCardByAI 成功: ...         ← 成功
⚠️ 無効な effectTarget: ...        ← 警告（修正対応中）
❌ judgeCardByAI エラー: ...      ← エラー（デフォルト使用）
```

---

## テスト手順

### 1. 正常系テスト
```
test-judge.html を開く
→ カード名「炎」を入力
→ 判定ボタンをクリック
→ 「攻撃」タイプで「火だるま」が表示される
→ Console に 📊 API レスポンス が表示される
```

### 2. エラー系テスト（サーバーの GEMINI_API_KEY を削除）
```
サーバー再起動
→ test-judge.html で判定実行
→ デフォルト値が返される
→ ゲームが止まらない（不発扱い）
→ Console に ⚠️ デフォルトカード使用 が表示される
```

### 3. support 処理テスト
```
test-judge.html で「光」を判定
→ type = "support"
→ applySupport() が実行
→ gameState が更新される
→ activeEffectsList に効果が追加される
→ Console に ✨ 聖なる癒やし が発動！ が表示される
```

---

## チェックリスト

- ✅ Gemini プロンプトが「JSON のみ」を厳格に要求
- ✅ API レスポンスキーが統一（finalValue のみ）
- ✅ try-catch ですべての API 呼び出しを保護
- ✅ エラー時はデフォルド値で「不発」処理
- ✅ console.log でデータを確認可能
- ✅ support の effectTarget に応じた正しい処理
- ✅ UI 要素の存在確認を実装

---

## 参考資料

- **test-judge.html**: 新システムの動作確認ツール
- **test-special-effects.html**: 仕様書ドキュメント
- **Browser Console**: F12 → Console タブで詳細ログ確認
