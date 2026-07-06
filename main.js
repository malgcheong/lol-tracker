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
  hardMode: false,   // 하드 모드: 하루 한도 초과 시 롤 클라이언트 강제 종료 + 재실행 감시
};

let settings = { ...DEFAULT_SETTINGS };
let firstRun = false;
try {
  settings = { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')) };
} catch {
  firstRun = true;
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(DEFAULT_SETTINGS, null, 2));
}

// ---- 여의주 = 연속 지킴 (streak을 state.json에 저장, 여의주는 계산값) ----
// 연속 7일 → 1개(몽실이) / 14일 → 2개(몽무기) / 28일 → 3개. 하루라도 초과하면 즉시 0으로 리셋.
const STATE_PATH = path.join(__dirname, 'state.json');
let orbState = { streak: 0, lastSeen: null }; // lastSeen: { day, count } - 마지막으로 본 '논리적 하루'와 그날 판수
try {
  const loaded = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  orbState = { streak: 0, lastSeen: null, ...loaded };
  // 구버전(orbs 저장) 마이그레이션
  if (loaded.orbs != null && loaded.streak == null) {
    orbState.streak = loaded.orbs >= 3 ? 28 : loaded.orbs === 2 ? 14 : loaded.orbs === 1 ? 7 : 0;
  }
} catch {}
function orbsOf(streak) { return streak >= 28 ? 3 : streak >= 14 ? 2 : streak >= 7 ? 1 : 0; }
function saveOrbState() {
  // mock 모드는 조종판 미리보기용이라 파일에 안 씀 — 실제 진행도(state.json)를 안 건드림
  if (config.mode === 'mock') return;
  fs.writeFileSync(STATE_PATH, JSON.stringify(orbState, null, 2));
}
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
  broadcast('state', {
    phase: lastPhase,
    verdict: computeVerdict(),
    orbs: orbsOf(orbState.streak),
    streak: orbState.streak,
  });
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
    // 하루가 넘어갔으면 어제를 정산: 게임을 했고 약속 안에서 멈췄으면 연속 +1
    // (아예 안 한 날은 연속 유지 — 부재는 절제가 아니라서 +1은 없음)
    const day = dayKey();
    const limit = settings.dailyLimit;
    if (orbState.lastSeen && orbState.lastSeen.day !== day) {
      const y = orbState.lastSeen;
      if (limit > 0 && y.count > 0 && y.count <= limit) {
        const before = orbsOf(orbState.streak);
        orbState.streak++;
        const after = orbsOf(orbState.streak);
        console.log(`[streak] 어제(${y.day}) 약속 지킴 → 연속 ${orbState.streak}일, 여의주 ${after}개`);
        if (after > before) broadcast('orb-earned', { orbs: after, streak: orbState.streak });
        else broadcast('day-kept', orbState.streak);
      }
    }
    // 한 번 실패하면 바로 리셋: 오늘 이미 한도를 넘었으면 그 즉시 0으로 (퇴화)
    if (limit > 0 && stats.todayCount > limit && orbState.streak > 0) {
      console.log(`[streak] 오늘 ${stats.todayCount}판 > 한도 ${limit} → 연속 기록 리셋`);
      orbState.streak = 0;
      broadcast('streak-reset', 0);
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

// ---- 하드 모드: 한도 초과 시 롤 클라이언트 강제 종료 + 워치독 ----
// 안전 수칙: 인게임·챔피언 선택 중엔 절대 안 닫음 (탈주/닷지 패널티). 로비 계열 phase에서만.
// 로비 클라를 닫는 건 그냥 창 닫기라 패널티·밴 위험 없음.
const KILL_SAFE_PHASES = ['None', 'Lobby', 'Matchmaking', 'ReadyCheck', 'EndOfGame', 'WaitingForStats', 'PreEndOfGame'];
function enforceHardMode() {
  if (!settings.hardMode || config.mode === 'mock') return;
  const v = computeVerdict();
  if (!v.violations.some((x) => x.type === 'daily')) return; // 하드 모드는 판수 한도만 (연패는 마찰로)
  if (!KILL_SAFE_PHASES.includes(lastPhase)) return; // 게임 중이면 끝날 때까지 대기
  exec('taskkill /F /IM LeagueClient.exe /T', (err) => {
    if (!err) {
      console.log('[hard] 한도 초과 → 롤 클라이언트 종료');
      broadcast('status', '하드 모드: 오늘 한도 소진 → 클라이언트 닫음');
    }
  });
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
    enforceHardMode(); // 게임이 끝나 안전한 phase로 돌아오는 순간 바로 집행
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
    setInterval(enforceHardMode, 20 * 1000); // 워치독: 클라 다시 켜도 20초 안에 또 닫힘
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

// 조종판의 연속 기록 조작 (mock 테스트/단계 미리보기용 — 파일 저장 안 됨)
ipcMain.on('mock-set-streak', (_e, n) => {
  orbState.streak = Math.max(0, Math.floor(n) || 0);
  pushState();
});
ipcMain.on('mock-day-keep', () => { // 하루 성공 연출
  const before = orbsOf(orbState.streak);
  orbState.streak++;
  const after = orbsOf(orbState.streak);
  if (after > before) broadcast('orb-earned', { orbs: after, streak: orbState.streak });
  else broadcast('day-kept', orbState.streak);
});
ipcMain.on('mock-day-fail', () => { // 실패(리셋) 연출
  orbState.streak = 0;
  broadcast('streak-reset', 0);
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
