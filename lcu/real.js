// 진짜 롤 클라이언트(LCU) 연결 (집에서 테스트용)
//
// 동작 원리 (핸드오프 문서 3-2):
// 1. 롤 설치 폴더의 lockfile을 읽는다. 내용: 이름:PID:포트:비밀번호:프로토콜
// 2. wss://127.0.0.1:포트 에 WebSocket으로 붙는다 (인증: riot:비밀번호, 자체서명 인증서라 검증 끔)
// 3. gameflow-phase 이벤트를 구독하면 로비/매칭중/챔픽/인게임 상태 변화가 실시간으로 온다.
//
// 롤 클라이언트가 꺼져 있으면 lockfile이 없다 → 5초마다 재시도하며 기다린다.
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const https = require('https');
const WebSocket = require('ws');

const DEFAULT_LEAGUE_PATHS = [
  'C:\\Riot Games\\League of Legends',
];

const GAMEFLOW_EVENT = 'OnJsonApiEvent_lol-gameflow_v1_gameflow-phase';
const RETRY_MS = 5000;

class RealLcuClient extends EventEmitter {
  constructor(leaguePath) {
    super();
    const candidates = leaguePath ? [leaguePath] : DEFAULT_LEAGUE_PATHS;
    this.lockfileCandidates = candidates.map((p) => path.join(p, 'lockfile'));
    this.stopped = false;
  }

  start() {
    this.emit('status', '롤 클라이언트를 찾는 중...');
    this.tryConnect();
  }

  readLockfile() {
    for (const file of this.lockfileCandidates) {
      try {
        const raw = fs.readFileSync(file, 'utf8');
        const [name, pid, port, password, protocol] = raw.split(':');
        if (port && password) return { name, pid, port, password, protocol };
      } catch {
        // 파일 없음 = 클라이언트 꺼져 있음. 다음 후보 확인.
      }
    }
    return null;
  }

  tryConnect() {
    if (this.stopped) return;
    const lock = this.readLockfile();
    if (!lock) {
      this.emit('status', '롤 클라이언트 대기 중... (lockfile 없음, 5초 후 재시도)');
      this.emit('client', false); // 클라 없음 → 캐릭터 숨김
      setTimeout(() => this.tryConnect(), RETRY_MS);
      return;
    }
    this.connect(lock);
  }

  connect({ port, password }) {
    const auth = 'Basic ' + Buffer.from(`riot:${password}`).toString('base64');
    const ws = new WebSocket(`wss://127.0.0.1:${port}`, {
      headers: { Authorization: auth },
      rejectUnauthorized: false, // LCU는 자체서명 인증서를 씀. 로컬 통신이라 안전.
    });

    ws.on('open', () => {
      this.emit('status', `LCU 연결됨 (포트 ${port})`);
      this.emit('client', true); // 클라 켜짐 → 캐릭터 등장
      // [5, 이벤트명] = "이 이벤트 구독할게" 라는 LCU WebSocket 약속
      ws.send(JSON.stringify([5, GAMEFLOW_EVENT]));
      this.fetchCurrentPhase(port, auth); // 구독은 '변화'만 알려주니 현재 상태는 한 번 직접 물어봄
    });

    ws.on('message', (data) => {
      try {
        const parsed = JSON.parse(data.toString());
        // 구독 이벤트는 [8, 이벤트명, { data: "Lobby", ... }] 형태로 옴
        if (Array.isArray(parsed) && parsed[0] === 8 && parsed[1] === GAMEFLOW_EVENT) {
          this.emit('phase', parsed[2].data);
        }
      } catch {
        // 빈 메시지 등은 무시
      }
    });

    ws.on('close', () => {
      this.emit('status', 'LCU 연결 끊김 (클라이언트 종료?). 재연결 대기...');
      this.emit('phase', 'None');
      this.emit('client', false); // 클라 종료 → 캐릭터 숨김
      setTimeout(() => this.tryConnect(), RETRY_MS);
    });

    ws.on('error', (err) => {
      this.emit('status', `LCU 연결 오류: ${err.message}`);
      ws.close();
    });
  }

  fetchCurrentPhase(port, auth) {
    const req = https.request(
      {
        host: '127.0.0.1',
        port,
        path: '/lol-gameflow/v1/gameflow-phase',
        headers: { Authorization: auth },
        rejectUnauthorized: false,
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            this.emit('phase', JSON.parse(body)); // 응답은 "Lobby" 같은 JSON 문자열
          } catch {
            this.emit('status', `현재 phase 조회 실패: ${body}`);
          }
        });
      }
    );
    req.on('error', (err) => this.emit('status', `phase 조회 오류: ${err.message}`));
    req.end();
  }
}

module.exports = { RealLcuClient };
