// 가짜 롤 클라이언트 (회사용 비행 시뮬레이터)
// 진짜 LCU 클라이언트(real.js)와 똑같은 이벤트('phase', 'status')를 내보낸다.
// 조종판(control.html) 버튼으로 phase를 바꾸면 캐릭터가 진짜처럼 반응한다.
const { EventEmitter } = require('events');

class MockLcuClient extends EventEmitter {
  start() {
    this.emit('status', 'mock 모드 - 조종판 버튼으로 상태를 바꿔보세요');
    this.setPhase('Lobby'); // 개발 편의: 켜자마자 캐릭터가 깨어있게 로비에서 시작
  }

  setPhase(phase) {
    this.phase = phase;
    this.emit('phase', phase);
  }
}

module.exports = { MockLcuClient };
