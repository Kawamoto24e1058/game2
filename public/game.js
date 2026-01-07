const socket = io();

// グローバル変数（DOMContentLoaded後に初期化）
let passwordInput = null;
let startBtn = null;
let gameContainer = null;
let battleLog = null;
let playerHealth = null;
let opponentHealth = null;
let playerStamina = null;
let playerMagic = null;
let opponentStamina = null;
let opponentMagic = null;
let attackInput = null;
let attackBtn = null;
let defendInput = null;
let defendBtn = null;
let playerName = null;
let opponentName = null;
let statusMessage = null;
let cutinOverlay = null;
let cutinCard = null;
let cutinStats = null;
let supportOverlay = null;
let supportMessage = null;

let currentPlayerId = null;
let opponentId = null;
let currentTurn = null;
let roomId = null;
let gameStarted = false;
let players = [];

// ========================================
// DOM初期化（DOMContentLoaded時）
// ========================================
function initializeDOM() {
  passwordInput = document.getElementById('passwordInput');
  startBtn = document.getElementById('startBtn');
  gameContainer = document.getElementById('gameContainer');
  battleLog = document.getElementById('battleLog');
  playerHealth = document.getElementById('playerHealth');
  opponentHealth = document.getElementById('opponentHealth');
  playerStamina = document.getElementById('playerStamina');
  playerMagic = document.getElementById('playerMagic');
  opponentStamina = document.getElementById('opponentStamina');
  opponentMagic = document.getElementById('opponentMagic');
  attackInput = document.getElementById('attackInput');
  attackBtn = document.getElementById('attackBtn');
  defendInput = document.getElementById('defendInput');
  defendBtn = document.getElementById('defendBtn');
  playerName = document.getElementById('playerName');
  opponentName = document.getElementById('opponentName');
  statusMessage = document.getElementById('statusMessage');
  cutinOverlay = document.getElementById('cutinOverlay');
  cutinCard = document.getElementById('cutinCard');
  cutinStats = document.getElementById('cutinStats');
  supportOverlay = document.getElementById('supportOverlay');
  supportMessage = document.getElementById('supportMessage');

  console.log('✅ DOM要素を初期化しました');
}

// ========================================
// イベントリスナー登録
// ========================================
function setupEventListeners() {
  // マッチングボタン（開始ボタン）
  if (startBtn) {
    startBtn.addEventListener('click', () => {
      console.log('🎮 開始ボタンが押されました');
      const password = passwordInput ? passwordInput.value.trim() : '';
      
      if (!password) {
        showStatus('パスワードを入力してください', 'error');
        console.warn('⚠️ パスワードが空です');
        return;
      }

      console.log(`📤 socket.emit('join', '${password}') を送信します`);
      socket.emit('join', password);
      
      // ボタン無効化と待機表示
      if (startBtn) startBtn.disabled = true;
      if (passwordInput) passwordInput.disabled = true;
      showStatus('対戦相手を探しています...', 'info');
    });
  } else {
    console.warn('⚠️ startBtn が見つかりません');
  }

  // 攻撃ボタン
  if (attackBtn) {
    attackBtn.addEventListener('click', () => {
      const word = attackInput ? attackInput.value.trim() : '';
      if (!word) {
        showStatus('攻撃の言葉を入力してください', 'error');
        return;
      }
      socket.emit('attackWord', { word });
      if (attackInput) attackInput.value = '';
      if (attackBtn) attackBtn.disabled = true;
      if (attackInput) attackInput.disabled = true;
    });
  }

  // 防御ボタン
  if (defendBtn) {
    defendBtn.addEventListener('click', () => {
      const word = defendInput ? defendInput.value.trim() : '';
      if (!word) {
        showStatus('防御の言葉を入力してください', 'error');
        return;
      }
      socket.emit('defendWord', { word });
      if (defendInput) defendInput.value = '';
      if (defendBtn) defendBtn.disabled = true;
      if (defendInput) defendInput.disabled = true;
    });
  }

  console.log('✅ イベントリスナーを登録しました');
}

// ========================================
// ゲーム開始
// ========================================
socket.on('battleStart', ({ roomId: rid, players: p, currentTurn: ct }) => {
  console.log('🎮 battleStart イベントを受信しました');
  roomId = rid;
  players = p;
  currentTurn = ct;
  gameStarted = true;
  currentPlayerId = socket.id;
  opponentId = players.find(pl => pl.id !== socket.id).id;

  console.log('�� バトル開始:', { roomId, players: players.length + '人', currentTurn });

  if (gameContainer) gameContainer.style.display = 'block';
  const loginContainer = document.getElementById('loginContainer');
  if (loginContainer) loginContainer.style.display = 'none';

  const currentPlayer = players.find(pl => pl.id === currentPlayerId);
  const opponent = players.find(pl => pl.id !== currentPlayerId);

  if (playerName) playerName.textContent = currentPlayer.name || 'Player 1';
  if (opponentName) opponentName.textContent = opponent.name || 'Player 2';

  updateHealthBars();
  updateResourceBars();

  clearBattleLog();
  appendLog('【ゲーム開始】バトルが始まりました！');

  if (currentPlayerId === currentTurn) {
    enableAttack();
  } else {
    disableAttack();
    appendLog(`${opponent.name || 'プレイヤー'} の攻撃ターン...`);
  }
});

// ========================================
// 攻撃宣言受信
// ========================================
socket.on('attackDeclared', ({ attackerId, defenderId, card }) => {
  const attacker = players.find(p => p.id === attackerId);
  const defender = players.find(p => p.id === defenderId);

  console.log('⚔️ 攻撃宣言:', { attacker: attacker.name, card });

  if (defenderId === currentPlayerId) {
    enableDefend();
    appendLog(`${attacker.name || 'プレイヤー'} が【${card.word}】で攻撃！`);
  } else {
    appendLog(`${attacker.name || 'プレイヤー'} が【${card.word}】で攻撃を仕掛けました`);
  }
});

// ========================================
// ターン解決
// ========================================
socket.on('turnResolved', (data) => {
  const {
    attackerId,
    defenderId,
    attackCard,
    defenseCard,
    damage,
    defenseFailed,
    affinity,
    hp,
    maxHp,
    resources,
    fieldEffect,
    shortageWarnings,
    nextTurn,
    winnerId,
    statusTick
  } = data;

  const attacker = players.find(p => p.id === attackerId);
  const defender = players.find(p => p.id === defenderId);

  console.log('✅ ターン解決:', {
    attacker: attacker.name,
    defender: defender.name,
    damage,
    defenseFailed,
    affinity: affinity?.relation
  });

  // HP更新
  if (hp) {
    attacker.hp = hp[attackerId];
    defender.hp = hp[defenderId];
  }

  // リソース更新
  if (resources) {
    if (resources[attackerId]) {
      attacker.stamina = resources[attackerId].stamina;
      attacker.magic = resources[attackerId].magic;
      attacker.maxStamina = resources[attackerId].maxStamina;
      attacker.maxMagic = resources[attackerId].maxMagic;
    }
    if (resources[defenderId]) {
      defender.stamina = resources[defenderId].stamina;
      defender.magic = resources[defenderId].magic;
      defender.maxStamina = resources[defenderId].maxStamina;
      defender.maxMagic = resources[defenderId].maxMagic;
    }
  }

  updateHealthBars();
  updateResourceBars();

  // リソース不足警告
  if (shortageWarnings && shortageWarnings.length > 0) {
    shortageWarnings.forEach(w => {
      appendLog(`⚠️ ${w.message}`);
    });
  }

  // 攻撃カード表示（攻撃側）
  if (attackCard) {
    showCutin(attackCard, 'attacker');
    setTimeout(() => {
      const attackMsg = buildAttackLog(attackCard);
      appendLog(attackMsg);

      if (attackCard.role === 'support') {
        const supportMsg = attackCard.supportMessage || '効果を発動';
        showSupportOverlay(supportMsg);
        setTimeout(() => {
          closeSupportOverlay();

          // 防御カード表示（防御側）
          if (defenseCard) {
            showCutin(defenseCard, 'defender');
            setTimeout(() => {
              const defendMsg = buildDefenseLog(defenseCard);
              appendLog(defendMsg);

              if (defenseCard.role === 'support') {
                const defSupportMsg = defenseCard.supportMessage || '効果を発動';
                showSupportOverlay(defSupportMsg);
                setTimeout(() => {
                  closeSupportOverlay();
                  processResolveLogic(data);
                }, 1500);
              } else {
                setTimeout(() => {
                  processResolveLogic(data);
                }, 1500);
              }
            }, 400);
          } else {
            processResolveLogic(data);
          }
        }, 1500);
      } else {
        // 防御カード表示（防御側）
        if (defenseCard) {
          showCutin(defenseCard, 'defender');
          setTimeout(() => {
            const defendMsg = buildDefenseLog(defenseCard);
            appendLog(defendMsg);

            if (defenseCard.role === 'support') {
              const defSupportMsg = defenseCard.supportMessage || '効果を発動';
              showSupportOverlay(defSupportMsg);
              setTimeout(() => {
                closeSupportOverlay();
                processResolveLogic(data);
              }, 1500);
            } else {
              setTimeout(() => {
                processResolveLogic(data);
              }, 1500);
            }
          }, 400);
        } else {
          setTimeout(() => {
            processResolveLogic(data);
          }, 1500);
        }
      }
    }, 400);
  } else {
    processResolveLogic(data);
  }

  function processResolveLogic(resolveData) {
    const { damage: dmg, affinity: aff, winnerId, nextTurn: nt, defenseFailed: df } = resolveData;

    // ダメージログ
    if (dmg > 0) {
      const affinityMsg = aff?.relation === 'advantage'
        ? '💥有効！'
        : aff?.relation === 'disadvantage'
          ? '🛡️不利...'
          : '';
      appendLog(`【ダメージ】${dmg} ${affinityMsg}`);
    } else if (df) {
      appendLog('【ダメージ】防御失敗！回避されました！');
    } else {
      appendLog('【ダメージ】0 （完全に防いだ！）');
    }

    // 勝者判定
    if (winnerId) {
      const winner = players.find(p => p.id === winnerId);
      appendLog(`\n【ゲーム終了】${winner.name || 'プレイヤー'} の勝利！`);
      gameStarted = false;
      disableAttack();
      disableDefend();
    } else {
      // 次のターン
      currentTurn = nt;
      if (currentPlayerId === currentTurn) {
        enableAttack();
        appendLog(`\n${attacker.name || 'プレイヤー'} のターン終了。\nあなたの攻撃ターンです！`);
      } else {
        disableAttack();
        disableDefend();
        appendLog(`\n${defender.name || 'プレイヤー'} の攻撃ターン...`);
      }
    }
  }
});

// ========================================
// 攻撃ログ生成
// ========================================
function buildAttackLog(card) {
  const roleName = card.role === 'attack'
    ? '【攻撃】'
    : card.role === 'defense'
      ? '【防御】'
      : card.role === 'support'
        ? '【支援】'
        : '【技】';

  if (card.role === 'support') {
    return `${roleName} 【${card.word}】`;
  }

  const stats = [];
  if (card.attack > 0) stats.push(`攻撃: ${card.attack}`);
  if (card.defense > 0) stats.push(`防御: ${card.defense}`);
  const statsStr = stats.length > 0 ? ' / ' + stats.join(', ') : '';

  return `${roleName} 【${card.word}】${statsStr}`;
}

// ========================================
// 防御ログ生成
// ========================================
function buildDefenseLog(card) {
  const roleName = card.role === 'attack'
    ? '【攻撃】'
    : card.role === 'defense'
      ? '【防御】'
      : card.role === 'support'
        ? '【支援】'
        : '【技】';

  if (card.role === 'support') {
    return `${roleName} 【${card.word}】`;
  }

  const stats = [];
  if (card.attack > 0) stats.push(`攻撃: ${card.attack}`);
  if (card.defense > 0) stats.push(`防御: ${card.defense}`);
  const statsStr = stats.length > 0 ? ' / ' + stats.join(', ') : '';

  return `${roleName} 【${card.word}】${statsStr}`;
}

// ========================================
// 切入演出表示
// ========================================
function showCutin(card, side) {
  if (!cutinCard) return;
  cutinCard.className = 'cutin-card';

  const roleBadgeEl = document.createElement('div');
  roleBadgeEl.className = 'role-badge';
  if (card.role === 'attack') {
    roleBadgeEl.className += ' attack-role';
    roleBadgeEl.textContent = '⚔️ ATTACK';
  } else if (card.role === 'defense') {
    roleBadgeEl.className += ' defense-role';
    roleBadgeEl.textContent = '🛡️ DEFENSE';
  } else if (card.role === 'support') {
    roleBadgeEl.className += ' support-role';
    roleBadgeEl.textContent = '✨ SUPPORT';
  }

  const wordEl = document.createElement('div');
  wordEl.className = 'cutin-word';
  wordEl.textContent = card.word;

  const attrEl = document.createElement('div');
  attrEl.className = 'cutin-attribute';
  attrEl.textContent = card.attribute ? `属性: ${card.attribute}` : '';

  const statsEl = document.createElement('div');
  statsEl.className = 'cutin-stats';

  // role に応じて表示を分ける
  if (card.role === 'support') {
    // Support時は数字を完全に表示しない（display: none）
    statsEl.style.display = 'none';
  } else if (card.role === 'attack') {
    // Attack時は attack のみ表示
    const atkDiv = document.createElement('div');
    atkDiv.className = 'stat-line attack';
    atkDiv.innerHTML = `<span class="stat-label">攻撃力:</span> <span class="stat-value">${card.attack || 0}</span>`;
    statsEl.appendChild(atkDiv);
  } else if (card.role === 'defense') {
    // Defense時は defense のみ表示
    const defDiv = document.createElement('div');
    defDiv.className = 'stat-line defense';
    defDiv.innerHTML = `<span class="stat-label">防御力:</span> <span class="stat-value">${card.defense || 0}</span>`;
    statsEl.appendChild(defDiv);
  }

  cutinCard.innerHTML = '';
  cutinCard.appendChild(roleBadgeEl);
  cutinCard.appendChild(wordEl);
  cutinCard.appendChild(attrEl);
  cutinCard.appendChild(statsEl);

  if (cutinOverlay) {
    cutinOverlay.className = 'cutin-overlay active';
    if (side === 'attacker') {
      cutinOverlay.classList.add('attacker-side');
    } else {
      cutinOverlay.classList.add('defender-side');
    }
    cutinOverlay.style.display = 'flex';
  }
}

// ========================================
// 切入演出非表示
// ========================================
function closeCutin() {
  if (cutinOverlay) {
    cutinOverlay.style.display = 'none';
    cutinOverlay.className = 'cutin-overlay';
  }
}

// ========================================
// サポート効果表示
// ========================================
function showSupportOverlay(message) {
  if (supportMessage) supportMessage.textContent = message;
  if (supportOverlay) {
    supportOverlay.style.display = 'flex';
    supportOverlay.classList.add('active');
  }
}

// ========================================
// サポート効果非表示
// ========================================
function closeSupportOverlay() {
  if (supportOverlay) {
    supportOverlay.style.display = 'none';
    supportOverlay.classList.remove('active');
  }
}

// ========================================
// UI更新関数
// ========================================
function updateHealthBars() {
  if (!players || players.length < 2) return;

  const currentPlayer = players.find(p => p.id === currentPlayerId);
  const opponent = players.find(p => p.id !== currentPlayerId);

  if (currentPlayer && playerHealth) {
    const maxHp = currentPlayer.maxHp || 120;
    const percentage = Math.max(0, Math.min(100, (currentPlayer.hp / maxHp) * 100));
    playerHealth.style.width = percentage + '%';

    const playerHpText = document.getElementById('playerHpText');
    if (playerHpText) {
      playerHpText.textContent = `${currentPlayer.hp}/${maxHp}`;
    }
  }

  if (opponent && opponentHealth) {
    const maxHp = opponent.maxHp || 120;
    const percentage = Math.max(0, Math.min(100, (opponent.hp / maxHp) * 100));
    opponentHealth.style.width = percentage + '%';

    const opponentHpText = document.getElementById('opponentHpText');
    if (opponentHpText) {
      opponentHpText.textContent = `${opponent.hp}/${maxHp}`;
    }
  }
}

function updateResourceBars() {
  if (!players || players.length < 2) return;

  const currentPlayer = players.find(p => p.id === currentPlayerId);
  const opponent = players.find(p => p.id !== currentPlayerId);

  if (currentPlayer) {
    const stPercent = (currentPlayer.stamina / (currentPlayer.maxStamina || 100)) * 100;
    if (playerStamina) playerStamina.style.width = stPercent + '%';

    const mpPercent = (currentPlayer.magic / (currentPlayer.maxMagic || 100)) * 100;
    if (playerMagic) playerMagic.style.width = mpPercent + '%';

    const playerStText = document.getElementById('playerStText');
    if (playerStText) {
      playerStText.textContent = `${currentPlayer.stamina}/${currentPlayer.maxStamina || 100}`;
    }

    const playerMpText = document.getElementById('playerMpText');
    if (playerMpText) {
      playerMpText.textContent = `${currentPlayer.magic}/${currentPlayer.maxMagic || 100}`;
    }
  }

  if (opponent) {
    const stPercent = (opponent.stamina / (opponent.maxStamina || 100)) * 100;
    if (opponentStamina) opponentStamina.style.width = stPercent + '%';

    const mpPercent = (opponent.magic / (opponent.maxMagic || 100)) * 100;
    if (opponentMagic) opponentMagic.style.width = mpPercent + '%';

    const opponentStText = document.getElementById('opponentStText');
    if (opponentStText) {
      opponentStText.textContent = `${opponent.stamina}/${opponent.maxStamina || 100}`;
    }

    const opponentMpText = document.getElementById('opponentMpText');
    if (opponentMpText) {
      opponentMpText.textContent = `${opponent.magic}/${opponent.maxMagic || 100}`;
    }
  }
}

function enableAttack() {
  if (attackInput) attackInput.disabled = false;
  if (attackBtn) attackBtn.disabled = false;
  if (defendInput) defendInput.disabled = true;
  if (defendBtn) defendBtn.disabled = true;
}

function disableAttack() {
  if (attackInput) attackInput.disabled = true;
  if (attackBtn) attackBtn.disabled = true;
}

function enableDefend() {
  if (defendInput) defendInput.disabled = false;
  if (defendBtn) defendBtn.disabled = false;
  if (attackInput) attackInput.disabled = true;
  if (attackBtn) attackBtn.disabled = true;
}

function disableDefend() {
  if (defendInput) defendInput.disabled = true;
  if (defendBtn) defendBtn.disabled = true;
}

function appendLog(message) {
  if (!battleLog) return;
  const logEntry = document.createElement('div');
  logEntry.className = 'log-entry';
  logEntry.textContent = message;
  battleLog.appendChild(logEntry);
  battleLog.scrollTop = battleLog.scrollHeight;
}

function clearBattleLog() {
  if (battleLog) battleLog.innerHTML = '';
}

function showStatus(message, type = 'info') {
  if (!statusMessage) {
    console.warn('statusMessage が見つかりません:', message);
    return;
  }
  statusMessage.textContent = message;
  statusMessage.className = 'status-message ' + type;
  statusMessage.style.display = 'block';
  console.log(`📢 ステータス[${type}]: ${message}`);
  if (type !== 'error') {
    setTimeout(() => {
      statusMessage.style.display = 'none';
    }, 3000);
  }
}

// ========================================
// エラーハンドリング
// ========================================
socket.on('errorMessage', ({ message }) => {
  console.error('❌ エラー:', message);
  showStatus(message, 'error');
});

socket.on('statusUpdate', ({ message }) => {
  console.log('📢 ステータス受信:', message);
  showStatus(message, 'info');
  if (message.includes('相手が切断')) {
    gameStarted = false;
    disableAttack();
    disableDefend();
  }
});

// ========================================
// DOMContentLoaded時の初期化
// ========================================
document.addEventListener('DOMContentLoaded', () => {
  console.log('📦 DOMContentLoaded イベント発火');
  initializeDOM();
  setupEventListeners();
  console.log('✅ game.js の初期化が完了しました');
});
