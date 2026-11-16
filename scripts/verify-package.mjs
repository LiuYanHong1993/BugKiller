// 安装包校验器（随包分发）：Ed25519 签名（公钥构建时注入）+ 逐文件 sha256 双校验
// 对照智作「哈希清单 + 签名双校验」的更新安全模型；任何一关不过 → 退出码 1（fail-closed）

'use strict';

import { createHash, verify } from 'node:crypto';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBKEY_PEM = `__PACKAGE_PUBKEY__`;
const here = fileURLToPath(new URL('.', import.meta.url));
const root = resolve(process.argv[2] ?? join(here, '..'));

const manifestFile = join(root, 'manifest.json');
if (!existsSync(manifestFile)) {
  console.error(`[verify] 缺少 manifest.json：${manifestFile}`);
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));

// ---- 第一关：签名 ----
const payload = Buffer.from(JSON.stringify({ version: manifest.version, files: manifest.files }), 'utf8');
const sigOk = verify(null, payload, PUBKEY_PEM, Buffer.from(manifest.signature, 'base64'));
if (!sigOk) {
  console.error('[verify] manifest 签名校验失败 —— 安装包来源不可信，拒绝安装');
  process.exit(1);
}

// ---- 第二关：逐文件摘要 + 大小 ----
const problems = [];
for (const f of manifest.files) {
  const full = join(root, f.rel);
  if (!existsSync(full)) {
    problems.push(`缺少文件：${f.rel}`);
    continue;
  }
  const size = statSync(full).size;
  if (size !== f.size) {
    problems.push(`大小不符：${f.rel}（期望 ${f.size}，实际 ${size}）`);
    continue;
  }
  const digest = createHash('sha256').update(readFileSync(full)).digest('hex');
  if (digest !== f.sha256) problems.push(`摘要不符：${f.rel}`);
}

if (problems.length > 0) {
  console.error(`[verify] 安装包不完整（${problems.length} 个问题）：`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(`[verify] 安装包校验通过：v${manifest.version}，${manifest.files.length} 个文件，签名与摘要全部匹配`);
process.exit(0);
