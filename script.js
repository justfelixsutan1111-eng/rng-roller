"use strict";

(() => {
  const $ = id => document.getElementById(id);
  const KEY = "rng-roller-040";
  const OLD = "rng-roller-035";
  const LIMIT = Number.MAX_SAFE_INTEGER;
  const AUTO_COST = 350;
  const CINEMATIC_MIN = 4;

  // Name, base weight, payout, glass color.
  const rarities = [
    ["Common",       680000,     3, "#c4cede"],
    ["Uncommon",     210000,     6, "#78e8be"],
    ["Rare",          75000,    15, "#7bbdff"],
    ["Epic",          24000,    45, "#be9cff"],
    ["Legendary",      7500,   140, "#ffd48a"],
    ["Mythic",         2400,   450, "#ff98c8"],
    ["Exotic",          750,  1200, "#ff6b8b"],
    ["Divine",          240,  3500, "#7af0ff"],
    ["Celestial",        90, 10000, "#a38bff"],
    ["Transcendent",     20, 35000, "#fff099"]
  ];

  // Internal pricing only. Nothing in the UI displays these boundaries.
  const stages = [[0,1], [5,2], [14,4], [28,8], [48,18]];

  // Name, first price, price step, cap.
  const shop = {
    luck:     ["Luck",           30, 20, Infinity],
    speed:    ["Auto Speed",     80, 95, 10],
    focus:    ["Focus Width",    50, 50, 5],
    reserve:  ["Focus Reserve",  70, 70, 5],
    recovery: ["Focus Recovery", 65, 65, 6]
  };
  const keys = Object.keys(shop);
  const prefs = ["rollAnimation", "reducedMotion", "confirmReset", "pauseOutsideGame"];
  const tabs = Array.from(document.querySelectorAll("nav [data-page]"));
  const deviceMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const focusHelp = "Stop the needle in green. Aim for the pale center for a perfect hit.";

  const int = v => Number.isSafeInteger(v) && v >= 0;
  const num = n => n.toLocaleString();
  const cash = n => "$" + num(n);
  const times = n => Number(n.toFixed(2)) + "×";
  const sum = a => a.reduce((x, y) => x + y, 0);
  const percent = p => (100 * p).toFixed(p < .001 ? 4 : 2) + "%";
  const buffer = new Uint32Array(1);
  const random = () => crypto.getRandomValues(buffer)[0] / 4294967296;
  const notice = text => { $("notice").textContent = text; };

  function fresh() {
    return {
      version: 6,
      coins: 0, earned: 0, spent: 0, manual: 0, automatic: 0,
      attempts: 0, focusHits: 0, perfects: 0,
      charges: 0, multiplier: 1, focusReady: 0, autoOwned: false,
      settings: {
        rollAnimation: true, reducedMotion: false, confirmReset: true,
        pauseOutsideGame: false, autoStopMinRarity: 5
      },
      levels: { luck: 0, speed: 0, focus: 0, reserve: 0, recovery: 0 },
      collection: Array(10).fill(0)
    };
  }

  function valid(data, legacy = false) {
    if (!data || data.version !== (legacy ? 5 : 6) || !data.settings || !data.levels) return false;

    const counts = ["coins", "earned", "manual", "automatic", "attempts",
      "focusHits", "perfects", "charges", "focusReady"];
    if (!counts.every(k => int(data[k]))) return false;
    if (typeof data.autoOwned !== "boolean") return false;
    if (!prefs.every(k => typeof data.settings[k] === "boolean")) return false;

    const stop = data.settings.autoStopMinRarity;
    if (!int(stop) || stop >= rarities.length) return false;
    const levelKeys = legacy ? ["luck", "speed", "focus"] : keys;
    if (!levelKeys.every(k => int(data.levels[k]) && data.levels[k] <= shop[k][3])) return false;
    if (data.levels.luck > 1e8 || (!data.autoOwned && data.levels.speed)) return false;

    const c = data.collection;
    if (!Array.isArray(c) || c.length !== 10 || !c.every(int)) return false;
    if (!int(data.manual + data.automatic) || sum(c) !== data.manual + data.automatic) return false;
    if (sum(c.map((n, i) => n * rarities[i][2])) !== data.earned) return false;
    if (data.focusHits > data.attempts || data.perfects > data.focusHits) return false;
    if (data.charges > 5 + (legacy ? 0 : data.levels.reserve)) return false;
    if (data.charges ? ![2, 3.5].includes(data.multiplier) : data.multiplier !== 1) return false;

    let spent = data.spent;
    if (legacy) {
      const { luck, speed, focus } = data.levels;
      spent = 30 * luck * (luck + 3) + (data.autoOwned ? 1000 : 0) + 150 * (2 ** focus - 1);
      for (let i = 0; i < speed; i++) spent += Math.ceil(150 * 1.7 ** i);
    }
    return int(spent) && data.earned - spent === data.coins;
  }

  let dirty = false, saveTimer = 0, writable = true;

  function load() {
    try {
      const current = localStorage.getItem(KEY);
      if (current !== null) {
        const data = JSON.parse(current);
        if (!valid(data)) throw Error("Invalid save");
        return data;
      }
      const old = localStorage.getItem(OLD);
      if (old !== null) {
        const data = JSON.parse(old);
        if (!valid(data, true)) throw Error("Invalid legacy save");
        data.version = 6;
        data.spent = data.earned - data.coins;
        data.levels.reserve = 0;
        data.levels.recovery = 0;
        dirty = true;
        notice("Imported your 0.35 progress. Your original save is unchanged.");
        return data;
      }
    } catch {
      writable = false;
      notice("Could not read a valid save. Playing in memory only; existing data has not been replaced.");
    }
    return fresh();
  }

  let s = load();

  function flush() {
    clearTimeout(saveTimer);
    saveTimer = 0;
    if (!dirty || !writable) return;
    try {
      localStorage.setItem(KEY, JSON.stringify(s));
      dirty = false;
    } catch {
      notice("Browser storage is unavailable. Keep this tab open to retain this session.");
    }
  }
  function changed(immediate = false) {
    dirty = true;
    if (immediate) flush();
    else if (!saveTimer && writable) saveTimer = setTimeout(flush, 180);
  }

  let page = "game", auto = false, stopped = false;
  let selected = null, challenge = null, film = null, pulse = null;
  let credit = 0, last = performance.now(), lastNeedle = last, paint = 0;
  let cooldown = last + Math.min(12000, Math.max(0, s.focusReady - Date.now()));

  const cps = () => 2 + s.levels.speed;
  const width = () => .085 + .006 * s.levels.focus;
  const charges = () => 5 + s.levels.reserve;
  const recovery = () => 12000 - 1000 * s.levels.recovery;
  const baseLuck = () => 1 + .1 * s.levels.luck;
  const luck = () => baseLuck() * s.multiplier;
  const weights = () => rarities.map((r, i) => r[1] * (i ? luck() : 1));
  const still = () => s.settings.reducedMotion || deviceMotion.matches;
  const moving = () => s.settings.rollAnimation && !still();

  const locked = () => document.hidden || !!film;
  const playable = () => !locked() && page === "game";
  const autoActive = () => auto && !locked() && !challenge &&
    (!s.settings.pauseOutsideGame || page === "game");

  function resetClock() {
    credit = 0;
    last = performance.now();
  }

  const owned = () => sum(keys.map(k => s.levels[k]));
  const stageAt = n => stages.reduce((index, stage, i) => n >= stage[0] ? i : index, 0);
  const price = k => (shop[k][1] + shop[k][2] * s.levels[k]) * stages[stageAt(owned())][1];

  function luckCost(count) {
    let n = owned(), level = s.levels.luck, cost = 0;
    while (count > 0) {
      const i = stageAt(n);
      const next = stages[i + 1]?.[0] ?? Infinity;
      const take = Math.min(count, next - n);
      cost += take * (30 + 20 * level + 10 * (take - 1)) * stages[i][1];
      if (!int(cost)) return Infinity;
      n += take;
      level += take;
      count -= take;
    }
    return cost;
  }

  function maxLuck() {
    let lo = 0, hi = 1;
    while (luckCost(hi) <= s.coins) hi *= 2;
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (luckCost(mid) <= s.coins) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  function buy(k, bulk = false) {
    if (!playable() || challenge || s.levels[k] >= shop[k][3]) return;
    if (k === "speed" && !s.autoOwned) return;
    const count = bulk ? maxLuck() : 1;
    const cost = bulk ? luckCost(count) : price(k);
    if (!count || !int(cost) || cost > s.coins) return;

    s.coins -= cost;
    s.spent += cost;
    s.levels[k] += count;
    if (k === "speed") resetClock();
    changed(true);
    render();
  }

  function make(tag, text, cls) {
    const el = document.createElement(tag);
    if (text !== undefined) el.textContent = text;
    if (cls) el.className = cls;
    return el;
  }
  function rows(el, items) {
    el.replaceChildren(...items.map(([label, value]) => {
      const row = make("div");
      row.append(make("dt", label), make("dd", value));
      return row;
    }));
  }

  const buyViews = {};
  for (const k of keys) {
    const row = make("div", undefined, "shopRow");
    const info = make("div"), desc = make("small");
    const actions = make("div", undefined, "actions");
    const button = make("button");
    info.append(make("strong", shop[k][0]), desc);
    button.onclick = () => buy(k);
    actions.append(button);
    let max = null;
    if (k === "luck") {
      max = make("button", "Max");
      max.setAttribute("aria-label", "Buy maximum affordable Luck");
      max.onclick = () => buy(k, true);
      actions.append(max);
    }
    row.append(info, actions);
    $("shop").append(row);
    buyViews[k] = { desc, button, max };
  }

  const cards = rarities.map((r, i) => {
    const b = make("button");
    b.onclick = () => {
      if (locked()) return;
      selected = selected === i ? null : i;
      renderCollection();
    };
    $("collection").append(b);
    return b;
  });
  $("close").onclick = () => {
    const old = selected;
    selected = null;
    renderCollection();
    if (old !== null) cards[old].focus();
  };

  function renderCollection() {
    $("found").textContent = s.collection.filter(Boolean).length + " / 10";
    cards.forEach((b, i) => {
      const found = s.collection[i] > 0;
      b.textContent = found ? rarities[i][0] : "???";
      b.style.setProperty("--tier", found ? rarities[i][3] : "#a1a8bb");
      b.setAttribute("aria-label", "Tier " + (i + 1) + ": " + b.textContent);
      b.setAttribute("aria-expanded", String(i === selected));
    });
    $("detail").hidden = selected === null;
    if (selected === null) return;
    const i = selected, r = rarities[i], n = s.collection[i];
    const w = weights(), p = w[i] / sum(w);
    $("detailName").textContent = "Tier " + (i + 1) + " · " + (n ? r[0] : "Undiscovered");
    rows($("detailRows"), [
      ["Payout", n ? cash(r[2]) : "???"],
      ["Current odds", percent(p) + " · 1 in " + num(Math.round(1 / p))],
      ["Times found", num(n)],
      ["Total earned", n ? cash(n * r[2]) : "Undiscovered"]
    ]);
  }

  function renderStats() {
    const total = s.manual + s.automatic;
    const best = s.collection.map(Boolean).lastIndexOf(true);
    rows($("numbers"), [
      ["Total rolls", num(total)],
      ["Manual / auto", num(s.manual) + " / " + num(s.automatic)],
      ["Best rarity", best < 0 ? "None yet" : rarities[best][0]],
      ["Lifetime money", cash(s.earned)],
      ["Wallet / spent", cash(s.coins) + " / " + cash(s.spent)],
      ["Average per roll", cash(total ? +(s.earned / total).toFixed(2) : 0)],
      ["Base / current luck", times(baseLuck()) + " / " + times(luck())],
      ["Auto speed", cps() + " rolls/sec"],
      ["Focus attempts", num(s.attempts)],
      ["Focus hits", num(s.focusHits)],
      ["Perfect hits", num(s.perfects)],
      ["Hit / perfect rate", percent(s.attempts ? s.focusHits / s.attempts : 0) +
        " / " + percent(s.attempts ? s.perfects / s.attempts : 0)],
      ["Focus width", (100 * width()).toFixed(1) + "%"]
    ]);
    $("bars").replaceChildren(...rarities.map((r, i) => {
      const n = s.collection[i], p = total ? n / total : 0;
      const box = make("div"), top = make("div", undefined, "barTop");
      const bar = make("div", undefined, "bar"), fill = make("i");
      top.append(make("span", n ? r[0] : "???"), make("small", num(n) + " · " + percent(p)));
      fill.style.width = (100 * p) + "%";
      fill.style.background = r[3];
      bar.append(fill);
      box.append(top, bar);
      return box;
    }));
  }

  function focusButton() {
    const b = $("focus"), left = Math.max(0, cooldown - performance.now());
    b.disabled = !playable() || (!challenge && (s.charges > 0 || left > 0));
    b.textContent = challenge ? "Stop needle" : s.charges ? s.charges + " boosted rolls left" :
      left ? "Ready in " + Math.ceil(left / 1000) + "s" : "Start focus";
  }

  function render() {
    document.documentElement.classList.toggle("still", still());
    $("money").textContent = cash(s.coins);
    $("luck").textContent = times(luck());
    $("boost").textContent = s.charges ? times(s.multiplier) + " · " + s.charges + " left" : "Inactive";
    $("mode").textContent = film ? "Revealing" : auto ? (autoActive() ? "Auto" : "Auto paused") :
      stopped ? "Auto stopped" : "Manual";

    $("roll").disabled = !playable() || auto || !!challenge;
    $("auto").disabled = !playable() || !!challenge || (!s.autoOwned && s.coins < AUTO_COST);
    $("auto").textContent = s.autoOwned ? "Auto: " + (auto ? "On" : "Off") :
      "Unlock auto · " + cash(AUTO_COST);
    $("auto").setAttribute("aria-pressed", String(auto));
    $("autoInfo").textContent = cps() + " rolls/sec · Full payout · No manual cooldown";

    $("focusTerms").textContent = "Hit: 2× luck · Perfect: 3.5× · " + charges() + " boosted rolls";
    $("focusTime").textContent = recovery() / 1000 + "s cooldown";
    focusButton();

    const descriptions = {
      luck: times(baseLuck()) + " base · +0.1×",
      speed: cps() + " rolls/sec · +1",
      focus: (100 * width()).toFixed(1) + "% zone · +0.6 pts",
      reserve: charges() + " rolls/hit · +1",
      recovery: recovery() / 1000 + "s cooldown · −1s"
    };
    for (const k of keys) {
      const { desc, button, max } = buyViews[k];
      const level = s.levels[k], cap = shop[k][3];
      const capped = level >= cap, needs = k === "speed" && !s.autoOwned;
      desc.textContent = "Lv. " + num(level) + (Number.isFinite(cap) ? "/" + cap : "") +
        " · " + descriptions[k];
      button.disabled = !playable() || !!challenge || capped || needs || s.coins < price(k);
      button.textContent = capped ? "Maxed" : needs ? "Unlock auto first" : cash(price(k));
      button.setAttribute("aria-label", shop[k][0] + ": " + button.textContent);
      if (max) {
        const count = maxLuck();
        max.disabled = button.disabled || !count;
        max.textContent = count ? "Max +" + num(count) : "Max";
      }
    }
    if (page === "game") renderCollection();
    if (page === "stats") renderStats();
    for (const k of prefs) $(k).checked = s.settings[k];
    $("threshold").value = String(s.settings.autoStopMinRarity);
  }

  function rollPulse(color, isAuto) {
    const name = $("rarity");
    if (pulse) pulse.cancel();
    pulse = null;
    if (!moving() || page !== "game" || typeof name.animate !== "function") return;

    // Restart even if the new roll is the same rarity as the previous roll.
    pulse = name.animate([
      {
        transform: isAuto ? "translateY(1px)" : "translateY(3px) scale(.98)",
        textShadow: `0 0 ${isAuto ? 6 : 12}px ${color}88`
      },
      { transform: "translateY(0) scale(1)", textShadow: `0 0 0px ${color}00` }
    ], {
      duration: isAuto ? Math.min(160, 900 / cps()) : 300,
      easing: "ease-out"
    });
  }

  function startFilm(i, stop) {
    const r = rarities[i], animate = moving(), d = $("cinema");
    film = { remaining: animate ? 2200 : 850, stop };
    resetClock();
    $("filmTier").textContent = "Tier " + (i + 1) + " of 10";
    $("filmName").textContent = r[0];
    $("filmReward").textContent = "+" + cash(r[2]) +
      (stop ? " · Auto-stop threshold reached" : auto ? " · Auto resumes after reveal" : "");
    d.style.setProperty("--tone", r[3]);
    d.classList.toggle("moving", animate);

    if (typeof d.showModal === "function") d.showModal();
    else {
      d.classList.add("fallback");
      d.setAttribute("open", "");
    }
  }

  function endFilm() {
    const d = $("cinema");
    if (film.stop) {
      auto = false;
      stopped = true;
    }
    if (typeof d.close === "function") d.close();
    else d.removeAttribute("open");
    d.classList.remove("fallback", "moving");
    film = null;
    resetClock();
    render();
  }
  $("cinema").addEventListener("cancel", e => e.preventDefault());

  function roll(isAuto = false) {
    if (locked() || challenge || (isAuto ? !autoActive() : auto || page !== "game")) return;

    const w = weights();
    let pick = random() * sum(w), i = 0;
    while (i < w.length - 1 && (pick -= w[i]) >= 0) i++;

    const r = rarities[i], reward = r[2];
    if (s.earned > LIMIT - reward) {
      auto = false;
      resetClock();
      notice("Numeric limit reached; no further reward can be recorded.");
      return;
    }

    const boosted = s.charges > 0;
    s[isAuto ? "automatic" : "manual"]++;
    s.collection[i]++;
    s.coins += reward;
    s.earned += reward;
    if (boosted && --s.charges === 0) s.multiplier = 1;

    const threshold = s.settings.autoStopMinRarity;
    const stop = isAuto && threshold > 0 && i >= threshold;
    stopped = false;
    $("rarity").textContent = r[0];
    $("rarity").style.color = r[3];
    $("card").style.setProperty("--drop-tone", r[3]);
    $("reward").textContent = "+" + cash(reward) + (boosted ? " · Focus boosted" : "");
    $("dropLabel").textContent = stop ? "Auto-stop drop" : "Your drop";

    if (i >= CINEMATIC_MIN) startFilm(i, stop);
    else {
      rollPulse(r[3], isAuto);
      if (stop) {
        auto = false;
        stopped = true;
        resetClock();
      }
    }
    changed(stop || !!film);
  }

  $("roll").onclick = () => { roll(); render(); };
  $("auto").onclick = () => {
    if (!playable() || challenge) return;
    if (!s.autoOwned) {
      if (s.coins < AUTO_COST) return;
      s.coins -= AUTO_COST;
      s.spent += AUTO_COST;
      s.autoOwned = true;
    }
    auto = !auto;
    stopped = false;
    resetClock();
    changed(true);
    render();
  };

  function position(c, now) {
    const p = Math.min(1, Math.max(0, (now - c.start) / c.duration));
    return c.reverse ? 1 - p : p;
  }

  function startFocus() {
    const now = performance.now();
    if (!playable() || challenge || s.charges || now < cooldown || s.attempts >= LIMIT) return;
    const c = challenge = {
      start: now, duration: 1000 + random() * 260,
      center: .25 + random() * .5, width: width(), reverse: random() < .5
    };
    lastNeedle = now;
    s.attempts++;
    cooldown = now + recovery();
    s.focusReady = Date.now() + recovery();

    for (const [id, factor] of [["zone", 1], ["perfect", .2]]) {
      $(id).style.left = 100 * (c.center - c.width * factor / 2) + "%";
      $(id).style.width = 100 * c.width * factor + "%";
    }
    $("needle").style.left = 100 * position(c, now) + "%";
    $("focusMsg").textContent = "Stop inside the green zone.";
    resetClock();
    changed(true);
    render();
  }

  function finishFocus(forceMiss = false) {
    if (!challenge) return;
    const c = challenge, now = performance.now();
    const p = position(c, now), distance = Math.abs(p - c.center);
    const hit = !forceMiss && now - lastNeedle <= 250 &&
      now - c.start < c.duration && distance <= c.width / 2;
    challenge = null;
    $("needle").style.left = 100 * p + "%";
    if (hit) {
      const perfect = distance <= c.width * .1;
      s.focusHits++;
      if (perfect) s.perfects++;
      s.multiplier = perfect ? 3.5 : 2;
      s.charges = charges();
      $("focusMsg").textContent = (perfect ? "Perfect! " : "Hit! ") +
        times(s.multiplier) + " luck for " + s.charges + " rolls.";
    } else {
      $("focusMsg").textContent = "Miss. No charges spent.";
    }
    resetClock();
    changed(true);
    render();
  }

  $("focus").onclick = () => {
    if (!playable()) return;
    if (challenge) finishFocus();
    else startFocus();
  };
  document.addEventListener("keydown", e => {
    if (e.code !== "Space" || !playable()) return;
    if (e.target.closest?.("button,input,select,textarea,a,[contenteditable]")) return;
    e.preventDefault();
    if (e.repeat) return;
    if (challenge) finishFocus();
    else { roll(); render(); }
  });

  tabs.forEach((b, index) => {
    b.onclick = () => {
      if (locked()) return;
      if (challenge && b.dataset.page !== "game") finishFocus(true);
      const wasActive = autoActive();
      page = b.dataset.page;

      for (const el of document.querySelectorAll(".page")) el.hidden = el.id !== page;
      for (const tab of tabs) tab.removeAttribute("aria-current");
      b.setAttribute("aria-current", "page");

      const nav = b.parentElement;
      nav.style.setProperty("--tab-offset", (index * 100) + "%");
      if (nav.scrollWidth > nav.clientWidth) {
        nav.scrollTo({
          left: b.offsetLeft + b.offsetWidth / 2 - nav.clientWidth / 2,
          behavior: still() ? "auto" : "smooth"
        });
      }
      if (wasActive !== autoActive()) resetClock();
      render();
      $(page).focus({ preventScroll: true });
    };
  });

  rarities.forEach((r, i) => {
    const text = i ? r[0] + (i === rarities.length - 1 ? "" : "+") : "Off";
    $("threshold").add(new Option(text, String(i)));
  });
  $("threshold").onchange = () => {
    if (locked()) return;
    s.settings.autoStopMinRarity = Number($("threshold").value);
    changed(true);
    render();
  };
  for (const k of prefs) {
    $(k).onchange = () => {
      if (locked()) return;
      s.settings[k] = $(k).checked;
      if (k === "pauseOutsideGame") resetClock();
      if (!moving() && pulse) pulse.cancel();
      changed(true);
      render();
    };
  }

  $("reset").onclick = () => {
    if (locked()) return;
    if (s.settings.confirmReset && !confirm("Reset 0.4 progress? Your original 0.35 save is not changed.")) return;

    const settings = { ...s.settings };
    s = fresh();
    s.settings = settings;
    auto = false;
    stopped = false;
    challenge = null;
    selected = null;
    cooldown = 0;
    resetClock();
    if (pulse) pulse.cancel();

    $("card").style.removeProperty("--drop-tone");
    $("rarity").textContent = "Ready?";
    $("rarity").style.color = "";
    $("dropLabel").textContent = "Your drop";
    $("reward").textContent = "Roll to discover your first rarity.";
    $("focusMsg").textContent = focusHelp;
    $("zone").style.width = $("perfect").style.width = $("needle").style.left = "0%";
    changed(true);
    render();
  };

  document.addEventListener("visibilitychange", () => {
    resetClock();
    if (document.hidden) {
      if (challenge) finishFocus(true);
      flush();
    }
    render();
  });
  window.addEventListener("pagehide", () => {
    if (challenge) finishFocus(true);
    resetClock();
    flush();
  });
  window.addEventListener("pageshow", resetClock);

  function frame(now) {
    const elapsed = Math.max(0, now - last);
    last = now;

    if (!document.hidden) {
      if (film) {
        credit = 0;
        film.remaining -= elapsed;
        if (film.remaining <= 0) endFilm();
      } else if (challenge) {
        if (now - lastNeedle > 250 || now - challenge.start >= challenge.duration) {
          finishFocus(true);
        } else {
          $("needle").style.left = 100 * position(challenge, now) + "%";
          lastNeedle = now;
        }
      } else if (autoActive()) {
        // Fractional roll credit is independent of touches and animation duration.
        // Ignore long stalls rather than paying out a burst of background rolls.
        credit += Math.min(elapsed, 250) * cps() / 1000;
        let rolled = false;
        while (credit >= 1 && autoActive()) {
          credit -= 1;
          roll(true);
          rolled = true;
        }
        if (rolled) render();
      } else {
        credit = 0;
      }

      if (now - paint >= 100) {
        focusButton();
        paint = now;
      }
    }
    requestAnimationFrame(frame);
  }

  render();
  flush();
  requestAnimationFrame(frame);
})();
