// 部署 CLI（M5）：生成/执行事务式部署计划
//   node --strip deploy/src/cli.ts --plan <dir>            # 打印发布清单 + 命令序列（dry-run，默认）
//   node --strip deploy/src/cli.ts --deploy <dir> --host h --user u [--port 22] [--health URL]
// 部署流程：上传 release → 原子切换 current → 健康检查 → 失败自动回滚 previous

import { resolve } from 'node:path';
import {
  buildHealthCheckCommand,
  buildReleaseManifest,
  buildRollbackCommands,
  buildSwitchCommands,
} from './plan.ts';
import { sshRun, sshUploadDir } from './ssh.ts';
import type { SshTarget } from './ssh.ts';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const planDir = arg('--plan');
  const deployDir = arg('--deploy');
  if (!planDir && !deployDir) {
    console.error('用法：--plan <目录>（dry-run）或 --deploy <目录> --host <host> --user <user> [--port 22] [--health http://.../health]');
    process.exit(2);
  }

  const dir = resolve(planDir ?? deployDir!);
  const manifest = await buildReleaseManifest(dir);
  console.log(`发布版本 ${manifest.version}，文件 ${manifest.files.length} 个：`);
  for (const f of manifest.files.slice(0, 20)) {
    console.log(`  ${f.rel}  ${f.size}B  ${f.sha256.slice(0, 12)}…`);
  }
  if (manifest.files.length > 20) console.log(`  …共 ${manifest.files.length} 个`);

  const cmds = buildSwitchCommands({
    releasesDir: '/srv/myagent/releases',
    currentLink: '/srv/myagent/current',
    previousLink: '/srv/myagent/previous',
    version: manifest.version,
  });
  console.log('\n切换命令（事务式）：');
  for (const c of cmds) console.log(`  $ ${c}`);
  console.log('\n回滚命令：');
  for (const c of buildRollbackCommands({ releasesDir: '/srv/myagent/releases', currentLink: '/srv/myagent/current', previousLink: '/srv/myagent/previous' })) {
    console.log(`  $ ${c}`);
  }

  if (!deployDir) {
    console.log('\n(dry-run 结束 —— 加 --deploy --host --user 实际执行)');
    return;
  }

  const host = arg('--host');
  const user = arg('--user');
  if (!host || !user) {
    console.error('--deploy 需要 --host 与 --user');
    process.exit(2);
  }
  const target: SshTarget = { host, user, port: Number(arg('--port') ?? 22) || 22 };
  const health = arg('--health');

  console.log(`\n[1/3] 上传 release → ${target.host}`);
  const up = sshUploadDir(target, dir, `/srv/myagent/releases/${manifest.version}`);
  if (!up.ok) {
    console.error(`上传失败：${up.stderr || up.stdout}`);
    process.exit(1);
  }

  console.log('[2/3] 原子切换');
  for (const c of cmds) {
    const r = sshRun(target, c);
    if (!r.ok) {
      console.error(`切换失败：${c}\n${r.stderr}`);
      process.exit(1);
    }
  }

  if (health) {
    console.log('[3/3] 健康检查');
    const hc = sshRun(target, buildHealthCheckCommand(health));
    if (!hc.ok) {
      console.error('健康检查失败 —— 自动回滚到 previous');
      for (const c of buildRollbackCommands({ releasesDir: '/srv/myagent/releases', currentLink: '/srv/myagent/current', previousLink: '/srv/myagent/previous' })) {
        const r = sshRun(target, c);
        if (!r.ok) console.error(`回滚命令失败：${c}\n${r.stderr}`);
      }
      process.exit(1);
    }
  } else {
    console.log('[3/3] 未配置 --health，跳过健康检查');
  }

  console.log(`\n部署完成：${manifest.version}`);
}

main().catch((e) => {
  console.error('[fatal]', e instanceof Error ? e.message : e);
  process.exit(1);
});
