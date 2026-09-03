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
          document.getElementById('divideMode').value = res.m;
          document.getElementById('customBatchRow').style.display = 'none';
      } else {
          document.getElementById('divideMode').value = 'custom';
          document.getElementById('batchSize').value = res.b || 800;
          document.getElementById('customBatchRow').style.display = 'block';
      }
      isRunningInTab = true;
    }

    // 현재 탭에서 실행한 적이 없는 '새 창'이라면, 공통 저장된 마지막 값을 불러옵니다.
    if (!isRunningInTab) {
      if (localStorage.getItem('mango_start')) document.getElementById('startLimit').value = localStorage.getItem('mango_start');
      if (localStorage.getItem('mango_end')) document.getElementById('endLimit').value = localStorage.getItem('mango_end');
      
      if (localStorage.getItem('mango_mode')) {
          const savedMode = localStorage.getItem('mango_mode');
          document.getElementById('divideMode').value = savedMode;
          document.getElementById('customBatchRow').style.display = (savedMode === 'custom') ? 'block' : 'none';
      }
      
      if (localStorage.getItem('mango_batch')) document.getElementById('batchSize').value = localStorage.getItem('mango_batch');
      if (localStorage.getItem('mango_pos')) document.getElementById('posPreset').value = localStorage.getItem('mango_pos');
    }
  });
});

document.getElementById('divideMode').addEventListener('change', (e) => {
  document.getElementById('customBatchRow').style.display = (e.target.value === 'custom') ? 'block' : 'none';
});

document.getElementById('btnRun').addEventListener('click', async () => {
  const sVal = document.getElementById('startLimit').value;
  const eVal = document.getElementById('endLimit').value;
  const mode = document.getElementById('divideMode').value;
  const bVal = document.getElementById('batchSize').value;
  const xVal = document.getElementById('posPreset').value; 
  const yVal = 0; 

  localStorage.setItem('mango_start', sVal);
  localStorage.setItem('mango_end', eVal);
  localStorage.setItem('mango_mode', mode);
  localStorage.setItem('mango_batch', bVal);
  localStorage.setItem('mango_pos', xVal);

  let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: "MAIN",
    func: (s, e, mode, b, x, y) => {
      window.__MANGO_START = parseInt(s) || 1;
      window.__MANGO_END = e ? parseInt(e) : null;
      // 기존 1700 오류 방지 수정
      window.__MANGO_START_X = (x !== "" && x !== null) ? parseInt(x) : 1250; // 이왕이면 1700 대신 새 기본값 1250으로!
      window.__MANGO_START_Y = y;
      
      if (mode === 'custom') {  // 👈 이 줄이 지워져 있어서 다시 추가해야 합니다!
          window.__MANGO_BATCH = parseInt(b) || 800;
          window.__MANGO_DIVIDE = null;
      } else {
          window.__MANGO_BATCH = null;
          window.__MANGO_DIVIDE = parseInt(mode); 
      }
    },
    args: [sVal, eVal, mode, bVal, xVal, yVal]
  });

  chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ['mango_script.js'], 
    world: "MAIN"
  });
});