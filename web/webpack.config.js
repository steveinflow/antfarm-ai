import path from 'path';
import { fileURLToPath } from 'url';
import { copyFileSync, existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'fs';
import webpack from 'webpack';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env file if present (for local development).
// Variables already set in the environment take precedence.
// .env is gitignored — never commit real credentials; use .env.example as a template.
const envFilePath = path.resolve(__dirname, '.env');
if (existsSync(envFilePath)) {
  const envLines = readFileSync(envFilePath, 'utf-8').split('\n');
  for (const line of envLines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    // Only set if not already provided — shell env takes precedence over .env
    if (key && !(key in process.env)) {
      process.env[key] = val;
    }
  }
}

// Read version from package.json
const pkg = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8'));
const version = pkg.version;

// Detect canary vs production environment
const isCanary = process.env.DOCKET_ENV === 'canary';

// Firebase configuration — loaded from environment variables, falling back to
// docket.config.json → webFirebaseConfig when env vars aren't set.
// See web/.env.example for the full list of required variables.
let docketWebConfig = {};
try {
  const cfgPath = path.resolve(__dirname, '..', 'docket.config.json');
  if (existsSync(cfgPath)) {
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    docketWebConfig = cfg.webFirebaseConfig || {};
  }
} catch {}

const firebaseConfig = {
  apiKey:            process.env.FIREBASE_API_KEY            || docketWebConfig.apiKey,
  authDomain:        process.env.FIREBASE_AUTH_DOMAIN        || docketWebConfig.authDomain,
  projectId:         process.env.FIREBASE_PROJECT_ID         || docketWebConfig.projectId,
  storageBucket:     process.env.FIREBASE_STORAGE_BUCKET     || docketWebConfig.storageBucket,
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || docketWebConfig.messagingSenderId,
  appId:             process.env.FIREBASE_APP_ID             || docketWebConfig.appId,
};

// Favicons as inline SVG data URIs
const FAVICON_RELEASE = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='6' fill='%231a1a1a'/%3E%3Ctext x='16' y='23' font-family='Inter%2C-apple-system%2Csans-serif' font-size='20' font-weight='600' fill='%23ffffff' text-anchor='middle'%3ED%3C/text%3E%3C/svg%3E";
const FAVICON_CANARY  = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='6' fill='%23cc6600'/%3E%3Ctext x='16' y='23' font-family='Inter%2C-apple-system%2Csans-serif' font-size='20' font-weight='600' fill='%23ffffff' text-anchor='middle'%3ED%3C/text%3E%3C/svg%3E";

// Simple webpack plugin that copies src/index.html -> dist/index.html and writes version.json
class CopyHtmlPlugin {
  apply(compiler) {
    compiler.hooks.afterEmit.tap('CopyHtmlPlugin', () => {
      const src = path.resolve(__dirname, 'src', 'index.html');
      const dest = path.resolve(__dirname, 'dist', 'index.html');
      mkdirSync(path.dirname(dest), { recursive: true });

      // Substitute canary favicon so the browser tab is visually distinct from release
      if (isCanary) {
        let html = readFileSync(src, 'utf-8');
        html = html.replace(FAVICON_RELEASE, FAVICON_CANARY);
        writeFileSync(dest, html);
      } else {
        copyFileSync(src, dest);
      }

      // Write version.json for auto-reload detection
      const versionJson = JSON.stringify({
        version,
        env: isCanary ? 'canary' : 'production',
        builtAt: new Date().toISOString(),
      });
      writeFileSync(path.resolve(__dirname, 'dist', 'version.json'), versionJson);

      // Copy 404.html for GitHub Pages SPA routing fallback
      // Apply the same canary favicon swap so the browser tab is visually distinct
      if (isCanary) {
        let html404 = readFileSync(path.resolve(__dirname, 'src', '404.html'), 'utf-8');
        html404 = html404.replace(FAVICON_RELEASE, FAVICON_CANARY);
        writeFileSync(path.resolve(__dirname, 'dist', '404.html'), html404);
      } else {
        copyFileSync(
          path.resolve(__dirname, 'src', '404.html'),
          path.resolve(__dirname, 'dist', '404.html')
        );
      }

      // Copy PWA manifest
      copyFileSync(
        path.resolve(__dirname, 'src', 'manifest.json'),
        path.resolve(__dirname, 'dist', 'manifest.json')
      );

      // Copy service worker (must be at root of deployment scope)
      copyFileSync(
        path.resolve(__dirname, 'src', 'sw.js'),
        path.resolve(__dirname, 'dist', 'sw.js')
      );
    });
  }
}

export default {
  entry: './src/index.js',
  output: {
    filename: 'bundle.js',
    path: path.resolve(__dirname, 'dist'),
  },
  module: {
    rules: [
      {
        test: /\.css$/,
        use: ['style-loader', 'css-loader'],
      },
    ],
  },
  plugins: [
    new CopyHtmlPlugin(),
    // Inject DOCKET_ENV and Firebase config into the bundle at build time.
    // Firebase values come from environment variables (see web/.env.example).
    new webpack.DefinePlugin({
      'process.env.DOCKET_ENV':                    JSON.stringify(isCanary ? 'canary' : 'production'),
      'process.env.FIREBASE_API_KEY':              JSON.stringify(firebaseConfig.apiKey),
      'process.env.FIREBASE_AUTH_DOMAIN':          JSON.stringify(firebaseConfig.authDomain),
      'process.env.FIREBASE_PROJECT_ID':           JSON.stringify(firebaseConfig.projectId),
      'process.env.FIREBASE_STORAGE_BUCKET':       JSON.stringify(firebaseConfig.storageBucket),
      'process.env.FIREBASE_MESSAGING_SENDER_ID':  JSON.stringify(firebaseConfig.messagingSenderId),
      'process.env.FIREBASE_APP_ID':               JSON.stringify(firebaseConfig.appId),
    }),
  ],
  devServer: {
    static: path.resolve(__dirname, 'dist'),
    port: 3001,
    hot: true,
  },
};
