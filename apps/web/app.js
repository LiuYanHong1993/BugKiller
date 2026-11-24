// 工作流运行器页（办公套件 · 工作流 Tab）
const WF_SAMPLE = JSON.stringify({
  name: '两步示例：调研 → 总结',
  steps: [
    { id: 'research', prompt: '读取工作区 README.md，列出这个项目的三个核心特点（每条一行）。' },
    { id: 'summarize', prompt: '把以下调研结论压缩成一句 50 字以内的推荐语：\n\n${research}', dependsOn: ['research'] },
  ],
}, null, 2);

function renderFlowsPage(listWrap) {
  listWrap.innerHTML =
    `<div class="wf-editor-box">` +
    `<div class="office-sec-t" style="margin-bottom:6px">工作流定义（JSON）</div>` +
    `<textarea id="wfJson" class="wf-json" spellcheck="false" placeholder='{"name":"...","steps":[{"id":"s1","prompt":"..."}]}'></textarea>` +
    `<div style="display:flex;gap:8px;margin-top:8px">` +
    `<button class="pbtn accent" id="wfRun">▶ 运行工作流</button>` +
    `<button class="pbtn" id="wfSample">填入示例</button></div>` +
    `<div id="wfEvents" class="wf-events"></div></div>` +
    `<div class="office-section" style="margin-top:14px"><div class="office-sec-t">运行历史 <span class="dim">data/workflows/</span></div><div id="wfRuns"><div class="pc-empty">加载中…</div></div></div>`;

  const jsonTa = listWrap.querySelector('#wfJson');
  const evBox = listWrap.querySelector('#wfEvents');
  jsonTa.value = WF_SAMPLE;

  listWrap.querySelector('#wfSample').onclick = () => { jsonTa.value = WF_SAMPLE; };

  const drawEvents = (ev) => {
    const row = document.createElement('div');
    row.className = 'wf-ev';
    const t = String(ev.ts || '').slice(11, 19);
    if (ev.type === 'workflow_start') row.innerHTML = `<span class="wf-t">${t}</span><span class="badge b-req">开始</span><span class="s-tx">${esc(ev.name)}（${ev.steps.length} 步）</span>`;
    else if (ev.type === 'step_start') row.innerHTML = `<span class="wf-t">${t}</span><span class="badge b-tool">运行</span><span class="s-tx">${esc(ev.stepId)}</span>`;
    else if (ev.type === 'step_end') row.innerHTML = `<span class="wf-t">${t}</span><span class="badge ${ev.ok ? 'b-req' : 'b-rej'}">${ev.ok ? '✓ 完成' : '✗ 失败'}</span><span class="s-tx">${esc(ev.stepId)} · ${fmtDur(ev.durationMs || 0)}${ev.error ? ' · ' + esc(ev.error) : ''}${ev.output ? ' · ' + esc(truncate(ev.output, 80)) : ''}</span>`;
    else if (ev.type === 'workflow_end') row.innerHTML = `<span class="wf-t">${t}</span><span class="badge ${ev.ok ? 'b-req' : 'b-rej'}">${ev.ok ? '🏁 全部完成' : '🏁 有失败'}</span><span class="s-tx">总用时 ${fmtDur(ev.durationMs || 0)}</span>`;
    evBox.appendChild(row);
    evBox.scrollTop = evBox.scrollHeight;
  };

  listWrap.querySelector('#wfRun').onclick = async () => {
    let def;
    try { def = JSON.parse(jsonTa.value); } catch (e) { alert('JSON 不合法：' + e.message); return; }
    evBox.innerHTML = '';
    const runBtn = listWrap.querySelector('#wfRun');
    runBtn.disabled = true;
    runBtn.textContent = '运行中…';
    try {
      const res = await fetch('/api/workflow/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ json: jsonTa.value, session: state.sessionId || '' }),
      });
      if (!res.ok || !res.body) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `HTTP ${res.status}`);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          let evName = 'message';
          let payload = '';
          for (const line of frame.split('\n')) {
            if (line.startsWith('event:')) evName = line.slice(6).trim();
            else if (line.startsWith('data:')) payload += line.slice(5).trim();
          }
          if (!payload) continue;
          try {
            const data = JSON.parse(payload);
            if (evName === 'wf') drawEvents(data);
            else if (evName === 'error') { const r = document.createElement('div'); r.className = 'msg note err'; r.textContent = '运行失败：' + (data.message || ''); evBox.appendChild(r); }
            else if (evName === 'done') {
              const r = document.createElement('div');
              r.className = 'msg note';
              r.textContent = `🏁 运行结束（runId ${data.runId}）—— 结果已存 data/workflows/${data.runId}/`;
              evBox.appendChild(r);
            }
          } catch { /* 跳过坏帧 */ }
        }
      }
      loadWfRuns();
    } catch (e) {
      const r = document.createElement('div');
      r.className = 'msg note err';
      r.textContent = '连接中断：' + e.message;
      evBox.appendChild(r);
    } finally {
      runBtn.disabled = false;
      runBtn.textContent = '▶ 运行工作流';
    }
  };

  const loadWfRuns = async () => {
    const runsBox = listWrap.querySelector('#wfRuns');
    try {
      const d = await api('/api/workflow/runs');
      runsBox.innerHTML = d.runs.length ? '' : '<div class="pc-empty">还没有运行记录</div>';
      for (const r of d.runs) {
        const row = document.createElement('div');
        row.className = 'prow';
        row.innerHTML =
          `<span class="prow-t">${r.ok === undefined ? '⏳' : r.ok ? '✓' : '✗'} ${esc(String(r.runId))}${r.name ? ' · ' + esc(String(r.name)) : ''}</span>` +
          `<span class="prow-time">${r.durationMs != null ? fmtDur(r.durationMs) : ''}</span>`;
        runsBox.appendChild(row);
      }
    } catch {
      runsBox.innerHTML = '<div class="pc-empty">历史读取失败</div>';
    }
  };
  loadWfRuns();
}