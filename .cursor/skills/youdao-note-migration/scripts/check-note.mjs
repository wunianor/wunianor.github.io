import { pathToFileURL } from 'node:url';

import { checkNote } from '../lib/note-check.mjs';
import { parseOptions, runAsScript, writeJson } from '../lib/script-utils.mjs';

const COMMAND = 'check-note';
const USAGE =
  'Usage: check-note --draft <relative-json> --approved-markdown <relative-md> --category <slug> --topic <slug> --article <slug> [--content-dir <relative-dir>] [--image-dir <relative-dir>]';

/**
 * @brief 校验最终 Markdown 与图片资产是否与已批准草稿一致。
 * @param {string[]} argv - 脚本参数。
 * @param {object} [context] - 运行上下文。
 * @param {string} [context.repoRoot=process.cwd()] - 仓库根目录。
 * @param {(text: string) => void} [context.write] - stdout 写入函数。
 * @returns {Promise<void>}
 * @note `--approved-markdown` 映射为内部 `--markdown`；失败 stderr 为含 `command: check-note` 的安全 JSON。
 */
export async function main(
  argv,
  {
    repoRoot = process.cwd(),
    write = (value) => process.stdout.write(value),
  } = {},
) {
  const options = parseOptions(argv, {
    valueFlags: ['--draft', '--approved-markdown', '--category', '--topic', '--article'],
    optionalValueFlags: ['--content-dir', '--image-dir'],
    usage: USAGE,
  });
  writeJson(
    write,
    checkNote(repoRoot, { ...options, '--markdown': options['--approved-markdown'] }),
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runAsScript(COMMAND, main);
}
