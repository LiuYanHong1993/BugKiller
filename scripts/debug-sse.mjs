// SSE 调试脚本（临时）：读 client.log 拿最新 URL → 建会话 → 流式请求 → 打帧
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const log = readFileSync(join(process.cwd(), 'dist', 'agent-platform-0.1.0', 'data', 'client.log'), 'utf8');
const urls = [...log.matchAll(/http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]+/g)];
const url = urls[urls.length - 1][0];
const base = url.split('/?')[0];
const tok = url.split('token=')[1];
console.log('URL:', url);

const s = await (await fetch(`${base}/api/sessions`, {
  method: 'POST',
  headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
  body: JSON.stringify({ title: 'SSE调试' }),
})).json();
console.log('会话:', s.id);

const res = await fetch(`${base}/api/sessions/${s.id}/turns/stream`, {
  method: 'POST',
  headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
  body: JSON.stringify({ text: '只回复：好' }),
});
console.log('HTTP', res.status, '| CT:', res.headers.get('content-type'));

const reader = res.body.getReader();
const dec = new TextDecoder();
let n = 0;
const t0 = Date.now();
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  n += 1;
  console.log(`帧${n} @${Date.now() - t0}ms:`, dec.decode(value).replace(/\n/g, '|').slice(0, 140));
}
console.log('总帧数:', n);

const t2 = readFileSync(join(process.cwd(), 'dist', 'agent-platform-0.1.0', 'data', 'client.log'), 'utf8');
console.log('--- stream 桩日志 ---');
console.log(t2.split('\n').filter((l) => l.includes('[stream]')).join('\n') || '(无)');
