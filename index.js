const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

// --- ESTRUCTURA DE DATOS GLOBAL ---
const rooms = {}; 

/*
    SISTEMA DE LIMPIEZA AUTOMÁTICA
    Para evitar que el servidor se llene de salas abandonadas por siempre,
    revisamos cada 30 minutos y borramos salas que no se hayan tocado en 1 hora.
*/
setInterval(() => {
    const now = Date.now();
    Object.keys(rooms).forEach(roomId => {
        if (now - rooms[roomId].lastActivity > 3600000) { // 1 hora de inactividad
            delete rooms[roomId];
            console.log(`Sala ${roomId} eliminada por inactividad.`);
        }
    });
}, 1800000); // Chequeo cada 30 mins

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
        lastActivity: Date.now() // Marca de tiempo para limpieza
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
    
    // 1. CREAR SALA
    socket.on('createRoom', (data) => {
        const name = data.name.substring(0, 15);
        const uuid = data.uuid;
        const roomId = Math.random().toString(36).substring(2, 6).toUpperCase();
        
        initRoom(roomId);
        
        const player = { 
            id: socket.id, uuid, name, hand: [], hasDrawn: false, 
            isSpectator: false, isDead: false, isAdmin: true 
        };
        
        rooms[roomId].players.push(player);
        socket.join(roomId);
        socket.emit('roomCreated', { roomId, name });
        updateAll(roomId);
    });

    // 2. UNIRSE A SALA (O RECONECTARSE)
    socket.on('joinRoom', (data) => {
        const name = data.name.substring(0, 15);
        const roomId = data.roomId.toUpperCase();
        const uuid = data.uuid;
        
        if (!rooms[roomId]) {
            socket.emit('error', 'Sala no encontrada o expirada.');
            return;
        }

        const room = rooms[roomId];
        touchRoom(roomId);

        // BUSCAR SI YA EXISTE (POR UUID)
        const existingPlayer = room.players.find(p => p.uuid === uuid);

        if (existingPlayer) {
            // ¡ES UNA RECONEXIÓN!
            existingPlayer.id = socket.id; // Actualizamos el ID del socket
            existingPlayer.name = name;    // Actualizamos nombre por si acaso
            socket.join(roomId);
            
            // No notificamos a todos para no spammear si solo fue un parpadeo de red
            // Pero sí le enviamos el estado al que volvió
            socket.emit('roomJoined', { roomId }); 
        } else {
            // NUEVO JUGADOR
            const isGameRunning = room.gameState !== 'waiting' && room.gameState !== 'counting';
            const player = { 
                id: socket.id, uuid, name, hand: [], hasDrawn: false, 
                isSpectator: isGameRunning, isDead: false, 
                isAdmin: (room.players.length === 0) 
            };
            
            room.players.push(player);
            socket.join(roomId);
            
            socket.emit('roomJoined', { roomId });
            io.to(roomId).emit('notification', `👋 ${player.name} entró.`);
        }
        updateAll(roomId);
    });

    // --- LÓGICA DE JUEGO ---

    socket.on('requestStart', () => {
        const roomId = getRoomId(socket);
        if(!roomId || !rooms[roomId]) return;
        touchRoom(roomId);
        const room = rooms[roomId];
        const p = room.players.find(p => p.id === socket.id);

        if (p && p.isAdmin && room.gameState === 'waiting') {
            if (room.players.length < 2) {
                socket.emit('notification', '⚠️ Mínimo 2 jugadores.');
                return;
            }
            startCountdown(roomId);
        }
    });

    socket.on('playCard', (cardId, chosenColor) => {
        const roomId = getRoomId(socket);
        if(!roomId || !rooms[roomId]) return;
        touchRoom(roomId);
        const room = rooms[roomId];

        if (room.gameState !== 'playing') return;
        
        const pIndex = room.players.findIndex(p => p.id === socket.id);
        if (pIndex === -1) return;
        const player = room.players[pIndex];
        
        if (player.isDead || player.isSpectator) return;

        const cardIndex = player.hand.findIndex(c => c.id === cardId);
        if (cardIndex === -1) return;
        
        const card = player.hand[cardIndex];
        const top = room.discardPile[room.discardPile.length - 1];

        if (player.hand.length === 1) {
            const isStrictNumber = /^[0-9]$/.test(card.value);
            const isUnoYMedio = card.value === '1 y 1/2';
            const isGracia = card.value === 'GRACIA';
            if (!isStrictNumber && !isUnoYMedio && !isGracia) {
                socket.emit('notification', '🚫 Última carta: Solo Números o Gracia.');
                return; 
            }
        }

        if (top.color !== 'negro') room.activeColor = top.color;

        let isSaff = false;
        if (pIndex !== room.currentTurn) {
            const isNumericSaff = /^[0-9]$/.test(card.value) || card.value === '1 y 1/2';
            if (isNumericSaff && card.color !== 'negro' && card.value === top.value && card.color === top.color) {
                isSaff = true;
                room.currentTurn = pIndex;
                room.pendingPenalty = 0;
                io.to(roomId).emit('notification', `⚡ ¡${player.name} hizo SAFF!`);
                io.to(roomId).emit('playSound', 'saff');
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

        if (card.value === 'GRACIA') {
            const deadPlayer = room.players.find(p => p.isDead);
            player.hand.splice(cardIndex, 1); room.discardPile.push(card); io.to(roomId).emit('playSound', 'divine');
            if (room.pendingPenalty > 0) {
                io.to(roomId).emit('showDivine', `${player.name} anuló el castigo`); room.pendingPenalty = 0;
                if (!room.activeColor) room.activeColor = 'rojo'; 
                advanceTurn(roomId, 1); updateAll(roomId); return;
            }
            if (deadPlayer) {
                deadPlayer.isDead = false; deadPlayer.isSpectator = false;
                io.to(roomId).emit('showDivine', `¡MILAGRO! ${deadPlayer.name} revivió`);
            } else { io.to(roomId).emit('notification', `❤️ ${player.name} usó Gracia.`); }
            
            if (player.hand.length === 0) { finishRound(roomId, player); return; }
            advanceTurn(roomId, 1); updateAll(roomId); return;
        }

        if (card.value === 'RIP') {
            if (getAlivePlayersCount(roomId) < 2) {
                player.hand.splice(cardIndex, 1); room.discardPile.push(card);
                io.to(roomId).emit('notification', '💀 RIP fallido.');
                advanceTurn(roomId, 1); updateAll(roomId); return;
            }
            player.hand.splice(cardIndex, 1); room.discardPile.push(card); io.to(roomId).emit('playSound', 'rip');
            room.gameState = 'rip_decision';
            const attacker = player;
            const victimIdx = getNextPlayerIndex(roomId, 1);
            const defender = room.players[victimIdx];
            
            room.duelState = { 
                attackerId: attacker.id, defenderId: defender.id, 
                attackerName: attacker.name, defenderName: defender.name, 
                round: 1, scoreAttacker: 0, scoreDefender: 0, 
                attackerChoice: null, defenderChoice: null, history: [],
                turn: attacker.id 
            };
            
            io.to(roomId).emit('notification', `💀 ¡${attacker.name} RIP a ${defender.name}!`);
            updateAll(roomId); return;
        }

        player.hand.splice(cardIndex, 1); room.discardPile.push(card);
        io.to(roomId).emit('cardPlayedEffect', { color: card.color });

        if (card.color === 'negro' && chosenColor) room.activeColor = chosenColor;
        else if (card.color !== 'negro') room.activeColor = card.color;

        let steps = 1;
        if (card.value === 'R') {
            if (getAlivePlayersCount(roomId) === 2) steps = 2; else room.direction *= -1;
        }
        if (card.value === 'X') steps = 2;

        if (['+2', '+4', '+12'].includes(card.value)) {
            const val = parseInt(card.value.replace('+',''));
            room.pendingPenalty += val;
            io.to(roomId).emit('notification', `💥 ¡+${val}! Total: ${room.pendingPenalty}`);
            io.to(roomId).emit('playSound', 'attack');
            if (val > 4) io.to(roomId).emit('shakeScreen');
            advanceTurn(roomId, 1); updateAll(roomId); return; 
        }

        if (card.color === 'negro') io.to(roomId).emit('playSound', 'wild'); else io.to(roomId).emit('playSound', 'soft');

        if (player.hand.length === 0) finishRound(roomId, player);
        else { advanceTurn(roomId, steps); updateAll(roomId); }
    });

    socket.on('draw', () => {
        const roomId = getRoomId(socket);
        if(!roomId || !rooms[roomId]) return;
        touchRoom(roomId);
        const room = rooms[roomId];
        
        if (room.gameState !== 'playing') return;
        const pIndex = room.players.findIndex(p => p.id === socket.id);
        
        if (pIndex === -1 || room.players[pIndex].isDead || room.players[pIndex].isSpectator) return;

        if (pIndex === room.currentTurn) {
            if (room.pendingPenalty > 0) {
                drawCards(roomId, pIndex, 1); room.pendingPenalty--; io.to(roomId).emit('playSound', 'soft');
                if (room.pendingPenalty > 0) { io.to(roomId).emit('notification', `😰 Faltan: ${room.pendingPenalty}`); updateAll(roomId); } 
                else { io.to(roomId).emit('notification', `😓 Terminó castigo.`); advanceTurn(roomId, 1); updateAll(roomId); }
            } else {
                if (!room.players[pIndex].hasDrawn) {
                    drawCards(roomId, pIndex, 1); room.players[pIndex].hasDrawn = true; io.to(roomId).emit('playSound', 'soft'); updateAll(roomId);
                } else { socket.emit('notification', 'Ya robaste.'); }
            }
        }
    });

    socket.on('passTurn', () => {
        const roomId = getRoomId(socket);
        if(!roomId || !rooms[roomId]) return;
        touchRoom(roomId);
        const room = rooms[roomId];

        if (room.gameState !== 'playing') return;
        const pIndex = room.players.findIndex(p => p.id === socket.id);
        if (pIndex === room.currentTurn && room.players[pIndex].hasDrawn && room.pendingPenalty === 0) {
            advanceTurn(roomId, 1); updateAll(roomId);
        }
    });

    socket.on('playGraceDefense', (chosenColor) => {
        const roomId = getRoomId(socket);
        if(!roomId || !rooms[roomId]) return;
        touchRoom(roomId);
        const room = rooms[roomId];

        if (room.gameState !== 'rip_decision' || socket.id !== room.duelState.defenderId) return;
        const defender = room.players.find(p => p.id === socket.id);
        const cardIndex = defender.hand.findIndex(c => c.value === 'GRACIA');
        if (cardIndex !== -1) {
            defender.hand.splice(cardIndex, 1); room.discardPile.push(defender.hand[cardIndex]);
            room.activeColor = chosenColor || 'rojo';
            io.to(roomId).emit('showDivine', `${defender.name} salvado por Gracia`); io.to(roomId).emit('playSound', 'divine');
            const attIndex = room.players.findIndex(p => p.id === room.duelState.attackerId);
            drawCards(roomId, attIndex, 4);
            room.gameState = 'playing'; advanceTurn(roomId, 1); updateAll(roomId);
        }
    });

    socket.on('ripDecision', (d) => {
        const roomId = getRoomId(socket);
        if(!roomId || !rooms[roomId]) return;
        touchRoom(roomId);
        const room = rooms[roomId];

        if (room.gameState !== 'rip_decision' || socket.id !== room.duelState.defenderId) return;
        const def = room.players.find(p => p.id === room.duelState.defenderId);
        if (d === 'surrender') { eliminatePlayer(roomId, def.id); checkWinCondition(roomId); }
        else { io.to(roomId).emit('playSound', 'bell'); room.gameState = 'dueling'; updateAll(roomId); }
    });

    socket.on('duelPick', (c) => {
        const roomId = getRoomId(socket);
        if(!roomId || !rooms[roomId]) return;
        touchRoom(roomId);
        const room = rooms[roomId];

        if (room.gameState !== 'dueling') return;
        if (socket.id !== room.duelState.turn) return;

        if (socket.id === room.duelState.attackerId) {
            room.duelState.attackerChoice = c;
            room.duelState.turn = room.duelState.defenderId;
        } else if (socket.id === room.duelState.defenderId) {
            room.duelState.defenderChoice = c;
            resolveDuelRound(roomId);
            return;
        }
        updateAll(roomId);
    });

    socket.on('sayUno', () => {
        const roomId = getRoomId(socket);
        if(!roomId || !rooms[roomId]) return;
        const room = rooms[roomId];
        const p = room.players.find(p => p.id === socket.id);
        if (p && !p.isDead && !p.isSpectator) { io.to(roomId).emit('notification', `🚨 ¡${p.name} gritó UNO y 1/2!`); io.to(roomId).emit('playSound', 'uno'); }
    });
    
    socket.on('sendChat', (text) => { 
        const roomId = getRoomId(socket);
        if(!roomId || !rooms[roomId]) return;
        const room = rooms[roomId];
        const p = room.players.find(x => x.id === socket.id); 
        if (p) {
            const msg = { name: p.name, text };
            room.chatHistory.push(msg);
            if(room.chatHistory.length > 50) room.chatHistory.shift();
            io.to(roomId).emit('chatMessage', msg); 
        }
    });

    // --- MODIFICACIÓN CLAVE: DISCONNECT NO DESTRUCTIVO ---
    socket.on('disconnect', () => {
        // En los juegos de navegador móvil, disconnect ocurre muy seguido.
        // YA NO borramos al jugador. Dejamos que "persista".
        // La limpieza solo la hace el setInterval global si la sala muere.
        // Si el usuario vuelve, el 'joinRoom' con UUID recupera la sesión.
        const roomId = getRoomId(socket);
        if (roomId && rooms[roomId]) {
            console.log(`Socket desconectado en sala ${roomId}. Mantenemos datos para reconexión.`);
        }
    });
});

// --- HELPERS ---

function getRoomId(socket) {
    return Array.from(socket.rooms).find(r => r !== socket.id);
}

function startCountdown(roomId) {
    const room = rooms[roomId];
    if (room.players.length < 2) return;
    
    room.gameState = 'counting';
    let count = 3;
    createDeck(roomId);
    let safeCard = room.deck.pop();
    while (safeCard.color === 'negro' || safeCard.value === '+2' || safeCard.value === 'R' || safeCard.value === 'X') {
        room.deck.unshift(safeCard); 
        for (let i = room.deck.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [room.deck[i], room.deck[j]] = [room.deck[j], room.deck[i]];
        }
        safeCard = room.deck.pop();
    }
    room.discardPile = [safeCard];
    room.activeColor = safeCard.color;
    room.currentTurn = 0; 
    room.pendingPenalty = 0;
    
    room.players.forEach(p => { 
        p.hand = []; p.hasDrawn = false; p.isDead = false; 
        if (!p.isSpectator) {
            for (let i = 0; i < 7; i++) drawCards(roomId, room.players.indexOf(p), 1); 
        }
    });
    
    io.to(roomId).emit('countdownTick', 3);
    room.countdownInterval = setInterval(() => {
        if (!rooms[roomId]) return clearInterval(room.countdownInterval);
        io.to(roomId).emit('countdownTick', count); io.to(roomId).emit('playSound', 'soft');
        if (count <= 0) { 
            clearInterval(room.countdownInterval); 
            room.gameState = 'playing'; 
            io.to(roomId).emit('playSound', 'start'); 
            updateAll(roomId); 
        } 
        count--;
    }, 1000);
}

function drawCards(roomId, pid, n) { 
    const room = rooms[roomId];
    if (pid < 0 || pid >= room.players.length) return; 
    for (let i = 0; i < n; i++) { 
        if (room.deck.length === 0) recycleDeck(roomId); 
        if (room.deck.length > 0) room.players[pid].hand.push(room.deck.pop()); 
    } 
}

function advanceTurn(roomId, steps) {
    const room = rooms[roomId];
    if (room.players.length === 0) return;
    room.players.forEach(p => p.hasDrawn = false);

    let attempts = 0;
    while (steps > 0 && attempts < room.players.length * 2) {
        room.currentTurn = (room.currentTurn + room.direction + room.players.length) % room.players.length;
        if (!room.players[room.currentTurn].isDead && !room.players[room.currentTurn].isSpectator) { 
            steps--; 
        }
        attempts++;
    }
    if (room.players[room.currentTurn]) room.players[room.currentTurn].hasDrawn = false;
}

function getNextPlayerIndex(roomId, steps) {
    const room = rooms[roomId];
    let next = room.currentTurn;
    let attempts = 0;
    while (steps > 0 && attempts < room.players.length * 2) {
        next = (next + room.direction + room.players.length) % room.players.length;
        if (!room.players[next].isDead && !room.players[next].isSpectator) steps--;
        attempts++;
    }
    return next;
}

function finishRound(roomId, w) {
    const room = rooms[roomId];
    room.gameState = 'waiting';
    io.to(roomId).emit('gameOver', { winner: w.name }); 
    io.to(roomId).emit('playSound', 'win');
    
    setTimeout(() => {
        delete rooms[roomId];
    }, 5000);
}

function checkWinCondition(roomId) {
    const room = rooms[roomId];
    if (room.players.length > 1 && getAlivePlayersCount(roomId) <= 1) {
        const winner = room.players.find(p => !p.isDead && !p.isSpectator); 
        if (winner) finishRound(roomId, winner); 
    } else { 
        room.gameState = 'playing'; advanceTurn(roomId, 1); updateAll(roomId); 
    }
}

function resolveDuelRound(roomId) {
    const room = rooms[roomId];
    const att = room.duelState.attackerChoice, def = room.duelState.defenderChoice;
    let winner = 'tie';
    if ((att == 'fuego' && def == 'hielo') || (att == 'hielo' && def == 'agua') || (att == 'agua' && def == 'fuego')) winner = 'attacker';
    else if ((def == 'fuego' && att == 'hielo') || (def == 'hielo' && att == 'agua') || (def == 'agua' && att == 'fuego')) winner = 'defender';
    
    if (winner == 'attacker') room.duelState.scoreAttacker++; else if (winner == 'defender') room.duelState.scoreDefender++;
    
    let winName = 'Empate';
    if(winner === 'attacker') winName = room.duelState.attackerName;
    if(winner === 'defender') winName = room.duelState.defenderName;

    room.duelState.history.push({ round: room.duelState.round, att, def, winnerName: winName });
    room.duelState.attackerChoice = null; room.duelState.defenderChoice = null; 
    room.duelState.turn = room.duelState.attackerId; 

    io.to(roomId).emit('playSound', 'soft');
    
    if (room.duelState.round >= 3 || room.duelState.scoreAttacker >= 2 || room.duelState.scoreDefender >= 2) {
        setTimeout(() => finalizeDuel(roomId), 2000); 
    } else { 
        room.duelState.round++; updateAll(roomId); 
    }
}

function finalizeDuel(roomId) {
    const room = rooms[roomId];
    const att = room.players.find(p => p.id === room.duelState.attackerId); const def = room.players.find(p => p.id === room.duelState.defenderId);
    if (!att || !def) { room.gameState = 'playing'; updateAll(roomId); return; }
    
    if (room.duelState.scoreAttacker > room.duelState.scoreDefender) { 
        io.to(roomId).emit('notification', `💀 ${att.name} GANA.`); 
        eliminatePlayer(roomId, def.id); 
        checkWinCondition(roomId); 
    }
    else if (room.duelState.scoreDefender > room.duelState.scoreAttacker) { 
        io.to(roomId).emit('notification', `🛡️ ${def.name} GANA. Castigo atacante.`); 
        drawCards(roomId, room.players.findIndex(p => p.id === room.duelState.attackerId), 4); 
        room.gameState = 'playing'; advanceTurn(roomId, 1); updateAll(roomId); 
    }
    else { 
        io.to(roomId).emit('notification', `🤝 EMPATE.`); 
        room.gameState = 'playing'; advanceTurn(roomId, 1); updateAll(roomId); 
    }
}

function eliminatePlayer(roomId, id) { 
    const room = rooms[roomId];
    const p = room.players.find(p => p.id === id); 
    if (p) { p.isDead = true; p.isSpectator = true; } 
}
function getAlivePlayersCount(roomId) { 
    return rooms[roomId].players.filter(p => !p.isDead && !p.isSpectator).length; 
}

function updateAll(roomId) {
    const room = rooms[roomId];
    if(!room) return;

    let lastRoundWinner = "";
    if (room.duelState.history.length > 0) {
        lastRoundWinner = room.duelState.history[room.duelState.history.length - 1].winnerName;
    }

    const duelInfo = (room.gameState === 'dueling' || room.gameState === 'rip_decision') ? {
        attackerName: room.duelState.attackerName, defenderName: room.duelState.defenderName, round: room.duelState.round, 
        scoreAttacker: room.duelState.scoreAttacker, scoreDefender: room.duelState.scoreDefender, history: room.duelState.history, 
        attackerId: room.duelState.attackerId, defenderId: room.duelState.defenderId, 
        myChoice: null,
        turn: room.duelState.turn,
        lastWinner: lastRoundWinner 
    } : null;
    
    const pack = {
        state: room.gameState, 
        roomId: roomId, 
        players: room.players.map((p, i) => ({ 
            name: p.name + (p.isAdmin ? " 👑" : "") + (p.isSpectator ? " 👁️" : ""),
            cardCount: p.hand.length, 
            id: p.id, 
            isTurn: (room.gameState === 'playing' && i === room.currentTurn), 
            hasDrawn: p.hasDrawn, 
            isDead: p.isDead, 
            isSpectator: p.isSpectator,
            isAdmin: p.isAdmin 
        })),
        topCard: room.discardPile.length > 0 ? room.discardPile[room.discardPile.length - 1] : null, 
        activeColor: room.activeColor, 
        currentTurn: room.currentTurn, duelInfo, pendingPenalty: room.pendingPenalty,
        chatHistory: room.chatHistory
    };
    
    room.players.forEach(p => {
        const mp = JSON.parse(JSON.stringify(pack));
        mp.iamAdmin = p.isAdmin;
        if (mp.duelInfo) {
            if (p.id === room.duelState.attackerId) mp.duelInfo.myChoice = room.duelState.attackerChoice;
            if (p.id === room.duelState.defenderId) mp.duelInfo.myChoice = room.duelState.defenderChoice;
        }
        io.to(p.id).emit('updateState', mp); 
        if (!p.isSpectator || p.isDead) io.to(p.id).emit('handUpdate', p.hand);
        io.to(p.id).emit('chatHistory', room.chatHistory);
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
        .hand-card { flex: 0 0 85px; height: 130px; border-radius: 8px; border: 2px solid white; background: #444; display: flex; justify-content: center; align-items: center; font-size: 32px; font-weight: 900; color: white; scroll-snap-align: center; position: relative; cursor: pointer; box-shadow: 0 4px 8px rgba(0,0,0,0.6); user-select: none; z-index: 1; }
        .hand-card:active { transform: scale(0.95); }

        body.bg-rojo { background-color: #4a1c1c !important; } 
        body.bg-azul { background-color: #1c2a4a !important; } 
        body.bg-verde { background-color: #1c4a2a !important; } 
        body.bg-amarillo { background-color: #4a451c !important; }

        #login { background: #2c3e50; z-index: 2000; }
        #join-menu { background: #34495e; z-index: 2000; display:none; }
        #lobby { background: #2c3e50; z-index: 1500; }
        
        #rip-screen { background: rgba(50,0,0,0.98); z-index: 3000; }
        #duel-screen { background: rgba(0,0,0,0.98); z-index: 3000; }
        #game-over-screen { background: rgba(0,0,0,0.95); z-index: 4000; display: none; text-align: center; border: 5px solid gold; box-sizing: border-box; }
        
        #color-picker { position: fixed; top: 40%; left: 50%; transform: translate(-50%,-50%); background: white; padding: 20px; border-radius: 10px; z-index: 4000; display: none; text-align: center; box-shadow: 0 0 50px black; }
        .color-circle { width: 60px; height: 60px; border-radius: 50%; display: inline-block; margin: 10px; cursor: pointer; border: 3px solid #ddd; }

        #chat-btn { position: fixed; bottom: 200px; right: 20px; width: 50px; height: 50px; background: #3498db; border-radius: 50%; display: flex; justify-content: center; align-items: center; border: 2px solid white; z-index: 5000; box-shadow: 0 4px 5px rgba(0,0,0,0.3); font-size: 24px; cursor: pointer; }
        #chat-win { position: fixed; bottom: 260px; right: 20px; width: 280px; height: 200px; background: rgba(0,0,0,0.9); border: 1px solid #666; display: none; flex-direction: column; z-index: 5000; border-radius: 10px; }
        
        .duel-btn { font-size:40px; background:none; border:none; cursor:pointer; opacity: 0.5; transition: 0.3s; }
        .duel-btn:hover { opacity: 0.8; }
        .duel-btn.selected { opacity: 1; transform: scale(1.3); text-shadow: 0 0 20px white; border-bottom: 3px solid gold; padding-bottom: 5px; }
        .duel-btn:disabled { opacity: 0.2; cursor: not-allowed; filter: grayscale(1); }
        
        input { padding:15px; font-size:20px; text-align:center; width:80%; max-width:300px; border-radius:30px; border:none; margin:10px 0; }
        .btn-main { padding:15px 40px; background:#27ae60; color:white; border:none; border-radius:30px; font-size:20px; cursor:pointer; margin: 10px; }

        @keyframes pop { 0% { transform: scale(0.8); opacity:0; } 100% { transform: scale(1); opacity:1; } }
    </style>
</head>
<body>
    <div id="login" class="screen" style="display:flex;">
        <h1 style="font-size:60px; margin:0;">UNO 1/2</h1>
        <p>Reconnect & Fix</p>
        <input id="my-name" type="text" placeholder="Tu Nombre" maxlength="15">
        <button id="btn-create" class="btn-main" onclick="showCreate()">Crear Sala</button>
        <button id="btn-join-menu" class="btn-main" onclick="showJoin()" style="background:#2980b9">Unirse a Sala</button>
    </div>

    <div id="join-menu" class="screen">
        <h1>Unirse</h1>
        <input id="room-code" type="text" placeholder="Código de Sala" style="text-transform:uppercase;">
        <button class="btn-main" onclick="joinRoom()">Entrar</button>
        <button class="btn-main" onclick="backToLogin()" style="background:#7f8c8d">Volver</button>
    </div>

    <div id="lobby" class="screen">
        <h1>Sala: <span id="lobby-code" style="color:gold; font-family:monospace;"></span></h1>
        <button onclick="copyLink()" style="background:none; border:1px solid #aaa; color:#aaa; padding:5px 10px; border-radius:5px; cursor:pointer; margin-bottom:20px;">🔗 Copiar Link Invitación</button>
        
        <p id="host-msg" style="color:gold; font-size:18px; display:none;">👑 Eres el Anfitrión.</p>
        <div id="lobby-users" style="font-size:20px; margin-bottom:20px;"></div>
        
        <button id="start-btn" onclick="start()" class="btn-main" style="display:none; background:#e67e22;">EMPEZAR</button>
        <p id="wait-msg" style="display:none; color:#aaa;">Esperando al anfitrión...</p>
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

    <div id="game-over-screen" class="screen">
        <h1 style="color:gold; font-size:60px; margin-bottom:10px;">🏆 ¡VICTORIA! 🏆</h1>
        <h2 id="winner-name" style="color:white; font-size:40px;"></h2>
        <div style="font-size:50px; margin:20px;">🎉🎊🥂</div>
        <p style="color: #aaa;">Reiniciando...</p>
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
        <h2 id="round-winner" style="color: #2ecc71; font-size: 24px; min-height: 30px;"></h2>
        <h2 id="duel-names">... vs ...</h2>
        <h3 id="duel-sc">0 - 0</h3>
        <p id="duel-turn-msg" style="color: #aaa; font-style: italic; min-height: 24px;">Esperando tu turno...</p>
        <div id="duel-opts" style="margin-top:20px;">
            <button id="btn-fuego" class="duel-btn" onclick="pick('fuego')">🔥</button>
            <button id="btn-hielo" class="duel-btn" onclick="pick('hielo')">❄️</button>
            <button id="btn-agua" class="duel-btn" onclick="pick('agua')">💧</button>
        </div>
        <div id="duel-info" style="margin-top:20px; color:#aaa; font-size: 14px; opacity: 0.7;"></div>
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
        let myId = ''; let pendingCard = null; let pendingGrace = false; let amAdmin = false; let isMyTurn = false;
        let currentRoomId = '';

        // --- SISTEMA DE PERSISTENCIA UUID ---
        let myUUID = localStorage.getItem('uno_uuid');
        if (!myUUID) {
            myUUID = Math.random().toString(36).substring(2) + Date.now().toString(36);
            localStorage.setItem('uno_uuid', myUUID);
        }

        // --- MANEJO DE LINKS DE INVITACIÓN ---
        const urlParams = new URLSearchParams(window.location.search);
        const inviteCode = urlParams.get('room');
        if (inviteCode) {
            document.getElementById('room-code').value = inviteCode;
            document.getElementById('btn-create').style.display = 'none';
            const btnJoin = document.getElementById('btn-join-menu');
            btnJoin.innerText = "ENTRAR A SALA " + inviteCode;
            btnJoin.style.background = "#e67e22";
            btnJoin.onclick = joinRoom;
        }

        // --- SISTEMA DE RE-CONEXIÓN AUTOMÁTICA ---
        // Si el socket se corta (WhatsApp, bloqueo pantalla) y vuelve, intentamos volver a la sala
        socket.on('connect', () => {
            myId = socket.id;
            // Solo intentamos reconectar si ya estábamos en una sala y tenemos un nombre puesto
            if (currentRoomId && document.getElementById('my-name').value) {
                 console.log("Reconectando a sala: " + currentRoomId);
                 const name = document.getElementById('my-name').value;
                 // Emitimos joinRoom de nuevo. El servidor verá el UUID y nos devolverá el control.
                 socket.emit('joinRoom', { name, uuid: myUUID, roomId: currentRoomId });
            }
        });

        function showCreate() {
            const name = document.getElementById('my-name').value.trim();
            if(!name) return alert('Ingresa tu nombre');
            socket.emit('createRoom', { name, uuid: myUUID });
            play('soft');
        }

        function showJoin() {
            document.getElementById('login').style.display = 'none';
            document.getElementById('join-menu').style.display = 'flex';
        }

        function backToLogin() {
            document.getElementById('join-menu').style.display = 'none';
            document.getElementById('login').style.display = 'flex';
        }

        function joinRoom() {
            const name = document.getElementById('my-name').value.trim();
            const code = document.getElementById('room-code').value.trim();
            
            if(!name) return alert('¡Falta tu nombre!');
            if(!code) return alert('Falta el código de sala');
            
            socket.emit('joinRoom', { name, uuid: myUUID, roomId: code });
            play('soft');
        }
        
        function copyLink() {
            const link = window.location.origin + '/?room=' + currentRoomId;
            navigator.clipboard.writeText(link).then(() => alert('Enlace copiado!'));
        }

        socket.on('roomCreated', (data) => {
            currentRoomId = data.roomId;
            enterLobby();
        });

        socket.on('roomJoined', (data) => {
            currentRoomId = data.roomId;
            enterLobby();
        });
        
        socket.on('error', (msg) => {
            alert(msg);
        });

        function enterLobby() {
            document.getElementById('login').style.display = 'none';
            document.getElementById('join-menu').style.display = 'none';
            document.getElementById('lobby').style.display = 'flex';
            document.getElementById('lobby-code').innerText = currentRoomId;
        }

        // --- JUEGO ---
        
        const colorMap = { 'rojo': '#ff5252', 'azul': '#448aff', 'verde': '#69f0ae', 'amarillo': '#ffd740', 'negro': '#212121', 'death-card': '#000000', 'divine-card': '#ffffff', 'mega-wild': '#4a148c' };
        const sounds = { soft: 'https://cdn.freesound.org/previews/240/240776_4107740-lq.mp3', attack: 'https://cdn.freesound.org/previews/155/155235_2452367-lq.mp3', rip: 'https://cdn.freesound.org/previews/173/173930_2394245-lq.mp3', divine: 'https://cdn.freesound.org/previews/242/242501_4414128-lq.mp3', uno: 'https://cdn.freesound.org/previews/415/415209_5121236-lq.mp3', start: 'https://cdn.freesound.org/previews/320/320655_5260872-lq.mp3', win: 'https://cdn.freesound.org/previews/270/270402_5123851-lq.mp3', bell: 'https://cdn.freesound.org/previews/336/336899_4939433-lq.mp3', saff: 'https://cdn.freesound.org/previews/614/614742_11430489-lq.mp3', wild: 'https://cdn.freesound.org/previews/320/320653_5260872-lq.mp3', thunder: 'https://cdn.freesound.org/previews/173/173930_2394245-lq.mp3' };
        const audio = {}; Object.keys(sounds).forEach(k => { audio[k] = new Audio(sounds[k]); audio[k].volume = 0.3; });
        function play(k) { if(audio[k]) { audio[k].currentTime=0; audio[k].play().catch(()=>{}); } }

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

        socket.on('chatHistory', h => {
             const b = document.getElementById('chat-msgs');
             b.innerHTML = '';
             h.forEach(m => b.innerHTML += \`<div><b style="color:gold">\${m.name}:</b> \${m.text}</div>\`);
             b.scrollTop = b.scrollHeight;
        });

        socket.on('gameOver', data => {
             document.getElementById('game-over-screen').style.display = 'flex';
             document.getElementById('winner-name').innerText = data.winner;
             setTimeout(() => {
                 localStorage.removeItem('uno_uuid'); 
                 window.location = window.location.origin; 
             }, 5000);
        });

        socket.on('countdownTick', n => {
            document.getElementById('lobby').style.display='none';
            document.getElementById('game-over-screen').style.display='none';
            document.getElementById('game-area').style.display='flex';
            document.getElementById('hand-zone').style.display='flex';
            const c = document.getElementById('countdown');
            c.style.display='flex'; c.innerText=n;
            if(n<=0) c.style.display='none';
        });

        socket.on('updateState', s => {
            amAdmin = s.iamAdmin;
            document.getElementById('login').style.display='none';
            document.getElementById('join-menu').style.display='none'; 
            
            document.getElementById('lobby').style.display = s.state==='waiting' ? 'flex' : 'none';
            document.getElementById('rip-screen').style.display = 'none';
            document.getElementById('duel-screen').style.display = s.state==='dueling' ? 'flex' : 'none';
            
            if(s.state === 'waiting') {
                document.getElementById('lobby-users').innerHTML = s.players.map(p=>\`<div>\${p.name}</div>\`).join('');
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
            
            if (s.state === 'dueling') {
                document.getElementById('hand-zone').style.display = 'none';
            } else {
                document.getElementById('hand-zone').style.display = 'flex';
            }

            document.body.className = s.activeColor ? 'bg-'+s.activeColor : '';

            const top = s.topCard;
            const tEl = document.getElementById('top-card');
            if(top) {
                tEl.className = 'card-pile';
                let bg = colorMap[top.color] || '#444'; let txt = 'white'; let border = '3px solid white';
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
            const canPlay = me && !me.isSpectator;
            isMyTurn = me && me.isTurn; 

            document.getElementById('btn-pass').style.display = (canPlay && me.isTurn && me.hasDrawn && s.pendingPenalty===0) ? 'inline-block' : 'none';
            document.getElementById('uno-btn-area').style.visibility = canPlay ? 'visible' : 'hidden';

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
                document.getElementById('round-winner').innerText = s.duelInfo.lastWinner ? "Ganador Ronda: " + s.duelInfo.lastWinner : "";
                
                document.getElementById('duel-info').innerHTML = s.duelInfo.history.map(h=>\`<div>Gana: \${h.winnerName}</div>\`).join('');
                
                const amIFighter = (myId === s.duelInfo.attackerId || myId === s.duelInfo.defenderId);
                const isMyTurnDuel = (s.duelInfo.turn === myId);
                
                document.getElementById('duel-opts').style.display = amIFighter ? 'block' : 'none';
                
                const turnMsg = document.getElementById('duel-turn-msg');
                const btns = document.querySelectorAll('.duel-btn');
                
                if (amIFighter) {
                    if (isMyTurnDuel) {
                        turnMsg.innerText = "¡TU TURNO! Elige...";
                        turnMsg.style.color = "#2ecc71";
                        btns.forEach(b => b.disabled = false);
                    } else {
                        turnMsg.innerText = "Esperando al oponente...";
                        turnMsg.style.color = "#aaa";
                        btns.forEach(b => b.disabled = true);
                    }
                } else {
                    turnMsg.innerText = "";
                }

                ['fuego','hielo','agua'].forEach(t => document.getElementById('btn-'+t).className = 'duel-btn');
                if(s.duelInfo.myChoice) {
                    document.getElementById('btn-' + s.duelInfo.myChoice).className = 'duel-btn selected';
                }
            }
        });

        socket.on('handUpdate', h => {
            const hz = document.getElementById('hand-zone');
            hz.innerHTML = '';
            
            if (!h || h.length === 0) return;

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
                
                if(c.value === '1 y 1/2') { d.style.fontSize = '18px'; }

                d.onclick = () => {
                     if (!isMyTurn) {
                        const isNumeric = /^[0-9]$/.test(c.value) || c.value === '1 y 1/2';
                        if (!isNumeric) return; 
                     }

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
