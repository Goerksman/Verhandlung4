/* ========================================================================== */
/* Konfiguration via URL                                                     */
/* ========================================================================== */
const Q = new URLSearchParams(location.search);

const CONFIG = {
  INITIAL_OFFER: Q.has("i") ? Number(Q.get("i")) : 5518,  // Startangebot 5518

  // optional direkt setzen (?min=3500). Wenn nicht gesetzt, wird per Faktor berechnet.
  MIN_PRICE: Q.has("min") ? Number(Q.get("min")) : undefined,
  MIN_PRICE_FACTOR: Number(Q.get("mf")) || 0.70,

  // Zufällige Rundenzahl 8–12 (optional über rmin/rmax konfigurierbar)
  ROUNDS_MIN: parseInt(Q.get("rmin") || "8", 10),
  ROUNDS_MAX: parseInt(Q.get("rmax") || "12", 10),

  THINK_DELAY_MS_MIN: parseInt(Q.get("tmin") || "1200", 10),
  THINK_DELAY_MS_MAX: parseInt(Q.get("tmax") || "2800", 10)
};

// Mindestpreis finalisieren (Fallback über Faktor)
CONFIG.MIN_PRICE = Number.isFinite(CONFIG.MIN_PRICE)
  ? CONFIG.MIN_PRICE
  : Math.round(CONFIG.INITIAL_OFFER * CONFIG.MIN_PRICE_FACTOR);


/* ============================================================
   HILFSFUNKTIONEN (alle Beträge → ganze Euro)
============================================================ */

const roundEuro = n => Math.round(Number(n));
const randInt   = (min, max) =>
  Math.floor(Math.random() * (max - min + 1)) + min;

const eur = n =>
  new Intl.NumberFormat("de-DE", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0
  }).format(roundEuro(n));

const app = document.getElementById("app");


/* ============================================================
   DIMENSIONSSYSTEM – reelle Faktoren 1–5 (zufällig)
============================================================ */

// frühere Liste wird nicht mehr benutzt, bleibt nur als Referenz stehen
const DIM_FACTORS = [1, 2, 3, 4, 5];
let DIM_QUEUE = [];

// Multiplikator jetzt: echte Zufallszahl zwischen 1 und 5
function nextDimension() {
  return 1 + Math.random() * 4; // [1, 5)
}


/* ============================================================
   SPIELZUSTAND
============================================================ */

function newState() {
  const f = nextDimension();

  // Basiswerte mit Multiplikator f, auf ganze Euro gerundet
  const baseStart = roundEuro(CONFIG.INITIAL_OFFER * f);
  const baseMin   = roundEuro(CONFIG.MIN_PRICE * f);

  return {
    participant_id: crypto.randomUUID?.() || "v_" + Date.now(),

    runde: 1,
    max_runden: randInt(CONFIG.ROUNDS_MIN, CONFIG.ROUNDS_MAX),

    scale: f,

    initial_offer: baseStart,
    current_offer: baseStart,
    min_price: baseMin,

    history: [],
    accepted: false,
    finished: false,

    patternMessage: "",
    last_abort_chance: null,  // für Anzeige (nur Gesamtwert)
    warningRounds: 0          // wie viele Runden in Folge "kleine Schritte" erkannt werden
  };
}

let state = newState();


/* ============================================================
   AUTO-ACCEPT LOGIK
============================================================ */

function shouldAccept(userOffer) {
  const buyer  = roundEuro(userOffer);
  const seller = state.current_offer;
  const f      = state.scale;

  // 1) Käufer-Angebot ≥ aktuelles Verkäuferangebot
  if (buyer >= seller) return true;

  // 2) Käufer liegt innerhalb von 5 % am Verkäuferangebot
  if (Math.abs(seller - buyer) / seller <= 0.05) return true;

  // 3) Absolute Schwelle (mit Dimension skaliert)
  if (buyer >= roundEuro(5000 * f)) return true;

  // 4) Letzte Runde (oder vorletzte) und Käufer ist mindestens bei min_price
  if (state.max_runden - state.runde <= 1 && buyer >= state.min_price)
    return true;

  return false;
}

// Wrapper für bestehende Signatur
function shouldAutoAccept(_initialOffer, _minPrice, _prevOffer, counter) {
  return shouldAccept(counter);
}


/* ============================================================
   VERKÄUFER-UPDATE
   Runde 1:  -500 * f
   Runde 2:  -250 * f
   Ab Runde 3: prozentuale Schritte in Richtung min_price,
               so dass in der letzten Runde min_price erreicht wird.
   ignoreUserAccept = true → nur Schritt simulieren, kein Auto-Accept
============================================================ */

function computeNextOffer(userOffer, ignoreUserAccept = false) {
  if (!ignoreUserAccept && shouldAccept(userOffer))
    return roundEuro(userOffer);

  const f    = state.scale;
  const r    = state.runde;
  const min  = state.min_price;
  const curr = state.current_offer;

  let next;

  if (r === 1) {
    // 1. Runde: fester Schritt 500 * f
    next = curr - roundEuro(500 * f);
  } else if (r === 2) {
    // 2. Runde: fester Schritt 250 * f
    next = curr - roundEuro(250 * f);
  } else if (r >= state.max_runden) {
    // Letzte Angebotsrunde: direkt an die Schmerzgrenze
    next = min;
  } else {
    // Ab Runde 3 bis kurz vor der letzten Runde:
    // proportionaler Schritt vom aktuellen Angebot hin zur Schmerzgrenze.
    const remainingSteps = state.max_runden - r + 1;
    const gap            = curr - min;
    const stepDown       = gap / remainingSteps;
    next = curr - stepDown;
  }

  if (next < min) next = min;

  return roundEuro(next);
}


/* ============================================================
   PATTERNERKENNUNG (keine / kleine Schritte pro Runde)
   - relevant ab Angeboten ≥ 2250 * Multiplikator
   - "kleiner Schritt": diff >= 0 und diff ≤ 100 * Multiplikator
   - sobald diese Bedingung erfüllt ist:
       * warningRounds++ (solange sie in Folge weiter erfüllt wird)
       * patternMessage gesetzt
   - bei größerem Schritt oder Rückschritt → reset
============================================================ */

function updatePatternMessage(currentBuyerOffer) {
  const f           = state.scale;
  const minRelevant = roundEuro(2250 * f);
  const SMALL       = roundEuro(100 * f);
  const buyer       = roundEuro(currentBuyerOffer);

  const last = state.history[state.history.length - 1];

  if (!last || last.proband_counter == null) {
    state.warningRounds = 0;
    state.patternMessage = "";
    return;
  }

  const lastBuyer = roundEuro(last.proband_counter);

  // nur wenn beide Angebote im relevanten Bereich liegen
  if (buyer < minRelevant || lastBuyer < minRelevant) {
    state.warningRounds = 0;
    state.patternMessage = "";
    return;
  }

  const diff = buyer - lastBuyer;

  // keine Veränderung oder kleine Erhöhung (≤ 100 * Multiplikator)
  if (diff >= 0 && diff <= SMALL) {
    state.warningRounds = (state.warningRounds || 0) + 1;
    state.patternMessage =
      "Mit derart kleinen Erhöhungen kommen wir eher unwahrscheinlich zu einer Einigung.";
  } else {
    // Muster bricht ab
    state.warningRounds = 0;
    state.patternMessage = "";
  }
}


/* ============================================================
   RISIKO-SYSTEM
   - Differenzmodell mit Referenz 3000·Multiplikator → 25 %
   - Bei Angeboten < 1500·Multiplikator → Basisrisiko 100 %
   - Zusätzlich +2 %-Punkte pro Warnrunde (warningRounds * 2)
   - Abbruch erst ab Runde 3 (vorher nur Anzeige)
============================================================ */

function abortProbabilityFromLastDifference(sellerOffer, buyerOffer) {
  const f = state.scale || 1.0;

  const diff = Math.abs(
    roundEuro(sellerOffer) - roundEuro(buyerOffer)
  );

  // Referenz: 3000 € * Multiplikator → 25 %
  const BASE_DIFF = 3000 * f;

  let chance = (diff / BASE_DIFF) * 25;  // vorher 30

  if (chance < 0)   chance = 0;
  if (chance > 100) chance = 100;

  return Math.round(chance);
}

function maybeAbort(userOffer) {
  const f      = state.scale;
  const seller = state.current_offer;
  const buyer  = roundEuro(userOffer);

  // Basis-Risiko aus Differenz
  let chance = abortProbabilityFromLastDifference(seller, buyer);

  // Extrem-Lowball: unter 1500 * Multiplikator → Basisrisiko 100 %
  if (buyer < roundEuro(1500 * f)) {
    chance = 100;
  }

  // Zusatz 2 % pro Warnrunde, solange Warnung aktiv ist
  if (state.warningRounds > 0) {
    chance = Math.min(100, chance + 2 * state.warningRounds);
  }

  // Gesamt-Abbruchwahrscheinlichkeit für die Anzeige
  state.last_abort_chance = chance;

  // Vor Runde 3: niemals abbrechen, nur die Wahrscheinlichkeit anzeigen
  if (state.runde < 3) {
    return false;
  }

  const roll = randInt(1, 100);

  if (roll <= chance) {
    logRound({
      runde: state.runde,
      algo_offer: seller,
      proband_counter: buyer,
      accepted: false,
      finished: true,
      proband_exit: "",
      algo_exit: "yes",
      deal_price: ""
    });

    state.history.push({
      runde: state.runde,
      algo_offer: seller,
      proband_counter: buyer,
      accepted: false
    });

    state.finished = true;
    state.accepted = false;

    viewAbort(chance);
    return true;
  }

  return false;
}


/* ============================================================
   LOGGING
============================================================ */

function logRound(row) {
  if (window.sendRow) {
    window.sendRow({
      participant_id: state.participant_id,
      player_id: window.playerId,
      proband_code: window.probandCode,
      scale_factor: state.scale,
      ...row
    });
  }
}


/* ============================================================
   HISTORY
============================================================ */

function historyTable(){
  if (!state.history.length) return "";
  const rows = state.history
    .map(h => `
      <tr>
        <td>${h.runde}</td>
        <td>${eur(h.algo_offer)}</td>
        <td>${h.proband_counter != null && h.proband_counter !== "" ? eur(h.proband_counter) : "-"}</td>
        <td>${h.accepted ? "Ja" : "Nein"}</td>
      </tr>
    `)
    .join("");

  return `
    <h2>Verlauf</h2>
    <table>
      <thead>
        <tr><th>Runde</th><th>Angebot Verkäufer</th><th>Gegenangebot</th><th>Angenommen?</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}


/* ============================================================
   SCREENS
============================================================ */

function viewVignette(){
  app.innerHTML = `
    <h1>Designer-Verkaufsmesse</h1>
    <p class="muted">Stelle dir folgende Situation vor:</p>
    <p>
      Ein Verkäufer bietet eine <b>hochwertige Designer-Ledercouch</b> auf einer Möbelmesse an.
      Solche Möbel werden üblicherweise im <b>gehobenen Preissegment €</b> gehandelt, da sie aus wertvollem 
      Material bestehen und in der Regel Einzelstücke sind. Den Rahmen des Preises siehst du in der Verhandlung. 
    </p>
    <p>
      Du verhandelst mit dem Verkäufer über den endgültigen Verkaufspreis. 
    </p>
    <p class="muted"> 
      <b>Hinweis:</b> Die Verhandlung dauert zufällig ${CONFIG.ROUNDS_MIN}–${CONFIG.ROUNDS_MAX} Runden.
      Dein Verhalten beeinflusst das <b>Abbruchrisiko</b>: unangemessen niedrige oder kaum veränderte
      Angebote können zu einem vorzeitigen Abbruch führen.
    </p>
    <div class="grid">
      <label class="consent">
        <input id="consent" type="checkbox" />
        <span>Ich stimme zu, dass meine Eingaben anonym gespeichert werden.</span>
      </label>
      <div><button id="startBtn" disabled>Verhandlung starten</button></div>
    </div>`;

  document.getElementById("consent").onchange =
    () => document.getElementById("startBtn").disabled =
      !document.getElementById("consent").checked;

  document.getElementById("startBtn").onclick = () => {
    state = newState();
    viewNegotiate();
  };
}

function viewThink(next){
  const delay = randInt(CONFIG.THINK_DELAY_MS_MIN, CONFIG.THINK_DELAY_MS_MAX);
  app.innerHTML = `
    <h1>Die Verkäuferseite überlegt<span class="pulse">…</span></h1>
    <p class="muted">Bitte warten.</p>
  `;
  setTimeout(next, delay);
}

function viewAbort(chance){
  app.innerHTML = `
    <h1>Verhandlung abgebrochen</h1>
    <p class="muted">Teilnehmer-ID: ${state.participant_id}</p>

    <div class="card" style="padding:16px;border:1px dashed var(--accent);">
      <strong>Die Verkäuferseite hat die Verhandlung beendet, da er mit Ihrem Gegenangebot nicht zufrieden war.</strong>
      <p class="muted">Abbruchwahrscheinlichkeit in dieser Runde: ${chance}%</p>
    </div>

    <p><b>Du kannst nun entweder eine neue Runde spielen oder die Umfrage beantworten.</b></p>

    <button id="restartBtn">Neue Verhandlung</button>
    <button id="surveyBtn"
      style="
        margin-top:8px;
        display:inline-block;
        padding:8px 14px;
        border-radius:9999px;
        border:1px solid #d1d5db;
        background:#e5e7eb;
        color:#374151;
        font-size:0.95rem;
        cursor:pointer;
      ">
      Zur Umfrage
    </button>

    ${historyTable()}
  `;

  document.getElementById("restartBtn").onclick = () => {
    state = newState();
    viewVignette();
  };

  const surveyBtn = document.getElementById("surveyBtn");
  if (surveyBtn) {
    surveyBtn.onclick = () => {
      window.location.href =
        "https://docs.google.com/forms/d/e/1FAIpQLSd2WAprvECsFLzU_erdGxM0bpaVk_bhm2fzxKgysXlafd8P6A/viewform?usp=publish-editor";
    };
  }
}

/* NEU: Abbruch durch Proband */
function viewProbandExit(){
  app.innerHTML = `
    <h1>Verhandlung abgebrochen</h1>
    <p class="muted">Teilnehmer-ID: ${state.participant_id}</p>

    <div class="card" style="padding:16px;border:1px dashed var(--accent);">
      <strong>Du hast die Verhandlung abgebrochen.</strong>
      <p class="muted" style="margin-top:8px;">Es kam zu keiner Einigung.</p>
    </div>

    <p><b>Du kannst nun entweder eine neue Runde spielen oder die Umfrage beantworten.</b></p>

    <button id="restartBtn">Neue Verhandlung</button>
    <button id="surveyBtn"
      style="
        margin-top:8px;
        display:inline-block;
        padding:8px 14px;
        border-radius:9999px;
        border:1px solid #d1d5db;
        background:#e5e7eb;
        color:#374151;
        font-size:0.95rem;
        cursor:pointer;
      ">
      Zur Umfrage
    </button>

    ${historyTable()}
  `;

  document.getElementById("restartBtn").onclick = () => {
    state = newState();
    viewVignette();
  };

  const surveyBtn = document.getElementById("surveyBtn");
  if (surveyBtn) {
    surveyBtn.onclick = () => {
      window.location.href =
        "https://docs.google.com/forms/d/e/1FAIpQLSd2WAprvECsFLzU_erdGxM0bpaVk_bhm2fzxKgysXlafd8P6A/viewform?usp=publish-editor";
    };
  }
}

function viewNegotiate(errorMsg){
  const abortChance =
    typeof state.last_abort_chance === "number"
      ? state.last_abort_chance
      : null;

  // Farbskala nach Vorgabe:
  // <20 %: grün, 20–40 %: orange, >40 %: rot
  let color = "#16a34a"; // grün
  if (abortChance !== null) {
    if (abortChance > 40) {
      color = "#dc2626"; // rot
    } else if (abortChance >= 20) {
      color = "#f97316"; // orange
    }
  }

  app.innerHTML = `
    <h1>Verkaufsverhandlung</h1>
    <p class="muted">Spieler-ID: ${window.playerId ?? "-"} </p>
    <p class="muted">Teilnehmer-ID: ${state.participant_id}</p>

    <div class="grid">

      <div class="card" style="padding:16px;border:1px dashed var(--accent);">
        <strong>Aktuelles Angebot:</strong> ${eur(state.current_offer)}
      </div>

      <div style="
        background:${color}22;
        border-left:6px solid ${color};
        padding:10px;
        border-radius:8px;
        margin-bottom:10px;">
        <b style="color:${color};">Abbruchwahrscheinlichkeit:</b>
        <span style="color:${color}; font-weight:600;">
          ${abortChance !== null ? abortChance + "%" : "--"}
        </span>
      </div>

      <label for="counter">Dein Gegenangebot (€)</label>
      <div class="row">
        <input id="counter" type="number" step="1" min="0" />
        <button id="sendBtn">Gegenangebot senden</button>
      </div>

      <div class="row">
        <button id="acceptBtn" class="ghost">Angebot annehmen</button>
        <button id="abortBtn"
          style="
            border:1px solid #d1d5db;
            background:#e5e7eb;
            color:#374151;
            font-size:0.95rem;
            cursor:pointer;
          ">
          Verhandlung abbrechen
        </button>
      </div>
    </div>

    ${historyTable()}
    ${state.patternMessage ? `<p class="info">${state.patternMessage}</p>` : ""}
    ${errorMsg ? `<p class="error">${errorMsg}</p>` : ""}
  `;

  const inputEl = document.getElementById("counter");
  inputEl.onkeydown = e => { if (e.key === "Enter") handleSubmit(inputEl.value); };
  document.getElementById("sendBtn").onclick = () => handleSubmit(inputEl.value);

  document.getElementById("acceptBtn").onclick = () => {
    state.history.push({
      runde: state.runde,
      algo_offer: state.current_offer,
      proband_counter: null,
      accepted: true
    });

    logRound({
      runde: state.runde,
      algo_offer: state.current_offer,
      proband_counter: "",
      accepted: true,
      finished: true,
      proband_exit: "",
      algo_exit: "",
      deal_price: state.current_offer
    });

    state.accepted   = true;
    state.finished   = true;
    state.deal_price = state.current_offer;

    viewThink(() => viewFinish(true));
  };

  document.getElementById("abortBtn").onclick = () => {
    state.history.push({
      runde: state.runde,
      algo_offer: state.current_offer,
      proband_counter: null,
      accepted: false
    });

    logRound({
      runde: state.runde,
      algo_offer: state.current_offer,
      proband_counter: "",
      accepted: false,
      finished: true,
      proband_exit: "yes",
      algo_exit: "",
      deal_price: ""
    });

    state.accepted = false;
    state.finished = true;
    state.deal_price = null;

    viewThink(() => viewProbandExit());
  };
}


/* ============================================================
   HANDLE SUBMIT
============================================================ */

function handleSubmit(raw){
  const val    = String(raw ?? "").trim().replace(",", ".");
  const parsed = Number(val);

  if (!Number.isFinite(parsed) || parsed < 0){
    return viewNegotiate("Bitte eine gültige Zahl ≥ 0 eingeben.");
  }

  const num       = roundEuro(parsed);
  const prevOffer = state.current_offer;

  // keine niedrigeren Angebote als in der Vorrunde erlauben
  const last = state.history[state.history.length - 1];
  if (last && last.proband_counter != null) {
    const lastBuyer = roundEuro(last.proband_counter);
    if (num < lastBuyer) {
      return viewNegotiate(
        `Dein Gegenangebot darf nicht niedriger sein als in der Vorrunde (${eur(lastBuyer)}).`
      );
    }
  }

  // Standard-Auto-Accept
  if (shouldAutoAccept(state.initial_offer, state.min_price, prevOffer, num)){
    state.history.push({
      runde: state.runde,
      algo_offer: prevOffer,
      proband_counter: num,
      accepted: true
    });

    logRound({
      runde: state.runde,
      algo_offer: prevOffer,
      proband_counter: num,
      accepted: true,
      finished: true,
      proband_exit: "",
      algo_exit: "",
      deal_price: num
    });

    state.accepted   = true;
    state.finished   = true;
    state.deal_price = num;

    return viewThink(() => viewFinish(true));
  }

  // Zusätzliche Regel:
  // Wenn das Angebot des Käufers mehr als 5 % unter dem letzten Angebot des Verkäufers liegt,
  // aber mindestens so hoch ist wie der nächste Schritt des Verkäufers,
  // soll der Verkäufer dieses Angebot akzeptieren.
  const simulatedNext = computeNextOffer(num, true); // nächster Schritt ohne Auto-Accept
  const diffRatio     = (prevOffer - num) / prevOffer;

  if (diffRatio > 0.05 && num >= simulatedNext && num < prevOffer) {
    state.history.push({
      runde: state.runde,
      algo_offer: prevOffer,
      proband_counter: num,
      accepted: true
    });

    logRound({
      runde: state.runde,
      algo_offer: prevOffer,
      proband_counter: num,
      accepted: true,
      finished: true,
      proband_exit: "",
      algo_exit: "",
      deal_price: num
    });

    state.accepted   = true;
    state.finished   = true;
    state.deal_price = num;

    return viewThink(() => viewFinish(true));
  }

  // Warn-/Patternzustand mit dem aktuellen Angebot aktualisieren
  updatePatternMessage(num);

  // Abbruch prüfen (nutzt warningRounds, setzt last_abort_chance)
  if (maybeAbort(num)) return;

  // normale Runde: Verkäufer macht sein nächstes Angebot
  const next = computeNextOffer(num);

  logRound({
    runde: state.runde,
    algo_offer: prevOffer,
    proband_counter: num,
    accepted: false,
    finished: false,
    proband_exit: "",
    algo_exit: "",
    deal_price: ""
  });

  state.history.push({
    runde: state.runde,
    algo_offer: prevOffer,
    proband_counter: num,
    accepted: false
  });

  state.current_offer = next;

  if (state.runde >= state.max_runden){
    state.finished = true;
    return viewThink(() => viewDecision());
  }

  state.runde++;
  viewThink(() => viewNegotiate());
}


/* ============================================================
   LETZTE RUNDE
============================================================ */

function viewDecision(){
  app.innerHTML = `
    <h1>Letzte Runde</h1>
    <p class="muted">Teilnehmer-ID: ${state.participant_id}</p>

    <div class="card" style="padding:16px;border:1px dashed var(--accent);">
      <strong>Letztes Angebot:</strong> ${eur(state.current_offer)}</strong>
    </div>

    <button id="takeBtn">Annehmen</button>
    <button id="noBtn" class="ghost">Ablehnen</button>

    ${historyTable()}
  `;

  document.getElementById("takeBtn").onclick = () => finish(true, state.current_offer);
  document.getElementById("noBtn").onclick   = () => finish(false, null);
}


/* ============================================================
   FINISH
============================================================ */

function finish(accepted, dealPrice) {
  state.accepted   = !!accepted;
  state.finished   = true;
  state.deal_price = (dealPrice == null ? null : roundEuro(dealPrice));

  logRound({
    runde: state.runde,
    algo_offer: state.current_offer,
    proband_counter: dealPrice == null ? "" : state.deal_price,
    accepted: state.accepted,
    finished: true,
    proband_exit: "",
    algo_exit: "",
    deal_price: dealPrice == null ? "" : state.deal_price
  });

  viewThink(() => viewFinish(state.accepted));
}

function viewFinish(accepted){
  const dealPrice = state.deal_price ?? state.current_offer;

  let text;
  if (accepted){
    text = `Einigung in Runde ${state.runde} bei ${eur(dealPrice)}.`;
  } else {
    text = `Keine Einigung.`;
  }

  app.innerHTML = `
    <h1>Verhandlung abgeschlossen</h1>
    <p class="muted">Teilnehmer-ID: ${state.participant_id}</p>

    <div class="card" style="padding:16px;border:1px dashed var(--accent);">
      <strong>Ergebnis:</strong> ${text}</strong>
    </div>

    <p><b>Du kannst nun entweder eine neue Runde spielen oder die Umfrage beantworten.</b></p>

    <button id="restartBtn">Neue Verhandlung</button>
    <button id="surveyBtn"
      style="
        margin-top:8px;
        display:inline-block;
        padding:8px 14px;
        border-radius:9999px;
        border:1px solid #d1d5db;
        background:#e5e7eb;
        color:#374151;
        font-size:0.95rem;
        cursor:pointer;
      ">
      Zur Umfrage
    </button>

    ${historyTable()}
  `;

  document.getElementById("restartBtn").onclick = () => {
    state = newState();
    viewVignette();
  };

  const surveyBtn = document.getElementById("surveyBtn");
  if (surveyBtn) {
    surveyBtn.onclick = () => {
      window.location.href =
        "https://docs.google.com/forms/d/e/1FAIpQLSd2WAprvECsFLzU_erdGxM0bpaVk_bhm2fzxKgysXlafd8P6A/viewform?usp=publish-editor";
    };
  }
}


/* ============================================================
   INIT
============================================================ */

viewVignette();
