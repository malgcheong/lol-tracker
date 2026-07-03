// 렌더러(캐릭터/조종판/설정 화면)와 메인 프로세스 사이의 다리
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tracker', {
  // 상태 수신: { phase, verdict: { hasData, violations, stats, error } }
  onState: (cb) => ipcRenderer.on('state', (_e, state) => cb(state)),
  onStatus: (cb) => ipcRenderer.on('status', (_e, msg) => cb(msg)),
  onCursor: (cb) => ipcRenderer.on('cursor', (_e, pos) => cb(pos)),

  // 캐릭터
  snooze: (minutes) => ipcRenderer.send('snooze', minutes),

  // 조종판 (mock 전용)
  setPhase: (phase) => ipcRenderer.send('mock-set-phase', phase),
  setStats: (fake) => ipcRenderer.send('mock-set-stats', fake),

  // 설정 화면
  getSettings: () => ipcRenderer.invoke('settings-get'),
  saveSettings: (s) => ipcRenderer.invoke('settings-save', s),
  testStats: (s) => ipcRenderer.invoke('stats-test', s),
});
