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

// 演出関数群
function showFloatingText(x, y, text, type = 'damage') {
  const container = document.getElementById('effectContainer');
  const floatingText = document.createElement('div');
  floatingText.className = `floating-text ${type}`;
  floatingText.textContent = text;
  floatingText.style.left = x + 'px';
  floatingText.style.top = y + 'px';
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

function showDamageAnimation(targetHp, damage) {
  const targetBar = targetHp === 'my' ? document.getElementById('myHealthFill') : document.getElementById('opHealthFill');
  const rect = targetBar.getBoundingClientRect();
  const x = rect.left + rect.width / 2 - 20;
  const y = rect.top + rect.height;
  
  flashAttackEffect();
  showFloatingText(x, y, `-${damage}`, 'damage');
  bounceEffect(targetHp === 'my' ? 'myHealthFill' : 'opHealthFill');
}

function showHealAnimation(targetHp, amount) {
  const targetBar = targetHp === 'my' ? document.getElementById('myHealthFill') : document.getElementById('opHealthFill');
  const rect = targetBar.getBoundingClientRect();
  const x = rect.left + rect.width / 2 - 20;
  const y = rect.top + rect.height;
  
  showFloatingText(x, y, `+${amount}`, 'heal');
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

    cutinWord.textContent = card.word;
    
    // role ベースの表示制御：不規則な数値をそのまま表示
    const role = (card.role || card.effect || 'neutral').toLowerCase();
    let statsDisplay = '';
    
    if (role === 'defense') {
      // Defense ロール：防御力のみ表示、攻撃力は非表示
      statsDisplay = `防御力: ${card.defense}`;
    } else if (role === 'attack') {
      // Attack ロール：攻撃力のみ表示、防御力は非表示
      statsDisplay = `攻撃力: ${card.attack}`;
    } else if (role === 'support') {
      // Support ロール：効果説明を優先
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
      const typeLabel = supportTypeLabel[card.supportType] || card.supportType || 'サポート効果';
      statsDisplay = typeLabel;
    } else {
      // デフォルト：両方表示
      statsDisplay = `攻撃力: ${card.attack} / 防御力: ${card.defense}`;
    }
    
    cutinStats.textContent = statsDisplay;
    
    // role / tier の順で表示
    const roleDisplay = (card.role || card.effect || 'neutral').toUpperCase();
    const tier = (card.tier || 'common').toUpperCase();
    cutinTier.textContent = `${card.attribute.toUpperCase()} [${tier}] ${roleDisplay}`;
    
    // 特殊効果と サポート情報を表示
    let specialInfo = card.specialEffect || 'なし';
    if (card.supportMessage) {
      specialInfo = `${card.specialEffect} → ${card.supportMessage}`;
    }
    cutinSpecial.textContent = `特殊効果: ${specialInfo}`;
    
    // コメント（審判コメント + 相性情報等）
    const comments = [card.judgeComment || '判定コメントなし'];
    if (extraComment) comments.push(extraComment);
    cutinComment.textContent = comments.join(' / ');

    cutinModal.classList.remove('hidden');

    setTimeout(() => {
      cutinModal.classList.add('hidden');
      resolve();
    }, duration);
  });
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
  if (fieldEffect && fieldEffect.visual) {
    // 背景グラデーションを適用
    document.body.style.background = fieldEffect.visual;
    document.body.style.backgroundAttachment = 'fixed';
    
    // 中央に大きく効果名を表示
    const announcement = document.createElement('div');
    announcement.className = 'field-announcement';
    announcement.textContent = fieldEffect.name || 'フィールド効果発動！';
    document.body.appendChild(announcement);
    
    // 3秒後に背景を戻す
    setTimeout(() => {
      announcement.remove();
      // 背景をデフォルトに戻す（戦闘画面のスタイルに依存）
      document.body.style.background = '';
    }, 3000);
    
    appendLog(`� フィールド効果発動: ${fieldEffect.name}`, 'info');
  }
}

// サポート効果専用の演出表示
function showSupportOverlay(supportCard, duration = 3000) {
  return new Promise((resolve) => {
    // 既存のオーバーレイがあれば削除
    const existingOverlay = document.getElementById('supportOverlay');
    if (existingOverlay) {
      existingOverlay.remove();
    }

    // サポート演出用のコンテナを動的に作成
    const overlay = document.createElement('div');
    overlay.id = 'supportOverlay';
    overlay.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: linear-gradient(135deg, rgba(100, 150, 255, 0.4), rgba(200, 100, 255, 0.4));
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      z-index: 10000;
      animation: supportFade 0.5s ease-in-out;
      font-family: 'Arial', sans-serif;
    `;

    // サポート名（単語）を表示するエレメント
    const supportNameEl = document.createElement('div');
    supportNameEl.style.cssText = `
      font-size: 3.5em;
      font-weight: bold;
      color: #fff;
      text-shadow: 3px 3px 8px rgba(0, 0, 0, 0.8);
      margin-bottom: 20px;
      letter-spacing: 2px;
      animation: supportWordPop 0.6s cubic-bezier(0.68, -0.55, 0.265, 1.55);
    `;
    supportNameEl.textContent = supportCard.word;

    // サポートメッセージを表示するエレメント
    const supportMessageEl = document.createElement('div');
    supportMessageEl.style.cssText = `
      font-size: 1.5em;
      color: #fff;
      text-shadow: 2px 2px 6px rgba(0, 0, 0, 0.8);
      text-align: center;
      max-width: 600px;
      line-height: 1.6;
      animation: supportMessageSlide 0.8s ease-out 0.3s both;
    `;
    supportMessageEl.textContent = supportCard.supportMessage || '効果を発動！';

    // 特殊効果を表示するエレメント
    const specialEl = document.createElement('div');
    specialEl.style.cssText = `
      font-size: 1.2em;
      color: #ffeb3b;
      text-shadow: 2px 2px 4px rgba(0, 0, 0, 0.8);
      margin-top: 20px;
      animation: supportSpecialGlow 1s ease-in-out 0.5s infinite;
    `;
    specialEl.textContent = supportCard.specialEffect || '';

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
      margin-bottom: 15px;
      animation: supportIconBounce 0.6s ease-in-out;
    `;
    iconEl.textContent = icon;

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
          }
          to {
            opacity: 1;
          }
        }
        @keyframes supportWordPop {
          0% {
            transform: scale(0) rotateZ(-10deg);
            opacity: 0;
          }
          50% {
            transform: scale(1.1) rotateZ(5deg);
          }
          100% {
            transform: scale(1) rotateZ(0deg);
            opacity: 1;
          }
        }
        @keyframes supportMessageSlide {
          from {
            transform: translateY(20px);
            opacity: 0;
          }
          to {
            transform: translateY(0);
            opacity: 1;
          }
        }
        @keyframes supportSpecialGlow {
          0%, 100% {
            opacity: 0.7;
            text-shadow: 2px 2px 4px rgba(0, 0, 0, 0.8);
          }
          50% {
            opacity: 1;
            text-shadow: 0px 0px 20px rgba(255, 235, 59, 0.8);
          }
        }
        @keyframes supportIconBounce {
          0% {
            transform: scale(0) translateY(-50px);
            opacity: 0;
          }
          50% {
            transform: scale(1.15);
          }
          100% {
            transform: scale(1) translateY(0);
            opacity: 1;
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
    const me = players.find(p => p.id === playerId);
    const op = players.find(p => p.id !== playerId);
    updateHealthBars(me ? me.hp : 100, op ? op.hp : 100);
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
    
    appendLog(`${isAttacker ? 'あなた' : '相手'}の攻撃: ${card.word} (${card.attribute}) ATK:${card.attack}`, 'damage');
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
            showDamageAnimation(tick.playerId === playerId ? 'my' : 'op', result.value);
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
    }

    // 防御失敗メッセージ
    if (defenseFailed) {
      appendLog('⚠️ 防御失敗！攻撃カードを使用したためフルダメージ！', 'damage');
    }

    // ダメージ表示
    if (damage > 0) {
      showDamageAnimation(defenderId === playerId ? 'my' : 'op', damage);
      if (defenderId === playerId && damage > 20) {
        screenShake();
      }
    }

    // カウンターダメージ表示（トゲ系）
    if (counterDamage > 0) {
      setTimeout(() => {
        showDamageAnimation(attackerId === playerId ? 'my' : 'op', counterDamage);
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
    appendLog(`攻撃: ${attackCard.word} (${attackCard.effect}) / 防御: ${defenseCard.word} (${defenseCard.effect})`, 'info');

    if (affinity) {
      const relation = affinity.relation || 'neutral';
      appendLog(`属性相性: ${attackCard.attribute} vs ${defenseCard.attribute} → x${affinity.multiplier ?? 1} (${relation})`, relation === 'advantage' ? 'buff' : relation === 'disadvantage' ? 'debuff' : 'info');
      showAffinityMessage(relation);
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
      showSection('resultSection');
      return;
    }

    currentTurn = nextTurn;
    const myTurn = currentTurn === playerId;
    updateTurnIndicator(myTurn);
    toggleInputs(myTurn);
    setStatus(myTurn ? 'あなたのターン、攻撃の言葉を入力してください' : '相手のターンを待っています');
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
            showDamageAnimation(tick.playerId === playerId ? 'my' : 'op', result.value);
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
    } else {
      // 通常カード：カットイン演出を表示
      await showCutin(card, 2000);
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
    appendLog(`${emoji} ${isMe ? 'あなた' : '相手'}がサポートを使用: ${card.word} (${effectLabel})`, 'info');
    
    // 効果詳細ログ
    const effectMessage = buildSupportEffectMessage(card, isMe);
    appendLog(`→ ${effectMessage}`, 'buff');
    
    // サポートメッセージがあれば追加
    if (card.supportMessage) {
      appendLog(`  詳細: ${card.supportMessage}`, 'buff');
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
    }

    if (isMe && typeof newRemaining === 'number') {
      supportRemaining = newRemaining;
      updateSupportCounter();
    }

    myHp = hp[playerId];
    const opponentId = Object.keys(hp).find(id => id !== playerId);
    opponentHp = hp[opponentId];

    updateHealthBars(myHp, opponentHp);

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
      showSection('resultSection');
      return;
    }

    if (nextTurn) {
      currentTurn = nextTurn;
    }
    const myTurn = currentTurn === playerId;
    updateTurnIndicator(myTurn);
    toggleInputs(myTurn);
  });

  socket.on('opponentLeft', ({ message }) => {
    appendLog(message || '相手が離脱しました', 'win');
    showSection('resultSection');
    document.getElementById('resultMessage').textContent = message || '相手が離脱しました';
  });

  socket.on('status', ({ message }) => setStatus(message));

  socket.on('fieldEffectUpdate', ({ fieldEffect }) => {
    if (fieldEffect && fieldEffect.name) {
      showFieldEffect(fieldEffect);
    } else {
      // フィールド効果が消えた場合
      const overlay = document.getElementById('fieldEffectOverlay');
      if (overlay) {
        overlay.style.background = '';
      }
      appendLog('🌐 フィールド効果が消滅した', 'info');
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
