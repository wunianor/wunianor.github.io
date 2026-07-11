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

export function skillDirectory(repoRoot) {
  return path.join(repoRoot, ...SKILL_DIR_SEGMENTS);
}

export function rulesPath(repoRoot) {
  return path.join(skillDirectory(repoRoot), RULES_FILENAME);
}

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

function buildPosixPath(...segments) {
  return path.join(...segments).replaceAll('\\', '/');
}

export function buildMigrationPaths(rules, { categorySlug, topicSlug, articleSlug }) {
  validateSlug('categorySlug', categorySlug);
  validateSlug('topicSlug', topicSlug);
  validateSlug('articleSlug', articleSlug);

  return {
    cacheRoot: buildPosixPath(rules.cacheRoot),
    cacheContentDir: buildPosixPath(
      rules.cacheRoot,
      rules.contentRoot,
      categorySlug,
      topicSlug,
      articleSlug,
    ),
    cacheImageDir: buildPosixPath(rules.cacheRoot, rules.imageRoot, categorySlug, articleSlug),
    contentDir: buildPosixPath(rules.contentRoot, categorySlug, topicSlug),
    imageDir: buildPosixPath(rules.imageRoot, categorySlug, articleSlug),
  };
}
