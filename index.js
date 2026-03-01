const express = require('express');
const app = express();
const http = require('http').createServer(app);

// --- CONFIGURACIÓN SOCKET.IO ---
const io = require('socket.io')(http, {
    pingTimeout: 60000,
    pingInterval: 25000
});

// --- VARIABLES GLOBALES ---
const rooms = {}; 
const ladderOrder = ['0', '1', '1 y 1/2', '2', '3', '4', '5', '6', '7', '8', '9'];

const sortValWeights = {
    '0': -1, '1':1, '1 y 1/2':1.5, '2':2, '3':3, '4':4, '5':5, '6':6, '7':7, '8':8, '9':9,
    '+2': 20, 'X': 21, 'R': 22,
    'color': 50, '+4': 51, 'SALTEO SUPREMO': 52, '+12': 53, 'RIP': 54, 'LIBRE': 55, 'GRACIA': 56
};
const sortColWeights = { 'rojo':1, 'azul':2, 'verde':3, 'amarillo':4, 'negro':5 };

const colors = ['rojo', 'azul', 'verde', 'amarillo'];
const values = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '1 y 1/2', '+2', 'X', 'R'];

setInterval(() => {
    try {
        const now = Date.now();
        Object.keys(rooms).forEach(roomId => {
            if (rooms[roomId] && now - rooms[roomId].lastActivity > 7200000) {
                if (rooms[roomId].actionTimer) clearTimeout(rooms[roomId].actionTimer);
                if (rooms[roomId].turnTimer) clearTimeout(rooms[roomId].turnTimer);
                if (rooms[roomId].afkTimer) clearTimeout(rooms[roomId].afkTimer);
                delete rooms[roomId]; 
            }
        });
    } catch (e) { console.error("Error en limpieza:", e); }
}, 60000 * 5); 

// --- FUNCIONES DEL SERVIDOR ---

function initRoom(roomId) {
    rooms[roomId] = {
        gameState: 'waiting', 
        players: [],
        deck: [],
        discardPile: [],
        currentTurn: 0,
        roundStarterIndex: 0,
        direction: 1,
        activeColor: '',
        pendingPenalty: 0,
        pendingSkip: 0,
        scores: {}, 
        roundCount: 1,
        librePending: null, 
        duelState: { 
            attackerId: null, defenderId: null, attackerName: '', defenderName: '', 
            round: 1, scoreAttacker: 0, scoreDefender: 0, 
            attackerChoice: null, defenderChoice: null, history: [], turn: null, narrative: '',
            type: 'rip', originalPenalty: 0, originalSkip: 0, triggerCard: null
        },
        chatHistory: [],
        lastActivity: Date.now(),
        actionTimer: null,
        turnTimer: null,
        afkTimer: null,
        timerEndsAt: null,
        resumeTurnFrom: null
    };
}

function getRoomId(socket) {
    for (const rId in rooms) {
        if (rooms[rId].players.some(p => p.id === socket.id)) return rId;
    }
    return null;
}

function touchRoom(roomId) { if (rooms[roomId]) rooms[roomId].lastActivity = Date.now(); }

function createDeck(roomId) {
    const room = rooms[roomId]; if(!room) return;
    room.deck = [];
    colors.forEach(color => {
        room.deck.push({ color, value: '0', type: 'normal', id: Math.random().toString(36) });
        room.deck.push({ color, value: '0', type: 'normal', id: Math.random().toString(36) });
        values.forEach(val => {
            room.deck.push({ color, value: val, type: 'normal', id: Math.random().toString(36) });
            room.deck.push({ color, value: val, type: 'normal', id: Math.random().toString(36) });
        });
    });
    for (let i = 0; i < 4; i++) {
        room.deck.push({ color: 'negro', value: 'color', type: 'wild', id: Math.random().toString(36) });
        room.deck.push({ color: 'negro', value: '+4', type: 'wild', id: Math.random().toString(36) });
    }
    const addSpecial = (val, count) => {
        for(let k=0; k<count; k++) room.deck.push({ color: 'negro', value: val, type: 'special', id: Math.random().toString(36) });
    };
    addSpecial('RIP', 2); addSpecial('GRACIA', 2); addSpecial('+12', 2); addSpecial('LIBRE', 2); addSpecial('SALTEO SUPREMO', 2);
    
    for (let i = room.deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [room.deck[i], room.deck[j]] = [room.deck[j], room.deck[i]];
    }
}

function recycleDeck(roomId) {
    const room = rooms[roomId]; if(!room) return;
    if (room.discardPile.length <= 1) { createDeck(roomId); io.to(roomId).emit('notification', '⚠️ Mazo regenerado.'); return; }
    const topCard = room.discardPile.pop();
    room.deck = [...room.discardPile]; room.discardPile = [topCard];
    for (let i = room.deck.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [room.deck[i], room.deck[j]] = [room.deck[j], room.deck[i]]; }
    io.to(roomId).emit('notification', '♻️ Barajando descartes...');
}

function getCardPoints(card) {
    if (!card) return 0;
    if (card.value === 'RIP') return 100;
    if (['+12', 'SALTEO SUPREMO', 'LIBRE'].includes(card.value)) return 80;
    if (['+4', 'color'].includes(card.value)) return 40;
    if (['+2', 'R', 'X'].includes(card.value)) return 20;
    if (card.value === '1 y 1/2') return 1.5;
    const val = parseInt(card.value);
    return isNaN(val) ? 0 : val;
}

const safe = (fn) => {
    return (...args) => { try { fn(...args); } catch (err) { console.error("Socket Error Prevenido:", err); } };
};

function forceKickAFK(roomId, uuid) {
    try {
        const room = rooms[roomId]; if(!room) return;
        const pIndex = room.players.findIndex(p => p.uuid === uuid);
        if(pIndex === -1) return;
        const player = room.players[pIndex];
        
        player.isDead = true; player.isSpectator = true; player.hasLeft = true;
        let msg = `🚪 ${player.name} fue expulsado de la partida por inactividad extrema.`;

        if (player.isAdmin) {
            player.isAdmin = false;
            const nextAdmin = room.players.find(p => !p.isDead && !p.isSpectator && !p.hasLeft);
            if (nextAdmin) {
                nextAdmin.isAdmin = true;
                msg += `\n👑 Ahora ${nextAdmin.name} es el nuevo anfitrión.`;
            }
        }

        const socketToKick = io.sockets.sockets.get(player.id);
        if(socketToKick) { socketToKick.leave(roomId); socketToKick.emit('requireLogin'); }

        if (getAlivePlayersCount(roomId) <= 1) {
            io.to(roomId).emit('notification', msg); 
            checkWinCondition(roomId);
        } else {
            if (room.currentTurn === pIndex) {
                room.pendingPenalty = 0; room.pendingSkip = 0;
                advanceTurn(roomId, 1);
            }
            io.to(roomId).emit('gamePaused', { message: msg, duration: 4000 });
            setTimeout(() => { try { if(rooms[roomId]) updateAll(roomId); } catch(e){} }, 4000);
        }
    } catch (e) { console.error("Error en forceKickAFK:", e); }
}

function handleTimeout(roomId, targetUuid, stateContext) {
    try {
        const room = rooms[roomId]; if (!room) return;
        const targetIdx = room.players.findIndex(p => p.uuid === targetUuid);
        if (targetIdx === -1) return;
        const target = room.players[targetIdx];
        
        if (stateContext === 'penalty_decision' && room.gameState === 'penalty_decision') {
            io.to(roomId).emit('notification', `⏳ Tiempo agotado. ${target.name} recibió el castigo automáticamente.`);
            room.gameState = 'playing';
            updateAll(roomId);
        } 
        else if (stateContext === 'rip_decision' && room.gameState === 'rip_decision') {
            io.to(roomId).emit('notification', `⏳ Tiempo agotado. ${target.name} se quedó paralizado y fue eliminado.`);
            eliminatePlayer(roomId, targetUuid);
            checkWinCondition(roomId);
            if (rooms[roomId] && rooms[roomId].gameState !== 'game_over') {
                room.gameState = 'playing';
                room.currentTurn = room.players.findIndex(p => p.uuid === room.duelState.attackerId);
                advanceTurn(roomId, 1);
                updateAll(roomId);
            }
        } 
        else if (stateContext === 'dueling' && room.gameState === 'dueling') {
            if (targetUuid === room.duelState.attackerId) {
                room.duelState.attackerChoice = null; 
            } else if (targetUuid === room.duelState.defenderId) {
                room.duelState.defenderChoice = null; 
            }
            resolveDuelRound(roomId, true);
        } 
    } catch (e) { console.error("Error en handleTimeout:", e); }
}

function manageTimers(roomId) {
    const room = rooms[roomId]; if (!room) return;
    
    if (room.actionTimer) { clearTimeout(room.actionTimer); room.actionTimer = null; }
    if (room.turnTimer) { clearTimeout(room.turnTimer); room.turnTimer = null; }
    if (room.afkTimer) { clearTimeout(room.afkTimer); room.afkTimer = null; }

    let targetUuid = null;
    let stateCtx = '';
    
    if (room.gameState === 'rip_decision' || room.gameState === 'penalty_decision') {
        targetUuid = room.duelState.defenderId; stateCtx = room.gameState;
    } else if (room.gameState === 'dueling') {
        targetUuid = room.duelState.turn; stateCtx = 'dueling';
    }

    if (targetUuid) {
        room.timerEndsAt = Date.now() + 20000;
        room.actionTimer = setTimeout(() => {
            handleTimeout(roomId, targetUuid, stateCtx);
        }, 20000);
        return; 
    }

    if (room.gameState === 'playing' && getAlivePlayersCount(roomId) > 1) {
        const currentPlayer = room.players[room.currentTurn];
        if (currentPlayer && !currentPlayer.isDead && !currentPlayer.isSpectator && !currentPlayer.hasLeft) {
            room.timerEndsAt = null; 
            room.turnTimer = setTimeout(() => {
                io.to(currentPlayer.id).emit('showAFKPrompt');
                room.afkTimer = setTimeout(() => {
                    forceKickAFK(roomId, currentPlayer.uuid);
                }, 10000);
            }, 20000);
        }
    } else {
        room.timerEndsAt = null;
    }
}

// --- SOCKETS ---
io.on('connection', (socket) => {
    
    socket.on('checkSession', safe((uuid) => {
        let foundRoomId = null; let foundPlayer = null;
        for (const rId in rooms) { 
            const p = rooms[rId].players.find(pl => pl.uuid === uuid); 
            if (p) { foundRoomId = rId; foundPlayer = p; break; } 
        }
        if (foundRoomId && foundPlayer) {
            foundPlayer.id = socket.id; foundPlayer.isConnected = true;
            if (foundPlayer.hasLeft) {
                foundPlayer.hasLeft = false;
                const room = rooms[foundRoomId];
                if (room.gameState === 'waiting') {
                    foundPlayer.isDead = false; foundPlayer.isSpectator = false;
                    const idx = room.players.indexOf(foundPlayer);
                    if (idx !== -1) {
                        room.players.splice(idx, 1);
                        room.players.push(foundPlayer);
                    }
                } else {
                    foundPlayer.isSpectator = true;
                }
                io.to(foundRoomId).emit('notification', `👋 ${foundPlayer.name} se ha reconectado.`);
            }
            socket.join(foundRoomId); touchRoom(foundRoomId); updateAll(foundRoomId);
        } else { socket.emit('requireLogin'); }
    }));

    socket.on('createRoom', safe((data) => {
        const roomId = Math.random().toString(36).substring(2, 6).toUpperCase(); initRoom(roomId);
        const player = createPlayerObj(socket.id, data.uuid, data.name, true);
        rooms[roomId].scores[data.uuid] = 0; 
        rooms[roomId].players.push(player); socket.join(roomId); 
        socket.emit('roomCreated', { roomId, name: data.name }); 
        updateAll(roomId);
    }));

    socket.on('joinRoom', safe((data) => {
        const roomId = data.roomId.toUpperCase(); const room = rooms[roomId];
        if (!room) { socket.emit('error', 'Sala no encontrada.'); return; }
        touchRoom(roomId);
        const existing = room.players.find(p => p.uuid === data.uuid);
        if (existing) { 
            existing.id = socket.id; existing.name = data.name; existing.isConnected = true; 
            if (existing.hasLeft) {
                existing.hasLeft = false;
                if (room.gameState === 'waiting') {
                    existing.isDead = false; existing.isSpectator = false;
                    const idx = room.players.indexOf(existing);
                    if (idx !== -1) {
                        room.players.splice(idx, 1);
                        room.players.push(existing);
                    }
                } else {
                    existing.isSpectator = true;
                }
                io.to(roomId).emit('notification', `👋 ${existing.name} regresó a la sala.`);
            }
            socket.join(roomId); socket.emit('roomJoined', { roomId }); 
        } else {
            const player = createPlayerObj(socket.id, data.uuid, data.name, (room.players.length === 0));
            player.isSpectator = (room.gameState !== 'waiting');
            if(room.scores[data.uuid] === undefined) room.scores[data.uuid] = 0;
            room.players.push(player); socket.join(roomId); socket.emit('roomJoined', { roomId });
            io.to(roomId).emit('notification', `👋 ${player.name} entró.`);
        }
        updateAll(roomId);
    }));

    socket.on('imHere', safe(() => {
        const roomId = getRoomId(socket); if(!roomId || !rooms[roomId]) return;
        touchRoom(roomId); manageTimers(roomId);
    }));
    
    socket.on('requestSort', safe(() => {
        const roomId = getRoomId(socket); if(!roomId || !rooms[roomId]) return;
        const room = rooms[roomId]; const p = room.players.find(x => x.id === socket.id);
        if(!p) return;
        p.hand.sort((a,b) => {
            const cA = sortColWeights[a.color] || 99; const cB = sortColWeights[b.color] || 99;
            if(cA !== cB) return cA - cB;
            const vA = sortValWeights[a.value] !== undefined ? sortValWeights[a.value] : 99;
            const vB = sortValWeights[b.value] !== undefined ? sortValWeights[b.value] : 99;
            return vA - vB;
        });
        io.to(p.id).emit('handUpdate', p.hand); socket.emit('notification', 'Cartas ordenadas.');
        manageTimers(roomId); 
    }));

    socket.on('kickPlayer', safe((targetId) => {
        const roomId = getRoomId(socket); if(!roomId || !rooms[roomId]) return;
        const room = rooms[roomId]; const admin = room.players.find(p => p.id === socket.id);
        if(admin && admin.isAdmin) {
            const idx = room.players.findIndex(p => p.id === targetId);
            if(idx !== -1) { room.players.splice(idx, 1); updateAll(roomId); io.to(targetId).emit('error', 'Has sido expulsado de la sala.'); }
        }
    }));

    socket.on('requestStart', safe(() => {
        const roomId = getRoomId(socket); if(!roomId || !rooms[roomId]) return;
        const room = rooms[roomId]; if (room.gameState === 'waiting' && room.players.length >= 2) startCountdown(roomId);
    }));

    socket.on('requestLeave', safe(() => {
        const roomId = getRoomId(socket); if(!roomId || !rooms[roomId]) return;
        const room = rooms[roomId];
        const pIndex = room.players.findIndex(p => p.id === socket.id); if (pIndex === -1) return;
        const player = room.players[pIndex];

        const isMyTurn = (room.currentTurn === pIndex);
        const hasPenalty = ((isMyTurn && room.pendingPenalty > 0) || player.personalDebt > 0);
        const inDuel = (['dueling', 'rip_decision', 'penalty_decision', 'animating_penalty', 'animating_rip'].includes(room.gameState) && (room.duelState.attackerId === player.uuid || room.duelState.defenderId === player.uuid));

        if (hasPenalty || inDuel) {
            socket.emit('notification', '🚫 No puedes huir si tienes un castigo, deuda o duelo pendiente.');
            return;
        }

        if (player.isAdmin) { socket.emit('showLeaveAdminPrompt'); } else { socket.emit('showLeaveNormalPrompt'); }
    }));

    socket.on('confirmLeave', safe((choice) => {
        const roomId = getRoomId(socket); if(!roomId || !rooms[roomId]) return;
        const room = rooms[roomId];
        const pIndex = room.players.findIndex(p => p.id === socket.id);
        if (pIndex === -1) return;
        const player = room.players[pIndex];

        if (choice === 'leave_host_end' && player.isAdmin) {
            if (room.gameState === 'waiting') {
                io.to(roomId).emit('roomCancelled');
            } else {
                io.to(roomId).emit('notification', `⚠️ El anfitrión finalizó la partida para todos.`);
                io.to(roomId).emit('gameOver', { winner: 'Partida Cancelada', totalScore: 0, reason: 'cancelled' });
            }
            if (room.actionTimer) clearTimeout(room.actionTimer);
            if (room.turnTimer) clearTimeout(room.turnTimer);
            if (room.afkTimer) clearTimeout(room.afkTimer);
            setTimeout(() => { delete rooms[roomId]; }, 3000);
            return;
        }

        player.isDead = true; player.isSpectator = true; player.hasLeft = true;
        let msg = `🚪 ${player.name} abandonó la partida.`;

        if (player.isAdmin) {
            player.isAdmin = false;
            const nextAdmin = room.players.find(p => !p.isDead && !p.isSpectator && !p.hasLeft);
            if (nextAdmin) {
                nextAdmin.isAdmin = true;
                msg += `\n👑 Ahora ${nextAdmin.name} es el nuevo anfitrión.`;
            }
        }

        socket.leave(roomId); socket.emit('requireLogin');

        if (getAlivePlayersCount(roomId) <= 1) {
            io.to(roomId).emit('notification', msg); 
            checkWinCondition(roomId);
        } else {
            const oldState = room.gameState;
            if (oldState === 'playing' || oldState === 'waiting') {
                room.gameState = 'paused';
                io.to(roomId).emit('gamePaused', { message: msg, duration: 4000 });
                if (room.currentTurn === pIndex && oldState === 'playing') advanceTurn(roomId, 1);
                updateAll(roomId);
                setTimeout(() => { try { if (rooms[roomId]) { room.gameState = oldState; updateAll(roomId); } } catch(e){} }, 4000);
            } else {
                if (room.currentTurn === pIndex) advanceTurn(roomId, 1);
                updateAll(roomId);
            }
        }
    }));

    socket.on('playMultiCards', safe((cardIds) => {
        const roomId = getRoomId(socket); if(!roomId || !rooms[roomId]) return; touchRoom(roomId);
        const room = rooms[roomId]; const pIndex = room.players.findIndex(p => p.id === socket.id); const player = room.players[pIndex];
        if (room.gameState !== 'playing' || pIndex !== room.currentTurn || room.pendingPenalty > 0 || room.librePending) return;
        if (player.personalDebt > 0) { socket.emit('notification', '🚫 Tienes una deuda de cartas. Toca el mazo para pagar primero.'); return; }
        if (!cardIds || cardIds.length < 2) return; 

        let playCards = []; let tempHand = [...player.hand];
        for(let id of cardIds) { const c = tempHand.find(x => x.id === id); if(!c) return; playCards.push(c); }
        const top = room.discardPile.length > 0 ? room.discardPile[room.discardPile.length - 1] : { value: '0', color: 'rojo' };

        const isAll15 = playCards.every(c => c.value === '1 y 1/2');
        if (isAll15) {
            const count = playCards.length;
            if (count !== 2 && count !== 4 && count !== 6) {
                socket.emit('notification', '🚫 Solo puedes agrupar 2, 4 o 6 cartas "1 y 1/2".'); return;
            }
            const targetVal = (count * 1.5).toString();
            if (top.value !== targetVal) {
                socket.emit('notification', `🚫 Coincidencia numérica requerida. Debes arrojarlas sobre un ${targetVal}.`); return;
            }

            const finalColor = playCards[playCards.length - 1].color;
            removeCards(player, cardIds);
            room.discardPile.push(...playCards); 
            room.activeColor = finalColor; 

            io.to(roomId).emit('ladderAnimate', { cards: playCards, playerName: player.name, playerId: player.id });
            io.to(roomId).emit('notification', `✨ ¡COMBO MATEMÁTICO! ${player.name} combinó ${count} cartas "1 y 1/2".`); 
            io.to(roomId).emit('playSound', 'divine'); 
            checkUnoCheck(roomId, player);
            
            if(player.hand.length === 0) { initiateRoundEnd(roomId, player); } else { advanceTurn(roomId, 1); updateAll(roomId); }
            return;
        }

        const firstColor = playCards[0].color;
        if(firstColor === 'negro') { socket.emit('notification', '🚫 Escaleras solo con color.'); return; }
        if(!playCards.every(c => c.color === firstColor)) { socket.emit('notification', '🚫 Mismo color requerido para escalera.'); return; }
        
        const indices = playCards.map(c => ladderOrder.indexOf(c.value));
        if(indices.includes(-1)) { socket.emit('notification', '🚫 Solo números y 1y1/2 en escaleras.'); return; }
        
        const sortedIndices = [...indices].sort((a,b) => a-b);
        let isInternallyConsecutive = true;
        for(let i = 0; i < sortedIndices.length - 1; i++) { if(sortedIndices[i+1] !== sortedIndices[i] + 1) { isInternallyConsecutive = false; break; } }
        if(!isInternallyConsecutive) { socket.emit('notification', '🚫 No son consecutivas.'); return; }

        let isValidPlay = false;

        if (playCards.length === 2) {
            const topIdx = ladderOrder.indexOf(top.value);
            if (topIdx !== -1 && top.color === firstColor) {
                const min = sortedIndices[0]; const max = sortedIndices[1];
                const isAsc = (min === topIdx + 1 && max === topIdx + 2);
                const isDesc = (max === topIdx - 1 && min === topIdx - 2);
                if (isAsc || isDesc) {
                    isValidPlay = true;
                    if (isAsc) playCards.sort((a,b) => ladderOrder.indexOf(a.value) - ladderOrder.indexOf(b.value));
                    if (isDesc) playCards.sort((a,b) => ladderOrder.indexOf(b.value) - ladderOrder.indexOf(a.value));
                } else { socket.emit('notification', '🚫 No conectan con la mesa.'); return; }
            } else { socket.emit('notification', '🚫 Color/Número mesa inválido.'); return; }
        } else {
             let colorMatch = (firstColor === room.activeColor);
             let valueMatch = false;
             if (!colorMatch && playCards.some(c => c.value === top.value)) valueMatch = true;
             if (colorMatch || valueMatch) {
                 isValidPlay = true;
                 playCards.sort((a,b) => ladderOrder.indexOf(a.value) - ladderOrder.indexOf(b.value));
             } else { socket.emit('notification', '🚫 Color no coincide.'); return; }
        }

        if (isValidPlay) {
            removeCards(player, cardIds);
            room.discardPile.push(...playCards); room.activeColor = firstColor;
            io.to(roomId).emit('ladderAnimate', { cards: playCards, playerName: player.name, playerId: player.id });
            io.to(roomId).emit('notification', `🪜 ¡ESCALERA de ${player.name}!`); io.to(roomId).emit('playSound', 'soft');
            checkUnoCheck(roomId, player);
            if(player.hand.length === 0) { initiateRoundEnd(roomId, player); } else { advanceTurn(roomId, 1); updateAll(roomId); }
        }
    }));

    socket.on('confirmReviveSingle', safe((data) => {
        const roomId = getRoomId(socket); if(!roomId || !rooms[roomId]) return; touchRoom(roomId);
        const room = rooms[roomId]; const pIndex = room.players.findIndex(p => p.id === socket.id); const player = room.players[pIndex];
        if (room.gameState !== 'playing' || pIndex !== room.currentTurn) return;
        
        let cardIndex = player.hand.findIndex(c => c.id === data.cardId); 
        let card = (cardIndex !== -1) ? player.hand[cardIndex] : null;

        if (!card) {
            const top = room.discardPile.length > 0 ? room.discardPile[room.discardPile.length - 1] : null;
            if (top && top.id === data.cardId) card = top;
        }
        if(!card) return;

        const deadPlayers = room.players.filter(p => p.isDead && !p.hasLeft);

        if(data.confirmed && deadPlayers.length === 1) {
             const target = deadPlayers[0]; target.isDead = false; target.isSpectator = false;
             io.to(roomId).emit('playerRevived', { savior: player.name, revived: target.name }); io.to(roomId).emit('playSound', 'divine');
             
             if (data.chosenColor) room.activeColor = data.chosenColor; else if (!room.activeColor) room.activeColor = 'rojo';
             if (player.hand.length === 0) { initiateRoundEnd(roomId, player); return; }
             checkUnoCheck(roomId, player); advanceTurn(roomId, 1); updateAll(roomId);
        } else {
             if (cardIndex === -1) { advanceTurn(roomId, 1); updateAll(roomId); }
        }
    }));

    socket.on('playLibreInitial', safe((cardId) => {
        const roomId = getRoomId(socket); if(!roomId || !rooms[roomId]) return; touchRoom(roomId);
        const room = rooms[roomId]; 
        const pIndex = room.players.findIndex(p => p.id === socket.id); if (pIndex === -1) return;
        const player = room.players[pIndex]; 
        
        if (room.gameState !== 'playing' && room.gameState !== 'penalty_decision') return;
        if (player.personalDebt > 0) return;
        
        const cardIndex = player.hand.findIndex(c => c.id === cardId);
        if(cardIndex === -1) return;
        const card = player.hand[cardIndex];
        
        if (card.value !== 'LIBRE') return;

        player.hand.splice(cardIndex, 1);
        room.discardPile.push(card);
        room.activeColor = 'negro'; 
        room.librePending = player.uuid;
        
        io.to(roomId).emit('animateCard', { card: card, playerId: player.id });
        io.to(roomId).emit('playSound', 'wild');
        io.to(roomId).emit('notification', `🕊️ ${player.name} arrojó LIBRE ALBEDRÍO y está decidiendo...`);
        
        updateAll(roomId);
        socket.emit('startLibreLogic', card.id);
    }));

    socket.on('playCard', safe((cardId, chosenColor, reviveTargetId, libreContext) => {
        const roomId = getRoomId(socket); if(!roomId || !rooms[roomId]) return; touchRoom(roomId);
        const room = rooms[roomId]; 
        if (room.gameState !== 'playing' && room.gameState !== 'penalty_decision') return;
        
        const pIndex = room.players.findIndex(p => p.id === socket.id); if (pIndex === -1) return;
        const player = room.players[pIndex]; if (player.isDead || player.isSpectator || player.hasLeft) return;
        
        if (player.personalDebt > 0) {
            socket.emit('notification', '🚫 Tienes una deuda de cartas. Toca el mazo rojo.');
            return;
        }

        if (room.pendingPenalty > 0 && room.resumeTurnFrom !== null && room.resumeTurnFrom !== undefined) {
            socket.emit('notification', '🚫 Castigo ineludible. Toca el mazo rojo.');
            return;
        }

        let isLibreDiscard = false;
        let cardIndex = -1;
        let card = null;

        if (libreContext) {
            const gIdx = player.hand.findIndex(c => c.id === libreContext.giftId);
            const dIdx = player.hand.findIndex(c => c.id === libreContext.discardId);
            const target = room.players.find(p => p.id === libreContext.targetId);
            if (gIdx === -1 || dIdx === -1 || !target) return;

            room.pendingPenalty = 0; room.pendingSkip = 0;
            room.librePending = null;

            const giftCard = player.hand.splice(gIdx, 1)[0];
            target.hand.push(giftCard);
            io.to(target.id).emit('handUpdate', target.hand);
            
            const realDIdx = player.hand.findIndex(c => c.id === libreContext.discardId);
            card = player.hand.splice(realDIdx, 1)[0];
            room.discardPile.push(card);
            
            io.to(roomId).emit('animateCard', { card: card, playerId: player.id });
            io.to(roomId).emit('playSound', 'soft');
            
            isLibreDiscard = true;
            cardIndex = -2;
            
            if (player.hand.length === 0) { 
                 io.to(roomId).emit('notification', `🕊️ ¡JUGADA MAESTRA! ${player.name} regaló una carta y ganó.`);
            } else {
                 io.to(roomId).emit('notification', `🕊️ ${player.name} regaló una carta y descartó.`);
            }
            
            if (card.color === 'negro' && chosenColor) room.activeColor = chosenColor; 
            else if (card.color !== 'negro') room.activeColor = card.color;

            checkUnoCheck(roomId, player); 
            applyCardEffect(roomId, player, card, chosenColor);
            return;
        }

        cardIndex = player.hand.findIndex(c => c.id === cardId); 
        card = (cardIndex !== -1) ? player.hand[cardIndex] : null;
        
        if (!card && reviveTargetId) {
             const topAux = room.discardPile.length > 0 ? room.discardPile[room.discardPile.length - 1] : null; 
             if(topAux && topAux.value === 'GRACIA') card = topAux;
        }
        if (!card) return;
        const top = room.discardPile.length > 0 ? room.discardPile[room.discardPile.length - 1] : { value: '0', color: 'rojo' };

        if (room.gameState === 'penalty_decision') {
            if (pIndex !== room.currentTurn) return;
            if (card.value === 'GRACIA') {
                player.hand.splice(cardIndex, 1); room.discardPile.push(card);
                io.to(roomId).emit('animateCard', { card: card, playerId: player.id });
                io.to(roomId).emit('playSound', 'divine');
                if (chosenColor) room.activeColor = chosenColor; else if (!room.activeColor) room.activeColor = 'rojo';
                io.to(roomId).emit('showDivine', `${player.name} anuló el castigo`);
                room.pendingPenalty = 0; room.pendingSkip = 0; room.gameState = 'playing'; 
                checkUnoCheck(roomId, player);
                if (player.hand.length === 0) { initiateRoundEnd(roomId, player); return; }
                advanceTurn(roomId, 1); updateAll(roomId); return;
            } else {
                socket.emit('notification', '🚫 Solo puedes usar GRACIA DIVINA o batirte a duelo.'); return; 
            }
        }

        if (cardIndex !== -1) {
            if (player.hand.length === 1) {
                const isStrictNumber = /^[0-9]$/.test(card.value);
                const isUnoYMedio = card.value === '1 y 1/2';
                const isGracia = card.value === 'GRACIA';
                if (!isStrictNumber && !isUnoYMedio && !isGracia) { socket.emit('notification', '🚫 Última carta: Solo Números o Gracia.'); return; }
            }

            if (top.color !== 'negro') room.activeColor = top.color;
            
            let isSaff = false;
            if (pIndex !== room.currentTurn) {
                const isNumericSaff = /^[0-9]$/.test(card.value) || card.value === '1 y 1/2';
                if (isNumericSaff && card.color !== 'negro' && card.value === top.value && card.color === top.color) {
                    if (room.pendingPenalty > 0 || room.librePending) return; 
                    if (player.hand.length === 1) { socket.emit('notification', '🚫 Prohibido ganar con SAFF.'); return; }
                    isSaff = true; room.currentTurn = pIndex; room.pendingPenalty = 0;
                    io.to(roomId).emit('notification', `⚡ ¡${player.name} robó el turno con S.A.F.F.!`); io.to(roomId).emit('playSound', 'saff');
                } else { return; }
            }

            if (pIndex === room.currentTurn && !isSaff) {
                if (room.pendingPenalty > 0) { 
                    if (card.value === 'SALTEO SUPREMO') { socket.emit('notification', '🚫 No puedes usar SS aquí.'); return; }
                    if (card.value === 'GRACIA') { } else {
                        const getVal = (v) => { if (v === '+2') return 2; if (v === '+4') return 4; if (v === '+12') return 12; return 0; };
                        const cardVal = getVal(card.value); const topVal = getVal(top.value);
                        if (cardVal === 0 || cardVal < topVal) { socket.emit('notification', `🚫 Castigo inválido.`); return; }
                    }
                } else { 
                    let valid = (card.color === 'negro' || card.value === 'GRACIA' || card.color === room.activeColor || card.value === top.value);
                    if (!valid) { socket.emit('notification', `❌ Carta inválida.`); return; }
                }
            }
        }

        if (card.value === 'GRACIA') {
            const deadPlayers = room.players.filter(p => p.isDead && !p.hasLeft);
            if (room.pendingPenalty > 0 && cardIndex !== -1) {
                player.hand.splice(cardIndex, 1); room.discardPile.push(card); 
                io.to(roomId).emit('animateCard', { card: card, playerId: player.id });
                io.to(roomId).emit('playSound', 'divine');
                if (chosenColor) room.activeColor = chosenColor; else if (!room.activeColor) room.activeColor = 'rojo';
                io.to(roomId).emit('showDivine', `${player.name} anuló el castigo`); 
                room.pendingPenalty = 0; room.pendingSkip = 0; checkUnoCheck(roomId, player);
                if (player.hand.length === 0) { initiateRoundEnd(roomId, player); return; }
                advanceTurn(roomId, 1); updateAll(roomId); return;
            }
            if (deadPlayers.length > 0) {
                if(deadPlayers.length === 1) { socket.emit('askReviveConfirmation', { name: deadPlayers[0].name, cardId: card.id }); return; } 
                else {
                    if (!reviveTargetId) {
                        const zombieList = deadPlayers.map(z => ({ id: z.id, name: z.name, count: z.hand.length })); socket.emit('askReviveTarget', zombieList); return; 
                    } else {
                        const target = room.players.find(p => p.id === reviveTargetId && p.isDead && !p.hasLeft);
                        if (target) { 
                            target.isDead = false; target.isSpectator = false; io.to(roomId).emit('playerRevived', { savior: player.name, revived: target.name });
                            if(cardIndex !== -1) {
                                player.hand.splice(cardIndex, 1); room.discardPile.push(card); 
                                io.to(roomId).emit('animateCard', { card: card, playerId: player.id });
                                if (chosenColor) room.activeColor = chosenColor; else if (!room.activeColor) room.activeColor = 'rojo';
                            }
                            io.to(roomId).emit('playSound', 'divine'); checkUnoCheck(roomId, player);
                            if (player.hand.length === 0) { initiateRoundEnd(roomId, player); return; }
                            advanceTurn(roomId, 1); updateAll(roomId); return;
                        }
                    }
                }
            } else { 
                if (cardIndex !== -1) {
                     io.to(roomId).emit('notification', `❤️ ${player.name} usó Gracia.`); 
                     player.hand.splice(cardIndex, 1); room.discardPile.push(card); 
                     io.to(roomId).emit('animateCard', { card: card, playerId: player.id });
                     io.to(roomId).emit('playSound', 'divine'); 
                     if (chosenColor) room.activeColor = chosenColor; else if (!room.activeColor) room.activeColor = 'rojo';
                     checkUnoCheck(roomId, player);
                     if (player.hand.length === 0) { initiateRoundEnd(roomId, player); return; }
                     advanceTurn(roomId, 1); updateAll(roomId); return;
                }
            }
        }

        if (cardIndex === -1) return; 

        player.hand.splice(cardIndex, 1); room.discardPile.push(card);
        io.to(roomId).emit('animateCard', { card: card, playerId: player.id });
        if (card.color === 'negro' && chosenColor) room.activeColor = chosenColor; else if (card.color !== 'negro') room.activeColor = card.color;

        checkUnoCheck(roomId, player); 
        applyCardEffect(roomId, player, card, chosenColor);
    }));

    socket.on('draw', safe(() => {
        const roomId = getRoomId(socket); if(!roomId || !rooms[roomId]) return; touchRoom(roomId);
        const room = rooms[roomId]; if (room.gameState !== 'playing') return;
        const pIndex = room.players.findIndex(p => p.id === socket.id);
        if (pIndex === -1 || room.players[pIndex].isDead || room.players[pIndex].isSpectator || room.librePending) return;
        
        if (room.players[pIndex].personalDebt > 0) {
            drawCards(roomId, pIndex, 1); 
            room.players[pIndex].personalDebt--; 
            io.to(roomId).emit('cardDrawnEffect', { playerName: room.players[pIndex].name });
            io.to(roomId).emit('playSound', 'soft');
            if (room.players[pIndex].personalDebt === 0) {
                io.to(roomId).emit('notification', `✅ ${room.players[pIndex].name} saldó su deuda.`);
            }
            updateAll(roomId); return;
        }

        if (pIndex === room.currentTurn) {
            if (room.pendingPenalty > 0) {
                drawCards(roomId, pIndex, 1); room.pendingPenalty--; io.to(roomId).emit('playSound', 'soft');
                io.to(roomId).emit('cardDrawnEffect', { playerName: room.players[pIndex].name });
                
                if (room.pendingPenalty > 0) { updateAll(roomId); } else { 
                    if (room.pendingSkip > 0) { io.to(roomId).emit('notification', `⛔ ¡${room.players[pIndex].name} PIERDE ${room.pendingSkip} TURNOS!`); room.players[pIndex].missedTurns += room.pendingSkip; room.pendingSkip = 0; } 
                    else { io.to(roomId).emit('notification', `✅ Fin del castigo.`); }
                    if (room.resumeTurnFrom !== undefined && room.resumeTurnFrom !== null) { room.currentTurn = room.resumeTurnFrom; room.resumeTurnFrom = null; }
                    advanceTurn(roomId, 1); updateAll(roomId); 
                }
            } else {
                if (!room.players[pIndex].hasDrawn) { 
                    drawCards(roomId, pIndex, 1); room.players[pIndex].hasDrawn = true; 
                    room.players[pIndex].saidUno = false; room.players[pIndex].lastOneCardTime = 0;
                    io.to(roomId).emit('playSound', 'soft'); 
                    io.to(roomId).emit('cardDrawnEffect', { playerName: room.players[pIndex].name });
                    updateAll(roomId); 
                } else { socket.emit('notification', 'Ya robaste.'); }
            }
        }
    }));

    socket.on('passTurn', safe(() => {
        const roomId = getRoomId(socket); if(!roomId || !rooms[roomId]) return; touchRoom(roomId);
        const room = rooms[roomId]; if (room.gameState !== 'playing') return;
        const pIndex = room.players.findIndex(p => p.id === socket.id);
        if (pIndex === room.currentTurn && room.players[pIndex].hasDrawn && room.pendingPenalty === 0 && room.players[pIndex].personalDebt === 0 && !room.librePending) { advanceTurn(roomId, 1); updateAll(roomId); }
    }));

    socket.on('ripDecision', safe((d) => {
        const roomId = getRoomId(socket); if(!roomId || !rooms[roomId]) return; touchRoom(roomId);
        const room = rooms[roomId]; if (room.gameState !== 'rip_decision' && room.gameState !== 'penalty_decision') return;
        const myUUID = room.players.find(x => x.id === socket.id)?.uuid;
        if (myUUID !== room.duelState.defenderId) return;

        if (d === 'surrender') { 
            if(room.duelState.type === 'rip') { 
                eliminatePlayer(roomId, room.duelState.defenderId); 
                checkWinCondition(roomId); 
                if (rooms[roomId] && rooms[roomId].gameState !== 'game_over') { room.gameState = 'playing'; room.currentTurn = room.players.findIndex(p => p.uuid === room.duelState.attackerId); advanceTurn(roomId, 1); updateAll(roomId); }
            }
        }
        else if (d === 'accept_penalty') { const p = room.players.find(x => x.uuid === myUUID); io.to(roomId).emit('notification', `${p.name} aceptó el castigo.`); room.gameState = 'playing'; updateAll(roomId); }
        else { io.to(roomId).emit('playSound', 'bell'); room.gameState = 'dueling'; room.duelState.narrative = `⚔️ ¡Duelo iniciado! Turno de ataque...`; room.duelState.turn = room.duelState.attackerId; updateAll(roomId); }
    }));

    socket.on('duelPick', safe((c) => {
        const roomId = getRoomId(socket); if(!roomId || !rooms[roomId]) return; touchRoom(roomId);
        const room = rooms[roomId]; if (room.gameState !== 'dueling') return;
        const myUUID = room.players.find(x => x.id === socket.id)?.uuid;
        if (myUUID !== room.duelState.turn) return;

        if (myUUID === room.duelState.attackerId) { room.duelState.attackerChoice = c; room.duelState.turn = room.duelState.defenderId; room.duelState.narrative = `⚔️ Turno de defensa de ${room.duelState.defenderName}...`; updateAll(roomId); } 
        else if (myUUID === room.duelState.defenderId) { room.duelState.defenderChoice = c; room.duelState.narrative = `¡IMPACTO INMINENTE!`; io.to(roomId).emit('duelClash', { attName: room.duelState.attackerName, defName: room.duelState.defenderName, attChoice: room.duelState.attackerChoice, defChoice: room.duelState.defenderChoice }); io.to(roomId).emit('playSound', 'attack'); setTimeout(() => { resolveDuelRound(roomId, false); }, 3500); }
    }));
    
    socket.on('sayUno', safe(() => {
        const roomId = getRoomId(socket); if(!roomId) return; const room = rooms[roomId]; if (room.gameState !== 'playing') return;
        const p = room.players.find(x => x.id === socket.id);
        if(p && p.hand.length === 1) { p.saidUno = true; io.to(roomId).emit('notification', `📢 ¡${p.name} gritó "UNO y 1/2"!`); io.to(roomId).emit('playSound', 'uno'); manageTimers(roomId); }
    }));

    socket.on('reportUno', safe((targetId) => {
        const roomId = getRoomId(socket); if(!roomId) return; const room = rooms[roomId]; if (room.gameState !== 'playing') return;
        const accuser = room.players.find(x => x.id === socket.id); const target = room.players.find(x => x.id === targetId);
        if(!target || target.hand.length !== 1 || target.saidUno) { socket.emit('notification', '🚫 Denuncia falsa.'); return; }
        const timeDiff = Date.now() - target.lastOneCardTime;
        if (timeDiff < 2000) { socket.emit('notification', '¡Espera!'); return; }
        target.personalDebt += 2; target.saidUno = true; io.to(roomId).emit('notification', `🚨 ¡${accuser.name} denunció a ${target.name}!`); updateAll(roomId);
    }));

    socket.on('sendChat', safe((text) => { 
        const roomId = getRoomId(socket); if(!roomId || !rooms[roomId]) return;
        const room = rooms[roomId]; const p = room.players.find(x => x.id === socket.id); 
        if (p) { const msg = { name: p.name, text }; room.chatHistory.push(msg); if(room.chatHistory.length > 50) room.chatHistory.shift(); io.to(roomId).emit('chatMessage', msg); manageTimers(roomId); }
    }));

    socket.on('disconnect', () => { try { const roomId = getRoomId(socket); if (roomId && rooms[roomId]) { const room = rooms[roomId]; const p = room.players.find(pl => pl.id === socket.id); if(p) { p.isConnected = false; updateAll(roomId); } } } catch(e) { console.error(e); } });
});

// --- HELPERS SERVIDOR ---

function createPlayerObj(socketId, uuid, name, isAdmin) { return { id: socketId, uuid, name: name.substring(0, 12), hand: [], hasDrawn: false, isSpectator: false, isDead: false, isAdmin, isConnected: true, saidUno: false, lastOneCardTime: 0, missedTurns: 0, hasLeft: false, personalDebt: 0 }; }
function checkUnoCheck(roomId, player) { if (player.hand.length === 1) { player.lastOneCardTime = Date.now(); player.saidUno = false; } else { player.saidUno = false; player.lastOneCardTime = 0; } }
function removeCards(player, ids) { ids.forEach(id => { const idx = player.hand.findIndex(c => c.id === id); if(idx !== -1) player.hand.splice(idx, 1); }); }

function applyCardEffect(roomId, player, card, chosenColor) {
    const room = rooms[roomId]; let steps = 1;
    if (card.value === 'R') { if (getAlivePlayersCount(roomId) === 2) steps = 2; else room.direction *= -1; }
    if (card.value === 'X') steps = 2;
    if (['+2', '+4', '+12', 'SALTEO SUPREMO'].includes(card.value)) {
        let val = 0; let skips = 0; if(card.value === '+2') val=2; if(card.value === '+4') val=4; if(card.value === '+12') val=12; if(card.value === 'SALTEO SUPREMO') { val=4; skips=4; }
        room.pendingPenalty += val; room.pendingSkip += skips; io.to(roomId).emit('notification', `💥 ¡Total: ${room.pendingPenalty}`); io.to(roomId).emit('playSound', 'attack'); if (val > 4) io.to(roomId).emit('shakeScreen');
        if (['+12', 'SALTEO SUPREMO'].includes(card.value)) {
            const nextPIdx = getNextPlayerIndex(roomId, 1); const victim = room.players[nextPIdx]; room.gameState = 'animating_penalty';
            room.duelState = { attackerId: player.uuid, defenderId: victim.uuid, attackerName: player.name, defenderName: victim.name, round: 1, scoreAttacker: 0, scoreDefender: 0, attackerChoice: null, defenderChoice: null, history: [], turn: player.uuid, narrative: `⚔️ ¡Duelo?`, type: 'penalty', originalPenalty: room.pendingPenalty, originalSkip: room.pendingSkip, triggerCard: card.value };
            room.currentTurn = nextPIdx; updateAll(roomId); 
            setTimeout(() => { if(rooms[roomId] && rooms[roomId].gameState === 'animating_penalty') { rooms[roomId].gameState = 'penalty_decision'; updateAll(roomId); } }, 1200); return;
        }
        advanceTurn(roomId, 1); updateAll(roomId); return; 
    }
    if (card.value === 'RIP') {
        if (getAlivePlayersCount(roomId) < 2) { advanceTurn(roomId, 1); updateAll(roomId); return; }
        const victimIdx = getNextPlayerIndex(roomId, 1); const victim = room.players[victimIdx]; io.to(roomId).emit('playSound', 'rip'); room.gameState = 'animating_rip';
        room.duelState = { attackerId: player.uuid, defenderId: victim.uuid, attackerName: player.name, defenderName: victim.name, round: 1, scoreAttacker: 0, scoreDefender: 0, attackerChoice: null, defenderChoice: null, history: [], turn: player.uuid, narrative: `💀 RIP!`, type: 'rip', originalPenalty: 0, originalSkip: 0, triggerCard: 'RIP' };
        updateAll(roomId); setTimeout(() => { if(rooms[roomId] && rooms[roomId].gameState === 'animating_rip') { rooms[roomId].gameState = 'rip_decision'; updateAll(roomId); } }, 1200); return;
    }
    if (card.color === 'negro') io.to(roomId).emit('playSound', 'wild'); else io.to(roomId).emit('playSound', 'soft');
    if (player.hand.length === 0) initiateRoundEnd(roomId, player); else { advanceTurn(roomId, steps); updateAll(roomId); }
}

function resolveDuelRound(roomId, isTimeout = false) {
    try {
        const room = rooms[roomId]; if (!room) return;
        let att = room.duelState.attackerChoice; let def = room.duelState.defenderChoice; let winner = 'tie';
        if (isTimeout) { if (!att) { winner = 'defender'; } else if (!def) { winner = 'attacker'; } } else {
            if ((att == 'fuego' && def == 'hielo') || (att == 'hielo' && def == 'agua') || (att == 'agua' && def == 'fuego')) winner = 'attacker';
            else if ((def == 'fuego' && att == 'hielo') || (def == 'hielo' && att == 'agua') || (def == 'agua' && att == 'fuego')) winner = 'defender';
            room.duelState.narrative = getDuelNarrative(room.duelState.attackerName, room.duelState.defenderName, att, def);
        }
        if (winner == 'attacker') room.duelState.scoreAttacker++; else if (winner == 'defender') room.duelState.scoreDefender++;
        room.duelState.history.push({ round: room.duelState.round, att: att || 'timeout', def: def || 'timeout', winnerName: winner === 'tie' ? 'Empate' : (winner === 'attacker' ? room.duelState.attackerName : room.duelState.defenderName) });
        room.duelState.attackerChoice = null; room.duelState.defenderChoice = null; room.duelState.turn = room.duelState.attackerId; io.to(roomId).emit('playSound', 'soft');
        if (room.duelState.scoreAttacker >= 2 || room.duelState.scoreDefender >= 2) { setTimeout(() => finalizeDuel(roomId), 2500); } 
        else { setTimeout(() => { try { if(rooms[roomId]) { rooms[roomId].duelState.round++; rooms[roomId].duelState.narrative = `Ronda ${rooms[roomId].duelState.round}...`; updateAll(roomId); } } catch(e){} }, 3000); }
        updateAll(roomId); 
    } catch (e) { console.error(e); }
}

function finalizeDuel(roomId) {
    try {
        const room = rooms[roomId]; if (!room) return;
        const att = room.players.find(p => p.uuid === room.duelState.attackerId); const def = room.players.find(p => p.uuid === room.duelState.defenderId);
        if (!att || !def) { room.gameState = 'playing'; updateAll(roomId); return; }
        const attWins = room.duelState.scoreAttacker > room.duelState.scoreDefender; const isPenaltyDuel = room.duelState.type === 'penalty';
        if (attWins) { io.to(roomId).emit('notification', `💀 Gana ${att.name}.`); 
            if (!isPenaltyDuel) { eliminatePlayer(roomId, def.uuid); checkWinCondition(roomId); if (rooms[roomId] && rooms[roomId].gameState !== 'game_over' && rooms[roomId].gameState !== 'round_over') { room.gameState = 'playing'; room.currentTurn = room.players.indexOf(att); advanceTurn(roomId, 1); updateAll(roomId); } } 
            else { room.pendingPenalty += 4; room.gameState = 'playing'; updateAll(roomId); }
        } else { io.to(roomId).emit('notification', `🛡️ Gana ${def.name}.`);
            if (!isPenaltyDuel) { room.pendingPenalty = 4; room.pendingSkip = 0; room.currentTurn = room.players.indexOf(att); room.resumeTurnFrom = room.players.indexOf(def); room.gameState = 'playing'; updateAll(roomId); } 
            else { room.pendingPenalty = 0; room.pendingSkip = 0; room.players.forEach(p => p.hasDrawn = false); room.currentTurn = room.players.indexOf(att); room.pendingPenalty = 4; room.pendingSkip = 0; room.resumeTurnFrom = room.players.indexOf(def); room.gameState = 'playing'; updateAll(roomId); }
        }
    } catch (e) { console.error(e); }
}

function eliminatePlayer(roomId, uuid) { const room = rooms[roomId]; if(!room) return; const p = room.players.find(p => p.uuid === uuid); if (p) { p.isDead = true; p.isSpectator = true; p.personalDebt = 0; } }
function getAlivePlayersCount(roomId) { const room = rooms[roomId]; if(!room) return 0; return room.players.filter(p => !p.isDead && !p.isSpectator && !p.hasLeft).length; }
function getNextPlayerIndex(roomId, step) { const room = rooms[roomId]; let current = room.currentTurn; for(let i=0; i<room.players.length; i++) { current = (current + room.direction + room.players.length) % room.players.length; if(!room.players[current].isDead && !room.players[current].isSpectator && !room.players[current].hasLeft) return current; } return current; }
function advanceTurn(roomId, steps) { const room = rooms[roomId]; if (!room || room.players.length === 0 || getAlivePlayersCount(roomId) <= 1) return; room.players.forEach(p => p.hasDrawn = false); let safeLoop = 0; while (steps > 0 && safeLoop < 100) { safeLoop++; room.currentTurn = (room.currentTurn + room.direction + room.players.length) % room.players.length; let cp = room.players[room.currentTurn]; if (!cp.isDead && !cp.isSpectator && !cp.hasLeft) { if (cp.missedTurns > 0) { cp.missedTurns--; io.to(roomId).emit('notification', `⏭️ Salteado.`); } else { steps--; } } } }

function startCountdown(roomId) {
    const room = rooms[roomId]; if (!room || room.players.length < 2) return;
    room.gameState = 'counting'; room.resumeTurnFrom = null; createDeck(roomId);
    let safeCard = room.deck.pop(); let loopCount = 0;
    while (['+2','+4','+12','R','X','RIP','GRACIA','LIBRE','SALTEO SUPREMO'].includes(safeCard.value) || safeCard.color === 'negro') { loopCount++; if (loopCount > 50) break; room.deck.unshift(safeCard); for (let i = room.deck.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [room.deck[i], room.deck[j]] = [room.deck[j], room.deck[i]]; } safeCard = room.deck.pop(); }
    room.discardPile = [safeCard]; room.activeColor = safeCard.color === 'negro' ? 'rojo' : safeCard.color; 
    let nextStarter = room.roundStarterIndex % room.players.length; let safeLoop = 0;
    while (room.players[nextStarter] && (!room.players[nextStarter].isConnected || room.players[nextStarter].isSpectator || room.players[nextStarter].hasLeft) && safeLoop < room.players.length) { nextStarter = (nextStarter + 1) % room.players.length; safeLoop++; }
    room.roundStarterIndex = nextStarter; room.currentTurn = room.roundStarterIndex; room.direction = 1; room.pendingPenalty = 0; room.pendingSkip = 0; room.librePending = null;
    room.players.forEach(p => { if(p.hasLeft) return; p.hand = []; p.hasDrawn = false; p.isDead = false; p.saidUno = false; p.missedTurns = 0; p.personalDebt = 0; if(room.gameState !== 'waiting') p.isSpectator = false; if (!p.isSpectator) { for (let i = 0; i < 7; i++) drawCards(roomId, room.players.indexOf(p), 1); } });
    io.to(roomId).emit('countdownTick', 3); let count = 3;
    room.countdownInterval = setInterval(() => { if (!rooms[roomId]) return clearInterval(room.countdownInterval); io.to(roomId).emit('countdownTick', count); io.to(roomId).emit('playSound', 'soft'); if (count <= 0) { clearInterval(room.countdownInterval); room.gameState = 'playing'; io.to(roomId).emit('playSound', 'start'); updateAll(roomId); io.to(roomId).emit('roundStarted', { round: room.roundCount, starterName: room.players[room.currentTurn].name }); } count--; }, 1000);
}

function drawCards(roomId, pid, n) { const room = rooms[roomId]; for (let i = 0; i < n; i++) { if (room.deck.length === 0) recycleDeck(roomId); if (room.deck.length > 0) room.players[pid].hand.push(room.deck.pop()); } checkUnoCheck(roomId, room.players[pid]); }
function initiateRoundEnd(roomId, winner) { const room = rooms[roomId]; if(!room) return; room.gameState = 'round_ending'; updateAll(roomId); setTimeout(() => { if(rooms[roomId]) calculateAndFinishRound(roomId, winner); }, 1000); }

function calculateAndFinishRound(roomId, winner) {
    try {
        const room = rooms[roomId]; if(!room) return;
        let pointsAccumulated = 0; let losersDetails = []; const lastCard = room.discardPile.length > 0 ? room.discardPile[room.discardPile.length - 1] : null; let bonus = 0; if (lastCard && lastCard.value === 'GRACIA') bonus = 50;
        room.players.forEach(p => { if (p.uuid !== winner.uuid && !p.isSpectator && !p.hasLeft) { const hasGrace = p.hand.some(c => c.value === 'GRACIA'); let pPoints = 0; if (!hasGrace) { pPoints = p.hand.reduce((acc, c) => acc + getCardPoints(c), 0); } if(pPoints > 0) { pointsAccumulated += pPoints; losersDetails.push({ name: p.name, points: pPoints }); } } });
        pointsAccumulated += bonus; if(bonus > 0) losersDetails.push({ name: "BONUS Gracia", points: 50 });
        if(room.scores[winner.uuid] === undefined) room.scores[winner.uuid] = 0; room.scores[winner.uuid] += pointsAccumulated; const winnerTotal = room.scores[winner.uuid];
        if (winnerTotal >= 800) { room.gameState = 'waiting'; io.to(roomId).emit('gameOver', { winner: winner.name, totalScore: winnerTotal }); io.to(roomId).emit('playSound', 'win'); delete rooms[roomId]; } 
        else { room.gameState = 'round_over'; room.roundCount++; const leaderboard = Object.keys(room.scores).map(uid => { const pl = room.players.find(x => x.uuid === uid && !x.hasLeft); if(pl) return { name: pl.name, score: room.scores[uid] }; return null; }).filter(x=>x).sort((a,b) => b.score - a.score); io.to(roomId).emit('roundOver', { winner: winner.name, roundPoints: pointsAccumulated, losersDetails: losersDetails, leaderboard: leaderboard, winnerTotal: winnerTotal }); io.to(roomId).emit('playSound', 'win'); setTimeout(() => { try { if(rooms[roomId]) resetRound(roomId); } catch(e){} }, (losersDetails.length * 1500) + 10000); }
    } catch(e) { console.error(e); try { if(rooms[roomId]) resetRound(roomId); } catch(err){} }
}

function resetRound(roomId) {
    try {
        const room = rooms[roomId]; if(!room) return; room.roundStarterIndex = (room.roundStarterIndex + 1) % room.players.length;
        let nextStarter = room.roundStarterIndex; let safeLoop = 0;
        while (room.players[nextStarter] && (!room.players[nextStarter].isConnected || room.players[nextStarter].isSpectator || room.players[nextStarter].hasLeft) && safeLoop < room.players.length) { nextStarter = (nextStarter + 1) % room.players.length; safeLoop++; }
        room.roundStarterIndex = nextStarter; startCountdown(roomId);
    } catch (e) { console.error(e); }
}

function checkWinCondition(roomId) {
    const room = rooms[roomId]; if (!room || room.gameState === 'waiting') return;
    const presentPlayers = room.players.filter(p => !p.isSpectator && !p.hasLeft); const alivePlayers = presentPlayers.filter(p => !p.isDead);
    if (presentPlayers.length <= 1) { const winner = presentPlayers[0] || room.players.find(p => !p.hasLeft); if (winner) { io.to(roomId).emit('gameOver', { winner: winner.name, totalScore: room.scores[winner.uuid] || 0, reason: 'desertion' }); delete rooms[roomId]; } } 
    else if (alivePlayers.length === 1) { initiateRoundEnd(roomId, alivePlayers[0]); }
}

function updateAll(roomId) {
    try {
        const room = rooms[roomId]; if(!room) return;
        const reportablePlayers = room.players.filter(p => !p.isDead && !p.isSpectator && !p.hasLeft && p.hand.length === 1 && !p.saidUno && (Date.now() - p.lastOneCardTime > 2000)).map(p => p.id);
        const duelInfo = (['dueling','rip_decision','penalty_decision', 'animating_penalty', 'animating_rip'].includes(room.gameState)) ? { attackerName: room.duelState.attackerName, defenderName: room.duelState.defenderName, round: room.duelState.round, scoreAttacker: room.duelState.scoreAttacker, scoreDefender: room.duelState.scoreDefender, history: room.duelState.history, attackerId: room.duelState.attackerId, defenderId: room.duelState.defenderId, turn: room.duelState.turn, narrative: room.duelState.narrative, type: room.duelState.type, triggerCard: room.duelState.triggerCard } : null;
        const leaderboard = Object.keys(room.scores).map(uid => { const pl = room.players.find(x => x.uuid === uid && !x.hasLeft); if(pl) return { name: pl.name, score: room.scores[uid] }; return null; }).filter(x=>x).sort((a,b) => b.score - a.score);
        const activePlayers = room.players.filter(p => !p.hasLeft);
        const pack = { state: room.gameState, roomId: roomId, librePending: room.librePending, players: activePlayers.map((p) => { const pIndex = room.players.findIndex(x => x.uuid === p.uuid); return { name: p.name + (p.isAdmin ? " 👑" : ""), uuid: p.uuid, cardCount: p.hand.length, id: p.id, isTurn: (['playing', 'animating_penalty', 'animating_rip'].includes(room.gameState) && pIndex === room.currentTurn), hasDrawn: p.hasDrawn, isDead: p.isDead, isSpectator: p.isSpectator, isAdmin: p.isAdmin, isConnected: p.isConnected, personalDebt: p.personalDebt }; }), topCard: room.discardPile.length > 0 ? room.discardPile[room.discardPile.length - 1] : null, activeColor: room.activeColor, currentTurn: room.currentTurn, duelInfo, pendingPenalty: room.pendingPenalty, chatHistory: room.chatHistory, reportTargets: reportablePlayers, leaderboard: leaderboard, timerEndsAt: room.timerEndsAt };
        activePlayers.forEach(p => { if(p.isConnected) { const mp = JSON.parse(JSON.stringify(pack)); if (mp.duelInfo) { mp.duelInfo.myChoice = (p.uuid === room.duelState.attackerId) ? room.duelState.attackerChoice : room.duelState.defenderChoice; } io.to(p.id).emit('updateState', mp); if (!p.isSpectator || p.isDead) io.to(p.id).emit('handUpdate', p.hand); io.to(p.id).emit('chatHistory', room.chatHistory); } });
        manageTimers(roomId); 
    } catch(e) { console.error(e); }
}

// --- CLIENTE HTML ---
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
    <title>UNO y 1/2 Final</title>
    <style>
        * { box-sizing: border-box; }
        :root { --app-height: 100dvh; --safe-bottom: env(safe-area-inset-bottom, 20px); }
        body { margin: 0; padding: 0; font-family: 'Segoe UI', sans-serif; background: transparent; color: white; overflow: hidden; height: var(--app-height); display: flex; flex-direction: column; user-select: none; transition: background-color 0.5s; }
        
        .bg-cycle { animation: bgCycle 20s infinite ease-in-out; }
        @keyframes bgCycle { 0% { background-color: #c0392b; } 25% { background-color: #2980b9; } 50% { background-color: #27ae60; } 75% { background-color: #f1c40f; } 100% { background-color: #c0392b; } }
        
        /* CORRECCIÓN: Fondo y color dinámico para cartas cayendo */
        .falling-bg-card { position: absolute; top: -110px; border: 2px solid #fff; border-radius: 8px; width: 60px; height: 90px; display: flex; justify-content: center; align-items: center; font-weight: bold; font-size: 20px; z-index: 1; pointer-events: none; opacity: 0.6; animation: fall linear forwards; box-shadow: 0 0 10px black; }
        @keyframes fall { to { transform: translateY(120vh) rotate(360deg); } }

        .screen { display: none; width: 100%; height: 100%; position: absolute; top: 0; left: 0; flex-direction: column; justify-content: center; align-items: center; z-index: 10; }
        .logo-title { font-size:60px; margin:0; margin-bottom: 20px; color: white; text-shadow: 0 0 20px rgba(0,0,0,0.8); animation: floatLogo 3s ease-in-out infinite; }
        @keyframes floatLogo { 0% { transform: translateY(0px); } 50% { transform: translateY(-10px); } 100% { transform: translateY(0px); } }
        
        #game-area { display: none; flex-direction: column; height: 100%; width: 100%; position: relative; z-index: 5; padding-bottom: calc(240px + var(--safe-bottom)); background: #1e272e; }
        #rip-screen, #duel-screen { background: rgba(50,0,0,0.98); z-index: 10000; }
        #game-over-screen { background: rgba(0,0,0,0.95); z-index: 200000; text-align: center; border: 5px solid gold; flex-direction: column; justify-content: center; align-items: center; }
        
        #round-overlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.98); z-index: 150000; display: none; flex-direction: column; justify-content: center; align-items: center; color: white; text-align: center; }
        .round-stage { display: none; flex-direction: column; align-items: center; width: 100%; }
        .active-stage { display: flex; animation: fadeIn 0.5s; }
        .score-flyer { position: absolute; font-size: 24px; color: gold; font-weight: bold; transition: all 0.6s ease-in-out; text-shadow: 0 0 10px black; z-index: 160000; }

        #round-start-banner { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%) scale(0); background: rgba(0,0,0,0.95); border: 4px solid gold; border-radius: 15px; color: white; padding: 30px; text-align: center; z-index: 200000; box-shadow: 0 0 30px gold; transition: transform 0.5s; display: none; flex-direction: column; justify-content: center; align-items: center; pointer-events: none; }
        #round-start-banner.show { transform: translate(-50%, -50%) scale(1); }

        .rank-row { display: flex; justify-content: space-between; width: 80%; max-width: 400px; padding: 15px; margin: 8px 0; background: rgba(255,255,255,0.1); border-radius: 8px; opacity: 0; transform: translateY(20px); transition: all 0.5s; font-size: 22px; }
        .rank-row.visible { opacity: 1; transform: translateY(0); }
        .rank-gold { border: 2px solid gold; background: rgba(255, 215, 0, 0.2); }

        .floating-window { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 340px; max-width: 95%; max-height: 85vh; background: #2c3e50; border: 3px solid #ecf0f1; border-radius: 15px; z-index: 100000; display: none; flex-direction: column; padding: 20px; color: white; text-align: center; }
        .modal-close { position: absolute; top: 10px; right: 15px; font-size: 28px; cursor: pointer; color: #aaa; font-weight: bold; }
        
        #reconnect-overlay { position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.8); z-index:90000; display:none; justify-content:center; align-items:center; color:white; font-size:20px; flex-direction:column; }
        .loader { border: 5px solid #f3f3f3; border-top: 5px solid #3498db; border-radius: 50%; width: 50px; height: 50px; animation: spin 1s linear infinite; margin-bottom:15px; }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }

        .libre-step { display: none; width: 100%; text-align: center; }
        .libre-step.active { display: block; }
        
        .hud-btn { position: fixed; width: 50px; height: 50px; border-radius: 50%; display: none; justify-content: center; align-items: center; border: 2px solid white; z-index: 50000; box-shadow: 0 4px 5px rgba(0,0,0,0.5); font-size: 20px; cursor: pointer; transition: transform 0.2s, top 0.3s ease-out, left 0.3s ease-out; }
        
        #score-btn { background: gold; color: black; }
        #rules-btn { background: #9b59b6; color: white; }
        #uno-main-btn { background: #e67e22; font-size: 10px; font-weight: bold; text-align: center; padding: 0; }
        #chat-btn { background: #3498db; }
        #global-leave-btn { background: #c0392b; font-size: 20px; }

        #players-zone { flex: 0 0 auto; padding: 30px 10px 10px 10px; background: rgba(0,0,0,0.5); display: flex; flex-wrap: wrap; justify-content: center; gap: 5px; z-index: 20; position: relative; }
        .player-badge { background: #333; color: white; padding: 5px 12px; border-radius: 20px; font-size: 13px; border: 1px solid #555; transition: all 0.3s; position: relative; }
        .is-turn { background: #2ecc71; color: black; font-weight: bold; border: 2px solid white; transform: scale(1.1); box-shadow: 0 0 10px #2ecc71; }
        .is-dead { text-decoration: line-through; opacity: 0.6; }
        
        @keyframes flashAction { 0% { box-shadow: 0 0 0px white; transform: scale(1); } 50% { box-shadow: 0 0 20px gold; transform: scale(1.15); } 100% { box-shadow: 0 0 0px white; transform: scale(1); } }
        .flash-action { animation: flashAction 0.4s ease-out; z-index: 9999; }

        #alert-zone { position: fixed; left: 0; width: 100%; display: flex; flex-direction: column; justify-content: center; align-items: center; z-index: 60000; pointer-events: none; transition: top 0.3s ease-out; gap: 10px; }
        .alert-box { background: rgba(0,0,0,0.95); border: 2px solid gold; color: white; padding: 15px; border-radius: 10px; text-align: center; font-weight: bold; font-size: 18px; display: none; pointer-events: auto; max-width: 90%; }
        
        #personal-debt-display { font-size: 20px; color: white; text-shadow: 0 0 5px black; display: none; background: rgba(231, 76, 60, 0.95); padding: 15px 20px; border-radius: 10px; border: 3px solid white; pointer-events: auto; width: 90%; max-width: 350px; text-align: center; animation: pulseRed 1s infinite alternate; }
        #penalty-display { font-size: 20px; color: #ff4757; text-shadow: 0 0 5px red; display: none; background: rgba(0,0,0,0.9); padding: 10px 15px; border-radius: 8px; border: 2px solid red; pointer-events: auto; text-align: center; animation: pulseRed 1s infinite alternate; }
        @keyframes pulseRed { from { box-shadow: 0 0 10px red; } to { box-shadow: 0 0 25px red; } }
        
        #table-zone { flex: 1; display: flex; flex-direction: column; justify-content: center; align-items: center; gap: 15px; z-index: 15; position: relative; }
        #decks-container { display: flex; gap: 30px; transform: scale(1.1); }
        .card-pile { width: 70px; height: 100px; border-radius: 8px; border: 3px solid white; display: flex; justify-content: center; align-items: center; font-size: 24px; position: relative; color: white; }
        #deck-pile { background: #e74c3c; cursor: pointer; }
        #top-card { background: #333; }
        
        #action-bar { position: fixed; bottom: 180px; left: 0; width: 100%; display: none; justify-content: center; align-items: center; padding: 10px; pointer-events: none; z-index: 20000; }
        #uno-btn-area { pointer-events: auto; display: flex; gap: 10px; flex-wrap: wrap; justify-content: center; }
        .btn-pass { background: #f39c12; color: white; border: 2px solid white; padding: 10px 20px; border-radius: 25px; font-weight: bold; cursor: pointer; display: none; }
        #btn-ladder-play { background: #27ae60; color: white; border: 2px solid white; padding: 10px 20px; border-radius: 25px; font-weight: bold; cursor: pointer; display:none; }
        #btn-ladder-cancel { background: #e74c3c; color: white; border: 2px solid white; padding: 10px 20px; border-radius: 25px; font-weight: bold; cursor: pointer; display:none; }
        #btn-sort { background: #34495e; color: white; border: 2px solid white; padding: 10px 20px; border-radius: 25px; font-weight: bold; cursor: pointer; font-size: 14px; }

        #hand-zone { position: fixed; bottom: 0; left: 0; width: 100%; height: 180px; background: rgba(20, 20, 20, 0.95); border-top: 2px solid #555; display: none; align-items: center; padding: 10px 20px; padding-bottom: calc(10px + var(--safe-bottom)); gap: 15px; overflow-x: auto; z-index: 10000; }
        body.state-round-ending #hand-zone { pointer-events: none; filter: grayscale(1) brightness(0.5); }
        
        .hand-card { flex: 0 0 85px; height: 130px; border-radius: 8px; border: 2px solid white; background: #444; display: flex; justify-content: center; align-items: center; font-size: 32px; font-weight: 900; color: white; position: relative; cursor: pointer; z-index: 1; transition: transform 0.2s; }
        .hand-card.selected-ladder { border: 4px solid cyan !important; transform: translateY(-20px); z-index:10; }
        
        @keyframes slideUp { from { transform: translateY(100px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
        .drawn-card { animation: slideUp 0.5s ease-out; border: 2px solid gold; }

        body.bg-rojo #game-area { background-color: #4a1c1c !important; } 
        body.bg-azul #game-area { background-color: #1c2a4a !important; } 
        body.bg-verde #game-area { background-color: #1c4a2a !important; } 
        body.bg-amarillo #game-area { background-color: #4a451c !important; }

        .color-circle { width: 70px; height: 70px; border-radius: 50%; display: inline-block; margin: 10px; cursor: pointer; border: 4px solid #fff; }
        .zombie-btn { display: block; width: 100%; padding: 15px; margin: 10px 0; background: #333; color: white; border: 1px solid #666; font-size: 18px; cursor: pointer; border-radius: 10px; }
        
        #chat-win { position: fixed; right: 10px; width: 280px; height: 250px; background: rgba(0,0,0,0.95); border: 2px solid #666; display: none; flex-direction: column; z-index: 50000; border-radius: 10px; box-shadow: 0 0 20px black; transition: top 0.3s ease-out; }
        #chat-badge { position: absolute; top: -5px; right: -5px; background: red; color: white; border-radius: 50%; width: 20px; height: 20px; font-size: 12px; display: none; justify-content: center; align-items: center; font-weight: bold; border: 2px solid white; }
        
        .min-c { display:inline-block; width:22px; height:32px; border-radius:3px; border:1px solid white; text-align:center; line-height:32px; font-weight:bold; font-size:12px; color:white; vertical-align:middle; margin:0 2px; }
        .mc-rojo { background:#ff5252; } .mc-azul { background:#448aff; } .mc-verde { background:#69f0ae; color:black; } .mc-amarillo { background:#ffd740; color:black; } .mc-negro { background:#212121; }
        .mc-rip { background:black; font-size:10px; display:inline-flex; align-items:center; justify-content:center; }
        .mc-gra { background:white; color:red; }

        .mini-card { display: inline-block; padding: 10px; margin: 5px; border: 2px solid white; border-radius: 5px; cursor: pointer; background: #444; }

        #duel-narrative { position: relative; z-index: 999999; font-size: 26px; text-align:center; padding:20px; border:2px solid #69f0ae; background:rgba(0,0,0,0.9); color: #69f0ae; width:90%; border-radius:15px; margin-bottom: 20px; }
        #duel-opts { display:flex; justify-content:center; gap:20px; margin-top:20px; width:100%; }
        .duel-btn { font-size:50px; background:none; border:none; cursor:pointer; opacity: 0.5; transition: 0.3s; padding:10px; }
        .duel-btn.selected { opacity: 1; transform: scale(1.3); text-shadow: 0 0 20px white; border-bottom: 3px solid gold; }
        .duel-btn:disabled { opacity: 0.2; cursor: not-allowed; }
        
        #duel-clash-zone { display: none; flex-direction: row; justify-content: center; align-items: center; width: 100%; gap: 30px; margin: 30px 0; }
        @keyframes slideRightHit { 0% { transform: translateX(-150px); opacity: 0; } 50% { opacity: 1; } 100% { transform: translateX(20px); } }
        @keyframes slideLeftHit { 0% { transform: translateX(150px); opacity: 0; } 50% { opacity: 1; } 100% { transform: translateX(-20px); } }
        .clash-player { font-size: 90px; text-align: center; }
        .clash-player-name { font-size: 18px; font-weight: bold; background: rgba(0,0,0,0.8); padding: 5px 10px; border-radius: 5px; display: block; margin-top: 10px; color: white; border: 1px solid white; }
        @keyframes screenShake { 0% { transform: translate(1px, 1px); } 50% { transform: translate(-3px, -2px); } 100% { transform: translate(1px, -2px); } }

        input { padding:15px; font-size:20px; text-align:center; width:80%; max-width:300px; border-radius:30px; border:none; margin:10px 0; }
        .btn-main { padding:15px 40px; background:#27ae60; color:white; border:none; border-radius:30px; font-size:20px; cursor:pointer; margin: 10px; }
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

        /* BLOQUEOS */
        body.state-dueling #game-area, body.state-dueling #hand-zone, body.state-dueling #action-bar, body.state-dueling .hud-btn, body.state-dueling #chat-win, body.state-dueling #alert-zone { display: none !important; }
        body.state-dueling #duel-screen { display: flex !important; }
        body.state-rip #game-area, body.state-rip #hand-zone, body.state-rip #action-bar, body.state-rip .hud-btn, body.state-rip #chat-win, body.state-rip #alert-zone { display: none !important; }
        body.state-rip #rip-screen { display: flex !important; } 

        .lobby-row { display: flex; align-items: center; justify-content: space-between; width: 100%; max-width: 300px; margin-bottom: 10px; background: rgba(0,0,0,0.5); padding: 5px 10px; border-radius: 5px; }
        .lobby-name { display: flex; align-items: center; gap: 10px; font-size:18px; font-weight:bold; }
        .kick-btn { background: #e74c3c; border: none; color: white; font-weight: bold; cursor: pointer; padding: 2px 8px; border-radius: 5px; margin-left: 20px; }
        
        #uno-menu { display: none; position: fixed; right: 10px; background: rgba(0,0,0,0.9); padding: 10px; border-radius: 10px; z-index: 40000; flex-direction: column; width: 180px; border: 1px solid #e67e22; transition: top 0.3s ease-out; }
        
        .universal-flying-card { position: fixed; width: 70px; height: 100px; border-radius: 8px; z-index: 50000; display: flex; justify-content: center; align-items: center; font-size: 24px; font-weight: bold; border: 2px solid white; box-shadow: 0 5px 15px rgba(0,0,0,0.8); transition: all 0.5s; pointer-events: none; }
    </style>
</head>
<body class="bg-cycle">
    <div id="reconnect-overlay"><div class="loader"></div><div>Reconectando...</div></div>

    <div id="login" class="screen login-bg" style="display:flex;">
        <h1 class="logo-title">UNO y 1/2</h1>
        <input id="my-name" type="text" placeholder="Tu Nombre" maxlength="15" onfocus="playUI()">
        <button id="btn-create" class="btn-main" onclick="playUI(); showCreate()">Crear Sala</button>
        <button id="btn-join-menu" class="btn-main" onclick="playUI(); showJoin()" style="background:#2980b9">Unirse a Sala</button>
    </div>
    <div id="join-menu" class="screen login-bg">
        <h1 class="logo-title">Unirse</h1>
        <input id="room-code" type="text" placeholder="Código" style="text-transform:uppercase;" onfocus="playUI()">
        <button class="btn-main" onclick="playUI(); joinRoom()">Entrar</button>
        <button class="btn-main" onclick="playUI(); backToLogin()">Volver</button>
    </div>
    <div id="lobby" class="screen login-bg">
        <button onclick="playUI(); toggleManual()" style="position: absolute; top: 10px; right: 10px; background: #8e44ad; color: white; border: none; padding: 10px; border-radius: 5px; cursor: pointer; z-index: 10;">📖 MANUAL</button>
        <h1 class="logo-title" style="font-size: 40px;">Sala: <span id="lobby-code" style="color:gold;"></span></h1>
        <div id="lobby-link-container"><button onclick="playUI(); copyLink()" style="background:#34495e; color:white; border:none; padding:10px 20px; border-radius:20px; cursor:pointer;">🔗 Copiar Link</button></div>
        <div id="lobby-users"></div>
        <button id="start-btn" onclick="playUI(); start()" class="btn-main" style="display:none; background:#2ecc71; border:2px solid white; font-weight:bold; font-size:24px;">EMPEZAR</button>
        <p id="wait-msg" style="display:none;">Esperando...</p>
    </div>
    
    <div id="game-area">
        <div id="players-zone"></div>
        <div id="table-zone">
            <div id="decks-container"><div id="deck-pile" class="card-pile" onclick="draw()">📦</div><div id="top-card" class="card-pile"></div></div>
        </div>
    </div>

    <div id="global-leave-btn" class="hud-btn" onclick="requestLeave()" title="Abandonar Partida">🚪</div>
    
    <div id="rules-btn" class="hud-btn" onclick="toggleManual()">📖</div>
    <div id="score-btn" class="hud-btn" onclick="toggleScores()">🏆</div>
    <div id="chat-btn" class="hud-btn" onclick="toggleChat()">💬<div id="chat-badge">0</div></div>
    <div id="uno-main-btn" class="hud-btn" onclick="toggleUnoMenu()">UNO<br>y 1/2</div>

    <div id="round-start-banner">
        <h1 id="rsb-round" style="color: gold; font-size: 50px; margin: 0; text-shadow: 2px 2px 5px black;">RONDA 1</h1>
        <h2 id="rsb-starter" style="font-size: 24px; margin-top: 10px;">Comienza Fulanito</h2>
    </div>

    <div id="alert-zone">
        <div id="personal-debt-display">🛑 ¡DEBES PAGAR <span id="pd-num">0</span> CARTAS! 🛑</div>
        <div id="penalty-display">⚠️ DEBES RECOGER <span id="pen-num">0</span> CARTAS</div>
        <div id="main-alert" class="alert-box"></div>
    </div>

    <div id="action-bar">
        <div id="uno-btn-area">
            <button id="btn-sort" onclick="requestSort()">ORDENAR</button>
            <button id="btn-pass" class="btn-pass" onclick="pass()">PASAR</button>
            <button id="btn-ladder-play" onclick="submitLadder()">JUGAR SELECCIÓN</button>
            <button id="btn-ladder-cancel" onclick="cancelLadder()">CANCELAR</button>
        </div>
    </div>

    <div id="uno-menu">
        <div id="uno-main-opts">
            <button class="btn-main" style="width:100%; font-size:14px; padding:10px; margin:2px; background:#e67e22;" onclick="trySayUno()">📢 ANUNCIAR</button>
            <button class="btn-main" style="width:100%; font-size:14px; padding:10px; margin:2px; background:#8e44ad;" onclick="showDenounceList()">🚨 DENUNCIAR</button>
            <button class="btn-main" style="width:100%; font-size:14px; padding:10px; margin:2px; background:#c0392b;" onclick="toggleUnoMenu()">CERRAR</button>
        </div>
        <div id="uno-denounce-opts" style="display:none; text-align:center;">
            <h3 style="margin-top:0; font-size:16px;">¿A quién denunciar?</h3>
            <div id="denounce-list-container" style="width:100%;"></div>
            <button class="btn-main" style="width:100%; font-size:12px; padding:8px; margin:5px 0 0 0; background:#c0392b;" onclick="closeDenounceList()">VOLVER</button>
        </div>
    </div>
    
    <div id="hand-zone"></div>
    
    <div id="chat-win">
        <div style="text-align:right; padding:5px; border-bottom:1px solid #444;"><span style="cursor:pointer;" onclick="toggleChat()">X</span></div>
        <div id="chat-msgs" style="flex:1; overflow-y:auto; padding:10px; font-size:12px; color:#ddd;"></div>
        <div style="display:flex; border-top:1px solid #555;">
            <input id="chat-in" style="flex:1; border-radius:0; padding:10px; border:none; background:#333; color:white; font-size:14px;" placeholder="Mensaje..." onkeypress="if(event.key==='Enter') sendChat()">
            <button onclick="sendChat()" style="background:#2980b9; color:white; border:none; padding:0 15px; cursor:pointer;">></button>
        </div>
    </div>
    
    <div id="score-modal" class="floating-window">
        <div class="modal-close" onclick="toggleScores()">X</div>
        <h2 style="color:gold;">PUNTAJES</h2>
        <div id="score-list" style="text-align:left; color:white; font-size:16px;"></div>
    </div>

    <div id="manual-modal" class="floating-window" style="width: 95%; max-width: 800px; max-height: 90vh;">
        <div class="modal-close" onclick="toggleManual()">X</div>
        <h1 style="color:gold; font-size:32px; border-bottom: 2px solid gold; padding-bottom: 10px;">📖 MANUAL</h1>
        <div style="padding:0 10px; text-align:left; line-height:1.7; font-size: 15px;">
            <p>El primer jugador en sumar <b>800 puntos</b> gana.</p>
            <p>🪜 Escalera: 3 o más consecutivas del mismo color.</p>
            <p>✨ Combo 1y1/2: Junta 2, 4 o 6 cartas para sumar 3, 6 o 9.</p>
            <p>⚡ S.A.F.F.: Tira una carta IDÉNTICA fuera de turno y róbalo.</p>
            <p>🪦 RIP: Duelo a muerte. El perdedor es eliminado.</p>
            <p>❤️ GRACIA: Anula castigos, revive muertos y cambia color.</p>
        </div>
    </div>

    <div id="afk-modal" class="floating-window" style="z-index: 999999; background: #c0392b; border: 4px solid gold;">
        <h1 style="color:white; font-size:40px;">¿ESTÁS AHÍ?</h1>
        <button class="btn-main" style="background:#27ae60; font-size:20px; width:100%;" onclick="imHere()">¡SÍ!</button>
    </div>

    <div id="leave-normal-modal" class="floating-window">
        <h2>¿Abandonar?</h2>
        <button class="btn-main" onclick="confirmLeave('leave_normal')" style="background:#e74c3c;">SÍ</button>
        <button class="btn-main" onclick="forceCloseModals()" style="background:#34495e;">CANCELAR</button>
    </div>
    <div id="leave-admin-modal" class="floating-window">
        <h2>¿Abandonar?</h2>
        <button class="btn-main" onclick="confirmLeave('leave_host_end')" style="background:#e74c3c;">FINALIZAR PARTIDA</button>
        <button class="btn-main" onclick="forceCloseModals()" style="background:#34495e;">CANCELAR</button>
    </div>

    <div id="game-over-screen" class="screen">
        <h1 style="color:gold;">VICTORIA</h1>
        <h2 id="winner-name"></h2>
        <h3 id="final-score"></h3>
    </div>
    
    <div id="pause-overlay" style="display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.85); z-index:999999; justify-content:center; align-items:center; flex-direction:column; color:white; text-align:center;">
        <h1 style="color:gold; font-size:50px;">⏸️ PAUSA</h1>
        <h2 id="pause-msg"></h2>
    </div>

    <div id="round-overlay">
        <div id="stage-collection" class="round-stage active-stage">
            <h1 id="r-winner-name" style="color: gold; font-size: 40px;"></h1>
            <h3 id="r-winner-pts">0 pts</h3>
            <div id="losers-area"></div>
        </div>
        <div id="stage-ranking" class="round-stage">
            <h1>RANKING</h1>
            <div id="ranking-list"></div>
        </div>
    </div>

    <div id="rip-screen" class="screen">
        <h1 style="color:red;" id="rip-title">💀 RIP 💀</h1>
        <h3 id="rip-msg-custom"></h3>
        <div id="decision-timer" style="font-size: 60px; color: #e74c3c;">15</div>
        <button id="btn-accept-penalty" onclick="ripResp('accept_penalty')" class="btn-main" style="background:#34495e; display:none;">ACEPTAR</button>
        <button id="btn-duel-start" onclick="ripResp('duel')" class="btn-main" style="background:red;">DUELO</button>
        <button id="btn-surrender" onclick="ripResp('surrender')" class="btn-main">RENDIRSE</button>
    </div>

    <div id="duel-screen" class="screen">
        <h1 style="color:gold;">⚔️ DUELO ⚔️</h1>
        <div id="duel-timer" style="font-size: 40px; color: #e74c3c;">15</div>
        <h3 id="duel-narrative">Cargando...</h3>
        <h2 id="duel-sc">0 - 0</h2>
        <div id="duel-opts">
            <button id="btn-fuego" class="duel-btn" onclick="pick('fuego')">🔥</button>
            <button id="btn-hielo" class="duel-btn" onclick="pick('hielo')">❄️</button>
            <button id="btn-agua" class="duel-btn" onclick="pick('agua')">💧</button>
        </div>
        <div id="duel-clash-zone">
            <div class="clash-player"><span id="clash-att-emoji">🔥</span><br><span class="clash-player-name" id="clash-att-name"></span></div>
            <div class="clash-player"><span id="clash-def-emoji">❄️</span><br><span class="clash-player-name" id="clash-def-name"></span></div>
        </div>
    </div>
    
    <div id="color-picker" class="floating-window"><h3>Elige Color</h3><div style="display:flex; justify-content:center;"><div class="color-circle" style="background:#ff5252;" onclick="pickCol('rojo')"></div><div class="color-circle" style="background:#448aff;" onclick="pickCol('azul')"></div><div class="color-circle" style="background:#69f0ae;" onclick="pickCol('verde')"></div><div class="color-circle" style="background:#ffd740;" onclick="pickCol('amarillo')"></div></div></div>
    <div id="revive-screen" class="floating-window"><h2>REVIVIR?</h2><div id="zombie-list"></div></div>
    
    <div id="grace-color-modal" class="floating-window"><h2>❤️ GRACIA</h2><button class="btn-main" onclick="confirmGraceColor(true)">SÍ</button><button class="btn-main" onclick="confirmGraceColor(false)">NO</button></div>
    <div id="revive-confirm-screen" class="floating-window"><h2>REVIVIR A <span id="revive-name"></span>?</h2><button class="btn-main" onclick="confirmRevive(true)">SÍ</button><button class="btn-main" onclick="confirmRevive(false)">NO</button></div>
    <div id="countdown" style="display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.8); z-index:250000; justify-content:center; align-items:center; font-size:120px; color:gold;">3</div>

    <div id="libre-modal" class="floating-window">
        <div id="step-1" class="libre-step active"><h2>Regalar a?</h2><div id="libre-targets"></div></div>
        <div id="step-2" class="libre-step"><h2>Carta a regalar?</h2><div id="libre-gift-hand"></div></div>
        <div id="step-3" class="libre-step"><h2>Carta a descartar?</h2><div id="libre-discard-hand"></div></div>
    </div>

    <script src="/socket.io/socket.io.js"></script>
    <script>
        const socket = io();
        let myId = '', pendingCard = null, pendingGrace = false, myHand = [], currentPlayers = [], isChatOpen = false, unreadCount = 0, ladderMode = false, ladderSelected = []; 
        let myUUID = localStorage.getItem('uno_uuid'), pressTimer, pendingColorForRevive = null, pendingLibreContext = null, clientTimerInterval = null, hasPlayedIntro = false;

        function getCardText(c) { if(c.value==='RIP') return '🪦'; if(c.value==='GRACIA') return '❤️'; if(c.value==='LIBRE') return '🕊️'; if(c.value==='SALTEO SUPREMO') return 'SS'; return c.value; }
        function getBgColor(c) { const map = { 'rojo': '#ff5252', 'azul': '#448aff', 'verde': '#69f0ae', 'amarillo': '#ffd740', 'negro': '#212121' }; if(c.value==='RIP') return 'black'; if(c.value==='GRACIA') return 'white'; if(c.value==='+12') return '#000000'; if(c.value==='LIBRE') return '#000'; if(c.value==='SALTEO SUPREMO') return '#2c3e50'; return map[c.color] || '#444'; }

        // CORRECCIÓN: Generador de partículas que respeta el diseño real
        function createFallingCard() {
            if(document.body.classList.contains('playing-state')) return; 
            
            // Pool de cartas especiales para la animación
            const pool = [
                {value: '+12', color: 'negro'},
                {value: 'SALTEO SUPREMO', color: 'negro'},
                {value: 'RIP', color: 'negro'},
                {value: 'GRACIA', color: 'negro'},
                {value: 'LIBRE', color: 'negro'},
                {value: '+4', color: 'negro'},
                {value: 'color', color: 'negro'},
                {value: 'X', color: 'rojo'},
                {value: 'R', color: 'azul'},
                {value: '1 y 1/2', color: 'verde'}
            ];
            
            const card = pool[Math.floor(Math.random() * pool.length)];
            const el = document.createElement('div');
            el.className = 'falling-bg-card';
            
            // Aplicar texto y fondo real
            el.innerText = getCardText(card);
            const bgColor = getBgColor(card);
            el.style.backgroundColor = bgColor;
            
            // Aplicar color de texto real (negro para fondo blanco o amarillo/verde)
            if (card.color === 'amarillo' || card.color === 'verde' || card.value === 'GRACIA') {
                el.style.color = (card.value === 'GRACIA') ? 'red' : 'black';
            } else {
                el.style.color = 'white';
            }

            // Bordes especiales para visibilidad
            if (card.value === 'RIP') el.style.borderColor = '#666';
            else if (card.value === 'GRACIA') el.style.borderColor = 'gold';
            
            el.style.left = Math.random() * 100 + 'vw';
            el.style.animationDuration = (Math.random() * 5 + 8) + 's'; 
            document.body.appendChild(el);
            setTimeout(() => el.remove(), 13000);
        }
        setInterval(createFallingCard, 1200);

        function playUI() { if(!hasPlayedIntro) { const a = new Audio('https://cdn.freesound.org/previews/511/511484_6890478-lq.mp3'); a.volume = 0.5; a.play().catch(()=>{}); hasPlayedIntro = true; } }
        if (!myUUID) { myUUID = Math.random().toString(36).substring(2) + Date.now().toString(36); localStorage.setItem('uno_uuid', myUUID); }
        const urlParams = new URLSearchParams(window.location.search); const inviteCode = urlParams.get('room');
        if (inviteCode) { document.getElementById('room-code').value = inviteCode; document.getElementById('btn-create').style.display = 'none'; document.getElementById('btn-join-menu').onclick = joinRoom; }
        
        let lastInteractionTime = Date.now();
        function reportActivity() { const now = Date.now(); if (now - lastInteractionTime > 5000) { lastInteractionTime = now; if (document.body.classList.contains('playing-state')) { socket.emit('imHere'); } } }
        document.addEventListener('touchstart', reportActivity); document.addEventListener('click', reportActivity);

        function forceCloseModals() { document.querySelectorAll('.floating-window').forEach(w => w.style.display = 'none'); document.getElementById('chat-win').style.display = 'none'; document.getElementById('uno-menu').style.display = 'none'; isChatOpen = false; }
        function repositionHUD() { const pZone = document.getElementById('players-zone'); if (!pZone || pZone.offsetHeight === 0) return; const rect = pZone.getBoundingClientRect(); const baseTop = rect.bottom + 10; const buttons = [ document.getElementById('global-leave-btn'), document.getElementById('rules-btn'), document.getElementById('score-btn'), document.getElementById('chat-btn'), document.getElementById('uno-main-btn') ]; const screenW = window.innerWidth, btnSize = 50; let gap = 15; if (screenW < 360) gap = 8; const totalW = (btnSize * 5) + (gap * 4); let startLeft = (screenW - totalW) / 2; buttons.forEach((btn, idx) => { if (btn) { btn.style.top = baseTop + 'px'; btn.style.left = (startLeft + (btnSize + gap) * idx) + 'px'; } }); const lowerElements = ['uno-menu', 'chat-win']; lowerElements.forEach(id => { const el = document.getElementById(id); if(el) { el.style.top = (baseTop + 60) + 'px'; } }); const alertZone = document.getElementById('alert-zone'); if(alertZone) alertZone.style.top = (baseTop + 75) + 'px'; }
        window.addEventListener('resize', repositionHUD);

        socket.on('connect', () => { document.getElementById('reconnect-overlay').style.display = 'none'; myId = socket.id; socket.emit('checkSession', myUUID); });
        socket.on('disconnect', () => { document.getElementById('reconnect-overlay').style.display = 'flex'; });
        socket.on('requireLogin', () => { document.getElementById('reconnect-overlay').style.display = 'none'; changeScreen('login'); document.getElementById('global-leave-btn').style.display = 'none'; document.getElementById('lobby-users').innerHTML = ''; document.getElementById('hand-zone').innerHTML = ''; });
        socket.on('showAFKPrompt', () => { document.getElementById('afk-modal').style.display = 'flex'; });
        function imHere() { document.getElementById('afk-modal').style.display = 'none'; socket.emit('imHere'); }
        
        let libreState = { active: false, cardId: null, targetId: null, giftId: null, discardId: null };
        socket.on('startLibreLogic', (cardId) => { if(myHand.length < 3) return; document.getElementById('action-bar').style.display = 'none'; libreState = { active: true, cardId: cardId, targetId: null, giftId: null, discardId: null }; document.getElementById('libre-modal').style.display = 'flex'; showLibreStep(1); const div = document.getElementById('libre-targets'); div.innerHTML = ''; currentPlayers.forEach(p => { if(p.uuid !== myUUID && !p.isSpectator && !p.isDead && !p.hasLeft) { const b = document.createElement('button'); b.className = 'btn-main'; b.innerText = p.name; b.onclick = () => { libreState.targetId = p.id; showLibreStep(2); renderGiftHand(); }; div.appendChild(b); } }); });
        function renderGiftHand() { const div = document.getElementById('libre-gift-hand'); div.innerHTML = ''; myHand.forEach(c => { if(c.id === libreState.cardId) return; const b = document.createElement('div'); b.className = 'mini-card'; b.innerText = getCardText(c); b.style.color = (c.color==='amarillo'||c.color==='verde')?'black':'white'; b.style.backgroundColor = getBgColor(c); b.onclick = () => { libreState.giftId = c.id; showLibreStep(3); renderDiscardHand(); }; div.appendChild(b); }); }
        function renderDiscardHand() { const pool = document.getElementById('libre-discard-hand'); pool.innerHTML = ''; myHand.forEach(c => { if(c.id === libreState.cardId || c.id === libreState.giftId) return; const b = document.createElement('div'); b.className = 'mini-card'; b.innerText = getCardText(c); b.style.color = (c.color==='amarillo'||c.color==='verde')?'black':'white'; b.style.backgroundColor = getBgColor(c); b.onclick = () => { libreState.discardId = c.id; pendingLibreContext = { libreId: libreState.cardId, targetId: libreState.targetId, giftId: libreState.giftId, discardId: libreState.discardId }; document.getElementById('libre-modal').style.display = 'none'; libreState.active = false; socket.emit('playCard', null, null, null, pendingLibreContext); pendingLibreContext = null; }; pool.appendChild(b); }); }
        function cancelLibre() { document.getElementById('libre-modal').style.display = 'none'; pendingLibreContext = null; }
        function showLibreStep(n) { document.querySelectorAll('.libre-step').forEach(el => el.classList.remove('active')); document.getElementById('step-'+n).classList.add('active'); }
        function showCreate() { const name = document.getElementById('my-name').value.trim(); if(name) socket.emit('createRoom', { name, uuid: myUUID }); }
        function showJoin() { changeScreen('join-menu'); } function backToLogin() { changeScreen('login'); }
        function joinRoom() { const name = document.getElementById('my-name').value.trim(), code = document.getElementById('room-code').value.trim(); if(name && code) socket.emit('joinRoom', { name, uuid: myUUID, roomId: code }); }
        function copyLink() { const code = document.getElementById('lobby-code').innerText, url = window.location.origin + '/?room=' + code; navigator.clipboard.writeText(url); }
        function kick(id) { socket.emit('kickPlayer', id); }
        socket.on('roomCreated', (d) => { changeScreen('lobby'); document.getElementById('lobby-code').innerText = d.roomId; });
        socket.on('roomJoined', (d) => { changeScreen('lobby'); document.getElementById('lobby-code').innerText = d.roomId; });
        socket.on('cardPlayedEffect', d => { if(d.playerName) { document.querySelectorAll('.player-badge').forEach(b => { if(b.innerText.includes(d.playerName)) { b.classList.add('flash-action'); setTimeout(()=>b.classList.remove('flash-action'), 400); } }); } });
        socket.on('cardDrawnEffect', d => { if(d.playerName) { document.querySelectorAll('.player-badge').forEach(b => { if(b.innerText.includes(d.playerName)) { b.classList.add('flash-action'); setTimeout(()=>b.classList.remove('flash-action'), 400); } }); } });

        socket.on('animateCard', data => {
            const el = document.createElement('div'), isMe = (data.playerId === socket.id);
            el.className = 'universal-flying-card'; el.style.backgroundColor = getBgColor(data.card); el.style.color = (data.card.color==='amarillo'||data.card.color==='verde'||data.card.value==='GRACIA') ? ((data.card.value==='GRACIA')?'red':'black') : 'white';
            el.innerText = getCardText(data.card);
            if (isMe) { el.style.bottom = '100px'; el.style.left = '50%'; el.style.transform = 'translateX(-50%) scale(1.5)'; } 
            else { el.style.top = '30%'; el.style.right = '-50px'; el.style.transform = 'scale(1.5)'; }
            document.body.appendChild(el);
            setTimeout(() => { const dest = document.getElementById('top-card').getBoundingClientRect(); el.style.top = dest.top + 'px'; el.style.left = dest.left + 'px'; el.style.transform = 'scale(1)'; }, 50);
            setTimeout(() => el.remove(), 600);
        });

        socket.on('ladderAnimate', data => {
            const isMe = (data.playerId === socket.id);
            data.cards.forEach((c, i) => { setTimeout(() => {
                    const el = document.createElement('div');
                    el.className = 'universal-flying-card'; el.style.backgroundColor = getBgColor(c); el.style.color = (c.color==='amarillo'||c.color==='verde')?'black':'white'; el.innerText = getCardText(c); 
                    if (isMe) { el.style.bottom = '100px'; el.style.left = '50%'; el.style.transform = 'translateX(-50%) scale(1.3)'; } 
                    else { el.style.top = '30%'; el.style.right = '-50px'; el.style.transform = 'scale(1.3)'; }
                    document.body.appendChild(el); 
                    setTimeout(() => { const dest = document.getElementById('top-card').getBoundingClientRect(); el.style.top = dest.top + 'px'; el.style.left = dest.left + 'px'; el.style.transform = 'scale(1)'; }, 50); 
                    setTimeout(() => el.remove(), 600); 
                }, i * 200); 
            });
        });

        socket.on('duelClash', data => {
            document.getElementById('duel-opts').style.display = 'none'; document.getElementById('duel-clash-zone').style.display = 'flex';
            const emMap = { 'fuego': '🔥', 'hielo': '❄️', 'agua': '💧' };
            document.getElementById('clash-att-name').innerText = data.attName; document.getElementById('clash-def-name').innerText = data.defName;
            document.getElementById('clash-att-emoji').innerText = emMap[data.attChoice]; document.getElementById('clash-def-emoji').innerText = emMap[data.defChoice];
            document.body.style.animation = 'screenShake 0.5s'; setTimeout(() => document.body.style.animation = '', 500);
        });

        socket.on('updateState', s => {
            currentPlayers = s.players;
            if(s.state === 'waiting' || s.state === 'playing') { document.getElementById('global-leave-btn').style.display = 'flex'; document.getElementById('lobby-code').innerText = s.roomId; }
            else { document.getElementById('global-leave-btn').style.display = 'none'; }
            if(s.leaderboard) { document.getElementById('score-list').innerHTML = s.leaderboard.map((u, i) => '<div>' + (i+1) + '. ' + u.name + ': ' + u.score + '</div>').join(''); }
            if (clientTimerInterval) clearInterval(clientTimerInterval);
            if (s.timerEndsAt) { const updateTimer = () => { let rem = Math.ceil((s.timerEndsAt - Date.now()) / 1000); if (rem < 0) rem = 0; document.querySelectorAll('#decision-timer, #duel-timer').forEach(el => el.innerText = rem); }; updateTimer(); clientTimerInterval = setInterval(updateTimer, 250); }
            const me = s.players.find(p=>p.uuid===myUUID); if(!me) return;
            if(s.state === 'waiting') { changeScreen('lobby'); document.getElementById('lobby-users').innerHTML = s.players.map(p => '<div class="lobby-row">' + p.name + (s.iamAdmin && p.uuid !== myUUID ? '<button onclick="kick(\\''+p.id+'\\')">X</button>' : '') + '</div>').join(''); document.getElementById('start-btn').style.display = s.iamAdmin ? 'block' : 'none'; }
            else if(s.state === 'playing' || s.state === 'round_ending') {
                 changeScreen('game-area'); document.body.classList.add('playing-state'); if(s.activeColor) document.body.className = 'playing-state bg-'+s.activeColor;
                 document.getElementById('players-zone').innerHTML = s.players.map(p => '<div class="player-badge ' + (p.isTurn?'is-turn':'') + ' ' + (p.isDead?'is-dead':'') + '">' + p.name + ' (' + p.cardCount + ')</div>').join('');
                 requestAnimationFrame(repositionHUD); document.getElementById('personal-debt-display').style.display = me.personalDebt > 0 ? 'block' : 'none';
                 if(s.topCard) { const el = document.getElementById('top-card'); el.style.backgroundColor = getBgColor(s.topCard); el.innerText = getCardText(s.topCard); el.style.color = (s.topCard.color==='amarillo'||s.topCard.color==='verde')?'black':'white'; }
                 document.getElementById('btn-pass').style.display = (me.isTurn && me.hasDrawn && s.pendingPenalty === 0 && !s.librePending) ? 'inline-block' : 'none';
                 if(me.isTurn && s.pendingPenalty > 0) { document.getElementById('penalty-display').style.display='block'; document.getElementById('pen-num').innerText = s.pendingPenalty; } else document.getElementById('penalty-display').style.display='none';
            } 
            else if (s.state === 'rip_decision' || s.state === 'penalty_decision') {
                changeScreen('game-area'); forceCloseModals(); document.body.classList.add('state-rip');
                if(s.duelInfo.defenderId === myUUID) { 
                    document.getElementById('rip-screen').style.display = 'flex'; 
                    document.getElementById('rip-msg-custom').innerText = s.state === 'rip_decision' ? 'RIP por ' + s.duelInfo.attackerName : 'Castigo por ' + s.duelInfo.attackerName;
                    document.getElementById('btn-accept-penalty').style.display = s.state === 'penalty_decision' ? 'inline-block' : 'none';
                    document.getElementById('btn-surrender').style.display = s.state === 'rip_decision' ? 'inline-block' : 'none';
                }
            }
            else if (s.state === 'dueling') {
                changeScreen('game-area'); forceCloseModals(); document.body.classList.add('state-dueling');
                document.getElementById('duel-screen').style.display = 'flex'; document.getElementById('duel-sc').innerText = s.duelInfo.scoreAttacker + ' - ' + s.duelInfo.scoreDefender;
                const amFighter = (myUUID === s.duelInfo.attackerId || myUUID === s.duelInfo.defenderId); 
                document.getElementById('duel-opts').style.display = amFighter ? 'flex' : 'none';
                if(amFighter) { const isTurn = (s.duelInfo.turn === myUUID); document.querySelectorAll('.duel-btn').forEach(b => b.disabled = !isTurn); }
            }
        });

        socket.on('handUpdate', h => { const oldLen = myHand.length; myHand = h; renderHand(oldLen); });
        function requestSort() { socket.emit('requestSort'); }
        function renderHand(oldLen) {
            const hz = document.getElementById('hand-zone'); hz.innerHTML = '';
            myHand.forEach((c, index) => {
                const d = document.createElement('div'); d.className = 'hand-card'; if(ladderSelected.includes(c.id)) d.classList.add('selected-ladder');
                d.style.backgroundColor = getBgColor(c); d.style.color = (c.color==='amarillo'||c.color==='verde'||c.value==='GRACIA')?((c.value==='GRACIA')?'red':'black'):'white'; d.innerText = getCardText(c);
                d.onmousedown = d.ontouchstart = () => { pressTimer = setTimeout(() => { if(!ladderMode) { ladderMode = true; toggleLadderSelection(c, d); } }, 800); };
                d.onmouseup = d.onmouseleave = d.ontouchend = () => clearTimeout(pressTimer);
                d.onclick = () => { if(ladderMode) toggleLadderSelection(c, d); else handleCardClick(c); };
                hz.appendChild(d);
            });
        }
        
        function toggleLadderSelection(c, d) { if(ladderSelected.includes(c.id)) { ladderSelected = ladderSelected.filter(id => id !== c.id); d.classList.remove('selected-ladder'); if(ladderSelected.length === 0) cancelLadder(); } else { ladderSelected.push(c.id); d.classList.add('selected-ladder'); } updateLadderUI(); }
        function cancelLadder() { ladderMode = false; ladderSelected = []; document.querySelectorAll('.hand-card').forEach(c => c.classList.remove('selected-ladder')); updateLadderUI(); }
        function updateLadderUI() { const act = ladderMode; document.getElementById('btn-sort').style.display = act ? 'none' : 'block'; document.getElementById('btn-ladder-play').style.display = (act && ladderSelected.length >= 2) ? 'block' : 'none'; document.getElementById('btn-ladder-cancel').style.display = act ? 'block' : 'none'; }

        function handleCardClick(c) {
            if (document.getElementById('personal-debt-display').style.display === 'block') return;
            if(c.value === 'LIBRE') { socket.emit('playLibreInitial', c.id); return; }
            if(c.color==='negro') { pendingCard=c.id; document.getElementById('color-picker').style.display='flex'; } 
            else socket.emit('playCard', c.id);
        }
        function pickCol(c){ document.getElementById('color-picker').style.display='none'; socket.emit('playCard', pendingCard, c, null, pendingLibreContext); }
        function changeScreen(id) { document.querySelectorAll('.screen').forEach(s=>s.style.display='none'); document.getElementById('game-area').style.display='none'; document.getElementById(id).style.display='flex'; repositionHUD(); }
        function start(){ socket.emit('requestStart'); } function draw(){ socket.emit('draw'); } function pass(){ socket.emit('passTurn'); }
        function trySayUno() { sayUno(); } function sayUno(){ socket.emit('sayUno'); toggleUnoMenu(); }
        function toggleUnoMenu() { const m = document.getElementById('uno-menu'); m.style.display = (m.style.display==='flex'?'none':'flex'); }
        function showDenounceList() { const cont = document.getElementById('denounce-list-container'); cont.innerHTML = ''; currentPlayers.forEach(p => { if (p.uuid !== myUUID) { const b = document.createElement('button'); b.innerText = p.name; b.onclick = () => { socket.emit('reportUno', p.id); toggleUnoMenu(); }; cont.appendChild(b); } }); }
        function sendChat(){ const i=document.getElementById('chat-in'); if(i.value){ socket.emit('sendChat',i.value); i.value=''; }}
        function toggleChat(){ const w = document.getElementById('chat-win'); if(isChatOpen) { w.style.display = 'none'; isChatOpen = false; } else { w.style.display = 'flex'; isChatOpen = true; } }
        function toggleScores() { const r = document.getElementById('score-modal'); r.style.display = r.style.display === 'flex' ? 'none' : 'flex'; }
        function toggleManual() { const r = document.getElementById('manual-modal'); r.style.display = r.style.display === 'flex' ? 'none' : 'flex'; }
        function ripResp(d){ socket.emit('ripDecision',d); } function pick(c){ socket.emit('duelPick',c); }
        socket.on('gameOver', d => { alert('FIN. Gana ' + d.winner); location.reload(); });
    </script>
</body>
</html>
    `);
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {});
