// CueMark - App Password setup wizard (manage-app-lock.html)
// Depends on globals from app.js/applock.js: state, saveData(), normalizeAppLock(),
// setAppLockSecret(), setSecurityQuestions(), setBiometricAppLock(),
// renderPatternGrid(), serializePattern(), updateAppLockSettingsSummary().

const APP_LOCK_METHOD_CHOICES = [
  { value: "none", label: "None", desc: "Open without an app lock.", icon: "lock-open" },
  { value: "pin", label: "PIN", desc: "Numeric code, 4+ digits.", icon: "key-round" },
  { value: "pattern", label: "Pattern", desc: "Connect 2+ dots in any order.", icon: "waypoints" },
  { value: "alphanumeric", label: "Password", desc: "Letters, numbers, or symbols.", icon: "key-square" },
  { value: "biometric", label: "Biometric", desc: "Use device biometrics or screen lock.", icon: "fingerprint" }
];

const SETTINGS_URL = "static/pages/settings/settings.html";

let appLockDraftMethod = null;
let appLockPendingSecret = null;  // set once the setup step's secret is confirmed
let appLockFirstSecret = null;    // first entry, awaiting re-verify match

// ---- Step navigation -------------------------------------------------------

const APP_LOCK_STEPS = ["method", "setup", "questions"];

function showAppLockStep(step) {
  APP_LOCK_STEPS.forEach(name => {
    const panel = document.getElementById(`app-lock-step-${name}`);
    if (panel) panel.style.display = name === step ? "block" : "none";
  });
  const stepper = document.getElementById("app-lock-stepper");
  if (stepper) {
    const order = APP_LOCK_STEPS.indexOf(step);
    stepper.querySelectorAll("li").forEach(li => {
      const idx = APP_LOCK_STEPS.indexOf(li.dataset.step);
      li.classList.toggle("active", idx === order);
      li.classList.toggle("done", idx < order);
      if (idx === order) li.setAttribute("aria-current", "step");
      else li.removeAttribute("aria-current");
    });
  }
}

// ---- Step 1: method picker -------------------------------------------------

function renderAppLockMethodPicker() {
  const container = document.getElementById("app-lock-method-picker");
  if (!container) return;

  container.setAttribute("role", "radiogroup");
  container.setAttribute("aria-label", "Choose how to lock CueMark");
  normalizeAppLock();
  if (!appLockDraftMethod) appLockDraftMethod = state.preferences.appLock.method;

  container.innerHTML = "";
  APP_LOCK_METHOD_CHOICES.forEach(choice => {
    const row = document.createElement("label");
    row.className = "app-lock-method-card";
    row.innerHTML = `
      <span class="app-lock-method-icon"><i data-lucide="${choice.icon}" aria-hidden="true"></i></span>
      <span class="app-lock-method-copy"><strong>${choice.label}</strong><small>${choice.desc}</small></span>
      <input type="radio" name="app-lock-method" value="${choice.value}" aria-label="${choice.label}" ${appLockDraftMethod === choice.value ? "checked" : ""}>
    `;
    container.appendChild(row);
  });

  if (window.lucide) lucide.createIcons(container);

  container.querySelectorAll('input[name="app-lock-method"]').forEach(radio => {
    radio.addEventListener("change", (e) => {
      appLockDraftMethod = e.target.value;
      appLockPendingSecret = null;
      appLockFirstSecret = null;
      updateAppLockMethodAction();
    });
  });

  updateAppLockMethodAction();
  showAppLockStep("method");
}

function updateAppLockMethodAction() {
  const button = document.getElementById("app-lock-method-continue");
  if (!button) return;
  const currentMethod = state.preferences.appLock.method;
  button.textContent = appLockDraftMethod === "none"
    ? (currentMethod === "none" ? "Continue without lock" : "Turn Off App Lock")
    : "Continue";
}

function handleMethodContinue() {
  if (!appLockDraftMethod) {
    alert("Pick a lock method to continue.");
    return;
  }

  // "None" applies immediately — no secret, no questions.
  if (appLockDraftMethod === "none") {
    normalizeAppLock();
    state.preferences.appLock.method = "none";
    state.preferences.appLock.passwordHash = "";
    state.preferences.appLock.passwordSalt = "";
    state.preferences.appLock.securityQuestions = [];
    saveData();
    updateAppLockSettingsSummary();
    window.location.href = SETTINGS_URL;
    return;
  }

  renderAppLockSetupArea();
  showAppLockStep("setup");
}

// ---- Step 2: set up secret (enter + re-verify) -----------------------------

function renderAppLockSetupArea() {
  const setupArea = document.getElementById("app-lock-setup-area");
  const setupTitle = document.getElementById("app-lock-setup-title");
  const continueBtn = document.getElementById("app-lock-setup-continue");
  if (!setupArea) return;

  appLockPendingSecret = null;
  appLockFirstSecret = null;
  if (continueBtn) continueBtn.style.display = "";

  if (appLockDraftMethod === "biometric") {
    setupTitle.textContent = "Biometric Unlock";
    setupArea.innerHTML = `
      <p class="setting-desc">Uses biometrics or the device screen lock already set up in Android. CueMark cannot enroll fingerprints or face data itself.</p>
      <button type="button" class="btn btn-primary" id="app-lock-enable-biometric" style="width:100%;margin-top:12px;">Enable Biometric Unlock</button>
      <p class="app-lock-error" id="app-lock-biometric-error" style="display:none;"></p>
    `;
    // Biometric enables and exits directly; no re-verify / questions steps.
    if (continueBtn) continueBtn.style.display = "none";
    document.getElementById("app-lock-enable-biometric").addEventListener("click", enableBiometricAppLock);
    return;
  }

  if (appLockDraftMethod === "pattern") {
    setupTitle.textContent = "Draw Your Pattern";
    renderPatternSetup(setupArea);
    return;
  }

  // PIN / alphanumeric: enter, then re-enter to confirm.
  setupTitle.textContent = appLockDraftMethod === "pin" ? "Set Your PIN" : "Set Your Password";
  const isPin = appLockDraftMethod === "pin";
  const type = isPin ? "password" : "text";
  const extra = isPin ? 'inputmode="numeric" pattern="[0-9]*"' : "";
  setupArea.innerHTML = `
    <div class="form-group">
      <label for="app-lock-secret-input">${isPin ? "New PIN" : "New password"}</label>
      <input type="${type}" ${extra} id="app-lock-secret-input" class="form-control" autocomplete="new-password" placeholder="${isPin ? "New PIN (4+ digits)" : "New password"}">
    </div>
    <div class="form-group">
      <label for="app-lock-secret-confirm">${isPin ? "Confirm PIN" : "Confirm password"}</label>
      <input type="${type}" ${extra} id="app-lock-secret-confirm" class="form-control" autocomplete="new-password" placeholder="Re-enter to confirm">
    </div>
    <p class="app-lock-error" id="app-lock-setup-error" style="display:none;"></p>
  `;

  const input = document.getElementById("app-lock-secret-input");
  const confirm = document.getElementById("app-lock-secret-confirm");
  const errorEl = document.getElementById("app-lock-setup-error");

  const validate = () => {
    const value = input.value;
    const confirmValue = confirm.value;
    const baseValid = isPin ? /^\d{4,}$/.test(value) : value.length >= 4;
    appLockPendingSecret = null;

    if (!baseValid) {
      errorEl.textContent = isPin ? "PIN must be at least 4 digits." : "Password must be at least 4 characters.";
      errorEl.style.display = value ? "block" : "none";
      return;
    }
    if (!confirmValue) {
      errorEl.style.display = "none";
      return;
    }
    if (value !== confirmValue) {
      errorEl.textContent = isPin ? "PINs don't match." : "Passwords don't match.";
      errorEl.style.display = "block";
      return;
    }
    appLockPendingSecret = value;
    errorEl.style.display = "none";
  };

  input.addEventListener("input", validate);
  confirm.addEventListener("input", validate);
}

function renderPatternSetup(setupArea) {
  // Two-phase pattern: draw once, then redraw to confirm it matches.
  setupArea.innerHTML = `<p class="setting-desc" id="app-lock-pattern-status">Draw a pattern (2+ dots).</p>`;
  const gridWrap = document.createElement("div");
  setupArea.appendChild(gridWrap);

  const statusEl = () => document.getElementById("app-lock-pattern-status");

  const startConfirmPhase = () => {
    statusEl().textContent = "Great — now draw the same pattern again to confirm.";
    gridWrap.innerHTML = "";
    renderPatternGrid(gridWrap, (cells) => {
      const candidate = serializePattern(cells);
      if (candidate === appLockFirstSecret) {
        appLockPendingSecret = candidate;
        statusEl().textContent = `Pattern confirmed (${cells.length} dots). Tap Continue.`;
      } else {
        appLockPendingSecret = null;
        appLockFirstSecret = null;
        statusEl().textContent = "Patterns didn't match. Start over — draw your pattern.";
        startDrawPhase();
      }
    });
  };

  const startDrawPhase = () => {
    appLockFirstSecret = null;
    appLockPendingSecret = null;
    gridWrap.innerHTML = "";
    renderPatternGrid(gridWrap, (cells) => {
      appLockFirstSecret = serializePattern(cells);
      startConfirmPhase();
    });
  };

  startDrawPhase();
}

function handleSetupContinue() {
  if (appLockDraftMethod === "biometric") return; // handled by its own button
  if (!appLockPendingSecret) {
    alert(appLockDraftMethod === "pattern"
      ? "Draw and confirm your pattern first."
      : "Enter and confirm your PIN/password first.");
    return;
  }
  renderAppLockQuestionsArea();
  showAppLockStep("questions");
}

// ---- Step 3: security questions (skippable) --------------------------------

function renderAppLockQuestionsArea() {
  const questionsArea = document.getElementById("app-lock-questions-area");
  if (!questionsArea) return;
  if (questionsArea.childElementCount > 0) return; // keep answers already typed

  const existing = state.preferences.appLock.securityQuestions || [];
  questionsArea.innerHTML = "";
  for (let i = 0; i < 3; i++) {
    const group = document.createElement("div");
    group.className = "form-group";
    group.innerHTML = `
      <label for="app-lock-question-${i}">Question ${i + 1}</label>
      <input type="text" id="app-lock-question-${i}" class="form-control app-lock-question-input" data-index="${i}" placeholder="e.g. What was your first pet's name?">
      <input type="text" id="app-lock-answer-${i}" class="form-control app-lock-answer-input" data-index="${i}" aria-label="Answer to question ${i + 1}" placeholder="Answer" style="margin-top:8px;">
    `;
    questionsArea.appendChild(group);
    group.querySelector(".app-lock-question-input").value = existing[i]?.question || "";
  }
}

async function commitAppLock(includeQuestions) {
  if (!appLockPendingSecret) {
    alert("Please finish setting your PIN, pattern, or password first.");
    showAppLockStep("setup");
    return;
  }

  let qaPairs = [];
  if (includeQuestions) {
    const questions = Array.from(document.querySelectorAll(".app-lock-question-input"))
      .sort((a, b) => Number(a.dataset.index) - Number(b.dataset.index))
      .map(el => el.value.trim());
    const answers = Array.from(document.querySelectorAll(".app-lock-answer-input"))
      .sort((a, b) => Number(a.dataset.index) - Number(b.dataset.index))
      .map(el => el.value);

    if (questions.some(q => !q) || answers.some(a => !a.trim())) {
      alert("Please fill in all 3 security questions and answers, or use Skip.");
      return;
    }
    qaPairs = questions.map((question, i) => ({ question, answer: answers[i] }));
  }

  await setAppLockSecret(appLockDraftMethod, appLockPendingSecret);
  await setSecurityQuestions(qaPairs); // empty array clears questions on skip

  alert(includeQuestions ? "App password set successfully." : "App password set. No recovery questions — keep it safe.");
  appLockPendingSecret = null;
  updateAppLockSettingsSummary();
  window.location.href = SETTINGS_URL;
}

// ---- Biometric -------------------------------------------------------------

async function enableBiometricAppLock() {
  const biometric = window.Capacitor?.Plugins?.Biometric;
  const errorEl = document.getElementById("app-lock-biometric-error");
  const showError = (message) => {
    if (errorEl) {
      errorEl.textContent = message;
      errorEl.style.display = "block";
    } else {
      alert(message);
    }
  };

  if (!biometric?.isAvailable) {
    showError("Biometric support is unavailable in this Android build. Rebuild and reinstall the app.");
    return;
  }

  try {
    const available = await biometric.isAvailable();
    if (!available?.supportsDeviceCredential) {
      showError("Biometric unlock with device-screen-lock recovery requires Android 11 or later. Use an app PIN or password on this Android version.");
      return;
    }
    if (!available.available) {
      showError("No biometric or device screen lock is available. Set up a fingerprint, face unlock, or screen lock in Android settings first.");
      return;
    }
  } catch (err) {
    showError("Android could not check biometric availability. You can still choose an app PIN or password.");
    return;
  }

  const enableButton = document.getElementById("app-lock-enable-biometric");
  try {
    if (enableButton) {
      enableButton.disabled = true;
      enableButton.textContent = "Confirm on your device…";
    }
    const result = await biometric.authenticate({ reason: "Confirm biometric unlock for CueMark" });
    if (!result?.success) {
      showError("Biometric confirmation did not succeed. App Lock has not been changed.");
      return;
    }
  } catch (err) {
    showError("Biometric confirmation was canceled or failed. App Lock has not been changed.");
    return;
  } finally {
    if (enableButton?.isConnected) {
      enableButton.disabled = false;
      enableButton.textContent = "Enable Biometric Unlock";
    }
  }

  setBiometricAppLock();
  updateAppLockSettingsSummary();
  window.location.href = SETTINGS_URL;
}

// ---- Wiring ----------------------------------------------------------------

function setupAppLockWizard() {
  const wired = document.getElementById("app-lock-stepper");
  if (wired && wired.dataset.bound) return;
  if (wired) wired.dataset.bound = "true";

  document.getElementById("app-lock-method-continue")?.addEventListener("click", handleMethodContinue);
  document.getElementById("app-lock-setup-back")?.addEventListener("click", () => showAppLockStep("method"));
  document.getElementById("app-lock-setup-continue")?.addEventListener("click", handleSetupContinue);
  document.getElementById("app-lock-questions-back")?.addEventListener("click", () => showAppLockStep("setup"));
  document.getElementById("app-lock-skip-btn")?.addEventListener("click", () => {
    if (window.confirm("Skip security questions? You won't be able to recover a forgotten password.")) {
      commitAppLock(false);
    }
  });
  document.getElementById("app-lock-save-btn")?.addEventListener("click", () => commitAppLock(true));
}

document.addEventListener("DOMContentLoaded", () => {
  // Runs after app.js's own DOMContentLoaded handler (script order in the HTML),
  // so state is already loaded by the time this fires.
  const tryInit = () => {
    if (!document.getElementById("app-lock-method-picker")) return;
    renderAppLockMethodPicker();
    setupAppLockWizard();
    showAppLockStep("method");
  };
  // app.js may still be mid-unlock-gate on this page; wait for app-unlocked if so.
  if (typeof appLockShouldBlockPage === "function" && appLockShouldBlockPage()) {
    document.addEventListener("app-unlocked", tryInit, { once: true });
  } else {
    tryInit();
  }
});
