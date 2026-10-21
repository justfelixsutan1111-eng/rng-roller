"use strict";

const $ = id => document.getElementById(id);

// Keep the existing key so Update 0.15 progress can be migrated.
const SAVE_KEY = "rng-game-convenience-015";
const LOCK_KEY = SAVE_KEY + "-active-tab";

const AUTO_COST = 250;
const FOCUS_DELAY = 12000;
const BASE_AUTO_DELAY = 1800;
const AUTO_SPEED_STEP = 120;
const MAX_SPEED = 10;
const MAX_FOCUS = 5;
const SAFE_MAX = Number.MAX_SAFE_INTEGER;

const rarities = [
  { name: "Common", weight: 800000, coins: 3, color: "#c4cede" },
  { name: "Uncommon", weight: 170000, coins: 6, color: "#78e8be" },
  { name: "Rare", weight: 27000, coins: 15, color: "#7bbdff" },
  { name: "Epic", weight: 2800, coins: 50, color: "#be9cff" },
  { name: "Legendary", weight: 190, coins: 200, color: "#ffd48a" },
  { name: "Mythic", weight: 10, coins: 1500, color: "#ff98c8" }
];

const upgradeDefinitions = [
  { key: "luck", name: "Luck" },
  { key: "speed", name: "Auto Speed" },
  { key: "focus", name: "Focus Width" }
];

const settingsKeys = [
  "confirmReset",
  "reducedMotion",
  "pauseOutsideGame"
];

let storageMessage = "";
let sessionMessage = "";
let state = freshSave();
let currentPage = "game";
let autoOn = false;
let challenge = null;
let nextAuto = 0;
let focusDeadline = 0;
let lastFrame = 0;
let lastButtonPaint = 0;
let saveTimer = null;
let dirty = false;
let canPlay = false;
let pageLive = true;
let useLocks = !!navigator.locks;
let lockTask = null;
let unlock = null;

const collectionViews = [];
const upgradeViews = new Map();
const statsViews = new Map();

/* ---------- Costs and save validation ---------- */

function freshSave() {
  return {
    version: 3,
    coins: 0,
    earned: 0,
    manual: 0,
    automatic: 0,
    attempts: 0,
    focusHits: 0,
    perfects: 0,
    charges: 0,
    multiplier: 1,
    focusReady: 0,
    autoOwned: false,
    settings: {
      confirmReset: true,
      reducedMotion: false,
      pauseOutsideGame: false
    },
    levels: {
      luck: 0,
      speed: 0,
      focus: 0
    },
    collection: [0, 0, 0, 0, 0, 0]
  };
}

function integer(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function upgradePrice(key, levels = state.levels) {
  switch (key) {
    case "luck":
      return 120 + levels.luck * 60;
    case "speed":
      return Math.ceil(150 * 1.7 ** levels.speed);
    case "focus":
      return 150 * 2 ** levels.focus;
    default:
      return Infinity;
  }
}

function spentTotal(saved) {
  const level = saved.levels.luck;

  // Sum of 120, 180, 240, ... for all purchased Luck levels.
  let spent = 30 * level * (level + 3);
  if (!integer(spent)) return NaN;

  spent += saved.autoOwned ? AUTO_COST : 0;

  for (let i = 0; i < saved.levels.speed; i++) {
    spent += Math.ceil(150 * 1.7 ** i);
  }

  for (let i = 0; i < saved.levels.focus; i++) {
    spent += 150 * 2 ** i;
  }

  return integer(spent) ? spent : NaN;
}

function validCommon(saved) {
  if (!saved || typeof saved !== "object") return false;

  const fields = [
    "coins", "earned", "manual", "automatic", "attempts",
    "focusHits", "perfects", "charges", "focusReady"
  ];

  if (!fields.every(key => integer(saved[key]))) return false;
  if (typeof saved.autoOwned !== "boolean") return false;

  if (!saved.settings || !settingsKeys.every(key =>
    typeof saved.settings[key] === "boolean"
  )) return false;

  if (!Array.isArray(saved.collection) ||
      saved.collection.length !== rarities.length ||
      !saved.collection.every(integer)) return false;

  const rolls = saved.manual + saved.automatic;
  const collected = saved.collection.reduce((sum, n) => sum + n, 0);

  if (!integer(rolls) || !integer(collected) || rolls !== collected) {
    return false;
  }

  if (saved.charges > 5) return false;
  if (saved.charges === 0 && saved.multiplier !== 1) return false;
  if (saved.charges > 0 && ![2, 3.5].includes(saved.multiplier)) {
    return false;
  }

  if (saved.perfects > saved.focusHits ||
      saved.focusHits > saved.attempts) return false;

  if (saved.charges > 0 && saved.focusHits === 0) return false;
  if (saved.multiplier === 3.5 && saved.perfects === 0) return false;
  if (saved.automatic > 0 && !saved.autoOwned) return false;

  return true;
}

function validSave(saved) {
  if (!validCommon(saved) || saved.version !== 3) return false;

  const levels = saved.levels;
  if (!levels || !integer(levels.luck) ||
      !integer(levels.speed) || !integer(levels.focus)) return false;

  if (levels.speed > MAX_SPEED || levels.focus > MAX_FOCUS) {
    return false;
  }

  const spent = spentTotal(saved);

  return integer(spent) &&
    saved.earned - spent === saved.coins;
}

function migrateLegacy(saved) {
  if (!validCommon(saved) || saved.version !== 2) return null;

  const levels = saved.levels;

  if (!levels || !integer(levels.luck) ||
      !integer(levels.income) || !integer(levels.focus) ||
      levels.luck > 8 || levels.income > 8 ||
      levels.focus > MAX_FOCUS) return null;

  let oldSpent = saved.autoOwned ? AUTO_COST : 0;

  const oldUpgrades = [
    { key: "luck", base: 120, growth: 1.9 },
    { key: "income", base: 100, growth: 1.85 },
    { key: "focus", base: 150, growth: 2 }
  ];

  for (const upgrade of oldUpgrades) {
    for (let i = 0; i < levels[upgrade.key]; i++) {
      oldSpent += Math.ceil(upgrade.base * upgrade.growth ** i);
    }
  }

  if (saved.earned - oldSpent !== saved.coins) return null;

  const migrated = {
    ...saved,
    version: 3,
    settings: { ...saved.settings },
    levels: {
      luck: levels.luck,
      speed: 0,
      focus: levels.focus
    },
    collection: [...saved.collection]
  };

  // Refund removed Coin Bonus costs and the difference in Luck costs.
  migrated.coins = migrated.earned - spentTotal(migrated);

  return validSave(migrated) ? migrated : null;
}

function loadSave() {
  storageMessage = "";

  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return freshSave();

    const saved = JSON.parse(raw);
    if (validSave(saved)) return saved;

    const migrated = migrateLegacy(saved);
    if (migrated) {
      storageMessage = "Save updated for 0.2. Upgrade cost differences refunded.";
      return migrated;
    }

    storageMessage = "Invalid save data. A new game was loaded.";
  } catch {
    storageMessage = "Could not load saved progress.";
  }

  return freshSave();
}

function showNotice() {
  $("notice").textContent = sessionMessage || storageMessage;
}

function saveNow() {
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }

  if (!canPlay || !dirty) return;

  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(state));
    dirty = false;
  } catch {
    storageMessage = "Saving is unavailable. Progress may not survive closing this page.";
    showNotice();
  }
}

function changed(immediate = false) {
  dirty = true;

  if (immediate) {
    saveNow();
  } else if (saveTimer === null) {
    // Throttle writes without delaying them forever during rapid clicking.
    saveTimer = setTimeout(saveNow, 150);
  }
}

/* ---------- Odds ---------- */

function random() {
  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  return value[0] / 4294967296;
}

function baseLuck() {
  return 1 + state.levels.luck * 0.1;
}

function totalLuck() {
  return baseLuck() * (state.charges > 0 ? state.multiplier : 1);
}

function rarityWeights() {
  const luck = totalLuck();

  // Both roll modes now use the same luck and Focus rules.
  return rarities.map((rarity, index) =>
    rarity.weight * (index === 0 ? 1 : luck)
  );
}

function chooseRarity() {
  const weights = rarityWeights();
  let ticket = random() * weights.reduce((sum, weight) => sum + weight, 0);

  for (let i = 0; i < weights.length; i++) {
    ticket -= weights[i];
    if (ticket < 0) return i;
  }

  return rarities.length - 1;
}

function autoDelay() {
  return BASE_AUTO_DELAY - state.levels.speed * AUTO_SPEED_STEP;
}

function formatLuck(value) {
  return `${Number(value.toFixed(2)).toLocaleString(undefined, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 2
  })}×`;
}

function formatChance(probability) {
  const percent = probability * 100;
  return `${percent.toFixed(percent < 0.1 ? 4 : 2)}% chance`;
}

/* ---------- Build persistent controls ---------- */

function buildCollection() {
  for (const rarity of rarities) {
    const card = document.createElement("div");
    card.className = "item";
    card.style.setProperty("--rarity-color", rarity.color);

    const name = document.createElement("strong");
    name.textContent = rarity.name;

    const count = document.createElement("span");
    const odds = document.createElement("span");
    odds.className = "item-odds";

    card.append(name, count, odds);
    $("collection").append(card);
    collectionViews.push({ count, odds });
  }
}

function buildUpgrades() {
  for (const upgrade of upgradeDefinitions) {
    const row = document.createElement("div");
    row.className = "upgrade";

    const copy = document.createElement("div");
    const name = document.createElement("strong");
    name.className = "upgrade-name";
    name.textContent = upgrade.name;

    const detail = document.createElement("span");
    detail.className = "upgrade-detail";

    const buy = document.createElement("button");
    buy.type = "button";
    buy.setAttribute("aria-label", `Buy ${upgrade.name} upgrade`);
    buy.addEventListener("click", event => {
      if (event.isTrusted) purchase(upgrade.key);
    });

    copy.append(name, detail);
    row.append(copy, buy);
    $("upgrades").append(row);
    upgradeViews.set(upgrade.key, { detail, buy });
  }
}

function buildStats() {
  const rows = [
    ["total", "Total rolls"],
    ["manual", "Manual rolls"],
    ["automatic", "Auto rolls"],
    ["best", "Best rarity"],
    ["earned", "Lifetime coins"],
    ["attempts", "Focus attempts"],
    ["focusHits", "Focus hits"],
    ["perfects", "Perfect hits"],
    ["rate", "Focus success"],
    ["baseLuck", "Base luck"],
    ["totalLuck", "Current luck"],
    ["speed", "Auto interval"]
  ];

  for (const [key, label] of rows) {
    const row = document.createElement("div");
    const title = document.createElement("dt");
    const value = document.createElement("dd");

    title.textContent = label;
    row.append(title, value);
    $("stats").append(row);
    statsViews.set(key, value);
  }
}

/* ---------- Rendering ---------- */

function upgradeMaxed(key) {
  if (key === "speed") return state.levels.speed >= MAX_SPEED;
  if (key === "focus") return state.levels.focus >= MAX_FOCUS;
  return false;
}

function renderButtons() {
  const blocked = !canPlay || document.hidden;
  const remaining = Math.max(0, focusDeadline - performance.now());

  $("roll").disabled = blocked || autoOn || !!challenge;
  $("roll").textContent = challenge
    ? "Focusing…"
    : autoOn ? "Auto rolling…" : "Roll";

  $("auto").disabled = blocked || !!challenge ||
    (!state.autoOwned && state.coins < AUTO_COST);

  $("auto").textContent = state.autoOwned
    ? `Auto roll: ${autoOn ? "On" : "Off"}`
    : `Auto roll · ${AUTO_COST} coins`;

  $("auto").setAttribute("aria-pressed", String(autoOn));

  $("focus").disabled = blocked || (!challenge &&
    (state.charges > 0 || remaining > 0));

  $("focus").textContent = challenge
    ? "Stop needle"
    : state.charges > 0
      ? `${state.charges} boosted rolls left`
      : remaining > 0
        ? `Ready in ${Math.ceil(remaining / 1000)}s`
        : "Start focus";

  $("reset").disabled = blocked;

  for (const [key, view] of upgradeViews) {
    view.buy.disabled = blocked || !!challenge ||
      upgradeMaxed(key) ||
      (key === "speed" && !state.autoOwned) ||
      state.coins < upgradePrice(key);
  }

  for (const button of document.querySelectorAll("[data-setting]")) {
    button.disabled = blocked;
  }
}

function renderUpgrades() {
  for (const [key, view] of upgradeViews) {
    const level = state.levels[key];

    if (key === "luck") {
      view.detail.textContent =
        `Lv. ${level.toLocaleString()} · ${formatLuck(baseLuck())} · +0.1×`;
    } else if (key === "speed") {
      view.detail.textContent =
        `${level}/${MAX_SPEED} · ${(autoDelay() / 1000).toFixed(1)}s`;
    } else {
      view.detail.textContent = `${level}/${MAX_FOCUS}`;
    }

    view.buy.textContent = upgradeMaxed(key)
      ? "Maxed"
      : key === "speed" && !state.autoOwned
        ? "Unlock auto first"
        : `${upgradePrice(key).toLocaleString()} coins`;
  }
}

function renderCollection() {
  const weights = rarityWeights();
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let discovered = 0;

  collectionViews.forEach((view, index) => {
    const count = state.collection[index];
    if (count > 0) discovered++;

    view.count.textContent = `${count.toLocaleString()} found`;
    view.odds.textContent = formatChance(weights[index] / total);
  });

  $("collectionProgress").textContent = `${discovered} / ${rarities.length}`;
}

function renderStats() {
  let best = "None";

  for (let i = rarities.length - 1; i >= 0; i--) {
    if (state.collection[i] > 0) {
      best = rarities[i].name;
      break;
    }
  }

  const values = {
    total: (state.manual + state.automatic).toLocaleString(),
    manual: state.manual.toLocaleString(),
    automatic: state.automatic.toLocaleString(),
    best,
    earned: state.earned.toLocaleString(),
    attempts: state.attempts.toLocaleString(),
    focusHits: state.focusHits.toLocaleString(),
    perfects: state.perfects.toLocaleString(),
    rate: state.attempts
      ? `${(state.focusHits / state.attempts * 100).toFixed(1)}%`
      : "0%",
    baseLuck: formatLuck(baseLuck()),
    totalLuck: formatLuck(totalLuck()),
    speed: `${(autoDelay() / 1000).toFixed(1)}s`
  };

  for (const [key, value] of Object.entries(values)) {
    statsViews.get(key).textContent = value;
  }
}

function renderSettings() {
  for (const button of document.querySelectorAll("[data-setting]")) {
    const enabled = state.settings[button.dataset.setting];
    button.textContent = enabled ? "On" : "Off";
    button.setAttribute("aria-pressed", String(enabled));
  }

  document.body.classList.toggle(
    "reduced-motion",
    state.settings.reducedMotion
  );
}

function render() {
  $("coins").textContent = state.coins.toLocaleString();
  $("luck").textContent = formatLuck(totalLuck());

  $("boost").textContent = state.charges > 0
    ? `${state.multiplier}× · ${state.charges} left`
    : "Inactive";

  const autoPaused = autoOn && (
    document.hidden ||
    !!challenge ||
    (state.settings.pauseOutsideGame && currentPage !== "game")
  );

  $("rollMode").textContent = autoOn
    ? autoPaused ? "Auto paused" : "Auto"
    : "Manual";

  $("autoInfo").textContent =
    `Auto: ${(autoDelay() / 1000).toFixed(1)}s · 40% coins`;

  renderUpgrades();
  renderCollection();
  renderStats();
  renderSettings();
  renderButtons();
}

/* ---------- Navigation ---------- */

function showPage(name) {
  const destination = $("page-" + name);
  if (!destination) return;

  if (challenge && name !== "game") finishFocus(true);

  const returningFromPausedPage =
    currentPage !== "game" &&
    name === "game" &&
    state.settings.pauseOutsideGame;

  currentPage = name;

  if (returningFromPausedPage) {
    nextAuto = performance.now() + autoDelay();
  }

  for (const page of document.querySelectorAll(".page")) {
    page.hidden = page !== destination;
  }

  for (const button of document.querySelectorAll("[data-page]")) {
    if (button.dataset.page === name) {
      button.setAttribute("aria-current", "page");
    } else {
      button.removeAttribute("aria-current");
    }
  }

  render();
  destination.focus({ preventScroll: true });
}

for (const button of document.querySelectorAll("[data-page]")) {
  button.addEventListener("click", () => showPage(button.dataset.page));
}

/* ---------- Rolls ---------- */

function roll(automatic = false) {
  const now = performance.now();

  if (!canPlay || document.hidden || challenge) return;

  if (automatic) {
    if (!autoOn || !state.autoOwned || now < nextAuto ||
        (state.settings.pauseOutsideGame && currentPage !== "game")) {
      return;
    }
  } else if (autoOn || currentPage !== "game") {
    return;
  }

  // Resolve with the current Focus multiplier before using its charge.
  const index = chooseRarity();
  const rarity = rarities[index];
  const reward = automatic
    ? Math.max(1, Math.floor(rarity.coins * 0.4))
    : rarity.coins;

  if (state.earned > SAFE_MAX - reward ||
      state.manual + state.automatic >= SAFE_MAX) {
    autoOn = false;
    sessionMessage = "This save has reached the browser's safe numeric range.";
    showNotice();
    render();
    return;
  }

  state.collection[index]++;
  state.coins += reward;
  state.earned += reward;

  if (automatic) {
    state.automatic++;
    nextAuto = now + autoDelay();
  } else {
    state.manual++;
  }

  // Both manual and automatic rolls consume one charge.
  const usedFocus = state.charges > 0;

  if (usedFocus) {
    state.charges--;
    if (state.charges === 0) state.multiplier = 1;
  }

  $("rarity").textContent = rarity.name;
  $("rarity").style.color = rarity.color;
  $("rarity").classList.toggle("rare-result", index >= 3);

  $("reward").textContent =
    `+${reward.toLocaleString()} coins${usedFocus ? " · Focus boosted" : ""}`;

  changed();
  render();
}

$("roll").addEventListener("click", event => {
  if (event.isTrusted) roll();
});

$("auto").addEventListener("click", event => {
  if (!event.isTrusted || !canPlay || document.hidden || challenge ||
      currentPage !== "game") return;

  if (!state.autoOwned) {
    if (state.coins < AUTO_COST) return;

    state.coins -= AUTO_COST;
    state.autoOwned = true;
  }

  autoOn = !autoOn;
  nextAuto = performance.now() + autoDelay();

  changed(true);
  render();
});

/* ---------- Upgrades ---------- */

function purchase(key) {
  if (!canPlay || document.hidden || challenge ||
      currentPage !== "game" || upgradeMaxed(key)) return;

  if (key === "speed" && !state.autoOwned) return;

  const cost = upgradePrice(key);
  if (!integer(cost) || state.coins < cost) return;

  state.coins -= cost;
  state.levels[key]++;

  if (key === "speed") {
    nextAuto = performance.now() + autoDelay();
  }

  changed(true);
  render();
}

/* ---------- Focus ---------- */

function startFocus() {
  const now = performance.now();

  if (!canPlay || document.hidden || currentPage !== "game" ||
      challenge || state.charges > 0 || now < focusDeadline) return;

  if (state.attempts >= SAFE_MAX) return;

  // Keep auto enabled. It pauses during the challenge, then resumes.
  state.attempts++;
  state.focusReady = Date.now() + FOCUS_DELAY;
  focusDeadline = now + FOCUS_DELAY;

  challenge = {
    started: now,
    duration: 1000 + random() * 260,
    centre: 0.25 + random() * 0.5,
    width: 0.085 + state.levels.focus * 0.006,
    reverse: random() < 0.5
  };

  const c = challenge;

  $("target").style.left = `${(c.centre - c.width / 2) * 100}%`;
  $("target").style.width = `${c.width * 100}%`;

  $("perfect").style.left = `${(c.centre - c.width * 0.1) * 100}%`;
  $("perfect").style.width = `${c.width * 0.2 * 100}%`;

  $("needle").style.left = c.reverse ? "100%" : "0%";
  $("focusMessage").textContent = "Stop inside the green zone.";

  lastFrame = now;
  changed(true);
  render();
}

function focusPosition(now) {
  const progress = Math.min(
    1,
    Math.max(0, (now - challenge.started) / challenge.duration)
  );

  return challenge.reverse ? 1 - progress : progress;
}

function finishFocus(forcedMiss = false) {
  if (!challenge) return;

  const now = performance.now();
  const c = challenge;
  const position = focusPosition(now);
  const stalled = lastFrame > 0 && now - lastFrame > 250;
  const distance = Math.abs(position - c.centre);

  challenge = null;

  const hit = !forcedMiss && !stalled &&
    now - c.started < c.duration &&
    distance <= c.width / 2;

  const perfect = hit && distance <= c.width * 0.1;

  $("needle").style.left = `${position * 100}%`;

  if (hit) {
    state.focusHits++;
    if (perfect) state.perfects++;

    state.charges = 5;
    state.multiplier = perfect ? 3.5 : 2;

    $("focusMessage").textContent = perfect
      ? "Perfect! 3.5× luck for 5 rolls."
      : "Hit! 2× luck for 5 rolls.";
  } else {
    $("focusMessage").textContent = "Miss. Nothing lost.";
  }

  // Resume after a full interval, without awarding catch-up rolls.
  nextAuto = now + autoDelay();

  changed(true);
  render();
}

$("focus").addEventListener("click", event => {
  if (!event.isTrusted || !canPlay || document.hidden ||
      currentPage !== "game") return;

  if (challenge) finishFocus();
  else startFocus();
});

/* ---------- Keyboard ---------- */

document.addEventListener("keydown", event => {
  if (event.code !== "Space" || !event.isTrusted ||
      !canPlay || document.hidden || currentPage !== "game") return;

  if (event.target instanceof Element && event.target.closest(
    "button, input, textarea, select, summary, a, [contenteditable]"
  )) return;

  event.preventDefault();
  if (event.repeat) return;

  if (challenge) finishFocus();
  else roll();
});

/* ---------- Settings and reset ---------- */

for (const button of document.querySelectorAll("[data-setting]")) {
  button.addEventListener("click", event => {
    if (!event.isTrusted || !canPlay || document.hidden) return;

    const key = button.dataset.setting;
    state.settings[key] = !state.settings[key];

    if (key === "pauseOutsideGame") {
      nextAuto = performance.now() + autoDelay();
    }

    changed(true);
    render();
  });
}

$("reset").addEventListener("click", event => {
  if (!event.isTrusted || !canPlay || document.hidden) return;

  if (state.settings.confirmReset &&
      !confirm("Delete all progress? This cannot be undone.")) return;

  const settings = { ...state.settings };

  autoOn = false;
  challenge = null;
  state = freshSave();
  state.settings = settings;

  focusDeadline = 0;
  nextAuto = performance.now() + autoDelay();
  sessionMessage = "";
  storageMessage = "";

  $("rarity").textContent = "Ready?";
  $("rarity").style.color = "";
  $("rarity").classList.remove("rare-result");
  $("reward").textContent = "Your next roll is one click away.";
  $("focusMessage").textContent = "Stop the needle in the green zone.";
  $("target").style.width = "0";
  $("perfect").style.width = "0";
  $("needle").style.left = "0";

  changed(true);
  showNotice();
  render();
});

/* ---------- Save ownership ---------- */

function activateSave() {
  state = loadSave();
  dirty = false;
  autoOn = false;
  challenge = null;
  canPlay = true;

  const now = performance.now();

  focusDeadline = now + Math.min(
    FOCUS_DELAY,
    Math.max(0, state.focusReady - Date.now())
  );

  nextAuto = now + autoDelay();
  lastFrame = now;

  showNotice();
  render();

  // Persist migrations only after this tab owns the save.
  changed(true);
}

async function acquireOwnership() {
  if (!pageLive) return;

  if (lockTask) {
    await lockTask.catch(() => {});
    if (!pageLive || canPlay) return;
  }

  if (!useLocks) {
    activateSave();
    return;
  }

  canPlay = false;
  render();

  const task = navigator.locks.request(
    LOCK_KEY,
    { ifAvailable: true },
    async lock => {
      if (!pageLive) return;

      if (!lock) {
        sessionMessage =
          "The game is open in another tab. Close it, then reload this page.";
        showNotice();
        render();
        return;
      }

      sessionMessage = "";
      activateSave();

      await new Promise(resolve => {
        unlock = resolve;
      });

      unlock = null;
    }
  );

  lockTask = task;

  try {
    await task;
  } catch {
    if (pageLive) {
      useLocks = false;
      sessionMessage =
        "Single-tab protection is unavailable. Please play in one tab.";
      activateSave();
    }
  } finally {
    if (lockTask === task) lockTask = null;
  }
}

/* ---------- Visibility and browser navigation ---------- */

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    if (challenge) finishFocus(true);
    saveNow();
  } else {
    lastFrame = performance.now();
    nextAuto = lastFrame + autoDelay();
  }

  render();
});

window.addEventListener("pagehide", () => {
  pageLive = false;

  if (challenge) finishFocus(true);

  saveNow();
  autoOn = false;
  canPlay = false;

  if (unlock) unlock();
});

window.addEventListener("pageshow", event => {
  if (!event.persisted) return;

  pageLive = true;
  autoOn = false;
  acquireOwnership();
});

// Best-effort synchronization if Web Locks are unavailable.
window.addEventListener("storage", event => {
  if (useLocks || !canPlay ||
      (event.key !== SAVE_KEY && event.key !== null)) return;

  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }

  dirty = false;
  autoOn = false;
  challenge = null;

  state = loadSave();

  focusDeadline = performance.now() + Math.min(
    FOCUS_DELAY,
    Math.max(0, state.focusReady - Date.now())
  );

  nextAuto = performance.now() + autoDelay();
  sessionMessage = "Progress updated from another tab. Please use one tab.";
  showNotice();
  render();
});

/* ---------- Main loop ---------- */

function frame(now) {
  if (canPlay && !document.hidden) {
    if (challenge) {
      const stalled = lastFrame > 0 && now - lastFrame > 250;
      const expired = now - challenge.started >= challenge.duration;

      if (stalled || expired) {
        finishFocus(true);
      } else {
        $("needle").style.left = `${focusPosition(now) * 100}%`;
      }
    }

    if (autoOn && !challenge && now >= nextAuto) {
      roll(true);
    }
  }

  if (now - lastButtonPaint >= 100) {
    renderButtons();
    lastButtonPaint = now;
  }

  lastFrame = now;
  requestAnimationFrame(frame);
}

/* ---------- Start ---------- */

buildCollection();
buildUpgrades();
buildStats();
render();
acquireOwnership();
requestAnimationFrame(frame);
