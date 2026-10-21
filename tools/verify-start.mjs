// 校验启动器文件的完整性与编码
// 存在的意义：这类脚本坏了通常只表现为「双击没反应」，看不出原因。
import { readFileSync, existsSync } from 'node:fs';
import { projectPath } from './paths.mjs';

const files = [
  { name: '启动.cmd', mustBeAscii: true },
  { name: '启动-简易版.cmd', mustBeAscii: true },
  { name: 'start.ps1', mustBeAscii: true },
];

let problems = 0;

for (const { name, mustBeAscii } of files) {
  const p = projectPath(name);
  if (!existsSync(p)) {
    console.log(`· ${name}: 不存在（可选文件）`);
    continue;
  }
  const raw = readFileSync(p);
  const text = raw.toString('utf8');
  const nonAscii = [...raw].filter((b) => b > 127).length;
  const hasBom = raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
  const hasCrlf = text.includes('\r\n');

  const issues = [];
  if (mustBeAscii && nonAscii > 0) issues.push(`含 ${nonAscii} 个非 ASCII 字节（cmd/PS5.1 会读乱）`);
  if (hasBom) issues.push('带 BOM');
  if (!hasCrlf && name.endsWith('.cmd')) issues.push('换行是 LF（老式 cmd 对 LF 批处理不友好）');

  if (issues.length) {
    problems += issues.length;
    console.log(`✗ ${name}: ${issues.join('; ')}`);
  } else {
    console.log(`✓ ${name}: ${raw.length} 字节，纯 ASCII，CRLF=${hasCrlf}`);
  }
}

// start.ps1 里必须能解析出关键逻辑，避免拿到一个半截文件
const ps1 = projectPath('start.ps1');
if (existsSync(ps1)) {
  const s = readFileSync(ps1, 'utf8');
  for (const needle of ['param(', 'Test-ServerAt', 'server.mjs', 'Start-Process']) {
    if (!s.includes(needle)) {
      console.log(`✗ start.ps1 缺少关键片段: ${needle}`);
      problems++;
    }
  }
}

// server.mjs 的关闭接口是 stop.mjs 的前提
const server = readFileSync(projectPath('server.mjs'), 'utf8');
for (const needle of ['/api/shutdown', 'SHUTDOWN_TOKEN', '--port']) {
  if (!server.includes(needle)) {
    console.log(`✗ server.mjs 缺少关键片段: ${needle}`);
    problems++;
  }
}
console.log(problems ? `\n发现 ${problems} 处问题` : '\n启动器文件检查通过');
