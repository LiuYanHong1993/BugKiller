// 生成 apps/web/icons.js —— 从 iconify Lucide 批量数据内联（离线可用、同风格线条）
import { readFileSync, writeFileSync } from 'node:fs';
const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const batch = JSON.parse(readFileSync(ROOT + '/scripts/lucide-icons.json', 'utf8').replace(/^\uFEFF/, ''));

const NAMES = [
  'message-square-plus', 'folder-kanban', 'briefcase', 'folder-tree', 'bot',
  'archive', 'search', 'list-filter', 'trash-2', 'pin', 'ellipsis',
  'plus', 'shield-check', 'sliders-horizontal', 'arrow-up',
  'copy', 'pencil', 'quote', 'refresh-cw', 'undo-2',
  'users', 'wrench', 'plug', 'book-open', 'folder', 'x',
  'chevron-down', 'chevron-right', 'chevron-up', 'circle-check', 'corner-down-left',
  'file-text', 'save', 'external-link', 'download', 'upload',
  'sparkles', 'brain', 'zap', 'bar-chart-3', 'notebook-pen', 'globe',
  'scale', 'package', 'history', 'message-square', 'activity', 'database',
  'terminal', 'git-branch', 'shield', 'key', 'settings',
];

function bodyOf(name) {
  const direct = batch.icons && batch.icons[name];
  if (direct) return direct.body;
  const alias = batch.aliases && batch.aliases[name];
  if (alias && batch.icons && batch.icons[alias.parent]) return batch.icons[alias.parent].body;
  return null;
}

const camel = (s) => s.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
const map = {};
const missing = [];
for (const name of NAMES) {
  const body = bodyOf(name);
  if (!body) { missing.push(name); continue; }
  map[camel(name)] = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
}

const lines = ['// 图标集：Lucide（经 iconify 提取，内联离线使用）', 'window.ICONS = {'];
for (const [k, v] of Object.entries(map)) lines.push(`  ${JSON.stringify(k)}: ${JSON.stringify(v)},`);
lines.push('};', '', '/** 取图标 SVG；size 覆盖宽高；cls 追加 class */',
  'function icon(name, size, cls) {',
  '  let s = (window.ICONS && window.ICONS[name]) || "";',
  '  if (!s) return "";',
  '  if (size) s = s.replace(/width="\\d+" height="\\d+"/, `width="${size}" height="${size}"`);',
  '  if (cls) s = s.replace("<svg ", `<svg class="${cls}" `);',
  '  return s;',
  '}', '');
writeFileSync(ROOT + '/apps/web/icons.js', lines.join('\n'), 'utf8');
console.log(`生成 icons.js：${Object.keys(map).length} 个图标`);
if (missing.length) console.log('缺失:', missing.join(', '));