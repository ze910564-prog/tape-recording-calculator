// 工具脚本共用的小函数

import { join } from 'node:path';

/**
 * 项目根目录。
 *
 * 用 process.cwd() 而不是从 import.meta.url 反推 —— 后者经 URL 编码后，中文目录名会变成
 * %E5%BD%95... 这类打不开的路径。约定：所有工具脚本都从项目根目录运行（node tools/xxx.mjs）。
 */
export function projectRoot() {
  return process.cwd();
}

/** 项目内的某个路径 */
export function projectPath(...parts) {
  return join(projectRoot(), ...parts);
}
