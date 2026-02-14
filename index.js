const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

// --- ESTRUCTURA DE DATOS GLOBAL ---
const rooms = {}; 

// GARBAGE COLLECTOR: Limpieza de salas (1 hora)
setInterval(() => {
    const now = Date.now();
    Object.keys(rooms).forEach(roomId => {
        if (now - rooms[roomId].lastActivity > 3600000) { 
            console.log(`🧹 Limpiando sala inactiva: ${roomId}`);
            delete rooms[roomId];
        }
    });
}, 60000 * 5); 

const colors = ['rojo', 'azul', 'verde', 'amarillo'];
const values = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '1 y 1/2', '+2', 'X', 'R'];

// --- FUNCIONES CORE ---

function initRoom(roomId) {
    rooms[roomId] = {
        gameState: 'waiting',
        players: [],
        deck: [],
        discardPile: [],
        currentTurn: 0,
        direction: 1,
        activeColor: '',
        pendingPenalty: 0,
        countdownInterval: null,
        duelState: { 
            attackerId: null, defenderId: null, attackerName: '', defenderName: '', 
            round: 1, scoreAttacker: 0, scoreDefender: 0, 
            attackerChoice: null, defenderChoice: null, history: [], turn: null 
        },
        chatHistory: [],
        lastActivity: Date.now()
    };
}

function touchRoom(roomId) {
    if (rooms[roomId]) rooms[roomId].lastActivity = Date.now();
}

function createDeck(roomId) {
    const room = rooms[roomId];
    if(!room) return;
    
    room.deck = [];
    colors.forEach(color => {
        values.forEach(val => {
            room.deck.push({ color, value: val, type: 'normal', id: Math.random().toString(36) });
            if (val !== '0') room.deck.push({ color, value: val, type: 'normal', id: Math.random().toString(36) });
        });
    });
    for (let i = 0; i < 4; i++) {
        room.deck.push({ color: 'negro', value: 'color', type: 'wild', id: Math.random().toString(36) });
        room.deck.push({ color: 'negro', value: '+4', type: 'wild', id: Math.random().toString(36) });
    }
    room.deck.push({ color: 'negro', value: 'RIP', type: 'death', id: Math.random().toString(36) });
    room.deck.push({ color: 'negro', value: 'RIP', type: 'death', id: Math.random().toString(36) });
    room.deck.push({ color: 'negro', value: 'GRACIA', type: 'divine', id: Math.random().toString(36) });
    room.deck.push({ color: 'negro', value: 'GRACIA', type: 'divine', id: Math.random().toString(36) });
    room.deck.push({ color: 'negro', value: '+12', type: 'wild', id: Math.random().toString(36) });
    room.deck.push({ color: 'negro', value: '+12', type: 'wild', id: Math.random().toString(36) });
    
    // Shuffle
    for (let i = room.deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [room.deck[i], room.deck[j]] = [room.deck[j], room.deck[i]];
    }
}

function recycleDeck(roomId) {
    const room = rooms[roomId];
    if(!room) return;
    
    if (room.discardPile.length <= 1) { 
        createDeck(roomId); 
        io.to(roomId).emit('notification', '⚠️ Mazo regenerado.');
        return; 
    }
    const topCard = room.discardPile.pop();
    room.deck = [...room.discardPile];
    room.discardPile = [topCard];
    
    // Shuffle
    for (let i = room.deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [room.deck[i], room.deck[j]] = [room.deck[j], room.deck[i]];
    }
    io.to(roomId).emit('notification', '♻️ Barajando descartes...');
}

// --- SOCKETS ---

io.on('connection', (socket) => {
    
    socket.on('checkSession', (uuid) => {
        let foundRoomId = null;
        let foundPlayer = null;
        for (const rId in rooms) {
            const p = rooms[rId].players.find(pl => pl.uuid === uuid);
            if (p) { foundRoomId = rId; foundPlayer = p; break; }
        }
        if (foundRoomId && foundPlayer) {
            foundPlayer.id = socket.id; foundPlayer.isConnected = true;
            socket.join(foundRoomId); touchRoom(foundRoomId);
            socket.emit('sessionRestored', { roomId: foundRoomId, name: foundPlayer.name });
            updateAll(foundRoomId);
        } else { socket.emit('requireLogin'); }
    });

    socket.on('createRoom', (data) => {
        const name = data.name.substring(0, 15); const uuid = data.uuid;
        const roomId = Math.random().toString(36).substring(2, 6).toUpperCase();
        initRoom(roomId);
        const player = { id: socket.id, uuid, name, hand: [], hasDrawn: false, isSpectator: false, isDead: false, isAdmin: true, isConnected: true };
        rooms[roomId].players.push(player);
        socket.join(roomId); socket.emit('roomCreated', { roomId, name });
        updateAll(roomId);
    });

    socket.on('joinRoom', (data) => {
        const name = data.name.substring(0, 15); const roomId = data.roomId.toUpperCase(); const uuid = data.uuid;
        if (!rooms[roomId]) { socket.emit('error', 'Sala no encontrada o expirada.'); return; }
        const room = rooms[roomId]; touchRoom(roomId);
        const existingPlayer = room.players.find(p => p.uuid === uuid);
        if (existingPlayer) {
            existingPlayer.id = socket.id; existingPlayer.name = name; existingPlayer.isConnected = true;
            socket.join(roomId); socket.emit('roomJoined', { roomId });
        } else {
            const isGameRunning = room.gameState !== 'waiting' && room.gameState !== 'counting';
            const player = { id: socket.id, uuid, name, hand: [], hasDrawn: false, isSpectator: isGameRunning, isDead: false, isAdmin: (room.players.length === 0), isConnected: true };
            room.players.push(player);
            socket.join(roomId); socket.emit('roomJoined', { roomId });
            io.to(roomId).emit('notification', `👋 ${player.name} entró.`);
        }
        updateAll(roomId);
    });

    socket.on('kickPlayer', (targetId) => {
        const roomId = getRoomId(socket); if(!roomId || !rooms[roomId]) return; const room = rooms[roomId];
        if (room.gameState !== 'waiting') return;
        const requestor = room.players.find(p => p.id === socket.id);
        if (!requestor || !requestor.isAdmin) return;
        if (requestor.id === targetId) return;
        const targetIndex = room.players.findIndex(p => p.id === targetId);
        if (targetIndex !== -1) {
            const targetName = room.players[targetIndex].name;
            io.to(targetId).emit('kicked');
            room.players.splice(targetIndex, 1);
            io.to(roomId).emit('notification', `🚫 ${targetName} fue expulsado.`);
            updateAll(roomId);
        }
    });

    socket.on('requestStart', () => {
        const roomId = getRoomId(socket); if(!roomId || !rooms[roomId]) return; touchRoom(roomId);
        const room = rooms[roomId]; const p = room.players.find(p => p.id === socket.id);
        if (p && p.isAdmin && room.gameState === 'waiting') {
            if (room.players.length < 2) { socket.emit('notification', '⚠️ Mínimo 2 jugadores.'); return; }
            startCountdown(roomId);
        }
    });

    // MODIFICADO: Acepta un tercer argumento 'reviveTargetId'
    socket.on('playCard', (cardId, chosenColor, reviveTargetId) => {
        const roomId = getRoomId(socket); if(!roomId || !rooms[roomId]) return; touchRoom(roomId);
        const room = rooms[roomId];
        if (room.gameState !== 'playing') return;
        
        const pIndex = room.players.findIndex(p => p.id === socket.id); if (pIndex === -1) return;
        const player = room.players[pIndex];
        if (player.isDead || player.isSpectator) return;

        const cardIndex = player.hand.findIndex(c => c.id === cardId); if (cardIndex === -1) return;
        const card = player.hand[cardIndex];
        const top = room.discardPile[room.discardPile.length - 1];

        // CHECK VICTORIA
        if (player.hand.length === 1) {
            const isStrictNumber = /^[0-9]$/.test(card.value);
            const isUnoYMedio = card.value === '1 y 1/2';
            const isGracia = card.value === 'GRACIA';
            if (!isStrictNumber && !isUnoYMedio && !isGracia) { socket.emit('notification', '🚫 Última carta: Solo Números o Gracia.'); return; }
        }

        if (top.color !== 'negro') room.activeColor = top.color;

        // SAFF logic
        let isSaff = false;
        if (pIndex !== room.currentTurn) {
            const isNumericSaff = /^[0-9]$/.test(card.value) || card.value === '1 y 1/2';
            if (isNumericSaff && card.color !== 'negro' && card.value === top.value && card.color === top.color) {
                isSaff = true; room.currentTurn = pIndex; room.pendingPenalty = 0;
                io.to(roomId).emit('notification', `⚡ ¡${player.name} hizo SAFF!`); io.to(roomId).emit('playSound', 'saff');
            } else { return; }
        }

        if (pIndex === room.currentTurn && !isSaff) {
            if (room.pendingPenalty > 0) {
                let allowed = false;
                if (card.value === '+12' || card.value === '+4' || card.value === 'GRACIA') allowed = true;
                else if (top.value === '+2' && card.value === '+2') allowed = true;
                if (!allowed) { socket.emit('notification', `🚫 Debes responder al +${room.pendingPenalty} o robar.`); return; }
            } else {
                let valid = false;
                if (card.color === 'negro') valid = true;
                else if (card.value === 'GRACIA') valid = true;
                else if (card.color === room.activeColor) valid = true;
                else if (card.value === top.value) valid = true;
                if (!valid) { socket.emit('notification', `❌ Carta inválida.`); return; }
            }
        }

        // --- LÓGICA GRACIA DIVINA CON SELECTOR ---
        if (card.value === 'GRACIA') {
            const deadPlayers = room.players.filter(p => p.isDead);

            // PRIORIDAD 1: SALVARSE DEL CASTIGO
            if (room.pendingPenalty > 0) {
                player.hand.splice(cardIndex, 1); room.discardPile.push(card); 
                io.to(roomId).emit('playSound', 'divine');
                if (chosenColor) room.activeColor = chosenColor; else if (!room.activeColor) room.activeColor = 'rojo';
                io.to(roomId).emit('showDivine', `${player.name} anuló el castigo`); 
                room.pendingPenalty = 0;
                if (player.hand.length === 0) { finishRound(roomId, player); return; }
                advanceTurn(roomId, 1); updateAll(roomId); return;
            }

            // PRIORIDAD 2: ELEGIR A QUIÉN REVIVIR
            if (deadPlayers.length > 0) {
                // Si NO mandaron targetID, pedimos al cliente que elija
                if (!reviveTargetId) {
                    // Enviamos lista de zombies (Nombre y Cantidad de cartas)
                    const zombieList = deadPlayers.map(z => ({ id: z.id, name: z.name, count: z.hand.length }));
                    socket.emit('askReviveTarget', zombieList); 
                    return; // PAUSA: Esperamos que el cliente responda con la elección
                } else {
                    // Si ya mandaron targetID, ejecutamos
                    const target = room.players.find(p => p.id === reviveTargetId && p.isDead);
                    if (target) {
                        target.isDead = false; target.isSpectator = false;
                        io.to(roomId).emit('showDivine', `¡MILAGRO! ${target.name} fue revivido por ${player.name}`);
                    }
                }
            } else {
                // PRIORIDAD 3: SOLO COLOR
                io.to(roomId).emit('notification', `❤️ ${player.name} usó Gracia.`); 
            }

            // Ejecución común (si no hubo return antes)
            player.hand.splice(cardIndex, 1); room.discardPile.push(card); 
            io.to(roomId).emit('playSound', 'divine');
            if (chosenColor) room.activeColor = chosenColor; else if (!room.activeColor) room.activeColor = 'rojo';
            
            if (player.hand.length === 0) { finishRound(roomId, player); return; }
            advanceTurn(roomId, 1); updateAll(roomId); return;
        }

        // --- LÓGICA RIP ---
        if (card.value === 'RIP') {
            if (room.pendingPenalty > 0) { socket.emit('notification', '🚫 RIP no sirve para evitar castigos.'); return; }
            const isTopNumeric = /^[0-9]$/.test(top.value) || top.value === '1 y 1/2';
            if (!isTopNumeric) { socket.emit('notification', '🚫 RIP solo se puede jugar sobre Números.'); return; }
            if (getAlivePlayersCount(roomId) < 2) {
                player.hand.splice(cardIndex, 1); room.discardPile.push(card);
                io.to(roomId).emit('notification', '💀 RIP fallido.');
                advanceTurn(roomId, 1); updateAll(roomId); return;
            }
            player.hand.splice(cardIndex, 1); room.discardPile.push(card); io.to(roomId).emit('playSound', 'rip');
            room.gameState = 'rip_decision';
            const attacker = player; const victimIdx = getNextPlayerIndex(roomId, 1); const defender = room.players[victimIdx];
            room.duelState = { attackerId: attacker.id, defenderId: defender.id, attackerName: attacker.name, defenderName: defender.name, round: 1, scoreAttacker: 0, scoreDefender: 0, attackerChoice: null, defenderChoice: null, history: [], turn: attacker.id };
            io.to(roomId).emit('notification', `💀 ¡${attacker.name} RIP a ${defender.name}!`);
            updateAll(roomId); return;
        }

        player.hand.splice(cardIndex, 1); room.discardPile.push(card);
        io.to(roomId).emit('cardPlayedEffect', { color: card.color });
        if (card.color === 'negro' && chosenColor) room.activeColor = chosenColor; else if (card.color !== 'negro') room.activeColor = card.color;

        let steps = 1;
        if (card.value === 'R') { if (getAlivePlayersCount(roomId) === 2) steps = 2; else room.direction *= -1; }
        if (card.value === 'X') steps = 2;
        if (['+2', '+4', '+12'].includes(card.value)) {
            const val = parseInt(card.value.replace('+','')); room.pendingPenalty += val;
            io.to(roomId).emit('notification', `💥 ¡+${val}! Total: ${room.pendingPenalty}`); io.to(roomId).emit('playSound', 'attack');
            if (val > 4) io.to(roomId).emit('shakeScreen');
            advanceTurn(roomId, 1); updateAll(roomId); return; 
        }

        if (card.color === 'negro') io.to(roomId).emit('playSound', 'wild'); else io.to(roomId).emit('playSound', 'soft');
        if (player.hand.length === 0) finishRound(roomId, player);
        else { advanceTurn(roomId, steps); updateAll(roomId); }
    });

    socket.on('draw', () => {
        const roomId = getRoomId(socket); if(!roomId || !rooms[roomId]) return; touchRoom(roomId);
        const room = rooms[roomId]; if (room.gameState !== 'playing') return;
        const pIndex = room.players.findIndex(p => p.id === socket.id);
        if (pIndex === -1 || room.players[pIndex].isDead || room.players[pIndex].isSpectator) return;
        if (pIndex === room.currentTurn) {
            if (room.pendingPenalty > 0) {
                drawCards(roomId, pIndex, 1); room.pendingPenalty--; io.to(roomId).emit('playSound', 'soft');
                if (room.pendingPenalty > 0) { io.to(roomId).emit('notification', `😰 Faltan: ${room.pendingPenalty}`); updateAll(roomId); } 
                else { io.to(roomId).emit('notification', `😓 Terminó castigo.`); advanceTurn(roomId, 1); updateAll(roomId); }
            } else {
                if (!room.players[pIndex].hasDrawn) { drawCards(roomId, pIndex, 1); room.players[pIndex].hasDrawn = true; io.to(roomId).emit('playSound', 'soft'); updateAll(roomId); } 
                else { socket.emit('notification', 'Ya robaste.'); }
            }
        }
    });

    socket.on('passTurn', () => {
        const roomId = getRoomId(socket); if(!roomId || !rooms[roomId]) return; touchRoom(roomId);
        const room = rooms[roomId]; if (room.gameState !== 'playing') return;
        const pIndex = room.players.findIndex(p => p.id === socket.id);
        if (pIndex === room.currentTurn && room.players[pIndex].hasDrawn && room.pendingPenalty === 0) { advanceTurn(roomId, 1); updateAll(roomId); }
    });

    socket.on('playGraceDefense', (chosenColor) => {
        const roomId = getRoomId(socket); if(!roomId || !rooms[roomId]) return; touchRoom(roomId);
        const room = rooms[roomId]; if (room.gameState !== 'rip_decision' || socket.id !== room.duelState.defenderId) return;
        const defender = room.players.find(p => p.id === socket.id);
        const cardIndex = defender.hand.findIndex(c => c.value === 'GRACIA');
        if (cardIndex !== -1) {
            defender.hand.splice(cardIndex, 1); room.discardPile.push(defender.hand[cardIndex]);
            room.activeColor = chosenColor || 'rojo';
            io.to(roomId).emit('showDivine', `${defender.name} salvado por Gracia`); io.to(roomId).emit('playSound', 'divine');
            const attIndex = room.players.findIndex(p => p.id === room.duelState.attackerId);
            drawCards(roomId, attIndex, 4); room.gameState = 'playing'; advanceTurn(roomId, 1); updateAll(roomId);
        }
    });

    socket.on('ripDecision', (d) => {
        const roomId = getRoomId(socket); if(!roomId || !rooms[roomId]) return; touchRoom(roomId);
        const room = rooms[roomId]; if (room.gameState !== 'rip_decision' || socket.id !== room.duelState.defenderId) return;
        const def = room.players.find(p => p.id === room.duelState.defenderId);
        if (d === 'surrender') { eliminatePlayer(roomId, def.id); checkWinCondition(roomId); }
        else { io.to(roomId).emit('playSound', 'bell'); room.gameState = 'dueling'; updateAll(roomId); }
    });

    socket.on('duelPick', (c) => {
        const roomId = getRoomId(socket); if(!roomId || !rooms[roomId]) return; touchRoom(roomId);
        const room = rooms[roomId]; if (room.gameState !== 'dueling') return;
        if (socket.id !== room.duelState.turn) return;
        if (socket.id === room.duelState.attackerId) { room.duelState.attackerChoice = c; room.duelState.turn = room.duelState.defenderId; } 
        else if (socket.id === room.duelState.defenderId) { room.duelState.defenderChoice = c; resolveDuelRound(roomId); return; }
        updateAll(roomId);
    });

    socket.on('sayUno', () => {
        const roomId = getRoomId(socket); if(!roomId || !rooms[roomId]) return;
        const room = rooms[roomId]; const p = room.players.find(p => p.id === socket.id);
        if (p && !p.isDead && !p.isSpectator) { io.to(roomId).emit('notification', `🚨 ¡${p.name} gritó UNO y 1/2!`); io.to(roomId).emit('playSound', 'uno'); }
    });
    
    socket.on('sendChat', (text) => { 
        const roomId = getRoomId(socket); if(!roomId || !rooms[roomId]) return;
        const room = rooms[roomId]; const p = room.players.find(x => x.id === socket.id); 
        if (p) {
            const msg = { name: p.name, text }; room.chatHistory.push(msg);
            if(room.chatHistory.length > 50) room.chatHistory.shift();
            io.to(roomId).emit('chatMessage', msg); 
        }
    });

    socket.on('disconnect', () => {
        const roomId = getRoomId(socket);
        if (roomId && rooms[roomId]) { const p = rooms[roomId].players.find(pl => pl.id === socket.id); if(p) p.isConnected = false; }
    });
});

// --- HELPERS ---
function getRoomId(socket) { return Array.from(socket.rooms).find(r => r !== socket.id); }

function startCountdown(roomId) {
    const room = rooms[roomId]; if (room.players.length < 2) return;
    room.gameState = 'counting'; let count = 3; createDeck(roomId);
    let safeCard = room.deck.pop();
    while (safeCard.color === 'negro' || safeCard.value === '+2' || safeCard.value === 'R' || safeCard.value === 'X') {
        room.deck.unshift(safeCard); 
        for (let i = room.deck.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [room.deck[i], room.deck[j]] = [room.deck[j], room.deck[i]]; }
        safeCard = room.deck.pop();
    }
    room.discardPile = [safeCard]; room.activeColor = safeCard.color; room.currentTurn = 0; room.pendingPenalty = 0;
    room.players.forEach(p => { 
        p.hand = []; p.hasDrawn = false; p.isDead = false; 
        if (!p.isSpectator) { for (let i = 0; i < 7; i++) drawCards(roomId, room.players.indexOf(p), 1); }
    });
    io.to(roomId).emit('countdownTick', 3);
    room.countdownInterval = setInterval(() => {
        if (!rooms[roomId]) return clearInterval(room.countdownInterval);
        io.to(roomId).emit('countdownTick', count); io.to(roomId).emit('playSound', 'soft');
        if (count <= 0) { clearInterval(room.countdownInterval); room.gameState = 'playing'; io.to(roomId).emit('playSound', 'start'); updateAll(roomId); } 
        count--;
    }, 1000);
}

function drawCards(roomId, pid, n) { 
    const room = rooms[roomId]; if (pid < 0 || pid >= room.players.length) return; 
    for (let i = 0; i < n; i++) { if (room.deck.length === 0) recycleDeck(roomId); if (room.deck.length > 0) room.players[pid].hand.push(room.deck.pop()); } 
}

function advanceTurn(roomId, steps) {
    const room = rooms[roomId]; if (room.players.length === 0) return;
    room.players.forEach(p => p.hasDrawn = false);
    let attempts = 0;
    while (steps > 0 && attempts < room.players.length * 2) {
        room.currentTurn = (room.currentTurn + room.direction + room.players.length) % room.players.length;
        if (!room.players[room.currentTurn].isDead && !room.players[room.currentTurn].isSpectator) { steps--; }
        attempts++;
    }
    if (room.players[room.currentTurn]) room.players[room.currentTurn].hasDrawn = false;
}

function getNextPlayerIndex(roomId, steps) {
    const room = rooms[roomId]; let next = room.currentTurn; let attempts = 0;
    while (steps > 0 && attempts < room.players.length * 2) {
        next = (next + room.direction + room.players.length) % room.players.length;
        if (!room.players[next].isDead && !room.players[next].isSpectator) steps--;
        attempts++;
    }
    return next;
}

function finishRound(roomId, w) {
    const room = rooms[roomId]; room.gameState = 'waiting';
    io.to(roomId).emit('gameOver', { winner: w.name }); io.to(roomId).emit('playSound', 'win');
    setTimeout(() => { delete rooms[roomId]; }, 5000);
}

function checkWinCondition(roomId) {
    const room = rooms[roomId];
    if (room.players.length > 1 && getAlivePlayersCount(roomId) <= 1) { const winner = room.players.find(p => !p.isDead && !p.isSpectator); if (winner) finishRound(roomId, winner); } 
    else { room.gameState = 'playing'; advanceTurn(roomId, 1); updateAll(roomId); }
}

function resolveDuelRound(roomId) {
    const room = rooms[roomId];
    const att = room.duelState.attackerChoice, def = room.duelState.defenderChoice;
    let winner = 'tie';
    if ((att == 'fuego' && def == 'hielo') || (att == 'hielo' && def == 'agua') || (att == 'agua' && def == 'fuego')) winner = 'attacker';
    else if ((def == 'fuego' && att == 'hielo') || (def == 'hielo' && att == 'agua') || (def == 'agua' && att == 'fuego')) winner = 'defender';
    
    if (winner == 'attacker') room.duelState.scoreAttacker++; else if (winner == 'defender') room.duelState.scoreDefender++;
    let winName = 'Empate'; if(winner === 'attacker') winName = room.duelState.attackerName; if(winner === 'defender') winName = room.duelState.defenderName;

    room.duelState.history.push({ round: room.duelState.round, att, def, winnerName: winName });
    room.duelState.attackerChoice = null; room.duelState.defenderChoice = null; room.duelState.turn = room.duelState.attackerId; 

    io.to(roomId).emit('playSound', 'soft');
    if (room.duelState.round >= 3 || room.duelState.scoreAttacker >= 2 || room.duelState.scoreDefender >= 2) { setTimeout(() => finalizeDuel(roomId), 2000); } 
    else { room.duelState.round++; updateAll(roomId); }
}

function finalizeDuel(roomId) {
    const room = rooms[roomId];
    const att = room.players.find(p => p.id === room.duelState.attackerId); const def = room.players.find(p => p.id === room.duelState.defenderId);
    if (!att || !def) { room.gameState = 'playing'; updateAll(roomId); return; }
    
    if (room.duelState.scoreAttacker > room.duelState.scoreDefender) { 
        io.to(roomId).emit('notification', `💀 ${att.name} GANA.`); eliminatePlayer(roomId, def.id); checkWinCondition(roomId); 
    }
    else if (room.duelState.scoreDefender > room.duelState.scoreAttacker) { 
        io.to(roomId).emit('notification', `🛡️ ${def.name} GANA. Castigo atacante.`); drawCards(roomId, room.players.findIndex(p => p.id === room.duelState.attackerId), 4); room.gameState = 'playing'; advanceTurn(roomId, 1); updateAll(roomId); 
    }
    else { io.to(roomId).emit('notification', `🤝 EMPATE.`); room.gameState = 'playing'; advanceTurn(roomId, 1); updateAll(roomId); }
}

function eliminatePlayer(roomId, id) { const room = rooms[roomId]; const p = room.players.find(p => p.id === id); if (p) { p.isDead = true; p.isSpectator = true; } }
function getAlivePlayersCount(roomId) { return rooms[roomId].players.filter(p => !p.isDead && !p.isSpectator).length; }

function updateAll(roomId) {
    const room = rooms[roomId]; if(!room) return;
    let lastRoundWinner = ""; if (room.duelState.history.length > 0) { lastRoundWinner = room.duelState.history[room.duelState.history.length - 1].winnerName; }
    const duelInfo = (room.gameState === 'dueling' || room.gameState === 'rip_decision') ? { attackerName: room.duelState.attackerName, defenderName: room.duelState.defenderName, round: room.duelState.round, scoreAttacker: room.duelState.scoreAttacker, scoreDefender: room.duelState.scoreDefender, history: room.duelState.history, attackerId: room.duelState.attackerId, defenderId: room.duelState.defenderId, myChoice: null, turn: room.duelState.turn, lastWinner: lastRoundWinner } : null;
    const pack = { state: room.gameState, roomId: roomId, players: room.players.map((p, i) => ({ name: p.name + (p.isAdmin ? " 👑" : "") + (p.isSpectator ? " 👁️" : ""), cardCount: p.hand.length, id: p.id, isTurn: (room.gameState === 'playing' && i === room.currentTurn), hasDrawn: p.hasDrawn, isDead: p.isDead, isSpectator: p.isSpectator, isAdmin: p.isAdmin, isConnected: p.isConnected })), topCard: room.discardPile.length > 0 ? room.discardPile[room.discardPile.length - 1] : null, activeColor: room.activeColor, currentTurn: room.currentTurn, duelInfo, pendingPenalty: room.pendingPenalty, chatHistory: room.chatHistory };
    room.players.forEach(p => {
        if(p.isConnected) {
            const mp = JSON.parse(JSON.stringify(pack)); mp.iamAdmin = p.isAdmin;
            if (mp.duelInfo) { if (p.id === room.duelState.attackerId) mp.duelInfo.myChoice = room.duelState.attackerChoice; if (p.id === room.duelState.defenderId) mp.duelInfo.myChoice = room.duelState.defenderChoice; }
            io.to(p.id).emit('updateState', mp); if (!p.isSpectator || p.isDead) io.to(p.id).emit('handUpdate', p.hand); io.to(p.id).emit('chatHistory', room.chatHistory);
        }
    });
}

// --- CLIENTE ---
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
        .is-dead { text-decoration: line-
