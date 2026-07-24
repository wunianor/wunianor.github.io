import { spawn } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

import { buildDeliveryBranchName, loadRules } from './paths.mjs';

/**
 * @brief 将子进程 stdout/stderr 数据块拼接为 UTF-8 字符串。
 * @param {Buffer[]} chunks - 二进制块数组。
 * @returns {string} 解码后的完整文本。
 */
function outputText(chunks) {
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * @brief 以无 shell 方式启动子进程并收集退出码与输出。
 * @param {string} command - 可执行文件名（如 `git`、`hugo`）。
 * @param {string[]} argumentsList - 参数列表。
 * @param {{ cwd: string }} options - 工作目录。
 * @returns {Promise<{ exitCode: number, stdout: string, stderr: string }>}
 * @note 不继承 stdin；Windows 下隐藏控制台窗口；进程启动失败时 reject。
 */
export function runProcess(command, argumentsList, { cwd }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argumentsList, {
      cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];

    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', (error) => reject(error));
    child.once('close', (exitCode) => {
      resolve({ exitCode: exitCode ?? 1, stdout: outputText(stdout), stderr: outputText(stderr) });
    });
  });
}

/**
 * @brief 断言外部命令返回有效且为零的退出码。
 * @param {{ exitCode: number } | undefined} result - `runProcess` 结果。
 * @param {string} toolName - 工具名，用于错误消息。
 * @returns {void}
 * @note 退出码非零或结果畸形时抛 `Error`。
 */
function requireSuccessfulResult(result, toolName) {
  if (!result || !Number.isInteger(result.exitCode)) {
    throw new Error(`${toolName} runner returned an invalid result.`);
  }
  if (result.exitCode !== 0) {
    throw new Error(`${toolName} failed with exit code ${result.exitCode}.`);
  }
}

/**
 * @brief 以固定生产参数运行 Hugo 构建做站点门禁。
 * @param {{ repoRoot: string, run?: typeof runProcess }} options - 仓库根与可注入的运行器。
 * @returns {Promise<{ valid: true, command: 'check-site', exitCode: number }>}
 * @note 固定 `hugo --minify --environment production`；Hugo 无法启动或失败时抛 `Error`。
 */
export async function checkSite({ repoRoot, run = runProcess }) {
  let result;
  try {
    result = await run('hugo', ['--minify', '--environment', 'production'], { cwd: repoRoot });
  } catch (error) {
    throw new Error(`Hugo could not start safely: ${error.message}`);
  }
  requireSuccessfulResult(result, 'Hugo');

  return {
    valid: true,
    command: 'check-site',
    exitCode: result.exitCode,
  };
}

/**
 * @brief 解析 `git status --porcelain=v1` 输出为变更条目列表。
 * @param {string} statusOutput - Git 状态文本。
 * @returns {{ status: string, changedPath: string }[]} 路径已规范为 POSIX `/`。
 * @note 拒绝重命名箭头、引号路径等不支持格式；空输出返回 `[]`。
 */
function parseChangedEntries(statusOutput) {
  if (typeof statusOutput !== 'string') {
    throw new Error('Git status output is invalid.');
  }
  if (statusOutput === '') {
    return [];
  }

  return statusOutput.split(/\r?\n/).filter((line) => line !== '').map((line) => {
    if (line.length < 4 || !/^[ MADRCU?!]{2} /.test(line)) {
      throw new Error('Git status output contains an unsupported path format.');
    }
    const changedPath = line.slice(3);
    if (
      changedPath === ''
      || changedPath.includes(' -> ')
      || changedPath.startsWith('"')
      || changedPath.includes('\0')
    ) {
      throw new Error('Git status output contains an unsupported path format.');
    }
    return {
      status: line.slice(0, 2),
      changedPath: changedPath.replaceAll('\\', '/'),
    };
  });
}

/**
 * @brief 判断变更路径是否落在给定相对根目录之下（或等于该根）。
 * @param {string} changedPath - 变更的相对路径（POSIX `/`）。
 * @param {string} root - 相对根目录（如 `content/notes`）。
 * @returns {boolean} 路径等于根或位于根下为 `true`。
 */
function pathIsUnderRoot(changedPath, root) {
  const normalizedRoot = root.replaceAll('\\', '/').replace(/\/+$/, '');
  return changedPath === normalizedRoot || changedPath.startsWith(`${normalizedRoot}/`);
}

/**
 * @brief 判断 Git 变更路径是否在文章交付白名单内。
 * @param {string} changedPath - 变更的相对路径。
 * @param {string} markdownPath - 文章 Markdown 相对路径。
 * @param {string} imageDir - 文章图片目录相对路径。
 * @param {Set<string>} explicitAllowPaths - `--allow` 显式允许的额外路径集合。
 * @returns {boolean} 允许提交为 `true`。
 */
function pathIsAllowed(changedPath, markdownPath, imageDir, explicitAllowPaths) {
  return (
    changedPath === markdownPath
    || changedPath.startsWith(`${imageDir}/`)
    || explicitAllowPaths.has(changedPath)
  );
}

/**
 * @brief 判断候选绝对路径是否落在仓库根目录之外。
 * @param {string} root - 仓库根绝对路径。
 * @param {string} candidate - 待检查绝对路径。
 * @returns {boolean} 在根外为 `true`。
 */
function isOutsideRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

/**
 * @brief 检查未跟踪 Markdown 文件中的行尾空白与冲突标记。
 * @param {string} repoRoot - 仓库根目录。
 * @param {string} changedPath - 未跟踪 `.md` 的相对路径。
 * @returns {string | undefined} 发现问题时返回英文描述；干净时 `undefined`。
 * @note 经 `realpathSync` 沙箱校验；用于 `git-readiness` 在允许路径前的额外门禁。
 */
function untrackedMarkdownWhitespaceError(repoRoot, changedPath) {
  const root = realpathSync(repoRoot);
  const candidate = path.resolve(root, changedPath);
  if (isOutsideRoot(root, candidate)) {
    throw new Error(`Untracked Markdown path "${changedPath}" escapes the repository root.`);
  }
  const resolvedPath = realpathSync(candidate);
  if (isOutsideRoot(root, resolvedPath)) {
    throw new Error(`Untracked Markdown path "${changedPath}" escapes the repository root.`);
  }
  const markdown = readFileSync(resolvedPath, 'utf8');
  for (const [index, sourceLine] of markdown.split('\n').entries()) {
    const line = sourceLine.endsWith('\r') ? sourceLine.slice(0, -1) : sourceLine;
    if (/[ \t]+$/.test(line)) {
      return `trailing whitespace on line ${index + 1}`;
    }
    if (/^ +\t/.test(line)) {
      return `a space before a tab on line ${index + 1}`;
    }
    if (/^(?:<{7}|={7}|>{7})(?:\s|$)/.test(line)) {
      return `a conflict marker on line ${index + 1}`;
    }
  }
  return undefined;
}

/**
 * @brief 检查 Git 分支、变更路径与白空间是否满足提交就绪条件。
 * @param {object} options - 检查参数。
 * @param {string} options.repoRoot - 仓库根目录。
 * @param {string} options.categorySlug - 类目 slug。
 * @param {string} options.topicSlug - 主题 slug。
 * @param {string} options.articleSlug - 文章 slug。
 * @param {string} options.markdownPath - 最终 Markdown 相对路径。
 * @param {string} options.imageDir - 最终图片目录相对路径。
 * @param {Set<string>} options.explicitAllowPaths - 额外允许路径。
 * @param {typeof runProcess} [options.run] - 可注入的 Git/Hugo 运行器。
 * @returns {Promise<{ valid: true, command: 'git-readiness', branch: string, changedPaths: string[] }>}
 * @note 须在 `docs/<category>_<topic>_<article>` 分支；仅审查 `contentRoot`/`imageRoot` 内变更（根外忽略）；
 *       根内仍只允许本文 Markdown、本文 `imageDir/` 与 `--allow`；`.tmp` 变更一律拒绝；先跑 `diff --check` 再报路径错误。
 */
export async function checkGitReadiness({
  repoRoot,
  categorySlug,
  topicSlug,
  articleSlug,
  markdownPath,
  imageDir,
  explicitAllowPaths,
  run = runProcess,
}) {
  let branchResult;
  try {
    branchResult = await run('git', ['branch', '--show-current'], { cwd: repoRoot });
  } catch (error) {
    throw new Error(`Git branch check could not start safely: ${error.message}`);
  }
  requireSuccessfulResult(branchResult, 'Git branch check');
  const branch = branchResult.stdout.trim();
  const rules = loadRules(repoRoot);
  const expectedBranch = buildDeliveryBranchName(rules, {
    categorySlug,
    topicSlug,
    articleSlug,
  });
  if (branch !== expectedBranch) {
    throw new Error(`Git readiness requires branch "${expectedBranch}", found "${branch || '(detached HEAD)'}".`);
  }

  let statusResult;
  try {
    statusResult = await run('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
      cwd: repoRoot,
    });
  } catch (error) {
    throw new Error(`Git status check could not start safely: ${error.message}`);
  }
  requireSuccessfulResult(statusResult, 'Git status check');
  const changedEntries = parseChangedEntries(statusResult.stdout);
  const changedPaths = changedEntries.map((entry) => entry.changedPath);
  const { contentRoot, imageRoot } = rules;
  const unexpectedPaths = changedEntries
    .map((entry) => entry.changedPath)
    .filter((changedPath) => {
      if (changedPath === '.tmp' || changedPath.startsWith('.tmp/')) {
        return true;
      }
      const inDeliveryRoots =
        pathIsUnderRoot(changedPath, contentRoot) || pathIsUnderRoot(changedPath, imageRoot);
      if (!inDeliveryRoots) {
        return false;
      }
      return !pathIsAllowed(changedPath, markdownPath, imageDir, explicitAllowPaths);
    });

  let diffResult;
  try {
    diffResult = await run('git', ['diff', '--check'], { cwd: repoRoot });
  } catch (error) {
    throw new Error(`Git diff check could not start safely: ${error.message}`);
  }
  requireSuccessfulResult(diffResult, 'Git diff check');

  let cachedDiffResult;
  try {
    cachedDiffResult = await run('git', ['diff', '--cached', '--check'], { cwd: repoRoot });
  } catch (error) {
    throw new Error(`Git cached diff check could not start safely: ${error.message}`);
  }
  requireSuccessfulResult(cachedDiffResult, 'Git cached diff check');

  if (unexpectedPaths.length > 0) {
    throw new Error(`Git readiness found unexpected changed paths: ${unexpectedPaths.join(', ')}.`);
  }

  for (const { status, changedPath } of changedEntries) {
    if (status !== '??' || !changedPath.endsWith('.md')) {
      continue;
    }
    const inDeliveryRoots =
      pathIsUnderRoot(changedPath, contentRoot) || pathIsUnderRoot(changedPath, imageRoot);
    if (!inDeliveryRoots) {
      continue;
    }
    const whitespaceError = untrackedMarkdownWhitespaceError(repoRoot, changedPath);
    if (whitespaceError) {
      throw new Error(`Untracked Markdown "${changedPath}" contains ${whitespaceError}.`);
    }
  }

  return {
    valid: true,
    command: 'git-readiness',
    branch,
    changedPaths,
  };
}

/**
 * @brief 断言最终 Markdown 不含 HTML 图片、远程链接或 `.tmp` 引用。
 * @param {string} markdown - 最终或候选 Markdown 正文。
 * @returns {void}
 * @note 用于 `check-note` 与草稿校验链路；违规时抛 `Error`。
 */
export function assertSafeMarkdownLinks(markdown) {
  if (/<img\b/i.test(markdown)) {
    throw new Error('Markdown must not contain HTML image tags.');
  }
  if (/(?:https?:)?\/\//i.test(markdown)) {
    throw new Error('Markdown must not contain remote links.');
  }
  if (/(?:^|[(/])\.tmp(?:[\\/)]|$)/m.test(markdown)) {
    throw new Error('Markdown must not contain .tmp links.');
  }
}
