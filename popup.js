// 분할 방식에 따라 "한 창당 처리 개수" / "창 개수" 입력칸을 보여준다
function applyModeUI(mode) {
  document.getElementById('customBatchRow').style.display = (mode === 'custom') ? 'block' : 'none';
  document.getElementById('windowCountRow').style.display = (mode === 'windows') ? 'block' : 'none';
}

document.addEventListener('DOMContentLoaded', async () => {
  // 1. 현재 열려있는 탭 정보를 가져옵니다.
  let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  
  // 2. 현재 탭에서 이미 실행 중인 매크로 값이 있는지 몰래 확인합니다.
  chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: "MAIN",
    func: () => {
      return {
        x: window.__MANGO_START_X,
        s: window.__MANGO_START,
        e: window.__MANGO_END,
        b: window.__MANGO_BATCH,
        m: window.__MANGO_DIVIDE
      };
    }
  }, (results) => {
    let isRunningInTab = false;
    
    // 💡 현재 탭에서 실행된 적이 있다면, 그 값으로 팝업을 세팅(고정)합니다!
    if (results && results[0] && results[0].result && results[0].result.x !== undefined) {
      const res = results[0].result;
      document.getElementById('posPreset').value = res.x;
      document.getElementById('startLimit').value = res.s || '1';
      if (res.e) document.getElementById('endLimit').value = res.e;
      
      if (res.m) {
          document.getElementById('divideMode').value = 'windows';
          document.getElementById('windowCount').value = res.m;
      } else {
          document.getElementById('divideMode').value = 'custom';
          document.getElementById('batchSize').value = res.b || 800;
      }
      applyModeUI(document.getElementById('divideMode').value);
      isRunningInTab = true;
    }

    // 현재 탭에서 실행한 적이 없는 '새 창'이라면, 공통 저장된 마지막 값을 불러옵니다.
    if (!isRunningInTab) {
      if (localStorage.getItem('mango_start')) document.getElementById('startLimit').value = localStorage.getItem('mango_start');
      if (localStorage.getItem('mango_end')) document.getElementById('endLimit').value = localStorage.getItem('mango_end');
      
      if (localStorage.getItem('mango_mode')) {
          let savedMode = localStorage.getItem('mango_mode');
          // 예전 버전에서 저장된 숫자 값(예: "4")은 "직접 창 개수 입력" 4개로 옮겨준다
          if (savedMode !== 'custom' && savedMode !== 'windows') {
              document.getElementById('windowCount').value = parseInt(savedMode) || 2;
              savedMode = 'windows';
          }
          document.getElementById('divideMode').value = savedMode;
          applyModeUI(savedMode);
      }
      
      if (localStorage.getItem('mango_batch')) document.getElementById('batchSize').value = localStorage.getItem('mango_batch');
      if (localStorage.getItem('mango_windows')) document.getElementById('windowCount').value = localStorage.getItem('mango_windows');
      if (localStorage.getItem('mango_pos')) document.getElementById('posPreset').value = localStorage.getItem('mango_pos');
    }
  });
});

document.getElementById('divideMode').addEventListener('change', (e) => {
  applyModeUI(e.target.value);
});

document.getElementById('btnRun').addEventListener('click', async () => {
  const sVal = document.getElementById('startLimit').value;
  const eVal = document.getElementById('endLimit').value;
  const mode = document.getElementById('divideMode').value;
  const bVal = document.getElementById('batchSize').value;
  const wVal = document.getElementById('windowCount').value;
  const xVal = document.getElementById('posPreset').value; 
  const yVal = 0; 

  if (mode === 'windows' && !(parseInt(wVal) >= 1)) {
    alert('창 개수는 1 이상의 숫자를 입력해주세요.');
    return;
  }

  localStorage.setItem('mango_start', sVal);
  localStorage.setItem('mango_end', eVal);
  localStorage.setItem('mango_mode', mode);
  localStorage.setItem('mango_batch', bVal);
  localStorage.setItem('mango_windows', wVal);
  localStorage.setItem('mango_pos', xVal);

  let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: "MAIN",
    func: (s, e, mode, b, w, x, y) => {
      window.__MANGO_START = parseInt(s) || 1;
      window.__MANGO_END = e ? parseInt(e) : null;
      // 기존 1700 오류 방지 수정
      window.__MANGO_START_X = (x !== "" && x !== null) ? parseInt(x) : 1250; // 이왕이면 1700 대신 새 기본값 1250으로!
      window.__MANGO_START_Y = y;
      
      if (mode === 'custom') {
          window.__MANGO_BATCH = parseInt(b) || 800;
          window.__MANGO_DIVIDE = null;
      } else {
          // 직접 창 개수 입력: 전체를 창 개수로 나눠서 한 창당 처리 개수를 정한다 (mango_script.js의 DIVIDE_MODE)
          window.__MANGO_BATCH = null;
          window.__MANGO_DIVIDE = parseInt(w) || 2;
      }
    },
    args: [sVal, eVal, mode, bVal, wVal, xVal, yVal]
  });

  chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ['mango_script.js'], 
    world: "MAIN"
  });
});

// ───────────────────────────────────────────────────────────────
// SSG 자동 재로그인 (실제 동작은 background.js)
// ───────────────────────────────────────────────────────────────
function renderSsgStatus(st) {
  const box = document.getElementById('ssgStatus');
  const btn = document.getElementById('btnSsgStart');
  if (!st) { box.textContent = '상태: 꺼짐'; btn.textContent = 'SSG 로그인 실행'; return; }
  const head = st.running
    ? '상태: 실행 중 (1시간마다 열어 둔 SSG 탭에서 마이페이지 확인)'
    : '상태: 꺼짐';
  const lines = (st.log || []).slice(-3).join('\n');
  box.textContent = lines ? `${head}\n${lines}` : head;
  box.scrollTop = box.scrollHeight;
  btn.textContent = st.running ? 'SSG 로그인 실행 (다시 시작)' : 'SSG 로그인 실행';
}

async function loadSsgState() {
  const r = await chrome.storage.local.get('ssgAuto');
  const st = r.ssgAuto;
  if (st) {
    if (st.id) document.getElementById('ssgId').value = st.id;
    if (st.pw) document.getElementById('ssgPw').value = st.pw;
  }
  renderSsgStatus(st);
}
document.addEventListener('DOMContentLoaded', loadSsgState);

// 백그라운드가 상태를 바꾸면 팝업 표시도 바로 갱신
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.ssgAuto) renderSsgStatus(changes.ssgAuto.newValue);
});

document.getElementById('btnSsgStart').addEventListener('click', async () => {
  const id = document.getElementById('ssgId').value.trim();
  const pw = document.getElementById('ssgPw').value;
  if (!id || !pw) { alert('SSG 아이디와 비밀번호를 입력해주세요.'); return; }

  // 💡 확인은 background.js 가 SSG 탭 하나를 열어 두고(백그라운드) 그 탭에서 한다 → 현재 탭은 건드리지 않음
  chrome.runtime.sendMessage({ type: 'ssg_start', id, pw }); // 표시 갱신은 storage.onChanged 에서
});

document.getElementById('btnSsgStop').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'ssg_stop' });
});
