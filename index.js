const express = require('express');
const app = express();
const http = require('http').createServer(app);

// --- CONFIGURACIÓN SOCKET.IO ---
const io = require('socket.io')(http, {
    pingTimeout: 15000,
    pingInterval: 8000
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
        players: [], deck: [], discardPile: [], currentTurn: 0, roundStarterIndex: 0, direction: 1, activeColor: '',
        pendingPenalty: 0, pendingSkip: 0, scores: {}, roundCount: 1,
        duelState: { attackerId: null, defenderId: null, attackerName: '', defenderName: '', round: 1, scoreAttacker: 0, scoreDefender: 0, attackerChoice: null, defenderChoice: null, history: [], turn: null, narrative: '', type: 'rip', originalPenalty: 0, originalSkip: 0, triggerCard: null },
        chatHistory: [], lastActivity: Date.now(), actionTimer: null, turnTimer: null, afkTimer: null, timerEndsAt: null, resumeTurnFrom: null, interruptedTurn: false 
    };
}

function getRoomId(socket) {
    for (const rId in rooms) { if (rooms[rId].players.some(p => p.id === socket.id)) return rId; }
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
    const addSpecial = (val, count) => { for(let k=0; k<count; k++) room.deck.push({ color: 'negro', value: val, type: 'special', id: Math.random().toString(36) }); };
    addSpecial('RIP', 2); addSpecial('GRACIA', 2); addSpecial('+12', 2); addSpecial('LIBRE', 2); addSpecial('SALTEO SUPREMO', 2);
    
    for (let i = room.deck.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [room.deck[i], room.deck[j]] = [room.deck[j], room.deck[i]]; }
}

function recycleDeck(roomId) {
    const room = rooms[roomId]; if(!room) return;
    if (room.discardPile.length <= 1) { createDeck(roomId); io.to(roomId).emit('notification', '⚠️ Mazo regenerado.'); return; }
    const topCard = room.discardPile.pop(); room.deck = [...room.discardPile]; room.discardPile = [topCard];
    for (let i = room.deck.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [room.deck[i], room.deck[j]] = [room.deck[j], room.deck[i]]; }
    io.to(roomId).emit('notification', '♻️ Barajando descartes...');
}

function getCardPoints(card) {
    if (!card) return 0;
    if (card.value === 'RIP') return 100; if (['+12', 'SALTEO SUPREMO', 'LIBRE'].includes(card.value)) return 80;
    if (['+4', 'color'].includes(card.value)) return 40; if (['+2', 'R', 'X'].includes(card.value)) return 20;
    if (card.value === '1 y 1/2') return 1.5;
    const val = parseInt(card.value); return isNaN(val) ? 0 : val;
}

const safe = (fn) => (...args) => { try { fn(...args); } catch (err) { console.error("Socket Error Prevenido:", err); } };

function forceKickAFK(roomId, uuid) {
    try {
        const room = rooms[roomId]; if(!room) return;
        const pIndex = room.players.findIndex(p => p.uuid === uuid); if(pIndex === -1) return;
        const player = room.players[pIndex]; player.isDead = true; player.isSpectator = true; player.hasLeft = true;
        let msg = `🚪 ${player.name} fue expulsado de la partida por inactividad extrema.`;
        if (player.isAdmin) {
            player.isAdmin = false; const nextAdmin = room.players.find(p => !p.isDead && !p.isSpectator && !p.hasLeft);
            if (nextAdmin) { nextAdmin.isAdmin = true; msg += `\n👑 Ahora ${nextAdmin.name} es el nuevo anfitrión.`; }
        }
        const socketToKick = io.sockets.sockets.get(player.id); if(socketToKick) { socketToKick.leave(roomId); socketToKick.emit('requireLogin'); }
        if (getAlivePlayersCount(roomId) <= 1) { io.to(roomId).emit('notification', msg); checkWinCondition(roomId); } 
        else {
            if (room.currentTurn === pIndex) { room.pendingPenalty = 0; room.pendingSkip = 0; if (room.gameState === 'libre_choosing') room.gameState = 'playing'; advanceTurn(roomId, 1); }
            io.to(roomId).emit('gamePaused', { message: msg, duration: 4000 });
            setTimeout(() => { try { if(rooms[roomId]) updateAll(roomId); } catch(e){} }, 4000);
        }
    } catch (e) {}
}

function handleTimeout(roomId, targetUuid, stateContext) {
    try {
        const room = rooms[roomId]; if (!room) return;
        const targetIdx = room.players.findIndex(p => p.uuid === targetUuid); if (targetIdx === -1) return;
        const target = room.players[targetIdx];
        if (stateContext === 'penalty_decision' && room.gameState === 'penalty_decision') {
            io.to(roomId).emit('notification', `⏳ Tiempo agotado. ${target.name} perdió la chance de batirse a duelo y recibe el castigo automáticamente.`);
            room.gameState = 'playing'; updateAll(roomId);
        } else if (stateContext === 'rip_decision' && room.gameState === 'rip_decision') {
            io.to(roomId).emit('notification', `⏳ Tiempo agotado. ${target.name} se quedó paralizado por el miedo y fue eliminado.`);
            eliminatePlayer(roomId, targetUuid); checkWinCondition(roomId);
            if (rooms[roomId] && rooms[roomId].gameState !== 'game_over') { room.gameState = 'playing'; room.currentTurn = room.players.findIndex(p => p.uuid === room.duelState.attackerId); advanceTurn(roomId, 1); updateAll(roomId); }
        } else if (stateContext === 'dueling' && room.gameState === 'dueling') {
            if (targetUuid === room.duelState.attackerId) room.duelState.attackerChoice = null; else if (targetUuid === room.duelState.defenderId) room.duelState.defenderChoice = null; 
            resolveDuelRound(roomId, true);
        } 
    } catch (e) {}
}

function manageTimers(roomId) {
    const room = rooms[roomId]; if (!room) return;
    if (room.actionTimer) { clearTimeout(room.actionTimer); room.actionTimer = null; }
    if (room.turnTimer) { clearTimeout(room.turnTimer); room.turnTimer = null; }
    if (room.afkTimer) { clearTimeout(room.afkTimer); room.afkTimer = null; }

    let targetUuid = null; let stateCtx = '';
    if (room.gameState === 'rip_decision' || room.gameState === 'penalty_decision') { targetUuid = room.duelState.defenderId; stateCtx = room.gameState; } 
    else if (room.gameState === 'dueling') { targetUuid = room.duelState.turn; stateCtx = 'dueling'; }

    if (targetUuid) {
        room.timerEndsAt = Date.now() + 20000;
        room.actionTimer = setTimeout(() => handleTimeout(roomId, targetUuid, stateCtx), 20000); return; 
    }

    if ((room.gameState === 'playing' || room.gameState === 'libre_choosing') && getAlivePlayersCount(roomId) > 1) {
        const currentPlayer = room.players[room.currentTurn];
        if (currentPlayer && !currentPlayer.isDead && !currentPlayer.isSpectator && !currentPlayer.hasLeft) {
            room.timerEndsAt = null; 
            room.turnTimer = setTimeout(() => {
                io.to(currentPlayer.id).emit('showAFKPrompt');
                room.afkTimer = setTimeout(() => forceKickAFK(roomId, currentPlayer.uuid), 10000);
            }, 20000);
        }
    } else { room.timerEndsAt = null; }
}

// --- SOCKETS ---
io.on('connection', (socket) => {
    socket.on('checkSession', safe((uuid) => {
        let foundRoomId = null; let foundPlayer = null;
        for (const rId in rooms) { const p = rooms[rId].players.find(pl => pl.uuid === uuid); if (p) { foundRoomId = rId; foundPlayer = p; break; } }
        if (foundRoomId && foundPlayer) {
            foundPlayer.id = socket.id; foundPlayer.isConnected = true;
            if (foundPlayer.hasLeft) {
                foundPlayer.hasLeft = false; const room = rooms[foundRoomId];
                if (room.gameState === 'waiting') { foundPlayer.isDead = false; foundPlayer.isSpectator = false; const idx = room.players.indexOf(foundPlayer); if (idx !== -1) { room.players.splice(idx, 1); room.players.push(foundPlayer); } } else { foundPlayer.isSpectator = true; }
                io.to(foundRoomId).emit('notification', `👋 ${foundPlayer.name} se ha reconectado.`);
            }
            socket.join(foundRoomId); touchRoom(foundRoomId); updateAll(foundRoomId);
        } else { socket.emit('requireLogin'); }
    }));

    socket.on('createRoom', safe((data) => {
        const roomId = Math.random().toString(36).substring(2, 6).toUpperCase(); initRoom(roomId);
        const player = createPlayerObj(socket.id, data.uuid, data.name, true);
        rooms[roomId].scores[data.uuid] = 0; rooms[roomId].players.push(player); socket.join(roomId); socket.emit('roomCreated', { roomId, name: data.name }); updateAll(roomId);
    }));

    socket.on('joinRoom', safe((data) => {
        const roomId = data.roomId.toUpperCase(); const room = rooms[roomId];
        if (!room) { socket.emit('error', 'Sala no encontrada.'); return; }
        touchRoom(roomId); const existing = room.players.find(p => p.uuid === data.uuid);
        if (existing) { 
            existing.id = socket.id; existing.name = data.name; existing.isConnected = true; 
            if (existing.hasLeft) { existing.hasLeft = false; if (room.gameState === 'waiting') { existing.isDead = false; existing.isSpectator = false; const idx = room.players.indexOf(existing); if (idx !== -1) { room.players.splice(idx, 1); room.players.push(existing); } } else { existing.isSpectator = true; } io.to(roomId).emit('notification', `👋 ${existing.name} regresó a la sala.`); }
            socket.join(roomId); socket.emit('roomJoined', { roomId }); 
        } else {
            const player = createPlayerObj(socket.id, data.uuid, data.name, (room.players.length === 0)); player.isSpectator = (room.gameState !== 'waiting');
            if(room.scores[data.uuid] === undefined) room.scores[data.uuid] = 0;
            room.players.push(player); socket.join(roomId); socket.emit('roomJoined', { roomId }); io.to(roomId).emit('notification', `👋 ${player.name} entró.`);
        }
        updateAll(roomId);
    }));

    socket.on('imHere', safe(() => { const roomId = getRoomId(socket); if(!roomId || !rooms[roomId]) return; touchRoom(roomId); manageTimers(roomId); }));
    
    socket.on('requestSort', safe(() => {
        const roomId = getRoomId(socket); if(!roomId || !rooms[roomId]) return; const room = rooms[roomId]; const p = room.players.find(x => x.id === socket.id); if(!p) return;
        p.hand.sort((a,b) => { const cA = sortColWeights[a.color] || 99; const cB = sortColWeights[b.color] || 99; if(cA !== cB) return cA - cB; const vA = sortValWeights[a.value] !== undefined ? sortValWeights[a.value] : 99; const vB = sortValWeights[b.value] !== undefined ? sortValWeights[b.value] : 99; return vA - vB; });
        io.to(p.id).emit('handUpdate', p.hand); socket.emit('notification', 'Cartas ordenadas.'); manageTimers(roomId); 
    }));

    socket.on('kickPlayer', safe((targetId) => {
        const roomId = getRoomId(socket); if(!roomId || !rooms[roomId]) return; const room = rooms[roomId]; const admin = room.players.find(p => p.id === socket.id);
        if(admin && admin.isAdmin) { const idx = room.players.findIndex(p => p.id === targetId); if(idx !== -1) { room.players.splice(idx, 1); updateAll(roomId); io.to(targetId).emit('error', 'Has sido expulsado de la sala.'); } }
    }));

    socket.on('requestStart', safe(() => { const roomId = getRoomId(socket); if(!roomId || !rooms[roomId]) return; const room = rooms[roomId]; if (room.gameState === 'waiting' && room.players.length >= 2) startCountdown(roomId); }));

    socket.on('requestLeave', safe(() => {
        const roomId = getRoomId(socket); if(!roomId || !rooms[roomId]) return; const room = rooms[roomId]; const pIndex = room.players.findIndex(p => p.id === socket.id); if (pIndex === -1) return; const player = room.players[pIndex];
        const isMyTurn = (room.currentTurn === pIndex); const hasPenalty = (isMyTurn && room.pendingPenalty > 0); const inDuel = (['dueling', 'rip_decision', 'penalty_decision'].includes(room.gameState) && (room.duelState.attackerId === player.uuid || room.duelState.defenderId === player.uuid));
        if (hasPenalty || inDuel) { socket.emit('notification', '🚫 No puedes huir si tienes un castigo o duelo pendiente.'); return; }
        if (player.isAdmin) { socket.emit('showLeaveAdminPrompt'); } else { socket.emit('showLeaveNormalPrompt'); }
    }));

    socket.on('confirmLeave', safe((choice) => {
        const roomId = getRoomId(socket); if(!roomId || !rooms[roomId]) return; const room = rooms[roomId]; const pIndex = room.players.findIndex(p => p.id === socket.id); if (pIndex === -1) return; const player = room.players[pIndex];
        if (choice === 'leave_host_end' && player.isAdmin) {
            if (room.gameState === 'waiting') { io.to(roomId).emit('roomCancelled'); } else { io.to(roomId).emit('notification', `⚠️ El anfitrión finalizó la partida para todos.`); io.to(roomId).emit('gameOver', { winner: 'Partida Cancelada', totalScore: 0, reason: 'cancelled' }); }
            if (room.actionTimer) clearTimeout(room.actionTimer); if (room.turnTimer) clearTimeout(room.turnTimer); if (room.afkTimer) clearTimeout(room.afkTimer); setTimeout(() => { delete rooms[roomId]; }, 3000); return;
        }
        player.isDead = true; player.isSpectator = true; player.hasLeft = true; let msg = `🚪 ${player.name} abandonó la partida.`;
        if (player.isAdmin) { player.isAdmin = false; const nextAdmin = room.players.find(p => !p.isDead && !p.isSpectator && !p.hasLeft); if (nextAdmin) { nextAdmin.isAdmin = true; msg += `\n👑 Ahora ${nextAdmin.name} es el nuevo anfitrión.`; } }
        const socketToKick = io.sockets.sockets.get(player.id); if(socketToKick) { socketToKick.leave(roomId); socketToKick.emit('requireLogin'); }
        if (getAlivePlayersCount(roomId) <= 1) { io.to(roomId).emit('notification', msg); checkWinCondition(roomId); } 
        else {
            const oldState = room.gameState;
            if (oldState === 'playing' || oldState === 'waiting') {
                room.gameState = 'paused'; io.to(roomId).emit('gamePaused', { message: msg, duration: 4000 });
                if (room.currentTurn === pIndex && oldState === 'playing') advanceTurn(roomId, 1);
                updateAll(roomId); setTimeout(() => { try { if (rooms[roomId]) { room.gameState = oldState; updateAll(roomId); } } catch(e){} }, 4000);
            } else { if (room.currentTurn === pIndex) advanceTurn(roomId, 1); updateAll(roomId); }
        }
    }));

    socket.on('playMultiCards', safe((cardIds) => {
        const roomId = getRoomId(socket); if(!roomId || !rooms[roomId]) return; touchRoom(roomId);
        const room = rooms[roomId]; const pIndex = room.players.findIndex(p => p.id === socket.id); const player = room.players[pIndex];
        if (room.gameState !== 'playing' || pIndex !== room.currentTurn || room.pendingPenalty > 0) return;
        if (!cardIds || cardIds.length < 2) return; 

        let playCards = []; let tempHand = [...player.hand];
        for(let id of cardIds) { const c = tempHand.find(x => x.id === id); if(!c) return; playCards.push(c); }
        const top = room.discardPile.length > 0 ? room.discardPile[room.discardPile.length - 1] : { value: '0', color: 'rojo' };

        const isAll15 = playCards.every(c => c.value === '1 y 1/2');
        if (isAll15) {
            const count = playCards.length;
            if (count !== 2 && count !== 4 && count !== 6) { socket.emit('notification', '🚫 Solo puedes agrupar 2, 4 o 6 cartas "1 y 1/2".'); return; }
            const targetVal = (count * 1.5).toString();
            if (top.value !== targetVal) { socket.emit('notification', `🚫 Coincidencia numérica requerida. Debes arrojarlas sobre un ${targetVal}.`); return; }
            const finalColor = playCards[playCards.length - 1].color;
            removeCards(player, cardIds); room.discardPile.push(...playCards); room.activeColor = finalColor; 
            io.to(roomId).emit('ladderAnimate', { cards: playCards, playerName: player.name }); io.to(roomId).emit('notification', `✨ ¡COMBO MATEMÁTICO! ${player.name} combinó ${count} cartas "1 y 1/2" y formó un ${targetVal}.`); io.to(roomId).emit('playSound', 'divine'); checkUnoCheck(roomId, player);
            if(player.hand.length === 0) { room.gameState = 'animating_win'; updateAll(roomId); setTimeout(() => calculateAndFinishRound(roomId, player), 1000); } else { advanceTurn(roomId, 1); updateAll(roomId); }
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
                const isAsc = (min === topIdx + 1 && max === topIdx + 2); const isDesc = (max === topIdx - 1 && min === topIdx - 2);
                if (isAsc || isDesc) { isValidPlay = true; if (isAsc) playCards.sort((a,b) => ladderOrder.indexOf(a.value) - ladderOrder.indexOf(b.value)); if (isDesc) playCards.sort((a,b) => ladderOrder.indexOf(b.value) - ladderOrder.indexOf(a.value)); } else { socket.emit('notification', '🚫 No conectan con la mesa.'); return; }
            } else { socket.emit('notification', '🚫 Color/Número mesa inválido.'); return; }
        } else {
             let colorMatch = (firstColor === room.activeColor); let valueMatch = false;
             if (!colorMatch && playCards.some(c => c.value === top.value)) valueMatch = true;
             if (colorMatch || valueMatch) { isValidPlay = true; playCards.sort((a,b) => ladderOrder.indexOf(a.value) - ladderOrder.indexOf(b.value)); } else { socket.emit('notification', '🚫 Color no coincide.'); return; }
        }

        if (isValidPlay) {
            removeCards(player, cardIds); room.discardPile.push(...playCards); room.activeColor = firstColor;
            io.to(roomId).emit('ladderAnimate', { cards: playCards, playerName: player.name }); io.to(roomId).emit('notification', `🪜 ¡ESCALERA de ${player.name}!`); io.to(roomId).emit('playSound', 'soft'); checkUnoCheck(roomId, player);
            if(player.hand.length === 0) { room.gameState = 'animating_win'; updateAll(roomId); setTimeout(() => calculateAndFinishRound(roomId, player), 1000); } else { advanceTurn(roomId, 1); updateAll(roomId); }
        }
    }));

    socket.on('confirmReviveSingle', safe((data) => {
        const roomId = getRoomId(socket); if(!roomId || !rooms[roomId]) return; touchRoom(roomId);
        const room = rooms[roomId]; const pIndex = room.players.findIndex(p => p.id === socket.id); const player = room.players[pIndex];
        if (room.gameState !== 'playing' || pIndex !== room.currentTurn) return;
