const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Game state
const waitingPlayers = [];
const activeBattles = new Map();

// AI-based technique generator
function generateTechnique(word) {
  const wordLower = word.toLowerCase();
  const wordLength = word.length;
  
  // Calculate base stats based on word characteristics
  const basepower = Math.min(100, wordLength * 10 + Math.floor(Math.random() * 20));
  const vowelCount = (word.match(/[aeiouAEIOU]/g) || []).length;
  const consonantCount = wordLength - vowelCount;
  
  // Determine technique type based on word characteristics
  let type = 'normal';
  let special = '';
  
  if (wordLower.includes('fire') || wordLower.includes('burn') || wordLower.includes('flame')) {
    type = 'fire';
    special = 'burn';
  } else if (wordLower.includes('water') || wordLower.includes('ice') || wordLower.includes('freeze')) {
    type = 'water';
    special = 'freeze';
  } else if (wordLower.includes('thunder') || wordLower.includes('electric') || wordLower.includes('shock')) {
    type = 'electric';
    special = 'paralyze';
  } else if (wordLower.includes('heal') || wordLower.includes('cure') || wordLower.includes('restore')) {
    type = 'heal';
    special = 'heal';
  } else if (consonantCount > vowelCount * 2) {
    type = 'physical';
    special = 'critical';
  } else if (vowelCount > consonantCount) {
    type = 'magic';
    special = 'penetrate';
  }
  
  // Generate technique name with creative AI-like transformation
  const techName = word.charAt(0).toUpperCase() + word.slice(1) + ' Strike';
  
  return {
    name: techName,
    originalWord: word,
    power: basepower,
    type: type,
    special: special,
    description: `A ${type} technique generated from the word "${word}"`
  };
}

// API endpoint for technique generation
app.post('/api/generate-technique', (req, res) => {
  const { word } = req.body;
  
  if (!word || word.trim().length === 0) {
    return res.status(400).json({ error: 'Word is required' });
  }
  
  const technique = generateTechnique(word.trim());
  res.json({ technique });
});

// WebSocket connection handling
wss.on('connection', (ws) => {
  console.log('New client connected');
  
  ws.playerId = crypto.randomUUID();
  ws.isAlive = true;
  
  ws.on('pong', () => {
    ws.isAlive = true;
  });
  
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      handleMessage(ws, data);
    } catch (error) {
      console.error('Error parsing message:', error);
    }
  });
  
  ws.on('close', () => {
    console.log('Client disconnected');
    handleDisconnect(ws);
  });
  
  // Send player ID
  ws.send(JSON.stringify({
    type: 'connected',
    playerId: ws.playerId
  }));
});

function handleMessage(ws, data) {
  switch (data.type) {
    case 'findMatch':
      findMatch(ws, data.techniques);
      break;
    case 'useTechnique':
      useTechnique(ws, data.techniqueIndex);
      break;
    case 'cancelSearch':
      cancelSearch(ws);
      break;
  }
}

function findMatch(ws, techniques) {
  ws.techniques = techniques;
  ws.health = 100;
  
  if (waitingPlayers.length > 0) {
    // Match found
    const opponent = waitingPlayers.shift();
    startBattle(ws, opponent);
  } else {
    // Add to waiting queue
    waitingPlayers.push(ws);
    ws.send(JSON.stringify({
      type: 'searching',
      message: 'Searching for opponent...'
    }));
  }
}

function startBattle(player1, player2) {
  const battleId = crypto.randomUUID();
  
  const battle = {
    id: battleId,
    players: [player1, player2],
    currentTurn: 0,
    turnCount: 0
  };
  
  activeBattles.set(battleId, battle);
  player1.battleId = battleId;
  player2.battleId = battleId;
  
  // Notify both players
  const player1Data = {
    type: 'battleStart',
    battleId: battleId,
    playerIndex: 0,
    opponentTechniques: player2.techniques.map(t => ({ name: t.name, type: t.type })),
    message: 'Battle started! Your turn.'
  };
  
  const player2Data = {
    type: 'battleStart',
    battleId: battleId,
    playerIndex: 1,
    opponentTechniques: player1.techniques.map(t => ({ name: t.name, type: t.type })),
    message: 'Battle started! Waiting for opponent...'
  };
  
  player1.send(JSON.stringify(player1Data));
  player2.send(JSON.stringify(player2Data));
}

function useTechnique(ws, techniqueIndex) {
  const battleId = ws.battleId;
  const battle = activeBattles.get(battleId);
  
  if (!battle) {
    return;
  }
  
  const playerIndex = battle.players.indexOf(ws);
  
  if (battle.currentTurn !== playerIndex) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Not your turn!'
    }));
    return;
  }
  
  const attacker = battle.players[playerIndex];
  const defender = battle.players[1 - playerIndex];
  const technique = attacker.techniques[techniqueIndex];
  
  if (!technique) {
    return;
  }
  
  // Calculate damage
  let damage = technique.power;
  
  // Apply special effects
  if (technique.special === 'critical' && Math.random() > 0.7) {
    damage *= 1.5;
  }
  
  if (technique.special === 'heal') {
    attacker.health = Math.min(100, attacker.health + damage / 2);
    damage = 0;
  }
  
  defender.health = Math.max(0, defender.health - damage);
  
  battle.turnCount++;
  
  // Check for winner
  let winner = null;
  if (defender.health <= 0) {
    winner = playerIndex;
  }
  
  // Send battle update
  const battleUpdate = {
    type: 'battleUpdate',
    attacker: playerIndex,
    technique: technique.name,
    damage: damage,
    player1Health: battle.players[0].health,
    player2Health: battle.players[1].health,
    special: technique.special,
    winner: winner,
    turnCount: battle.turnCount
  };
  
  battle.players.forEach(player => {
    player.send(JSON.stringify(battleUpdate));
  });
  
  if (winner !== null) {
    // Battle ended
    activeBattles.delete(battleId);
    battle.players.forEach(player => {
      delete player.battleId;
    });
  } else {
    // Switch turn
    battle.currentTurn = 1 - battle.currentTurn;
  }
}

function cancelSearch(ws) {
  const index = waitingPlayers.indexOf(ws);
  if (index > -1) {
    waitingPlayers.splice(index, 1);
  }
}

function handleDisconnect(ws) {
  cancelSearch(ws);
  
  if (ws.battleId) {
    const battle = activeBattles.get(ws.battleId);
    if (battle) {
      const opponent = battle.players.find(p => p !== ws);
      if (opponent) {
        opponent.send(JSON.stringify({
          type: 'opponentDisconnected',
          message: 'Opponent disconnected. You win!'
        }));
        delete opponent.battleId;
      }
      activeBattles.delete(ws.battleId);
    }
  }
}

// Heartbeat to detect broken connections
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      handleDisconnect(ws);
      return ws.terminate();
    }
    
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => {
  clearInterval(interval);
});

// Start server
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Open http://localhost:${PORT} in your browser`);
});
