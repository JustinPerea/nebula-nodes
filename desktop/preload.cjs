const { contextBridge } = require('electron');

// Phase 1 deliberately exposes no filesystem, credential, or process access
// to the React renderer. Native integrations are added one reviewed IPC method
// at a time in later phases.
contextBridge.exposeInMainWorld('nebulaDesktop', {
  platform: process.platform,
  shell: 'electron',
});
