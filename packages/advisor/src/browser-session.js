// Shared Playwright session runner used by the QA and Design personas.
// Requires Playwright: npm install playwright && npx playwright install chromium
//
// captureSession() drives a headless browser through a flow DSL and returns
// an array of step results, each with a screenshot buffer and any console errors.

import { get as httpsGet } from 'node:https';
import { get as httpGet } from 'node:http';

// ── SSRF protection ────────────────────────────────────────────────────────
// Validate that a URL is safe to navigate to — rejects localhost, private IP
// ranges, cloud metadata endpoints, and non-HTTP/HTTPS schemes.
//
// The appUrl comes from Firestore config (user-controlled).  Without this
// check, a malicious config could point Chromium at internal services,
// the EC2/GCE metadata endpoint (169.254.169.254), or other private targets.
//
// Hostname patterns that are ALWAYS rejected:
//   • localhost / *.localhost
//   • 127.x.x.x  (IPv4 loopback)
//   • ::1 / [::1]  (IPv6 loopback)
//   • 0.0.0.0
//   • 169.254.x.x  (link-local / cloud metadata)
//   • 10.x.x.x     (RFC-1918 private)
//   • 172.16-31.x.x (RFC-1918 private)
//   • 192.168.x.x  (RFC-1918 private)
//   • fc00::/7 (fd00:: prefix) — IPv6 ULA
//   • Non-http/https schemes
//
// Returns { safe: true } or { safe: false, reason: string }.

const PRIVATE_IPV4_RE = [
  /^127\./,                         // 127.0.0.0/8 loopback
  /^169\.254\./,                    // 169.254.0.0/16 link-local / metadata
  /^10\./,                          // 10.0.0.0/8 RFC-1918
  /^172\.(1[6-9]|2\d|3[01])\./,    // 172.16.0.0/12 RFC-1918
  /^192\.168\./,                    // 192.168.0.0/16 RFC-1918
  /^0\.0\.0\.0$/,                   // unspecified
];

// Strip IPv6 brackets: [::1] → ::1
function stripBrackets(hostname) {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
}

export function isSafeUrl(urlString) {
  let parsed;
  try {
    parsed = new URL(urlString);
  } catch {
    return { safe: false, reason: 'invalid URL' };
  }

  // Only allow http and https
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { safe: false, reason: `disallowed scheme: ${parsed.protocol}` };
  }

  const hostname = stripBrackets(parsed.hostname).toLowerCase();

  // Reject empty hostname
  if (!hostname) {
    return { safe: false, reason: 'missing hostname' };
  }

  // Reject localhost and *.localhost
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    return { safe: false, reason: 'localhost is not allowed' };
  }

  // Reject IPv4 loopback / private / metadata ranges
  for (const re of PRIVATE_IPV4_RE) {
    if (re.test(hostname)) {
      return { safe: false, reason: `private or reserved IP range: ${hostname}` };
    }
  }

  // Reject IPv6 loopback (::1)
  if (hostname === '::1') {
    return { safe: false, reason: 'IPv6 loopback is not allowed' };
  }

  // Reject IPv6 link-local (fe80::/10)
  if (/^fe[89ab][0-9a-f]:/i.test(hostname)) {
    return { safe: false, reason: `IPv6 link-local address is not allowed: ${hostname}` };
  }

  // Reject IPv6 ULA (fc00::/7 — covers fc00:: and fd00::)
  if (/^f[cd][0-9a-f]{2}:/i.test(hostname)) {
    return { safe: false, reason: `IPv6 ULA address is not allowed: ${hostname}` };
  }

  return { safe: true };
}

/**
 * Resolve a flow path against a base app URL.
 *
 * Flow paths in docket.config.json are relative to the application root
 * (appUrl), NOT relative to the host origin.  This is the key difference
 * from a plain `new URL(flow, base)` call, which treats a leading "/" as
 * root-relative (host origin), causing two problems:
 *
 *   1. appUrl="https://host/projects/docket/" + flow="/" would resolve to
 *      "https://host/" (host root) instead of the app root.
 *
 *   2. A naive string concatenation of appUrl + flow when both contain the
 *      same path (e.g. appUrl="…/projects/docket/" + flow="/projects/docket/")
 *      produces a doubled URL: "…/projects/docket/projects/docket/".
 *
 * This function treats "/" (or empty) as "the app root" (returns appUrl) and
 * appends any other path relative to appUrl's pathname, then deduplicates a
 * doubled prefix in case legacy config stored the full path in appFlows.
 *
 * Correct appFlows config: use paths relative to the app root, e.g. "/" or
 * "/settings" — do NOT repeat the deployment base path that is already in
 * appUrl (e.g. do NOT set appFlows: ["/projects/docket/"]).
 *
 * If flow is already absolute (starts with http/https), it is returned as-is.
 *
 * @param {string} appUrl  - Base app URL (e.g. "https://host.example.com/foo/")
 * @param {string} flow    - Flow path, either absolute or relative (e.g. "/" or "/bar")
 * @returns {string} Fully-qualified URL string
 */
export function resolveUrl(appUrl, flow) {
  if (flow.startsWith('http')) return flow;

  // Empty or root "/" means "visit the app home" — return appUrl unchanged.
  if (!flow || flow === '/') return appUrl;

  try {
    const base = new URL(appUrl);
    const basePath = base.pathname; // e.g. "/projects/docket/"

    // Treat flow as relative to the basePath (not the host root).
    // Strip one leading slash so we can append to basePath cleanly.
    const flowRelative = flow.startsWith('/') ? flow.slice(1) : flow;
    const joined = basePath.endsWith('/') ? basePath + flowRelative : `${basePath}/${flowRelative}`;

    // Deduplicate a doubled base-path prefix that can occur when legacy config
    // stored the full path in both appUrl and appFlows.
    // e.g. basePath="/projects/docket/" + flow="/projects/docket/"
    //      → flowRelative="projects/docket/" → joined="/projects/docket/projects/docket/"
    //      which looks wrong; we recover by stripping the duplicated prefix.
    const basePathNoTrail = basePath.replace(/\/$/, '');
    if (basePathNoTrail && basePathNoTrail !== '/') {
      const doubled = basePathNoTrail + basePathNoTrail;
      if (joined.startsWith(doubled)) {
        const result = new URL(appUrl);
        result.pathname = joined.slice(basePathNoTrail.length);
        return result.href;
      }
    }

    // Collapse any accidental double-slashes in the path (belt-and-suspenders).
    const normalised = joined.replace(/\/\/+/g, '/');
    const result = new URL(appUrl);
    result.pathname = normalised;
    return result.href;
  } catch {
    // Fallback: plain string concatenation, collapsing any double-slashes.
    return `${appUrl}${flow}`.replace(/([^:])\/\/+/g, '$1/');
  }
}

/**
 * Check whether a URL returns a successful HTTP status code (2xx).
 * Follows up to one redirect. Returns { ok: boolean, status: number }.
 *
 * @param {string} url
 * @returns {Promise<{ ok: boolean, status: number }>}
 */
export function checkUrlReachable(url) {
  return new Promise((resolve) => {
    const getter = url.startsWith('https') ? httpsGet : httpGet;
    try {
      const req = getter(url, { timeout: 10_000 }, (res) => {
        const status = res.statusCode ?? 0;
        res.resume(); // discard body
        resolve({ ok: status >= 200 && status < 400, status });
      });
      req.on('error', () => resolve({ ok: false, status: 0 }));
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0 }); });
    } catch {
      resolve({ ok: false, status: 0 });
    }
  });
}

/**
 * Execute a single flow step.
 *
 * Supported step actions:
 *   screenshot  — no-op (screenshot is captured after every visible step automatically)
 *   click       — click a locator (selector string, Playwright-compatible)
 *   fill        — fill a text input / textarea (selector + text)
 *   wait        — pause for `ms` milliseconds (no screenshot captured after this)
 *   scroll      — scroll down half a viewport
 *   navigate    — go to a url (absolute, or relative to appUrl)
 *
 * @param {import('playwright').Page} page
 * @param {object} step
 * @param {string} appUrl - Base URL used to resolve relative navigate URLs
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function executeStep(page, step, appUrl) {
  try {
    switch (step.action) {
      case 'screenshot':
        return { ok: true };

      case 'click': {
        if (step.selector) {
          await page.locator(step.selector).first().click({ timeout: 5_000 });
        }
        return { ok: true };
      }

      case 'fill': {
        if (step.selector && step.text != null) {
          await page.locator(step.selector).first().fill(String(step.text), { timeout: 5_000 });
        }
        return { ok: true };
      }

      case 'wait': {
        await page.waitForTimeout(step.ms ?? 1_000);
        return { ok: true };
      }

      case 'scroll': {
        await page.evaluate(() => window.scrollBy(0, window.innerHeight / 2));
        return { ok: true };
      }

      case 'navigate': {
        if (step.url) {
          const url = resolveUrl(appUrl, step.url);
          // SSRF guard: reject private/internal targets even in navigate steps.
          // step.url is user-supplied from Firestore config.
          const ssrfCheck = isSafeUrl(url);
          if (!ssrfCheck.safe) {
            return { ok: false, error: `SSRF guard blocked navigate to "${url}": ${ssrfCheck.reason}` };
          }
          await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
        }
        return { ok: true };
      }

      default:
        return { ok: true }; // unknown step type — skip silently
    }
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Run a Playwright session through all configured flows.
 * Each flow gets a fresh page. A screenshot is captured after every non-wait step.
 *
 * @param {string} appUrl - Base URL of the application
 * @param {object[]} flows - Flow definitions from docket.config.json (qaFlows)
 * @param {object} [options]
 * @param {Function} [options.onLog] - Optional log callback (line: string) => void
 * @returns {Promise<Array<{
 *   flowName: string,
 *   stepName: string,
 *   screenshot: Buffer,
 *   consoleErrors: string[],
 *   stepFailed: boolean,
 *   stepError?: string
 * }>>}
 */
export async function captureSession(appUrl, flows, { onLog, localStorage: lsItems, cookies } = {}) {
  const log = onLog || (() => {});

  // SSRF guard: validate appUrl before launching any browser session.
  // appUrl comes from Firestore config (user-controlled) and must not point
  // at localhost, private IP ranges, or cloud metadata endpoints.
  const appUrlSsrfCheck = isSafeUrl(appUrl);
  if (!appUrlSsrfCheck.safe) {
    throw new Error(`SSRF guard: appUrl "${appUrl}" is not allowed — ${appUrlSsrfCheck.reason}`);
  }

  let chromium;
  try {
    const pw = await import('playwright');
    chromium = pw.chromium;
  } catch {
    throw new Error('Playwright not installed. Run: npm install playwright && npx playwright install chromium');
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });

  if (cookies && cookies.length > 0) {
    await context.addCookies(cookies);
  }
  if (lsItems && Object.keys(lsItems).length > 0) {
    await context.addInitScript((items) => {
      for (const [k, v] of Object.entries(items)) localStorage.setItem(k, v);
    }, lsItems);
  }
  const allStepResults = [];

  for (const flow of flows) {
    const flowName = flow.name || 'Unnamed flow';
    log(`Running flow: "${flowName}"`);

    const page = await context.newPage();
    const consoleErrors = [];
    page.on('console', msg => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', err => consoleErrors.push(`[pageerror] ${err.message}`));

    // Navigate to the flow's start URL (or appUrl if not specified)
    const startUrl = flow.url ? resolveUrl(appUrl, flow.url) : appUrl;

    // SSRF guard: re-validate each resolved flow URL in case flow.url is an
    // absolute URL pointing at a private/internal target.
    const flowSsrfCheck = isSafeUrl(startUrl);
    if (!flowSsrfCheck.safe) {
      log(`  Flow "${flowName}": SSRF guard blocked "${startUrl}" — ${flowSsrfCheck.reason}`);
      await page.close();
      continue;
    }

    // Validate URL is reachable before launching Playwright navigation.
    // A 4xx/5xx response means we captured the wrong page (e.g. a 404 error screen)
    // rather than the actual application — abort this flow with a clear error.
    const { ok: urlOk, status: urlStatus } = await checkUrlReachable(startUrl);
    if (!urlOk) {
      log(`  Flow "${flowName}": URL ${startUrl} returned HTTP ${urlStatus || 'error'} — skipping flow`);
      await page.close();
      continue;
    }

    try {
      await page.goto(startUrl, { waitUntil: 'networkidle', timeout: 30_000 });
      await page.waitForTimeout(800);
    } catch (err) {
      log(`  Flow "${flowName}": failed to load ${startUrl}: ${err.message}`);
      await page.close();
      continue;
    }

    const steps = flow.steps || [{ action: 'screenshot', name: 'Page load' }];

    for (const step of steps) {
      const stepName = step.name || step.action || 'Step';

      // Snapshot errors accumulated since the last step, then reset for next step
      const stepErrors = [...consoleErrors];
      consoleErrors.length = 0;

      const result = await executeStep(page, step, appUrl);
      if (!result.ok) {
        log(`  Step "${stepName}" failed${step.optional ? ' (optional)' : ''}: ${result.error}`);
      }

      // Capture a screenshot after every step except pure waits
      if (step.action !== 'wait') {
        try {
          await page.waitForTimeout(400);
          const buf = await page.screenshot({ fullPage: false, type: 'png' });
          allStepResults.push({
            flowName,
            stepName,
            screenshot: buf,
            consoleErrors: stepErrors,
            stepFailed: !result.ok,
            stepError: result.error,
          });
          log(`  Captured "${stepName}" (${Math.round(buf.length / 1024)} KB)${result.ok ? '' : ' [step failed]'}`);
        } catch (err) {
          log(`  Screenshot failed for "${stepName}": ${err.message}`);
        }
      }
    }

    await page.close();
  }

  await browser.close();
  return allStepResults;
}
