# Zoom Innovation Lab (ZIL) - Check-In/Check-Out Kiosk

A simple, offline-first check-in/check-out kiosk web application built for the Zoom Innovation Lab (ZIL) at Arizona State University's Creativity Commons, Tempe. Designed specifically for full-screen iPad kiosk operation in the lab.

---

## Features

- **Strict ASU & ZIL Branding**: Uses official ASU maroon (`#8C1D40`), gold (`#FFC627`), and dark neutral palette. Includes official ASU vertical brand logo cached for offline reliability. No emojis or icon libraries.
- **Offline-First PWA**: Powered by IndexedDB and a Service Worker cache. Works without an active internet connection.
- **iPad Kiosk Ergonomics**:
  - Minimum 48px touch targets (large 60px–120px buttons).
  - High-contrast typography.
  - Text selection disabled across all screens (form fields remain editable).
  - 30-second inactivity timer automatically returns the kiosk to the Home screen.
  - Double-submit prevention on all forms and action buttons.
- **Configurable Studios**:
  1. Studio 1 (Room 133) - Podcasting Studio
  2. Studio 2 (Room 134) - Streaming Studio
  3. Studio 3 (Room 135) - Streaming Studio
  4. Studio 4 (Room 140) - Zoom Innovation Lab
- **Data Model (IndexedDB)**:
  - `visits`: Stores visit records with `id`, `name`, `asuId_or_email`, `room`, `purpose`, `checkInAt`, `checkOutAt`, `status`, `damage`, `damageNotes`, `warningShown`.
  - `people`: Keyed by `asuId_or_email` tracking `name`, `missedCheckoutCount`, and `lastVisitAt`.
  - `meta`: Key-value store tracking `lastBackupAt` and settings.
- **Check-In Validation & Missed Checkout Warning**:
  - Automatically flags previous-calendar-day active sessions as `missed_checkout` on app load.
  - Prevents duplicate active check-ins for the same person (prompts to check out instead).
  - Shows full-screen warning if a user previously missed check-out: *"You did not check out last time on [date]. Please always check out when your appointment is done."* Requires tapping *"I understand"* to continue.
- **Check-Out & Room Inspection**:
  - Real-time searchable list of currently active visitors.
  - Asks *"Any damage or issues in the room?"* (Yes/No). If Yes, requires an explanation note.
- **Staff Dashboard (Protected by 4-digit PIN)**:
  - Default PIN: `1234` (configurable at top of `app.js`).
  - Live active sessions list with manual force check-out.
  - Damage and issue reports list.
  - Repeat missed-checkout offenders list.
  - Storage usage indicator (`navigator.storage.estimate()`).
  - Red alert banner if data has not been backed up in over 7 days.
  - Full CSV export and JSON backup/restore.

---

## File Structure

```text
check-in-out-system/
├── index.html               # Main kiosk interface and screen containers
├── styles.css               # Touch-first ASU styles, high contrast layout
├── app.js                   # Application logic, IndexedDB layer, kiosk timers
├── manifest.json            # PWA web app manifest for standalone iPad install
├── service-worker.js        # Offline asset caching and service worker lifecycle
├── README.md                # Documentation and setup instructions
├── assets/
│   └── arizona-state-university-logo-vertical.png   # Downloaded ASU header logo
└── icons/
    ├── icon-192.png         # [Place user-provided 192x192 PNG icon here]
    └── icon-512.png         # [Place user-provided 512x512 PNG icon here]
```

---

## Icon Files

The web app manifest references home screen icons at:
- `icons/icon-192.png` (192x192 pixels)
- `icons/icon-512.png` (512x512 pixels)

Place your custom 192x192 and 512x512 PNG icon files directly into the `/icons/` directory. If they are not yet provided, the app will continue to function normally offline.

---

## Running Locally

To test or run the kiosk locally:

```bash
# Start a local web server on port 8000
python3 -m http.server 8000
```

Open `http://localhost:8000` in Safari or Chrome.

---

## Hosting on GitHub Pages (Recommended)

GitHub Pages provides free, automatic HTTPS hosting, which is required for PWAs, Service Workers, and iPad Home Screen installation.

### Step 1: Create a Repository on GitHub
1. Log in to [GitHub](https://github.com).
2. Click the **+** (plus) icon in the top-right corner and select **New repository**.
3. Name your repository (for example: `zil-kiosk` or `check-in-out-system`).
4. Choose **Public** (or **Private** if you have a GitHub Pro / Enterprise account that supports private Pages).
5. **Do not** check "Initialize this repository with a README" (your local project already has one).
6. Click **Create repository**.

### Step 2: Push Local Code to GitHub
In your terminal, within this project directory:

```bash
# 1. Add your GitHub repository as the remote origin
# (Replace YOUR_USERNAME and YOUR_REPO with your actual GitHub username and repo name)
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git

# 2. Push the main branch
git push -u origin main
```

### Step 3: Enable GitHub Pages
1. Go to your repository on GitHub.
2. Click **Settings** (gear tab near the top).
3. In the left sidebar, click **Pages** (under the "Code and automation" section).
4. Under **Build and deployment**:
   - **Source**: Select `Deploy from a branch`.
   - **Branch**: Select `main` from the dropdown, and leave the folder as `/(root)`.
5. Click **Save**.
6. Wait 1–2 minutes for GitHub Actions to build and deploy. Refresh the Pages settings page until you see:
   > *"Your site is live at `https://YOUR_USERNAME.github.io/YOUR_REPO/`"*

### Step 4: Open on iPad and Install
1. Open **Safari** on the iPad and go to `https://YOUR_USERNAME.github.io/YOUR_REPO/`.
2. Tap the **Share** button (box with upward arrow) and select **Add to Home Screen**.
3. Follow the Guided Access setup below to lock the iPad in kiosk mode.

### Future Updates
Whenever you make changes to files:
```bash
git add .
git commit -m "Describe your update"
git push
```
GitHub Pages will automatically rebuild and publish the update within 1–2 minutes. Due to the Service Worker caching, devices will receive the update automatically on their next refresh.

---

## iPad Setup: Add to Home Screen

1. Open **Safari** on the iPad and navigate to the hosted HTTPS URL.
2. Tap the **Share** button (the square with an upward arrow in Safari's toolbar).
3. Scroll down and tap **Add to Home Screen**.
4. Set the name to **ZIL Kiosk** (or keep default) and tap **Add**.
5. The app will appear on the iPad home screen as a standalone app without browser URL bars or navigation buttons.
6. Tap the icon to launch in full-screen standalone mode (supports both portrait and landscape orientations).

---

## iPad Setup: Enable Guided Access (Kiosk Lockdown)

Guided Access locks the iPad to the ZIL Kiosk app, prevents visitors from exiting to the home screen, and disables hardware buttons.

### Initial Setup
1. On the iPad, open **Settings**.
2. Go to **Accessibility** > **Guided Access**.
3. Toggle **Guided Access** to **ON**.
4. Tap **Passcode Settings** > **Set Guided Access Passcode** (enter a secure 4 or 6-digit passcode known only to lab staff).

### Launching Guided Access
1. Open the **ZIL Kiosk** app from the iPad Home Screen.
2. **Triple-click** the top button (or Home button on older iPads).
3. In the Guided Access setup screen, verify hardware buttons (Sleep/Wake, Volume) are disabled.
4. Tap **Start** in the top-right corner.
5. The iPad is now locked into the kiosk app.

### Re-enabling After Restart or Power Loss
If the iPad battery dies or the device restarts:
1. Turn on and unlock the iPad.
2. Open the **ZIL Kiosk** app from the Home Screen.
3. **Triple-click** the top button (or Home button).
4. Tap **Resume** or enter your Guided Access passcode to restart lockdown.

---

## Staff Access & Configuration

### Changing the Staff PIN
The 4-digit PIN is defined as a constant at the top of [`app.js`](file:///home/sp/zil/check-in-out-system/app.js#L12):

```javascript
const STAFF_PIN = "1234";
```

To update the PIN, edit this value in `app.js`.

### Accessing the Dashboard
1. On the Home screen, tap **Staff Access** at the bottom of the screen.
2. Enter the 4-digit PIN (`1234`) on the touch keypad.
3. The Staff Dashboard displays:
   - **Active Sessions**: Live view of checked-in visitors with manual check-out override.
   - **Damage Reports**: Detailed logs of damage or issues reported by visitors.
   - **Repeat Offenders**: Users with missed check-outs.
   - **Data Management**: Backup and restore tools.

---

## Data Backup and Restore

All visit records are stored in browser **IndexedDB** on the iPad device.

### Backing Up Data
1. In the Staff Dashboard, select the **Data Management** tab.
2. Tap **Export as CSV** to download a spreadsheet-ready file of all visits (`.csv`).
3. Tap **Export as JSON** to download a complete backup of visits, people records, and metadata (`.json`).
4. Every export automatically updates the `lastBackupAt` timestamp.
5. If no backup has occurred within 7 days, a prominent red warning banner is displayed across the Staff Dashboard.

### Restoring Data
1. In the Staff Dashboard, select the **Data Management** tab.
2. Under **Restore Data from JSON Backup**, tap **Choose Backup File to Restore**.
3. Select a previously exported `.json` backup file.
4. Confirm the prompt to restore and merge records into IndexedDB.
