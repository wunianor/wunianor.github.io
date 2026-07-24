import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

/**
 * @brief 解析脚本长选项参数，校验必填项并返回选项对象。
 * @param {string[]} argumentsList - 去掉 `node` 与脚本路径后的 argv 片段。
 * @param {object} config - 解析配置。
 * @param {string[]} config.valueFlags - 必须出现且必须带值的选项名（如 `--draft`）。
 * @param {string[]} [config.optionalValueFlags] - 可选带值选项名。
 * @param {string[]} [config.booleanFlags] - 仅出现即表示为真的布尔选项名。
 * @param {string[]} [config.repeatableValueFlags] - 可重复出现的带值选项名，值会收集为数组。
 * @param {string} config.usage - 参数不合法时抛出的 usage 文本。
 * @returns {Record<string, string | string[] | boolean>} 以选项名为键的解析结果。
 * @note 未知选项、重复必填项、缺值或缺必填项时抛出含 usage 的 `Error`；不执行路径沙箱校验。
 */
export function parseOptions(
  argumentsList,
  { valueFlags, optionalValueFlags = [], booleanFlags = [], repeatableValueFlags = [], usage },
) {
  const options = {};

  for (let index = 0; index < argumentsList.length; index += 1) {
    const flag = argumentsList[index];
    if (valueFlags.includes(flag) || optionalValueFlags.includes(flag)) {
      const value = argumentsList[index + 1];
      if (value === undefined || value.startsWith('--') || options[flag] !== undefined) {
        throw new Error(usage);
      }

      options[flag] = value;
      index += 1;
      continue;
    }

    if (repeatableValueFlags.includes(flag)) {
      const value = argumentsList[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(usage);
      }
      (options[flag] ??= []).push(value);
      index += 1;
      continue;
    }

    if (booleanFlags.includes(flag) && !options[flag]) {
      options[flag] = true;
      continue;
    }

    throw new Error(usage);
  }

  for (const flag of valueFlags) {
    if (!options[flag]) {
      throw new Error(usage);
    }
  }

  return options;
}

/**
 * @brief 将 JSON 值格式化后写入输出流。
 * @param {(text: string) => void} write - 输出回调，通常绑定到 `process.stdout.write`。
 * @param {unknown} value - 要序列化的对象。
 * @returns {void}
 * @note 使用两空格缩进并在末尾追加换行；不捕获序列化异常。
 */
export function writeJson(write, value) {
  write(`${JSON.stringify(value, null, 2)}\n`);
}

/**
 * @brief 判断候选路径是否落在仓库根目录之外。
 * @param {string} root - 已解析的仓库根绝对路径。
 * @param {string} candidate - 待检查的绝对路径。
 * @returns {boolean} 在根外或为跨盘绝对路径时返回 `true`。
 * @note 使用 `path.relative` 检测 `..` 前缀；不跟随符号链接。
 */
export function isOutsideRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

/**
 * @brief 将仓库内相对路径解析为可读的绝对路径并做符号链接沙箱校验。
 * @param {string} repoRoot - 仓库根目录。
 * @param {string} relativePath - 相对仓库根的路径，禁止绝对路径与 `..` 逃逸。
 * @param {string} label - 用于错误消息的人类可读字段名（如 `draft`）。
 * @returns {{ absolutePath: string, relativePath: string }} 真实路径与 POSIX 风格相对路径。
 * @note 拒绝空串、各平台绝对路径写法；`realpathSync` 后再次校验防止符号链接越界；失败抛 `Error`。
 */
export function resolveReadPath(repoRoot, relativePath, label) {
  if (
    typeof relativePath !== 'string'
    || relativePath.trim() === ''
    || path.isAbsolute(relativePath)
    || path.posix.isAbsolute(relativePath)
    || path.win32.isAbsolute(relativePath)
    || path.win32.parse(relativePath).root !== ''
  ) {
    throw new Error(`${label} must be a relative path under the repository root.`);
  }

  const resolvedRoot = path.resolve(repoRoot);
  const resolvedPath = path.resolve(resolvedRoot, relativePath);
  if (isOutsideRoot(resolvedRoot, resolvedPath)) {
    throw new Error(`${label} must stay under the repository root.`);
  }

  const realRoot = realpathSync(resolvedRoot);
  const realPath = realpathSync(resolvedPath);
  if (isOutsideRoot(realRoot, realPath)) {
    throw new Error(`${label} must stay under the repository root.`);
  }

  return {
    absolutePath: realPath,
    relativePath: path.relative(resolvedRoot, resolvedPath).replaceAll('\\', '/'),
  };
}

/**
 * @brief 将仓库内相对路径规范化为 POSIX 相对路径，不要求目标已存在。
 * @param {string} repoRoot - 仓库根目录。
 * @param {string} relativePath - 相对仓库根的路径。
 * @param {string} label - 用于错误消息的字段名。
 * @returns {string} 以 `/` 分隔的相对路径。
 * @note 拒绝绝对路径与目录遍历；不调用 `realpathSync`；失败抛 `Error`。
 */
export function resolveRelativePath(repoRoot, relativePath, label) {
  if (
    typeof relativePath !== 'string'
    || relativePath.trim() === ''
    || path.isAbsolute(relativePath)
    || path.posix.isAbsolute(relativePath)
    || path.win32.isAbsolute(relativePath)
    || path.win32.parse(relativePath).root !== ''
  ) {
    throw new Error(`${label} must be a relative path under the repository root.`);
  }

  const resolvedRoot = path.resolve(repoRoot);
  const resolvedPath = path.resolve(resolvedRoot, relativePath);
  if (isOutsideRoot(resolvedRoot, resolvedPath)) {
    throw new Error(`${label} must stay under the repository root.`);
  }

  return path.relative(resolvedRoot, resolvedPath).replaceAll('\\', '/');
}

/**
 * @brief 从沙箱路径读取草稿 JSON 与候选 Markdown 正文。
 * @param {string} repoRoot - 仓库根目录。
 * @param {Record<string, string>} options - 含 `--draft` 与 `--markdown` 的解析选项。
 * @returns {{ draft: object, draftPath: object, markdown: string, markdownPath: object }}
 * @note 路径经 `resolveReadPath` 校验；JSON 或文件读取失败时包装为可读 `Error`。
 */
export function readDraftValidationInputs(repoRoot, options) {
  const draftPath = resolveReadPath(repoRoot, options['--draft'], 'draft');
  const markdownPath = resolveReadPath(repoRoot, options['--markdown'], 'markdown');
  let draft;
  try {
    draft = JSON.parse(readFileSync(draftPath.absolutePath, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to read draft JSON: ${error.message}`);
  }

  let markdown;
  try {
    markdown = readFileSync(markdownPath.absolutePath, 'utf8');
  } catch (error) {
    throw new Error(`Unable to read Markdown: ${error.message}`);
  }

  return { draft, draftPath, markdown, markdownPath };
}

/**
 * @brief 汇总 `validate-draft` 成功时的只读 JSON 摘要。
 * @param {{ draft: object, draftPath: { relativePath: string }, markdownPath: { relativePath: string } }} input
 * @returns {object} 含 `valid`、`draft`、`markdown`、`target` 与 `counts` 的摘要对象。
 * @note 不重新校验草稿；假定调用方已通过 `validateDraftOutput`。
 */
export function summarizeDraftValidation({ draft, draftPath, markdownPath }) {
  return {
    valid: true,
    draft: draftPath.relativePath,
    markdown: markdownPath.relativePath,
    target: {
      markdownPath: draft.target.markdownPath,
      imageDir: draft.target.imageDir,
    },
    counts: {
      sourceSections: draft.sourceSections.length,
      outputSections: draft.outputSections.length,
      paragraphs: draft.outputSections.reduce(
        (total, section) => total + section.paragraphs.length,
        0,
      ),
      formatChanges: draft.formatChanges.length,
      contentChanges: draft.contentChanges.length,
      images: draft.images.length,
    },
  };
}

/**
 * @brief 按脚本能力名将错误写入 stderr 并设置非零退出码。
 * @param {string} command - 能力名，如 `validate-draft`、`share-info`。
 * @param {Error} error - 捕获到的错误对象。
 * @returns {void}
 * @note `validate-draft` 输出 `{ valid, error }`；`check-note`/`check-site`/`git-readiness` 含 `command`；其余为 `Error: ...` 文本。
 */
export function writeScriptError(command, error) {
  if (command === 'validate-draft') {
    process.stderr.write(`${JSON.stringify({ valid: false, error: error.message })}\n`);
  } else if (['check-note', 'check-site', 'git-readiness'].includes(command)) {
    process.stderr.write(
      `${JSON.stringify({ valid: false, command, error: error.message })}\n`,
    );
  } else {
    process.stderr.write(`Error: ${error.message}\n`);
  }
  process.exitCode = 1;
}

/**
 * @brief 作为可执行脚本入口运行 `main`，统一处理未捕获错误。
 * @param {string} command - 能力名，用于错误信封。
 * @param {(argv: string[], context: object) => Promise<void>} main - 脚本主逻辑。
 * @param {object} [context] - 传给 `main` 的上下文（`repoRoot`、`write`、`dependencies` 等）。
 * @returns {Promise<void>}
 * @note 仅在直接执行脚本文件时由脚本底部调用；测试可单独 `import { main }` 并注入依赖。
 */
export async function runAsScript(command, main, context = {}) {
  try {
    await main(process.argv.slice(2), context);
  } catch (error) {
    writeScriptError(command, error);
  }
}
