#!/usr/bin/env node
// Pinger's entry point: check the Node version, quiet one known warning, start the app.

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(
    `Pinger needs Node.js 22.13 or newer (you have ${process.versions.node}).\nDownload the current version from https://nodejs.org and run this again.`,
  );
  process.exit(1);
}

// Node still labels its built-in SQLite "experimental"; that warning means nothing to a user.
const emitWarning = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  const type = typeof rest[0] === 'string' ? rest[0] : rest[0]?.type;
  if (type === 'ExperimentalWarning' && /sqlite/i.test(String(warning?.message ?? warning))) return;
  return emitWarning.call(process, warning, ...rest);
};

const { main } = await import('../src/main.js');
await main(process.argv.slice(2));
