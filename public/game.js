const socket = io();

// ========================================
// DOM要素取得
// ========================================
const passwordInput = document.getElementById('passwordInput');
const startBtn = document.getElementById('startBtn');
const gameContainer = document.getElementById('gameContainer');
const battleLog = document.getElementById('battleLog');
const playerHealth = document.getElementById('playerHealth');
const opponentHealth = document.getElementById('opponentHealth');
const playerStamina = document.getElementById('playerStamina');
const playerMagic = document.getElementById('playerMagic');
const opponentStamina = document.getElementById('opponentStamina');
const opponentMagic = document.getElementById('opponentMagic');
const attackInput = document.getElementById('attackInput');
const attackBtn = document.getElementById('attackBtn');
const defendInput = document.getElementById('defendInput');
const defendBtn = document.getElementById('defendBtn');
const playerName = document.getElementById('playerName');
const opponentName = document.getElementById('opponentName');
const statusMessage = document.getElementById('statusMessage');
const cutinOverlay = document.getElementById('cutinOverlay');
const cutinCard = document.getElementById('cutinCard');
const cutinRole = document.getElementById('cutinRole');
const cutinStats = document.getElementById('cutinStats');
const supportOverlay = document.getElementById('supportOverlay');
const supportMessage = document.getElementById('supportMessage');

let currentPlayerId = null;
let opponentId = null;
let currentTurn = null;
let roomId = null;
let gameStarted = false;
let players = [];

// ========================================
// 初期化
// ========================================
startBtn.addEventListener('click', () => {
  const password = passwordInput.value.trim();
  if (!password) {
    showStatus('パスワードを入力してください', 'error');
    return;
  }
  socket.emit('join', password);
  startBtn.disabled = true;
  passwordInput.disabled = true;
});

// ========================================
// ゲーム開始
// ========================================
socket.on('battleStart', ({ roomId: rid, players: p, currentTurn: ct }) => {
  roomId = rid;
  players = p;
  currentTurn = ct;
  gameStarted = true;
  currentPlayerId = socket.id;
  opponentId = players.find(pl => pl.id !== socket.id).id;

  console.log('🎮 バトル開始:', { roomId, players, currentTurn });

  gameContainer.style.display = 'block';
  document.getElementById('loginContainer').style.display = 'none';

  const currentPlayer = players.find(pl => pl.id === currentPlayerId);
  const opponent = players.find(pl => pl.id !== currentPlayerId);

  playerName.textContent = currentPlayer.name || 'Player 1';
  opponentName.textContent = opponent.name || 'Player 2';

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
// 攻撃宣言
// ========================================
attackBtn.addEventListener('click', () => {
  const word = attackInput.value.trim();
  if (!word) {
    showStatus('攻撃の言葉を入力してください', 'error');
    return;
  }
  socket.emit('attackWord', { word });
  attackInput.value = '';
  attackBtn.disabled = true;
  attackInput.disabled = true;
});

// ========================================
// 防御宣言
// ========================================
defendBtn.addEventListener('click', () => {
  const word = defendInput.value.trim();
  if (!word) {
    showStatus('防御の言葉を入力してください', 'error');
    return;
  }
  socket.emit('defendWord', { word });
  defendInput.value = '';
  defendBtn.disabled = true;
  defendInput.disabled = true;
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

  cutinOverlay.className = 'cutin-overlay active';
  if (side === 'attacker') {
    cutinOverlay.classList.add('attacker-side');
  } else {
    cutinOverlay.classList.add('defender-side');
  }
  cutinOverlay.style.display = 'flex';
}

// ========================================
// 切入演出非表示
// ========================================
function closeCutin() {
  cutinOverlay.style.display = 'none';
  cutinOverlay.className = 'cutin-overlay';
}

// ========================================
// サポート効果表示
// ========================================
function showSupportOverlay(message) {
  supportMessage.textContent = message;
  supportOverlay.style.display = 'flex';
  supportOverlay.classList.add('active');
}

// ========================================
// サポート効果非表示
// ========================================
function closeSupportOverlay() {
  supportOverlay.style.display = 'none';
  supportOverlay.classList.remove('active');
}

// ========================================
// UI更新関数
// ========================================
function updateHealthBars() {
  if (!players || players.length < 2) return;

  const currentPlayer = players.find(p => p.id === currentPlayerId);
  const opponent = players.find(p => p.id !== currentPlayerId);

  if (currentPlayer) {
    const maxHp = currentPlayer.maxHp || 120;
    const percentage = Math.max(0, Math.min(100, (currentPlayer.hp / maxHp) * 100));
    playerHealth.style.width = percentage + '%';

    const playerHpText = document.getElementById('playerHpText');
    if (playerHpText) {
      playerHpText.textContent = `${currentPlayer.hp}/${maxHp}`;
    }
  }

  if (opponent) {
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
    playerStamina.style.width = stPercent + '%';

    const mpPercent = (currentPlayer.magic / (currentPlayer.maxMagic || 100)) * 100;
    playerMagic.style.width = mpPercent + '%';

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
    opponentStamina.style.width = stPercent + '%';

    const mpPercent = (opponent.magic / (opponent.maxMagic || 100)) * 100;
    opponentMagic.style.width = mpPercent + '%';

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
  attackInput.disabled = false;
  attackBtn.disabled = false;
  defendInput.disabled = true;
  defendBtn.disabled = true;
}

function disableAttack() {
  attackInput.disabled = true;
  attackBtn.disabled = true;
}

function enableDefend() {
  defendInput.disabled = false;
  defendBtn.disabled = false;
  attackInput.disabled = true;
  attackBtn.disabled = true;
}

function disableDefend() {
  defendInput.disabled = true;
  defendBtn.disabled = true;
}

function appendLog(message) {
  const logEntry = document.createElement('div');
  logEntry.className = 'log-entry';
  logEntry.textContent = message;
  battleLog.appendChild(logEntry);
  battleLog.scrollTop = battleLog.scrollHeight;
}

function clearBattleLog() {
  battleLog.innerHTML = '';
}

function showStatus(message, type = 'info') {
  statusMessage.textContent = message;
  statusMessage.className = 'status-message ' + type;
  statusMessage.style.display = 'block';
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
  console.log('📢 ステータス:', message);
  showStatus(message, 'info');
  if (message.includes('相手が切断')) {
    gameStarted = false;
    disableAttack();
    disableDefend();
  }
});
