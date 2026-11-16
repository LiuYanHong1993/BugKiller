// 更新校验器（M4）：摘要 + 签名双校验，哈希清单 + 签名双校验的更新安全模型
// 校验顺序：先验 manifest 签名（Ed25519），再逐文件 sha256 + size —— 两关全过才算合法更新

import { createHash, sign, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface UpdateFileEntry {
  path: string;
  sha256: string;
  size: number;
}

export interface UpdateManifest {
  version: string;
  files: UpdateFileEntry[];
  /** 对 canonical({version, files}) 的 Ed25519 签名（base64） */
  signature: string;
}

export type ManifestForSigning = Omit<UpdateManifest, 'signature'>;

function canonical(m: ManifestForSigning): Buffer {
  // 签名载体固定为 {version, files}，键序即构造序，双端一致
  return Buffer.from(JSON.stringify({ version: m.version, files: m.files }), 'utf8');
}

export function signManifest(m: ManifestForSigning, privateKeyPem: string): string {
  return sign(null, canonical(m), privateKeyPem).toString('base64');
}

export async function sha256File(fullPath: string): Promise<{ sha256: string; size: number }> {
  const buf = await readFile(fullPath);
  return { sha256: createHash('sha256').update(buf).digest('hex'), size: buf.length };
}

export interface VerifyResult {
  ok: boolean;
  problems: string[];
}

export async function verifyUpdate(
  dir: string,
  manifest: UpdateManifest,
  publicKeyPem: string,
): Promise<VerifyResult> {
  const problems: string[] = [];

  // 第一关：manifest 签名（防清单被篡改）
  const sigOk = verify(
    null,
    canonical({ version: manifest.version, files: manifest.files }),
    publicKeyPem,
    Buffer.from(manifest.signature, 'base64'),
  );
  if (!sigOk) {
    return { ok: false, problems: ['manifest 签名校验失败'] };
  }

  // 第二关：逐文件摘要 + 大小
  for (const f of manifest.files) {
    let buf: Buffer;
    try {
      buf = await readFile(join(dir, f.path));
    } catch {
      problems.push(`缺少文件：${f.path}`);
      continue;
    }
    if (buf.length !== f.size) {
      problems.push(`大小不符：${f.path}（期望 ${f.size}，实际 ${buf.length}）`);
      continue;
    }
    const digest = createHash('sha256').update(buf).digest('hex');
    if (digest !== f.sha256.toLowerCase()) {
      problems.push(`摘要不符：${f.path}`);
    }
  }

  return { ok: problems.length === 0, problems };
}
