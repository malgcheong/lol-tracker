// 롤 트래커 - Electron 메인 프로세스
// 역할: 창 관리 + [통계 1층]이 위반을 판단 → [LCU 2층]이 phase를 감지 → [캐릭터 3층]에 전달
const { app, BrowserWindow, Tray, Menu, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');

const { RiotStats } = require('./stats/riot');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

// ---- 사용자 설정 (settings.json, 없으면 기본값으로 생성) ----
const SETTINGS_PATH = path.join(__dirname, 'settings.json');
const DEFAULT_SETTINGS = {
  riotId: '',        // 닉네임#태그
  apiKey: '',        // developer.riotgames.com 개발 키 (24시간 유효)
  dailyLimit: 5,     // 하루 판수 한도 (이만큼 하면 개입, 0 = 끔)
  lossStreakLimit: 2,// 연패 한도 (이만큼 연패면 개입, 0 = 끔)
  dayResetHour: 5,   // '오늘'이 리셋되는 시각. 새벽 5시 전 게임은 전날로 (심야 롤은 오늘에 누적)
};

let settings = { ...DEFAULT_SETTINGS };
let firstRun = false;
try {
  settings = { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')) };
} catch {
  firstRun = true;
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(DEFAULT_SETTINGS, null, 2));
}

// ---- 상태 ----
let characterWin = null;
let controlWin = null;
let settingsWin = null;
let tray = null;
let lcu = null;

const riot = new RiotStats();
let stats = null;      // { todayCount, lossStreak, fetchedAt } 또는 null(데이터 없음)
let statsError = null;
let lastPhase = 'None';
let snoozeUntil = 0;

// ---- 위반 판단 (개입 트리거, 핸드오프 문서 6-1) ----
function computeVerdict() {
  if (!stats) return { hasData: false, violations: [], stats: null, error: statsError };
  const violations = [];
  if (settings.lossStreakLimit > 0 && stats.lossStreak >= settings.lossStreakLimit) {
    violations.push({ type: 'lossStreak', n: stats.lossStreak, limit: settings.lossStreakLimit });
  }
  if (settings.dailyLimit > 0 && stats.todayCount >= settings.dailyLimit) {
    violations.push({ type: 'daily', n: stats.todayCount, limit: settings.dailyLimit });
  }
  return { hasData: true, violations, stats, error: null };
}

function broadcast(channel, payload) {
  for (const win of [characterWin, controlWin, settingsWin]) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

function pushState() {
  if (Date.now() < snoozeUntil) return; // 스누즈 중엔 조용히
  broadcast('state', { phase: lastPhase, verdict: computeVerdict() });
}

// ---- 통계 새로고침 ----
async function refreshStats(reason) {
  if (!settings.riotId.includes('#') || !settings.apiKey) {
    statsError = '설정에서 라이엇 ID와 API 키를 입력해주세요';
    return;
  }
  try {
    stats = await riot.refresh(settings);
    statsError = null;
    console.log(`[stats] ${reason}: 오늘 ${stats.todayCount}판, ${stats.lossStreak}연패`);
  } catch (err) {
    statsError = err.message;
    console.log(`[stats] ${reason} 실패: ${err.message}`);
  }
  pushState();
}

// ---- 창들 ----
function createCharacterWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  characterWin = new BrowserWindow({
    width: 360, height: 480,
    x: width - 380, y: height - 500,
    transparent: true, frame: false, resizable: false,
    alwaysOnTop: true, skipTaskbar: true, hasShadow: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  characterWin.setAlwaysOnTop(true, 'screen-saver');
  characterWin.loadFile(path.join(__dirname, 'ui', 'character.html'));
}

function createControlWindow() {
  controlWin = new BrowserWindow({
    width: 300, height: 560, x: 40, y: 40,
    title: '가짜 롤 클라이언트 조종판 (mock)',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  controlWin.loadFile(path.join(__dirname, 'ui', 'control.html'));
  controlWin.on('closed', () => { controlWin = null; });
}

function openSettingsWindow() {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    width: 460, height: 640,
    title: '롤 트래커 설정',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  settingsWin.loadFile(path.join(__dirname, 'ui', 'settings.html'));
  settingsWin.on('closed', () => { settingsWin = null; });
}

function createTray() {
  tray = new Tray(path.join(__dirname, 'assets', 'tray.png'));
  tray.setToolTip('롤 트래커');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '설정', click: openSettingsWindow },
    { label: '통계 새로고침', click: () => refreshStats('수동') },
    { type: 'separator' },
    { label: '종료', click: () => app.quit() },
  ]));
  tray.on('click', openSettingsWindow);
}

// ---- 시작 ----
app.whenReady().then(() => {
  createCharacterWindow();
  createTray();

  if (config.mode === 'mock') {
    const { MockLcuClient } = require('./lcu/mock');
    lcu = new MockLcuClient();
    createControlWindow();
  } else {
    const { RealLcuClient } = require('./lcu/real');
    lcu = new RealLcuClient(config.leaguePath);
  }

  lcu.on('phase', (phase) => {
    lastPhase = phase;
    console.log(`[gameflow-phase] ${phase}`); // 실제 클라에서 phase 이름 확인용
    pushState();
    // 게임 끝났으면 잠시 후 전적 갱신 (기록이 올라오는 데 시간이 걸림 - CCTV 녹화본)
    if (phase === 'EndOfGame' && config.mode === 'real') {
      setTimeout(() => refreshStats('게임 종료 후'), 2 * 60 * 1000);
    }
  });
  lcu.on('status', (msg) => {
    console.log(`[lcu] ${msg}`);
    broadcast('status', msg);
  });

  characterWin.webContents.once('did-finish-load', () => {
    lcu.start();
    refreshStats('시작');
  });

  // real 모드에서만 주기 갱신. mock 모드에선 조종판의 가짜 통계를 덮어쓰지 않도록 안 돌림.
  if (config.mode === 'real') {
    setInterval(() => refreshStats('주기'), 5 * 60 * 1000);
  }

  if (firstRun || !settings.apiKey) openSettingsWindow();

  // 커서 위치를 캐릭터에게 계속 알려줌 → 눈동자가 마우스를 따라다님
  setInterval(() => {
    if (!characterWin || characterWin.isDestroyed()) return;
    const p = screen.getCursorScreenPoint();
    const b = characterWin.getBounds();
    characterWin.webContents.send('cursor', { x: p.x - b.x, y: p.y - b.y });
  }, 120);
});

// ---- IPC ----
ipcMain.on('mock-set-phase', (_e, phase) => {
  if (lcu && lcu.setPhase) lcu.setPhase(phase);
});

// 조종판의 가짜 통계 (mock 테스트용)
ipcMain.on('mock-set-stats', (_e, fake) => {
  stats = { todayCount: fake.todayCount, lossStreak: fake.lossStreak, fetchedAt: Date.now() };
  statsError = null;
  pushState();
});

ipcMain.handle('settings-get', () => settings);

ipcMain.handle('settings-save', (_e, next) => {
  settings = { ...settings, ...next };
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
  refreshStats('설정 저장');
  return { ok: true };
});

// 설정 화면의 "연결 테스트" - 저장 전 입력값으로 바로 조회해봄
ipcMain.handle('stats-test', async (_e, candidate) => {
  try {
    const tester = new RiotStats();
    const result = await tester.refresh({ ...settings, ...candidate });
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.on('snooze', (_e, minutes) => {
  snoozeUntil = Date.now() + minutes * 60 * 1000;
  broadcast('state', { phase: 'Snoozing', verdict: computeVerdict() });
  setTimeout(() => {
    snoozeUntil = 0;
    pushState(); // 스누즈 끝나면 현재 상태 재체크
  }, minutes * 60 * 1000);
});

app.on('window-all-closed', () => app.quit());
