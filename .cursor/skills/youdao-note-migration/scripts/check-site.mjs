import { pathToFileURL } from 'node:url';

import { checkSite, runProcess } from '../lib/quality-gates.mjs';
import { runAsScript, writeJson } from '../lib/script-utils.mjs';

const COMMAND = 'check-site';

/**
 * @brief 以固定生产参数运行 Hugo 构建做站点级门禁。
 * @param {string[]} argv - 脚本参数，必须为空。
 * @param {object} [context] - 运行上下文。
 * @param {string} [context.repoRoot=process.cwd()] - 仓库根目录。
 * @param {(text: string) => void} [context.write] - stdout 写入函数。
 * @param {object} [context.dependencies] - 可注入 `runProcess`。
 * @returns {Promise<void>}
 * @note 任意额外参数视为 usage 错误；失败 stderr 为含 `command: check-site` 的安全 JSON。
 */
export async function main(
  argv,
  {
    repoRoot = process.cwd(),
    write = (value) => process.stdout.write(value),
    dependencies = {},
  } = {},
) {
  if (argv.length !== 0) {
    throw new Error('Usage: check-site');
  }
  writeJson(
    write,
    await checkSite({ repoRoot, run: dependencies.runProcess ?? runProcess }),
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runAsScript(COMMAND, main);
}
