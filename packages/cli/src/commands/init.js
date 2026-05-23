// docket init — Initialize docket integration in an HTML file
// Registers project in Firestore, copies admin-panel.min.js, injects CSS/HTML/scripts.
//
// Usage:
//   docket init <html-file> --id <projectId> --prefix <PREFIX> --name <name> [--admin-email <email>]

import { resolve, dirname, join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createProjectService } from '@docket/core';

const MARKER = '<!-- docket-integration -->';

export async function run({ db, config, flags, positional }) {
  // ── Parse & validate ────────────────────────────────────────────────
  const htmlPath = positional[1] ? resolve(positional[1]) : null;
  const projectId = flags.id;
  const prefix = flags.prefix;
  const name = flags.name;
  const adminEmail = flags['admin-email'];

  if (!htmlPath || !projectId || !prefix || !name) {
    console.error('Usage: docket init <html-file> --id <projectId> --prefix <PREFIX> --name <name> [--admin-email <email>]');
    console.error('');
    console.error('Example:');
    console.error('  docket init ~/dev/js/blog-editor/editor.html --id blog-editor --prefix BE --name "Blog Editor"');
    process.exit(1);
  }

  if (!existsSync(htmlPath)) {
    console.error(`Error: HTML file not found: ${htmlPath}`);
    process.exit(1);
  }

  const webFirebaseConfig = config?.webFirebaseConfig;
  if (!webFirebaseConfig?.apiKey || !webFirebaseConfig?.projectId) {
    console.error('Error: webFirebaseConfig is missing or incomplete in docket.config.json.');
    console.error('Add a webFirebaseConfig block (apiKey, authDomain, projectId, storageBucket, messagingSenderId, appId)');
    console.error('— see docket.config.example.json for the expected shape.');
    process.exit(1);
  }

  const htmlDir = dirname(htmlPath);

  // ── 1. Register project in Firestore ────────────────────────────────
  const projectService = createProjectService(db);
  const existing = await projectService.get(projectId);

  if (existing) {
    console.log(`Project "${projectId}" already registered — skipping.`);
  } else {
    // Use --admin-email flag, or fall back to config default (DOCKET_ADMIN_EMAIL / defaults.adminEmail)
    const resolvedAdminEmail = adminEmail || config?.adminEmail || '';
    const adminEmails = resolvedAdminEmail ? [resolvedAdminEmail] : [];
    await projectService.register({ id: projectId, prefix, name, adminEmails });
    console.log(`Registered project "${name}" (${prefix}) with id "${projectId}".`);
  }

  // ── 2. Copy admin-panel.min.js ──────────────────────────────────────
  const thisFile = fileURLToPath(import.meta.url);
  const panelSrc = resolve(dirname(thisFile), '..', '..', '..', 'admin-panel', 'dist', 'admin-panel.min.js');
  const panelDest = join(htmlDir, 'admin-panel.min.js');

  if (!existsSync(panelSrc)) {
    console.error(`Error: admin-panel.min.js not found at ${panelSrc}`);
    console.error('Run the admin-panel build first.');
    process.exit(1);
  }

  copyFileSync(panelSrc, panelDest);
  console.log(`Copied admin-panel.min.js → ${panelDest}`);

  // ── 3. Inject into HTML ─────────────────────────────────────────────
  let html = readFileSync(htmlPath, 'utf-8');

  if (html.includes(MARKER)) {
    console.log('HTML already contains docket integration — skipping injection.');
    console.log('\nDone.');
    return;
  }

  const css = buildCSS();
  const body = buildBody(projectId, webFirebaseConfig);

  // Inject CSS before </head>
  if (html.includes('</head>')) {
    html = html.replace('</head>', css + '\n</head>');
  } else {
    // No </head> — prepend CSS at the top
    html = css + '\n' + html;
  }

  // Inject HTML + scripts before </body>
  if (html.includes('</body>')) {
    html = html.replace('</body>', body + '\n</body>');
  } else {
    // No </body> — append at the end
    html = html + '\n' + body;
  }

  writeFileSync(htmlPath, html, 'utf-8');
  console.log(`Injected docket integration into ${htmlPath}`);
  console.log('\nDone.');
}

// ── CSS ──────────────────────────────────────────────────────────────────

function buildCSS() {
  return `
${MARKER}
<style>
  #docket_fab {
    position: fixed;
    bottom: 24px;
    right: 24px;
    z-index: 90000;
    width: 56px;
    height: 56px;
    border-radius: 50%;
    border: none;
    background: #663399;
    color: #fff;
    font-size: 24px;
    cursor: pointer;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background 0.2s;
  }
  #docket_fab:hover { background: #7a45b0; }

  #docket_overlay {
    display: none;
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.4);
    z-index: 90001;
  }
  #docket_overlay.open { display: block; }

  #docket_drawer {
    display: none;
    position: fixed;
    top: 0;
    right: 0;
    width: 480px;
    max-width: 100vw;
    height: 100vh;
    background: #1e1e2e;
    z-index: 90002;
    box-shadow: -4px 0 24px rgba(0,0,0,0.4);
    flex-direction: column;
    overflow: hidden;
  }
  #docket_drawer.open { display: flex; }

  #docket_drawer_header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 20px;
    border-bottom: 1px solid #333;
    background: #181825;
  }
  #docket_drawer_header h2 {
    margin: 0;
    font-size: 16px;
    color: #cdd6f4;
    font-family: system-ui, sans-serif;
  }
  #docket_drawer_close {
    background: none;
    border: none;
    color: #cdd6f4;
    font-size: 22px;
    cursor: pointer;
    padding: 0 4px;
  }

  #docket_container {
    flex: 1;
    overflow-y: auto;
  }

  /* Dark theme overrides for admin panel inside drawer */
  #docket_container .ticket-admin-panel {
    background: #1e1e2e;
    color: #cdd6f4;
  }
</style>`;
}

// ── Body (HTML + Scripts) ────────────────────────────────────────────────

function buildBody(projectId, firebaseConfig) {
  return `
${MARKER}
<div id="docket_overlay"></div>
<div id="docket_drawer">
  <div id="docket_drawer_header">
    <h2>Antfarm</h2>
    <button id="docket_drawer_close">&times;</button>
  </div>
  <div id="docket_container"></div>
</div>
<button id="docket_fab" title="Open Antfarm">&#9998;</button>

<!-- Firebase compat CDN -->
<script src="https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js"></script>
<script src="https://www.gstatic.com/firebasejs/10.12.2/firebase-auth-compat.js"></script>
<script src="https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore-compat.js"></script>

<!-- Docket admin panel -->
<script src="admin-panel.min.js"></script>

<script>
(function() {
  // ── Firebase init (named instance so it won't collide with host app) ──
  var docketConfig = ${JSON.stringify(firebaseConfig, null, 4).replace(/\n/g, '\n  ')};

  var docketApp = firebase.initializeApp(docketConfig, 'docket');
  var db = docketApp.firestore();
  var auth = docketApp.auth();

  // ── file:// protocol guard ──
  if (window.location.protocol === 'file:') {
    console.warn(
      '[Docket] file:// protocol detected. Firebase auth requires HTTP(S). ' +
      'Serve this file with a local server (e.g. npx serve, python -m http.server).'
    );
  }

  // ── DOM refs ──
  var fab = document.getElementById('docket_fab');
  var overlay = document.getElementById('docket_overlay');
  var drawer = document.getElementById('docket_drawer');
  var closeBtn = document.getElementById('docket_drawer_close');
  var container = document.getElementById('docket_container');
  var panel = null;
  var currentUser = null;
  var drawerOpen = false;

  // ── Auth (single listener, registered once) ──
  auth.onAuthStateChanged(function(user) {
    currentUser = user;
    // If drawer is open and user just signed in, mount the panel
    if (user && drawerOpen) mountPanel(user);
  });

  function mountPanel(user) {
    if (!panel) {
      panel = new TicketAdminPanel({
        container: container,
        db: db,
        projectId: ${JSON.stringify(projectId)},
        getUser: function() { return { uid: user.uid, email: user.email }; },
        isAdmin: function() { return false; },
        onClose: closeDrawer,
        theme: 'dark'
      });
      panel.mount();
    } else {
      panel.refresh();
    }
  }

  function openDrawer() {
    drawerOpen = true;
    overlay.classList.add('open');
    drawer.classList.add('open');

    if (currentUser) {
      mountPanel(currentUser);
    } else {
      auth.signInWithPopup(new firebase.auth.GoogleAuthProvider()).catch(function(err) {
        console.error('[Docket] Auth error:', err.code, err.message);
      });
    }
  }

  function closeDrawer() {
    drawerOpen = false;
    overlay.classList.remove('open');
    drawer.classList.remove('open');
  }

  fab.addEventListener('click', openDrawer);
  overlay.addEventListener('click', closeDrawer);
  closeBtn.addEventListener('click', closeDrawer);
})();
</script>`;
}
