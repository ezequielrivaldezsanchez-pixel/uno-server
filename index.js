const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

// --- VARIABLES DE ESTADO ---
let gameState = 'waiting';
let players = [];
let deck = [];
let discardPile = [];
let currentTurn = 0;
let direction = 1;
let activeColor = '';
let pendingPenalty = 0;
let countdownInterval = null;

// DUELO
let duelState = {
    attackerId: null, defenderId: null, attackerName: '', defenderName: '',
    round: 1, scoreAttacker: 0, scoreDefender: 0,
    attackerChoice: null, defenderChoice: null, history: []
};

// CHAT (Ahora persistente)
let chatHistory = [];

const colors = ['rojo', 'azul', 'verde', 'amarillo'];
const values = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '+2', 'X', 'R'];

// --- FUNCIONES CORE ---

function resetGame() {
    gameState = 'waiting';
    deck = [];
    discardPile = [];
    currentTurn = 0;
    direction = 1;
    activeColor = '';
    pendingPenalty = 0;
    if (countdownInterval) clearInterval(countdownInterval);
    players.forEach(p => { 
        p.hand = []; 
        p.hasDrawn = false; 
        p.isDead = false; 
        p.isSpectator = true; 
    });
    duelState = { attackerId: null, defenderId: null, attackerName: '', defenderName: '', round: 1, scoreAttacker: 0, scoreDefender: 0, attackerChoice: null, defenderChoice: null, history: [] };
}

function createDeck() {
    deck = [];
    colors.forEach(color => {
        values.forEach(val => {
            deck.push({ color, value: val, type: 'normal', id: Math.random().toString(36) });
            if (val !== '0') deck.push({ color, value: val, type: 'normal', id: Math.random().toString(36) });
        });
    });
    // Especiales
    for (let i = 0; i < 4; i++) {
        deck.push({ color: 'negro', value: 'color', type: 'wild', id: Math.random().toString(36) });
        deck.push({ color: 'negro', value: '+4', type: 'wild', id: Math.random().toString(36) });
    }
    // Únicas
    deck.push({ color: 'negro', value: 'RIP', type: 'death', id: Math.random().toString(36) });
    deck.push({ color: 'negro', value: 'RIP', type: 'death', id: Math.random().toString(36) });
    deck.push({ color: 'negro', value: 'GRACIA', type: 'divine', id: Math.random().toString(36) });
    deck.push({ color: 'negro', value: 'GRACIA', type: 'divine', id: Math.random().toString(36) });
    deck.push({ color: 'negro', value: '+12', type: 'wild', id: Math.random().toString(36) });
    deck.push({ color: 'negro', value: '+12', type: 'wild', id: Math.random().toString(36) });
    shuffle();
}

function shuffle() {
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
}

function recycleDeck() {
    if (discardPile.length <= 1) { createDeck(); return; }
    const topCard = discardPile.pop();
    deck = [...discardPile];
    discardPile = [topCard];
    shuffle();
    io.emit('notification', '♻️ Barajando descartes...');
}

function calculateHandPoints(hand) {
    let points = 0;
    hand.forEach(card => {
        if (card.value === 'RIP') points += 100;
        else if (card.value === 'GRACIA') points += 150;
        else if (card.value === '+12') points += 200;
        else if (card.type === 'wild') points += 50;
        else if (['+2', 'X', 'R'].includes(card.value)) points += 20;
        else points += parseInt(card.value) || 0;
    });
    return points;
}

// --- SOCKETS ---

io.on('connection', (socket) => {
    // Enviar historial al conectar
    socket.emit('chatHistory', chatHistory);

    socket.on('join', (name) => {
        const existing = players.find(p => p.id === socket.id);
        if (!existing) {
            const isLate = gameState !== 'waiting' && gameState !== 'counting';
            const player = { id: socket.id, name: name.substring(0, 15), hand: [], hasDrawn: false, isSpectator: isLate, isDead: false };
            players.push(player);
            io.emit('notification', `👋 ${player.name} entró.`);
            updateAll();
        }
    });

    socket.on('requestStart', () => {
        if (gameState === 'waiting' && players.length >= 1) startCountdown();
    });

    // --- JUGAR CARTA ---
    socket.on('playCard', (cardId, chosenColor) => {
        if (gameState !== 'playing') return;
        const pIndex = players.findIndex(p => p.id === socket.id);
        if (pIndex === -1 || players[pIndex].isDead) return;
        const player = players[pIndex];
        const cardIndex = player.hand.findIndex(c => c.id === cardId);
        if (cardIndex === -1) return;
        
        const card = player.hand[cardIndex];
        const top = discardPile[discardPile.length - 1];
        if (top.color !== 'negro') activeColor = top.color;

        // SAFF (Intercepción)
        let isSaff = false;
        if (pIndex !== currentTurn) {
            if (card.color !== 'negro' && card.value === top.value && card.color === top.color) {
                isSaff = true;
                currentTurn = pIndex;
                pendingPenalty = 0;
                io.emit('notification', `⚡ ¡${player.name} hizo SAFF!`);
                io.emit('playSound', 'saff');
            } else {
                return; // Silencioso para no spamear
            }
        }

        // VALIDACIÓN
        if (pIndex === currentTurn && !isSaff) {
            // MODO COMBATE (HAY CASTIGO)
            if (pendingPenalty > 0) {
                let allowed = false;
                let topPower = top.value === '+2' ? 1 : (top.value === '+4' ? 2 : (top.value === '+12' ? 3 : 0));
                let cardPower = card.value === '+2' ? 1 : (card.value === '+4' ? 2 : (card.value === '+12' ? 3 : 0));
                
                if (cardPower > 0 && cardPower >= topPower) allowed = true;
                if (card.value === 'GRACIA') allowed = true;

                if (!allowed) {
                    socket.emit('notification', `🚫 Debes tirar igual/mayor poder o robar.`);
                    return;
                }
            } 
            // MODO NORMAL
            else {
                let valid = false;
                if (card.color === 'negro' || card.value === 'GRACIA') valid = true;
                else if (card.color === activeColor) valid = true;
                else if (card.value === top.value) valid = true;
                if (!valid) {
                    socket.emit('notification', `❌ Carta inválida.`);
                    return;
                }
            }
        }

        // --- EJECUCIÓN ---

        // 1. GRACIA
        if (card.value === 'GRACIA') {
            player.hand.splice(cardIndex, 1);
            discardPile.push(card);
            io.emit('playSound', 'divine');
            
            if (pendingPenalty > 0) {
                io.emit('showDivine', `${player.name} anuló el castigo.`);
                pendingPenalty = 0;
                if (!activeColor) activeColor = 'rojo'; // Fallback de seguridad
                advanceTurn(1); // Pasa 1 turno normal
                updateAll();
                return;
            }
            const deadPlayer = players.find(p => p.isDead);
            if (deadPlayer) {
                deadPlayer.isDead = false; deadPlayer.isSpectator = false;
                io.emit('showDivine', `¡MILAGRO! ${deadPlayer.name} revivió`);
            } else {
                io.emit('notification', `❤️ ${player.name} usó Gracia.`);
            }
            advanceTurn(1); updateAll(); return;
        }

        // 2. RIP
        if (card.value === 'RIP') {
            if (getAlivePlayersCount() < 2) {
                player.hand.splice(cardIndex, 1); discardPile.push(card);
                advanceTurn(1); updateAll(); return;
            }
            player.hand.splice(cardIndex, 1); discardPile.push(card); io.emit('playSound', 'rip');
            gameState = 'rip_decision';
            const attacker = player;
            // Víctima es el siguiente jugador
            const victimIdx = getNextPlayerIndex(1);
            const defender = players[victimIdx];
            duelState = { attackerId: attacker.id, defenderId: defender.id, attackerName: attacker.name, defenderName: defender.name, round: 1, scoreAttacker: 0, scoreDefender: 0, history: [] };
            io.emit('notification', `💀 ¡${attacker.name} RIP a ${defender.name}!`);
            updateAll(); return;
        }

        // 3. JUGADA ESTÁNDAR
        player.hand.splice(cardIndex, 1);
        discardPile.push(card);
        io.emit('cardPlayedEffect', { color: card.color });

        if (card.color === 'negro' && chosenColor) activeColor = chosenColor;
        else if (card.color !== 'negro') activeColor = card.color;

        let steps = 1;

        // LÓGICA DE TURNOS (Salto y Reversa)
        if (card.value === 'R') {
            if (getAlivePlayersCount() === 2) {
                steps = 2; // En 1vs1, Reversa es Salto (Juega de nuevo)
            } else {
                direction *= -1; // En >2, cambia sentido
            }
        }
        if (card.value === 'X') {
            steps = 2; // Salta al siguiente
        }

        // CASTIGOS
        if (['+2', '+4', '+12'].includes(card.value)) {
            const val = parseInt(card.value.replace('+',''));
            pendingPenalty += val;
            let sound = val === 2 ? 'attack' : (val === 4 ? 'attack' : 'thunder');
            io.emit('notification', `💥 +${val} (Total: ${pendingPenalty})`);
            io.emit('playSound', sound);
            if (val > 4) io.emit('shakeScreen');
        } else {
            if (card.color === 'negro') io.emit('playSound', 'wild'); else io.emit('playSound', 'soft');
        }

        if (player.hand.length === 0) finishRound(player);
        else { advanceTurn(steps); updateAll(); }
    });

    // --- ROBAR ---
    socket.on('draw', () => {
        if (gameState !== 'playing') return;
        const pIndex = players.findIndex(p => p.id === socket.id);
        if (pIndex === -1) return;

        // FIX DE EMERGENCIA: Si es mi turno pero el server dice que ya robé,
        // permitimos resetear si no hay cartas jugadas, para evitar bloqueo.
        if (pIndex === currentTurn) {
            if (pendingPenalty > 0) {
                drawCards(pIndex, 1);
                pendingPenalty--;
                io.emit('playSound', 'soft');
                if (pendingPenalty <= 0) {
                    io.emit('notification', 'Terminó castigo. Pasa turno.');
                    advanceTurn(1);
                } else {
                    updateAll();
                }
            } else {
                if (!players[pIndex].hasDrawn) {
                    drawCards(pIndex, 1);
                    players[pIndex].hasDrawn = true;
                    io.emit('playSound', 'soft');
                    updateAll();
                } else {
                    socket.emit('notification', 'Ya robaste.');
                }
            }
        }
    });

    socket.on('passTurn', () => {
        if (gameState !== 'playing') return;
        const pIndex = players.findIndex(p => p.id === socket.id);
        if (pIndex === currentTurn && players[pIndex].hasDrawn && pendingPenalty === 0) {
            advanceTurn(1);
            updateAll();
        }
    });

    // --- CHAT Y OTROS ---
    socket.on('sendChat', (text) => {
        const p = players.find(x => x.id === socket.id);
        if (p) {
            const msg = { name: p.name, text };
            chatHistory.push(msg);
            if(chatHistory.length > 50) chatHistory.shift(); // Limitar historial
            io.emit('chatMessage', msg);
        }
    });

    socket.on('playGraceDefense', (chosenColor) => {
        if (gameState !== 'rip_decision' || socket.id !== duelState.defenderId) return;
        const defender = players.find(p => p.id === socket.id);
        const cardIndex = defender.hand.findIndex(c => c.value === 'GRACIA');
        if (cardIndex !== -1) {
            defender.hand.splice(cardIndex, 1);
            discardPile.push(defender.hand[cardIndex]);
            activeColor = chosenColor || 'rojo';
            io.emit('showDivine', `¡${defender.name} usa Gracia!`);
            io.emit('playSound', 'divine');
            
            const attIndex = players.findIndex(p => p.id === duelState.attackerId);
            drawCards(attIndex, 4); // Castigo al atacante
            gameState = 'playing';
            advanceTurn(1);
            updateAll();
        }
    });

    socket.on('ripDecision', (d) => {
        if (gameState !== 'rip_decision' || socket.id !== duelState.defenderId) return;
        if (d === 'surrender') {
            eliminatePlayer(duelState.defenderId);
            checkWinCondition();
        } else {
            gameState = 'dueling'; updateAll();
        }
    });

    socket.on('duelPick', (c) => {
        if (gameState !== 'dueling') return;
        if (socket.id === duelState.attackerId) duelState.attackerChoice = c;
        if (socket.id === duelState.defenderId) duelState.defenderChoice = c;
        if (duelState.attackerChoice && duelState.defenderChoice) resolveDuelRound();
        else updateAll();
    });

    socket.on('sayUno', () => {
        const p = players.find(p => p.id === socket.id);
        if (p && !p.isDead) {
            io.emit('notification', `🚨 ¡${p.name} gritó UNO! 🚨`);
            io.emit('playSound', 'uno');
        }
    });

    socket.on('restartGame', () => { resetGame(); updateAll(); });

    socket.on('disconnect', () => {
        players = players.filter(pl => pl.id !== socket.id);
        if (players.length < 1) resetGame();
        else if (gameState === 'playing' && currentTurn >= players.length) currentTurn = 0;
        updateAll();
    });
});

// --- FUNCIONES AUXILIARES ROBUSTAS ---

function startCountdown() {
    gameState = 'counting';
    let count = 3;
    createDeck();
    let safeCard = deck.pop();
    while (['negro', '+2', 'R', 'X'].includes(safeCard.color) || ['+2', 'R', 'X'].includes(safeCard.value)) {
        deck.unshift(safeCard); shuffle(); safeCard = deck.pop();
    }
    discardPile = [safeCard];
    activeColor = safeCard.color;
    currentTurn = 0; pendingPenalty = 0;
    players.forEach(p => { p.hand = []; p.hasDrawn = false; p.isDead = false; p.isSpectator = false; drawCards(players.indexOf(p), 7); });
    
    let int = setInterval(() => {
        io.emit('countdownTick', count);
        if (count <= 0) { clearInterval(int); gameState = 'playing'; io.emit('playSound', 'start'); updateAll(); }
        count--;
    }, 1000);
}

function drawCards(pid, n) { 
    if (pid < 0 || pid >= players.length) return; 
    for (let i = 0; i < n; i++) { 
        if (deck.length === 0) recycleDeck(); 
        if (deck.length > 0) players[pid].hand.push(deck.pop()); 
    } 
}

// NUEVA LÓGICA DE AVANCE MATEMÁTICO (SOLUCIÓN AL BLOQUEO)
function advanceTurn(steps) {
    if (players.length === 0) return;
    
    // 1. Limpieza preventiva global
    players.forEach(p => p.hasDrawn = false);

    let found = false;
    let attempts = 0;
    
    // Avanzamos 'steps' veces buscando al siguiente vivo
    while (steps > 0 && attempts < players.length * 2) {
        currentTurn = (currentTurn + direction + players.length) % players.length;
        if (!players[currentTurn].isDead) {
            steps--; // Solo descontamos si el jugador está vivo
        }
        attempts++;
    }
    // Asegurar limpieza del nuevo jugador actual
    if (players[currentTurn]) players[currentTurn].hasDrawn = false;
}

function getNextPlayerIndex(steps) {
    let next = currentTurn;
    let attempts = 0;
    while (steps > 0 && attempts < players.length * 2) {
        next = (next + direction + players.length) % players.length;
        if (!players[next].isDead) steps--;
        attempts++;
    }
    return next;
}

function finishRound(w) {
    gameState = 'waiting';
    const res = players.map(p => ({ name: p.name, points: p.isDead ? 0 : calculateHandPoints(p.hand), winner: p.id === w.id }));
    io.emit('gameOver', { winner: w.name, results: res });
    io.emit('playSound', 'win');
}

function checkWinCondition() {
    if (getAlivePlayersCount() <= 1) {
        const winner = players.find(p => !p.isDead);
        if (winner) finishRound(winner); else resetGame();
    } else {
        gameState = 'playing'; advanceTurn(1); updateAll();
    }
}

function eliminatePlayer(id) { const p = players.find(p => p.id === id); if (p) { p.isDead = true; p.isSpectator = true; } }
function getAlivePlayersCount() { return players.filter(p => !p.isDead).length; }

function resolveDuelRound() {
    // Lógica simple de piedra papel tijera
    const att = duelState.attackerChoice, def = duelState.defenderChoice;
    let winner = 'tie';
    if ((att == 'fuego' && def == 'hielo') || (att == 'hielo' && def == 'agua') || (att == 'agua' && def == 'fuego')) winner = 'attacker';
    else if ((def == 'fuego' && att == 'hielo') || (def == 'hielo' && att == 'agua') || (def == 'agua' && att == 'fuego')) winner = 'defender';
    
    if (winner == 'attacker') duelState.scoreAttacker++; else if (winner == 'defender') duelState.scoreDefender++;
    duelState.history.push({ round: duelState.round, att, def, winner: winner });
    duelState.attackerChoice = null; duelState.defenderChoice = null;
    
    if (duelState.round >= 3 || duelState.scoreAttacker >= 2 || duelState.scoreDefender >= 2) {
        const finalWinner = duelState.scoreAttacker > duelState.scoreDefender ? 'att' : (duelState.scoreDefender > duelState.scoreAttacker ? 'def' : 'tie');
        if (finalWinner === 'att') { eliminatePlayer(duelState.defenderId); checkWinCondition(); }
        else if (finalWinner === 'def') { drawCards(players.findIndex(p => p.id === duelState.attackerId), 4); gameState = 'playing'; advanceTurn(1); updateAll(); }
        else { gameState = 'playing'; advanceTurn(1); updateAll(); }
    } else {
        duelState.round++; updateAll();
    }
}

function updateAll() {
    const duelInfo = (gameState === 'dueling' || gameState === 'rip_decision') ? duelState : null;
    const pack = {
        state: gameState, 
        players: players.map((p, i) => ({ 
            name: p.name, cardCount: p.hand.length, id: p.id, 
            isTurn: (gameState === 'playing' && i === currentTurn), 
            hasDrawn: p.hasDrawn, isDead: p.isDead 
        })),
        topCard: discardPile[discardPile.length - 1], 
        activeColor, currentTurn, duelInfo, pendingPenalty
    };
    players.forEach(p => {
        io.to(p.id).emit('updateState', pack);
        io.to(p.id).emit('handUpdate', p.hand);
    });
}

// --- CLIENTE ---
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>UNO y 1/2</title>
    <style>
        * { box-sizing: border-box; }
        body { margin: 0; background: #1e272e; color: white; font-family: sans-serif; height: 100dvh; display: flex; flex-direction: column; overflow: hidden; }
        .screen { position: absolute; top:0; left:0; width:100%; height:100%; display:none; flex-direction:column; justify-content:center; align-items:center; z-index:10; background:#2c3e50; }
        
        #game-area { display: none; flex-direction: column; height: 100%; }
        #players-zone { padding: 10px; display: flex; justify-content: center; gap: 5px; background: rgba(0,0,0,0.5); flex-wrap: wrap; }
        .player-badge { padding: 5px 10px; background: #333; border-radius: 15px; border: 1px solid #555; }
        .is-turn { background: #2ecc71; color: black; border: 2px solid white; transform: scale(1.1); font-weight: bold; }
        .is-dead { text-decoration: line-through; opacity: 0.5; }

        #table-zone { flex: 1; display: flex; flex-direction: column; justify-content: center; align-items: center; gap: 20px; }
        .card { width: 80px; height: 120px; border-radius: 8px; border: 3px solid white; display: flex; justify-content: center; align-items: center; font-size: 30px; font-weight: bold; text-shadow: 1px 1px 0 #000; box-shadow: 0 4px 8px rgba(0,0,0,0.5); position: relative; }
        #deck { background: #e74c3c; cursor: pointer; }
        
        #hand-zone { height: 160px; background: rgba(0,0,0,0.9); display: flex; align-items: center; padding: 10px; gap: 10px; overflow-x: auto; border-top: 2px solid #555; z-index: 100; }
        .hand-card { min-width: 90px; height: 130px; border-radius: 8px; border: 2px solid white; display: flex; justify-content: center; align-items: center; font-size: 40px; cursor: pointer; }

        /* Colores dinámicos */
        .bg-rojo { background: #c0392b !important; }
        .bg-azul { background: #2980b9 !important; }
        .bg-verde { background: #27ae60 !important; }
        .bg-amarillo { background: #f1c40f !important; }
        .bg-negro { background: #2c3e50 !important; }
        
        /* Chat Flotante mejorado */
        #chat-btn { position: fixed; bottom: 180px; right: 20px; width: 50px; height: 50px; background: #3498db; border-radius: 50%; z-index: 2000; display: flex; justify-content: center; align-items: center; cursor: pointer; box-shadow: 0 4px 5px rgba(0,0,0,0.5); font-size: 24px; border: 2px solid white; }
        #chat-win { position: fixed; bottom: 240px; right: 20px; width: 250px; height: 200px; background: rgba(0,0,0,0.9); border: 1px solid #7f8c8d; z-index: 2000; display: none; flex-direction: column; border-radius: 10px; overflow: hidden; }
        #chat-history { flex: 1; overflow-y: auto; padding: 10px; font-size: 12px; }
        #chat-input { width: 100%; border: none; padding: 10px; background: #333; color: white; }

        /* Notificaciones */
        #notification { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); background: rgba(0,0,0,0.9); padding: 20px; border: 2px solid gold; border-radius: 10px; font-size: 20px; display: none; z-index: 3000; text-align: center; }
        
        #color-picker { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); background: white; padding: 20px; border-radius: 10px; display: none; z-index: 4000; }
        .cp-btn { width: 50px; height: 50px; border-radius: 50%; display: inline-block; margin: 5px; cursor: pointer; border: 2px solid #ccc; }
    </style>
</head>
<body>

    <div id="login" class="screen" style="display:flex;">
        <h1>UNO y 1/2</h1>
        <input id="name-in" placeholder="Nombre" style="padding:10px; font-size:16px;">
        <br><button onclick="join()" style="padding:10px 20px; font-size:16px;">Entrar</button>
    </div>

    <div id="game-area">
        <div id="players-zone"></div>
        
        <div id="table-zone">
            <div id="notification"></div>
            <div style="display:flex; gap:20px;">
                <div id="deck" class="card" onclick="draw()">📦</div>
                <div id="top-card" class="card"></div>
            </div>
            <button onclick="uno()" style="padding:10px 20px; background:#e74c3c; color:white; border:none; border-radius:20px; font-weight:bold; margin-top:20px;">¡UNO y 1/2!</button>
            <button id="pass-btn" onclick="pass()" style="display:none; padding:10px 20px; background:#f39c12; color:white; border:none; border-radius:20px; margin-top:10px;">PASAR</button>
        </div>

        <div id="hand-zone"></div>
    </div>

    <div id="chat-btn" onclick="toggleChat()">💬</div>
    <div id="chat-win">
        <div id="chat-history"></div>
        <input id="chat-input" placeholder="Mensaje..." onkeypress="if(event.key==='Enter') sendChat()">
    </div>

    <div id="color-picker">
        <div class="cp-btn" style="background:#c0392b" onclick="pickColor('rojo')"></div>
        <div class="cp-btn" style="background:#2980b9" onclick="pickColor('azul')"></div>
        <div class="cp-btn" style="background:#27ae60" onclick="pickColor('verde')"></div>
        <div class="cp-btn" style="background:#f1c40f" onclick="pickColor('amarillo')"></div>
    </div>

    <div id="rip-modal" class="screen" style="background:rgba(0,0,0,0.95)">
        <h1 style="color:red">TE HAN LANZADO RIP</h1>
        <button onclick="socket.emit('ripDecision','duel')">ACEPTAR DUELO</button>
        <button onclick="socket.emit('ripDecision','surrender')">RENDIRSE</button>
        <br><br>
        <button id="grace-btn" style="display:none; border:2px solid gold; color:gold; background:transparent;" onclick="graceDef()">USAR GRACIA</button>
    </div>

    <div id="duel-modal" class="screen">
        <h1 style="color:gold">DUELO</h1>
        <h2 id="duel-score">0 - 0</h2>
        <div style="font-size:40px;">
            <span onclick="socket.emit('duelPick','fuego')">🔥</span>
            <span onclick="socket.emit('duelPick','hielo')">❄️</span>
            <span onclick="socket.emit('duelPick','agua')">💧</span>
        </div>
    </div>

    <script src="/socket.io/socket.io.js"></script>
    <script>
        const socket = io();
        let myId = null;
        let pendingCard = null;
        let pendingGrace = false;

        const colorHex = { 'rojo': '#c0392b', 'azul': '#2980b9', 'verde': '#27ae60', 'amarillo': '#f1c40f', 'negro': '#2c3e50' };

        function join() {
            const name = document.getElementById('name-in').value;
            if(name) { socket.emit('join', name); document.getElementById('login').style.display='none'; document.getElementById('game-area').style.display='flex'; }
        }

        function draw() { socket.emit('draw'); }
        function pass() { socket.emit('passTurn'); }
        function uno() { socket.emit('sayUno'); }
        
        function sendChat() {
            const inp = document.getElementById('chat-input');
            if(inp.value.trim()) { socket.emit('sendChat', inp.value); inp.value = ''; }
        }
        function toggleChat() {
            const win = document.getElementById('chat-win');
            win.style.display = win.style.display === 'flex' ? 'none' : 'flex';
        }

        function pickColor(c) {
            document.getElementById('color-picker').style.display = 'none';
            if(pendingGrace) { socket.emit('playGraceDefense', c); pendingGrace=false; }
            else { socket.emit('playCard', pendingCard, c); pendingCard = null; }
        }
        function graceDef() { pendingGrace=true; document.getElementById('rip-modal').style.display='none'; document.getElementById('color-picker').style.display='block'; }

        // SONIDOS
        const sounds = {
            soft: new Audio('https://cdn.freesound.org/previews/240/240776_4107740-lq.mp3'),
            attack: new Audio('https://cdn.freesound.org/previews/155/155235_2452367-lq.mp3'),
            start: new Audio('https://cdn.freesound.org/previews/320/320655_5260872-lq.mp3')
        };
        socket.on('playSound', k => { if(sounds[k]) sounds[k].play().catch(()=>{}); });

        // UPDATES
        socket.on('connect', () => myId = socket.id);
        
        socket.on('chatHistory', hist => {
            const box = document.getElementById('chat-history');
            box.innerHTML = '';
            hist.forEach(m => box.innerHTML += \`<div><b>\${m.name}:</b> \${m.text}</div>\`);
        });
        socket.on('chatMessage', m => {
            const box = document.getElementById('chat-history');
            box.innerHTML += \`<div><b>\${m.name}:</b> \${m.text}</div>\`;
            box.scrollTop = box.scrollHeight;
        });

        socket.on('notification', t => {
            const n = document.getElementById('notification');
            n.innerText = t; n.style.display = 'block';
            setTimeout(() => n.style.display='none', 2000);
        });

        socket.on('updateState', s => {
            // Render Players
            const pz = document.getElementById('players-zone');
            pz.innerHTML = s.players.map(p => 
                \`<div class="player-badge \${p.isTurn?'is-turn':''} \${p.isDead?'is-dead':''}">
                    \${p.name} (\${p.cardCount})
                </div>\`
            ).join('');

            // Render Table
            const tc = document.getElementById('top-card');
            if(s.topCard) {
                const c = s.topCard;
                tc.style.backgroundColor = colorHex[s.activeColor || c.color] || '#333';
                tc.style.color = (s.activeColor==='amarillo'||c.color==='amarillo') ? 'black':'white';
                tc.innerText = c.value;
                if(c.value==='RIP') tc.innerText = '💀';
                if(c.value==='GRACIA') tc.innerText = '❤️';
            }

            // Controls
            const me = s.players.find(p => p.id === myId);
            document.getElementById('pass-btn').style.display = (me && me.isTurn && me.hasDrawn && s.pendingPenalty===0) ? 'block' : 'none';

            // Modals
            if(s.state === 'rip_decision') {
                if(s.duelInfo && s.duelInfo.defenderId === myId) {
                    document.getElementById('rip-modal').style.display = 'flex';
                }
            } else {
                document.getElementById('rip-modal').style.display = 'none';
            }
            
            if(s.state === 'dueling') {
                document.getElementById('duel-modal').style.display = 'flex';
                if(s.duelInfo) document.getElementById('duel-score').innerText = \`\${s.duelInfo.scoreAttacker} - \${s.duelInfo.scoreDefender}\`;
            } else {
                document.getElementById('duel-modal').style.display = 'none';
            }
        });

        socket.on('handUpdate', hand => {
            const hz = document.getElementById('hand-zone');
            hz.innerHTML = '';
            const hasGrace = hand.some(c => c.value === 'GRACIA');
            document.getElementById('grace-btn').style.display = hasGrace ? 'block' : 'none';

            hand.forEach(c => {
                const el = document.createElement('div');
                el.className = 'hand-card';
                el.style.backgroundColor = colorHex[c.color] || '#333';
                el.style.color = c.color==='amarillo'?'black':'white';
                el.innerText = c.value;
                if(c.value==='RIP') el.innerText = '💀';
                if(c.value==='GRACIA') el.innerText = '❤️';
                
                el.onclick = () => {
                    if(c.color === 'negro' && c.value !== 'GRACIA') {
                         if(c.value === 'RIP') socket.emit('playCard', c.id, null);
                         else { pendingCard = c.id; document.getElementById('color-picker').style.display='block'; }
                    } else {
                        socket.emit('playCard', c.id, null);
                    }
                };
                hz.appendChild(el);
            });
        });
    </script>
</body>
</html>
    `);
});

http.listen(process.env.PORT || 3000, () => console.log('SERVER OK'));
