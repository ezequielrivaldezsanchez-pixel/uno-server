
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
    players.forEach(p => { p.hand = []; p.hasDrawn = false; p.isDead = false; p.isSpectator = true; });
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
    for(let i=0; i<2; i++) { deck.push({ color: 'negro', value: '+12', type: 'wild', id: Math.random().toString(36) }); }
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
    io.emit('notification', '♻️ Barajando mazo...');
}

// --- SOCKET LOGIC ---
io.on('connection', (socket) => {
    socket.on('join', (name) => {
        const player = { id: socket.id, name: name.substring(0, 12), hand: [], hasDrawn: false, isSpectator: gameState !== 'waiting', isDead: false };
        players.push(player);
        updateAll();
    });

    socket.on('requestStart', () => { if(gameState === 'waiting' && players.length >= 1) startCountdown(); });

    socket.on('playCard', (cardId, chosenColor) => {
        if(gameState !== 'playing') return;
        const pIndex = players.findIndex(p => p.id === socket.id);
        const player = players[pIndex];
        const cardIndex = player.hand.findIndex(c => c.id === cardId);
        if(cardIndex === -1) return;
        const card = player.hand[cardIndex];
        const top = discardPile[discardPile.length - 1];

        if (pIndex === currentTurn) {
            let valid = (card.value === 'GRACIA' || card.color === 'negro' || card.color === activeColor || card.value === top.value);
            if (!valid) return;
        } else {
            if (card.value === top.value && card.color === top.color && card.color !== 'negro') {
                currentTurn = pIndex;
                io.emit('notification', `⚡ ¡SAFF de ${player.name}!`);
            } else return;
        }

        player.hand.splice(cardIndex, 1);
        discardPile.push(card);
        if (card.color === 'negro' && chosenColor) activeColor = chosenColor;
        else if (card.color !== 'negro') activeColor = card.color;

        if (card.value === '+2') pendingPenalty += 2;
        if (card.value === '+4') pendingPenalty += 4;
        if (card.value === '+12') pendingPenalty += 12;
        if (card.value === 'GRACIA') pendingPenalty = 0;

        if (player.hand.length === 0) { gameState = 'waiting'; io.emit('notification', `🎉 ¡${player.name} GANÓ!`); resetGame(); }
        else { advanceTurn(); }
        updateAll();
    });

    socket.on('draw', () => {
        const pIndex = players.findIndex(p => p.id === socket.id);
        if (pIndex !== currentTurn) return;
        if (deck.length === 0) recycleDeck();
        players[pIndex].hand.push(deck.pop());
        players[pIndex].hasDrawn = true;
        updateAll();
    });

    socket.on('passTurn', () => { advanceTurn(); updateAll(); });
    socket.on('disconnect', () => { players = players.filter(p => p.id !== socket.id); updateAll(); });
});

function advanceTurn() { currentTurn = (currentTurn + 1) % players.length; }

function startCountdown() {
    createDeck();
    discardPile = [deck.pop()];
    activeColor = discardPile[0].color === 'negro' ? 'rojo' : discardPile[0].color;
    players.forEach(p => { for(let i=0; i<7; i++) p.hand.push(deck.pop()); });
    gameState = 'playing';
}

function updateAll() {
    players.forEach((p, i) => {
        const state = {
            state: gameState,
            myHand: p.hand,
            topCard: discardPile[discardPile.length - 1],
            activeColor,
            isMyTurn: i === currentTurn,
            players: players.map(pl => ({ name: pl.name, count: pl.hand.length }))
        };
        io.to(p.id).emit('updateState', state);
    });
}

// --- CLIENTE HTML ---
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=0">
    <style>
        body { margin: 0; background: #1e272e; color: white; font-family: sans-serif; overflow: hidden; }
        .game-container { display: flex; flex-direction: column; height: 100vh; }
        
        /* MESA CENTRAL */
        .table { flex: 1; display: flex; flex-direction: column; justify-content: center; align-items: center; gap: 20px; }
        .card { width: 80px; height: 120px; border-radius: 10px; border: 3px solid white; display: flex; justify-content: center; align-items: center; font-size: 24px; font-weight: bold; text-shadow: 2px 2px black; }
        
        /* MANO DEL JUGADOR (SCROLL HORIZONTAL) */
        .hand-container { background: rgba(0,0,0,0.3); padding: 10px 0; height: 160px; overflow-x: auto; white-space: nowrap; -webkit-overflow-scrolling: touch; }
        .hand-container .card { display: inline-flex; margin: 0 5px; vertical-align: top; }
        
        /* COLORES */
        .rojo { background: #ff5e57; } .azul { background: #1e90ff; } .verde { background: #2ecc71; } .amarillo { background: #f1c40f; } .negro { background: #2f3542; border-color: gold; }
        
        /* UI */
        .ui-top { position: absolute; top: 10px; left: 10px; font-size: 14px; }
        #btn-rules { position: absolute; top: 10px; right: 10px; background: rgba(255,255,255,0.2); border: 1px solid white; color: white; border-radius: 5px; padding: 5px 10px; }
        .controls { padding: 10px; display: flex; justify-content: center; gap: 10px; }
        button { padding: 10px 20px; border-radius: 20px; border: none; font-weight: bold; cursor: pointer; }
        
        #modal-rules { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.9); z-index: 100; padding: 20px; overflow-y: auto; }
    </style>
</head>
<body>
    <div id="game" class="game-container">
        <div id="login" style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%;">
            <h1>UNO y 1/2</h1>
            <input id="nick" type="text" placeholder="Tu nombre" style="padding: 10px; border-radius: 10px; border: none;">
            <br>
            <button onclick="join()" style="background: #2ecc71; color: white;">ENTRAR</button>
        </div>

        <div id="board" style="display: none; height: 100%;">
            <div class="ui-top" id="player-info"></div>
            <button id="btn-rules" onclick="document.getElementById('modal-rules').style.display='block'">📜 Reglas</button>
            
            <div class="table">
                <div id="turn-indicator" style="font-weight: bold; color: gold;"></div>
                <div id="top-card" class="card"></div>
                <div id="color-msg"></div>
            </div>

            <div class="controls">
                <button onclick="socket.emit('draw')" style="background: #e74c3c; color: white;">ROBAR</button>
                <button onclick="socket.emit('passTurn')" style="background: #f39c12; color: white;">PASAR</button>
                <button onclick="socket.emit('requestStart')" id="start-btn" style="background: #2ecc71; color: white;">EMPEZAR</button>
            </div>

            <div class="hand-container" id="my-hand"></div>
        </div>
    </div>

    <div id="modal-rules" onclick="this.style.display='none'">
        <h2>Reglas Cortas</h2>
        <p><b>SAFF:</b> Tirar carta igual (color y número) fuera de turno.</p>
        <p><b>RIP:</b> Duelo a muerte. Perdedor es Zombie.</p>
        <p><b>Gracia:</b> Te salva de todo y revive zombies.</p>
        <p><b>Jerarquía:</b> +12 > +4 > +2.</p>
        <p style="color: gold;">Toca para cerrar.</p>
    </div>

    <script src="/socket.io/socket.io.js"></script>
    <script>
        const socket = io();
        function join() {
            const n = document.getElementById('nick').value;
            if(n) {
                socket.emit('join', n);
                document.getElementById('login').style.display = 'none';
                document.getElementById('board').style.display = 'flex';
            }
        }

        socket.on('updateState', (s) => {
            document.getElementById('top-card').className = 'card ' + s.topCard.color;
            document.getElementById('top-card').innerText = s.topCard.value;
            document.getElementById('turn-indicator').innerText = s.isMyTurn ? "¡TU TURNO!" : "Esperando...";
            document.body.style.boxShadow = "inset 0 0 100px " + (s.activeColor === 'rojo' ? '#ff5e57' : s.activeColor === 'azul' ? '#1e90ff' : s.activeColor === 'verde' ? '#2ecc71' : '#f1c40f');
            
            const hand = document.getElementById('my-hand');
            hand.innerHTML = '';
            s.myHand.forEach(c => {
                const div = document.createElement('div');
                div.className = 'card ' + c.color;
                div.innerText = c.value;
                div.onclick = () => {
                    if(c.color === 'negro') {
                        const col = prompt("Elige color: rojo, azul, verde, amarillo");
                        socket.emit('playCard', c.id, col);
                    } else socket.emit('playCard', c.id);
                };
                hand.appendChild(div);
            });
        });
        
        socket.on('notification', (m) => alert(m));
    </script>
</body>
</html>
`);
});

http.listen(process.env.PORT || 3000, () => { console.log('UNO 15.3 READY'); });
