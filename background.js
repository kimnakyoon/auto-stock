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
