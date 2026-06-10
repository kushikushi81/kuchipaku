'use strict';

// KuchiPaku 録画用 Web Worker
// MediaRecorderのチャンクをOPFSへ逐次書き込みし、長時間録画でもRAMに溜め込まない

let accessHandle = null;
let writeOffset = 0;

self.onmessage = async (e) => {
  const { type } = e.data;

  if (type === 'init') {
    try {
      const dir = await navigator.storage.getDirectory();
      const fileHandle = await dir.getFileHandle(e.data.fileName, { create: true });
      accessHandle = await fileHandle.createSyncAccessHandle();
      accessHandle.truncate(0);
      writeOffset = 0;
      self.postMessage({ type: 'ready' });
    } catch (err) {
      self.postMessage({ type: 'error', message: String(err && err.message || err) });
    }
    return;
  }

  if (type === 'chunk') {
    if (!accessHandle) return;
    try {
      writeOffset += accessHandle.write(e.data.buffer, { at: writeOffset });
    } catch (err) {
      self.postMessage({ type: 'error', message: String(err && err.message || err) });
    }
    return;
  }

  if (type === 'finish') {
    if (accessHandle) {
      accessHandle.flush();
      accessHandle.close();
      accessHandle = null;
    }
    self.postMessage({ type: 'finished', size: writeOffset });
    return;
  }

  if (type === 'abort') {
    if (accessHandle) {
      try { accessHandle.close(); } catch {}
      accessHandle = null;
    }
    self.postMessage({ type: 'aborted' });
  }
};
