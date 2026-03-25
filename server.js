const express = require('express');
const app = express();
const http = require('http').createServer(app);
const path = require('path');

// Servir archivos estáticos desde la carpeta 'public'
app.use(express.static(path.join(__dirname, 'public')));

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
                if (rooms[roomId].countdownInterval) clearInterval(rooms[roomId].countdownInterval);
                delete rooms[roomId]; 
            }
        });
    } catch (e) { console.error("Error en limpieza:", e); }
}, 60000 * 5); 

// --- FUNCIONES DEL SERVIDOR ---

function initRoom(roomId) {
    rooms[roomId] = {
        gameState: 'waiting', 
        players: [], deck: [], discardPile: [],
        currentTurn: 0, roundStarterIndex: 0, direction: 1,
        activeColor: '', pendingPenalty: 0, pendingSkip: 0,
        scores: {}, roundCount: 1,
        duelState: { 
            attackerId: null, defenderId: null, attackerName: '', defenderName: '', 
            round: 1, scoreAttacker: 0, scoreDefender: 0, 
            attackerChoice: null, defenderChoice: null, history: [], turn: null, narrative: '',
            type: 'rip', originalPenalty: 0, originalSkip: 0, triggerCard: null
        },
        chatHistory: [], lastActivity: Date.now(),
        actionTimer: null, turnTimer: null, afkTimer: null, timerEndsAt: null, countdownInterval: null,
        resumeTurnFrom: null, interruptedTurn: false 
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
                if (room.gameState === 'libre_choosing') room.gameState = 'playing';
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
            io.to(roomId).emit('notification', `⏳ Tiempo agotado. ${target.name} perdió la chance de batirse a duelo y recibe el castigo automáticamente.`);
            room.gameState = 'playing';
            updateAll(roomId);
        } 
        else if (stateContext === 'rip_decision' && room.gameState === 'rip_decision') {
            io.to(roomId).emit('notification', `⏳ Tiempo agotado. ${target.name} se quedó paralizado por el miedo y fue eliminado.`);
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

    if ((room.gameState === 'playing' || room.gameState === 'libre_choosing') && getAlivePlayersCount(roomId) > 1) {
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

function advanceTurn(roomId, steps) {
    const room = rooms[roomId]; if (!room || room.players.length === 0) return;
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
    const room = rooms[roomId]; if (!room || room.players.length < 2) return;
    room.gameState = 'counting'; room.resumeTurnFrom = null; createDeck(roomId);
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
    room.interruptedTurn = false;
    
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
    const room = rooms[roomId]; if (!room || pid < 0 || pid >= room.players.length) return; 
    for (let i = 0; i < n; i++) { if (room.deck.length === 0) recycleDeck(roomId); if (room.deck.length > 0) room.players[pid].hand.push(room.deck.pop()); } 
    checkUnoCheck(roomId, room.players[pid]);
}

function calculateAndFinishRound(roomId, winner) {
    try {
        const room = rooms[roomId]; if(!room) return;
        
        if (room.actionTimer) clearTimeout(room.actionTimer);
        if (room.turnTimer) clearTimeout(room.turnTimer);
        if (room.afkTimer) clearTimeout(room.afkTimer);
        room.timerEndsAt = null;

        let pointsAccumulated = 0; let losersDetails = [];
        const lastCard = room.discardPile.length > 0 ? room.discardPile[room.discardPile.length - 1] : null;
        let bonus = 0; if (lastCard && lastCard.value === 'GRACIA') bonus = 50;

        // AJUSTE 5: Gracia Divina en Ranking (no da puntos y se avisa)
        let graceSavedPlayers = []; 
        room.players.forEach(p => {
            if (p.uuid !== winner.uuid && !p.isSpectator && !p.hasLeft) { 
                const hasGrace = p.hand.some(c => c.value === 'GRACIA');
                let pPoints = 0; 
                if (!hasGrace) { 
                    pPoints = p.hand.reduce((acc, c) => acc + getCardPoints(c), 0); 
                } else {
                    graceSavedPlayers.push(p.name);
                }
                if(pPoints > 0) { pointsAccumulated += pPoints; losersDetails.push({ name: p.name + (p.isDead ? " (RIP)" : ""), points: pPoints }); }
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
            setTimeout(() => { delete rooms[roomId]; }, 10000);
        } else {
            room.gameState = 'round_over'; room.roundCount++;
            
            const leaderboard = Object.keys(room.scores).map(uid => {
                const pl = room.players.find(x => x.uuid === uid && !x.hasLeft); 
                if(pl) return { name: pl.name, score: room.scores[uid] }; return null;
            }).filter(x=>x).sort((a,b) => b.score - a.score);

            if(graceSavedPlayers.length > 0) {
                io.to(roomId).emit('notification', `✨ Gracia Divina protegió a: ${graceSavedPlayers.join(", ")}. ¡No dan puntos!`);
            }

            io.to(roomId).emit('roundOver', { winner: winner.name, roundPoints: pointsAccumulated, losersDetails: losersDetails, leaderboard: leaderboard, winnerTotal: winnerTotal });
            io.to(roomId).emit('playSound', 'win');

            // AJUSTE 5: Animaciones de Ranking (12 segundos)
            const animationDelay = 12000; 
            setTimeout(() => { try { if(rooms[roomId]) resetRound(roomId); } catch(e){} }, animationDelay);
        }
    } catch(e) { console.error("Error en calc round:", e); try { if(rooms[roomId]) resetRound(roomId); } catch(err){} }
}

function resetRound(roomId) {
    try {
        const room = rooms[roomId]; if(!room) return;
        room.resumeTurnFrom = null;
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
        
        room.direction = 1; room.pendingPenalty = 0; room.pendingSkip = 0; room.interruptedTurn = false; room.gameState = 'playing';

        room.players.forEach(p => { 
            if(p.hasLeft) return;
            p.hand = []; p.hasDrawn = false; p.isDead = false; p.isSpectator = false; p.saidUno = false; p.missedTurns = 0;
            for (let i = 0; i < 7; i++) drawCards(roomId, room.players.indexOf(p), 1); 
        });

        startCountdown(roomId);
    } catch (e) { console.error("Error en resetRound:", e); }
}

function checkWinCondition(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    if (room.gameState === 'waiting') {
        updateAll(roomId);
        return;
    }
    const presentPlayers = room.players.filter(p => !p.isSpectator && !p.hasLeft);
    const alivePlayers = presentPlayers.filter(p => !p.isDead);

    if (presentPlayers.length <= 1) {
        const winner = presentPlayers || room.players.find(p => !p.hasLeft);
        if (winner) {
            room.gameState = 'game_over';
            setTimeout(() => {
                if (!rooms[roomId]) return;
                io.to(roomId).emit('gameOver', { 
                    winner: winner.name, 
                    totalScore: room.scores[winner.uuid] || 0,
                    reason: 'desertion' 
                });
                io.to(roomId).emit('playSound', 'win');
                if (room.actionTimer) clearTimeout(room.actionTimer);
                if (room.turnTimer) clearTimeout(room.turnTimer);
                if (room.afkTimer) clearTimeout(room.afkTimer);
                setTimeout(() => { delete rooms[roomId]; }, 10000);
            }, 3000);
        }
    } 
    else if (alivePlayers.length === 1 && presentPlayers.length > 1) {
        const roundWinner = alivePlayers;
        calculateAndFinishRound(roomId, roundWinner);
    }
}

function updateAll(roomId) {
    try {
        const room = rooms[roomId]; if(!room) return;
        let lastRoundWinner = ""; if (room.duelState.history.length > 0) { lastRoundWinner = room.duelState.history[room.duelState.history.length - 1].winnerName; }
        const reportablePlayers = room.players.filter(p => !p.isDead && !p.isSpectator && !p.hasLeft && p.hand.length === 1 && !p.saidUno && (Date.now() - p.lastOneCardTime > 2000)).map(p => p.id);
        const duelInfo = (['dueling','rip_decision','penalty_decision'].includes(room.gameState)) ? { attackerName: room.duelState.attackerName, defenderName: room.duelState.defenderName, round: room.duelState.round, scoreAttacker: room.duelState.scoreAttacker, scoreDefender: room.duelState.scoreDefender, history: room.duelState.history, attackerId: room.duelState.attackerId, defenderId: room.duelState.defenderId, myChoice: null, turn: room.duelState.turn, lastWinner: lastRoundWinner, narrative: room.duelState.narrative, type: room.duelState.type, triggerCard: room.duelState.triggerCard } : null;

        const leaderboard = Object.keys(room.scores).map(uid => {
            const pl = room.players.find(x => x.uuid === uid && !x.hasLeft); 
            if(pl) return { name: pl.name, score: room.scores[uid] }; return null;
        }).filter(x=>x).sort((a,b) => b.score - a.score);

        const activePlayers = room.players.filter(p => !p.hasLeft);

        const pack = { state: room.gameState, roomId: roomId, players: activePlayers.map((p) => {
            const pIndex = room.players.findIndex(x => x.uuid === p.uuid);
            return { name: p.name + (p.isAdmin ? " 👑" : "") + (p.isSpectator ? " 👁️" : ""), uuid: p.uuid, cardCount: p.hand.length, id: p.id, isTurn: (room.gameState === 'playing' && pIndex === room.currentTurn), hasDrawn: p.hasDrawn, isDead: p.isDead, isSpectator: p.isSpectator, isAdmin: p.isAdmin, isConnected: p.isConnected };
        }), topCard: room.discardPile.length > 0 ? room.discardPile[room.discardPile.length - 1] : null, activeColor: room.activeColor, currentTurn: room.currentTurn, duelInfo, pendingPenalty: room.pendingPenalty, chatHistory: room.chatHistory, reportTargets: reportablePlayers, leaderboard: leaderboard, timerEndsAt: room.timerEndsAt };
        
        activePlayers.forEach(p => {
            if(p.isConnected) {
                const mp = JSON.parse(JSON.stringify(pack)); mp.iamAdmin = p.isAdmin;
                if (mp.duelInfo) { if (p.uuid === room.duelState.attackerId) mp.duelInfo.myChoice = room.duelState.attackerChoice; if (p.uuid === room.duelState.defenderId) mp.duelInfo.myChoice = room.duelState.defenderChoice; }
                io.to(p.id).emit('updateState', mp); if (!p.isSpectator || p.isDead) io.to(p.id).emit('handUpdate', p.hand); io.to(p.id).emit('chatHistory', room.chatHistory);
            }
        });
        
        manageTimers(roomId); 
    } catch(e) { console.error("Error UpdateAll:", e); }
}

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
            if (player.hand.length === 0) {
                room.gameState = 'animating_win'; updateAll(roomId);
                setTimeout(() => calculateAndFinishRound(roomId, player), 1000);
                return;
            }
            room.gameState = 'penalty_decision';
            room.duelState = { 
                attackerId: player.uuid, defenderId: victim.uuid, attackerName: player.name, defenderName: victim.name, 
                round: 1, scoreAttacker: 0, scoreDefender: 0, attackerChoice: null, defenderChoice: null, history: [], 
                turn: player.uuid, narrative: `⚔️ ¡${victim.name} puede batirse a duelo para evitar el castigo!`, type: 'penalty', originalPenalty: room.pendingPenalty, originalSkip: room.pendingSkip, triggerCard: card.value 
            };
            room.currentTurn = nextPIdx; updateAll(roomId); return;
        }
        
        if (player.hand.length === 0) {
            room.gameState = 'animating_win'; updateAll(roomId);
            setTimeout(() => calculateAndFinishRound(roomId, player), 1000);
        } else {
            advanceTurn(roomId, 1); updateAll(roomId);
        }
        return; 
    }
    
    if (card.color === 'negro') io.to(roomId).emit('playSound', 'wild'); else io.to(roomId).emit('playSound', 'soft');
    
    if (player.hand.length === 0) {
        room.gameState = 'animating_win'; updateAll(roomId); 
        setTimeout(() => calculateAndFinishRound(roomId, player), 1000); 
    } else { advanceTurn(roomId, steps); updateAll(roomId); }
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

function resolveDuelRound(roomId, isTimeout = false) {
    try {
        const room = rooms[roomId]; if (!room) return;
        let att = room.duelState.attackerChoice;
        let def = room.duelState.defenderChoice;
        let winner = 'tie';

        if (isTimeout) {
            if (!att) {
                winner = 'defender';
                room.duelState.narrative = `⏳ ${room.duelState.defenderName} ganó la ronda porque ${room.duelState.attackerName} tardó mucho en elegir.`;
            } else if (!def) {
                winner = 'attacker';
                room.duelState.narrative = `⏳ ${room.duelState.attackerName} ganó la ronda porque ${room.duelState.defenderName} tardó mucho en elegir.`;
            }
        } else {
            if ((att == 'fuego' && def == 'hielo') || (att == 'hielo' && def == 'agua') || (att == 'agua' && def == 'fuego')) winner = 'attacker';
            else if ((def == 'fuego' && att == 'hielo') || (def == 'hielo' && def == 'agua') || (def == 'agua' && att == 'fuego')) winner = 'defender';
            room.duelState.narrative = getDuelNarrative(room.duelState.attackerName, room.duelState.defenderName, att, def);
            
            io.to(roomId).emit('duelClash', { att, def, attName: room.duelState.attackerName, defName: room.duelState.defenderName, winner });
        }
        
        if (winner == 'attacker') room.duelState.scoreAttacker++; else if (winner == 'defender') room.duelState.scoreDefender++;
        
        let winNameToHistory = 'Empate'; 
        if(winner === 'attacker') winNameToHistory = room.duelState.attackerName; 
        if(winner === 'defender') winNameToHistory = room.duelState.defenderName;

        room.duelState.history.push({ round: room.duelState.round, att: att || 'timeout', def: def || 'timeout', winnerName: winNameToHistory });
        room.duelState.attackerChoice = null; room.duelState.defenderChoice = null; room.duelState.turn = room.duelState.attackerId; 
        
        io.to(roomId).emit('playSound', 'soft');
        
        if (room.duelState.scoreAttacker >= 2 || room.duelState.scoreDefender >= 2) { 
            setTimeout(() => finalizeDuel(roomId), 3000); 
        } else { 
            setTimeout(() => { 
                try {
                    if(rooms[roomId]) { 
                        rooms[roomId].duelState.round++; 
                        rooms[roomId].duelState.narrative = `Ronda ${rooms[roomId].duelState.round}: ${rooms[roomId].duelState.attackerName} elige arma...`; 
                        updateAll(roomId); 
                    } 
                } catch(e){}
            }, 4000); 
        }
        updateAll(roomId); 
    } catch (e) { console.error("Error en resolveDuelRound:", e); }
}

function finalizeDuel(roomId) {
    try {
        const room = rooms[roomId]; if (!room) return;
        const att = room.players.find(p => p.uuid === room.duelState.attackerId); const def = room.players.find(p => p.uuid === room.duelState.defenderId);
        if (!att || !def) { room.gameState = 'playing'; updateAll(roomId); return; }
        const attWins = room.duelState.scoreAttacker > room.duelState.scoreDefender; const isPenaltyDuel = room.duelState.type === 'penalty';

        if (attWins) {
            io.to(roomId).emit('notification', `💀 ${att.name} GANA el duelo.`);
            if (!isPenaltyDuel) {
                eliminatePlayer(roomId, def.uuid);
                checkWinCondition(roomId);
                if (rooms[roomId] && rooms[roomId].gameState !== 'game_over' && rooms[roomId].gameState !== 'round_over') {
                    room.gameState = 'playing';
                    room.currentTurn = room.players.indexOf(att);
                    advanceTurn(roomId, 1);
                    updateAll(roomId);
                }
            }
            else {
                // AJUSTE 4: Castigo acumulado y pérdida de turnos real
                const totalCastigo = room.pendingPenalty + 4;
                const totalSkips = room.pendingSkip; 
                
                io.to(roomId).emit('notification', `🩸 ¡Castigo AUMENTADO! ${def.name} recibe ${totalCastigo} cartas y pierde sus turnos.`);
                drawCards(roomId, room.players.indexOf(def), totalCastigo);
                
                if (totalSkips > 0) def.missedTurns += totalSkips;

                room.pendingPenalty = 0; room.pendingSkip = 0;
                room.gameState = 'playing';
                room.currentTurn = room.players.indexOf(def);
                advanceTurn(roomId, 1); 
                updateAll(roomId);
            }
        } else {
            io.to(roomId).emit('notification', `🛡️ ${def.name} GANA el duelo.`);
            if (!isPenaltyDuel) {
                io.to(roomId).emit('notification', `🩸 ¡${att.name} falló y debe recoger 4 cartas!`);
                room.pendingPenalty = 4; room.pendingSkip = 0;
                room.currentTurn = room.players.indexOf(att);
                room.resumeTurnFrom = room.players.indexOf(def);
                room.gameState = 'playing'; updateAll(roomId);
            }
            else {
                io.to(roomId).emit('notification', `✨ ¡${def.name} devuelve el ataque! Castigo anulado y ${att.name} roba 4.`);
                drawCards(roomId, room.players.indexOf(att), 4);
                room.pendingPenalty = 0; room.pendingSkip = 0;

                room.gameState = 'playing';
                room.currentTurn = room.players.indexOf(def);
                advanceTurn(roomId, 1);
                updateAll(roomId);
            }
        }
    } catch (e) { console.error("Error en finalizeDuel:", e); }
}

function eliminatePlayer(roomId, uuid) { 
    const room = rooms[roomId]; if(!room) return; 
    const p = room.players.find(p => p.uuid === uuid); 
    if (p) { p.isDead = true; } 
}

function getAlivePlayersCount(roomId) { const room = rooms[roomId]; if(!room) return 0; return room.players.filter(p => !p.isDead && !p.isSpectator && !p.hasLeft).length; }

function getNextPlayerIndex(roomId, step) {
    const room = rooms[roomId]; if(!room) return 0; let current = room.currentTurn;
    for(let i=0; i<room.players.length; i++) {
        current = (current + room.direction + room.players.length) % room.players.length;
        if(!room.players[current].isDead && !room.players[current].isSpectator && !room.players[current].hasLeft) return current;
    }
    return current;
}
const presentPlayers = room.players.filter(p => !p.isSpectator && !p.hasLeft);
    const alivePlayers = presentPlayers.filter(p => !p.isDead);

    if (presentPlayers.length <= 1) {
        const winner = presentPlayers || room.players.find(p => !p.hasLeft);
        if (winner) {
            room.gameState = 'game_over';
            setTimeout(() => {
                if (!rooms[roomId]) return;
                io.to(roomId).emit('gameOver', { 
                    winner: winner.name, 
                    totalScore: room.scores[winner.uuid] || 0,
                    reason: 'desertion' 
                });
                io.to(roomId).emit('playSound', 'win');
                if (room.actionTimer) clearTimeout(room.actionTimer);
                if (room.turnTimer) clearTimeout(room.turnTimer);
                if (room.afkTimer) clearTimeout(room.afkTimer);
                setTimeout(() => { delete rooms[roomId]; }, 10000);
            }, 3000);
        }
    } 
    else if (alivePlayers.length === 1 && presentPlayers.length > 1) {
        const roundWinner = alivePlayers;
        calculateAndFinishRound(roomId, roundWinner);
    }
}

function updateAll(roomId) {
    try {
        const room = rooms[roomId]; if(!room) return;
        let lastRoundWinner = ""; if (room.duelState.history.length > 0) { lastRoundWinner = room.duelState.history[room.duelState.history.length - 1].winnerName; }
        const reportablePlayers = room.players.filter(p => !p.isDead && !p.isSpectator && !p.hasLeft && p.hand.length === 1 && !p.saidUno && (Date.now() - p.lastOneCardTime > 2000)).map(p => p.id);
        const duelInfo = (['dueling','rip_decision','penalty_decision'].includes(room.gameState)) ? { attackerName: room.duelState.attackerName, defenderName: room.duelState.defenderName, round: room.duelState.round, scoreAttacker: room.duelState.scoreAttacker, scoreDefender: room.duelState.scoreDefender, history: room.duelState.history, attackerId: room.duelState.attackerId, defenderId: room.duelState.defenderId, myChoice: null, turn: room.duelState.turn, lastWinner: lastRoundWinner, narrative: room.duelState.narrative, type: room.duelState.type, triggerCard: room.duelState.triggerCard } : null;

        const leaderboard = Object.keys(room.scores).map(uid => {
            const pl = room.players.find(x => x.uuid === uid && !x.hasLeft); 
            if(pl) return { name: pl.name, score: room.scores[uid] }; return null;
        }).filter(x=>x).sort((a,b) => b.score - a.score);

        const activePlayers = room.players.filter(p => !p.hasLeft);

        const pack = { state: room.gameState, roomId: roomId, players: activePlayers.map((p) => {
            const pIndex = room.players.findIndex(x => x.uuid === p.uuid);
            return { name: p.name + (p.isAdmin ? " 👑" : "") + (p.isSpectator ? " 👁️" : ""), uuid: p.uuid, cardCount: p.hand.length, id: p.id, isTurn: (room.gameState === 'playing' && pIndex === room.currentTurn), hasDrawn: p.hasDrawn, isDead: p.isDead, isSpectator: p.isSpectator, isAdmin: p.isAdmin, isConnected: p.isConnected };
        }), topCard: room.discardPile.length > 0 ? room.discardPile[room.discardPile.length - 1] : null, activeColor: room.activeColor, currentTurn: room.currentTurn, duelInfo, pendingPenalty: room.pendingPenalty, chatHistory: room.chatHistory, reportTargets: reportablePlayers, leaderboard: leaderboard, timerEndsAt: room.timerEndsAt };
        
        activePlayers.forEach(p => {
            if(p.isConnected) {
                const mp = JSON.parse(JSON.stringify(pack)); mp.iamAdmin = p.isAdmin;
                if (mp.duelInfo) { if (p.uuid === room.duelState.attackerId) mp.duelInfo.myChoice = room.duelState.attackerChoice; if (p.uuid === room.duelState.defenderId) mp.duelInfo.myChoice = room.duelState.defenderChoice; }
                io.to(p.id).emit('updateState', mp); if (!p.isSpectator || p.isDead) io.to(p.id).emit('handUpdate', p.hand); io.to(p.id).emit('chatHistory', room.chatHistory);
            }
        });
        
        manageTimers(roomId); 
    } catch(e) { console.error("Error UpdateAll:", e); }
}

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
            if (player.hand.length === 0) {
                room.gameState = 'animating_win'; updateAll(roomId);
                setTimeout(() => calculateAndFinishRound(roomId, player), 1000);
                return;
            }
            room.gameState = 'penalty_decision';
            room.duelState = { 
                attackerId: player.uuid, defenderId: victim.uuid, attackerName: player.name, defenderName: victim.name, 
                round: 1, scoreAttacker: 0, scoreDefender: 0, attackerChoice: null, defenderChoice: null, history: [], 
                turn: player.uuid, narrative: `⚔️ ¡${victim.name} puede batirse a duelo para evitar el castigo!`, type: 'penalty', originalPenalty: room.pendingPenalty, originalSkip: room.pendingSkip, triggerCard: card.value 
            };
            room.currentTurn = nextPIdx; updateAll(roomId); return;
        }
        
        if (player.hand.length === 0) {
            room.gameState = 'animating_win'; updateAll(roomId);
            setTimeout(() => calculateAndFinishRound(roomId, player), 1000);
        } else {
            advanceTurn(roomId, 1); updateAll(roomId);
        }
        return; 
    }
    
    if (card.color === 'negro') io.to(roomId).emit('playSound', 'wild'); else io.to(roomId).emit('playSound', 'soft');
    
    if (player.hand.length === 0) {
        room.gameState = 'animating_win'; updateAll(roomId); 
        setTimeout(() => calculateAndFinishRound(roomId, player), 1000); 
    } else { advanceTurn(roomId, steps); updateAll(roomId); }
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

function resolveDuelRound(roomId, isTimeout = false) {
    try {
        const room = rooms[roomId]; if (!room) return;
        let att = room.duelState.attackerChoice;
        let def = room.duelState.defenderChoice;
        let winner = 'tie';

        if (isTimeout) {
            if (!att) {
                winner = 'defender';
                room.duelState.narrative = `⏳ ${room.duelState.defenderName} ganó la ronda porque ${room.duelState.attackerName} tardó mucho en elegir.`;
            } else if (!def) {
                winner = 'attacker';
                room.duelState.narrative = `⏳ ${room.duelState.attackerName} ganó la ronda porque ${room.duelState.defenderName} tardó mucho en elegir.`;
            }
        } else {
            if ((att == 'fuego' && def == 'hielo') || (att == 'hielo' && def == 'agua') || (att == 'agua' && def == 'fuego')) winner = 'attacker';
            else if ((def == 'fuego' && att == 'hielo') || (def == 'hielo' && def == 'agua') || (def == 'agua' && att == 'fuego')) winner = 'defender';
            room.duelState.narrative = getDuelNarrative(room.duelState.attackerName, room.duelState.defenderName, att, def);
            
            io.to(roomId).emit('duelClash', { att, def, attName: room.duelState.attackerName, defName: room.duelState.defenderName, winner });
        }
        
        if (winner == 'attacker') room.duelState.scoreAttacker++; else if (winner == 'defender') room.duelState.scoreDefender++;
        
        let winNameToHistory = 'Empate'; 
        if(winner === 'attacker') winNameToHistory = room.duelState.attackerName; 
        if(winner === 'defender') winNameToHistory = room.duelState.defenderName;

        room.duelState.history.push({ round: room.duelState.round, att: att || 'timeout', def: def || 'timeout', winnerName: winNameToHistory });
        room.duelState.attackerChoice = null; room.duelState.defenderChoice = null; room.duelState.turn = room.duelState.attackerId; 
        
        io.to(roomId).emit('playSound', 'soft');
        
        if (room.duelState.scoreAttacker >= 2 || room.duelState.scoreDefender >= 2) { 
            setTimeout(() => finalizeDuel(roomId), 3000); 
        } else { 
            setTimeout(() => { 
                try {
                    if(rooms[roomId]) { 
                        rooms[roomId].duelState.round++; 
                        rooms[roomId].duelState.narrative = `Ronda ${rooms[roomId].duelState.round}: ${rooms[roomId].duelState.attackerName} elige arma...`; 
                        updateAll(roomId); 
                    } 
                } catch(e){}
            }, 4000); 
        }
        updateAll(roomId); 
    } catch (e) { console.error("Error en resolveDuelRound:", e); }
}

function finalizeDuel(roomId) {
    try {
        const room = rooms[roomId]; if (!room) return;
        const att = room.players.find(p => p.uuid === room.duelState.attackerId); const def = room.players.find(p => p.uuid === room.duelState.defenderId);
        if (!att || !def) { room.gameState = 'playing'; updateAll(roomId); return; }
        const attWins = room.duelState.scoreAttacker > room.duelState.scoreDefender; const isPenaltyDuel = room.duelState.type === 'penalty';

        if (attWins) {
            io.to(roomId).emit('notification', `💀 ${att.name} GANA el duelo.`);
            if (!isPenaltyDuel) {
                eliminatePlayer(roomId, def.uuid);
                checkWinCondition(roomId);
                if (rooms[roomId] && rooms[roomId].gameState !== 'game_over' && rooms[roomId].gameState !== 'round_over') {
                    room.gameState = 'playing';
                    room.currentTurn = room.players.indexOf(att);
                    advanceTurn(roomId, 1);
                    updateAll(roomId);
                }
            }
            else {
                // AJUSTE 4: Castigo acumulado y pérdida de turnos real
                const totalCastigo = room.pendingPenalty + 4;
                const totalSkips = room.pendingSkip; 
                
                io.to(roomId).emit('notification', `🩸 ¡Castigo AUMENTADO! ${def.name} recibe ${totalCastigo} cartas y pierde sus turnos.`);
                drawCards(roomId, room.players.indexOf(def), totalCastigo);
                
                if (totalSkips > 0) def.missedTurns += totalSkips;

                room.pendingPenalty = 0; room.pendingSkip = 0;
                room.gameState = 'playing';
                room.currentTurn = room.players.indexOf(def);
                advanceTurn(roomId, 1); 
                updateAll(roomId);
            }
        } else {
            io.to(roomId).emit('notification', `🛡️ ${def.name} GANA el duelo.`);
            if (!isPenaltyDuel) {
                io.to(roomId).emit('notification', `🩸 ¡${att.name} falló y debe recoger 4 cartas!`);
                room.pendingPenalty = 4; room.pendingSkip = 0;
                room.currentTurn = room.players.indexOf(att);
                room.resumeTurnFrom = room.players.indexOf(def);
                room.gameState = 'playing'; updateAll(roomId);
            }
            else {
                io.to(roomId).emit('notification', `✨ ¡${def.name} devuelve el ataque! Castigo anulado y ${att.name} roba 4.`);
                drawCards(roomId, room.players.indexOf(att), 4);
                room.pendingPenalty = 0; room.pendingSkip = 0;

                room.gameState = 'playing';
                room.currentTurn = room.players.indexOf(def);
                advanceTurn(roomId, 1);
                updateAll(roomId);
            }
        }
    } catch (e) { console.error("Error en finalizeDuel:", e); }
}

function eliminatePlayer(roomId, uuid) { 
    const room = rooms[roomId]; if(!room) return; 
    const p = room.players.find(p => p.uuid === uuid); 
    if (p) { p.isDead = true; } 
}

function getAlivePlayersCount(roomId) { const room = rooms[roomId]; if(!room) return 0; return room.players.filter(p => !p.isDead && !p.isSpectator && !p.hasLeft).length; }

function getNextPlayerIndex(roomId, step) {
    const room = rooms[roomId]; if(!room) return 0; let current = room.currentTurn;
    for(let i=0; i<room.players.length; i++) {
        current = (current + room.direction + room.players.length) % room.players.length;
        if(!room.players[current].isDead && !room.players[current].isSpectator && !room.players[current].hasLeft) return current;
    }
    return current;
}
