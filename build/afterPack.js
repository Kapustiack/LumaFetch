const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function run(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || stdout || error.message));
        return;
      }
      resolve();
    });
  });
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;

  const exePath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`);
  const iconPath = path.join(context.packager.projectDir, 'electron_app', 'assets', 'lumafetch-icon.ico');
  const rceditPath = path.join(context.packager.projectDir, 'node_modules', 'electron-winstaller', 'vendor', 'rcedit.exe');

  if (!fs.existsSync(exePath) || !fs.existsSync(iconPath) || !fs.existsSync(rceditPath)) {
    throw new Error('Could not stamp Windows icon: missing exe, icon, or rcedit.');
  }

  await run(rceditPath, [
    exePath,
    '--set-icon',
    iconPath,
    '--set-version-string',
    'FileDescription',
    context.packager.appInfo.description || 'LumaFetch',
    '--set-version-string',
    'ProductName',
    context.packager.appInfo.productName,
    '--set-version-string',
    'InternalName',
    context.packager.appInfo.productFilename,
    '--set-file-version',
    context.packager.appInfo.version,
    '--set-product-version',
    context.packager.appInfo.version,
  ]);
};
