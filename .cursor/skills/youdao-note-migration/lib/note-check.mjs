import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { validateDraftOutput } from './draft-validator.mjs';
import { buildMigrationPaths, loadRules } from './paths.mjs';
import { assertSafeMarkdownLinks } from './quality-gates.mjs';
import {
  readDraftValidationInputs,
  resolveReadPath,
  resolveRelativePath,
} from './script-utils.mjs';

/**
 * @brief 断言路径信息指向的已存在节点为目录。
 * @param {{ absolutePath: string }} pathInfo - `resolveReadPath` 返回的路径对象。
 * @param {string} label - 用于错误消息的字段名。
 * @returns {void}
 * @note 目标不存在或非目录时抛 `Error`。
 */
function requireDirectory(pathInfo, label) {
  if (!statSync(pathInfo.absolutePath).isDirectory()) {
    throw new Error(`${label} must be a directory.`);
  }
}

/**
 * @brief 解析必须存在的仓库内相对路径。
 * @param {string} repoRoot - 仓库根目录。
 * @param {string} relativePath - 相对路径。
 * @param {string} label - 字段名。
 * @returns {{ absolutePath: string, relativePath: string }}
 * @note 包装 `resolveReadPath`，将任意沙箱失败统一为「必须存在于仓库根下」消息。
 */
function resolveRequiredPath(repoRoot, relativePath, label) {
  try {
    return resolveReadPath(repoRoot, relativePath, label);
  } catch {
    throw new Error(`${label} must exist under the repository root.`);
  }
}

/**
 * @brief 校验可选的 `--content-dir` / `--image-dir` 与预期路径完全一致。
 * @param {string} repoRoot - 仓库根目录。
 * @param {string | undefined} suppliedPath - CLI 提供的相对目录，未提供则跳过。
 * @param {string} expectedPath - 由 slug 推导的规范相对路径。
 * @param {string} label - 选项标签（如 `content-dir`）。
 * @returns {void}
 * @note 提供时必须存在、为目录且相对路径字节级等于 `expectedPath`。
 */
function checkOptionalDirectory(repoRoot, suppliedPath, expectedPath, label) {
  if (suppliedPath === undefined) {
    return;
  }
  const supplied = resolveReadPath(repoRoot, suppliedPath, label);
  requireDirectory(supplied, label);
  if (supplied.relativePath !== expectedPath) {
    throw new Error(`${label} must equal "${expectedPath}".`);
  }
}

/**
 * @brief 递归列出最终图片目录下的相对文件路径。
 * @param {string} directory - 当前遍历的绝对目录。
 * @param {string} [rootDirectory] - 用于计算相对路径的根目录，默认为 `directory`。
 * @returns {string[]} POSIX 风格的相对文件路径列表。
 * @note 遇符号链接目录或非文件节点时抛 `Error`；不包含目录条目本身。
 */
function listFinalImageAssets(directory, rootDirectory = directory) {
  const assets = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      assets.push(...listFinalImageAssets(absolutePath, rootDirectory));
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`Final image directory contains unsupported asset "${entry.name}".`);
    }
    assets.push(
      path.relative(rootDirectory, absolutePath).replaceAll('\\', '/'),
    );
  }
  return assets;
}

/**
 * @brief 计算仓库内文件的 SHA-256 十六进制摘要。
 * @param {{ absolutePath: string }} pathInfo - 已解析的文件路径对象。
 * @returns {string} 小写十六进制哈希。
 * @note 一次性读入内存；大文件场景与迁移图片规模一致。
 */
function sha256(pathInfo) {
  return createHash('sha256').update(readFileSync(pathInfo.absolutePath)).digest('hex');
}

/**
 * @brief 从缓存 provenance 构建来源 URL 到 SHA-256 的映射并校验缓存文件。
 * @param {string} repoRoot - 仓库根目录。
 * @param {string} cacheContentDir - 文章缓存内容目录相对路径。
 * @returns {Map<string, string>} `sourceUrl` → 小写 hex SHA-256。
 * @note 校验 JSON 结构、哈希格式、路径唯一性及磁盘文件与记录一致；失败抛 `Error`。
 */
function readPreservedImageHashes(repoRoot, cacheContentDir) {
  const provenancePath = resolveRequiredPath(
    repoRoot,
    `${cacheContentDir}/reports/provenance.json`,
    'image provenance',
  );
  let provenance;
  try {
    provenance = JSON.parse(readFileSync(provenancePath.absolutePath, 'utf8'));
  } catch {
    throw new Error('Image provenance must be valid JSON.');
  }
  if (!Array.isArray(provenance?.images)) {
    throw new Error('Image provenance must contain an images array.');
  }

  const bySource = new Map();
  for (const image of provenance.images) {
    if (
      typeof image?.sourceUrl !== 'string'
      || typeof image.localPath !== 'string'
      || !/^[a-f0-9]{64}$/i.test(image.sha256)
      || bySource.has(image.sourceUrl)
    ) {
      throw new Error('Image provenance contains an invalid or ambiguous image record.');
    }
    const cachedImage = resolveRequiredPath(repoRoot, image.localPath, 'preserved cache image');
    if (sha256(cachedImage) !== image.sha256.toLowerCase()) {
      throw new Error(`Preserved cache image "${image.localPath}" does not match its SHA256 provenance.`);
    }
    bySource.set(image.sourceUrl, image.sha256.toLowerCase());
  }
  return bySource;
}

/**
 * @brief 对最终 Markdown 与图片资产执行交付前门禁校验。
 * @param {string} repoRoot - 仓库根目录。
 * @param {Record<string, string>} options - 含 `--draft`、`--markdown`（或映射后的 approved-markdown）、category/topic/article 及可选目录选项。
 * @returns {{ valid: true, command: 'check-note', markdown: string, imageDir: string, images: number }}
 * @note 校验草稿 target 与 slug 一致、候选与最终文件逐字节相同、图片清单与 provenance；不修改任何文件。
 */
export function checkNote(repoRoot, options) {
  const { draft, markdown } = readDraftValidationInputs(repoRoot, options);
  const rules = loadRules(repoRoot);
  const paths = buildMigrationPaths(rules, {
    categorySlug: options['--category'],
    topicSlug: options['--topic'],
    articleSlug: options['--article'],
  });
  const markdownPath = `${paths.contentDir}/${options['--article']}.md`;

  if (
    draft.target.categorySlug !== options['--category']
    || draft.target.topicSlug !== options['--topic']
    || draft.target.articleSlug !== options['--article']
    || draft.target.markdownPath !== markdownPath
    || draft.target.imageDir !== paths.imageDir
  ) {
    throw new Error('Draft target does not match the supplied category, topic, and article slugs.');
  }
  checkOptionalDirectory(repoRoot, options['--content-dir'], paths.contentDir, 'content-dir');
  checkOptionalDirectory(repoRoot, options['--image-dir'], paths.imageDir, 'image-dir');

  validateDraftOutput(draft, markdown, rules);
  assertSafeMarkdownLinks(markdown);

  const finalMarkdown = resolveRequiredPath(repoRoot, markdownPath, 'final markdown');
  const finalImageDirRelativePath = resolveRelativePath(
    repoRoot,
    paths.imageDir,
    'final image directory',
  );
  const finalImageDirAbsolutePath = path.resolve(repoRoot, finalImageDirRelativePath);
  const finalImageDir = existsSync(finalImageDirAbsolutePath)
    ? resolveReadPath(repoRoot, finalImageDirRelativePath, 'final image directory')
    : undefined;
  if (finalImageDir) {
    requireDirectory(finalImageDir, 'final image directory');
  } else if (draft.images.length > 0) {
    throw new Error('final image directory must exist under the repository root.');
  }
  const finalMarkdownContents = readFileSync(finalMarkdown.absolutePath, 'utf8');
  if (Buffer.compare(Buffer.from(markdown), readFileSync(finalMarkdown.absolutePath)) !== 0) {
    throw new Error('Final markdown must byte-match the approved candidate Markdown.');
  }
  validateDraftOutput(draft, finalMarkdownContents, rules);
  assertSafeMarkdownLinks(finalMarkdownContents);

  const finalAssets = new Set(
    (finalImageDir ? listFinalImageAssets(finalImageDir.absolutePath) : []).map(
      (asset) => `${finalImageDirRelativePath}/${asset}`,
    ),
  );
  const approvedAssets = new Set(draft.images.map((image) => image.finalPath));
  for (const asset of finalAssets) {
    if (!approvedAssets.has(asset)) {
      throw new Error(`Unapproved final image asset "${asset}".`);
    }
  }

  const preservedImageHashes = draft.images.some((image) => image.decision === 'preserve-original')
    ? readPreservedImageHashes(repoRoot, paths.cacheContentDir)
    : new Map();
  for (const image of draft.images) {
    const finalImage = resolveRequiredPath(repoRoot, image.finalPath, 'approved final image');
    if (statSync(finalImage.absolutePath).isDirectory()) {
      throw new Error(`Approved final image "${image.finalPath}" must be a file.`);
    }
    if (image.decision === 'preserve-original') {
      const expectedHash = preservedImageHashes.get(image.source);
      if (!expectedHash || sha256(finalImage) !== expectedHash) {
        throw new Error(`Preserve-original image "${image.finalPath}" does not match provenance SHA256.`);
      }
    }
  }

  return {
    valid: true,
    command: 'check-note',
    markdown: finalMarkdown.relativePath,
    imageDir: finalImageDirRelativePath,
    images: draft.images.length,
  };
}
