// Antfarm Architect — pheromone-trail ant colony simulation
// Reshaped for legibility: visible pheromone trails, ant-mode colors,
// live behavior legend, and stronger / more satisfying food-drop interaction.

// ──────────────────────────────────────────────
//  Canvas setup
// ──────────────────────────────────────────────
const COLS = 120;
const ROWS = 90;
const CELL = 4; // px per cell

let canvas, ctx;
let grid = []; // cell states: 'rock'|'soil'|'tunnel'|'nest'|'food'|'air'
let pheromones = []; // Float32Array[2] — [to-nest (carried food), to-food (scouting)]
let ants = [];
let foodSources = [];
let stats = { tunnels: 0, food: 0 };
let tickCount = 0;
let animId;
let tapHintHidden = false;
let showPheromones = true; // toggle via legend button
let lastFoodDrop = -999; // tick of most recent food drop (for visual ripple)
let lastFoodPos = { x: 0, y: 0 };

// Archetype verdicts — deterministic based on colony metrics
const VERDICTS = [
  {
    name: 'The Paranoid Hoarders',
    test: (s) => s.foodRatio > 0.55,
    desc: (s) => `Your colony collected ${s.foodCollected} food caches while excavating only the tunnels absolutely necessary. They trust nothing, stockpile everything, and have definitely built a secret chamber you haven't found yet.`,
  },
  {
    name: 'The Tunnel Maximalists',
    test: (s) => s.tunnelRatio > 0.45,
    desc: (s) => `${s.tunnelCount} tunnels and counting. Your colony doesn't need a destination — the digging IS the destination. Structural integrity is someone else's problem.`,
  },
  {
    name: 'The Chaotic Scouts',
    test: (s) => s.scoutRatio > 0.5,
    desc: (s) => `${s.scoutCount} ants were spotted wandering off-pheromone at the moment of the snapshot. They claim they're "exploring alternative routes." No one believes them.`,
  },
  {
    name: 'The Reluctant Architects',
    test: (s) => s.tunnelRatio < 0.12 && s.foodRatio < 0.3,
    desc: (_s) => `Your colony spent most of its time standing very still, looking thoughtful. They have strong opinions about tunnel placement but have yet to commit to any of them.`,
  },
  {
    name: 'The Efficient Minimalists',
    test: (_s) => true, // fallback
    desc: (s) => `Clean tunnel network. Reliable food loops. ${s.foodCollected} food sources secured with surgical precision. Your colony is what the others aspire to be — and silently resent.`,
  },
];

// Ant mode display config
const MODE_COLORS = {
  scout:  '#d49016', // amber — exploring, digging
  toFood: '#50c8c8', // cyan — following pheromone trail to food
  toNest: '#ffc84a', // bright amber — carrying food home
};

const MODE_LABELS = {
  scout:  'DIGGING',
  toFood: 'SEEKING FOOD',
  toNest: 'RETURNING HOME',
};

// ──────────────────────────────────────────────
//  Grid helpers
// ──────────────────────────────────────────────
function idx(x, y) { return y * COLS + x; }
function inBounds(x, y) { return x >= 0 && x < COLS && y >= 0 && y < ROWS; }

function initGrid() {
  grid = new Array(COLS * ROWS).fill('soil');
  pheromones = new Float32Array(COLS * ROWS * 2);

  // Nest chamber at center-top
  const nestX = Math.floor(COLS / 2);
  const nestY = 6;
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -3; dx <= 3; dx++) {
      const nx = nestX + dx, ny = nestY + dy;
      if (inBounds(nx, ny)) grid[idx(nx, ny)] = 'nest';
    }
  }

  // Scatter random rocks
  const rng = seededRng(42);
  for (let i = 0; i < 320; i++) {
    const rx = Math.floor(rng() * COLS);
    const ry = Math.floor(rng() * ROWS * 0.85) + Math.floor(ROWS * 0.12);
    const rw = 1 + Math.floor(rng() * 3);
    const rh = 1 + Math.floor(rng() * 2);
    for (let dy = 0; dy < rh; dy++) {
      for (let dx = 0; dx < rw; dx++) {
        const gx = rx + dx, gy = ry + dy;
        if (inBounds(gx, gy) && grid[idx(gx, gy)] === 'soil') {
          grid[idx(gx, gy)] = 'rock';
        }
      }
    }
  }

  foodSources = [];
  stats = { tunnels: 0, food: 0 };
}

function initAnts() {
  ants = [];
  const nestX = Math.floor(COLS / 2);
  const nestY = 6;
  for (let i = 0; i < 60; i++) {
    ants.push(createAnt(nestX, nestY));
  }
}

function createAnt(x, y) {
  return {
    x, y,
    dx: Math.random() < 0.5 ? 1 : -1,
    dy: 1,
    mode: 'scout',   // 'scout' | 'toFood' | 'toNest'
    carryFood: false,
    age: 0,
    scoutTimer: 0,
  };
}

// ──────────────────────────────────────────────
//  Seeded RNG (mulberry32)
// ──────────────────────────────────────────────
function seededRng(seed) {
  let s = seed;
  return function () {
    s |= 0; s = s + 0x6D2B79F5 | 0;
    let z = Math.imul(s ^ s >>> 15, 1 | s);
    z ^= z + Math.imul(z ^ z >>> 7, 61 | z);
    return ((z ^ z >>> 14) >>> 0) / 4294967296;
  };
}

// Colony snapshot metric hash (for determinism)
function colonyHash() {
  let h = 0;
  for (let i = 0; i < grid.length; i++) {
    const c = grid[i] === 'tunnel' ? 1 : grid[i] === 'food' ? 2 : 0;
    h = (Math.imul(31, h) + c) | 0;
  }
  h = (h + ants.length * 137 + foodSources.length * 97 + tickCount) | 0;
  return Math.abs(h);
}

// ──────────────────────────────────────────────
//  Ant logic
// ──────────────────────────────────────────────
const DIRS = [
  [-1, -1], [0, -1], [1, -1],
  [-1,  0],           [1,  0],
  [-1,  1], [0,  1], [1,  1],
];

function stepAnt(ant, rng) {
  ant.age++;
  ant.scoutTimer++;

  const cell = inBounds(ant.x, ant.y) ? grid[idx(ant.x, ant.y)] : 'soil';

  // Pick up food if standing on it
  if (!ant.carryFood && (cell === 'food') && ant.mode !== 'toNest') {
    ant.carryFood = true;
    ant.mode = 'toNest';
  }

  // Deposit food at nest
  if (ant.carryFood && cell === 'nest') {
    ant.carryFood = false;
    ant.mode = 'scout';
    ant.scoutTimer = 0;
    stats.food++;
  }

  // Dig if on soil and scouting
  if (cell === 'soil' && ant.mode !== 'toNest') {
    grid[idx(ant.x, ant.y)] = 'tunnel';
    stats.tunnels++;
    if (ant.carryFood) {
      pheromones[idx(ant.x, ant.y) * 2] = Math.min(255, pheromones[idx(ant.x, ant.y) * 2] + 40);
    }
  }

  // Deposit pheromones — stronger values so trails are visible
  if (inBounds(ant.x, ant.y)) {
    const pi = idx(ant.x, ant.y) * 2;
    if (ant.mode === 'toNest') {
      pheromones[pi] = Math.min(255, pheromones[pi] + 35);     // to-nest (amber)
    } else {
      pheromones[pi + 1] = Math.min(255, pheromones[pi + 1] + 22); // to-food (cyan)
    }
  }

  // Choose next cell
  const candidates = [];
  for (const [ddx, ddy] of DIRS) {
    const nx = ant.x + ddx;
    const ny = ant.y + ddy;
    if (!inBounds(nx, ny)) continue;
    const ncell = grid[idx(nx, ny)];
    if (ncell === 'rock') continue;

    let weight = 1;
    const np = idx(nx, ny) * 2;

    if (ant.mode === 'toNest') {
      weight += pheromones[np] * 0.1;
      if (ncell === 'nest') weight += 500;
      if (ncell === 'tunnel') weight += 3;
      if (ny < ant.y) weight += 4;
    } else if (ant.mode === 'toFood') {
      weight += pheromones[np + 1] * 0.08;
      if (ncell === 'food') weight += 500;
      if (ncell === 'tunnel') weight += 2;
    } else {
      // Scout: prefer pheromones lightly, downward gravity to explore
      weight += pheromones[np + 1] * 0.02;
      if (ncell === 'tunnel') weight += 1.5;
      if (ny > ant.y) weight += 2;
      if (ncell === 'food') weight += 80;
    }

    // Momentum
    if (ddx === ant.dx && ddy === ant.dy) weight *= 2.5;

    candidates.push({ nx, ny, ddx, ddy, weight });
  }

  if (candidates.length === 0) {
    ant.dx = -ant.dx; ant.dy = -ant.dy;
    return;
  }

  // Weighted random pick
  const total = candidates.reduce((s, c) => s + c.weight, 0);
  let pick = rng() * total;
  for (const c of candidates) {
    pick -= c.weight;
    if (pick <= 0) {
      ant.x = c.nx; ant.y = c.ny;
      ant.dx = c.ddx; ant.dy = c.ddy;
      break;
    }
  }

  // Mode transitions
  if (ant.mode === 'scout' && ant.scoutTimer > 40 && rng() < 0.02) {
    ant.mode = 'toFood';
  }
  if (ant.mode === 'toFood' && ant.scoutTimer > 120 && rng() < 0.015) {
    ant.mode = 'scout';
    ant.scoutTimer = 0;
  }
}

// ──────────────────────────────────────────────
//  Pheromone decay
// ──────────────────────────────────────────────
function decayPheromones() {
  for (let i = 0; i < pheromones.length; i++) {
    if (pheromones[i] > 0) pheromones[i] = Math.max(0, pheromones[i] - 0.22);
  }
}

// ──────────────────────────────────────────────
//  Render
// ──────────────────────────────────────────────
const COLORS = {
  soil:   '#1a1208',
  rock:   '#2a1f10',
  tunnel: '#0d0900',
  nest:   '#3d2800',
  food:   '#e8a020',
  air:    '#000',
};

function render() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Draw grid
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const cell = grid[idx(x, y)];
      ctx.fillStyle = COLORS[cell] || '#000';
      ctx.fillRect(x * CELL, y * CELL, CELL, CELL);

      // Draw pheromone overlay — much stronger alpha so trails are clearly visible
      if (showPheromones && (cell === 'tunnel' || cell === 'nest' || cell === 'soil')) {
        const pi = idx(x, y) * 2;
        const toNest = pheromones[pi];      // amber trail — ants carrying food home
        const toFood = pheromones[pi + 1];  // cyan trail — ants seeking food

        if (toNest > 3) {
          // Amber = "food was here, follow me home"
          ctx.fillStyle = `rgba(255,180,40,${Math.min(toNest / 180, 0.75)})`;
          ctx.fillRect(x * CELL, y * CELL, CELL, CELL);
        }
        if (toFood > 3) {
          // Cyan = "nest is here, come this way"
          ctx.fillStyle = `rgba(80,200,200,${Math.min(toFood / 200, 0.5)})`;
          ctx.fillRect(x * CELL, y * CELL, CELL, CELL);
        }
      }
    }
  }

  // Food drop ripple effect
  const rippleAge = tickCount - lastFoodDrop;
  if (rippleAge < 30) {
    const alpha = 1 - rippleAge / 30;
    const r = (rippleAge / 30) * CELL * 14;
    const px = lastFoodPos.x * CELL + CELL / 2;
    const py = lastFoodPos.y * CELL + CELL / 2;
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(255,200,60,${alpha * 0.6})`;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // Draw food sources (pulsing)
  const pulse = 0.5 + 0.5 * Math.sin(tickCount * 0.08);
  for (const f of foodSources) {
    const px = f.x * CELL + CELL / 2;
    const py = f.y * CELL + CELL / 2;
    const r = CELL * (1.8 + pulse * 0.8);
    const grad = ctx.createRadialGradient(px, py, 0, px, py, r);
    grad.addColorStop(0, 'rgba(255,210,80,0.95)');
    grad.addColorStop(1, 'rgba(232,160,32,0)');
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();
  }

  // Draw ants — color-coded by mode so you can read the colony state at a glance
  for (const ant of ants) {
    const px = ant.x * CELL + CELL / 2;
    const py = ant.y * CELL + CELL / 2;
    ctx.fillStyle = MODE_COLORS[ant.mode] || '#d49016';
    ctx.beginPath();
    ctx.arc(px, py, ant.mode === 'toNest' ? 2.2 : 1.6, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ──────────────────────────────────────────────
//  Simulation tick
// ──────────────────────────────────────────────
const antRng = seededRng(Date.now() & 0xffff);

function tick() {
  tickCount++;

  // Step ants
  for (const ant of ants) {
    stepAnt(ant, antRng);
  }

  // Decay pheromones every 3 frames
  if (tickCount % 3 === 0) decayPheromones();

  // Mark food source cells
  for (const f of foodSources) {
    if (inBounds(f.x, f.y) && grid[idx(f.x, f.y)] !== 'nest') {
      grid[idx(f.x, f.y)] = 'food';
    }
  }

  // Update stats display and live legend
  updateStats();
  updateLegend();
  render();
  animId = requestAnimationFrame(tick);
}

function updateStats() {
  const tunnelCount = grid.filter(c => c === 'tunnel').length;
  document.getElementById('stat-ants').textContent = `ANTS: ${ants.length}`;
  document.getElementById('stat-tunnels').textContent = `TUNNELS: ${tunnelCount}`;
  document.getElementById('stat-food').textContent = `FOOD SECURED: ${stats.food}`;
}

function updateLegend() {
  // Count ants by mode and display live in the legend
  const counts = { scout: 0, toFood: 0, toNest: 0 };
  for (const ant of ants) counts[ant.mode]++;
  const legendScout  = document.getElementById('legend-scout-count');
  const legendFood   = document.getElementById('legend-food-count');
  const legendNest   = document.getElementById('legend-nest-count');
  if (legendScout)  legendScout.textContent  = counts.scout;
  if (legendFood)   legendFood.textContent   = counts.toFood;
  if (legendNest)   legendNest.textContent   = counts.toNest;
}

// ──────────────────────────────────────────────
//  User interaction — drop food
// ──────────────────────────────────────────────
function canvasClick(e) {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  const clientY = e.touches ? e.touches[0].clientY : e.clientY;
  const scaleX = COLS / rect.width;
  const scaleY = ROWS / rect.height;
  const gx = Math.floor((clientX - rect.left) * scaleX);
  const gy = Math.floor((clientY - rect.top) * scaleY);

  if (!inBounds(gx, gy)) return;

  // Drop 3×3 food blob
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const fx = gx + dx, fy = gy + dy;
      if (inBounds(fx, fy) && grid[idx(fx, fy)] !== 'rock') {
        grid[idx(fx, fy)] = 'food';
        foodSources.push({ x: fx, y: fy });
      }
    }
  }

  // Blast a burst of to-food pheromone outward from the drop point so ants
  // pick up the signal quickly — this makes food placement feel impactful
  const blastRadius = 12;
  for (let dy = -blastRadius; dy <= blastRadius; dy++) {
    for (let dx = -blastRadius; dx <= blastRadius; dx++) {
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > blastRadius) continue;
      const fx = gx + dx, fy = gy + dy;
      if (!inBounds(fx, fy)) continue;
      const strength = 120 * (1 - dist / blastRadius);
      pheromones[idx(fx, fy) * 2 + 1] = Math.min(255, pheromones[idx(fx, fy) * 2 + 1] + strength);
    }
  }

  // Switch ALL ants to food-seeking mode immediately — user action should be decisive
  for (const ant of ants) {
    ant.mode = 'toFood';
    ant.scoutTimer = 0;
  }

  // Ripple effect
  lastFoodDrop = tickCount;
  lastFoodPos = { x: gx, y: gy };

  // Show a brief status message
  showAction('FOOD DROPPED — COLONY REDIRECTED');

  // Hide tap hint
  if (!tapHintHidden) {
    tapHintHidden = true;
    document.getElementById('tap-hint').classList.add('hidden');
  }
}

// ──────────────────────────────────────────────
//  Action flash message
// ──────────────────────────────────────────────
let actionTimer = null;
function showAction(msg) {
  const el = document.getElementById('action-msg');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('visible');
  clearTimeout(actionTimer);
  actionTimer = setTimeout(() => el.classList.remove('visible'), 2000);
}

// ──────────────────────────────────────────────
//  Toggle pheromone overlay
// ──────────────────────────────────────────────
function togglePheromones() {
  showPheromones = !showPheromones;
  const btn = document.getElementById('btn-pheromones');
  if (btn) {
    btn.textContent = showPheromones ? 'PHEROMONES: ON' : 'PHEROMONES: OFF';
    btn.classList.toggle('dim', !showPheromones);
  }
}

// ──────────────────────────────────────────────
//  Snapshot / reveal
// ──────────────────────────────────────────────
function takeSnapshot() {
  const panel = document.getElementById('reveal-panel');
  panel.style.display = 'flex';
  document.getElementById('reveal-computing').style.display = 'block';
  document.getElementById('reveal-result').style.display = 'none';

  setTimeout(() => {
    const tunnelCount = grid.filter(c => c === 'tunnel').length;
    const totalCells = COLS * ROWS;
    const tunnelRatio = tunnelCount / totalCells;
    const foodCollected = stats.food;
    const maxFood = Math.max(1, foodSources.length * 2);
    const foodRatio = Math.min(1, foodCollected / maxFood);
    const scoutCount = ants.filter(a => a.mode === 'scout').length;
    const scoutRatio = scoutCount / ants.length;

    const snapStats = { tunnelCount, tunnelRatio, foodCollected, foodRatio, scoutCount, scoutRatio };

    // Deterministic verdict from colony hash
    const h = colonyHash();
    const shuffled = VERDICTS.slice().sort((a, b) => {
      const ha = Math.imul(h, a.name.length) | 0;
      const hb = Math.imul(h, b.name.length) | 0;
      return ha - hb;
    });

    let verdict = VERDICTS[VERDICTS.length - 1];
    for (const v of shuffled) {
      if (v.test(snapStats)) { verdict = v; break; }
    }

    document.getElementById('reveal-computing').style.display = 'none';
    document.getElementById('verdict-name').textContent = verdict.name;
    document.getElementById('verdict-desc').textContent = verdict.desc(snapStats);
    document.getElementById('reveal-result').style.display = 'block';
    document.getElementById('share').style.display = 'block';
  }, 1400);
}

function closeReveal() {
  document.getElementById('reveal-panel').style.display = 'none';
}

// ──────────────────────────────────────────────
//  Reset
// ──────────────────────────────────────────────
function resetColony() {
  cancelAnimationFrame(animId);
  initGrid();
  initAnts();
  tapHintHidden = false;
  lastFoodDrop = -999;
  document.getElementById('tap-hint').classList.remove('hidden');
  closeReveal();
  animId = requestAnimationFrame(tick);
}

// ──────────────────────────────────────────────
//  Share
// ──────────────────────────────────────────────
function share() {
  const verdictName = document.getElementById('verdict-name').textContent;
  const shareText = `My ant colony is: "${verdictName}" — watch yours excavate an underground world`;
  if (navigator.share) {
    navigator.share({ title: 'Antfarm Architect', text: shareText, url: location.href });
  } else {
    navigator.clipboard.writeText(`${shareText}\n${location.href}`)
      .then(() => alert('Link copied!'));
  }
}

// ──────────────────────────────────────────────
//  Init
// ──────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  canvas = document.getElementById('antfarm');
  canvas.width = COLS * CELL;
  canvas.height = ROWS * CELL;
  ctx = canvas.getContext('2d');

  canvas.addEventListener('click', canvasClick);
  canvas.addEventListener('touchstart', canvasClick, { passive: false });

  initGrid();
  initAnts();
  animId = requestAnimationFrame(tick);
});
