// ─── 常數 ───────────────────────────────────────────────────────────────────
const TILE = 32;
const COLS = 25;
const ROWS = 18;
const W = COLS * TILE; // 800
const H = ROWS * TILE; // 576
const HUD_H = 40;

const TILE_EMPTY = 0;
const TILE_BRICK = 1;
const TILE_STEEL = 2;
const TILE_BASE  = 3;

const DIR = { UP: 0, RIGHT: 1, DOWN: 2, LEFT: 3 };
const DX = [0, 1, 0, -1];
const DY = [-1, 0, 1, 0];

// ─── Canvas 設定 ─────────────────────────────────────────────────────────────
const canvas = document.getElementById('gameCanvas');
canvas.width  = W;
canvas.height = H + HUD_H;
const ctx = canvas.getContext('2d');

// ─── 遊戲狀態 ────────────────────────────────────────────────────────────────
const State = {
  MENU:         'menu',
  PVP:          'pvp',
  PVE:          'pve',
  UPGRADE:      'upgrade',
  OVER:         'over',
  ONLINE_LOBBY: 'online_lobby',
  ONLINE_GAME:  'online_game',
};

// ─── 升級池 ──────────────────────────────────────────────────────────────────
const UPGRADE_POOL = [
  { id: 'maxhp',     name: '裝甲強化', desc: '最大血量 +1，立即回血', color: '#22c55e' },
  { id: 'speed',     name: '引擎升級', desc: '移動速度永久 +0.7',     color: '#facc15' },
  { id: 'firerate',  name: '快速射擊', desc: '射擊冷卻縮短 5 幀',     color: '#f97316' },
  { id: 'pierce',    name: '穿甲砲彈', desc: '每波多 4 發穿牆子彈',   color: '#a78bfa' },
  { id: 'basehp',    name: '基地修復', desc: '基地回復 1 HP',         color: '#fbbf24' },
  { id: 'multishot', name: '散彈射擊', desc: '射擊時同時發左右各一顆', color: '#60a5fa' },
];
let state = State.MENU;
let winner = '';

// ─── 種子亂數（線上模式用，確保雙方地圖相同）────────────────────────────────
function makeRNG(seed) {
  let s = (seed * 0x100000000) >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

// ─── 輸入管理 ────────────────────────────────────────────────────────────────
const Input = {
  keys: {},
  pressed: {},
  init() {
    window.addEventListener('keydown', e => {
      if (!this.keys[e.code]) this.pressed[e.code] = true;
      this.keys[e.code] = true;
      e.preventDefault();
    });
    window.addEventListener('keyup', e => { this.keys[e.code] = false; });
  },
  held(code)    { return !!this.keys[code]; },
  justPressed(code) { return !!this.pressed[code]; },
  flush()       { this.pressed = {}; },
};

// ─── 地圖生成 ────────────────────────────────────────────────────────────────
const Map = {
  tiles: [],

  generate(pveMode, rng) {
    if (!rng) rng = () => Math.random();
    const tiles = Array.from({ length: ROWS }, () => new Array(COLS).fill(TILE_EMPTY));

    // 邊界鐵牆
    for (let r = 0; r < ROWS; r++) {
      tiles[r][0] = tiles[r][COLS - 1] = TILE_STEEL;
    }
    for (let c = 0; c < COLS; c++) {
      tiles[0][c] = tiles[ROWS - 1][c] = TILE_STEEL;
    }

    // 程序生成左半邊（不含邊界，排除出生點附近）
    const halfCols = Math.floor(COLS / 2);
    const spawnClear = new Set();
    // P1 出生點左下，P2 右上，基地下中
    [[ROWS-2, 1],[ROWS-2, 2],[ROWS-3, 1],
     [1, COLS-2],[1, COLS-3],[2, COLS-2],
     [ROWS-2, halfCols], [ROWS-3, halfCols]].forEach(([r,c]) => spawnClear.add(`${r},${c}`));

    for (let r = 1; r < ROWS - 1; r++) {
      for (let c = 1; c < halfCols; c++) {
        if (spawnClear.has(`${r},${c}`)) continue;
        const rand = rng();
        if (rand < 0.18) tiles[r][c] = TILE_BRICK;
        else if (rand < 0.23) tiles[r][c] = TILE_STEEL;
      }
    }

    // 水平鏡像到右半邊
    for (let r = 1; r < ROWS - 1; r++) {
      for (let c = 1; c < halfCols; c++) {
        tiles[r][COLS - 1 - c] = tiles[r][c];
      }
    }

    // 中線留通道
    for (let r = 2; r < ROWS - 2; r++) {
      tiles[r][halfCols] = TILE_EMPTY;
    }

    // PvE 基地（底部中央，2×2）
    if (pveMode) {
      tiles[ROWS-2][halfCols]   = TILE_BASE;
      tiles[ROWS-2][halfCols-1] = TILE_BASE;
    }

    this.tiles = tiles;
  },

  get(r, c) {
    if (r < 0 || r >= ROWS || c < 0 || c >= COLS) return TILE_STEEL;
    return this.tiles[r][c];
  },

  // 矩形像素碰撞：回傳碰到的第一個非空格子類型
  rectCollide(px, py, pw, ph, excludeTile) {
    const c0 = Math.floor(px / TILE);
    const c1 = Math.floor((px + pw - 1) / TILE);
    const r0 = Math.floor(py / TILE);
    const r1 = Math.floor((py + ph - 1) / TILE);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const t = this.get(r, c);
        if (t !== TILE_EMPTY && t !== excludeTile) return { type: t, r, c };
      }
    }
    return null;
  },

  destroyBrick(r, c) {
    if (this.tiles[r] && this.tiles[r][c] === TILE_BRICK) {
      this.tiles[r][c] = TILE_EMPTY;
    }
  },
};

// ─── 粒子系統 ────────────────────────────────────────────────────────────────
const Particles = {
  list: [],

  spawn(x, y, color, count = 10) {
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 1 + Math.random() * 4;
      this.list.push({
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 1,
        decay: 0.04 + Math.random() * 0.04,
        r: 2 + Math.random() * 3,
        color,
      });
    }
  },

  update() {
    this.list = this.list.filter(p => {
      p.x += p.vx;
      p.y += p.vy;
      p.vx *= 0.92;
      p.vy *= 0.92;
      p.life -= p.decay;
      return p.life > 0;
    });
  },

  draw() {
    this.list.forEach(p => {
      ctx.save();
      ctx.globalAlpha = p.life;
      ctx.shadowBlur  = 8;
      ctx.shadowColor = p.color;
      ctx.fillStyle   = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y + HUD_H, p.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    });
  },
};

// ─── 子彈 ────────────────────────────────────────────────────────────────────
const Bullets = {
  list: [],

  spawn(x, y, dir, owner, pierce) {
    this.list.push({ x, y, dir, owner, pierce, trail: [] });
  },

  update() {
    const speed = 8;
    this.list = this.list.filter(b => {
      b.trail.push({ x: b.x, y: b.y });
      if (b.trail.length > 6) b.trail.shift();

      b.x += DX[b.dir] * speed;
      b.y += DY[b.dir] * speed;

      // 邊界外
      if (b.x < 0 || b.x >= W || b.y < 0 || b.y >= H) {
        Particles.spawn(b.x, b.y, b.owner === 'p1' ? '#60a5fa' : '#f87171', 6);
        return false;
      }

      // 地圖碰撞
      const bw = 6, bh = 6;
      const hit = Map.rectCollide(b.x - bw/2, b.y - bh/2, bw, bh, TILE_EMPTY);
      if (hit) {
        Particles.spawn(b.x, b.y, '#fbbf24', 8);
        if (hit.type === TILE_BRICK && !b.pierce) {
          Map.destroyBrick(hit.r, hit.c);
          return false;
        }
        if (hit.type === TILE_BRICK && b.pierce) {
          Map.destroyBrick(hit.r, hit.c);
          return true; // 穿牆子彈繼續
        }
        if (hit.type === TILE_BASE) {
          Game.baseHit();
          return false;
        }
        return false;
      }
      return true;
    });
  },

  draw() {
    this.list.forEach(b => {
      const color = b.owner === 'p1' ? '#93c5fd' : '#fca5a5';
      const glow  = b.owner === 'p1' ? '#3b82f6' : '#ef4444';

      // 拖尾
      b.trail.forEach((t, i) => {
        ctx.save();
        ctx.globalAlpha = (i / b.trail.length) * 0.5;
        ctx.fillStyle = color;
        ctx.shadowBlur  = 6;
        ctx.shadowColor = glow;
        ctx.beginPath();
        ctx.arc(t.x, t.y + HUD_H, 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      });

      // 子彈本體
      ctx.save();
      ctx.shadowBlur  = 12;
      ctx.shadowColor = glow;
      ctx.fillStyle   = '#fff';
      ctx.beginPath();
      ctx.arc(b.x, b.y + HUD_H, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    });
  },
};

// ─── 道具箱 ──────────────────────────────────────────────────────────────────
const PowerUps = {
  list: [],
  spawnTimer: 0,
  INTERVAL: 600, // frames

  TYPES: [
    { id: 'heal',   emoji: '❤️',  color: '#22c55e' },
    { id: 'speed',  emoji: '⚡',  color: '#facc15' },
    { id: 'shield', emoji: '🛡️', color: '#60a5fa' },
    { id: 'pierce', emoji: '💥',  color: '#f97316' },
  ],

  spawnRandom() {
    // 找一個空格（不在邊界、不是牆）
    let tries = 50;
    while (tries-- > 0) {
      const r = 2 + Math.floor(Math.random() * (ROWS - 4));
      const c = 2 + Math.floor(Math.random() * (COLS - 4));
      if (Map.get(r, c) === TILE_EMPTY) {
        const type = this.TYPES[Math.floor(Math.random() * this.TYPES.length)];
        this.list.push({ r, c, x: c * TILE + TILE/2, y: r * TILE + TILE/2, type, pulse: 0 });
        return;
      }
    }
  },

  update(tanks) {
    this.spawnTimer++;
    if (this.spawnTimer >= this.INTERVAL) {
      this.spawnTimer = 0;
      this.spawnRandom();
    }

    this.list = this.list.filter(p => {
      p.pulse += 0.1;
      // 碰撞偵測
      for (const tank of tanks) {
        if (!tank.alive) continue;
        if (Math.abs(tank.x - p.x) < TILE && Math.abs(tank.y - p.y) < TILE) {
          applyPowerUp(tank, p.type.id);
          Particles.spawn(p.x, p.y, p.type.color, 12);
          return false;
        }
      }
      return true;
    });
  },

  draw() {
    this.list.forEach(p => {
      const scale = 1 + Math.sin(p.pulse) * 0.1;
      ctx.save();
      ctx.translate(p.x, p.y + HUD_H);
      ctx.scale(scale, scale);
      ctx.shadowBlur  = 16;
      ctx.shadowColor = p.type.color;
      ctx.font = '18px serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(p.type.emoji, 0, 0);
      ctx.restore();
    });
  },

  reset() { this.list = []; this.spawnTimer = 0; },
};

function applyPowerUp(tank, id) {
  if (id === 'heal')   { tank.hp = Math.min(tank.maxHp, tank.hp + 2); }
  if (id === 'speed')  { tank.speedBoost = 480; }
  if (id === 'shield') { tank.shield = 240; }
  if (id === 'pierce') { tank.pierceAmmo = 5; }
}

// ─── 線上模組 ────────────────────────────────────────────────────────────────
const Online = {
  active:   false,
  socket:   null,
  role:     'p1',   // 'p1' | 'p2'
  roomCode: '',
  seed:     0,

  lobbyMode: 'select', // 'select' | 'create' | 'join'
  joinInput: '',
  statusMsg: '',
  errorMsg:  '',

  init() {
    if (typeof io === 'undefined') return;
    this.socket = io();

    this.socket.on('roomCreated', ({ code }) => {
      this.roomCode = code;
      this.role = 'p1';
      this.statusMsg = `房間代碼：${code}　等待對手加入...`;
      this.errorMsg  = '';
    });

    this.socket.on('gameStart', ({ seed }) => {
      this.seed   = seed;
      this.active = true;
      Game.startOnline(this.role, seed);
    });

    this.socket.on('joined', ({ role }) => {
      this.role     = role;
      this.errorMsg = '';
      this.statusMsg = '加入成功！等待開始...';
    });

    this.socket.on('roomError', (msg) => {
      this.errorMsg = msg;
    });

    this.socket.on('opponentState', (s) => {
      if (state !== State.ONLINE_GAME) return;
      const oppTeam = this.role === 'p1' ? 'p2' : 'p1';
      const opp = Game.tanks.find(t => t.team === oppTeam);
      if (!opp) return;
      const wasAlive = opp.alive;
      opp.x = s.x; opp.y = s.y; opp.dir = s.dir;
      opp.hp = s.hp; opp.alive = s.alive;
      opp.shield = s.shield; opp.speedBoost = s.speedBoost;
      if (wasAlive && !s.alive) Particles.spawn(opp.x, opp.y, tankColor(opp).glow, 30);
    });

    this.socket.on('opponentBullet', (b) => {
      if (state === State.ONLINE_GAME) Bullets.spawn(b.x, b.y, b.dir, b.owner, b.pierce);
    });

    this.socket.on('opponentLeft', () => {
      winner = '對手離線，你獲勝！';
      state  = State.OVER;
    });
  },

  createRoom() {
    if (!this.socket) return;
    this.lobbyMode = 'create';
    this.statusMsg = '建立中...';
    this.roomCode  = '';
    this.errorMsg  = '';
    this.socket.emit('createRoom');
  },

  joinRoom(code) {
    if (!this.socket) return;
    this.socket.emit('joinRoom', code);
  },

  sendState(tank) {
    if (!this.socket) return;
    this.socket.emit('playerState', {
      x: tank.x, y: tank.y, dir: tank.dir,
      hp: tank.hp, alive: tank.alive,
      shield: tank.shield, speedBoost: tank.speedBoost,
    });
  },

  sendBullet(b) {
    if (!this.socket) return;
    this.socket.emit('bulletFired', b);
  },

  reset() {
    this.active    = false;
    this.roomCode  = '';
    this.seed      = 0;
    this.lobbyMode = 'select';
    this.joinInput = '';
    this.statusMsg = '';
    this.errorMsg  = '';
  },
};

// ─── 坦克 ────────────────────────────────────────────────────────────────────
function createTank(x, y, dir, team, isAI) {
  return {
    x, y, dir,
    team,   // 'p1' | 'p2' | 'ai'
    isAI,
    alive: true,
    hp: 5, maxHp: 5,
    speed: 3,
    fireCd: 0, fireCdBase: 30,
    shield: 0,
    speedBoost: 0,
    pierceAmmo: 0,
    multishot: false,
    // AI 狀態
    aiTimer: 0,
    aiDir: dir,
    aiFireTimer: 0,
    stuckTimer: 0,
    lastX: x, lastY: y,
  };
}

function tankColor(tank) {
  if (tank.team === 'p1') return { body: '#1d4ed8', glow: '#3b82f6', barrel: '#60a5fa' };
  if (tank.team === 'p2') return { body: '#991b1b', glow: '#ef4444', barrel: '#fca5a5' };
  return { body: '#78350f', glow: '#f97316', barrel: '#fdba74' };
}

function drawTank(tank) {
  if (!tank.alive) return;
  const c = tankColor(tank);
  const tw = 22, th = 22;
  const sx = tank.x - tw/2;
  const sy = tank.y + HUD_H - th/2;
  const cx = tank.x, cy = tank.y + HUD_H;
  const angle = tank.dir * Math.PI / 2;

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);

  // 護盾光環
  if (tank.shield > 0) {
    ctx.save();
    ctx.shadowBlur  = 20;
    ctx.shadowColor = '#60a5fa';
    ctx.strokeStyle = `rgba(96,165,250,${0.5 + 0.5 * Math.sin(Date.now() * 0.01)})`;
    ctx.lineWidth   = 3;
    ctx.beginPath();
    ctx.arc(0, 0, 18, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  // 車身
  ctx.shadowBlur  = 14;
  ctx.shadowColor = c.glow;
  ctx.fillStyle   = c.body;
  ctx.fillRect(-tw/2, -th/2, tw, th);

  // 砲管（朝上方 = dir UP = 角度 0）
  ctx.fillStyle   = c.barrel;
  ctx.shadowColor = c.barrel;
  ctx.fillRect(-3, -th/2 - 10, 6, 14);

  // 履帶線條
  ctx.strokeStyle = c.glow;
  ctx.lineWidth   = 1.5;
  ctx.beginPath(); ctx.moveTo(-tw/2, -th/4); ctx.lineTo(-tw/2 - 3, -th/4); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(-tw/2, th/4);  ctx.lineTo(-tw/2 - 3,  th/4);  ctx.stroke();
  ctx.beginPath(); ctx.moveTo( tw/2, -th/4); ctx.lineTo( tw/2 + 3, -th/4); ctx.stroke();
  ctx.beginPath(); ctx.moveTo( tw/2,  th/4); ctx.lineTo( tw/2 + 3,  th/4); ctx.stroke();

  ctx.restore();
}

function moveTank(tank, dir) {
  if (!tank.alive) return;
  tank.dir = dir;
  const spd = tank.speed + (tank.speedBoost > 0 ? 2 : 0);
  const nx = tank.x + DX[dir] * spd;
  const ny = tank.y + DY[dir] * spd;
  const tw = 20;
  if (!Map.rectCollide(nx - tw/2, ny - tw/2, tw, tw, TILE_EMPTY)) {
    // 檢查和其他坦克碰撞
    tank.x = nx;
    tank.y = ny;
  }
}

function fireTank(tank, fromNetwork = false) {
  if (!tank.alive || tank.fireCd > 0) return;
  const bx = tank.x + DX[tank.dir] * 18;
  const by = tank.y + DY[tank.dir] * 18;
  const pierce = tank.pierceAmmo > 0;
  if (pierce) tank.pierceAmmo--;
  const owner = tank.team === 'ai' ? 'p2' : tank.team;
  Bullets.spawn(bx, by, tank.dir, owner, pierce);
  // 散彈：左右各一顆（方向偏移 90 度）
  if (tank.multishot) {
    const leftDir  = (tank.dir + 3) % 4;
    const rightDir = (tank.dir + 1) % 4;
    Bullets.spawn(bx, by, leftDir,  owner, false);
    Bullets.spawn(bx, by, rightDir, owner, false);
  }
  tank.fireCd = tank.fireCdBase;

  // 線上模式：廣播子彈給對方
  if (Online.active && !fromNetwork && state === State.ONLINE_GAME) {
    Online.sendBullet({ x: bx, y: by, dir: tank.dir, owner, pierce });
    if (tank.multishot) {
      Online.sendBullet({ x: bx, y: by, dir: (tank.dir+3)%4, owner, pierce: false });
      Online.sendBullet({ x: bx, y: by, dir: (tank.dir+1)%4, owner, pierce: false });
    }
  }
}

function tickTank(tank) {
  if (tank.fireCd > 0) tank.fireCd--;
  if (tank.shield > 0) tank.shield--;
  if (tank.speedBoost > 0) tank.speedBoost--;
}

function hitTank(tank) {
  if (!tank.alive) return;
  if (tank.shield > 0) return;
  tank.hp--;
  Particles.spawn(tank.x, tank.y, tankColor(tank).glow, 15);
  if (tank.hp <= 0) {
    tank.alive = false;
    Particles.spawn(tank.x, tank.y, tankColor(tank).glow, 30);
  }
}

// ─── AI 邏輯 ─────────────────────────────────────────────────────────────────
function bfsDir(fromR, fromC, toR, toC) {
  const queue = [[fromR, fromC, -1]];
  const visited = new Set([`${fromR},${fromC}`]);
  while (queue.length) {
    const [r, c, firstDir] = queue.shift();
    for (let d = 0; d < 4; d++) {
      const nr = r + DY[d];
      const nc = c + DX[d];
      const key = `${nr},${nc}`;
      if (visited.has(key)) continue;
      const t = Map.get(nr, nc);
      if (t === TILE_STEEL) continue;
      visited.add(key);
      const fd = firstDir === -1 ? d : firstDir;
      if (nr === toR && nc === toC) return fd;
      if (t === TILE_EMPTY || t === TILE_BASE) queue.push([nr, nc, fd]);
      else if (t === TILE_BRICK) queue.push([nr, nc, fd]); // 可穿磚牆（子彈破磚）
    }
  }
  return Math.floor(Math.random() * 4);
}

function updateAI(ai, target) {
  if (!ai.alive) return;
  ai.aiTimer++;
  ai.aiFireTimer++;
  ai.stuckTimer++;

  // 每 60 幀重新尋路
  if (ai.aiTimer >= 60) {
    ai.aiTimer = 0;
    const fr = Math.round(ai.y / TILE);
    const fc = Math.round(ai.x / TILE);
    const tr = Math.round(target.y / TILE);
    const tc = Math.round(target.x / TILE);
    ai.aiDir = bfsDir(fr, fc, tr, tc);
  }

  // 卡牆偵測
  if (ai.stuckTimer >= 30) {
    ai.stuckTimer = 0;
    if (Math.abs(ai.x - ai.lastX) < 2 && Math.abs(ai.y - ai.lastY) < 2) {
      ai.aiDir = Math.floor(Math.random() * 4);
    }
    ai.lastX = ai.x; ai.lastY = ai.y;
  }

  moveTank(ai, ai.aiDir);

  // 瞄準玩家方向射擊
  if (ai.aiFireTimer >= 50) {
    ai.aiFireTimer = 0;
    const dx = target.x - ai.x;
    const dy = target.y - ai.y;
    let fireDir = ai.dir;
    if (Math.abs(dx) > Math.abs(dy)) {
      fireDir = dx > 0 ? DIR.RIGHT : DIR.LEFT;
    } else {
      fireDir = dy > 0 ? DIR.DOWN : DIR.UP;
    }
    ai.dir = fireDir;
    fireTank(ai);
  }
}

// ─── 子彈坦克碰撞 ─────────────────────────────────────────────────────────────
function checkBulletTankCollisions(tanks) {
  Bullets.list = Bullets.list.filter(b => {
    for (const tank of tanks) {
      if (!tank.alive) continue;
      const owner = tank.team === 'ai' ? 'p2' : tank.team;
      if (owner === b.owner) continue; // 不打自己
      if (Math.abs(tank.x - b.x) < 14 && Math.abs(tank.y - b.y) < 14) {
        hitTank(tank);
        Particles.spawn(b.x, b.y, b.owner === 'p1' ? '#60a5fa' : '#f87171', 12);
        return false;
      }
    }
    return true;
  });
}

// ─── 遊戲主體 ────────────────────────────────────────────────────────────────
const Game = {
  tanks: [],
  wave: 0,
  waveTimer: 0,
  baseHp: 3,
  baseMaxHp: 3,
  score: 0,

  startPvP() {
    state = State.PVP;
    Map.generate(false);
    Bullets.list = [];
    Particles.list = [];
    PowerUps.reset();
    this.tanks = [
      createTank(TILE * 2,      TILE * (ROWS - 2), DIR.UP,   'p1', false),
      createTank(TILE * (COLS-3), TILE * 2,         DIR.DOWN, 'p2', false),
    ];
    this.score = 0;
  },

  startOnline(role, seed) {
    state = State.ONLINE_GAME;
    const rng = makeRNG(seed);
    Map.generate(false, rng);
    Bullets.list = [];
    Particles.list = [];
    PowerUps.reset();
    // P1 左下，P2 右上（與本地 PvP 相同）
    this.tanks = [
      createTank(TILE * 2,        TILE * (ROWS - 2), DIR.UP,   'p1', false),
      createTank(TILE * (COLS-3), TILE * 2,          DIR.DOWN, 'p2', false),
    ];
    this.score = 0;
  },

  startPvE() {
    state = State.PVE;
    Map.generate(true);
    Bullets.list = [];
    Particles.list = [];
    PowerUps.reset();
    this.tanks = [
      createTank(TILE * 2, TILE * (ROWS - 3), DIR.UP, 'p1', false),
    ];
    this.wave = 0;
    this.waveTimer = 0;
    this.baseHp = this.baseMaxHp;
    this.score = 0;
    this.spawnWave();
  },

  spawnWave() {
    this.wave++;
    const count = Math.min(this.wave, 3);
    const spd   = Math.min(2 + this.wave * 0.3, 5);
    const aiHp  = this.wave <= 2 ? 2 : this.wave <= 4 ? 3 : 4;
    const aiCd  = Math.max(50 - this.wave * 3, 28);
    const positions = [
      [2, 2], [2, COLS-3], [2, Math.floor(COLS/2)],
    ];
    for (let i = 0; i < count; i++) {
      const [r, c] = positions[i];
      const ai = createTank(c * TILE, r * TILE, DIR.DOWN, 'ai', true);
      ai.hp = aiHp; ai.maxHp = aiHp;
      ai.speed = spd;
      ai.aiFireTimer = i * 20; // 錯開射擊時機
      this.tanks.push(ai);
      // 重設 AI 固定射擊間隔
      ai._fireCdBase = aiCd;
    }
  },

  upgradeChoices: [],

  pickUpgrades() {
    const pool = [...UPGRADE_POOL];
    this.upgradeChoices = [];
    for (let i = 0; i < 3 && pool.length; i++) {
      const idx = Math.floor(Math.random() * pool.length);
      this.upgradeChoices.push(pool.splice(idx, 1)[0]);
    }
  },

  applyUpgrade(id) {
    const p1 = this.tanks.find(t => t.team === 'p1');
    if (!p1) return;
    if (id === 'maxhp')     { p1.maxHp++; p1.hp = p1.maxHp; }
    if (id === 'speed')     { p1.speed += 0.7; }
    if (id === 'firerate')  { p1.fireCdBase = Math.max(10, p1.fireCdBase - 5); }
    if (id === 'pierce')    { p1.pierceAmmo += 4; }
    if (id === 'basehp')    { this.baseHp = Math.min(this.baseMaxHp, this.baseHp + 1); }
    if (id === 'multishot') { p1.multishot = true; }
  },

  baseHit() {
    this.baseHp--;
    Particles.spawn(W/2, H - TILE * 1.5, '#fbbf24', 20);
    if (this.baseHp <= 0) {
      winner = '基地被摧毀！';
      state = State.OVER;
    }
  },

  aiTanks()     { return this.tanks.filter(t => t.isAI); },
  playerTanks() { return this.tanks.filter(t => !t.isAI); },

  update() {
    const p1 = this.tanks.find(t => t.team === 'p1');
    const p2 = this.tanks.find(t => t.team === 'p2');

    // P1 輸入
    if (p1 && p1.alive) {
      if (Input.held('KeyW')) moveTank(p1, DIR.UP);
      if (Input.held('KeyS')) moveTank(p1, DIR.DOWN);
      if (Input.held('KeyA')) moveTank(p1, DIR.LEFT);
      if (Input.held('KeyD')) moveTank(p1, DIR.RIGHT);
      const shootKey = state === State.PVE ? 'Space' : 'KeyF';
      if (Input.justPressed(shootKey)) fireTank(p1);
    }

    // P2 輸入（PvP 模式）
    if (state === State.PVP && p2 && p2.alive) {
      if (Input.held('ArrowUp'))    moveTank(p2, DIR.UP);
      if (Input.held('ArrowDown'))  moveTank(p2, DIR.DOWN);
      if (Input.held('ArrowLeft'))  moveTank(p2, DIR.LEFT);
      if (Input.held('ArrowRight')) moveTank(p2, DIR.RIGHT);
      if (Input.justPressed('Enter')) fireTank(p2);
    }

    // AI 更新
    if (state === State.PVE && p1) {
      // 用基地作為攻擊目標（往基地走）
      const baseTarget = { x: W/2, y: H - TILE * 1.5, alive: true };
      for (const ai of this.aiTanks()) {
        updateAI(ai, baseTarget);
        tickTank(ai);
      }
    }

    // 玩家 tick
    for (const t of this.playerTanks()) tickTank(t);

    Bullets.update();
    checkBulletTankCollisions(this.tanks);
    PowerUps.update(this.tanks);
    Particles.update();

    // ── 勝負判定 PvP ──
    if (state === State.PVP) {
      if (p1 && !p1.alive) { winner = '玩家 2 獲勝！'; state = State.OVER; }
      else if (p2 && !p2.alive) { winner = '玩家 1 獲勝！'; state = State.OVER; }
    }

    // ── 波次推進 PvE ──
    if (state === State.PVE) {
      if (p1 && !p1.alive) { winner = '玩家陣亡！'; state = State.OVER; }
      const aiAlive = this.aiTanks().filter(t => t.alive);
      if (aiAlive.length === 0) {
        this.waveTimer++;
        if (this.waveTimer > 90) {
          this.waveTimer = 0;
          this.score += this.wave * 100;
          this.pickUpgrades();
          state = State.UPGRADE;
        }
      }
    }

    Input.flush();
  },

  // ── 繪製地圖 ──
  drawMap() {
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const t = Map.tiles[r][c];
        const x = c * TILE, y = r * TILE + HUD_H;
        if (t === TILE_EMPTY) continue;
        ctx.save();
        if (t === TILE_BRICK) {
          ctx.fillStyle   = '#78350f';
          ctx.shadowBlur  = 4;
          ctx.shadowColor = '#92400e';
          ctx.fillRect(x+1, y+1, TILE-2, TILE-2);
          ctx.strokeStyle = '#92400e';
          ctx.lineWidth = 1;
          ctx.strokeRect(x+1, y+1, TILE-2, TILE-2);
          // 磚紋
          ctx.strokeStyle = '#92400e88';
          ctx.lineWidth = 0.5;
          ctx.beginPath(); ctx.moveTo(x+1, y+TILE/2); ctx.lineTo(x+TILE-1, y+TILE/2); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(x+TILE/2, y+1); ctx.lineTo(x+TILE/2, y+TILE-1); ctx.stroke();
        } else if (t === TILE_STEEL) {
          ctx.fillStyle   = '#374151';
          ctx.shadowBlur  = 2;
          ctx.shadowColor = '#6b7280';
          ctx.fillRect(x+1, y+1, TILE-2, TILE-2);
          ctx.strokeStyle = '#6b7280';
          ctx.lineWidth = 1;
          ctx.strokeRect(x+1, y+1, TILE-2, TILE-2);
        } else if (t === TILE_BASE) {
          const pulse = 0.6 + 0.4 * Math.sin(Date.now() * 0.005);
          ctx.fillStyle   = `rgba(251,191,36,${pulse * 0.3})`;
          ctx.shadowBlur  = 16;
          ctx.shadowColor = '#fbbf24';
          ctx.fillRect(x+1, y+1, TILE-2, TILE-2);
          ctx.strokeStyle = `rgba(251,191,36,${pulse})`;
          ctx.lineWidth = 2;
          ctx.strokeRect(x+2, y+2, TILE-4, TILE-4);
          ctx.fillStyle = '#fbbf24';
          ctx.font = '14px serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('🏠', x + TILE/2, y + TILE/2);
        }
        ctx.restore();
      }
    }
  },

  // ── HUD ──
  drawHUD() {
    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, W, HUD_H);
    ctx.strokeStyle = '#1f2937';
    ctx.lineWidth = 1;
    ctx.strokeRect(0, 0, W, HUD_H);

    const p1 = this.tanks.find(t => t.team === 'p1');
    const p2 = this.tanks.find(t => t.team === 'p2');

    // P1 血條
    if (p1) {
      ctx.fillStyle = '#3b82f6';
      ctx.font = 'bold 13px Courier New';
      ctx.textAlign = 'left';
      ctx.fillText('P1', 12, 16);
      for (let i = 0; i < p1.maxHp; i++) {
        ctx.save();
        ctx.shadowBlur  = i < p1.hp ? 6 : 0;
        ctx.shadowColor = '#22c55e';
        ctx.fillStyle   = i < p1.hp ? '#22c55e' : '#1f2937';
        ctx.fillRect(36 + i * 16, 6, 12, 12);
        ctx.restore();
      }
      // 道具狀態
      let px = 36 + p1.maxHp * 16 + 8;
      if (p1.shield > 0)     { ctx.font = '11px serif'; ctx.fillText('🛡️', px, 16); px += 18; }
      if (p1.speedBoost > 0) { ctx.fillText('⚡', px, 16); px += 18; }
      if (p1.pierceAmmo > 0) { ctx.fillText('💥', px, 16); }
    }

    // 中間資訊
    if (state === State.PVE) {
      ctx.fillStyle = '#fbbf24';
      ctx.font = 'bold 13px Courier New';
      ctx.textAlign = 'center';
      ctx.fillText(`Wave ${this.wave}  Score ${this.score}`, W/2, 16);
      // 基地血條
      ctx.fillStyle = '#9ca3af';
      ctx.font = '11px Courier New';
      ctx.fillText('BASE', W/2, 30);
      for (let i = 0; i < this.baseMaxHp; i++) {
        ctx.save();
        ctx.shadowBlur  = i < this.baseHp ? 8 : 0;
        ctx.shadowColor = '#fbbf24';
        ctx.fillStyle   = i < this.baseHp ? '#fbbf24' : '#1f2937';
        ctx.fillRect(W/2 - (this.baseMaxHp * 14)/2 + i * 14, 32, 12, 4);
        ctx.restore();
      }
    } else {
      ctx.fillStyle = '#f59e0b';
      ctx.font = 'bold 14px Courier New';
      ctx.textAlign = 'center';
      ctx.fillText('⚔  TANK  BATTLE  ⚔', W/2, 22);
    }

    // P2 血條
    if (p2) {
      ctx.fillStyle = '#ef4444';
      ctx.font = 'bold 13px Courier New';
      ctx.textAlign = 'right';
      ctx.fillText('P2', W - 12, 16);
      for (let i = 0; i < p2.maxHp; i++) {
        ctx.save();
        ctx.shadowBlur  = i < p2.hp ? 6 : 0;
        ctx.shadowColor = '#ef4444';
        ctx.fillStyle   = i < p2.hp ? '#ef4444' : '#1f2937';
        ctx.fillRect(W - 36 - (p2.maxHp - i) * 16 + 4, 6, 12, 12);
        ctx.restore();
      }
    }
  },
};

// ─── 主選單 ───────────────────────────────────────────────────────────────────
function drawMenu() {
  // 背景
  ctx.fillStyle = '#0a0a14';
  ctx.fillRect(0, 0, W, H + HUD_H);

  // 背景星點
  const t = Date.now() * 0.001;
  for (let i = 0; i < 40; i++) {
    const x = (Math.sin(i * 137.5) * 0.5 + 0.5) * W;
    const y = (Math.cos(i * 137.5) * 0.5 + 0.5) * (H + HUD_H);
    const a = 0.3 + 0.7 * Math.sin(t + i);
    ctx.fillStyle = `rgba(100,120,255,${a})`;
    ctx.beginPath();
    ctx.arc(x, y, 1.5, 0, Math.PI * 2);
    ctx.fill();
  }

  const cy = (H + HUD_H) / 2;

  // 標題
  ctx.save();
  ctx.shadowBlur  = 40;
  ctx.shadowColor = '#3b82f6';
  ctx.fillStyle   = '#fff';
  ctx.font        = 'bold 52px Courier New';
  ctx.textAlign   = 'center';
  ctx.fillText('TANK BATTLE', W/2, cy - 100);
  ctx.restore();

  ctx.save();
  ctx.fillStyle = '#60a5fa';
  ctx.font = '18px Courier New';
  ctx.textAlign = 'center';
  ctx.letterSpacing = '8px';
  ctx.fillText('坦  克  大  戰', W/2, cy - 60);
  ctx.restore();

  // 按鈕
  drawMenuBtn('[ 1 ]  PvP  雙人對戰', W/2, cy - 20, '#1d4ed8', '#3b82f6');
  drawMenuBtn('[ 2 ]  PvE  單人闖關', W/2, cy + 50, '#166534', '#22c55e');
  if (typeof io !== 'undefined') {
    drawMenuBtn('[ 3 ]  線上 PvP', W/2, cy + 120, '#581c87', '#a78bfa');
  }

  // 操作說明
  ctx.fillStyle = '#4b5563';
  ctx.font = '12px Courier New';
  ctx.textAlign = 'center';
  ctx.fillText('PvP — P1: WASD + F 射擊     P2: 方向鍵 + Enter 射擊', W/2, cy + 185);
  ctx.fillText('PvE — WASD 移動 + 空白鍵 射擊', W/2, cy + 203);
}

function drawMenuBtn(label, x, y, bg, glow) {
  const bw = 260, bh = 44;
  ctx.save();
  ctx.shadowBlur  = 20;
  ctx.shadowColor = glow;
  ctx.fillStyle   = bg;
  ctx.fillRect(x - bw/2, y - bh/2, bw, bh);
  ctx.strokeStyle = glow;
  ctx.lineWidth   = 2;
  ctx.strokeRect(x - bw/2, y - bh/2, bw, bh);
  ctx.fillStyle   = '#fff';
  ctx.shadowBlur  = 0;
  ctx.font        = 'bold 16px Courier New';
  ctx.textAlign   = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, x, y);
  ctx.restore();
}

// ─── 線上大廳畫面 ─────────────────────────────────────────────────────────────
function drawLobby() {
  ctx.fillStyle = '#0a0a14';
  ctx.fillRect(0, 0, W, H + HUD_H);

  // 背景星點（同主選單）
  const t = Date.now() * 0.001;
  for (let i = 0; i < 40; i++) {
    const x = (Math.sin(i * 137.5) * 0.5 + 0.5) * W;
    const y = (Math.cos(i * 137.5) * 0.5 + 0.5) * (H + HUD_H);
    const a = 0.3 + 0.7 * Math.sin(t + i);
    ctx.fillStyle = `rgba(100,120,255,${a})`;
    ctx.beginPath(); ctx.arc(x, y, 1.5, 0, Math.PI * 2); ctx.fill();
  }

  const cy = (H + HUD_H) / 2;

  ctx.save();
  ctx.shadowBlur = 30; ctx.shadowColor = '#a78bfa';
  ctx.fillStyle = '#e9d5ff';
  ctx.font = 'bold 34px Courier New';
  ctx.textAlign = 'center';
  ctx.fillText('線上 PvP', W/2, cy - 150);
  ctx.restore();

  if (Online.lobbyMode === 'select') {
    drawMenuBtn('[ C ]  建立房間', W/2, cy - 30, '#1d4ed8', '#3b82f6');
    drawMenuBtn('[ J ]  加入房間', W/2, cy + 50, '#166534', '#22c55e');
    ctx.fillStyle = '#4b5563';
    ctx.font = '12px Courier New';
    ctx.textAlign = 'center';
    ctx.fillText('ESC 返回選單', W/2, cy + 120);

  } else if (Online.lobbyMode === 'create') {
    ctx.fillStyle = '#9ca3af';
    ctx.font = '14px Courier New';
    ctx.textAlign = 'center';
    ctx.fillText(Online.statusMsg, W/2, cy - 50);

    if (Online.roomCode) {
      ctx.save();
      ctx.shadowBlur = 24; ctx.shadowColor = '#fbbf24';
      ctx.fillStyle = '#fbbf24';
      ctx.font = 'bold 52px Courier New';
      ctx.textAlign = 'center';
      ctx.fillText(Online.roomCode, W/2, cy + 20);
      ctx.restore();
      ctx.fillStyle = '#6b7280';
      ctx.font = '12px Courier New';
      ctx.fillText('將此代碼傳給朋友', W/2, cy + 70);
    }
    ctx.fillStyle = '#374151';
    ctx.font = '12px Courier New';
    ctx.fillText('ESC 返回', W/2, cy + 120);

  } else if (Online.lobbyMode === 'join') {
    ctx.fillStyle = '#9ca3af';
    ctx.font = '14px Courier New';
    ctx.textAlign = 'center';
    ctx.fillText('輸入朋友的房間代碼', W/2, cy - 70);

    // 輸入框
    const bw = 260, bh = 64;
    ctx.save();
    const pulse = Math.sin(Date.now() * 0.006);
    ctx.shadowBlur = 14 + pulse * 4; ctx.shadowColor = '#3b82f6';
    ctx.fillStyle = '#0f172a';
    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth = 2;
    ctx.fillRect(W/2 - bw/2, cy - 36, bw, bh);
    ctx.strokeRect(W/2 - bw/2, cy - 36, bw, bh);
    ctx.restore();

    const cursor = Math.floor(Date.now() / 500) % 2 === 0 ? '_' : '';
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 30px Courier New';
    ctx.textAlign = 'center';
    ctx.fillText(Online.joinInput + cursor, W/2, cy + 4);

    if (Online.errorMsg) {
      ctx.fillStyle = '#ef4444';
      ctx.font = '13px Courier New';
      ctx.fillText(Online.errorMsg, W/2, cy + 60);
    }
    if (Online.statusMsg) {
      ctx.fillStyle = '#22c55e';
      ctx.font = '13px Courier New';
      ctx.fillText(Online.statusMsg, W/2, cy + 60);
    }
    ctx.fillStyle = '#374151';
    ctx.font = '12px Courier New';
    ctx.fillText('Enter 確認   ESC 返回', W/2, cy + 110);
  }
}

// ─── 升級選擇畫面 ─────────────────────────────────────────────────────────────
function drawUpgradeScreen() {
  ctx.fillStyle = 'rgba(0,0,0,0.82)';
  ctx.fillRect(0, 0, W, H + HUD_H);

  const cy = (H + HUD_H) / 2;

  ctx.save();
  ctx.shadowBlur  = 30;
  ctx.shadowColor = '#a78bfa';
  ctx.fillStyle   = '#e9d5ff';
  ctx.font        = 'bold 32px Courier New';
  ctx.textAlign   = 'center';
  ctx.fillText('LEVEL UP!  選擇升級', W/2, cy - 140);
  ctx.restore();

  ctx.fillStyle = '#6b7280';
  ctx.font = '13px Courier New';
  ctx.textAlign = 'center';
  ctx.fillText('按 1 / 2 / 3 選擇', W/2, cy - 105);

  const choices = Game.upgradeChoices;
  const cardW = 200, cardH = 130, gap = 24;
  const totalW = choices.length * cardW + (choices.length - 1) * gap;
  const startX = W / 2 - totalW / 2;

  choices.forEach((u, i) => {
    const x = startX + i * (cardW + gap);
    const y = cy - 80;
    ctx.save();
    ctx.shadowBlur  = 20;
    ctx.shadowColor = u.color;
    ctx.strokeStyle = u.color;
    ctx.lineWidth   = 2;
    ctx.fillStyle   = '#111827';
    ctx.beginPath();
    ctx.roundRect(x, y, cardW, cardH, 8);
    ctx.fill();
    ctx.stroke();

    // 數字標籤
    ctx.fillStyle = u.color;
    ctx.shadowColor = u.color;
    ctx.shadowBlur = 10;
    ctx.font = 'bold 22px Courier New';
    ctx.textAlign = 'center';
    ctx.fillText(`[${i + 1}]`, x + cardW / 2, y + 30);

    // 名稱
    ctx.fillStyle = '#f9fafb';
    ctx.shadowBlur = 0;
    ctx.font = 'bold 15px Courier New';
    ctx.fillText(u.name, x + cardW / 2, y + 58);

    // 說明（換行）
    ctx.fillStyle = '#9ca3af';
    ctx.font = '12px Courier New';
    const words = u.desc.split('，');
    words.forEach((w, wi) => ctx.fillText(w, x + cardW / 2, y + 80 + wi * 18));

    ctx.restore();
  });
}

// ─── Game Over 畫面 ───────────────────────────────────────────────────────────
function drawGameOver() {
  ctx.fillStyle = 'rgba(0,0,0,0.75)';
  ctx.fillRect(0, 0, W, H + HUD_H);

  const cy = (H + HUD_H) / 2;

  ctx.save();
  ctx.shadowBlur  = 30;
  ctx.shadowColor = '#f59e0b';
  ctx.fillStyle   = '#fbbf24';
  ctx.font        = 'bold 42px Courier New';
  ctx.textAlign   = 'center';
  ctx.fillText('GAME OVER', W/2, cy - 60);
  ctx.restore();

  ctx.fillStyle = '#e5e7eb';
  ctx.font = 'bold 24px Courier New';
  ctx.textAlign = 'center';
  ctx.fillText(winner, W/2, cy);

  if (state === State.PVE) {
    ctx.fillStyle = '#60a5fa';
    ctx.font = '18px Courier New';
    ctx.fillText(`最終分數：${Game.score}`, W/2, cy + 40);
  }

  ctx.fillStyle = '#6b7280';
  ctx.font = '14px Courier New';
  ctx.fillText('按 Enter 返回選單', W/2, cy + 90);
}

// ─── 遊戲主循環 ───────────────────────────────────────────────────────────────
function gameLoop() {
  ctx.fillStyle = '#0d1117';
  ctx.fillRect(0, 0, W, H + HUD_H);

  if (state === State.MENU) {
    drawMenu();
    if (Input.justPressed('Digit1') || Input.justPressed('Numpad1')) Game.startPvP();
    if (Input.justPressed('Digit2') || Input.justPressed('Numpad2')) Game.startPvE();
    Input.flush();
  } else if (state === State.UPGRADE) {
    // 繪製上一幀遊戲畫面作為背景
    ctx.fillStyle = '#111827';
    ctx.fillRect(0, HUD_H, W, H);
    Game.drawMap();
    Particles.update();
    Particles.draw();
    Game.tanks.forEach(drawTank);
    Game.drawHUD();
    drawUpgradeScreen();
    const choices = Game.upgradeChoices;
    ['Digit1','Digit2','Digit3'].forEach((key, i) => {
      if (Input.justPressed(key) && choices[i]) {
        Game.applyUpgrade(choices[i].id);
        state = State.PVE;
        Game.spawnWave();
        PowerUps.spawnRandom();
      }
    });
    Input.flush();
  } else if (state === State.OVER) {
    // 繼續繪製最後的遊戲畫面
    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, HUD_H, W, H);
    Game.drawMap();
    Particles.draw();
    PowerUps.draw();
    Game.tanks.forEach(drawTank);
    Bullets.draw();
    Game.drawHUD();
    drawGameOver();
    if (Input.justPressed('Enter')) { state = State.MENU; }
    Input.flush();
  } else {
    Game.update();

    // 繪製
    ctx.fillStyle = '#111827';
    ctx.fillRect(0, HUD_H, W, H);

    // 背景格線（很淡）
    ctx.strokeStyle = '#1f2937';
    ctx.lineWidth   = 0.5;
    for (let r = 0; r <= ROWS; r++) {
      ctx.beginPath();
      ctx.moveTo(0, r * TILE + HUD_H);
      ctx.lineTo(W, r * TILE + HUD_H);
      ctx.stroke();
    }
    for (let c = 0; c <= COLS; c++) {
      ctx.beginPath();
      ctx.moveTo(c * TILE, HUD_H);
      ctx.lineTo(c * TILE, H + HUD_H);
      ctx.stroke();
    }

    Game.drawMap();
    Particles.draw();
    PowerUps.draw();
    Game.tanks.forEach(drawTank);
    Bullets.draw();
    Game.drawHUD();

    // ESC 返回選單
    if (Input.justPressed('Escape')) { state = State.MENU; Input.flush(); }
  }

  requestAnimationFrame(gameLoop);
}

// ─── 啟動 ─────────────────────────────────────────────────────────────────────
Input.init();
gameLoop();
