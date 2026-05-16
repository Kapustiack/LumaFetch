const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const skipDirs = new Set(['.git', 'node_modules', 'release', '__pycache__']);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: options.stdio || 'pipe',
    windowsHide: true,
  });
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`${command} ${args.join(' ')} failed${output ? `\n${output}` : ''}`);
  }
  return result;
}

function findFiles(dir, extension) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skipDirs.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...findFiles(fullPath, extension));
    } else if (entry.isFile() && entry.name.endsWith(extension)) {
      files.push(fullPath);
    }
  }
  return files;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function checkJavaScriptSyntax() {
  for (const filePath of findFiles(root, '.js')) {
    run(process.execPath, ['--check', filePath]);
  }
}

function checkCoreHelpers() {
  const { normalizeAudioQuality, formatSelectorForQuality } = require('../electron_app/core/ytdlp');
  const { collectMediaFiles } = require('../electron_app/core/converter');

  assert(normalizeAudioQuality('192k') === '192K', 'Expected 192k to normalize to 192K.');
  assert(normalizeAudioQuality('320') === '320K', 'Expected 320 to normalize to 320K.');
  assert(normalizeAudioQuality('bad') === '192K', 'Expected invalid quality to fall back to 192K.');
  assert(formatSelectorForQuality('720p').includes('height<=720'), 'Expected 720p selector to cap height.');
  assert(Array.isArray(collectMediaFiles([], true)), 'Expected collectMediaFiles to return an array.');
}

function checkPythonSyntax() {
  const python = spawnSync('python', ['--version'], { encoding: 'utf8', windowsHide: true });
  if (python.status === 0) {
    run('python', ['-m', 'compileall', 'telegram_bot_app', 'webm_to_mp3_converter.py'], { stdio: 'inherit' });
    return;
  }

  const py = spawnSync('py', ['-3', '--version'], { encoding: 'utf8', windowsHide: true });
  if (py.status === 0) {
    run('py', ['-3', '-m', 'compileall', 'telegram_bot_app', 'webm_to_mp3_converter.py'], { stdio: 'inherit' });
  }
}

checkJavaScriptSyntax();
checkCoreHelpers();
checkPythonSyntax();

console.log('Validation passed.');
