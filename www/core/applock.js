// CueMark - App lock (PIN / pattern / alphanumeric password + security-question reset)
//
// Threat model: this deters casual snooping (someone picking up the phone), not a
// determined attacker with adb/root — the underlying data in localStorage is not
// encrypted, only gated behind this screen. Secrets are hashed (PBKDF2 + per-secret
// random salt) so the raw PIN/pattern/password/security answers are never stored in
// plain text, but nothing here changes what's readable via direct filesystem access.
//
// Depends on globals from app.js: state, saveData(), loadData(), CATEGORIES.

const APP_LOCK_MAX_ATTEMPTS = 5;
const APP_LOCK_PBKDF2_ITERATIONS = 100000;
let appLockBiometricAttemptInProgress = false;

function normalizeAppLock() {
  const defaults = { method: "none", passwordHash: "", passwordSalt: "", securityQuestions: [] };
  const current = state.preferences.appLock;
  if (!current || typeof current !== "object") {
    state.preferences.appLock = { ...defaults };
    return;
  }
  if (!["none", "pin", "pattern", "alphanumeric", "biometric"].includes(current.method)) current.method = "none";
  if (typeof current.passwordHash !== "string") current.passwordHash = "";
  if (typeof current.passwordSalt !== "string") current.passwordSalt = "";
  if (!Array.isArray(current.securityQuestions)) current.securityQuestions = [];
}

function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}

function randomSaltHex() {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
}

// PBKDF2-SHA256, returned as a hex string. Same secret + same salt always yields
// the same hash, so this is used both to set a secret and to verify one later.
async function hashSecret(secret, saltHex) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(secret), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: hexToBytes(saltHex), iterations: APP_LOCK_PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return bytesToHex(new Uint8Array(bits));
}

function normalizeSecurityAnswer(answer) {
  return String(answer || "").trim().toLowerCase();
}

// Serializes a pattern (array of cell indices, e.g. [0,4,8]) into one string so it
// can be hashed like any other secret.
function serializePattern(cells) {
  return cells.join("-");
}

async function setAppLockSecret(method, secret) {
  normalizeAppLock();
  const salt = randomSaltHex();
  const hash = await hashSecret(secret, salt);
  state.preferences.appLock.method = method;
  state.preferences.appLock.passwordHash = hash;
  state.preferences.appLock.passwordSalt = salt;
  saveData();
}

function setBiometricAppLock() {
  normalizeAppLock();
  state.preferences.appLock.method = "biometric";
  state.preferences.appLock.passwordHash = "";
  state.preferences.appLock.passwordSalt = "";
  state.preferences.appLock.securityQuestions = [];
  saveData();
}

async function verifyAppLockSecret(secret) {
  normalizeAppLock();
  const { passwordHash, passwordSalt } = state.preferences.appLock;
  if (!passwordHash || !passwordSalt) return false;
  const candidate = await hashSecret(secret, passwordSalt);
  return candidate === passwordHash;
}

async function setSecurityQuestions(qaPairs) {
  normalizeAppLock();
  const questions = [];
  for (const { question, answer } of qaPairs) {
    const salt = randomSaltHex();
    const hash = await hashSecret(normalizeSecurityAnswer(answer), salt);
    questions.push({ question, answerHash: hash, answerSalt: salt });
  }
  state.preferences.appLock.securityQuestions = questions;
  saveData();
}

async function verifySecurityAnswers(answers) {
  normalizeAppLock();
  const questions = state.preferences.appLock.securityQuestions;
  if (questions.length === 0 || answers.length !== questions.length) return false;
  const results = await Promise.all(questions.map((q, i) =>
    hashSecret(normalizeSecurityAnswer(answers[i]), q.answerSalt).then(h => h === q.answerHash)
  ));
  return results.every(Boolean);
}

function getFailedAttempts() {
  return parseInt(localStorage.getItem("cuemark_lock_failed_attempts") || "0", 10) || 0;
}

function setFailedAttempts(count) {
  localStorage.setItem("cuemark_lock_failed_attempts", String(count));
}

function isSessionUnlocked() {
  return sessionStorage.getItem("cuemark_lock_unlocked") === "true";
}

function markSessionUnlocked() {
  sessionStorage.setItem("cuemark_lock_unlocked", "true");
  setFailedAttempts(0);
}

// Called at the very top of every page's init, before anything else renders.
// If a lock method is set and this session hasn't been unlocked yet, shows a
// full-screen overlay and returns true (caller should stop further rendering).
function appLockShouldBlockPage() {
  normalizeAppLock();
  return state.preferences.appLock.method !== "none" && !isSessionUnlocked();
}

function renderAppLockOverlay() {
  let overlay = document.getElementById("app-lock-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "app-lock-overlay";
    overlay.className = "app-lock-overlay";
    document.body.appendChild(overlay);
  }

  const method = state.preferences.appLock.method;
  const attempts = getFailedAttempts();
  const showForgot = attempts >= APP_LOCK_MAX_ATTEMPTS;

  overlay.innerHTML = `
    <div class="app-lock-card">
      <i data-lucide="lock" class="app-lock-icon"></i>
      <h2>CueMark Locked</h2>
      <div id="app-lock-input-area"></div>
      <p class="app-lock-error" id="app-lock-error" style="display:none;"></p>
      ${showForgot ? `<button type="button" class="btn btn-secondary" id="app-lock-forgot-btn" style="width:100%;margin-top:12px;">Forgot password?</button>` : ""}
    </div>
  `;

  renderAppLockInputArea(method);
  if (window.lucide) lucide.createIcons();

  const forgotBtn = document.getElementById("app-lock-forgot-btn");
  if (forgotBtn) forgotBtn.addEventListener("click", renderAppLockForgotFlow);
}

async function handleBiometricUnlock() {
  if (appLockBiometricAttemptInProgress) return;
  const biometric = window.Capacitor?.Plugins?.Biometric;
  if (!biometric?.authenticate) {
    showAppLockError("Biometric unlock is available in the installed Android app only.");
    return;
  }

  appLockBiometricAttemptInProgress = true;
  const button = document.getElementById("app-lock-biometric-btn");
  if (button) button.disabled = true;
  try {
    const result = await biometric.authenticate({ reason: "Unlock your CueMark library" });
    if (!result?.success) {
      showAppLockError("Authentication did not complete. Try again or use your device screen lock.");
      return;
    }
    markSessionUnlocked();
    document.getElementById("app-lock-overlay")?.remove();
    document.dispatchEvent(new CustomEvent("app-unlocked"));
  } catch (err) {
    showAppLockError("Authentication was canceled or unavailable. Try again or use your device screen lock.");
  } finally {
    appLockBiometricAttemptInProgress = false;
    if (button?.isConnected) button.disabled = false;
  }
}

function showAppLockError(message) {
  const errorEl = document.getElementById("app-lock-error");
  if (errorEl) {
    errorEl.textContent = message;
    errorEl.style.display = "block";
  }
}

async function handleAppLockAttempt(secret) {
  const correct = await verifyAppLockSecret(secret);
  if (correct) {
    markSessionUnlocked();
    const overlay = document.getElementById("app-lock-overlay");
    if (overlay) overlay.remove();
    document.dispatchEvent(new CustomEvent("app-unlocked"));
    return;
  }

  const attempts = getFailedAttempts() + 1;
  setFailedAttempts(attempts);
  const remaining = APP_LOCK_MAX_ATTEMPTS - attempts;
  showAppLockError(remaining > 0 ? `Incorrect. ${remaining} attempt(s) left before you can use "Forgot password".` : "Incorrect.");
  renderAppLockOverlay();
}

function renderAppLockInputArea(method) {
  const area = document.getElementById("app-lock-input-area");
  if (!area) return;

  if (method === "biometric") {
    area.innerHTML = `
      <p class="setting-desc">Use a fingerprint, face, or screen lock enrolled with Android.</p>
      <button type="button" class="btn btn-primary" id="app-lock-biometric-btn" style="width:100%;margin-top:10px;">Unlock with biometrics</button>
    `;
    document.getElementById("app-lock-biometric-btn").addEventListener("click", handleBiometricUnlock);
    setTimeout(handleBiometricUnlock, 150);
  } else if (method === "pin") {
    area.innerHTML = `
      <input type="password" inputmode="numeric" pattern="[0-9]*" id="app-lock-pin-input" class="form-control app-lock-text-input" placeholder="Enter PIN" autocomplete="off">
      <button type="button" class="btn btn-primary" id="app-lock-submit-btn" style="width:100%;margin-top:10px;">Unlock</button>
    `;
    document.getElementById("app-lock-submit-btn").addEventListener("click", () => {
      const value = document.getElementById("app-lock-pin-input").value;
      if (value) handleAppLockAttempt(value);
    });
    document.getElementById("app-lock-pin-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") document.getElementById("app-lock-submit-btn").click();
    });
  } else if (method === "alphanumeric") {
    area.innerHTML = `
      <input type="password" id="app-lock-password-input" class="form-control app-lock-text-input" placeholder="Enter password" autocomplete="off">
      <button type="button" class="btn btn-primary" id="app-lock-submit-btn" style="width:100%;margin-top:10px;">Unlock</button>
    `;
    document.getElementById("app-lock-submit-btn").addEventListener("click", () => {
      const value = document.getElementById("app-lock-password-input").value;
      if (value) handleAppLockAttempt(value);
    });
    document.getElementById("app-lock-password-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") document.getElementById("app-lock-submit-btn").click();
    });
  } else if (method === "pattern") {
    renderPatternGrid(area, (cells) => {
      if (cells.length >= 2) handleAppLockAttempt(serializePattern(cells));
    });
  }
}

// Renders a 3x3 dot grid the user draws a pattern across (pointer down on a dot,
// drag through others, release to submit). No minimum-4 restriction like stock
// Android — onComplete only requires 2+ dots (a single dot isn't a "pattern").
function renderPatternGrid(container, onComplete) {
  container.innerHTML = `
    <div class="app-lock-pattern-grid" id="app-lock-pattern-grid">
      <svg class="app-lock-pattern-lines" id="app-lock-pattern-lines">
        <defs>
          <marker id="app-lock-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="var(--primary)"></path>
          </marker>
        </defs>
      </svg>
    </div>`;
  const grid = document.getElementById("app-lock-pattern-grid");
  const svg = document.getElementById("app-lock-pattern-lines");
  const dots = [];
  for (let i = 0; i < 9; i++) {
    const dot = document.createElement("div");
    dot.className = "app-lock-pattern-dot";
    dot.dataset.index = String(i);
    grid.appendChild(dot);
    dots.push(dot);
  }

  let drawing = false;
  let selected = [];

  const dotCenter = (dot) => {
    const gridRect = grid.getBoundingClientRect();
    const rect = dot.getBoundingClientRect();
    return {
      x: rect.left - gridRect.left + rect.width / 2,
      y: rect.top - gridRect.top + rect.height / 2
    };
  };

  const redrawLines = () => {
    while (svg.lastChild && svg.lastChild.tagName !== "defs") svg.removeChild(svg.lastChild);
    for (let i = 0; i < selected.length - 1; i++) {
      const from = dotCenter(dots[selected[i]]);
      const to = dotCenter(dots[selected[i + 1]]);
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", from.x);
      line.setAttribute("y1", from.y);
      line.setAttribute("x2", to.x);
      line.setAttribute("y2", to.y);
      line.setAttribute("class", "app-lock-pattern-line");
      if (i === selected.length - 2) line.setAttribute("marker-end", "url(#app-lock-arrow)");
      svg.appendChild(line);
    }
  };

  const reset = () => {
    selected = [];
    dots.forEach(d => d.classList.remove("active", "pattern-start", "pattern-end"));
    redrawLines();
  };

  const selectDot = (dot) => {
    const idx = parseInt(dot.dataset.index, 10);
    if (!selected.includes(idx)) {
      dots.forEach(d => d.classList.remove("pattern-end"));
      selected.push(idx);
      dot.classList.add("active");
      if (selected.length === 1) dot.classList.add("pattern-start");
      dot.classList.add("pattern-end");
      redrawLines();
    }
  };

  const dotAtPoint = (x, y) => {
    return dots.find(d => {
      const rect = d.getBoundingClientRect();
      return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    });
  };

  grid.addEventListener("pointerdown", (e) => {
    reset();
    drawing = true;
    const dot = dotAtPoint(e.clientX, e.clientY);
    if (dot) selectDot(dot);
  });
  grid.addEventListener("pointermove", (e) => {
    if (!drawing) return;
    const dot = dotAtPoint(e.clientX, e.clientY);
    if (dot) selectDot(dot);
  });
  const finish = () => {
    if (!drawing) return;
    drawing = false;
    if (selected.length >= 2) {
      onComplete([...selected]);
    }
    reset();
  };
  grid.addEventListener("pointerup", finish);
  grid.addEventListener("pointerleave", finish);
}

function renderAppLockForgotFlow() {
  const overlay = document.getElementById("app-lock-overlay");
  if (!overlay) return;
  const questions = state.preferences.appLock.securityQuestions;

  if (questions.length === 0) {
    overlay.querySelector(".app-lock-card").innerHTML = `
      <i data-lucide="alert-triangle" class="app-lock-icon"></i>
      <h2>No Recovery Available</h2>
      <p class="app-lock-error" style="display:block;">No security questions were set up. There is no way to recover this password.</p>
    `;
    if (window.lucide) lucide.createIcons();
    return;
  }

  overlay.querySelector(".app-lock-card").innerHTML = `
    <i data-lucide="help-circle" class="app-lock-icon"></i>
    <h2>Security Questions</h2>
    <div id="app-lock-security-answers"></div>
    <p class="app-lock-error" id="app-lock-error" style="display:none;"></p>
    <button type="button" class="btn btn-primary" id="app-lock-verify-answers-btn" style="width:100%;margin-top:10px;">Verify</button>
  `;

  const answersArea = document.getElementById("app-lock-security-answers");
  questions.forEach((q, i) => {
    const group = document.createElement("div");
    group.className = "form-group";
    group.innerHTML = `
      <label>${q.question}</label>
      <input type="text" class="form-control app-lock-security-answer" data-index="${i}" autocomplete="off">
    `;
    answersArea.appendChild(group);
  });

  document.getElementById("app-lock-verify-answers-btn").addEventListener("click", async () => {
    const answers = Array.from(document.querySelectorAll(".app-lock-security-answer"))
      .sort((a, b) => Number(a.dataset.index) - Number(b.dataset.index))
      .map(el => el.value);
    const correct = await verifySecurityAnswers(answers);
    if (correct) {
      renderAppLockResetFlow();
    } else {
      showAppLockError("One or more answers are incorrect.");
    }
  });

  if (window.lucide) lucide.createIcons();
}

function renderAppLockResetFlow() {
  const overlay = document.getElementById("app-lock-overlay");
  if (!overlay) return;

  overlay.querySelector(".app-lock-card").innerHTML = `
    <i data-lucide="key-round" class="app-lock-icon"></i>
    <h2>Set a New Password</h2>
    <p class="setting-desc">Choose a new lock method and secret. Your security questions stay the same.</p>
    <select id="app-lock-reset-method" class="form-control" style="margin-top:10px;">
      <option value="pin">PIN</option>
      <option value="pattern">Pattern</option>
      <option value="alphanumeric">Alphanumeric Password</option>
    </select>
    <div id="app-lock-reset-input-area" style="margin-top:10px;"></div>
    <p class="app-lock-error" id="app-lock-error" style="display:none;"></p>
  `;
  if (window.lucide) lucide.createIcons();

  const methodSelect = document.getElementById("app-lock-reset-method");
  const renderResetInput = () => {
    const area = document.getElementById("app-lock-reset-input-area");
    const method = methodSelect.value;
    if (method === "pattern") {
      area.innerHTML = `<p class="setting-desc">Draw a new pattern (2+ dots) to confirm.</p>`;
      const gridWrap = document.createElement("div");
      area.appendChild(gridWrap);
      renderPatternGrid(gridWrap, async (cells) => {
        await setAppLockSecret("pattern", serializePattern(cells));
        setFailedAttempts(0);
        markSessionUnlocked();
        overlay.remove();
        document.dispatchEvent(new CustomEvent("app-unlocked"));
      });
    } else {
      area.innerHTML = `
        <input type="${method === "pin" ? "password" : "text"}" ${method === "pin" ? 'inputmode="numeric" pattern="[0-9]*"' : ""} id="app-lock-reset-secret" class="form-control" placeholder="${method === "pin" ? "New PIN (4+ digits)" : "New password"}">
        <button type="button" class="btn btn-primary" id="app-lock-reset-save-btn" style="width:100%;margin-top:10px;">Save</button>
      `;
      document.getElementById("app-lock-reset-save-btn").addEventListener("click", async () => {
        const value = document.getElementById("app-lock-reset-secret").value;
        if (method === "pin" && (!/^\d{4,}$/.test(value))) {
          showAppLockError("PIN must be at least 4 digits.");
          return;
        }
        if (method === "alphanumeric" && value.length < 4) {
          showAppLockError("Password must be at least 4 characters.");
          return;
        }
        await setAppLockSecret(method, value);
        setFailedAttempts(0);
        markSessionUnlocked();
        overlay.remove();
        document.dispatchEvent(new CustomEvent("app-unlocked"));
      });
    }
  };
  methodSelect.addEventListener("change", renderResetInput);
  renderResetInput();
}

// Call once at the top of every page's init. If locked, shows the overlay and
// returns true so the caller can skip further rendering until unlocked.
function guardAppLock() {
  if (appLockShouldBlockPage()) {
    renderAppLockOverlay();
    return true;
  }
  return false;
}
