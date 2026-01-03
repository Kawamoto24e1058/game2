const SOCKET_URL = 'https://create-cards.onrender.com';

let socket = null;
let playerId = null;
let playerName = '';
let roomId = null;
let isHost = false;
let currentTurn = null;
let myHp = 0;
let opponentHp = 0;

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
    toggleInputs(myTurn, false);
    setStatus(myTurn ? 'あなたのターンです' : '相手のターンを待っています');
    appendLog('バトル開始！', 'info');
  });

  socket.on('attackDeclared', ({ attackerId, defenderId, card }) => {
    const isAttacker = attackerId === playerId;
    const isDefender = defenderId === playerId;
    appendLog(`${isAttacker ? 'あなた' : '相手'}の攻撃: ${card.word} (${card.attribute}) ATK:${card.attack}`, 'damage');
    toggleInputs(false, isDefender);
    if (isDefender) {
      setStatus('防御の言葉を入力してください');
      document.getElementById('defenseWordInput').focus();
    } else {
      setStatus('相手の防御を待っています');
    }
  });

  socket.on('turnResolved', ({ attackerId, defenderId, attackCard, defenseCard, damage, hp, nextTurn, winnerId }) => {
    const meHp = hp[playerId] ?? myHp;
    const opHp = Object.entries(hp).find(([id]) => id !== playerId)?.[1] ?? opponentHp;
    updateHealthBars(meHp, opHp);

    appendLog(`攻撃: ${attackCard.word} (${attackCard.effect}) / 防御: ${defenseCard.word} (${defenseCard.effect})`, 'info');
    appendLog(`ダメージ: ${damage}`, 'damage');

    if (winnerId) {
      const winMe = winnerId === playerId;
      setStatus(winMe ? 'あなたの勝利！' : '敗北...');
      appendLog(winMe ? 'あなたの勝利！' : '相手の勝利', 'win');
      showSection('resultSection');
      document.getElementById('resultMessage').textContent = winMe ? '勝利しました！' : '敗北しました...';
      return;
    }

    currentTurn = nextTurn;
    const myTurn = currentTurn === playerId;
    toggleInputs(myTurn, false);
    setStatus(myTurn ? 'あなたのターンです' : '相手のターンを待っています');
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
