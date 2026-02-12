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

let duelState = {
    attackerId: null, defenderId: null, attackerName: '', defenderName: '',
    round: 1, scoreAttacker: 0, scoreDefender: 0,
    attackerChoice: null, defenderChoice: null, history: [] 
};

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
            const player = { id: socket.id, name: name.substring(0, 15), hand: [], hasDrawn: false, isSpectator: isLate, isDead: false };
            players.push(player);
            io.emit('notification', `👋 ${player.name} entró.`);
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
        if(gameState === 'waiting' && players.length >= 1) startCountdown();
    });

    socket.on('playCard', (cardId, chosenColor) => {
        if(gameState !== 'playing') return;
        const pIndex = players.findIndex(p => p.id === socket.id);
        if (pIndex === -1) return;
        const player = players[pIndex];
        const cardIndex = player.hand.findIndex(c => c.id === cardId);
        if(cardIndex === -1) return;
        const card = player.hand[cardIndex];
        const top = discardPile[discardPile.length - 1];

        // Reglas de juego básicas...
        player.hand.splice(cardIndex, 1);
        discardPile.push(card);
        if (card.color === 'negro' && chosenColor) activeColor = chosenColor;
        else if (card.color !== 'negro') activeColor = card.color;

        if (player.hand.length === 0) finishRound(player); 
        else { advanceTurn(); updateAll(); }
    });

    socket.on('draw', () => {
        if(gameState !== 'playing') return;
        const pIndex = players.findIndex(p => p.id === socket.id);
        if(pIndex === currentTurn) {
            if(deck.length === 0) recycleDeck();
            players[pIndex].hand.push(deck.pop());
            updateAll();
        }
    });

    socket.on('passTurn', () => {
        advanceTurn();
        updateAll();
    });

    socket.on('disconnect', () => {
        players = players.filter(pl => pl.id !== socket.id);
        updateAll();
    });
});

function advanceTurn() {
    currentTurn = (currentTurn + 1) % players.length;
}

function startCountdown() {
    createDeck();
    discardPile = [deck.pop()];
    activeColor = discardPile[0].color === 'negro' ? 'rojo' : discardPile[0].color;
    players.forEach(p => {
        p.hand = [];
        for(let i=0; i<7; i++) p.hand.push(deck.pop());
    });
    gameState = 'playing';
    updateAll();
}

function finishRound(w) {
    gameState = 'waiting';
    io.emit('notification', `🏆 ¡${w.name} ganó la ronda!`);
    resetGame();
    updateAll();
}

function updateAll() {
    players.forEach((p, i) => {
        const state = {
            state: gameState,
            players: players.map((pl, idx) => ({ name: pl.name, cardCount: pl.hand.length, isTurn: idx === currentTurn })),
            topCard: discardPile[discardPile.length - 1],
            activeColor,
            pendingPenalty
        };
        io.to(p.id).emit('updateState', state);
        io.to(p.id).emit('handUpdate', p.hand);
    });
}

// --- CLIENTE HTML ---
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        body { font-family: sans-serif; background: #1e272e; color: white; text-align: center; margin: 0; }
        .card { display: inline-flex; width: 70px; height: 100px; border: 2px solid white; border-radius: 8px; justify-content: center; align-items: center; font-weight: bold; margin: 5px; cursor: pointer; }
        .rojo { background: #ff4757; } .azul { background: #1e90ff; } .verde { background: #2ed573; } .amarillo { background: #eccc68; color: black; } .negro { background: #2f3542; border-color: gold; }
        #game-area { display: none; padding: 20px; }
        #my-hand { margin-top: 50px; border-top: 1px solid #555; padding-top: 20px; }
    </style>
</head>
<body>
    <div id="login">
        <h1>🃏 UNO y 1/2</h1>
        <input id="nick" type="text" placeholder="Tu Nombre">
        <button onclick="join()">Entrar</button>
    </div>
    <div id="game-area">
        <div id="status"></div>
        <div id="table">
            <p>Mesa:</p>
            <div id="top-card" class="card"></div>
        </div>
        <button onclick="socket.emit('draw')">Robar</button>
        <button onclick="socket.emit('passTurn')">Pasar</button>
        <button onclick="socket.emit('requestStart')">Empezar Juego</button>
        <div id="my-hand"></div>
    </div>
    <script src="/socket.io/socket.io.js"></script>
    <script>
        const socket = io();
        function join() {
            const n = document.getElementById('nick').value;
            if(n) {
                socket.emit('join', n);
                document.getElementById('login').style.display = 'none';
                document.getElementById('game-area').style.display = 'block';
            }
        }
        socket.on('updateState', (s) => {
            const top = document.getElementById('top-card');
            top.className = 'card ' + s.topCard.color;
            top.innerText = s.topCard.value;
            document.getElementById('status').innerText = s.state === 'playing' ? "En juego" : "Esperando...";
        });
        socket.on('handUpdate', (hand) => {
            const div = document.getElementById('my-hand');
            div.innerHTML = '';
            hand.forEach(c => {
                const el = document.createElement('div');
                el.className = 'card ' + c.color;
                el.innerText = c.value;
                el.onclick = () => {
                    if(c.color === 'negro') {
                        const col = prompt("Color? rojo, azul, verde, amarillo");
                        socket.emit('playCard', c.id, col);
                    } else socket.emit('playCard', c.id);
                };
                div.appendChild(el);
            });
        });
        socket.on('notification', (m) => alert(m));
    </script>
</body>
</html>
    `);
});

http.listen(process.env.PORT || 3000, () => { console.log('V15.2 READY'); });
