const { spawn } = require('node:child_process');

function createCancelToken() {
  return {
    cancelled: false,
    children: new Set(),
  };
}

function killProcessTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.on('error', () => {});
    return;
  }
  child.kill('SIGTERM');
}

function registerCancelableChild(cancelToken, child) {
  if (!cancelToken || !child) return () => {};
  if (!cancelToken.children) cancelToken.children = new Set();
  cancelToken.children.add(child);

  const cleanup = () => {
    if (cancelToken.children) cancelToken.children.delete(child);
  };
  child.once('exit', cleanup);
  child.once('error', cleanup);

  if (cancelToken.cancelled) {
    killProcessTree(child);
  }

  return cleanup;
}

function requestCancel(cancelToken) {
  if (!cancelToken) return;
  cancelToken.cancelled = true;
  for (const child of [...(cancelToken.children || [])]) {
    killProcessTree(child);
  }
}

module.exports = {
  createCancelToken,
  killProcessTree,
  registerCancelableChild,
  requestCancel,
};
