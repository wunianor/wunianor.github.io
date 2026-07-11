import { spawn } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

function outputText(chunks) {
  return Buffer.concat(chunks).toString('utf8');
}

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

function requireSuccessfulResult(result, toolName) {
  if (!result || !Number.isInteger(result.exitCode)) {
    throw new Error(`${toolName} runner returned an invalid result.`);
  }
  if (result.exitCode !== 0) {
    throw new Error(`${toolName} failed with exit code ${result.exitCode}.`);
  }
}

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

function pathIsAllowed(changedPath, markdownPath, imageDir, explicitAllowPaths) {
  return (
    changedPath === markdownPath
    || changedPath.startsWith(`${imageDir}/`)
    || explicitAllowPaths.has(changedPath)
  );
}

function isOutsideRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

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
  const expectedBranch = `docs/${categorySlug}-${articleSlug}`;
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
  const unexpectedPaths = changedEntries
    .map((entry) => entry.changedPath)
    .filter(
      (changedPath) =>
        changedPath === '.tmp'
        || changedPath.startsWith('.tmp/')
        || !pathIsAllowed(changedPath, markdownPath, imageDir, explicitAllowPaths),
    );

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
