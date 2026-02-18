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

// Pesos para ordenamiento
const sortValWeights = {
    '0':0, '1':1, '1 y 1/2':1.5, '2':2, '3':3, '4':4, '5':5, '6':6, '7':7, '8':8, '9':9,
    '+2': 20, 'X': 21, 'R': 22,
    'color': 50, '+4': 51, 'SALTEO SUPREMO': 52, '+12': 53, 'RIP': 54, 'LIBRE': 55, 'GRACIA': 56
};
const sortColWeights = { 'rojo':1, 'azul':2, 'verde':3, 'amarillo':4, 'negro':5 };

const colors = ['rojo', 'azul', 'verde', 'amarillo'];
const values = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '1 y 1/2', '+2', 'X', 'R'];

// Limpieza automática
setInterval(() => {
    const now = Date.now();
    Object.keys(rooms).forEach(roomId => {
        if (now - rooms[roomId].lastActivity > 7200000) delete rooms[roomId];
    });
}, 60000 * 5); 

// --- FUNCIONES DEL SERVIDOR ---

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
        pendingSkip: 0,
        duelState: { 
            attackerId: null, defenderId: null, attackerName: '', defenderName: '', 
            round: 1, scoreAttacker: 0, scoreDefender: 0, 
            attackerChoice: null, defenderChoice: null, history: [], turn: null, narrative: '',
            type: 'rip' // 'rip' o 'penalty'
        },
        chatHistory: [],
        lastActivity: Date.now()
    };
}

function touchRoom(roomId) { if (rooms[roomId]) rooms[roomId].lastActivity = Date.now(); }

function createDeck(roomId) {
    const room = rooms[roomId]; if(!room) return;
    room.deck = [];
    colors.forEach(color => {
        values.forEach(val => {
            room.deck.push({ color, value: val, type: 'normal', id: Math.random().toString(36) });
            if (val !== '0') room.deck.push({ color, value: val, type: 'normal', id: Math.random().toString(36) });
        });
    });
    // Especiales Negras
    for (let i = 0; i < 4; i++) {
        room.deck.push({ color: 'negro', value: 'color', type: 'wild', id: Math.random().toString(36) });
        room.deck.push({ color: 'negro', value: '+4', type: 'wild', id: Math.random().toString(36) });
    }
    
    // CARTAS SUPREMAS (2 de cada una)
    const addSpecial = (val, count) => {
        for(let k=0; k<count; k++) room.deck.push({ color: 'negro', value: val, type: 'special', id: Math.random().toString(36) });
    };

    addSpecial('RIP', 2);
    addSpecial('GRACIA', 2);
    addSpecial('+12', 2);
    addSpecial('LIBRE', 2);
    addSpecial('SALTEO SUPREMO', 2);
    
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

// --- SOCKETS ---
io.on('connection', (socket) => {
    
    socket.on('checkSession', (uuid) => {
        let foundRoomId = null; let foundPlayer = null;
        for (const rId in rooms) { 
            const p = rooms[rId].players.find(pl => pl.uuid === uuid); 
            if (p) { foundRoomId = rId; foundPlayer = p; break; } 
        }
        if (foundRoomId && foundPlayer) {
            foundPlayer.id = socket.id; foundPlayer.isConnected = true;
            socket.join(foundRoomId); touchRoom(foundRoomId); updateAll(foundRoomId);
        } else { socket.emit('requireLogin'); }
    });

    socket.on('createRoom', (data) => {
        const roomId = Math.random().toString(36).substring(2, 6).toUpperCase(); initRoom(roomId);
        const player = createPlayerObj(socket.id, data.uuid, data.name, true);
        rooms[roomId].players.push(player); socket.join(roomId); socket.emit('roomCreated', { roomId, name: data.name }); updateAll(roomId);
    });

    socket.on('joinRoom', (data) => {
        const roomId = data.roomId.toUpperCase(); const room = rooms[roomId];
        if (!room) { socket.emit('error', 'Sala no encontrada.'); return; }
        touchRoom(roomId);
        const existing = room.players.find(p => p.uuid === data.uuid);
        if (existing) { existing.id = socket.id; existing.name = data.name; existing.isConnected = true; socket.join(roomId); socket.emit('roomJoined', { roomId }); }
        else {
            const player = createPlayerObj(socket.id, data.uuid, data.name, (room.players.length === 0));
            player.isSpectator = (room.gameState !== 'waiting');
            room.players.push(player); socket.join(roomId); socket.emit('roomJoined', { roomId });
            io.to(roomId).emit('notification', `👋 ${player.name} entró.`);
        }
        updateAll(roomId);
    });
    
    socket.on('requestSort', () => {
        const roomId = getRoomId(socket); if(!roomId || !rooms[roomId]) return;
        const room = rooms[roomId]; const p = room.players.find(x => x.id === socket.id);
        if(!p) return;
        p.hand.sort((a,b) => {
            const cA = sortColWeights[a.color] || 99; const cB = sortColWeights[b.color] || 99;
            if(cA !== cB) return cA - cB;
            const vA = sortValWeights[a.value] || 99; const vB = sortValWeights[b.value] || 99;
            return vA - vB;
        });
        io.to(p.id).emit('handUpdate', p.hand); socket.emit('notification', 'Cartas ordenadas.');
    });

    socket.on('kickPlayer', (targetId) => {
        const roomId = getRoomId(socket); if(!roomId || !rooms[roomId]) return;
        const room = rooms[roomId]; const admin = room.players.find(p => p.id === socket.id);
        if(admin && admin.isAdmin) {
            const idx = room.players.findIndex(p => p.id === targetId);
            if(idx !== -1) { room.players.splice(idx, 1); updateAll(roomId); io.to(targetId).emit('error', 'Has sido expulsado de la sala.'); }
        }
    });

    socket.on('requestStart', () => {
        const roomId = getRoomId(socket); if(!roomId || !rooms[roomId]) return;
        const room = rooms[roomId]; if (room.gameState === 'waiting' && room.players.length >= 2) startCountdown(roomId);
    });

    socket.on('playMultiCards', (cardIds) => {
        const roomId = getRoomId(socket); if(!roomId || !rooms[roomId]) return; touchRoom(roomId);
        const room = rooms[roomId]; const pIndex = room.players.findIndex(p => p.id === socket.id); const player = room.players[pIndex];
        
        if (room.gameState !== 'playing' || pIndex !== room.currentTurn || room.pendingPenalty > 0) return;
        if (!cardIds || cardIds.length < 2) return; 

        let playCards = []; let tempHand = [...player.hand];
        for(let id of cardIds) { const c = tempHand.find(x => x.id === id); if(!c) return; playCards.push(c); }
        const top = room.discardPile[room.discardPile.length - 1];

        // 1. Combo 1 y 1/2
        if (playCards.length === 2 && playCards[0].value === '1 y 1/2' && playCards[1].value === '1 y 1/2') {
            const c1 = playCards[0]; const c2 = playCards[1];
            if (c1.color !== c2.color) { socket.emit('notification', '🚫 Deben ser del mismo color.'); return; }
            if (top.value !== '3') { socket.emit('notification', '🚫 Solo sobre un 3.'); return; }
            
            removeCards(player, cardIds);
            room.discardPile.push(...playCards); room.activeColor = c1.color; 
            io.to(roomId).emit('notification', `✨ ¡COMBO MATEMÁTICO! (1.5 + 1.5 = 3)`); io.to(roomId).emit('playSound', 'divine'); 
            checkUnoCheck(roomId, player);
            if(player.hand.length === 0) { finishRound(roomId, player); } else { advanceTurn(roomId, 1); updateAll(roomId); }
            return;
        }

        // 2. Escaleras
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

        // Escalera Integrada
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
        } 
        // Escalera Autónoma
        else {
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
            io.to(roomId).emit('notification', `🪜 ¡ESCALERA de ${player.name}!`); io.to(roomId).emit('playSound', 'soft');
            checkUnoCheck(roomId, player);
            if(player.hand.length === 0) { finishRound(roomId, player); } else { advanceTurn(roomId, 1); updateAll(roomId); }
        }
    });

    socket.on('playLibreAlbedrio', (data) => {
        const roomId = getRoomId(socket); if(!roomId || !rooms[roomId]) return; touchRoom(roomId);
        const room = rooms[roomId]; const pIndex = room.players.findIndex(p => p.id === socket.id); const player = room.players[pIndex];

        if (room.gameState !== 'playing' || pIndex !== room.currentTurn || room.pendingPenalty > 0) return;
        if (player.hand.length < 3) return; 

        // 1. Regalo
        const libreIdx = player.hand.findIndex(c => c.id === data.cardId); if (libreIdx === -1) return;
        const libreCard = player.hand.splice(libreIdx, 1)[0]; room.discardPile.push(libreCard); 

        const target = room.players.find(p => p.id === data.targetPlayerId);
        const giftIdx = player.hand.findIndex(c => c.id === data.giftCardId);
        if (!target || giftIdx === -1) return; 
        const giftCard = player.hand.splice(giftIdx, 1)[0]; target.hand.push(giftCard);
        io.to(target.id).emit('handUpdate', target.hand);

        // 2. Descarte
        const dId = data.discardId; 
        const dIdx = player.hand.findIndex(c => c.id === dId);
        if (dIdx === -1) { finishRound(roomId, player); return; }
        
        const lastDiscard = player.hand.splice(dIdx, 1)[0]; 
        room.discardPile.push(lastDiscard);
        io.to(roomId).emit('animateLibre', { playerName: player.name, cards: [lastDiscard] });
        io.to(roomId).emit('playSound', 'wild');

        if (player.hand.length === 0) {
            const isLegal = /^[0-9]$/.test(lastDiscard.value) || lastDiscard.value === '1 y 1/2' || lastDiscard.value === 'GRACIA';
            if (isLegal) { finishRound(roomId, player); return; } else { drawCards(roomId, pIndex, 1); io.to(roomId).emit('notification', `🚫 Cierre Ilegal. Robas 1.`); io.to(player.id).emit('handUpdate', player.hand); }
        } else {
            checkUnoCheck(roomId, player);
        }

        if (lastDiscard.color === 'negro' && data.chosenColor) room.activeColor = data.chosenColor;
        else if (lastDiscard.color !== 'negro') room.activeColor = lastDiscard.color;
        
        setTimeout(() => {
            io.to(roomId).emit('cardPlayedEffect', { color: room.activeColor });
            applyCardEffect(roomId, player, lastDiscard, data.chosenColor);
        }, 1500);
    });

    socket.on('confirmReviveSingle', (data) => {
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

        const deadPlayers = room.players.filter(p => p.isDead);

        if(data.confirmed && deadPlayers.length === 1) {
             const target = deadPlayers[0];
             target.isDead = false; target.isSpectator = false;
             io.to(roomId).emit('playerRevived', { savior: player.name, revived: target.name });
             io.to(roomId).emit('playSound', 'divine');
             
             if (data.chosenColor) room.activeColor = data.chosenColor; else if (!room.activeColor) room.activeColor = 'rojo';
             if (player.hand.length === 0) { finishRound(roomId, player); return; }
             checkUnoCheck(roomId, player);
             advanceTurn(roomId, 1); updateAll(roomId);
        } else {
             if (cardIndex === -1) { advanceTurn(roomId, 1); updateAll(roomId); }
        }
    });

    socket.on('playCard', (cardId, chosenColor, reviveTargetId) => {
        const roomId = getRoomId(socket); if(!roomId || !rooms[roomId]) return; touchRoom(roomId);
        const room = rooms[roomId]; if (room.gameState !== 'playing') return;
        
        const pIndex = room.players.findIndex(p => p.id === socket.id); if (pIndex === -1) return;
        const player = room.players[pIndex]; if (player.isDead || player.isSpectator) return;

        let cardIndex = player.hand.findIndex(c => c.id === cardId); 
        let card = (cardIndex !== -1) ? player.hand[cardIndex] : null;
        if (!card && reviveTargetId) {
             const top = room.discardPile[room.discardPile.length - 1];
             if(top && top.value === 'GRACIA') card = top;
        }

        if (!card) return;
        const top = room.discardPile[room.discardPile.length - 1];

        if (cardIndex !== -1) {
            // Regla última carta
            if (player.hand.length === 1) {
                const isStrictNumber = /^[0-9]$/.test(card.value);
                const isUnoYMedio = card.value === '1 y 1/2';
                const isGracia = card.value === 'GRACIA';
                if (!isStrictNumber && !isUnoYMedio && !isGracia) { socket.emit('notification', '🚫 Última carta: Solo Números o Gracia.'); return; }
            }

            if (top.color !== 'negro') room.activeColor = top.color;
            
            let isSaff = false;
            // SAFF
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
                    // DEFENSAS
                    if (card.value === 'GRACIA') { /* Pass */ }
                    else if (card.value === 'LIBRE' && room.pendingSkip === 0) { /* Pass */ }
                    else {
                        const getVal = (v) => { if (v === '+2') return 2; if (v === '+4') return 4; if (v === '+12') return 12; return 0; };
                        const cardVal = getVal(card.value); const topVal = getVal(top.value);
                        if (cardVal === 0 || cardVal < topVal) { socket.emit('notification', `🚫 Debes tirar un castigo igual/mayor, Gracia o Libre.`); return; }
                    }
                } else {
                    let valid = (card.color === 'negro' || card.value === 'GRACIA' || card.color === room.activeColor || card.value === top.value);
                    if (!valid) { socket.emit('notification', `❌ Carta inválida.`); return; }
                }
            }
        }

        // LIBRE DEFENSIVO
        if (room.pendingPenalty > 0 && card.value === 'LIBRE' && room.pendingSkip === 0 && cardIndex !== -1) {
             player.hand.splice(cardIndex, 1); room.discardPile.push(card);
             io.to(roomId).emit('notification', `🛡️ ${player.name} usó LIBRE ALBEDRÍO para bloquear el castigo.`);
             io.to(roomId).emit('playSound', 'wild');
             room.pendingPenalty = 0;
             socket.emit('startLibreLogic', card.id);
             return;
        }

        // GRACIA DIVINA
        if (card.value === 'GRACIA') {
            const deadPlayers = room.players.filter(p => p.isDead);
            
            // Defensa de Castigo
            if (room.pendingPenalty > 0 && cardIndex !== -1) {
                player.hand.splice(cardIndex, 1); room.discardPile.push(card); 
                io.to(roomId).emit('playSound', 'divine');
                if (chosenColor) room.activeColor = chosenColor; else if (!room.activeColor) room.activeColor = 'rojo';
                io.to(roomId).emit('showDivine', `${player.name} anuló el castigo`); 
                room.pendingPenalty = 0; room.pendingSkip = 0;
                checkUnoCheck(roomId, player);
                if (player.hand.length === 0) { finishRound(roomId, player); return; }
                advanceTurn(roomId, 1); updateAll(roomId); return;
            }
            
            // Revivir
            if (deadPlayers.length > 0) {
                if(deadPlayers.length === 1) {
                    socket.emit('askReviveConfirmation', { name: deadPlayers[0].name, cardId: card.id }); return; 
                } else {
                    if (!reviveTargetId) {
                        const zombieList = deadPlayers.map(z => ({ id: z.id, name: z.name, count: z.hand.length }));
                        socket.emit('askReviveTarget', zombieList); return; 
                    } else {
                        const target = room.players.find(p => p.id === reviveTargetId && p.isDead);
                        if (target) { 
                            target.isDead = false; target.isSpectator = false; 
                            io.to(roomId).emit('playerRevived', { savior: player.name, revived: target.name });
                            if(cardIndex !== -1) {
                                player.hand.splice(cardIndex, 1); room.discardPile.push(card); 
                                if (chosenColor) room.activeColor = chosenColor; else if (!room.activeColor) room.activeColor = 'rojo';
                            }
                            io.to(roomId).emit('playSound', 'divine');
                            checkUnoCheck(roomId, player);
                            if (player.hand.length === 0) { finishRound(roomId, player); return; }
                            advanceTurn(roomId, 1); updateAll(roomId); return;
                        }
                    }
                }
            } else { 
                if (cardIndex !== -1) {
                     io.to(roomId).emit('notification', `❤️ ${player.name} usó Gracia.`); 
                     player.hand.splice(cardIndex, 1); room.discardPile.push(card); 
                     io.to(roomId).emit('playSound', 'divine'); 
                     if (chosenColor) room.activeColor = chosenColor; else if (!room.activeColor) room.activeColor = 'rojo';
                     checkUnoCheck(roomId, player);
                     if (player.hand.length === 0) { finishRound(roomId, player); return; }
                     advanceTurn(roomId, 1); updateAll(roomId); return;
                }
            }
        }

        if (cardIndex === -1) return; 

        // RIP
        if (card.value === 'RIP') {
            if (room.pendingPenalty > 0) { socket.emit('notification', '🚫 RIP no evita castigos.'); return; }
            if (getAlivePlayersCount(roomId) < 2) { 
                player.hand.splice(cardIndex, 1); room.discardPile.push(card);
                advanceTurn(roomId, 1); updateAll(roomId); return; 
            }
            player.hand.splice(cardIndex, 1); room.discardPile.push(card); io.to(roomId).emit('playSound', 'rip');
            checkUnoCheck(roomId, player);
            
            room.gameState = 'rip_decision';
            const attacker = player; const victimIdx = getNextPlayerIndex(roomId, 1); const defender = room.players[victimIdx];
            room.duelState = { 
                attackerId: attacker.id, defenderId: defender.id, attackerName: attacker.name, defenderName: defender.name, 
                round: 1, scoreAttacker: 0, scoreDefender: 0, attackerChoice: null, defenderChoice: null, history: [], 
                turn: attacker.id, narrative: `💀 ${attacker.name} te retó a Duelo usando la carta RIP!`, type: 'rip' 
            };
            updateAll(roomId); return;
        }

        // LIBRE OFENSIVO
        if (card.value === 'LIBRE') {
             socket.emit('startLibreLogic', card.id);
             return;
        }

        // EJECUTAR CARTA NORMAL
        player.hand.splice(cardIndex, 1); room.discardPile.push(card);
        io.to(roomId).emit('cardPlayedEffect', { color: card.color });
        if (card.color === 'negro' && chosenColor) room.activeColor = chosenColor; else if (card.color !== 'negro') room.activeColor = card.color;

        checkUnoCheck(roomId, player);
        applyCardEffect(roomId, player, card, chosenColor);
    });

    socket.on('draw', () => {
        const roomId = getRoomId(socket); if(!roomId || !rooms[roomId]) return; touchRoom(roomId);
        const room = rooms[roomId]; if (room.gameState !== 'playing') return;
        const pIndex = room.players.findIndex(p => p.id === socket.id);
        if (pIndex === -1 || room.players[pIndex].isDead || room.players[pIndex].isSpectator) return;
        
        if (pIndex === room.currentTurn) {
            if (room.pendingPenalty > 0) {
                // Robo Manual por Castigo
                drawCards(roomId, pIndex, 1); room.pendingPenalty--; io.to(roomId).emit('playSound', 'soft');
                if (room.pendingPenalty > 0) { 
                    io.to(roomId).emit('notification', `😰 Faltan: ${room.pendingPenalty}`); 
                    updateAll(roomId); 
                } else { 
                    if (room.pendingSkip > 0) {
                        io.to(roomId).emit('notification', `😓 Pierdes ${room.pendingSkip} turnos.`); 
                        const skips = room.pendingSkip; room.pendingSkip = 0;
                        advanceTurn(roomId, skips + 1);
                    } else {
                        io.to(roomId).emit('notification', `😓 Fin del castigo.`); 
                        advanceTurn(roomId, 1);
                    }
                    updateAll(roomId); 
                }
            } else {
                if (!room.players[pIndex].hasDrawn) { 
                    drawCards(roomId, pIndex, 1); room.players[pIndex].hasDrawn = true; 
                    room.players[pIndex].saidUno = false; room.players[pIndex].lastOneCardTime = 0;
                    io.to(roomId).emit('playSound', 'soft'); updateAll(roomId); 
                } 
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

    socket.on('ripDecision', (d) => {
        const roomId = getRoomId(socket); if(!roomId || !rooms[roomId]) return; touchRoom(roomId);
        const room = rooms[roomId]; if (room.gameState !== 'rip_decision' && room.gameState !== 'penalty_decision') return;
        if (socket.id !== room.duelState.defenderId) return;

        if (d === 'surrender') { 
            if(room.duelState.type === 'rip') {
                eliminatePlayer(roomId, room.duelState.defenderId); checkWinCondition(roomId); 
            }
        }
        else if (d === 'accept_penalty') {
             const p = room.players.find(x => x.id === socket.id);
             io.to(roomId).emit('notification', `${p.name} aceptó el castigo.`);
             room.gameState = 'playing'; 
             updateAll(roomId);
        }
        else { 
            io.to(roomId).emit('playSound', 'bell'); room.gameState = 'dueling';
            room.duelState.narrative = `¡${room.duelState.defenderName} aceptó el duelo!`; 
            updateAll(roomId); 
        }
    });

    socket.on('duelPick', (c) => {
        const roomId = getRoomId(socket); if(!roomId || !rooms[roomId]) return; touchRoom(roomId);
        const room = rooms[roomId]; if (room.gameState !== 'dueling') return;
        if (socket.id !== room.duelState.turn) return;
        
        if (socket.id === room.duelState.attackerId) { 
            room.duelState.attackerChoice = c; room.duelState.turn = room.duelState.defenderId;
            room.duelState.narrative = `⚔️ ${room.duelState.attackerName} eligió. Turno de ${room.duelState.defenderName}...`;
        } 
        else if (socket.id === room.duelState.defenderId) { room.duelState.defenderChoice = c; resolveDuelRound(roomId); return; }
        updateAll(roomId);
    });
    
    // UNO y 1/2
    socket.on('sayUno', () => {
        const roomId = getRoomId(socket); if(!roomId) return;
        const room = rooms[roomId]; const p = room.players.find(x => x.id === socket.id);
        if(p && p.hand.length === 1) {
            p.saidUno = true;
            io.to(roomId).emit('notification', `📢 ¡${p.name} gritó "UNO y 1/2"!`);
            io.to(roomId).emit('playSound', 'uno');
        }
    });

    socket.on('reportUno', (targetId) => {
        const roomId = getRoomId(socket); if(!roomId) return;
        const room = rooms[roomId]; const accuser = room.players.find(x => x.id === socket.id);
        const target = room.players.find(x => x.id === targetId);
        
        if(!target || target.hand.length !== 1 || target.saidUno) { socket.emit('notification', 'Denuncia inválida.'); return; }
        
        const timeDiff = Date.now() - target.lastOneCardTime;
        if (timeDiff < 2000) { socket.emit('notification', '¡Espera! Tiene tiempo de gracia (2s).'); return; }

        drawCards(roomId, room.players.indexOf(target), 2);
        target.saidUno = true; 
        io.to(roomId).emit('notification', `🚨 ¡${accuser.name} denunció a ${target.name}! Castigo: +2 cartas.`);
        updateAll(roomId);
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
        if (roomId && rooms[roomId]) { 
            const room = rooms[roomId]; const p = room.players.find(pl => pl.id === socket.id); 
            if(p) {
                p.isConnected = false;
                if (room.gameState === 'dueling' || room.gameState === 'rip_decision' || room.gameState === 'penalty_decision') {
                     if(socket.id === room.duelState.attackerId || socket.id === room.duelState.defenderId) {
                         eliminatePlayer(roomId, socket.id); checkWinCondition(roomId);
                     }
                }
                updateAll(roomId);
            }
        }
    });
});

// --- HELPERS ---

function createPlayerObj(socketId, uuid, name, isAdmin) {
    return { id: socketId, uuid, name: name.substring(0, 12), hand: [], hasDrawn: false, isSpectator: false, isDead: false, isAdmin, isConnected: true, saidUno: false, lastOneCardTime: 0 };
}

function checkUnoCheck(roomId, player) {
    if (player.hand.length === 1) {
        player.lastOneCardTime = Date.now();
        player.saidUno = false;
    } else {
        player.saidUno = false;
        player.lastOneCardTime = 0;
    }
}

function removeCards(player, ids) {
    ids.forEach(id => {
        const idx = player.hand.findIndex(c => c.id === id);
        if(idx !== -1) player.hand.splice(idx, 1);
    });
}

function applyCardEffect(roomId, player, card, chosenColor) {
    const room = rooms[roomId];
    let steps = 1;
    
    if (card.value === 'R') { if (getAlivePlayersCount(roomId) === 2) steps = 2; else room.direction *= -1; }
    if (card.value === 'X') steps = 2;
    
    if (['+2', '+4', '+12', 'SALTEO SUPREMO'].includes(card.value)) {
        let val = 0; let skips = 0;
        if(card.value === '+2') val=2;
        if(card.value === '+4') val=4;
        if(card.value === '+12') val=12;
        if(card.value === 'SALTEO SUPREMO') { val=4; skips=4; }

        room.pendingPenalty += val;
        room.pendingSkip += skips;
        
        io.to(roomId).emit('notification', `💥 ¡${card.value}! Total: ${room.pendingPenalty}`); 
        io.to(roomId).emit('playSound', 'attack');
        if (val > 4) io.to(roomId).emit('shakeScreen');

        if (['+12', 'SALTEO SUPREMO'].includes(card.value)) {
            const nextPIdx = getNextPlayerIndex(roomId, 1);
            const victim = room.players[nextPIdx];
            room.gameState = 'penalty_decision';
            room.duelState = { 
                attackerId: player.id, defenderId: victim.id, attackerName: player.name, defenderName: victim.name, 
                round: 1, scoreAttacker: 0, scoreDefender: 0, attackerChoice: null, defenderChoice: null, history: [], 
                turn: player.id, narrative: `⚔️ ¡${victim.name} puede batirse a duelo para evitar el castigo!`, type: 'penalty' 
            };
            room.currentTurn = nextPIdx;
            updateAll(roomId);
            return;
        }

        advanceTurn(roomId, 1); updateAll(roomId); return; 
    }

    if (card.color === 'negro') io.to(roomId).emit('playSound', 'wild'); else io.to(roomId).emit('playSound', 'soft');
    if (player.hand.length === 0) finishRound(roomId, player);
    else { advanceTurn(roomId, steps); updateAll(roomId); }
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
    const room = rooms[roomId];
    const att = room.duelState.attackerChoice, def = room.duelState.defenderChoice;
    let winner = 'tie';
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
    const room = rooms[roomId]; const att = room.players.find(p => p.id === room.duelState.attackerId); const def = room.players.find(p => p.id === room.duelState.defenderId);
    if (!att || !def) { room.gameState = 'playing'; updateAll(roomId); return; }
    
    const attWins = room.duelState.scoreAttacker > room.duelState.scoreDefender;
    const isPenaltyDuel = room.duelState.type === 'penalty';

    if (attWins) { 
        io.to(roomId).emit('notification', `💀 ${att.name} GANA el duelo.`); 
        if (!isPenaltyDuel) {
            eliminatePlayer(roomId, def.id); checkWinCondition(roomId); 
        } else {
            io.to(roomId).emit('notification', `🩸 ¡Castigo AUMENTADO para ${def.name}!`);
            room.pendingPenalty += 4; 
            room.gameState = 'playing'; 
            updateAll(roomId);
        }
    }
    else { 
        io.to(roomId).emit('notification', `🛡️ ${def.name} GANA el duelo.`);
        if (!isPenaltyDuel) {
             drawCards(roomId, rooms[roomId].players.indexOf(att), 2); 
             room.gameState = 'playing'; advanceTurn(roomId, 1); updateAll(roomId);
        } else {
             io.to(roomId).emit('notification', `✨ ¡${def.name} devuelve el castigo a ${att.name}!`);
             room.pendingPenalty = 0; room.pendingSkip = 0; 
             drawCards(roomId, rooms[roomId].players.indexOf(att), 4); 
             room.gameState = 'playing';
             advanceTurn(roomId, 1); 
             updateAll(roomId);
        }
    }
}

function eliminatePlayer(roomId, id) { const room = rooms[roomId]; const p = room.players.find(p => p.id === id); if (p) { p.isDead = true; p.isSpectator = true; } }
function getAlivePlayersCount(roomId) { return rooms[roomId].players.filter(p => !p.isDead && !p.isSpectator).length; }
function getRoomId(socket) { return Array.from(socket.rooms).find(r => r !== socket.id); }

function startCountdown(roomId) {
    const room = rooms[roomId]; if (room.players.length < 2) return;
    room.gameState = 'counting'; let count = 3; createDeck(roomId);
    let safeCard = room.deck.pop();
    while (['+2','+4','+12','R','X','RIP','GRACIA','LIBRE','SALTEO SUPREMO'].includes(safeCard.value) || safeCard.color === 'negro') {
        room.deck.unshift(safeCard); for (let i = room.deck.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [room.deck[i], room.deck[j]] = [room.deck[j], room.deck[i]]; } safeCard = room.deck.pop();
    }
    room.discardPile = [safeCard]; room.activeColor = safeCard.color; room.currentTurn = 0; room.pendingPenalty = 0; room.pendingSkip = 0;
    room.players.forEach(p => { p.hand = []; p.hasDrawn = false; p.isDead = false; p.saidUno = false; if (!p.isSpectator) { for (let i = 0; i < 7; i++) drawCards(roomId, room.players.indexOf(p), 1); } });
    io.to(roomId).emit('countdownTick', 3);
    room.countdownInterval = setInterval(() => {
        if (!rooms[roomId]) return clearInterval(room.countdownInterval);
        io.to(roomId).emit('countdownTick', count); io.to(roomId).emit('playSound', 'soft');
        if (count <= 0) { clearInterval(room.countdownInterval); room.gameState = 'playing'; io.to(roomId).emit('playSound', 'start'); updateAll(roomId); } count--;
    }, 1000);
}

function drawCards(roomId, pid, n) { 
    const room = rooms[roomId]; if (pid < 0 || pid >= room.players.length) return; 
    for (let i = 0; i < n; i++) { if (room.deck.length === 0) recycleDeck(roomId); if (room.deck.length > 0) room.players[pid].hand.push(room.deck.pop()); } 
    checkUnoCheck(roomId, room.players[pid]);
}

function advanceTurn(roomId, steps) {
    const room = rooms[roomId]; if (room.players.length === 0) return;
    room.players.forEach(p => p.hasDrawn = false);
    let attempts = 0;
    while (steps > 0 && attempts < room.players.length * 2) {
        room.currentTurn = (room.currentTurn + room.direction + room.players.length) % room.players.length;
        if (!room.players[room.currentTurn].isDead && !room.players[room.currentTurn].isSpectator) { steps--; } attempts++;
    }
    if (room.players[room.currentTurn]) room.players[room.currentTurn].hasDrawn = false;
}

function getNextPlayerIndex(roomId, steps) {
    const room = rooms[roomId]; let next = room.currentTurn; let attempts = 0;
    while (steps > 0 && attempts < room.players.length * 2) {
        next = (next + room.direction + room.players.length) % room.players.length;
        if (!room.players[next].isDead && !room.players[next].isSpectator) steps--; attempts++;
    } return next;
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

function updateAll(roomId) {
    const room = rooms[roomId]; if(!room) return;
    let lastRoundWinner = ""; if (room.duelState.history.length > 0) { lastRoundWinner = room.duelState.history[room.duelState.history.length - 1].winnerName; }
    
    // Lista de denunciables
    const reportablePlayers = room.players.filter(p => !p.isDead && !p.isSpectator && p.hand.length === 1 && !p.saidUno && (Date.now() - p.lastOneCardTime > 2000)).map(p => p.id);

    const duelInfo = (room.gameState === 'dueling' || room.gameState === 'rip_decision' || room.gameState === 'penalty_decision') ? { attackerName: room.duelState.attackerName, defenderName: room.duelState.defenderName, round: room.duelState.round, scoreAttacker: room.duelState.scoreAttacker, scoreDefender: room.duelState.scoreDefender, history: room.duelState.history, attackerId: room.duelState.attackerId, defenderId: room.duelState.defenderId, myChoice: null, turn: room.duelState.turn, lastWinner: lastRoundWinner, narrative: room.duelState.narrative, type: room.duelState.type } : null;

    const pack = { state: room.gameState, roomId: roomId, players: room.players.map((p, i) => ({ name: p.name + (p.isAdmin ? " 👑" : "") + (p.isSpectator ? " 👁️" : ""), cardCount: p.hand.length, id: p.id, isTurn: (room.gameState === 'playing' && i === room.currentTurn), hasDrawn: p.hasDrawn, isDead: p.isDead, isSpectator: p.isSpectator, isAdmin: p.isAdmin, isConnected: p.isConnected })), topCard: room.discardPile.length > 0 ? room.discardPile[room.discardPile.length - 1] : null, activeColor: room.activeColor, currentTurn: room.currentTurn, duelInfo, pendingPenalty: room.pendingPenalty, chatHistory: room.chatHistory, reportTargets: reportablePlayers };
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
    // IMPORTANTE: USAR COMILLAS SIMPLES O ESCAPAR BACKTICKS EN EL CLIENTE PARA EVITAR ERRORES DE PARSEO
    const htmlContent = `
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
        
        #game-over-screen { background: rgba(0,0,0,0.95); z-index: 200000; text-align: center; border: 5px solid gold; }
        
        #revive-screen, #revive-confirm-screen { position: fixed; top: 40%; left: 50%; transform: translate(-50%,-50%); background: rgba(0,0,0,0.95); border: 2px solid gold; padding: 20px; border-radius: 15px; z-index: 10500; display: none; text-align: center; width: 90%; max-width: 400px; }
        
        #reconnect-overlay { position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.8); z-index:90000; display:none; justify-content:center; align-items:center; color:white; font-size:20px; flex-direction:column; }
        .loader { border: 5px solid #f3f3f3; border-top: 5px solid #3498db; border-radius: 50%; width: 50px; height: 50px; animation: spin 1s linear infinite; margin-bottom:15px; }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }

        #libre-modal { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.95); z-index: 60000; display: none; flex-direction: column; justify-content: center; align-items: center; color: white; }
        .libre-step { display: none; width: 90%; text-align: center; }
        .libre-step.active { display: block; }
        .mini-card { display: inline-block; padding: 10px; margin: 5px; border: 2px solid white; border-radius: 5px; cursor: pointer; background: #444; }
        .mini-card.selected { border-color: gold; transform: scale(1.1); background: #666; }

        #players-zone { flex: 0 0 auto; padding: 10px; background: rgba(0,0,0,0.5); display: flex; flex-wrap: wrap; justify-content: center; gap: 5px; z-index: 20; }
        .player-badge { background: #333; color: white; padding: 5px 12px; border-radius: 20px; font-size: 13px; border: 1px solid #555; transition: all 0.3s; }
        .is-turn { background: #2ecc71; color: black; font-weight: bold; border: 2px solid white; transform: scale(1.1); box-shadow: 0 0 10px #2ecc71; }
        .is-dead { text-decoration: line-through; opacity: 0.6; }
        
        #alert-zone { 
            position: fixed; top: 120px; left: 0; width: 100%; 
            display: flex; flex-direction: column; justify-content: center; align-items: center; 
            z-index: 60000; pointer-events: none; 
        }
        
        .alert-box { background: rgba(0,0,0,0.95); border: 2px solid gold; color: white; padding: 15px; border-radius: 10px; text-align: center; font-weight: bold; font-size: 18px; box-shadow: 0 5px 20px rgba(0,0,0,0.8); animation: pop 0.3s ease-out; max-width: 90%; display: none; margin-bottom: 10px; pointer-events: auto; }
        #penalty-display { font-size: 30px; color: #ff4757; text-shadow: 0 0 5px red; display: none; margin-bottom: 10px; background: rgba(0,0,0,0.8); padding: 10px; border-radius: 10px; border: 1px solid red; pointer-events: auto; }
        
        #table-zone { flex: 1; display: flex; flex-direction: column; justify-content: center; align-items: center; gap: 15px; z-index: 15; position: relative; }
        #decks-container { display: flex; gap: 30px; transform: scale(1.1); }
        
        .card-pile { width: 70px; height: 100px; border-radius: 8px; border: 3px solid white; display: flex; justify-content: center; align-items: center; font-size: 24px; box-shadow: 0 5px 10px rgba(0,0,0,0.5); position: relative; color: white; white-space: nowrap; overflow: hidden; }
        #deck-pile { background: #e74c3c; cursor: pointer; }
        #top-card { background: #333; }
        
        #action-bar {
            position: fixed; bottom: 180px; left: 0; width: 100%;
            display: none; justify-content: center; align-items: center;
            padding: 10px; pointer-events: none; z-index: 20000;
        }
        #uno-btn-area { pointer-events: auto; display: flex; gap: 10px; flex-wrap: wrap; justify-content: center; background: none; padding: 0; border-radius: 0; }

        .btn-pass { background: #f39c12; color: white; border: 2px solid white; padding: 10px 20px; border-radius: 25px; font-weight: bold; cursor: pointer; display: none; box-shadow: 0 4px 0 #d35400; }
        #btn-ladder-play { background: #27ae60; color: white; border: 2px solid white; padding: 10px 20px; border-radius: 25px; font-weight: bold; cursor: pointer; display:none; animation: pop 0.3s; box-shadow: 0 0 10px gold; font-size: 14px; }
        #btn-sort { background: #34495e; color: white; border: 2px solid white; padding: 10px 20px; border-radius: 25px; font-weight: bold; cursor: pointer; font-size: 14px; box-shadow: 0 4px 0 #2c3e50; }

        #hand-zone { position: fixed; bottom: 0; left: 0; width: 100%; height: 180px; background: rgba(20, 20, 20, 0.95); border-top: 2px solid #555; display: flex; align-items: center; padding: 10px 20px; padding-bottom: calc(10px + var(--safe-bottom)); gap: 15px; overflow-x: auto; overflow-y: hidden; white-space: nowrap; scroll-snap-type: x mandatory; -webkit-overflow-scrolling: touch; z-index: 10000; }
        .hand-card { flex: 0 0 85px; height: 130px; border-radius: 8px; border: 2px solid white; background: #444; display: flex; justify-content: center; align-items: center; font-size: 32px; font-weight: 900; color: white; scroll-snap-align: center; position: relative; cursor: pointer; box-shadow: 0 4px 8px rgba(0,0,0,0.6); user-select: none; z-index: 1; transition: all 0.2s; white-space: nowrap; }
        .hand-card:active { transform: scale(0.95); }
        .hand-card.selected-ladder { border: 4px solid cyan !important; transform: translateY(-20px); box-shadow: 0 0 15px cyan; z-index:10; }

        body.bg-rojo { background-color: #4a1c1c !important; } body.bg-azul { background-color: #1c2a4a !important; } body.bg-verde { background-color: #1c4a2a !important; } body.bg-amarillo { background-color: #4a451c !important; }
        #color-picker { position: fixed; top: 40%; left: 50%; transform: translate(-50%,-50%); background: white; padding: 20px; border-radius: 10px; z-index: 4000; display: none; text-align: center; box-shadow: 0 0 50px black; }
        .color-circle { width: 60px; height: 60px; border-radius: 50%; display: inline-block; margin: 10px; cursor: pointer; border: 3px solid #ddd; }
        .zombie-btn { display: block; width: 100%; padding: 15px; margin: 10px 0; background: #333; color: white; border: 1px solid #666; font-size: 18px; cursor: pointer; border-radius: 10px; }
        #revival-overlay { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.95); z-index: 5000; flex-direction: column; justify-content: center; align-items: center; text-align: center; pointer-events: all; }
        #revival-text { color: white; font-size: 30px; font-weight: bold; text-shadow: 0 0 20px gold; padding: 20px; border: 3px solid gold; border-radius: 15px; background: rgba(50,50,0,0.3); max-width: 90%; animation: pop 0.5s ease-out; }
        
        #chat-btn { position: fixed; top: 110px; right: 20px; width: 50px; height: 50px; background: #3498db; border-radius: 50%; display: none; justify-content: center; align-items: center; border: 2px solid white; z-index: 50000; box-shadow: 0 4px 5px rgba(0,0,0,0.3); font-size: 24px; cursor: pointer; transition: all 0.3s; }
        #chat-win { position: fixed; top: 170px; right: 20px; width: 280px; height: 250px; background: rgba(0,0,0,0.95); border: 2px solid #666; display: none; flex-direction: column; z-index: 50000; border-radius: 10px; box-shadow: 0 0 20px black; }
        #chat-badge { position: absolute; top: -5px; right: -5px; background: red; color: white; border-radius: 50%; width: 20px; height: 20px; font-size: 12px; display: none; justify-content: center; align-items: center; font-weight: bold; border: 2px solid white; }
        #chat-close { position: absolute; top: 5px; right: 10px; color: #aaa; cursor: pointer; font-weight: bold; font-family: monospace; }
        
        #rules-btn { position: fixed; top: 110px; left: 20px; width: 50px; height: 50px; background: #9b59b6; border-radius: 50%; display: none; justify-content: center; align-items: center; border: 2px solid white; z-index: 50000; box-shadow: 0 4px 5px rgba(0,0,0,0.3); font-size: 24px; cursor: pointer; transition: all 0.3s; }
        #rules-modal, #manual-modal { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 95%; max-width: 600px; max-height: 90vh; background: rgba(15, 15, 15, 0.98); border: 2px solid #9b59b6; display: none; flex-direction: column; z-index: 50001; border-radius: 10px; padding: 20px; color: white; overflow-y: auto; box-shadow: 0 0 30px rgba(155, 89, 182, 0.5); }
        #rules-close, #manual-close { position: absolute; top: 10px; right: 15px; color: white; font-size: 24px; cursor: pointer; font-weight: bold; z-index:10; }
        
        .rule-row { display: flex; align-items: center; margin-bottom: 15px; text-align: left; }
        .rule-badge { width: 40px; height: 56px; border-radius: 4px; border: 2px solid white; display: flex; justify-content: center; align-items: center; font-weight: bold; margin-right: 15px; font-size: 20px; flex-shrink: 0; box-shadow: 0 2px 5px black; }
        .rule-text { font-size: 14px; line-height: 1.4; }

        /* Manual Styles */
        .man-card { display: inline-flex; justify-content: center; align-items: center; width: 35px; height: 50px; border-radius: 4px; border: 2px solid white; font-weight: bold; font-size: 14px; margin: 2px; color: white; text-shadow: 1px 1px 0 #000; box-shadow: 1px 1px 3px rgba(0,0,0,0.5); vertical-align: middle; }
        .man-example { background: rgba(255,255,255,0.1); padding: 10px; border-radius: 8px; margin: 5px 0; text-align: center; }
        .man-arrow { font-size: 20px; color: gold; margin: 0 5px; vertical-align: middle; }

        #duel-narrative { position: relative; z-index: 999999; font-size: 26px; text-align:center; padding:20px; border:2px solid #69f0ae; background:rgba(0,0,0,0.9); color: #69f0ae; width:90%; border-radius:15px; margin-bottom: 20px; box-shadow: 0 0 20px rgba(105, 240, 174, 0.5); text-shadow: 1px 1px 2px black; }
        .duel-btn { font-size:40px; background:none; border:none; cursor:pointer; opacity: 0.5; transition: 0.3s; }
        .duel-btn:hover { opacity: 0.8; }
        .duel-btn.selected { opacity: 1; transform: scale(1.3); text-shadow: 0 0 20px white; border-bottom: 3px solid gold; padding-bottom: 5px; }
        .duel-btn:disabled { opacity: 0.2; cursor: not-allowed; filter: grayscale(1); }
        input { padding:15px; font-size:20px; text-align:center; width:80%; max-width:300px; border-radius:30px; border:none; margin:10px 0; }
        .btn-main { padding:15px 40px; background:#27ae60; color:white; border:none; border-radius:30px; font-size:20px; cursor:pointer; margin: 10px; }
        @keyframes pop { 0% { transform: scale(0.8); opacity:0; } 100% { transform: scale(1); opacity:1; } }

        body.state-dueling #game-area, body.state-dueling #hand-zone, body.state-dueling #action-bar { display: none !important; }
        body.state-dueling #duel-screen { display: flex !important; }
        body.state-rip #game-area, body.state-rip #hand-zone, body.state-rip #action-bar { display: none !important; }
        body.state-rip #rip-screen { display: flex !important; } 

        .lobby-row { display: flex; align-items: center; justify-content: space-between; width: 100%; max-width: 300px; margin-bottom: 10px; background: rgba(0,0,0,0.3); padding: 5px 10px; border-radius: 5px; }
        .lobby-name { display: flex; align-items: center; gap: 10px; }
        .kick-btn { background: #e74c3c; border: none; color: white; font-weight: bold; cursor: pointer; padding: 2px 8px; border-radius: 5px; margin-left: 20px; }
        #lobby-link-container { margin-bottom: 30px; }
        
        #uno-main-btn { position: fixed; bottom: 180px; left: 10px; width: 60px; height: 60px; border-radius: 50%; background: #e67e22; border: 3px solid white; font-weight: bold; z-index: 30000; font-size: 11px; display: none; align-items: center; justify-content: center; text-align: center; box-shadow: 0 0 10px orange; cursor: pointer; }
        #uno-menu { display: none; position: fixed; bottom: 250px; left: 20px; background: rgba(0,0,0,0.9); padding: 10px; border-radius: 10px; z-index: 40000; flex-direction: column; width: 160px; border: 1px solid #e67e22; }
    </style>
</head>
<body>
    <div id="reconnect-overlay"><div class="loader"></div><div>Reconectando...</div></div>

    <div id="login" class="screen" style="display:flex;"><h1 style="font-size:60px; margin:0;">UNO y 1/2</h1><input id="my-name" type="text" placeholder="Tu Nombre" maxlength="15"><button id="btn-create" class="btn-main" onclick="showCreate()">Crear Sala</button><button id="btn-join-menu" class="btn-main" onclick="showJoin()" style="background:#2980b9">Unirse a Sala</button></div>
    <div id="join-menu" class="screen"><h1>Unirse</h1><input id="room-code" type="text" placeholder="Código" style="text-transform:uppercase;"><button class="btn-main" onclick="joinRoom()">Entrar</button><button class="btn-main" onclick="backToLogin()">Volver</button></div>
    <div id="lobby" class="screen">
        <button onclick="toggleManual()" style="position: absolute; top: 10px; right: 10px; background: #8e44ad; color: white; border: none; padding: 10px; border-radius: 5px; cursor: pointer;">📖 MANUAL</button>
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

    <div id="alert-zone"><div id="penalty-display">CASTIGO: +<span id="pen-num">0</span></div><div id="main-alert" class="alert-box"></div></div>

    <div id="action-bar">
        <div id="uno-btn-area">
            <button id="btn-sort" onclick="requestSort()">ORDENAR</button>
            <button id="btn-pass" class="btn-pass" onclick="pass()">PASAR</button>
            <button id="btn-ladder-play" onclick="submitLadder()">JUGAR SELECCIÓN</button>
        </div>
    </div>
    
    <div id="uno-main-btn" onclick="toggleUnoMenu()">UNO<br>y 1/2</div>
    <div id="uno-menu">
        <button class="btn-main" style="width:100%; font-size:14px; padding:10px; margin:2px; background:#e67e22;" onclick="sayUno()">📢 ANUNCIAR</button>
        <div id="report-list" style="width:100%;"></div>
        <button class="btn-main" style="width:100%; font-size:14px; padding:10px; margin:2px; background:#c0392b;" onclick="toggleUnoMenu()">CERRAR</button>
    </div>
    
    <div id="hand-zone"></div>
    
    <div id="chat-btn" onclick="toggleChat()">💬<div id="chat-badge">0</div></div>
    <div id="chat-win">
        <div id="chat-close" onclick="toggleChat()">X</div>
        <div id="chat-msgs" style="flex:1; overflow-y:auto; padding:10px; font-size:12px; color:#ddd;"></div>
        <div style="display:flex; border-top:1px solid #555;">
            <input id="chat-in" style="flex:1; border-radius:0; padding:10px; border:none; background:#333; color:white; font-size:14px;" placeholder="Mensaje..." onkeypress="if(event.key==='Enter') sendChat()">
            <button onclick="sendChat()" style="background:#2980b9; color:white; border:none; padding:0 15px; cursor:pointer;">></button>
        </div>
    </div>
    
    <div id="rules-btn" onclick="toggleRules()">❓</div>
    
    <div id="rules-modal">
        <div id="rules-close" onclick="toggleRules()">X</div>
        <h2 style="color:gold; text-align:center; border-bottom:1px solid #555; padding-bottom:10px;">Reglamento Rápido</h2>
        <p style="text-align:center; font-style:italic;">¡Mantén pulsada una carta para selección múltiple!</p>
        <div class="rule-row"><div class="rule-badge" style="background:#000; color:white; border-color:#666;">🪦</div><div class="rule-text"><b>RIP:</b> Duelo a muerte. Perdedor eliminado.</div></div>
        <div class="rule-row"><div class="rule-badge" style="background:white; color:red; border-color:gold;">❤️</div><div class="rule-text"><b>GRACIA:</b> Inmune a todo. Anula cartas negras.</div></div>
        <div class="rule-row"><div class="rule-badge" style="background:#000; color:white;">🕊️</div><div class="rule-text"><b>LIBRE:</b> Defiende de +2/+4/+12. Regala 1, Descarta 1, Cambia Color.</div></div>
        <div class="rule-row"><div class="rule-badge" style="background:#000; color:purple;">SS</div><div class="rule-text"><b>SALTEO SUPREMO:</b> Rival pierde 4 turnos y roba 4 cartas.</div></div>
        <div class="rule-row"><div class="rule-badge" style="background:#e67e22;">📢</div><div class="rule-text"><b>UNO y 1/2:</b> Grita si te queda 1 carta. Si te denuncian tras 2s, +2 cartas.</div></div>
    </div>

    <div id="manual-modal">
        <div id="manual-close" onclick="toggleManual()">X</div>
        <h2 style="color:gold; text-align:center;">MANUAL DE JUEGO</h2>
        
        <div style="padding:0 10px;">
            <h3>1. OBJETIVO</h3>
            <p>Quedarte sin cartas antes que nadie. Debes ir descartando tu mano en la pila central.</p>
            <p>🃏 <b>El Mazo:</b> Contiene +100 cartas, incluyendo colores (Rojo, Azul, Verde, Amarillo) y cartas Negras (Especiales). Si se acaba, ¡se regenera automáticamente!</p>

            <hr style="border-color:#555;">

            <h3>2. JUGADAS BÁSICAS</h3>
            <p>En tu turno, puedes tirar una carta si coincide en <b>COLOR</b> o <b>NÚMERO</b> con la carta de la mesa.</p>
            <div class="man-example">
                <p>Mesa: <span class="man-card" style="background:#ff5252">5</span></p>
                <span class="man-arrow">⬇️</span>
                <p>Puedes tirar: <span class="man-card" style="background:#ff5252">8</span> (Color) o <span class="man-card" style="background:#448aff">5</span> (Número)</p>
            </div>

            <hr style="border-color:#555;">

            <h3>3. JUGADAS MAESTRAS (MODO SELECCIÓN)</h3>
            <p>🖐️ <b>Pulsación Larga:</b> Mantén apretada una carta para activar el "Modo Selección" y elegir varias cartas.</p>

            <h4>A) Escaleras (3+ cartas)</h4>
            <p>Si tienes una secuencia de números del <b>MISMO COLOR</b>, ¡tírala toda junta!</p>
            <div class="man-example">
                <span class="man-card" style="background:#69f0ae">3</span>
                <span class="man-card" style="background:#69f0ae">4</span>
                <span class="man-card" style="background:#69f0ae">5</span>
                <p><i>¡Ascendente o Descendente!</i></p>
            </div>
            <p>💡 <b>Escalera Integrada:</b> Si en la mesa hay un <span class="man-card" style="background:#69f0ae">3</span>, puedes tirar un <span class="man-card" style="background:#69f0ae">4</span> y un <span class="man-card" style="background:#69f0ae">5</span> de tu mano.</p>

            <h4>B) El Combo Matemático (1½)</h4>
            <p>La carta "1 y 1/2" vale 1.5. Dos de estas suman 3. Puedes tirarlas juntas SOLO sobre un 3.</p>
            <div class="man-example">
                <p>Mesa: <span class="man-card" style="background:#448aff">3</span></p>
                <span class="man-arrow">⬇️</span>
                <span class="man-card" style="background:#448aff; font-size:10px">1½</span> + 
                <span class="man-card" style="background:#448aff; font-size:10px">1½</span>
            </div>

            <hr style="border-color:#555;">

            <h3>4. SAFF (ROBO DE TURNO)</h3>
            <p>Si tienes una carta <b>IDÉNTICA</b> (mismo número y color) a la de la mesa, ¡tírala aunque no sea tu turno!</p>
            <div class="man-example">
                <p>Mesa: <span class="man-card" style="background:#ffd740; color:black">7</span></p>
                <p>Tu mano: <span class="man-card" style="background:#ffd740; color:black">7</span> ¡TÍRALA YA!</p>
            </div>
            <p><i>Le robarás el turno a quien le tocaba.</i></p>

            <hr style="border-color:#555;">

            <h3>5. CARTAS DE ATAQUE</h3>
            <p>💥 <b>+2, +4, +12:</b> Hacen que el siguiente jugador robe esa cantidad. ¡Se acumulan!</p>
            <p>🚫 <b>X (Salto):</b> El siguiente pierde el turno.</p>
            <p>🔄 <b>R (Reversa):</b> Cambia el sentido de la ronda.</p>
            <p>👑 <b>SS (Salteo Supremo):</b> Carta negra. El siguiente pierde 4 turnos y roba 4 cartas.</p>

            <hr style="border-color:#555;">

            <h3>6. CARTAS SUPREMAS</h3>
            <div style="display:flex; align-items:center; margin-bottom:10px;">
                <span class="man-card" style="background:black; border-color:#666">🪦</span>
                <div style="margin-left:10px;"><b>RIP:</b> Retas a un <b>Duelo a Muerte</b> (Piedra, Papel o Tijera elemental) al siguiente jugador. El que pierde queda <b>ELIMINADO</b> de la ronda.</div>
            </div>
            <div style="display:flex; align-items:center; margin-bottom:10px;">
                <span class="man-card" style="background:white; color:red; border-color:gold">❤️</span>
                <div style="margin-left:10px;"><b>GRACIA DIVINA:</b> La carta más poderosa. Te salva de TODO (+12, RIP, SS). También sirve para revivir a un muerto o como comodín.</div>
            </div>
            <div style="display:flex; align-items:center; margin-bottom:10px;">
                <span class="man-card" style="background:black">🕊️</span>
                <div style="margin-left:10px;"><b>LIBRE ALBEDRÍO:</b> Te defiende de robos (+2/+4/+12). Te permite regalar 1 carta a otro jugador y descartar 1 carta de tu mano.</div>
            </div>

            <hr style="border-color:#555;">

            <h3>7. BOTÓN UNO Y 1/2</h3>
            <p>Cuando te quede <b>1 sola carta</b>, ¡toca el botón naranja RÁPIDO! 📢</p>
            <p>Si pasan 2 segundos y no lo dijiste, cualquiera te puede <b>DENUNCIAR</b> y comerás +2 cartas.</p>

            <hr style="border-color:#555;">
            
            <h3>8. DUELOS DE CASTIGO</h3>
            <p>Si te tiran un <b>+12</b> o un <b>Salteo Supremo</b>, puedes aceptar el castigo o... ¡Batirte a Duelo! ⚔️</p>
            <ul>
                <li><b>Si ganas:</b> Devuelves el castigo (el agresor come 4 cartas).</li>
                <li><b>Si pierdes:</b> El castigo aumenta (+16 cartas o peor).</li>
            </ul>
        </div>
        <br><br>
    </div>

    <div id="game-over-screen" class="screen"><h1 style="color:gold;">VICTORIA</h1><h2 id="winner-name"></h2></div>
    
    <div id="rip-screen" class="screen">
        <h1 style="color:red;" id="rip-title">💀 RIP 💀</h1>
        <h3 id="rip-msg-custom" style="text-align:center; padding:10px;"></h3>
        <button id="btn-accept-penalty" onclick="ripResp('accept_penalty')" class="btn-main" style="background:#34495e; display:none;">ACEPTAR CASTIGO</button>
        <button id="btn-duel-start" onclick="ripResp('duel')" class="btn-main" style="background:red; border:3px solid gold;">BATIRSE A DUELO</button>
        <button id="btn-surrender" onclick="ripResp('surrender')" class="btn-main">RENDIRSE</button>
        <p id="duel-warning" style="font-size:12px; color:#aaa; display:none;">Nota: batirse a duelo y perder implicará una penalidad extra para ti.</p>
        <div id="grace-btn" style="display:none;"><button onclick="graceDef()" class="btn-main" style="background:white; color:red;">USAR GRACIA</button></div>
    </div>

    <div id="duel-screen" class="screen"><h1 style="color:gold;">⚔️ DUELO ⚔️</h1><h3 id="duel-narrative">Cargando duelo...</h3><h2 id="duel-names">... vs ...</h2><h3 id="duel-sc">0 - 0</h3><p id="duel-turn-msg"></p><div id="duel-opts"><button id="btn-fuego" class="duel-btn" onclick="pick('fuego')">🔥</button><button id="btn-hielo" class="duel-btn" onclick="pick('hielo')">❄️</button><button id="btn-agua" class="duel-btn" onclick="pick('agua')">💧</button></div></div>
    
    <div id="color-picker"><h3>Elige Color</h3><div class="color-circle" style="background:#ff5252;" onclick="pickCol('rojo')"></div><div class="color-circle" style="background:#448aff;" onclick="pickCol('azul')"></div><div class="color-circle" style="background:#69f0ae;" onclick="pickCol('verde')"></div><div class="color-circle" style="background:#ffd740;" onclick="pickCol('amarillo')"></div></div>
    <div id="revive-screen"><h2 style="color:gold;">¿A QUIÉN REVIVES?</h2><div id="zombie-list"></div></div><div id="revival-overlay"><div id="revival-text"></div></div>
    
    <div id="revive-confirm-screen">
        <h2 style="color:gold;">¿RESUCITAR A <span id="revive-name"></span>?</h2>
        <button class="btn-main" onclick="confirmRevive(true)">SÍ, REVIVIR</button>
        <button class="btn-main" onclick="confirmRevive(false)" style="background:#e74c3c">NO</button>
    </div>

    <div id="countdown" style="display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.8); z-index:6000; justify-content:center; align-items:center; font-size:120px; color:gold;">3</div>

    <div id="libre-modal">
        <div id="step-1" class="libre-step active">
            <h2>Paso 1: ¿A quién regalas una carta?</h2>
            <div id="libre-targets"></div>
        </div>
        <div id="step-2" class="libre-step">
            <h2>Paso 2: Elige la carta para regalar</h2>
            <div id="libre-gift-hand"></div>
        </div>
        <div id="step-3" class="libre-step">
            <h2>Paso 3: Elige 1 carta para descartar</h2>
            <div id="libre-discard-hand"></div>
        </div>
        <div id="step-color" class="libre-step">
            <h2>Paso 4: Elige Color Final</h2>
            <div class="color-circle" style="background:#ff5252;" onclick="finishLibre('rojo')"></div>
            <div class="color-circle" style="background:#448aff;" onclick="finishLibre('azul')"></div>
            <div class="color-circle" style="background:#69f0ae;" onclick="finishLibre('verde')"></div>
            <div class="color-circle" style="background:#ffd740;" onclick="finishLibre('amarillo')"></div>
        </div>
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

        if (!myUUID) { myUUID = Math.random().toString(36).substring(2) + Date.now().toString(36); localStorage.setItem('uno_uuid', myUUID); }
        const urlParams = new URLSearchParams(window.location.search);
        const inviteCode = urlParams.get('room');
        if (inviteCode) { document.getElementById('room-code').value = inviteCode; document.getElementById('btn-create').style.display = 'none'; document.getElementById('btn-join-menu').innerText = "ENTRAR A SALA " + inviteCode; document.getElementById('btn-join-menu').onclick = joinRoom; }
        
        socket.on('connect', () => { 
            document.getElementById('reconnect-overlay').style.display = 'none';
            myId = socket.id; 
            socket.emit('checkSession', myUUID); 
        });
        
        socket.on('disconnect', () => { document.getElementById('reconnect-overlay').style.display = 'flex'; });
        socket.on('sessionRestored', (data) => { });
        socket.on('requireLogin', () => { document.getElementById('reconnect-overlay').style.display = 'none'; changeScreen('login'); });
        
        let libreState = { active: false, cardId: null, targetId: null, giftId: null, discardId: null };
        
        function startLibreLogic(cardId) {
            if(myHand.length < 3) return; 
            document.getElementById('action-bar').style.display = 'none';
            libreState = { active: true, cardId: cardId, targetId: null, giftId: null, discardId: null };
            document.getElementById('libre-modal').style.display = 'flex'; showLibreStep(1);
            const div = document.getElementById('libre-targets'); div.innerHTML = '';
            currentPlayers.forEach(p => {
                if(p.id !== myId && !p.isSpectator && !p.isDead) {
                    const b = document.createElement('button'); b.className = 'btn-main'; b.innerText = p.name;
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
                    if(c.color === 'negro') { showLibreStep('color'); } else { finishLibre(null); }
                };
                pool.appendChild(b);
            });
        }
        
        function finishLibre(color) {
            document.getElementById('libre-modal').style.display = 'none';
            if(document.body.classList.contains('playing-state')) document.getElementById('action-bar').style.display = 'flex';
            socket.emit('playLibreAlbedrio', { cardId: libreState.cardId, targetPlayerId: libreState.targetId, giftCardId: libreState.giftId, discardId: libreState.discardId, chosenColor: color });
            libreState = { active: false };
        }
        function showLibreStep(n) { document.querySelectorAll('.libre-step').forEach(el => el.classList.remove('active')); if(n==='color') document.getElementById('step-color').classList.add('active'); else document.getElementById('step-'+n).classList.add('active'); }
        
        function getCardText(c) {
             if(c.value==='RIP') return '🪦';
             if(c.value==='GRACIA') return '❤️';
             if(c.value==='LIBRE') return '🕊️';
             if(c.value==='SALTEO SUPREMO') return 'SS';
             return c.value;
        }

        function getBgColor(c) { 
            const map = { 'rojo': '#ff5252', 'azul': '#448aff', 'verde': '#69f0ae', 'amarillo': '#ffd740', 'negro': '#212121' }; 
            if(c.value==='RIP') return 'black'; 
            if(c.value==='GRACIA') return 'white'; 
            if(c.value==='+12') return '#000000';
            if(c.value==='LIBRE') return '#000'; 
            if(c.value==='SALTEO SUPREMO') return '#2c3e50';
            return map[c.color] || '#444'; 
        }

        function showCreate() { const name = document.getElementById('my-name').value.trim(); if(name) socket.emit('createRoom', { name, uuid: myUUID }); }
        function showJoin() { changeScreen('join-menu'); }
        function backToLogin() { changeScreen('login'); }
        function joinRoom() { const name = document.getElementById('my-name').value.trim(); const code = document.getElementById('room-code').value.trim(); if(name && code) socket.emit('joinRoom', { name, uuid: myUUID, roomId: code }); }
        
        function copyLink() { 
            const code = document.getElementById('lobby-code').innerText;
            const url = window.location.origin + '/?room=' + code;
            if(navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(url).then(() => { alert('¡Link copiado!'); }).catch(err => { prompt("Copia:", url); }); } 
            else { prompt("Copia:", url); }
        }

        function kick(id) { if(confirm('Echar?')) socket.emit('kickPlayer', id); }

        socket.on('roomCreated', (d) => { changeScreen('lobby'); document.getElementById('lobby-code').innerText = d.roomId; });
        socket.on('roomJoined', (d) => { changeScreen('lobby'); document.getElementById('lobby-code').innerText = d.roomId; });
        socket.on('updateState', s => {
            currentPlayers = s.players;
            const me = s.players.find(p=>p.id===myId);
            const amITurning = me && me.isTurn;
            
            if(!amITurning && (ladderMode || document.getElementById('libre-modal').style.display === 'flex')) {
                 ladderMode = false; ladderSelected = [];
                 document.getElementById('btn-ladder-play').style.display = 'none';
                 document.querySelectorAll('.hand-card').forEach(c => c.classList.remove('selected-ladder'));
                 document.getElementById('libre-modal').style.display = 'none';
                 libreState = { active: false };
            }

            if(s.state === 'waiting') {
                // Se usan comillas simples dentro del HTML string para evitar romper el template string del servidor
                const list = s.players.map(p => '<div class="lobby-row"><div class="lobby-name">' + (p.isConnected?'🟢':'🔴') + ' ' + p.name + '</div>' + (s.iamAdmin&&p.id!==myId?('<button class="kick-btn" onclick="kick(\\''+p.id+'\\')">X</button>'):'') + '</div>').join('');
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
                 document.getElementById('game-area').style.display = 'flex';
                 document.getElementById('hand-zone').style.display = 'flex';
                 document.getElementById('uno-main-btn').style.display = 'flex';
                 
                 if(document.getElementById('libre-modal').style.display !== 'flex') {
                    document.getElementById('action-bar').style.display = 'flex';
                 }
                 document.getElementById('chat-btn').style.display = 'flex';
                 document.getElementById('rules-btn').style.display = 'flex';
                 document.getElementById('duel-screen').style.display = 'none';
                 document.getElementById('rip-screen').style.display = 'none';
                 
                 // UNO Report logic
                 const reportList = document.getElementById('report-list');
                 reportList.innerHTML = '';
                 if(s.reportTargets && s.reportTargets.length > 0) {
                     s.reportTargets.forEach(tid => {
                         const p = s.players.find(x=>x.id===tid);
                         // Se usan comillas simples y concatenación para evitar error de sintaxis en el servidor
                         if(p) reportList.innerHTML += '<button class="btn-main" style="width:100%;font-size:12px;background:red;margin:2px;" onclick="socket.emit(\\'reportUno\\',\\''+tid+'\\')">DENUNCIAR A ' + p.name.toUpperCase() + '</button>';
                     });
                 }
            } 
            else if (s.state === 'rip_decision' || s.state === 'penalty_decision') {
                changeScreen('game-area'); forceCloseChat();
                document.body.classList.add('state-rip');
                if(s.duelInfo.defenderId === myId) { 
                    document.getElementById('rip-screen').style.display = 'flex'; 
                    document.getElementById('duel-screen').style.display = 'none'; 
                    
                    const msgDiv = document.getElementById('rip-msg-custom');
                    const duelWarn = document.getElementById('duel-warning');
                    const btnAccept = document.getElementById('btn-accept-penalty');
                    const btnSurrender = document.getElementById('btn-surrender');
                    const btnDuel = document.getElementById('btn-duel-start');
                    
                    if (s.state === 'rip_decision') {
                        document.getElementById('rip-title').innerText = "💀 RIP 💀";
                        msgDiv.innerText = s.duelInfo.attackerName + " te retó a Duelo usando la carta RIP.";
                        duelWarn.style.display = 'none';
                        btnAccept.style.display = 'none';
                        btnSurrender.style.display = 'inline-block';
                        btnDuel.style.display = 'inline-block';
                    } else {
                        document.getElementById('rip-title').innerText = "⚠️ CASTIGO ⚠️";
                        msgDiv.innerText = "Has recibido un castigo de " + s.duelInfo.attackerName + ".";
                        duelWarn.style.display = 'block';
                        btnAccept.style.display = 'inline-block'; 
                        btnSurrender.style.display = 'none';
                        btnDuel.style.display = 'inline-block';
                    }
                } 
                else { 
                    document.getElementById('rip-screen').style.display = 'none'; document.getElementById('duel-screen').style.display = 'flex'; 
                    document.getElementById('duel-narrative').innerText = s.duelInfo.narrative || "Esperando respuesta del desafiado..."; 
                    document.getElementById('duel-names').innerText = s.duelInfo.attackerName + ' vs ' + s.duelInfo.defenderName; 
                    document.getElementById('duel-opts').style.display = 'none'; 
                }
            }
            else if (s.state === 'dueling') {
                changeScreen('game-area'); forceCloseChat();
                document.body.classList.add('state-dueling');
                document.getElementById('rip-screen').style.display = 'none';
                document.getElementById('duel-screen').style.display = 'flex';
                document.getElementById('duel-narrative').innerText = s.duelInfo.narrative || "...";
                document.getElementById('duel-names').innerText = s.duelInfo.attackerName + ' vs ' + s.duelInfo.defenderName;
                document.getElementById('duel-sc').innerText = s.duelInfo.scoreAttacker + ' - ' + s.duelInfo.scoreDefender;
                const amFighter = (myId === s.duelInfo.attackerId || myId === s.duelInfo.defenderId);
                document.getElementById('duel-opts').style.display = amFighter ? 'block' : 'none';
                if(amFighter) {
                    const isTurn = s.duelInfo.turn === myId;
                    document.getElementById('duel-turn-msg').innerText = isTurn ? "¡TU TURNO! Elige..." : "Esperando al oponente...";
                    document.querySelectorAll('.duel-btn').forEach(b => b.disabled = !isTurn);
                    if(s.duelInfo.myChoice) { document.getElementById('btn-' + s.duelInfo.myChoice).className = 'duel-btn selected'; }
                    else { document.querySelectorAll('.duel-btn').forEach(b => b.classList.remove('selected')); }
                } else { document.getElementById('duel-turn-msg').innerText = ""; }
            }

            if(s.state === 'playing') {
                document.getElementById('players-zone').innerHTML = s.players.map(p => '<div class="player-badge ' + (p.isTurn?'is-turn':'') + ' ' + (p.isDead?'is-dead':'') + '">' + (p.isConnected?'':'🔴') + ' ' + p.name + ' (' + p.cardCount + ') ' + (p.isDead?'💀':'') + '</div>').join('');
                if(s.topCard) {
                    const tc = s.topCard; const el = document.getElementById('top-card');
                    el.style.backgroundColor = getBgColor(tc); el.style.border = (tc.value==='RIP'?'3px solid #666':(tc.value==='GRACIA'?'3px solid gold':'3px solid white'));
                    el.innerText = getCardText(tc);
                    if(tc.value === '1 y 1/2') { el.style.fontSize = '20px'; el.style.padding = '0 5px'; } 
                    else { el.style.fontSize = '24px'; el.style.padding = '0'; }
                }
                document.getElementById('btn-pass').style.display = (me && me.isTurn && me.hasDrawn && s.pendingPenalty===0) ? 'inline-block' : 'none';
                if(me && me.isTurn && s.pendingPenalty>0) { document.getElementById('penalty-display').style.display='block'; document.getElementById('pen-num').innerText=s.pendingPenalty; } else document.getElementById('penalty-display').style.display='none';
            }
        });

        socket.on('handUpdate', h => {
            myHand = h;
            renderHand(); 
        });
        
        function requestSort() {
            socket.emit('requestSort');
        }

        function renderHand() {
            if(document.body.classList.contains('state-dueling') || document.body.classList.contains('state-rip')) return;
            const hz = document.getElementById('hand-zone'); hz.innerHTML = '';
            
            let displayHand = myHand; 

            const hasGrace = myHand.some(c=>c.value==='GRACIA');
            document.getElementById('grace-btn').style.display = hasGrace ? 'block':'none';
            
            displayHand.forEach(c => {
                const d = document.createElement('div'); d.className = 'hand-card';
                if(ladderSelected.includes(c.id)) d.classList.add('selected-ladder');
                d.style.backgroundColor = getBgColor(c); 
                d.style.color = (c.color==='amarillo'||c.color==='verde')?'black':'white';
                d.innerText = getCardText(c);
                
                if(c.value === '1 y 1/2') { d.style.fontSize = '16px'; d.style.padding = '0 5px'; }
                
                d.onmousedown = d.ontouchstart = (e) => {
                    pressTimer = setTimeout(() => {
                        if(!ladderMode) {
                            ladderMode = true;
                            if(navigator.vibrate) navigator.vibrate(50);
                            toggleLadderSelection(c, d);
                        }
                    }, 800);
                };
                d.onmouseup = d.onmouseleave = d.ontouchend = () => clearTimeout(pressTimer);
                
                d.onclick = () => {
                    if(ladderMode) {
                        toggleLadderSelection(c, d);
                    } else {
                        handleCardClick(c);
                    }
                };
                hz.appendChild(d);
            });
        }
        
        function toggleLadderSelection(c, d) {
            if(ladderSelected.includes(c.id)) { 
                ladderSelected = ladderSelected.filter(id => id !== c.id); 
                d.classList.remove('selected-ladder'); 
                if(ladderSelected.length === 0) ladderMode = false;
            } 
            else { 
                ladderSelected.push(c.id); 
                d.classList.add('selected-ladder'); 
            }
            document.getElementById('btn-ladder-play').style.display = (ladderSelected.length >= 2) ? 'block' : 'none';
        }

        function handleCardClick(c) {
            if(document.getElementById('color-picker').style.display === 'block') return;
            if(c.value === 'LIBRE') { socket.emit('playCard', c.id, null, null); return; }
            
            if(c.value === 'GRACIA') {
                const hasZombies = currentPlayers.some(p => p.isDead);
                const hasPenalty = (document.getElementById('penalty-display').style.display === 'block');
                if(!hasZombies && !hasPenalty) {
                     if(confirm("⚠️ ¿Usar Gracia como cambio de color normal?")) {
                         pendingCard = c.id; 
                         pendingColorForRevive = null; 
                         pendingGrace = false; 
                         document.getElementById('color-picker').style.display='block';
                         return;
                     } else { return; }
                }
            }

            if(c.color==='negro' && c.value!=='GRACIA') { 
                if(c.value==='RIP' || c.value==='SALTEO SUPREMO' || c.value==='+12') {
                    if(c.value==='RIP') {
                         socket.emit('playCard', c.id, null, null);
                    } else {
                         pendingCard=c.id; document.getElementById('color-picker').style.display='block'; 
                    }
                } else { 
                    pendingCard=c.id; document.getElementById('color-picker').style.display='block'; 
                } 
            } 
            else socket.emit('playCard', c.id, null, null);
        }

        function submitLadder() { if(ladderSelected.length < 2) return; socket.emit('playMultiCards', ladderSelected); ladderMode = false; ladderSelected = []; }

        function changeScreen(id) { 
            document.querySelectorAll('.screen').forEach(s=>s.style.display='none'); 
            document.getElementById('game-area').style.display='none'; 
            document.getElementById('action-bar').style.display='none'; 
            document.getElementById('chat-btn').style.display='none'; 
            document.getElementById('rules-btn').style.display='none'; 
            document.getElementById('uno-main-btn').style.display='none';
            document.getElementById(id).style.display='flex'; 
        }
        function start(){ socket.emit('requestStart'); }
        function draw(){ socket.emit('draw'); }
        function pass(){ socket.emit('passTurn'); }
        function sayUno(){ socket.emit('sayUno'); toggleUnoMenu(); }
        function toggleUnoMenu() { const m = document.getElementById('uno-menu'); m.style.display = (m.style.display==='flex'?'none':'flex'); }
        function sendChat(){ const i=document.getElementById('chat-in'); if(i.value){ socket.emit('sendChat',i.value); i.value=''; }}
        function toggleChat(){ const w = document.getElementById('chat-win'); if(isChatOpen) { w.style.display = 'none'; isChatOpen = false; } else { w.style.display = 'flex'; isChatOpen = true; unreadCount = 0; document.getElementById('chat-badge').style.display = 'none'; document.getElementById('chat-badge').innerText = '0'; } }
        function forceCloseChat() { const w = document.getElementById('chat-win'); w.style.display = 'none'; isChatOpen = false; document.getElementById('rules-modal').style.display='none'; document.getElementById('manual-modal').style.display='none'; }
        function toggleRules() { const r = document.getElementById('rules-modal'); r.style.display = (r.style.display === 'flex') ? 'none' : 'flex'; }
        function toggleManual() { const r = document.getElementById('manual-modal'); r.style.display = (r.style.display === 'flex') ? 'none' : 'flex'; }

        function pickCol(c){ 
            document.getElementById('color-picker').style.display='none'; 
            pendingColorForRevive = c; 
            if(pendingGrace) socket.emit('playGraceDefense',c); 
            else socket.emit('playCard',pendingCard,c,null); 
        }
        function ripResp(d){ socket.emit('ripDecision',d); }
        function pick(c){ socket.emit('duelPick',c); }
        function graceDef(){ pendingGrace=true; document.getElementById('color-picker').style.display='block'; }
        
        let pendingReviveCardId = null;
        socket.on('askReviveConfirmation', (data) => {
            pendingReviveCardId = data.cardId;
            document.getElementById('revive-name').innerText = data.name;
            document.getElementById('revive-confirm-screen').style.display = 'block';
        });
        function confirmRevive(confirmed) {
            document.getElementById('revive-confirm-screen').style.display = 'none';
            if(pendingReviveCardId) {
                socket.emit('confirmReviveSingle', { cardId: pendingReviveCardId, confirmed: confirmed, chosenColor: pendingColorForRevive });
            } 
            pendingReviveCardId = null;
        }

        socket.on('animateLibre', (data) => {
            const alertBox = document.getElementById('main-alert');
            alertBox.innerText = '🕊️ ' + data.playerName + ' descartó 1 carta';
            alertBox.style.display = 'block';
            
            const topEl = document.getElementById('top-card');
            if(data.cards.length > 0) {
                const c = data.cards[0];
                topEl.style.transition = "transform 0.2s";
                topEl.style.transform = "scale(1.2)";
                topEl.style.backgroundColor = getBgColor(c);
                topEl.style.border = (c.value==='RIP'?'3px solid #666':(c.value==='GRACIA'?'3px solid gold':'3px solid white'));
                topEl.innerText = getCardText(c);
                setTimeout(() => { topEl.style.transform = "scale(1)"; }, 200);
            }
            setTimeout(() => alertBox.style.display = 'none', 1500);
        });

        socket.on('countdownTick',n=>{ changeScreen('game-area'); document.getElementById('countdown').style.display=n>0?'flex':'none'; document.getElementById('countdown').innerText=n; });
        socket.on('playSound',k=>{const a=new Audio({soft:'https://cdn.freesound.org/previews/240/240776_4107740-lq.mp3',attack:'https://cdn.freesound.org/previews/155/155235_2452367-lq.mp3',rip:'https://cdn.freesound.org/previews/173/173930_2394245-lq.mp3',divine:'https://cdn.freesound.org/previews/242/242501_4414128-lq.mp3',uno:'https://cdn.freesound.org/previews/415/415209_5121236-lq.mp3',start:'https://cdn.freesound.org/previews/320/320655_5260872-lq.mp3',win:'https://cdn.freesound.org/previews/270/270402_5123851-lq.mp3',bell:'https://cdn.freesound.org/previews/336/336899_4939433-lq.mp3',wild:'https://cdn.freesound.org/previews/320/320653_5260872-lq.mp3',saff:'https://cdn.freesound.org/previews/614/614742_11430489-lq.mp3'}[k]); a.volume=0.3; a.play().catch(()=>{});});
        
        socket.on('notification',m=>{const b=document.getElementById('main-alert'); b.innerText=m; b.style.display='block'; setTimeout(()=>b.style.display='none',4000);});
        socket.on('showDivine',m=>{const b=document.getElementById('main-alert'); b.innerText=m; b.style.display='block'; b.style.background='white'; b.style.color='gold'; setTimeout(()=>{b.style.display='none'; b.style.background='rgba(0,0,0,0.95)'; b.style.color='white';},4000);});
        socket.on('cardPlayedEffect', d => { if(d.color) document.body.className = 'bg-' + d.color; });
        
        socket.on('chatMessage', m => { const b = document.getElementById('chat-msgs'); b.innerHTML += '<div><b style="color:gold">' + m.name + ':</b> ' + m.text + '</div>'; b.scrollTop = b.scrollHeight; if(!isChatOpen) { unreadCount++; const badge = document.getElementById('chat-badge'); badge.style.display = 'flex'; badge.innerText = unreadCount > 9 ? '9+' : unreadCount; } });
        socket.on('chatHistory',h=>{const b=document.getElementById('chat-msgs'); b.innerHTML=''; h.forEach(m=>b.innerHTML+='<div><b style="color:gold">' + m.name + ':</b> ' + m.text + '</div>'); b.scrollTop=b.scrollHeight;});
        
        socket.on('gameOver',d=>{
            document.getElementById('action-bar').style.display = 'none';
            document.getElementById('chat-btn').style.display = 'none';
            document.getElementById('rules-btn').style.display = 'none';
            document.getElementById('uno-main-btn').style.display='none';
            document.getElementById('game-over-screen').style.display='flex'; 
            document.getElementById('winner-name').innerText=d.winner; 
            setTimeout(()=>{localStorage.removeItem('uno_uuid'); window.location=window.location.origin;},5000);
        });
        
        socket.on('askReviveTarget',z=>{const l=document.getElementById('zombie-list'); l.innerHTML=''; z.forEach(x=>{const b=document.createElement('button'); b.className='zombie-btn'; b.innerHTML=x.name + '<br><small>(' + x.count + ')</small>'; b.onclick=()=>{document.getElementById('revive-screen').style.display='none'; socket.emit('playCard',pendingCard,pendingColorForRevive,x.id);}; l.appendChild(b);}); document.getElementById('revive-screen').style.display='block';});
        socket.on('playerRevived',d=>{ const o=document.getElementById('revival-overlay'); document.getElementById('revival-text').innerHTML='✨<br>' + d.revived + ' fue resucitado por gracia divina de ' + d.savior + '<br>✨'; o.style.display='flex'; setTimeout(()=>o.style.display='none',4000);});
    </script>
</body>
</html>
    `;
    res.send(htmlContent);
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
