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

// カットイン演出表示
function showCutin(card, duration = 2500) {
  return new Promise((resolve) => {
    const cutinModal = document.getElementById('cutinModal');
    const cutinWord = document.getElementById('cutinWord');
    const cutinStats = document.getElementById('cutinStats');
    const cutinTier = document.getElementById('cutinTier');
    const cutinSpecial = document.getElementById('cutinSpecial');
    const cutinComment = document.getElementById('cutinComment');

    cutinWord.textContent = card.word;
    cutinStats.textContent = `攻撃力: ${card.attack} / 防御力: ${card.defense}`;
    cutinTier.textContent = `${card.attribute.toUpperCase()} [${card.tier.toUpperCase()}] ${card.effect.toUpperCase()}`;
    cutinSpecial.textContent = `特殊効果: ${card.specialEffect || 'なし'}`;
    cutinComment.textContent = card.judgeComment || '審判: 良好';

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

function toggleInputs(canAttack, canDefend) {
  document.getElementById('attackWordInput').disabled = !canAttack;
  document.getElementById('attackBtn').disabled = !canAttack;
  document.getElementById('defenseWordInput').disabled = !canDefend;
  document.getElementById('defenseBtn').disabled = !canDefend;
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
  startBtn.disabled = !(isHost && canStart);
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
    toggleInputs(myTurn, false);
    setStatus(myTurn ? 'あなたのターン、攻撃の言葉を入力してください' : '相手のターンを待っています');
    appendLog('バトル開始！', 'info');
  });

  socket.on('attackDeclared', async ({ attackerId, defenderId, card }) => {
    const isAttacker = attackerId === playerId;
    const isDefender = defenderId === playerId;
    
    // カットイン演出
    await showCutin(card, 2000);
    
    appendLog(`${isAttacker ? 'あなた' : '相手'}の攻撃: ${card.word} (${card.attribute}) ATK:${card.attack}`, 'damage');
    flashAttackEffect();
    toggleInputs(false, false);
    
    if (isDefender) {
      // 防御ポップアップモーダル表示
      showDefenseModal(card);
    } else {
      setStatus('相手の防御を待っています...');
      updateTurnIndicator(false);
    }
  });

  socket.on('turnResolved', async ({ attackerId, defenderId, attackCard, defenseCard, damage, hp, nextTurn, winnerId, defenseFailed }) => {
    const meHp = hp[playerId] ?? myHp;
    const opHp = Object.entries(hp).find(([id]) => id !== playerId)?.[1] ?? opponentHp;

    // 防御カードのカットイン
    if (defenseCard) {
      await showCutin(defenseCard, 2000);
    }

    // 防御失敗メッセージ
    if (defenseFailed) {
      appendLog('⚠️ 防御失敗！攻撃カードを使用したためフルダメージ！', 'damage');
    }

    // ダメージ表示
    if (damage > 0) {
      showDamageAnimation(defenderId === playerId ? 'my' : 'op', damage);
    }

    // 回復表示
    if (attackCard.effect === 'heal') {
      showHealAnimation(attackerId === playerId ? 'my' : 'op', Math.round(attackCard.attack * 0.6));
    }

    updateHealthBars(meHp, opHp);
    appendLog(`攻撃: ${attackCard.word} (${attackCard.effect}) / 防御: ${defenseCard.word} (${defenseCard.effect})`, 'info');
    appendLog(`ダメージ: ${damage}`, 'damage');

    if (winnerId) {
      const winMe = winnerId === playerId;
      setStatus(winMe ? '🎉 あなたの勝利！🎉' : '😢 敗北...');
      appendLog(winMe ? 'あなたの勝利！' : '相手の勝利', 'win');
      showSection('resultSection');
      document.getElementById('resultMessage').textContent = winMe ? '勝利しました！🎊' : '敗北しました...😢';
      return;
    }

    currentTurn = nextTurn;
    const myTurn = currentTurn === playerId;
    updateTurnIndicator(myTurn);
    toggleInputs(myTurn, false);
    setStatus(myTurn ? 'あなたのターン、攻撃の言葉を入力してください' : '相手のターンを待っています');
  });

  socket.on('supportUsed', async ({ playerId: supportPlayerId, card, hp, supportRemaining: newRemaining }) => {
    await showCutin(card, 2000);
    
    const isMe = supportPlayerId === playerId;
    appendLog(`${isMe ? 'あなた' : '相手'}がサポートを使用: ${card.word} (${card.supportType})`, 'info');
    
    if (isMe) {
      supportRemaining = newRemaining;
      updateSupportCounter();
    }
    
    myHp = hp[playerId];
    const opponentId = Object.keys(hp).find(id => id !== playerId);
    opponentHp = hp[opponentId];
    
    updateHealthBars(myHp, opponentHp);
    
    toggleInputs(true, false);
  });

  socket.on('opponentLeft', ({ message }) => {
    appendLog(message || '相手が離脱しました', 'win');
    showSection('resultSection');
    document.getElementById('resultMessage').textContent = message || '相手が離脱しました';
  });

  socket.on('status', ({ message }) => setStatus(message));

  socket.on('matchCancelled', ({ message }) => {
    roomId = null;
    currentTurn = null;
    isHost = false;
    supportRemaining = 3;
    showSection('homeSection');
    setStatus(message || 'マッチングをキャンセルしました');
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
  socket.emit('joinGame', { name: playerName, mode: matchType, password: matchType === 'password' ? password : undefined });
}

function requestStart() {
  socket.emit('requestStart');
}

function submitAttack() {
  const word = document.getElementById('attackWordInput').value.trim();
  socket.emit('playWord', { word });
  document.getElementById('attackWordInput').value = '';
}

function submitDefense() {
  const word = document.getElementById('defenseWordInput').value.trim();
  socket.emit('defendWord', { word });
  document.getElementById('defenseWordInput').value = '';
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
  if (socket) {
    socket.emit('cancelMatch');
  }
  showSection('homeSection');
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
  document.getElementById('defenseBtn').addEventListener('click', submitDefense);
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
  initSocket();
  showSection('homeSection');
  toggleInputs(false, false);
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
