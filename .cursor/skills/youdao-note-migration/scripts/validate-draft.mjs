import { pathToFileURL } from 'node:url';

import { validateDraftOutput } from '../lib/draft-validator.mjs';
import { loadRules } from '../lib/paths.mjs';
import {
  parseOptions,
  readDraftValidationInputs,
  runAsScript,
  summarizeDraftValidation,
  writeJson,
} from '../lib/script-utils.mjs';

const COMMAND = 'validate-draft';
const USAGE = 'Usage: validate-draft --draft <relative-json> --markdown <relative-md>';

/**
 * @brief 只读校验草稿 JSON 与候选 Markdown 是否满足严格保真门禁。
 * @param {string[]} argv - 脚本参数。
 * @param {object} [context] - 运行上下文。
 * @param {string} [context.repoRoot=process.cwd()] - 仓库根目录。
 * @param {(text: string) => void} [context.write] - stdout 写入函数。
 * @returns {Promise<void>}
 * @note 不写最终 `content/` 或 `static/`；失败时 stderr 为 `{ valid: false, error }` JSON 且退出码非零。
 */
export async function main(
  argv,
  {
    repoRoot = process.cwd(),
    write = (value) => process.stdout.write(value),
  } = {},
) {
  const options = parseOptions(argv, {
    valueFlags: ['--draft', '--markdown'],
    usage: USAGE,
  });
  const { draft, draftPath, markdown, markdownPath } = readDraftValidationInputs(repoRoot, options);
  const rules = loadRules(repoRoot);
  validateDraftOutput(draft, markdown, rules);
  writeJson(write, summarizeDraftValidation({ draft, draftPath, markdownPath }));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runAsScript(COMMAND, main);
}
