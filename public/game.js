const SOCKET_URL = 'https://create-cards.onrender.com';

let socket = null;
let playerId = null;
let playerName = '';
let roomId = null;
let isHost = false;
let currentTurn = null;
let myHp = 0;
let opponentHp = 0;
let supportRemaining = 3;
let myStamina = 100;
let myMp = 50;
let opStamina = 100;
let opMp = 50;

// 現在有効な環境効果
let currentFieldEffect = null; // { name, multiplier, turns, originalTurns }

// 演出関数群
function showFloatingText(x, y, text, type = 'damage', isAdvantage = false) {
  const container = document.getElementById('effectContainer');
  const floatingText = document.createElement('div');
  floatingText.className = `floating-text ${type}`;
  floatingText.textContent = text;
  floatingText.style.left = x + 'px';
  floatingText.style.top = y + 'px';
  if (isAdvantage) {
    floatingText.style.fontSize = '33px';
    floatingText.style.textShadow = '0 0 12px rgba(255, 51, 51, 0.9), 0 0 24px rgba(255, 51, 51, 0.6)';
  }
  container.appendChild(floatingText);
  setTimeout(() => floatingText.remove(), 1500);
}

function flashAttackEffect() {
  const battleSection = document.getElementById('battleSection');
  battleSection.classList.add('flash-effect');
  setTimeout(() => battleSection.classList.remove('flash-effect'), 400);
}

function bounceEffect(elementId) {
  const el = document.getElementById(elementId);
  el.classList.add('bounce-effect');
  setTimeout(() => el.classList.remove('bounce-effect'), 500);
}

async function showDamageAnimation(targetHp, damage, affinity = null) {
  const targetBar = targetHp === 'my' ? document.getElementById('myHealthFill') : document.getElementById('opHealthFill');
  const rect = targetBar.getBoundingClientRect();
  const x = rect.left + rect.width / 2 - 20;
  const y = rect.top + rect.height;
  
  // 大ダメージ時（30以上）はヒットストップ演出
  if (damage >= 30) {
    await hitStop(100);
  }
  
  flashAttackEffect();
  const isAdvantage = affinity && affinity.relation === 'advantage';
  showFloatingText(x, y, `-${damage}`, 'damage', isAdvantage);
  bounceEffect(targetHp === 'my' ? 'myHealthFill' : 'opHealthFill');
  
  // パーティクル演出: 中央からHPバーへ飛ぶ
  const playArea = document.getElementById('playArea');
  if (playArea) {
    const centerRect = playArea.getBoundingClientRect();
    const centerX = centerRect.left + centerRect.width / 2;
    const centerY = centerRect.top + centerRect.height / 2;
    const targetBarId = targetHp === 'my' ? 'myHpBar' : 'opHpBar';
    createDamageParticle(centerX, centerY, targetBarId, damage, false);
  }
}

function showHealAnimation(targetHp, amount) {
  const targetBar = targetHp === 'my' ? document.getElementById('myHealthFill') : document.getElementById('opHealthFill');
  const rect = targetBar.getBoundingClientRect();
  const x = rect.left + rect.width / 2 - 20;
  const y = rect.top + rect.height;
  
  showFloatingText(x, y, `+${amount}`, 'heal');
  
  // パーティクル演出: 中央からHPバーへ飛ぶ（回復）
  const playArea = document.getElementById('playArea');
  if (playArea) {
    const centerRect = playArea.getBoundingClientRect();
    const centerX = centerRect.left + centerRect.width / 2;
    const centerY = centerRect.top + centerRect.height / 2;
    const targetBarId = targetHp === 'my' ? 'myHpBar' : 'opHpBar';
    createDamageParticle(centerX, centerY, targetBarId, amount, true);
  }
}

function showGuardAnimation() {
  const container = document.getElementById('effectContainer');
  const guardText = document.createElement('div');
  guardText.className = 'floating-text guard';
  guardText.textContent = 'Guard!';
  guardText.style.left = 'calc(50% - 30px)';
  guardText.style.top = '20px';
  container.appendChild(guardText);
  setTimeout(() => guardText.remove(), 1500);
}

function screenShake() {
  const battleSection = document.getElementById('battleSection');
  if (battleSection) {
    battleSection.classList.add('screen-shake');
    setTimeout(() => battleSection.classList.remove('screen-shake'), 500);
  }
}

// パーティクル演出: ダメージ数値がHPバーへ飛んでいく
function createDamageParticle(startX, startY, targetElementId, damage, isHeal = false) {
  const particle = document.createElement('div');
  particle.className = isHeal ? 'heal-particle' : 'damage-particle';
  particle.textContent = isHeal ? `+${damage}` : `-${damage}`;
  particle.style.left = `${startX}px`;
  particle.style.top = `${startY}px`;
  
  // ターゲット位置を計算
  const targetEl = document.getElementById(targetElementId);
  if (targetEl) {
    const targetRect = targetEl.getBoundingClientRect();
    const targetX = targetRect.left + targetRect.width / 2 - startX;
    const targetY = targetRect.top + targetRect.height / 2 - startY;
    particle.style.setProperty('--target-x', `${targetX}px`);
    particle.style.setProperty('--target-y', `${targetY}px`);
  }
  
  document.body.appendChild(particle);
  setTimeout(() => particle.remove(), 800);
}

// ヒットストップ: 大ダメージ時に画面を一瞬フリーズ
function hitStop(duration = 100) {
  return new Promise(resolve => {
    const battleSection = document.getElementById('battleSection');
    if (battleSection) {
      battleSection.classList.add('hit-freeze');
      setTimeout(() => {
        battleSection.classList.remove('hit-freeze');
        resolve();
      }, duration);
    } else {
      setTimeout(resolve, duration);
    }
  });
}

function showAffinityMessage(relation) {
  if (relation === 'advantage') {
    const msg = document.createElement('div');
    msg.className = 'affinity-message advantage';
    msg.textContent = '効果はばつぐんだ！';
    document.body.appendChild(msg);
    setTimeout(() => msg.remove(), 2000);
  } else if (relation === 'disadvantage') {
    const msg = document.createElement('div');
    msg.className = 'affinity-message disadvantage';
    msg.textContent = 'いまひとつのようだ...';
    document.body.appendChild(msg);
    setTimeout(() => msg.remove(), 2000);
  }
}

// 戦歴管理
function getWinCount() {
  return parseInt(localStorage.getItem('battleWins') || '0');
}

function incrementWinCount() {
  const wins = getWinCount() + 1;
  localStorage.setItem('battleWins', wins.toString());
  return wins;
}

function displayWinCount() {
  const wins = getWinCount();
  const statusMsg = document.getElementById('statusMessage');
  if (statusMsg && wins > 0) {
    statusMsg.textContent += ` | 通算勝利数: ${wins}`;
  }
}

function buildCutinFlavor({ affinity, defenseCard, defenseFailed }) {
  const notes = [];
  if (affinity?.relation === 'advantage') {
    notes.push('効果はばつぐんだ！');
  } else if (affinity?.relation === 'disadvantage') {
    notes.push('いまひとつの相性だ...');
  }
  if (defenseCard?.hasReflect && !defenseFailed) {
    notes.push('反射ダメージ発動！');
  }
  return notes.join(' / ');
}

// カットイン演出表示（任意で追加コメントを表示）
function showCutin(card, duration = 2500, extraComment = '') {
  return new Promise((resolve) => {
    const cutinModal = document.getElementById('cutinModal');
    const cutinWord = document.getElementById('cutinWord');
    const cutinStats = document.getElementById('cutinStats');
    const cutinTier = document.getElementById('cutinTier');
    const cutinSpecial = document.getElementById('cutinSpecial');
    const cutinComment = document.getElementById('cutinComment');

    // カードネーム表示（card.name または word をフォールバック）
    cutinWord.textContent = card.name || card.word || '不明なカード';

    // element に応じた背景色・アイコン切り替え
    const elementDisplayJP = card.element || null;
    const elementColorMap = {
      '火': 'linear-gradient(135deg, rgba(244,67,54,0.35), rgba(255,87,34,0.35))',
      '水': 'linear-gradient(135deg, rgba(33,150,243,0.35), rgba(0,188,212,0.35))',
      '草': 'linear-gradient(135deg, rgba(76,175,80,0.35), rgba(139,195,74,0.35))',
      '雷': 'linear-gradient(135deg, rgba(255,235,59,0.35), rgba(255,193,7,0.35))',
      '土': 'linear-gradient(135deg, rgba(121,85,72,0.35), rgba(158,118,104,0.35))',
      '風': 'linear-gradient(135deg, rgba(0,150,136,0.35), rgba(0,188,212,0.35))',
      '光': 'linear-gradient(135deg, rgba(255,215,0,0.35), rgba(255,255,255,0.35))',
      '闇': 'linear-gradient(135deg, rgba(63,81,181,0.35), rgba(103,58,183,0.35))'
    };
    const elementIconMap = {
      '火': '🔥',
      '水': '🌊',
      '草': '🌿',
      '雷': '⚡',
      '土': '🪨',
      '風': '🍃',
      '光': '✨',
      '闇': '🌑'
    };
    const defaultGradient = 'linear-gradient(135deg, rgba(100, 150, 255, 0.25), rgba(200, 100, 255, 0.25))';
    const bgGradient = elementDisplayJP ? (elementColorMap[elementDisplayJP] || defaultGradient) : defaultGradient;
    cutinModal.style.background = bgGradient;
    // アイコンを左上に表示
    const existingElemIcon = document.getElementById('cutinElemIcon');
    if (existingElemIcon) existingElemIcon.remove();
    const elemIcon = document.createElement('div');
    elemIcon.id = 'cutinElemIcon';
    elemIcon.textContent = elementDisplayJP ? (elementIconMap[elementDisplayJP] || '📌') : '📌';
    elemIcon.style.cssText = `
      position: absolute;
      top: 10px;
      left: 10px;
      font-size: 2rem;
      filter: drop-shadow(0 2px 4px rgba(0,0,0,0.4));
    `;
    cutinModal.appendChild(elemIcon);

    // ステータス要素の生成（roleに基づき片方のみ表示、無い枠は非表示）
    const role = (card.role || 'Unknown').toLowerCase();
    cutinStats.innerHTML = '';

    const statsFragment = document.createDocumentFragment();

    // 攻撃力（Attackロールのみ）
    const hasAttack = card.attack !== undefined && card.attack !== null && role === 'attack';
    if (hasAttack) {
      const atkEl = document.createElement('div');
      atkEl.className = 'stat-pill attack-pill';
      atkEl.textContent = `攻撃力: ${card.attack}`;
      statsFragment.appendChild(atkEl);
    }

    // 防御力（Defenseロールのみ）
    const hasDefense = card.defense !== undefined && card.defense !== null && role === 'defense';
    if (hasDefense) {
      const defEl = document.createElement('div');
      defEl.className = 'stat-pill defense-pill';
      defEl.textContent = `防御力: ${card.defense}`;
      statsFragment.appendChild(defEl);
    }

    // Support ロール時は supportType ラベルのみ（攻撃/防御は生成しない）
    if (role === 'support') {
      const supportTypeLabel = {
        'heal': '🏥 HP回復',
        'hpMaxUp': '💪 最大HP増加',
        'staminaRecover': '⚡ スタミナ回復',
        'magicRecover': '✨ 魔力回復',
        'defenseBuff': '🛡️ 防御強化',
        'poison': '☠️ 毒',
        'burn': '🔥 焼け',
        'allStatBuff': '👑 全体強化',
        'debuff': '📉 弱体化',
        'cleanse': '💧 浄化',
        'counter': '⚔️ カウンター',
        'fieldChange': '🌍 フィールド変化'
      };
      const typeLabel = supportTypeLabel[card.supportType] || card.supportType || '';
      if (typeLabel) {
        const supEl = document.createElement('div');
        supEl.className = 'stat-pill support-pill';
        supEl.textContent = typeLabel;
        statsFragment.appendChild(supEl);
      }
    }

    // 生成結果をDOMに反映。何も表示するものがなければコンテナ自体を非表示。
    if (statsFragment.childNodes.length > 0) {
      cutinStats.style.display = 'block';
      cutinStats.appendChild(statsFragment);
    } else {
      cutinStats.style.display = 'none';
    }

    // 属性（element優先）と役割を表示（tier はレガシー対応）
    const roleDisplay = (card.role || 'UNKNOWN').toUpperCase();
    const elementJP = card.element || null;
    const attribute = (card.attribute || 'earth').toUpperCase();
    const tierDisplay = card.tier ? ` [${card.tier.toUpperCase()}]` : '';
    const elementDisplay = elementJP ? `${elementJP}` : attribute;
    cutinTier.textContent = `${elementDisplay}${tierDisplay} ${roleDisplay}`;

    // 特殊効果を表示（supportMessage が存在する場合は併記）
    let specialInfo = card.specialEffect || 'なし';
    if (card.supportMessage) {
      specialInfo = `${card.specialEffect}\n→ ${card.supportMessage}`;
    }
    cutinSpecial.textContent = `特殊効果: ${specialInfo}`;

    // コメント（審判コメント + 追加コメント）
    const comments = [card.judgeComment || '判定コメントなし'];
    if (extraComment) comments.push(extraComment);
    cutinComment.textContent = comments.join(' / ');

    cutinModal.classList.remove('hidden');

    setTimeout(() => {
      cutinModal.classList.add('hidden');
      // 表示状態を戻す（次回のため）
      cutinStats.style.display = '';
      cutinModal.style.background = '';
      const iconEl = document.getElementById('cutinElemIcon');
      if (iconEl) iconEl.remove();
      resolve();
    }, duration);
  });
}

// 横並び対面型レイアウト初期化
function initGodFieldLayout() {
  const battleSection = document.getElementById('battleSection');
  if (!battleSection) return;
  battleSection.classList.add('gfield-enabled');
  
  // 既存のプレイエリアがなければ追加
  if (!document.getElementById('playArea')) {
    const playArea = document.createElement('div');
    playArea.id = 'playArea';
    battleSection.insertBefore(playArea, document.getElementById('battleLog'));
  }
  
  // 横並びヘッダーを作成
  if (!document.getElementById('battleHeader')) {
    const header = document.createElement('div');
    header.id = 'battleHeader';
    header.className = 'battle-header';
    header.innerHTML = `
      <div class="player-status me">
        <div class="player-name" id="myPlayerName">あなた</div>
        <div class="hp-bar-container">
          <div class="hp-bar-bg">
            <div class="hp-bar-fill" id="myHpBar">
              <span id="myHpText">100</span>
            </div>
          </div>
        </div>
        <div class="resource-bars">
          <div class="resource-bar-wrap">
            <div class="resource-bar-fill st" id="myStBar">
              <span id="myStText">100</span>
            </div>
          </div>
          <div class="resource-bar-wrap">
            <div class="resource-bar-fill mp" id="myMpBar">
              <span id="myMpText">50</span>
            </div>
          </div>
        </div>
      </div>
      <div class="player-status opponent">
        <div class="player-name" id="opPlayerName">相手</div>
        <div class="hp-bar-container">
          <div class="hp-bar-bg">
            <div class="hp-bar-fill" id="opHpBar">
              <span id="opHpText">100</span>
            </div>
          </div>
        </div>
        <div class="resource-bars">
          <div class="resource-bar-wrap">
            <div class="resource-bar-fill st" id="opStBar">
              <span id="opStText">100</span>
            </div>
          </div>
          <div class="resource-bar-wrap">
            <div class="resource-bar-fill mp" id="opMpBar">
              <span id="opMpText">50</span>
            </div>
          </div>
        </div>
      </div>
    `;
    
    // ターンバナーの後に挿入
    const turnBanner = document.getElementById('turnBanner');
    if (turnBanner && turnBanner.parentNode) {
      turnBanner.parentNode.insertBefore(header, turnBanner.nextSibling);
    } else {
      battleSection.insertBefore(header, battleSection.firstChild);
    }
  }
}

function showCenterCard(card) {
  const playArea = document.getElementById('playArea');
  if (!playArea) return;
  // 既存カードを消去
  const old = playArea.querySelector('.center-card');
  if (old) old.remove();
  const role = (card.role || '').toLowerCase();
  const sword = '🗡️';
  const shield = '🛡️';
  const supportEmojiMap = { 'heal':'🏥','hpMaxUp':'💪','staminaRecover':'⚡','magicRecover':'✨','defenseBuff':'🛡️','poison':'☠️','burn':'🔥','allStatBuff':'👑','debuff':'📉','cleanse':'💧','counter':'⚔️','fieldChange':'🌍' };
  const supportLabelMap = {
    'heal': 'HP回復',
    'hpMaxUp': '最大HP増加',
    'staminaRecover': 'スタミナ回復',
    'magicRecover': '魔力回復',
    'defenseBuff': '防御力強化',
    'poison': '毒付与',
    'burn': '焼け付与',
    'allStatBuff': '全能力強化',
    'debuff': '能力低下',
    'cleanse': '状態異常クリア',
    'counter': 'カウンター準備',
    'fieldChange': 'フィールド変化'
  };
  const supportType = (card.supportType || '').toString();
  const supportEmoji = supportEmojiMap[supportType] || '🌟';
  const supportLabel = supportLabelMap[supportType] || 'サポート';
  const cardEl = document.createElement('div');
  // 手札から飛んでくる演出（ランダムな横位置から）
  const isSubmit = card.isSubmit || false;
  if (isSubmit) {
    cardEl.className = 'center-card card-submit';
    const randomX = (Math.random() - 0.5) * 200;
    cardEl.style.setProperty('--submit-x', `${randomX}px`);
  } else {
    cardEl.className = 'center-card card-enter';
  }
  
  if (role === 'attack') {
    const atk = Number(card.attack) || 0;
    cardEl.innerHTML = `
      <div class="role-icon">${sword}</div>
      <div class="word">${card.word || card.name || ''}</div>
      <div class="role-value attack">${atk}</div>
    `;
  } else if (role === 'defense') {
    const def = Number(card.defense) || 0;
    const effect = card.specialEffect || '';
    cardEl.innerHTML = `
      <div class="role-icon">${shield}</div>
      <div class="word">${card.word || card.name || ''}</div>
      <div class="role-value defense">${def}</div>
      ${effect ? `<div class="role-extra">${effect}</div>` : ''}
    `;
  } else if (role === 'support') {
    const msg = card.supportMessage || '効果を発動！';
    // Supportの場合は背景を暗くしてネオン効果を強調
    cardEl.style.background = 'linear-gradient(145deg, #0a1628, #1a2b3f)';
    cardEl.style.borderColor = '#00d4ff';
    cardEl.innerHTML = `
      <div class="role-icon">${supportEmoji}</div>
      <div class="word" style="color: #e0f7ff; text-shadow: 0 0 10px rgba(0, 255, 255, 0.5);">${card.word || card.name || ''}</div>
      <div class="role-effect">${supportLabel}</div>
      <div class="role-message">${msg}</div>
    `;
  } else {
    // 未定義ロールのフォールバック
    cardEl.innerHTML = `
      <div class="word">${card.word || card.name || ''}</div>
    `;
  }
  
  playArea.appendChild(cardEl);
  // Element Glow: 属性色でボヤッと光らせる
  const elemColorMap = {
    '火': 'rgba(255, 87, 34, 0.55)',
    '水': 'rgba(33, 150, 243, 0.55)',
    '草': 'rgba(76, 175, 80, 0.55)',
    '雷': 'rgba(255, 235, 59, 0.55)',
    '土': 'rgba(121, 85, 72, 0.55)',
    '風': 'rgba(0, 188, 212, 0.55)',
    '光': 'rgba(255, 215, 0, 0.6)',
    '闇': 'rgba(103, 58, 183, 0.55)'
  };
  const glow = elemColorMap[card.element] || 'rgba(124, 240, 197, 0.5)';
  cardEl.style.setProperty('--elem-glow', glow);
  cardEl.classList.add('element-glow');
  setTimeout(() => cardEl.classList.remove('element-glow'), 900);
  // 自動で少し後にフェードアウト
  setTimeout(() => {
    cardEl.style.transition = 'opacity 0.4s ease';
    cardEl.style.opacity = '0';
    setTimeout(() => cardEl.remove(), 400);
  }, 2200);
}

function updateGodFieldBars() {
  // HPバーの色を残量に応じて変化させるヘルパー
  function getHpColor(hpPercent) {
    if (hpPercent > 60) {
      // 緑系
      return 'linear-gradient(90deg, #7cf0c5, #5ed0ff)';
    } else if (hpPercent > 30) {
      // 黄系
      return 'linear-gradient(90deg, #ffd166, #ffb347)';
    } else {
      // 赤系
      return 'linear-gradient(90deg, #ff8a8a, #ff5f52)';
    }
  }
  
  // 自分のバー更新
  const myHpBar = document.getElementById('myHpBar');
  const myStBar = document.getElementById('myStBar');
  const myMpBar = document.getElementById('myMpBar');
  
  if (myHpBar) {
    const hpPercent = Math.max(0, Math.min(100, myHp));
    myHpBar.style.width = `${hpPercent}%`;
    myHpBar.style.background = getHpColor(hpPercent);
    document.getElementById('myHpText').textContent = Math.round(myHp);
    myHpBar.classList.add('pulse');
    setTimeout(() => myHpBar.classList.remove('pulse'), 600);
  }
  
  if (myStBar) {
    const stPercent = Math.max(0, Math.min(100, myStamina));
    myStBar.style.width = `${stPercent}%`;
    document.getElementById('myStText').textContent = Math.round(myStamina);
  }
  
  if (myMpBar) {
    const mpPercent = Math.max(0, Math.min(100, myMp));
    myMpBar.style.width = `${mpPercent}%`;
    document.getElementById('myMpText').textContent = Math.round(myMp);
  }
  
  // 相手のバー更新
  const opHpBar = document.getElementById('opHpBar');
  const opStBar = document.getElementById('opStBar');
  const opMpBar = document.getElementById('opMpBar');
  
  if (opHpBar) {
    const hpPercent = Math.max(0, Math.min(100, opponentHp));
    opHpBar.style.width = `${hpPercent}%`;
    opHpBar.style.background = getHpColor(hpPercent);
    document.getElementById('opHpText').textContent = Math.round(opponentHp);
    opHpBar.classList.add('pulse');
    setTimeout(() => opHpBar.classList.remove('pulse'), 600);
  }
  
  if (opStBar) {
    const stPercent = Math.max(0, Math.min(100, opStamina));
    opStBar.style.width = `${stPercent}%`;
    document.getElementById('opStText').textContent = Math.round(opStamina);
  }
  
  if (opMpBar) {
    const mpPercent = Math.max(0, Math.min(100, opMp));
    opMpBar.style.width = `${mpPercent}%`;
    document.getElementById('opMpText').textContent = Math.round(opMp);
  }
}

function updateSupportCounter() {
  const supportRemainingEl = document.getElementById('supportRemaining');
  if (supportRemainingEl) {
    supportRemainingEl.textContent = supportRemaining;
  }
  const supportBtn = document.getElementById('supportBtn');
  if (supportBtn) {
    supportBtn.disabled = supportRemaining <= 0 || currentTurn !== playerId;
  }
}

function updateTurnIndicator(isMyTurn) {
  const indicator = document.getElementById('turnIndicator');
  const turnBanner = document.getElementById('turnBanner');
  const turnBannerText = document.getElementById('turnBannerText');
  const attackInput = document.getElementById('attackWordInput');
  const attackBtn = document.getElementById('attackBtn');
  const supportBtn = document.getElementById('supportBtn');

  if (isMyTurn) {
    indicator.textContent = '🔵 あなたのターンです！';
    indicator.classList.remove('opponent-turn');
    indicator.classList.add('my-turn');
    turnBannerText.textContent = 'あなたの番';
    turnBanner.classList.remove('opponent');
    turnBanner.classList.add('mine');

    if (attackInput) attackInput.disabled = false;
    if (attackBtn) attackBtn.disabled = false;
    if (supportBtn) supportBtn.disabled = supportRemaining <= 0;
  } else {
    indicator.textContent = '⌛ 相手のターンを待機中...';
    indicator.classList.remove('my-turn');
    indicator.classList.add('opponent-turn');
    turnBannerText.textContent = '相手の番';
    turnBanner.classList.remove('mine');
    turnBanner.classList.add('opponent');

    if (attackInput) attackInput.disabled = true;
    if (attackBtn) attackBtn.disabled = true;
    if (supportBtn) supportBtn.disabled = true;
  }
}

// ターン状態をサーバーと同期（演出中でも最終的に必ず呼ぶ）
function syncTurnState({ activePlayer, nextTurn, hp, players }) {
  // activePlayer優先、なければnextTurn
  if (typeof activePlayer === 'string') {
    currentTurn = activePlayer;
  } else if (typeof nextTurn === 'string') {
    currentTurn = nextTurn;
  }

  // HP更新（hpマップ優先、なければplayers配列で上書き）
  let myVal = myHp;
  let opVal = opponentHp;
  if (hp && typeof hp === 'object') {
    if (hp[playerId] !== undefined) myVal = hp[playerId];
    const opEntry = Object.entries(hp).find(([id]) => id !== playerId);
    if (opEntry) opVal = opEntry[1];
  }
  if (players && Array.isArray(players) && players.length > 0) {
    players.forEach(p => {
      if (p.id === playerId) myVal = p.hp;
      else opVal = p.hp;
    });
  }

  updateHealthBars(myVal, opVal);

  const myTurn = currentTurn === playerId;
  updateTurnIndicator(myTurn);
  toggleInputs(myTurn);
}

function showSection(id) {
  ['homeSection', 'matchingSection', 'waitingSection', 'battleSection', 'resultSection'].forEach(sec => {
    document.getElementById(sec).classList.add('hidden');
  });
  document.getElementById(id).classList.remove('hidden');
}

function updateHealthBars(my, op) {
  myHp = my;
  opponentHp = op;
  const myFill = document.getElementById('myHealthFill');
  const opFill = document.getElementById('opHealthFill');
  document.getElementById('myHealthText').textContent = Math.round(myHp);
  document.getElementById('opHealthText').textContent = Math.round(opponentHp);
  myFill.style.width = `${Math.max(0, Math.min(100, myHp))}%`;
  opFill.style.width = `${Math.max(0, Math.min(100, opponentHp))}%`;
  updateGodFieldBars();
}

function updateStatusBadges(playerId, statusAilments) {
  const badgesContainer = playerId === socket.id 
    ? document.getElementById('myStatusBadges')
    : document.getElementById('opStatusBadges');
  
  if (!badgesContainer) return;
  
  badgesContainer.innerHTML = '';
  statusAilments.forEach(ailment => {
    const badge = document.createElement('div');
    badge.className = `status-badge ${ailment.effectType}`;
    badge.textContent = `${ailment.name} (${ailment.turns})`;
    badgesContainer.appendChild(badge);
  });
}

function showFieldEffect(fieldEffect) {
  if (fieldEffect && (fieldEffect.visual || fieldEffect.name)) {
    const { name, multiplier, turns, originalTurns, visual } = fieldEffect;
    const announcementText = multiplier 
      ? name + "属性威力が" + multiplier + "倍！（" + (turns || originalTurns) + "ターン）"
      : "フィールド効果発動: " + name;
    
    // 背景グラデーションを永続適用
    if (visual) {
      document.body.style.background = visual;
      document.body.style.backgroundAttachment = 'fixed';
    }
    
    // 中央に大きく効果名を一時的に表示（3秒）
    const announcement = document.createElement('div');
    announcement.className = 'field-announcement';
    announcement.textContent = announcementText;
    announcement.style.cssText = `
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      font-size: 2.5em;
      font-weight: bold;
      color: white;
      text-shadow: 2px 2px 8px rgba(0,0,0,0.8);
      z-index: 9999;
      animation: pulse 1s ease-in-out;
    `;
    document.body.appendChild(announcement);
    
    // 3秒後にアナウンスのみ削除、背景は維持
    setTimeout(() => {
      announcement.remove();
    }, 3000);
    
    // グローバル環境効果を更新（背景永続化のため）
    currentFieldEffect = fieldEffect;
    appendLog("🌍 フィールド効果: " + announcementText, "buff");
  }
}

// 環境効果バッジの更新・表示
function updateFieldEffectBadge(fieldEffect) {
  let badgeContainer = document.getElementById('fieldEffectBadge');
  
  if (!fieldEffect || !fieldEffect.name || fieldEffect.turns <= 0) {
    // 環境効果が消えたらバッジを削除
    if (badgeContainer) {
      badgeContainer.remove();
    }
    return;
  }
  
  // バッジコンテナが存在しなければ作成
  if (!badgeContainer) {
    badgeContainer = document.createElement('div');
    badgeContainer.id = 'fieldEffectBadge';
    badgeContainer.style.cssText = `
      position: fixed;
      top: 120px;
      left: 20px;
      background: rgba(0, 0, 0, 0.7);
      border: 2px solid #00ffff;
      border-radius: 8px;
      padding: 8px 12px;
      color: #fff;
      font-weight: bold;
      font-size: 14px;
      z-index: 1000;
      display: flex;
      align-items: center;
      gap: 6px;
      box-shadow: 0 0 10px rgba(0, 255, 255, 0.5);
    `;
    document.body.appendChild(badgeContainer);
  }
  
  // 属性ごとのアイコン
  const elementIcons = {
    '火': '☀️',
    '水': '💧',
    '雷': '⚡',
    '土': '🌍',
    '風': '💨',
    '光': '✨',
    '闇': '🌙',
    '草': '🌿'
  };
  
  const icon = elementIcons[fieldEffect.name] || '🌈';
  const label = `${fieldEffect.name}属性強化中（残り${fieldEffect.turns}ターン）`;
  
  badgeContainer.innerHTML = `<span>${icon}</span><span>${label}</span>`;
}
function showSupportOverlay(supportCard, duration = 3000) {
  return new Promise((resolve) => {
    // 既存のオーバーレイがあれば削除
    const existingOverlay = document.getElementById('supportOverlay');
    if (existingOverlay) {
      existingOverlay.remove();
    }

    // supportType に基づいた背景グラデーションマップ
    const supportTypeGradients = {
      'heal': 'linear-gradient(135deg, rgba(76, 175, 80, 0.5), rgba(139, 195, 74, 0.5))',
      'hpMaxUp': 'linear-gradient(135deg, rgba(255, 152, 0, 0.5), rgba(255, 193, 7, 0.5))',
      'staminaRecover': 'linear-gradient(135deg, rgba(255, 87, 34, 0.5), rgba(255, 152, 0, 0.5))',
      'magicRecover': 'linear-gradient(135deg, rgba(156, 39, 176, 0.5), rgba(103, 58, 183, 0.5))',
      'defenseBuff': 'linear-gradient(135deg, rgba(63, 81, 181, 0.5), rgba(33, 150, 243, 0.5))',
      'allStatBuff': 'linear-gradient(135deg, rgba(255, 215, 0, 0.5), rgba(255, 165, 0, 0.5))',
      'poison': 'linear-gradient(135deg, rgba(76, 175, 80, 0.5), rgba(0, 128, 0, 0.5))',
      'burn': 'linear-gradient(135deg, rgba(255, 87, 34, 0.5), rgba(244, 67, 54, 0.5))',
      'debuff': 'linear-gradient(135deg, rgba(156, 39, 176, 0.5), rgba(233, 30, 99, 0.5))',
      'cleanse': 'linear-gradient(135deg, rgba(0, 188, 212, 0.5), rgba(0, 150, 136, 0.5))',
      'counter': 'linear-gradient(135deg, rgba(255, 152, 0, 0.5), rgba(244, 67, 54, 0.5))',
      'fieldChange': 'linear-gradient(135deg, rgba(33, 150, 243, 0.5), rgba(0, 188, 212, 0.5))'
    };
    
    const backgroundGradient = supportTypeGradients[supportCard.supportType] || 
                               'linear-gradient(135deg, rgba(100, 150, 255, 0.5), rgba(200, 100, 255, 0.5))';

    // サポート演出用のコンテナを動的に作成
    const overlay = document.createElement('div');
    overlay.id = 'supportOverlay';
    overlay.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: ${backgroundGradient};
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      z-index: 10000;
      animation: supportFade 0.5s ease-in-out;
      font-family: 'Segoe UI', 'Trebuchet MS', 'Georgia', sans-serif;
      backdrop-filter: blur(2px);
      padding: 20px;
    `;

    // supportType に対応したアイコンを表示
    const supportTypeIcons = {
      'heal': '🏥',
      'hpMaxUp': '💪',
      'staminaRecover': '⚡',
      'magicRecover': '✨',
      'defenseBuff': '🛡️',
      'allStatBuff': '👑',
      'poison': '☠️',
      'burn': '🔥',
      'debuff': '📉',
      'cleanse': '💧',
      'counter': '⚔️',
      'fieldChange': '🌍'
    };
    const icon = supportTypeIcons[supportCard.supportType] || '📌';

    const iconEl = document.createElement('div');
    iconEl.style.cssText = `
      font-size: 4em;
      margin-bottom: 10px;
      animation: supportIconBounce 0.6s ease-in-out;
      filter: drop-shadow(0 0 10px rgba(255, 255, 255, 0.5));
    `;
    iconEl.textContent = icon;

    // サポート名（単語）を表示するエレメント
    const supportNameEl = document.createElement('div');
    supportNameEl.style.cssText = `
      font-size: 3.8em;
      font-weight: 900;
      color: #ffffff;
      text-shadow: 
        0 2px 4px rgba(0, 0, 0, 0.3),
        0 4px 8px rgba(0, 0, 0, 0.4),
        2px 2px 0px rgba(0, 0, 0, 0.5),
        -2px -2px 0px rgba(255, 255, 255, 0.2);
      margin-bottom: 15px;
      letter-spacing: 3px;
      animation: supportWordPop 0.7s cubic-bezier(0.68, -0.55, 0.265, 1.55);
      text-align: center;
      max-width: 90vw;
      word-wrap: break-word;
    `;
    supportNameEl.textContent = supportCard.word;

    // サポートメッセージを表示するエレメント
    const supportMessageEl = document.createElement('div');
    supportMessageEl.style.cssText = `
      font-size: 1.8em;
      font-weight: 500;
      color: #ffffff;
      text-shadow:
        0 2px 4px rgba(0, 0, 0, 0.4),
        0 4px 8px rgba(0, 0, 0, 0.5),
        1px 1px 0px rgba(0, 0, 0, 0.6);
      text-align: center;
      max-width: 80vw;
      line-height: 1.8;
      letter-spacing: 1px;
      animation: supportMessageSlide 0.9s ease-out 0.2s both;
      padding: 0 20px;
    `;
    supportMessageEl.textContent = supportCard.supportMessage || '効果を発動！';

    // 特殊効果を表示するエレメント
    const specialEl = document.createElement('div');
    specialEl.style.cssText = `
      font-size: 1.3em;
      font-weight: 600;
      color: #ffeb3b;
      text-shadow: 
        0 2px 4px rgba(0, 0, 0, 0.5),
        0 0 10px rgba(255, 235, 59, 0.3),
        0 0 20px rgba(255, 235, 59, 0.2);
      margin-top: 15px;
      animation: supportSpecialGlow 1.2s ease-in-out 0.4s infinite;
      text-align: center;
      max-width: 70vw;
    `;
    specialEl.textContent = supportCard.specialEffect || '';

    overlay.appendChild(iconEl);
    overlay.appendChild(supportNameEl);
    overlay.appendChild(supportMessageEl);
    if (specialEl.textContent) {
      overlay.appendChild(specialEl);
    }

    document.body.appendChild(overlay);

    // CSS アニメーションを動的に追加
    if (!document.getElementById('supportAnimationStyle')) {
      const style = document.createElement('style');
      style.id = 'supportAnimationStyle';
      style.textContent = `
        @keyframes supportFade {
          from {
            opacity: 0;
            backdrop-filter: blur(0px);
          }
          to {
            opacity: 1;
            backdrop-filter: blur(2px);
          }
        }

        @keyframes supportWordPop {
          0% {
            transform: scale(0) rotateZ(-15deg);
            opacity: 0;
            filter: blur(10px);
          }
          50% {
            transform: scale(1.15) rotateZ(5deg);
            filter: blur(0px);
          }
          100% {
            transform: scale(1) rotateZ(0deg);
            opacity: 1;
            filter: blur(0px);
          }
        }

        @keyframes supportMessageSlide {
          from {
            transform: translateY(30px);
            opacity: 0;
            filter: blur(5px);
          }
          to {
            transform: translateY(0);
            opacity: 1;
            filter: blur(0px);
          }
        }

        @keyframes supportSpecialGlow {
          0% {
            opacity: 0.6;
            text-shadow: 
              0 2px 4px rgba(0, 0, 0, 0.5),
              0 0 10px rgba(255, 235, 59, 0.2),
              0 0 20px rgba(255, 235, 59, 0.1);
            transform: scale(1);
          }
          50% {
            opacity: 1;
            text-shadow: 
              0 2px 4px rgba(0, 0, 0, 0.5),
              0 0 15px rgba(255, 235, 59, 0.6),
              0 0 30px rgba(255, 235, 59, 0.4);
            transform: scale(1.05);
          }
          100% {
            opacity: 0.6;
            text-shadow: 
              0 2px 4px rgba(0, 0, 0, 0.5),
              0 0 10px rgba(255, 235, 59, 0.2),
              0 0 20px rgba(255, 235, 59, 0.1);
            transform: scale(1);
          }
        }

        @keyframes supportIconBounce {
          0% {
            transform: scale(0) translateY(-80px);
            opacity: 0;
          }
          50% {
            transform: scale(1.25);
            opacity: 1;
          }
          75% {
            transform: scale(0.95);
          }
          100% {
            transform: scale(1) translateY(0);
            opacity: 1;
          }
        }

        @media (max-width: 768px) {
          #supportOverlay > div:nth-child(2) {
            font-size: 2.5em !important;
          }
          #supportOverlay > div:nth-child(3) {
            font-size: 1.3em !important;
          }
          #supportOverlay > div:nth-child(1) {
            font-size: 3em !important;
          }
        }
      `;
      document.head.appendChild(style);
    }

    // 指定時間後にオーバーレイを削除
    setTimeout(() => {
      overlay.style.animation = 'supportFade 0.5s ease-in-out reverse';
      setTimeout(() => {
        overlay.remove();
        resolve();
      }, 500);
    }, duration);
  });
}
function buildSupportEffectMessage(card, isMe) {
  const supportType = card.supportType || '';
  const targetName = isMe ? 'あなた' : '相手';
  
  const effectMessages = {
    'heal': `${targetName}のHPを回復！`,
    'hpMaxUp': `${targetName}の最大HPが増加した！`,
    'staminaRecover': `${targetName}のスタミナを回復！`,
    'magicRecover': `${targetName}の魔力を回復！`,
    'defenseBuff': `${targetName}の防御力が上昇した！`,
    'allStatBuff': `${targetName}の全能力が上昇した！`,
    'poison': `${isMe ? '相手' : 'あなた'}に猛毒を付与！毎ターンダメージ！`,
    'burn': `${isMe ? '相手' : 'あなた'}に焼けを付与！毎ターンダメージ！`,
    'debuff': `${isMe ? '相手' : 'あなた'}の能力が低下した...`,
    'cleanse': `${targetName}の状態異常が全てクリアされた！`,
    'counter': `${targetName}がカウンター準備完了！`,
    'fieldChange': `フィールドの環境が大きく変わった！`
  };
  
  return effectMessages[supportType] || `${targetName}がサポート効果を発動！`;
}

function appendLog(message, type = 'info') {
  const log = document.getElementById('battleLog');
  const entry = document.createElement('div');
  entry.className = `log-entry ${type}`;
  entry.textContent = message;
  log.appendChild(entry);
  log.scrollTop = log.scrollHeight;
}

function setStatus(message) {
  document.getElementById('statusMessage').textContent = message;
}

function toggleInputs(canAttack) {
  document.getElementById('attackWordInput').disabled = !canAttack;
  document.getElementById('attackBtn').disabled = !canAttack;
}

function renderWaiting(players, canStart, hostId) {
  const list = document.getElementById('playerList');
  list.innerHTML = '';
  players.forEach(p => {
    const row = document.createElement('div');
    row.className = 'log-entry info';
    row.textContent = `${p.name}${p.id === hostId ? ' (ホスト)' : ''}`;
    list.appendChild(row);
  });
  const startBtn = document.getElementById('startBattleBtn');
  // 全員が開始できるよう、人数条件のみで有効化
  startBtn.disabled = !canStart;
}

function initSocket() {
    // 役割に応じたステータスラベルを組み立てるヘルパー
    function buildRoleStatLabel(card) {
      const role = (card?.role || '').toLowerCase();
      if (role === 'attack') {
        const atk = Number(card?.attack);
        return isFinite(atk) ? `ATK:${atk}` : '';
      }
      if (role === 'defense') {
        const def = Number(card?.defense);
        return isFinite(def) ? `DEF:${def}` : '';
      }
      return '';
    }
  socket = io(SOCKET_URL, {
    transports: ['websocket'],
  });
  socket.on('connect', () => {
    console.log('connected', socket.id);
  });

  socket.on('errorMessage', ({ message }) => alert(message));

  socket.on('joinedRoom', ({ roomId: rId, players, isHost: hostFlag, playerId: pid }) => {
    roomId = rId;
    isHost = hostFlag;
    playerId = pid;
    showSection('waitingSection');
    document.getElementById('waitingInfo').textContent = `ルームID: ${roomId}`;
    renderWaiting(players, false, players[0]?.id);
  });

  socket.on('waitingUpdate', ({ players = [], canStart = false, hostId }) => {
    if (roomId) {
      showSection('waitingSection');
      renderWaiting(players, canStart, hostId);
      document.getElementById('waitingInfo').textContent = `参加人数: ${players.length}人`;
    } else {
      showSection('matchingSection');
      const matchingMessage = document.getElementById('matchingMessage');
      matchingMessage.textContent = `参加待ち: ${players.length}人。相手を待っています...`;
    }
  });

  socket.on('battleStarted', ({ players, turn }) => {
    showSection('battleSection');
    initGodFieldLayout();
    const me = players.find(p => p.id === playerId);
    const op = players.find(p => p.id !== playerId);
    updateHealthBars(me ? me.hp : 100, op ? op.hp : 100);
    myStamina = 100; myMp = 50; opStamina = 100; opMp = 50; updateGodFieldBars();
    currentTurn = turn;
    supportRemaining = 3;
    updateSupportCounter();
    const myTurn = currentTurn === playerId;
    updateTurnIndicator(myTurn);
    toggleInputs(myTurn);
    const wins = getWinCount();
    setStatus(myTurn ? 'あなたのターン、攻撃の言葉を入力してください' : '相手のターンを待っています');
    appendLog('バトル開始！', 'info');
    if (wins > 0) {
      appendLog(`あなたの通算勝利数: ${wins}`, 'info');
    }
  });

  socket.on('attackDeclared', async ({ attackerId, defenderId, card }) => {
    const isAttacker = attackerId === playerId;
    const isDefender = defenderId === playerId;
    
    // カットイン演出
    await showCutin(card, 2000);
    // 中央プレイエリア表示（提出演出付き）
    showCenterCard({ ...card, isSubmit: true });
    
    const statLabel = buildRoleStatLabel(card);
    const attr = (card.element || (card.attribute || '')?.toUpperCase());
    const labelText = statLabel ? ` ${statLabel}` : '';
    appendLog(`${isAttacker ? 'あなた' : '相手'}の攻撃: ${card.word} (${attr})${labelText}`, 'damage');
    flashAttackEffect();
    toggleInputs(false);
    
    if (isDefender) {
      // 防御ポップアップモーダル表示
      showDefenseModal(card);
    } else {
      setStatus('相手の防御を待っています...');
      updateTurnIndicator(false);
    }
  });

  socket.on('turnResolved', async ({ attackerId, defenderId, attackCard, defenseCard, damage, counterDamage, dotDamage, appliedStatus, fieldEffect, statusTick, hp, players, nextTurn, winnerId, defenseFailed, affinity }) => {
    const meHp = hp[playerId] ?? myHp;
    const opHp = Object.entries(hp).find(([id]) => id !== playerId)?.[1] ?? opponentHp;

    // ターン開始時の状態異常処理
    if (statusTick) {
      appendLog('⏰ ターン開始: 状態異常を処理中...', 'info');
      for (const tick of statusTick) {
        const targetName = tick.playerId === playerId ? 'あなた' : '相手';
        for (const result of tick.results) {
          if (result.type === 'dot') {
            appendLog(`💀 ${targetName}は ${result.ailmentName} で ${result.value} ダメージ受けた！`, 'damage');
            showDamageAnimation(tick.playerId === playerId ? 'my' : 'op', result.value, null);
          } else if (result.type === 'expired') {
            appendLog(`✨ ${targetName}の ${result.ailmentName} が消滅した`, 'info');
          }
        }
      }
      // 状態異常バッジを更新
      if (players && players.length > 0) {
        players.forEach(p => {
          updateStatusBadges(p.id, p.statusAilments || []);
        });
      }
    }

    const cutinFlavor = buildCutinFlavor({ affinity, defenseCard, defenseFailed });

    // 防御カードのカットイン（相性・反射の一言付き）
    if (defenseCard) {
      await showCutin(defenseCard, 2000, cutinFlavor);
      showCenterCard({ ...defenseCard, isSubmit: true });
    }

    // 防御失敗メッセージ
    if (defenseFailed) {
      appendLog('⚠️ 防御失敗！攻撃カードを使用したためフルダメージ！', 'damage');
    }

    // ダメージ表示
    if (damage > 0) {
      showDamageAnimation(defenderId === playerId ? 'my' : 'op', damage, affinity);
      // ダメージ計算時のインパクト演出（常時）
      screenShake();
    }

    // カウンターダメージ表示（トゲ系）
    if (counterDamage > 0) {
      setTimeout(() => {
        showDamageAnimation(attackerId === playerId ? 'my' : 'op', counterDamage, null);
        appendLog(`🌵 カウンター！ トゲで ${counterDamage} ダメージ`, 'damage');
        showFloatingText(attackerId === playerId ? 'my' : 'op', `カウンター -${counterDamage}`, 'counter');
      }, 800);
    }

    // 状態異常付与ログ
    if (appliedStatus && appliedStatus.length > 0) {
      appliedStatus.forEach(s => {
        const toMe = s.targetId === playerId;
        appendLog(`🩸 ${toMe ? 'あなた' : '相手'} に状態異常付与: ${s.name} (${s.effectType || 'effect'}, ${s.turns}ターン, 値:${s.value ?? 0})`, 'debuff');
      });
      // 状態異常バッジを更新
      if (players && players.length > 0) {
        players.forEach(p => {
          updateStatusBadges(p.id, p.statusAilments || []);
        });
      }
    }

    // フィールド効果表示
    if (fieldEffect && fieldEffect.name) {
      showFieldEffect(fieldEffect);
    }

    // 回復表示
    if (attackCard.effect === 'heal') {
      showHealAnimation(attackerId === playerId ? 'my' : 'op', Math.round(attackCard.attack * 0.6));
    }

    updateHealthBars(meHp, opHp);
    const atkLabel = buildRoleStatLabel(attackCard);
    const defLabel = buildRoleStatLabel(defenseCard);
    const atkText = atkLabel ? ` [${atkLabel}]` : '';
    const defText = defLabel ? ` [${defLabel}]` : '';
    appendLog(`攻撃: ${attackCard.word}${atkText} / 防御: ${defenseCard.word}${defText}`, 'info');

    if (affinity) {
      const relation = affinity.relation || 'neutral';
      const atkElem = attackCard.element || (attackCard.attribute || '').toUpperCase();
      const defElem = defenseCard.element || (defenseCard.attribute || '').toUpperCase();
      appendLog(`属性相性: ${atkElem} vs ${defElem} → x${affinity.multiplier ?? 1} (${relation})`, relation === 'advantage' ? 'buff' : relation === 'disadvantage' ? 'debuff' : 'info');
      if (relation === 'advantage') {
        appendLog('属性有利！ダメージ増加！', 'buff');
      } else if (relation === 'disadvantage') {
        appendLog('属性不利…ダメージ減少', 'debuff');
      }
      showAffinityMessage(relation);
    }

    // フィールド効果の補正ログ
    if (fieldEffect && fieldEffect.name && fieldEffect.multiplier) {
      const atkElem = attackCard.element || (attackCard.attribute || '').toUpperCase();
      if (atkElem === fieldEffect.name) {
        const turnInfo = fieldEffect.turns > 0 ? `（残り${fieldEffect.turns}ターン）` : '';
        appendLog(`🌍 環境効果: ${fieldEffect.name}属性が${fieldEffect.multiplier}倍に強化！${turnInfo}`, 'buff');
      }
      // グローバル環境効果を更新してバッジを表示
      currentFieldEffect = fieldEffect;
      updateFieldEffectBadge(fieldEffect);
    }

    appendLog(`ダメージ: ${damage}`, 'damage');

    if (winnerId) {
      const winMe = winnerId === playerId;
      if (winMe) {
        const totalWins = incrementWinCount();
        setStatus(`🎉 あなたの勝利！🎉 (通算 ${totalWins} 勝)`);
        appendLog(`あなたの勝利！(通算 ${totalWins} 勝)`, 'win');
        document.getElementById('resultMessage').textContent = `勝利しました！🎊\n通算勝利数: ${totalWins}`;
      } else {
        setStatus('😢 敗北...');
        appendLog('相手の勝利', 'win');
        document.getElementById('resultMessage').textContent = '敗北しました...😢';
      }
      // 結果画面に遷移する前に背景をリセット
      currentFieldEffect = null;
      document.body.style.background = '';
      updateFieldEffectBadge(null);
      showSection('resultSection');
      return;
    }

    // 演出後でも必ずターン同期
    syncTurnState({ nextTurn, hp, players });
    // nextTurn が存在する場合は確実に currentTurn を更新
    if (nextTurn) {
      currentTurn = nextTurn;
    }
    setStatus(currentTurn === playerId ? 'あなたのターン、攻撃の言葉を入力してください' : '相手のターンを待っています');
  });

  socket.on('supportUsed', async ({ playerId: supportPlayerId, card, hp, supportRemaining: newRemaining, winnerId, nextTurn, statusTick, appliedStatus, fieldEffect, players }) => {
    // ターン開始時の状態異常処理
    if (statusTick) {
      appendLog('⏰ ターン開始: 状態異常を処理中...', 'info');
      for (const tick of statusTick) {
        const targetName = tick.playerId === playerId ? 'あなた' : '相手';
        for (const result of tick.results) {
          if (result.type === 'dot') {
            appendLog(`💀 ${targetName}は ${result.ailmentName} で ${result.value} ダメージ受けた！`, 'damage');
            showDamageAnimation(tick.playerId === playerId ? 'my' : 'op', result.value, null);
          } else if (result.type === 'expired') {
            appendLog(`✨ ${targetName}の ${result.ailmentName} が消滅した`, 'info');
          }
        }
      }
      // 状態異常バッジを更新
      if (players && players.length > 0) {
        players.forEach(p => {
          updateStatusBadges(p.id, p.statusAilments || []);
        });
      }
    }
    
    // サポートカード判定：role が 'support' の場合は専用演出を使用
    const isSupport = (card.role || '').toLowerCase() === 'support';
    
    if (isSupport) {
      // サポート専用演出：カットインなし、オーバーレイのみ表示
      await showSupportOverlay(card, 3000);
      showCenterCard({ ...card, isSubmit: true });
    } else {
      // 通常カード：カットイン演出を表示
      await showCutin(card, 2000);
      showCenterCard({ ...card, isSubmit: true });
    }

    const isMe = supportPlayerId === playerId;
    
    // supportType に基づいた詳細な効果表示
    let supportTypeEmoji = {
      'heal': '🏥',
      'hpMaxUp': '💪',
      'staminaRecover': '⚡',
      'magicRecover': '✨',
      'defenseBuff': '🛡️',
      'poison': '☠️',
      'burn': '🔥',
      'allStatBuff': '👑',
      'debuff': '📉',
      'cleanse': '💧',
      'counter': '⚔️',
      'fieldChange': '🌍'
    };
    
    const supportTypeEffectMap = {
      'heal': 'HP回復',
      'hpMaxUp': '最大HP増加',
      'staminaRecover': 'スタミナ回復',
      'magicRecover': '魔力回復',
      'defenseBuff': '防御力強化',
      'allStatBuff': '全能力強化',
      'poison': '毒付与',
      'burn': '焼け付与',
      'debuff': '能力低下',
      'cleanse': '状態異常クリア',
      'counter': 'カウンター準備',
      'fieldChange': 'フィールド変化'
    };
    
    const emoji = supportTypeEmoji[card.supportType] || '📌';
    const effectLabel = supportTypeEffectMap[card.supportType] || card.supportType || 'サポート';
    
     // メインログ：誰が何を使ったか
     if (card && card.word) {
       appendLog(`${emoji} ${isMe ? 'あなた' : '相手'}がサポートを使用: ${card.word} (${effectLabel})`, 'info');
     } else {
       appendLog(`${emoji} ${isMe ? 'あなた' : '相手'}がサポートを使用 (${effectLabel})`, 'info');
     }
    
    // 効果詳細ログ
    const effectMessage = buildSupportEffectMessage(card, isMe);
    appendLog(`→ ${effectMessage}`, 'buff');
    
    // サポートメッセージがあれば追加
    if (card.supportMessage) {
      appendLog(`  詳細: ${card.supportMessage}`, 'buff');
    }
    // サポートメッセージが無い場合のフォールバック表示
    if (!card.supportMessage && card.supportType === 'fieldChange') {
      appendLog(`  環境が変化した！`, 'buff');
    }
    if (!card.supportMessage && card.supportType !== 'fieldChange') {
      appendLog(`  詳細: ${card.word || 'サポート'}が効果を発動した`, 'buff');
    }

    if (appliedStatus && appliedStatus.length > 0) {
      appliedStatus.forEach(s => {
        const toMe = s.targetId === playerId;
        appendLog(`🩸 ${toMe ? 'あなた' : '相手'} に状態異常付与: ${s.name} (${s.effectType || 'effect'}, ${s.turns}ターン, 値:${s.value ?? 0})`, 'debuff');
      });
      // 状態異常バッジを更新
      if (players && players.length > 0) {
        players.forEach(p => {
          updateStatusBadges(p.id, p.statusAilments || []);
        });
      }
    }

    // フィールド効果の表示（背景グラデーション更新）
    if (fieldEffect && fieldEffect.name) {
      showFieldEffect(fieldEffect);
    } else if (card && card.supportType === 'fieldChange') {
      // supportType が fieldChange だが fieldEffect オブジェクトが無い場合、通知を表示
      appendLog(`🌍 環境が変化した！`, 'buff');
    }

    if (isMe && typeof newRemaining === 'number') {
      supportRemaining = newRemaining;
      updateSupportCounter();
    }

    myHp = hp[playerId];
    const opponentId = Object.keys(hp).find(id => id !== playerId);
    opponentHp = hp[opponentId];

    updateHealthBars(myHp, opponentHp);
    // Supportの種類に応じてST/MPを簡易的に更新（UI演出）
    const valueMatch = (card.supportMessage || '').match(/(\d+)/);
    const amount = valueMatch ? parseInt(valueMatch[1], 10) : 0;
    if ((card.supportType || '').toLowerCase() === 'staminaRecover') {
      if (isMe) { myStamina = Math.min(100, myStamina + amount); } else { opStamina = Math.min(100, opStamina + amount); }
    } else if ((card.supportType || '').toLowerCase() === 'magicRecover') {
      if (isMe) { myMp = Math.min(100, myMp + amount); } else { opMp = Math.min(100, opMp + amount); }
    }
    updateGodFieldBars();

    if (winnerId) {
      const winMe = winnerId === playerId;
      if (winMe) {
        const totalWins = incrementWinCount();
        setStatus(`🎉 あなたの勝利！🎉 (通算 ${totalWins} 勝)`);
        appendLog(`あなたの勝利！(通算 ${totalWins} 勝)`, 'win');
        document.getElementById('resultMessage').textContent = `勝利しました！🎊\n通算勝利数: ${totalWins}`;
      } else {
        setStatus('😢 敗北...');
        appendLog('相手の勝利', 'win');
        document.getElementById('resultMessage').textContent = '敗北しました...😢';
      }
      // 結果画面に遷移する前に背景をリセット
      currentFieldEffect = null;
      document.body.style.background = '';
      updateFieldEffectBadge(null);
      showSection('resultSection');
      return;
    }

    // 演出後でも必ずターン同期
    syncTurnState({ nextTurn, hp, players });
    // nextTurn が存在する場合は確実に currentTurn を更新
    if (nextTurn) {
      currentTurn = nextTurn;
    }
    setStatus(currentTurn === playerId ? 'あなたのターン、攻撃の言葉を入力してください' : '相手のターンを待っています');
  });

  socket.on('opponentLeft', ({ message }) => {
    appendLog(message || '相手が離脱しました', 'win');
    // 背景をリセット
    currentFieldEffect = null;
    document.body.style.background = '';
    updateFieldEffectBadge(null);
    showSection('resultSection');
    document.getElementById('resultMessage').textContent = message || '相手が離脱しました';
  });

  socket.on('status', ({ message }) => setStatus(message));

  // 【完全同期】ターン更新イベントを受け取り UI を同期
  socket.on('turnUpdate', ({ activePlayer, activePlayerName, turnIndex, players }) => {
    console.log(`📢 turnUpdate受信: アクティブプレイヤー=${activePlayerName}, turnIndex=${turnIndex}`);
    
    currentTurn = activePlayer;
    currentTurnIndex = turnIndex;

    // サーバー状態で必ず同期
    syncTurnState({ activePlayer, players });

    const myTurn = activePlayer === socket.id;
    setStatus(myTurn ? 'あなたのターン、攻撃の言葉を入力してください' : `${activePlayerName} のターン進行中`);
    console.log(`✅ ターン同期完了: ${myTurn ? 'あなたが' : activePlayerName + 'が'}プレイ中`);
  });

  socket.on('fieldEffectUpdate', ({ fieldEffect }) => {
    if (fieldEffect && fieldEffect.name) {
      showFieldEffect(fieldEffect);
      updateFieldEffectBadge(fieldEffect);
    } else {
      // フィールド効果が消えた場合
      currentFieldEffect = null;
      document.body.style.background = '';
      updateFieldEffectBadge(null);
      appendLog('🌐 環境効果が消滅した', 'info');
    }
  });

  socket.on('matchCancelled', ({ message }) => {
    console.log('🚫 マッチングがキャンセルされました');
    
    // 状態を完全にリセット
    roomId = null;
    currentTurn = null;
    isHost = false;
    playerId = null;
    myHp = 0;
    opponentHp = 0;
    supportRemaining = 3;
    
    // 環境効果をリセット
    currentFieldEffect = null;
    document.body.style.background = '';
    updateFieldEffectBadge(null);
    
    // ホーム画面に戻る
    showSection('homeSection');
    setStatus(message || 'マッチングをキャンセルしました');
    
    // 入力欄をクリア
    const attackInput = document.getElementById('attackWordInput');
    const defenseInput = document.getElementById('defenseModalInput');
    if (attackInput) attackInput.value = '';
    if (defenseInput) defenseInput.value = '';
  });
}

function join(matchType) {
  playerName = document.getElementById('playerNameInput').value.trim();
  const password = document.getElementById('passwordInput').value.trim();
  if (!playerName) {
    alert('プレイヤー名を入力してください');
    return;
  }
  const matchingMessage = document.getElementById('matchingMessage');
  matchingMessage.textContent = matchType === 'password'
    ? '指定されたパスワードで相手を探しています...'
    : '相手を探しています...';
  showSection('matchingSection');
  if (!socket || !socket.connected) {
    initSocket();
    setTimeout(() => join(matchType), 200);
    return;
  }
  socket.emit('startMatching', { name: playerName, mode: matchType, password: matchType === 'password' ? password : undefined });
}

function requestStart() {
  socket.emit('requestStart');
}

function submitAttack() {
  const word = document.getElementById('attackWordInput').value.trim();
  socket.emit('playWord', { word });
  document.getElementById('attackWordInput').value = '';
}

function showDefenseModal(attackCard) {
  const modal = document.getElementById('defenseModal');
  const message = document.getElementById('defenseModalMessage');
  message.textContent = `相手が「${attackCard.word}」で攻撃してきた！ 防御してください！`;
  modal.classList.remove('hidden');
  document.getElementById('defenseModalInput').focus();
  setStatus('⚔️ 防御フェーズ - 言葉を入力してください ⚔️');
  updateTurnIndicator(false);
}

function hideDefenseModal() {
  const modal = document.getElementById('defenseModal');
  modal.classList.add('hidden');
  document.getElementById('defenseModalInput').value = '';
}

function submitDefenseModal() {
  const word = document.getElementById('defenseModalInput').value.trim();
  if (!word) {
    alert('防御の言葉を入力してください！');
    return;
  }
  console.log('🛡️ 防御を送信:', word);
  socket.emit('defendWord', { word });
  hideDefenseModal();
  setStatus('防御を送信しました...');
}
function submitSupport() {
  const word = document.getElementById('attackWordInput').value.trim();
  if (!word) {
    alert('サポートの言葉を入力してください');
    return;
  }
  if (supportRemaining <= 0) {
    alert('サポートはこの試合で使用できません');
    return;
  }
  document.getElementById('attackBtn').disabled = true;
  document.getElementById('supportBtn').disabled = true;
  document.getElementById('attackWordInput').disabled = true;
  
  socket.emit('supportAction', { word });
  document.getElementById('attackWordInput').value = '';
}

function cancelMatching() {
  console.log('🚫 キャンセルボタンが押されました');
  
  if (socket && socket.connected) {
    socket.emit('cancelMatching');
    console.log('  → サーバーにcancelMatchingを送信');
  } else {
    console.warn('  ⚠️ socketが接続されていません');
  }
  
  // UIを即座にホームに戻す
  showSection('homeSection');
  setStatus('マッチングをキャンセルしています...');
}

function initAffinityPanel() {
  const toggle = document.getElementById('affinityToggle');
  const panel = document.getElementById('affinityPanel');
  const closeBtn = document.getElementById('affinityClose');
  if (!toggle || !panel) return;

  const hide = () => panel.classList.add('hidden');
  const togglePanel = () => panel.classList.toggle('hidden');

  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    togglePanel();
  });

  if (closeBtn) {
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      hide();
    });
  }

  document.addEventListener('click', (e) => {
    if (!panel.classList.contains('hidden') && !panel.contains(e.target) && !toggle.contains(e.target)) {
      hide();
    }
  });
}

function bindUI() {
  document.getElementById('matchCardRandom').addEventListener('click', () => selectMatchMode('random'));
  document.getElementById('matchCardPassword').addEventListener('click', () => selectMatchMode('password'));
  document.getElementById('matchStartBtn').addEventListener('click', startMatch);
  document.getElementById('startBattleBtn').addEventListener('click', requestStart);
  document.getElementById('waitingCancelBtn').addEventListener('click', cancelMatching);
  document.getElementById('cancelMatchingBtn').addEventListener('click', cancelMatching);
  document.getElementById('returnHomeBtn').addEventListener('click', () => location.reload());
  document.getElementById('attackBtn').addEventListener('click', submitAttack);
  document.getElementById('defenseModalBtn').addEventListener('click', submitDefenseModal);
  document.getElementById('defenseModalInput').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') submitDefenseModal();
  });

  // サポートボタンのハンドラー
  const supportBtn = document.getElementById('supportBtn');
  if (supportBtn) {
    supportBtn.addEventListener('click', submitSupport);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  bindUI();
  initAffinityPanel();
  initSocket();
  showSection('homeSection');
  toggleInputs(false);
  // レイアウト準備（バトル開始時に有効化）
  // initGodFieldLayout();
  
  // 戦歴を表示
  const wins = getWinCount();
  if (wins > 0) {
    const badge = document.getElementById('winCountBadge');
    if (badge) {
      badge.textContent = `🏆 ${wins}勝`;
      badge.classList.remove('hidden');
    }
  }
});

// マッチタイプ選択（新UI）
let selectedMode = 'random';
function selectMatchMode(mode) {
  selectedMode = mode;
  const randomCard = document.getElementById('matchCardRandom');
  const passwordCard = document.getElementById('matchCardPassword');
  randomCard.classList.toggle('selected', mode === 'random');
  passwordCard.classList.toggle('selected', mode === 'password');
  const wrap = document.getElementById('passwordWrap');
  wrap.classList.toggle('hidden', mode !== 'password');
}

function startMatch() {
  if (selectedMode === 'password' && !document.getElementById('passwordInput').value.trim()) {
    alert('パスワードを入力してください');
    return;
  }
  join(selectedMode);
}
