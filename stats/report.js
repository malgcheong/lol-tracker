// 주간 리포트 (핸드오프 문서 7)
// 실시간 알림은 그 순간 무시되기 쉽다. 대신 일주일치를 모아서 패턴을 보여준다:
// "이번 주 18시간, 연패 세션 4번, 그중 3번은 밤 11시 이후 시작" → 지뢰밭을 스스로 발견하게.

function buildWeeklyReport(matches, settings) {
  const nightStart = settings.nightStartHour ?? 23;
  const reset = settings.dayResetHour ?? 5;
  const isNight = (ts) => {
    const h = new Date(ts).getHours();
    return nightStart > reset ? h >= nightStart || h < reset : h >= nightStart && h < reset;
  };

  const list = matches.filter((m) => !m.remake).sort((a, b) => a.startedAt - b.startedAt);
  const total = list.length;
  const wins = list.filter((m) => m.win).length;
  const playSec = list.reduce((s, m) => s + m.duration, 0);
  const nightCount = list.filter((m) => isNight(m.startedAt)).length;

  // 연패 세션: 시간순으로 2연패 이상 이어진 구간
  const sessions = [];
  let cur = [];
  for (const m of list) {
    if (!m.win) cur.push(m);
    else { if (cur.length >= 2) sessions.push(cur); cur = []; }
  }
  if (cur.length >= 2) sessions.push(cur);
  const nightSessions = sessions.filter((s) => isNight(s[0].startedAt)).length;

  // 하루 최다 (새벽 리셋 기준의 '논리적 하루')
  const byDay = {};
  for (const m of list) {
    const d = new Date(m.startedAt - reset * 3600 * 1000).toISOString().slice(0, 10);
    byDay[d] = (byDay[d] || 0) + 1;
  }
  const maxDay = Object.entries(byDay).sort((a, b) => b[1] - a[1])[0] || null;

  // 패턴 인사이트: 제일 아픈 것 하나만 짚는다 (잔소리 남발 금지)
  const winrate = total ? Math.round((wins / total) * 100) : 0;
  let insight;
  if (total === 0) {
    insight = '이번 주는 롤 없이 살았네. 여의주는 못 모으지만, 그것도 나쁘지 않아.';
  } else if (sessions.length >= 2 && nightSessions / sessions.length >= 0.5) {
    insight = `연패 세션 ${sessions.length}번 중 ${nightSessions}번이 심야에 시작됐어. 심야가 네 지뢰밭이야.`;
  } else if (total >= 5 && nightCount / total >= 0.4) {
    insight = `이번 주 판의 ${Math.round((nightCount / total) * 100)}%가 심야였어. 잠을 걸고 도박하는 중이야.`;
  } else if (sessions.length >= 3) {
    insight = `연패 세션이 ${sessions.length}번. 지기 시작하면 멈추는 연습이 필요해.`;
  } else if (total >= 10 && winrate < 45) {
    insight = `승률 ${winrate}%. 판을 늘린다고 오르지 않아 — 쉬어가는 것도 실력이야.`;
  } else if (maxDay && maxDay[1] > (settings.dailyLimit || 5) * 1.5) {
    insight = `${maxDay[0]}에 하루 ${maxDay[1]}판. 그날 무슨 일 있었어?`;
  } else {
    insight = '이번 주는 패턴이 건강했어. 이대로만 하자.';
  }

  return {
    total, wins, losses: total - wins, winrate, playSec,
    nightCount, lossSessions: sessions.length, nightLossSessions: nightSessions,
    maxDay, insight,
  };
}

module.exports = { buildWeeklyReport };
