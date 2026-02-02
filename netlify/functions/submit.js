import crypto from "crypto";

// Must match frontend config exactly
const GRID = 24;
const BONUS_CHANCE = 0.25;
const BONUS_MIN = 10;
const BONUS_MAX = 20;
const FOOD_SCORE = 3;
const TICK_MS = 110; // MUST match client

// Deterministic PRNG (Mulberry32), identical to client
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hmac(secret, msg) {
  return crypto.createHmac("sha256", secret).update(msg).digest("hex");
}

function clampInt(n, lo, hi) {
  n = Number(n);
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

function vecFromDirCode(c) {
  if (c === "U") return { x: 0, y: -1 };
  if (c === "D") return { x: 0, y: 1 };
  if (c === "L") return { x: -1, y: 0 };
  if (c === "R") return { x: 1, y: 0 };
  return { x: 1, y: 0 };
}

function eq(a, b) { return a.x === b.x && a.y === b.y; }
function inBounds(p) { return p.x >= 0 && p.x < GRID && p.y >= 0 && p.y < GRID; }

async function redisGet(key) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("Missing Upstash env");

  const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const j = await r.json();
  return j.result ? JSON.parse(j.result) : null;
}

async function redisSet(key, value) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("Missing Upstash env");

  const r = await fetch(
    `${url}/set/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(value))}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!r.ok) throw new Error("Redis set failed");
}

// Replay the whole run server-side and compute score.
// IMPORTANT: wall/self are normal game-over, so stop replay and return score-so-far.
function replay({ seed, tickCount, inputs }) {
  const rng = mulberry32(seed >>> 0);

  const mid = Math.floor(GRID / 2);
  let snake = [
    { x: mid, y: mid },
    { x: mid - 1, y: mid },
    { x: mid - 2, y: mid },
    { x: mid - 3, y: mid },
  ];
  let dir = { x: 1, y: 0 };
  let food = null;
  let bonus = null; // {x,y, expiresTick, totalSec}
  let score = 0;

  function isOccupied(p) {
    return snake.some((s) => s.x === p.x && s.y === p.y);
  }

  function randomEmptyCell() {
    for (let i = 0; i < 200; i++) {
      const x = Math.floor(rng() * GRID);
      const y = Math.floor(rng() * GRID);
      const p = { x, y };
      if (
        !isOccupied(p) &&
        (!food || !eq(p, food)) &&
        (!bonus || (p.x !== bonus.x || p.y !== bonus.y))
      ) return p;
    }
    for (let y = 0; y < GRID; y++) {
      for (let x = 0; x < GRID; x++) {
        const p = { x, y };
        if (
          !isOccupied(p) &&
          (!food || !eq(p, food)) &&
          (!bonus || (p.x !== bonus.x || p.y !== bonus.y))
        ) return p;
      }
    }
    return null;
  }

  function maybeSpawnBonus(currentTick) {
    if (bonus) return;
    if (rng() >= BONUS_CHANCE) return;

    const sec = Math.floor(rng() * (BONUS_MAX - BONUS_MIN + 1)) + BONUS_MIN;
    const pos = randomEmptyCell();
    if (!pos) return;

    const expiresTick = currentTick + Math.ceil((sec * 1000) / TICK_MS);
    bonus = { x: pos.x, y: pos.y, expiresTick, totalSec: sec };
  }

  // start food
  food = randomEmptyCell();
  if (!food) return { ok: false, reason: "no space" };

  // preprocess inputs by tick (last change in a tick wins)
  const byTick = new Map();
  for (const it of inputs) {
    const t = clampInt(it?.t, 0, tickCount);
    const d = String(it?.d || "");
    if (!["U", "D", "L", "R"].includes(d)) continue;
    byTick.set(t, d);
  }

  for (let tick = 1; tick <= tickCount; tick++) {
    // apply direction at tick boundary
    const code = byTick.get(tick);
    if (code) {
      const nd = vecFromDirCode(code);
      // disallow reverse
      if (!(nd.x === -dir.x && nd.y === -dir.y)) dir = nd;
    }

    const head = snake[0];
    const next = { x: head.x + dir.x, y: head.y + dir.y };

    // NORMAL game over: stop
    if (!inBounds(next)) break;

    const willEatFood = food && eq(next, food);
    const willEatBonus = bonus && next.x === bonus.x && next.y === bonus.y;

    // self collision (MATCH CLIENT EXACTLY):
    // allow stepping into tail if NOT growing (client checks only !willEatFood)
    const hits = snake.some(
      (s, idx) =>
        s.x === next.x &&
        s.y === next.y &&
        !(idx === snake.length - 1 && !willEatFood)
    );

    // NORMAL game over: stop
    if (hits) break;

    snake.unshift(next);

    // expire bonus (tick-based, same as client)
    const bonusExpiresTick = bonus ? bonus.expiresTick : null;
    if (bonus && tick >= bonus.expiresTick) bonus = null;

    if (willEatFood) {
      score += FOOD_SCORE;
      food = randomEmptyCell();
      maybeSpawnBonus(tick);
      // grow: do not pop
    } else if (willEatBonus) {
      // In the client, if bonus expired exactly now, bonusRemainingSeconds() becomes 0.
      // Replicate that safely:
      let remSec = 0;
      if (bonusExpiresTick != null) {
        const ticksLeft = bonusExpiresTick - tick;
        remSec = Math.max(0, Math.ceil((ticksLeft * TICK_MS) / 1000));
      }
      score += remSec;

      snake.pop(); // no-grow
      bonus = null;
    } else {
      snake.pop();
    }

    if (!food) return { ok: false, reason: "no food space" };
  }

  return { ok: true, score };
}

export async function handler(event) {
  try {
    const body = JSON.parse(event.body || "{}");

    const name =
      String(body.name || "anon")
        .replace(/[^a-zA-Z0-9 _.-]/g, "")
        .trim()
        .slice(0, 16) || "anon";

    const sessionId = String(body.sessionId || "");
    const seed = Number(body.seed);
    const sig = String(body.sig || "");
    const tickCount = clampInt(body.tickCount, 1, 200000);
    const inputs = Array.isArray(body.inputs) ? body.inputs.slice(0, 20000) : [];

    const secret = process.env.SESSION_HMAC_SECRET;
    if (!secret) {
      return {
        statusCode: 500,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
        body: JSON.stringify({ ok: false, reason: "Missing SESSION_HMAC_SECRET" }),
      };
    }

    // verify session signature
    const expected = hmac(secret, `${sessionId}:${seed}:${name}`);
    if (!sessionId || !sig || sig !== expected) {
      return {
        statusCode: 200,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
        body: JSON.stringify({ ok: false, reason: "bad session" }),
      };
    }

    if (tickCount > 60000) {
      return {
        statusCode: 200,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
        body: JSON.stringify({ ok: false, reason: "run too long" }),
      };
    }

    const rep = replay({ seed: seed >>> 0, tickCount, inputs });
    if (!rep.ok) {
      return {
        statusCode: 200,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
        body: JSON.stringify({ ok: false, reason: `replay failed (${rep.reason})` }),
      };
    }

    const verifiedScore = rep.score;

    // update top5
    const top = (await redisGet("snake:top5")) || [];
    top.push({ name, score: verifiedScore, at: Date.now() });
    top.sort((a, b) => b.score - a.score);
    const top5 = top.slice(0, 5);
    await redisSet("snake:top5", top5);

    return {
      statusCode: 200,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
      body: JSON.stringify({ ok: true, verifiedScore, top5 }),
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
      body: JSON.stringify({ ok: false, reason: e?.message || "server error" }),
    };
  }
}
