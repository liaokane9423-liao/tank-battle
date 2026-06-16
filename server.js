const express  = require('express');
const http      = require('http');
const { Server } = require('socket.io');
const path      = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname)));

// rooms: code → { players: [{id, role}], seed }
const rooms = new Map();

function genCode() {
  let code;
  do { code = Math.random().toString(36).substr(2, 6).toUpperCase(); }
  while (rooms.has(code));
  return code;
}

io.on('connection', (socket) => {
  console.log('[+]', socket.id);

  // ── 建立房間 ──────────────────────────────────────────────────────────────
  socket.on('createRoom', () => {
    const code = genCode();
    const seed = Math.random();
    rooms.set(code, { players: [{ id: socket.id, role: 'p1' }], seed });
    socket.join(code);
    socket.roomCode = code;
    socket.role = 'p1';
    socket.emit('roomCreated', { code, role: 'p1' });
    console.log(`Room ${code} created by ${socket.id}`);
  });

  // ── 加入房間 ──────────────────────────────────────────────────────────────
  socket.on('joinRoom', (rawCode) => {
    const code = rawCode.toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) { socket.emit('roomError', '找不到房間'); return; }
    if (room.players.length >= 2) { socket.emit('roomError', '房間已滿'); return; }

    room.players.push({ id: socket.id, role: 'p2' });
    socket.join(code);
    socket.roomCode = code;
    socket.role = 'p2';
    socket.emit('joined', { role: 'p2', seed: room.seed });
    // 通知房間內所有人開始遊戲
    io.to(code).emit('gameStart', { seed: room.seed });
    console.log(`Room ${code}: ${socket.id} joined as p2`);
  });

  // ── 坦克狀態同步 ──────────────────────────────────────────────────────────
  socket.on('playerState', (s) => {
    if (socket.roomCode) socket.to(socket.roomCode).emit('opponentState', s);
  });

  // ── 子彈事件廣播 ──────────────────────────────────────────────────────────
  socket.on('bulletFired', (b) => {
    if (socket.roomCode) socket.to(socket.roomCode).emit('opponentBullet', b);
  });

  // ── 中斷連線 ──────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log('[-]', socket.id);
    if (socket.roomCode) {
      socket.to(socket.roomCode).emit('opponentLeft');
      rooms.delete(socket.roomCode);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Tank Battle server: http://localhost:${PORT}`));
