// 内核日志环形缓冲（供 /api/logs 查看；stdout 输出保持不变）
const ring: string[] = [];
const MAX = 600;

export function logLine(line: string): void {
  const ts = new Date().toISOString().slice(11, 23);
  ring.push(`${ts} ${line}`);
  if (ring.length > MAX) ring.shift();
}

export function logTail(n = 400): string[] {
  return ring.slice(-n);
}

export function logClear(): void {
  ring.length = 0;
}