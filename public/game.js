const SOCKET_URL = 'https://create-cards.onrender.com';

let socket = null;
let playerId = null;
let playerName = '';
let roomId = null;
let isHost = false;
let currentTurn = null;
let myHp = 0;
let opponentHp = 0;

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

function updateTurnIndicator(isMyTurn) {
  const indicator = document.getElementById('turnIndicator');
  if (isMyTurn) {
    indicator.textContent = '🟢 あなたのターンです！';
    indicator.classList.remove('opponent-turn');
    indicator.classList.add('my-turn');
  } else {
    indicator.textContent = '⏳ 相手のターンを待機中...';
    indicator.classList.remove('my-turn');
    indicator.classList.add('opponent-turn');
  }
}

function showSection(id) {
  ['homeSection', 'waitingSection', 'battleSection', 'resultSection'].forEach(sec => {
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
    renderWaiting(players, canStart, hostId);
    document.getElementById('waitingInfo').textContent = `参加人数: ${players.length}人`;
  });

  socket.on('battleStarted', ({ players, turn }) => {
    showSection('battleSection');
    const me = players.find(p => p.id === playerId);
    const op = players.find(p => p.id !== playerId);
    updateHealthBars(me ? me.hp : 100, op ? op.hp : 100);
    currentTurn = turn;
    const myTurn = currentTurn === playerId;
    updateTurnIndicator(myTurn);
    toggleInputs(myTurn, false);
    setStatus(myTurn ? 'あなたのターン、攻撃の言葉を入力してください' : '相手のターンを待っています');
    appendLog('バトル開始！', 'info');
  });

  socket.on('attackDeclared', ({ attackerId, defenderId, card }) => {
    const isAttacker = attackerId === playerId;
    const isDefender = defenderId === playerId;
    appendLog(`${isAttacker ? 'あなた' : '相手'}の攻撃: ${card.word} (${card.attribute}) ATK:${card.attack}`, 'damage');
    flashAttackEffect();
    toggleInputs(false, isDefender);
    if (isDefender) {
      setStatus('防御の言葉を入力してください！');
      document.getElementById('defenseWordInput').focus();
    } else {
      setStatus('相手の防御を待っています...');
    }
  });

  socket.on('turnResolved', ({ attackerId, defenderId, attackCard, defenseCard, damage, hp, nextTurn, winnerId }) => {
    const meHp = hp[playerId] ?? myHp;
    const opHp = Object.entries(hp).find(([id]) => id !== playerId)?.[1] ?? opponentHp;

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

  socket.on('opponentLeft', ({ message }) => {
    appendLog(message || '相手が離脱しました', 'win');
    showSection('resultSection');
    document.getElementById('resultMessage').textContent = message || '相手が離脱しました';
  });

  socket.on('status', ({ message }) => setStatus(message));
}

function join(matchType) {
  playerName = document.getElementById('playerNameInput').value.trim();
  const password = document.getElementById('passwordInput').value.trim();
  if (!playerName) {
    alert('プレイヤー名を入力してください');
    return;
  }
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

function bindUI() {
  document.getElementById('randomMatchBtn').addEventListener('click', () => join('random'));
  document.getElementById('passwordMatchBtn').addEventListener('click', () => join('password'));
  document.getElementById('startBattleBtn').addEventListener('click', requestStart);
  document.getElementById('backHomeBtn').addEventListener('click', () => location.reload());
  document.getElementById('returnHomeBtn').addEventListener('click', () => location.reload());
  document.getElementById('attackBtn').addEventListener('click', submitAttack);
  document.getElementById('defenseBtn').addEventListener('click', submitDefense);

  document.getElementsByName('matchType').forEach(r => {
    r.addEventListener('change', (e) => {
      const pwdInput = document.getElementById('passwordInput');
      pwdInput.style.display = e.target.value === 'password' ? 'block' : 'none';
    });
  });
}

document.addEventListener('DOMContentLoaded', () => {
  bindUI();
  initSocket();
  showSection('homeSection');
  toggleInputs(false, false);
});
