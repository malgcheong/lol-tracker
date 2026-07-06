// 통계 1층 - Riot 웹 API (핸드오프 문서 3-1)
//
// 역할: "오늘 몇 판 / 지금 몇 연패"를 계산한다. 모든 개입 판단의 재료.
// 주의: 이건 CCTV 녹화본이다. 경기가 끝난 뒤에야 기록이 올라오고 몇 분 딜레이도 있음.
//
// 사용하는 API 두 개:
//   Account-V1: 라이엇 ID(닉네임#태그) → puuid (계정 고유번호)
//   Match-V5:   puuid → 최근 매치 ID 목록 → 각 경기 상세(승패/시작시각/길이)
const REGION = 'asia'; // 한국 계정 라우팅. Account-V1, Match-V5 둘 다 asia를 씀.
const REMAKE_SECONDS = 300; // 5분 미만 게임 = 다시하기(remake)로 보고 통계에서 제외

class RiotStats {
  constructor() {
    this.puuid = null;
    this.puuidFor = null; // 어떤 riotId로 얻은 puuid인지 (ID 바꾸면 다시 조회)
    this.matchCache = new Map(); // 경기 상세는 불변이라 한 번 받으면 재사용 (요청 수 절약)
  }

  async api(pathname, apiKey) {
    const res = await fetch(`https://${REGION}.api.riotgames.com${pathname}`, {
      headers: { 'X-Riot-Token': apiKey },
    });
    if (!res.ok) {
      const hint = {
        401: '죽은 키 (만료 또는 재발급으로 무효화됨). developer.riotgames.com에서 지금 보이는 키를 다시 복사해올 것',
        403: 'API 키 만료 또는 잘못됨 (개발 키는 24시간마다 developer.riotgames.com에서 재발급)',
        404: '계정을 못 찾음 (라이엇 ID 오타? 닉네임#태그 형식 확인)',
        429: '요청 너무 많음 (잠시 후 재시도)',
      }[res.status];
      throw new Error(`Riot API ${res.status}${hint ? ` - ${hint}` : ''}`);
    }
    return res.json();
  }

  async resolvePuuid(riotId, apiKey) {
    if (this.puuid && this.puuidFor === riotId) return this.puuid;
    const [name, tag] = riotId.split('#');
    if (!name || !tag) throw new Error('라이엇 ID는 "닉네임#태그" 형식이어야 함');
    const account = await this.api(
      `/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(name.trim())}/${encodeURIComponent(tag.trim())}`,
      apiKey
    );
    this.puuid = account.puuid;
    this.puuidFor = riotId;
    return this.puuid;
  }

  // "오늘"의 시작 시각. dayResetHour=5면 새벽 5시 전 게임은 어제로 침 (심야 롤은 '오늘'에 누적)
  todayStart(dayResetHour) {
    const now = new Date();
    const start = new Date(now);
    start.setHours(dayResetHour, 0, 0, 0);
    if (now < start) start.setDate(start.getDate() - 1);
    return start.getTime();
  }

  async refresh({ riotId, apiKey, dayResetHour = 5 }) {
    const puuid = await this.resolvePuuid(riotId, apiKey);
    const dayStart = this.todayStart(dayResetHour);

    // 최근 30판 ID (연패가 이보다 길면... 그건 앱이 아니라 병원이 필요함)
    const ids = await this.api(`/lol/match/v5/matches/by-puuid/${puuid}/ids?start=0&count=30`, apiKey);

    let todayCount = 0;
    let lossStreak = 0;
    let streakBroken = false;
    let latest = null; // 가장 최근 판 (near-miss 감지용)

    for (const id of ids) { // ids는 최신순
      const m = await this.getMatch(id, puuid, apiKey);
      if (m.remake) continue;
      if (!latest) latest = { id, ...m };

      if (m.startedAt >= dayStart) todayCount++;
      if (!streakBroken) {
        if (m.win) streakBroken = true;
        else lossStreak++;
      }
      // 연패도 끊겼고 오늘 범위도 벗어났으면 더 옛날 경기는 볼 필요 없음
      if (streakBroken && m.startedAt < dayStart) break;
    }

    return { todayCount, lossStreak, fetchedAt: Date.now(), latest };
  }
}

// 경기 상세 (불변이라 캐시)
RiotStats.prototype.getMatch = async function (id, puuid, apiKey) {
  let m = this.matchCache.get(id);
  if (!m) {
    const full = await this.api(`/lol/match/v5/matches/${id}`, apiKey);
    const me = full.info.participants.find((p) => p.puuid === puuid);
    m = {
      startedAt: full.info.gameStartTimestamp,
      duration: full.info.gameDuration,
      win: me ? me.win : true,
      remake: full.info.gameDuration < REMAKE_SECONDS,
    };
    this.matchCache.set(id, m);
  }
  return m;
};

// 타임라인 분석: 분당 팀 골드 차이로 "얼마나 앞서다 뒤집혔나"를 계산 (near-miss 감지 재료)
RiotStats.prototype.getTimeline = async function (matchId, { riotId, apiKey }) {
  const puuid = await this.resolvePuuid(riotId, apiKey);
  const tl = await this.api(`/lol/match/v5/matches/${matchId}/timeline`, apiKey);
  const me = tl.info.participants.find((p) => p.puuid === puuid);
  if (!me) return null;
  const myTeam = me.participantId <= 5 ? [1, 2, 3, 4, 5] : [6, 7, 8, 9, 10];
  let maxLead = 0, maxLeadMin = 0;
  for (const f of tl.info.frames || []) {
    let diff = 0;
    for (const [pid, pf] of Object.entries(f.participantFrames || {})) {
      diff += (myTeam.includes(Number(pid)) ? 1 : -1) * (pf.totalGold || 0);
    }
    if (diff > maxLead) { maxLead = diff; maxLeadMin = Math.round(f.timestamp / 60000); }
  }
  return { maxLead, maxLeadMin };
};

// 최근 N일치 경기 전부 (주간 리포트용)
RiotStats.prototype.matchesSince = async function (daysBack, { riotId, apiKey }) {
  const puuid = await this.resolvePuuid(riotId, apiKey);
  const startTime = Math.floor((Date.now() - daysBack * 24 * 3600 * 1000) / 1000);
  const ids = await this.api(
    `/lol/match/v5/matches/by-puuid/${puuid}/ids?startTime=${startTime}&count=100`,
    apiKey
  );
  const out = [];
  for (const id of ids) out.push(await this.getMatch(id, puuid, apiKey));
  return out;
};

module.exports = { RiotStats };
