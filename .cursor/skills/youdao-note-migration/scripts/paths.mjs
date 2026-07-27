import { pathToFileURL } from 'node:url';

import { buildMigrationPaths, loadRules } from '../lib/paths.mjs';
import { parseOptions, runAsScript, writeJson } from '../lib/script-utils.mjs';

const COMMAND = 'paths';
const USAGE = 'Usage: paths --category <slug> --topic <slug> --article <slug>';

/**
 * @brief 根据 category/topic/article slug 输出缓存与最终交付路径 JSON。
 * @param {string[]} argv - 脚本参数。
 * @param {object} [context] - 运行上下文。
 * @param {string} [context.repoRoot=process.cwd()] - 仓库根，用于加载规则文件。
 * @param {(text: string) => void} [context.write] - stdout 写入函数。
 * @returns {Promise<void>}
 * @note 只读；slug 非法或规则无效时抛错；失败 stderr 为 `Error: ...` 文本。
 */
export async function main(
  argv,
  {
    repoRoot = process.cwd(),
    write = (value) => process.stdout.write(value),
  } = {},
) {
  const options = parseOptions(argv, {
    valueFlags: ['--category', '--topic', '--article'],
    usage: USAGE,
  });
  const rules = loadRules(repoRoot);
  writeJson(
    write,
    buildMigrationPaths(rules, {
      categorySlug: options['--category'],
      topicSlug: options['--topic'],
      articleSlug: options['--article'],
    }),
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runAsScript(COMMAND, main);
}
