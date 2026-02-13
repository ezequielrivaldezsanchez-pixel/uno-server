const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

// --- VARIABLES DE JUEGO ---
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

// CHAT
let chatHistory = [];

const colors = ['rojo', 'azul', 'verde', 'amarillo'];
const values = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '+2', 'X', 'R'];

// --- FUNCIONES DEL SISTEMA ---

function resetGame() {
    gameState = 'waiting';
    deck = [];
    discardPile = [];
    currentTurn = 0;
    direction = 1;
    activeColor = '';
    pendingPenalty = 0;
    if (countdownInterval) clearInterval(countdownInterval);
    
    // Mantener jugadores pero resetear estados
    players.forEach((p, index) => { 
        p.hand = []; 
        p.hasDrawn = false; 
        p.isDead = false; 
        p.isSpectator = false; // Todos vuelven a jugar
        p.isAdmin = (index === 0); // El primero de la lista es Admin
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
    if (discardPile.length <= 1) { 
        createDeck(); 
        io.emit('notification', '⚠️ Mazo regenerado.');
        return; 
    }
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
    socket.emit('chatHistory', chatHistory);

    socket.on('join', (name) => {
        const existing = players.find(p => p.id === socket.id);
        if (!existing) {
            // LÓGICA DE SALA CERRADA
            const isGameRunning = gameState !== 'waiting' && gameState !== 'counting';
            
            const player = { 
                id: socket.id, 
                name: name.substring(0, 15), 
                hand: [], 
                hasDrawn: false, 
                isSpectator: isGameRunning, // Si el juego corre, es espectador
                isDead: false,
                isAdmin: (players.length === 0) // Si es el primero, es Admin
            };
            
            players.push(player);
            io.emit('notification', `👋 ${player.name} entró.`);
            
            if (isGameRunning) {
                socket.emit('notification', 'Partida en curso. Modo Espectador.');
            }
            
            updateAll();
        }
    });

    socket.on('requestStart', () => {
        const p = players.find(p => p.id === socket.id);
        // SOLO EL ADMIN PUEDE INICIAR
        if (p && p.isAdmin && gameState === 'waiting' && players.length >= 1) {
            startCountdown();
        }
    });

    // --- PLAY CARD ---
    socket.on('playCard', (cardId, chosenColor) => {
        if (gameState !== 'playing') return;
        const pIndex = players.findIndex(p => p.id === socket.id);
        if (pIndex === -1) return;
        const player = players[pIndex];
        if (player.isDead || player.isSpectator) return;

        const cardIndex = player.hand.findIndex(c => c.id === cardId);
        if (cardIndex === -1) return; 
        const card = player.hand[cardIndex];
        const top = discardPile[discardPile.length - 1];

        if (top.color !== 'negro') activeColor = top.color;

        // SAFF
        let isSaff = false;
        if (pIndex !== currentTurn) {
            if (card.color !== 'negro' && card.value === top.value && card.color === top.color) {
                isSaff = true; currentTurn = pIndex; pendingPenalty = 0;
                io.emit('notification', `⚡ ¡${player.name} hizo SAFF!`); 
                io.emit('playSound', 'saff');
            } else { return; }
        }

        if (pIndex === currentTurn && !isSaff) {
            if (pendingPenalty > 0) {
                let allowed = false;
                if (card.value === '+12' || card.value === '+4' || card.value === 'GRACIA') allowed = true;
                else if (top.value === '+2' && card.value === '+2') allowed = true;
                if (!allowed) { socket.emit('notification', `🚫 Tienes castigo (+${pendingPenalty}).`); return; }
            } else {
                let valid = false;
                if (card.color === 'negro' || card.value === 'GRACIA') valid = true;
                else if (card.color === activeColor || card.value === top.value) valid = true;
                if (!valid) { socket.emit('notification', `❌ Carta inválida.`); return; }
            }
        }

        // EJECUCIÓN
        if (card.value === 'GRACIA') {
            const deadPlayer = players.find(p => p.isDead);
            player.hand.splice(cardIndex, 1); discardPile.push(card); io.emit('playSound', 'divine'); 
            if (pendingPenalty > 0) {
                io.emit('showDivine', `${player.name} anuló el castigo`); pendingPenalty = 0; 
                if (!activeColor) activeColor = 'rojo'; 
                advanceTurn(); updateAll(); return;
            }
            if (deadPlayer) {
                deadPlayer.isDead = false; deadPlayer.isSpectator = false; 
                io.emit('showDivine', `¡MILAGRO! ${deadPlayer.name} revivió`);
            } else { io.emit('notification', `❤️ ${player.name} usó Gracia.`); }
            advanceTurn(); updateAll(); return;
        }

        if (card.value === 'RIP') {
            if (getAlivePlayersCount() < 2) {
                player.hand.splice(cardIndex, 1); discardPile.push(card); 
                io.emit('notification', '💀 RIP fallido.'); advanceTurn(); updateAll(); return;
            }
            player.hand.splice(cardIndex, 1); discardPile.push(card); io.emit('playSound', 'rip'); 
            gameState = 'rip_decision';
            const attacker = player; const defender = players[getNextPlayerIndex()];
            duelState = { attackerId: attacker.id, defenderId: defender.id, attackerName: attacker.name, defenderName: defender.name, round: 1, scoreAttacker: 0, scoreDefender: 0, attackerChoice: null, defenderChoice: null, history: [] };
            io.emit('notification', `💀 ¡${attacker.name} usó RIP contra ${defender.name}!`);
            updateAll(); return;
        }

        player.hand.splice(cardIndex, 1); discardPile.push(card); 
        io.emit('cardPlayedEffect', { color: card.color });
        if (card.color === 'negro' && chosenColor) activeColor = chosenColor; 
        else if (card.color !== 'negro') activeColor = card.color;

        if (card.value === 'R') { 
            if (getAlivePlayersCount() === 2) advanceTurn(); 
            else direction *= -1; 
        }
        if (card.value === 'X') advanceTurn();
        
        if (['+2', '+4', '+12'].includes(card.value)) { 
            const val = parseInt(card.value.replace('+',''));
            pendingPenalty += val; 
            io.emit('notification', `💥 ¡+${val}! Total: ${pendingPenalty}`); 
            io.emit('playSound', 'attack'); io.emit('shakeScreen'); 
            advanceTurn(); updateAll(); return; 
        }

        if (card.color === 'negro') io.emit('playSound', 'wild'); else io.emit('playSound', 'soft');
        if (player.hand.length === 0) finishRound(player); else { advanceTurn(); updateAll(); }
    });

    socket.on('draw', () => {
        if (gameState !== 'playing') return;
        const pIndex = players.findIndex(p => p.id === socket.id);
        if (pIndex === -1 || players[pIndex].isDead) return;

        if (pIndex === currentTurn) {
            if (pendingPenalty > 0) {
                drawCards(pIndex, 1); pendingPenalty--; io.emit('playSound', 'soft');
                if (pendingPenalty > 0) { io.emit('notification', `😰 Faltan: ${pendingPenalty}`); updateAll(); } 
                else { io.emit('notification', `😓 Terminó castigo.`); advanceTurn(); updateAll(); }
            } else {
                if (!players[pIndex].hasDrawn) { 
                    drawCards(pIndex, 1); players[pIndex].hasDrawn = true; io.emit('playSound', 'soft'); updateAll(); 
                } else { socket.emit('notification', 'Ya robaste.'); }
            }
        }
    });

    socket.on('passTurn', () => {
        if (gameState !== 'playing') return;
        const pIndex = players.findIndex(p => p.id === socket.id);
        if (pIndex === currentTurn && players[pIndex].hasDrawn && pendingPenalty === 0) { advanceTurn(); updateAll(); }
    });

    socket.on('playGraceDefense', (chosenColor) => {
        if (gameState !== 'rip_decision' || socket.id !== duelState.defenderId) return;
        const defender = players.find(p => p.id === socket.id);
        const cardIndex = defender.hand.findIndex(c => c.value === 'GRACIA');
        if (cardIndex !== -1) {
            defender.hand.splice(cardIndex, 1); discardPile.push(defender.hand[cardIndex]); 
            activeColor = chosenColor || 'rojo';
            io.emit('showDivine', `${defender.name} salvado por Gracia`); io.emit('playSound', 'divine');
            const attIndex = players.findIndex(p => p.id === duelState.attackerId); drawCards(attIndex, 4); 
            gameState = 'playing'; advanceTurn(); updateAll();
        }
    });

    socket.on('ripDecision', (d) => {
        if (gameState !== 'rip_decision' || socket.id !== duelState.defenderId) return;
        const def = players.find(p => p.id === duelState.defenderId);
        if (d === 'surrender') { eliminatePlayer(def.id); checkWinCondition(); } 
        else { io.emit('playSound', 'bell'); gameState = 'dueling'; updateAll(); }
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
        if (p && !p.isDead) { io.emit('notification', `🚨 ¡${p.name} gritó UNO y 1/2!`); io.emit('playSound', 'uno'); }
    });

    socket.on('restartGame', () => { resetGame(); updateAll(); });
    
    socket.on('sendChat', (text) => { 
        const p = players.find(x => x.id === socket.id); 
        if (p) {
            const msg = { name: p.name, text };
            chatHistory.push(msg);
            if (chatHistory.length > 50) chatHistory.shift();
            io.emit('chatMessage', msg); 
        }
    });

    socket.on('disconnect', () => {
        const p = players.find(p => p.id === socket.id);
        if (!p) return;
        
        // Si el Host se va, heredar al siguiente
        const wasAdmin = p.isAdmin;
        players = players.filter(pl => pl.id !== socket.id);
        
        if (wasAdmin && players.length > 0) {
            players[0].isAdmin = true;
            io.emit('notification', `👑 ${players[0].name} es el nuevo anfitrión.`);
        }

        if (gameState === 'playing' || gameState === 'counting') {
            if (players.length < 1) resetGame();
            else {
                if (currentTurn >= players.length) currentTurn = 0; 
                updateAll();
            }
        }
        updateAll();
    });
});

// --- FUNCIONES AUXILIARES ---

function checkWinCondition() {
    if (players.length > 1 && getAlivePlayersCount() <= 1) {
        const winner = players.find(p => !p.isDead); if (winner) finishRound(winner); else resetGame(); updateAll();
    } else { gameState = 'playing'; advanceTurn(); updateAll(); }
}

function resolveDuelRound() {
    const att = duelState.attackerChoice, def = duelState.defenderChoice;
    let winner = 'tie';
    if ((att == 'fuego' && def == 'hielo') || (att == 'hielo' && def == 'agua') || (att == 'agua' && def == 'fuego')) winner = 'attacker';
    else if ((def == 'fuego' && att == 'hielo') || (def == 'hielo' && att == 'agua') || (def == 'agua' && att == 'fuego')) winner = 'defender';

    if (winner == 'attacker') duelState.scoreAttacker++; else if (winner == 'defender') duelState.scoreDefender++;
    duelState.history.push({ round: duelState.round, att, def, winnerName: winner == 'attacker' ? duelState.attackerName : (winner == 'defender' ? duelState.defenderName : 'Empate') });
    duelState.attackerChoice = null; duelState.defenderChoice = null; io.emit('playSound', 'soft');

    if (duelState.round >= 3 || duelState.scoreAttacker >= 2 || duelState.scoreDefender >= 2) setTimeout(finalizeDuel, 2000); else { duelState.round++; updateAll(); }
}

function finalizeDuel() {
    const att = players.find(p => p.id === duelState.attackerId); const def = players.find(p => p.id === duelState.defenderId);
    if (!att || !def) { gameState = 'playing'; updateAll(); return; }
    if (duelState.scoreAttacker > duelState.scoreDefender) { io.emit('notification', `💀 ${att.name} GANA.`); eliminatePlayer(def.id); checkWinCondition(); }
    else if (duelState.scoreDefender > duelState.scoreAttacker) { io.emit('notification', `🛡️ ${def.name} GANA. Castigo atacante.`); drawCards(players.findIndex(p => p.id === duelState.attackerId), 4); gameState = 'playing'; advanceTurn(); updateAll(); }
    else { io.emit('notification', `🤝 EMPATE.`); gameState = 'playing'; advanceTurn(); updateAll(); }
}

function eliminatePlayer(id) { const p = players.find(p => p.id === id); if (p) { p.isDead = true; p.isSpectator = true; } }
function getAlivePlayersCount() { return players.filter(p => !p.isDead).length; }

function startCountdown() {
    if (players.length < 1) return;
    gameState = 'counting';
    let count = 3;
    createDeck();
    let safeCard = deck.pop();
    while (safeCard.color === 'negro' || safeCard.value === '+2' || safeCard.value === 'R' || safeCard.value === 'X') {
        deck.unshift(safeCard); shuffle(); safeCard = deck.pop();
    }
    discardPile = [safeCard];
    activeColor = safeCard.color;
    currentTurn = 0; pendingPenalty = 0;
    players.forEach(p => { p.hand = []; p.hasDrawn = false; p.isDead = false; p.isSpectator = false; for (let i = 0; i < 7; i++) drawCards(players.indexOf(p), 1); });
    io.emit('countdownTick', 3);
    countdownInterval = setInterval(() => {
        if (players.length < 1) { clearInterval(countdownInterval); resetGame(); updateAll(); return; }
        io.emit('countdownTick', count); io.emit('playSound', 'soft');
        if (count <= 0) { clearInterval(countdownInterval); gameState = 'playing'; io.emit('playSound', 'start'); updateAll(); } count--;
    }, 1000);
}

function drawCards(pid, n) { 
    if (pid < 0 || pid >= players.length) return; 
    for (let i = 0; i < n; i++) { 
        if (deck.length === 0) recycleDeck(); 
        if (deck.length > 0) players[pid].hand.push(deck.pop()); 
    } 
}

function advanceTurn() {
    if (players[currentTurn]) players[currentTurn].hasDrawn = false;
    let attempts = 0; let aliveCount = getAlivePlayersCount();
    if (aliveCount < 2 && gameState === 'playing' && players.length > 1) return;
    do { 
        currentTurn = (currentTurn + direction + players.length) % players.length; 
        attempts++; 
    } while (players[currentTurn].isDead && attempts < players.length * 2);
}

function getNextPlayerIndex() {
    let next = currentTurn; let attempts = 0;
    do { next = (next + direction + players.length) % players.length; attempts++; } while (players[next].isDead && attempts < players.length * 2);
    return next;
}

function finishRound(w) {
    gameState = 'waiting';
    const res = players.map(p => ({ name: p.name + (p.isDead ? "(💀)" : ""), points: p.isDead ? 0 : calculateHandPoints(p.hand), winner: p.id === w.id }));
    if (res.find(r => r.winner)) { res.find(r => r.winner).points = res.reduce((a, b) => a + b.points, 0); }
    io.emit('gameOver', { winner: w.name, results: res }); io.emit('playSound', 'win');
}

function updateAll() {
    const duelInfo = (gameState === 'dueling' || gameState === 'rip_decision') ? {
        attackerName: duelState.attackerName, defenderName: duelState.defenderName, round: duelState.round, scoreAttacker: duelState.scoreAttacker, scoreDefender: duelState.scoreDefender, history: duelState.history, attackerId: duelState.attackerId, defenderId: duelState.defenderId, myChoice: null
    } : null;
    const pack = {
        state: gameState, 
        // MODIFICACIÓN: Pasamos flag isAdmin al cliente
        players: players.map((p, i) => ({ 
            name: p.name + (p.isAdmin ? " 👑" : ""), // Visual simple en el nombre
            cardCount: p.hand.length, 
            id: p.id, 
            isTurn: (gameState === 'playing' && i === currentTurn), 
            hasDrawn: p.hasDrawn, 
            isDead: p.isDead, 
            isSpectator: p.isSpectator,
            isAdmin: p.isAdmin 
        })),
        topCard: discardPile.length > 0 ? discardPile[discardPile.length - 1] : null, activeColor, currentTurn, duelInfo, pendingPenalty
    };
    players.forEach(p => {
        const mp = JSON.parse(JSON.stringify(pack));
        // Flag especial para el cliente: ¿Soy Admin?
        mp.iamAdmin = p.isAdmin;
        if (mp.duelInfo) {
            if (p.id === duelState.attackerId) mp.duelInfo.myChoice = duelState.attackerChoice;
            if (p.id === duelState.defenderId) mp.duelInfo.myChoice = duelState.defenderChoice;
        }
        io.to(p.id).emit('updateState', mp); if (!p.isSpectator || p.isDead) io.to(p.id).emit('handUpdate', p.hand);
    });
}

// --- CLIENTE VISUAL NUCLEAR (VERSIÓN ORIGINAL RESTAURADA + GESTIÓN SALA) ---
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
    <title>UNO y 1/2</title>
    <style>
        * { box-sizing: border-box; }
        :root { --app-height: 100dvh; --safe-bottom: env(safe-area-inset-bottom, 20px); }
        body { margin: 0; padding: 0; font-family: 'Segoe UI', sans-serif; background: #1e272e; color: white; overflow: hidden; height: var(--app-height); display: flex; flex-direction: column; user-select: none; transition: background 0.5s; }
        .screen { display: none; width: 100%; height: 100%; position: absolute; top: 0; left: 0; flex-direction: column; justify-content: center; align-items: center; z-index: 10; }
        
        #game-area { display: none; flex-direction: column; height: 100%; width: 100%; position: relative; z-index: 5; padding-bottom: calc(200px + var(--safe-bottom)); }
        #players-zone { flex: 0 0 auto; padding: 10px; background: rgba(0,0,0,0.5); display: flex; flex-wrap: wrap; justify-content: center; gap: 5px; z-index: 20; }
        .player-badge { background: #333; color: white; padding: 5px 12px; border-radius: 20px; font-size: 13px; border: 1px solid #555; transition: all 0.3s; }
        .is-turn { background: #2ecc71; color: black; font-weight: bold; border: 2px solid white; transform: scale(1.1); box-shadow: 0 0 10px #2ecc71; }
        .is-dead { text-decoration: line-through; opacity: 0.6; }

        #alert-zone { flex: 0 1 auto; display: flex; flex-direction: column; justify-content: center; align-items: center; min-height: 50px; pointer-events: none; margin-top: 10px; }
        .alert-box { background: rgba(0,0,0,0.95); border: 2px solid gold; color: white; padding: 15px; border-radius: 10px; text-align: center; font-weight: bold; font-size: 18px; box-shadow: 0 5px 20px rgba(0,0,0,0.8); animation: pop 0.3s ease-out; max-width: 90%; display: none; margin-bottom: 10px; pointer-events: auto; }
        #penalty-display { font-size: 30px; color: #ff4757; text-shadow: 0 0 5px red; display: none; margin-bottom: 10px; background: rgba(0,0,0,0.8); padding: 10px; border-radius: 10px; border: 1px solid red; }

        #table-zone { flex: 1; display: flex; flex-direction: column; justify-content: center; align-items: center; gap: 15px; z-index: 15; position: relative; }
        #decks-container { display: flex; gap: 30px; transform: scale(1.1); }
        .card-pile { width: 70px; height: 100px; border-radius: 8px; border: 3px solid white; display: flex; justify-content: center; align-items: center; font-size: 24px; box-shadow: 0 5px 10px rgba(0,0,0,0.5); position: relative; color: white; }
        #deck-pile { background: #e74c3c; cursor: pointer; }
        #top-card { background: #333; }
        
        #uno-btn-area { display: flex; gap: 15px; margin-top: 20px; z-index: 30; }
        .btn-uno { background: #e74c3c; color: white; border: 2px solid white; padding: 10px 25px; border-radius: 25px; font-weight: bold; cursor: pointer; font-size: 16px; box-shadow: 0 4px 0 #c0392b; }
        .btn-uno:active { transform: translateY(4px); box-shadow: none; }
        .btn-pass { background: #f39c12; color: white; border: 2px solid white; padding: 10px 25px; border-radius: 25px; font-weight: bold; cursor: pointer; display: none; box-shadow: 0 4px 0 #d35400; }

        #hand-zone { position: fixed; bottom: 0; left: 0; width: 100%; height: 180px; background: rgba(20, 20, 20, 0.95); border-top: 2px solid #555; display: flex; align-items: center; padding: 10px 20px; padding-bottom: calc(10px + var(--safe-bottom)); gap: 15px; overflow-x: auto; overflow-y: hidden; white-space: nowrap; scroll-snap-type: x mandatory; -webkit-overflow-scrolling: touch; z-index: 99999 !important; }
        .hand-card { flex: 0 0 85px; height: 130px; border-radius: 8px; border: 2px solid white; background: #444; display: flex; justify-content: center; align-items: center; font-size: 32px; font-weight: 900; color: white; text-shadow: 2px 2px 0 #000; scroll-snap-align: center; position: relative; cursor: pointer; box-shadow: 0 4px 8px rgba(0,0,0,0.6); user-select: none; z-index: 1; }
        .hand-card:active { transform: scale(0.95); }

        body.bg-rojo { background-color: #4a1c1c !important; } 
        body.bg-azul { background-color: #1c2a4a !important; } 
        body.bg-verde { background-color: #1c4a2a !important; } 
        body.bg-amarillo { background-color: #4a451c !important; }

        #login, #lobby { background: #2c3e50; z-index: 2000; }
        #rip-screen { background: rgba(50,0,0,0.98); z-index: 3000; }
        #duel-screen { background: rgba(0,0,0,0.98); z-index: 3000; }
        
        #color-picker { position: fixed; top: 40%; left: 50%; transform: translate(-50%,-50%); background: white; padding: 20px; border-radius: 10px; z-index: 4000; display: none; text-align: center; box-shadow: 0 0 50px black; }
        .color-circle { width: 60px; height: 60px; border-radius: 50%; display: inline-block; margin: 10px; cursor: pointer; border: 3px solid #ddd; }

        #chat-btn { position: fixed; bottom: 200px; right: 20px; width: 50px; height: 50px; background: #3498db; border-radius: 50%; display: flex; justify-content: center; align-items: center; border: 2px solid white; z-index: 5000; box-shadow: 0 4px 5px rgba(0,0,0,0.3); font-size: 24px; cursor: pointer; }
        #chat-win { position: fixed; bottom: 260px; right: 20px; width: 280px; height: 200px; background: rgba(0,0,0,0.9); border: 1px solid #666; display: none; flex-direction: column; z-index: 5000; border-radius: 10px; }
        @keyframes pop { 0% { transform: scale(0.8); opacity:0; } 100% { transform: scale(1); opacity:1; } }
    </style>
</head>
<body>
    <div id="login" class="screen" style="display:flex;">
        <h1 style="font-size:60px; margin:0;">UNO 1/2</h1>
        <p>Host Edition</p>
        <input id="user-in" type="text" placeholder="Tu Nombre" style="padding:15px; font-size:20px; text-align:center; width:80%; max-width:300px; border-radius:30px; border:none; margin:20px 0;">
        <button onclick="join()" style="padding:15px 40px; background:#27ae60; color:white; border:none; border-radius:30px; font-size:20px; cursor:pointer;">Jugar</button>
    </div>

    <div id="lobby" class="screen">
        <h1>Sala de Espera</h1>
        <p id="host-msg" style="color:gold; display:none;">¡Eres el Anfitrión! Inicia cuando estén todos.</p>
        <div id="lobby-users" style="font-size:20px; margin-bottom:20px;"></div>
        <button id="start-btn" onclick="start()" style="display:none; padding:15px 40px; background:#e67e22; color:white; border:none; border-radius:30px; font-size:20px; cursor:pointer;">EMPEZAR</button>
        <p id="wait-msg" style="display:none;">Esperando al Anfitrión...</p>
    </div>

    <div id="game-area">
        <div id="players-zone"></div>
        <div id="alert-zone">
            <div id="penalty-display">CASTIGO: +<span id="pen-num">0</span></div>
            <div id="main-alert" class="alert-box"></div>
        </div>
        <div id="table-zone">
            <div id="decks-container">
                <div id="deck-pile" class="card-pile" onclick="draw()">📦</div>
                <div id="top-card" class="card-pile"></div>
            </div>
            <div id="uno-btn-area">
                <button id="btn-pass" class="btn-pass" onclick="pass()">PASAR</button>
                <button class="btn-uno" onclick="uno()">¡UNO y 1/2!</button>
            </div>
        </div>
    </div>

    <div id="hand-zone"></div>

    <div id="chat-btn" onclick="toggleChat()">💬</div>
    <div id="chat-win">
        <div id="chat-msgs" style="flex:1; overflow-y:auto; padding:10px; font-size:12px; color:#ddd;"></div>
        <input id="chat-in" style="width:100%; padding:10px; border:none; background:#333; color:white;" placeholder="Mensaje..." onkeypress="if(event.key==='Enter') sendChat()">
    </div>

    <div id="rip-screen" class="screen">
        <h1 style="color:red; font-size:50px;">💀 RIP 💀</h1>
        <p>Defiéndete o muere</p>
        <button onclick="ripResp('duel')" style="padding:20px; background:red; border:3px solid gold; color:white; font-size:18px; margin:10px; border-radius:10px;">⚔️ ACEPTAR DUELO</button>
        <button onclick="ripResp('surrender')" style="padding:15px; background:#444; border:1px solid white; color:white; margin:10px; border-radius:10px;">🏳️ Rendirse</button>
        <div id="grace-btn" style="display:none; margin-top:20px;">
            <button onclick="graceDef()" style="padding:20px; background:white; color:red; border:3px solid gold; font-weight:bold; border-radius:10px;">❤️ USAR MILAGRO</button>
        </div>
    </div>

    <div id="duel-screen" class="screen">
        <h1 style="color:gold;">⚔️ DUELO ⚔️</h1>
        <h2 id="duel-names">... vs ...</h2>
        <h3 id="duel-sc">0 - 0</h3>
        <div id="duel-opts" style="margin-top:20px;">
            <button onclick="pick('fuego')" style="font-size:40px; background:none; border:none; cursor:pointer;">🔥</button>
            <button onclick="pick('hielo')" style="font-size:40px; background:none; border:none; cursor:pointer;">❄️</button>
            <button onclick="pick('agua')" style="font-size:40px; background:none; border:none; cursor:pointer;">💧</button>
        </div>
        <div id="duel-info" style="margin-top:20px; color:#aaa;"></div>
    </div>

    <div id="color-picker">
        <h3>Elige Color</h3>
        <div class="color-circle" style="background:#ff5252;" onclick="pickCol('rojo')"></div>
        <div class="color-circle" style="background:#448aff;" onclick="pickCol('azul')"></div>
        <div class="color-circle" style="background:#69f0ae;" onclick="pickCol('verde')"></div>
        <div class="color-circle" style="background:#ffd740;" onclick="pickCol('amarillo')"></div>
    </div>

    <div id="countdown" style="display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.8); z-index:6000; justify-content:center; align-items:center; font-size:120px; color:gold;">3</div>

    <script src="/socket.io/socket.io.js"></script>
    <script>
        const socket = io();
        let myId = ''; let pendingCard = null; let pendingGrace = false;
        
        const colorMap = { 'rojo': '#ff5252', 'azul': '#448aff', 'verde': '#69f0ae', 'amarillo': '#ffd740', 'negro': '#212121', 'death-card': '#000000', 'divine-card': '#ffffff', 'mega-wild': '#4a148c' };
        const sounds = { soft: 'https://cdn.freesound.org/previews/240/240776_4107740-lq.mp3', attack: 'https://cdn.freesound.org/previews/155/155235_2452367-lq.mp3', rip: 'https://cdn.freesound.org/previews/173/173930_2394245-lq.mp3', divine: 'https://cdn.freesound.org/previews/242/242501_4414128-lq.mp3', uno: 'https://cdn.freesound.org/previews/415/415209_5121236-lq.mp3', start: 'https://cdn.freesound.org/previews/320/320655_5260872-lq.mp3', win: 'https://cdn.freesound.org/previews/270/270402_5123851-lq.mp3', bell: 'https://cdn.freesound.org/previews/336/336899_4939433-lq.mp3', saff: 'https://cdn.freesound.org/previews/614/614742_11430489-lq.mp3', wild: 'https://cdn.freesound.org/previews/320/320653_5260872-lq.mp3', thunder: 'https://cdn.freesound.org/previews/173/173930_2394245-lq.mp3' };
        const audio = {}; Object.keys(sounds).forEach(k => { audio[k] = new Audio(sounds[k]); audio[k].volume = 0.3; });
        function play(k) { if(audio[k]) { audio[k].currentTime=0; audio[k].play().catch(()=>{}); } }

        function join() { socket.emit('join', document.getElementById('user-in').value); play('soft'); }
        function start() { socket.emit('requestStart'); }
        function draw() { socket.emit('draw'); }
        function pass() { socket.emit('passTurn'); }
        function uno() { socket.emit('sayUno'); }
        function sendChat() { const i=document.getElementById('chat-in'); if(i.value){socket.emit('sendChat',i.value);i.value='';} }
        function toggleChat() { const w=document.getElementById('chat-win'); w.style.display=w.style.display==='flex'?'none':'flex'; }
        
        document.getElementById('hand-zone').addEventListener('wheel', e => { e.preventDefault(); document.getElementById('hand-zone').scrollLeft += e.deltaY; });

        function pickCol(c) { 
            document.getElementById('color-picker').style.display='none'; 
            if(pendingGrace) { socket.emit('playGraceDefense', c); pendingGrace=false; }
            else { socket.emit('playCard', pendingCard, c); pendingCard=null; }
        }
        function ripResp(d) { socket.emit('ripDecision', d); }
        function pick(c) { socket.emit('duelPick', c); }
        function graceDef() { pendingGrace=true; document.getElementById('color-picker').style.display='block'; }

        socket.on('connect', () => myId = socket.id);
        socket.on('playSound', k => play(k));
        socket.on('notification', m => {
            const el = document.getElementById('main-alert');
            el.innerText = m; el.style.display = 'block';
            setTimeout(() => el.style.display='none', 3000);
        });

        socket.on('showDivine', m => {
            const el = document.getElementById('main-alert');
            el.innerText = m; el.style.display='block'; el.style.background='white'; el.style.color='gold';
            setTimeout(() => { el.style.display='none'; el.style.background='rgba(0,0,0,0.95)'; el.style.color='white'; }, 4000);
        });

        socket.on('chatMessage', m => {
            const b = document.getElementById('chat-msgs');
            b.innerHTML += \`<div><b style="color:gold">\${m.name}:</b> \${m.text}</div>\`;
            b.scrollTop = b.scrollHeight;
        });
        
        // RECUPERAR HISTORIAL
        socket.on('chatHistory', h => {
             const b = document.getElementById('chat-msgs');
             b.innerHTML = '';
             h.forEach(m => b.innerHTML += \`<div><b style="color:gold">\${m.name}:</b> \${m.text}</div>\`);
             b.scrollTop = b.scrollHeight;
        });

        socket.on('countdownTick', n => {
            document.getElementById('lobby').style.display='none';
            document.getElementById('game-area').style.display='flex';
            document.getElementById('hand-zone').style.display='flex';
            const c = document.getElementById('countdown');
            c.style.display='flex'; c.innerText=n;
            if(n<=0) c.style.display='none';
        });

        socket.on('updateState', s => {
            document.getElementById('login').style.display='none';
            document.getElementById('lobby').style.display = s.state==='waiting' ? 'flex' : 'none';
            document.getElementById('rip-screen').style.display = 'none';
            document.getElementById('duel-screen').style.display = s.state==='dueling' ? 'flex' : 'none';
            
            if(s.state === 'waiting') {
                document.getElementById('lobby-users').innerHTML = s.players.map(p=>\`<div>\${p.name}</div>\`).join('');
                // GESTIÓN SALA: Botón solo para ADMIN
                if (s.iamAdmin) {
                     document.getElementById('start-btn').style.display = 'block';
                     document.getElementById('host-msg').style.display = 'block';
                     document.getElementById('wait-msg').style.display = 'none';
                } else {
                     document.getElementById('start-btn').style.display = 'none';
                     document.getElementById('host-msg').style.display = 'none';
                     document.getElementById('wait-msg').style.display = 'block';
                }
                document.getElementById('hand-zone').style.display='none';
                return;
            }

            document.getElementById('game-area').style.display='flex';
            document.getElementById('hand-zone').style.display='flex';
            document.body.className = s.activeColor ? 'bg-'+s.activeColor : '';

            const top = s.topCard;
            const tEl = document.getElementById('top-card');
            if(top) {
                tEl.className = 'card-pile';
                let bg = colorMap[top.color] || '#444';
                let txt = 'white';
                let border = '3px solid white';
                
                if(s.activeColor && top.color !== 'negro') bg = colorMap[top.color];
                else if(s.activeColor && top.color === 'negro') bg = colorMap[s.activeColor];

                if(top.value==='RIP') { bg = 'black'; txt = 'red'; border = '3px solid #666'; }
                else if(top.value==='GRACIA') { bg = 'white'; txt = 'red'; border = '3px solid gold'; }
                else if(top.value==='+12') { bg = '#4a148c'; border = '3px solid #ea80fc'; }
                else if(top.color === 'amarillo' || top.color === 'verde') txt = 'black';

                tEl.style.backgroundColor = bg; tEl.style.color = txt; tEl.style.border = border;
                tEl.innerText = (top.value==='RIP'?'🪦':(top.value==='GRACIA'?'❤️':top.value));
            }

            document.getElementById('players-zone').innerHTML = s.players.map(p => 
                \`<div class="player-badge \${p.isTurn?'is-turn':''} \${p.isDead?'is-dead':''}">\${p.name} (\${p.cardCount})</div>\`
            ).join('');

            const me = s.players.find(p=>p.id===myId);
            document.getElementById('btn-pass').style.display = (me && me.isTurn && me.hasDrawn && s.pendingPenalty===0) ? 'inline-block' : 'none';
            
            const penEl = document.getElementById('penalty-display');
            if(me && me.isTurn && s.pendingPenalty>0) {
                penEl.style.display='block'; document.getElementById('pen-num').innerText=s.pendingPenalty;
            } else penEl.style.display='none';

            if(s.state === 'rip_decision') {
                if(s.duelInfo.defenderId === myId) document.getElementById('rip-screen').style.display='flex';
                else { const al = document.getElementById('main-alert'); al.innerText = "⏳ Esperando Duelo..."; al.style.display = 'block'; }
            }

            if(s.state === 'dueling') {
                document.getElementById('duel-names').innerText = \`\${s.duelInfo.attackerName} vs \${s.duelInfo.defenderName}\`;
                document.getElementById('duel-sc').innerText = \`\${s.duelInfo.scoreAttacker} - \${s.duelInfo.scoreDefender}\`;
                document.getElementById('duel-info').innerHTML = s.duelInfo.history.map(h=>\`<div>Gana: \${h.winnerName}</div>\`).join('');
                const amIFighter = (myId === s.duelInfo.attackerId || myId === s.duelInfo.defenderId);
                document.getElementById('duel-opts').style.display = amIFighter ? 'block' : 'none';
            }
        });

        socket.on('handUpdate', h => {
            const hz = document.getElementById('hand-zone');
            hz.innerHTML = '';
            const hasGrace = h.some(c=>c.value==='GRACIA');
            document.getElementById('grace-btn').style.display = hasGrace ? 'block':'none';

            h.forEach(c => {
                const d = document.createElement('div');
                d.className = 'hand-card';
                let bg = colorMap[c.color] || '#444'; let txt = 'white'; let border = '2px solid white';

                if(c.value==='RIP') { bg = 'black'; txt = 'red'; border = '3px solid #666'; }
                else if(c.value==='GRACIA') { bg = 'white'; txt = 'red'; border = '3px solid gold'; }
                else if(c.value==='+12') { bg = '#4a148c'; border = '3px solid #ea80fc'; }
                else if(c.color === 'amarillo' || c.color === 'verde') { txt = 'black'; }

                d.style.backgroundColor = bg; d.style.color = txt; d.style.border = border;
                d.innerText = (c.value==='RIP'?'🪦':(c.value==='GRACIA'?'❤️':c.value));
                d.onclick = () => {
                     if(c.color==='negro' && c.value!=='GRACIA') {
                        if(c.value==='RIP') socket.emit('playCard', c.id, null);
                        else { pendingCard=c.id; document.getElementById('color-picker').style.display='block'; }
                     } else socket.emit('playCard', c.id, null);
                };
                hz.appendChild(d);
            });
        });
    </script>
</body>
</html>
    `);
});

http.listen(process.env.PORT || 3000, () => console.log('SERVER LISTO'));
