import { pathToFileURL } from 'node:url';

import { cachePublicShare } from '../lib/cache.mjs';
import { loadRules } from '../lib/paths.mjs';
import { readPublicShare, resolveShareInput } from '../lib/public-share.mjs';
import { parseOptions, runAsScript, writeJson } from '../lib/script-utils.mjs';

const COMMAND = 'cache-share';
const USAGE =
  'Usage: cache-share --share-id <shareId-or-url> --category <categorySlug> --topic <topicSlug> --article <articleSlug> --confirmed';

/**
 * @brief 在用户确认后将公共分享缓存到文章 `.tmp` 目录。
 * @param {string[]} argv - 脚本参数。
 * @param {object} [context] - 运行上下文。
 * @param {string} [context.repoRoot=process.cwd()] - 仓库根目录。
 * @param {(text: string) => void} [context.write] - stdout 写入函数。
 * @param {object} [context.dependencies] - 可注入分享读取、缓存与网络实现。
 * @returns {Promise<void>}
 * @note 必须带 `--confirmed` 才会读网或写盘；缓存仅写入 `.tmp/content/notes/...`；失败 stderr 为 `Error: ...`。
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
    valueFlags: ['--share-id', '--category', '--topic', '--article'],
    booleanFlags: ['--confirmed'],
    usage: USAGE,
  });
  if (!options['--confirmed']) {
    throw new Error(USAGE);
  }

  const services = {
    readShare: dependencies.readShare ?? readPublicShare,
    cacheShare: dependencies.cacheShare ?? cachePublicShare,
    resolveShareInput:
      dependencies.resolveShareInput
      ?? ((input) =>
        resolveShareInput(input, {
          resolveHost: dependencies.resolveHost,
          requestImpl: dependencies.requestImpl,
        })),
  };

  const rules = loadRules(repoRoot);
  const shareId = await services.resolveShareInput(options['--share-id']);
  const share = await services.readShare(shareId);
  const result = await services.cacheShare({
    repoRoot,
    rules,
    categorySlug: options['--category'],
    topicSlug: options['--topic'],
    articleSlug: options['--article'],
    share,
    resolveHost: dependencies.resolveHost,
    requestImpl: dependencies.requestImpl,
    fetchImpl: dependencies.fetchImpl,
    renameImpl: dependencies.renameImpl,
  });
  writeJson(write, result);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runAsScript(COMMAND, main);
}
