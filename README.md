# 롤 자기관리 트래커

연패 추격·판수 폭주·심야 롤 같은 도박성 패턴을 데스크톱 캐릭터가 감지해서 말려주는 자기구속 프로그램.
전체 설계는 `lol_tracker_handoff.md` 참고 (핸드오프 문서).

## 현재 상태 (MVP 2단계)

- 투명 always-on-top 캐릭터 창 (CSS로 그린 강아지, 잡고 끌어서 이동 가능)
- LCU `gameflow-phase` 구독 → phase별 캐릭터 반응 (선제 등장 / 화내기 / 수락 전 경고 / 인게임 조용)
- **통계 1층**: Riot 웹 API로 오늘 판수 + 현재 연패 계산 (`stats/riot.js`, 리메이크 제외, 새벽 5시 리셋)
- **개입 조건 게이트**: 하루 판수 한도 / 연패 한도를 넘겼을 때만 화냄. 안 넘겼으면 응원만
- **설정 화면**: 트레이 아이콘(강아지 얼굴) 클릭 → 라이엇 ID, API 키, 한도 입력 + 연결 테스트
- "15분 쉴게" 스누즈 / "그래도 할래" 3번 누르기 마찰 장치
- **mock 모드**: 롤 없이 개발용. 조종판으로 phase + 가짜 통계(판수/연패)를 흉내 냄

아직 없는 것: 큐 버튼 물리적 덮기, 심야 가중, near-miss 감지, 주간 리포트, 커스터마이징/해금.

## API 키

developer.riotgames.com → 라이엇 계정 로그인 → 첫 화면의 Development API Key 복사 → 설정 화면에 붙여넣기.
개발 키는 **24시간마다 만료**됨 (같은 페이지에서 Regenerate 후 다시 붙여넣기).
키는 이 폴더의 `settings.json`에만 저장되고 git에는 안 들어감(.gitignore).

## 실행 (개발)

```
npm install
npm start
```

개발 모드(npm start)는 config.json의 `mode`를 따른다. mock이면 조종판 창이 같이 떠서, 롤 없이 phase/통계를 흉내 낼 수 있다.

## 빌드 (.exe 만들기)

```
npm run pack
```

`dist/LoL Tracker-win32-x64/LoL Tracker.exe`가 나온다. **패키징된 exe는 항상 real 모드** (조종판 없음, 실제 롤 클라에 붙음). 더블클릭으로 실행되고, 설정에서 "윈도우 시작 시 자동 실행"을 켜면 부팅 시 트레이 상주.
(electron-builder의 NSIS 설치본은 winCodeSign 심볼릭 링크 이슈로 관리자 권한이 필요 → 지금은 electron-packager로 무설치 폴더 빌드를 쓴다.)

## 집에서 진짜 롤로 테스트하기 (체크리스트)

1. 이 폴더를 집 컴퓨터로 복사 (`node_modules` 빼고) → `npm install`
2. `config.json`에서 `"mode": "real"`로 변경
3. 롤이 기본 경로(`C:\Riot Games\League of Legends`)가 아니면 `leaguePath`에 설치 폴더 기입
4. `npm start` → 롤 클라이언트 실행 (순서 무관, 클라 기다렸다가 자동 연결됨)
5. **터미널에 찍히는 `[gameflow-phase] ...` 로그 확인** ← 핸드오프 문서 3-2 경고: phase 이름이 문서와 다르면 `ui/character.html`의 `STATES` 키를 실제 값에 맞출 것
6. 확인할 것: 로비 진입 시 캐릭터 등장 / 큐 누르는 순간 화냄 / 수락 창에서 경고 / 챔픽·인게임에선 조용해지는지

## 구조

```
main.js            Electron 메인. 창/트레이 + 위반 판단(verdict) + phase 중계 + 스누즈
preload.js         렌더러 ↔ 메인 다리
config.json        mode(mock/real), leaguePath
settings.json      사용자 설정 (라이엇 ID, API 키, 한도들) — git 제외, 자동 생성
lcu/real.js        진짜 LCU 연결 (lockfile → WebSocket 구독)
lcu/mock.js        가짜 클라이언트 (real과 동일한 이벤트 인터페이스)
stats/riot.js      통계 1층 (Account-V1 → puuid, Match-V5 → 오늘 판수/연패)
ui/character.html  캐릭터 창 (phase × 위반 여부에 따른 표정/대사/버튼)
ui/control.html    mock 조종판 (phase 버튼 + 가짜 통계 입력)
ui/settings.html   설정 화면 (연결 테스트 포함)
```

real과 mock은 같은 이벤트(`phase`, `status`)를 내보내는 쌍둥이라, 나머지 코드는 어느 쪽이 꽂혀 있는지 모른다.

## 다음 조각 후보

- 심야 가중: 밤 늦을수록 한도를 자동으로 낮추기 (낮 3연패 ≠ 새벽 3연패)
- near-miss 감지: 역전패(오래 앞서다 진 판) 직후 = 가장 취약한 순간에 개입
- 큐 버튼 덮기: 실제 클라 창 좌표 확인 필요 (집에서)
- 주간 리포트 / 캐릭터 커스터마이징·해금
