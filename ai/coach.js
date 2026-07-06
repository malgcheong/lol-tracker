// DeepSeek 판 피드백 — 게임당 정확히 1콜.
// 원칙: LLM은 '말 잘하는 해설가'일 뿐, 판단(위반/차단/연속기록)은 전부 결정적 코드가 한다.
// 실패(키 없음/타임아웃/에러)하면 null 반환 → 기존 하드코딩 대사가 그대로 나감 (유저는 차이를 모름).
const API_URL = 'https://api.deepseek.com/chat/completions';

const SYSTEM = `너는 '몽뿔이' — 롤 과몰입을 말려주는 작은 이무기 정령이다. 사용자가 방금 끝낸 판의 데이터를 보고 딱 한마디 건넨다.
규칙:
- 한국어 반말, 2~3문장, 130자 이내. 이모지·마크다운·따옴표 금지.
- 매칭 조작 같은 남 탓은 절대 금지. 본전 추격·틸트·심야 같은 도박 심리를 데이터 숫자로 짚는다.
- 이긴 판이면 짧게 축하하되 "이 기세로 한 판 더" 같은 말은 절대 금지 — 이긴 지금이 멈추기 제일 좋은 순간임을 상기시킨다.
- 진 판이면 먼저 위로하고, 세션 맥락(연패/오늘 판수/심야)이 위험하면 그걸 짚는다.
- 화내되 미워지지 않게. 잔소리꾼이 아니라 걱정해주는 친구 톤.`;

async function generateGameFeedback(payload, apiKey) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000); // 10초 넘으면 포기 (폴백)
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: `방금 끝난 판과 세션 상황이야: ${JSON.stringify(payload)}` },
        ],
        max_tokens: 200,
        temperature: 1.0,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`DeepSeek API ${res.status}`);
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content?.trim();
    return text ? text.replace(/["'*#]/g, '').replace(/\s*\n+\s*/g, ' ').slice(0, 200) : null;
  } catch (err) {
    console.log(`[ai] 피드백 생성 실패 (기존 대사로 폴백): ${err.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { generateGameFeedback };
