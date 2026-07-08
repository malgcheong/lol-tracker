// 롤 트래커 - Electron 메인 프로세스
// 역할: 창 관리 + [통계 1층]이 위반을 판단 → [LCU 2층]이 phase를 감지 → [캐릭터 3층]에 전달
const { app, BrowserWindow, Tray, Menu, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');

const { RiotStats } = require('./stats/riot');
const { buildWeeklyReport } = require('./stats/report');
const { generateGameFeedback } = require('./ai/coach');

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
  nightTighten: true,// 심야 가중: 심야엔 판수/연패 한도 -1 (낮 3연패 ≠ 새벽 3연패)
  nightStartHour: 23,// 심야 시작 시각 (여기부터 dayResetHour까지가 심야)
  deepseekKey: '',   // DeepSeek API 키 (선택): 넣으면 게임 끝날 때마다 AI가 판 피드백 한마디 (게임당 1콜)
  defaultTasks: '빨래, 청소, 침대 정리, 샤워, 운동', // 매일 자동 등록되는 기본 할 일 (쉼표 구분, 비우면 없음)
  quotes: '',        // 내가 적어둔 명언/다짐 (줄바꿈 구분): 캐릭터 혼잣말 + 블로커에 표시
  meditationMinutes: 1, // 명상 시간 (분) — 캐릭터를 꾹 눌러 호흡을 진행하는 방식
};

function quotesList() {
  return (settings.quotes || '').split('\n').map((s) => s.trim()).filter(Boolean);
}

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
let lastNearMissId = null;  // 타임라인 검사를 이미 한 판 (재검사 방지)
let nearMissFiredId = null; // 실제로 역전패 경고가 나간 판
let lastFeedbackId = null;  // AI 피드백이 나간 판 (게임당 1콜 보장)
let blockerWin = null;
let forcedThroughMain = false; // 이번 로비 세션 동안 "그래도 할래"로 뚫었는지

// ---- 위반 판단 (개입 트리거, 핸드오프 문서 6-1) ----
// 심야 가중: 심야(nightStartHour~dayResetHour)엔 한도가 1씩 낮아짐. 연속 기록 판정은 기본 한도 기준.
function isNightNow() {
  if (!settings.nightTighten) return false;
  const h = new Date().getHours();
  return settings.nightStartHour > settings.dayResetHour
    ? h >= settings.nightStartHour || h < settings.dayResetHour
    : h >= settings.nightStartHour && h < settings.dayResetHour;
}
// 오늘의 할 일 (게임을 보상으로: 다 끝내기 전엔 위반 취급 — 프리맥 원리)
function todayTasks() {
  const day = dayKey();
  if (!orbState.tasks || orbState.tasks.day !== day) {
    // 새 하루: 기본 할 일 자동 등록
    const defaults = (settings.defaultTasks || '').split(',').map((s) => s.trim()).filter(Boolean);
    orbState.tasks = { day, items: defaults.map((text) => ({ text, done: false })) };
  }
  return orbState.tasks;
}

function computeVerdict() {
  const night = isNightNow();
  const violations = [];
  // 할 일 게이트: 통계(Riot API) 없이도 작동
  const t = todayTasks();
  const remaining = t.items.filter((i) => !i.done).length;
  if (remaining > 0) violations.push({ type: 'tasks', n: remaining, total: t.items.length });
  if (!stats) return { hasData: false, violations, stats: null, error: statsError, night };
  const dLimit = settings.dailyLimit > 0 ? Math.max(1, settings.dailyLimit - (night ? 1 : 0)) : 0;
  const lLimit = settings.lossStreakLimit > 0 ? Math.max(1, settings.lossStreakLimit - (night ? 1 : 0)) : 0;
  if (lLimit > 0 && stats.lossStreak >= lLimit) {
    violations.push({ type: 'lossStreak', n: stats.lossStreak, limit: lLimit, night: night && lLimit < settings.lossStreakLimit });
  }
  if (dLimit > 0 && stats.todayCount >= dLimit) {
    violations.push({ type: 'daily', n: stats.todayCount, limit: dLimit, night: night && dLimit < settings.dailyLimit });
  }
  return { hasData: true, violations, stats, error: null, night };
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
    width: 380, height: 260,
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
    console.log('[blocker] 롤 클라 창을 못 찾음 (창 제목 "League of Legends" 탐색 실패)');
    if (blockerWin && !blockerWin.isDestroyed()) blockerWin.hide();
    return;
  }

  ensureBlockerWindow();
  const bw = 380, bh = 260;
  // "게임 찾기" 버튼 = 로비 화면 하단 중앙. 그 위에 얹는다.
  const bx = Math.round(rect.x + rect.w / 2 - bw / 2);
  const by = Math.round(rect.y + rect.h - bh - 16);
  console.log(`[blocker] 클라 창 (${rect.x},${rect.y}) ${rect.w}x${rect.h} → 블로커 (${bx},${by}) ${bw}x${bh}`);
  blockerWin.setBounds({ x: bx, y: by, width: bw, height: bh });
  blockerWin.showInactive(); // 포커스는 뺏지 않되 위에 뜸
  // 차단당하는 순간, 내가 적어둔 다짐을 같이 보여줌 (제일 아픈 잔소리는 내 글씨)
  const q = quotesList();
  v.quote = q.length ? q[Math.floor(Math.random() * q.length)] : null;
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
    quotes: quotesList(),
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
    // near-miss(역전패) 감지: 방금 진 판이 크게 앞서다 뒤집힌 판이면 경고 — 가장 취약한 순간 (핸드오프 6-1)
    const latest = stats.latest;
    if (config.mode === 'real' && latest && !latest.win && lastNearMissId !== latest.id &&
        Date.now() - (latest.startedAt + latest.duration * 1000) < 30 * 60 * 1000) {
      lastNearMissId = latest.id;
      try {
        const tl = await riot.getTimeline(latest.id, settings);
        if (tl && tl.maxLead >= 2500) {
          console.log(`[near-miss] ${latest.id}: ${tl.maxLeadMin}분에 +${tl.maxLead}골드 앞서다 역전패`);
          nearMissFiredId = latest.id;
          broadcast('near-miss', { lead: tl.maxLead, minute: tl.maxLeadMin });
        }
      } catch (err) {
        console.log(`[near-miss] 타임라인 조회 실패: ${err.message}`);
      }
    }
    // AI 판 피드백: 게임당 정확히 1콜. near-miss 경고가 나간 판은 생략(결정적 경고가 우선).
    // 키 없거나 호출 실패 시 조용히 생략 → 기존 대사 흐름 그대로.
    if (config.mode === 'real' && settings.deepseekKey && latest &&
        lastFeedbackId !== latest.id && nearMissFiredId !== latest.id &&
        Date.now() - (latest.startedAt + latest.duration * 1000) < 30 * 60 * 1000) {
      lastFeedbackId = latest.id;
      const payload = {
        game: {
          champion: latest.champ, win: latest.win,
          kda: `${latest.k}/${latest.d}/${latest.a}`, cs: latest.cs,
          minutes: Math.round(latest.duration / 60),
        },
        session: {
          todayCount: stats.todayCount, dailyLimit: settings.dailyLimit,
          lossStreak: stats.lossStreak, keepStreakDays: orbState.streak,
          night: isNightNow(),
        },
      };
      generateGameFeedback(payload, settings.deepseekKey).then((text) => {
        if (text) broadcast('game-feedback', { text, win: latest.win });
      });
    }
    orbState.lastSeen = { day, count: stats.todayCount };
    // 일요일이면 주간 리포트 자동 1회 (핸드오프 문서 7)
    if (config.mode === 'real' && new Date().getDay() === 0 && orbState.lastReport !== day) {
      orbState.lastReport = day;
      openReportWindow();
    }
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
    icon: path.join(__dirname, 'assets', 'tray.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  controlWin.loadFile(path.join(__dirname, 'ui', 'control.html'));
  controlWin.on('closed', () => { controlWin = null; });
}

// 유리(아크릴) 질감의 자체 창 — OS 기본 창틀 대신 커스텀 타이틀바 (OP.GG Desktop 느낌)
// Windows 11이면 아크릴 블러, 안 되면 반투명 창으로 폴백
function createGlassWindow(width, height, file) {
  const base = {
    width, height,
    frame: false, resizable: false,
    icon: path.join(__dirname, 'assets', 'tray.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  };
  let win;
  try {
    win = new BrowserWindow({ ...base, backgroundMaterial: 'acrylic' });
  } catch {
    win = new BrowserWindow({ ...base, transparent: true });
  }
  win.loadFile(path.join(__dirname, 'ui', file));
  return win;
}

let tasksWin = null;
function openTasksWindow() {
  if (tasksWin && !tasksWin.isDestroyed()) { tasksWin.focus(); return; }
  tasksWin = createGlassWindow(360, 540, 'tasks.html');
  tasksWin.on('closed', () => { tasksWin = null; });
}

// 명상: 별도 창 없이 상주 캐릭터가 직접 진행 (캐릭터를 톡 눌러야 호흡이 하나씩 — 딴짓 방지)
function startMeditation() {
  if (characterWin && !characterWin.isDestroyed()) {
    characterWin.webContents.send('meditate-start', settings.meditationMinutes || 3);
  }
}

let reportWin = null;
function openReportWindow() {
  if (reportWin && !reportWin.isDestroyed()) { reportWin.focus(); return; }
  reportWin = createGlassWindow(420, 640, 'report.html');
  reportWin.on('closed', () => { reportWin = null; });
}

function openSettingsWindow() {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.focus(); return; }
  settingsWin = createGlassWindow(460, 720, 'settings.html');
  settingsWin.on('closed', () => { settingsWin = null; });
}

function createTray() {
  tray = new Tray(path.join(__dirname, 'assets', 'tray.png'));
  tray.setToolTip('롤 트래커');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '오늘 할 일', click: openTasksWindow },
    { label: '명상하기', click: startMeditation },
    { label: '설정', click: openSettingsWindow },
    { label: '주간 리포트', click: openReportWindow },
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

// 명상
ipcMain.on('open-meditation', startMeditation);
ipcMain.on('meditation-done', () => console.log('[meditation] 완료'));

// 오늘의 할 일
ipcMain.handle('tasks-get', () => todayTasks());
ipcMain.handle('tasks-set', (_e, items) => {
  const t = todayTasks();
  const beforeRemaining = t.items.filter((i) => !i.done).length;
  t.items = (items || []).map((i) => ({ text: String(i.text).slice(0, 80), done: !!i.done }));
  const afterRemaining = t.items.filter((i) => !i.done).length;
  saveOrbState();
  pushState(); // 블로커/캐릭터 즉시 갱신
  // 마지막 할 일을 끝낸 순간: 보상 해금 축하
  if (beforeRemaining > 0 && afterRemaining === 0 && t.items.length > 0) {
    broadcast('tasks-done', t.items.length);
  }
  return t;
});

ipcMain.handle('settings-get', () => settings);

ipcMain.handle('settings-save', (_e, next) => {
  settings = { ...settings, ...next };
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
  refreshStats('설정 저장');
  return { ok: true };
});

// ISO 주차 키 (예: 2026-W28) — 리포트 아카이브 파일명
function isoWeekKey(d = new Date()) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// 주간 리포트: 최근 7일 매치 분석. mock 모드는 샘플 데이터로 UI 확인
ipcMain.handle('report-get', async () => {
  try {
    if (config.mode === 'mock') {
      const fake = [];
      const now = Date.now();
      // 샘플: 일주일간 21판, 심야 연패 세션 포함
      const pattern = [
        [6, 14, [1, 1, 0]], [5, 23, [0, 0, 1]], [5, 24, [0, 0]],
        [3, 15, [1, 0, 1, 1]], [2, 23, [0, 0, 0]], [1, 25, [1, 0]], [0, 20, [1, 1, 0, 0]],
      ];
      for (const [daysAgo, hour, results] of pattern) {
        results.forEach((win, i) => {
          const t = new Date(now - daysAgo * 86400e3);
          t.setHours(hour % 24, i * 40, 0, 0);
          fake.push({ startedAt: t.getTime(), duration: 1700 + i * 300, win: !!win, remake: false });
        });
      }
      return {
        ok: true, sample: true,
        report: buildWeeklyReport(fake, settings),
        prev: buildWeeklyReport(fake.slice(0, 14), settings), // 비교 UI 확인용 가짜 지난주
      };
    }
    const matches = await riot.matchesSince(7, settings);
    const report = buildWeeklyReport(matches, settings);
    // 아카이브: 매주 reports/<주차>.json으로 영구 저장 (다시 열면 갱신)
    const dir = path.join(__dirname, 'reports');
    fs.mkdirSync(dir, { recursive: true });
    const key = isoWeekKey();
    fs.writeFileSync(
      path.join(dir, `${key}.json`),
      JSON.stringify({ week: key, generatedAt: new Date().toISOString(), report }, null, 2)
    );
    // 지난주 아카이브가 있으면 비교
    let prev = null;
    try {
      const prevKey = isoWeekKey(new Date(Date.now() - 7 * 86400e3));
      prev = JSON.parse(fs.readFileSync(path.join(dir, `${prevKey}.json`), 'utf8')).report;
    } catch { /* 지난주 기록 없음 */ }
    return { ok: true, sample: false, report, prev };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// 조종판: 역전패 연출 미리보기
ipcMain.on('mock-near-miss', () => broadcast('near-miss', { lead: 3200, minute: 21 }));
// 조종판: AI 피드백 말풍선 자리 확인용 (실제 호출 아님)
ipcMain.on('mock-game-feedback', () => broadcast('game-feedback', {
  text: '오늘 3판째에 첫 승이네. 근데 지금 새벽 1시야 — 이긴 지금이 끄기 제일 좋은 타이밍인 거 알지?',
  win: true,
}));

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

// 캐릭터를 꾹 잡고 끌면 창이 딸려옴
ipcMain.on('char-move-by', (_e, { dx, dy }) => {
  if (!characterWin || characterWin.isDestroyed()) return;
  const [x, y] = characterWin.getPosition();
  characterWin.setPosition(Math.round(x + dx), Math.round(y + dy));
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
