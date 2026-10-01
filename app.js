/**
 * Zoom Innovation Lab (ZIL) Kiosk Web Application
 * Offline-first check-in and check-out kiosk for iPad
 * ASU Brand & Strict Constraints (No emojis, Vanilla JS, IndexedDB)
 */

// ==========================================================================
// 1. CONFIGURATION & CONSTANTS
// ==========================================================================

/** 4-digit staff PIN for dashboard authorization (configurable) */
const STAFF_PIN = "1234";

/** List of available studios at Zoom Innovation Lab */
const ROOMS = [
  "Studio 1 (Room 133) - Podcasting Studio",
  "Studio 2 (Room 134) - Streaming Studio",
  "Studio 3 (Room 135) - Streaming Studio",
  "Studio 4 (Room 140) - Zoom Innovation Lab"
];

/** Database name and version */
const DB_NAME = "ZIL_KIOSK_DB";
const DB_VERSION = 1;

/** Kiosk auto-return inactivity timeout: 30 seconds */
const INACTIVITY_TIMEOUT_MS = 30000;

/** Backup age threshold: 7 days */
const BACKUP_ALERT_DAYS = 7;

// ==========================================================================
// 2. STATE MANAGEMENT (Ephemeral UI state only - records live in IndexedDB)
// ==========================================================================

let db = null;
let inactivityTimer = null;
let currentScreen = "screen-home";
let enteredPin = "";
let selectedVisitForCheckout = null;
let pendingCheckInData = null;
let confirmationTimer = null;

// ==========================================================================
// 3. INDEXEDDB HELPER MODULE
// ==========================================================================

/**
 * Initializes IndexedDB schema and upgrades if needed.
 * Stores:
 * - visits: id (autoIncrement), name, email, room,
 *           checkInAt, checkOutAt, status, damage, damageNotes,
 *           warningShown
 * - people: email (keyPath), name, missedCheckoutCount, lastVisitAt
 * - meta: key (keyPath), value
 */
function initDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const database = event.target.result;

      // Visits Store
      if (!database.objectStoreNames.contains("visits")) {
        const visitStore = database.createObjectStore("visits", {
          keyPath: "id",
          autoIncrement: true
        });
        visitStore.createIndex("email", "email", { unique: false });
        visitStore.createIndex("status", "status", { unique: false });
        visitStore.createIndex("room", "room", { unique: false });
        visitStore.createIndex("checkInAt", "checkInAt", { unique: false });
      } else {
        const visitStore = event.target.transaction.objectStore("visits");
        if (!visitStore.indexNames.contains("email")) {
          visitStore.createIndex("email", "email", { unique: false });
        }
      }

      // People Store (keyed by email)
      if (!database.objectStoreNames.contains("people")) {
        database.createObjectStore("people", { keyPath: "email" });
      }

      // Meta Store (keyed by string key)
      if (!database.objectStoreNames.contains("meta")) {
        database.createObjectStore("meta", { keyPath: "key" });
      }
    };

    request.onsuccess = (event) => {
      db = event.target.result;

      // Handle generic errors on db connection
      db.onerror = (e) => {
        console.error("IndexedDB error:", e.target.error);
        showSystemError("Database connection error: " + (e.target.error?.message || "Unknown error"));
      };

      resolve(db);
    };

    request.onerror = (event) => {
      console.error("Failed to open IndexedDB:", event.target.error);
      showSystemError("Failed to initialize database: " + (event.target.error?.message || "Unknown error"));
      reject(event.target.error);
    };
  });
}

/**
 * Executes an atomic transaction across one or more stores.
 * Resolves only after transaction successfully completes (oncomplete).
 */
function runAtomicTransaction(storeNames, mode, operationFn) {
  return new Promise((resolve, reject) => {
    if (!db) {
      const err = new Error("Database not initialized");
      showSystemError(err.message);
      return reject(err);
    }

    const tx = db.transaction(storeNames, mode);
    let operationResult = null;

    tx.oncomplete = () => {
      resolve(operationResult);
    };

    tx.onerror = (event) => {
      const error = event.target.error || new Error("Transaction failed");
      console.error("Transaction error:", error);
      showSystemError("Storage error: " + error.message);
      reject(error);
    };

    tx.onabort = (event) => {
      const error = event.target.error || new Error("Transaction was aborted");
      console.error("Transaction aborted:", error);
      showSystemError("Storage operation aborted: " + error.message);
      reject(error);
    };

    try {
      operationResult = operationFn(tx);
    } catch (err) {
      console.error("Exception inside transaction operation:", err);
      showSystemError("Execution error: " + err.message);
      try {
        tx.abort();
      } catch (e) {
        // Ignored if already finished
      }
      reject(err);
    }
  });
}

/** Fetch all records from an object store */
function getAllRecords(storeName) {
  return new Promise((resolve, reject) => {
    if (!db) return reject(new Error("Database not initialized"));
    const tx = db.transaction(storeName, "readonly");
    const store = tx.objectStore(storeName);
    const request = store.getAll();

    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => {
      showSystemError("Failed to read " + storeName);
      reject(request.error);
    };
  });
}

/** Fetch a single record by key */
function getRecord(storeName, key) {
  return new Promise((resolve, reject) => {
    if (!db) return reject(new Error("Database not initialized"));
    const tx = db.transaction(storeName, "readonly");
    const store = tx.objectStore(storeName);
    const request = store.get(key);

    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => {
      showSystemError("Failed to fetch record from " + storeName);
      reject(request.error);
    };
  });
}

/** Request persistent storage to protect data against eviction on iPad */
async function requestPersistentStorage() {
  if (navigator.storage && navigator.storage.persist) {
    try {
      const isPersisted = await navigator.storage.persist();
      console.log("Persistent storage granted:", isPersisted);
    } catch (err) {
      console.warn("Could not request persistent storage:", err);
    }
  }
}

/**
 * On app load: Sessions still active from a previous calendar day become status = 'missed_checkout'
 */
async function processPreviousDayMissedCheckouts() {
  const allVisits = await getAllRecords("visits");
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

  const staleVisits = allVisits.filter((visit) => {
    if (visit.status !== "active") return false;
    const checkInTime = new Date(visit.checkInAt).getTime();
    return checkInTime < startOfToday;
  });

  if (staleVisits.length === 0) return;

  await runAtomicTransaction(["visits"], "readwrite", (tx) => {
    const visitStore = tx.objectStore("visits");
    for (const v of staleVisits) {
      v.status = "missed_checkout";
      visitStore.put(v);
    }
  });

  console.log(`Updated ${staleVisits.length} previous-day sessions to missed_checkout`);
}

// ==========================================================================
// 4. INACTIVITY TIMER & KIOSK BEHAVIOR
// ==========================================================================

function resetInactivityTimer() {
  if (inactivityTimer) {
    clearTimeout(inactivityTimer);
  }

  inactivityTimer = setTimeout(() => {
    handleInactivityTimeout();
  }, INACTIVITY_TIMEOUT_MS);
}

function handleInactivityTimeout() {
  // If already at home and no modal open, nothing to reset
  const hasOpenModals = document.querySelector(".kiosk-overlay:not(.hidden)");
  if (currentScreen === "screen-home" && !hasOpenModals) {
    return;
  }

  // Dismiss all modals and overlays
  hideElement("overlay-missed-warning");
  hideElement("overlay-duplicate-active");
  hideElement("overlay-checkout-inspect");
  hideElement("overlay-confirmation");
  hideElement("overlay-staff-pin");

  // Reset form inputs & temporary states
  resetCheckInForm();
  resetPinModal();
  selectedVisitForCheckout = null;
  pendingCheckInData = null;

  if (confirmationTimer) {
    clearInterval(confirmationTimer);
    confirmationTimer = null;
  }

  // Navigate back to home screen
  showScreen("screen-home");
}

function setupInactivityListeners() {
  const activityEvents = ["touchstart", "pointerdown", "mousedown", "keydown", "input", "click", "scroll"];
  activityEvents.forEach((evt) => {
    window.addEventListener(evt, resetInactivityTimer, { passive: true });
  });
  resetInactivityTimer();
}

// ==========================================================================
// 5. NAVIGATION & SCREEN MANAGEMENT
// ==========================================================================

function showScreen(screenId) {
  document.querySelectorAll(".kiosk-screen").forEach((screen) => {
    screen.classList.remove("active");
    screen.classList.add("hidden");
  });

  const target = document.getElementById(screenId);
  if (target) {
    target.classList.remove("hidden");
    target.classList.add("active");
    currentScreen = screenId;
  }

  resetInactivityTimer();
}

function showElement(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove("hidden");
}

function hideElement(id) {
  const el = document.getElementById(id);
  if (el) el.classList.add("hidden");
}

function showSystemError(message) {
  const banner = document.getElementById("system-error-banner");
  const msgEl = document.getElementById("system-error-message");
  if (banner && msgEl) {
    msgEl.textContent = message;
    banner.classList.remove("hidden");
  }
}

function hideSystemError() {
  hideElement("system-error-banner");
}

// ==========================================================================
// 6. HEADER CLOCK
// ==========================================================================

function updateHeaderClock() {
  const clockEl = document.getElementById("header-clock");
  if (!clockEl) return;

  const now = new Date();
  const options = {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true
  };
  clockEl.textContent = now.toLocaleDateString("en-US", options);
}

// ==========================================================================
// 7. CHECK IN FLOW
// ==========================================================================

/** Populate the room dropdown on startup */
function populateRoomDropdown() {
  const select = document.getElementById("checkin-room");
  if (!select) return;

  // Clear existing options except placeholder
  select.innerHTML = '<option value="" disabled selected>Select a studio...</option>';

  ROOMS.forEach((roomName) => {
    const opt = document.createElement("option");
    opt.value = roomName;
    opt.textContent = roomName;
    select.appendChild(opt);
  });
}

function resetCheckInForm() {
  const form = document.getElementById("form-checkin");
  if (form) form.reset();
  const errEl = document.getElementById("checkin-validation-error");
  if (errEl) {
    errEl.textContent = "";
    errEl.classList.add("hidden");
  }
  const submitBtn = document.getElementById("btn-checkin-submit");
  if (submitBtn) {
    submitBtn.disabled = false;
    submitBtn.textContent = "Submit Check In";
  }
}

/** Helper to get normalized visitor email from a record */
function getVisitorEmail(v) {
  if (!v) return "";
  return (v.email || v.asuId_or_email || "").trim().toLowerCase();
}

/** Form submission handler */
async function handleCheckInSubmit(event) {
  event.preventDefault();
  const submitBtn = document.getElementById("btn-checkin-submit");
  const errEl = document.getElementById("checkin-validation-error");
  errEl.classList.add("hidden");

  // Read and trim inputs
  const nameInput = document.getElementById("checkin-name").value.trim();
  const emailInput = document.getElementById("checkin-email").value.trim();
  const roomInput = document.getElementById("checkin-room").value;

  // Validate inputs
  if (!nameInput) {
    showFormError(errEl, "Please enter your full name.");
    return;
  }
  if (!emailInput || !emailInput.includes("@") || !emailInput.includes(".")) {
    showFormError(errEl, "Please enter a valid email address.");
    return;
  }
  if (!roomInput || !ROOMS.includes(roomInput)) {
    showFormError(errEl, "Please select a valid studio from the dropdown.");
    return;
  }

  // Prevent double-submit
  submitBtn.disabled = true;
  submitBtn.textContent = "Checking...";

  const normalizedEmail = emailInput.toLowerCase();

  try {
    const allVisits = await getAllRecords("visits");

    // Check 1: Duplicate active check-in rule:
    // Prevent duplicate active check-ins for the same person (offer to check out instead).
    const activeVisit = allVisits.find((v) => {
      return getVisitorEmail(v) === normalizedEmail && v.status === "active";
    });

    if (activeVisit) {
      submitBtn.disabled = false;
      submitBtn.textContent = "Submit Check In";
      showDuplicateActiveModal(activeVisit);
      return;
    }

    // Check 2: Missed checkout rule:
    // If they have any previous visit with status active/missed_checkout, show full-screen warning:
    // "You did not check out last time on <date>. Please always check out when your appointment is done."
    // Require tap on "I understand" before continuing, then increment missedCheckoutCount and set warningShown = true.
    const missedVisit = allVisits
      .filter((v) => {
        return (
          getVisitorEmail(v) === normalizedEmail &&
          (v.status === "missed_checkout" || v.status === "active") &&
          v.warningShown !== true
        );
      })
      .sort((a, b) => new Date(b.checkInAt).getTime() - new Date(a.checkInAt).getTime())[0];

    if (missedVisit) {
      // Store pending check-in parameters to execute after user taps "I understand"
      pendingCheckInData = {
        name: nameInput,
        email: normalizedEmail,
        room: roomInput,
        missedVisit: missedVisit
      };

      submitBtn.disabled = false;
      submitBtn.textContent = "Submit Check In";
      showMissedCheckoutWarning(missedVisit);
      return;
    }

    // Direct Check In (no missed checkouts)
    await completeCheckIn({
      name: nameInput,
      email: normalizedEmail,
      room: roomInput
    });

  } catch (error) {
    console.error("Check-in error:", error);
    submitBtn.disabled = false;
    submitBtn.textContent = "Submit Check In";
    showFormError(errEl, "Unable to complete check in. Please try again.");
  }
}

function showFormError(el, message) {
  if (!el) return;
  el.textContent = message;
  el.classList.remove("hidden");
}

/** Show duplicate active check-in modal */
function showDuplicateActiveModal(visit) {
  const roomEl = document.getElementById("duplicate-room-name");
  const timeEl = document.getElementById("duplicate-checkin-time");
  if (roomEl) roomEl.textContent = visit.room;
  if (timeEl) {
    timeEl.textContent = new Date(visit.checkInAt).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true
    });
  }

  // Setup button handlers
  const checkoutNowBtn = document.getElementById("btn-duplicate-checkout-now");
  checkoutNowBtn.onclick = () => {
    hideElement("overlay-duplicate-active");
    resetCheckInForm();
    showScreen("screen-checkout");
    openInspectionModal(visit);
  };

  const cancelBtn = document.getElementById("btn-duplicate-cancel");
  cancelBtn.onclick = () => {
    hideElement("overlay-duplicate-active");
    resetCheckInForm();
    showScreen("screen-home");
  };

  showElement("overlay-duplicate-active");
}

/** Show missed checkout warning overlay */
function showMissedCheckoutWarning(missedVisit) {
  const dateEl = document.getElementById("warning-missed-date");
  if (dateEl) {
    const d = new Date(missedVisit.checkInAt);
    dateEl.textContent = d.toLocaleDateString("en-US", {
      weekday: "long",
      month: "short",
      day: "numeric",
      year: "numeric"
    });
  }

  showElement("overlay-missed-warning");
}

/** User acknowledged warning by tapping "I understand" */
async function handleWarningUnderstood() {
  hideElement("overlay-missed-warning");

  if (!pendingCheckInData) {
    showScreen("screen-home");
    return;
  }

  const { name, email, room, missedVisit } = pendingCheckInData;

  try {
    // Atomic transaction across visits and people
    await runAtomicTransaction(["visits", "people"], "readwrite", (tx) => {
      const visitStore = tx.objectStore("visits");
      const peopleStore = tx.objectStore("people");

      // 1. Update missed visit record: warningShown = true, status = missed_checkout
      if (missedVisit) {
        missedVisit.status = "missed_checkout";
        missedVisit.warningShown = true;
        visitStore.put(missedVisit);
      }

      // 2. Lookup & update person record: increment missedCheckoutCount
      const personReq = peopleStore.get(email);
      personReq.onsuccess = () => {
        let person = personReq.result;
        if (!person) {
          person = {
            email: email,
            name: name,
            missedCheckoutCount: 1,
            lastVisitAt: new Date().toISOString()
          };
        } else {
          person.name = name;
          person.missedCheckoutCount = (person.missedCheckoutCount || 0) + 1;
          person.lastVisitAt = new Date().toISOString();
        }
        peopleStore.put(person);
      };

      // 3. Add new active visit record
      const newVisit = {
        name: name,
        email: email,
        room: room,
        checkInAt: new Date().toISOString(),
        checkOutAt: null,
        status: "active",
        damage: "none",
        damageNotes: "",
        warningShown: false
      };
      visitStore.add(newVisit);
    });

    pendingCheckInData = null;
    resetCheckInForm();
    showConfirmation("Check In Successful", `Welcome, ${name}! You are checked in to ${room}.`);

  } catch (error) {
    console.error("Failed to complete check in after warning:", error);
    showSystemError("Failed to record check in: " + error.message);
  }
}

/** Standard check in completion (without warning) */
async function completeCheckIn({ name, email, room }) {
  await runAtomicTransaction(["visits", "people"], "readwrite", (tx) => {
    const visitStore = tx.objectStore("visits");
    const peopleStore = tx.objectStore("people");

    // Update people store
    const personReq = peopleStore.get(email);
    personReq.onsuccess = () => {
      let person = personReq.result;
      if (!person) {
        person = {
          email: email,
          name: name,
          missedCheckoutCount: 0,
          lastVisitAt: new Date().toISOString()
        };
      } else {
        person.name = name;
        person.lastVisitAt = new Date().toISOString();
      }
      peopleStore.put(person);
    };

    // Add new visit
    const newVisit = {
      name: name,
      email: email,
      room: room,
      checkInAt: new Date().toISOString(),
      checkOutAt: null,
      status: "active",
      damage: "none",
      damageNotes: "",
      warningShown: false
    };
    visitStore.add(newVisit);
  });

  resetCheckInForm();
  showConfirmation("Check In Successful", `Welcome, ${name}! You are checked in to ${room}.`);
}

// ==========================================================================
// 8. CHECK OUT FLOW
// ==========================================================================

async function loadActiveVisitors(searchFilter = "") {
  const container = document.getElementById("active-visitors-container");
  if (!container) return;

  const allVisits = await getAllRecords("visits");
  const activeVisits = allVisits.filter((v) => v.status === "active");

  const query = searchFilter.toLowerCase().trim();
  const filtered = activeVisits.filter((v) => {
    if (!query) return true;
    return (
      v.name.toLowerCase().includes(query) ||
      getVisitorEmail(v).includes(query) ||
      v.room.toLowerCase().includes(query)
    );
  });

  container.innerHTML = "";

  if (filtered.length === 0) {
    const emptyDiv = document.createElement("div");
    emptyDiv.className = "empty-state";
    emptyDiv.textContent = query
      ? "No matching checked-in visitors found."
      : "No active check-ins found. All studios are currently vacant.";
    container.appendChild(emptyDiv);
    return;
  }

  filtered.forEach((visit) => {
    const card = document.createElement("div");
    card.className = "visitor-card";

    const checkInTimeFormatted = new Date(visit.checkInAt).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true
    });

    card.innerHTML = `
      <div class="visitor-card-info">
        <div class="visitor-card-name">${escapeHtml(visit.name)}</div>
        <div class="visitor-card-meta">
          <span class="visitor-card-room">${escapeHtml(visit.room)}</span>
          <span>Checked in at ${checkInTimeFormatted}</span>
        </div>
      </div>
      <button type="button" class="btn-card-select">Check Out</button>
    `;

    card.addEventListener("click", () => {
      openInspectionModal(visit);
    });

    container.appendChild(card);
  });
}

function openInspectionModal(visit) {
  selectedVisitForCheckout = visit;

  const nameEl = document.getElementById("inspect-visitor-name");
  const metaEl = document.getElementById("inspect-visitor-meta");
  const notesField = document.getElementById("damage-notes-field");
  const notesInput = document.getElementById("checkout-damage-notes");
  const notesError = document.getElementById("damage-notes-error");
  const submitBtn = document.getElementById("btn-checkout-confirm-submit");

  if (nameEl) nameEl.textContent = visit.name;
  if (metaEl) {
    const checkInFormatted = new Date(visit.checkInAt).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true
    });
    metaEl.textContent = `${visit.room} • Checked in at ${checkInFormatted}`;
  }

  // Reset damage toggles to "No"
  setDamageToggle(false);
  if (notesField) notesField.classList.add("hidden");
  if (notesInput) notesInput.value = "";
  if (notesError) notesError.classList.add("hidden");
  if (submitBtn) {
    submitBtn.disabled = false;
    submitBtn.textContent = "Complete Check Out";
  }

  showElement("overlay-checkout-inspect");
}

function setDamageToggle(hasDamage) {
  const btnNo = document.getElementById("btn-damage-no");
  const btnYes = document.getElementById("btn-damage-yes");
  const notesField = document.getElementById("damage-notes-field");
  const notesError = document.getElementById("damage-notes-error");

  if (hasDamage) {
    btnYes.classList.add("active");
    btnNo.classList.remove("active");
    if (notesField) notesField.classList.remove("hidden");
  } else {
    btnNo.classList.add("active");
    btnYes.classList.remove("active");
    if (notesField) notesField.classList.add("hidden");
    if (notesError) notesError.classList.add("hidden");
  }
}

async function handleCheckoutInspectionSubmit() {
  if (!selectedVisitForCheckout) return;

  const submitBtn = document.getElementById("btn-checkout-confirm-submit");
  const btnYes = document.getElementById("btn-damage-yes");
  const notesInput = document.getElementById("checkout-damage-notes");
  const notesError = document.getElementById("damage-notes-error");

  const hasDamage = btnYes.classList.contains("active");
  const damageNotes = notesInput ? notesInput.value.trim() : "";

  if (hasDamage && !damageNotes) {
    if (notesError) notesError.classList.remove("hidden");
    return;
  }
  if (notesError) notesError.classList.add("hidden");

  // Prevent double-submit
  submitBtn.disabled = true;
  submitBtn.textContent = "Processing...";

  try {
    const visitToUpdate = selectedVisitForCheckout;

    // Atomic update
    await runAtomicTransaction(["visits"], "readwrite", (tx) => {
      const visitStore = tx.objectStore("visits");
      visitToUpdate.checkOutAt = new Date().toISOString();
      visitToUpdate.status = "completed";
      visitToUpdate.damage = hasDamage ? "reported" : "none";
      visitToUpdate.damageNotes = hasDamage ? damageNotes : "";
      visitStore.put(visitToUpdate);
    });

    hideElement("overlay-checkout-inspect");
    selectedVisitForCheckout = null;

    showConfirmation(
      "Check Out Complete",
      hasDamage
        ? "You have been checked out. Thank you for reporting the issue to staff."
        : "You have been checked out. Thank you for visiting the Zoom Innovation Lab!"
    );

  } catch (err) {
    console.error("Check out failure:", err);
    submitBtn.disabled = false;
    submitBtn.textContent = "Complete Check Out";
    showSystemError("Check out failed: " + err.message);
  }
}

// ==========================================================================
// 9. CONFIRMATION SCREEN
// ==========================================================================

function showConfirmation(title, message) {
  const titleEl = document.getElementById("conf-title");
  const msgEl = document.getElementById("conf-message");
  const countdownEl = document.getElementById("conf-countdown");

  if (titleEl) titleEl.textContent = title;
  if (msgEl) msgEl.textContent = message;

  let secondsLeft = 4;
  if (countdownEl) countdownEl.textContent = secondsLeft;

  showElement("overlay-confirmation");

  if (confirmationTimer) clearInterval(confirmationTimer);

  confirmationTimer = setInterval(() => {
    secondsLeft -= 1;
    if (countdownEl) countdownEl.textContent = secondsLeft;
    if (secondsLeft <= 0) {
      dismissConfirmation();
    }
  }, 1000);
}

function dismissConfirmation() {
  if (confirmationTimer) {
    clearInterval(confirmationTimer);
    confirmationTimer = null;
  }
  hideElement("overlay-confirmation");
  showScreen("screen-home");
}

// ==========================================================================
// 10. STAFF AUTHORIZATION (PIN MODAL)
// ==========================================================================

function openPinModal() {
  resetPinModal();
  showElement("overlay-staff-pin");
}

function resetPinModal() {
  enteredPin = "";
  updatePinDots();
  const err = document.getElementById("pin-error-message");
  if (err) err.classList.add("hidden");
}

function updatePinDots() {
  for (let i = 1; i <= 4; i++) {
    const dot = document.getElementById(`pin-dot-${i}`);
    if (!dot) continue;
    if (i <= enteredPin.length) {
      dot.classList.add("filled");
    } else {
      dot.classList.remove("filled");
    }
  }
}

function handlePinDigit(digit) {
  if (enteredPin.length >= 4) return;
  enteredPin += digit;
  updatePinDots();

  if (enteredPin.length === 4) {
    // Check PIN
    setTimeout(() => {
      if (enteredPin === STAFF_PIN) {
        hideElement("overlay-staff-pin");
        resetPinModal();
        openStaffDashboard();
      } else {
        const err = document.getElementById("pin-error-message");
        if (err) err.classList.remove("hidden");
        enteredPin = "";
        updatePinDots();
      }
    }, 150);
  }
}

// ==========================================================================
// 11. STAFF DASHBOARD
// ==========================================================================

async function openStaffDashboard() {
  showScreen("screen-staff");
  await refreshStaffDashboard();
}

async function refreshStaffDashboard() {
  await updateBackupAlertBanner();
  await updateStorageEstimate();
  await renderStaffActiveSessions();
  await renderStaffDamageReports();
  await renderStaffOffenders();
}

/**
 * Backup date check: Red alert banner if older than 7 days or never backed up
 */
async function updateBackupAlertBanner() {
  const bannerContainer = document.getElementById("staff-backup-banner");
  const lastBackupText = document.getElementById("staff-last-backup-text");
  if (!bannerContainer) return;

  const metaRecord = await getRecord("meta", "lastBackupAt");
  const lastBackupAt = metaRecord ? metaRecord.value : null;

  if (!lastBackupAt) {
    bannerContainer.innerHTML = `
      <div class="backup-banner-alert">
        <span>Warning: Data has never been backed up! Please export a backup immediately to prevent data loss.</span>
      </div>
    `;
    if (lastBackupText) lastBackupText.textContent = "Never";
    return;
  }

  const lastDate = new Date(lastBackupAt);
  const diffDays = (Date.now() - lastDate.getTime()) / (1000 * 60 * 60 * 24);
  const formattedDate = lastDate.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true
  });

  if (lastBackupText) lastBackupText.textContent = formattedDate;

  if (diffDays >= BACKUP_ALERT_DAYS) {
    bannerContainer.innerHTML = `
      <div class="backup-banner-alert">
        <span>Warning: Data has not been backed up in over 7 days (Last backup: ${formattedDate}). Please export a backup immediately.</span>
      </div>
    `;
  } else {
    bannerContainer.innerHTML = `
      <div class="backup-banner-normal">
        <span>Backup status: Up to date (Last exported: ${formattedDate})</span>
      </div>
    `;
  }
}

/** Storage usage estimate using navigator.storage.estimate() */
async function updateStorageEstimate() {
  const el = document.getElementById("staff-storage-info");
  if (!el) return;

  if (navigator.storage && navigator.storage.estimate) {
    try {
      const estimate = await navigator.storage.estimate();
      const usedMB = (estimate.usage / (1024 * 1024)).toFixed(2);
      const quotaMB = (estimate.quota / (1024 * 1024)).toFixed(0);
      const percent = ((estimate.usage / estimate.quota) * 100).toFixed(2);
      el.textContent = `${usedMB} MB of ${quotaMB} MB used (${percent}%)`;
    } catch (e) {
      el.textContent = "Estimate unavailable";
    }
  } else {
    el.textContent = "Storage API not supported";
  }
}

/** Tab 1: Live Active Sessions */
async function renderStaffActiveSessions() {
  const container = document.getElementById("staff-active-table-container");
  const countEl = document.getElementById("staff-active-count");
  if (!container) return;

  const allVisits = await getAllRecords("visits");
  const activeVisits = allVisits.filter((v) => v.status === "active");

  if (countEl) countEl.textContent = activeVisits.length;

  if (activeVisits.length === 0) {
    container.innerHTML = '<div class="empty-state">No visitors currently active.</div>';
    return;
  }

  let html = `
    <table class="staff-table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Email</th>
          <th>Studio</th>
          <th>Check-in Time</th>
          <th>Action</th>
        </tr>
      </thead>
      <tbody>
  `;

  activeVisits.forEach((visit) => {
    const timeFormatted = new Date(visit.checkInAt).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true
    });

    html += `
      <tr>
        <td><strong>${escapeHtml(visit.name)}</strong></td>
        <td>${escapeHtml(getVisitorEmail(visit))}</td>
        <td>${escapeHtml(visit.room)}</td>
        <td>${timeFormatted}</td>
        <td>
          <button type="button" class="btn-table-action btn-maroon" data-visit-id="${visit.id}">
            Force Check Out
          </button>
        </td>
      </tr>
    `;
  });

  html += "</tbody></table>";
  container.innerHTML = html;

  // Add event listeners for force checkout
  container.querySelectorAll("button[data-visit-id]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const visitId = Number(btn.getAttribute("data-visit-id"));
      const visitToCheckout = activeVisits.find((v) => v.id === visitId);
      if (visitToCheckout) {
        if (confirm(`Check out ${visitToCheckout.name} from ${visitToCheckout.room}?`)) {
          await forceCheckOutVisit(visitToCheckout);
        }
      }
    });
  });
}

async function forceCheckOutVisit(visit) {
  await runAtomicTransaction(["visits"], "readwrite", (tx) => {
    const visitStore = tx.objectStore("visits");
    visit.checkOutAt = new Date().toISOString();
    visit.status = "completed";
    visit.damage = "none";
    visit.damageNotes = "Force checked out by staff";
    visitStore.put(visit);
  });

  await refreshStaffDashboard();
}

/** Tab 2: Damage Reports */
async function renderStaffDamageReports() {
  const container = document.getElementById("staff-damage-container");
  const countEl = document.getElementById("staff-damage-count");
  if (!container) return;

  const allVisits = await getAllRecords("visits");
  const damageVisits = allVisits
    .filter((v) => v.damage === "reported")
    .sort((a, b) => new Date(b.checkOutAt || b.checkInAt).getTime() - new Date(a.checkOutAt || a.checkInAt).getTime());

  if (countEl) countEl.textContent = damageVisits.length;

  if (damageVisits.length === 0) {
    container.innerHTML = '<div class="empty-state">No damage or equipment issues reported.</div>';
    return;
  }

  container.innerHTML = "";

  damageVisits.forEach((visit) => {
    const dateFormatted = new Date(visit.checkOutAt || visit.checkInAt).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true
    });

    const card = document.createElement("div");
    card.className = "damage-card";
    card.innerHTML = `
      <div class="damage-card-header">
        <div class="damage-card-room">${escapeHtml(visit.room)}</div>
        <div class="damage-card-date">${dateFormatted}</div>
      </div>
      <div class="damage-card-user">Reported by: ${escapeHtml(visit.name)} (${escapeHtml(getVisitorEmail(visit))})</div>
      <div class="damage-card-notes">${escapeHtml(visit.damageNotes || "No details provided")}</div>
    `;
    container.appendChild(card);
  });
}

/** Tab 4: Repeat Missed-Checkout Offenders */
async function renderStaffOffenders() {
  const container = document.getElementById("staff-offenders-container");
  if (!container) return;

  const people = await getAllRecords("people");
  const allVisits = await getAllRecords("visits");

  // Also count actual missed_checkout visits to ensure complete tracking
  const missedCountsByPerson = {};
  allVisits.forEach((v) => {
    if (v.status === "missed_checkout") {
      const emailKey = getVisitorEmail(v);
      missedCountsByPerson[emailKey] = (missedCountsByPerson[emailKey] || 0) + 1;
    }
  });

  // Merge counts
  const offenders = people
    .map((p) => {
      const emailKey = getVisitorEmail(p);
      const visitCount = missedCountsByPerson[emailKey] || 0;
      const count = Math.max(p.missedCheckoutCount || 0, visitCount);
      return {
        name: p.name,
        email: emailKey,
        missedCheckoutCount: count,
        lastVisitAt: p.lastVisitAt
      };
    })
    .filter((p) => p.missedCheckoutCount > 0)
    .sort((a, b) => b.missedCheckoutCount - a.missedCheckoutCount);

  if (offenders.length === 0) {
    container.innerHTML = '<div class="empty-state">No repeat missed-checkout offenders recorded.</div>';
    return;
  }

  let html = `
    <table class="staff-table">
      <thead>
        <tr>
          <th>Visitor Name</th>
          <th>Email</th>
          <th>Missed Checkouts</th>
          <th>Last Visit</th>
        </tr>
      </thead>
      <tbody>
  `;

  offenders.forEach((p) => {
    const lastVisitFormatted = p.lastVisitAt
      ? new Date(p.lastVisitAt).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric"
        })
      : "Unknown";

    html += `
      <tr>
        <td><strong>${escapeHtml(p.name)}</strong></td>
        <td>${escapeHtml(p.email)}</td>
        <td><strong>${p.missedCheckoutCount}</strong></td>
        <td>${lastVisitFormatted}</td>
      </tr>
    `;
  });

  html += "</tbody></table>";
  container.innerHTML = html;
}

// ==========================================================================
// 12. DATA EXPORT & IMPORT (BACKUP / RESTORE)
// ==========================================================================

/** Export visits as CSV */
async function exportDataAsCsv() {
  const visits = await getAllRecords("visits");

  const headers = [
    "id",
    "name",
    "email",
    "room",
    "checkInAt",
    "checkOutAt",
    "status",
    "damage",
    "damageNotes",
    "warningShown"
  ];

  let csvContent = headers.join(",") + "\n";

  visits.forEach((v) => {
    const row = headers.map((key) => {
      const val = (key === "email") ? getVisitorEmail(v) : v[key];
      if (val === null || val === undefined) return '""';
      const escaped = String(val).replace(/"/g, '""');
      return `"${escaped}"`;
    });
    csvContent += row.join(",") + "\n";
  });

  downloadFile(
    csvContent,
    `zil-visits-backup-${formatDateForFilename(new Date())}.csv`,
    "text/csv;charset=utf-8;"
  );

  // Set meta.lastBackupAt after each export
  await setLastBackupTimestamp();
  await updateBackupAlertBanner();
}

/** Export full database as JSON */
async function exportDataAsJson() {
  const visits = await getAllRecords("visits");
  const people = await getAllRecords("people");
  const meta = await getAllRecords("meta");

  const exportPayload = {
    version: 1,
    appName: "Zoom Innovation Lab Kiosk",
    exportedAt: new Date().toISOString(),
    visits: visits,
    people: people,
    meta: meta
  };

  const jsonString = JSON.stringify(exportPayload, null, 2);

  downloadFile(
    jsonString,
    `zil-kiosk-full-backup-${formatDateForFilename(new Date())}.json`,
    "application/json"
  );

  // Set meta.lastBackupAt after each export
  await setLastBackupTimestamp();
  await updateBackupAlertBanner();
}

/** Set lastBackupAt in meta store atomically */
async function setLastBackupTimestamp() {
  const timestamp = new Date().toISOString();
  await runAtomicTransaction(["meta"], "readwrite", (tx) => {
    const metaStore = tx.objectStore("meta");
    metaStore.put({ key: "lastBackupAt", value: timestamp });
  });
}

/** Trigger file download in browser */
function downloadFile(content, fileName, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function formatDateForFilename(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
}

/** Restore database from JSON backup file */
async function handleRestoreFile(event) {
  const fileInput = event.target;
  const file = fileInput.files?.[0];
  const statusEl = document.getElementById("restore-status-message");

  if (!file) return;

  try {
    const text = await file.text();
    const data = JSON.parse(text);

    if (!data.visits || !Array.isArray(data.visits)) {
      throw new Error("Invalid backup file: 'visits' list missing or corrupt.");
    }

    const confirmRestore = confirm(
      `Restore data from backup (${data.visits.length} visits found)? Existing records with matching IDs will be overwritten.`
    );
    if (!confirmRestore) {
      fileInput.value = "";
      return;
    }

    if (statusEl) {
      statusEl.textContent = "Restoring database records...";
      statusEl.style.color = "var(--asu-maroon)";
    }

    // Atomic multi-store restore
    await runAtomicTransaction(["visits", "people", "meta"], "readwrite", (tx) => {
      const visitStore = tx.objectStore("visits");
      const peopleStore = tx.objectStore("people");
      const metaStore = tx.objectStore("meta");

      // Import visits
      data.visits.forEach((v) => {
        visitStore.put(v);
      });

      // Import people if present
      if (Array.isArray(data.people)) {
        data.people.forEach((p) => {
          peopleStore.put(p);
        });
      }

      // Import meta
      if (Array.isArray(data.meta)) {
        data.meta.forEach((m) => {
          metaStore.put(m);
        });
      }
    });

    if (statusEl) {
      statusEl.textContent = "Database restored successfully!";
      statusEl.style.color = "var(--color-success)";
    }

    fileInput.value = "";
    await refreshStaffDashboard();

  } catch (err) {
    console.error("Restore error:", err);
    if (statusEl) {
      statusEl.textContent = "Restore failed: " + err.message;
      statusEl.style.color = "var(--color-error)";
    }
    fileInput.value = "";
  }
}

// ==========================================================================
// 13. UI EVENT LISTENERS INITIALIZATION
// ==========================================================================

function setupEventListeners() {
  // Global Error Dismiss
  document.getElementById("btn-dismiss-error")?.addEventListener("click", hideSystemError);

  // Home Screen Buttons
  document.getElementById("btn-home-checkin")?.addEventListener("click", () => {
    resetCheckInForm();
    showScreen("screen-checkin");
  });

  document.getElementById("btn-home-checkout")?.addEventListener("click", async () => {
    const searchInput = document.getElementById("checkout-search-input");
    if (searchInput) searchInput.value = "";
    hideElement("btn-checkout-clear-search");
    showScreen("screen-checkout");
    await loadActiveVisitors();
  });

  document.getElementById("btn-home-staff-access")?.addEventListener("click", openPinModal);

  // Check In Screen Buttons
  document.getElementById("btn-checkin-back")?.addEventListener("click", () => {
    resetCheckInForm();
    showScreen("screen-home");
  });

  document.getElementById("btn-checkin-cancel")?.addEventListener("click", () => {
    resetCheckInForm();
    showScreen("screen-home");
  });

  document.getElementById("form-checkin")?.addEventListener("submit", handleCheckInSubmit);

  // Missed Checkout Warning Overlay
  document.getElementById("btn-warning-understand")?.addEventListener("click", handleWarningUnderstood);

  // Check Out Screen
  document.getElementById("btn-checkout-back")?.addEventListener("click", () => {
    showScreen("screen-home");
  });

  const searchInput = document.getElementById("checkout-search-input");
  const clearSearchBtn = document.getElementById("btn-checkout-clear-search");

  searchInput?.addEventListener("input", (e) => {
    const val = e.target.value;
    if (val.trim()) {
      clearSearchBtn?.classList.remove("hidden");
    } else {
      clearSearchBtn?.classList.add("hidden");
    }
    loadActiveVisitors(val);
  });

  clearSearchBtn?.addEventListener("click", () => {
    if (searchInput) searchInput.value = "";
    clearSearchBtn.classList.add("hidden");
    loadActiveVisitors("");
  });

  // Inspection Modal Toggles & Buttons
  document.getElementById("btn-damage-no")?.addEventListener("click", () => setDamageToggle(false));
  document.getElementById("btn-damage-yes")?.addEventListener("click", () => setDamageToggle(true));

  document.getElementById("btn-checkout-inspect-cancel")?.addEventListener("click", () => {
    hideElement("overlay-checkout-inspect");
    selectedVisitForCheckout = null;
  });

  document.getElementById("btn-checkout-confirm-submit")?.addEventListener("click", handleCheckoutInspectionSubmit);

  // Confirmation Done Button
  document.getElementById("btn-conf-done")?.addEventListener("click", dismissConfirmation);

  // Staff PIN Keypad Buttons
  document.querySelectorAll(".btn-pin-key[data-digit]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const digit = btn.getAttribute("data-digit");
      if (digit !== null) handlePinDigit(digit);
    });
  });

  document.getElementById("btn-pin-clear")?.addEventListener("click", resetPinModal);

  document.getElementById("btn-pin-cancel")?.addEventListener("click", () => {
    hideElement("overlay-staff-pin");
    resetPinModal();
  });

  // Staff Dashboard Tabs
  document.querySelectorAll(".staff-tab-btn").forEach((tabBtn) => {
    tabBtn.addEventListener("click", () => {
      document.querySelectorAll(".staff-tab-btn").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".staff-tab-pane").forEach((p) => {
        p.classList.add("hidden");
        p.classList.remove("active");
      });

      tabBtn.classList.add("active");
      const targetPane = document.getElementById(tabBtn.getAttribute("data-tab"));
      if (targetPane) {
        targetPane.classList.remove("hidden");
        targetPane.classList.add("active");
      }
    });
  });

  document.getElementById("btn-staff-exit")?.addEventListener("click", () => {
    showScreen("screen-home");
  });

  // Staff Export & Restore Buttons
  document.getElementById("btn-export-csv")?.addEventListener("click", exportDataAsCsv);
  document.getElementById("btn-export-json")?.addEventListener("click", exportDataAsJson);
  document.getElementById("input-restore-file")?.addEventListener("change", handleRestoreFile);
}

// ==========================================================================
// 14. HELPER UTILITIES
// ==========================================================================

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ==========================================================================
// 15. INITIALIZATION
// ==========================================================================

async function initApp() {
  try {
    // 1. Initialize IndexedDB
    await initDatabase();

    // 2. Request persistent storage for offline iPad reliability
    await requestPersistentStorage();

    // 3. Convert stale sessions from previous calendar days to missed_checkout
    await processPreviousDayMissedCheckouts();

    // 4. Setup UI components
    populateRoomDropdown();
    setupEventListeners();
    setupInactivityListeners();

    // 5. Header clock
    updateHeaderClock();
    setInterval(updateHeaderClock, 1000);

    // 6. Register service worker for offline PWA functionality
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("service-worker.js").catch((err) => {
        console.warn("Service worker registration skipped or failed:", err);
      });
    }

    console.log("Zoom Innovation Lab Kiosk initialized successfully.");
  } catch (err) {
    console.error("App initialization failed:", err);
    showSystemError("Initialization error: " + (err.message || "Unknown error"));
  }
}

// Run on DOM load
window.addEventListener("DOMContentLoaded", initApp);
