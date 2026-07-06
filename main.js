// 롤 트래커 - Electron 메인 프로세스
// 역할: 창 관리 + [통계 1층]이 위반을 판단 → [LCU 2층]이 phase를 감지 → [캐릭터 3층]에 전달
const { app, BrowserWindow, Tray, Menu, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');

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

// ---- 여의주 (약속 지킨 날마다 수집, state.json에 저장) ----
const STATE_PATH = path.join(__dirname, 'state.json');
let orbState = { orbs: 0, lastSeen: null }; // lastSeen: { day, count } - 마지막으로 본 '논리적 하루'와 그날 판수
try { orbState = { ...orbState, ...JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) }; } catch {}
function saveOrbState() { fs.writeFileSync(STATE_PATH, JSON.stringify(orbState, null, 2)); }
// 새벽 리셋 시각 기준의 '논리적 하루' 키 (예: 새벽 5시 전은 전날로)
function dayKey() {
  const d = new Date();
  d.setHours(d.getHours() - settings.dayResetHour);
  return d.toISOString().slice(0, 10);
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
let blockerWin = null;
let forcedThroughMain = false; // 이번 로비 세션 동안 "그래도 할래"로 뚫었는지

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

// ---- 플레이 버튼 덮기 (핸드오프 문서 4-2) ----
// 롤 클라이언트 창의 우하단(플레이 버튼 위치)에 always-on-top 블로커 창을 얹는다.
// 게임 파일엔 손 안 대고 "내 창을 위에 올렸을 뿐"이라 Vanguard 안전.
function findClientRect() {
  return new Promise((resolve) => {
    if (config.mode === 'mock') {
      // 사무실엔 롤이 없으니 화면 우하단에 가짜 클라 영역을 시뮬레이션
      const { width, height } = screen.getPrimaryDisplay().workAreaSize;
      return resolve({ x: width - 900, y: height - 640, w: 880, h: 600 });
    }
    // 실제 모드: win32로 "League of Legends" 클라 창의 화면 좌표를 구함
    const ps = [
      'Add-Type \'using System;using System.Runtime.InteropServices;',
      'public class W{[DllImport("user32.dll")]public static extern IntPtr FindWindow(string c,string n);',
      '[DllImport("user32.dll")]public static extern bool GetWindowRect(IntPtr h,out RECT r);',
      'public struct RECT{public int L,T,R,B;}}\';',
      '$h=[W]::FindWindow($null,"League of Legends");',
      '$r=New-Object W+RECT;[void][W]::GetWindowRect($h,[ref]$r);',
      'Write-Output "$($r.L),$($r.T),$($r.R),$($r.B)"',
    ].join('');
    exec(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`, (err, stdout) => {
      if (err) return resolve(null);
      const m = String(stdout).trim().match(/(-?\d+),(-?\d+),(-?\d+),(-?\d+)/);
      if (!m) return resolve(null);
      const [, l, t, r, b] = m.map(Number);
      if (r - l < 400 || b - t < 300) return resolve(null); // 최소화됐거나 못 찾음
      resolve({ x: l, y: t, w: r - l, h: b - t });
    });
  });
}

function ensureBlockerWindow() {
  if (blockerWin && !blockerWin.isDestroyed()) return;
  blockerWin = new BrowserWindow({
    width: 300, height: 220,
    transparent: true, frame: false, resizable: false,
    alwaysOnTop: true, skipTaskbar: true, hasShadow: false, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  blockerWin.setAlwaysOnTop(true, 'screen-saver');
  blockerWin.loadFile(path.join(__dirname, 'ui', 'block.html'));
}

async function updateBlocker() {
  const v = computeVerdict();
  const shouldBlock =
    v.violations.length > 0 &&
    ['Lobby', 'Matchmaking'].includes(lastPhase) &&
    !forcedThroughMain &&
    Date.now() >= snoozeUntil;

  if (!shouldBlock) {
    if (blockerWin && !blockerWin.isDestroyed()) blockerWin.hide();
    return;
  }

  const rect = await findClientRect();
  if (!rect) {
    // 클라 창을 못 찾으면 버튼을 못 덮음 → 캐릭터 잔소리(character.html)로 폴백
    if (blockerWin && !blockerWin.isDestroyed()) blockerWin.hide();
    return;
  }

  ensureBlockerWindow();
  const bw = 300, bh = 220;
  // 플레이 버튼 = 클라 우하단. 그 위에 얹는다.
  const bx = Math.round(rect.x + rect.w - bw - 24);
  const by = Math.round(rect.y + rect.h - bh - 12);
  blockerWin.setBounds({ x: bx, y: by, width: bw, height: bh });
  blockerWin.showInactive(); // 포커스는 뺏지 않되 위에 뜸
  blockerWin.webContents.send('block', v);
}

function pushState() {
  updateBlocker(); // 창 위치/표시 갱신 (스누즈 중이어도 숨김 처리 위해 먼저 호출)
  if (Date.now() < snoozeUntil) return; // 스누즈 중엔 캐릭터 대사는 조용히
  broadcast('state', { phase: lastPhase, verdict: computeVerdict(), orbs: orbState.orbs });
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
    // 하루가 넘어갔으면 어제를 정산: 게임을 했는데 약속 안에서 멈췄으면 여의주 +1
    const day = dayKey();
    if (orbState.lastSeen && orbState.lastSeen.day !== day) {
      const y = orbState.lastSeen;
      if (settings.dailyLimit > 0 && y.count > 0 && y.count <= settings.dailyLimit) {
        orbState.orbs++;
        console.log(`[orb] 어제(${y.day}) 약속 지킴 → 여의주 ${orbState.orbs}개`);
        broadcast('orb-earned', orbState.orbs);
      }
    }
    orbState.lastSeen = { day, count: stats.todayCount };
    saveOrbState();
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
    width: 300, height: 720, x: 40, y: 40,
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
    // 로비/매칭 구간을 벗어나면 "그래도 할래" 통과 상태 초기화 (다음 세션에 다시 막게)
    if (!['Lobby', 'Matchmaking'].includes(phase)) forcedThroughMain = false;
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
    if (config.mode === 'mock') {
      // 개발 확인용 시드 (조종판으로 덮어쓸 수 있음)
      stats = { todayCount: 2, lossStreak: 0, fetchedAt: Date.now() };
      pushState();
    } else {
      refreshStats('시작');
    }
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

// 조종판의 여의주 조작 (mock 테스트/단계 미리보기용)
ipcMain.on('mock-set-orbs', (_e, n) => {
  orbState.orbs = Math.max(0, Math.floor(n) || 0);
  saveOrbState();
  pushState();
});
ipcMain.on('mock-earn-orb', () => {
  orbState.orbs++;
  saveOrbState();
  broadcast('orb-earned', orbState.orbs); // 획득 연출은 캐릭터가 알아서
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
  if (blockerWin && !blockerWin.isDestroyed()) blockerWin.hide(); // 버튼 즉시 열어줌
  broadcast('state', { phase: 'Snoozing', verdict: computeVerdict(), orbs: orbState.orbs });
  setTimeout(() => {
    snoozeUntil = 0;
    pushState(); // 스누즈 끝나면 현재 상태 재체크 (아직 로비면 다시 막음)
  }, minutes * 60 * 1000);
});

// "그래도 할래" 3번 뚫음 → 이번 로비 세션 동안 블로커 해제
ipcMain.on('force-through', () => {
  forcedThroughMain = true;
  if (blockerWin && !blockerWin.isDestroyed()) blockerWin.hide();
});

app.on('before-quit', () => { if (blockerWin && !blockerWin.isDestroyed()) blockerWin.destroy(); });

app.on('window-all-closed', () => app.quit());
