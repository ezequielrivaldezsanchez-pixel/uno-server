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

        let graceSavedPlayers = []; // AJUSTE 5: Lista de protegidos
        room.players.forEach(p => {
            if (p.uuid !== winner.uuid && !p.isSpectator && !p.hasLeft) { 
                const hasGrace = p.hand.some(c => c.value === 'GRACIA');
                let pPoints = 0; 
                if (!hasGrace) { 
                    pPoints = p.hand.reduce((acc, c) => acc + getCardPoints(c), 0); 
                } else {
                    // Si tiene Gracia, lo guardamos para avisar al final
                    graceSavedPlayers.push(p.name);
                }
                if(pPoints > 0) { 
                    pointsAccumulated += pPoints; 
                    losersDetails.push({ name: p.name + (p.isDead ? " (RIP)" : ""), points: pPoints }); 
                }
            }
        });

        // Enviamos la notificación inmediata si alguien se salvó
        if(graceSavedPlayers.length > 0) {
            io.to(roomId).emit('notification', `✨ Gracia Divina protegió a: ${graceSavedPlayers.join(", ")}. ¡No entregan puntos al ganador!`);
        }

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

            io.to(roomId).emit('roundOver', { winner: winner.name, roundPoints: pointsAccumulated, losersDetails: losersDetails, leaderboard: leaderboard, winnerTotal: winnerTotal });
            io.to(roomId).emit('playSound', 'win');

           // AJUSTE 5: Damos 12 segundos para ver bien el ranking y las animaciones
            const animationDelay = 10000; 
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
        const winner = presentPlayers[0] || room.players.find(p => !p.hasLeft);
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
        const roundWinner = alivePlayers[0];
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
            else if ((def == 'fuego' && att == 'hielo') || (def == 'hielo' && att == 'agua') || (def == 'agua' && att == 'fuego')) winner = 'defender';
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
        const room = rooms[roomId]; 
        if (!room) return;

        const att = room.players.find(p => p.uuid === room.duelState.attackerId); 
        const def = room.players.find(p => p.uuid === room.duelState.defenderId);
        
        if (!att || !def) { 
            room.gameState = 'playing'; 
            updateAll(roomId); 
            return; 
        }

        const attWins = room.duelState.scoreAttacker > room.duelState.scoreDefender; 
        const isPenaltyDuel = room.duelState.type === 'penalty';

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
            } else {
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
                room.gameState = 'playing'; 
                updateAll(roomId);
            } else {
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
        if (room.gameState !== 'playing' || pIndex !== room.currentTurn || room.pendingPenalty > 0) return;
        if (!cardIds || cardIds.length < 2) return; 

        let playCards = []; let tempHand = [...player.hand];
        for(let id of cardIds) { const c = tempHand.find(x => x.id === id); if(!c) return; playCards.push(c); }
        const top = room.discardPile.length > 0 ? room.discardPile[room.discardPile.length - 1] : { value: '0', color: 'rojo' };

        const isAll15 = playCards.every(c => c.value === '1 y 1/2');
        if (isAll15) {
            const count = playCards.length;
            if (count !== 2 && count !== 4 && count !== 6) {
                socket.emit('notification', '🚫 Solo puedes agrupar 2, 4 o 6 cartas "1 y 1/2".');
                return;
            }
            
            const targetVal = (count * 1.5).toString();
            
            if (top.value !== targetVal) {
                socket.emit('notification', `🚫 Coincidencia numérica requerida. Debes arrojarlas sobre un ${targetVal}.`);
                return;
            }

            const finalColor = playCards[playCards.length - 1].color;
            removeCards(player, cardIds);
            room.discardPile.push(...playCards); 
            room.activeColor = finalColor; 
// AJUSTE 3: La última carta seleccionada es la que manda
room.activeColor = playCards[playCards.length - 1].color;
            
            io.to(roomId).emit('ladderAnimate', { cards: playCards, playerName: player.name });
            io.to(roomId).emit('notification', `✨ ¡COMBO MATEMÁTICO! ${player.name} combinó ${count} cartas "1 y 1/2" y formó un ${targetVal}.`); 
            io.to(roomId).emit('playSound', 'divine'); 
            checkUnoCheck(roomId, player);
            // AJUSTE 3: La última carta seleccionada es la que manda
room.activeColor = playCards[playCards.length - 1].color;
            
            if(player.hand.length === 0) { 
                room.gameState = 'animating_win'; updateAll(roomId); 
                setTimeout(() => calculateAndFinishRound(roomId, player), 1000); 
            } 
            else { advanceTurn(roomId, 1); updateAll(roomId); }
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
            io.to(roomId).emit('ladderAnimate', { cards: playCards, playerName: player.name });
            io.to(roomId).emit('notification', `🪜 ¡ESCALERA de ${player.name}!`); io.to(roomId).emit('playSound', 'soft');
            checkUnoCheck(roomId, player);
            if(player.hand.length === 0) { 
                room.gameState = 'animating_win'; updateAll(roomId); 
                setTimeout(() => calculateAndFinishRound(roomId, player), 1000); 
            } else { advanceTurn(roomId, 1); updateAll(roomId); }
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
             io.to(roomId).emit('playerRevived', { savior: player.name, revived: target.name }); 
             io.to(roomId).emit('playSound', 'divine');
             
             if (data.chosenColor) room.activeColor = data.chosenColor; else if (!room.activeColor) room.activeColor = 'rojo';
             
             if (cardIndex !== -1) {
                 player.hand.splice(cardIndex, 1);
                 room.discardPile.push(card);
                 io.to(roomId).emit('universalDiscardAnim', { card: card, playerId: socket.id, isLibreDiscard: false });
             }
             
             if (player.hand.length === 0) { 
                 room.gameState = 'animating_win'; updateAll(roomId); 
                 setTimeout(() => calculateAndFinishRound(roomId, player), 1000); return; 
             }
             checkUnoCheck(roomId, player); advanceTurn(roomId, 1); updateAll(roomId);
        } else {
             if (cardIndex === -1) { advanceTurn(roomId, 1); updateAll(roomId); }
        }
    }));socket.on('playCard', safe((cardId, chosenColor, reviveTargetId, libreContext) => {
        const roomId = getRoomId(socket); if(!roomId || !rooms[roomId]) return; touchRoom(roomId);
        const room = rooms[roomId]; 
        
        if (room.gameState !== 'playing' && room.gameState !== 'penalty_decision' && room.gameState !== 'libre_choosing') return;
        
        if (room.gameState === 'libre_choosing' && !libreContext) {
            socket.emit('notification', '⏳ Acción bloqueada. Un jugador está resolviendo Libre Albedrío.');
            return;
        }
        
        const pIndex = room.players.findIndex(p => p.id === socket.id); if (pIndex === -1) return;
        const player = room.players[pIndex]; if (player.isDead || player.isSpectator || player.hasLeft) return;
        
        if (room.pendingPenalty > 0 && room.resumeTurnFrom !== null && room.resumeTurnFrom !== undefined) {
            socket.emit('notification', '🚫 Tienes que cumplir la penalidad robando del mazo obligatoriamente.');
            return;
        }

        let cardIndex = player.hand.findIndex(c => c.id === cardId); 
        let card = (cardIndex !== -1) ? player.hand[cardIndex] : null;

        if (!card && reviveTargetId) {
             const topAux = room.discardPile.length > 0 ? room.discardPile[room.discardPile.length - 1] : null; 
             if(topAux && topAux.value === 'GRACIA') card = topAux;
        }
        
        if (!card) return;

        let isLibreDiscard = false;

        if (libreContext) {
            const gIdx = player.hand.findIndex(c => c.id === libreContext.giftId);
            const target = room.players.find(p => p.uuid === libreContext.targetId);
            if (gIdx === -1 || !target) return;

            room.gameState = 'playing'; 
            room.pendingPenalty = 0; room.pendingSkip = 0;
            
            const giftCard = player.hand.splice(gIdx, 1)[0];
            target.hand.push(giftCard);
            io.to(target.id).emit('handUpdate', target.hand);
            io.to(roomId).emit('playSound', 'wild');

            isLibreDiscard = true; 
            
            if (player.hand.length === 1) { 
                 io.to(roomId).emit('notification', `🕊️ ¡JUGADA MAESTRA! ${player.name} usó Libre Albedrío, regaló una carta y se quedó sin nada. ¡GANA LA RONDA!`);
            } else {
                 io.to(roomId).emit('notification', `🕊️ ${player.name} completó LIBRE ALBEDRÍO y regaló una carta a ${target.name}.`);
            }
            
            cardIndex = player.hand.findIndex(c => c.id === cardId);
            card = (cardIndex !== -1) ? player.hand[cardIndex] : null;
            if (!card) { advanceTurn(roomId, 1); updateAll(roomId); return; }
        }

        const top = room.discardPile.length > 0 ? room.discardPile[room.discardPile.length - 1] : { value: '0', color: 'rojo' };

        if (room.gameState === 'penalty_decision') {
            if (pIndex !== room.currentTurn) return;
            if (card.value === 'GRACIA') {
                player.hand.splice(cardIndex, 1); room.discardPile.push(card);
                io.to(roomId).emit('universalDiscardAnim', { card: card, playerId: socket.id, isLibreDiscard: false });
                io.to(roomId).emit('playSound', 'divine');
                if (chosenColor) room.activeColor = chosenColor; else if (!room.activeColor) room.activeColor = 'rojo';
                io.to(roomId).emit('showDivine', `${player.name} anuló el castigo`);
                room.pendingPenalty = 0; room.pendingSkip = 0; room.gameState = 'playing'; 
                checkUnoCheck(roomId, player);
                if (player.hand.length === 0) { 
                    room.gameState = 'animating_win'; updateAll(roomId); 
                    setTimeout(() => calculateAndFinishRound(roomId, player), 1000); return; 
                }
                advanceTurn(roomId, 1); updateAll(roomId); return;
            } else {
                socket.emit('notification', '🚫 Frente a un castigo supremo, solo puedes usar GRACIA DIVINA o batirte a duelo.');
                return; 
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
                    if (room.pendingPenalty > 0) return; 
                    if (player.hand.length === 1) { socket.emit('notification', '🚫 Prohibido ganar con SAFF.'); return; }
                    isSaff = true; room.currentTurn = pIndex; room.pendingPenalty = 0;
                    io.to(roomId).emit('notification', `⚡ ¡${player.name} robó el turno haciendo S.A.F.F. con una carta idéntica!`); io.to(roomId).emit('playSound', 'saff');
                } else { return; }
            }

            if (pIndex === room.currentTurn && !isSaff) {
                if (room.pendingPenalty > 0) { 
                    if (card.value === 'SALTEO SUPREMO') {
                        socket.emit('notification', '🚫 SALTEO SUPREMO no puede usarse para defender castigos.'); return;
                    }
                    // AJUSTE 1: LIBRE ALBEDRÍO no defiende contra castigos numéricos
if (card.value === 'GRACIA' || isLibreDiscard) { 
    // Gracia y descartes de regalo de LIBRE siguen funcionando
} else if (card.value === 'LIBRE' && room.pendingPenalty === 0 && room.pendingSkip === 0) {
    // LIBRE solo se puede tirar si NO hay castigo pendiente (+2, +4, +12 o Salteo)
} else { 
                    } else {
                        const getVal = (v) => { if (v === '+2') return 2; if (v === '+4') return 4; if (v === '+12') return 12; return 0; };
                        const cardVal = getVal(card.value); const topVal = getVal(top.value);
                        if (cardVal === 0 || cardVal < topVal) { socket.emit('notification', `🚫 Debes tirar un castigo igual/mayor, Gracia o Libre.`); return; }
                    }
                } else { 
                    let valid = isLibreDiscard || (card.color === 'negro' || card.value === 'GRACIA' || card.color === room.activeColor || card.value === top.value);
                    if (!valid) { socket.emit('notification', `❌ Carta inválida. Color o símbolo no coincide.`); return; }
                }
            }
        }

        if (card.value === 'GRACIA') {
            const deadPlayers = room.players.filter(p => p.isDead && !p.hasLeft);
            if (room.pendingPenalty > 0 && cardIndex !== -1) {
                player.hand.splice(cardIndex, 1); room.discardPile.push(card); io.to(roomId).emit('playSound', 'divine');
                io.to(roomId).emit('universalDiscardAnim', { card: card, playerId: socket.id, isLibreDiscard: isLibreDiscard });
                if (chosenColor) room.activeColor = chosenColor; else if (!room.activeColor) room.activeColor = 'rojo';
                io.to(roomId).emit('showDivine', `${player.name} anuló el castigo`); 
                room.pendingPenalty = 0; room.pendingSkip = 0; checkUnoCheck(roomId, player);
                if (player.hand.length === 0) { 
                    room.gameState = 'animating_win'; updateAll(roomId); 
                    setTimeout(() => calculateAndFinishRound(roomId, player), 1000); return; 
                }
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
                                io.to(roomId).emit('universalDiscardAnim', { card: card, playerId: socket.id, isLibreDiscard: isLibreDiscard });
                                if (chosenColor) room.activeColor = chosenColor; else if (!room.activeColor) room.activeColor = 'rojo';
                            }
                            io.to(roomId).emit('playSound', 'divine'); checkUnoCheck(roomId, player);
                            if (player.hand.length === 0) { 
                                room.gameState = 'animating_win'; updateAll(roomId); 
                                setTimeout(() => calculateAndFinishRound(roomId, player), 1000); return; 
                            }
                            advanceTurn(roomId, 1); updateAll(roomId); return;
                        }
                    }
                }
            } else { 
                if (cardIndex !== -1) {
                     io.to(roomId).emit('notification', `❤️ ${player.name} usó Gracia.`); 
                     player.hand.splice(cardIndex, 1); room.discardPile.push(card); io.to(roomId).emit('playSound', 'divine'); 
                     io.to(roomId).emit('universalDiscardAnim', { card: card, playerId: socket.id, isLibreDiscard: isLibreDiscard });
                     if (chosenColor) room.activeColor = chosenColor; else if (!room.activeColor) room.activeColor = 'rojo';
                     checkUnoCheck(roomId, player);
                     if (player.hand.length === 0) { 
                         room.gameState = 'animating_win'; updateAll(roomId); 
                         setTimeout(() => calculateAndFinishRound(roomId, player), 1000); return; 
                     }
                     advanceTurn(roomId, 1); updateAll(roomId); return;
                }
            }
        }

        if (cardIndex === -1) return; 

        if (card.value === 'RIP') {
            if (room.pendingPenalty > 0) { socket.emit('notification', '🚫 RIP no evita castigos.'); return; }
            if (getAlivePlayersCount(roomId) < 2) { 
                player.hand.splice(cardIndex, 1); room.discardPile.push(card);
                io.to(roomId).emit('universalDiscardAnim', { card: card, playerId: socket.id, isLibreDiscard: isLibreDiscard });
                advanceTurn(roomId, 1); updateAll(roomId); return; 
            }
            
            const victimIdx = getNextPlayerIndex(roomId, 1);
            if (victimIdx === pIndex) { socket.emit('notification', '⛔ No puedes desafiarte a duelo a ti mismo.'); return; }

            player.hand.splice(cardIndex, 1); room.discardPile.push(card); io.to(roomId).emit('playSound', 'rip');
            io.to(roomId).emit('universalDiscardAnim', { card: card, playerId: socket.id, isLibreDiscard: isLibreDiscard });
            checkUnoCheck(roomId, player);
            
            const attacker = player; const defender = room.players[victimIdx];
            room.duelState = { 
                attackerId: attacker.uuid, defenderId: defender.uuid, attackerName: attacker.name, defenderName: defender.name, 
                round: 1, scoreAttacker: 0, scoreDefender: 0, attackerChoice: null, defenderChoice: null, history: [], 
                turn: attacker.uuid, narrative: `💀 ${attacker.name} retó a Duelo a ${defender.name} usando la carta RIP!`, type: 'rip', originalPenalty: 0, originalSkip: 0, triggerCard: 'RIP' 
            };
            
            room.gameState = 'animating_rip'; updateAll(roomId);
            setTimeout(() => {
                if (rooms[roomId]) { rooms[roomId].gameState = 'rip_decision'; updateAll(roomId); }
            }, 1000);
            return;
        }

        if (card.value === 'LIBRE' && !isLibreDiscard) { 
            if (player.hand.length < 3) {
                socket.emit('notification', '🚫 Necesitas al menos 3 cartas para usar LIBRE ALBEDRÍO (la de uso, una para regalar y otra para descartar).');
                return;
            }
            player.hand.splice(cardIndex, 1); 
            room.discardPile.push(card);
            io.to(roomId).emit('universalDiscardAnim', { card: card, playerId: socket.id, isLibreDiscard: false });
            io.to(roomId).emit('notification', `🕊️ ${player.name} arrojó LIBRE ALBEDRÍO y está eligiendo...`);
            room.gameState = 'libre_choosing';
            updateAll(roomId);
            setTimeout(() => { socket.emit('startLibreLogic', card.id); }, 1000);
            return; 
        }

        player.hand.splice(cardIndex, 1); room.discardPile.push(card);
        io.to(roomId).emit('cardPlayedEffect', { color: card.color });
        if (card.color === 'negro' && chosenColor) room.activeColor = chosenColor; else if (card.color !== 'negro') room.activeColor = card.color;
        
        io.to(roomId).emit('universalDiscardAnim', { card: card, playerId: socket.id, isLibreDiscard: isLibreDiscard });
        checkUnoCheck(roomId, player); 
        
        let delay = 0;
        if (['+12', 'SALTEO SUPREMO'].includes(card.value)) {
            delay = 1000;
            room.gameState = 'animating_penalty';
            updateAll(roomId);
        } else {
            delay = 400; 
        }

        setTimeout(() => {
            if (!rooms[roomId]) return;
            if (room.gameState === 'animating_penalty') room.gameState = 'playing';
            applyCardEffect(roomId, player, card, chosenColor);
        }, delay);

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
                    
                    let resumed = false;
                    if (room.resumeTurnFrom !== undefined && room.resumeTurnFrom !== null) {
                        room.currentTurn = room.resumeTurnFrom;
                        room.resumeTurnFrom = null;
                        resumed = true;
                    }
                    
                    if (resumed && room.interruptedTurn) {
                        room.interruptedTurn = false;
                    } else {
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
        
        const player = room.players.find(x => x.id === socket.id);
        if (!player || player.uuid !== room.duelState.defenderId) return;

        if (d === 'surrender') { 
            if(room.duelState.type === 'rip') { 
                eliminatePlayer(roomId, room.duelState.defenderId); 
                checkWinCondition(roomId); 
                if (rooms[roomId] && rooms[roomId].gameState !== 'game_over') {
                    room.gameState = 'playing';
                    room.currentTurn = room.players.findIndex(p => p.uuid === room.duelState.attackerId);
                    advanceTurn(roomId, 1);
                    updateAll(roomId);
                }
            }
        }
        else if (d === 'accept_penalty') {
             io.to(roomId).emit('notification', `${player.name} aceptó el castigo.`); room.gameState = 'playing'; updateAll(roomId);
        }
        else if (d === 'divine_save') { // NUEVO: Manejo de Gracia Divina en RIP
            const graceIdx = player.hand.findIndex(c => c.value === 'GRACIA');
            if (graceIdx !== -1) {
                const graceCard = player.hand.splice(graceIdx, 1);
                room.discardPile.push(graceCard);
                io.to(roomId).emit('universalDiscardAnim', { card: graceCard, playerId: socket.id, isLibreDiscard: false });
                io.to(roomId).emit('playSound', 'divine');
                io.to(roomId).emit('showDivine', `${player.name} usó Gracia Divina y anuló el RIP`);
                room.gameState = 'playing';
                room.currentTurn = room.players.findIndex(p => p.uuid === room.duelState.attackerId);
                advanceTurn(roomId, 1);
                updateAll(roomId);
            }
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
        else if (myUUID === room.duelState.defenderId) { room.duelState.defenderChoice = c; resolveDuelRound(roomId, false); return; }
        updateAll(roomId);
    }));
    
    socket.on('sayUno', safe(() => {
        const roomId = getRoomId(socket); if(!roomId) return; const room = rooms[roomId]; 
        if (room.gameState !== 'playing') return;
        const p = room.players.find(x => x.id === socket.id);
        if(p && p.hand.length === 1) { p.saidUno = true; io.to(roomId).emit('notification', `📢 ¡${p.name} gritó "UNO y 1/2"!`); io.to(roomId).emit('playSound', 'uno'); manageTimers(roomId); }
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
        
        target.saidUno = true; 
        
        drawCards(roomId, room.players.indexOf(target), 2);
        io.to(roomId).emit('notification', `🚨 ¡${accuser.name} denunció a ${target.name}! Recibe 2 cartas al instante.`); 
        io.to(roomId).emit('playSound', 'attack');
        updateAll(roomId);
    }));

    socket.on('sendChat', safe((text) => { 
        const roomId = getRoomId(socket); if(!roomId || !rooms[roomId]) return;
        const room = rooms[roomId]; const p = room.players.find(x => x.id === socket.id); 
        if (p) {
            const msg = { name: p.name, text }; room.chatHistory.push(msg);
            if(room.chatHistory.length > 50) room.chatHistory.shift();
            io.to(roomId).emit('chatMessage', msg); 
            manageTimers(roomId);
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

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Servidor corriendo en el puerto ${PORT}`);
});
