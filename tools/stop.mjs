// 停止后台运行的服务
//
// 主路径是 HTTP：服务把自己的端口和关闭口令写在 .cache/config.json 里，
// 这里读出来直接请求它退出。纯 Node 实现，不依赖 netstat / taskkill，
// 因此在禁止执行外部程序的环境里也能工作。
//
// netstat 那条路只作为兜底（config 丢失、或服务是旧版本启动的）。

import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { projectPath } from './paths.mjs';

const CONFIG = projectPath('.cache', 'config.json');

async function readConfig() {
  try {
    return JSON.parse(await readFile(CONFIG, 'utf8'));
  } catch {
    return null;
  }
}

/** 确认这个端口上跑的是本工具，而不是别的什么服务 */
async function probe(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return false;
    const data = await res.json();
    return Boolean(data?.config?.tape && data?.library);
  } catch {
    return false;
  }
}

const cfg = await readConfig();
const candidates = new Set();
if (cfg?.port) candidates.add(Number(cfg.port));
if (process.env.PORT) candidates.add(Number(process.env.PORT));
candidates.add(7788);
for (let p = 7789; p <= 7800; p++) candidates.add(p);

let stopped = 0;

// ── 主路径：带口令的关闭请求 ────────────────────────────────────────────────
for (const port of candidates) {
  if (!(await probe(port))) continue;

  if (cfg?.token) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/shutdown`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: cfg.token }),
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        console.log(`已请求端口 ${port} 上的服务退出`);
        stopped++;
        continue;
      }
      console.log(`端口 ${port} 拒绝了口令（HTTP ${res.status}），改用信号方式`);
    } catch {
      // 服务可能在响应前就退出了，这本身也说明停成功了
      console.log(`端口 ${port} 上的服务已无响应（多半已退出）`);
      stopped++;
      continue;
    }
  }

  // ── 兜底：找不到口令时用 netstat + 信号 ──────────────────────────────────
  const pid = findPidByPort(port);
  if (pid) {
    try {
      process.kill(pid, 'SIGTERM');
      console.log(`已向端口 ${port} 的进程（PID ${pid}）发送终止信号`);
      stopped++;
    } catch (e) {
      console.log(`停止 PID ${pid} 失败：${e.message}`);
    }
  } else {
    console.log(`端口 ${port} 上确认是本工具，但拿不到它的 PID（netstat 不可用？）`);
    console.log('可以直接关掉那个服务窗口来停止它。');
  }
}

function findPidByPort(port) {
  try {
    const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true });
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/);
      if (m && Number(m[1]) === port) return Number(m[2]);
    }
  } catch {
    /* 受限环境里 netstat 可能不允许执行，忽略 */
  }
  return null;
}

if (!stopped) {
  console.log('没有找到正在运行的服务。');
}
