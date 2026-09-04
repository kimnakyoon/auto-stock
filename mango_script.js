'use strict';
// 더망고 자동화 매크로 - 작업 스크립트
// 💡 파일 전체를 즉시실행함수로 감싸서 전역 변수 충돌 방지 (재실행 시 SyntaxError로 조용히 죽던 문제 해결)
(() => {
    if (window.__MANGO_LOCK) {
        const msg = '⚠️ 이미 이 탭에서 매크로가 실행 중입니다. (설정을 바꿔 다시 실행하려면 페이지를 새로고침하세요)';
        console.warn(msg);
        const box = document.getElementById('mango_log_box_ui');
        if (box) {
            const l = document.createElement('div');
            l.innerText = msg;
            l.style.color = '#e67e22';
            box.appendChild(l);
            box.scrollTop = box.scrollHeight;
        }
        return;
    }
    window.__MANGO_LOCK = true;

    mangoAutoLoop({
        BATCH_SIZE: window.__MANGO_BATCH || 800,
        FIRST_START_LIMIT: window.__MANGO_START || 1,
        LAST_END_LIMIT: window.__MANGO_END || null,
        DIVIDE_MODE: window.__MANGO_DIVIDE || null,
        START_X: window.__MANGO_START_X ?? 1250,
        START_Y: window.__MANGO_START_Y || 0
    });
})();

function mangoAutoLoop(CFG) {
    // 💡 매크로 시작 시점의 관리자 페이지 주소 (에러 페이지 복구 시 재접속용)
    const MAIN_URL = window.location.href;

    // ───────────────────────────────────────────────────────────────
    // 💡 크롬의 백그라운드 탭 1분 지연(Throttling)을 무시하는 타이머
    //    [최적화] 타이머마다 Worker를 새로 만들지 않고, Worker 하나가 모든 타이머를 관리
    // ───────────────────────────────────────────────────────────────
    const bgTimer = (() => {
        const workerSrc = `
            const timers = new Map();
            onmessage = (e) => {
                const { cmd, id, ms } = e.data;
                if (cmd === 'timeout') {
                    timers.set(id, setTimeout(() => { timers.delete(id); postMessage(id); }, ms));
                } else if (cmd === 'interval') {
                    timers.set(id, setInterval(() => postMessage(id), ms));
                } else if (cmd === 'clear') {
                    const h = timers.get(id);
                    if (h !== undefined) { clearTimeout(h); clearInterval(h); timers.delete(id); }
                }
            };`;
        const blobUrl = URL.createObjectURL(new Blob([workerSrc], { type: 'application/javascript' }));
        const worker = new Worker(blobUrl);
        URL.revokeObjectURL(blobUrl);

        const callbacks = new Map(); // id → { fn, once }
        let seq = 0;
        worker.onmessage = (e) => {
            const id = e.data;
            const cb = callbacks.get(id);
            if (!cb) return;
            if (cb.once) callbacks.delete(id);
            try { cb.fn(); } catch (err) { console.error('[mango timer]', err); }
        };

        const clear = (id) => {
            if (!id) return;
            callbacks.delete(id);
            worker.postMessage({ cmd: 'clear', id });
        };
        return {
            setTimeout: (fn, ms) => { const id = ++seq; callbacks.set(id, { fn, once: true }); worker.postMessage({ cmd: 'timeout', id, ms }); return id; },
            setInterval: (fn, ms) => { const id = ++seq; callbacks.set(id, { fn, once: false }); worker.postMessage({ cmd: 'interval', id, ms }); return id; },
            clearTimeout: clear,
            clearInterval: clear
        };
    })();

    // ───────────────────────────────────────────────────────────────
    // 실시간 기록창
    // ───────────────────────────────────────────────────────────────
    const MAX_LOG_LINES = 300; // [최적화] 며칠씩 돌려도 기록이 무한히 쌓여 느려지지 않도록 오래된 줄은 지움
    const POS_NAMES = { 450: '위치 0', 700: '위치 1', 950: '위치 2', 1200: '위치 3', 1450: '위치 4', 1700: '위치 5' };

    let logBox = document.getElementById('mango_log_box_ui');
    if (!logBox) {
        const posText = POS_NAMES[CFG.START_X] || `가로 ${CFG.START_X}`;
        logBox = document.createElement('div');
        logBox.id = 'mango_log_box_ui';
        logBox.style.cssText = 'position:fixed; bottom:20px; left:20px; width:350px; height:250px; background:rgba(0,0,0,0.85); color:#fff; z-index:999999; overflow-y:auto; font-size:13px; padding:12px; border-radius:8px; font-family:monospace; line-height:1.6; box-shadow: 0 4px 10px rgba(0,0,0,0.5);';
        logBox.innerHTML = `<div style="color:#f1c40f; font-weight:bold; font-size:14px; margin-bottom:8px; border-bottom:1px solid #555; padding-bottom:5px; display:flex; justify-content:space-between;">
            <span>🥭 실시간 기록</span>
            <span style="color:#64b5f6; background:#222; padding:2px 6px; border-radius:4px;">[${posText}]</span>
        </div>`;
        document.body.appendChild(logBox);
    }

    const pad2 = (n) => String(n).padStart(2, '0');
    const log = (m) => {
        const d = new Date();
        const msg = `[${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}] ${m}`;
        console.log(`%c${msg}`, 'color: #2980b9; font-weight: bold;');

        const line = document.createElement('div');
        line.innerText = msg;
        if (m.includes('완료')) line.style.color = '#2ecc71';
        else if (m.includes('시작')) line.style.color = '#3498db';
        else if (m.includes('지연')) line.style.color = '#e74c3c';
        else line.style.color = '#ecf0f1';

        logBox.appendChild(line);
        while (logBox.childElementCount > MAX_LOG_LINES + 1) logBox.removeChild(logBox.children[1]); // 첫 줄(제목)은 유지
        logBox.scrollTop = logBox.scrollHeight;
    };

    const SUCCESS_TEXT = '상품의 가격 업데이트 및 선택하신 마켓으로 상품 전송이 모두 완료되었습니다.';
    const normalizedSuccess = SUCCESS_TEXT.replace(/\s+/g, '');
    const ERROR_TEXT = '페이지 로딩이 잠시 지연';
    // 💡 마켓 로그인 체크 실패 등으로 작업이 시작도 못 하고 끝났을 때 뜨는 문구
    //    ("전송가능한 업데이트 또는 마켓이 없습니다. 전송을 종료합니다.")
    const ABORT_TEXT = '전송을 종료합니다';
    const normalizedAbort = ABORT_TEXT.replace(/\s+/g, '');
    // 💡 SSG 로그인이 풀린 채 작업하면 작업 창에 뜨는 alert 문구
    //    ("로그인 페이지 또는 CAPTCHA 페이지입니다. 로그인 또는 CAPTCHA 해제 후에 ... 다시 진행하시기 바랍니다.")
    const CAPTCHA_TEXT = 'CAPTCHA';

    // 💡 카페24 서버 과부하 시 뜨는 "페이지 로딩이 잠시 지연되었습니다" 에러 페이지 감지
    function isErrorPage(win) {
        try {
            const body = win.document.body;
            return !!body && body.innerText.includes(ERROR_TEXT);
        } catch (e) { return false; }
    }

    // 작업 탭 안에 팝업 위치 고정 + 로딩 지연 자동 재시도 훅을 심는다
    function injectPopupHook(win, tabIndex) {
        const script = win.document.createElement('script');
        script.textContent = `
        (() => {
            // 💡 백그라운드(background.js)가 팝업 위치를 강제 고정할 때 읽어가는 표식
            window.__MANGO_POPUP_LEFT = ${CFG.START_X};
            window.__MANGO_POPUP_TOP = ${CFG.START_Y};
            window.__MANGO_TAB_INDEX = ${tabIndex};

            if (window.__MANGO_HOOKED) return; // 중복 주입 방지
            window.__MANGO_HOOKED = true;

            // 💡 SSG 로그인이 풀리면 더망고가 "로그인 페이지 또는 CAPTCHA 페이지입니다" alert 를 띄우며 이 창이 막힌다.
            //    대화상자는 띄우지 않고 표식(__MANGO_CAPTCHA)만 남긴다 → 실행 탭이 이 표식을 보고
            //    확장에 SSG 재로그인을 요청한다. 이후 처리는 실행 탭의 감시 루프가 정한다.
            const nativeAlert = window.alert.bind(window);
            window.alert = function(msg) {
                const s = String(msg ?? '');
                if (s.indexOf('${CAPTCHA_TEXT}') === -1) return nativeAlert(msg);
                window.__MANGO_CAPTCHA = s;
                console.warn('[mango] SSG 로그인/CAPTCHA 알림 감지 (창이 막히지 않도록 대화상자는 띄우지 않음):', s);
            };

            const originalOpen = window.open;
            const tracked = []; // 열린 팝업 감시 목록 (로딩 지연 에러 자동 재시도용)
            const P_WIDTH = 220, P_HEIGHT = 120, Y_STEP = 65;

            window.open = function(url, name, specs) {
                // 💡 실행한 모니터 기준으로 좌표 계산 (availLeft/availTop = 현재 창이 떠 있는 모니터의 시작 좌표)
                const left = (screen.availLeft || 0) + ${CFG.START_X};
                const top = (screen.availTop || 0) + ${CFG.START_Y} + (${tabIndex} * Y_STEP);
                const newSpecs = 'width=' + P_WIDTH + ',height=' + P_HEIGHT + ',left=' + left + ',screenX=' + left + ',top=' + top + ',screenY=' + top + ',status=no,toolbar=no,scrollbars=yes';
                const newWin = originalOpen.call(window, url, name, newSpecs);

                if (newWin) {
                    // 💡 원본 moveTo를 먼저 보관한 뒤 무력화 → 마켓 팝업은 못 움직이고, 우리는 움직일 수 있음
                    let nativeMoveTo = null;
                    try {
                        nativeMoveTo = newWin.moveTo.bind(newWin);
                        newWin.moveTo = function(){};
                        newWin.moveBy = function(){};
                        newWin.resizeTo = function(){};
                        newWin.resizeBy = function(){};
                    } catch(e) {}

                    // 💡 크롬이 left 무시할 경우 보관해둔 원본 moveTo로 강제 이동
                    const fix = () => { try { if (nativeMoveTo) nativeMoveTo(left, top); } catch(e) {} };
                    setTimeout(fix, 300);
                    setTimeout(fix, 1000);

                    // 💡 로딩 지연 에러 감시 목록에 등록 (원래 가려던 주소를 기억해둠)
                    let fullUrl = null;
                    try { if (url && url !== 'about:blank') fullUrl = new URL(url, location.href).href; } catch(e) {}
                    tracked.push({ w: newWin, url: fullUrl, last: 0 });
                }
                return newWin;
            };

            // 💡 백그라운드에서도 멈추지 않는 Worker 타이머로 팝업 상태 감시
            //    팝업에 "페이지 로딩이 잠시 지연" 에러가 뜨면 20초 간격으로 원래 주소로 재접속
            const blobUrl = URL.createObjectURL(new Blob(['setInterval(() => postMessage(1), 5000)'], {type:'application/javascript'}));
            const watcher = new Worker(blobUrl);
            URL.revokeObjectURL(blobUrl);
            watcher.onmessage = () => {
                for (let i = tracked.length - 1; i >= 0; i--) {
                    const p = tracked[i];
                    try {
                        if (!p.w || p.w.closed) { tracked.splice(i, 1); continue; }
                        const body = p.w.document.body;
                        if (body && body.innerText.indexOf('${ERROR_TEXT}') !== -1 && Date.now() - p.last > 20000) {
                            p.last = Date.now();
                            if (p.url) p.w.location.href = p.url;
                            else p.w.location.reload();
                        }
                    } catch(e) {}
                }
            };
        })();
        `;
        win.document.documentElement.appendChild(script);
    }

    // 💡 작업 탭 세팅(검색 → 범위 입력 → 작업 시작)
    //    에러 페이지가 뜨면 관리자 페이지로 재접속한 뒤 처음부터 다시 세팅한다
    //    세팅이 끝나면(또는 창이 닫히면) t.onReady를 호출해 다음 창을 열도록 알린다
    function startWorkerSetup(t) {
        const wake = () => { const cb = t.onReady; t.onReady = null; if (cb) cb(); };
        const stop = () => { bgTimer.clearInterval(t.setupIt); t.setupIt = null; };

        stop();
        t.setupIt = bgTimer.setInterval(() => {
            try {
                const w = t.win;
                if (!w || w.closed) { stop(); wake(); return; }

                // 로딩 지연 에러 페이지 감지 → 15초 간격으로 재접속
                if (isErrorPage(w)) {
                    if (Date.now() - (t.lastRetry || 0) > 15000) {
                        t.lastRetry = Date.now();
                        t.retryCount = (t.retryCount || 0) + 1;
                        log(`⚠️ [${t.start}~${t.end}] 로딩 지연 감지 → 재접속 ${t.retryCount}회차`);
                        w.location.href = MAIN_URL;
                    }
                    return;
                }

                const doc = w.document;
                if (doc.readyState !== 'complete' || w.location.href === 'about:blank') return;

                // [최적화] 같은 문서에 훅을 매번 다시 심지 않음 (문서가 바뀌면 표식도 사라지므로 자동 재주입)
                if (!doc.__MANGO_HOOKED) { injectPopupHook(w, t.index); doc.__MANGO_HOOKED = true; }

                const btn = doc.querySelector('a.defbtn_med.dtype2[onclick*="search_form"]');
                if (btn && !w.__CLICKED) { btn.click(); w.__CLICKED = true; }

                if (typeof w.set_limit_num !== 'function') return;
                w.set_limit_num();
                const sI = doc.getElementById('start_limit');
                const eI = doc.getElementById('end_limit');
                if (sI && eI && typeof w.start_ini_all === 'function') {
                    sI.value = t.start;
                    eI.value = t.end;
                    w.start_ini_all();
                    stop();
                    t.ready = true;
                    wake();
                }
            } catch (e) {}
        }, 1000); // [최적화] 3초 → 1초: 창이 뜨자마자 세팅되어 다음 창이 더 빨리 열림
    }

    // 전체 수량 파악용 임시 탭을 열어 총 개수를 알아낸다 (undefined=팝업 차단, null=실패, 0=작업 없음)
    function fetchTotalCount() {
        const masterWorker = window.open(MAIN_URL, '_blank');
        if (!masterWorker) return Promise.resolve(undefined);
        masterWorker.opener = null;

        return new Promise(resolve => {
            let clicked = false, clickTime = 0, lastRetry = 0;
            const openTime = Date.now();
            const finish = (val) => { bgTimer.clearInterval(it); try { masterWorker.close(); } catch (e) {} resolve(val); };

            const it = bgTimer.setInterval(() => {
                try {
                    if (masterWorker.closed) { finish(null); return; }

                    // 💡 "검색된 상품이 없습니다" 같은 alert 창이 흐름을 막지 못하게 무력화
                    try { masterWorker.alert = function () {}; } catch (e) {}

                    // 💡 수량 파악 탭도 로딩 지연 에러가 뜨면 재접속
                    if (isErrorPage(masterWorker)) {
                        if (Date.now() - lastRetry > 15000) {
                            lastRetry = Date.now();
                            clicked = false;
                            clickTime = 0;
                            log('⚠️ 수량 파악 탭 로딩 지연 감지 → 재접속');
                            masterWorker.location.href = MAIN_URL;
                        }
                        return;
                    }

                    const doc = masterWorker.document;
                    const btn = doc.querySelector('a.defbtn_med.dtype2[onclick*="search_form"]');
                    if (btn && !clicked) { btn.click(); clicked = true; clickTime = Date.now(); }

                    const el = doc.getElementById('span_total_count');
                    const num = parseInt(el?.innerText.replace(/[^\d]/g, '') || '0');
                    if (num > 0) { finish(num); return; }

                    // 검색을 눌렀는데 60초가 지나도 0개면 → "작업할 상품 없음"으로 판단
                    if (clicked && Date.now() - clickTime > 60000) { finish(0); return; }
                    // 3분이 지나도록 검색 버튼조차 못 찾으면 → 실패로 판단하고 재시도
                    if (!clicked && Date.now() - openTime > 180000) { finish(null); return; }
                } catch (e) {}
            }, 1000);
        });
    }

    // 작업 창 하나가 세팅을 마칠 때까지 기다린다 (창이 닫히거나 3분이 지나면 그냥 넘어감)
    function waitUntilReady(t) {
        return new Promise(resolve => {
            const guard = bgTimer.setTimeout(() => { t.onReady = null; resolve(); }, 180000);
            t.onReady = () => { bgTimer.clearTimeout(guard); resolve(); };
        });
    }

    const sleep = (ms) => new Promise(r => bgTimer.setTimeout(r, ms));

    // 💡 [실행 탭 복귀] 새 작업 탭들이 앞으로 나오면서 이 탭(작업 로그가 보이는 실행 탭)이 가려지므로,
    //    창을 다 연 뒤 확장(popup.js가 심어둔 브리지 → background.js)에 신호를 보내 이 탭으로 되돌아온다
    //    같은 브리지로 MANGO_SSG_CAPTCHA 도 보낸다: 작업 창에 SSG 로그인/CAPTCHA 알림이 떴으니
    //    확장이 SSG 재로그인을 하고, 성공하면 CAPTCHA 가 뜬 작업 창과 배열에 맞춰 뜬 SSG 팝업창을 모두 닫아 달라는 신호
    const signalExt = (type) => { try { window.postMessage({ type }, location.origin); } catch (e) {} };
    const focusRunner = () => signalExt('MANGO_FOCUS_RUNNER');
    const CAPTCHA_NOTIFY_MS = 60000; // 확장이 아직 안 닫아 줬으면 이 간격으로 다시 알린다

    // 💡 작업 창 하나를 끝난 것으로 표시한다 (사이클은 모든 창이 끝나면 다음 바퀴를 처음부터 시작)
    function finishWorker(t, msg) {
        t.done = true;
        t.onReady = null;
        if (msg) log(msg);
    }

    // 💡 작업 창을 닫고 같은 구간으로 새 창을 열어 처음부터 다시 실행한다 ("전송을 종료합니다" 조기 종료용)
    function reopenWorker(t) {
        try { t.win.close(); } catch (e) {}
        const nw = window.open(MAIN_URL, '_blank');
        if (!nw) {
            finishWorker(t, `⚠️ [${t.start}~${t.end}] 재실행 창을 열지 못했습니다. (팝업 차단 확인)`);
            return;
        }
        nw.opener = null;
        t.win = nw;
        t.ready = false;
        t.captchaAt = 0;
        startWorkerSetup(t);
        focusRunner(); // 재실행 창이 앞으로 나오므로 실행 탭으로 되돌아온다
    }

    async function runCycle() {
        log('🔄 사이클 시작 - 전체 수량 파악용 임시 탭을 엽니다.');
        const total = await fetchTotalCount();

        if (total === undefined) {
            alert('⚠️ 팝업 차단 해제가 필요합니다!');
            window.__MANGO_LOCK = false;
            return;
        }
        if (total === null) {
            log('⚠️ 수량 파악 실패 → 30초 후 사이클을 다시 시도합니다.');
            bgTimer.setTimeout(runCycle, 30000);
            return;
        }
        if (total === 0) {
            log('ℹ️ 검색 결과 0개 - 지금은 작업할 상품이 없습니다. 60초 후 다시 확인합니다.');
            bgTimer.setTimeout(runCycle, 60000);
            return;
        }

        const endLimit = (CFG.LAST_END_LIMIT === null) ? total : Math.min(CFG.LAST_END_LIMIT, total);
        const workRange = endLimit - CFG.FIRST_START_LIMIT + 1;

        let batchSize = CFG.BATCH_SIZE;
        if (CFG.DIVIDE_MODE) {
            batchSize = Math.ceil(workRange / CFG.DIVIDE_MODE);
            log(`총 ${workRange}개를 ${CFG.DIVIDE_MODE}분할 하여 1개 창당 ${batchSize}개씩 작업합니다.`);
        }

        const totalTabs = Math.ceil(workRange / batchSize);
        const workers = [];

        // 💡 창을 한 번에 다 열지 않고, 앞 창이 완전히 뜨고 작업이 시작된 뒤 다음 창을 연다
        for (let i = 0; i < totalTabs; i++) {
            const start = CFG.FIRST_START_LIMIT + (i * batchSize);
            const end = Math.min(start + batchSize - 1, endLimit);

            const w = window.open(MAIN_URL, '_blank');
            // captchaAt: SSG 로그인/CAPTCHA 알림을 감지한 시각 (0 이면 감지 안 됨)
            const t = { win: w, start, end, index: i, done: false, ready: false, onReady: null, setupIt: null, lastRetry: 0, retryCount: 0, abortCount: 0, captchaAt: 0 };
            workers.push(t);

            if (!w) { // 창 자체가 안 열리면(팝업 차단 등) 이 구간은 건너뛰어 사이클이 영원히 멈추지 않게 함
                finishWorker(t, `⚠️ ${i + 1}/${totalTabs}번째 창 [${start}~${end}]을 열지 못했습니다. (팝업 차단 확인)`);
                continue;
            }
            w.opener = null;

            log(`🪟 ${i + 1}/${totalTabs}번째 창 [${start}~${end}] 준비 중...`);
            startWorkerSetup(t);
            await waitUntilReady(t);

            if (i + 1 < totalTabs) {
                if (t.ready) log(`🪟 ${i + 1}/${totalTabs}번째 창 준비 완료 → 다음 창을 엽니다.`);
                await sleep(1000); // 팝업 위치 정렬이 겹치지 않도록 잠시 간격
            } else if (t.ready) {
                log(`🪟 ${i + 1}/${totalTabs}번째 창 준비 완료. 모든 창이 작업 중입니다.`);
            }
        }

        // 💡 창을 모두 열었으니 실행 탭(이 탭)으로 돌아온다
        if (workers.some(t => t.win)) {
            log('↩️ 모든 창을 열었습니다 → 실행 탭으로 돌아옵니다.');
            focusRunner();
        }

        // 💡 [정책] CAPTCHA 로 닫힌 창은 구간을 다시 열지 않는다. 닫힌 창은 모두 끝난 창으로 보고,
        //    모든 창이 끝나면 다음 사이클을 처음부터(수량 파악 → 창 순차 오픈) 시작한다.
        //    확장에는 사이클당 하나의 시계로 1분에 한 번만 알린다 (작업 창마다 따로 보내면 같은 요청이 창 수만큼 간다)
        let captchaNotifiedAt = 0;
        let reopenedAt = 0; // 재실행 창은 처음 열 때처럼 한 번(10초 틱)에 하나씩만 연다 (한꺼번에 열면 로딩 지연 유발)
        const monitorIt = bgTimer.setInterval(() => {
            const now = Date.now();
            let allFinished = true;
            for (const t of workers) {
                if (t.done) continue;
                try {
                    if (t.win.closed) {
                        finishWorker(t, t.captchaAt && `🔁 [${t.start}~${t.end}] CAPTCHA 창이 닫힘 → 이 구간은 다시 열지 않음 (모든 창이 끝나면 다음 사이클 시작)`);
                        continue;
                    }

                    // 💡 SSG 로그인/CAPTCHA 알림 표식(훅이 alert 를 가로채며 남김) 감지 — 값 하나만 읽으므로 비싼 검사들보다 먼저 본다
                    //    → 확장에 알리고, 확장이 SSG 재로그인 뒤 이 창을 닫아 줄 때까지 기다린다 (닫히면 위에서 끝난 창으로 처리)
                    if (!t.setupIt && t.win.__MANGO_CAPTCHA) {
                        allFinished = false;
                        if (!t.captchaAt) {
                            t.captchaAt = now;
                            log(`⚠️ [${t.start}~${t.end}] SSG 로그인/CAPTCHA 감지 → 확장에 SSG 재로그인 요청 (로그인 후 이 창을 닫음)`);
                        }
                        if (now - captchaNotifiedAt > CAPTCHA_NOTIFY_MS) { captchaNotifiedAt = now; signalExt('MANGO_SSG_CAPTCHA'); }
                        continue;
                    }

                    // 💡 작업 시작 후 에러 페이지가 뜨면 → 재접속하고 해당 구간을 처음부터 재시작
                    //    (세팅 중이면 startWorkerSetup 쪽에서 이미 처리하므로 setupIt이 없을 때만)
                    if (!t.setupIt && isErrorPage(t.win)) {
                        allFinished = false;
                        if (Date.now() - (t.lastRetry || 0) > 15000) {
                            t.lastRetry = Date.now();
                            t.retryCount = (t.retryCount || 0) + 1;
                            log(`⚠️ [${t.start}~${t.end}] 작업 중 로딩 지연 감지 → 구간 재시작 ${t.retryCount}회차`);
                            t.win.location.href = MAIN_URL;
                            startWorkerSetup(t);
                        }
                        continue;
                    }

                    // 진행 메시지 영역(layer_page)을 한 번만 읽어 "전송 종료"와 "완료"를 함께 판정
                    const layer = (t.win.document.getElementById('layer_page')?.innerText || '').replace(/\s+/g, '');

                    // 💡 "전송을 종료합니다" 조기 종료 → 해당 창만 닫고 같은 구간으로 새 창을 열어 다시 실행
                    if (!t.setupIt && layer.includes(normalizedAbort)) {
                        allFinished = false;
                        if (reopenedAt !== now) {
                            reopenedAt = now;
                            log(`⚠️ [${t.start}~${t.end}] 전송 종료 문구 감지 → 창 닫고 재실행 ${++t.abortCount}회차`);
                            reopenWorker(t);
                        }
                        continue;
                    }

                    if (layer.includes(normalizedSuccess)) {
                        finishWorker(t, `✅ [${t.start}~${t.end}] 완료. (3초 후 탭 자동 종료)`);
                        const w = t.win;
                        bgTimer.setTimeout(() => { try { w.close(); } catch (e) {} }, 3000);
                    } else {
                        allFinished = false;
                    }
                } catch (e) { allFinished = false; }
            }

            if (allFinished) {
                bgTimer.clearInterval(monitorIt);
                log('🏁 한 바퀴(사이클) 모두 완료되었습니다.');
                log('⏳ 5초 후 다음 사이클을 자동으로 시작합니다...');
                bgTimer.setTimeout(runCycle, 5000);
            }
        }, 10000);
    }

    runCycle();
}
