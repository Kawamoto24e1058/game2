// Game state
let techniques = [];
let ws = null;
let playerId = null;
let battleId = null;
let playerIndex = null;
let isMyTurn = false;

// Constants
const WEBSOCKET_RECONNECT_DELAY = 3000;

// Initialize WebSocket connection
function initWebSocket() {
    // Fixed WebSocket endpoint for Render
    const wsUrl = 'wss://create-cards.onrender.com';
    
    ws = new WebSocket(wsUrl);
    
    ws.onopen = () => {
        console.log('WebSocket connected');
    };
    
    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        handleServerMessage(data);
    };
    
    ws.onclose = () => {
        console.log('WebSocket disconnected');
        setTimeout(initWebSocket, WEBSOCKET_RECONNECT_DELAY);
    };
    
    ws.onerror = (error) => {
        console.error('WebSocket error:', error);
    };
}

// Handle messages from server
function handleServerMessage(data) {
    switch (data.type) {
        case 'connected':
            playerId = data.playerId;
            console.log('Connected with player ID:', playerId);
            break;
            
        case 'searching':
            showStatus(data.message);
            break;
            
        case 'battleStart':
            battleId = data.battleId;
            playerIndex = data.playerIndex;
            isMyTurn = (playerIndex === 0);
            startBattle(data.opponentTechniques);
            showStatus(data.message);
            break;
            
        case 'battleUpdate':
            handleBattleUpdate(data);
            break;
            
        case 'opponentDisconnected':
            showStatus(data.message);
            addLogEntry('相手が切断しました。あなたの勝利です！', 'win');
            setTimeout(() => {
                returnToMenu();
            }, 3000);
            break;
            
        case 'error':
            alert(data.message);
            break;
    }
}

// Generate technique from word
async function generateTechnique() {
    const wordInput = document.getElementById('wordInput');
    const word = wordInput.value.trim();
    
    if (!word) {
        alert('言葉を入力してください');
        return;
    }
    
    if (techniques.length >= 3) {
        alert('技は最大3つまでです');
        return;
    }
    
    try {
        const response = await fetch('/api/generate-technique', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ word })
        });
        
        const data = await response.json();
        
        if (data.technique) {
            techniques.push(data.technique);
            renderTechniques();
            wordInput.value = '';
            
            // Enable battle button if we have 3 techniques
            if (techniques.length === 3) {
                document.getElementById('battleBtn').disabled = false;
            }
        }
    } catch (error) {
        console.error('Error generating technique:', error);
        alert('技の生成に失敗しました');
    }
}

// Render techniques list
function renderTechniques() {
    const techniquesList = document.getElementById('techniquesList');
    techniquesList.innerHTML = '';
    
    techniques.forEach((tech, index) => {
        const card = document.createElement('div');
        card.className = `technique-card ${tech.type}`;
        card.innerHTML = `
            <button class="remove-btn" onclick="removeTechnique(${index})">×</button>
            <div class="technique-name">${tech.name}</div>
            <div class="technique-type">${tech.type.toUpperCase()}</div>
            <div class="technique-power">威力: ${tech.power}</div>
            <div class="technique-description">${tech.description}</div>
            ${tech.special ? `<div class="technique-type">特殊: ${tech.special}</div>` : ''}
        `;
        techniquesList.appendChild(card);
    });
}

// Remove technique
function removeTechnique(index) {
    techniques.splice(index, 1);
    renderTechniques();
    
    if (techniques.length < 3) {
        document.getElementById('battleBtn').disabled = true;
    }
}

// Find match
function findMatch() {
    if (techniques.length < 3) {
        alert('3つの技が必要です');
        return;
    }
    
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        alert('サーバーに接続していません');
        initWebSocket();
        return;
    }
    
    // Hide input section and show battle section
    document.getElementById('inputSection').classList.add('hidden');
    document.getElementById('battleSection').classList.remove('hidden');
    
    // Send find match request
    ws.send(JSON.stringify({
        type: 'findMatch',
        techniques: techniques
    }));
}

// Start battle
function startBattle(opponentTechniques) {
    // Render player techniques
    const playerTechniquesDiv = document.getElementById('playerTechniques');
    playerTechniquesDiv.innerHTML = '';
    
    techniques.forEach((tech, index) => {
        const btn = document.createElement('button');
        btn.className = `battle-technique-btn ${tech.type}`;
        btn.innerHTML = `
            <div><strong>${tech.name}</strong></div>
            <div style="font-size: 0.9em;">威力: ${tech.power} | ${tech.type}</div>
        `;
        btn.onclick = () => useTechnique(index);
        btn.disabled = !isMyTurn;
        playerTechniquesDiv.appendChild(btn);
    });
    
    // Render opponent techniques (hidden power)
    const opponentTechniquesDiv = document.getElementById('opponentTechniques');
    opponentTechniquesDiv.innerHTML = '';
    
    opponentTechniques.forEach((tech) => {
        const btn = document.createElement('button');
        btn.className = `battle-technique-btn ${tech.type}`;
        btn.innerHTML = `
            <div><strong>${tech.name}</strong></div>
            <div style="font-size: 0.9em;">${tech.type}</div>
        `;
        btn.disabled = true;
        opponentTechniquesDiv.appendChild(btn);
    });
    
    // Clear battle log
    document.getElementById('battleLog').innerHTML = '';
    addLogEntry('バトル開始！', 'info');
}

// Use technique
function useTechnique(index) {
    if (!isMyTurn) {
        alert('あなたのターンではありません');
        return;
    }
    
    ws.send(JSON.stringify({
        type: 'useTechnique',
        techniqueIndex: index
    }));
    
    // Disable all technique buttons
    const buttons = document.querySelectorAll('#playerTechniques button');
    buttons.forEach(btn => btn.disabled = true);
}

// Handle battle update
function handleBattleUpdate(data) {
    const { attacker, technique, damage, player1Health, player2Health, special, winner, turnCount } = data;
    
    // Update health bars
    const playerHealth = playerIndex === 0 ? player1Health : player2Health;
    const opponentHealth = playerIndex === 0 ? player2Health : player1Health;
    
    updateHealth('player', playerHealth);
    updateHealth('opponent', opponentHealth);
    
    // Add log entry
    const isPlayerAttacker = (attacker === playerIndex);
    const attackerName = isPlayerAttacker ? 'あなた' : '相手';
    
    if (special === 'heal') {
        addLogEntry(`${attackerName}は「${technique}」で体力を回復した！`, 'heal');
    } else {
        addLogEntry(`${attackerName}は「${technique}」を使った！ ${damage}ダメージ！`, 'damage');
    }
    
    if (special && special !== 'heal') {
        addLogEntry(`特殊効果: ${special}`, 'info');
    }
    
    // Check for winner
    if (winner !== null) {
        const isPlayerWinner = (winner === playerIndex);
        const resultText = isPlayerWinner ? 'あなたの勝利です！' : '相手の勝利です...';
        addLogEntry(resultText, 'win');
        showStatus(resultText);
        
        setTimeout(() => {
            returnToMenu();
        }, 3000);
    } else {
        // Update turn
        isMyTurn = !isMyTurn;
        
        if (isMyTurn) {
            showStatus('あなたのターンです！');
            enableTechniqueButtons();
        } else {
            showStatus('相手のターン...');
        }
    }
}

// Update health bar
function updateHealth(player, health) {
    const healthFill = document.getElementById(`${player}Health`);
    const healthText = document.getElementById(`${player}HealthText`);
    
    healthFill.style.width = `${health}%`;
    healthText.textContent = Math.round(health);
    
    // Change color based on health
    if (health > 60) {
        healthFill.style.background = 'linear-gradient(90deg, #1dd1a1 0%, #10ac84 100%)';
    } else if (health > 30) {
        healthFill.style.background = 'linear-gradient(90deg, #feca57 0%, #ff9ff3 100%)';
    } else {
        healthFill.style.background = 'linear-gradient(90deg, #ff6b6b 0%, #ee5a24 100%)';
    }
}

// Enable technique buttons
function enableTechniqueButtons() {
    const buttons = document.querySelectorAll('#playerTechniques button');
    buttons.forEach(btn => btn.disabled = false);
}

// Show status message
function showStatus(message) {
    document.getElementById('statusMessage').textContent = message;
}

// Add log entry
function addLogEntry(message, type = 'info') {
    const battleLog = document.getElementById('battleLog');
    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;
    entry.textContent = message;
    battleLog.appendChild(entry);
    battleLog.scrollTop = battleLog.scrollHeight;
}

// Return to menu
function returnToMenu() {
    // Reset state
    battleId = null;
    playerIndex = null;
    isMyTurn = false;
    
    // Reset health bars
    updateHealth('player', 100);
    updateHealth('opponent', 100);
    
    // Show input section, hide battle section
    document.getElementById('inputSection').classList.remove('hidden');
    document.getElementById('battleSection').classList.add('hidden');
}

// Handle Enter key in word input
document.addEventListener('DOMContentLoaded', () => {
    const wordInput = document.getElementById('wordInput');
    wordInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            generateTechnique();
        }
    });
    
    // Initialize WebSocket
    initWebSocket();
});
