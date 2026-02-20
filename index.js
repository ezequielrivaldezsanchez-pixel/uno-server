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
        duelState: { 
            attackerId: null, defenderId: null, attackerName: '', defenderName: '', 
            round: 1, scoreAttacker: 0, scoreDefender: 0, 
            attackerChoice: null, defenderChoice: null, history: [], turn: null, narrative: '',
            type: 'rip', originalPenalty: 0, originalSkip: 0
        },
        chatHistory: [],
        lastActivity: Date.now(),
        actionTimer: null
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

// --- GESTIÓN DE EXPULSIÓN POR INACTIVIDAD ---

function getNextPlayerFrom(roomId, startIdx) {
    const room = rooms[roomId];
    let current = startIdx;
    for(let i=0; i<room.players.length; i++) {
        current = (current + room.direction + room.players.length) % room.players.length;
        if(!room.players[current].isDead && !room.players[current].isSpectator && !room.players[current].hasLeft) return current;
    }
    return current;
}

function executeCowardKick(roomId, targetUuid) {
    const room = rooms[roomId]; if (!room) return;
    const targetIdx = room.players.findIndex(p => p.uuid === targetUuid);
    if (targetIdx === -1) return;
    const player = room.players[targetIdx];
    if (player.hasLeft) return; 

    player.isDead = true; player.isSpectator = true; player.hasLeft = true;
    io.to(roomId).emit('notification', `⚠️ ${player.name} fue expulsado de la partida por no asumir sus responsabilidades como jugador.`);
    
    const socketToKick = io.sockets.sockets.get(player.id);
    if (socketToKick) { socketToKick.leave(roomId); socketToKick.emit('requireLogin'); }

    if (player.isAdmin) {
        player.isAdmin = false;
        const nextAdmin = room.players.find(p => !p.isDead && !p.isSpectator && !p.hasLeft);
        if (nextAdmin) {
            nextAdmin.isAdmin = true;
            io.to(roomId).emit('notification', `👑 ${nextAdmin.name} es el nuevo anfitrión.`);
        }
    }

    if (getAlivePlayersCount(roomId) <= 1) {
        checkWinCondition(roomId);
        return;
    }

    const isPenaltyDuel = room.duelState.type === 'penalty';

    if (room.gameState === 'playing' && room.pendingPenalty > 0) {
        if (room.currentTurn === targetIdx) {
            const nextIdx = getNextPlayerFrom(roomId, targetIdx);
            room.currentTurn = nextIdx;
            const nextPlayer = room.players[nextIdx];
            io.to(roomId).emit('notification', `🩸 ¡El castigo pendiente de ${player.name} se transfiere a ${nextPlayer.name}!`);
        }
    } else if (room.gameState === 'rip_decision' || room.gameState === 'penalty_decision') {
        if (targetUuid === room.duelState.defenderId) {
            const nextIdx = getNextPlayerFrom(roomId, targetIdx);
            const nextPlayer = room.players[nextIdx];
            room.duelState.defenderId = nextPlayer.uuid;
            room.duelState.defenderName = nextPlayer.name;
            if (room.currentTurn === targetIdx) room.currentTurn = nextIdx;
            room.duelState.narrative = `¡${player.name} huyó! 🩸 ${nextPlayer.name} hereda el duelo.`;
        } else if (targetUuid === room.duelState.attackerId) {
            room.gameState = 'playing'; room.pendingPenalty = 0; room.pendingSkip = 0;
            room.currentTurn = room.players.findIndex(p => p.uuid === room.duelState.defenderId);
        }
    } else if (room.gameState === 'dueling') {
        if (targetUuid === room.duelState.attackerId) {
            io.to(roomId).emit('notification', `¡${player.name} huyó! ${room.duelState.defenderName} se salva.`);
            room.gameState = 'playing'; room.pendingPenalty = 0; room.pendingSkip = 0;
            room.currentTurn = room.players.findIndex(p => p.uuid === room.duelState.defenderId);
        } else {
            if (isPenaltyDuel) {
                const nextIdx = getNextPlayerFrom(roomId, targetIdx);
                const nextPlayer = room.players[nextIdx];
                room.pendingPenalty += 4; 
                room.gameState = 'playing';
                room.currentTurn = nextIdx;
                io.to(roomId).emit('notification', `¡${player.name} huyó del duelo! ${nextPlayer.name} hereda TODO el castigo.`);
            } else {
                room.gameState = 'playing';
                room.currentTurn = room.players.findIndex(p => p.uuid === room.duelState.attackerId);
                advanceTurn(roomId, 1);
            }
        }
    }

    updateAll(roomId);
}

function checkPenaltyTimer(roomId) {
    const room = rooms[roomId]; if (!room) return;
    if (room.actionTimer) { clearTimeout(room.actionTimer); room.actionTimer = null; }

    let targetUuid = null;
    if (room.gameState === 'playing' && room.pendingPenalty > 0) {
        if (room.players[room.currentTurn]) targetUuid = room.players[room.currentTurn].uuid;
    } else if (room.gameState === 'rip_decision' || room.gameState === 'penalty_decision') {
        targetUuid = room.duelState.defenderId;
    } else if (room.gameState === 'dueling') {
        targetUuid = room.duelState.turn;
    }

    if (targetUuid) {
        room.actionTimer = setTimeout(() => {
            executeCowardKick(roomId, targetUuid);
        }, 10000);
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
        const pIndex = room.players.findIndex(p => p.id === socket.id);
        if (pIndex === -1) return;
        const player = room.players[pIndex];

        const isMyTurn = (room.currentTurn === pIndex);
        const hasPenalty = (isMyTurn && room.pendingPenalty > 0);
        const inDuel = (['dueling', 'rip_decision', 'penalty_decision'].includes(room.gameState) && (room.duelState.attackerId === player.uuid || room.duelState.defenderId === player.uuid));

        if (hasPenalty || inDuel) {
            socket.emit('notification', '🚫 No puedes huir si tienes un castigo o duelo pendiente.');
            return;
        }

        if (player.isAdmin) { socket.emit('showLeaveAdminPrompt'); } 
        else { socket.emit('showLeaveNormalPrompt'); }
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
                setTimeout(() => { if (rooms[roomId]) { room.gameState = oldState; updateAll(roomId); } }, 4000);
            } else {
                if (room.currentTurn === pIndex) advanceTurn(roomId, 1);
                updateAll(roomId);
            }
        }
    }));

    socket.on('playMultiCards', safe((cardIds) => {
        const roomId = getRoomId(socket); if(!roomId || !rooms[roomId]) return; touchRoom(roomId);
        const room = rooms[roomId]; const pIndex = room.players.findIndex(p => p.id === socket.id); const player = room.players[pIndex];
        if (room.gameState !== 'playing' || pIndex !== room.currentTurn || room.pendingPenalty > 0) return;
        if (!cardIds || cardIds.length < 2) return; 

        let playCards = []; let tempHand = [...player.hand];
        for(let id of cardIds) { const c = tempHand.find(x => x.id === id); if(!c) return; playCards.push(c); }
        const top = room.discardPile[room.discardPile.length - 1];

        if (playCards.length === 2 && playCards[0].value === '1 y 1/2' && playCards[1].value === '1 y 1/2') {
            const c1 = playCards[0]; const c2 = playCards[1];
            if (c1.color !== c2.color) { socket.emit('notification', '🚫 Deben ser del mismo color.'); return; }
            if (top.value !== '3') { socket.emit('notification', '🚫 Solo sobre un 3.'); return; }
            
            removeCards(player, cardIds);
            room.discardPile.push(...playCards); room.activeColor = c1.color; 
            io.to(roomId).emit('notification', `✨ ¡COMBO MATEMÁTICO! (1.5 + 1.5 = 3)`); io.to(roomId).emit('playSound', 'divine'); 
            checkUnoCheck(roomId, player);
            if(player.hand.length === 0) { calculateAndFinishRound(roomId, player); } else { advanceTurn(roomId, 1); updateAll(roomId); }
            return;
        }

        const firstColor = playCards[0].color;
        if(firstColor === 'negro') { socket.emit('notification', '🚫 Escaleras solo con color.'); return; }
        if(!playCards.every(c => c.color === firstColor)) { socket.emit('notification', '🚫 Mismo color requerido.'); return; }
        
        const indices = playCards.map(c => ladderOrder.indexOf(c.value));
        if(indices.includes(-1)) { socket.emit('notification', '🚫 Solo números y 1y1/2.'); return; }
        
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
            io.to(roomId).emit('ladderAnimate', { cards: playCards, playerName: player.name });
            io.to(roomId).emit('notification', `🪜 ¡ESCALERA de ${player.name}!`); io.to(roomId).emit('playSound', 'soft');
            checkUnoCheck(roomId, player);
            if(player.hand.length === 0) { calculateAndFinishRound(roomId, player); } else { advanceTurn(roomId, 1); updateAll(roomId); }
        }
    }));

    socket.on('confirmReviveSingle', safe((data) => {
        const roomId = getRoomId(socket); if(!roomId || !rooms[roomId]) return; touchRoom(roomId);
        const room = rooms[roomId]; const pIndex = room.players.findIndex(p => p.id === socket.id); const player = room.players[pIndex];
        if (room.gameState !== 'playing' || pIndex !== room.currentTurn) return;
        
        let cardIndex = player.hand.findIndex(c => c.id === data.cardId); 
        let card = (cardIndex !== -1) ? player.hand[cardIndex] : null;

        if (!card) {
            const top = room.discardPile[room.discardPile.length - 1];
            if (top && top.id === data.cardId) card = top;
        }
        if(!card) return;

        const deadPlayers = room.players.filter(p => p.isDead && !p.hasLeft);

        if(data.confirmed && deadPlayers.length === 1) {
             const target = deadPlayers[0]; target.isDead = false; target.isSpectator = false;
             io.to(roomId).emit('playerRevived', { savior: player.name, revived: target.name }); io.to(roomId).emit('playSound', 'divine');
             
             if (data.chosenColor) room.activeColor = data.chosenColor; else if (!room.activeColor) room.activeColor = 'rojo';
             if (player.hand.length === 0) { calculateAndFinishRound(roomId, player); return; }
             checkUnoCheck(roomId, player); advanceTurn(roomId, 1); updateAll(roomId);
        } else {
             if (cardIndex === -1) { advanceTurn(roomId, 1); updateAll(roomId); }
        }
    }));

    socket.on('playCard', safe((cardId, chosenColor, reviveTargetId, libreContext) => {
        const roomId = getRoomId(socket); if(!roomId || !rooms[roomId]) return; touchRoom(roomId);
        const room = rooms[roomId]; 
        if (room.gameState !== 'playing' && room.gameState !== 'penalty_decision') return;
        
        const pIndex = room.players.findIndex(p => p.id === socket.id); if (pIndex === -1) return;
        const player = room.players[pIndex]; if (player.isDead || player.isSpectator || player.hasLeft) return;
        if (room.gameState === 'penalty_decision' && pIndex !== room.currentTurn) return;

        let isLibreDiscard = false;

        if (libreContext) {
            const lIdx = player.hand.findIndex(c => c.id === libreContext.libreId);
            const gIdx = player.hand.findIndex(c => c.id === libreContext.giftId);
            const target = room.players.find(p => p.id === libreContext.targetId);
            if (lIdx === -1 || gIdx === -1 || !target) return;

            room.pendingPenalty = 0; room.pendingSkip = 0;
            if (room.gameState === 'penalty_decision') {
                room.gameState = 'playing';
                io.to(roomId).emit('notification', `🛡️ ${player.name} usó LIBRE ALBEDRÍO para bloquear el castigo.`);
            } else {
                io.to(roomId).emit('notification', `🕊️ ${player.name} usó LIBRE ALBEDRÍO.`);
            }
            io.to(roomId).emit('playSound', 'wild');

            player.hand.splice(lIdx, 1);
            room.discardPile.push({ color: 'negro', value: 'LIBRE', type: 'special', id: libreContext.libreId });

            const realGIdx = player.hand.findIndex(c => c.id === libreContext.giftId);
            const giftCard = player.hand.splice(realGIdx, 1)[0];
            target.hand.push(giftCard);
            io.to(target.id).emit('handUpdate', target.hand);

            isLibreDiscard = true;
        }

        let cardIndex = player.hand.findIndex(c => c.id === cardId); 
        let card = (cardIndex !== -1) ? player.hand[cardIndex] : null;
        if (!card && reviveTargetId) {
             const top = room.discardPile[room.discardPile.length - 1]; if(top && top.value === 'GRACIA') card = top;
        }
        if (!card) return;
        const top = room.discardPile[room.discardPile.length - 1];

        if (room.gameState === 'penalty_decision') {
            if (card.value === 'GRACIA') {
                player.hand.splice(cardIndex, 1); room.discardPile.push(card);
                io.to(roomId).emit('playSound', 'divine');
                if (chosenColor) room.activeColor = chosenColor; else if (!room.activeColor) room.activeColor = 'rojo';
                io.to(roomId).emit('showDivine', `${player.name} anuló el castigo`);
                room.pendingPenalty = 0; room.pendingSkip = 0; room.gameState = 'playing'; 
                checkUnoCheck(roomId, player);
                if (player.hand.length === 0) { calculateAndFinishRound(roomId, player); return; }
                advanceTurn(roomId, 1); updateAll(roomId); return;
            } 
            else if (card.value === 'LIBRE') { socket.emit('startLibreLogic', card.id); return; }
            else { return; }
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
                    if (room.pendingPenalty > 0) return; 
                    if (player.hand.length === 1) { socket.emit('notification', '🚫 Prohibido ganar con SAFF.'); return; }
                    isSaff = true; room.currentTurn = pIndex; room.pendingPenalty = 0;
                    io.to(roomId).emit('notification', `⚡ ¡${player.name} hizo SAFF!`); io.to(roomId).emit('playSound', 'saff');
                } else { return; }
            }

            if (pIndex === room.currentTurn && !isSaff) {
                if (room.pendingPenalty > 0) {
                    if (card.value === 'SALTEO SUPREMO') {
                        socket.emit('notification', '🚫 SALTEO SUPREMO no puede usarse para defender castigos.'); return;
                    }
                    if (card.value === 'GRACIA' || (card.value === 'LIBRE' && room.pendingSkip === 0)) { /* Pass */ }
                    else {
                        const getVal = (v) => { if (v === '+2') return 2; if (v === '+4') return 4; if (v === '+12') return 12; return 0; };
                        const cardVal = getVal(card.value); const topVal = getVal(top.value);
                        if (cardVal === 0 || cardVal < topVal) { socket.emit('notification', `🚫 Debes tirar un castigo igual/mayor, Gracia o Libre.`); return; }
                    }
                } else {
                    let valid = isLibreDiscard || (card.color === 'negro' || card.value === 'GRACIA' || card.color === room.activeColor || card.value === top.value);
                    if (!valid) { socket.emit('notification', `❌ Carta inválida.`); return; }
                }
            }
        }

        if (room.pendingPenalty > 0 && card.value === 'LIBRE' && room.pendingSkip === 0 && cardIndex !== -1 && !isLibreDiscard) {
             socket.emit('startLibreLogic', card.id); return;
        }

        if (card.value === 'GRACIA') {
            const deadPlayers = room.players.filter(p => p.isDead && !p.hasLeft);
            if (room.pendingPenalty > 0 && cardIndex !== -1) {
                player.hand.splice(cardIndex, 1); room.discardPile.push(card); io.to(roomId).emit('playSound', 'divine');
                if (chosenColor) room.activeColor = chosenColor; else if (!room.activeColor) room.activeColor = 'rojo';
                io.to(roomId).emit('showDivine', `${player.name} anuló el castigo`); 
                room.pendingPenalty = 0; room.pendingSkip = 0; checkUnoCheck(roomId, player);
                if (player.hand.length === 0) { calculateAndFinishRound(roomId, player); return; }
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
                                if (chosenColor) room.activeColor = chosenColor; else if (!room.activeColor) room.activeColor = 'rojo';
                            }
                            io.to(roomId).emit('playSound', 'divine'); checkUnoCheck(roomId, player);
                            if (player.hand.length === 0) { calculateAndFinishRound(roomId, player); return; }
                            advanceTurn(roomId, 1); updateAll(roomId); return;
                        }
                    }
                }
            } else { 
                if (cardIndex !== -1) {
                     io.to(roomId).emit('notification', `❤️ ${player.name} usó Gracia.`); 
                     player.hand.splice(cardIndex, 1); room.discardPile.push(card); io.to(roomId).emit('playSound', 'divine'); 
                     if (chosenColor) room.activeColor = chosenColor; else if (!room.activeColor) room.activeColor = 'rojo';
                     checkUnoCheck(roomId, player);
                     if (player.hand.length === 0) { calculateAndFinishRound(roomId, player); return; }
                     advanceTurn(roomId, 1); updateAll(roomId); return;
                }
            }
        }

        if (cardIndex === -1) return; 

        if (card.value === 'RIP') {
            if (room.pendingPenalty > 0) { socket.emit('notification', '🚫 RIP no evita castigos.'); return; }
            if (getAlivePlayersCount(roomId) < 2) { 
                player.hand.splice(cardIndex, 1); room.discardPile.push(card);
                advanceTurn(roomId, 1); updateAll(roomId); return; 
            }
            
            const victimIdx = getNextPlayerIndex(roomId, 1);
            if (victimIdx === pIndex) { socket.emit('notification', '⛔ No puedes desafiarte a duelo a ti mismo.'); return; }

            player.hand.splice(cardIndex, 1); room.discardPile.push(card); io.to(roomId).emit('playSound', 'rip');
            checkUnoCheck(roomId, player);
            
            room.gameState = 'rip_decision';
            const attacker = player; const defender = room.players[victimIdx];
            room.duelState = { 
                attackerId: attacker.uuid, defenderId: defender.uuid, attackerName: attacker.name, defenderName: defender.name, 
                round: 1, scoreAttacker: 0, scoreDefender: 0, attackerChoice: null, defenderChoice: null, history: [], 
                turn: attacker.uuid, narrative: `💀 ${attacker.name} retó a Duelo a ${defender.name} usando la carta RIP!`, type: 'rip', originalPenalty: 0, originalSkip: 0 
            };
            updateAll(roomId); return;
        }

        if (card.value === 'LIBRE' && !isLibreDiscard) { socket.emit('startLibreLogic', card.id); return; }

        player.hand.splice(cardIndex, 1); room.discardPile.push(card);
        io.to(roomId).emit('cardPlayedEffect', { color: card.color });
        if (card.color === 'negro' && chosenColor) room.activeColor = chosenColor; else if (card.color !== 'negro') room.activeColor = card.color;

        checkUnoCheck(roomId, player); applyCardEffect(roomId, player, card, chosenColor);
    }));

    socket.on('draw', safe(() => {
        const roomId = getRoomId(socket); if(!roomId || !rooms[roomId]) return; touchRoom(roomId);
        const room = rooms[roomId]; if (room.gameState !== 'playing') return;
        const pIndex = room.players.findIndex(p => p.id === socket.id);
        if (pIndex === -1 || room.players[pIndex].isDead || room.players[pIndex].isSpectator) return;
        
        if (pIndex === room.currentTurn) {
            if (room.pendingPenalty > 0) {
                drawCards(roomId, pIndex, 1); room.pendingPenalty--; io.to(roomId).emit('playSound', 'soft');
                
                if (room.pendingPenalty > 0) { 
                    updateAll(roomId); 
                } else { 
                    if (room.pendingSkip > 0) {
                        io.to(roomId).emit('notification', `⛔ ¡${room.players[pIndex].name} PIERDE ${room.pendingSkip} TURNOS!`); 
                        room.players[pIndex].missedTurns += room.pendingSkip;
                        room.pendingSkip = 0;
                    } else { 
                        io.to(roomId).emit('notification', `✅ Fin del castigo.`); 
                    }
                    advanceTurn(roomId, 1);
                    updateAll(roomId); 
                }
            } else {
                if (!room.players[pIndex].hasDrawn) { 
                    drawCards(roomId, pIndex, 1); room.players[pIndex].hasDrawn = true; 
                    room.players[pIndex].saidUno = false; room.players[pIndex].lastOneCardTime = 0;
                    io.to(roomId).emit('playSound', 'soft'); updateAll(roomId); 
                } 
                else { socket.emit('notification', 'Ya robaste. Debes jugar o pasar.'); }
            }
        }
    }));

    socket.on('passTurn', safe(() => {
        const roomId = getRoomId(socket); if(!roomId || !rooms[roomId]) return; touchRoom(roomId);
        const room = rooms[roomId]; if (room.gameState !== 'playing') return;
        const pIndex = room.players.findIndex(p => p.id === socket.id);
        if (pIndex === room.currentTurn && room.players[pIndex].hasDrawn && room.pendingPenalty === 0) { advanceTurn(roomId, 1); updateAll(roomId); }
    }));

    socket.on('ripDecision', safe((d) => {
        const roomId = getRoomId(socket); if(!roomId || !rooms[roomId]) return; touchRoom(roomId);
        const room = rooms[roomId]; if (room.gameState !== 'rip_decision' && room.gameState !== 'penalty_decision') return;
        
        const myUUID = room.players.find(x => x.id === socket.id)?.uuid;
        if (myUUID !== room.duelState.defenderId) return;

        if (d === 'surrender') { 
            if(room.duelState.type === 'rip') { eliminatePlayer(roomId, room.duelState.defenderId); checkWinCondition(roomId); }
        }
        else if (d === 'accept_penalty') {
             const p = room.players.find(x => x.uuid === myUUID);
             io.to(roomId).emit('notification', `${p.name} aceptó el castigo.`); room.gameState = 'playing'; updateAll(roomId);
        }
        else { 
            io.to(roomId).emit('playSound', 'bell'); room.gameState = 'dueling';
            if(room.duelState.type === 'penalty') { room.duelState.narrative = `⚔️ ¡${room.duelState.defenderName} desafió a duelo a ${room.duelState.attackerName} para salvarse!`; } 
            else { room.duelState.narrative = `¡${room.duelState.defenderName} aceptó el duelo!`; }
            room.duelState.turn = room.duelState.attackerId; updateAll(roomId); 
        }
    }));

    socket.on('duelPick', safe((c) => {
        const roomId = getRoomId(socket); if(!roomId || !rooms[roomId]) return; touchRoom(roomId);
        const room = rooms[roomId]; if (room.gameState !== 'dueling') return;
        
        const myUUID = room.players.find(x => x.id === socket.id)?.uuid;
        if (myUUID !== room.duelState.turn) return;

        if (myUUID === room.duelState.attackerId) { 
            room.duelState.attackerChoice = c; room.duelState.turn = room.duelState.defenderId;
            room.duelState.narrative = `⚔️ ${room.duelState.attackerName} eligió. Turno de ${room.duelState.defenderName}...`;
        } 
        else if (myUUID === room.duelState.defenderId) { room.duelState.defenderChoice = c; resolveDuelRound(roomId); return; }
        updateAll(roomId);
    }));
    
    socket.on('sayUno', safe(() => {
        const roomId = getRoomId(socket); if(!roomId) return; const room = rooms[roomId]; 
        if (room.gameState !== 'playing') return;
        const p = room.players.find(x => x.id === socket.id);
        if(p && p.hand.length === 1) { p.saidUno = true; io.to(roomId).emit('notification', `📢 ¡${p.name} gritó "UNO y 1/2"!`); io.to(roomId).emit('playSound', 'uno'); }
    }));

    socket.on('reportUno', safe((targetId) => {
        const roomId = getRoomId(socket); if(!roomId) return; const room = rooms[roomId]; 
        if (room.gameState !== 'playing') { socket.emit('notification', '⛔ No puedes denunciar ahora.'); return; }
        const accuser = room.players.find(x => x.id === socket.id); const target = room.players.find(x => x.id === targetId);
        
        if(!target || target.hand.length !== 1 || target.saidUno) { 
            socket.emit('notification', '🚫 No puedes hacer denuncias falsas.'); 
            return; 
        }
        
        const timeDiff = Date.now() - target.lastOneCardTime;
        if (timeDiff < 2000) { socket.emit('notification', '¡Espera! Tiene tiempo de gracia (2s).'); return; }
        drawCards(roomId, room.players.indexOf(target), 2); target.saidUno = true; 
        io.to(roomId).emit('notification', `🚨 ¡${accuser.name} denunció a ${target.name}! Castigo: +2 cartas.`); updateAll(roomId);
    }));

    socket.on('sendChat', safe((text) => { 
        const roomId = getRoomId(socket); if(!roomId || !rooms[roomId]) return;
        const room = rooms[roomId]; const p = room.players.find(x => x.id === socket.id); 
        if (p) {
            const msg = { name: p.name, text }; room.chatHistory.push(msg);
            if(room.chatHistory.length > 50) room.chatHistory.shift();
            io.to(roomId).emit('chatMessage', msg); 
        }
    }));

    socket.on('disconnect', () => {
        try {
            const roomId = getRoomId(socket);
            if (roomId && rooms[roomId]) { 
                const room = rooms[roomId]; const p = room.players.find(pl => pl.id === socket.id); 
                if(p) {
                    p.isConnected = false;
                    updateAll(roomId);
                }
            }
        } catch(e) { console.error("Error desconexión:", e); }
    });
});

// --- HELPERS ---

function createPlayerObj(socketId, uuid, name, isAdmin) {
    return { id: socketId, uuid, name: name.substring(0, 12), hand: [], hasDrawn: false, isSpectator: false, isDead: false, isAdmin, isConnected: true, saidUno: false, lastOneCardTime: 0, missedTurns: 0, hasLeft: false };
}

function checkUnoCheck(roomId, player) {
    if (player.hand.length === 1) { player.lastOneCardTime = Date.now(); player.saidUno = false; } 
    else { player.saidUno = false; player.lastOneCardTime = 0; }
}

function removeCards(player, ids) {
    ids.forEach(id => { const idx = player.hand.findIndex(c => c.id === id); if(idx !== -1) player.hand.splice(idx, 1); });
}

function applyCardEffect(roomId, player, card, chosenColor) {
    const room = rooms[roomId]; let steps = 1;
    if (card.value === 'R') { if (getAlivePlayersCount(roomId) === 2) steps = 2; else room.direction *= -1; }
    if (card.value === 'X') steps = 2;
    
    if (['+2', '+4', '+12', 'SALTEO SUPREMO'].includes(card.value)) {
        let val = 0; let skips = 0;
        if(card.value === '+2') val=2; if(card.value === '+4') val=4; if(card.value === '+12') val=12;
        if(card.value === 'SALTEO SUPREMO') { val=4; skips=4; }

        room.pendingPenalty += val; room.pendingSkip += skips;
        io.to(roomId).emit('notification', `💥 ¡${card.value}! Total: ${room.pendingPenalty}`); io.to(roomId).emit('playSound', 'attack');
        if (val > 4) io.to(roomId).emit('shakeScreen');

        if (['+12', 'SALTEO SUPREMO'].includes(card.value)) {
            const nextPIdx = getNextPlayerIndex(roomId, 1); const victim = room.players[nextPIdx];
            room.gameState = 'penalty_decision';
            room.duelState = { 
                attackerId: player.uuid, defenderId: victim.uuid, attackerName: player.name, defenderName: victim.name, 
                round: 1, scoreAttacker: 0, scoreDefender: 0, attackerChoice: null, defenderChoice: null, history: [], 
                turn: player.uuid, narrative: `⚔️ ¡${victim.name} puede batirse a duelo para evitar el castigo!`, type: 'penalty', originalPenalty: room.pendingPenalty, originalSkip: room.pendingSkip 
            };
            room.currentTurn = nextPIdx; updateAll(roomId); return;
        }
        advanceTurn(roomId, 1); updateAll(roomId); return; 
    }
    if (card.color === 'negro') io.to(roomId).emit('playSound', 'wild'); else io.to(roomId).emit('playSound', 'soft');
    if (player.hand.length === 0) calculateAndFinishRound(roomId, player); else { advanceTurn(roomId, steps); updateAll(roomId); }
}

function getDuelNarrative(attName, defName, att, def) {
    if (att === def) return `⚡ Choque idéntico. ¡Empate!`;
    if (att === 'fuego' && def === 'hielo') return `🔥 El Fuego de ${attName} derritió el Hielo.`;
    if (att === 'hielo' && def === 'agua') return `❄️ El Hielo de ${attName} congeló el Agua.`;
    if (att === 'agua' && def === 'fuego') return `💧 El Agua de ${attName} apagó el Fuego.`;
    if (def === 'fuego' && att === 'hielo') return `🔥 El Fuego de ${defName} derritió el Hielo.`;
    if (def === 'hielo' && att === 'agua') return `❄️ El Hielo de ${defName} congeló el Agua.`;
    if (def === 'agua' && att === 'fuego') return `💧 El Agua de ${defName} apagó el Fuego.`;
    return "Resultado confuso...";
}

function resolveDuelRound(roomId) {
    const room = rooms[roomId]; const att = room.duelState.attackerChoice, def = room.duelState.defenderChoice; let winner = 'tie';
    if ((att == 'fuego' && def == 'hielo') || (att == 'hielo' && def == 'agua') || (att == 'agua' && def == 'fuego')) winner = 'attacker';
    else if ((def == 'fuego' && att == 'hielo') || (def == 'hielo' && att == 'agua') || (def == 'agua' && att == 'fuego')) winner = 'defender';
    
    if (winner == 'attacker') room.duelState.scoreAttacker++; else if (winner == 'defender') room.duelState.scoreDefender++;
    let winName = 'Empate'; if(winner === 'attacker') winName = room.duelState.attackerName; if(winner === 'defender') winName = room.duelState.defenderName;

    room.duelState.narrative = getDuelNarrative(room.duelState.attackerName, room.duelState.defenderName, att, def);
    room.duelState.history.push({ round: room.duelState.round, att, def, winnerName: winName });
    room.duelState.attackerChoice = null; room.duelState.defenderChoice = null; room.duelState.turn = room.duelState.attackerId; 
    io.to(roomId).emit('playSound', 'soft');
    
    if (room.duelState.scoreAttacker >= 2 || room.duelState.scoreDefender >= 2) { setTimeout(() => finalizeDuel(roomId), 2000); } 
    else { setTimeout(() => { if(rooms[roomId]) { room.duelState.round++; room.duelState.narrative = `Ronda ${room.duelState.round}: ${room.duelState.attackerName} elige arma...`; updateAll(roomId); } }, 2500); updateAll(roomId); }
}

function finalizeDuel(roomId) {
    const room = rooms[roomId]; const att = room.players.find(p => p.uuid === room.duelState.attackerId); const def = room.players.find(p => p.uuid === room.duelState.defenderId);
    if (!att || !def) { room.gameState = 'playing'; updateAll(roomId); return; }
    const attWins = room.duelState.scoreAttacker > room.duelState.scoreDefender; const isPenaltyDuel = room.duelState.type === 'penalty';

    if (attWins) { 
        io.to(roomId).emit('notification', `💀 ${att.name} GANA el duelo.`); 
        if (!isPenaltyDuel) { eliminatePlayer(roomId, def.uuid); checkWinCondition(roomId); } 
        else { io.to(roomId).emit('notification', `🩸 ¡Castigo AUMENTADO para ${def.name}!`); room.pendingPenalty += 4; room.gameState = 'playing'; updateAll(roomId); }
    } else { 
        io.to(roomId).emit('notification', `🛡️ ${def.name} GANA el duelo.`);
        if (!isPenaltyDuel) { 
            io.to(roomId).emit('notification', `🩸 ¡${att.name} falló y debe recoger 4 cartas!`); 
            room.pendingPenalty = 4; room.pendingSkip = 0; room.currentTurn = room.players.indexOf(att); room.gameState = 'playing'; updateAll(roomId); 
        } 
        else { 
            io.to(roomId).emit('notification', `✨ ¡${def.name} devuelve el ataque! Castigo anulado y ${att.name} roba 4.`); 
            room.pendingPenalty = 0; room.pendingSkip = 0; 
            room.players.forEach(p => p.hasDrawn = false); 
            room.currentTurn = room.players.indexOf(att); 
            room.pendingPenalty = 4; room.pendingSkip = 0; 
            room.gameState = 'playing'; updateAll(roomId); 
        }
    }
}

function eliminatePlayer(roomId, uuid) { const room = rooms[roomId]; if(!room) return; const p = room.players.find(p => p.uuid === uuid); if (p) { p.isDead = true; p.isSpectator = true; } }
function getAlivePlayersCount(roomId) { return rooms[roomId].players.filter(p => !p.isDead && !p.isSpectator && !p.hasLeft).length; }

function getNextPlayerIndex(roomId, step) {
    const room = rooms[roomId]; let current = room.currentTurn;
    for(let i=0; i<room.players.length; i++) {
        current = (current + room.direction + room.players.length) % room.players.length;
        if(!room.players[current].isDead && !room.players[current].isSpectator && !room.players[current].hasLeft) return current;
    }
    return current;
}

function advanceTurn(roomId, steps) {
    const room = rooms[roomId]; if (room.players.length === 0) return;
    if (getAlivePlayersCount(roomId) <= 1) return; 
    
    room.players.forEach(p => p.hasDrawn = false);
    
    let safeLoop = 0;
    while (steps > 0 && safeLoop < 100) {
        safeLoop++;
        room.currentTurn = (room.currentTurn + room.direction + room.players.length) % room.players.length;
        let cp = room.players[room.currentTurn];
        
        if (!cp.isDead && !cp.isSpectator && !cp.hasLeft) {
            if (cp.missedTurns > 0) {
                cp.missedTurns--;
                io.to(roomId).emit('notification', `⏭️ Turno de ${cp.name} salteado por castigo.`);
            } else {
                steps--; 
            }
        }
    }
    if (room.players[room.currentTurn]) room.players[room.currentTurn].hasDrawn = false;
}

function startCountdown(roomId) {
    const room = rooms[roomId]; if (room.players.length < 2) return;
    room.gameState = 'counting'; createDeck(roomId);
    let safeCard = room.deck.pop();
    while (['+2','+4','+12','R','X','RIP','GRACIA','LIBRE','SALTEO SUPREMO'].includes(safeCard.value) || safeCard.color === 'negro') {
        room.deck.unshift(safeCard); for (let i = room.deck.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [room.deck[i], room.deck[j]] = [room.deck[j], room.deck[i]]; } safeCard = room.deck.pop();
    }
    room.discardPile = [safeCard]; room.activeColor = safeCard.color; 
    
    let nextStarter = room.roundStarterIndex % room.players.length;
    let safeLoop = 0;
    while (room.players[nextStarter] && (!room.players[nextStarter].isConnected || room.players[nextStarter].isSpectator || room.players[nextStarter].hasLeft) && safeLoop < room.players.length) {
        nextStarter = (nextStarter + 1) % room.players.length;
        safeLoop++;
    }
    room.roundStarterIndex = nextStarter;
    room.currentTurn = room.roundStarterIndex; 
    
    room.direction = 1;
    room.pendingPenalty = 0; room.pendingSkip = 0;
    
    room.players.forEach(p => { 
        if(p.hasLeft) return;
        p.hand = []; p.hasDrawn = false; p.isDead = false; p.saidUno = false; p.missedTurns = 0;
        if(room.gameState !== 'waiting') p.isSpectator = false; 
        if (!p.isSpectator) { for (let i = 0; i < 7; i++) drawCards(roomId, room.players.indexOf(p), 1); } 
    });
    
    io.to(roomId).emit('countdownTick', 3); let count = 3;
    room.countdownInterval = setInterval(() => {
        if (!rooms[roomId]) return clearInterval(room.countdownInterval);
        io.to(roomId).emit('countdownTick', count); io.to(roomId).emit('playSound', 'soft');
        if (count <= 0) { 
            clearInterval(room.countdownInterval); 
            room.gameState = 'playing'; 
            io.to(roomId).emit('playSound', 'start'); 
            updateAll(roomId); 
            
            const starterName = room.players[room.currentTurn] ? room.players[room.currentTurn].name : "???";
            io.to(roomId).emit('roundStarted', { round: room.roundCount, starterName: starterName });
        } 
        count--;
    }, 1000);
}

function drawCards(roomId, pid, n) { 
    const room = rooms[roomId]; if (pid < 0 || pid >= room.players.length) return; 
    for (let i = 0; i < n; i++) { if (room.deck.length === 0) recycleDeck(roomId); if (room.deck.length > 0) room.players[pid].hand.push(room.deck.pop()); } 
    checkUnoCheck(roomId, room.players[pid]);
}

function calculateAndFinishRound(roomId, winner) {
    try {
        const room = rooms[roomId]; if(!room) return;
        let pointsAccumulated = 0; let losersDetails = [];
        const lastCard = room.discardPile.length > 0 ? room.discardPile[room.discardPile.length - 1] : null;
        let bonus = 0; if (lastCard && lastCard.value === 'GRACIA') bonus = 50;

        room.players.forEach(p => {
            if (p.uuid !== winner.uuid && !p.isSpectator && !p.hasLeft) { 
                const hasGrace = p.hand.some(c => c.value === 'GRACIA');
                let pPoints = 0; if (!hasGrace) { pPoints = p.hand.reduce((acc, c) => acc + getCardPoints(c), 0); }
                if(pPoints > 0) { pointsAccumulated += pPoints; losersDetails.push({ name: p.name, points: pPoints }); }
            }
        });

        pointsAccumulated += bonus;
        if(bonus > 0) losersDetails.push({ name: "BONUS (Cierre Gracia)", points: 50 });

        if(room.scores[winner.uuid] === undefined) room.scores[winner.uuid] = 0;
        room.scores[winner.uuid] += pointsAccumulated;
        const winnerTotal = room.scores[winner.uuid];

        if (winnerTotal >= 800) {
            room.gameState = 'waiting';
            io.to(roomId).emit('gameOver', { winner: winner.name, totalScore: winnerTotal }); io.to(roomId).emit('playSound', 'win');
            if (room.actionTimer) clearTimeout(room.actionTimer);
            setTimeout(() => { delete rooms[roomId]; }, 10000);
        } else {
            room.gameState = 'round_over'; room.roundCount++;
            
            const leaderboard = Object.keys(room.scores).map(uid => {
                const pl = room.players.find(x => x.uuid === uid && !x.hasLeft); 
                if(pl) return { name: pl.name, score: room.scores[uid] }; return null;
            }).filter(x=>x).sort((a,b) => b.score - a.score);

            io.to(roomId).emit('roundOver', { winner: winner.name, roundPoints: pointsAccumulated, losersDetails: losersDetails, leaderboard: leaderboard, winnerTotal: winnerTotal });
            io.to(roomId).emit('playSound', 'win');

            const animationDelay = (losersDetails.length * 1500) + 2000 + (leaderboard.length * 800) + 2500 + 3000;
            setTimeout(() => { if(rooms[roomId]) resetRound(roomId); }, animationDelay);
        }
    } catch(e) { console.error("Error en calc round:", e); if(rooms[roomId]) resetRound(roomId); }
}

function resetRound(roomId) {
    const room = rooms[roomId]; if(!room) return;
    room.roundStarterIndex = (room.roundStarterIndex + 1) % room.players.length;

    let nextStarter = room.roundStarterIndex;
    let safeLoop = 0;
    while (room.players[nextStarter] && (!room.players[nextStarter].isConnected || room.players[nextStarter].isSpectator || room.players[nextStarter].hasLeft) && safeLoop < room.players.length) {
        nextStarter = (nextStarter + 1) % room.players.length;
        safeLoop++;
    }
    room.roundStarterIndex = nextStarter;

    createDeck(roomId);
    let safeCard = room.deck.pop();
    while (['+2','+4','+12','R','X','RIP','GRACIA','LIBRE','SALTEO SUPREMO'].includes(safeCard.value) || safeCard.color === 'negro') {
        room.deck.unshift(safeCard); for (let i = room.deck.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [room.deck[i], room.deck[j]] = [room.deck[j], room.deck[i]]; } safeCard = room.deck.pop();
    }
    room.discardPile = [safeCard]; room.activeColor = safeCard.color; 
    
    room.direction = 1; room.pendingPenalty = 0; room.pendingSkip = 0; room.gameState = 'playing';

    room.players.forEach(p => { 
        if(p.hasLeft) return;
        p.hand = []; p.hasDrawn = false; p.isDead = false; p.isSpectator = false; p.saidUno = false; p.missedTurns = 0;
        for (let i = 0; i < 7; i++) drawCards(roomId, room.players.indexOf(p), 1); 
    });

    startCountdown(roomId);
}

function checkWinCondition(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    // GUARDIA DE LOBBY: Si la sala está en espera, no calculamos victoria, solo actualizamos la interfaz.
    if (room.gameState === 'waiting') {
        updateAll(roomId);
        return;
    }

    if (room.players.length > 1 && getAlivePlayersCount(roomId) <= 1) { 
        const winner = room.players.find(p => !p.isDead && !p.isSpectator && !p.hasLeft); 
        if (winner) {
            room.gameState = 'game_over'; // Frenamos cualquier otra interacción
            
            // Pausamos 3 segundos para que se alcance a leer el cartel de abandono antes del Game Over
            setTimeout(() => {
                if (!rooms[roomId]) return;
                io.to(roomId).emit('gameOver', { 
                    winner: winner.name, 
                    totalScore: room.scores[winner.uuid] || 0,
                    reason: 'desertion' 
                });
                io.to(roomId).emit('playSound', 'win');
                if (room.actionTimer) clearTimeout(room.actionTimer);
                setTimeout(() => { delete rooms[roomId]; }, 10000);
            }, 3000);
        } 
    } 
}

function updateAll(roomId) {
    try {
        const room = rooms[roomId]; if(!room) return;
        let lastRoundWinner = ""; if (room.duelState.history.length > 0) { lastRoundWinner = room.duelState.history[room.duelState.history.length - 1].winnerName; }
        const reportablePlayers = room.players.filter(p => !p.isDead && !p.isSpectator && !p.hasLeft && p.hand.length === 1 && !p.saidUno && (Date.now() - p.lastOneCardTime > 2000)).map(p => p.id);
        const duelInfo = (['dueling','rip_decision','penalty_decision'].includes(room.gameState)) ? { attackerName: room.duelState.attackerName, defenderName: room.duelState.defenderName, round: room.duelState.round, scoreAttacker: room.duelState.scoreAttacker, scoreDefender: room.duelState.scoreDefender, history: room.duelState.history, attackerId: room.duelState.attackerId, defenderId: room.duelState.defenderId, myChoice: null, turn: room.duelState.turn, lastWinner: lastRoundWinner, narrative: room.duelState.narrative, type: room.duelState.type } : null;

        const leaderboard = Object.keys(room.scores).map(uid => {
            const pl = room.players.find(x => x.uuid === uid && !x.hasLeft); 
            if(pl) return { name: pl.name, score: room.scores[uid] }; return null;
        }).filter(x=>x).sort((a,b) => b.score - a.score);

        const activePlayers = room.players.filter(p => !p.hasLeft);

        const pack = { state: room.gameState, roomId: roomId, players: activePlayers.map((p) => {
            const pIndex = room.players.findIndex(x => x.uuid === p.uuid);
            return { name: p.name + (p.isAdmin ? " 👑" : "") + (p.isSpectator ? " 👁️" : ""), uuid: p.uuid, cardCount: p.hand.length, id: p.id, isTurn: (room.gameState === 'playing' && pIndex === room.currentTurn), hasDrawn: p.hasDrawn, isDead: p.isDead, isSpectator: p.isSpectator, isAdmin: p.isAdmin, isConnected: p.isConnected };
        }), topCard: room.discardPile.length > 0 ? room.discardPile[room.discardPile.length - 1] : null, activeColor: room.activeColor, currentTurn: room.currentTurn, duelInfo, pendingPenalty: room.pendingPenalty, chatHistory: room.chatHistory, reportTargets: reportablePlayers, leaderboard: leaderboard };
        
        activePlayers.forEach(p => {
            if(p.isConnected) {
                const mp = JSON.parse(JSON.stringify(pack)); mp.iamAdmin = p.isAdmin;
                if (mp.duelInfo) { if (p.uuid === room.duelState.attackerId) mp.duelInfo.myChoice = room.duelState.attackerChoice; if (p.uuid === room.duelState.defenderId) mp.duelInfo.myChoice = room.duelState.defenderChoice; }
                io.to(p.id).emit('updateState', mp); if (!p.isSpectator || p.isDead) io.to(p.id).emit('handUpdate', p.hand); io.to(p.id).emit('chatHistory', room.chatHistory);
            }
        });
        
        checkPenaltyTimer(roomId); 
    } catch(e) { console.error("Error UpdateAll:", e); }
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
        body { margin: 0; padding: 0; font-family: 'Segoe UI', sans-serif; background: #1e272e; color: white; overflow: hidden; height: var(--app-height); display: flex; flex-direction: column; user-select: none; transition: background 0.5s; }
        
        .screen { display: none; width: 100%; height: 100%; position: absolute; top: 0; left: 0; flex-direction: column; justify-content: center; align-items: center; z-index: 10; }
        #login, #join-menu, #lobby { background: #2c3e50; z-index: 2000; }
        #game-area { display: none; flex-direction: column; height: 100%; width: 100%; position: relative; z-index: 5; padding-bottom: calc(240px + var(--safe-bottom)); }
        #rip-screen, #duel-screen { background: rgba(50,0,0,0.98); z-index: 10000; }
        #game-over-screen { background: rgba(0,0,0,0.95); z-index: 200000; text-align: center; border: 5px solid gold; flex-direction: column; justify-content: center; align-items: center; }
        
        #round-overlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.98); z-index: 150000; display: none; flex-direction: column; justify-content: center; align-items: center; color: white; text-align: center; }
        .round-stage { display: none; flex-direction: column; align-items: center; width: 100%; }
        .active-stage { display: flex; animation: fadeIn 0.5s; }
        .score-flyer { position: absolute; font-size: 24px; color: gold; font-weight: bold; transition: all 0.6s ease-in-out; text-shadow: 0 0 10px black; z-index: 160000; }

        #round-start-banner {
            position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%) scale(0);
            background: rgba(0,0,0,0.95); border: 4px solid gold; border-radius: 15px;
            color: white; padding: 30px; text-align: center; z-index: 200000;
            box-shadow: 0 0 30px gold; transition: transform 0.5s cubic-bezier(0.175, 0.885, 0.32, 1.275);
            display: none; flex-direction: column; justify-content: center; align-items: center; pointer-events: none;
        }
        #round-start-banner.show { transform: translate(-50%, -50%) scale(1); }

        .rank-row { display: flex; justify-content: space-between; width: 80%; max-width: 400px; padding: 15px; margin: 8px 0; background: rgba(255,255,255,0.1); border-radius: 8px; opacity: 0; transform: translateY(20px); transition: all 0.5s; font-size: 22px; }
        .rank-row.visible { opacity: 1; transform: translateY(0); }
        .rank-gold { border: 2px solid gold; background: rgba(255, 215, 0, 0.2); }

        .floating-window { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 340px; max-width: 95%; max-height: 85vh; background: #2c3e50; border: 3px solid #ecf0f1; border-radius: 15px; box-shadow: 0 10px 40px rgba(0,0,0,0.9); z-index: 100000; display: none; flex-direction: column; padding: 20px; color: white; overflow-y: auto; text-align: center; }
        .modal-close { position: absolute; top: 10px; right: 15px; font-size: 28px; cursor: pointer; color: #aaa; font-weight: bold; }
        
        #reconnect-overlay { position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.8); z-index:90000; display:none; justify-content:center; align-items:center; color:white; font-size:20px; flex-direction:column; }
        .loader { border: 5px solid #f3f3f3; border-top: 5px solid #3498db; border-radius: 50%; width: 50px; height: 50px; animation: spin 1s linear infinite; margin-bottom:15px; }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }

        .libre-step { display: none; width: 100%; text-align: center; }
        .libre-step.active { display: block; }
        
        .hud-btn { position: fixed; width: 55px; height: 55px; border-radius: 50%; display: none; justify-content: center; align-items: center; border: 2px solid white; z-index: 50000; box-shadow: 0 4px 5px rgba(0,0,0,0.5); font-size: 24px; cursor: pointer; transition: transform 0.2s, top 0.3s ease-out; }
        .hud-btn:active { transform: scale(0.9); }
        
        #score-btn { left: 20px; background: gold; color: black; }
        #rules-btn { left: 20px; background: #9b59b6; color: white; }
        #uno-main-btn { right: 20px; background: #e67e22; font-size: 11px; font-weight: bold; text-align: center; line-height: 1.2; }
        #chat-btn { right: 20px; background: #3498db; }

        /* Botón de Salir Fijo y Global */
        #global-leave-btn { left: 20px; background: #c0392b; font-size: 20px; }

        #players-zone { flex: 0 0 auto; padding: 30px 10px 10px 10px; background: rgba(0,0,0,0.5); display: flex; flex-wrap: wrap; justify-content: center; gap: 5px; z-index: 20; position: relative; }
        .player-badge { background: #333; color: white; padding: 5px 12px; border-radius: 20px; font-size: 13px; border: 1px solid #555; transition: all 0.3s; }
        .is-turn { background: #2ecc71; color: black; font-weight: bold; border: 2px solid white; transform: scale(1.1); box-shadow: 0 0 10px #2ecc71; }
        .is-dead { text-decoration: line-through; opacity: 0.6; }
        
        #alert-zone { position: fixed; left: 0; width: 100%; display: flex; flex-direction: column; justify-content: center; align-items: center; z-index: 60000; pointer-events: none; transition: top 0.3s ease-out; }
        .alert-box { background: rgba(0,0,0,0.95); border: 2px solid gold; color: white; padding: 15px; border-radius: 10px; text-align: center; font-weight: bold; font-size: 18px; box-shadow: 0 5px 20px rgba(0,0,0,0.8); animation: pop 0.3s ease-out; max-width: 90%; display: none; margin-bottom: 10px; pointer-events: auto; }
        
        #penalty-display { font-size: 20px; color: #ff4757; text-shadow: 0 0 5px red; display: none; margin-bottom: 5px; background: rgba(0,0,0,0.9); padding: 10px 15px; border-radius: 8px; border: 2px solid red; pointer-events: auto; width: 85%; max-width: 320px; text-align: center; line-height: 1.3; transform: translateY(-30px); animation: pulseRed 1s infinite alternate; }
        @keyframes pulseRed { from { box-shadow: 0 0 10px red; } to { box-shadow: 0 0 25px red; } }
        
        #table-zone { flex: 1; display: flex; flex-direction: column; justify-content: center; align-items: center; gap: 15px; z-index: 15; position: relative; }
        #decks-container { display: flex; gap: 30px; transform: scale(1.1); }
        .card-pile { width: 70px; height: 100px; border-radius: 8px; border: 3px solid white; display: flex; justify-content: center; align-items: center; font-size: 24px; box-shadow: 0 5px 10px rgba(0,0,0,0.5); position: relative; color: white; white-space: nowrap; overflow: hidden; }
        #deck-pile { background: #e74c3c; cursor: pointer; }
        #top-card { background: #333; }
        
        #action-bar { position: fixed; bottom: 180px; left: 0; width: 100%; display: none; justify-content: center; align-items: center; padding: 10px; pointer-events: none; z-index: 20000; }
        #uno-btn-area { pointer-events: auto; display: flex; gap: 10px; flex-wrap: wrap; justify-content: center; background: none; padding: 0; border-radius: 0; }
        .btn-pass { background: #f39c12; color: white; border: 2px solid white; padding: 10px 20px; border-radius: 25px; font-weight: bold; cursor: pointer; display: none; box-shadow: 0 4px 0 #d35400; }
        #btn-ladder-play { background: #27ae60; color: white; border: 2px solid white; padding: 10px 20px; border-radius: 25px; font-weight: bold; cursor: pointer; display:none; animation: pop 0.3s; box-shadow: 0 0 10px gold; font-size: 14px; }
        #btn-ladder-cancel { background: #e74c3c; color: white; border: 2px solid white; padding: 10px 20px; border-radius: 25px; font-weight: bold; cursor: pointer; display:none; animation: pop 0.3s; box-shadow: 0 0 10px red; font-size: 14px; }
        #btn-sort { background: #34495e; color: white; border: 2px solid white; padding: 10px 20px; border-radius: 25px; font-weight: bold; cursor: pointer; font-size: 14px; box-shadow: 0 4px 0 #2c3e50; }

        #hand-zone { position: fixed; bottom: 0; left: 0; width: 100%; height: 180px; background: rgba(20, 20, 20, 0.95); border-top: 2px solid #555; display: flex; align-items: center; padding: 10px 20px; padding-bottom: calc(10px + var(--safe-bottom)); gap: 15px; overflow-x: auto; overflow-y: hidden; white-space: nowrap; scroll-snap-type: x mandatory; -webkit-overflow-scrolling: touch; z-index: 10000; }
        .hand-card { flex: 0 0 85px; height: 130px; border-radius: 8px; border: 2px solid white; background: #444; display: flex; justify-content: center; align-items: center; font-size: 32px; font-weight: 900; color: white; scroll-snap-align: center; position: relative; cursor: pointer; box-shadow: 0 4px 8px rgba(0,0,0,0.6); user-select: none; z-index: 1; transition: transform 0.2s; white-space: nowrap; }
        .hand-card:active { transform: scale(0.95); }
        .hand-card.selected-ladder { border: 4px solid cyan !important; transform: translateY(-20px); box-shadow: 0 0 15px cyan; z-index:10; }
        
        @keyframes slideUp { from { transform: translateY(100px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
        .drawn-card { animation: slideUp 0.5s ease-out; border: 2px solid gold; }

        body.bg-rojo { background-color: #4a1c1c !important; } body.bg-azul { background-color: #1c2a4a !important; } body.bg-verde { background-color: #1c4a2a !important; } body.bg-amarillo { background-color: #4a451c !important; }
        .color-circle { width: 70px; height: 70px; border-radius: 50%; display: inline-block; margin: 10px; cursor: pointer; border: 4px solid #fff; }
        .zombie-btn { display: block; width: 100%; padding: 15px; margin: 10px 0; background: #333; color: white; border: 1px solid #666; font-size: 18px; cursor: pointer; border-radius: 10px; }
        
        #chat-win { position: fixed; right: 20px; width: 280px; height: 250px; background: rgba(0,0,0,0.95); border: 2px solid #666; display: none; flex-direction: column; z-index: 50000; border-radius: 10px; box-shadow: 0 0 20px black; transition: top 0.3s ease-out; }
        #chat-badge { position: absolute; top: -5px; right: -5px; background: red; color: white; border-radius: 50%; width: 20px; height: 20px; font-size: 12px; display: none; justify-content: center; align-items: center; font-weight: bold; border: 2px solid white; }
        
        .min-c { display:inline-block; width:22px; height:32px; border-radius:3px; border:1px solid white; text-align:center; line-height:32px; font-weight:bold; font-size:12px; color:white; vertical-align:middle; margin:0 2px; }
        .mc-rojo { background:#ff5252; } .mc-azul { background:#448aff; } .mc-verde { background:#69f0ae; color:black; } .mc-amarillo { background:#ffd740; color:black; } .mc-negro { background:#212121; }
        .mc-rip { background:black; font-size:10px; line-height:12px; display:inline-flex; align-items:center; justify-content:center; }
        .mc-gra { background:white; color:red; }

        .mini-card { display: inline-block; padding: 10px; margin: 5px; border: 2px solid white; border-radius: 5px; cursor: pointer; background: #444; }
        .mini-card.selected { border-color: gold; transform: scale(1.1); background: #666; }

        #duel-narrative { position: relative; z-index: 999999; font-size: 26px; text-align:center; padding:20px; border:2px solid #69f0ae; background:rgba(0,0,0,0.9); color: #69f0ae; width:90%; border-radius:15px; margin-bottom: 20px; box-shadow: 0 0 20px rgba(105, 240, 174, 0.5); text-shadow: 1px 1px 2px black; }
        #duel-opts { display:flex; justify-content:center; gap:20px; margin-top:20px; width:100%; }
        .duel-btn { font-size:50px; background:none; border:none; cursor:pointer; opacity: 0.5; transition: 0.3s; padding:10px; }
        .duel-btn:hover { opacity: 0.8; }
        .duel-btn.selected { opacity: 1; transform: scale(1.3); text-shadow: 0 0 20px white; border-bottom: 3px solid gold; padding-bottom: 5px; }
        .duel-btn:disabled { opacity: 0.2; cursor: not-allowed; filter: grayscale(1); }
        
        input { padding:15px; font-size:20px; text-align:center; width:80%; max-width:300px; border-radius:30px; border:none; margin:10px 0; }
        .btn-main { padding:15px 40px; background:#27ae60; color:white; border:none; border-radius:30px; font-size:20px; cursor:pointer; margin: 10px; }
        @keyframes pop { 0% { transform: scale(0.8); opacity:0; } 100% { transform: scale(1); opacity:1; } }
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

        /* BLOQUEO ABSOLUTO DE CHAT Y BOTONES EN DUELOS / RIP */
        body.state-dueling #game-area, body.state-dueling #hand-zone, body.state-dueling #action-bar, body.state-dueling .hud-btn, body.state-dueling #chat-win, body.state-dueling #alert-zone { display: none !important; }
        body.state-dueling #duel-screen { display: flex !important; }
        body.state-rip #game-area, body.state-rip #hand-zone, body.state-rip #action-bar, body.state-rip .hud-btn, body.state-rip #chat-win, body.state-rip #alert-zone { display: none !important; }
        body.state-rip #rip-screen { display: flex !important; } 

        .lobby-row { display: flex; align-items: center; justify-content: space-between; width: 100%; max-width: 300px; margin-bottom: 10px; background: rgba(0,0,0,0.3); padding: 5px 10px; border-radius: 5px; }
        .lobby-name { display: flex; align-items: center; gap: 10px; }
        .kick-btn { background: #e74c3c; border: none; color: white; font-weight: bold; cursor: pointer; padding: 2px 8px; border-radius: 5px; margin-left: 20px; }
        #lobby-link-container { margin-bottom: 30px; }
        
        #uno-menu { display: none; position: fixed; right: 80px; background: rgba(0,0,0,0.9); padding: 10px; border-radius: 10px; z-index: 40000; flex-direction: column; width: 180px; border: 1px solid #e67e22; transition: top 0.3s ease-out; }
        
        .flying-card { position: fixed; width: 70px; height: 100px; background: #fff; border-radius: 8px; z-index: 50000; transition: all 0.5s ease-in-out; display: flex; justify-content: center; align-items: center; font-size: 24px; font-weight: bold; border: 2px solid white; }
    </style>
</head>
<body>
    <div id="reconnect-overlay"><div class="loader"></div><div>Reconectando...</div></div>

    <div id="login" class="screen" style="display:flex;"><h1 style="font-size:60px; margin:0;">UNO y 1/2</h1><input id="my-name" type="text" placeholder="Tu Nombre" maxlength="15"><button id="btn-create" class="btn-main" onclick="showCreate()">Crear Sala</button><button id="btn-join-menu" class="btn-main" onclick="showJoin()" style="background:#2980b9">Unirse a Sala</button></div>
    <div id="join-menu" class="screen"><h1>Unirse</h1><input id="room-code" type="text" placeholder="Código" style="text-transform:uppercase;"><button class="btn-main" onclick="joinRoom()">Entrar</button><button class="btn-main" onclick="backToLogin()">Volver</button></div>
    <div id="lobby" class="screen">
        <button onclick="toggleManual()" style="position: absolute; top: 10px; right: 10px; background: #8e44ad; color: white; border: none; padding: 10px; border-radius: 5px; cursor: pointer; z-index: 10;">📖 MANUAL</button>
        <h1>Sala: <span id="lobby-code" style="color:gold;"></span></h1>
        <div id="lobby-link-container"><button onclick="copyLink()">🔗 Link</button></div>
        <div id="lobby-users"></div>
        <button id="start-btn" onclick="start()" class="btn-main" style="display:none;">EMPEZAR</button>
        <p id="wait-msg" style="display:none;">Esperando...</p>
    </div>
    
    <div id="game-area">
        <div id="players-zone"></div>
        <div id="table-zone">
            <div id="decks-container"><div id="deck-pile" class="card-pile" onclick="draw()">📦</div><div id="top-card" class="card-pile"></div></div>
        </div>
    </div>

    <div id="global-leave-btn" class="hud-btn" onclick="requestLeave()" title="Abandonar Partida">🚪</div>

    <div id="round-start-banner">
        <h1 id="rsb-round" style="color: gold; font-size: 50px; margin: 0; text-shadow: 2px 2px 5px black;">RONDA 1</h1>
        <h2 id="rsb-starter" style="font-size: 24px; margin-top: 10px;">Comienza Fulanito</h2>
    </div>

    <div id="alert-zone">
        <div id="penalty-display">⚠️ DEBES RECOGER <span id="pen-num">0</span> CARTAS<br><small style="color:white; font-size:14px; font-weight:normal;">(Toca el mazo rojo para robar)</small></div>
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
    
    <div id="score-btn" class="hud-btn" onclick="toggleScores()">🏆</div>
    <div id="rules-btn" class="hud-btn" onclick="toggleRules()">❓</div>
    <div id="uno-main-btn" class="hud-btn" onclick="toggleUnoMenu()">UNO<br>y 1/2</div>
    <div id="chat-btn" class="hud-btn" onclick="toggleChat()">💬<div id="chat-badge">0</div></div>

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

    <div id="rules-modal" class="floating-window">
        <div class="modal-close" onclick="toggleRules()">X</div>
        <h2 style="color:gold;">Reglas Rápidas</h2>
        <div style="text-align:left; font-size:14px;">
            <p><b>Puntos:</b> Número=Cara | 1y1/2=1.5 | +2/Reversa/Salteo=20 | Color/+4=40 | +12/Libre/SS=80 | RIP=100.</p>
            <p>💀 <b>RIP:</b> Desafía a duelo a muerte. Si atacas y pierdes, robas 4.</p>
            <p>❤️ <b>GRACIA:</b> Inmune a castigos. Revive. Usada como última carta para ganar da un Bonus de +50pts.</p>
            <p>🕊️ <b>LIBRE ALBEDRÍO:</b> Defiende castigo. Regalas 1 y descartas la que quieras para definir el juego.</p>
            <p>🪜 <b>ESCALERA:</b> 3 o más cartas consecutivas del mismo color (ej. <span class="min-c mc-azul">3</span> <span class="min-c mc-azul">4</span> <span class="min-c mc-azul">5</span>). Manten apretada una carta para seleccionar varias.</p>
            <p>✨ <b>SAFF:</b> Tira fuera de turno si tu carta es EXACTAMENTE igual en número y color a la de la mesa.</p>
        </div>
    </div>

    <div id="manual-modal" class="floating-window" style="width:80%; max-width:600px;">
        <div class="modal-close" onclick="toggleManual()">X</div>
        <h1 style="color:gold; font-size:28px;">📖 MANUAL COMPLETO</h1>
        <div style="padding:0 10px; text-align:left; line-height:1.6;">
            <h3>1. EL OBJETIVO Y PUNTUACIÓN</h3>
            <p>El juego se gana al alcanzar los <b>800 puntos</b>. El jugador que se queda sin cartas (gana la ronda) recolecta el valor de las manos de todos los perdedores.</p>
            <ul>
                <li>Numéricas (0-9): Su valor.</li>
                <li><span class="min-c mc-rojo">1 ½</span> Vale 1.5 puntos.</li>
                <li><span class="min-c mc-verde">+2</span> <span class="min-c mc-amarillo">⮂</span> <span class="min-c mc-azul">⊘</span> Valen 20 puntos.</li>
                <li><span class="min-c mc-negro">C</span> <span class="min-c mc-negro">+4</span> Valen 40 puntos.</li>
                <li><span class="min-c mc-negro">SS</span> <span class="min-c mc-negro">+12</span> <span class="min-c mc-negro">🕊️</span> Valen 80 puntos.</li>
                <li><span class="min-c mc-rip">🪦</span> Vale 100 puntos.</li>
                <li><span class="min-c mc-gra">❤️</span> Vale 0 si pierdes con ella en mano. Si cierras la partida tirando esta carta, ganas +50 puntos de Bonus.</li>
            </ul>

            <h3>2. CARTAS DEL MAZO (130 Totales)</h3>
            <p>Cada color (Rojo, Azul, Verde, Amarillo) tiene: dos 0, dos 1-9, dos 1y1/2, dos +2, dos Reversa, dos Salteo. <br>Especiales negras: 4 Cambios Color, 4 Mas Cuatro, 2 RIP, 2 Gracia Divina, 2 +12, 2 Libre Albedrío, 2 Salteo Supremo.</p>

            <h3>3. JUGADAS MAESTRAS (Selección Múltiple)</h3>
            <p>Mantén presionada una carta para iniciar la Selección Múltiple y elige varias para hacer combinaciones.</p>
            <p><b>A) ESCALERAS (Mínimo 3 cartas):</b> Deben ser consecutivas numéricamente y del <b>MISMO COLOR</b>. Puedes tirarlas siempre que la primera encaje con la mesa.</p>
            <p><b>B) EL COMBO 1 ½:</b> Dos cartas <span class="min-c mc-azul">1 ½</span> suman 3. Si la mesa tiene un <span class="min-c mc-azul">3</span>, seleccionas ambas 1y1/2 del mismo color y las tiras al mismo tiempo.</p>

            <h3>4. EL MOVIMIENTO S.A.F.F.</h3>
            <p>No tienes que esperar tu turno si tienes una carta <b>IDÉNTICA</b> a la de la mesa (Mismo Número Y Mismo Color). Tírala rápido.</p>

            <h3>5. CARTAS SUPREMAS Y DUELOS</h3>
            <p><span class="min-c mc-rip">🪦</span> <b>RIP:</b> Seleccionas a tu víctima y comienza un duelo a muerte. Al mejor de 3. Si el atacante gana, la víctima muere (no juega) hasta ser revivido. Si la víctima se defiende y gana, el atacante roba 4 cartas.</p>
            <p><span class="min-c mc-gra">❤️</span> <b>GRACIA DIVINA:</b> Anula cualquier castigo si la tiras encima. Si alguien está muerto (RIP), la tiras y lo resucitas. Al resucitar alguien, decides el color de la mesa.</p>
            <p><span class="min-c mc-negro">🕊️</span> <b>LIBRE ALBEDRÍO:</b> Defiende castigos numéricos. Abre una ventana para: 1) Regalar una carta a un rival. 2) Descartar la carta que quieras a la mesa (sin importar el color previo). El color y efecto de la carta que descartes dictará cómo sigue el juego automáticamente (si descartas un RIP, inicias duelo; si descartas un Cambio de Color, eliges color, etc.).</p>
            <p><span class="min-c mc-negro">SS</span> <b>SALTEO SUPREMO:</b> El siguiente jugador pierde el turno y se le acumulan +4 cartas para robar.</p>
        </div>
    </div>

    <div id="leave-normal-modal" class="floating-window">
        <h2 style="color:gold;">¿Abandonar Partida?</h2>
        <p>Serás expulsado de la sala y no podrás volver.</p>
        <button class="btn-main" onclick="confirmLeave('leave_normal')" style="background:#e74c3c;">SÍ, ABANDONAR</button>
        <button class="btn-main" onclick="closeLeaveModals()" style="background:#34495e;">CANCELAR</button>
    </div>
    <div id="leave-admin-modal" class="floating-window">
        <h2 style="color:gold;">¿Abandonar Partida?</h2>
        <p>Eres el anfitrión. Puedes irte y dejar que continúen o cancelar la partida para todos.</p>
        <button class="btn-main" onclick="confirmLeave('leave_host_keep')" style="background:#f39c12; font-size:16px;">IRME Y DEJARLOS JUGANDO</button>
        <button class="btn-main" onclick="confirmLeave('leave_host_end')" style="background:#e74c3c; font-size:16px;">FINALIZAR PARTIDA PARA TODOS</button>
        <button class="btn-main" onclick="closeLeaveModals()" style="background:#34495e;">CANCELAR</button>
    </div>

    <div id="game-over-screen" class="screen">
        <h1 style="color:gold;">VICTORIA SUPREMA</h1>
        <h2 id="winner-name"></h2>
        <h3 id="final-score"></h3>
    </div>
    
    <div id="pause-overlay" style="display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.85); z-index:999999; justify-content:center; align-items:center; flex-direction:column; color:white; text-align:center; padding: 20px;">
        <h1 style="color:gold; font-size:50px; margin-bottom: 10px;">⏸️ PAUSA</h1>
        <h2 id="pause-msg" style="font-weight: normal;"></h2>
    </div>

    <div id="round-overlay">
        <div id="stage-collection" class="round-stage active-stage">
            <h2 style="color: #2ecc71;">GANADOR DE LA RONDA</h2>
            <h1 id="r-winner-name" style="color: gold; font-size: 40px; margin-top: 0; margin-bottom: 10px;"></h1>
            <h3 id="r-winner-pts" style="color: white; border: 2px solid gold; padding: 10px 20px; border-radius: 10px; background: rgba(0,0,0,0.5); display: inline-block;">0 pts</h3>
            <div id="losers-area" style="margin-top: 30px; min-height: 100px; display: flex; flex-direction: column; gap: 15px;"></div>
        </div>
        <div id="stage-ranking" class="round-stage">
            <h1 style="color:gold; font-size: 40px; letter-spacing: 5px; margin-bottom: 5px;">RANKING</h1>
            <h4 style="color:#aaa; margin-top: 0; margin-bottom: 30px;">Puntajes acumulados</h4>
            <div id="ranking-list" style="width: 100%; display: flex; flex-direction: column; align-items: center;"></div>
        </div>
    </div>

    <div id="rip-screen" class="screen">
        <h1 style="color:red;" id="rip-title">💀 RIP 💀</h1>
        <h3 id="rip-msg-custom" style="text-align:center; padding:10px;"></h3>
        <button id="btn-accept-penalty" onclick="ripResp('accept_penalty')" class="btn-main" style="background:#34495e; display:none;">ACEPTAR CASTIGO</button>
        <button id="btn-duel-start" onclick="ripResp('duel')" class="btn-main" style="background:red; border:3px solid gold;">BATIRSE A DUELO</button>
        <button id="btn-surrender" onclick="ripResp('surrender')" class="btn-main">RENDIRSE</button>
        <p id="duel-warning" style="font-size:12px; color:#aaa; display:none;">Nota: batirse a duelo y perder implicará una penalidad extra.</p>
        <div id="grace-btn" style="display:none;"><button onclick="showGraceModal()" class="btn-main" style="background:white; color:red;">USAR GRACIA</button></div>
    </div>

    <div id="duel-screen" class="screen">
        <h1 style="color:gold;">⚔️ DUELO ⚔️</h1>
        <h3 id="duel-narrative">Cargando duelo...</h3>
        <h2 id="duel-names">... vs ...</h2>
        <h3 id="duel-sc">0 - 0</h3>
        <p id="duel-turn-msg"></p>
        <div id="duel-opts">
            <button id="btn-fuego" class="duel-btn" onclick="pick('fuego')">🔥</button>
            <button id="btn-hielo" class="duel-btn" onclick="pick('hielo')">❄️</button>
            <button id="btn-agua" class="duel-btn" onclick="pick('agua')">💧</button>
        </div>
    </div>
    
    <div id="color-picker" class="floating-window"><h3>Elige Color</h3><div style="display:flex; flex-wrap:wrap; justify-content:center;"><div class="color-circle" style="background:#ff5252;" onclick="pickCol('rojo')"></div><div class="color-circle" style="background:#448aff;" onclick="pickCol('azul')"></div><div class="color-circle" style="background:#69f0ae;" onclick="pickCol('verde')"></div><div class="color-circle" style="background:#ffd740;" onclick="pickCol('amarillo')"></div></div></div>
    <div id="revive-screen" class="floating-window"><h2 style="color:gold;">¿A QUIÉN REVIVES?</h2><div id="zombie-list"></div></div>
    
    <div id="grace-color-modal" class="floating-window">
        <h2 style="color:gold;">❤️ GRACIA DIVINA ❤️</h2>
        <p>¿Quieres usarla como cambio de color?</p>
        <button class="btn-main" onclick="confirmGraceColor(true)">SÍ</button>
        <button class="btn-main" onclick="confirmGraceColor(false)" style="background:#e74c3c">CANCELAR</button>
    </div>

    <div id="revive-confirm-screen" class="floating-window">
        <h2 style="color:gold;">¿RESUCITAR A <span id="revive-name"></span>?</h2>
        <button class="btn-main" onclick="confirmRevive(true)">SÍ, REVIVIR</button>
        <button class="btn-main" onclick="confirmRevive(false)" style="background:#e74c3c">NO</button>
    </div>

    <div id="countdown" style="display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.8); z-index:250000; justify-content:center; align-items:center; font-size:120px; color:gold;">3</div>

    <div id="libre-modal" class="floating-window" style="width: 380px;">
        <div id="step-1" class="libre-step active"><h2 style="color: gold;">¿A quién regalas 1 carta?</h2><div id="libre-targets"></div><button class="btn-main" style="background:#e74c3c; width:100%; margin-top:15px;" onclick="cancelLibre()">CANCELAR</button></div>
        <div id="step-2" class="libre-step"><h2 style="color: gold;">Elige qué carta regalar</h2><div id="libre-gift-hand" style="max-height: 200px; overflow-y: auto;"></div><button class="btn-main" style="background:#e74c3c; width:100%; margin-top:15px;" onclick="cancelLibre()">CANCELAR</button></div>
        <div id="step-3" class="libre-step"><h2 style="color: gold;">Elige 1 carta a descartar</h2><div id="libre-discard-hand" style="max-height: 200px; overflow-y: auto;"></div><button class="btn-main" style="background:#e74c3c; width:100%; margin-top:15px;" onclick="cancelLibre()">CANCELAR</button></div>
    </div>

    <script src="/socket.io/socket.io.js"></script>
    <script>
        const socket = io();
        let myId = ''; let pendingCard = null; let pendingGrace = false; let isMyTurn = false; let myHand = []; let currentPlayers = [];
        let isChatOpen = false; let unreadCount = 0;
        let ladderMode = false; let ladderSelected = []; 
        let myUUID = localStorage.getItem('uno_uuid');
        
        let pressTimer;
        let pendingColorForRevive = null;
        let pendingLibreContext = null; 

        if (!myUUID) { myUUID = Math.random().toString(36).substring(2) + Date.now().toString(36); localStorage.setItem('uno_uuid', myUUID); }
        const urlParams = new URLSearchParams(window.location.search);
        const inviteCode = urlParams.get('room');
        if (inviteCode) { document.getElementById('room-code').value = inviteCode; document.getElementById('btn-create').style.display = 'none'; document.getElementById('btn-join-menu').innerText = "ENTRAR A SALA " + inviteCode; document.getElementById('btn-join-menu').onclick = joinRoom; }
        
        function repositionHUD() {
            const pZone = document.getElementById('players-zone');
            if (!pZone || pZone.offsetHeight === 0) return;
            const rect = pZone.getBoundingClientRect();
            const baseTop = rect.bottom + 15;
            
            // Columna Izquierda
            const leaveBtn = document.getElementById('global-leave-btn');
            if(leaveBtn) leaveBtn.style.top = baseTop + 'px';
            const scoreBtn = document.getElementById('score-btn');
            if(scoreBtn) scoreBtn.style.top = (baseTop + 65) + 'px';
            const rulesBtn = document.getElementById('rules-btn');
            if(rulesBtn) rulesBtn.style.top = (baseTop + 130) + 'px';
            
            // Columna Derecha
            const unoBtn = document.getElementById('uno-main-btn');
            if(unoBtn) unoBtn.style.top = baseTop + 'px';
            const chatBtn = document.getElementById('chat-btn');
            if(chatBtn) chatBtn.style.top = (baseTop + 65) + 'px';
            
            const lowerElements = ['uno-menu', 'chat-win'];
            lowerElements.forEach(function(id) { const el = document.getElementById(id); if(el) el.style.top = (baseTop + 65) + 'px'; });

            const alertZone = document.getElementById('alert-zone');
            if(alertZone) alertZone.style.top = (baseTop + 40) + 'px';
        }
        window.addEventListener('resize', repositionHUD);

        socket.on('connect', () => { 
            document.getElementById('reconnect-overlay').style.display = 'none';
            myId = socket.id; 
            socket.emit('checkSession', myUUID); 
        });
        
        socket.on('disconnect', () => { document.getElementById('reconnect-overlay').style.display = 'flex'; });
        socket.on('requireLogin', () => { document.getElementById('reconnect-overlay').style.display = 'none'; changeScreen('login'); document.getElementById('global-leave-btn').style.display = 'none'; });
        
        let libreState = { active: false, cardId: null, targetId: null, giftId: null, discardId: null };
        
        function startLibreLogic(cardId) {
            if(myHand.length < 3) return; 
            document.getElementById('action-bar').style.display = 'none';
            libreState = { active: true, cardId: cardId, targetId: null, giftId: null, discardId: null };
            document.getElementById('libre-modal').style.display = 'flex'; showLibreStep(1);
            const div = document.getElementById('libre-targets'); div.innerHTML = '';
            currentPlayers.forEach(p => {
                if(p.uuid !== myUUID && !p.isSpectator && !p.isDead && !p.hasLeft) {
                    const b = document.createElement('button'); b.className = 'btn-main'; b.style.width = '100%'; b.innerText = p.name;
                    b.onclick = () => { libreState.targetId = p.id; showLibreStep(2); renderGiftHand(); };
                    div.appendChild(b);
                }
            });
        }
        socket.on('startLibreLogic', startLibreLogic);

        function renderGiftHand() {
            const div = document.getElementById('libre-gift-hand'); div.innerHTML = '';
            myHand.forEach(c => {
                if(c.id === libreState.cardId) return;
                const b = document.createElement('div'); b.className = 'mini-card';
                b.innerText = getCardText(c); b.style.color = (c.color==='amarillo'||c.color==='verde')?'black':'white'; b.style.backgroundColor = getBgColor(c);
                b.onclick = () => { libreState.giftId = c.id; showLibreStep(3); renderDiscardHand(); };
                div.appendChild(b);
            });
        }
        function renderDiscardHand() {
            const pool = document.getElementById('libre-discard-hand'); pool.innerHTML = '';
            myHand.forEach(c => {
                if(c.id === libreState.cardId || c.id === libreState.giftId) return;
                const b = document.createElement('div'); b.className = 'mini-card';
                b.innerText = getCardText(c); b.style.color = (c.color==='amarillo'||c.color==='verde')?'black':'white'; b.style.backgroundColor = getBgColor(c);
                b.onclick = () => { 
                    libreState.discardId = c.id; 
                    pendingLibreContext = { libreId: libreState.cardId, targetId: libreState.targetId, giftId: libreState.giftId };
                    document.getElementById('libre-modal').style.display = 'none';
                    libreState.active = false;
                    handleCardClick(c);
                };
                pool.appendChild(b);
            });
        }
        
        function cancelLibre() {
            document.getElementById('libre-modal').style.display = 'none';
            if(document.body.classList.contains('playing-state')) document.getElementById('action-bar').style.display = 'flex';
            libreState = { active: false };
            pendingLibreContext = null;
        }

        function showLibreStep(n) { document.querySelectorAll('.libre-step').forEach(el => el.classList.remove('active')); document.getElementById('step-'+n).classList.add('active'); }
        
        function getCardText(c) { if(c.value==='RIP') return '🪦'; if(c.value==='GRACIA') return '❤️'; if(c.value==='LIBRE') return '🕊️'; if(c.value==='SALTEO SUPREMO') return 'SS'; return c.value; }
        function getBgColor(c) { const map = { 'rojo': '#ff5252', 'azul': '#448aff', 'verde': '#69f0ae', 'amarillo': '#ffd740', 'negro': '#212121' }; if(c.value==='RIP') return 'black'; if(c.value==='GRACIA') return 'white'; if(c.value==='+12') return '#000000'; if(c.value==='LIBRE') return '#000'; if(c.value==='SALTEO SUPREMO') return '#2c3e50'; return map[c.color] || '#444'; }

        function showCreate() { const name = document.getElementById('my-name').value.trim(); if(name) socket.emit('createRoom', { name, uuid: myUUID }); }
        function showJoin() { changeScreen('join-menu'); }
        function backToLogin() { changeScreen('login'); }
        function joinRoom() { const name = document.getElementById('my-name').value.trim(); const code = document.getElementById('room-code').value.trim(); if(name && code) socket.emit('joinRoom', { name, uuid: myUUID, roomId: code }); }
        function copyLink() { const code = document.getElementById('lobby-code').innerText; const url = window.location.origin + '/?room=' + code; if(navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(url).then(() => { alert('¡Link copiado!'); }).catch(err => { prompt("Copia:", url); }); } else { prompt("Copia:", url); } }
        function kick(id) { if(confirm('Echar?')) socket.emit('kickPlayer', id); }

        socket.on('roomCreated', (d) => { changeScreen('lobby'); document.getElementById('lobby-code').innerText = d.roomId; });
        socket.on('roomJoined', (d) => { changeScreen('lobby'); document.getElementById('lobby-code').innerText = d.roomId; });
        
        socket.on('updateState', s => {
            currentPlayers = s.players;
            
            if(s.state === 'waiting' || s.state === 'playing') {
                document.getElementById('global-leave-btn').style.display = 'flex';
                const lc = document.getElementById('lobby-code'); if(!lc.innerText && s.roomId) lc.innerText = s.roomId;
            } else {
                document.getElementById('global-leave-btn').style.display = 'none';
            }

            if(s.leaderboard) {
                const slist = document.getElementById('score-list');
                slist.innerHTML = s.leaderboard.map(function(u, i) {
                    return '<div style="display:flex; justify-content:space-between; padding:5px; border-bottom:1px solid #444;"><span>' + (i+1) + '. ' + u.name + '</span><span style="color:gold; font-weight:bold;">' + parseFloat(u.score).toFixed(1) + '</span></div>';
                }).join('');
            }

            const me = s.players.find(p=>p.uuid===myUUID); const amITurning = me && me.isTurn;
            
            if(!amITurning && (ladderMode || document.getElementById('libre-modal').style.display === 'flex')) {
                 if (document.getElementById('libre-modal').style.display !== 'flex') { cancelLadder(); cancelLibre(); }
            }

            if(s.state === 'waiting') {
                const list = s.players.map(p => '<div class="lobby-row"><div class="lobby-name">' + (p.isConnected?'🟢':'🔴') + ' ' + p.name + '</div>' + (s.iamAdmin && p.uuid !== myUUID ? ('<button class="kick-btn" onclick="kick(\\''+p.id+'\\')">X</button>') : '') + '</div>').join('');
                document.getElementById('lobby-users').innerHTML = list;
                document.getElementById('start-btn').style.display = s.iamAdmin ? 'block' : 'none';
                changeScreen('lobby'); 
                return;
            }
            
            document.body.className = ''; 
            if(s.state === 'playing') {
                 changeScreen('game-area'); 
                 
                 document.body.classList.add('playing-state'); 
                 if(s.activeColor) document.body.classList.add('bg-'+s.activeColor);
                 document.getElementById('game-area').style.display = 'flex'; document.getElementById('hand-zone').style.display = 'flex';
                 document.getElementById('round-overlay').style.display = 'none'; 
                 if(document.getElementById('libre-modal').style.display !== 'flex') { document.getElementById('action-bar').style.display = 'flex'; }
                 document.getElementById('duel-screen').style.display = 'none'; document.getElementById('rip-screen').style.display = 'none';
                 
                 document.getElementById('players-zone').innerHTML = s.players.map(p => '<div class="player-badge ' + (p.isTurn?'is-turn':'') + ' ' + (p.isDead?'is-dead':'') + '">' + (p.isConnected?'':'🔴') + ' ' + p.name + ' (' + p.cardCount + ') ' + (p.isDead?'💀':'') + '</div>').join('');
                 
                 document.querySelectorAll('.hud-btn').forEach(b => b.style.display = 'flex');
                 requestAnimationFrame(repositionHUD);
            } 
            else if (s.state === 'rip_decision' || s.state === 'penalty_decision') {
                changeScreen('game-area'); forceCloseChat(); document.body.classList.add('state-rip');
                
                if(s.duelInfo.defenderId === myUUID) { 
                    document.getElementById('rip-screen').style.display = 'flex'; document.getElementById('duel-screen').style.display = 'none'; 
                    const msgDiv = document.getElementById('rip-msg-custom'); const duelWarn = document.getElementById('duel-warning'); const btnAccept = document.getElementById('btn-accept-penalty'); const btnSurrender = document.getElementById('btn-surrender'); const btnDuel = document.getElementById('btn-duel-start');
                    if (s.state === 'rip_decision') { document.getElementById('rip-title').innerText = "💀 RIP 💀"; msgDiv.innerText = s.duelInfo.attackerName + " te retó a Duelo."; duelWarn.style.display = 'none'; btnAccept.style.display = 'none'; btnSurrender.style.display = 'inline-block'; btnDuel.style.display = 'inline-block'; } 
                    else { document.getElementById('rip-title').innerText = "⚠️ CASTIGO ⚠️"; msgDiv.innerText = "Castigo de " + s.duelInfo.attackerName + "."; duelWarn.style.display = 'block'; btnAccept.style.display = 'inline-block'; btnSurrender.style.display = 'none'; btnDuel.style.display = 'inline-block'; }
                } else { 
                    document.getElementById('rip-screen').style.display = 'none'; document.getElementById('duel-screen').style.display = 'flex'; 
                    document.getElementById('duel-narrative').innerText = s.duelInfo.narrative || "Esperando respuesta..."; document.getElementById('duel-names').innerText = s.duelInfo.attackerName + ' vs ' + s.duelInfo.defenderName; document.getElementById('duel-opts').style.display = 'none'; 
                }
            }
            else if (s.state === 'dueling') {
                changeScreen('game-area'); forceCloseChat(); document.body.classList.add('state-dueling');
                document.getElementById('rip-screen').style.display = 'none'; document.getElementById('duel-screen').style.display = 'flex';
                document.getElementById('duel-narrative').innerText = s.duelInfo.narrative || "..."; document.getElementById('duel-names').innerText = s.duelInfo.attackerName + ' vs ' + s.duelInfo.defenderName; document.getElementById('duel-sc').innerText = s.duelInfo.scoreAttacker + ' - ' + s.duelInfo.scoreDefender;
                
                const amFighter = (myUUID === s.duelInfo.attackerId || myUUID === s.duelInfo.defenderId); 
                document.getElementById('duel-opts').style.display = amFighter ? 'flex' : 'none';
                
                if(amFighter) {
                    const isTurn = (s.duelInfo.turn === myUUID); 
                    document.getElementById('duel-turn-msg').innerText = isTurn ? "¡TU TURNO! Elige un ataque:" : "Esperando al oponente..."; 
                    document.querySelectorAll('.duel-btn').forEach(b => b.disabled = !isTurn);
                    if(s.duelInfo.myChoice) { document.getElementById('btn-' + s.duelInfo.myChoice).classList.add('selected'); } else { document.querySelectorAll('.duel-btn').forEach(b => b.classList.remove('selected')); }
                } else { document.getElementById('duel-turn-msg').innerText = ""; }
            }

            if(s.state === 'playing') {
                if(s.topCard) {
                    const tc = s.topCard; const el = document.getElementById('top-card'); el.style.backgroundColor = getBgColor(tc); el.style.border = (tc.value==='RIP'?'3px solid #666':(tc.value==='GRACIA'?'3px solid gold':'3px solid white')); el.innerText = getCardText(tc);
                    if(tc.value === '1 y 1/2') { el.style.fontSize = '20px'; el.style.padding = '0 5px'; } else { el.style.fontSize = '24px'; el.style.padding = '0'; }
                }
                
                if (me && me.isTurn && me.hasDrawn && s.pendingPenalty === 0) { document.getElementById('btn-pass').style.display = 'inline-block'; } 
                else { document.getElementById('btn-pass').style.display = 'none'; }

                if(me && me.isTurn && s.pendingPenalty > 0) { 
                    document.getElementById('penalty-display').style.display='block'; 
                    document.getElementById('pen-num').innerText = s.pendingPenalty; 
                } else { 
                    document.getElementById('penalty-display').style.display='none'; 
                }
            }
        });

        socket.on('handUpdate', h => { const oldLen = myHand.length; myHand = h; renderHand(oldLen); });
        function requestSort() { socket.emit('requestSort'); }

        function renderHand(oldLen) {
            if(document.body.classList.contains('state-dueling') || document.body.classList.contains('state-rip')) return;
            const hz = document.getElementById('hand-zone'); hz.innerHTML = '';
            let displayHand = myHand; const newCardsCount = Math.max(0, myHand.length - oldLen); const startAnimIdx = myHand.length - newCardsCount;
            const hasGrace = myHand.some(c=>c.value==='GRACIA'); document.getElementById('grace-btn').style.display = hasGrace ? 'block':'none';
            
            displayHand.forEach((c, index) => {
                const d = document.createElement('div'); d.className = 'hand-card'; if(ladderSelected.includes(c.id)) d.classList.add('selected-ladder');
                if (oldLen !== undefined && oldLen > 0 && index >= startAnimIdx) { d.classList.add('drawn-card'); }
                d.style.backgroundColor = getBgColor(c); d.style.color = (c.color==='amarillo'||c.color==='verde')?'black':'white'; d.innerText = getCardText(c);
                if(c.value === '1 y 1/2') { d.style.fontSize = '16px'; d.style.padding = '0 5px'; }
                
                d.onmousedown = d.ontouchstart = (e) => { pressTimer = setTimeout(() => { if(!ladderMode) { ladderMode = true; if(navigator.vibrate) navigator.vibrate(50); toggleLadderSelection(c, d); } }, 800); };
                d.onmouseup = d.onmouseleave = d.ontouchend = () => clearTimeout(pressTimer);
                d.onclick = () => { if(ladderMode) { toggleLadderSelection(c, d); } else { handleCardClick(c); } };
                hz.appendChild(d);
            });
        }
        
        function toggleLadderSelection(c, d) {
            if(ladderSelected.includes(c.id)) { ladderSelected = ladderSelected.filter(id => id !== c.id); d.classList.remove('selected-ladder'); if(ladderSelected.length === 0) cancelLadder(); } 
            else { ladderSelected.push(c.id); d.classList.add('selected-ladder'); } updateLadderUI();
        }

        function cancelLadder() { ladderMode = false; ladderSelected = []; document.querySelectorAll('.hand-card').forEach(c => c.classList.remove('selected-ladder')); updateLadderUI(); }
        
        function updateLadderUI() { 
            const active = ladderMode; document.getElementById('btn-sort').style.display = active ? 'none' : 'block'; 
            document.getElementById('btn-ladder-play').style.display = (active && ladderSelected.length >= 2) ? 'block' : 'none'; 
            document.getElementById('btn-ladder-cancel').style.display = active ? 'block' : 'none'; 
        }

        function handleCardClick(c) {
            if(document.getElementById('color-picker').style.display === 'flex') return;

            const hasPenalty = (document.getElementById('penalty-display').style.display === 'block');
            if (hasPenalty && !pendingLibreContext) {
                if (c.value !== 'GRACIA' && c.value !== 'LIBRE') {
                    const isPenaltyCard = ['+2', '+4', '+12', 'SALTEO SUPREMO'].includes(c.value);
                    if (!isPenaltyCard) {
                        const b = document.getElementById('main-alert'); b.innerText="🚫 ¡Cumple el castigo tocando el mazo, acumúlalo o defiéndete!"; b.style.display='block'; setTimeout(()=>b.style.display='none',3000); 
                        return;
                    }
                }
            }

            if(c.value === 'LIBRE' && !pendingLibreContext) { socket.emit('playCard', c.id, null, null, null); return; }
            if(c.value === 'GRACIA') {
                const hasZombies = currentPlayers.some(p => p.isDead); const isDecisionPhase = (document.body.classList.contains('state-rip'));
                if(isDecisionPhase) { socket.emit('playCard', c.id, null, null, pendingLibreContext); pendingLibreContext = null; return; }
                if(!hasZombies && !hasPenalty) { showGraceModal(); pendingCard = c.id; return; }
            }
            
            if(c.color==='negro' && c.value!=='GRACIA') { 
                if(c.value==='RIP' || c.value==='SALTEO SUPREMO' || c.value==='+12') { 
                    if(c.value==='RIP') { socket.emit('playCard', c.id, null, null, pendingLibreContext); pendingLibreContext = null; } 
                    else { pendingCard=c.id; document.getElementById('color-picker').style.display='flex'; } 
                } 
                else { pendingCard=c.id; document.getElementById('color-picker').style.display='flex'; } 
            } else {
                socket.emit('playCard', c.id, null, null, pendingLibreContext);
                pendingLibreContext = null;
            }
        }

        function showGraceModal() { document.getElementById('grace-color-modal').style.display = 'flex'; }
        function confirmGraceColor(confirmed) { 
            document.getElementById('grace-color-modal').style.display = 'none'; 
            if (confirmed) { pendingColorForRevive = null; pendingGrace = false; document.getElementById('color-picker').style.display='flex'; } 
            else { socket.emit('playCard', pendingCard, null, null, pendingLibreContext); pendingLibreContext = null; pendingCard = null; } 
        }
        
        function submitLadder() { 
            const hasPenalty = (document.getElementById('penalty-display').style.display === 'block');
            if(hasPenalty) { const b = document.getElementById('main-alert'); b.innerText="🚫 ¡No puedes hacer jugadas múltiples con castigo pendiente!"; b.style.display='block'; setTimeout(()=>b.style.display='none',3000); cancelLadder(); return; }
            if(ladderSelected.length < 2) return; 
            socket.emit('playMultiCards', ladderSelected); cancelLadder(); 
        }

        function changeScreen(id) { 
            document.querySelectorAll('.screen').forEach(s=>s.style.display='none'); document.getElementById('game-area').style.display='none'; document.getElementById('action-bar').style.display='none'; 
            document.querySelectorAll('.hud-btn').forEach(b => b.style.display = 'none'); 
            document.getElementById(id).style.display='flex'; 
            
            if (id === 'lobby') {
                const cb = document.getElementById('chat-btn');
                cb.style.display = 'flex'; cb.style.top = '65px'; cb.style.right = '10px';
                const lv = document.getElementById('global-leave-btn');
                if(lv) { lv.style.display = 'flex'; lv.style.top = '15px'; lv.style.left = '15px'; }
            } else if (id === 'game-area') {
                const cb = document.getElementById('chat-btn');
                cb.style.display = 'flex'; cb.style.right = '20px'; requestAnimationFrame(repositionHUD);
            }
        }
        
        function start(){ socket.emit('requestStart'); } function draw(){ socket.emit('draw'); } function pass(){ socket.emit('passTurn'); }
        function trySayUno() { if(myHand.length > 2) { const b=document.getElementById('main-alert'); b.innerText="🚫 ¡No puedes anunciar si no es verdad!"; b.style.display='block'; setTimeout(()=>b.style.display='none',3000); toggleUnoMenu(); return; } sayUno(); }
        function sayUno(){ socket.emit('sayUno'); toggleUnoMenu(); }
        
        function toggleUnoMenu() { 
            if(document.body.classList.contains('state-dueling') || document.body.classList.contains('state-rip')) return; 
            const m = document.getElementById('uno-menu'); m.style.display = (m.style.display==='flex'?'none':'flex'); closeDenounceList(); 
        }
        
        function showDenounceList() {
            document.getElementById('uno-main-opts').style.display = 'none'; document.getElementById('uno-denounce-opts').style.display = 'block';
            const cont = document.getElementById('denounce-list-container'); cont.innerHTML = '';
            currentPlayers.forEach(p => {
                if (p.uuid !== myUUID && !p.isSpectator && !p.isDead && !p.hasLeft) {
                    const b = document.createElement('button'); b.className = 'btn-main'; b.style.width = '100%'; b.style.margin = '2px 0'; b.innerText = p.name;
                    b.onclick = () => { socket.emit('reportUno', p.id); toggleUnoMenu(); }; cont.appendChild(b);
                }
            });
        }
        function closeDenounceList() { document.getElementById('uno-main-opts').style.display = 'block'; document.getElementById('uno-denounce-opts').style.display = 'none'; }

        function sendChat(){ const i=document.getElementById('chat-in'); if(i.value){ socket.emit('sendChat',i.value); i.value=''; }}
        function toggleChat(){ 
            const w = document.getElementById('chat-win'); 
            if(isChatOpen) { w.style.display = 'none'; isChatOpen = false; } 
            else { 
                w.style.display = 'flex'; isChatOpen = true; unreadCount = 0; document.getElementById('chat-badge').style.display = 'none'; document.getElementById('chat-badge').innerText = '0'; 
                const pZone = document.getElementById('players-zone');
                if (!pZone || pZone.offsetHeight === 0) { w.style.top = '130px'; w.style.right = '10px'; }
            } 
        }
        function forceCloseChat() { document.getElementById('chat-win').style.display = 'none'; isChatOpen = false; document.getElementById('uno-menu').style.display = 'none'; document.querySelectorAll('.floating-window').forEach(w => w.style.display='none'); }
        
        function toggleRules() { const r = document.getElementById('rules-modal'); r.style.display = (r.style.display === 'flex') ? 'none' : 'flex'; }
        function toggleScores() { const r = document.getElementById('score-modal'); r.style.display = (r.style.display === 'flex') ? 'none' : 'flex'; }
        function toggleManual() { const r = document.getElementById('manual-modal'); r.style.display = (r.style.display === 'flex') ? 'none' : 'flex'; }

        function pickCol(c){ 
            document.getElementById('color-picker').style.display='none'; pendingColorForRevive = c; 
            if(pendingGrace) { socket.emit('playGraceDefense',c); } else { socket.emit('playCard', pendingCard, c, null, pendingLibreContext); pendingLibreContext = null; }
        }
        function ripResp(d){ socket.emit('ripDecision',d); } function pick(c){ socket.emit('duelPick',c); }
        
        let pendingReviveCardId = null;
        socket.on('askReviveConfirmation', (data) => { pendingReviveCardId = data.cardId; document.getElementById('revive-name').innerText = data.name; document.getElementById('revive-confirm-screen').style.display = 'flex'; });
        function confirmRevive(confirmed) { 
            document.getElementById('revive-confirm-screen').style.display = 'none'; 
            if(pendingReviveCardId) { socket.emit('confirmReviveSingle', { cardId: pendingReviveCardId, confirmed: confirmed, chosenColor: pendingColorForRevive, libreContext: pendingLibreContext }); } 
            pendingReviveCardId = null; pendingLibreContext = null;
        }

        socket.on('ladderAnimate', (data) => {
            data.cards.forEach((c, i) => { setTimeout(() => { const el = document.createElement('div'); el.className = 'flying-card'; el.style.backgroundColor = getBgColor(c); el.style.color = (c.color==='amarillo'||c.color==='verde')?'black':'white'; el.innerText = getCardText(c); el.style.bottom = '150px'; el.style.left = '50%'; el.style.transform = 'translateX(-50%)'; document.body.appendChild(el); setTimeout(() => { el.style.bottom = '50%'; el.style.opacity = '0'; el.style.transform = 'translate(-50%, -50%) scale(0.5)'; }, 50); setTimeout(() => el.remove(), 600); }, i * 200); });
        });

        socket.on('roundStarted', data => {
            forceCloseChat(); 
            const banner = document.getElementById('round-start-banner');
            document.getElementById('rsb-round').innerText = "RONDA " + data.round;
            document.getElementById('rsb-starter').innerText = "Comienza " + data.starterName;
            banner.style.display = 'flex'; void banner.offsetWidth; banner.classList.add('show');
            setTimeout(() => { banner.classList.remove('show'); setTimeout(() => banner.style.display = 'none', 500); }, 3000);
        });

        // NUEVO: SISTEMA DE ABANDONO
        function requestLeave() { socket.emit('requestLeave'); }
        socket.on('showLeaveNormalPrompt', () => { document.getElementById('leave-normal-modal').style.display = 'flex'; });
        socket.on('showLeaveAdminPrompt', () => { document.getElementById('leave-admin-modal').style.display = 'flex'; });
        function confirmLeave(choice) { closeLeaveModals(); socket.emit('confirmLeave', choice); }
        function closeLeaveModals() { document.getElementById('leave-normal-modal').style.display = 'none'; document.getElementById('leave-admin-modal').style.display = 'none'; }
        
        socket.on('gamePaused', (data) => {
            document.getElementById('pause-msg').innerText = data.message;
            document.getElementById('pause-overlay').style.display = 'flex';
            setTimeout(() => { document.getElementById('pause-overlay').style.display = 'none'; }, data.duration);
        });

        // --- MANEJO DE CANCELACIÓN DE SALA EN EL LOBBY ---
        socket.on('roomCancelled', () => {
            document.getElementById('action-bar').style.display = 'none';
            document.querySelectorAll('.hud-btn').forEach(b => b.style.display = 'none');
            document.getElementById('round-overlay').style.display = 'none';
            const goScreen = document.getElementById('game-over-screen');
            goScreen.style.display = 'flex';
            goScreen.innerHTML = '<h1 style="color:#e74c3c;">SALA CERRADA</h1><h2 style="color:white; margin-top:20px;">EL ANFITRIÓN ELIMINÓ ESTA PARTIDA</h2>';
            setTimeout(() => { localStorage.removeItem('uno_uuid'); window.location = window.location.origin; }, 4000);
        });

        socket.on('countdownTick',n=>{ changeScreen('game-area'); forceCloseChat(); document.getElementById('countdown').style.display=n>0?'flex':'none'; document.getElementById('countdown').innerText=n; });
        socket.on('playSound',k=>{const a=new Audio({soft:'https://cdn.freesound.org/previews/240/240776_4107740-lq.mp3',attack:'https://cdn.freesound.org/previews/155/155235_2452367-lq.mp3',rip:'https://cdn.freesound.org/previews/173/173930_2394245-lq.mp3',divine:'https://cdn.freesound.org/previews/242/242501_4414128-lq.mp3',uno:'https://cdn.freesound.org/previews/415/415209_5121236-lq.mp3',start:'https://cdn.freesound.org/previews/320/320655_5260872-lq.mp3',win:'https://cdn.freesound.org/previews/270/270402_5123851-lq.mp3',bell:'https://cdn.freesound.org/previews/336/336899_4939433-lq.mp3',wild:'https://cdn.freesound.org/previews/320/320653_5260872-lq.mp3',saff:'https://cdn.freesound.org/previews/614/614742_11430489-lq.mp3'}[k]); a.volume=0.3; a.play().catch(()=>{});});
        
        socket.on('notification',m=>{const b=document.getElementById('main-alert'); b.innerText=m; b.style.display='block'; setTimeout(()=>b.style.display='none',4000);});
        socket.on('showDivine',m=>{const b=document.getElementById('main-alert'); b.innerText=m; b.style.display='block'; b.style.background='white'; b.style.color='gold'; setTimeout(()=>{b.style.display='none'; b.style.background='rgba(0,0,0,0.95)'; b.style.color='white';},4000);});
        socket.on('cardPlayedEffect', d => { if(d.color) document.body.className = 'bg-' + d.color; });
        
        socket.on('chatMessage', m => { const b = document.getElementById('chat-msgs'); b.innerHTML += '<div><b style="color:gold">' + m.name + ':</b> ' + m.text + '</div>'; b.scrollTop = b.scrollHeight; if(!isChatOpen) { unreadCount++; const badge = document.getElementById('chat-badge'); badge.style.display = 'flex'; badge.innerText = unreadCount > 9 ? '9+' : unreadCount; } });
        socket.on('chatHistory',h=>{const b=document.getElementById('chat-msgs'); b.innerHTML=''; h.forEach(m=>b.innerHTML+='<div><b style="color:gold">' + m.name + ':</b> ' + m.text + '</div>'); b.scrollTop=b.scrollHeight;});
        
        socket.on('roundOver', async d => {
            document.getElementById('action-bar').style.display='none'; document.querySelectorAll('.hud-btn').forEach(b => b.style.display = 'none');
            document.getElementById('stage-collection').style.display = 'none'; document.getElementById('stage-ranking').style.display = 'none'; document.getElementById('round-overlay').style.display = 'flex';
            document.getElementById('stage-collection').style.display = 'flex'; document.getElementById('r-winner-name').innerText = d.winner;
            const wPtsEl = document.getElementById('r-winner-pts'); let acumuladoRonda = 0; wPtsEl.innerText = "0 pts"; 
            const losersArea = document.getElementById('losers-area'); losersArea.innerHTML = '';

            for (let loser of d.losersDetails) {
                const lDiv = document.createElement('div');
                lDiv.innerHTML = '<span style="color:white; font-size:24px;">' + loser.name + '</span> <span style="color:#ff4757; font-weight:bold; margin-left:15px; font-size:24px;">+' + loser.points + '</span>';
                lDiv.style.opacity = '0'; lDiv.style.transition = 'opacity 0.5s'; losersArea.appendChild(lDiv);
                
                await new Promise(r => setTimeout(r, 400)); lDiv.style.opacity = '1'; await new Promise(r => setTimeout(r, 500));

                const flyer = document.createElement('div'); flyer.className = 'score-flyer'; flyer.innerText = '+' + loser.points;
                const rect = lDiv.getBoundingClientRect(); flyer.style.top = rect.top + 'px'; flyer.style.left = (rect.right + 20) + 'px'; document.body.appendChild(flyer);
                await new Promise(r => setTimeout(r, 50));
                
                const destRect = wPtsEl.getBoundingClientRect(); flyer.style.top = destRect.top + 'px'; flyer.style.left = destRect.left + 'px'; flyer.style.opacity = '0';
                await new Promise(r => setTimeout(r, 600)); flyer.remove();
                
                acumuladoRonda += loser.points; wPtsEl.innerText = acumuladoRonda + ' pts';
                wPtsEl.style.transform = 'scale(1.3)'; wPtsEl.style.borderColor = '#2ecc71';
                setTimeout(() => { wPtsEl.style.transform = 'scale(1)'; wPtsEl.style.borderColor = 'gold'; }, 300); lDiv.style.opacity = '0.3';
            }
            await new Promise(r => setTimeout(r, 2000)); 

            document.getElementById('stage-collection').style.display = 'none'; document.getElementById('stage-ranking').style.display = 'flex';
            const rankList = document.getElementById('ranking-list'); rankList.innerHTML = '';
            d.leaderboard.forEach((u, i) => {
                const row = document.createElement('div'); row.className = 'rank-row ' + (i===0 ? 'rank-gold' : '');
                row.innerHTML = '<span>' + (i+1) + '. ' + u.name + '</span><span>' + parseFloat(u.score).toFixed(1) + ' pts</span>'; rankList.appendChild(row);
            });
            const rows = document.querySelectorAll('.rank-row');
            for (let row of rows) { await new Promise(r => setTimeout(r, 600)); row.classList.add('visible'); }
        });

        // NUEVA LÓGICA DE GAME OVER (Recibe parámetro "reason")
        socket.on('gameOver', d => {
            document.getElementById('action-bar').style.display = 'none'; 
            document.querySelectorAll('.hud-btn').forEach(b => b.style.display = 'none'); 
            document.getElementById('round-overlay').style.display='none';
            document.getElementById('game-over-screen').style.display='flex'; 
            document.getElementById('winner-name').innerText = d.winner; 
            
            const fs = document.getElementById('final-score');
            if (d.reason === 'desertion') {
                fs.innerText = "¡Ganaste por deserción de tu oponente!";
            } else if (d.reason === 'cancelled') {
                fs.innerText = "El anfitrión terminó la partida.";
            } else {
                fs.innerText = "Puntaje Final: " + parseFloat(d.totalScore).toFixed(1);
            }
            
            setTimeout(()=>{localStorage.removeItem('uno_uuid'); window.location=window.location.origin;},10000);
        });
        
        socket.on('askReviveTarget',z=>{const l=document.getElementById('zombie-list'); l.innerHTML=''; z.forEach(x=>{const b=document.createElement('button'); b.className='zombie-btn'; b.innerHTML=x.name + '<br><small>(' + x.count + ')</small>'; b.onclick=()=>{document.getElementById('revive-screen').style.display='none'; socket.emit('playCard',pendingCard,pendingColorForRevive,x.id, pendingLibreContext); pendingLibreContext = null;}; l.appendChild(b);}); document.getElementById('revive-screen').style.display='flex';});
    </script>
</body>
</html>
    `);
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
