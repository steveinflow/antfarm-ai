import firebase from 'firebase/compat/app';
import 'firebase/compat/firestore';
import 'firebase/compat/auth';
import { TicketAdminPanel } from '@docket/admin-panel';
import { createProjectService } from '@docket/core';
import { OrchestratorPanel } from './orchestrator-panel.js';
import { AdvisorPanel } from './advisor-panel.js';
import { TriagePanel } from './triage-panel.js';
import './styles.css';

// ---------------------------------------------------------------------------
// Global error boundary — catch chunk-load failures and unhandled rejections
// and show a branded error message instead of a blank screen.
// ---------------------------------------------------------------------------

(function installGlobalErrorBoundary() {
  // Signal to the pre-JS timeout in index.html that the bundle loaded OK.
  if (typeof window.__cancelBundleTimeout === 'function') {
    window.__cancelBundleTimeout();
  }

  /**
   * Show the bundle-error overlay.  This is the same element controlled by
   * the pre-JS inline script in index.html, so if JS does boot but then
   * hits a fatal error we reuse the same branded UI.
   */
  function showFatalError(detail) {
    let el = document.getElementById('bundle_error');
    if (!el) {
      // Fallback: create a minimal overlay if the DOM element is missing.
      el = document.createElement('div');
      el.style.cssText =
        'position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;' +
        'justify-content:center;gap:16px;padding:32px;text-align:center;' +
        'background:var(--bg-deep,#0e0e12);z-index:99999;';
      el.innerHTML =
        '<div style="font-size:2.5rem">⚠️</div>' +
        '<h2 style="margin:0;font-size:1.25rem;font-weight:600;color:var(--text-bright,#fff)">Something went wrong</h2>' +
        '<p style="margin:0;font-size:.9rem;color:var(--text-muted,#aaa);max-width:360px;line-height:1.6">' +
        'Antfarm encountered an unexpected error.</p>' +
        '<button onclick="window.location.reload()" style="padding:10px 24px;font-size:.9rem;font-weight:500;' +
        'border:none;border-radius:8px;background:var(--primary,#7c6bff);color:#fff;cursor:pointer;margin-top:4px">' +
        'Try again</button>' +
        '<p id="bundle_error_detail_fallback" style="font-size:.75rem;color:var(--text-very-faint,#666);max-width:400px;line-height:1.5;margin:0"></p>';
      document.body.appendChild(el);
    }

    if (el.style.display !== 'flex') {
      el.style.display = 'flex';
    }

    // Hide the auth spinner so both aren't shown at once.
    const spinner = document.getElementById('auth_loading');
    if (spinner) spinner.style.display = 'none';

    // Update the detail message if provided.
    if (detail) {
      const detailEl =
        document.getElementById('bundle_error_detail') ||
        document.getElementById('bundle_error_detail_fallback');
      if (detailEl) detailEl.textContent = detail;
    }
  }

  /**
   * Determine whether an error looks like a chunk-load failure.
   * Webpack chunk errors have names like "ChunkLoadError" or messages
   * containing "Loading chunk" or "Loading CSS chunk".
   */
  function isChunkLoadError(err) {
    if (!err) return false;
    const name = err.name || '';
    const msg = (err.message || '') + (err.stack || '');
    return (
      name === 'ChunkLoadError' ||
      /loading (css )?chunk/i.test(msg) ||
      /failed to fetch dynamically imported module/i.test(msg) ||
      /Importing a module script failed/i.test(msg)
    );
  }

  // Catch synchronous JS errors (including chunk-load errors thrown at boot).
  window.addEventListener('error', (event) => {
    const err = event.error;
    // Ignore resource-load errors (img, stylesheet, etc.) — those are
    // ErrorEvents without an .error property.
    if (!err) return;

    if (isChunkLoadError(err)) {
      console.error('[docket] Chunk load failed — showing error boundary', err);
      showFatalError(
        'A required piece of the application failed to load. ' +
          'This is often a network issue — try refreshing.'
      );
    }
    // Non-chunk errors are left for the browser to handle normally; we
    // deliberately avoid hiding arbitrary JS bugs behind a blank screen.
  });

  // Catch promise rejections (dynamic import() failures hit here in many browsers).
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    if (isChunkLoadError(reason)) {
      console.error('[docket] Chunk load rejected — showing error boundary', reason);
      event.preventDefault(); // suppress "Uncaught (in promise)" browser error
      showFatalError(
        'A required piece of the application failed to load. ' +
          'This is often a network issue — try refreshing.'
      );
    }
  });
})();

// ---------------------------------------------------------------------------
// Service Worker registration (PWA)
// ---------------------------------------------------------------------------

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('./sw.js')
      .then((reg) => {
        // When a new SW is waiting, trigger the version-update banner so the
        // user can reload and activate the new version.
        reg.addEventListener('updatefound', () => {
          const newWorker = reg.installing;
          if (!newWorker) return;
          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              // New content available — the version poller will also catch this,
              // but nudge immediately via the existing banner element.
              const bannerEl = document.getElementById('update_banner');
              if (bannerEl) bannerEl.classList.remove('hidden');
            }
          });
        });
      })
      .catch((err) => {
        console.warn('Service worker registration failed:', err);
      });
  });
}

// ---------------------------------------------------------------------------
// Auto-reload: poll version.json and prompt user when a new version is live
// ---------------------------------------------------------------------------

(function initVersionPoller() {
  const POLL_INTERVAL_MS = 60_000; // check every 60 seconds
  const bannerEl = document.getElementById('update_banner');
  const reloadBtn = document.getElementById('update_reload_btn');
  const dismissBtn = document.getElementById('update_dismiss_btn');

  if (!bannerEl || !reloadBtn || !dismissBtn) return;

  let currentVersion = null;
  let dismissed = false;

  reloadBtn.addEventListener('click', () => window.location.reload());
  dismissBtn.addEventListener('click', () => {
    dismissed = true;
    bannerEl.classList.add('hidden');
  });

  async function checkVersion() {
    try {
      // Cache-bust so we always get the latest version.json
      const res = await fetch('version.json?_=' + Date.now(), { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      const fetched = data && data.version;
      if (!fetched) return;

      if (currentVersion === null) {
        // First fetch — record the version this page was loaded with
        currentVersion = fetched;
      } else if (fetched !== currentVersion && !dismissed) {
        // A newer version has been deployed — show the banner
        bannerEl.classList.remove('hidden');
      }
    } catch (_) {
      // Network error — silently ignore, try again next interval
    }
  }

  // Kick off immediately, then on interval
  checkVersion();
  setInterval(checkVersion, POLL_INTERVAL_MS);
})();

// ---------------------------------------------------------------------------
// Firebase init
// ---------------------------------------------------------------------------

// Firebase configuration is injected at build time by webpack DefinePlugin.
// Values come from environment variables (FIREBASE_API_KEY, etc.) set before
// running the build — see web/webpack.config.js for details.
const firebaseConfig = {
  apiKey:            process.env.FIREBASE_API_KEY,
  authDomain:        process.env.FIREBASE_AUTH_DOMAIN,
  projectId:         process.env.FIREBASE_PROJECT_ID,
  storageBucket:     process.env.FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
  appId:             process.env.FIREBASE_APP_ID,
};

const app = firebase.initializeApp(firebaseConfig);
const db = app.firestore();
const auth = app.auth();
const projectService = createProjectService(db);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let projects = [];         // [{ id, name, prefix, adminEmails, ... }]
let adminMap = {};         // { projectId: boolean }
let activePanels = [];     // TicketAdminPanel instances currently mounted
let selectedTab = null;    // projectId (null until projects are loaded)
let orchPanel = null;      // OrchestratorPanel instance
let advisorPanel = null;   // AdvisorPanel singleton
let triagePanel = null;    // TriagePanel instance

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------

const authLoadingEl = document.getElementById('auth_loading');
const signinPage = document.getElementById('signin_page');
const signinVersionEl = document.getElementById('signin_version');
const signinBtn = document.getElementById('signin_btn');
const appEl = document.getElementById('app');
const tabsEl = document.getElementById('project_tabs');
const userEmailEl = document.getElementById('user_email');
const signoutBtn = document.getElementById('signout_btn');
const panelContainer = document.getElementById('panel_container');
const orchSidebar = document.getElementById('orch_sidebar');
const leftSidebar = document.getElementById('left_sidebar');
const themeToggleBtn = document.getElementById('theme_toggle_btn');
const canaryBadge = document.getElementById('canary_badge');
const projectBuildLinks = document.getElementById('project_build_links');
const promoteBtn = document.getElementById('promote_btn');
const promoteModalOverlay = document.getElementById('promote_modal_overlay');
const promoteModalClose = document.getElementById('promote_modal_close');
const promoteCancelBtn = document.getElementById('promote_cancel_btn');
const promoteConfirmBtn = document.getElementById('promote_confirm_btn');
const promoteStatus = document.getElementById('promote_status');
const triageBtn = document.getElementById('triage_btn');
const triageOverlay = document.getElementById('triage_overlay');
const newProjectBtn = document.getElementById('new_project_btn');
const newProjectModalOverlay = document.getElementById('new_project_modal_overlay');
const newProjectModalClose = document.getElementById('new_project_modal_close');
const newProjectCancelBtn = document.getElementById('new_project_cancel_btn');
const newProjectSubmitBtn = document.getElementById('new_project_submit_btn');
const newProjectIdInput = document.getElementById('new_project_id');
const newProjectPrefixInput = document.getElementById('new_project_prefix');
const newProjectNameInput = document.getElementById('new_project_name');
const newProjectDescriptionInput = document.getElementById('new_project_description');
const newProjectIdEditBtn = document.getElementById('new_project_id_edit');
const newProjectStatus = document.getElementById('new_project_status');
const newProjectPrefixPreview = document.getElementById('new_project_prefix_preview');
const newProjectPrefixNone = document.getElementById('new_project_prefix_none');
const newProjectPrefixEditLink = document.getElementById('new_project_prefix_edit_link');
const newProjectPrefixCustomWrap = document.getElementById('new_project_prefix_custom_wrap');
const newProjectPrefixResetBtn = document.getElementById('new_project_prefix_reset');
// Template step (DK-141)
const newProjectTemplateStep = document.getElementById('new_project_template_step');
const newProjectTemplateList = document.getElementById('new_project_template_list');
const newProjectTemplateSkipBtn = document.getElementById('new_project_template_skip');
const newProjectTemplateApplied = document.getElementById('new_project_template_applied');

// ---------------------------------------------------------------------------
// Canary detection + promote controls
// ---------------------------------------------------------------------------

// Detect whether we are running on the canary URL or as a canary build.
// Either condition counts: URL path contains '/docket-canary/' OR the build
// was compiled with DOCKET_ENV=canary.
const isCanaryBuild = process.env.DOCKET_ENV === 'canary';
const isCanaryUrl = window.location.pathname.includes('/docket-canary/');
const isCanary = isCanaryBuild || isCanaryUrl;

// Show the canary badge whenever we're on canary
if (isCanary && canaryBadge) {
  canaryBadge.classList.remove('hidden');
}

// ---------------------------------------------------------------------------
// Theme toggle (light / dark)
// ---------------------------------------------------------------------------

// Theme state — exposed so panels can read the current theme on creation.
let currentTheme = 'dark';

function getCurrentTheme() {
  return currentTheme;
}

(function initTheme() {
  const STORAGE_KEY = 'docket_theme';

  function applyTheme(theme) {
    if (theme === 'light') {
      document.body.classList.add('light-theme');
      if (themeToggleBtn) themeToggleBtn.textContent = '🌙';
      if (themeToggleBtn) themeToggleBtn.title = 'Switch to dark mode';
    } else {
      document.body.classList.remove('light-theme');
      if (themeToggleBtn) themeToggleBtn.textContent = '☀️';
      if (themeToggleBtn) themeToggleBtn.title = 'Switch to light mode';
    }
    // Propagate theme to all currently-mounted ticket panels
    for (const p of activePanels) {
      p.setTheme(theme);
    }
  }

  // Load persisted preference, defaulting to dark
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'light' || saved === 'dark') currentTheme = saved;
  } catch (_e) {}

  applyTheme(currentTheme);

  if (themeToggleBtn) {
    themeToggleBtn.addEventListener('click', () => {
      currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
      applyTheme(currentTheme);
      try {
        localStorage.setItem(STORAGE_KEY, currentTheme);
      } catch (_e) {}
    });
  }
})();

// ── Promote modal ─────────────────────────────────────────────────────

// Show or hide the promote button based on whether the user is an admin of
// the currently selected project (on canary only).
function updatePromoteBtn() {
  if (!promoteBtn || !isCanary) return;
  const isAdminOfSelected = selectedTab && !!adminMap[selectedTab];
  if (isAdminOfSelected) {
    promoteBtn.classList.remove('hidden');
  } else {
    promoteBtn.classList.add('hidden');
  }
}

// Render canary + release build links for the currently selected project.
// Links are shown whenever the project document has canaryUrl or releaseUrl set.
function updateProjectLinks() {
  if (!projectBuildLinks) return;

  const project = selectedTab ? projects.find(p => p.id === selectedTab) : null;
  const canaryUrl = project && project.canaryUrl;
  const releaseUrl = project && project.releaseUrl;

  if (!canaryUrl && !releaseUrl) {
    projectBuildLinks.classList.add('hidden');
    projectBuildLinks.innerHTML = '';
    return;
  }

  projectBuildLinks.innerHTML = '';

  if (canaryUrl) {
    const a = document.createElement('a');
    a.href = canaryUrl;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.className = 'project-build-link canary-link';
    a.title = `Open canary build: ${canaryUrl}`;
    a.textContent = '⬡ Canary';
    projectBuildLinks.appendChild(a);
  }

  if (releaseUrl) {
    const a = document.createElement('a');
    a.href = releaseUrl;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.className = 'project-build-link release-link';
    a.title = `Open release build: ${releaseUrl}`;
    a.textContent = '⬡ Release';
    projectBuildLinks.appendChild(a);
  }

  projectBuildLinks.classList.remove('hidden');
}

function openPromoteModal() {
  promoteStatus.textContent = '';
  promoteStatus.className = '';
  promoteConfirmBtn.disabled = false;

  // Update modal to reflect the currently selected project
  const promoteProjectName = document.getElementById('promote_project_name');
  if (promoteProjectName && selectedTab) {
    const project = projects.find(p => p.id === selectedTab);
    promoteProjectName.textContent = project ? project.name || project.id : selectedTab;
  }

  promoteModalOverlay.classList.remove('hidden');
}

function closePromoteModal() {
  promoteModalOverlay.classList.add('hidden');
}

if (promoteModalClose) promoteModalClose.addEventListener('click', closePromoteModal);
if (promoteCancelBtn) promoteCancelBtn.addEventListener('click', closePromoteModal);
if (promoteModalOverlay) {
  promoteModalOverlay.addEventListener('click', (e) => {
    if (e.target === promoteModalOverlay) closePromoteModal();
  });
}

if (promoteBtn) {
  promoteBtn.addEventListener('click', openPromoteModal);
}

if (promoteConfirmBtn) {
  promoteConfirmBtn.addEventListener('click', async () => {
    const projectId = selectedTab;
    if (!projectId) {
      promoteStatus.textContent = 'Error: No project selected.';
      promoteStatus.className = 'error';
      return;
    }

    promoteConfirmBtn.disabled = true;
    promoteStatus.textContent = 'Requesting promotion…';
    promoteStatus.className = '';

    try {
      const timestamp = new Date().toISOString();
      await db.collection('orchestrator').doc('config').set(
        { promoteCanary: { [projectId]: timestamp } },
        { merge: true }
      );
      promoteStatus.textContent = '✓ Promotion requested. The orchestrator will deploy canary → release shortly.';
      promoteStatus.className = 'success';
      // Close the modal after a short delay
      setTimeout(() => closePromoteModal(), 2500);
    } catch (err) {
      promoteStatus.textContent = `Error: ${err.message}`;
      promoteStatus.className = 'error';
      promoteConfirmBtn.disabled = false;
    }
  });
}

// ── New Project modal ──────────────────────────────────────────────────────

// Derive a slug-style Project ID from a display name.
// "My Feature" → "my-feature", "Hello World!" → "hello-world"
function deriveProjectId(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || '';
}

// Derive a ticket prefix from a project ID slug.
// Splits on hyphens, takes first letter of each segment (clamped to 2–4 chars), uppercased.
// "my-feature" → "MF", "hello-world-test" → "HWT", "docket" → "DO"
function derivePrefix(projectId) {
  const segments = projectId.trim().split(/-+/).filter(Boolean);
  if (segments.length === 0) return '';
  let prefix;
  if (segments.length === 1) {
    // Single segment: take first 2–3 letters
    prefix = segments[0].replace(/[^a-zA-Z]/g, '').slice(0, 3);
    if (prefix.length < 2) prefix = segments[0].replace(/[^a-zA-Z0-9]/g, '').slice(0, 2);
  } else {
    prefix = segments.map(s => s.replace(/[^a-zA-Z0-9]/g, '')[0] || '').join('').slice(0, 4);
  }
  return prefix.toUpperCase();
}

// Track whether the user has manually edited id / prefix
let newProjectIdManual = false;
let newProjectPrefixManual = false;

// Template application state for new project modal (DK-141)
let newProjectSelectedTemplateId = null;  // null = no template selected
let newProjectAppliedTemplateConfig = null; // config object if applied

// Update the prefix preview span (and the hidden input's auto-derived value when not manual)
function updatePrefixPreview(projectId) {
  const derived = derivePrefix(projectId);
  if (newProjectPrefixPreview) {
    newProjectPrefixPreview.textContent = derived || '';
  }
  if (newProjectPrefixNone) {
    if (derived) {
      newProjectPrefixNone.classList.add('hidden');
      if (newProjectPrefixPreview) newProjectPrefixPreview.classList.remove('hidden');
    } else {
      newProjectPrefixNone.classList.remove('hidden');
      if (newProjectPrefixPreview) newProjectPrefixPreview.classList.add('hidden');
    }
  }
}

function openNewProjectModal() {
  newProjectIdManual = false;
  newProjectPrefixManual = false;
  newProjectSelectedTemplateId = null;
  newProjectAppliedTemplateConfig = null;
  if (newProjectIdInput) { newProjectIdInput.value = ''; newProjectIdInput.readOnly = true; }
  if (newProjectPrefixInput) newProjectPrefixInput.value = '';
  if (newProjectNameInput) newProjectNameInput.value = '';
  if (newProjectDescriptionInput) newProjectDescriptionInput.value = '';
  if (newProjectStatus) { newProjectStatus.textContent = ''; newProjectStatus.className = ''; }
  if (newProjectSubmitBtn) newProjectSubmitBtn.disabled = false;
  if (newProjectIdEditBtn) { newProjectIdEditBtn.classList.remove('active'); newProjectIdEditBtn.textContent = 'Edit'; }
  // Reset prefix custom UI
  if (newProjectPrefixCustomWrap) newProjectPrefixCustomWrap.classList.add('hidden');
  const prefixHintEl = document.getElementById('new_project_prefix_hint');
  if (prefixHintEl) prefixHintEl.classList.remove('hidden');
  updatePrefixPreview('');
  // Reset template step
  if (newProjectTemplateApplied) newProjectTemplateApplied.style.display = 'none';
  // Populate template step if user has saved templates (DK-141)
  _populateNewProjectTemplateStep();
  if (newProjectModalOverlay) newProjectModalOverlay.classList.remove('hidden');
  // Focus Display Name first
  setTimeout(() => { if (newProjectNameInput) newProjectNameInput.focus(); }, 50);
}

/**
 * Populate the "Apply a template" step in the new project modal.
 * Shows the step if the advisor panel has saved templates; hides it if none.
 * Called each time the modal opens so the list is fresh.
 */
function _populateNewProjectTemplateStep() {
  if (!newProjectTemplateStep || !newProjectTemplateList) return;

  // Get templates from the advisor panel (if mounted and signed in)
  const templates = advisorPanel ? advisorPanel.getTemplates() : [];

  if (templates.length === 0) {
    // No templates — hide the step entirely (spec: don't show empty state)
    newProjectTemplateStep.classList.remove('visible');
    return;
  }

  // Show the step
  newProjectTemplateStep.classList.add('visible');

  // Rebuild the list
  newProjectTemplateList.innerHTML = '';

  for (const tmpl of templates) {
    const item = document.createElement('div');
    item.className = 'new-project-template-item';
    item.setAttribute('role', 'option');
    item.setAttribute('tabindex', '0');
    item.setAttribute('aria-selected', 'false');
    item.dataset.templateId = tmpl.id;

    const meta = document.createElement('div');
    meta.className = 'new-project-template-item-meta';

    const nameEl = document.createElement('span');
    nameEl.className = 'new-project-template-item-name';
    nameEl.textContent = tmpl.name;
    meta.appendChild(nameEl);

    if (tmpl.description) {
      const descEl = document.createElement('span');
      descEl.className = 'new-project-template-item-desc';
      descEl.textContent = tmpl.description;
      meta.appendChild(descEl);
    }

    item.appendChild(meta);

    // Preview button — opens the preview modal in the advisor panel
    const previewBtn = document.createElement('button');
    previewBtn.className = 'new-project-template-preview-btn';
    previewBtn.type = 'button';
    previewBtn.textContent = 'Preview';
    previewBtn.title = `Preview template: ${tmpl.name}`;
    previewBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (advisorPanel) {
        advisorPanel._openTemplatePreviewModal(tmpl, (config) => {
          // User clicked "Apply and edit" — mark this template as selected
          _selectNewProjectTemplate(tmpl.id, tmpl.name, config);
        });
      }
    });
    item.appendChild(previewBtn);

    // Click to select template (direct apply without preview)
    item.addEventListener('click', () => {
      // Toggle: clicking selected item deselects it
      if (newProjectSelectedTemplateId === tmpl.id) {
        _deselectNewProjectTemplate();
      } else {
        // Open preview first, then apply if user confirms
        if (advisorPanel) {
          advisorPanel._openTemplatePreviewModal(tmpl, (config) => {
            _selectNewProjectTemplate(tmpl.id, tmpl.name, config);
          });
        } else {
          _selectNewProjectTemplate(tmpl.id, tmpl.name, tmpl.config || {});
        }
      }
    });

    // Keyboard: Enter/Space to select
    item.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        item.click();
      }
    });

    newProjectTemplateList.appendChild(item);
  }
}

function _selectNewProjectTemplate(templateId, templateName, config) {
  newProjectSelectedTemplateId = templateId;
  newProjectAppliedTemplateConfig = config;

  // Update visual selection state
  if (newProjectTemplateList) {
    for (const item of newProjectTemplateList.querySelectorAll('.new-project-template-item')) {
      const selected = item.dataset.templateId === templateId;
      item.classList.toggle('new-project-template-item-selected', selected);
      item.setAttribute('aria-selected', String(selected));
    }
  }

  // Show applied confirmation
  if (newProjectTemplateApplied) {
    newProjectTemplateApplied.textContent = `✓ Template "${templateName}" will be applied. Edit persona instructions after the project is created.`;
    newProjectTemplateApplied.style.display = '';
  }

  // Update last-used timestamp for this template (best-effort, non-blocking)
  _touchTemplateLastUsed(templateId);
}

function _deselectNewProjectTemplate() {
  newProjectSelectedTemplateId = null;
  newProjectAppliedTemplateConfig = null;
  if (newProjectTemplateList) {
    for (const item of newProjectTemplateList.querySelectorAll('.new-project-template-item')) {
      item.classList.remove('new-project-template-item-selected');
      item.setAttribute('aria-selected', 'false');
    }
  }
  if (newProjectTemplateApplied) {
    newProjectTemplateApplied.textContent = '';
    newProjectTemplateApplied.style.display = 'none';
  }
}

/**
 * Update lastUsedAt on a template document when it is applied.
 * @param {string} templateId
 */
async function _touchTemplateLastUsed(templateId) {
  const user = auth.currentUser;
  if (!user || !templateId) return;
  try {
    await db.collection('users').doc(user.uid)
      .collection('personaTemplates').doc(templateId)
      .update({ lastUsedAt: new Date().toISOString() });
  } catch (_) { /* non-fatal */ }
}

// Skip button — deselect and collapse the template step
if (newProjectTemplateSkipBtn) {
  newProjectTemplateSkipBtn.addEventListener('click', () => {
    _deselectNewProjectTemplate();
  });
}

function closeNewProjectModal() {
  if (newProjectModalOverlay) newProjectModalOverlay.classList.add('hidden');
}

if (newProjectModalClose) newProjectModalClose.addEventListener('click', closeNewProjectModal);
if (newProjectCancelBtn) newProjectCancelBtn.addEventListener('click', closeNewProjectModal);
if (newProjectModalOverlay) {
  newProjectModalOverlay.addEventListener('click', (e) => {
    if (e.target === newProjectModalOverlay) closeNewProjectModal();
  });
}

// When display name changes, auto-update Project ID (and from that, the prefix preview)
if (newProjectNameInput) {
  newProjectNameInput.addEventListener('input', () => {
    const name = newProjectNameInput.value;
    if (!newProjectIdManual && newProjectIdInput) {
      const derived = deriveProjectId(name);
      newProjectIdInput.value = derived;
      if (!newProjectPrefixManual) {
        updatePrefixPreview(derived);
      }
    }
  });
}

// "Edit" button for Project ID — unlocks the field for manual editing
if (newProjectIdEditBtn) {
  newProjectIdEditBtn.addEventListener('click', () => {
    newProjectIdManual = true;
    if (newProjectIdInput) {
      newProjectIdInput.readOnly = false;
      newProjectIdInput.focus();
      const len = newProjectIdInput.value.length;
      newProjectIdInput.setSelectionRange(len, len);
    }
    newProjectIdEditBtn.classList.add('active');
    newProjectIdEditBtn.textContent = 'Custom';
  });
}

// "Edit" link for Ticket Prefix — shows custom input inline, hides hint row
if (newProjectPrefixEditLink) {
  newProjectPrefixEditLink.addEventListener('click', () => {
    newProjectPrefixManual = true;
    const hintEl = document.getElementById('new_project_prefix_hint');
    if (hintEl) hintEl.classList.add('hidden');
    if (newProjectPrefixCustomWrap) newProjectPrefixCustomWrap.classList.remove('hidden');
    if (newProjectPrefixInput) {
      // Seed with current derived value
      newProjectPrefixInput.value = newProjectPrefixPreview ? newProjectPrefixPreview.textContent : '';
      newProjectPrefixInput.focus();
      const len = newProjectPrefixInput.value.length;
      newProjectPrefixInput.setSelectionRange(len, len);
    }
  });
}

// "Reset" link — go back to auto-derived prefix, show hint row again
if (newProjectPrefixResetBtn) {
  newProjectPrefixResetBtn.addEventListener('click', () => {
    newProjectPrefixManual = false;
    if (newProjectPrefixCustomWrap) newProjectPrefixCustomWrap.classList.add('hidden');
    const hintEl = document.getElementById('new_project_prefix_hint');
    if (hintEl) hintEl.classList.remove('hidden');
    if (newProjectPrefixInput) newProjectPrefixInput.value = '';
    // Re-derive from current project ID
    const currentId = newProjectIdInput ? newProjectIdInput.value : '';
    updatePrefixPreview(currentId);
  });
}

// Auto-uppercase the custom prefix input
if (newProjectPrefixInput) {
  newProjectPrefixInput.addEventListener('input', () => {
    const pos = newProjectPrefixInput.selectionStart;
    newProjectPrefixInput.value = newProjectPrefixInput.value.toUpperCase().replace(/[^A-Z]/g, '');
    try { newProjectPrefixInput.setSelectionRange(pos, pos); } catch (_) {}
  });
}

// Auto-slugify the project ID field when manually editing; also update prefix preview
if (newProjectIdInput) {
  newProjectIdInput.addEventListener('input', () => {
    if (!newProjectIdInput.readOnly) {
      const pos = newProjectIdInput.selectionStart;
      newProjectIdInput.value = newProjectIdInput.value.toLowerCase().replace(/[^a-z0-9-]/g, '');
      try { newProjectIdInput.setSelectionRange(pos, pos); } catch (_) {}
    }
    // Always update the prefix preview from the current project ID (unless prefix is manual)
    if (!newProjectPrefixManual) {
      updatePrefixPreview(newProjectIdInput.value);
    }
  });
}

if (newProjectBtn) {
  newProjectBtn.addEventListener('click', openNewProjectModal);
}

if (newProjectSubmitBtn) {
  newProjectSubmitBtn.addEventListener('click', async () => {
    const name = newProjectNameInput ? newProjectNameInput.value.trim() : '';
    const id = newProjectIdInput ? newProjectIdInput.value.trim() : '';
    const description = newProjectDescriptionInput ? newProjectDescriptionInput.value.trim() : '';
    // Prefix: use manual input if set, otherwise derive from project ID
    const prefix = newProjectPrefixManual && newProjectPrefixInput
      ? newProjectPrefixInput.value.trim()
      : derivePrefix(id);

    // Validate — Display Name first (primary field)
    if (!name) {
      newProjectStatus.textContent = 'Display name is required.';
      newProjectStatus.className = 'error';
      if (newProjectNameInput) newProjectNameInput.focus();
      return;
    }
    if (!id) {
      newProjectStatus.textContent = 'Project ID is required.';
      newProjectStatus.className = 'error';
      if (newProjectIdInput) { newProjectIdInput.readOnly = false; newProjectIdInput.focus(); }
      return;
    }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
      newProjectStatus.textContent = 'Project ID must start with a letter or number and contain only lowercase letters, numbers, and hyphens.';
      newProjectStatus.className = 'error';
      if (newProjectIdInput) { newProjectIdInput.readOnly = false; newProjectIdInput.focus(); }
      return;
    }
    if (!prefix || !/^[A-Z]{2,4}$/.test(prefix)) {
      newProjectStatus.textContent = 'Could not derive a valid ticket prefix (2–4 letters). Please set one manually.';
      newProjectStatus.className = 'error';
      // Show the custom prefix input so user can fix it
      newProjectPrefixManual = true;
      if (newProjectPrefixCustomWrap) newProjectPrefixCustomWrap.classList.remove('hidden');
      const prefixHintElErr = document.getElementById('new_project_prefix_hint');
      if (prefixHintElErr) prefixHintElErr.classList.add('hidden');
      if (newProjectPrefixInput) { newProjectPrefixInput.value = prefix; newProjectPrefixInput.focus(); }
      return;
    }

    newProjectSubmitBtn.disabled = true;
    newProjectStatus.textContent = 'Creating project…';
    newProjectStatus.className = '';

    try {
      const user = auth.currentUser;
      if (!user) throw new Error('You must be signed in to create a project.');

      const now = new Date().toISOString();

      // Build the project document; include personaInstructions if a template was applied (DK-141)
      const projectDoc = {
        prefix,
        name,
        adminEmails: [user.email],
        repoPath: '',
        nextTicketNumber: 1,
        createdAt: now,
        updatedAt: now,
      };

      // Include advisorContext if description was provided (DK-357)
      if (description) {
        projectDoc.advisorContext = description;
      }

      if (newProjectAppliedTemplateConfig) {
        const cfg = newProjectAppliedTemplateConfig;
        // Map template config fields to personaInstructions (engineer/design/product)
        // Instructions field → engineer, scope → design, triggers → product
        // Only include non-empty values; do not overwrite with blanks.
        const pi = {};
        if (cfg.instructions) pi.engineer = cfg.instructions;
        if (cfg.scope)        pi.design   = cfg.scope;
        if (cfg.triggers)     pi.product  = cfg.triggers;
        if (Object.keys(pi).length > 0) projectDoc.personaInstructions = pi;
      }

      await db.collection('projects').doc(id).set(projectDoc);

      const templateNote = newProjectAppliedTemplateConfig
        ? '<div class="new-project-success-note">Persona instructions pre-populated from template — review and save in the Advisor panel.</div>'
        : '';
      // Escape display name for safe HTML insertion (id/prefix are already validated safe)
      const safeName = name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      // Show a rich summary so users know exactly what was created (DK-358)
      newProjectStatus.innerHTML = `
        <div class="new-project-success-summary">
          <div class="new-project-success-header">✓ Project created</div>
          <div class="new-project-success-details">
            <div class="new-project-success-row"><span class="new-project-success-label">Name</span><span class="new-project-success-value">${safeName}</span></div>
            <div class="new-project-success-row"><span class="new-project-success-label">ID</span><span class="new-project-success-value new-project-success-mono">${id}</span></div>
            <div class="new-project-success-row"><span class="new-project-success-label">Ticket prefix</span><span class="new-project-success-value new-project-success-mono">${prefix}-1, ${prefix}-2, …</span></div>
          </div>
          ${templateNote}
        </div>`;
      newProjectStatus.className = 'success';

      // Reload projects to show the new one
      await loadProjects(user.email);

      // Switch to the new project tab
      selectTab(id);

      setTimeout(() => closeNewProjectModal(), 3000);
    } catch (err) {
      newProjectStatus.textContent = `Error: ${err.message}`;
      newProjectStatus.className = 'error';
      newProjectSubmitBtn.disabled = false;
    }
  });
}

// ---------------------------------------------------------------------------
// Triage panel
// ---------------------------------------------------------------------------

function openTriage() {
  if (!triageOverlay) return;
  const user = auth.currentUser;
  if (!user) return;

  triageOverlay.classList.remove('hidden');

  // Mount the triage panel inside the overlay
  if (!triagePanel) {
    triagePanel = new TriagePanel({
      container: triageOverlay,
      db,
      projectIds: projects.map(p => p.id),
      projects: projects.map(p => ({ id: p.id, name: p.name || p.id })),
      getUser: () => ({ uid: user.uid, email: user.email }),
      serverTimestamp: () => firebase.firestore.FieldValue.serverTimestamp(),
    });
    triagePanel.mount();

    // Listen for close event from within the panel
    triageOverlay.addEventListener('triage:close', closeTriage, { once: false });

    // Close triage when backdrop is clicked (the ::before pseudo-element)
    triageOverlay.addEventListener('click', (e) => {
      // Only close if clicking on the backdrop itself, not on content
      if (e.target === triageOverlay) {
        closeTriage();
      }
    });

    // Also close on Escape key
    const escapeHandler = (e) => {
      if (e.key === 'Escape') {
        closeTriage();
      }
    };
    document.addEventListener('keydown', escapeHandler);
    // Store handler for cleanup
    triageOverlay._escapeHandler = escapeHandler;
  }

  // Handle URL hash routing — set #triage
  try {
    history.replaceState(null, '', window.location.pathname + '#triage');
  } catch (_) {}
}

function closeTriage() {
  if (!triageOverlay) return;
  triageOverlay.classList.add('hidden');

  if (triagePanel) {
    triagePanel.unmount();
    triagePanel = null;
  }

  // Clean up escape handler
  if (triageOverlay._escapeHandler) {
    document.removeEventListener('keydown', triageOverlay._escapeHandler);
    triageOverlay._escapeHandler = null;
  }

  // Restore URL hash
  try {
    history.replaceState(null, '', window.location.pathname);
  } catch (_) {}
}

// Hash-based routing note: Docket is hosted on GitHub Pages (static files only).
// We use hash fragments (e.g. /#triage) for all client-side navigation because
// hashes are never sent to the server, so GitHub Pages never needs to rewrite
// URLs to index.html. If you add path-based routes, update src/404.html too —
// see web/CLAUDE.md § "Routing — GitHub Pages SPA Constraint" for details.

// Open triage if URL hash is #triage on load
if (window.location.hash === '#triage') {
  // Will open once auth resolves and projects load (see onProjectsLoaded below)
}

// Triage button click
if (triageBtn) {
  triageBtn.addEventListener('click', openTriage);
}

// Update triage button badge with proposed ticket count
function updateTriageBadge(count) {
  if (!triageBtn) return;
  let badge = triageBtn.querySelector('.triage-btn-badge');
  if (count > 0) {
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'triage-btn-badge';
      triageBtn.appendChild(badge);
    }
    badge.textContent = String(count);
  } else {
    if (badge) badge.remove();
  }

  // DK-104: Also badge the AdvisorPanel trigger button with proposed count
  const advisorToggleBtn = document.getElementById('advisor_toggle_btn');
  if (advisorToggleBtn) {
    let advisorBadge = advisorToggleBtn.querySelector('.advisor-triage-badge');
    if (count > 0) {
      if (!advisorBadge) {
        advisorBadge = document.createElement('span');
        advisorBadge.className = 'advisor-triage-badge';
        advisorBadge.setAttribute('aria-label', `${count} proposed ticket${count !== 1 ? 's' : ''} awaiting triage`);
        advisorToggleBtn.appendChild(advisorBadge);
      }
      advisorBadge.textContent = String(count > 99 ? '99+' : count);
      advisorBadge.setAttribute('aria-label', `${count} proposed ticket${count !== 1 ? 's' : ''} awaiting triage`);
    } else {
      if (advisorBadge) advisorBadge.remove();
    }
  }

  // Mirror badge count to mobile nav triage badge (inside drawer)
  const mobileBadge = document.getElementById('mobile_nav_triage_badge');
  if (mobileBadge) {
    if (count > 0) {
      mobileBadge.textContent = String(count > 99 ? '99+' : count);
      mobileBadge.style.display = 'flex';
    } else {
      mobileBadge.style.display = 'none';
    }
  }

  // Mirror badge count to hamburger button badge
  const hamburgerBadge = document.getElementById('hamburger_triage_badge');
  if (hamburgerBadge) {
    if (count > 0) {
      hamburgerBadge.textContent = String(count > 99 ? '99+' : count);
      hamburgerBadge.style.display = 'flex';
    } else {
      hamburgerBadge.style.display = 'none';
    }
  }
}

// ---------------------------------------------------------------------------
// YOLO — persistent mode toggle + bulk accept existing proposed tickets
// ---------------------------------------------------------------------------

// Watch proposed ticket count across all projects (for triage badge).
let triageBadgeUnsubscribes = [];

function startTriageBadgeWatcher(projectIds) {
  // Cleanup previous watchers
  triageBadgeUnsubscribes.forEach(fn => fn());
  triageBadgeUnsubscribes = [];

  const countsByProject = {};
  const updateTotal = () => {
    const total = Object.values(countsByProject).reduce((a, b) => a + b, 0);
    updateTriageBadge(total);
  };

  for (const projectId of projectIds) {
    // Watch proposed tickets count
    const q = db
      .collection('projects')
      .doc(projectId)
      .collection('tickets')
      .where('status', '==', 'proposed');

    const unsub = q.onSnapshot(snap => {
      countsByProject[projectId] = snap.size;
      updateTotal();
    });
    triageBadgeUnsubscribes.push(unsub);
  }
}

// ---------------------------------------------------------------------------
// Scroll persistence helpers
// ---------------------------------------------------------------------------

// Throttle helper — calls fn at most once per `wait` ms
function throttle(fn, wait) {
  let last = 0;
  return function (...args) {
    const now = Date.now();
    if (now - last >= wait) {
      last = now;
      fn.apply(this, args);
    }
  };
}

// Save / restore orch sidebar scroll
function saveOrchScroll() {
  if (!orchSidebar) return;
  try {
    localStorage.setItem('docket_orch_scroll', String(orchSidebar.scrollTop));
  } catch (_e) {}
}

function restoreOrchScroll() {
  if (!orchSidebar) return;
  try {
    const saved = localStorage.getItem('docket_orch_scroll');
    if (saved !== null) {
      orchSidebar.scrollTop = parseInt(saved, 10) || 0;
    }
  } catch (_e) {}
}

// Attach scroll listeners once the DOM is ready
if (orchSidebar) {
  orchSidebar.addEventListener('scroll', throttle(saveOrchScroll, 200));
}
if (panelContainer) {
  panelContainer.addEventListener('scroll', throttle(() => savePanelScroll(), 200));
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

signinBtn.addEventListener('click', async () => {
  try {
    await auth.signInWithPopup(new firebase.auth.GoogleAuthProvider());
  } catch (err) {
    console.error('Sign-in error:', err.code, err.message);
  }
});

signoutBtn.addEventListener('click', () => {
  auth.signOut();
});


auth.onAuthStateChanged(user => {
  // Hide the initial auth loading spinner now that auth state is known
  if (authLoadingEl) authLoadingEl.style.display = 'none';

  if (user) {
    signinPage.style.display = 'none';
    if (signinVersionEl) signinVersionEl.style.display = 'none';
    appEl.style.display = 'block';
    userEmailEl.textContent = user.email;
    loadProjects(user.email);
    mountAdvisorPanel(user);
  } else {
    signinPage.style.display = 'flex';
    if (signinVersionEl) signinVersionEl.style.display = '';
    appEl.style.display = 'none';
    unmountAllPanels();
    unmountOrchPanel();
    unmountAdvisorPanel();
    closeTriage();
    triageBadgeUnsubscribes.forEach(fn => fn());
    triageBadgeUnsubscribes = [];
  }
});

// ---------------------------------------------------------------------------
// Orchestrator ticket navigation
// ---------------------------------------------------------------------------

/**
 * Called when a ticket row in the orchestrator panel is clicked.
 * Switches to the appropriate tab and focuses the ticket in the admin panel.
 * @param {{ projectId: string, ticketId: string }} ticket
 */
async function openTicketFromOrchestrator(ticket) {
  const { projectId, ticketId } = ticket;
  if (!ticketId) return;

  // Determine which tab to switch to.
  // If the ticket's project matches one of our known project tabs, use that.
  // Otherwise fall back to the currently selected tab.
  const targetTab = projects.find(p => p.id === projectId) ? projectId : selectedTab;

  // Switch tab if needed (this remounts panels)
  if (selectedTab !== targetTab) {
    selectTab(targetTab);
    // Wait a tick for the panel to mount and load data
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  // Try to focus the ticket in the active panel
  // Retry a few times in case data is still loading
  let focused = false;
  for (let attempt = 0; attempt < 5 && !focused; attempt++) {
    for (const panel of activePanels) {
      if (panel.focusTicket(ticketId)) {
        focused = true;
        break;
      }
    }
    if (!focused) {
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  }
}

// ---------------------------------------------------------------------------
// Project loading
// ---------------------------------------------------------------------------

async function loadProjects(email) {
  try {
    projects = await projectService.list();

    // Determine admin status for each project
    adminMap = {};
    for (const p of projects) {
      adminMap[p.id] = (p.adminEmails || []).includes(email);
    }

    renderTabs();

    // Update the promote button visibility for the selected tab
    updatePromoteBtn();
    updateProjectLinks();

    // Start watching proposed ticket counts for triage badge
    startTriageBadgeWatcher(projects.map(p => p.id));

    // Mount or update orchestrator panel with all project IDs
    const allProjectIds = projects.map(p => p.id);
    if (orchPanel) {
      orchPanel.updateProjects(allProjectIds);
    } else {
      // Only admins of at least one project can delete tickets from the Workers pane
      const isAdminOfProject = (projectId) => !!adminMap[projectId];

      orchPanel = new OrchestratorPanel({
        container: orchSidebar,
        db,
        projectIds: allProjectIds,
        onTicketClick: (ticket) => openTicketFromOrchestrator(ticket),
        onDelete: async (projectId, docId) => {
          if (!isAdminOfProject(projectId)) {
            throw new Error('You do not have permission to delete tickets in this project.');
          }
          await db.collection('projects').doc(projectId).collection('tickets').doc(docId).delete();
        },
      });
      orchPanel.mount();
      // Restore orch sidebar scroll position after mount
      requestAnimationFrame(() => restoreOrchScroll());
    }

    // Restore previously selected tab, falling back to first project if saved tab no longer exists
    const savedTab = localStorage.getItem('docket_selected_tab');
    const validTabIds = new Set(projects.map(p => p.id));
    const defaultProject = projects.find(p => p.id === 'docket') || projects[0];
    const defaultId = defaultProject ? defaultProject.id : (projects[0] ? projects[0].id : null);
    selectTab(validTabIds.has(savedTab) ? savedTab : defaultId);

    // If URL hash is #triage, open the triage view after projects load
    if (window.location.hash === '#triage') {
      openTriage();
    }
  } catch (err) {
    const errDiv = document.createElement('div');
    errDiv.id = 'loading_msg';
    errDiv.textContent = 'Failed to load projects: ' + err.message;
    panelContainer.innerHTML = '';
    panelContainer.appendChild(errDiv);
  }
}

function unmountOrchPanel() {
  if (orchPanel) {
    orchPanel.unmount();
    orchPanel = null;
  }
}

// ---------------------------------------------------------------------------
// Advisor panel
// ---------------------------------------------------------------------------

let _advisorMounting = false; // guard against concurrent mount attempts
async function mountAdvisorPanel(user) {
  if (advisorPanel || _advisorMounting) return;
  _advisorMounting = true;
  try {
    // Ensure the Firebase ID token is fetched and propagated to Firestore before
    // starting any listeners. Without this, Firestore requests can fire before the
    // auth token is ready, causing spurious "Missing or insufficient permissions"
    // errors in the console even though the user is authenticated.
    if (user) {
      try {
        await user.getIdToken();
      } catch (_) {
        // If token fetch fails (e.g. network error), continue anyway — the
        // listeners have their own retry logic for permission failures.
      }
    }
    // Guard: user may have signed out while we awaited the token.
    if (!auth.currentUser) return;
    if (advisorPanel) return; // another call may have completed while we awaited
    advisorPanel = new AdvisorPanel({ container: leftSidebar, db });
    advisorPanel.mount();
    // Sync the current project selection so the advisor panel reflects whichever
    // project tab is active at mount time. Without this, if loadProjects() already
    // called selectTab() before mountAdvisorPanel() finished (a common race), the
    // panel starts with _filterProjectId=null and "Run Now" sends no project filter.
    advisorPanel.setProjectFilter(selectedTab);
    // Pass the authenticated user so on-demand trigger runs are attributed correctly.
    advisorPanel.setCurrentUser(user || auth.currentUser);
  } finally {
    _advisorMounting = false;
  }
}

function unmountAdvisorPanel() {
  if (!advisorPanel) return;
  advisorPanel.unmount();
  advisorPanel = null;
}

// DK-189: Listen for "open run log" events dispatched from ticket detail attribution links.
// The TicketCard in @docket/admin-panel fires window CustomEvent 'docket:open-run-log'
// with { detail: { runId } } when a user clicks the "via Advisor" attribution line.
window.addEventListener('docket:open-run-log', (e) => {
  if (!advisorPanel) return;
  const runId = e.detail && e.detail.runId ? e.detail.runId : null;
  advisorPanel._openRunLogDrawer(runId);
});

// ---------------------------------------------------------------------------
// Tab bar
// ---------------------------------------------------------------------------

function renderTabs() {
  tabsEl.innerHTML = '';

  // Project dropdown — used on both desktop and mobile
  const select = document.createElement('select');
  select.id = 'project_tabs_select';
  select.setAttribute('aria-label', 'Select project');

  for (const p of projects) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name || p.id;
    if (p.id === selectedTab) opt.selected = true;
    select.appendChild(opt);
  }

  select.addEventListener('change', () => selectTab(select.value));
  tabsEl.appendChild(select);
}

function savePanelScroll() {
  if (!panelContainer) return;
  try {
    localStorage.setItem(
      `docket_panel_scroll_${selectedTab}`,
      String(panelContainer.scrollTop)
    );
  } catch (_e) {}
}

function restorePanelScroll(tabId) {
  if (!panelContainer) return;
  try {
    const saved = localStorage.getItem(`docket_panel_scroll_${tabId}`);
    if (saved !== null) {
      panelContainer.scrollTop = parseInt(saved, 10) || 0;
    }
  } catch (_e) {}
}

function selectTab(id) {
  if (!id) return;

  // Save scroll position of the current tab before switching
  savePanelScroll();

  selectedTab = id;
  localStorage.setItem('docket_selected_tab', id);

  // Sync dropdown selection
  const sel = document.getElementById('project_tabs_select');
  if (sel && sel.value !== selectedTab) sel.value = selectedTab;

  // Update EPD Advisor pane to show only the focused project
  if (advisorPanel) advisorPanel.setProjectFilter(selectedTab);

  // Update promote button visibility and build links for the newly selected project
  updatePromoteBtn();
  updateProjectLinks();

  mountPanels();
}

// ---------------------------------------------------------------------------
// Panel lifecycle
// ---------------------------------------------------------------------------

function unmountAllPanels() {
  for (const p of activePanels) {
    p.unmount();
  }
  activePanels = [];
  panelContainer.innerHTML = '';
}

function mountPanels() {
  unmountAllPanels();

  const user = auth.currentUser;
  if (!user) return;

  if (projects.length === 0) {
    panelContainer.innerHTML = '';
    const emptyEl = document.createElement('div');
    emptyEl.className = 'panel-empty-state';
    emptyEl.innerHTML = `
      <div class="panel-empty-state-icon">📋</div>
      <h2 class="panel-empty-state-title">No projects yet</h2>
      <p class="panel-empty-state-message">Create your first project to start tracking tickets and collaborating with the AI advisor.</p>
    `;
    const ctaBtn = document.createElement('button');
    ctaBtn.className = 'panel-empty-state-action';
    ctaBtn.textContent = '+ Create your first project';
    ctaBtn.addEventListener('click', openNewProjectModal);
    emptyEl.appendChild(ctaBtn);
    panelContainer.appendChild(emptyEl);
    return;
  }

  const project = projects.find(p => p.id === selectedTab);
  if (!project) {
    panelContainer.innerHTML = '<div id="loading_msg">Project not found.</div>';
    return;
  }

  const section = document.createElement('div');
  section.className = 'project-section';
  panelContainer.appendChild(section);

  const isAdminForProject = adminMap[project.id] || false;
  const isAdminForAny = projects.some(p => adminMap[p.id]);

  const panel = new TicketAdminPanel({
    container: section,
    db,
    projectId: project.id,
    getUser: () => ({ uid: user.uid, email: user.email }),
    isAdmin: () => isAdminForProject,
    theme: getCurrentTheme(),
    features: { createTicket: true, rekickButton: isAdminForAny },
    storageKey: project.id,
  });

  panel.mount();
  activePanels.push(panel);

  // Restore scroll position for this tab after panels are mounted.
  // Use a short timeout to allow Firestore data to populate the list before scrolling.
  const tabToRestore = selectedTab;
  setTimeout(() => restorePanelScroll(tabToRestore), 600);
}

// ---------------------------------------------------------------------------
// Resizable panes — drag handles between left_sidebar, panel_container, orch_sidebar
// ---------------------------------------------------------------------------

(function initResizablePanes() {
  const STORAGE_KEY = 'docket_pane_widths';
  const MIN_WIDTH = 160;       // px minimum for any sidebar
  const MIN_CENTER_WIDTH = 500; // px minimum for center panel workspace

  const leftSidebar = document.getElementById('left_sidebar');
  const orchSidebar = document.getElementById('orch_sidebar');
  const panelContainer = document.getElementById('panel_container');
  const dividerLeft = document.getElementById('divider_left');
  const dividerRight = document.getElementById('divider_right');

  if (!leftSidebar || !orchSidebar || !dividerLeft || !dividerRight) return;

  // Load saved widths from localStorage
  function loadWidths() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) return JSON.parse(saved);
    } catch (e) { /* ignore */ }
    return null;
  }

  // Save widths to localStorage
  function saveWidths() {
    try {
      const leftW = Math.round(leftSidebar.getBoundingClientRect().width);
      const orchW = Math.round(orchSidebar.getBoundingClientRect().width);
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ left: leftW, orch: orchW }));
    } catch (e) { /* ignore */ }
  }

  // Apply pixel widths to the sidebars; center pane takes remaining space via flex:1
  function applyWidths(leftW, orchW) {
    leftSidebar.style.flex = 'none';
    leftSidebar.style.width = leftW + 'px';
    orchSidebar.style.flex = 'none';
    orchSidebar.style.width = orchW + 'px';
  }

  // Sensible default sidebar widths for first-run (no saved preference yet).
  // 280px each gives the center panel most of the horizontal space.
  const DEFAULT_SIDEBAR_WIDTH = 280;

  // Restore widths on load (only on wide enough screens)
  const saved = loadWidths();
  if (window.innerWidth > 1100) {
    if (saved) {
      applyWidths(saved.left, saved.orch);
    } else {
      applyWidths(DEFAULT_SIDEBAR_WIDTH, DEFAULT_SIDEBAR_WIDTH);
    }
  }

  // Return the maximum width a sidebar can be set to without shrinking the
  // center panel below MIN_CENTER_WIDTH. otherSidebarEl is the opposite sidebar.
  function maxSidebarWidth(otherSidebarEl) {
    const totalW = document.getElementById('app_body')
      ? document.getElementById('app_body').getBoundingClientRect().width
      : window.innerWidth;
    const dividerW = 24; // two 12px dividers
    const otherW = otherSidebarEl.getBoundingClientRect().width;
    return Math.max(MIN_WIDTH, totalW - dividerW - otherW - MIN_CENTER_WIDTH);
  }

  // Attach drag behavior to a divider.
  // direction: +1 means dragging right increases the target pane width (left pane),
  //            -1 means dragging right decreases the target pane width (right pane).
  // otherSidebarEl: the opposite sidebar, used to enforce the center panel minimum.
  function makeDraggable(divider, targetEl, direction, otherSidebarEl) {
    let startX = 0;
    let startWidth = 0;

    function onMouseMove(e) {
      const dx = e.clientX - startX;
      const desired = startWidth + direction * dx;
      const maxW = maxSidebarWidth(otherSidebarEl);
      const newWidth = Math.min(maxW, Math.max(MIN_WIDTH, desired));
      targetEl.style.flex = 'none';
      targetEl.style.width = newWidth + 'px';
    }

    function onMouseUp() {
      divider.classList.remove('dragging');
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      saveWidths();
    }

    divider.addEventListener('mousedown', (e) => {
      e.preventDefault();
      startX = e.clientX;
      startWidth = targetEl.getBoundingClientRect().width;
      divider.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });
  }

  // Left divider: drag right → left sidebar gets wider (+1); orch sidebar is the other
  makeDraggable(dividerLeft, leftSidebar, 1, orchSidebar);

  // Right divider: drag right → orch sidebar gets narrower (-1); left sidebar is the other
  makeDraggable(dividerRight, orchSidebar, -1, leftSidebar);
})();

// ---------------------------------------------------------------------------
// Advisor sidebar icon-rail + toggle (narrow widths AND wide-screen toggle)
// ---------------------------------------------------------------------------

(function initAdvisorSidebarToggle() {
  const STORAGE_KEY = 'docket_advisor_sidebar_expanded';
  // Separate key for wide-screen visibility preference
  const WIDE_VISIBLE_KEY = 'docket_advisor_sidebar_wide_visible';
  const BREAKPOINT_MAX = 1100;
  const BREAKPOINT_MIN = 0; // icon rail handles all narrow widths (no hamburger drawer)

  const sidebar = document.getElementById('left_sidebar');
  const backdrop = document.getElementById('adv_sidebar_backdrop');
  const toggleBtn = document.getElementById('advisor_toggle_btn');
  const dividerLeft = document.getElementById('divider_left');

  if (!sidebar || !backdrop || !toggleBtn) return;

  // Persona definitions for the icon rail (mirrors advisor-panel.js PERSONAS)
  const RAIL_PERSONAS = [
    { id: 'product',  label: 'Product',  emoji: '📋' },
    { id: 'design',   label: 'Design',   emoji: '🎨' },
    { id: 'engineer', label: 'Engineer', emoji: '⚙️' },
    { id: 'qa',       label: 'QA',       emoji: '🧪' },
  ];

  // Build the icon rail element (inserted into left_sidebar)
  const iconRail = document.createElement('div');
  iconRail.className = 'adv-icon-rail';
  iconRail.setAttribute('aria-label', 'EPD Advisor personas');

  // Expand button at the top of the rail
  const railExpandBtn = document.createElement('button');
  railExpandBtn.className = 'adv-rail-expand-btn';
  railExpandBtn.title = 'Expand Advisor panel';
  railExpandBtn.setAttribute('aria-label', 'Expand Advisor panel');
  railExpandBtn.textContent = '»';
  iconRail.appendChild(railExpandBtn);

  // Per-persona rail buttons (dot status updated dynamically)
  const railDots = {}; // personaId -> dot element
  RAIL_PERSONAS.forEach(({ id, label, emoji }) => {
    const btn = document.createElement('button');
    btn.className = 'adv-rail-btn';
    btn.title = label;
    btn.setAttribute('aria-label', `${label} persona`);
    btn.textContent = emoji;

    const dot = document.createElement('span');
    dot.className = 'adv-rail-dot dot-paused';
    dot.setAttribute('aria-hidden', 'true');
    dot.title = 'Advisor: idle';
    btn.appendChild(dot);
    railDots[id] = dot;

    btn.addEventListener('click', () => expand());
    iconRail.appendChild(btn);
  });

  sidebar.appendChild(iconRail);

  // ── State management ──────────────────────────────────────────────────────

  function isWideMode() {
    return window.innerWidth > BREAKPOINT_MAX;
  }
  function isNarrowMode() {
    return window.innerWidth <= BREAKPOINT_MAX && window.innerWidth > BREAKPOINT_MIN;
  }

  function loadExpanded() {
    try { return localStorage.getItem(STORAGE_KEY) === 'true'; } catch (e) { return false; }
  }
  function saveExpanded(val) {
    try { localStorage.setItem(STORAGE_KEY, String(val)); } catch (e) { /* ignore */ }
  }

  function loadWideVisible() {
    try {
      const v = localStorage.getItem(WIDE_VISIBLE_KEY);
      if (v === null) return null; // not set
      return v === 'true';
    } catch (e) { return null; }
  }
  function saveWideVisible(val) {
    try { localStorage.setItem(WIDE_VISIBLE_KEY, String(val)); } catch (e) { /* ignore */ }
  }

  let _expanded = loadExpanded();
  let _wideVisible = loadWideVisible();
  // Default for returning users (no key): show the sidebar (preserve existing behavior)
  if (_wideVisible === null) _wideVisible = true;

  function applyState() {
    if (isWideMode()) {
      // Wide desktop mode: handle show/hide without icon rail
      sidebar.classList.remove('adv-sidebar-collapsed', 'adv-sidebar-expanded');
      backdrop.classList.remove('open');
      if (_wideVisible) {
        sidebar.classList.remove('adv-sidebar-wide-hidden');
        if (dividerLeft) dividerLeft.classList.remove('divider-hidden');
        toggleBtn.classList.add('active');
        toggleBtn.setAttribute('aria-expanded', 'true');
        toggleBtn.title = 'Hide Advisor panel';
      } else {
        sidebar.classList.add('adv-sidebar-wide-hidden');
        if (dividerLeft) dividerLeft.classList.add('divider-hidden');
        toggleBtn.classList.remove('active');
        toggleBtn.setAttribute('aria-expanded', 'false');
        toggleBtn.title = 'Show Advisor panel';
      }
      return;
    }

    // Remove wide-hidden class when not in wide mode
    sidebar.classList.remove('adv-sidebar-wide-hidden');
    if (dividerLeft) dividerLeft.classList.remove('divider-hidden');

    if (!isNarrowMode()) {
      // Very narrow / mobile nav — remove icon-rail classes; mobile nav handles it
      sidebar.classList.remove('adv-sidebar-collapsed', 'adv-sidebar-expanded');
      backdrop.classList.remove('open');
      toggleBtn.classList.remove('active');
      toggleBtn.setAttribute('aria-expanded', 'false');
      return;
    }

    if (_expanded) {
      sidebar.classList.add('adv-sidebar-expanded');
      sidebar.classList.remove('adv-sidebar-collapsed');
      backdrop.classList.add('open');
      toggleBtn.classList.add('active');
      toggleBtn.setAttribute('aria-expanded', 'true');
    } else {
      sidebar.classList.add('adv-sidebar-collapsed');
      sidebar.classList.remove('adv-sidebar-expanded');
      backdrop.classList.remove('open');
      toggleBtn.classList.remove('active');
      toggleBtn.setAttribute('aria-expanded', 'false');
    }
  }

  function expand() {
    if (isWideMode()) {
      _wideVisible = true;
      saveWideVisible(true);
    } else {
      _expanded = true;
      saveExpanded(true);
    }
    applyState();
  }

  function collapse() {
    if (isWideMode()) {
      _wideVisible = false;
      saveWideVisible(false);
    } else {
      _expanded = false;
      saveExpanded(false);
    }
    applyState();
  }

  function toggle() {
    if (isWideMode()) {
      if (_wideVisible) collapse(); else expand();
    } else {
      if (_expanded) collapse(); else expand();
    }
  }

  // ── Wire up controls ──────────────────────────────────────────────────────

  toggleBtn.addEventListener('click', toggle);
  railExpandBtn.addEventListener('click', expand);

  // Close on backdrop click
  backdrop.addEventListener('click', collapse);

  // Close on Escape key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && _expanded && isNarrowMode()) collapse();
  });

  // Re-apply on resize (crossing the breakpoint)
  window.addEventListener('resize', applyState, { passive: true });

  // Initial state
  applyState();

  // ── Public API: update rail dot status (called from advisor panel) ────────
  window._updateAdvisorRailDot = function(personaId, status) {
    const dot = railDots[personaId];
    if (!dot) return;
    dot.className = 'adv-rail-dot';
    if (status === 'running') { dot.classList.add('dot-running'); dot.title = 'Advisor: active'; }
    else if (status === 'error') { dot.classList.add('dot-error'); dot.title = 'Advisor: error'; }
    else { dot.classList.add('dot-paused'); dot.title = 'Advisor: idle'; }
  };

  // ── Public API: set wide-screen visibility (used by onboarding) ──────────
  window._setAdvisorWideVisible = function(visible) {
    _wideVisible = visible;
    saveWideVisible(visible);
    applyState();
  };
})();

// ---------------------------------------------------------------------------
// Workers sidebar toggle — handles narrow widths (icon-rail) AND wide-screen hide/show
// ---------------------------------------------------------------------------

(function initWorkersSidebarToggle() {
  const STORAGE_KEY = 'docket_workers_sidebar_expanded';
  // Separate key for whether the sidebar is visible on wide screens (non-null = user has set preference)
  const WIDE_VISIBLE_KEY = 'docket_workers_sidebar_wide_visible';
  const BREAKPOINT_MAX = 1100;
  const BREAKPOINT_MIN = 0; // icon rail handles all narrow widths (no hamburger drawer)

  const sidebar = document.getElementById('orch_sidebar');
  const backdrop = document.getElementById('orch_sidebar_backdrop');
  const toggleBtn = document.getElementById('workers_toggle_btn');
  const dividerRight = document.getElementById('divider_right');

  if (!sidebar || !backdrop || !toggleBtn) return;

  // Build the icon rail element (inserted into orch_sidebar)
  const iconRail = document.createElement('div');
  iconRail.className = 'orch-icon-rail';
  iconRail.setAttribute('aria-label', 'Workers panel');

  // Expand button at the top of the rail
  const railExpandBtn = document.createElement('button');
  railExpandBtn.className = 'orch-rail-expand-btn';
  railExpandBtn.title = 'Expand Workers panel';
  railExpandBtn.setAttribute('aria-label', 'Expand Workers panel');
  railExpandBtn.textContent = '«';
  iconRail.appendChild(railExpandBtn);

  // A small status dot to show orchestrator activity
  const railDot = document.createElement('span');
  railDot.className = 'orch-rail-dot dot-idle';
  railDot.setAttribute('aria-hidden', 'true');
  railDot.title = 'Workers';
  iconRail.appendChild(railDot);

  // Insert at the beginning of the sidebar so it appears above the panel content
  sidebar.insertBefore(iconRail, sidebar.firstChild);

  // ── State management ──────────────────────────────────────────────────────

  function isWideMode() {
    return window.innerWidth > BREAKPOINT_MAX;
  }
  function isNarrowMode() {
    return window.innerWidth <= BREAKPOINT_MAX && window.innerWidth > BREAKPOINT_MIN;
  }

  function loadExpanded() {
    try { return localStorage.getItem(STORAGE_KEY) === 'true'; } catch (e) { return false; }
  }
  function saveExpanded(val) {
    try { localStorage.setItem(STORAGE_KEY, String(val)); } catch (e) { /* ignore */ }
  }

  // Wide-screen visibility: true = visible (default for returning users), false = hidden
  // null means "not set yet" (first visit; will be set by onboarding logic)
  function loadWideVisible() {
    try {
      const v = localStorage.getItem(WIDE_VISIBLE_KEY);
      if (v === null) return null; // not set
      return v === 'true';
    } catch (e) { return null; }
  }
  function saveWideVisible(val) {
    try { localStorage.setItem(WIDE_VISIBLE_KEY, String(val)); } catch (e) { /* ignore */ }
  }

  let _expanded = loadExpanded();
  let _wideVisible = loadWideVisible();
  // Default for returning users (no key): show the sidebar (preserve existing behavior)
  if (_wideVisible === null) _wideVisible = true;

  function applyState() {
    if (isWideMode()) {
      // Wide desktop mode: handle show/hide without icon rail
      sidebar.classList.remove('orch-sidebar-collapsed', 'orch-sidebar-expanded');
      backdrop.classList.remove('open');
      if (_wideVisible) {
        sidebar.classList.remove('orch-sidebar-wide-hidden');
        if (dividerRight) dividerRight.classList.remove('divider-hidden');
        toggleBtn.classList.add('active');
        toggleBtn.setAttribute('aria-expanded', 'true');
        toggleBtn.title = 'Hide Workers panel';
      } else {
        sidebar.classList.add('orch-sidebar-wide-hidden');
        if (dividerRight) dividerRight.classList.add('divider-hidden');
        toggleBtn.classList.remove('active');
        toggleBtn.setAttribute('aria-expanded', 'false');
        toggleBtn.title = 'Show Workers panel';
      }
      return;
    }

    // Remove wide-hidden class when not in wide mode
    sidebar.classList.remove('orch-sidebar-wide-hidden');
    if (dividerRight) dividerRight.classList.remove('divider-hidden');

    if (!isNarrowMode()) {
      // Very narrow / mobile nav — remove icon-rail classes; mobile nav handles it
      sidebar.classList.remove('orch-sidebar-collapsed', 'orch-sidebar-expanded');
      backdrop.classList.remove('open');
      toggleBtn.classList.remove('active');
      toggleBtn.setAttribute('aria-expanded', 'false');
      return;
    }

    if (_expanded) {
      sidebar.classList.add('orch-sidebar-expanded');
      sidebar.classList.remove('orch-sidebar-collapsed');
      backdrop.classList.add('open');
      toggleBtn.classList.add('active');
      toggleBtn.setAttribute('aria-expanded', 'true');
    } else {
      sidebar.classList.add('orch-sidebar-collapsed');
      sidebar.classList.remove('orch-sidebar-expanded');
      backdrop.classList.remove('open');
      toggleBtn.classList.remove('active');
      toggleBtn.setAttribute('aria-expanded', 'false');
    }
  }

  function expand() {
    if (isWideMode()) {
      _wideVisible = true;
      saveWideVisible(true);
    } else {
      _expanded = true;
      saveExpanded(true);
    }
    applyState();
  }

  function collapse() {
    if (isWideMode()) {
      _wideVisible = false;
      saveWideVisible(false);
    } else {
      _expanded = false;
      saveExpanded(false);
    }
    applyState();
  }

  function toggle() {
    if (isWideMode()) {
      if (_wideVisible) collapse(); else expand();
    } else {
      if (_expanded) collapse(); else expand();
    }
  }

  // ── Wire up controls ──────────────────────────────────────────────────────

  toggleBtn.addEventListener('click', toggle);
  railExpandBtn.addEventListener('click', expand);

  // Close on backdrop click
  backdrop.addEventListener('click', collapse);

  // Close on Escape key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && _expanded && isNarrowMode()) collapse();
  });

  // Re-apply on resize (crossing the breakpoint)
  window.addEventListener('resize', applyState, { passive: true });

  // Initial state
  applyState();

  // ── Public API: update rail dot status (called from orchestrator panel) ───
  window._updateWorkersRailDot = function(status) {
    railDot.className = 'orch-rail-dot';
    if (status === 'running') { railDot.classList.add('dot-running'); railDot.title = 'Workers: active'; }
    else { railDot.classList.add('dot-idle'); railDot.title = 'Workers: idle'; }
  };

  // ── Public API: set wide-screen visibility (used by onboarding) ──────────
  window._setWorkersWideVisible = function(visible) {
    _wideVisible = visible;
    saveWideVisible(visible);
    applyState();
  };
})();

// ---------------------------------------------------------------------------
// Mobile / PWA navigation — hamburger drawer
// ---------------------------------------------------------------------------

(function initMobileNav() {
  const mobileNav = document.getElementById('mobile_nav');
  if (!mobileNav) return;

  const overlay = document.getElementById('mobile_nav_overlay');
  const hamburgerBtn = document.getElementById('hamburger_btn');
  const closeBtn = document.getElementById('mobile_nav_close');

  // The three nav buttons inside the drawer
  const navBtns = mobileNav.querySelectorAll('.mobile-nav-btn');

  // Check if we're in mobile/PWA mode (hamburger button is visible)
  function isMobileNavActive() {
    return hamburgerBtn && getComputedStyle(hamburgerBtn).display !== 'none';
  }

  // Open the drawer
  function openDrawer() {
    mobileNav.classList.add('open');
    mobileNav.setAttribute('aria-hidden', 'false');
    if (overlay) {
      overlay.classList.add('open');
      overlay.setAttribute('aria-hidden', 'false');
    }
    if (hamburgerBtn) hamburgerBtn.setAttribute('aria-expanded', 'true');
    // Trap focus: move focus to close button
    if (closeBtn) closeBtn.focus();
  }

  // Close the drawer
  function closeDrawer() {
    mobileNav.classList.remove('open');
    mobileNav.setAttribute('aria-hidden', 'true');
    if (overlay) {
      overlay.classList.remove('open');
      overlay.setAttribute('aria-hidden', 'true');
    }
    if (hamburgerBtn) {
      hamburgerBtn.setAttribute('aria-expanded', 'false');
      hamburgerBtn.focus();
    }
  }

  // Switch the visible pane
  function switchPane(targetPaneId) {
    const panes = ['panel_container', 'orch_sidebar', 'left_sidebar'];
    for (const paneId of panes) {
      const el = document.getElementById(paneId);
      if (el) {
        if (paneId === targetPaneId) {
          el.classList.add('mobile-pane-active');
        } else {
          el.classList.remove('mobile-pane-active');
        }
      }
    }

    // Update button active states
    navBtns.forEach(btn => {
      const isActive = btn.dataset.pane === targetPaneId;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-pressed', String(isActive));
    });

    // Persist the chosen pane
    try {
      localStorage.setItem('docket_mobile_pane', targetPaneId);
    } catch (_) {}
  }

  // Hamburger button opens drawer
  if (hamburgerBtn) {
    hamburgerBtn.addEventListener('click', openDrawer);
  }

  // Close button closes drawer
  if (closeBtn) {
    closeBtn.addEventListener('click', closeDrawer);
  }

  // Backdrop click closes drawer
  if (overlay) {
    overlay.addEventListener('click', closeDrawer);
  }

  // Escape key closes drawer
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && mobileNav.classList.contains('open')) {
      closeDrawer();
    }
  });

  // Nav item click: switch pane and close drawer
  navBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      if (isMobileNavActive()) {
        switchPane(btn.dataset.pane);
        closeDrawer();
      }
    });
  });

  // On load, set the initial active pane (default: tickets)
  function initPane() {
    if (!isMobileNavActive()) return;
    let saved = 'panel_container';
    try {
      const s = localStorage.getItem('docket_mobile_pane');
      if (s && ['panel_container', 'orch_sidebar', 'left_sidebar'].includes(s)) saved = s;
    } catch (_) {}
    switchPane(saved);
  }

  // Run on load and on resize (in case viewport changes)
  initPane();
  window.addEventListener('resize', () => {
    if (isMobileNavActive()) {
      // Ensure at least one pane is visible on mobile
      const anyActive = Array.from(document.querySelectorAll('.mobile-pane-active')).length > 0;
      if (!anyActive) initPane();
    } else {
      // Closing the drawer if we resize back to desktop
      closeDrawer();
    }
  });

})();

// ---------------------------------------------------------------------------
// First-visit onboarding: progressive disclosure for new users
// ---------------------------------------------------------------------------
// On the very first visit (no 'docket_layout_seen_v1' key in localStorage),
// we collapse both sidebars so the user sees a focused, single-panel view.
// We show a brief banner explaining the core loop. On dismiss the banner is
// hidden and the preference is saved — subsequent visits are unaffected.
// ---------------------------------------------------------------------------

(function initFirstVisitOnboarding() {
  // 'docket_layout_seen_v1' is set once the user has gone through onboarding.
  // We also check 'docket_pane_widths' as a proxy for existing users who have
  // previously customised the layout — those users should not have their layout
  // reset even if they haven't seen the new onboarding banner.
  const SEEN_KEY = 'docket_layout_seen_v1';
  const EXISTING_USER_PROXY_KEY = 'docket_pane_widths'; // set whenever user drags sidebar dividers

  let isTrueNewUser = false;
  try {
    const hasSeen = !!localStorage.getItem(SEEN_KEY);
    const hasExistingLayout = !!localStorage.getItem(EXISTING_USER_PROXY_KEY);
    // Only treat as new user if they haven't been through onboarding AND
    // haven't customised their layout (i.e. truly brand new)
    isTrueNewUser = !hasSeen && !hasExistingLayout;
  } catch (_) { /* ignore */ }

  const bannerEl = document.getElementById('onboarding_banner');
  const dismissBtn = document.getElementById('onboarding_dismiss_btn');

  function markSeen() {
    try { localStorage.setItem(SEEN_KEY, '1'); } catch (_) {}
  }

  function dismissBanner() {
    if (bannerEl) bannerEl.classList.add('hidden');
    markSeen();
  }

  if (dismissBtn) {
    dismissBtn.addEventListener('click', dismissBanner);
  }

  // Show the banner on first visit (both new users and existing users who
  // haven't seen the onboarding yet) — but only hide sidebars for true new users
  let showBanner = false;
  try { showBanner = !localStorage.getItem(SEEN_KEY); } catch (_) {}

  if (!showBanner) {
    // Returning user who has dismissed the banner — nothing to do
    return;
  }

  // Show the onboarding banner
  if (bannerEl) bannerEl.classList.remove('hidden');

  if (isTrueNewUser) {
    // True new user: on wide screens, default both sidebars to hidden so the
    // user starts with a focused single-panel view. Toggle buttons in the header
    // let them open the sidebars whenever they're ready.
    if (window.innerWidth > 1100) {
      if (typeof window._setWorkersWideVisible === 'function') {
        window._setWorkersWideVisible(false);
      }
      if (typeof window._setAdvisorWideVisible === 'function') {
        window._setAdvisorWideVisible(false);
      }
    }
  }
  // Note: we do NOT call markSeen() here — the SEEN_KEY is only written on
  // banner dismiss. This means the banner shows on every visit until dismissed.
})();
