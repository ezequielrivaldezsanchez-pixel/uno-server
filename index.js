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
    '0':0, '1':1, '1 y 1/2':1.5, '2':2, '3':3, '4':4, '5':5, '6':6, '7':7, '8':8, '9':9,
    '+2': 20, 'X': 21, 'R': 22,
    'color': 50, '+4': 51, '+12': 52, 'RIP': 53, 'LIBRE': 54, 'GRACIA': 55
};
const sortColWeights = { 'rojo':1, 'azul':2, 'verde':3, 'amarillo':4, 'negro':5 };

const colors = ['rojo', 'azul', 'verde', 'amarillo'];
const values = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '1 y 1/2', '+2', 'X', 'R'];

setInterval(() => {
    const now = Date.now();
    Object.keys(rooms).forEach(roomId => {
        if (now - rooms[roomId].lastActivity > 7200000) delete rooms[roomId];
    });
}, 300000); 

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
    room.deck.push({ color: 'negro', value: 'RIP', type: 'death', id: Math.random().toString(36) }, { color: 'negro', value: 'RIP', type: 'death', id: Math.random().toString(36) });
    room.deck.push({ color: 'negro', value: 'GRACIA', type: 'divine', id: Math.random().toString(36) }, { color: 'negro', value: 'GRACIA', type: 'divine', id: Math.random().toString(36) });
    room.deck.push({ color: 'negro', value: '+12', type: 'wild', id: Math.random().toString(36) }, { color: 'negro', value: '+12', type: 'wild', id: Math.random().toString(36) });
    for(let k=0; k<2; k++) room.deck.push({ color: 'negro', value: 'LIBRE', type: 'special', id: Math.random().toString(36) });
    
    for (let i = room.deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [room.deck[i], room.deck[j]] = [room.deck[j], room.deck[i]];
    }
}

function recycleDeck(roomId) {
    const room = rooms[roomId]; if(!room) return;
    if (room.discardPile.length <= 1) { createDeck(roomId); return; }
    const topCard = room.discardPile.pop();
    room.deck = [...room.discardPile]; room.discardPile = [topCard];
    for (let i = room.deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [room.deck[i], room.deck[j]] = [room.deck[j], room.deck[i]];
    }
}

io.on('connection', (socket) => {
    socket.on('checkSession', (uuid) => {
        for (const rId in rooms) { 
            const p = rooms[rId].players.find(pl => pl.uuid === uuid); 
            if (p) {
                p.id = socket.id; p.isConnected = true;
                socket.join(rId); touchRoom(rId); updateAll(rId);
                return;
            } 
        }
        socket.emit('requireLogin');
    });

    socket.on('createRoom', (data) => {
        const roomId = Math.random().toString(36).substring(2, 6).toUpperCase(); initRoom(roomId);
        const player = { id: socket.id, uuid: data.uuid, name: data.name.substring(0, 15), hand: [], hasDrawn: false, isSpectator: false, isDead: false, isAdmin: true, isConnected: true };
        rooms[roomId].players.push(player); socket.join(roomId); socket.emit('roomCreated', { roomId, name: data.name }); updateAll(roomId);
    });

    socket.on('joinRoom', (data) => {
        const roomId = data.roomId.toUpperCase(); const room = rooms[roomId];
        if (!room) { socket.emit('error', 'Sala no encontrada.'); return; }
        const existing = room.players.find(p => p.uuid === data.uuid);
        if (existing) { existing.id = socket.id; existing.isConnected = true; socket.join(roomId); socket.emit('roomJoined', { roomId }); }
        else {
            const player = { id: socket.id, uuid: data.uuid, name: data.name, hand: [], hasDrawn: false, isSpectator: (room.gameState !== 'waiting'), isDead: false, isAdmin: (room.players.length === 0), isConnected: true };
            room.players.push(player); socket.join(roomId); socket.emit('roomJoined', { roomId });
        }
        updateAll(roomId);
    });

    socket.on('playMultiCards', (cardIds) => {
        const roomId = getRoomId(socket); if(!roomId || !rooms[roomId]) return;
        const room = rooms[roomId];
        const pIndex = room.players.findIndex(p => p.id === socket.id);
        const player = room.players[pIndex];
        if (room.gameState !== 'playing' || pIndex !== room.currentTurn || room.pendingPenalty > 0) return;

        let playCards = [];
        for(let id of cardIds) {
            const c = player.hand.find(x => x.id === id);
            if(!c) return; 
            playCards.push(c);
        }
        const top = room.discardPile[room.discardPile.length - 1];

        if (playCards.length === 2 && playCards[0].value === '1 y 1/2' && playCards[1].value === '1 y 1/2') {
            if (playCards[0].color !== playCards[1].color || top.value !== '3') { socket.emit('notification', '🚫 Combo 1.5 + 1.5 solo sobre un 3 del mismo color.'); return; }
            cardIds.forEach(id => { const idx = player.hand.findIndex(c => c.id === id); player.hand.splice(idx, 1); });
            room.discardPile.push(...playCards); room.activeColor = playCards[0].color;
            io.to(roomId).emit('notification', `✨ COMBO MATEMÁTICO de ${player.name}`);
        } else {
            const firstColor = playCards[0].color;
            if(firstColor === 'negro' || !playCards.every(c => c.color === firstColor)) { socket.emit('notification', '🚫 Escaleras: mismo color y no negras.'); return; }
            const indices = playCards.map(c => ladderOrder.indexOf(c.value)).sort((a,b) => a-b);
            for(let i = 0; i < indices.length - 1; i++) { if(indices[i+1] !== indices[i] + 1) { socket.emit('notification', '🚫 No son consecutivas.'); return; } }

            let valid = false;
            if (playCards.length === 2) {
                const topIdx = ladderOrder.indexOf(top.value);
                if (top.color === firstColor && (indices[0] === topIdx + 1 && indices[1] === topIdx + 2 || indices[1] === topIdx - 1 && indices[0] === topIdx - 2)) valid = true;
            } else if (playCards.length >= 3) {
                if (firstColor === room.activeColor || playCards.some(c => c.value === top.value)) valid = true;
            }

            if (!valid) { socket.emit('notification', '🚫 Escalera inválida con la mesa.'); return; }
            cardIds.forEach(id => { const idx = player.hand.findIndex(c => c.id === id); player.hand.splice(idx, 1); });
            room.discardPile.push(...playCards); room.activeColor = firstColor;
            io.to(roomId).emit('notification', `🪜 Escalera de ${player.name}`);
        }
        if(player.hand.length === 0) finishRound(roomId, player); else { advanceTurn(roomId, 1); updateAll(roomId); }
    });

    socket.on('playCard', (cardId, chosenColor) => {
        const roomId = getRoomId(socket); if(!roomId || !rooms[roomId]) return;
        const room = rooms[roomId]; if (room.gameState !== 'playing') return;
        const pIndex = room.players.findIndex(p => p.id === socket.id);
        const player = room.players[pIndex];
        const cardIdx = player.hand.findIndex(c => c.id === cardId);
        if (cardIdx === -1) return;
        const card = player.hand[cardIdx];
        const top = room.discardPile[room.discardPile.length - 1];

        let isSaff = (pIndex !== room.currentTurn && card.value === top.value && card.color === top.color && card.color !== 'negro' && room.pendingPenalty === 0);
        if (pIndex !== room.currentTurn && !isSaff) return;

        if (card.value === 'RIP') {
            if (getAlivePlayersCount(roomId) < 2) return socket.emit('notification', 'No hay a quién retar.');
            player.hand.splice(cardIdx, 1); room.discardPile.push(card);
            room.gameState = 'rip_decision';
            const victimIdx = getNextPlayerIndex(roomId, 1);
            const defender = room.players[victimIdx];
            room.duelState = { attackerId: player.id, defenderId: defender.id, attackerName: player.name, defenderName: defender.name, round: 1, scoreAttacker: 0, scoreDefender: 0, turn: player.id, narrative: `⚔️ ¡${player.name} te ha desafiado a muerte!` };
            updateAll(roomId); return;
        }

        player.hand.splice(cardIdx, 1); room.discardPile.push(card);
        if (card.color === 'negro' && chosenColor) room.activeColor = chosenColor; else if (card.color !== 'negro') room.activeColor = card.color;
        
        if (['+2', '+4', '+12'].includes(card.value)) room.pendingPenalty += parseInt(card.value.replace('+',''));
        if (player.hand.length === 0) finishRound(roomId, player); else { if(!isSaff || room.currentTurn === pIndex) advanceTurn(roomId, (card.value==='X'?2:1)); room.currentTurn = pIndex; updateAll(roomId); }
    });

    socket.on('draw', () => {
        const roomId = getRoomId(socket); if(!roomId || !rooms[roomId]) return;
        const room = rooms[roomId]; const pIdx = room.players.findIndex(p => p.id === socket.id);
        if (pIdx !== room.currentTurn) return;
        if (room.pendingPenalty > 0) { drawCards(roomId, pIdx, 1); room.pendingPenalty--; if(room.pendingPenalty === 0) advanceTurn(roomId, 1); }
        else if (!room.players[pIdx].hasDrawn) { drawCards(roomId, pIdx, 1); room.players[pIdx].hasDrawn = true; }
        updateAll(roomId);
    });

    socket.on('passTurn', () => {
        const roomId = getRoomId(socket); if(!roomId || !rooms[roomId]) return;
        const room = rooms[roomId]; const pIdx = room.players.findIndex(p => p.id === socket.id);
        if (pIdx === room.currentTurn && room.players[pIdx].hasDrawn) { advanceTurn(roomId, 1); updateAll(roomId); }
    });

    socket.on('ripDecision', (d) => {
        const roomId = getRoomId(socket); if(!roomId) return;
        const room = rooms[roomId];
        if (d === 'surrender') { eliminatePlayer(roomId, room.duelState.defenderId); checkWinCondition(roomId); }
        else { room.gameState = 'dueling'; updateAll(roomId); }
    });

    socket.on('duelPick', (c) => {
        const roomId = getRoomId(socket); if(!roomId) return;
        const room = rooms[roomId]; if (socket.id === room.duelState.attackerId) { room.duelState.attackerChoice = c; room.duelState.turn = room.duelState.defenderId; }
        else { room.duelState.defenderChoice = c; resolveDuelRound(roomId); }
        updateAll(roomId);
    });

    socket.on('requestStart', () => {
        const roomId = getRoomId(socket); if(rooms[roomId]) startCountdown(roomId);
    });
    
    socket.on('requestSort', () => {
        const roomId = getRoomId(socket); const room = rooms[roomId];
        const p = room.players.find(x => x.id === socket.id);
        if(p) { p.hand.sort((a,b) => (sortColWeights[a.color]-sortColWeights[b.color]) || (sortValWeights[a.value]-sortValWeights[b.value])); io.to(p.id).emit('handUpdate', p.hand); }
    });

    socket.on('sendChat', (text) => {
        const roomId = getRoomId(socket); if(!rooms[roomId]) return;
        const p = rooms[roomId].players.find(x => x.id === socket.id);
        if(p) { const msg = {name: p.name, text}; rooms[roomId].chatHistory.push(msg); io.to(roomId).emit('chatMessage', msg); }
    });
});

function getRoomId(socket) { return Array.from(socket.rooms).find(r => r !== socket.id); }
function advanceTurn(roomId, steps) {
    const room = rooms[roomId]; room.players.forEach(p => p.hasDrawn = false);
    while (steps > 0) { room.currentTurn = (room.currentTurn + room.direction + room.players.length) % room.players.length; if (!room.players[room.currentTurn].isDead && !room.players[room.currentTurn].isSpectator) steps--; }
}
function getNextPlayerIndex(roomId, steps) {
    const room = rooms[roomId]; let next = room.currentTurn;
    while (steps > 0) { next = (next + room.direction + room.players.length) % room.players.length; if (!room.players[next].isDead && !room.players[next].isSpectator) steps--; }
    return next;
}
function drawCards(roomId, pid, n) { 
    const room = rooms[roomId]; for (let i = 0; i < n; i++) { if (room.deck.length === 0) recycleDeck(roomId); room.players[pid].hand.push(room.deck.pop()); } 
}
function eliminatePlayer(roomId, id) { const p = rooms[roomId].players.find(p => p.id === id); if(p) p.isDead = true; }
function getAlivePlayersCount(roomId) { return rooms[roomId].players.filter(p => !p.isDead && !p.isSpectator).length; }
function checkWinCondition(roomId) { if (getAlivePlayersCount(roomId) <= 1) finishRound(roomId, rooms[roomId].players.find(p => !p.isDead && !p.isSpectator)); else { rooms[roomId].gameState = 'playing'; advanceTurn(roomId, 1); updateAll(roomId); } }
function finishRound(roomId, w) { io.to(roomId).emit('gameOver', { winner: w.name }); delete rooms[roomId]; }
function startCountdown(roomId) {
    const room = rooms[roomId]; room.gameState = 'playing'; createDeck(roomId);
    room.discardPile = [room.deck.pop()]; room.activeColor = room.discardPile[0].color;
    room.players.forEach((p, i) => { if(!p.isSpectator) { p.hand = []; drawCards(roomId, i, 7); } });
    updateAll(roomId);
}
function resolveDuelRound(roomId) {
    const room = rooms[roomId]; const att = room.duelState.attackerChoice, def = room.duelState.defenderChoice;
    if (att !== def) {
        if ((att=='fuego'&&def=='hielo') || (att=='hielo'&&def=='agua') || (att=='agua'&&def=='fuego')) room.duelState.scoreAttacker++;
        else room.duelState.scoreDefender++;
    }
    room.duelState.attackerChoice = null; room.duelState.defenderChoice = null; room.duelState.turn = room.duelState.attackerId;
    if (room.duelState.scoreAttacker >= 2 || room.duelState.scoreDefender >= 2) {
        if (room.duelState.scoreAttacker >= 2) eliminatePlayer(roomId, room.duelState.defenderId);
        room.gameState = 'playing'; advanceTurn(roomId, 1);
    } else room.duelState.round++;
    updateAll(roomId);
}

function updateAll(roomId) {
    const room = rooms[roomId]; if(!room) return;
    room.players.forEach(p => {
        const pack = { state: room.gameState, roomId: roomId, iamAdmin: p.isAdmin, players: room.players.map(pl => ({ name: pl.name, cardCount: pl.hand.length, isTurn: (room.players[room.currentTurn].id === pl.id), isDead: pl.isDead, isSpectator: pl.isSpectator, isAdmin: pl.isAdmin, isConnected: pl.isConnected })), topCard: room.discardPile[room.discardPile.length-1], activeColor: room.activeColor, pendingPenalty: room.pendingPenalty, duelInfo: (room.gameState === 'dueling' || room.gameState === 'rip_decision' ? room.duelState : null), chatHistory: room.chatHistory };
        io.to(p.id).emit('updateState', pack); io.to(p.id).emit('handUpdate', p.hand);
    });
}

// --- CLIENTE ---
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>UNO y 1/2 v10.3</title>
    <style>
        body { margin: 0; font-family: sans-serif; background: #1e272e; color: white; overflow: hidden; height: 100vh; display: flex; flex-direction: column; }
        .screen { display: none; flex-direction: column; align-items: center; justify-content: center; height: 100%; position: absolute; width: 100%; top: 0; left: 0; }
        #game-area { display: none; flex-direction: column; height: 100%; position: relative; }
        #players { display: flex; justify-content: center; gap: 10px; padding: 10px; background: rgba(0,0,0,0.3); flex-wrap: wrap; }
        .player { padding: 5px 10px; border-radius: 15px; background: #333; font-size: 11px; border: 1px solid #555; }
        .is-turn { background: #2ecc71; border-color: white; transform: scale(1.05); }
        .is-dead { text-decoration: line-through; opacity: 0.5; }
        #table { flex: 1; display: flex; justify-content: center; align-items: center; gap: 20px; }
        .card { width: 75px; height: 110px; border-radius: 8px; border: 2px solid white; display: flex; justify-content: center; align-items: center; font-size: 22px; font-weight: bold; position: relative; transition: 0.2s; box-shadow: 0 4px 8px rgba(0,0,0,0.5); }
        #hand { height: 155px; display: flex; align-items: center; padding: 0 15px; gap: 8px; overflow-x: auto; background: rgba(0,0,0,0.5); border-top: 2px solid #444; }
        .hand-card { flex-shrink: 0; cursor: pointer; user-select: none; -webkit-touch-callout: none; -webkit-tap-highlight-color: transparent; }
        .selected { border: 4px solid #00d2ff !important; transform: translateY(-15px); box-shadow: 0 8px 15px rgba(0,210,255,0.5); }
        #controls { position: fixed; bottom: 170px; width: 100%; display: flex; justify-content: center; gap: 10px; pointer-events: none; }
        .btn { pointer-events: auto; padding: 10px 20px; border-radius: 20px; border: none; font-weight: bold; cursor: pointer; color: white; font-size: 13px; }
        #btn-play { background: #2ecc71; display: none; }
        #btn-cancel { background: #e74c3c; display: none; }
        #btn-draw { background: #3498db; }
        #rip-overlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.95); z-index: 5000; display: none; flex-direction: column; align-items: center; justify-content: center; text-align: center; }
        #color-picker { display: none; position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); background: white; padding: 15px; border-radius: 12px; z-index: 6000; box-shadow: 0 0 30px black; }
        .color-btn { width: 50px; height: 50px; border-radius: 50%; display: inline-block; margin: 8px; border: 2px solid #ccc; }
        
        /* CHAT Y REGLAS */
        #chat-btn { position: fixed; top: 10px; right: 10px; background: #3498db; padding: 10px; border-radius: 50%; cursor: pointer; z-index: 100; border: 2px solid white; }
        #chat-win { display: none; position: fixed; bottom: 160px; right: 10px; width: 250px; height: 300px; background: rgba(0,0,0,0.95); border: 2px solid #555; z-index: 500; flex-direction: column; }
    </style>
</head>
<body>
    <div id="login" class="screen" style="display:flex;">
        <h1 style="color:gold;">UNO y 1/2</h1>
        <input id="name-in" type="text" placeholder="Tu Nombre" style="padding:10px; border-radius:5px; border:none; margin-bottom:10px;">
        <button class="btn" onclick="createRoom()" style="background:#27ae60; width:170px;">CREAR SALA</button>
        <div style="margin:10px;">o</div>
        <input id="code-in" type="text" placeholder="Código" style="padding:10px; border-radius:5px; border:none; margin-bottom:10px; text-transform:uppercase;">
        <button class="btn" onclick="joinRoom()" style="background:#2980b9; width:170px;">UNIRSE</button>
    </div>

    <div id="lobby" class="screen">
        <h2>SALA: <span id="room-id-display" style="color:gold;"></span></h2>
        <div id="lobby-list" style="background:rgba(0,0,0,0.3); padding:20px; border-radius:10px; width:200px; margin-bottom:20px;"></div>
        <button id="start-btn" class="btn" onclick="requestStart()" style="background:#2ecc71; display:none;">EMPEZAR</button>
        <p id="wait-msg" style="color:#aaa;">Esperando al admin...</p>
    </div>

    <div id="game-area">
        <div id="players"></div>
        <div id="table">
            <div id="deck" class="card" style="background:#c0392b; cursor:pointer;" onclick="draw()">📦</div>
            <div id="top-card" class="card"></div>
        </div>
        <div id="controls">
            <button id="btn-play" class="btn" onclick="sendMulti()">JUGAR SELECCIÓN</button>
            <button id="btn-cancel" class="btn" onclick="cancelSelect()">CANCELAR X</button>
            <button id="btn-sort" class="btn" onclick="socket.emit('requestSort')" style="background:#576574; pointer-events:auto;">ORDENAR</button>
        </div>
        <div id="hand"></div>
    </div>

    <div id="rip-overlay">
        <h1 style="color:red; font-size:40px;">💀 RIP 💀</h1>
        <h3 id="rip-msg" style="padding:20px; color:#69f0ae;"></h3>
        <div id="rip-btns">
            <button class="btn" onclick="ripAction('duel')" style="background:red;">ACEPTAR</button>
            <button class="btn" onclick="ripAction('surrender')" style="background:#333; margin-top:10px;">RENDIRSE</button>
        </div>
        <div id="duel-opts" style="display:none; margin-top:20px;">
            <button class="btn" onclick="socket.emit('duelPick','fuego')" style="font-size:30px; background:none;">🔥</button>
            <button class="btn" onclick="socket.emit('duelPick','hielo')" style="font-size:30px; background:none;">❄️</button>
            <button class="btn" onclick="socket.emit('duelPick','agua')" style="font-size:30px; background:none;">💧</button>
        </div>
    </div>

    <div id="color-picker">
        <div class="color-btn" style="background:red" onclick="pickColor('rojo')"></div>
        <div class="color-btn" style="background:blue" onclick="pickColor('azul')"></div>
        <div class="color-btn" style="background:green" onclick="pickColor('verde')"></div>
        <div class="color-btn" style="background:yellow" onclick="pickColor('amarillo')"></div>
    </div>

    <script src="/socket.io/socket.io.js"></script>
    <script>
        const socket = io();
        let myUUID = localStorage.getItem('uno_uuid') || Math.random().toString(36).substring(2);
        localStorage.setItem('uno_uuid', myUUID);
        
        let selectedCards = [];
        let selectionMode = false;
        let pressTimer;

        const clickSound = new Audio('https://cdn.freesound.org/previews/242/242501_4414128-lq.mp3');
        clickSound.volume = 0.2;

        socket.on('connect', () => socket.emit('checkSession', myUUID));
        socket.on('requireLogin', () => showScreen('login'));

        function showScreen(id) {
            document.querySelectorAll('.screen').forEach(s => s.style.display='none');
            document.getElementById('game-area').style.display='none';
            document.getElementById(id).style.display='flex';
        }

        function createRoom() { socket.emit('createRoom', { name: document.getElementById('name-in').value, uuid: myUUID }); }
        function joinRoom() { socket.emit('joinRoom', { roomId: document.getElementById('code-in').value, name: document.getElementById('name-in').value, uuid: myUUID }); }
        function requestStart() { socket.emit('requestStart'); }

        socket.on('roomCreated', d => { showScreen('lobby'); document.getElementById('room-id-display').innerText = d.roomId; });
        socket.on('roomJoined', d => { showScreen('lobby'); document.getElementById('room-id-display').innerText = d.roomId; });

        socket.on('updateState', s => {
            if(s.state === 'waiting') {
                showScreen('lobby');
                document.getElementById('lobby-list').innerHTML = s.players.map(p => '<div>' + (p.isConnected?'🟢':'🔴') + ' ' + p.name + '</div>').join('');
                document.getElementById('start-btn').style.display = s.iamAdmin ? 'block' : 'none';
                document.getElementById('wait-msg').style.display = s.iamAdmin ? 'none' : 'block';
                return;
            }
            showScreen('game-area');
            document.getElementById('players').innerHTML = s.players.map(p => 
                '<div class="player ' + (p.isTurn?'is-turn':'') + ' ' + (p.isDead?'is-dead':'') + '">' + p.name + ' (' + p.cardCount + ')</div>'
            ).join('');
            
            const top = document.getElementById('top-card');
            top.innerText = s.topCard.value;
            top.style.backgroundColor = getHex(s.topCard.color);
            document.body.style.backgroundColor = getHex(s.activeColor, true);

            const rip = document.getElementById('rip-overlay');
            if (s.duelInfo) {
                rip.style.display = 'flex';
                document.getElementById('rip-msg').innerText = s.duelInfo.narrative;
                const isMe = (socket.id === s.duelInfo.attackerId || socket.id === s.duelInfo.defenderId);
                document.getElementById('rip-btns').style.display = (s.state === 'rip_decision' && socket.id === s.duelInfo.defenderId) ? 'block' : 'none';
                document.getElementById('duel-opts').style.display = (s.state === 'dueling' && isMe && s.duelInfo.turn === socket.id) ? 'block' : 'none';
            } else rip.style.display = 'none';

            const me = s.players.find(p => p.name === document.getElementById('name-in').value);
            if(me && !me.isTurn) cancelSelect();
        });

        socket.on('handUpdate', hand => {
            const container = document.getElementById('hand');
            container.innerHTML = '';
            hand.forEach(c => {
                const el = document.createElement('div');
                el.className = 'card hand-card' + (selectedCards.includes(c.id) ? ' selected' : '');
                el.style.backgroundColor = getHex(c.color);
                el.innerText = c.value;
                
                el.onmousedown = el.ontouchstart = () => {
                    pressTimer = setTimeout(() => {
                        if(!selectionMode) {
                            selectionMode = true;
                            if(navigator.vibrate) navigator.vibrate(50);
                            clickSound.play();
                            toggleSelect(c.id, el);
                        }
                    }, 800);
                };
                el.onmouseup = el.onmouseleave = el.ontouchend = () => clearTimeout(pressTimer);
                
                el.onclick = () => {
                    if (selectionMode) {
                        clickSound.play();
                        toggleSelect(c.id, el);
                    } else {
                        if (c.color === 'negro') { window.pendingCard = c.id; document.getElementById('color-picker').style.display='block'; }
                        else socket.emit('playCard', c.id);
                    }
                };
                container.appendChild(el);
            });
        });

        function toggleSelect(id, el) {
            if (selectedCards.includes(id)) {
                selectedCards = selectedCards.filter(i => i !== id);
                el.classList.remove('selected');
            } else {
                selectedCards.push(id);
                el.classList.add('selected');
            }
            const active = selectedCards.length > 0;
            document.getElementById('btn-play').style.display = selectedCards.length >= 2 ? 'block' : 'none';
            document.getElementById('btn-cancel').style.display = active ? 'block' : 'none';
            if (!active) selectionMode = false;
        }

        function cancelSelect() {
            selectedCards = []; selectionMode = false;
            document.getElementById('btn-play').style.display = 'none';
            document.getElementById('btn-cancel').style.display = 'none';
            document.querySelectorAll('.hand-card').forEach(c => c.classList.remove('selected'));
        }

        function sendMulti() { socket.emit('playMultiCards', selectedCards); cancelSelect(); }
        function draw() { socket.emit('draw'); }
        function pickColor(c) { socket.emit('playCard', window.pendingCard, c); document.getElementById('color-picker').style.display='none'; }
        function ripAction(a) { socket.emit('ripDecision', a); }

        function getHex(c, dark = false) {
            const colors = { rojo: '#e74c3c', azul: '#3498db', verde: '#2ecc71', amarillo: '#f1c40f', negro: '#2d3436' };
            const darkColors = { rojo: '#4a1c1c', azul: '#1c2a4a', verde: '#1c4a2a', amarillo: '#4a451c', negro: '#1e272e' };
            return (dark ? darkColors[c] : colors[c]) || '#1e272e';
        }
        
        socket.on('notification', m => alert(m));
        socket.on('error', m => alert(m));
        socket.on('gameOver', d => { alert("GANADOR: " + d.winner); location.reload(); });
    </script>
</body>
</html>
    `);
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log('Servidor en puerto ' + PORT));
