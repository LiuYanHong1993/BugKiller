// 行级 diff（LCS）：write_file 的 +N −R 摘要与差异文本

export interface LineDiffResult {
  added: number;
  removed: number;
  text: string; // 仅增删行，'+'/'-' 前缀；超长截断
}

const MAX_DP = 1_000_000; // a.len*b.len 上限，超过则退化为计数
const MAX_TEXT_LINES = 300;

export function lineDiff(oldText: string, newText: string): LineDiffResult {
  const a = oldText.split('\n');
  const b = newText.split('\n');

  if (a.length * b.length > MAX_DP) {
    const added = Math.max(0, b.length - a.length);
    const removed = Math.max(0, a.length - b.length);
    return { added, removed, text: `(大文件差异省略：+${added} −${removed})` };
  }

  const n = a.length;
  const m = b.length;
  // dp[i][j] = a[i..] 与 b[j..] 的最长公共子序列长度
  const dp: Uint32Array[] = new Array(n + 1);
  for (let i = 0; i <= n; i++) dp[i] = new Uint32Array(m + 1);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }

  const ops: Array<{ t: '+' | '-' | ' '; s: string }> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ t: ' ', s: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ t: '-', s: a[i]! });
      i++;
    } else {
      ops.push({ t: '+', s: b[j]! });
      j++;
    }
  }
  while (i < n) ops.push({ t: '-', s: a[i++]! });
  while (j < m) ops.push({ t: '+', s: b[j++]! });

  const added = ops.filter((o) => o.t === '+').length;
  const removed = ops.filter((o) => o.t === '-').length;

  const changed = ops.filter((o) => o.t !== ' ');
  const shown = changed.slice(0, MAX_TEXT_LINES);
  let text = shown.map((o) => `${o.t} ${o.s}`).join('\n');
  if (changed.length > MAX_TEXT_LINES) text += `\n…(其余 ${changed.length - MAX_TEXT_LINES} 行省略)`;
  return { added, removed, text: text || '(无变化)' };
}
