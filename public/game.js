const SOCKET_URL = 'https://create-cards.onrender.com';

const MAX_HP_BASE = 120;

let socket = null;
let playerId = null;
let playerName = '';
let roomId = null;
let isHost = false;
let currentTurn = null;
let myHp = 0;
let opponentHp = 0;
let myMaxHp = MAX_HP_BASE;
let opponentMaxHp = MAX_HP_BASE;
let myStamina = 100;
let myMagic = 100;
let opponentStamina = 100;
let opponentMagic = 100;
let myMaxStamina = 100;
let myMaxMagic = 100;
let opponentMaxStamina = 100;
let opponentMaxMagic = 100;
let supportRemaining = 3;
let defaultBackground = '';
let activeFieldName = null;
let isMatching = false;
const statusState = { my: [], op: [] };
const roleState = { my: '--', op: '--' };

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

function showSupportOverlay(detailText) {
  const overlay = document.getElementById('supportOverlay');
  const detailEl = document.getElementById('supportOverlayDetail');
  if (!overlay || !detailEl) return;
  detailEl.textContent = detailText || '効果が発動！';
  overlay.classList.remove('hidden');
  overlay.classList.add('show');
  setTimeout(() => {
    overlay.classList.remove('show');
    setTimeout(() => overlay.classList.add('hidden'), 260);
  }, 2000);
}

function updateRoleBadge(targetKey, role) {
  const el = document.getElementById(targetKey === 'my' ? 'myRoleBadge' : 'opRoleBadge');
  if (!el) return;
  const roleLower = (role || '--').toLowerCase();
  el.className = 'role-chip';
  if (roleLower === 'attack') {
    el.classList.add('attack');
    el.textContent = 'ATK';
  } else if (roleLower === 'defense') {
    el.classList.add('defense');
    el.textContent = 'DEF';
  } else if (roleLower === 'support') {
    el.classList.add('support');
    el.textContent = 'SUP';
  } else {
    el.textContent = '--';
  }
  roleState[targetKey] = el.textContent;
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
    const cutinRoleBadge = document.getElementById('cutinRoleBadge');
    const cutinSpecial = document.getElementById('cutinSpecial');
    const cutinComment = document.getElementById('cutinComment');

    cutinWord.textContent = card.word;
    const stCost = card.staminaCost != null ? card.staminaCost : 0;
    const mpCost = card.magicCost != null ? card.magicCost : 0;
    // Support役は攻撃力/防御力を非表示にして、サポート情報を表示
    if (card.role === 'support') {
      cutinStats.textContent = `サポート効果: ${card.effectType || '効果'} / 消費ST:${stCost} 消費MP:${mpCost}`;
    } else {
      cutinStats.textContent = `攻撃力: ${card.attack} / 防御力: ${card.defense} / 消費ST:${stCost} 消費MP:${mpCost}`;
    }
    cutinTier.textContent = `${card.attribute.toUpperCase()} [${card.tier.toUpperCase()}]`;
    const roleRaw = (card.role || card.effect || 'unknown').toString();
    const roleLabel = roleRaw.toUpperCase();
    if (cutinRoleBadge) {
      cutinRoleBadge.textContent = roleLabel;
      cutinRoleBadge.className = 'cutin-role-badge';
      const roleLower = roleRaw.toLowerCase();
      if (roleLower === 'attack') {
        cutinRoleBadge.classList.add('attack');
      } else if (roleLower === 'defense') {
        cutinRoleBadge.classList.add('defense');
      } else if (roleLower === 'support') {
        cutinRoleBadge.classList.add('support');
      }
    }
    cutinSpecial.textContent = `特殊効果: ${card.specialEffect || 'なし'}`;
    const comments = [card.judgeComment || '審判: 良好'];
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

function updateHealthBars(my, op, myMax = myMaxHp, opMax = opponentMaxHp) {
  myHp = my;
  opponentHp = op;
  myMaxHp = myMax || MAX_HP_BASE;
  opponentMaxHp = opMax || MAX_HP_BASE;
  const myFill = document.getElementById('myHealthFill');
  const opFill = document.getElementById('opHealthFill');
  document.getElementById('myHealthText').textContent = `${Math.round(myHp)}/${myMaxHp}`;
  document.getElementById('opHealthText').textContent = `${Math.round(opponentHp)}/${opponentMaxHp}`;
  const myPercent = myMaxHp > 0 ? Math.max(0, Math.min(100, (myHp / myMaxHp) * 100)) : 0;
  const opPercent = opponentMaxHp > 0 ? Math.max(0, Math.min(100, (opponentHp / opponentMaxHp) * 100)) : 0;
  myFill.style.width = `${myPercent}%`;
  opFill.style.width = `${opPercent}%`;
}

function updateResourceBars({
  mySt = myStamina,
  myMp = myMagic,
  myStMax = myMaxStamina,
  myMpMax = myMaxMagic,
  opSt = opponentStamina,
  opMp = opponentMagic,
  opStMax = opponentMaxStamina,
  opMpMax = opponentMaxMagic
} = {}) {
  myStamina = mySt; myMagic = myMp; myMaxStamina = myStMax || 100; myMaxMagic = myMpMax || 100;
  opponentStamina = opSt; opponentMagic = opMp; opponentMaxStamina = opStMax || 100; opponentMaxMagic = opMpMax || 100;

  const sets = [
    { fill: 'myStaminaFill', text: 'myStaminaText', val: myStamina, max: myMaxStamina },
    { fill: 'myMagicFill', text: 'myMagicText', val: myMagic, max: myMaxMagic },
    { fill: 'opStaminaFill', text: 'opStaminaText', val: opponentStamina, max: opponentMaxStamina },
    { fill: 'opMagicFill', text: 'opMagicText', val: opponentMagic, max: opponentMaxMagic }
  ];

  sets.forEach(({ fill, text, val, max }) => {
    const fillEl = document.getElementById(fill);
    const textEl = document.getElementById(text);
    if (!fillEl || !textEl) return;
    const pct = max > 0 ? Math.max(0, Math.min(100, (val / max) * 100)) : 0;
    fillEl.style.width = `${pct}%`;
    textEl.textContent = `${Math.round(val)}/${max}`;
  });
}

function appendLog(message, type = 'info') {
  const log = document.getElementById('battleLog');
  const entry = document.createElement('div');
  entry.className = `log-entry ${type}`;
  entry.textContent = message;
  log.appendChild(entry);
  log.scrollTop = log.scrollHeight;
}

function ensureStatusContainers() {
  const areas = Array.from(document.querySelectorAll('.player-area'));
  areas.forEach((area, idx) => {
    const bar = area.querySelector('.health-bar');
    if (!bar || bar.parentElement.classList.contains('hp-row')) return;
    const row = document.createElement('div');
    row.className = 'hp-row';
    const badgeRow = document.createElement('div');
    badgeRow.className = 'status-badge-row';
    badgeRow.id = idx === 0 ? 'myStatusBadges' : 'opStatusBadges';
    row.appendChild(bar);
    row.appendChild(badgeRow);
    area.appendChild(row);
  });
}

function renderStatusBadges() {
  const map = { my: document.getElementById('myStatusBadges'), op: document.getElementById('opStatusBadges') };
  Object.entries(map).forEach(([key, el]) => {
    if (!el) return;
    el.innerHTML = '';
    const list = statusState[key] || [];
    list.slice(0, 3).forEach((s) => {
      const badge = document.createElement('span');
      badge.className = 'status-badge';
      badge.textContent = s.name || '効果';
      el.appendChild(badge);
    });
  });
}

function setStatusList(targetKey, list) {
  statusState[targetKey] = (list || []).slice(0, 3).map((s) => ({ name: s.name, turns: s.turns, effectType: s.effectType }));
  renderStatusBadges();
}

function addStatuses(appliedStatus = []) {
  appliedStatus.forEach((s) => {
    const targetKey = s.targetId === playerId ? 'my' : 'op';
    const current = statusState[targetKey] || [];
    if (current.length >= 3) return;
    current.push({ name: s.name, turns: s.turns, effectType: s.effectType });
    statusState[targetKey] = current.slice(0, 3);
  });
  renderStatusBadges();
}

function applyStatusTick(statusTick) {
  if (!statusTick || !Array.isArray(statusTick.ticks)) return;
  statusTick.ticks.forEach((t) => {
    const targetKey = t.playerId === playerId ? 'my' : 'op';
    const before = statusState[targetKey]?.length || 0;
    const remaining = (t.remaining || []).map((a) => ({ name: a.name, turns: a.turns, effectType: a.effectType }));
    setStatusList(targetKey, remaining);
    if (t.dot > 0) {
      const label = targetKey === 'my' ? 'あなた' : '相手';
      const names = remaining.map((r) => r.name).join(' / ') || '―';
      appendLog(`⏳ ${label} は状態異常で ${t.dot} ダメージ (残り: ${names})`, 'debuff');
    } else if (before > 0 && remaining.length === 0) {
      const label = targetKey === 'my' ? 'あなた' : '相手';
      appendLog(`✨ ${label} の状態異常が解除された`, 'buff');
    }
  });
}

function resetStatuses() {
  setStatusList('my', []);
  setStatusList('op', []);
}

function getFieldBanner() {
  let el = document.getElementById('fieldBanner');
  if (!el) {
    el = document.createElement('div');
    el.id = 'fieldBanner';
    el.className = 'field-banner';
    document.body.appendChild(el);
  }
  return el;
}

let fieldBannerTimer = null;
function showFieldBanner(name) {
  const banner = getFieldBanner();
  banner.textContent = name;
  banner.classList.add('show');
  if (fieldBannerTimer) clearTimeout(fieldBannerTimer);
  fieldBannerTimer = setTimeout(() => banner.classList.remove('show'), 2200);
}

function applyFieldVisual(fieldEffect, { silentLog = false } = {}) {
  const newName = fieldEffect && fieldEffect.name ? fieldEffect.name : null;
  const changed = newName !== activeFieldName;
  activeFieldName = newName;
  
  // フィールド効果のビジュアル適用：グラデーションを強調+画面全体に反映
  if (fieldEffect && fieldEffect.visual) {
    document.body.style.background = fieldEffect.visual;
    // バトルセクション全体をフィールド色でハイライト
    const battleSection = document.getElementById('battleSection');
    if (battleSection) {
      const gradientMatch = fieldEffect.visual.match(/#[0-9a-fA-F]{6}|rgb[a]?\([^)]+\)/g);
      if (gradientMatch && gradientMatch.length > 0) {
        const primaryColor = gradientMatch[0];
        const secondaryColor = gradientMatch[1] || primaryColor;
        // グロー効果 + インセットハイライト + 色の重ね合わせ
        battleSection.style.boxShadow = `0 0 80px ${primaryColor}60, 0 0 40px ${secondaryColor}40, inset 0 0 50px ${primaryColor}25`;
        battleSection.style.borderColor = primaryColor;
      }
    }
  } else {
    document.body.style.background = defaultBackground;
    const battleSection = document.getElementById('battleSection');
    if (battleSection) {
      battleSection.style.boxShadow = '';
      battleSection.style.borderColor = '';
    }
  }
  
  if (changed) {
    if (newName) {
      showFieldBanner(newName);
      if (!silentLog) {
        appendLog(`🌐 フィールドチェンジ: ${newName}${fieldEffect.buff ? ` (${fieldEffect.buff})` : ''}`, 'field');
      }
    } else if (!silentLog) {
      appendLog('🌐 フィールド効果が消滅', 'field');
    }
  }
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

  socket.on('waitingUpdate', ({ players = [], canStart = false, hostId, password }) => {
    if (roomId) {
      showSection('waitingSection');
      renderWaiting(players, canStart, hostId);
      document.getElementById('waitingInfo').textContent = `参加人数: ${players.length}人`;
    } else {
      showSection('matchingSection');
      const matchingMessage = document.getElementById('matchingMessage');
      if (password) {
        matchingMessage.textContent = `パスワード「${password}」で待機中: ${players.length}人。相手を待っています...`;
      } else {
        matchingMessage.textContent = `参加待ち: ${players.length}人。相手を待っています...`;
      }
    }
  });

  socket.on('battleStarted', ({ players, turn, resources }) => {
    isMatching = false;
    showSection('battleSection');
    const me = players.find(p => p.id === playerId);
    const op = players.find(p => p.id !== playerId);
    const myMax = me?.maxHp || MAX_HP_BASE;
    const opMax = op?.maxHp || MAX_HP_BASE;
    myMaxHp = myMax;
    opponentMaxHp = opMax;
    updateHealthBars(me ? me.hp : myMax, op ? op.hp : opMax, myMax, opMax);
    if (resources) {
      const myRes = resources[playerId] || {};
      const opEntry = Object.entries(resources).find(([id]) => id !== playerId);
      const opRes = opEntry ? opEntry[1] : {};
      updateResourceBars({
        mySt: myRes.stamina ?? myStamina,
        myMp: myRes.magic ?? myMagic,
        myStMax: myRes.maxStamina ?? myMaxStamina,
        myMpMax: myRes.maxMagic ?? myMaxMagic,
        opSt: opRes.stamina ?? opponentStamina,
        opMp: opRes.magic ?? opponentMagic,
        opStMax: opRes.maxStamina ?? opponentMaxStamina,
        opMpMax: opRes.maxMagic ?? opponentMaxMagic
      });
    }
    resetStatuses();
    updateRoleBadge('my', '--');
    updateRoleBadge('op', '--');
    applyFieldVisual(null, { silentLog: true });
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
    const attackerKey = isAttacker ? 'my' : 'op';
    
    // カットイン演出
    await showCutin(card, 2000);

    updateRoleBadge(attackerKey, card.role || 'attack');
    
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

  socket.on('turnResolved', async ({ attackerId, defenderId, attackCard, defenseCard, damage, counterDamage, dotDamage, appliedStatus, fieldEffect, hp, maxHp, resources, shortageWarnings = [], nextTurn, winnerId, defenseFailed, affinity, statusTick }) => {
    const meHp = hp[playerId] ?? myHp;
    const opHp = Object.entries(hp).find(([id]) => id !== playerId)?.[1] ?? opponentHp;
    const maxHpMap = maxHp || {};
    const meMax = maxHpMap[playerId] ?? myMaxHp ?? MAX_HP_BASE;
    const opMax = Object.entries(maxHpMap).find(([id]) => id !== playerId)?.[1] ?? opponentMaxHp ?? MAX_HP_BASE;

    const cutinFlavor = buildCutinFlavor({ affinity, defenseCard, defenseFailed });

    // 防御カードのカットイン（相性・反射の一言付き）
    if (defenseCard) {
      await showCutin(defenseCard, 2000, cutinFlavor);
    }

    if (attackCard) {
      const atkKey = attackerId === playerId ? 'my' : 'op';
      updateRoleBadge(atkKey, attackCard.role || 'attack');
    }
    if (defenseCard) {
      const defKey = defenderId === playerId ? 'my' : 'op';
      updateRoleBadge(defKey, defenseCard.role || 'defense');
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

    applyStatusTick(statusTick);

    // DoT 追加ダメージ表示（リアルタイム）
    if (dotDamage > 0) {
      appendLog(`⏳ 状態異常の継続ダメージ合計: ${dotDamage}`, 'debuff');
    }

    // 状態異常付与ログとバッジ更新
    if (appliedStatus && appliedStatus.length > 0) {
      appliedStatus.forEach(s => {
        const toMe = s.targetId === playerId;
        appendLog(`${toMe ? 'あなた' : '相手'} に状態異常付与: ${s.name} (${s.effectType || 'effect'}, ${s.turns}ターン, 値:${s.value ?? 0})`, 'debuff');
      });
      addStatuses(appliedStatus);
    }

    if (fieldEffect) {
      applyFieldVisual(fieldEffect);
    }

    if (resources) {
      const myRes = resources[playerId] || {};
      const opEntry = Object.entries(resources).find(([id]) => id !== playerId);
      const opRes = opEntry ? opEntry[1] : {};
      updateResourceBars({
        mySt: myRes.stamina ?? myStamina,
        myMp: myRes.magic ?? myMagic,
        myStMax: myRes.maxStamina ?? myMaxStamina,
        myMpMax: myRes.maxMagic ?? myMaxMagic,
        opSt: opRes.stamina ?? opponentStamina,
        opMp: opRes.magic ?? opponentMagic,
        opStMax: opRes.maxStamina ?? opponentMaxStamina,
        opMpMax: opRes.maxMagic ?? opponentMaxMagic
      });
    }

    if (shortageWarnings.length > 0) {
      shortageWarnings.forEach(w => {
        const isMe = w.playerId === playerId;
        appendLog(`⚠️ ${isMe ? 'あなた' : '相手'}: ${w.message}`, 'damage');
      });
    }

    // 回復表示
    if (attackCard.role === 'support') {
      showHealAnimation(attackerId === playerId ? 'my' : 'op', Math.round(attackCard.attack * 0.6));
    }

    updateHealthBars(meHp, opHp, meMax, opMax);
    appendLog(`攻撃: ${attackCard.word} (${attackCard.role}) / 防御: ${defenseCard.word} (${defenseCard.role})`, 'info');

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

  socket.on('supportUsed', async ({ playerId: supportPlayerId, card, hp, maxHp, resources, shortageWarnings = [], supportRemaining: newRemaining, winnerId, nextTurn, appliedStatus, fieldEffect, statusTick, supportDetail }) => {
    if (card) {
      await showCutin(card, 2000);
    }

    const isMe = supportPlayerId === playerId;
    const resolvedDetail = supportDetail || (card && card.supportDetail) || '';
    const resolvedMessage = (card && card.supportMessage) || resolvedDetail || '';
    if (card) {
      appendLog(`${isMe ? 'あなた' : '相手'}がサポートを使用: 【${card.word}】`, 'info');
      if (resolvedMessage) {
        appendLog(`✨ ${resolvedMessage}`, 'buff');
      }
    }

    const roleKey = isMe ? 'my' : 'op';
    updateRoleBadge(roleKey, 'support');

    // UIに表示するサポートメッセージ：supportMessage（解説文）を最優先
    const overlayDetail = resolvedMessage || (card ? `${card.word}` : 'サポートが発動');
    showSupportOverlay(overlayDetail);

    applyStatusTick(statusTick);

    if (appliedStatus && appliedStatus.length > 0) {
      appliedStatus.forEach(s => {
        const toMe = s.targetId === playerId;
        appendLog(`${toMe ? 'あなた' : '相手'} に状態異常付与: ${s.name} (${s.effectType || 'effect'}, ${s.turns}ターン, 値:${s.value ?? 0})`, 'debuff');
      });
      addStatuses(appliedStatus);
    }

    if (card && (card.effectType === 'cleanse' || card.supportType === 'cleanse')) {
      const targetKey = supportPlayerId === playerId ? 'my' : 'op';
      setStatusList(targetKey, []);
      appendLog(`${targetKey === 'my' ? 'あなた' : '相手'} の状態異常を解除`, 'buff');
    }

    if (fieldEffect) {
      applyFieldVisual(fieldEffect);
    }

    if (resources) {
      const myRes = resources[playerId] || {};
      const opId = Object.keys(resources).find(id => id !== playerId);
      const opRes = opId ? resources[opId] : {};
      updateResourceBars({
        mySt: myRes.stamina ?? myStamina,
        myMp: myRes.magic ?? myMagic,
        myStMax: myRes.maxStamina ?? myMaxStamina,
        myMpMax: myRes.maxMagic ?? myMaxMagic,
        opSt: opRes.stamina ?? opponentStamina,
        opMp: opRes.magic ?? opponentMagic,
        opStMax: opRes.maxStamina ?? opponentMaxStamina,
        opMpMax: opRes.maxMagic ?? opponentMaxMagic
      });
    }

    if (shortageWarnings.length > 0) {
      shortageWarnings.forEach(w => {
        const isMe = w.playerId === playerId;
        appendLog(`⚠️ ${isMe ? 'あなた' : '相手'}: ${w.message}`, 'damage');
      });
    }

    if (isMe && typeof newRemaining === 'number') {
      supportRemaining = newRemaining;
      updateSupportCounter();
    }

    myHp = hp[playerId];
    const opponentId = Object.keys(hp).find(id => id !== playerId);
    opponentHp = hp[opponentId];
    const maxHpMap = maxHp || {};
    const meMax = maxHpMap[playerId] ?? myMaxHp ?? MAX_HP_BASE;
    const opMax = opponentId ? (maxHpMap[opponentId] ?? opponentMaxHp ?? MAX_HP_BASE) : opponentMaxHp;

    updateHealthBars(myHp, opponentHp, meMax, opMax);

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

  const handleFieldChange = ({ fieldEffect }) => applyFieldVisual(fieldEffect);
  socket.on('fieldEffectUpdate', handleFieldChange);
  socket.on('fieldChanged', handleFieldChange);

  socket.on('matchCancelled', ({ message }) => {
    console.log('🚫 マッチングがキャンセルされました');
    isMatching = false;
    
    // 状態を完全にリセット
    roomId = null;
    currentTurn = null;
    isHost = false;
    playerId = null;
    myHp = 0;
    opponentHp = 0;
    myMaxHp = MAX_HP_BASE;
    opponentMaxHp = MAX_HP_BASE;
    myStamina = 0; myMagic = 0; opponentStamina = 0; opponentMagic = 0;
    supportRemaining = 3;
    
    // ホーム画面に戻る
    showSection('homeSection');
    setStatus(message || 'マッチングをキャンセルしました');
    updateResourceBars({
      mySt: 0, myMp: 0, myStMax: 100, myMpMax: 100,
      opSt: 0, opMp: 0, opStMax: 100, opMpMax: 100
    });
    
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
  if (isMatching && socket && socket.connected) return;
  const matchingMessage = document.getElementById('matchingMessage');
  matchingMessage.textContent = matchType === 'password'
    ? `パスワード: ${password} で対戦相手を探しています...`
    : '相手を探しています...';
  roomId = null;
  myMaxHp = MAX_HP_BASE;
  opponentMaxHp = MAX_HP_BASE;
  showSection('matchingSection');
  if (!socket || !socket.connected) {
    initSocket();
    setTimeout(() => join(matchType), 200);
    return;
  }
  isMatching = true;
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
  isMatching = false;
  
  if (socket && socket.connected) {
    socket.emit('cancelMatching');
    console.log('  → サーバーにcancelMatchingを送信');
  } else {
    console.warn('  ⚠️ socketが接続されていません');
  }
  
  // UIを即座にホームに戻す
  showSection('homeSection');
  applyFieldVisual(null, { silentLog: true });
  resetStatuses();
  updateRoleBadge('my', '--');
  updateRoleBadge('op', '--');
  setStatus('マッチングをキャンセルしています...');

   updateHealthBars(0, 0, MAX_HP_BASE, MAX_HP_BASE);
   updateResourceBars({
     mySt: 0, myMp: 0, myStMax: 100, myMpMax: 100,
     opSt: 0, opMp: 0, opStMax: 100, opMpMax: 100
   });
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

  const guideBtn = document.getElementById('supportGuideBtn');
  const guideModal = document.getElementById('supportGuideModal');
  const guideClose = document.getElementById('supportGuideClose');
  if (guideBtn && guideModal && guideClose) {
    const open = () => guideModal.classList.remove('hidden');
    const close = () => guideModal.classList.add('hidden');
    guideBtn.addEventListener('click', open);
    guideClose.addEventListener('click', close);
    guideModal.addEventListener('click', (e) => {
      if (e.target === guideModal) close();
    });
  }
}

document.addEventListener('DOMContentLoaded', () => {
  defaultBackground = getComputedStyle(document.body).background;
  ensureStatusContainers();
  renderStatusBadges();
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
