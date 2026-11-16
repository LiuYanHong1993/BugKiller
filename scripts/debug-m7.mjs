// M7 新能力端到端验证：todo 计划 → run_command → web_fetch → 自动标题
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const log = readFileSync(join(process.cwd(), 'dist', 'agent-platform-0.1.0', 'data', 'client.log'), 'utf8');
const urls = [...log.matchAll(/http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]+/g)];
const url = urls[urls.length - 1][0];
const base = url.split('/?')[0];
const tok = url.split('token=')[1];

const s = await (await fetch(`${base}/api/sessions`, {
  method: 'POST',
  headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
  body: JSON.stringify({ title: '新会话' }),
})).json();
console.log('会话:', s.id);

const task =
  '请严格按以下步骤执行：1) 先用 todo_write 建立三项计划：[查系统时间(run_command), 抓取 example.com(web_fetch), 汇报结果]；' +
  '2) 用 run_command 执行 Get-Date；3) 用 web_fetch 抓取 https://example.com；' +
  '4) 用 todo_write 把全部三项标为 completed；5) 简短汇报三步结果。';

const res = await fetch(`${base}/api/sessions/${s.id}/turns/stream`, {
  method: 'POST',
  headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
  body: JSON.stringify({ text: task }),
});
console.log('HTTP', res.status);

const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = '';
let deltas = 0;
let tools = 0;
let approvals = 0;
let done = false;
let reply = '';
const t0 = Date.now();
const seen = new Set();

for (;;) {
  const { done: rd, value } = await reader.read();
  if (rd) break;
  buf += dec.decode(value, { stream: true });
  let i;
  while ((i = buf.indexOf('\n\n')) >= 0) {
    const frame = buf.slice(0, i);
    buf = buf.slice(i + 2);
    const ev = (frame.match(/event: (.+)/) || [])[1];
    const d = (frame.match(/data: (.+)/) || [])[1];
    if (!ev || !d) continue;
    let data;
    try { data = JSON.parse(d); } catch { continue; }
    if (ev === 'delta') { deltas += 1; reply += data.text ?? ''; }
    else if (ev === 'tool_call') { tools += 1; if (!seen.has(data.name)) { seen.add(data.name); } console.log(`  ⚙ ${data.name} @${Date.now() - t0}ms`); }
    else if (ev === 'approval_request') {
      approvals += 1;
      console.log(`  ⏸ 审批：${data.detail?.slice?.(0, 50) ?? data.tool} @${Date.now() - t0}ms → 自动放行`);
      await fetch(`${base}/api/approvals/${data.approvalId}/decision`, {
        method: 'POST',
        headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
        body: JSON.stringify({ approved: true }),
      });
    }
    else if (ev === 'done') { done = true; }
  }
}

console.log(`\ndelta=${deltas} 工具调用=${tools}(${[...seen].join('/')}) 审批=${approvals} done=${done} 用时=${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log('回复片段:', reply.replace(/\n+/g, ' | ').slice(0, 200));

await new Promise((r) => setTimeout(r, 4000)); // 等自动标题
const list = await (await fetch(`${base}/api/sessions`, { headers: { authorization: `Bearer ${tok}` } })).json();
const mine = list.sessions.find((x) => x.id === s.id);
console.log('自动标题:', JSON.stringify(mine?.title));

const todos = await (await fetch(`${base}/api/todos/${s.id}`, { headers: { authorization: `Bearer ${tok}` } })).json();
console.log('todo 清单:', todos.items.map((x) => `${x.status === 'completed' ? '✓' : '○'}${x.text.slice(0, 14)}`).join(' '));
