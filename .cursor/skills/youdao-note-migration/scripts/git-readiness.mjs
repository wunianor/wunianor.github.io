import { pathToFileURL } from 'node:url';

import { buildMigrationPaths, loadRules } from '../lib/paths.mjs';
import { checkGitReadiness, runProcess } from '../lib/quality-gates.mjs';
import { parseOptions, resolveRelativePath, runAsScript, writeJson } from '../lib/script-utils.mjs';

const COMMAND = 'git-readiness';
const USAGE =
  'Usage: git-readiness --category <slug> --topic <slug> --article <slug> [--allow <relative-path> ...]';

/**
 * @brief 检查 Git 分支、变更路径与白空间门禁是否允许提交该文章交付物。
 * @param {string[]} argv - 脚本参数。
 * @param {object} [context] - 运行上下文。
 * @param {string} [context.repoRoot=process.cwd()] - 仓库根目录。
 * @param {(text: string) => void} [context.write] - stdout 写入函数。
 * @param {object} [context.dependencies] - 可注入 `runProcess` 以模拟 git 输出。
 * @returns {Promise<void>}
 * @note `--allow` 可重复；`.tmp` 变更不得通过 allow 放行；失败 stderr 为含 `command: git-readiness` 的安全 JSON。
 */
export async function main(
  argv,
  {
    repoRoot = process.cwd(),
    write = (value) => process.stdout.write(value),
    dependencies = {},
  } = {},
) {
  const options = parseOptions(argv, {
    valueFlags: ['--category', '--topic', '--article'],
    repeatableValueFlags: ['--allow'],
    usage: USAGE,
  });
  const rules = loadRules(repoRoot);
  const paths = buildMigrationPaths(rules, {
    categorySlug: options['--category'],
    topicSlug: options['--topic'],
    articleSlug: options['--article'],
  });
  const explicitAllowPaths = new Set(
    (options['--allow'] ?? []).map((allowPath) =>
      resolveRelativePath(repoRoot, allowPath, 'allow'),
    ),
  );
  writeJson(
    write,
    await checkGitReadiness({
      repoRoot,
      categorySlug: options['--category'],
      topicSlug: options['--topic'],
      articleSlug: options['--article'],
      markdownPath: `${paths.contentDir}/${options['--article']}.md`,
      imageDir: paths.imageDir,
      explicitAllowPaths,
      run: dependencies.runProcess ?? runProcess,
    }),
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runAsScript(COMMAND, main);
}
