const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { pingTimeout: 60000, pingInterval: 25000 });

// --- CONFIGURACIÓN ---
const rooms = {};
const ladderOrder = ['0', '1', '1 y 1/2', '2', '3', '4', '5', '6', '7', '8', '9'];
const colors = ['rojo', 'azul', 'verde', 'amarillo'];
const values = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '1 y 1/2', '+2', 'X', 'R'];

// Pesos para ordenamiento
const sortValWeights = {
    '0':0, '1':1, '1 y 1/2':1.5, '2':2, '3':3, '4':4, '5':5, '6':6, '7':7, '8':8, '9':9,
    '+2': 20, 'X': 21, 'R': 22,
    'color': 50, '+4': 51, '+12': 52, 'SALTEO SUPREMO': 53, 'RIP': 54, 'LIBRE': 55, 'GRACIA': 56
};
const sortColWeights = { 'rojo':1, 'azul':2, 'verde':3, 'amarillo':4, 'negro':5 };

// Limpieza de salas inactivas
setInterval(() => {
    const now = Date.now();
    Object.keys(rooms).forEach(roomId => {
        if (now - rooms[roomId].lastActivity > 7200000) delete rooms[roomId];
    });
}, 300000);

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
        pendingSkip: 0,    
        duelState: { 
            attackerId: null, defenderId: null, attackerName: '', defenderName: '', 
            round: 1, scoreAttacker: 0, scoreDefender: 0, 
            attackerChoice: null, defenderChoice: null, history: [], turn: null, narrative: '',
            isPenaltyDuel: false, penaltyType: '' // '+12' o 'SALTEO'
        },
        libreState: { userId: null, victimId: null, giveCardId: null },
        chatHistory: [],
        lastActivity: Date.now()
    };
}

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
    const addSpecial = (val, count) => {
        for(let i=0; i<count; i++) room.deck.push({ color: 'negro', value: val, type: 'special', id: Math.random().toString(36) });
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
    const room = rooms[roomId];
    if (room.discardPile.length <= 1) { createDeck(roomId); return; }
    const topCard = room.discardPile.pop();
    room.deck = [...room.discardPile];
    room.discardPile = [topCard];
    for (let i = room.deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [room.deck[i], room.deck[j]] = [room.deck[j], room.deck[i]];
    }
}

// --- LOGICA SOCKET ---

io.on('connection', (socket) => {
    socket.on('checkSession', (uuid) => {
        let found = false;
        for (const rId in rooms) { 
            const p = rooms[rId].players.find(pl => pl.uuid === uuid); 
            if (p) {
                p.id = socket.id; p.isConnected = true; found = true;
                socket.join(rId); rooms[rId].lastActivity = Date.now(); updateAll(rId);
                break;
            } 
        }
        if(!found) socket.emit('requireLogin');
    });

    socket.on('createRoom', (data) => {
        const roomId = Math.random().toString(36).substring(2, 6).toUpperCase(); initRoom(roomId);
        rooms[roomId].players.push(createPlayer(socket.id, data.uuid, data.name, true));
        socket.join(roomId); socket.emit('roomCreated', { roomId, name: data.name }); updateAll(roomId);
    });

    socket.on('joinRoom', (data) => {
        const roomId = data.roomId.toUpperCase(); const room = rooms[roomId];
        if (!room) { socket.emit('error', 'Sala no encontrada.'); return; }
        const existing = room.players.find(p => p.uuid === data.uuid);
        if (existing) { existing.id = socket.id; existing.isConnected = true; socket.join(roomId); }
        else {
            room.players.push(createPlayer(socket.id, data.uuid, data.name, (room.players.length === 0)));
            socket.join(roomId);
        }
        const p = room.players.find(pl => pl.uuid === data.uuid);
        if (room.gameState !== 'waiting') p.isSpectator = true;
        socket.emit('roomJoined', { roomId }); updateAll(roomId);
    });

    socket.on('requestStart', () => {
        const roomId = getRoomId(socket); const room = rooms[roomId];
        if(room && room.gameState === 'waiting') startCountdown(roomId);
    });

    // --- JUGADAS ---

    socket.on('playMultiCards', (cardIds) => {
        const roomId = getRoomId(socket); if(!roomId) return;
        const room = rooms[roomId]; const player = getPlayer(room, socket.id);
        if (!isTurn(room, player) || room.gameState !== 'playing' || room.pendingPenalty > 0) return;

        let cardsToPlay = [];
        for(let id of cardIds) {
            const c = player.hand.find(x => x.id === id);
            if(c) cardsToPlay.push(c);
        }
        if(cardsToPlay.length < 2) return;

        const top = room.discardPile[room.discardPile.length - 1];
        let valid = false;
        let type = '';

        // Combo 1.5 + 1.5
        if (cardsToPlay.length === 2 && cardsToPlay[0].value === '1 y 1/2' && cardsToPlay[1].value === '1 y 1/2') {
            if (cardsToPlay[0].color === cardsToPlay[1].color && top.value === '3' && top.color === cardsToPlay[0].color) {
                valid = true; type = 'Combo Matemático';
                room.activeColor = cardsToPlay[0].color;
            }
        } 
        // Escaleras
        else {
            const color = cardsToPlay[0].color;
            if (color !== 'negro' && cardsToPlay.every(c => c.color === color)) {
                const indices = cardsToPlay.map(c => ladderOrder.indexOf(c.value)).sort((a,b)=>a-b);
                let consecutive = true;
                for(let i=0; i<indices.length-1; i++) if(indices[i+1] !== indices[i]+1) consecutive = false;
                
                if (consecutive) {
                    if (cardsToPlay.length >= 3) {
                        if (color === room.activeColor || cardsToPlay.some(c => c.value === top.value)) { valid = true; type = 'Escalera'; room.activeColor = color; }
                    } else if (cardsToPlay.length === 2) {
                        const topIdx = ladderOrder.indexOf(top.value);
                        if (top.color === color && ((indices[0] === topIdx + 1 && indices[1] === topIdx + 2) || (indices[1] === topIdx - 1 && indices[0] === topIdx - 2))) {
                            valid = true; type = 'Escalera'; room.activeColor = color;
                        }
                    }
                }
            }
        }

        if (valid) {
            cardsToPlay.forEach(c => {
                 player.hand.splice(player.hand.indexOf(c), 1);
                 room.discardPile.push(c);
            });
            checkUnoStatus(player); // Chequeo de 1 carta
            io.to(roomId).emit('notification', `✨ ${type} de ${player.name}`);
            if(player.hand.length === 0) finishRound(roomId, player); 
            else { advanceTurn(roomId, 1); updateAll(roomId); }
        } else {
            socket.emit('error', 'Jugada múltiple inválida');
        }
    });

    socket.on('playCard', (cardId, chosenColor) => {
        const roomId = getRoomId(socket); if(!roomId) return;
        const room = rooms[roomId]; const player = getPlayer(room, socket.id);
        if (!player) return;

        const top = room.discardPile[room.discardPile.length - 1];
        const card = player.hand.find(c => c.id === cardId);
        if(!card) return;

        // SAFF
        let isSaff = (room.gameState === 'playing' && !isTurn(room, player) && card.value === top.value && card.color === top.color && card.color !== 'negro' && room.pendingPenalty === 0 && room.pendingSkip === 0);
        
        if (room.gameState !== 'playing' && room.gameState !== 'penalty_decision') return;
        if (!isSaff && !isTurn(room, player)) return;

        // 1. GRACIA DIVINA en Decision (Salva de todo castigo negro)
        if (room.gameState === 'penalty_decision') {
            if (isTurn(room, player) && card.value === 'GRACIA') {
                player.hand.splice(player.hand.findIndex(c => c.id === cardId), 1);
                room.discardPile.push(card);
                io.to(roomId).emit('notification', `🙏 ¡${player.name} usó GRACIA DIVINA y se salvó!`);
                room.pendingPenalty = 0; room.pendingSkip = 0; room.gameState = 'playing';
                checkUnoStatus(player);
                if(player.hand.length === 0) finishRound(roomId, player);
                else { advanceTurn(roomId, 1); updateAll(roomId); }
                return;
            } else return;
        }

        // 2. LIBRE ALBEDRÍO DEFENSIVO (+2, +4, +12) -> NO SIRVE CONTRA SALTEO
        if (isTurn(room, player) && room.pendingPenalty > 0 && room.pendingSkip === 0 && card.value === 'LIBRE') {
            player.hand.splice(player.hand.findIndex(c => c.id === cardId), 1);
            room.discardPile.push(card);
            io.to(roomId).emit('notification', `🛡️ ¡${player.name} usó LIBRE ALBEDRÍO para bloquear el castigo!`);
            room.pendingPenalty = 0;
            startLibreSequence(roomId, player);
            return;
        }

        // Bloqueo si hay castigo pendiente y no es defensa
        if (isTurn(room, player) && (room.pendingPenalty > 0 || room.pendingSkip > 0)) return;

        // JUGAR CARTA
        const cIndex = player.hand.findIndex(c => c.id === cardId);
        player.hand.splice(cIndex, 1);
        room.discardPile.push(card);

        if (card.color === 'negro' && chosenColor) room.activeColor = chosenColor;
        else if (card.color !== 'negro') room.activeColor = card.color;

        // --- EFECTOS ---

        // RIP
        if (card.value === 'RIP') {
            if (getAlivePlayersCount(roomId) < 2) { finishRound(roomId, player); return; }
            room.gameState = 'rip_decision';
            const victim = getNextPlayer(room, 1);
            initDuel(room, player, victim, false);
            room.duelState.narrative = `💀 ¡${player.name} te retó a Duelo usando la carta RIP!`;
            checkUnoStatus(player);
            updateAll(roomId); return;
        }

        // LIBRE ALBEDRIO (Normal)
        if (card.value === 'LIBRE') {
            checkUnoStatus(player);
            startLibreSequence(roomId, player);
            return;
        }

        // PENALIDADES NEGRAS (+12, SALTEO)
        if (['+12', 'SALTEO SUPREMO'].includes(card.value)) {
            let penalty = (card.value === '+12') ? 12 : 4;
            let skips = (card.value === 'SALTEO SUPREMO') ? 4 : 0;
            
            room.pendingPenalty += penalty;
            room.pendingSkip += skips;

            checkUnoStatus(player);
            if (player.hand.length === 0) { finishRound(roomId, player); return; }

            room.currentTurn = getNextPlayerIndex(room, 1);
            room.gameState = 'penalty_decision';
            // Guardamos el tipo de penalidad para el duelo
            initDuel(room, player, room.players[room.currentTurn], true); 
            room.duelState.penaltyType = card.value; 
            
            updateAll(roomId); return;
        }

        // RESTO
        if (['+2', '+4'].includes(card.value)) room.pendingPenalty += parseInt(card.value.replace('+',''));
        
        let steps = 1;
        if (card.value === 'X') steps = 2;
        if (card.value === 'R') room.direction *= -1;

        checkUnoStatus(player);
        if (player.hand.length === 0) finishRound(roomId, player);
        else {
            if (isSaff) room.currentTurn = rooms[roomId].players.findIndex(p => p.id === socket.id);
            advanceTurn(roomId, steps);
            updateAll(roomId);
        }
    });

    // --- LIBRE ALBEDRIO ---
    socket.on('libreAction', (data) => {
        const roomId = getRoomId(socket); if(!roomId) return;
        const room = rooms[roomId]; const player = getPlayer(room, socket.id);
        if(!player || player.id !== room.libreState.userId) return;

        if (data.type === 'victim' && room.gameState === 'libre_victim') {
            room.libreState.victimId = data.val;
            room.gameState = 'libre_give';
        } else if (data.type === 'give' && room.gameState === 'libre_give') {
            const idx = player.hand.findIndex(c => c.id === data.val);
            if(idx > -1) {
                const card = player.hand.splice(idx, 1)[0];
                const victim = room.players.find(p => p.id === room.libreState.victimId);
                victim.hand.push(card);
                room.gameState = 'libre_discard';
            }
        } else if (data.type === 'discard' && room.gameState === 'libre_discard') {
            const idx = player.hand.findIndex(c => c.id === data.val);
            if(idx > -1) {
                const card = player.hand.splice(idx, 1)[0];
                room.discardPile.push(card);
                room.activeColor = (card.color === 'negro') ? room.activeColor : card.color;
                room.gameState = 'libre_color';
            }
        } else if (data.type === 'color' && room.gameState === 'libre_color') {
            room.activeColor = data.val;
            const victimName = room.players.find(p => p.id === room.libreState.victimId).name;
            io.to(roomId).emit('notification', `⚖️ ${player.name} regaló a ${victimName}, descartó y cambió a ${data.val}.`);
            
            if (player.hand.length === 0) finishRound(roomId, player);
            else {
                room.gameState = 'playing';
                advanceTurn(roomId, 1);
            }
        }
        updateAll(roomId);
    });

    // --- DECISIONES ---

    socket.on('ripDecision', (action) => {
        const roomId = getRoomId(socket); const room = rooms[roomId];
        if(!room || room.gameState !== 'rip_decision' || socket.id !== room.duelState.defenderId) return;

        if (action === 'surrender') {
            eliminatePlayer(roomId, room.duelState.defenderId);
            checkWinCondition(roomId);
        } else {
            room.gameState = 'dueling';
            updateAll(roomId);
        }
    });

    socket.on('penaltyDecision', (action) => {
        const roomId = getRoomId(socket); const room = rooms[roomId];
        if(!room || room.gameState !== 'penalty_decision') return;
        const player = getPlayer(room, socket.id);
        if(!isTurn(room, player)) return;

        if (action === 'accept') {
            io.to(roomId).emit('notification', `${player.name} aceptó el castigo.`);
            room.gameState = 'playing'; 
            // NO se roban automatico. El estado es playing pero con pendingPenalty > 0
            // El jugador debe hacer click en mazo para robar 1 a 1.
            updateAll(roomId);
        } else {
            room.gameState = 'dueling';
            const attacker = room.players.find(p => p.id === room.duelState.attackerId);
            room.duelState.narrative = `⚔️ ¡${player.name} desafió a ${attacker.name} para evitar el castigo!`;
            updateAll(roomId);
        }
    });

    socket.on('duelPick', (choice) => {
        const roomId = getRoomId(socket); const room = rooms[roomId];
        if(!room || room.gameState !== 'dueling') return;

        if (socket.id === room.duelState.attackerId) room.duelState.attackerChoice = choice;
        else if (socket.id === room.duelState.defenderId) room.duelState.defenderChoice = choice;

        if (room.duelState.attackerChoice && room.duelState.defenderChoice) {
            resolveDuelRound(roomId);
        } else {
            room.duelState.turn = (socket.id === room.duelState.attackerId) ? room.duelState.defenderId : room.duelState.attackerId;
            updateAll(roomId);
        }
    });

    // --- UNO y 1/2 (ANUNCIO) ---

    socket.on('sayUno', () => {
        const roomId = getRoomId(socket); const room = rooms[roomId];
        const p = getPlayer(room, socket.id);
        if(p && p.hand.length === 1) {
            p.saidUno = true;
            io.to(roomId).emit('notification', `📢 ¡${p.name} gritó "UNO y 1/2"!`);
            updateAll(roomId);
        }
    });

    socket.on('reportUno', (targetId) => {
        const roomId = getRoomId(socket); const room = rooms[roomId];
        const accuser = getPlayer(room, socket.id);
        const target = getPlayer(room, targetId);

        if(!target || target.hand.length !== 1 || target.saidUno) {
            socket.emit('error', 'Denuncia inválida.'); return;
        }

        // Inmunidad de 2 segundos
        const timeDiff = Date.now() - target.lastOneCardTime;
        if (timeDiff < 2000) {
            socket.emit('error', '¡Espera! Todavía tiene tiempo de gracia.'); return;
        }

        drawCards(room, target, 2);
        target.saidUno = true; // Para que no lo vuelvan a denunciar por la misma omisión
        io.to(roomId).emit('notification', `🚨 ¡${accuser.name} denunció a ${target.name}! Castigo: +2 cartas.`);
        updateAll(roomId);
    });

    // --- ROBAR Y PASAR ---

    socket.on('draw', () => {
        const roomId = getRoomId(socket); const room = rooms[roomId]; const p = getPlayer(room, socket.id);
        if(room.gameState === 'playing' && isTurn(room, p)) {
            
            // CASO 1: Robando penalidad (manual)
            if (room.pendingPenalty > 0) {
                drawCards(room, p, 1);
                room.pendingPenalty--;
                
                // Si terminó de robar penalidad
                if (room.pendingPenalty === 0) {
                    if (room.pendingSkip > 0) {
                        // Era Salteo Supremo, ahora pierde turnos
                        const skip = room.pendingSkip;
                        room.pendingSkip = 0;
                        advanceTurn(roomId, skip + 1); // +1 para salir de su turno
                    } else {
                        // Era +2, +4, +12. Pierde su turno actual.
                        advanceTurn(roomId, 1);
                    }
                }
            } 
            // CASO 2: Robo normal
            else if(!p.hasDrawn) { 
                drawCards(room, p, 1); 
                p.hasDrawn = true; 
            }
            updateAll(roomId);
        }
    });

    socket.on('passTurn', () => {
        const roomId = getRoomId(socket); const room = rooms[roomId]; const p = getPlayer(room, socket.id);
        if(room.gameState === 'playing' && isTurn(room, p) && p.hasDrawn && room.pendingPenalty === 0) {
            advanceTurn(roomId, 1);
            updateAll(roomId);
        }
    });
    
    socket.on('sendChat', (text) => {
        const roomId = getRoomId(socket); if(rooms[roomId]) {
            const p = getPlayer(rooms[roomId], socket.id);
            if(p) io.to(roomId).emit('chatMessage', {name: p.name, text}); 
        }
    });

    socket.on('requestSort', () => {
        const roomId = getRoomId(socket); const room = rooms[roomId]; const p = getPlayer(room, socket.id);
        if(p) { p.hand.sort((a,b) => (sortColWeights[a.color]-sortColWeights[b.color]) || (sortValWeights[a.value]-sortValWeights[b.value])); socket.emit('handUpdate', p.hand); }
    });
});

// --- HELPERS ---

function createPlayer(socketId, uuid, name, isAdmin) {
    return { 
        id: socketId, uuid, name: name.substring(0,12), 
        hand: [], hasDrawn: false, isSpectator: false, isDead: false, 
        isAdmin, isConnected: true, 
        saidUno: false, lastOneCardTime: 0 
    };
}

function getPlayer(room, id) { return room.players.find(p => p.id === id); }
function getRoomId(socket) { return Array.from(socket.rooms).find(r => r !== socket.id); }
function isTurn(room, player) { return room.players[room.currentTurn].id === player.id; }

function getNextPlayerIndex(room, steps) {
    let next = room.currentTurn;
    let count = 0;
    while (count < steps) {
        next = (next + room.direction + room.players.length) % room.players.length;
        if (!room.players[next].isDead && !room.players[next].isSpectator) count++;
    }
    return next;
}
function getNextPlayer(room, steps) { return room.players[getNextPlayerIndex(room, steps)]; }
function getAlivePlayersCount(roomId) { return rooms[roomId].players.filter(p => !p.isDead && !p.isSpectator).length; }

function advanceTurn(roomId, steps) {
    const room = rooms[roomId];
    room.players.forEach(p => p.hasDrawn = false);
    room.currentTurn = getNextPlayerIndex(room, steps);
}

function drawCards(room, player, count) {
    for(let i=0; i<count; i++) {
        if(room.deck.length === 0) recycleDeck(Object.keys(rooms).find(key => rooms[key] === room));
        if(room.deck.length > 0) player.hand.push(room.deck.pop());
    }
    checkUnoStatus(player);
}

function checkUnoStatus(player) {
    if (player.hand.length === 1) {
        player.lastOneCardTime = Date.now();
        player.saidUno = false;
    } else {
        player.saidUno = false;
        player.lastOneCardTime = 0;
    }
}

function startLibreSequence(roomId, player) {
    const room = rooms[roomId];
    room.gameState = 'libre_victim';
    room.libreState = { userId: player.id, victimId: null, giveCardId: null };
    updateAll(roomId);
}

function initDuel(room, attacker, defender, isPenalty) {
    room.duelState = {
        attackerId: attacker.id, defenderId: defender.id,
        attackerName: attacker.name, defenderName: defender.name,
        round: 1, scoreAttacker: 0, scoreDefender: 0,
        attackerChoice: null, defenderChoice: null,
        turn: attacker.id, narrative: '', isPenaltyDuel: isPenalty
    };
}

function resolveDuelRound(roomId) {
    const room = rooms[roomId];
    const att = room.duelState.attackerChoice, def = room.duelState.defenderChoice;
    
    let winner = null;
    if ((att==='fuego' && def==='hielo') || (att==='hielo' && def==='agua') || (att==='agua' && def==='fuego')) winner = 'att';
    else if (att !== def) winner = 'def';

    if (winner === 'att') room.duelState.scoreAttacker++;
    if (winner === 'def') room.duelState.scoreDefender++;

    room.duelState.attackerChoice = null; room.duelState.defenderChoice = null;
    room.duelState.turn = room.duelState.attackerId;

    if (room.duelState.scoreAttacker >= 2 || room.duelState.scoreDefender >= 2) {
        finishDuel(roomId, room.duelState.scoreAttacker >= 2 ? 'attacker' : 'defender');
    } else {
        room.duelState.round++;
        updateAll(roomId);
    }
}

function finishDuel(roomId, winnerRole) {
    const room = rooms[roomId];
    const isPenalty = room.duelState.isPenaltyDuel;
    
    if (!isPenalty) {
        // DUELO RIP
        const loserId = (winnerRole === 'attacker') ? room.duelState.defenderId : room.duelState.attackerId;
        eliminatePlayer(roomId, loserId);
        checkWinCondition(roomId);
    } else {
        // DUELO POR PENALIDAD (+12 o Salteo)
        const attacker = room.players.find(p => p.id === room.duelState.attackerId); // Quien tiró
        const defender = room.players.find(p => p.id === room.duelState.defenderId); // Víctima

        if (winnerRole === 'defender') {
            // Defensor gana: Se salva de todo
            io.to(roomId).emit('notification', `🛡️ ¡${defender.name} ganó! Devuelve el castigo.`);
            room.pendingPenalty = 0; room.pendingSkip = 0;
            
            // Atacante recibe 4 cartas y turno pasa al siguiente de la víctima
            drawCards(room, attacker, 4);
            room.gameState = 'playing';
            // Como el atacante ya jugó y la víctima se salvó, sigue el jugador después de la víctima
            advanceTurn(roomId, 1);
            updateAll(roomId);

        } else {
            // Atacante gana: Se duplica/agrava el castigo
            // +12 -> +16 (4 extra)
            // Salteo -> 8 cartas (4 extra) y mantiene 4 saltos
            room.pendingPenalty += 4;
            io.to(roomId).emit('notification', `☠️ ¡${attacker.name} ganó! El castigo aumenta.`);
            
            // Víctima debe robar manualmente
            room.gameState = 'playing'; 
            updateAll(roomId);
        }
    }
}

function eliminatePlayer(roomId, id) { const p = rooms[roomId].players.find(p => p.id === id); if(p) p.isDead = true; }

function checkWinCondition(roomId) {
    if (getAlivePlayersCount(roomId) <= 1) finishRound(roomId, rooms[roomId].players.find(p => !p.isDead && !p.isSpectator));
    else { rooms[roomId].gameState = 'playing'; advanceTurn(roomId, 1); updateAll(roomId); }
}
function finishRound(roomId, w) { io.to(roomId).emit('gameOver', { winner: w.name }); delete rooms[roomId]; }

function startCountdown(roomId) {
    const room = rooms[roomId]; room.gameState = 'playing'; createDeck(roomId);
    room.discardPile = [room.deck.pop()]; room.activeColor = room.discardPile[0].color;
    room.players.forEach((p, i) => { 
        if(!p.isSpectator) { p.hand = []; drawCards(room, p, 7); p.isDead = false; } 
    });
    updateAll(roomId);
}

function updateAll(roomId) {
    const room = rooms[roomId]; if(!room) return;
    
    // Lista de denunciables (1 carta, sin anunciar, pasaron 2 segundos)
    const canBeReportedList = room.players
        .filter(p => !p.isDead && !p.isSpectator && p.hand.length === 1 && !p.saidUno && (Date.now() - p.lastOneCardTime > 2000))
        .map(p => p.id);
    
    room.players.forEach(p => {
        const pack = { 
            state: room.gameState, roomId, iamAdmin: p.isAdmin, 
            players: room.players.map(pl => ({ 
                id: pl.id, name: pl.name, cardCount: pl.hand.length, 
                isTurn: (room.players[room.currentTurn].id === pl.id), 
                isDead: pl.isDead, isSpectator: pl.isSpectator, isConnected: pl.isConnected 
            })), 
            topCard: room.discardPile[room.discardPile.length-1], 
            activeColor: room.activeColor, 
            pendingPenalty: room.pendingPenalty,
            pendingSkip: room.pendingSkip,
            duelInfo: (['dueling','rip_decision','penalty_decision'].includes(room.gameState) ? room.duelState : null),
            libreInfo: (room.gameState.startsWith('libre') ? { step: room.gameState, victim: room.libreState.victimId } : null),
            chatHistory: room.chatHistory,
            reportTargets: canBeReportedList
        };
        io.to(p.id).emit('updateState', pack); io.to(p.id).emit('handUpdate', p.hand);
    });
}

// --- CLIENTE HTML ---
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>UNO y 1/2 v11.5</title>
    <style>
        body { margin: 0; font-family: 'Segoe UI', sans-serif; background: #1e272e; color: white; overflow: hidden; height: 100vh; display: flex; flex-direction: column; }
        .screen { display: none; flex-direction: column; align-items: center; justify-content: center; height: 100%; width: 100%; position: absolute; top:0; left:0; z-index:10; }
        .btn { padding: 12px 24px; border-radius: 25px; border: none; font-weight: bold; cursor: pointer; color: white; font-size: 14px; box-shadow: 0 4px 6px rgba(0,0,0,0.3); transition: transform 0.1s; margin: 5px; }
        .btn:active { transform: scale(0.95); }
        .input-box { padding: 12px; border-radius: 8px; border: none; margin-bottom: 10px; text-align: center; }

        /* JUEGO */
        #game-area { display: none; flex-direction: column; height: 100%; position: relative; }
        #players { display: flex; justify-content: center; flex-wrap: wrap; gap: 8px; padding: 10px; background: rgba(0,0,0,0.2); }
        .player { padding: 4px 10px; border-radius: 12px; background: #333; font-size: 11px; border: 1px solid #555; opacity: 0.8; }
        .is-turn { background: #2ecc71; border-color: white; transform: scale(1.1); opacity: 1; z-index: 5; }
        .is-dead { text-decoration: line-through; color: #7f8c8d; }
        
        #table { flex: 1; display: flex; justify-content: center; align-items: center; gap: 20px; position: relative; }
        .card { width: 75px; height: 110px; border-radius: 8px; border: 2px solid white; display: flex; justify-content: center; align-items: center; font-size: 24px; font-weight: bold; background: #333; position: relative; transition: 0.2s; box-shadow: 0 5px 15px rgba(0,0,0,0.5); }
        
        #hand { height: 160px; display: flex; align-items: center; padding: 0 15px; gap: -20px; overflow-x: auto; background: rgba(0,0,0,0.6); border-top: 1px solid #555; }
        .hand-card { flex-shrink: 0; margin-right: 5px; cursor: pointer; user-select: none; -webkit-touch-callout: none; transition: transform 0.2s; }
        .hand-card.selected { transform: translateY(-30px); border: 3px solid #00d2ff !important; box-shadow: 0 0 15px #00d2ff; }
        
        #controls { position: fixed; bottom: 170px; width: 100%; display: flex; justify-content: center; pointer-events: none; gap: 10px; z-index: 20; }
        .control-btn { pointer-events: auto; }
        
        #uno-btn { position: fixed; bottom: 180px; left: 10px; width: 60px; height: 60px; border-radius: 50%; background: #e67e22; border: 3px solid white; font-weight: bold; z-index: 30; font-size: 11px; display: flex; align-items: center; justify-content: center; text-align: center; box-shadow: 0 0 10px orange; cursor: pointer; }
        #uno-menu { display: none; position: fixed; bottom: 250px; left: 20px; background: rgba(0,0,0,0.9); padding: 10px; border-radius: 10px; z-index: 40; flex-direction: column; width: 160px; }

        #rip-overlay, #color-picker, #manual-overlay, #rules-overlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.95); z-index: 100; display: none; flex-direction: column; align-items: center; justify-content: center; text-align: center; overflow-y: auto; }
        .color-circle { width: 60px; height: 60px; border-radius: 50%; margin: 10px; display: inline-block; border: 2px solid white; cursor: pointer; }
        
        /* MANUAL y REGLAS */
        .modal-content { width: 90%; max-width: 600px; background: #2c3e50; padding: 20px; border-radius: 10px; text-align: left; margin: 20px 0; border: 1px solid #7f8c8d; }
        .card-preview { display: inline-block; width: 40px; height: 60px; border: 1px solid white; margin-right: 10px; vertical-align: middle; text-align: center; font-size: 12px; line-height: 60px; font-weight: bold; border-radius: 4px; }
        
        #selection-indicator { display: none; position: fixed; bottom: 140px; width: 100%; text-align: center; color: #00d2ff; font-weight: bold; text-shadow: 0 0 5px black; pointer-events: none; }
        #cancel-select-btn { display: none; position: fixed; bottom: 200px; right: 20px; width: 50px; height: 50px; border-radius: 50%; background: #e74c3c; border: 2px solid white; z-index: 30; line-height: 45px; font-size: 20px; cursor: pointer; }
    </style>
</head>
<body>
    <div id="login" class="screen" style="display:flex;">
        <h1 style="color: gold; text-shadow: 2px 2px 0 #000;">UNO y 1/2</h1>
        <input id="name-in" type="text" class="input-box" placeholder="Tu Nombre">
        <button class="btn" style="background: #27ae60; width: 200px;" onclick="createRoom()">CREAR SALA</button>
        <p>o</p>
        <input id="code-in" type="text" class="input-box" placeholder="CÓDIGO SALA" style="text-transform:uppercase;">
        <button class="btn" style="background: #2980b9; width: 200px;" onclick="joinRoom()">UNIRSE</button>
    </div>

    <div id="lobby" class="screen">
        <button class="btn" style="position: absolute; top: 10px; right: 10px; background: #8e44ad;" onclick="openManual()">📖 MANUAL DEL JUEGO</button>
        <h2 style="color: #ecf0f1;">SALA: <span id="room-id-display" style="color: gold;"></span></h2>
        <div id="lobby-list" style="margin: 20px;"></div>
        <p id="wait-msg">Esperando al administrador...</p>
        <button id="start-btn" class="btn" style="background: #2ecc71; display: none;" onclick="socket.emit('requestStart')">EMPEZAR PARTIDA</button>
    </div>

    <div id="game-area">
        <div id="players"></div>
        <div id="table">
            <div id="deck" class="card" style="background: #c0392b; cursor: pointer;" onclick="draw()">📦</div>
            <div id="top-card" class="card"></div>
        </div>
        
        <div id="selection-indicator">MODO SELECCIÓN MÚLTIPLE ACTIVO</div>
        <button id="cancel-select-btn" onclick="cancelSelect()">✕</button>

        <div id="controls">
            <button id="btn-play-multi" class="btn control-btn" style="background: #2ecc71; display: none;" onclick="sendMulti()">JUGAR SELECCIÓN</button>
            <button id="btn-pass" class="btn control-btn" style="background: #f39c12; display: none;" onclick="passTurn()">PASAR TURNO</button>
            <button class="btn control-btn" style="background: #7f8c8d;" onclick="socket.emit('requestSort')">ORDENAR</button>
            <button class="btn control-btn" style="background: #8e44ad;" onclick="openRules()">📜 REGLAS</button>
        </div>
        
        <div id="uno-btn" onclick="toggleUnoMenu()">UNO<br>y 1/2</div>
        <div id="uno-menu">
            <button class="btn" style="background: #e67e22; margin-bottom:5px;" onclick="sayUno()">📢 ANUNCIAR</button>
            <div id="report-list"></div>
            <button class="btn" style="background: #c0392b;" onclick="toggleUnoMenu()">CERRAR</button>
        </div>

        <div id="hand"></div>
    </div>

    <div id="manual-overlay">
        <div class="modal-content">
            <h2 style="color: gold; text-align: center;">MANUAL DEL JUEGO</h2>
            <p><strong>Objetivo:</strong> Quedarse sin cartas. Grita "UNO y 1/2" cuando te quede una o serás penalizado.</p>
            <h3>Cartas Especiales</h3>
            <p><span class="card-preview" style="background:#000; color:red;">RIP</span> <strong>RIP:</strong> Reta a duelo a muerte. El perdedor queda ELIMINADO de la partida.</p>
            <p><span class="card-preview" style="background:#000; color:white;">LIB</span> <strong>LIBRE ALBEDRÍO:</strong> Defiende solo de +2, +4 y +12. Te permite regalar una carta, descartar y cambiar color.</p>
            <p><span class="card-preview" style="background:#000; color:purple;">SS</span> <strong>SALTEO SUPREMO:</strong> El siguiente pierde 4 turnos y roba 4 cartas. Si pierde el duelo de defensa, pierde 4 turnos y roba 8 cartas.</p>
            <p><span class="card-preview" style="background:#000; color:gold;">GD</span> <strong>GRACIA DIVINA:</strong> La defensa absoluta. Anula cualquier carta negra en tu contra (incluso RIP y Salteo).</p>
            <p><span class="card-preview" style="background:#000; color:blue;">+12</span> <strong>+12:</strong> El siguiente roba 12 cartas. Puede batirse a duelo para intentar reflejar el castigo (+16 si pierde).</p>
            <h3>Combos</h3>
            <p><strong>Escalera:</strong> Selecciona varias cartas del mismo color en orden (ej: 4, 5, 6) manteniendo pulsada una carta.</p>
            <br>
            <button class="btn" style="width: 100%; background: #34495e;" onclick="document.getElementById('manual-overlay').style.display='none'">CERRAR</button>
        </div>
    </div>

    <div id="rules-overlay">
        <div class="modal-content">
            <h2 style="color: gold; text-align: center;">REGLAS RÁPIDAS</h2>
            <ul>
                <li><strong>UNO y 1/2:</strong> Cuando te quede 1 carta, toca el botón naranja "ANUNCIAR". Tienes 2 segundos de inmunidad. Si no, ¡+2 cartas!</li>
                <li><strong>Selección Múltiple:</strong> Mantén pulsada una carta (0.8s) para seleccionar varias y jugar escaleras o combos.</li>
                <li><strong>Castigos Manuales:</strong> Si te tiran +4, +12 o Salteo, debes tocar el mazo para robar las cartas una por una.</li>
                <li><strong>Duelos:</strong> Puedes desafiar a quien te tire +12 o Salteo. Si ganas, le devuelves el castigo. Si pierdes, ¡se duplica!</li>
            </ul>
            <button class="btn" style="width: 100%; background: #34495e;" onclick="document.getElementById('rules-overlay').style.display='none'">CERRAR</button>
        </div>
    </div>

    <div id="rip-overlay">
        <h1 style="color: red; font-size: 40px; text-shadow: 0 0 10px black;">ATENCIÓN</h1>
        <h2 id="rip-msg" style="padding: 20px; color: #bdc3c7;"></h2>
        
        <div id="action-btns" style="display:none;">
            <button class="btn" style="background: red; border: 2px solid white; transform: scale(1.2);" onclick="decision('duel')">⚔️ BATIRSE A DUELO</button>
            <br><br>
            <button id="surrender-btn" class="btn" style="background: #333;" onclick="decision('surrender')">RENDIRSE</button>
            <button id="accept-btn" class="btn" style="background: #333; display:none;" onclick="decision('accept')">ACEPTAR CASTIGO</button>
            <p id="duel-note" style="font-size: 11px; color: #95a5a6; display:none;">Nota: batirse a duelo y perder implicará una penalidad extra para ti.</p>
        </div>

        <div id="duel-options" style="display:none; margin-top: 30px;">
            <p>ELIGE TU ARMA:</p>
            <button class="btn" style="font-size: 30px; background: transparent;" onclick="socket.emit('duelPick','fuego')">🔥</button>
            <button class="btn" style="font-size: 30px; background: transparent;" onclick="socket.emit('duelPick','hielo')">❄️</button>
            <button class="btn" style="font-size: 30px; background: transparent;" onclick="socket.emit('duelPick','agua')">💧</button>
        </div>
    </div>

    <div id="color-picker">
        <h3>ELIGE COLOR</h3>
        <div>
            <div class="color-circle" style="background: #e74c3c;" onclick="pickColor('rojo')"></div>
            <div class="color-circle" style="background: #3498db;" onclick="pickColor('azul')"></div>
            <div class="color-circle" style="background: #2ecc71;" onclick="pickColor('verde')"></div>
            <div class="color-circle" style="background: #f1c40f;" onclick="pickColor('amarillo')"></div>
        </div>
    </div>

    <script src="/socket.io/socket.io.js"></script>
    <script>
        const socket = io();
        let myUUID = localStorage.getItem('uno_uuid') || Math.random().toString(36).substring(2);
        localStorage.setItem('uno_uuid', myUUID);
        
        let selectedCards = [];
        let selectionMode = false;
        let pressTimer;
        let pendingCardId = null; 
        let currentGameState = '';

        const sounds = {
            pop: new Audio('https://cdn.freesound.org/previews/242/242501_4414128-lq.mp3'),
            alert: new Audio('https://cdn.freesound.org/previews/458/458587_5121236-lq.mp3')
        };
        sounds.pop.volume = 0.3;

        function showScreen(id) {
            document.querySelectorAll('.screen').forEach(s => s.style.display='none');
            document.getElementById('game-area').style.display='none';
            document.getElementById(id).style.display='flex';
        }
        function openManual() { document.getElementById('manual-overlay').style.display='flex'; }
        function openRules() { document.getElementById('rules-overlay').style.display='flex'; }

        socket.on('connect', () => socket.emit('checkSession', myUUID));
        socket.on('requireLogin', () => showScreen('login'));
        socket.on('roomCreated', d => { showScreen('lobby'); document.getElementById('room-id-display').innerText = d.roomId; });
        socket.on('roomJoined', d => { showScreen('lobby'); document.getElementById('room-id-display').innerText = d.roomId; });
        
        socket.on('updateState', s => {
            currentGameState = s.state;
            
            if(s.state === 'waiting') {
                showScreen('lobby');
                document.getElementById('lobby-list').innerHTML = s.players.map(p => \`<div>\${p.isConnected?'🟢':'🔴'} \${p.name} \${p.isSpectator?'(Esp)':''}</div>\`).join('');
                document.getElementById('start-btn').style.display = s.iamAdmin ? 'block' : 'none';
                document.getElementById('wait-msg').style.display = s.iamAdmin ? 'none' : 'block';
                return;
            }

            showScreen('game-area');
            renderPlayers(s);
            renderTable(s);
            handleOverlays(s);
            handleUnoMenu(s);

            const me = s.players.find(p => p.id === socket.id);
            document.getElementById('btn-pass').style.display = (me && me.isTurn && s.pendingPenalty === 0) ? 'block' : 'none';
            
            if(me && !me.isTurn && selectionMode) cancelSelect();
        });

        socket.on('handUpdate', hand => {
            const container = document.getElementById('hand');
            container.innerHTML = '';
            hand.forEach(c => {
                const el = document.createElement('div');
                el.className = \`card hand-card \${selectedCards.includes(c.id) ? 'selected' : ''}\`;
                el.style.backgroundColor = getHex(c.color);
                el.innerText = c.value;
                el.style.color = (c.color === 'negro') ? 'white' : 'black';
                if(['RIP','+12','SALTEO SUPREMO'].includes(c.value)) el.style.color = 'red';

                el.onmousedown = el.ontouchstart = (e) => {
                    if (e.type === 'touchstart') e.preventDefault();
                    pressTimer = setTimeout(() => {
                        if(!selectionMode) {
                            selectionMode = true;
                            if(navigator.vibrate) navigator.vibrate(50);
                            sounds.pop.play();
                            toggleSelect(c.id, el);
                        }
                    }, 800);
                };
                el.onmouseup = el.onmouseleave = el.ontouchend = () => clearTimeout(pressTimer);
                
                el.onclick = () => {
                    if (selectionMode) {
                        sounds.pop.play();
                        toggleSelect(c.id, el);
                    } else {
                        handleCardClick(c);
                    }
                };
                container.appendChild(el);
            });
        });

        function handleCardClick(c) {
            if (currentGameState === 'libre_give') {
                if (confirm(\`¿Regalar \${c.value}?\`)) socket.emit('libreAction', {type:'give', val: c.id});
                return;
            }
            if (currentGameState === 'libre_discard') {
                if (confirm(\`¿Descartar \${c.value}?\`)) socket.emit('libreAction', {type:'discard', val: c.id});
                return;
            }
            
            if (c.color === 'negro') {
                pendingCardId = c.id;
                if (c.value === 'LIBRE') socket.emit('playCard', c.id);
                else document.getElementById('color-picker').style.display = 'flex';
            } else {
                socket.emit('playCard', c.id);
            }
        }

        function renderPlayers(s) {
            document.getElementById('players').innerHTML = s.players.map(p => {
                let status = '';
                if(p.isDead) status = '💀';
                else if(p.isSpectator) status = '👁️';
                else if(!p.isConnected) status = '🔌';
                return \`<div class="player \${p.isTurn?'is-turn':''} \${p.isDead?'is-dead':''}" onclick="playerClick('\${p.id}', '\${s.state}')">\${p.name} (\${p.cardCount}) \${status}</div>\`;
            }).join('');
        }

        function playerClick(targetId, state) {
            if (state === 'libre_victim') {
                if(confirm('¿Elegir a este jugador para regalarle una carta?')) 
                    socket.emit('libreAction', {type:'victim', val: targetId});
            }
        }

        function renderTable(s) {
            const top = document.getElementById('top-card');
            top.innerText = s.topCard.value;
            top.style.backgroundColor = getHex(s.topCard.color);
            top.style.color = (s.topCard.color === 'negro') ? 'white' : 'black';
            document.body.style.backgroundColor = getHex(s.activeColor, true);
        }

        function handleOverlays(s) {
            const rip = document.getElementById('rip-overlay');
            const colorPick = document.getElementById('color-picker');
            
            if (s.state === 'libre_color' && s.players.find(p=>p.id===socket.id && p.isTurn)) {
                colorPick.style.display = 'flex';
                pendingCardId = null;
            } else if (s.state !== 'libre_color' && colorPick.style.display === 'flex' && !pendingCardId) {
                colorPick.style.display = 'none';
            }

            if (['rip_decision', 'penalty_decision', 'dueling'].includes(s.state)) {
                const duel = s.duelInfo;
                if (!duel) return;

                rip.style.display = 'flex';
                document.getElementById('rip-msg').innerText = duel.narrative;

                const isMe = (socket.id === duel.defenderId);
                const isAttacker = (socket.id === duel.attackerId);
                const actionDiv = document.getElementById('action-btns');
                const duelDiv = document.getElementById('duel-options');
                
                actionDiv.style.display = 'none';
                duelDiv.style.display = 'none';

                if (s.state === 'rip_decision' && isMe) {
                    actionDiv.style.display = 'block';
                    document.getElementById('surrender-btn').style.display = 'inline-block';
                    document.getElementById('accept-btn').style.display = 'none';
                    document.getElementById('duel-note').style.display = 'none';
                } 
                else if (s.state === 'penalty_decision' && isMe) {
                    actionDiv.style.display = 'block';
                    document.getElementById('surrender-btn').style.display = 'none';
                    document.getElementById('accept-btn').style.display = 'inline-block';
                    document.getElementById('duel-note').style.display = 'block';
                }
                else if (s.state === 'dueling') {
                     if ((isMe || isAttacker) && duel.turn === socket.id) {
                         duelDiv.style.display = 'block';
                     }
                }
            } else {
                rip.style.display = 'none';
            }
        }

        function handleUnoMenu(s) {
             const list = document.getElementById('report-list');
             list.innerHTML = '';
             if(s.reportTargets && s.reportTargets.length > 0) {
                 s.reportTargets.forEach(tid => {
                     const p = s.players.find(x => x.id === tid);
                     if(p) list.innerHTML += \`<button class="btn" style="background:red; width:100%; margin:2px;" onclick="socket.emit('reportUno', '\${tid}')">DENUNCIAR A \${p.name}</button>\`;
                 });
             } else {
                 list.innerHTML = '<p style="font-size:10px;">Nadie para denunciar</p>';
             }
        }

        function createRoom() { socket.emit('createRoom', { name: document.getElementById('name-in').value, uuid: myUUID }); }
        function joinRoom() { socket.emit('joinRoom', { roomId: document.getElementById('code-in').value, name: document.getElementById('name-in').value, uuid: myUUID }); }
        
        function draw() { socket.emit('draw'); }
        function passTurn() { socket.emit('passTurn'); }

        function toggleSelect(id, el) {
            if (selectedCards.includes(id)) {
                selectedCards = selectedCards.filter(i => i !== id);
                el.classList.remove('selected');
            } else {
                selectedCards.push(id);
                el.classList.add('selected');
            }
            updateSelectUI();
        }

        function updateSelectUI() {
            const active = selectedCards.length > 0;
            document.getElementById('btn-play-multi').style.display = (selectedCards.length >= 2) ? 'block' : 'none';
            document.getElementById('cancel-select-btn').style.display = active ? 'block' : 'none';
            document.getElementById('selection-indicator').style.display = active ? 'block' : 'none';
            if (!active) selectionMode = false;
        }

        function cancelSelect() {
            selectedCards = []; selectionMode = false; updateSelectUI();
            document.querySelectorAll('.hand-card').forEach(c => c.classList.remove('selected'));
        }

        function sendMulti() { socket.emit('playMultiCards', selectedCards); cancelSelect(); }

        function pickColor(c) {
            if (currentGameState === 'libre_color') socket.emit('libreAction', {type:'color', val: c});
            else socket.emit('playCard', pendingCardId, c); 
            document.getElementById('color-picker').style.display = 'none';
        }

        function decision(action) {
            if (currentGameState === 'rip_decision') socket.emit('ripDecision', action);
            if (currentGameState === 'penalty_decision') socket.emit('penaltyDecision', action);
        }
        
        function toggleUnoMenu() {
            const m = document.getElementById('uno-menu');
            m.style.display = (m.style.display === 'flex') ? 'none' : 'flex';
        }
        function sayUno() { socket.emit('sayUno'); toggleUnoMenu(); }

        function getHex(c, dark = false) {
            const colors = { rojo: '#e74c3c', azul: '#3498db', verde: '#2ecc71', amarillo: '#f1c40f', negro: '#2d3436' };
            const darkColors = { rojo: '#4a1c1c', azul: '#1c2a4a', verde: '#1c4a2a', amarillo: '#4a451c', negro: '#1e272e' };
            return (dark ? darkColors[c] : colors[c]) || '#1e272e';
        }
        
        socket.on('notification', m => { sounds.alert.play(); alert(m); });
        socket.on('error', m => alert(m));
        socket.on('gameOver', d => { alert("🏆 ¡GANADOR: " + d.winner + "!"); location.reload(); });
    </script>
</body>
</html>
    `);
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Servidor v11.5 corriendo en puerto ${PORT}`));
