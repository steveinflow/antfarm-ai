// @docket/admin-panel — esbuild build script
// Produces:
//   dist/admin-panel.min.js  (IIFE bundle, globalName TicketAdminPanel)
//   dist/admin-panel.esm.js  (ESM bundle)

import esbuild from 'esbuild';

const shared = {
  entryPoints: ['src/index.js'],
  bundle: true,
  sourcemap: true,
  target: ['es2020'],
  // Resolve the core package from the monorepo
  // esbuild will follow the package.json exports
};

async function build() {
  // IIFE bundle
  await esbuild.build({
    ...shared,
    outfile: 'dist/admin-panel.min.js',
    format: 'iife',
    globalName: 'TicketAdminPanel',
    minify: true,
  });

  // ESM bundle
  await esbuild.build({
    ...shared,
    outfile: 'dist/admin-panel.esm.js',
    format: 'esm',
    minify: false,
  });

  console.log('Build complete:');
  console.log('  dist/admin-panel.min.js  (IIFE)');
  console.log('  dist/admin-panel.esm.js  (ESM)');
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
