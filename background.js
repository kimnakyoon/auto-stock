// 더망고 자동화 매크로 - 마켓 전송 팝업 위치 강제 고정 (백그라운드)
//
// 원리: 페이지 쪽 window.open 좌표는 크롬이 로딩 상황에 따라 무시할 수 있어서
// 창이 뒤죽박죽 쌓이는 원인이 된다. 확장 API인 chrome.windows.update는 페이지
// 로딩과 무관하게 항상 동작하므로, 팝업이 생기는 즉시 지정 줄로 강제 이동시키고
// 이후 창이 움직일 때마다 다시 제자리로 되돌린다.

const Y_STEP = 65;

let winTarget = {};   // 팝업 windowId → 목표 좌표 {left, top} (크기는 건드리지 않음)
let loadState = null;

// 서비스워커가 잠들었다 깨어나도 관리 목록을 잃지 않도록 세션 저장소에 보관
function ensureLoaded() {
    if (!loadState) {
        loadState = chrome.storage.session.get('winTarget')
            .then(r => { if (r.winTarget) winTarget = r.winTarget; })
            .catch(() => {});
    }
    return loadState;
}
const saveState = () => { chrome.storage.session.set({ winTarget }).catch(() => {}); };

// 새 창이 열리면: 매크로 작업탭이 연 팝업인지 확인하고 해당 줄로 강제 이동
chrome.tabs.onCreated.addListener(async (tab) => {
    try {
        await ensureLoaded();
        if (!tab.openerTabId) return;

        const win = await chrome.windows.get(tab.windowId);
        if (win.type !== 'popup') return;

        // 팝업을 연 작업탭에 매크로 표식(__MANGO_POPUP_LEFT 등)이 있는지 확인
        // 표식이 없으면 매크로와 무관한 팝업이므로 건드리지 않는다
        const [res] = await chrome.scripting.executeScript({
            target: { tabId: tab.openerTabId },
            world: 'MAIN',
            func: () => ({
                left: window.__MANGO_POPUP_LEFT,
                top: window.__MANGO_POPUP_TOP,
                row: window.__MANGO_TAB_INDEX
            })
        });
        const info = res && res.result;
        if (!info || info.left === undefined || info.left === null) return;

        // 💡 작업탭이 떠 있는 창의 중심 좌표로 "어느 모니터인지"를 크롬 디스플레이 API로 판별
        //    (chrome.windows와 완전히 같은 좌표계라서 모니터별 배율이 달라도 어긋나지 않음)
        const openerTab = await chrome.tabs.get(tab.openerTabId);
        const openerWin = await chrome.windows.get(openerTab.windowId);
        const displays = await chrome.system.display.getInfo();
        const cx = (openerWin.left || 0) + (openerWin.width || 0) / 2;
        const cy = (openerWin.top || 0) + (openerWin.height || 0) / 2;
        const disp = displays.find(d =>
            cx >= d.bounds.left && cx < d.bounds.left + d.bounds.width &&
            cy >= d.bounds.top && cy < d.bounds.top + d.bounds.height
        ) || displays.find(d => d.isPrimary) || displays[0];

        // 💡 해당 모니터의 시작 좌표 + 선택한 위치값으로 이동 (크기는 건드리지 않음 → 창 작아짐 방지)
        //    팝업이 모니터 오른쪽 경계를 넘어가면 경계에 딱 맞게 왼쪽으로 당김 (옆 모니터 침범 방지)
        let targetLeft = disp.bounds.left + info.left;
        const maxLeft = disp.bounds.left + disp.bounds.width - (win.width || 236);
        if (targetLeft > maxLeft) targetLeft = maxLeft;

        const updated = await chrome.windows.update(tab.windowId, {
            left: targetLeft,
            top: disp.bounds.top + (info.top || 0) + (info.row || 0) * Y_STEP
        });
        winTarget[String(tab.windowId)] = { left: updated.left, top: updated.top };
        saveState();

        // 새 창이 앞으로 나오면서 아래 줄 창들을 덮으므로, 잠시 후 전체 재정렬
        scheduleRestack();
    } catch (e) {}
});

// 💡 [z-order 재정렬] 크롬은 "포커스 없이 창만 앞으로"가 불가능하므로,
//    위 줄부터 아래 줄 순서로 차례로 앞에 끌어와서 계단식으로 제목줄이 모두 보이게 만든다.
//    팝업이 연달아 뜰 때 매번 하지 않도록 10초 디바운스.
let restackTimer = null;
function scheduleRestack() {
    if (restackTimer) clearTimeout(restackTimer);
    restackTimer = setTimeout(restack, 10000);
}

async function restack() {
    restackTimer = null;
    try {
        await ensureLoaded();
        const ids = Object.keys(winTarget);
        if (ids.length < 2) return;

        // 사용자가 보고 있던 창을 기억해뒀다가 정렬 후 되돌려줌
        let prevFocused = null;
        try {
            const f = await chrome.windows.getLastFocused();
            if (f && f.focused && !winTarget[String(f.id)]) prevFocused = f.id;
        } catch (e) {}

        // 같은 열끼리 묶고, 위 줄 → 아래 줄 순서로 앞으로 끌어오기
        const order = ids
            .map(id => ({ id: parseInt(id), t: winTarget[id] }))
            .sort((a, b) => (a.t.left - b.t.left) || (a.t.top - b.t.top));

        let changed = false;
        for (const w of order) {
            try { await chrome.windows.update(w.id, { focused: true }); }
            catch (e) { delete winTarget[String(w.id)]; changed = true; } // 이미 닫힌 창 정리
        }
        if (changed) saveState();

        if (prevFocused) {
            try { await chrome.windows.update(prevFocused, { focused: true }); } catch (e) {}
        }
    } catch (e) {}
}

// 마켓 사이트나 사용자가 창을 옮기면 즉시 제자리로 복귀
// 주의: 목표 좌표(winTarget)는 처음 배정된 값을 절대 덮어쓰지 않는다
//       (이동이 실패한 좌표를 목표로 저장해버리면 영영 안 돌아오는 버그가 생김)
chrome.windows.onBoundsChanged.addListener(async (win) => {
    try {
        await ensureLoaded();
        const t = winTarget[String(win.id)];
        if (!t) return;
        if (Math.abs(win.left - t.left) < 3 && Math.abs(win.top - t.top) < 3) return;

        // 최대화 상태면 위치 지정이 무시되므로 일반 상태로 되돌리면서 이동
        await chrome.windows.update(win.id, { state: 'normal', left: t.left, top: t.top });

        // 끌었던 창이 앞에 남아 다른 줄을 덮고 있을 수 있으므로 재정렬
        scheduleRestack();
    } catch (e) {}
});

// 💡 30초마다 순찰: 어떤 이유로든 제자리를 벗어난 팝업을 원위치로 (이벤트를 놓친 경우 안전망)
chrome.alarms.create('mango_patrol', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name !== 'mango_patrol') return;
    await ensureLoaded();
    let changed = false;
    for (const id of Object.keys(winTarget)) {
        try {
            const w = await chrome.windows.get(parseInt(id));
            const t = winTarget[id];
            if (Math.abs(w.left - t.left) >= 3 || Math.abs(w.top - t.top) >= 3) {
                await chrome.windows.update(w.id, { state: 'normal', left: t.left, top: t.top });
            }
        } catch (e) {
            // 이미 닫힌 창은 목록에서 정리
            delete winTarget[id];
            changed = true;
        }
    }
    if (changed) saveState();
});

// 팝업이 닫히면 관리 목록에서 제거
chrome.windows.onRemoved.addListener(async (winId) => {
    await ensureLoaded();
    if (winTarget[String(winId)]) { delete winTarget[String(winId)]; saveState(); }
});


// ═══════════════════════════════════════════════════════════════
// 💡 SSG 자동 재로그인
//    처음 실행할 때 SSG 탭을 하나 열어 두고(백그라운드), 그 탭을 닫지 않고 계속 둔다.
//    어떤 SSG 탭이든 로그인 화면으로 넘어가거나 화면 안에 "로그인" 표시가 보이는 순간(= 로그아웃이 드러나는 순간) 바로 확인을 돌리고,
//    안전장치로 1시간마다도 "그 탭"에서 마이페이지로 이동해 로그인 상태를 확인한다.
//    로그아웃 상태면 (로그인 화면이 아니면 로그인 화면으로 이동한 뒤) 같은 탭에서 저장된 아이디/비밀번호로 자동 로그인한다.
//    확인이 끝나도 탭은 닫지 않는다. (실패해도 사용자가 직접 처리할 수 있도록 그대로 둠)
//    SSG 로그인 화면 탭이 따로 더 열려 있으면(확인용 탭 제외) 그 탭들만 닫는다. 다른 SSG 탭은 건드리지 않는다.
//    chrome.alarms + 백그라운드에서 돌기 때문에 다른 창이 선택되어 있어도
//    동작하고, 창을 앞으로 가져오지 않는다.
//
//    [작업 창 CAPTCHA 정리] 로그인이 풀린 채 작업하면 더망고 작업 창에 "로그인 페이지 또는 CAPTCHA 페이지입니다"
//    알림이 뜨며 멈춘다. 실행 탭이 그 신호(mango_ssg_captcha)를 보내오면 로그인 확인/재로그인을 한 뒤,
//    로그인이 되어 있을 때만 (1) 알림이 뜬 작업 창(mycafe24)과 (2) 작업 창이 배열에 맞춰 띄운 SSG 팝업창을 모두 닫는다.
//    실행 탭은 닫힌 창을 끝난 것으로 보고, 모든 창이 끝나면 다음 사이클을 처음부터 다시 시작한다.
// ═══════════════════════════════════════════════════════════════
const SSG_ALARM = 'mango_ssg_check';
const SSG_CHECK_MINUTES = 60;                       // 안전장치용 로그인 확인 주기 (1시간)
const SSG_EVENT_COOLDOWN_MS = 60 * 1000;            // 로그인 화면 감지로 확인을 돌린 뒤 같은 이유로 다시 돌리지 않는 시간
// 로그인이 풀려 있으면 member.ssg.com 로그인 화면으로 넘어가는 주소 (마이페이지 메인)
const SSG_CHECK_URL = 'https://www.ssg.com/myssg/main.ssg';
const SSG_TAB_MATCH = ['*://*.ssg.com/*'];          // SSG 탭으로 볼 주소 패턴
const SSG_LOG_MAX = 30;

// 화면에 "로그인" 표시만 있고 로그인 화면으로 안 넘어갈 때, 직접 이동할 로그인 화면 주소
const SSG_LOGIN_URL = 'https://member.ssg.com/member/login.ssg';

const isSsgLoginUrl = (url) => /login\.ssg|member\.ssg\.com/i.test(url || '');
const isSsgUrl = (url) => /^https?:\/\/([^/]*\.)?ssg\.com\//i.test(url || '');
const ssgWait = (ms) => new Promise(r => setTimeout(r, ms));

// 💡 SSG 화면 안에 로그인/로그아웃 표시가 있는지 본다 (페이지 안에서 실행)
//    로그아웃해도 주소가 로그인 화면으로 안 바뀌는 경우가 있어서, 주소와 함께 화면 내용으로도 판단한다.
//    hasLogin  : 화면에 보이는 "로그인" 링크/버튼이 있음 (= 로그아웃 상태)
//    hasLogout : 화면에 보이는 "로그아웃" 링크/버튼이 있음 (= 로그인 상태)
//    hasPwInput: 비밀번호 입력칸이 있음 (= 로그인 화면)
//    loginHref : "로그인" 링크의 주소 (있으면 그 주소로 이동해서 로그인)
function ssgPageState() {
    const vis = (el) => el.offsetParent !== null;
    const txt = (el) => ((el.innerText || el.textContent || el.value || el.getAttribute('title') || '') + '').replace(/\s+/g, '');
    const els = [...document.querySelectorAll('a, button, input[type="submit"], input[type="button"]')].filter(vis);
    const hasLogout = els.some(el => txt(el).includes('로그아웃'));
    const loginEls = els.filter(el => txt(el).includes('로그인') && !txt(el).includes('로그아웃'));
    const link = loginEls.find(el => el.tagName === 'A' && /^https?:/i.test(el.href || ''));
    return {
        hasLogin: loginEls.length > 0,
        hasLogout,
        hasPwInput: !!document.querySelector('input[type="password"]'),
        loginHref: link ? link.href : '',
    };
}
// 탭에서 func 를 실행해 결과를 돌려준다 (기본: ssgPageState, 실행 못 하면 null)
async function ssgProbe(tabId, func = ssgPageState, world) {
    try {
        const [r] = await chrome.scripting.executeScript({ target: { tabId }, func, world });
        return (r && r.result) || null;
    } catch (e) { return null; }
}
// 화면 내용으로 본 로그아웃 여부: 로그인 화면이거나, "로그인" 표시는 있는데 "로그아웃" 표시는 없으면 로그아웃 상태
const ssgLoggedOut = (p) => !!p && (p.hasPwInput || (p.hasLogin && !p.hasLogout));

async function ssgGetState() {
    const r = await chrome.storage.local.get('ssgAuto');
    return r.ssgAuto || { running: false, id: '', pw: '', log: [] };
}
// 기록 한 줄을 남기면서 상태(patch)도 같이 저장한다 (storage 쓰기 1회)
async function ssgLog(msg, patch) {
    const st = await ssgGetState();
    if (patch) Object.assign(st, patch);
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    const line = `[${p2(d.getMonth() + 1)}/${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}] ${msg}`;
    st.log = [...(st.log || []), line].slice(-SSG_LOG_MAX);
    st.lastMsg = line;
    await chrome.storage.local.set({ ssgAuto: st });
    console.log('[SSG]', line);
}

// 탭 로딩이 끝날 때까지 대기 (최대 timeout ms)
// checkNow=true  : 리스너를 붙이기 전에 이미 로딩이 끝났을 수 있으므로 현재 상태도 한 번 확인 (새 탭용)
// checkNow=false : 방금 tabs.update 로 이동시킨 경우 → 이전 페이지의 complete 에 속지 않도록 "새로 오는" complete 만 기다린다
function ssgWaitForLoad(tabId, timeout = 30000, checkNow = true) {
    return new Promise(resolve => {
        let done = false;
        const finish = () => { if (done) return; done = true; chrome.tabs.onUpdated.removeListener(onUpd); resolve(); };
        const onUpd = (id, info) => { if (id === tabId && info.status === 'complete') finish(); };
        chrome.tabs.onUpdated.addListener(onUpd);
        setTimeout(finish, timeout);
        if (checkNow) chrome.tabs.get(tabId).then(t => { if (t.status === 'complete') finish(); }).catch(finish);
    });
}

// 로딩이 끝나고 자바스크립트 리다이렉트가 자리잡을 때까지 기다린다
async function ssgSettle(tabId, checkNow) {
    await ssgWaitForLoad(tabId, 30000, checkNow);
    await ssgWait(2000);
}

// 탭의 현재 주소를 돌려준다 (탭이 닫혀 있으면 null)
const ssgTabUrl = (tabId) => chrome.tabs.get(tabId).then(t => t.url || '').catch(() => null);

// 지금 열려 있는 탭 목록 (기본: SSG 탭)
async function ssgListTabs(match = SSG_TAB_MATCH) {
    try { return await chrome.tabs.query({ url: match }); } catch (e) { return []; }
}

// 💡 확인용 SSG 탭을 구한다 (항상 같은 탭을 재사용)
//    1) 저장해 둔 탭이 아직 살아 있고 SSG 주소면 그대로 사용
//    2) 없으면 이미 열려 있는 SSG 탭 중 하나를 사용 (로그인 화면이 아닌 탭 우선)
//    3) 그것도 없으면 새 탭을 백그라운드로 연다
//    돌려주는 값: { tabId, created }  created=true 면 이번에 새로 연 탭
async function ssgGetTab(st) {
    if (st.tabId) {
        try {
            const t = await chrome.tabs.get(st.tabId);
            if (t && isSsgUrl(t.url)) return { tabId: t.id, created: false };
        } catch (e) { /* 탭이 닫힘 → 아래에서 다시 찾음 */ }
    }
    const tabs = await ssgListTabs();
    const pick = tabs.find(t => !isSsgLoginUrl(t.url)) || tabs[0];
    if (pick) return { tabId: pick.id, created: false };
    const t = await chrome.tabs.create({ url: SSG_CHECK_URL, active: false });
    return { tabId: t.id, created: true };
}

// 💡 확인용 탭을 제외한 "SSG 로그인 화면" 탭만 닫는다 (다른 SSG 탭은 그대로 둠)
async function ssgCloseLoginTabs(keepTabId) {
    const extra = (await ssgListTabs()).filter(t => t.id !== keepTabId && isSsgLoginUrl(t.url)).map(t => t.id);
    if (!extra.length) return;
    try { await chrome.tabs.remove(extra); } catch (e) { /* 이미 닫힘 */ }
    await ssgLog(`🧹 SSG 로그인 화면 탭이 따로 열려 있어 ${extra.length}개를 닫음 (확인용 탭은 그대로 둠)`);
}

// SSG 로그인 화면에 아이디/비밀번호를 넣고 로그인 버튼을 누른다 (페이지 안에서 실행)
function ssgFillAndSubmit(id, pw) {
    const q = (sels) => { for (const s of sels) { const el = document.querySelector(s); if (el) return el; } return null; };
    const idEl = q(['#mem_id', 'input[name="mem_id"]', 'input[name="loginId"]']);
    const pwEl = q(['#mem_pw', 'input[name="mem_pw"]', 'input[name="loginPw"]', 'input[type="password"]']);
    if (!idEl || !pwEl) return { ok: false, reason: '아이디/비밀번호 입력칸을 찾지 못함' };

    const setVal = (el, v) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    setVal(idEl, id);
    setVal(pwEl, pw);

    const txt = (el) => ((el.innerText || el.value || '') + '').replace(/\s+/g, '');
    const btn = [...document.querySelectorAll('button, a, input[type="submit"], input[type="button"]')]
        .find(el => txt(el) === '로그인' && el.offsetParent !== null)
        || document.querySelector('button[type="submit"], .btn_login, #btn_login');
    if (btn) { btn.click(); return { ok: true, how: 'button' }; }
    const form = pwEl.closest('form');
    if (form) { form.requestSubmit ? form.requestSubmit() : form.submit(); return { ok: true, how: 'form' }; }
    return { ok: false, reason: '로그인 버튼을 찾지 못함' };
}

// 💡 확인은 한 번에 하나만 돈다. 진행 중이면 그 확인(프로미스)을 그대로 돌려주므로
//    호출한 쪽은 await 로 결과(true=로그인됨, false=안 됨, undefined=판단 못 함)를 받을 수 있다.
let ssgInflight = null;
function ssgCheck(reason) {
    if (!ssgInflight) ssgInflight = ssgRunCheck(reason).finally(() => { ssgInflight = null; });
    return ssgInflight;
}
async function ssgRunCheck(reason) {
    const fail = async (msg) => { await ssgLog(`❌ ${msg} (탭은 그대로 둠)`, { lastCheck: Date.now(), loggedIn: false }); return false; };
    const ok = async (msg) => { await ssgLog(`✅ ${msg} (탭은 그대로 둠)`, { lastCheck: Date.now(), loggedIn: true }); return true; };
    try {
        const st = await ssgGetState();
        if (!st.running) return;

        // 1) 확인용 탭 확보 (처음 열어 둔 탭 재사용, 없을 때만 새로 연다)
        const { tabId, created } = await ssgGetTab(st);
        // 탭 번호 저장은 기록 한 줄과 함께 storage 쓰기 1회로 처리
        await ssgLog(`🔍 로그인 상태 확인 시작 (${reason}) → ${created ? '새 SSG 탭을 열어' : '열어 둔 SSG 탭에서'} 마이페이지 이동`, { tabId });

        // 2) 그 탭에서 마이페이지로 이동 (새 탭이면 이미 그 주소로 열렸으므로 로딩만 기다린다)
        if (!created) await chrome.tabs.update(tabId, { url: SSG_CHECK_URL });
        await ssgSettle(tabId, created);

        // 3) 확인용 탭 말고 SSG 로그인 화면 탭이 더 열려 있으면 그 탭들만 닫는다
        await ssgCloseLoginTabs(tabId);

        // 4) 주소가 로그인 화면이거나, 화면 안에 "로그인" 표시가 있으면(로그아웃 표시는 없음) 로그아웃 상태로 본다
        const url = await ssgTabUrl(tabId);
        if (url === null) { await ssgLog('⚠️ 확인용 탭이 도중에 닫혀 이번 확인을 건너뜁니다.'); return; }
        const page = await ssgProbe(tabId);
        const onLoginPage = isSsgLoginUrl(url) || !!(page && page.hasPwInput);
        if (!onLoginPage && !ssgLoggedOut(page)) return ok('SSG 로그인 유지 중');

        await ssgLog(`⚠️ 로그인이 풀려 있음 (${onLoginPage ? '로그인 화면' : '화면에 로그인 표시'}) → 같은 탭에서 자동 로그인 시도`);
        if (!st.id || !st.pw) return fail('아이디/비밀번호가 저장되어 있지 않아 로그인할 수 없습니다.');

        // 5) 로그인 화면이 아니면(로그아웃해도 주소가 안 바뀐 경우) "로그인" 링크 주소로, 없으면 기본 로그인 주소로 이동
        if (!onLoginPage) {
            const go = (page && page.loginHref) || SSG_LOGIN_URL;
            await ssgLog(`➡️ 로그인 화면으로 이동: ${go}`);
            await chrome.tabs.update(tabId, { url: go });
            await ssgSettle(tabId, false);
        }

        // 로그인 화면이 아직 완전히 그려지지 않았을 수 있어 입력칸이 나타날 때까지 잠시 대기 (최대 5회)
        let res = null;
        for (let i = 0; i < 5 && !(res && res.ok); i++) {
            if (i) await ssgWait(1500);
            try {
                const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: ssgFillAndSubmit, args: [st.id, st.pw] });
                res = r && r.result;
            } catch (e) { res = { ok: false, reason: e.message }; }
        }
        if (!res || !res.ok) return fail(`자동 로그인 실패: ${(res && res.reason) || '스크립트 실행 오류'}`);

        // 로그인 처리 대기 (최대 30초): 로그인 화면에서 벗어나고 화면에 로그인 표시도 없으면 성공
        for (let i = 0; i < 20; i++) {
            await ssgWait(1500);
            const u = await ssgTabUrl(tabId);
            if (u === null) break;
            if (isSsgLoginUrl(u)) continue;
            await ssgWait(1500); // 이동한 화면이 그려질 시간
            if (ssgLoggedOut(await ssgProbe(tabId))) return fail('로그인 화면에서는 벗어났지만 화면에 아직 로그인 표시가 있음 (비밀번호 확인 필요)');
            return ok('SSG 자동 로그인 성공');
        }
        return fail('로그인 버튼을 눌렀지만 로그인 화면에서 벗어나지 못함 (비밀번호/보안문자 확인 필요)');
    } catch (e) {
        await ssgLog(`❌ 오류: ${e.message}`);
    }
    // 💡 탭은 어떤 경우에도 닫지 않고 그대로 둔다
}

// ═══════════════════════════════════════════════════════════════
// 💡 작업 창 CAPTCHA 정리 (실행 탭의 mango_ssg_captcha 신호로 실행)
// ═══════════════════════════════════════════════════════════════
const MANGO_TAB_MATCH = ['*://*.mycafe24.com/*'];

// 작업 창(mycafe24 탭) 중 CAPTCHA 알림 표식(__MANGO_CAPTCHA, 훅이 alert 를 가로채며 남김)이 있는 탭 번호 목록
//    탭마다 표식을 읽는 작업은 서로 독립이므로 한꺼번에 실행한다
const hasCaptchaMark = () => !!window.__MANGO_CAPTCHA;
async function ssgFindCaptchaTabs() {
    const tabs = await ssgListTabs(MANGO_TAB_MATCH);
    const marks = await Promise.all(tabs.map(t => ssgProbe(t.id, hasCaptchaMark, 'MAIN')));
    return tabs.filter((t, i) => marks[i]).map(t => t.id);
}

// 💡 CAPTCHA 가 뜬 작업 창과, 작업 창이 배열에 맞춰 띄운 SSG 팝업창을 모두 닫는다
//    팝업창: type 이 popup 인 창 중 SSG 주소이거나 CAPTCHA 작업 창이 연 창 (about:blank 로 남은 창 포함)
//    확인용 SSG 탭은 일반 탭이라 여기에 해당하지 않는다
async function ssgCloseCaptchaWindows(captchaTabs) {
    const isCaptchaOpener = new Set(captchaTabs);
    let wins = [];
    try { wins = await chrome.windows.getAll({ populate: true, windowTypes: ['popup'] }); } catch (e) {}
    const popupIds = wins
        .filter(w => (w.tabs || []).some(t => isSsgUrl(t.url) || isCaptchaOpener.has(t.openerTabId)))
        .map(w => w.id);
    // 창 닫기는 서로 독립이므로 한꺼번에 (이미 닫힌 창은 무시)
    const closed = await Promise.all(popupIds.map(id => chrome.windows.remove(id).then(() => 1, () => 0)));
    const popups = closed.reduce((a, b) => a + b, 0);
    if (captchaTabs.length) {
        try { await chrome.tabs.remove(captchaTabs); } catch (e) { /* 이미 닫힘 */ }
    }
    await ssgLog(`🧹 CAPTCHA 작업 창 ${captchaTabs.length}개, 배열 SSG 팝업창 ${popups}개를 닫음 → 실행 탭은 모든 창이 끝나면 다음 사이클을 처음부터 시작`);
}

// 실행 탭은 창이 안 닫히면 1분마다 다시 신호를 보내므로, 처리 중이면 무시하고 꺼짐 경고도 자주 남기지 않는다
const SSG_CAPTCHA_WARN_COOLDOWN_MS = 10 * 60 * 1000;
let ssgCaptchaPending = false;
let ssgCaptchaWarnedAt = 0;
async function ssgCaptchaRecover() {
    if (ssgCaptchaPending) return;
    ssgCaptchaPending = true;
    try {
        if (!(await ssgGetState()).running) {
            if (Date.now() - ssgCaptchaWarnedAt < SSG_CAPTCHA_WARN_COOLDOWN_MS) return;
            ssgCaptchaWarnedAt = Date.now();
            await ssgLog('⚠️ 작업 창에 SSG 로그인/CAPTCHA 알림이 떴지만 SSG 자동 재로그인이 꺼져 있어 처리하지 않음 (SSG 로그인 실행을 눌러 주세요)');
            return;
        }
        await ssgLog('🚨 작업 창에 SSG 로그인/CAPTCHA 알림 감지 → 로그인 확인/재로그인 후 CAPTCHA 창을 정리합니다');
        // 진행 중인 확인이 있으면 그 결과를 같이 받고, 없으면 새로 확인한다
        if (!(await ssgCheck('작업 창 CAPTCHA 감지'))) {
            await ssgLog('❌ SSG 로그인이 확인되지 않아 CAPTCHA 창을 닫지 않음 (실행 탭이 1분 뒤 다시 요청함)');
            return;
        }
        await ssgCloseCaptchaWindows(await ssgFindCaptchaTabs());
    } catch (e) {
        await ssgLog(`❌ CAPTCHA 정리 오류: ${e.message}`);
    } finally {
        ssgCaptchaPending = false;
    }
}

async function ssgStart(id, pw) {
    await chrome.alarms.create(SSG_ALARM, { periodInMinutes: SSG_CHECK_MINUTES });
    await ssgLog(`▶ SSG 자동 재로그인 시작 (로그인 화면/로그인 표시가 보이면 즉시 + ${SSG_CHECK_MINUTES}분마다 열어 둔 SSG 탭에서 확인)`,
        { running: true, id, pw, loggedIn: null });
    ssgCheck('시작 직후'); // 기다리지 않고 바로 첫 확인
}

// 중지: 주기 확인만 멈추고, 열어 둔 SSG 탭은 닫지 않는다 (다시 시작하면 같은 탭을 재사용)
async function ssgStop(why = '⏹ SSG 자동 재로그인 중지 (열어 둔 SSG 탭은 그대로 둠)') {
    await chrome.alarms.clear(SSG_ALARM);
    await ssgLog(why, { running: false });
}

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === SSG_ALARM) ssgCheck('1시간 주기');
});

// 💡 로그아웃 즉시 감지: 어떤 SSG 탭이든
//    (1) 주소가 로그인 화면으로 바뀌거나
//    (2) 로딩이 끝난 화면 안에 "로그인" 표시가 있으면(로그아웃해도 주소가 안 바뀌는 경우) 바로 확인을 돌린다.
//    확인 중(ssgInflight)이면 확인용 탭이 움직이는 것이므로 무시하고,
//    감지로 한 번 돌린 뒤 SSG_EVENT_COOLDOWN_MS 안에는 다시 돌리지 않는다 (실패 반복 방지).
let ssgEventLast = 0;
function ssgTrigger(reason) {
    if (ssgInflight || Date.now() - ssgEventLast < SSG_EVENT_COOLDOWN_MS) return;
    ssgEventLast = Date.now();
    ssgCheck(reason);
}
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
    if (ssgInflight) return;
    if (isSsgLoginUrl(info.url)) { ssgTrigger('로그인 화면 감지'); return; }
    if (info.status !== 'complete' || !isSsgUrl(tab && tab.url)) return;
    if (!(await ssgGetState()).running) return;
    await ssgWait(1500); // 상단 메뉴가 그려질 시간
    if (ssgInflight) return;
    if (ssgLoggedOut(await ssgProbe(tabId))) ssgTrigger('화면에 로그인 표시 감지');
});

// 💡 [실행 탭 복귀] 매크로 실행 탭(mango_script.js)이 작업 창을 모두 연 뒤 보내는 신호
//    → 새 탭들이 앞으로 나오면서 가려진 실행 탭(작업 로그가 보이는 탭)을 다시 활성화한다
async function focusTab(tab) {
    try {
        await chrome.tabs.update(tab.id, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
    } catch (e) {}
}

// 팝업/실행 탭에서 오는 명령
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'mango_focus_runner') { if (sender.tab) focusTab(sender.tab); return; }
    if (msg.type === 'mango_ssg_captcha') { ssgCaptchaRecover(); return; }
    if (!msg.type.startsWith('ssg_')) return;
    (async () => {
        if (msg.type === 'ssg_start') await ssgStart(msg.id, msg.pw);
        else if (msg.type === 'ssg_stop') await ssgStop();
        sendResponse(await ssgGetState());
    })();
    return true; // 비동기 응답
});

// 브라우저를 다시 켰을 때: 예전 탭 번호는 더 이상 유효하지 않으므로 지우고,
// (열려 있는 SSG 탭을 다시 찾거나 새로 열어) 확인을 이어간다
// (chrome.alarms 는 브라우저 재시작 후에도 유지됨)
chrome.runtime.onStartup.addListener(async () => {
    const st = await ssgGetState();
    if (st.running) {
        await chrome.storage.local.set({ ssgAuto: { ...st, tabId: null } });
        await ssgLog('ℹ️ 브라우저가 다시 시작됨 → SSG 자동 재로그인 계속 실행');
        ssgCheck('브라우저 재시작');
    }
});
