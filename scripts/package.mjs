// 打包脚本（M5+）：构建带签名的 Windows 安装包
//   node scripts/package.mjs
// 产物：dist/agent-platform-<version>.zip + dist/manifest.json
// 安全模型：
//   - 私钥 keys/package-key.pem 只留在构建机（绝不进包）
//   - 公钥注入随包的 verify-package.mjs，安装器安装前先验签名 + 全量 sha256
//   - 私钥丢失 = 无法再签同源更新（与真实发布流程一致）

'use strict';

import { generateKeyPairSync, createHash, sign } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, copyFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const version = pkg.version;
const distDir = join(repoRoot, 'dist');
const keysDir = join(repoRoot, 'keys');
const stageRoot = join(distDir, `agent-platform-${version}`);
const zipPath = join(distDir, `agent-platform-${version}.zip`);

// ---- 1. 密钥：没有则生成（Ed25519） ----
mkdirSync(keysDir, { recursive: true });
const privPemFile = join(keysDir, 'package-key.pem');
const pubPemFile = join(keysDir, 'package-key.pub.pem');
if (!existsSync(privPemFile)) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  writeFileSync(privPemFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), 'utf8');
  writeFileSync(pubPemFile, publicKey.export({ type: 'spki', format: 'pem' }), 'utf8');
  console.log('[package] 已生成新的发布密钥对 → keys/（私钥务必保密，勿入安装包）');
}
const privPem = readFileSync(privPemFile, 'utf8');
const pubPem = readFileSync(pubPemFile, 'utf8');

const TOP_ITEMS = [
  'kernel', 'apps', 'workflow', 'deploy', 'plugins', 'policy', 'scripts', 'docs', 'install',
  'package.json', 'tsconfig.json', 'README.md',
];
const IGNORE = new Set(['node_modules', 'data', 'dist', 'keys', '.git', 'notes']);
const IGNORE_FILES = /\.log$|\.pem$|\.pub\.pem$/;

function copyTree(src, dest, opts = {}) {
  mkdirSync(dest, { recursive: true });
  for (const name of readdirSync(src)) {
    if (IGNORE.has(name)) continue;
    const s = join(src, name);
    const d = join(dest, name);
    const st = statSync(s);
    if (st.isDirectory()) copyTree(s, d, opts);
    else {
      if (IGNORE_FILES.test(name)) continue;
      try {
        copyFileSync(s, d);
      } catch (e) {
        if (!opts.tolerant) throw e;
        // 容错模式（备份/还原用户数据）：跳过被锁的文件（如 WebView2 运行缓存）
      }
    }
  }
}

// ---- 2. 暂存目录（干净树：先清掉上次构建残留；stage data/ 是便携用户数据，先备份后还原） ----
const dataBackup = join(distDir, '.data-backup');
if (existsSync(dataBackup)) rmSync(dataBackup, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
if (existsSync(stageRoot)) {
  const prevData = join(stageRoot, 'data');
  if (existsSync(prevData)) {
    rmSync(dataBackup, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    copyTree(prevData, dataBackup, { tolerant: true });
    // WebView2 浏览缓存：运行中的客户端会锁文件（EBUSY）→ 备份/还原都排除，客户端自动重建
    rmSync(join(dataBackup, 'webview2-profile'), { recursive: true, force: true });
  }
  rmSync(stageRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
mkdirSync(stageRoot, { recursive: true });

for (const item of TOP_ITEMS) {
  const src = join(repoRoot, item);
  if (!existsSync(src)) continue;
  const st = statSync(src);
  if (st.isDirectory()) copyTree(src, join(stageRoot, item));
  else copyFileSync(src, join(stageRoot, item));
}

// ---- 3. 编译原生 Windows 客户端（系统 csc，零下载；WebView2 程序集在 client/webview2/） ----
const cscCandidates = [
  'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
  'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe',
];
let csc = null;
for (const c of cscCandidates) {
  if (existsSync(c)) { csc = c; break; }
}
if (csc) {
  const wv2Dir = join(repoRoot, 'client', 'webview2');
  const hasWv2 = existsSync(join(wv2Dir, 'Microsoft.Web.WebView2.WinForms.dll'));
  const csArgs = [
    '/nologo', '/target:winexe', '/platform:x64',
    `/out:${join(repoRoot, 'client', 'agent-platform.exe')}`,
  ];
  const icoFile = join(repoRoot, 'client', 'app.ico');
  if (existsSync(icoFile)) csArgs.push(`/win32icon:${icoFile}`);
  if (hasWv2) csArgs.push('/define:WEBVIEW2');
  csArgs.push('/r:System.Windows.Forms.dll', '/r:System.Drawing.dll', '/r:System.Core.dll');
  if (hasWv2) {
    csArgs.push(
      `/r:${join(wv2Dir, 'Microsoft.Web.WebView2.Core.dll')}`,
      `/r:${join(wv2Dir, 'Microsoft.Web.WebView2.WinForms.dll')}`,
    );
  }
  csArgs.push(join(repoRoot, 'client', 'client.cs'));
  const cc = spawnSync(csc, csArgs, { encoding: 'utf8' });
  if (cc.status !== 0) {
    console.error(String(cc.stdout ?? '') + String(cc.stderr ?? ''));
    console.error('[package] 客户端编译失败，中止打包');
    process.exit(1);
  }
  console.log('[package] 客户端已编译：agent-platform.exe' + (hasWv2 ? '（WebView2 内嵌）' : '（浏览器回退模式）'));
  if (hasWv2) copyTree(wv2Dir, join(stageRoot, 'webview2'));
  copyFileSync(join(repoRoot, 'client', 'agent-platform.exe'), join(stageRoot, 'agent-platform.exe'));
  copyFileSync(join(repoRoot, 'client', 'client.cs'), join(stageRoot, 'client.cs'));
} else {
  console.error('[package] 警告：未找到系统 csc，本包将不含原生客户端 exe');
}

// ---- 4. 安装器放到包根目录（用户解压后直接可见）；PS 5.1 读无 BOM 的 UTF-8 会当 ANSI，
//         中文注释直接变乱码 → 统一补 BOM ----
function copyPs1WithBom(src, dest) {
  const text = readFileSync(src, 'utf8');
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  writeFileSync(dest, '\uFEFF' + body, 'utf8');
}
for (const f of ['install.ps1', 'uninstall.ps1']) {
  copyPs1WithBom(join(repoRoot, 'install', f), join(stageRoot, f));
  copyPs1WithBom(join(repoRoot, 'install', f), join(stageRoot, 'install', f));
}

// ---- 5. 注入公钥到校验器（随包分发的那份） ----
const verifySrc = readFileSync(join(repoRoot, 'scripts', 'verify-package.mjs'), 'utf8');
writeFileSync(
  join(stageRoot, 'scripts', 'verify-package.mjs'),
  verifySrc.replace('__PACKAGE_PUBKEY__', () => pubPem.replaceAll('$', '$$')),
  'utf8',
);

// ---- 6. 生成 manifest + 签名（覆盖暂存树全部文件） ----
const files = [];
function hashTree(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) hashTree(full);
    else {
      const buf = readFileSync(full);
      files.push({
        rel: relative(stageRoot, full).split('\\').join('/'),
        sha256: createHash('sha256').update(buf).digest('hex'),
        size: buf.length,
      });
    }
  }
}
hashTree(stageRoot);
files.sort((a, b) => (a.rel < b.rel ? -1 : 1));

const manifest = { version, createdAt: new Date().toISOString(), files, signature: '' };
manifest.signature = sign(
  null,
  Buffer.from(JSON.stringify({ version: manifest.version, files: manifest.files }), 'utf8'),
  privPem,
).toString('base64');
writeFileSync(join(stageRoot, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

// ---- 7. 自检：用暂存树里的校验器验一遍 ----
const selfCheck = spawnSync(process.execPath, [join(stageRoot, 'scripts', 'verify-package.mjs'), stageRoot], {
  encoding: 'utf8',
});
if (selfCheck.status !== 0) {
  console.error(String(selfCheck.stdout ?? '') + String(selfCheck.stderr ?? ''));
  console.error('[package] 自检失败，中止打包');
  process.exit(1);
}
console.log(String(selfCheck.stdout).trim());

// ---- 8. zip（Compress-Archive） ----
if (existsSync(zipPath)) rmSync(zipPath, { force: true });
const ps = `Compress-Archive -Path '${stageRoot.replaceAll("'", "''")}' -DestinationPath '${zipPath.replaceAll("'", "''")}' -Force`;
const zip = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true });
if (zip.status !== 0 || !existsSync(zipPath)) {
  console.error(`[package] 压缩失败：${String(zip.stderr ?? '').slice(0, 300)}`);
  process.exit(1);
}

const zipSize = statSync(zipPath).size;
console.log(`[package] 完成：${zipPath}（${(zipSize / 1024).toFixed(1)} KiB，${files.length} 个文件，v${version}）`);
console.log('[package] 安装：解压后运行 install.ps1（安装前自动验签）');

// ---- 8. 还原便携用户数据（会话/设置/todos —— zip 不含它们，但运行中的客户端需要） ----
if (existsSync(dataBackup)) {
  copyTree(dataBackup, join(stageRoot, 'data'), { tolerant: true });
  rmSync(dataBackup, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  console.log('[package] 便携用户数据已还原到 stage');
}
