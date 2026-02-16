const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

// --- CONFIGURACIÓN ---
const rooms = {}; 
const ladderOrder = ['0', '1', '1 y 1/2', '2', '3', '4', '5', '6', '7', '8', '9'];

// Limpieza automática
setInterval(() => {
    const now = Date.now();
    Object.keys(rooms).forEach(roomId => {
        if (now - rooms[roomId].lastActivity > 3600000) delete rooms[roomId];
    });
}, 60000 * 5); 

const colors = ['rojo', 'azul', 'verde', 'amarillo'];
const values = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '1 y 1/2', '+2', 'X', 'R'];

// --- LÓGICA DEL SERVIDOR ---

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
        duelState: { 
            attackerId: null, defenderId: null, attackerName: '', defenderName: '', 
            round: 1, scoreAttacker: 0, scoreDefender: 0, 
            attackerChoice: null, defenderChoice: null, history: [], turn: null, narrative: '' 
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
    
    for(let k=0; k<5; k++) {
        room.deck.push({ color: 'negro', value: 'LIBRE', type: 'special', id: Math.random().toString(36) });
    }
    
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
        for (const rId in rooms) { const p = rooms[rId].players.find(pl => pl.uuid === uuid); if (p) { foundRoomId = rId; foundPlayer = p; break; } }
        if (foundRoomId && foundPlayer) {
            foundPlayer.id = socket.id; foundPlayer.isConnected = true;
            socket.join(foundRoomId); touchRoom(foundRoomId);
            socket.emit('sessionRestored', { roomId: foundRoomId, name: foundPlayer.name });
            updateAll(foundRoomId);
        } else { socket.emit('requireLogin'); }
    });

    socket.on('createRoom', (data) => {
        const roomId = Math.random().toString(36).substring(2, 6).toUpperCase(); initRoom(roomId);
        const player = { id: socket.id, uuid: data.uuid, name: data.name.substring(0, 15), hand: [], hasDrawn: false, isSpectator: false, isDead: false, isAdmin: true, isConnected: true };
        rooms[roomId].players.push(player); socket.join(roomId); socket.emit('roomCreated', { roomId, name: data.name }); updateAll(roomId);
    });

    socket.on('joinRoom', (data) => {
        const roomId = data.roomId.toUpperCase(); const room = rooms[roomId];
        if (!room) { socket.emit('error', 'Sala no encontrada.'); return; }
        touchRoom(roomId);
        const existing = room.players.find(p => p.uuid === data.uuid);
        if (existing) { existing.id = socket.id; existing.name = data.name; existing.isConnected = true; socket.join(roomId); socket.emit('roomJoined', { roomId }); }
        else {
            const player = { id: socket.id, uuid: data.uuid, name: data.name, hand: [], hasDrawn: false, isSpectator: (room.gameState !== 'waiting'), isDead: false, isAdmin: (room.players.length === 0), isConnected: true };
            room.players.push(player); socket.join(roomId); socket.emit('roomJoined', { roomId });
            io.to(roomId).emit('notification', `👋 ${player.name} entró.`);
        }
        updateAll(roomId);
    });

    socket.on('requestStart', () => {
        const roomId = getRoomId(socket); if(!roomId || !rooms[roomId]) return;
        const room = rooms[roomId]; if (room.gameState === 'waiting' && room.players.length >= 2) startCountdown(roomId);
    });

    // --- LÓGICA DE JUGADA MÚLTIPLE (ESCALERA O COMBO 1.5) ---
    socket.on('playMultiCards', (cardIds) => {
        const roomId = getRoomId(socket); if(!roomId || !rooms[roomId]) return; touchRoom(roomId);
        const room = rooms[roomId];
        const pIndex = room.players.findIndex(p => p.id === socket.id);
        const player = room.players[pIndex];
        
        if (room.gameState !== 'playing' || pIndex !== room.currentTurn || room.pendingPenalty > 0) return;
        if (!cardIds || cardIds.length < 2) return; 

        let playCards = [];
        let tempHand = [...player.hand];
        for(let id of cardIds) {
            const c = tempHand.find(x => x.id === id);
            if(!c) return; 
            playCards.push(c);
        }
        const top = room.discardPile[room.discardPile.length - 1];

        // --- CASO 1: COMBO "1 Y 1/2" (Exactamente 2 cartas) ---
        if (playCards.length === 2) {
            const c1 = playCards[0];
            const c2 = playCards[1];

            // EXCLUSIVIDAD: Ambas deben ser '1 y 1/2'
            if (c1.value !== '1 y 1/2' || c2.value !== '1 y 1/2') {
                 // Si no son 1.5, intentamos validar como escalera
                 socket.emit('notification', '🚫 Para jugar 2 cartas, deben ser Escalera (3+) o dos "1 y 1/2".');
                 return;
            }
            if (c1.color !== c2.color) { socket.emit('notification', '🚫 Las dos "1 y 1/2" deben ser del mismo color.'); return; }
            if (top.value !== '3') { socket.emit('notification', '🚫 El combo de "1 y 1/2" solo se puede tirar sobre un 3.'); return; }

            // JUGADA VÁLIDA
            cardIds.forEach(id => {
                const idx = player.hand.findIndex(c => c.id === id);
                if(idx !== -1) player.hand.splice(idx, 1);
            });
            room.discardPile.push(...playCards);
            room.activeColor = c1.color; 
            io.to(roomId).emit('notification', `✨ ¡COMBO MATEMÁTICO! (1.5 + 1.5 = 3)`);
            io.to(roomId).emit('playSound', 'divine'); 

        } 
        // --- CASO 2: ESCALERA (3 o más cartas) ---
        else {
            const firstColor = playCards[0].color;
            if(firstColor === 'negro') { socket.emit('notification', '🚫 Escaleras solo con cartas de color.'); return; }
            if(!playCards.every(c => c.color === firstColor)) { socket.emit('notification', '🚫 Todas deben ser del mismo color.'); return; }

            const indices = playCards.map(c => ladderOrder.indexOf(c.value));
            if(indices.includes(-1)) { socket.emit('notification', '🚫 Solo números (0-9) y 1y1/2.'); return; }

            const sortedIndices = [...indices].sort((a,b) => a-b);
            let isConsecutive = true;
            for(let i = 0; i < sortedIndices.length - 1; i++) {
                if(sortedIndices[i+1] !== sortedIndices[i] + 1) { isConsecutive = false; break; }
            }
            if(!isConsecutive) { socket.emit('notification', '🚫 La escalera no es consecutiva.'); return; }

            const firstCard = playCards[0];
            let match = false;
            if(firstCard.color === room.activeColor) match = true;
            else if(firstCard.value === top.value) match = true;
            
            if(!match) { socket.emit('notification', '🚫 La primera carta seleccionada no coincide con la mesa.'); return; }

            cardIds.forEach(id => {
                const idx = player.hand.findIndex(c => c.id === id);
                if(idx !== -1) player.hand.splice(idx, 1);
            });
            room.discardPile.push(...playCards);
            room.activeColor = firstColor;
            io.to(roomId).emit('notification', `🪜 ¡ESCALERA de ${player.name}! (${playCards.length} cartas)`);
            io.to(roomId).emit('playSound', 'soft');
        }

        if(player.hand.length === 0) { finishRound(roomId, player); } else { advanceTurn(roomId, 1); updateAll(roomId); }
    });

    socket.on('playLibreAlbedrio', (data) => {
        const roomId = getRoomId(socket); if(!roomId || !rooms[roomId]) return; touchRoom(roomId);
        const room = rooms[roomId];
        const pIndex = room.players.findIndex(p => p.id === socket.id);
        const player = room.players[pIndex];

        if (room.gameState !== 'playing' || pIndex !== room.currentTurn || room.pendingPenalty > 0) return;
        if (player.hand.length < 3) return; 

        const libreIdx = player.hand.findIndex(c => c.id === data.cardId); if (libreIdx === -1) return;
        const libreCard = player.hand.splice(libreIdx, 1)[0]; room.discardPile.push(libreCard); 

        const target = room.players.find(p => p.id === data.targetPlayerId);
        const giftIdx = player.hand.findIndex(c => c.id === data.giftCardId);
        if (!target || giftIdx === -1) return; 
        const giftCard = player.hand.splice(giftIdx, 1)[0]; target.hand.push(giftCard);
        io.to(roomId).emit('notification', `🎁 ${player.name} regaló carta a ${target.name} (Libre Albedrío)`);
        io.to(target.id).emit('handUpdate', target.hand);

        let lastDiscard = null;
        if (data.discardIds && data.discardIds.length > 0) {
            data.discardIds.forEach(dId => {
                const dIdx = player.hand.findIndex(c => c.id === dId);
                if (dIdx !== -1) { const dCard = player.hand.splice(dIdx, 1)[0]; room.discardPile.push(dCard); lastDiscard = dCard; }
            });
        }
        if (!lastDiscard) { finishRound(roomId, player); return; }

        io.to(roomId).emit('notification', `🌪️ ${player.name} descartó ${data.discardIds.length} cartas.`);
        io.to(roomId).emit('playSound', 'wild');

        if (player.hand.length === 0) {
            const isLegal = /^[0-9]$/.test(lastDiscard.value) || lastDiscard.value === '1 y 1/2' || lastDiscard.value === 'GRACIA';
            if (isLegal) { finishRound(roomId, player); return; } else { drawCards(roomId, pIndex, 1); io.to(roomId).emit('notification', `🚫 Cierre Ilegal con ${lastDiscard.value}. Robas 1 carta.`); io.to(player.id).emit('handUpdate', player.hand); }
        }

        if (lastDiscard.color === 'negro' && data.chosenColor) room.activeColor = data.chosenColor;
        else if (lastDiscard.color !== 'negro') room.activeColor = lastDiscard.color;
        io.to(roomId).emit('cardPlayedEffect', { color: room.activeColor });

        if (lastDiscard.value === 'RIP') {
             if (getAlivePlayersCount(roomId) < 2) { advanceTurn(roomId, 1); updateAll(roomId); return; }
             io.to(roomId).emit('playSound', 'rip');
             room.gameState = 'rip_decision';
             const attacker = player; 
             const victimIdx = getNextPlayerIndex(roomId, 1); 
             const defender = room.players[victimIdx];
             room.duelState = { attackerId: attacker.id, defenderId: defender.id, attackerName: attacker.name, defenderName: defender.name, round: 1, scoreAttacker: 0, scoreDefender: 0, attackerChoice: null, defenderChoice: null, history: [], turn: attacker.id, narrative: `⚔️ ¡${attacker.name} desafía a muerte a ${defender.name}!` };
             updateAll(roomId); return;
        }

        if (['+2', '+4', '+12'].includes(lastDiscard.value)) {
            const val = parseInt(lastDiscard.value.replace('+','')); room.pendingPenalty += val;
            io.to(roomId).emit('notification', `💥 ¡+${val}!`); io.to(roomId).emit('playSound', 'attack');
            advanceTurn(roomId, 1); updateAll(roomId); return;
        }
        let steps = 1;
        if (lastDiscard.value === 'R') { if (getAlivePlayersCount(roomId) === 2) steps = 2; else room.direction *= -1; }
        if (lastDiscard.value === 'X') steps = 2;
        advanceTurn(roomId, steps); updateAll(roomId);
    });

    socket.on('playCard', (cardId, chosenColor, reviveTargetId) => {
        const roomId = getRoomId(socket); if(!roomId || !rooms[roomId]) return; touchRoom(roomId);
        const room = rooms[roomId]; if (room.gameState !== 'playing') return;
        
        const pIndex = room.players.findIndex(p => p.id === socket.id); if (pIndex === -1) return;
        const player = room.players[pIndex]; if (player.isDead || player.isSpectator) return;

        const cardIndex = player.hand.findIndex(c => c.id === cardId); if (cardIndex === -1) return;
        const card = player.hand[cardIndex]; const top = room.discardPile[room.discardPile.length - 1];

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
                if (player.hand.length === 1) { socket.emit('notification', '🚫 Prohibido ganar con SAFF. Espera tu turno.'); return; }
                isSaff = true; room.currentTurn = pIndex; room.pendingPenalty = 0;
                io.to(roomId).emit('notification', `⚡ ¡${player.name} hizo SAFF!`); io.to(roomId).emit('playSound', 'saff');
            } else { return; }
        }

        if (pIndex === room.currentTurn && !isSaff) {
            if (room.pendingPenalty > 0) {
                let allowed = false;
                if (card.value === 'GRACIA') allowed = true;
                else {
                    const getVal = (v) => { if (v === '+2') return 2; if (v === '+4') return 4; if (v === '+12') return 12; return 0; };
                    const cardVal = getVal(card.value); const topVal = getVal(top.value);
                    if (cardVal > 0 && cardVal >= topVal) allowed = true;
                }
                if (!allowed) { socket.emit('notification', `🚫 Debes tirar un castigo igual o mayor a la mesa, o Gracia.`); return; }
            } else {
                let valid = false;
                if (card.color === 'negro') valid = true; else if (card.value === 'GRACIA') valid = true; else if (card.color === room.activeColor) valid = true; else if (card.value === top.value) valid = true;
                if (!valid) { socket.emit('notification', `❌ Carta inválida.`); return; }
            }
        }

        if (card.value === 'GRACIA') {
            const deadPlayers = room.players.filter(p => p.isDead);
            if (room.pendingPenalty > 0) {
                player.hand.splice(cardIndex, 1); room.discardPile.push(card); 
                io.to(roomId).emit('playSound', 'divine');
                if (chosenColor) room.activeColor = chosenColor; else if (!room.activeColor) room.activeColor = 'rojo';
                io.to(roomId).emit('showDivine', `${player.name} anuló el castigo`); 
                room.pendingPenalty = 0;
                if (player.hand.length === 0) { finishRound(roomId, player); return; }
                advanceTurn(roomId, 1); updateAll(roomId); return;
            }
            if (deadPlayers.length > 0) {
                if (!reviveTargetId) {
                    const zombieList = deadPlayers.map(z => ({ id: z.id, name: z.name, count: z.hand.length }));
                    socket.emit('askReviveTarget', zombieList); return; 
                } else {
                    const target = room.players.find(p => p.id === reviveTargetId && p.isDead);
                    if (target) { target.isDead = false; target.isSpectator = false; io.to(roomId).emit('playerRevived', { savior: player.name, revived: target.name }); }
                }
            } else { io.to(roomId).emit('notification', `❤️ ${player.name} usó Gracia.`); }
            
            player.hand.splice(cardIndex, 1); room.discardPile.push(card); 
            if (!deadPlayers.length > 0) io.to(roomId).emit('playSound', 'divine'); 
            if (chosenColor) room.activeColor = chosenColor; else if (!room.activeColor) room.activeColor = 'rojo';
            if (player.hand.length === 0) { finishRound(roomId, player); return; }
            advanceTurn(roomId, 1); updateAll(roomId); return;
        }

        if (card.value === 'RIP') {
            if (room.pendingPenalty > 0) { socket.emit('notification', '🚫 RIP no sirve para evitar castigos.'); return; }
            // RESTRICCION ELIMINADA: Se permite tirar RIP sobre cualquier carta si no hay castigo pendiente.
            
            if (getAlivePlayersCount(roomId) < 2) {
                player.hand.splice(cardIndex, 1); room.discardPile.push(card);
                io.to(roomId).emit('notification', '💀 RIP fallido.');
                advanceTurn(roomId, 1); updateAll(roomId); return;
            }
            player.hand.splice(cardIndex, 1); room.discardPile.push(card); io.to(roomId).emit('playSound', 'rip');
            
            room.gameState = 'rip_decision';
            const attacker = player; const victimIdx = getNextPlayerIndex(roomId, 1); const defender = room.players[victimIdx];
            room.duelState = { attackerId: attacker.id, defenderId: defender.id, attackerName: attacker.name, defenderName: defender.name, round: 1, scoreAttacker: 0, scoreDefender: 0, attackerChoice: null, defenderChoice: null, history: [], turn: attacker.id, narrative: `⚔️ ¡${attacker.name} desafía a muerte a ${defender.name}!` };
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
        else { 
            io.to(roomId).emit('playSound', 'bell'); room.gameState = 'dueling';
            room.duelState.narrative = `¡${room.duelState.defenderName} aceptó! ${room.duelState.attackerName} está eligiendo...`; updateAll(roomId); 
        }
    });

    socket.on('duelPick', (c) => {
        const roomId = getRoomId(socket); if(!roomId || !rooms[roomId]) return; touchRoom(roomId);
        const room = rooms[roomId]; if (room.gameState !== 'dueling') return;
        if (socket.id !== room.duelState.turn) return;
        
        if (socket.id === room.duelState.attackerId) { 
            room.duelState.attackerChoice = c; room.duelState.turn = room.duelState.defenderId;
            room.duelState.narrative = `⚔️ ${room.duelState.attackerName} eligió arma oculta. Esperando a ${room.duelState.defenderName}...`;
        } 
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
        if (roomId && rooms[roomId]) { 
            const room = rooms[roomId]; const p = room.players.find(pl => pl.id === socket.id); 
            if(p) {
                p.isConnected = false;
                if ((room.gameState === 'dueling' || room.gameState === 'rip_decision') && (socket.id === room.duelState.attackerId || socket.id === room.duelState.defenderId)) {
                    io.to(roomId).emit('notification', '🔌 Jugador desconectado. Duelo cancelado.');
                    if (socket.id === room.duelState.attackerId) { eliminatePlayer(roomId, room.duelState.attackerId); }
                    if (socket.id === room.duelState.defenderId) { eliminatePlayer(roomId, room.duelState.defenderId); }
                    checkWinCondition(roomId);
                } else { updateAll(roomId); }
            }
        }
    });
});

// --- HELPERS ---
function getDuelNarrative(attName, defName, att, def) {
    if (att === def) return `⚡ Choque idéntico (${att.toUpperCase()}). ¡Empate!`;
    if (att === 'fuego' && def === 'hielo') return `🔥 El Fuego de ${attName} derritió el Hielo de ${defName}.`;
    if (att === 'hielo' && def === 'agua') return `❄️ El Hielo de ${attName} congeló el Agua de ${defName}.`;
    if (att === 'agua' && def === 'fuego') return `💧 El Agua de ${attName} apagó el Fuego de ${defName}.`;
    if (def === 'fuego' && att === 'hielo') return `🔥 El Fuego de ${defName} derritió el Hielo de ${attName}.`;
    if (def === 'hielo' && att === 'agua') return `❄️ El Hielo de ${defName} congeló el Agua de ${attName}.`;
    if (def === 'agua' && att === 'fuego') return `💧 El Agua de ${defName} apagó el Fuego de ${attName}.`;
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
    if (room.duelState.round >= 3 || room.duelState.scoreAttacker >= 2 || room.duelState.scoreDefender >= 2) { setTimeout(() => finalizeDuel(roomId), 2500); } 
    else { setTimeout(() => { if(rooms[roomId]) { room.duelState.round++; room.duelState.narrative = `Ronda ${room.duelState.round}: ${room.duelState.attackerName} elige arma...`; updateAll(roomId); } }, 3000); updateAll(roomId); }
}
function finalizeDuel(roomId) {
    const room = rooms[roomId]; const att = room.players.find(p => p.id === room.duelState.attackerId); const def = room.players.find(p => p.id === room.duelState.defenderId);
    if (!att || !def) { room.gameState = 'playing'; updateAll(roomId); return; }
    if (room.duelState.scoreAttacker > room.duelState.scoreDefender) { io.to(roomId).emit('notification', `💀 ${att.name} GANA.`); eliminatePlayer(roomId, def.id); checkWinCondition(roomId); }
    else if (room.duelState.scoreDefender > room.duelState.scoreAttacker) { io.to(roomId).emit('notification', `🛡️ ${def.name} GANA. Castigo atacante.`); drawCards(roomId, room.players.findIndex(p => p.id === room.duelState.attackerId), 4); room.gameState = 'playing'; advanceTurn(roomId, 1); updateAll(roomId); }
    else { io.to(roomId).emit('notification', `🤝 EMPATE.`); room.gameState = 'playing'; advanceTurn(roomId, 1); updateAll(roomId); }
}
function eliminatePlayer(roomId, id) { const room = rooms[roomId]; const p = room.players.find(p => p.id === id); if (p) { p.isDead = true; p.isSpectator = true; } }
function getAlivePlayersCount(roomId) { return rooms[roomId].players.filter(p => !p.isDead && !p.isSpectator).length; }
function getRoomId(socket) { return Array.from(socket.rooms).find(r => r !== socket.id); }
function startCountdown(roomId) {
    const room = rooms[roomId]; if (room.players.length < 2) return;
    room.gameState = 'counting'; let count = 3; createDeck(roomId);
    let safeCard = room.deck.pop();
    while (safeCard.color === 'negro' || safeCard.value === '+2' || safeCard.value === 'R' || safeCard.value === 'X') {
        room.deck.unshift(safeCard); for (let i = room.deck.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [room.deck[i], room.deck[j]] = [room.deck[j], room.deck[i]]; } safeCard = room.deck.pop();
    }
    room.discardPile = [safeCard]; room.activeColor = safeCard.color; room.currentTurn = 0; room.pendingPenalty = 0;
    room.players.forEach(p => { p.hand = []; p.hasDrawn = false; p.isDead = false; if (!p.isSpectator) { for (let i = 0; i < 7; i++) drawCards(roomId, room.players.indexOf(p), 1); } });
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
    
    const duelInfo = (room.gameState === 'dueling' || room.gameState === 'rip_decision') ? { attackerName: room.duelState.attackerName, defenderName: room.duelState.defenderName, round: room.duelState.round, scoreAttacker: room.duelState.scoreAttacker, scoreDefender: room.duelState.scoreDefender, history: room.duelState.history, attackerId: room.duelState.attackerId, defenderId: room.duelState.defenderId, myChoice: null, turn: room.duelState.turn, lastWinner: lastRoundWinner, narrative: room.duelState.narrative } : null;

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
        #login, #join-menu, #lobby { background: #2c3e50; z-index: 2000; }
        #game-area { display: none; flex-direction: column; height: 100%; width: 100%; position: relative; z-index: 5; padding-bottom: calc(240px + var(--safe-bottom)); } /* PADDING AUMENTADO */
        #rip-screen, #duel-screen { background: rgba(50,0,0,0.98); z-index: 10000; }
        #game-over-screen { background: rgba(0,0,0,0.95); z-index: 11000; text-align: center; border: 5px solid gold; }
        #revive-screen { position: fixed; top: 40%; left: 50%; transform: translate(-50%,-50%); background: rgba(0,0,0,0.95); border: 2px solid gold; padding: 20px; border-radius: 15px; z-index: 10500; display: none; text-align: center; width: 90%; max-width: 400px; }
        
        #libre-modal { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.95); z-index: 12000; display: none; flex-direction: column; justify-content: center; align-items: center; color: white; }
        .libre-step { display: none; width: 90%; text-align: center; }
        .libre-step.active { display: block; }
        .mini-card { display: inline-block; padding: 10px; margin: 5px; border: 2px solid white; border-radius: 5px; cursor: pointer; background: #444; }
        .mini-card.selected { border-color: gold; transform: scale(1.1); background: #666; }

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
        
        /* --- BARRA DE ACCIONES FLOTANTE (FIXED) --- */
        #action-bar {
            position: fixed;
            bottom: 180px; /* Justo arriba de las cartas */
            left: 0; width: 100%;
            display: flex; justify-content: center; align-items: center;
            padding: 10px; pointer-events: none; /* Dejar pasar clicks por los costados */
            z-index: 20000; /* SUPERIOR A TODO */
        }
        #uno-btn-area { 
            pointer-events: auto; 
            display: flex; gap: 10px; flex-wrap: wrap; justify-content: center; 
            background: rgba(0,0,0,0.6); padding: 5px 15px; border-radius: 30px;
        }

        .btn-uno { background: #e74c3c; color: white; border: 2px solid white; padding: 10px 20px; border-radius: 25px; font-weight: bold; cursor: pointer; font-size: 14px; box-shadow: 0 4px 0 #c0392b; }
        .btn-pass { background: #f39c12; color: white; border: 2px solid white; padding: 10px 20px; border-radius: 25px; font-weight: bold; cursor: pointer; display: none; box-shadow: 0 4px 0 #d35400; }
        #btn-ladder-toggle { background: #8e44ad; color: white; border: 2px solid white; padding: 10px 20px; border-radius: 25px; font-weight: bold; cursor: pointer; font-size: 14px; box-shadow: 0 4px 0 #6c3483; }
        #btn-ladder-play { background: #27ae60; color: white; border: 2px solid white; padding: 10px 20px; border-radius: 25px; font-weight: bold; cursor: pointer; display:none; animation: pop 0.3s; box-shadow: 0 0 10px gold; font-size: 14px; }

        #hand-zone { position: fixed; bottom: 0; left: 0; width: 100%; height: 180px; background: rgba(20, 20, 20, 0.95); border-top: 2px solid #555; display: flex; align-items: center; padding: 10px 20px; padding-bottom: calc(10px + var(--safe-bottom)); gap: 15px; overflow-x: auto; overflow-y: hidden; white-space: nowrap; scroll-snap-type: x mandatory; -webkit-overflow-scrolling: touch; z-index: 10000; }
        .hand-card { flex: 0 0 85px; height: 130px; border-radius: 8px; border: 2px solid white; background: #444; display: flex; justify-content: center; align-items: center; font-size: 32px; font-weight: 900; color: white; scroll-snap-align: center; position: relative; cursor: pointer; box-shadow: 0 4px 8px rgba(0,0,0,0.6); user-select: none; z-index: 1; transition: all 0.2s; }
        .hand-card:active { transform: scale(0.95); }
        .hand-card.selected-ladder { border: 4px solid cyan !important; transform: translateY(-20px); box-shadow: 0 0 15px cyan; z-index:10; }

        body.bg-rojo { background-color: #4a1c1c !important; } body.bg-azul { background-color: #1c2a4a !important; } body.bg-verde { background-color: #1c4a2a !important; } body.bg-amarillo { background-color: #4a451c !important; }
        #color-picker { position: fixed; top: 40%; left: 50%; transform: translate(-50%,-50%); background: white; padding: 20px; border-radius: 10px; z-index: 4000; display: none; text-align: center; box-shadow: 0 0 50px black; }
        .color-circle { width: 60px; height: 60px; border-radius: 50%; display: inline-block; margin: 10px; cursor: pointer; border: 3px solid #ddd; }
        .zombie-btn { display: block; width: 100%; padding: 15px; margin: 10px 0; background: #333; color: white; border: 1px solid #666; font-size: 18px; cursor: pointer; border-radius: 10px; }
        #revival-overlay { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.95); z-index: 5000; flex-direction: column; justify-content: center; align-items: center; text-align: center; pointer-events: all; }
        #revival-text { color: white; font-size: 30px; font-weight: bold; text-shadow: 0 0 20px gold; padding: 20px; border: 3px solid gold; border-radius: 15px; background: rgba(50,50,0,0.3); max-width: 90%; animation: pop 0.5s ease-out; }
        
        /* CHAT SYSTEM MOVIDO ARRIBA (FIXED) */
        #chat-btn { 
            position: fixed; 
            top: 110px; /* Debajo de los nombres */
            right: 20px; 
            width: 50px; height: 50px; 
            background: #3498db; border-radius: 50%; 
            display: flex; justify-content: center; align-items: center; 
            border: 2px solid white; z-index: 50000; 
            box-shadow: 0 4px 5px rgba(0,0,0,0.3); 
            font-size: 24px; cursor: pointer; transition: all 0.3s; 
        }
        #chat-win { 
            position: fixed; 
            top: 170px; /* Debajo del botón */
            right: 20px; 
            width: 280px; height: 250px; 
            background: rgba(0,0,0,0.95); border: 2px solid #666; 
            display: none; flex-direction: column; 
            z-index: 50000; border-radius: 10px; box-shadow: 0 0 20px black; 
        }
        #chat-badge { position: absolute; top: -5px; right: -5px; background: red; color: white; border-radius: 50%; width: 20px; height: 20px; font-size: 12px; display: none; justify-content: center; align-items: center; font-weight: bold; border: 2px solid white; }

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

    </style>
</head>
<body>
    <div id="login" class="screen" style="display:flex;"><h1 style="font-size:60px; margin:0;">UNO y 1/2</h1><input id="my-name" type="text" placeholder="Tu Nombre" maxlength="15"><button id="btn-create" class="btn-main" onclick="showCreate()">Crear Sala</button><button id="btn-join-menu" class="btn-main" onclick="showJoin()" style="background:#2980b9">Unirse a Sala</button></div>
    <div id="join-menu" class="screen"><h1>Unirse</h1><input id="room-code" type="text" placeholder="Código" style="text-transform:uppercase;"><button class="btn-main" onclick="joinRoom()">Entrar</button><button class="btn-main" onclick="backToLogin()">Volver</button></div>
    <div id="lobby" class="screen"><h1>Sala: <span id="lobby-code" style="color:gold;"></span></h1><button onclick="copyLink()">🔗 Link</button><div id="lobby-users"></div><button id="start-btn" onclick="start()" class="btn-main" style="display:none;">EMPEZAR</button><p id="wait-msg" style="display:none;">Esperando...</p></div>
    
    <div id="game-area">
        <div id="players-zone"></div>
        <div id="alert-zone"><div id="penalty-display">CASTIGO: +<span id="pen-num">0</span></div><div id="main-alert" class="alert-box"></div></div>
        <div id="table-zone">
            <div id="decks-container"><div id="deck-pile" class="card-pile" onclick="draw()">📦</div><div id="top-card" class="card-pile"></div></div>
        </div>
    </div>

    <div id="action-bar">
        <div id="uno-btn-area">
            <button id="btn-pass" class="btn-pass" onclick="pass()">PASAR</button>
            <button class="btn-uno" onclick="uno()">¡UNO y 1/2!</button>
            <button id="btn-ladder-toggle" onclick="toggleLadderMode()">ACTIVAR SELECCIÓN</button>
            <button id="btn-ladder-play" onclick="submitLadder()">JUGAR SELECCIÓN</button>
        </div>
    </div>
    
    <div id="hand-zone"></div>
    
    <div id="chat-btn" onclick="toggleChat()">💬<div id="chat-badge">0</div></div>
    <div id="chat-win">
        <div id="chat-msgs" style="flex:1; overflow-y:auto; padding:10px; font-size:12px; color:#ddd;"></div>
        <div style="display:flex; border-top:1px solid #555;">
            <input id="chat-in" style="flex:1; border-radius:0; padding:10px; border:none; background:#333; color:white; font-size:14px;" placeholder="Mensaje..." onkeypress="if(event.key==='Enter') sendChat()">
            <button onclick="sendChat()" style="background:#2980b9; color:white; border:none; padding:0 15px; cursor:pointer;">></button>
        </div>
    </div>
    
    <div id="game-over-screen" class="screen"><h1 style="color:gold;">VICTORIA</h1><h2 id="winner-name"></h2></div>
    
    <div id="rip-screen" class="screen"><h1 style="color:red;">💀 RIP 💀</h1><button onclick="ripResp('duel')" class="btn-main" style="background:red; border:3px solid gold;">ACEPTAR</button><button onclick="ripResp('surrender')" class="btn-main">Rendirse</button><div id="grace-btn" style="display:none;"><button onclick="graceDef()" class="btn-main" style="background:white; color:red;">USAR MILAGRO</button></div></div>
    <div id="duel-screen" class="screen"><h1 style="color:gold;">⚔️ DUELO ⚔️</h1><h3 id="duel-narrative">Cargando duelo...</h3><h2 id="duel-names">... vs ...</h2><h3 id="duel-sc">0 - 0</h3><p id="duel-turn-msg"></p><div id="duel-opts"><button id="btn-fuego" class="duel-btn" onclick="pick('fuego')">🔥</button><button id="btn-hielo" class="duel-btn" onclick="pick('hielo')">❄️</button><button id="btn-agua" class="duel-btn" onclick="pick('agua')">💧</button></div></div>
    
    <div id="color-picker"><h3>Elige Color</h3><div class="color-circle" style="background:#ff5252;" onclick="pickCol('rojo')"></div><div class="color-circle" style="background:#448aff;" onclick="pickCol('azul')"></div><div class="color-circle" style="background:#69f0ae;" onclick="pickCol('verde')"></div><div class="color-circle" style="background:#ffd740;" onclick="pickCol('amarillo')"></div></div>
    <div id="revive-screen"><h2 style="color:gold;">¿A QUIÉN REVIVES?</h2><div id="zombie-list"></div></div><div id="revival-overlay"><div id="revival-text"></div></div>
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
            <h2>Paso 3: Elige cartas para descartar (1-4)</h2>
            <p style="color:#aaa">Orden de descarte importa. Toca para agregar.</p>
            <div id="libre-discard-hand"></div>
            <div style="margin-top:20px; border-top:1px solid #555; padding-top:10px;">
                <h3>Cartas a descartar:</h3>
                <div id="libre-selected-discard"></div>
            </div>
            <button class="btn-main" onclick="confirmLibre()">CONFIRMAR JUGADA</button>
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
        if (!myUUID) { myUUID = Math.random().toString(36).substring(2) + Date.now().toString(36); localStorage.setItem('uno_uuid', myUUID); }
        const urlParams = new URLSearchParams(window.location.search);
        const inviteCode = urlParams.get('room');
        if (inviteCode) { document.getElementById('room-code').value = inviteCode; document.getElementById('btn-create').style.display = 'none'; document.getElementById('btn-join-menu').innerText = "ENTRAR A SALA " + inviteCode; document.getElementById('btn-join-menu').onclick = joinRoom; }
        
        socket.on('connect', () => { myId = socket.id; socket.emit('checkSession', myUUID); });
        socket.on('sessionRestored', (data) => { changeScreen('lobby'); });
        socket.on('requireLogin', () => { changeScreen('login'); });
        
        let libreState = { active: false, cardId: null, targetId: null, giftId: null, discardIds: [] };
        function startLibreAlbedrio(cardId) {
            if(myHand.length < 3) return alert("Necesitas al menos 3 cartas para usar esto.");
            libreState = { active: true, cardId: cardId, targetId: null, giftId: null, discardIds: [] };
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
        function renderGiftHand() {
            const div = document.getElementById('libre-gift-hand'); div.innerHTML = '';
            myHand.forEach(c => {
                if(c.id === libreState.cardId) return;
                const b = document.createElement('div'); b.className = 'mini-card';
                b.innerText = c.value; b.style.color = (c.color==='amarillo'||c.color==='verde')?'black':'white'; b.style.backgroundColor = getBgColor(c);
                b.onclick = () => { libreState.giftId = c.id; showLibreStep(3); renderDiscardHand(); };
                div.appendChild(b);
            });
        }
        function renderDiscardHand() {
            const pool = document.getElementById('libre-discard-hand'); pool.innerHTML = '';
            const selDiv = document.getElementById('libre-selected-discard'); selDiv.innerHTML = '';
            myHand.forEach(c => {
                if(c.id === libreState.cardId || c.id === libreState.giftId || libreState.discardIds.includes(c.id)) return;
                const b = document.createElement('div'); b.className = 'mini-card';
                b.innerText = c.value; b.style.color = (c.color==='amarillo'||c.color==='verde')?'black':'white'; b.style.backgroundColor = getBgColor(c);
                b.onclick = () => { if(libreState.discardIds.length < 4) { libreState.discardIds.push(c.id); renderDiscardHand(); } };
                pool.appendChild(b);
            });
            libreState.discardIds.forEach(did => {
                const c = myHand.find(x => x.id === did);
                const b = document.createElement('div'); b.className = 'mini-card selected';
                b.innerText = c.value; b.style.backgroundColor = getBgColor(c);
                b.onclick = () => { libreState.discardIds = libreState.discardIds.filter(x => x !== did); renderDiscardHand(); };
                selDiv.appendChild(b);
            });
        }
        function confirmLibre() {
            if(libreState.discardIds.length === 0) return alert("Debes descartar al menos 1 carta.");
            const lastId = libreState.discardIds[libreState.discardIds.length-1]; const lastCard = myHand.find(c => c.id === lastId);
            if(lastCard.color === 'negro') { showLibreStep('color'); } else { finishLibre(null); }
        }
        function finishLibre(color) {
            document.getElementById('libre-modal').style.display = 'none';
            socket.emit('playLibreAlbedrio', { cardId: libreState.cardId, targetPlayerId: libreState.targetId, giftCardId: libreState.giftId, discardIds: libreState.discardIds, chosenColor: color });
            libreState = { active: false };
        }
        function showLibreStep(n) { document.querySelectorAll('.libre-step').forEach(el => el.classList.remove('active')); if(n==='color') document.getElementById('step-color').classList.add('active'); else document.getElementById('step-'+n).classList.add('active'); }
        function getBgColor(c) { const map = { 'rojo': '#ff5252', 'azul': '#448aff', 'verde': '#69f0ae', 'amarillo': '#ffd740', 'negro': '#212121' }; if(c.value==='RIP') return 'black'; if(c.value==='GRACIA') return 'white'; if(c.value==='+12') return '#4a148c'; if(c.value==='LIBRE') return '#000'; return map[c.color] || '#444'; }

        function showCreate() { const name = document.getElementById('my-name').value.trim(); if(name) socket.emit('createRoom', { name, uuid: myUUID }); }
        function showJoin() { changeScreen('join-menu'); }
        function backToLogin() { changeScreen('login'); }
        function joinRoom() { const name = document.getElementById('my-name').value.trim(); const code = document.getElementById('room-code').value.trim(); if(name && code) socket.emit('joinRoom', { name, uuid: myUUID, roomId: code }); }
        
        // --- FUNCIÓN DE LINK CORREGIDA ---
        function copyLink() { 
            const code = document.getElementById('lobby-code').innerText;
            const url = window.location.origin + '/?room=' + code;
            if(navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(url).then(() => {
                    alert('¡Link copiado al portapapeles!');
                }).catch(err => {
                    prompt("Copia este link manualmente:", url);
                });
            } else {
                prompt("Copia este link manualmente:", url);
            }
        }

        function kick(id) { if(confirm('Echar?')) socket.emit('kickPlayer', id); }

        socket.on('roomCreated', (d) => { changeScreen('lobby'); document.getElementById('lobby-code').innerText = d.roomId; });
        socket.on('roomJoined', (d) => { changeScreen('lobby'); document.getElementById('lobby-code').innerText = d.roomId; });
        socket.on('updateState', s => {
            currentPlayers = s.players;
            if(s.state === 'waiting') {
                const list = s.players.map(p => '<div>' + (p.isConnected?'🟢':'🔴') + ' ' + p.name + (s.iamAdmin&&p.id!==myId?('<button onclick="kick(\''+p.id+'\')">❌</button>'):'') + '</div>').join('');
                document.getElementById('lobby-users').innerHTML = list;
                document.getElementById('start-btn').style.display = s.iamAdmin ? 'block' : 'none';
                return;
            }
            document.body.className = ''; 
            if(s.state === 'playing') {
                 if(s.activeColor) document.body.classList.add('bg-'+s.activeColor);
                 document.getElementById('game-area').style.display = 'flex';
                 document.getElementById('hand-zone').style.display = 'flex';
                 document.getElementById('action-bar').style.display = 'flex';
                 document.getElementById('duel-screen').style.display = 'none';
                 document.getElementById('rip-screen').style.display = 'none';
            } 
            else if (s.state === 'rip_decision') {
                document.body.classList.add('state-rip');
                if(s.duelInfo.defenderId === myId) { document.getElementById('rip-screen').style.display = 'flex'; document.getElementById('duel-screen').style.display = 'none'; } 
                else { 
                    document.getElementById('rip-screen').style.display = 'none'; document.getElementById('duel-screen').style.display = 'flex'; 
                    document.getElementById('duel-narrative').innerText = s.duelInfo.narrative || "Esperando respuesta del desafiado..."; 
                    document.getElementById('duel-names').innerText = s.duelInfo.attackerName + ' vs ' + s.duelInfo.defenderName; 
                    document.getElementById('duel-opts').style.display = 'none'; 
                }
            }
            else if (s.state === 'dueling') {
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
                document.getElementById('players-zone').innerHTML = s.players.map(p => '<div class="player-badge ' + (p.isTurn?'is-turn':'') + ' ' + (p.isDead?'is-dead':'') + '">' + (p.isConnected?'':'🔴') + ' ' + p.name + ' (' + p.cardCount + ')</div>').join('');
                if(s.topCard) {
                    const tc = s.topCard; const el = document.getElementById('top-card');
                    el.style.backgroundColor = getBgColor(tc); el.style.border = (tc.value==='RIP'?'3px solid #666':(tc.value==='GRACIA'?'3px solid gold':'3px solid white'));
                    el.innerText = (tc.value==='RIP'?'🪦':(tc.value==='GRACIA'?'❤️':(tc.value==='LIBRE'?'🕊️':tc.value)));
                }
                const me = s.players.find(p=>p.id===myId);
                isMyTurn = me && me.isTurn;
                document.getElementById('btn-pass').style.display = (me && me.isTurn && me.hasDrawn && s.pendingPenalty===0) ? 'inline-block' : 'none';
                if(me && me.isTurn && s.pendingPenalty>0) { document.getElementById('penalty-display').style.display='block'; document.getElementById('pen-num').innerText=s.pendingPenalty; } else document.getElementById('penalty-display').style.display='none';
            }
        });

        socket.on('handUpdate', h => {
            myHand = h;
            if(document.body.classList.contains('state-dueling') || document.body.classList.contains('state-rip')) return;
            const hz = document.getElementById('hand-zone'); hz.innerHTML = '';
            const hasGrace = h.some(c=>c.value==='GRACIA');
            document.getElementById('grace-btn').style.display = hasGrace ? 'block':'none';
            
            h.forEach(c => {
                const d = document.createElement('div'); d.className = 'hand-card';
                if(ladderSelected.includes(c.id)) d.classList.add('selected-ladder');
                d.style.backgroundColor = getBgColor(c); 
                d.style.color = (c.color==='amarillo'||c.color==='verde')?'black':'white';
                d.innerText = (c.value==='RIP'?'🪦':(c.value==='GRACIA'?'❤️':(c.value==='LIBRE'?'🕊️':c.value)));
                if(c.value === '1 y 1/2') d.style.fontSize = '18px';
                
                d.onclick = () => {
                    if(ladderMode) {
                        if(ladderSelected.includes(c.id)) { ladderSelected = ladderSelected.filter(id => id !== c.id); d.classList.remove('selected-ladder'); } 
                        else { ladderSelected.push(c.id); d.classList.add('selected-ladder'); }
                        document.getElementById('btn-ladder-play').style.display = (ladderSelected.length >= 2) ? 'block' : 'none';
                        return;
                    }
                    if(document.getElementById('color-picker').style.display === 'block') return;
                    if(c.value === 'LIBRE') { startLibreAlbedrio(c.id); return; }
                    if(!isMyTurn) { if(!(/^[0-9]$/.test(c.value) || c.value === '1 y 1/2')) return; }
                    if(c.color==='negro' && c.value!=='GRACIA') { if(c.value==='RIP') socket.emit('playCard', c.id, null, null); else { pendingCard=c.id; document.getElementById('color-picker').style.display='block'; } } 
                    else socket.emit('playCard', c.id, null, null);
                };
                hz.appendChild(d);
            });
        });

        function toggleLadderMode() {
            ladderMode = !ladderMode; ladderSelected = []; 
            const btn = document.getElementById('btn-ladder-toggle');
            if(ladderMode) { btn.innerText = "CANCELAR"; btn.style.background = "#e74c3c"; } 
            else { btn.innerText = "ACTIVAR SELECCIÓN"; btn.style.background = "#8e44ad"; document.getElementById('btn-ladder-play').style.display = 'none'; document.querySelectorAll('.hand-card').forEach(c => c.classList.remove('selected-ladder')); }
        }
        function submitLadder() { if(ladderSelected.length < 2) return; socket.emit('playMultiCards', ladderSelected); toggleLadderMode(); }

        function changeScreen(id) { document.querySelectorAll('.screen').forEach(s=>s.style.display='none'); document.getElementById('game-area').style.display='none'; document.getElementById('action-bar').style.display='none'; document.getElementById(id).style.display='flex'; }
        function start(){ socket.emit('requestStart'); }
        function draw(){ socket.emit('draw'); }
        function pass(){ socket.emit('passTurn'); }
        function uno(){ socket.emit('sayUno'); }
        function sendChat(){ const i=document.getElementById('chat-in'); if(i.value){ socket.emit('sendChat',i.value); i.value=''; }}
        function toggleChat(){ const w = document.getElementById('chat-win'); if(isChatOpen) { w.style.display = 'none'; isChatOpen = false; } else { w.style.display = 'flex'; isChatOpen = true; unreadCount = 0; document.getElementById('chat-badge').style.display = 'none'; document.getElementById('chat-badge').innerText = '0'; } }
        function pickCol(c){ document.getElementById('color-picker').style.display='none'; if(pendingGrace) socket.emit('playGraceDefense',c); else socket.emit('playCard',pendingCard,c,null); }
        function ripResp(d){ socket.emit('ripDecision',d); }
        function pick(c){ socket.emit('duelPick',c); }
        function graceDef(){ pendingGrace=true; document.getElementById('color-picker').style.display='block'; }
        
        socket.on('countdownTick',n=>{ changeScreen('game-area'); document.getElementById('countdown').style.display=n>0?'flex':'none'; document.getElementById('countdown').innerText=n; });
        socket.on('playSound',k=>{const a=new Audio({soft:'https://cdn.freesound.org/previews/240/240776_4107740-lq.mp3',attack:'https://cdn.freesound.org/previews/155/155235_2452367-lq.mp3',rip:'https://cdn.freesound.org/previews/173/173930_2394245-lq.mp3',divine:'https://cdn.freesound.org/previews/242/242501_4414128-lq.mp3',uno:'https://cdn.freesound.org/previews/415/415209_5121236-lq.mp3',start:'https://cdn.freesound.org/previews/320/320655_5260872-lq.mp3',win:'https://cdn.freesound.org/previews/270/270402_5123851-lq.mp3',bell:'https://cdn.freesound.org/previews/336/336899_4939433-lq.mp3',wild:'https://cdn.freesound.org/previews/320/320653_5260872-lq.mp3',saff:'https://cdn.freesound.org/previews/614/614742_11430489-lq.mp3'}[k]); a.volume=0.3; a.play().catch(()=>{});});
        socket.on('notification',m=>{const b=document.getElementById('main-alert'); b.innerText=m; b.style.display='block'; setTimeout(()=>b.style.display='none',3000);});
        socket.on('showDivine',m=>{const b=document.getElementById('main-alert'); b.innerText=m; b.style.display='block'; b.style.background='white'; b.style.color='gold'; setTimeout(()=>{b.style.display='none'; b.style.background='rgba(0,0,0,0.95)'; b.style.color='white';},4000);});
        socket.on('chatMessage', m => { const b = document.getElementById('chat-msgs'); b.innerHTML += '<div><b style="color:gold">' + m.name + ':</b> ' + m.text + '</div>'; b.scrollTop = b.scrollHeight; if(!isChatOpen) { unreadCount++; const badge = document.getElementById('chat-badge'); badge.style.display = 'flex'; badge.innerText = unreadCount > 9 ? '9+' : unreadCount; } });
        socket.on('chatHistory',h=>{const b=document.getElementById('chat-msgs'); b.innerHTML=''; h.forEach(m=>b.innerHTML+='<div><b style="color:gold">' + m.name + ':</b> ' + m.text + '</div>'); b.scrollTop=b.scrollHeight;});
        socket.on('gameOver',d=>{document.getElementById('game-over-screen').style.display='flex'; document.getElementById('winner-name').innerText=d.winner; setTimeout(()=>{localStorage.removeItem('uno_uuid'); window.location=window.location.origin;},5000);});
        socket.on('askReviveTarget',z=>{const l=document.getElementById('zombie-list'); l.innerHTML=''; z.forEach(x=>{const b=document.createElement('button'); b.className='zombie-btn'; b.innerHTML=x.name + '<br><small>(' + x.count + ')</small>'; b.onclick=()=>{document.getElementById('revive-screen').style.display='none'; socket.emit('playCard',pendingCard,pendingColorForRevive,x.id);}; l.appendChild(b);}); document.getElementById('revive-screen').style.display='block';});
        socket.on('playerRevived',d=>{ const o=document.getElementById('revival-overlay'); document.getElementById('revival-text').innerHTML='✨<br>' + d.revived + ' fue resucitado por gracia divina de ' + d.savior + '<br>✨'; o.style.display='flex'; setTimeout(()=>o.style.display='none',4000);});
    </script>
</body>
</html>
`);
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
