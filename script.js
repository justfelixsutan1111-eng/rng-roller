"use strict";

const $ = id => document.getElementById(id);
const SAVE_KEY = "rng-roller-035";
const AUTO_COST = 1000;
const FOCUS_DELAY = 12000;
const BASE_AUTO_DELAY = 900;
const AUTO_SPEED_STEP = 60;
const MAX_SPEED = 10;
const MAX_FOCUS = 5;
const SAFE_MAX = Number.MAX_SAFE_INTEGER;

const rarities = [
  { name: "Common", weight: 680000, coins: 3, color: "#c4cede" },
  { name: "Uncommon", weight: 210000, coins: 6, color: "#78e8be" },
  { name: "Rare", weight: 75000, coins: 15, color: "#7bbdff" },
  { name: "Epic", weight: 24000, coins: 45, color: "#be9cff" },
  { name: "Legendary", weight: 7500, coins: 140, color: "#ffd48a" },
  { name: "Mythic", weight: 2400, coins: 450, color: "#ff98c8" },
  { name: "Exotic", weight: 750, coins: 1200, color: "#ff6b8b" },
  { name: "Divine", weight: 240, coins: 3500, color: "#7af0ff" },
  { name: "Celestial", weight: 90, coins: 10000, color: "#a38bff" },
  { name: "Transcendent", weight: 20, coins: 35000, color: "#fff099" }
];

const upgradeDefinitions = [
  { key: "luck", name: "Luck" },
  { key: "speed", name: "Auto Speed" },
  { key: "focus", name: "Focus Width" }
];

let storageMessage = "";
let sessionMessage = "";
let state = freshSave();
let currentPage = "game";
let autoOn = false;
let autoStoppedByRarity = false;
let selectedRarity = null;
let challenge = null;
let nextAuto = 0;
let focusDeadline = 0;
let lastFrame = 0;
let lastButtonPaint = 0;
let saveTimer = null;
let dirty = false;
let canPlay = false;

const collectionViews = [];
const upgradeViews = new Map();
const statsViews = new Map();
const highlightViews = new Map();
const breakdownViews = [];

const formatMoney = value => `$${value.toLocaleString()}`;
const formatInterval = ms => `${(ms / 1000).toFixed(2)}s`;
const formatLuck = value =>
  `${Number(value.toFixed(2)).toLocaleString(undefined, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 2
  })}×`;
const formatChance = probability => {
  const percent = probability * 100;
  return `${percent.toFixed(percent < 0.1 ? 4 : 2)}%`;
};

function freshSave() {
  return {
    version: 5,
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
      rollAnimation: true,
      confirmReset: true,
      reducedMotion: false,
      pauseOutsideGame: false,
      autoStopMinRarity: 5
    },
    levels: { luck: 0, speed: 0, focus: 0 },
    collection: new Array(rarities.length).fill(0)
  };
}

const integer = value => Number.isSafeInteger(value) && value >= 0;

function upgradePrice(key, levels = state.levels) {
  if (key === "luck") return 120 + levels.luck * 60;
  if (key === "speed") return Math.ceil(150 * 1.7 ** levels.speed);
  if (key === "focus") return 150 * 2 ** levels.focus;
  return Infinity;
}

const luckBulkCost = (level, count) =>
  count <= 0 ? 0 : count * (120 + 60 * level) + 30 * count * (count - 1);

function maxLuckPurchases(coins = state.coins, level = state.levels.luck) {
  const firstCost = 120 + 60 * level;
  if (coins < firstCost) return { count: 0, cost: firstCost };

  const b = 60 * level + 90;
  let count = Math.floor((-b + Math.sqrt(b * b + 120 * coins)) / 60);
  if (count < 1) count = 1;

  while (luckBulkCost(level, count + 1) <= coins) count++;
  while (count > 1 && luckBulkCost(level, count) > coins) count--;

  const cost = luckBulkCost(level, count);
  return integer(cost) ? { count, cost } : { count: 0, cost: firstCost };
}

function spentTotal(save) {
  const luckLevel = save.levels.luck;
  let spent = 30 * luckLevel * (luckLevel + 3);
  if (!integer(spent)) return NaN;

  if (save.autoOwned) spent += AUTO_COST;
  for (let i = 0; i < save.levels.speed; i++) {
    spent += Math.ceil(150 * 1.7 ** i);
  }
  for (let i = 0; i < save.levels.focus; i++) {
    spent += 150 * 2 ** i;
  }

  return integer(spent) ? spent : NaN;
}

function validSave(save) {
  if (!save || typeof save !== "object" || save.version !== 5) return false;

  const fields = [
    "coins",
    "earned",
    "manual",
    "automatic",
    "attempts",
    "focusHits",
    "perfects",
    "charges",
    "focusReady"
  ];
  if (!fields.every(key => integer(save[key])) || typeof save.autoOwned !== "boolean") {
    return false;
  }

  const settings = save.settings;
  if (
    !settings ||
    !["rollAnimation", "confirmReset", "reducedMotion", "pauseOutsideGame"].every(
      key => typeof settings[key] === "boolean"
    )
  ) {
    return false;
  }
  if (!integer(settings.autoStopMinRarity) || settings.autoStopMinRarity >= rarities.length) {
    return false;
  }
  if (
    !Array.isArray(save.collection) ||
    save.collection.length !== rarities.length ||
    !save.collection.every(integer)
  ) {
    return false;
  }
  if (save.manual + save.automatic !== save.collection.reduce((sum, count) => sum + count, 0)) {
    return false;
  }
  if (
    save.charges > 5 ||
    (save.charges === 0 && save.multiplier !== 1) ||
    (save.charges > 0 && ![2, 3.5].includes(save.multiplier))
  ) {
    return false;
  }

  const levels = save.levels;
  if (
    !levels ||
    !integer(levels.luck) ||
    !integer(levels.speed) ||
    !integer(levels.focus) ||
    levels.speed > MAX_SPEED ||
    levels.focus > MAX_FOCUS
  ) {
    return false;
  }

  const spent = spentTotal(save);
  return integer(spent) && save.earned - spent === save.coins;
}

function loadSave() {
  storageMessage = "";
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return freshSave();

    const save = JSON.parse(raw);
    if (validSave(save)) return save;
    storageMessage = "Invalid save data. A new game was loaded.";
  } catch {
    storageMessage = "Could not load saved progress.";
  }
  return freshSave();
}

const showNotice = () => {
  $("notice").textContent = sessionMessage || storageMessage;
};

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
    saveTimer = setTimeout(saveNow, 150);
  }
}

function random() {
  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  return value[0] / 4294967296;
}

const baseLuck = () => 1 + state.levels.luck * 0.1;
const totalLuck = () => baseLuck() * (state.charges > 0 ? state.multiplier : 1);
const rarityWeights = () => {
  const luck = totalLuck();
  return rarities.map((rarity, index) => rarity.weight * (index === 0 ? 1 : luck));
};

function chooseRarity() {
  const weights = rarityWeights();
  let target = random() * weights.reduce((sum, weight) => sum + weight, 0);
  for (let i = 0; i < weights.length; i++) {
    target -= weights[i];
    if (target < 0) return i;
  }
  return rarities.length - 1;
}

const autoDelay = () => BASE_AUTO_DELAY - state.levels.speed * AUTO_SPEED_STEP;
const focusWidthPercent = () => (0.085 + state.levels.focus * 0.006) * 100;

function el(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function buildCollection() {
  rarities.forEach((rarity, index) => {
    const card = el("button", "item");
    card.type = "button";
    card.style.setProperty("--rarity-color", rarity.color);
    card.setAttribute("aria-expanded", "false");

    const name = el("strong");
    const tag = el("span", "item-tag");
    card.append(name, tag);
    card.addEventListener("click", () => {
      selectedRarity = selectedRarity === index ? null : index;
      renderCollection();
    });

    $("collection").append(card);
    collectionViews.push({ card, name, tag });
  });

  $("closeInfo").addEventListener("click", () => {
    selectedRarity = null;
    renderCollection();
  });
}

function buildUpgrades() {
  for (const upgrade of upgradeDefinitions) {
    const row = el("div", "upgrade");
    const copy = el("div");
    const name = el("strong", "upgrade-name", upgrade.name);
    const detail = el("span", "upgrade-detail");
    const actions = el("div", "upgrade-actions");

    const buy = el("button");
    buy.type = "button";
    buy.addEventListener("click", () => purchase(upgrade.key));
    actions.append(buy);

    let max = null;
    if (upgrade.key === "luck") {
      max = el("button", "max-button");
      max.type = "button";
      max.addEventListener("click", purchaseMaxLuck);
      actions.append(max);
    }

    copy.append(name, detail);
    row.append(copy, actions);
    $("upgrades").append(row);
    upgradeViews.set(upgrade.key, { detail, buy, max });
  }
}

function buildStats() {
  for (const [key, label] of [
    ["rolls", "TOTAL ROLLS"],
    ["lifetime", "LIFETIME MONEY"],
    ["best", "BEST RARITY"],
    ["luck", "CURRENT LUCK"]
  ]) {
    const card = el("div", "stat-card");
    const value = el("strong", "stat-card-value");
    const sub = el("span", "stat-card-sub");
    card.append(el("span", "stat-card-label", label), value, sub);
    $("statsHighlights").append(card);
    highlightViews.set(key, { value, sub });
  }

  const fill = (container, rows) => {
    for (const [key, label] of rows) {
      const row = el("div");
      const value = el("dd");
      row.append(el("dt", null, label), value);
      container.append(row);
      statsViews.set(key, value);
    }
  };

  fill($("statsEconomy"), [
    ["manual", "Manual rolls"],
    ["automatic", "Auto rolls"],
    ["currentMoney", "Current money"],
    ["spentMoney", "Money spent"],
    ["avgRoll", "Average per roll"],
    ["speed", "Auto interval"]
  ]);
  fill($("statsSkill"), [
    ["attempts", "Focus attempts"],
    ["focusHits", "Focus hits"],
    ["perfects", "Perfect hits"],
    ["rate", "Focus success"],
    ["perfectRate", "Perfect rate"],
    ["focusWidth", "Focus zone width"]
  ]);

  for (const rarity of rarities) {
    const row = el("div", "breakdown-row");
    const top = el("div", "breakdown-top");
    const name = el("span", "breakdown-name");
    const meta = el("span", "breakdown-meta");
    top.append(name, meta);

    const bar = el("div", "breakdown-bar");
    const fillBar = el("div", "breakdown-fill");
    fillBar.style.background = rarity.color;
    bar.append(fillBar);
    row.append(top, bar);
    $("statsBreakdown").append(row);
    breakdownViews.push({ name, meta, fill: fillBar });
  }
}

const upgradeMaxed = key =>
  key === "speed"
    ? state.levels.speed >= MAX_SPEED
    : key === "focus"
      ? state.levels.focus >= MAX_FOCUS
      : false;

function renderButtons() {
  const blocked = !canPlay || document.hidden;
  const remaining = Math.max(0, focusDeadline - performance.now());

  $("roll").disabled = blocked || autoOn || !!challenge;
  $("roll").textContent = challenge ? "Focusing…" : autoOn ? "Auto rolling…" : "Roll";
  $("auto").disabled = blocked || !!challenge || (!state.autoOwned && state.coins < AUTO_COST);
  $("auto").textContent = state.autoOwned
    ? `Auto roll: ${autoOn ? "On" : "Off"}`
    : `Auto roll · ${formatMoney(AUTO_COST)}`;
  $("auto").setAttribute("aria-pressed", String(autoOn));
  $("focus").disabled = blocked || (!challenge && (state.charges > 0 || remaining > 0));
  $("focus").textContent = challenge
    ? "Stop needle"
    : state.charges > 0
      ? `${state.charges} boosted rolls left`
      : remaining > 0
        ? `Ready in ${Math.ceil(remaining / 1000)}s`
        : "Start focus";
  $("reset").disabled = blocked;
  $("autoStopButton").disabled = blocked;

  for (const [key, view] of upgradeViews) {
    view.buy.disabled =
      blocked ||
      !!challenge ||
      upgradeMaxed(key) ||
      (key === "speed" && !state.autoOwned) ||
      state.coins < upgradePrice(key);

    if (view.max) {
      const purchases = maxLuckPurchases();
      view.max.disabled = blocked || !!challenge || purchases.count < 1;
      view.max.textContent =
        purchases.count > 0 ? `Max (+${purchases.count.toLocaleString()})` : "Max";
    }
  }

  for (const button of document.querySelectorAll("[data-setting]")) {
    button.disabled = blocked;
  }
}

function renderUpgrades() {
  for (const [key, view] of upgradeViews) {
    const level = state.levels[key];
    view.detail.textContent =
      key === "luck"
        ? `Lv. ${level.toLocaleString()} · ${formatLuck(baseLuck())} · +0.1×`
        : key === "speed"
          ? `${level}/${MAX_SPEED} · ${formatInterval(autoDelay())}`
          : `${level}/${MAX_FOCUS} · ${focusWidthPercent().toFixed(1)}% zone`;
    view.buy.textContent = upgradeMaxed(key)
      ? "Maxed"
      : key === "speed" && !state.autoOwned
        ? "Unlock auto first"
        : formatMoney(upgradePrice(key));
  }
}

function renderCollection() {
  const weights = rarityWeights();
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const totalRolls = state.manual + state.automatic;
  let found = 0;

  collectionViews.forEach((view, index) => {
    const unlocked = state.collection[index] > 0;
    if (unlocked) found++;

    view.card.classList.toggle("item-locked", !unlocked);
    view.card.setAttribute("aria-expanded", String(selectedRarity === index));
    view.name.textContent = unlocked ? rarities[index].name : "???";
    view.tag.textContent = unlocked ? "Info" : "Locked";
  });

  $("collectionProgress").textContent = `${found} / ${rarities.length}`;
  const box = $("collectionInfo");
  if (selectedRarity === null) {
    box.hidden = true;
    return;
  }

  box.hidden = false;
  const rarity = rarities[selectedRarity];
  const count = state.collection[selectedRarity];
  const unlocked = count > 0;
  const probability = weights[selectedRarity] / totalWeight;
  const share = totalRolls > 0 ? (count / totalRolls) * 100 : 0;

  $("infoTier").textContent = `TIER ${selectedRarity + 1} OF ${rarities.length}`;
  $("infoName").textContent = unlocked ? rarity.name : "??? (Undiscovered)";
  $("infoName").style.color = unlocked ? rarity.color : "var(--muted)";
  $("infoValue").textContent = unlocked ? `${formatMoney(rarity.coins)} per roll` : "???";
  $("infoOdds").textContent = `${formatChance(probability)} (1 in ${Math.max(
    1,
    Math.round(1 / probability)
  ).toLocaleString()})`;
  $("infoCount").textContent = unlocked
    ? `${count.toLocaleString()} (${share.toFixed(share < 0.1 ? 2 : 1)}%)`
    : "0 found";
  $("infoEarned").textContent = unlocked
    ? formatMoney(count * rarity.coins)
    : "Unlock to reveal";
}

function renderStats() {
  const total = state.manual + state.automatic;
  const spent = Math.max(0, state.earned - state.coins);
  let bestIndex = -1;
  for (let i = rarities.length - 1; i >= 0; i--) {
    if (state.collection[i] > 0) {
      bestIndex = i;
      break;
    }
  }
  const best = bestIndex >= 0 ? rarities[bestIndex] : null;

  const rollCard = highlightViews.get("rolls");
  rollCard.value.textContent = total.toLocaleString();
  rollCard.sub.textContent = `${state.manual.toLocaleString()} manual · ${
    total ? Math.round((state.automatic / total) * 100) : 0
  }% auto`;

  const lifetimeCard = highlightViews.get("lifetime");
  lifetimeCard.value.textContent = formatMoney(state.earned);
  lifetimeCard.value.style.color = "var(--gold)";
  lifetimeCard.sub.textContent = `${formatMoney(state.coins)} wallet · ${formatMoney(spent)} spent`;

  const bestCard = highlightViews.get("best");
  bestCard.value.textContent = best ? best.name : "None";
  bestCard.value.style.color = best ? best.color : "var(--text)";
  bestCard.sub.textContent = best
    ? `${state.collection[bestIndex].toLocaleString()} found · ${formatMoney(best.coins)} drop`
    : "Roll to discover rarities";

  const luckCard = highlightViews.get("luck");
  luckCard.value.textContent = formatLuck(totalLuck());
  luckCard.value.style.color = "var(--mint)";
  luckCard.sub.textContent =
    state.charges > 0
      ? `Base ${formatLuck(baseLuck())} · ${state.multiplier}× Focus (${state.charges} left)`
      : `Base ${formatLuck(baseLuck())} · Focus inactive`;

  const percentage = count =>
    state.attempts ? `${((count / state.attempts) * 100).toFixed(1)}%` : "0%";
  const values = {
    manual: state.manual.toLocaleString(),
    automatic: state.automatic.toLocaleString(),
    currentMoney: formatMoney(state.coins),
    spentMoney: formatMoney(spent),
    avgRoll: total
      ? `$${(state.earned / total).toLocaleString(undefined, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2
        })}`
      : "$0.00",
    speed: formatInterval(autoDelay()),
    attempts: state.attempts.toLocaleString(),
    focusHits: state.focusHits.toLocaleString(),
    perfects: state.perfects.toLocaleString(),
    rate: percentage(state.focusHits),
    perfectRate: percentage(state.perfects),
    focusWidth: `${focusWidthPercent().toFixed(1)}%`
  };
  for (const [key, value] of Object.entries(values)) {
    statsViews.get(key).textContent = value;
  }

  breakdownViews.forEach((view, index) => {
    const rarity = rarities[index];
    const count = state.collection[index];
    const unlocked = count > 0;
    const share = total ? (count / total) * 100 : 0;
    view.name.textContent = unlocked ? `${rarity.name} (${formatMoney(rarity.coins)})` : "???";
    view.name.style.color = unlocked ? rarity.color : "var(--muted)";
    view.meta.textContent = `${count.toLocaleString()} (${share.toFixed(
      share > 0 && share < 0.1 ? 2 : 1
    )}%)`;
    view.fill.style.width = `${Math.min(100, share)}%`;
  });
}

function renderSettings() {
  for (const button of document.querySelectorAll("[data-setting]")) {
    const enabled = state.settings[button.dataset.setting];
    button.textContent = enabled ? "On" : "Off";
    button.setAttribute("aria-pressed", String(enabled));
  }

  const index = state.settings.autoStopMinRarity;
  const button = $("autoStopButton");
  if (index === 0) {
    button.textContent = "Off";
    button.style.color = "var(--muted)";
  } else {
    button.textContent = index === rarities.length - 1 ? rarities[index].name : `${rarities[index].name}+`;
    button.style.color = rarities[index].color;
  }
  document.body.classList.toggle("reduced-motion", state.settings.reducedMotion);
}

function render() {
  $("coins").textContent = formatMoney(state.coins);
  $("luck").textContent = formatLuck(totalLuck());
  $("boost").textContent =
    state.charges > 0 ? `${state.multiplier}× · ${state.charges} left` : "Inactive";

  const paused =
    autoOn &&
    (document.hidden ||
      !!challenge ||
      (state.settings.pauseOutsideGame && currentPage !== "game"));
  $("rollMode").textContent = autoOn
    ? paused
      ? "Auto paused"
      : "Auto"
    : autoStoppedByRarity
      ? "Auto stopped"
      : "Manual";
  $("autoInfo").textContent = `Auto: ${formatInterval(autoDelay())} · 100% money`;

  renderUpgrades();
  renderCollection();
  renderStats();
  renderSettings();
  renderButtons();
}

function showPage(name) {
  const destination = $("page-" + name);
  if (!destination) return;
  if (challenge && name !== "game") finishFocus(true);

  const returningToGame =
    currentPage !== "game" && name === "game" && state.settings.pauseOutsideGame;
  currentPage = name;
  if (returningToGame) nextAuto = performance.now() + autoDelay();

  for (const page of document.querySelectorAll(".page")) {
    page.hidden = page !== destination;
  }
  for (const button of document.querySelectorAll("[data-page]")) {
    if (button.dataset.page === name) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }

  render();
  destination.focus({ preventScroll: true });
}

for (const button of document.querySelectorAll("[data-page]")) {
  button.addEventListener("click", () => showPage(button.dataset.page));
}

function triggerRollAnimation(color, autoStopped = false) {
  const reveal = $("reveal");
  reveal.style.setProperty("--drop-color", color);
  reveal.classList.remove("roll-animate", "autostop-animate");
  if (state.settings.reducedMotion) return;

  if (autoStopped) {
    void reveal.offsetWidth;
    reveal.classList.add("autostop-animate");
    return;
  }
  if (!state.settings.rollAnimation) return;

  void reveal.offsetWidth;
  reveal.classList.add("roll-animate");
}

function roll(automatic = false) {
  const now = performance.now();
  if (!canPlay || document.hidden || challenge) return;

  if (automatic) {
    if (
      !autoOn ||
      !state.autoOwned ||
      now < nextAuto ||
      (state.settings.pauseOutsideGame && currentPage !== "game")
    ) {
      return;
    }
  } else if (autoOn || currentPage !== "game") {
    return;
  }

  const index = chooseRarity();
  const rarity = rarities[index];
  const reward = rarity.coins;
  if (state.earned > SAFE_MAX - reward || state.manual + state.automatic >= SAFE_MAX) {
    autoOn = false;
    sessionMessage = "This save has reached the safe numeric range.";
    showNotice();
    render();
    return;
  }

  state.collection[index]++;
  state.coins += reward;
  state.earned += reward;

  let stopped = false;
  const minimumStop = state.settings.autoStopMinRarity;
  if (automatic) {
    state.automatic++;
    if (minimumStop > 0 && index >= minimumStop) {
      autoOn = false;
      autoStoppedByRarity = true;
      stopped = true;
    } else {
      nextAuto = now + autoDelay();
    }
  } else {
    state.manual++;
    autoStoppedByRarity = false;
  }

  const usedFocus = state.charges > 0;
  if (usedFocus) {
    state.charges--;
    if (state.charges === 0) state.multiplier = 1;
  }

  $("resultLabel").textContent = stopped ? "AUTO-STOPPED ON RARE DROP!" : "YOUR DROP";
  $("rarity").textContent = rarity.name;
  $("rarity").style.color = rarity.color;
  $("rarity").classList.toggle("rare-result", index >= 3);

  const notes = [];
  if (usedFocus) notes.push("Focus boosted");
  if (stopped) notes.push("Auto-stopped");
  $("reward").textContent = `+${formatMoney(reward)}${
    notes.length ? " · " + notes.join(" · ") : ""
  }`;

  triggerRollAnimation(rarity.color, stopped);
  changed(stopped);
  render();
}

$("roll").addEventListener("click", () => roll());
$("auto").addEventListener("click", () => {
  if (!canPlay || document.hidden || challenge || currentPage !== "game") return;
  if (!state.autoOwned) {
    if (state.coins < AUTO_COST) return;
    state.coins -= AUTO_COST;
    state.autoOwned = true;
  }

  autoOn = !autoOn;
  if (autoOn) autoStoppedByRarity = false;
  nextAuto = performance.now() + autoDelay();
  changed(true);
  render();
});

function purchase(key) {
  if (!canPlay || document.hidden || challenge || currentPage !== "game" || upgradeMaxed(key)) {
    return;
  }
  if (key === "speed" && !state.autoOwned) return;

  const cost = upgradePrice(key);
  if (!integer(cost) || state.coins < cost) return;
  state.coins -= cost;
  state.levels[key]++;
  if (key === "speed") nextAuto = performance.now() + autoDelay();
  changed(true);
  render();
}

function purchaseMaxLuck() {
  if (!canPlay || document.hidden || challenge || currentPage !== "game") return;

  const { count, cost } = maxLuckPurchases();
  if (count < 1 || !integer(cost) || state.coins < cost) return;
  state.coins -= cost;
  state.levels.luck += count;
  changed(true);
  render();
}

function startFocus() {
  const now = performance.now();
  if (
    !canPlay ||
    document.hidden ||
    currentPage !== "game" ||
    challenge ||
    state.charges > 0 ||
    now < focusDeadline
  ) {
    return;
  }
  if (state.attempts >= SAFE_MAX) return;

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

  const currentChallenge = challenge;
  $("target").style.left = `${(currentChallenge.centre - currentChallenge.width / 2) * 100}%`;
  $("target").style.width = `${currentChallenge.width * 100}%`;
  $("perfect").style.left = `${
    (currentChallenge.centre - currentChallenge.width * 0.1) * 100
  }%`;
  $("perfect").style.width = `${currentChallenge.width * 0.2 * 100}%`;
  $("needle").style.left = currentChallenge.reverse ? "100%" : "0%";
  $("focusMessage").textContent = "Stop inside the green zone.";
  lastFrame = now;
  changed(true);
  render();
}

function focusPosition(now) {
  const progress = Math.min(1, Math.max(0, (now - challenge.started) / challenge.duration));
  return challenge.reverse ? 1 - progress : progress;
}

function finishFocus(forcedMiss = false) {
  if (!challenge) return;

  const now = performance.now();
  const currentChallenge = challenge;
  const position = focusPosition(now);
  const stalled = lastFrame > 0 && now - lastFrame > 250;
  const distance = Math.abs(position - currentChallenge.centre);
  challenge = null;

  const hit =
    !forcedMiss &&
    !stalled &&
    now - currentChallenge.started < currentChallenge.duration &&
    distance <= currentChallenge.width / 2;
  const perfect = hit && distance <= currentChallenge.width * 0.1;
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

  nextAuto = now + autoDelay();
  changed(true);
  render();
}

$("focus").addEventListener("click", () => {
  if (!canPlay || document.hidden || currentPage !== "game") return;
  if (challenge) finishFocus();
  else startFocus();
});

document.addEventListener("keydown", event => {
  if (event.code !== "Space" || !canPlay || document.hidden || currentPage !== "game") return;
  if (
    event.target instanceof Element &&
    event.target.closest("button,input,textarea,select,summary,a,[contenteditable]")
  ) {
    return;
  }
  event.preventDefault();
  if (event.repeat) return;
  if (challenge) finishFocus();
  else roll();
});

for (const button of document.querySelectorAll("[data-setting]")) {
  button.addEventListener("click", () => {
    if (!canPlay || document.hidden) return;

    const key = button.dataset.setting;
    state.settings[key] = !state.settings[key];
    if (key === "pauseOutsideGame") nextAuto = performance.now() + autoDelay();
    if (key === "rollAnimation" && !state.settings.rollAnimation) {
      $("reveal").classList.remove("roll-animate");
    }
    changed(true);
    render();
  });
}

$("autoStopButton").addEventListener("click", () => {
  if (!canPlay || document.hidden) return;
  state.settings.autoStopMinRarity =
    (state.settings.autoStopMinRarity + 1) % rarities.length;
  changed(true);
  render();
});

$("reset").addEventListener("click", () => {
  if (!canPlay || document.hidden) return;

  let confirmed = true;
  if (state.settings.confirmReset) {
    try {
      confirmed = confirm("Delete all progress? This cannot be undone.");
    } catch {
      confirmed = true;
    }
  }
  if (!confirmed) return;

  const settings = { ...state.settings };
  autoOn = false;
  autoStoppedByRarity = false;
  selectedRarity = null;
  challenge = null;
  state = freshSave();
  state.settings = settings;
  focusDeadline = 0;
  nextAuto = performance.now() + autoDelay();
  sessionMessage = "";
  storageMessage = "";

  $("reveal").classList.remove("roll-animate", "autostop-animate");
  $("resultLabel").textContent = "YOUR DROP";
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
  if (challenge) finishFocus(true);
  saveNow();
});

function frame(now) {
  if (canPlay && !document.hidden) {
    if (challenge) {
      const stalled = lastFrame > 0 && now - lastFrame > 250;
      const expired = now - challenge.started >= challenge.duration;
      if (stalled || expired) finishFocus(true);
      else $("needle").style.left = `${focusPosition(now) * 100}%`;
    }
    if (autoOn && !challenge && now >= nextAuto) roll(true);
  }

  if (now - lastButtonPaint >= 100) {
    renderButtons();
    lastButtonPaint = now;
  }
  lastFrame = now;
  requestAnimationFrame(frame);
}

buildCollection();
buildUpgrades();
buildStats();
state = loadSave();
canPlay = true;

{
  const now = performance.now();
  focusDeadline = now + Math.min(FOCUS_DELAY, Math.max(0, state.focusReady - Date.now()));
  nextAuto = now + autoDelay();
  lastFrame = now;
}

showNotice();
render();
requestAnimationFrame(frame);
