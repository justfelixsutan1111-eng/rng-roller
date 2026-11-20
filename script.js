"use strict";
(() => {
  const $ = id => document.getElementById(id);
  const KEY = "rng-roller-040", OLD = "rng-roller-035";
  const LIMIT = Number.MAX_SAFE_INTEGER, AUTO_COST = 350, CINEMATIC_MIN = 4;
  const rarities = [
    ["Common",680000,3,"#c4cede"], ["Uncommon",210000,6,"#78e8be"],
    ["Rare",75000,15,"#7bbdff"], ["Epic",24000,45,"#be9cff"],
    ["Legendary",7500,140,"#ffd48a"], ["Mythic",2400,450,"#ff98c8"],
    ["Exotic",750,1200,"#ff6b8b"], ["Divine",240,3500,"#7af0ff"],
    ["Celestial",90,10000,"#a38bff"], ["Transcendent",20,35000,"#fff099"]
  ];
  const stages = [
    [0,"Fast",1], [5,"Mid-fast",2], [14,"Balanced",4],
    [28,"Mid-slow",8], [48,"Slow",18]
  ];
  // Name, base price, per-level price step, level cap.
  const shop = {
    luck:["Luck",30,20,Infinity], speed:["Auto Speed",80,95,10],
    focus:["Focus Width",50,50,5], reserve:["Focus Reserve",70,70,5],
    recovery:["Focus Recovery",65,65,6]
  };
  const keys = Object.keys(shop);
  const prefs = ["rollAnimation","reducedMotion","confirmReset","pauseOutsideGame"];
  const int = v => Number.isSafeInteger(v) && v >= 0;
  const num = n => n.toLocaleString();
  const cash = n => "$" + num(n);
  const times = n => Number(n.toFixed(2)) + "×";
  const sum = ns => ns.reduce((a,b) => a+b,0);
  const percent = p => (p*100).toFixed(p < .001 ? 4 : 2) + "%";
  const rngBuffer = new Uint32Array(1);
  const random = () => crypto.getRandomValues(rngBuffer)[0] / 4294967296;

  function fresh(){
    return {version:6,coins:0,earned:0,spent:0,manual:0,automatic:0,attempts:0,
      focusHits:0,perfects:0,charges:0,multiplier:1,focusReady:0,autoOwned:false,
      settings:{rollAnimation:true,reducedMotion:false,confirmReset:true,
        pauseOutsideGame:false,autoStopMinRarity:5},
      levels:{luck:0,speed:0,focus:0,reserve:0,recovery:0},collection:Array(10).fill(0)};
  }
  function valid(s,legacy=false){
    if(!s || s.version!==(legacy?5:6) || !s.levels || !s.settings) return false;
    if(!["coins","earned","manual","automatic","attempts","focusHits","perfects","charges","focusReady"]
      .every(k=>int(s[k]))) return false;
    if(typeof s.autoOwned!=="boolean" || !prefs.every(k=>typeof s.settings[k]==="boolean")) return false;
    const stop=s.settings.autoStopMinRarity;
    if(!int(stop)||stop>=rarities.length) return false;
    if(!(legacy?keys.slice(0,3):keys).every(k=>int(s.levels[k]) && s.levels[k]<=shop[k][3])) return false;
    if(s.levels.luck>1e8 || (!s.autoOwned && s.levels.speed)) return false;
    if(!Array.isArray(s.collection)||s.collection.length!==10||!s.collection.every(int)) return false;
    if(!int(s.manual+s.automatic)||sum(s.collection)!==s.manual+s.automatic) return false;
    if(sum(s.collection.map((n,i)=>n*rarities[i][2]))!==s.earned) return false;
    if(s.focusHits>s.attempts||s.perfects>s.focusHits||s.charges>5+(legacy?0:s.levels.reserve)) return false;
    if(s.charges ? ![2,3.5].includes(s.multiplier) : s.multiplier!==1) return false;
    let spent=s.spent;
    if(legacy){
      const {luck,speed,focus}=s.levels;
      spent=30*luck*(luck+3)+(s.autoOwned?1000:0)+150*(2**focus-1);
      for(let i=0;i<speed;i++) spent+=Math.ceil(150*1.7**i);
    }
    return int(spent) && s.earned-spent===s.coins;
  }

  let dirty=false, timer=0, writable=true;
  const notice = t => { $("notice").textContent=t; };
  function load(){
    try{
      const raw=localStorage.getItem(KEY);
      if(raw!==null){
        const s=JSON.parse(raw);
        if(!valid(s)) throw Error("invalid");
        return s;
      }
      const old=localStorage.getItem(OLD);
      if(old!==null){
        const s=JSON.parse(old);
        if(!valid(s,true)) throw Error("invalid");
        s.version=6; s.spent=s.earned-s.coins;
        s.levels.reserve=0; s.levels.recovery=0;
        dirty=true;
        notice("Imported your 0.35 progress. Your original save is unchanged.");
        return s;
      }
    }catch{
      writable=false;
      notice("Could not read a valid save. Playing in memory only; existing data has not been replaced.");
    }
    return fresh();
  }
  let s=load();
  function flush(){
    clearTimeout(timer); timer=0;
    if(!dirty||!writable) return;
    try{localStorage.setItem(KEY,JSON.stringify(s));dirty=false;}
    catch{notice("Browser storage is unavailable. Keep this tab open to retain this session.");}
  }
  function changed(now=false){
    dirty=true;
    if(now) flush(); else if(!timer && writable) timer=setTimeout(flush,180);
  }

  let page="game",auto=false,stopped=false,selected=null,challenge=null,film=null;
  let credit=0,last=performance.now(),paint=0,lastNeedle=last;
  let cooldown=last+Math.min(12000,Math.max(0,s.focusReady-Date.now()));
  const owned=()=>sum(keys.map(k=>s.levels[k]));
  const stageAt=n=>stages.reduce((ix,x,i)=>n>=x[0]?i:ix,0);
  const cps=()=>2+s.levels.speed;
  const width=()=>.085+.006*s.levels.focus;
  const charges=()=>5+s.levels.reserve;
  const recovery=()=>12000-1000*s.levels.recovery;
  const baseLuck=()=>1+.1*s.levels.luck;
  const luck=()=>baseLuck()*s.multiplier;
  const weights=()=>rarities.map((r,i)=>r[1]*(i?luck():1));
  const moving=()=>s.settings.rollAnimation && !s.settings.reducedMotion &&
    !matchMedia("(prefers-reduced-motion: reduce)").matches;
  const price=k=>(shop[k][1]+shop[k][2]*s.levels[k])*stages[stageAt(owned())][2];

  // Split bulk purchases at stage boundaries so Max matches single purchases.
  function luckCost(count){
    let n=owned(),level=s.levels.luck,cost=0;
    while(count>0){
      const i=stageAt(n), next=stages[i+1]?.[0]??Infinity;
      const take=Math.min(count,next-n);
      cost+=take*(30+20*level+10*(take-1))*stages[i][2];
      if(!int(cost)) return Infinity;
      n+=take;level+=take;count-=take;
    }
    return cost;
  }
  function maxLuck(){
    let lo=0,hi=1;
    while(luckCost(hi)<=s.coins) hi*=2;
    while(hi-lo>1){
      const mid=Math.floor((lo+hi)/2);
      if(luckCost(mid)<=s.coins) lo=mid; else hi=mid;
    }
    return lo;
  }
  const locked=()=>document.hidden||!!film;
  const playable=()=>!locked() && page==="game";
  const autoActive=()=>auto&&!locked()&&!challenge&&(!s.settings.pauseOutsideGame||page==="game");
  function resetClock(){credit=0;last=performance.now();}
  function buy(k,bulk=false){
    if(!playable()||challenge||s.levels[k]>=shop[k][3]||(k==="speed"&&!s.autoOwned)) return;
    const count=bulk?maxLuck():1,cost=bulk?luckCost(count):price(k);
    if(!count||!int(cost)||cost>s.coins) return;
    s.coins-=cost;s.spent+=cost;s.levels[k]+=count;
    if(k==="speed") resetClock();
    changed(true);render();
  }

  function make(tag,text,cls){
    const e=document.createElement(tag);
    if(text!==undefined)e.textContent=text;
    if(cls)e.className=cls;
    return e;
  }
  function rows(el,items){
    el.replaceChildren(...items.map(([k,v])=>{
      const row=make("div");row.append(make("dt",k),make("dd",v));return row;
    }));
  }
  const buyViews={};
  for(const k of keys){
    const row=make("div",undefined,"shopRow"),info=make("div"),desc=make("small");
    const actions=make("div",undefined,"actions"),button=make("button");
    info.append(make("strong",shop[k][0]),desc);
    button.onclick=()=>buy(k);actions.append(button);
    let max=null;
    if(k==="luck"){max=make("button","Max");max.onclick=()=>buy(k,true);actions.append(max);}
    row.append(info,actions);$("shop").append(row);
    buyViews[k]={desc,button,max};
  }
  const cards=rarities.map((r,i)=>{
    const b=make("button");b.onclick=()=>{selected=selected===i?null:i;renderCollection();};
    $("collection").append(b);return b;
  });
  $("close").onclick=()=>{
    const old=selected;selected=null;renderCollection();if(old!==null)cards[old].focus();
  };

  function renderCollection(){
    $("found").textContent=s.collection.filter(Boolean).length+" / 10";
    cards.forEach((b,i)=>{
      b.textContent=s.collection[i]?rarities[i][0]:"???";
      b.style.setProperty("--tier",s.collection[i]?rarities[i][3]:"#a1a8bb");
      b.setAttribute("aria-label","Tier "+(i+1)+": "+b.textContent);
      b.setAttribute("aria-expanded",String(i===selected));
    });
    $("detail").hidden=selected===null;
    if(selected===null)return;
    const i=selected,r=rarities[i],n=s.collection[i],w=weights(),p=w[i]/sum(w);
    $("detailName").textContent="Tier "+(i+1)+" · "+(n?r[0]:"Undiscovered");
    rows($("detailRows"),[
      ["Payout",n?cash(r[2]):"???"],["Current odds",percent(p)+" · 1 in "+num(Math.round(1/p))],
      ["Times found",num(n)],["Total earned",n?cash(n*r[2]):"Undiscovered"]
    ]);
  }
  function renderStats(){
    const total=s.manual+s.automatic,best=s.collection.map(Boolean).lastIndexOf(true);
    rows($("numbers"),[
      ["Total rolls",num(total)],["Manual / auto",num(s.manual)+" / "+num(s.automatic)],
      ["Best rarity",best<0?"None yet":rarities[best][0]],["Lifetime money",cash(s.earned)],
      ["Wallet / spent",cash(s.coins)+" / "+cash(s.spent)],
      ["Average per roll",cash(total?+(s.earned/total).toFixed(2):0)],
      ["Base / current luck",times(baseLuck())+" / "+times(luck())],["Auto speed",cps()+" rolls/sec"],
      ["Focus attempts",num(s.attempts)],["Focus hits",num(s.focusHits)],["Perfect hits",num(s.perfects)],
      ["Hit / perfect rate",percent(s.attempts?s.focusHits/s.attempts:0)+" / "+
        percent(s.attempts?s.perfects/s.attempts:0)],
      ["Focus width",(width()*100).toFixed(1)+"%"]
    ]);
    $("bars").replaceChildren(...rarities.map((r,i)=>{
      const n=s.collection[i],p=total?n/total:0;
      const box=make("div"),top=make("div",undefined,"barTop");
      const bar=make("div",undefined,"bar"),fill=make("i");
      top.append(make("span",n?r[0]:"???"),make("small",num(n)+" · "+percent(p)));
      fill.style.width=p*100+"%";fill.style.background=r[3];bar.append(fill);box.append(top,bar);return box;
    }));
  }

  function focusButton(){
    const left=Math.max(0,cooldown-performance.now()),b=$("focus");
    b.disabled=!playable()||(!challenge&&(s.charges>0||left>0));
    b.textContent=challenge?"Stop needle":s.charges?s.charges+" boosted rolls left":left?
      "Ready in "+Math.ceil(left/1000)+"s":"Start focus";
  }
  function render(){
    $("money").textContent=cash(s.coins);$("luck").textContent=times(luck());
    $("boost").textContent=s.charges?times(s.multiplier)+" · "+s.charges+" left":"Inactive";
    $("mode").textContent=film?"Revealing":auto?(autoActive()?"Auto":"Auto paused"):stopped?"Auto stopped":"Manual";
    $("roll").disabled=!playable()||auto||!!challenge;
    $("auto").disabled=!playable()||!!challenge||(!s.autoOwned&&s.coins<AUTO_COST);
    $("auto").textContent=s.autoOwned?"Auto: "+(auto?"On":"Off"):"Unlock auto · "+cash(AUTO_COST);
    $("auto").setAttribute("aria-pressed",String(auto));
    $("autoInfo").textContent=cps()+" rolls/sec · Full payout · No manual cooldown";
    $("focusTerms").textContent="Hit: 2× luck · Perfect: 3.5× · "+charges()+" boosted rolls";
    $("focusTime").textContent=recovery()/1000+"s cooldown";focusButton();
    const n=owned(),i=stageAt(n),stage=stages[i],next=stages[i+1];
    $("stage").textContent=(i+1)+"/5 · "+stage[1];
    $("stageBar").value=next?(n-stage[0])/(next[0]-stage[0]):1;
    $("stageInfo").textContent=next?(next[0]-n)+" permanent levels until "+next[1].toLowerCase()+" pricing.":
      "Final price stage · Luck can still be upgraded.";
    const desc={luck:times(baseLuck())+" base · +0.1×",speed:cps()+" rolls/sec · +1",
      focus:(100*width()).toFixed(1)+"% zone · +0.6 pts",reserve:charges()+" rolls/hit · +1",
      recovery:recovery()/1000+"s cooldown · −1s"};
    for(const k of keys){
      const {desc:d,button:b,max}=buyViews[k],cap=shop[k][3],level=s.levels[k];
      d.textContent="Lv. "+num(level)+(isFinite(cap)?"/"+cap:"")+" · "+desc[k];
      const capped=level>=cap,needs=k==="speed"&&!s.autoOwned;
      b.disabled=!playable()||!!challenge||capped||needs||s.coins<price(k);
      b.textContent=capped?"Maxed":needs?"Unlock auto first":cash(price(k));
      b.setAttribute("aria-label",shop[k][0]+": "+b.textContent);
      if(max){const count=maxLuck();max.disabled=b.disabled||!count;max.textContent=count?"Max +"+num(count):"Max";}
    }
    if(page==="game")renderCollection();
    if(page==="stats")renderStats();
    for(const k of prefs)$(k).checked=s.settings[k];
    $("threshold").value=String(s.settings.autoStopMinRarity);
  }

  function startFilm(i,stop){
    const r=rarities[i],animate=moving();
    film={remaining:animate?2200:850,stop};
    resetClock();
    $("filmTier").textContent="Tier "+(i+1)+" of 10";
    $("filmName").textContent=r[0];$("filmReward").textContent="+"+cash(r[2])+
      (stop?" · Auto-stop threshold reached":auto?" · Auto resumes after reveal":"");
    const d=$("cinema");d.style.setProperty("--tone",r[3]);d.classList.toggle("moving",animate);
    d.showModal();
  }
  function endFilm(){
    const stop=film.stop;
    if(stop){auto=false;stopped=true;}
    $("cinema").close();film=null;resetClock();render();
  }
  $("cinema").addEventListener("cancel",e=>e.preventDefault());

  function roll(isAuto=false){
    if(locked()||challenge||(isAuto?!autoActive():auto||page!=="game"))return;
    const w=weights();let pick=random()*sum(w),i=0;
    while(i<w.length-1 && (pick-=w[i])>=0)i++;
    const r=rarities[i],reward=r[2];
    if(s.earned>LIMIT-reward){
      auto=false;resetClock();notice("Numeric limit reached; no further reward can be recorded.");render();return;
    }
    const boosted=s.charges>0;
    s[isAuto?"automatic":"manual"]++;s.collection[i]++;s.coins+=reward;s.earned+=reward;
    if(boosted && --s.charges===0)s.multiplier=1;
    const threshold=s.settings.autoStopMinRarity;
    const stop=isAuto&&threshold>0&&i>=threshold;
    stopped=false;
    $("rarity").textContent=r[0];$("rarity").style.color=r[3];
    $("reward").textContent="+"+cash(reward)+(boosted?" · Focus boosted":"");
    $("dropLabel").textContent=stop?"Auto-stop drop":"Your drop";
    if(i>=CINEMATIC_MIN)startFilm(i,stop);
    else{
      if(stop){auto=false;stopped=true;resetClock();}
      const card = $("card");
const name = $("rarity");
card.style.setProperty("--drop-tone", r[3]);

if (moving() && page === "game" && typeof name.animate === "function") {
  // A new tap replaces the previous animation instead of stacking effects.
  for (const effect of name.getAnimations()) effect.cancel();

  if (isAuto) {
    // Small movement only: at 12 rolls/sec the name must stay readable.
    name.animate(
      [{ transform: "translateY(1.5px)" }, { transform: "translateY(0)" }],
      { duration: Math.min(100, 800 / cps()), easing: "ease-out" }
    );
  } else {
    name.animate(
      [
        { transform: "translateY(7px) scale(.94)", opacity: .72 },
        { transform: "translateY(-1px) scale(1.035)", opacity: 1, offset: .6 },
        { transform: "translateY(0) scale(1)", opacity: 1 }
      ],
      { duration: 330, easing: "cubic-bezier(.2,.75,.25,1)" }
    );

    for (const effect of card.getAnimations()) effect.cancel();
    card.animate(
      [{ borderColor: r[3] }, { borderColor: "#c8e9ff45" }],
      { duration: 460, easing: "ease-out" }
    );
  }
}
    }
    changed(stop||!!film);
  }
  $("roll").onclick=()=>{roll();render();};
  $("auto").onclick=()=>{
    if(!playable()||challenge)return;
    if(!s.autoOwned){
      if(s.coins<AUTO_COST)return;
      s.coins-=AUTO_COST;s.spent+=AUTO_COST;s.autoOwned=true;
    }
    auto=!auto;stopped=false;resetClock();changed(true);render();
  };

  const position=(c,now)=>{
    const p=Math.min(1,Math.max(0,(now-c.start)/c.duration));return c.reverse?1-p:p;
  };
  function startFocus(){
    const now=performance.now();
    if(!playable()||challenge||s.charges||now<cooldown||s.attempts>=LIMIT)return;
    const c=challenge={start:now,duration:1000+random()*260,center:.25+random()*.5,
      width:width(),reverse:random()<.5};
    lastNeedle=now;s.attempts++;cooldown=now+recovery();s.focusReady=Date.now()+recovery();
    for(const [id,factor] of [["zone",1],["perfect",.2]]){
      $(id).style.left=100*(c.center-c.width*factor/2)+"%";
      $(id).style.width=100*c.width*factor+"%";
    }
    $("needle").style.left=position(c,now)*100+"%";
    $("focusMsg").textContent="Stop inside the green zone.";resetClock();changed(true);render();
  }
  function finishFocus(force=false){
    if(!challenge)return;
    const c=challenge,now=performance.now(),p=position(c,now),d=Math.abs(p-c.center);
    const hit=!force&&now-lastNeedle<=250&&now-c.start<c.duration&&d<=c.width/2;
    challenge=null;$("needle").style.left=p*100+"%";
    if(hit){
      const perfect=d<=c.width*.1;s.focusHits++;if(perfect)s.perfects++;
      s.multiplier=perfect?3.5:2;s.charges=charges();
      $("focusMsg").textContent=(perfect?"Perfect! ":"Hit! ")+times(s.multiplier)+" luck for "+s.charges+" rolls.";
    }else $("focusMsg").textContent="Miss. No charges spent.";
    resetClock();changed(true);render();
  }
  $("focus").onclick=()=>{if(playable()){if(challenge)finishFocus();else startFocus();}};
  document.addEventListener("keydown",e=>{
    if(e.code!=="Space"||!playable())return;
    if(e.target.closest?.("button,input,select,textarea,a,[contenteditable]"))return;
    e.preventDefault();if(e.repeat)return;
    if(challenge)finishFocus();else{roll();render();}
  });

  for(const b of document.querySelectorAll("[data-page]")){
    b.onclick=()=>{
      if(locked())return;
      if(challenge&&b.dataset.page!=="game")finishFocus(true);
      const wasActive=autoActive();page=b.dataset.page;
      for(const el of document.querySelectorAll(".page"))el.hidden=el.id!==page;
      for(const nav of document.querySelectorAll("[data-page]"))nav.removeAttribute("aria-current");
      b.setAttribute("aria-current","page");if(wasActive!==autoActive())resetClock();
      render();$(page).focus({preventScroll:true});
    };
  }
  rarities.forEach((r,i)=>$("threshold").add(new Option(i?r[0]+(i===9?"":"+"):"Off",String(i))));
  $("threshold").onchange=()=>{
    if(locked())return;s.settings.autoStopMinRarity=Number($("threshold").value);changed(true);render();
  };
  for(const k of prefs)$(k).onchange=()=>{
    if(locked())return;
    s.settings[k]=$(k).checked;if(k==="pauseOutsideGame")resetClock();changed(true);render();
  };
  $("reset").onclick=()=>{
    if(locked()||(s.settings.confirmReset&&!confirm("Reset 0.4 progress? Your original 0.35 save is not changed.")))return;
    const settings={...s.settings};s=fresh();s.settings=settings;
    auto=false;stopped=false;challenge=null;selected=null;cooldown=0;resetClock();
    $("rarity").textContent="Ready?";$("rarity").style.color="";
    $("dropLabel").textContent="Your drop";$("reward").textContent="Roll to discover your first rarity.";
    $("focusMsg").textContent="Stop the needle in green. Aim for the pale center for a perfect hit.";
    $("zone").style.width=$("perfect").style.width=$("needle").style.left="0%";
    changed(true);render();
  };

  document.addEventListener("visibilitychange",()=>{
    resetClock();
    if(document.hidden){if(challenge)finishFocus(true);flush();}
    render();
  });
  addEventListener("pagehide",()=>{if(challenge)finishFocus(true);resetClock();flush();});
  addEventListener("pageshow",resetClock);
  function frame(now){
    const elapsed=Math.max(0,now-last);last=now;
    if(!document.hidden){
      if(film){
        credit=0;film.remaining-=elapsed;
        if(film.remaining<=0)endFilm();
      }else if(challenge){
        if(now-lastNeedle>250||now-challenge.start>=challenge.duration)finishFocus(true);
        else{$("needle").style.left=position(challenge,now)*100+"%";lastNeedle=now;}
      }else if(autoActive()){
        // Keep fractional credit between frames, but don't bank long stalls.
        credit+=Math.min(elapsed,250)*cps()/1000;
        let rolled=false;
        while(credit>=1 && autoActive()){
          credit-=1;roll(true);rolled=true;
        }
        if(rolled)render();
      }else credit=0;
      if(now-paint>=100){focusButton();paint=now;}
    }
    requestAnimationFrame(frame);
  }
  render();flush();requestAnimationFrame(frame);
})();
