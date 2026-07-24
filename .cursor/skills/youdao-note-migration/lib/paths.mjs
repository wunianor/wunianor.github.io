import { readFileSync } from 'node:fs';
import path from 'node:path';

const REQUIRED_STRING_FIELDS = [
  'cacheRoot',
  'contentRoot',
  'imageRoot',
  'branchTemplate',
  'commitTemplate',
  'approvalUserId',
];

const OUTPUT_ROOT_FIELDS = ['cacheRoot', 'contentRoot', 'imageRoot'];

/**
 * @brief 校验规则中的相对根路径字段不含绝对路径或 `..` 段。
 * @param {string} name - 字段名，用于错误消息。
 * @param {string} value - 配置值。
 * @returns {void}
 * @note 拒绝各平台绝对路径写法；失败抛 `Error`。
 */
function validateRelativeRoot(name, value) {
  if (
    path.isAbsolute(value) ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    path.win32.parse(value).root !== ''
  ) {
    throw new Error(`${name} must not be absolute.`);
  }

  if (value.split(/[\\/]+/).includes('..')) {
    throw new Error(`${name} must not contain a relative path segment.`);
  }
}

export const SKILL_DIR_SEGMENTS = ['.cursor', 'skills', 'youdao-note-migration'];
export const RULES_FILENAME = 'youdao-note-migration.json';

/**
 * @brief 返回 skill 目录在仓库内的绝对路径。
 * @param {string} repoRoot - 仓库根目录。
 * @returns {string} `.cursor/skills/youdao-note-migration` 的绝对路径。
 */
export function skillDirectory(repoRoot) {
  return path.join(repoRoot, ...SKILL_DIR_SEGMENTS);
}

/**
 * @brief 返回迁移规则 JSON 文件的绝对路径。
 * @param {string} repoRoot - 仓库根目录。
 * @returns {string} `youdao-note-migration.json` 绝对路径。
 */
export function rulesPath(repoRoot) {
  return path.join(skillDirectory(repoRoot), RULES_FILENAME);
}

/**
 * @brief 加载并校验版本 1 的有道笔记迁移规则。
 * @param {string} repoRoot - 仓库根目录。
 * @returns {object} 解析后的规则对象。
 * @note `cacheRoot` 必须为 `.tmp`；各根路径须为安全相对路径；失败抛 `Error`。
 */
export function loadRules(repoRoot) {
  const rulesPathResolved = rulesPath(repoRoot);
  let rules;

  try {
    rules = JSON.parse(readFileSync(rulesPathResolved, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to load Youdao note migration rules: ${error.message}`);
  }

  if (rules?.version !== 1) {
    throw new Error('Youdao note migration rules must use version 1.');
  }

  for (const field of REQUIRED_STRING_FIELDS) {
    if (typeof rules[field] !== 'string' || rules[field].trim() === '') {
      throw new Error(`Youdao note migration rules require a non-empty ${field} string.`);
    }
  }

  for (const field of OUTPUT_ROOT_FIELDS) {
    validateRelativeRoot(field, rules[field]);
  }

  if (rules.cacheRoot !== '.tmp') {
    throw new Error('cacheRoot must be exactly .tmp.');
  }

  return rules;
}

/**
 * @brief 校验 kebab-case slug 不含路径分隔符或遍历段。
 * @param {string} name - 字段名（如 `categorySlug`）。
 * @param {string} value - slug 字符串。
 * @returns {void}
 * @note 拒绝 `/`、`\`、`.`、`..` 与绝对路径；失败抛 `Error`。
 */
function validateSlug(name, value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} must be a non-empty slug.`);
  }

  if (
    path.isAbsolute(value) ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    value.includes('/') ||
    value.includes('\\') ||
    value === '.' ||
    value === '..'
  ) {
    throw new Error(`${name} must not contain a relative path segment or be absolute.`);
  }
}

/**
 * @brief 将路径段拼接为 POSIX 风格相对路径字符串。
 * @param {...string} segments - 路径段。
 * @returns {string} 以 `/` 分隔的路径。
 */
function buildPosixPath(...segments) {
  return path.join(...segments).replaceAll('\\', '/');
}

/**
 * @brief 根据规则与 slug 推导缓存目录与最终交付目录。
 * @param {object} rules - `loadRules` 返回的规则对象。
 * @param {{ categorySlug: string, topicSlug: string, articleSlug: string }} slugs - 三类 slug。
 * @returns {{ cacheRoot: string, cacheContentDir: string, cacheImageDir: string, contentDir: string, imageDir: string }}
 * @note `categorySlug` 必填；图片目录不含 `topic` 段；slug 非法时抛 `Error`。
 */
export function buildMigrationPaths(rules, { categorySlug, topicSlug, articleSlug }) {
  validateSlug('categorySlug', categorySlug);
  validateSlug('topicSlug', topicSlug);
  validateSlug('articleSlug', articleSlug);

  const cacheContentDir = buildPosixPath(
    rules.cacheRoot,
    rules.contentRoot,
    categorySlug,
    topicSlug,
    articleSlug,
  );

  return {
    cacheRoot: buildPosixPath(rules.cacheRoot),
    cacheContentDir,
    cacheImageDir: buildPosixPath(cacheContentDir, 'images'),
    contentDir: buildPosixPath(rules.contentRoot, categorySlug, topicSlug),
    imageDir: buildPosixPath(rules.imageRoot, categorySlug, articleSlug),
  };
}

/**
 * @brief 按规则模板生成学习笔记交付分支名。
 * @param {object} rules - `loadRules` 返回的规则对象。
 * @param {{ categorySlug: string, topicSlug: string, articleSlug: string }} slugs - 三类 slug。
 * @returns {string} 例如 `docs/linux_io-multiplexing_io-basics`。
 * @note 对应去掉 `content/notes/` 前缀后把 `/` 换成 `_` 的笔记路径（不含 `.md`）；
 *       模板占位符：`{category}` `{topic}` `{article}`，`{slug}` 兼容为 article。
 */
export function buildDeliveryBranchName(rules, { categorySlug, topicSlug, articleSlug }) {
  validateSlug('categorySlug', categorySlug);
  validateSlug('topicSlug', topicSlug);
  validateSlug('articleSlug', articleSlug);

  return rules.branchTemplate
    .replaceAll('{category}', categorySlug)
    .replaceAll('{topic}', topicSlug)
    .replaceAll('{article}', articleSlug)
    .replaceAll('{slug}', articleSlug);
}
