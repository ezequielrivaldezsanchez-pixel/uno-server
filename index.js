const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

// --- VARIABLES GLOBALES ---
let gameState = 'waiting'; 
let players = [];
let deck = [];
let discardPile = [];
let currentTurn = 0;
let direction = 1; 
let activeColor = ''; 
let pendingPenalty = 0; 
let countdownInterval = null;

// VARIABLES DEL DUELO
let duelState = {
    attackerId: null, defenderId: null, attackerName: '', defenderName: '',
    round: 1, scoreAttacker: 0, scoreDefender: 0,
    attackerChoice: null, defenderChoice: null, history: [] 
};

// CHAT
let chatHistory = [];

const colors = ['rojo', 'azul', 'verde', 'amarillo'];
const values = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '+2', 'X', 'R'];

// --- FUNCIONES CORE ---

function resetGame() {
    gameState = 'waiting';
    deck = [];
    discardPile = [];
    currentTurn = 0;
    direction = 1;
    activeColor = '';
    pendingPenalty = 0;
    if (countdownInterval) clearInterval(countdownInterval);
    
    players.forEach(p => {
        p.hand = [];
        p.hasDrawn = false;
        p.isDead = false;
        p.isSpectator = true; 
    });
    
    duelState = { attackerId: null, defenderId: null, attackerName: '', defenderName: '', round: 1, scoreAttacker: 0, scoreDefender: 0, attackerChoice: null, defenderChoice: null, history: [] };
}

function createDeck() {
    deck = [];
    colors.forEach(color => {
        values.forEach(val => {
            deck.push({ color, value: val, type: 'normal', id: Math.random().toString(36) });
            if (val !== '0') deck.push({ color, value: val, type: 'normal', id: Math.random().toString(36) });
        });
    });
    
    for(let i=0; i<4; i++) {
        deck.push({ color: 'negro', value: 'color', type: 'wild', id: Math.random().toString(36) });
        deck.push({ color: 'negro', value: '+4', type: 'wild', id: Math.random().toString(36) });
        deck.push({ color: 'negro', value: 'RIP', type: 'death', id: Math.random().toString(36) });
        deck.push({ color: 'negro', value: 'GRACIA', type: 'divine', id: Math.random().toString(36) });
    }
    
    for(let i=0; i<2; i++) {
        deck.push({ color: 'negro', value: '+12', type: 'wild', id: Math.random().toString(36) });
    }

    shuffle();
}

function shuffle() {
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
}

function recycleDeck() {
    if (discardPile.length <= 1) { createDeck(); return; }
    const topCard = discardPile.pop();
    deck = [...discardPile];
    discardPile = [topCard];
    shuffle();
    io.emit('notification', '♻️ Barajando descartes...');
}

function calculateHandPoints(hand) {
    let points = 0;
    hand.forEach(card => {
        if (card.value === 'RIP') points += 100; 
        else if (card.value === 'GRACIA') points += 150;
        else if (card.value === '+12') points += 200;
        else if (card.type === 'wild') points += 50;
        else if (['+2', 'X', 'R'].includes(card.value)) points += 20;
        else points += parseInt(card.value) || 0;
    });
    return points;
}

// --- SOCKET LOGIC ---

io.on('connection', (socket) => {
    socket.emit('chatHistory', chatHistory);

    socket.on('join', (name) => {
        const existing = players.find(p => p.id === socket.id);
        if(!existing) {
            const isLate = gameState !== 'waiting' && gameState !== 'counting';
            const player = { 
                id: socket.id, 
                name: name.substring(0, 15), 
                hand: [], 
                hasDrawn: false, 
                isSpectator: isLate, 
                isDead: false 
            };
            players.push(player);
            io.emit('notification', `👋 ${player.name} entró.`);
            
            const sysMsg = { name: 'SISTEMA', text: `${player.name} se ha unido.`, time: new Date().toLocaleTimeString() };
            chatHistory.push(sysMsg);
            if(chatHistory.length > 50) chatHistory.shift();
            io.emit('chatMessage', sysMsg);
            
            updateAll();
        }
    });

    socket.on('sendChat', (text) => {
        const p = players.find(p => p.id === socket.id);
        if(p && text.trim().length > 0) {
            const msg = { name: p.name, text: text.substring(0, 100), time: new Date().toLocaleTimeString() };
            chatHistory.push(msg);
            if(chatHistory.length > 50) chatHistory.shift();
            io.emit('chatMessage', msg);
        }
    });

    socket.on('requestStart', () => {
        // PERMITIR 1 JUGADOR PARA TESTING
        if(gameState === 'waiting' && players.length >= 1) {
            startCountdown();
        } else {
            io.emit('notification', '🚫 Esperando jugadores...');
        }
    });

    socket.on('playCard', (cardId, chosenColor) => {
        if(gameState !== 'playing') return;
        const pIndex = players.findIndex(p => p.id === socket.id);
        if (pIndex === -1) return;
        const player = players[pIndex];
        if (player.isDead) return;
        
        const cardIndex = player.hand.findIndex(c => c.id === cardId);
        if(cardIndex === -1) return;
        const card = player.hand[cardIndex];
        const top = discardPile[discardPile.length - 1];

        if (top.color !== 'negro') activeColor = top.color;

        if (pIndex === currentTurn && pendingPenalty > 0) {
            let allowed = false;
            if (top.value === '+12' && card.value === '+12') allowed = true;
            if (top.value === '+4' && card.value === '+4') allowed = true;
            if (top.value === '+2' && card.value === '+2') allowed = true;
            if (card.value === 'GRACIA') allowed = true;
            if (!allowed) { io.emit('notification', `🚫 ¡Tienes penalización!`); return; }
        }

        if (pIndex === currentTurn) {
            if (top.value === '+4' && card.value === '+2') { io.emit('notification', `⛔ Jerarquía: No +2 sobre +4.`); return; }
            if (top.value === '+12' && (card.value === '+2' || card.value === '+4')) { io.emit('notification', `⛔ Jerarquía: +12 es supremo.`); return; }
        }

        let isSaff = false;
        if (pIndex !== currentTurn) {
            if (card.color === 'negro') return; 
            if (card.value === top.value && card.color === top.color) {
                isSaff = true; currentTurn = pIndex; pendingPenalty = 0; 
                io.emit('notification', `⚡ ¡${player.name} hizo SAFF!`); io.emit('playSound', 'saff'); 
            } else { return; }
        } else {
            let valid = false;
            if (card.value === 'GRACIA') valid = true;
            else if (card.color === 'negro' || card.color === activeColor || card.value === top.value) valid = true;
            if (!valid) return;
        }

        if (card.value === 'GRACIA') {
            const deadPlayer = players.find(p => p.isDead);
            player.hand.splice(cardIndex, 1); discardPile.push(card); io.emit('playSound', 'divine'); 
            if (pendingPenalty > 0) {
                io.emit('showDivine', `${player.name} salvado por Gracia Divina`); pendingPenalty = 0; advanceTurn(); updateAll(); return;
            }
            if (deadPlayer) {
                deadPlayer.isDead = false; deadPlayer.isSpectator = false; io.emit('showDivine', `¡MILAGRO! ${deadPlayer.name} revivió`);
            } else { io.emit('notification', `❤️ ${player.name} usó Gracia.`); }
            advanceTurn(); updateAll(); return;
        }

        if (card.value === 'RIP') {
            if(getAlivePlayersCount() < 2) {
                player.hand.splice(cardIndex, 1); discardPile.push(card); io.emit('notification', '💀 RIP fallido.'); advanceTurn(); updateAll(); return;
            }
            player.hand.splice(cardIndex, 1); discardPile.push(card); io.emit('playSound', 'rip'); 
            gameState = 'rip_decision';
            const attacker = player; const defender = players[getNextPlayerIndex()];
            duelState = { attackerId: attacker.id, defenderId: defender.id, attackerName: attacker.name, defenderName: defender.name, round: 1, scoreAttacker: 0, scoreDefender: 0, attackerChoice: null, defenderChoice: null, history: [] };
            updateAll(); io.emit('notification', `💀 ¡${attacker.name} usó RIP contra ${defender.name}!`); return;
        }

        player.hand.splice(cardIndex, 1); discardPile.push(card); io.emit('cardPlayedEffect', { color: card.color });
        if (card.color === 'negro' && chosenColor) activeColor = chosenColor; else if (card.color !== 'negro') activeColor = card.color;

        if (card.value === 'R') { direction *= -1; if(getAlivePlayersCount() === 2) advanceTurn(); }
        if (card.value === 'X') advanceTurn(); 
        
        if (card.value === '+2') { pendingPenalty += 2; io.emit('notification', `💥 +2! Castigo: ${pendingPenalty}`); io.emit('playSound', 'attack'); io.emit('shakeScreen'); advanceTurn(); updateAll(); return; }
        if (card.value === '+4') { pendingPenalty += 4; io.emit('notification', `💣 +4! Castigo: ${pendingPenalty}`); io.emit('playSound', 'attack'); io.emit('shakeScreen'); advanceTurn(); updateAll(); return; }
        if (card.value === '+12') { pendingPenalty += 12; io.emit('notification', `☢️ ¡+12! Castigo: ${pendingPenalty}`); io.emit('playSound', 'thunder'); io.emit('shakeScreen'); advanceTurn(); updateAll(); return; }

        if (card.color === 'negro') io.emit('playSound', 'wild'); else io.emit('playSound', 'soft'); 

        if (player.hand.length === 0) finishRound(player); else { advanceTurn(); updateAll(); }
    });

    socket.on('playGraceDefense', (chosenColor) => {
        if(gameState !== 'rip_decision' || socket.id !== duelState.defenderId) return;
        const defender = players.find(p => p.id === socket.id);
        const cardIndex = defender.hand.findIndex(c => c.value === 'GRACIA');
        if(cardIndex !== -1) {
            defender.hand.splice(cardIndex, 1); discardPile.push(defender.hand[cardIndex]); activeColor = chosenColor || 'rojo'; 
            io.emit('showDivine', `${defender.name} salvado por Gracia Divina`); io.emit('playSound', 'divine');
            const attIndex = players.findIndex(p => p.id === duelState.attackerId); drawCards(attIndex, 4); 
            gameState = 'playing'; advanceTurn(); updateAll();
        }
    });

    socket.on('ripDecision', (d) => {
        if(gameState !== 'rip_decision' || socket.id !== duelState.defenderId) return;
        const def = players.find(p => p.id === duelState.defenderId);
        if (d === 'surrender') { io.emit('notification', `🏳️ ${def.name} se rindió.`); eliminatePlayer(def.id); checkWinCondition(); } 
        else { io.emit('playSound', 'bell'); gameState = 'dueling'; updateAll(); }
    });
    
    socket.on('duelPick', (c) => {
        if(gameState !== 'dueling') return;
        if (socket.id === duelState.attackerId) duelState.attackerChoice = c;
        if (socket.id === duelState.defenderId) duelState.defenderChoice = c;
        if (duelState.attackerChoice && duelState.defenderChoice) resolveDuelRound();
        else updateAll(); 
    });

    socket.on('draw', () => {
        if(gameState !== 'playing') return;
        const pIndex = players.findIndex(p => p.id === socket.id);
        if(pIndex === -1 || players[pIndex].isDead) return;
        io.emit('playSound', 'soft'); 
        if (pIndex === currentTurn) {
            if (pendingPenalty > 0) {
                drawCards(pIndex, 1); pendingPenalty--; 
                if (pendingPenalty > 0) { io.emit('notification', `😰 Faltan: ${pendingPenalty}`); updateAll(); } 
                else { io.emit('notification', `😓 Terminó. Pierde turno.`); advanceTurn(); updateAll(); }
            } else {
                if (!players[pIndex].hasDrawn) { drawCards(pIndex, 1); players[pIndex].hasDrawn = true; updateAll(); }
            }
        }
    });

    socket.on('passTurn', () => {
        if(gameState !== 'playing') return;
        const pIndex = players.findIndex(p => p.id === socket.id);
        if(pIndex === -1 || players[pIndex].isDead) return;
        if (pIndex === currentTurn && players[pIndex].hasDrawn && pendingPenalty === 0) { advanceTurn(); updateAll(); }
    });

    socket.on('sayUno', () => {
        const p = players.find(p => p.id === socket.id);
        if(p && !p.isDead) { io.emit('notification', `🚨 ¡${p.name} gritó UNO y 1/2! 🚨`); io.emit('playSound', 'uno'); }
    });

    socket.on('restartGame', () => { resetGame(); updateAll(); });

    socket.on('disconnect', () => {
        const p = players.find(p => p.id === socket.id);
        if(!p) return;
        if (gameState === 'dueling' || gameState === 'rip_decision') {
            if (p.id === duelState.attackerId) { io.emit('notification', `🏃‍♂️ Atacante huyó.`); gameState = 'playing'; advanceTurn(); } 
            else if (p.id === duelState.defenderId) { io.emit('notification', `🏃‍♂️ Defensor huyó.`); eliminatePlayer(p.id); checkWinCondition(); return; }
        }
        players = players.filter(pl => pl.id !== socket.id);
        if (gameState === 'playing' || gameState === 'counting') {
            if (players.length < 1) resetGame(); else { if (currentTurn >= players.length) currentTurn = 0; }
        } else { if (currentTurn >= players.length) currentTurn = 0; }
        updateAll();
    });
});

function checkWinCondition() {
    if(players.length > 1 && getAlivePlayersCount() <= 1) {
        const winner = players.find(p => !p.isDead); if(winner) finishRound(winner); else resetGame(); updateAll();
    } else { gameState = 'playing'; advanceTurn(); updateAll(); }
}

function resolveDuelRound() {
    const att = duelState.attackerChoice, def = duelState.defenderChoice;
    let winner = 'tie';
    if ((att=='fuego'&&def=='hielo')||(att=='hielo'&&def=='agua')||(att=='agua'&&def=='fuego')) winner='attacker';
    else if ((def=='fuego'&&att=='hielo')||(def=='hielo'&&att=='agua')||(def=='agua'&&att=='fuego')) winner='defender';
    
    if(winner=='attacker') duelState.scoreAttacker++; else if(winner=='defender') duelState.scoreDefender++;
    duelState.history.push({ round: duelState.round, att, def, winnerName: winner=='attacker'?duelState.attackerName:(winner=='defender'?duelState.defenderName:'Empate') });
    duelState.attackerChoice = null; duelState.defenderChoice = null; io.emit('playSound', 'soft');
    if (duelState.round >= 3 || duelState.scoreAttacker >= 2 || duelState.scoreDefender >= 2) setTimeout(finalizeDuel, 2000); else { duelState.round++; updateAll(); }
}

function finalizeDuel() {
    const att = players.find(p => p.id === duelState.attackerId); const def = players.find(p => p.id === duelState.defenderId);
    if (!att || !def) { gameState = 'playing'; updateAll(); return; }
    if (duelState.scoreAttacker > duelState.scoreDefender) { io.emit('notification', `💀 ${att.name} GANA. ${def.name} eliminado.`); io.emit('playSound', 'thunder'); eliminatePlayer(def.id); checkWinCondition(); } 
    else if (duelState.scoreDefender > duelState.scoreAttacker) { io.emit('notification', `🛡️ ${def.name} GANA. Castigo para ${att.name}.`); drawCards(players.findIndex(p=>p.id===duelState.attackerId), 4); gameState = 'playing'; advanceTurn(); updateAll(); } 
    else { io.emit('notification', `🤝 EMPATE.`); gameState = 'playing'; advanceTurn(); updateAll(); }
}

function eliminatePlayer(id) { const p = players.find(p => p.id === id); if(p) { p.isDead = true; p.isSpectator = true; } }
function getAlivePlayersCount() { return players.filter(p => !p.isDead).length; }

function startCountdown() {
    if (players.length < 1) return; 
    gameState = 'counting'; let count = 3; createDeck(); discardPile = [deck.pop()];
    activeColor = discardPile[0].color === 'negro' ? colors[Math.floor(Math.random()*4)] : discardPile[0].color;
    currentTurn = 0; pendingPenalty = 0;
    players.forEach(p => { p.hand=[]; p.hasDrawn=false; p.isDead=false; p.isSpectator=false; for(let i=0; i<7; i++) p.hand.push(deck.pop()); });
    io.emit('countdownTick', 3);
    countdownInterval = setInterval(() => { 
        if (players.length < 1) { clearInterval(countdownInterval); resetGame(); updateAll(); return; }
        io.emit('countdownTick', count); io.emit('playSound', 'soft'); 
        if(count <= 0){ clearInterval(countdownInterval); gameState = 'playing'; io.emit('playSound', 'start'); updateAll(); } count--; 
    }, 1000);
}

function drawCards(pid, n) { if (pid < 0 || pid >= players.length) return; for(let i=0; i<n; i++) { if(deck.length===0) recycleDeck(); if(deck.length>0) players[pid].hand.push(deck.pop()); } }

function advanceTurn() {
    if(players[currentTurn]) players[currentTurn].hasDrawn = false;
    let attempts = 0; let aliveCount = getAlivePlayersCount();
    if (aliveCount < 2 && gameState === 'playing' && players.length > 1) return;
    do { currentTurn = (currentTurn + direction + players.length) % players.length; attempts++; } while(players[currentTurn].isDead && attempts < players.length*2);
}

function getNextPlayerIndex() {
    let next = currentTurn; let attempts = 0;
    do { next = (next + direction + players.length) % players.length; attempts++; } while(players[next].isDead && attempts < players.length * 2); 
    return next;
}

function finishRound(w) {
    gameState = 'waiting';
    const res = players.map(p => ({ name: p.name + (p.isDead?"(💀)":""), points: p.isDead ? 0 : calculateHandPoints(p.hand), winner: p.id === w.id }));
    if(res.find(r=>r.winner)) { res.find(r=>r.winner).points = res.reduce((a,b) => a + b.points, 0); }
    io.emit('gameOver', { winner: w.name, results: res }); io.emit('playSound', 'win');
}

function updateAll() {
    const duelInfo = (gameState === 'dueling' || gameState === 'rip_decision') ? {
        attackerName: duelState.attackerName, defenderName: duelState.defenderName, round: duelState.round, scoreAttacker: duelState.scoreAttacker, scoreDefender: duelState.scoreDefender, history: duelState.history, myChoice: null 
    } : null;
    const pack = {
        state: gameState, players: players.map((p, i) => ({ name: p.name, cardCount: p.hand.length, id: p.id, isTurn: (gameState === 'playing' && i === currentTurn), hasDrawn: p.hasDrawn, isDead: p.isDead, isSpectator: p.isSpectator })),
        topCard: discardPile.length > 0 ? discardPile[discardPile.length - 1] : null, activeColor, currentTurn, duelInfo, pendingPenalty 
    };
    players.forEach(p => {
        const mp = JSON.parse(JSON.stringify(pack));
        if(mp.duelInfo) { if(p.id===duelState.attackerId) mp.duelInfo.myChoice=duelState.attackerChoice; if(p.id===duelState.defenderId) mp.duelInfo.myChoice=duelState.defenderChoice; }
        io.to(p.id).emit('updateState', mp); if(!p.isSpectator || p.isDead) io.to(p.id).emit('handUpdate', p.hand);
    });
}

// --- CLIENTE VISUAL ---
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>UNO y 1/2</title>
    <style>
        body { font-family: 'Segoe UI', sans-serif; background: #1e272e; color: white; text-align: center; margin: 0; user-select: none; overflow: hidden; transition: background 0.5s; }
        .screen { display: none; width: 100%; height: 100vh; flex-direction: column; justify-content: center; align-items: center; position: absolute; top: 0; left: 0; }
        #game-area { z-index: 5; }
        .bg-rojo { background: #4a1c1c; } .bg-azul { background: #1c2a4a; } .bg-verde { background: #1c4a2a; } .bg-amarillo { background: #4a451c; }
        #rip-decision-screen { background: rgba(150, 0, 0, 0.95); z-index: 50; } #duel-arena { background: #000; z-index: 50; }
        .card { display: flex; justify-content: center; align-items: center; width: 70px; height: 100px; border-radius: 8px; border: 3px solid white; cursor: pointer; margin: 2px; font-weight: 900; font-size: 24px; color: white; text-shadow: 2px 2px 0 #000; transition: transform 0.2s, box-shadow 0.2s; position: relative; }
        .card:hover { transform: translateY(-20px) scale(1.1); z-index: 100; box-shadow: 0 10px 20px rgba(0,0,0,0.5); }
        .card-enter { animation: slideUp 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275); }
        .pop-anim { animation: pop 0.3s ease-out; } .shake-screen { animation: shake 0.5s; }
        .rojo { background: #ff6b6b; } .azul { background: #48dbfb; } .verde { background: #1dd1a1; } .amarillo { background: #feca57; color: black; text-shadow: none; }
        .negro { background: #222; border-color: gold; } .death-card { background: #000; border: 3px solid #666; color: red; font-size: 30px; } .divine-card { background: white; border: 3px solid gold; color: red; font-size: 30px; text-shadow: none; }
        .mega-wild { background: #4b0082; border: 3px solid #ff00ff; color: #fff; box-shadow: 0 0 10px #ff00ff; }
        .card.zombie { opacity: 0.5; filter: grayscale(100%); cursor: not-allowed; }
        #divine-alert { position: fixed; top: 40%; left: 50%; transform: translate(-50%, -50%); background: white; border: 4px solid gold; color: #d4ac0d; padding: 30px; font-size: 30px; border-radius: 20px; box-shadow: 0 0 50px gold; z-index: 2000; text-align: center; font-weight: bold; display: none; animation: pop 0.5s; }
        #btn-rules { position: fixed; top: 10px; right: 10px; z-index: 2000; background: rgba(0,0,0,0.5); border: 2px solid white; color: white; border-radius: 20px; padding: 5px 15px; cursor: pointer; }
        #rules-modal { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.9); z-index: 3000; justify-content: center; align-items: center; overflow-y: auto; }
        #rules-content { background: #2c3e50; color: white; padding: 20px; border-radius: 10px; width: 90%; max-width: 600px; text-align: left; border: 2px solid gold; }
        .close-rules { float: right; cursor: pointer; font-size: 20px; font-weight: bold; }
        @keyframes slideUp { from { transform: translateY(100px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
        @keyframes pop { 0% { transform: scale(1); } 50% { transform: scale(1.4); } 100% { transform: scale(1); } }
        @keyframes shake { 0% { transform: translate(1px, 1px) rotate(0deg); } 10% { transform: translate(-1px, -2px) rotate(-1deg); } 20% { transform: translate(-3px, 0px) rotate(1deg); } 30% { transform: translate(3px, 2px) rotate(0deg); } 40% { transform: translate(1px, -1px) rotate(1deg); } 50% { transform: translate(-1px, 2px) rotate(-1deg); } 60% { transform: translate(-3px, 1px) rotate(0deg); } 70% { transform: translate(3px, 1px) rotate(-1deg); } 80% { transform: translate(-1px, -1px) rotate(1deg); } 90% { transform: translate(1px, 2px) rotate(0deg); } 100% { transform: translate(1px, -2px) rotate(-1deg); } }
        .duel-btn { width: 100px; height: 100px; border-radius: 50%; border: 5px solid white; font-size: 40px; margin: 20px; cursor: pointer; transition: transform 0.2s; opacity: 0.7; } .duel-btn.selected { border: 8px solid gold; opacity: 1; transform: scale(1.2); box-shadow: 0 0 20px gold; } .fuego { background: #e74c3c; } .hielo { background: #74b9ff; } .agua { background: #0984e3; }
        .player-badge { padding: 5px 15px; background: rgba(0,0,0,0.5); border-radius: 20px; margin: 5px; transition: all 0.3s; } .is-turn { border: 2px solid #2ecc71; background: #27ae60; transform: scale(1.1); box-shadow: 0 0 10px #2ecc71; } .is-dead { text-decoration: line-through; color: #aaa; background: #333; }
        #my-hand { display: flex; flex-wrap: wrap; justify-content: center; position: absolute; bottom: 10px; width: 100%; } #table-center { display: flex; gap: 30px; margin-bottom: 100px; }
        #notification { position: fixed; top: 20px; background: gold; color: black; padding: 10px 30px; border-radius: 30px; font-weight: bold; display: none; z-index: 1000; }
        #penalty-alert { position: absolute; top: 25%; left: 50%; transform: translate(-50%, -50%); width: 100%; text-align: center; font-size: 60px; font-weight: 900; color: #ff4757; text-shadow: 2px 2px 0 #fff, -1px -1px 0 #fff, 1px -1px 0 #fff; background: rgba(0,0,0,0.7); padding: 20px 0; z-index: 500; display: none; pointer-events: none; animation: pulse 0.5s infinite alternate; }
        @keyframes pulse { from { transform: translate(-50%, -50%) scale(1); } to { transform: translate(-50%, -50%) scale(1.1); } }
        #chat-container { position: fixed; bottom: 10px; left: 10px; width: 300px; height: 200px; background: rgba(0,0,0,0.6); border-radius: 10px; display: flex; flex-direction: column; z-index: 400; font-size: 12px; text-align: left; }
        #chat-messages { flex-grow: 1; overflow-y: auto; padding: 10px; color: #ddd; } #chat-input { width: 100%; padding: 10px; border: none; background: rgba(255,255,255,0.1); color: white; border-radius: 0 0 10px 10px; } #chat-input:focus { outline: none; background: rgba(255,255,255,0.2); } .chat-msg { margin-bottom: 5px; } .chat-name { font-weight: bold; color: #f1c40f; }
        @media (max-width: 600px) { #chat-container { width: 200px; height: 150px; opacity: 0.8; } }
    </style>
</head>
<body>
    <div id="notification"></div> <div id="divine-alert"></div> <button id="btn-rules" onclick="toggleRules()">📜 Reglas</button>
    <div id="rules-modal">
        <div id="rules-content">
            <span class="close-rules" onclick="toggleRules()">✖</span>
            <h2>📜 REGLAS DEL JUEGO</h2>
            <h3>🔥 Objetivo</h3> <p>Quedarte sin cartas antes que los demás. ¡No olvides gritar UNO y 1/2!</p>
            <h3>⚡ Cartas Especiales</h3>
            <p><b>+12 (Mega Comodín):</b> Obliga al siguiente a robar 12. Es SUPREMO. Solo se responde con +12 o Gracia.</p>
            <p><b>+4 (Comodín):</b> Roba 4 y cambia color.</p>
            <p><b>+2:</b> Roba 2. Acumulable.</p>
            <p><b>RIP (💀):</b> Duelo Piedra/Papel/Tijera. El perdedor muere (Zombie).</p>
            <p><b>GRACIA DIVINA (❤️):</b> Te salva de TODO (+12, +4, +2, RIP). Revive a muertos si se usa en paz. NO cambia color.</p>
            <h3>🛡️ Jerarquía</h3> <p>+12 > +4 > +2.</p>
            <h3>🚀 SAFF</h3> <p>Si tienes la carta EXACTA en mesa, juégala fuera de turno.</p>
        </div>
    </div>
    <div id="login" class="screen" style="display:flex;">
        <h1 style="font-size:80px; margin:0;">🃏 UNO y 1/2</h1> <p>V15.2: Final</p>
        <input id="username" type="text" placeholder="Tu Nombre" style="padding:15px; font-size:20px; text-align:center; border-radius:10px;"> <br><br>
        <button onclick="joinGame()" style="padding:15px 30px; background:#2ecc71; border:none; color:white; font-size:20px; border-radius:50px; cursor:pointer;">Entrar</button>
    </div>
    <div id="lobby" class="screen">
        <h1>⏳ Sala de Espera</h1> <div id="lobby-list"></div>
        <button id="btn-start" onclick="requestStart()" style="display:none; margin-top:20px; padding:15px 30px; background:#2ecc71; border:none; color:white; font-size:20px; border-radius:50px; cursor:pointer;">EMPEZAR</button>
    </div>
    <div id="game-area" class="screen">
        <div id="players-list" style="display:flex; flex-wrap:wrap; justify-content:center; width:100%;"></div>
        <div id="penalty-alert">¡CASTIGO!<br>ROBA <span id="penalty-count">0</span></div>
        <div id="table-center">
            <div id="deck-pile" class="card" onclick="drawCard()" style="background:#e74c3c;">S</div> <div id="top-card" class="card"></div>
        </div>
        <div id="controls" style="margin-bottom:10px;">
            <button id="btn-pass" onclick="passTurn()" style="display:none; padding:10px 20px; background:orange; border:none; border-radius:20px; color:white; font-weight:bold;">Pasar</button>
            <button onclick="sayUno()" style="padding:10px 20px; background:red; border:none; border-radius:20px; color:white; font-weight:bold;">¡UNO y 1/2!</button>
        </div>
        <div id="my-hand"></div> <div id="chat-container"><div id="chat-messages"></div><input id="chat-input" type="text" placeholder="Escribe aquí..." onkeypress="handleChat(event)"></div>
    </div>
    <div id="rip-decision-screen" class="screen">
        <h1 style="font-size: 50px;">💀 ¡TE LANZARON RIP!</h1>
        <div style="display:flex; gap:30px; flex-wrap: wrap; justify-content: center;">
            <button onclick="ripResponse('surrender')" style="padding:20px; background:#333; color:white; font-size:20px; border:2px solid white; cursor:pointer;">🏳️ Rendirse</button>
            <button onclick="ripResponse('duel')" style="padding:20px; background:red; color:white; font-size:20px; border:2px solid gold; cursor:pointer; font-weight:bold;">⚔️ ACEPTAR DUELO</button>
        </div>
        <div id="grace-option" style="display:none; margin-top: 20px;">
            <p>TIENES GRACIA DIVINA:</p> <button onclick="playGraceDefense()" style="padding:20px; background:white; color:red; font-size:20px; border:3px solid gold; cursor:pointer; font-weight:bold;">❤️ USAR MILAGRO</button>
        </div>
    </div>
    <div id="duel-arena" class="screen">
        <h1 style="color:gold;">⚔️ DUELO ⚔️</h1> <h2 id="duel-vs">... vs ...</h2> <h3 id="duel-score">Round 1 | 0 - 0</h3>
        <div id="duel-controls" style="display:none;">
            <button id="btn-fuego" class="duel-btn fuego" onclick="duelPick('fuego')">🔥</button> <button id="btn-hielo" class="duel-btn hielo" onclick="duelPick('hielo')">❄️</button> <button id="btn-agua" class="duel-btn agua" onclick="duelPick('agua')">💧</button>
        </div>
        <div id="duel-spectator" style="display:none;"><p>Peleando...</p></div> <div id="duel-history" style="margin-top:20px; font-size:16px; color:#aaa;"></div>
    </div>
    <div id="countdown-overlay" style="display:none; position:fixed; top:0; width:100%; height:100%; background:rgba(0,0,0,0.8); z-index:200; justify-content:center; align-items:center; font-size:150px; color:gold;">3</div>
    <div id="color-picker" style="display:none; position:fixed; top:50%; left:50%; transform:translate(-50%,-50%); background:white; padding:20px; border-radius:10px; z-index:200;">
        <h3 style="color:black">Elige color:</h3>
        <div style="display:flex; gap:10px;">
            <div onclick="selectColor('rojo')" style="width:50px; height:50px; background:red; border-radius:50%; cursor:pointer;"></div> <div onclick="selectColor('azul')" style="width:50px; height:50px; background:blue; border-radius:50%; cursor:pointer;"></div>
            <div onclick="selectColor('verde')" style="width:50px; height:50px; background:green; border-radius:50%; cursor:pointer;"></div> <div onclick="selectColor('amarillo')" style="width:50px; height:50px; background:yellow; border-radius:50%; cursor:pointer;"></div>
        </div>
    </div>
    <script>
        const sounds = { soft: new Audio('https://cdn.freesound.org/previews/240/240776_4107740-lq.mp3'), attack: new Audio('https://cdn.freesound.org/previews/155/155235_2452367-lq.mp3'), rip: new Audio('https://cdn.freesound.org/previews/173/173930_2394245-lq.mp3'), divine: new Audio('https://cdn.freesound.org/previews/242/242501_4414128-lq.mp3'), uno: new Audio('https://cdn.freesound.org/previews/415/415209_5121236-lq.mp3'), tick: new Audio('https://cdn.freesound.org/previews/250/250079_4486188-lq.mp3'), start: new Audio('https://cdn.freesound.org/previews/320/320655_5260872-lq.mp3'), win: new Audio('https://cdn.freesound.org/previews/270/270402_5123851-lq.mp3'), bell: new Audio('https://cdn.freesound.org/previews/336/336899_4939433-lq.mp3'), saff: new Audio('https://cdn.freesound.org/previews/614/614742_11430489-lq.mp3'), wild: new Audio('https://cdn.freesound.org/previews/320/320653_5260872-lq.mp3'), thunder: new Audio('https://cdn.freesound.org/previews/173/173930_2394245-lq.mp3') };
        Object.values(sounds).forEach(s => { s.volume = 0.25; s.load(); });
        function playSound(key) { if(sounds[key]) { sounds[key].currentTime = 0; sounds[key].play().catch(e=>console.log(e)); } }
    </script>
    <script src="/socket.io/socket.io.js"></script>
    <script>
        const socket = io(); let myId = ''; let isMyTurn = false; let pendingCardId = null; let pendingGraceDefense = false; let amIDead = false;
        function joinGame() { playSound('soft'); socket.emit('join', document.getElementById('username').value); document.getElementById('login').style.display = 'none'; }
        function requestStart() { socket.emit('requestStart'); }
        function toggleRules() { const m = document.getElementById('rules-modal'); m.style.display = (m.style.display === 'flex') ? 'none' : 'flex'; }
        socket.on('connect', () => myId = socket.id); socket.on('playSound', (key) => playSound(key));
        socket.on('notification', (msg) => { const el = document.getElementById('notification'); el.innerText = msg; el.style.display = 'block'; setTimeout(() => el.style.display = 'none', 3000); });
        socket.on('showDivine', (msg) => { const el = document.getElementById('divine-alert'); el.innerText = msg; el.style.display = 'block'; playSound('divine'); setTimeout(() => el.style.display = 'none', 4000); });
        socket.on('countdownTick', (n) => { document.getElementById('lobby').style.display = 'none'; document.getElementById('game-area').style.display = 'flex'; const ov = document.getElementById('countdown-overlay'); ov.style.display = 'flex'; ov.innerText = n; if(n===0) ov.style.display = 'none'; });
        socket.on('shakeScreen', () => { document.body.classList.add('shake-screen'); setTimeout(() => document.body.classList.remove('shake-screen'), 500); });
        socket.on('cardPlayedEffect', () => { const top = document.getElementById('top-card'); top.classList.remove('pop-anim'); void top.offsetWidth; top.classList.add('pop-anim'); });
        socket.on('chatMessage', (msg) => { const box = document.getElementById('chat-messages'); const div = document.createElement('div'); div.className = 'chat-msg'; div.innerHTML = \`<span class="chat-name">\${msg.name}:</span> \${msg.text}\`; box.appendChild(div); box.scrollTop = box.scrollHeight; });
        function handleChat(e) { if(e.key === 'Enter') { const val = e.target.value; if(val) socket.emit('sendChat', val); e.target.value = ''; } }
        socket.on('updateState', (state) => {
            hideAllScreens();
            const me = state.players.find(p => p.id === myId); amIDead = me ? me.isDead : false; isMyTurn = me ? me.isTurn : false;
            if(!isMyTurn && !pendingGraceDefense) document.getElementById('color-picker').style.display = 'none';
            if (state.state === 'waiting') { document.getElementById('lobby').style.display = 'flex'; document.getElementById('lobby-list').innerHTML = state.players.map(p => \`<div>\${p.name}</div>\`).join(''); document.getElementById('btn-start').style.display = state.players.length >= 1 ? 'block' : 'none'; }
            else if (state.state === 'playing') { document.getElementById('game-area').style.display = 'flex'; renderGame(state); }
            else if (state.state === 'rip_decision') { const duel = state.duelInfo; if (myId === state.players.find(p => p.name === duel.defenderName)?.id) { document.getElementById('rip-decision-screen').style.display = 'flex'; } else { document.getElementById('game-area').style.display = 'flex'; } }
            else if (state.state === 'dueling') { document.getElementById('duel-arena').style.display = 'flex'; renderDuel(state); }
        });
        socket.on('handUpdate', (hand) => {
            const hasGrace = hand.some(c => c.value === 'GRACIA'); if(hasGrace) document.getElementById('grace-option').style.display = 'block'; else document.getElementById('grace-option').style.display = 'none';
            const div = document.getElementById('my-hand'); div.innerHTML = '';
            hand.forEach((c, index) => {
                const el = document.createElement('div'); let cssClass = c.color; if(c.value==='RIP') cssClass='death-card'; else if(c.value==='GRACIA') cssClass='divine-card'; else if(c.value==='+12') cssClass='mega-wild';
                el.className = \`card \${cssClass} \${amIDead ? 'zombie' : ''} card-enter\`; el.style.animationDelay = \`\${index * 0.05}s\`; el.innerText = c.value === 'RIP' ? '🪦' : (c.value === 'GRACIA' ? '❤️' : c.value);
                if(!amIDead) { el.onclick = () => { if (c.color === 'negro' && !isMyTurn) return; if(c.color === 'negro' && c.value !== 'GRACIA') { if(c.value === 'RIP') socket.emit('playCard', c.id, null); else { pendingCardId = c.id; document.getElementById('color-picker').style.display = 'block'; } } else socket.emit('playCard', c.id, null); }; }
                div.appendChild(el);
            });
        });
        function renderGame(state) {
            document.body.className = state.activeColor ? 'bg-'+state.activeColor : ''; const top = state.topCard; const topEl = document.getElementById('top-card'); let css = 'negro'; let txt = '';
            if(top) { css = top.color; if(top.value === 'RIP') css = 'death-card'; else if(top.value === 'GRACIA') css = 'divine-card'; else if(top.value === '+12') css = 'mega-wild'; else if(top.color === 'negro') css = state.activeColor; txt = top.value === 'RIP' ? '🪦' : (top.value === 'GRACIA' ? '❤️' : top.value); }
            topEl.className = \`card \${css}\`; topEl.innerText = txt;
            const pList = document.getElementById('players-list'); pList.innerHTML = '';
            state.players.forEach(p => { const b = document.createElement('div'); b.className = \`player-badge \${p.isTurn ? 'is-turn' : ''} \${p.isDead ? 'is-dead' : ''}\`; b.innerText = \`\${p.name} (\${p.cardCount})\`; pList.appendChild(b); });
            const me = state.players.find(p => p.id === myId); const btnPass = document.getElementById('btn-pass');
            if(me && me.isTurn && me.hasDrawn && state.pendingPenalty === 0) btnPass.style.display = 'inline-block'; else btnPass.style.display = 'none';
            const alertEl = document.getElementById('penalty-alert'); if (me && me.isTurn && state.pendingPenalty > 0) { alertEl.style.display = 'block'; document.getElementById('penalty-count').innerText = state.pendingPenalty; } else { alertEl.style.display = 'none'; }
        }
        function renderDuel(state) {
            const d = state.duelInfo; document.getElementById('duel-vs').innerText = \`\${d.attackerName} vs \${d.defenderName}\`; document.getElementById('duel-score').innerText = \`Round \${d.round} | \${d.scoreAttacker} - \${d.scoreDefender}\`;
            const me = state.players.find(p => p.id === myId); const isFighter = (me.name === d.attackerName || me.name === d.defenderName);
            if(isFighter) { document.getElementById('duel-controls').style.display = 'block'; document.getElementById('duel-spectator').style.display = 'none'; ['fuego','hielo','agua'].forEach(type => { const btn = document.getElementById('btn-'+type); if(d.myChoice === type) btn.classList.add('selected'); else btn.classList.remove('selected'); }); } else { document.getElementById('duel-controls').style.display = 'none'; document.getElementById('duel-spectator').style.display = 'block'; }
            document.getElementById('duel-history').innerHTML = d.history.map(h => \`<div>R\${h.round}: Ganó \${h.winnerName}</div>\`).join('');
        }
        function hideAllScreens() { ['login','lobby','game-area','rip-decision-screen','duel-arena'].forEach(id => { const el = document.getElementById(id); if(el) el.style.display = 'none'; }); }
        function drawCard() { if(!amIDead) socket.emit('draw'); } function passTurn() { if(!amIDead) socket.emit('passTurn'); } function sayUno() { if(!amIDead) socket.emit('sayUno'); }
        function selectColor(c) { if(pendingGraceDefense) { socket.emit('playGraceDefense', c); pendingGraceDefense = false; } else { socket.emit('playCard', pendingCardId, c); pendingCardId = null; } document.getElementById('color-picker').style.display = 'none'; }
        function ripResponse(d) { socket.emit('ripDecision', d); } function duelPick(c) { socket.emit('duelPick', c); } function playGraceDefense() { pendingGraceDefense = true; document.getElementById('color-picker').style.display = 'block'; }
    </script>
</body>
</html>
`);
});

// FIX: PORT ENV VARIABLE
http.listen(process.env.PORT || 3000, () => { console.log('UNO y 1/2 V15.2 READY'); });
