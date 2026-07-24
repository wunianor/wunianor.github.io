import { pathToFileURL } from 'node:url';

import { extractImages } from '../lib/images.mjs';
import { readPublicShare, resolveShareInput } from '../lib/public-share.mjs';
import { parseOptions, runAsScript, writeJson } from '../lib/script-utils.mjs';

const COMMAND = 'share-info';
const USAGE = 'Usage: share-info --share-id <shareId-or-url>';

/**
 * @brief 解析公共分享输入并输出标题、shareId 与图片数量摘要。
 * @param {string[]} argv - 脚本参数（不含 node 与脚本路径）。
 * @param {object} [context] - 运行上下文。
 * @param {string} [context.repoRoot] - 仓库根；本命令不读写仓库文件，仅保持接口一致。
 * @param {(text: string) => void} [context.write] - stdout 写入函数。
 * @param {object} [context.dependencies] - 可注入 `resolveShareInput`、`readShare`、`resolveHost`、`requestImpl`。
 * @returns {Promise<void>}
 * @note 不输出正文 HTML；分享解析经 SSRF 防护；失败时 stderr 为 `Error: ...` 文本。
 */
export async function main(
  argv,
  {
    write = (value) => process.stdout.write(value),
    dependencies = {},
  } = {},
) {
  const options = parseOptions(argv, {
    valueFlags: ['--share-id'],
    usage: USAGE,
  });
  const services = {
    readShare: dependencies.readShare ?? readPublicShare,
    resolveShareInput:
      dependencies.resolveShareInput
      ?? ((input) =>
        resolveShareInput(input, {
          resolveHost: dependencies.resolveHost,
          requestImpl: dependencies.requestImpl,
        })),
  };
  const shareId = await services.resolveShareInput(options['--share-id']);
  const share = await services.readShare(shareId);
  writeJson(write, {
    title: share.title,
    shareId: share.shareId,
    imageCount: extractImages(share.content).length,
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runAsScript(COMMAND, main);
}
