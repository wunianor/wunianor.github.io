import { hasUnfixedTopLevelHeadingShell } from './heading-structure.mjs';
import {
  hasCodeFenceCommentIssues,
  hasChinesePunctuationIssues,
  hasEmphasisSyntaxIssues,
} from './markdown-format.mjs';

/**
 * @brief 以带路径前缀的错误消息终止校验流程。
 * @param {string} path - JSON 字段路径或逻辑位置标识。
 * @param {string} message - 人类可读的错误说明。
 * @returns {never} 始终抛出 Error，不会正常返回。
 * @note 所有校验辅助函数通过此入口统一失败；调用方应捕获或允许异常向上传播。
 */
function fail(path, message) {
  throw new Error(`${path} ${message}`);
}

const statuses = new Set(['pending', 'approved', 'rejected', 'blocked']);
const changeKinds = new Set(['mechanical', 'structural', 'factual', 'image']);
const formatCategories = new Set([
  'heading-structure',
  'emphasis-syntax',
  'chinese-punctuation',
  'code-fence-comments',
  'other-format',
]);
const imageDecisions = new Set([
  'preserve-original',
  'markdown-transcription',
  'redraw-candidate',
  'alternate-expression',
  'blocked',
]);
const referencePattern = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * @brief 断言值为非数组的普通对象。
 * @param {*} value - 待检查的值。
 * @param {string} path - 字段路径，用于错误消息。
 * @returns {void}
 * @note 值为 null、undefined、数组或非 object 类型时调用 fail 抛出异常。
 */
function requireObject(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(path, 'must be an object');
  }
}

/**
 * @brief 校验对象仅包含白名单内的键，拒绝未知字段。
 * @param {object} value - 待检查的对象。
 * @param {Set<string>} allowedKeys - 允许的键名集合。
 * @param {string} path - 字段路径前缀。
 * @returns {void}
 * @note 先调用 requireObject；出现未声明键时 fail 并指出具体键名。
 */
function requireOnlyKeys(value, allowedKeys, path) {
  requireObject(value, path);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      fail(`${path}.${key}`, 'is not allowed');
    }
  }
}

/**
 * @brief 断言值为去空白后非空的字符串。
 * @param {*} value - 待检查的值。
 * @param {string} path - 字段路径。
 * @returns {void}
 * @note 不接受纯空白字符串；失败时抛出校验错误。
 */
function requireString(value, path) {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(path, 'must be a non-empty string');
  }
}

/**
 * @brief 断言值为合法且可解析的 ISO-8601 UTC 时间戳字符串。
 * @param {*} value - 待检查的时间戳字符串，如 `2024-01-15T08:30:00Z`。
 * @param {string} path - 字段路径。
 * @returns {void}
 * @note 正则与 Date 解析双重校验，防止无效日历日期；格式不符或日期不真实时 fail。
 */
function requireUtcTimestamp(value, path) {
  requireString(value, path);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/.exec(value);
  if (!match) {
    fail(path, 'must be a valid ISO-8601 UTC date-time');
  }

  const timestamp = new Date(value);
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  if (
    Number.isNaN(timestamp.getTime())
    || timestamp.getUTCFullYear() !== year
    || timestamp.getUTCMonth() + 1 !== month
    || timestamp.getUTCDate() !== day
    || timestamp.getUTCHours() !== hour
    || timestamp.getUTCMinutes() !== minute
    || timestamp.getUTCSeconds() !== second
  ) {
    fail(path, 'must be a valid ISO-8601 UTC date-time');
  }
}

/**
 * @brief 断言值为数组。
 * @param {*} value - 待检查的值。
 * @param {string} path - 字段路径。
 * @returns {void}
 * @note 非数组类型时 fail；不校验数组元素内容或长度。
 */
function requireArray(value, path) {
  if (!Array.isArray(value)) {
    fail(path, 'must be an array');
  }
}

/**
 * @brief 断言字符串值属于给定枚举集合。
 * @param {*} value - 待检查的字符串。
 * @param {Set<string>} allowedValues - 合法取值集合。
 * @param {string} path - 字段路径。
 * @returns {void}
 * @note 先 requireString；值不在集合内时 fail 并列出全部合法选项。
 */
function requireEnum(value, allowedValues, path) {
  requireString(value, path);
  if (!allowedValues.has(value)) {
    fail(path, `must be one of: ${[...allowedValues].join(', ')}`);
  }
}

/**
 * @brief 断言引用标识符符合 `[A-Za-z0-9][A-Za-z0-9_-]*` 模式。
 * @param {*} value - 待检查的 ref 字符串。
 * @param {string} path - 字段路径。
 * @returns {void}
 * @note 用于 sourceSections、outputSections 等交叉引用字段；格式不符时 fail。
 */
function requireReference(value, path) {
  requireString(value, path);
  if (!referencePattern.test(value)) {
    fail(path, 'must match the configured reference pattern');
  }
}

/**
 * @brief 校验 ref 数组非空且每个 ref 均存在于已知源章节集合中。
 * @param {*} refs - 引用标识符数组。
 * @param {Set<string>} sourceRefs - 已注册的 sourceSections.ref 集合。
 * @param {string} path - 字段路径。
 * @returns {void}
 * @note 空数组或引用未知 ref 时 fail；逐项调用 requireReference。
 */
function requireKnownSourceRefs(refs, sourceRefs, path) {
  requireArray(refs, path);
  if (refs.length === 0) {
    fail(path, 'must not be empty');
  }

  for (const ref of refs) {
    requireReference(ref, path);
    if (!sourceRefs.has(ref)) {
      fail(path, `references unknown source section "${ref}"`);
    }
  }
}

/**
 * @brief 校验图片路径以指定目录前缀开头且仅含一个安全文件名。
 * @param {*} value - 仓库相对图片路径。
 * @param {string} prefix - 期望的目录前缀（含尾部 `/`）。
 * @param {string} path - 字段路径。
 * @returns {void}
 * @note 拒绝路径遍历（`..`）、子目录分隔符及空文件名；用于 finalPath 与 cachePath。
 */
function validateImagePath(value, prefix, path) {
  requireString(value, path);
  if (!value.startsWith(prefix)) {
    fail(path, `must start with "${prefix}"`);
  }

  const filename = value.slice(prefix.length);
  if (!filename || filename.includes('/') || filename.includes('\\') || filename === '.' || filename === '..') {
    fail(path, 'must contain one safe filename below its target directory');
  }
}

/**
 * @brief 校验 approval 对象结构并构建 id → 审批项 的索引 Map。
 * @param {object} approval - draft.approval 对象，含 status 与 approvals 数组。
 * @param {string} approvalUserId - 配置的审批用户标识，须与 confirmedBy 一致。
 * @returns {Map<string, object>} 以 approval.id 为键的审批项 Map。
 * @note 校验 status 枚举、UTC 时间戳、id 唯一性；confirmedBy 必须等于 approvalUserId。
 */
function approvalIndex(approval, approvalUserId) {
  requireString(approvalUserId, 'approvalUserId');
  requireOnlyKeys(approval, new Set(['status', 'approvals']), 'approval');
  requireEnum(approval.status, statuses, 'approval.status');
  requireArray(approval.approvals, 'approval.approvals');

  const approvals = new Map();
  for (const [index, item] of approval.approvals.entries()) {
    const path = `approval.approvals[${index}]`;
    requireOnlyKeys(
      item,
      new Set(['id', 'status', 'recordedAt', 'confirmedBy', 'confirmedAt', 'notes']),
      path,
    );
    requireReference(item.id, `${path}.id`);
    requireEnum(item.status, statuses, `${path}.status`);
    requireUtcTimestamp(item.recordedAt, `${path}.recordedAt`);
    requireString(item.confirmedBy, `${path}.confirmedBy`);
    if (item.confirmedBy !== approvalUserId) {
      fail(`${path}.confirmedBy`, 'must equal the configured approval user identifier');
    }
    requireUtcTimestamp(item.confirmedAt, `${path}.confirmedAt`);
    if (item.notes !== undefined) {
      requireString(item.notes, `${path}.notes`);
    }
    if (approvals.has(item.id)) {
      fail(`${path}.id`, 'must be unique');
    }
    approvals.set(item.id, item);
  }

  return approvals;
}

/**
 * @brief 校验变更项的 approvalId 指向已存在的审批对象，且 approved 状态一致。
 * @param {object} item - 含 status 与 approvalId 的 format/content/image 变更项。
 * @param {string} path - 变更项在 draft 中的路径前缀。
 * @param {Map<string, object>} approvals - approvalIndex 返回的审批索引。
 * @returns {void}
 * @note item.status 为 approved 时，对应审批对象 status 也必须为 approved。
 */
function validateApprovalId(item, path, approvals) {
  requireString(item.approvalId, `${path}.approvalId`);
  const approval = approvals.get(item.approvalId);
  if (!approval) {
    fail(`${path}.approvalId`, 'must reference an explicit approval object');
  }
  if (item.status === 'approved' && approval.status !== 'approved') {
    fail(`${path}.approvalId`, 'must reference an approved approval object');
  }
}

/**
 * @brief 校验 sourceSections 数组的结构、唯一 ref 与非空 headingPath。
 * @param {object[]} sourceSections - 有道源章节元数据数组。
 * @returns {Set<string>} 所有合法 source.ref 集合，供后续交叉引用校验。
 * @note 数组不能为空；ref 必须唯一；每项含 ref、id、title、headingPath。
 */
function validateSourceSections(sourceSections) {
  requireArray(sourceSections, 'sourceSections');
  if (sourceSections.length === 0) {
    fail('sourceSections', 'must not be empty');
  }

  const refs = new Set();
  for (const [index, source] of sourceSections.entries()) {
    const path = `sourceSections[${index}]`;
    requireOnlyKeys(source, new Set(['ref', 'id', 'title', 'headingPath']), path);
    requireReference(source.ref, `${path}.ref`);
    requireString(source.id, `${path}.id`);
    requireString(source.title, `${path}.title`);
    requireArray(source.headingPath, `${path}.headingPath`);
    if (source.headingPath.length === 0) {
      fail(`${path}.headingPath`, 'must not be empty');
    }
    for (const [headingIndex, heading] of source.headingPath.entries()) {
      requireString(heading, `${path}.headingPath[${headingIndex}]`);
    }
    if (refs.has(source.ref)) {
      fail(`${path}.ref`, 'must be unique');
    }
    refs.add(source.ref);
  }

  return refs;
}

/**
 * @brief 校验 outputSections 及其段落对源章节的引用关系。
 * @param {object[]} outputSections - 输出章节数组，含 ref、sourceSectionRefs、paragraphs。
 * @param {Set<string>} sourceRefs - validateSourceSections 返回的合法 ref 集合。
 * @returns {void}
 * @note outputSections.ref 须唯一；段落 sourceSectionRefs 须非空且引用已知 ref。
 */
function validateOutputSections(outputSections, sourceRefs) {
  requireArray(outputSections, 'outputSections');
  if (outputSections.length === 0) {
    fail('outputSections', 'must not be empty');
  }

  const outputRefs = new Set();
  for (const [index, section] of outputSections.entries()) {
    const path = `outputSections[${index}]`;
    requireOnlyKeys(section, new Set(['ref', 'sourceSectionRefs', 'paragraphs']), path);
    requireReference(section.ref, `${path}.ref`);
    requireKnownSourceRefs(section.sourceSectionRefs, sourceRefs, `${path}.sourceSectionRefs`);
    requireArray(section.paragraphs, `${path}.paragraphs`);
    if (outputRefs.has(section.ref)) {
      fail(`${path}.ref`, 'must be unique');
    }
    outputRefs.add(section.ref);

    for (const [paragraphIndex, paragraph] of section.paragraphs.entries()) {
      const paragraphPath = `${path}.paragraphs[${paragraphIndex}]`;
      requireOnlyKeys(paragraph, new Set(['ref', 'sourceSectionRefs']), paragraphPath);
      requireReference(paragraph.ref, `${paragraphPath}.ref`);
      requireKnownSourceRefs(
        paragraph.sourceSectionRefs,
        sourceRefs,
        `${paragraphPath}.sourceSectionRefs`,
      );
    }
  }
}

/**
 * @brief 校验 target 发布目标的路径、slug 格式与派生路径一致性。
 * @param {object} target - 含 title、categorySlug、topicSlug、articleSlug、markdownPath、imageDir。
 * @param {object} [options] - 可选路径根配置。
 * @param {string} [options.contentRoot='content/notes'] - Markdown 内容根目录。
 * @param {string} [options.imageRoot='static/images/notes'] - 图片静态资源根目录。
 * @returns {{ expectedImageDir: string }} 期望的 imageDir 值，供 images 校验使用。
 * @note slug 须为小写 kebab-case；markdownPath 与 imageDir 须与 slug 派生路径完全匹配。
 */
function validateTarget(
  target,
  { contentRoot = 'content/notes', imageRoot = 'static/images/notes' } = {},
) {
  requireOnlyKeys(
    target,
    new Set(['title', 'categorySlug', 'topicSlug', 'articleSlug', 'markdownPath', 'imageDir']),
    'target',
  );
  requireString(target.title, 'target.title');
  requireString(target.categorySlug, 'target.categorySlug');
  requireString(target.topicSlug, 'target.topicSlug');
  requireString(target.articleSlug, 'target.articleSlug');
  if (!slugPattern.test(target.categorySlug)) {
    fail('target.categorySlug', 'must be a lowercase kebab-case slug');
  }
  if (!slugPattern.test(target.topicSlug)) {
    fail('target.topicSlug', 'must be a lowercase kebab-case slug');
  }
  if (!slugPattern.test(target.articleSlug)) {
    fail('target.articleSlug', 'must be a lowercase kebab-case slug');
  }

  const expectedMarkdownPath =
    `${contentRoot}/${target.categorySlug}/${target.topicSlug}/${target.articleSlug}.md`;
  const expectedImageDir =
    `${imageRoot}/${target.categorySlug}/${target.topicSlug}/${target.articleSlug}`;
  if (target.markdownPath !== expectedMarkdownPath) {
    fail('target.markdownPath', `must equal "${expectedMarkdownPath}"`);
  }
  if (target.imageDir !== expectedImageDir) {
    fail('target.imageDir', `must equal "${expectedImageDir}"`);
  }

  return { expectedImageDir };
}

/**
 * @brief 校验草稿图片 cachePath 位于 original 或 generated 缓存子目录下。
 * @param {*} value - cachePath 字符串。
 * @param {object} target - draft.target，用于推导缓存基路径。
 * @param {string} contentRoot - 内容根目录，默认 `content/notes`。
 * @param {string} path - 字段路径。
 * @returns {void}
 * @note 路径前缀为 `.tmp/{contentRoot}/{category}/{topic}/{article}/images/{original|generated}/`。
 */
function validateCacheImagePath(value, target, contentRoot, path) {
  const cacheImageBase =
    `.tmp/${contentRoot}/${target.categorySlug}/${target.topicSlug}/${target.articleSlug}/images/`;
  const originalPrefix = `${cacheImageBase}original/`;
  const generatedPrefix = `${cacheImageBase}generated/`;
  if (typeof value === 'string' && value.startsWith(originalPrefix)) {
    validateImagePath(value, originalPrefix, path);
    return;
  }
  if (typeof value === 'string' && value.startsWith(generatedPrefix)) {
    validateImagePath(value, generatedPrefix, path);
    return;
  }
  fail(path, `must start with "${originalPrefix}" or "${generatedPrefix}"`);
}

/**
 * @brief 校验 formatChanges 数组的结构、枚举值与审批关联。
 * @param {object[]} formatChanges - 格式变更记录数组。
 * @param {Map<string, object>} approvals - approvalIndex 返回的审批索引。
 * @returns {void}
 * @note 每条 formatChange 的 approvalId 须唯一，禁止多条共享同一审批 id。
 */
function validateFormatChanges(formatChanges, approvals) {
  requireArray(formatChanges, 'formatChanges');
  const formatApprovalIds = new Set();
  for (const [index, change] of formatChanges.entries()) {
    const path = `formatChanges[${index}]`;
    requireOnlyKeys(
      change,
      new Set(['category', 'location', 'sourceExcerpt', 'reason', 'status', 'approvalId']),
      path,
    );
    requireEnum(change.category, formatCategories, `${path}.category`);
    requireString(change.location, `${path}.location`);
    requireString(change.sourceExcerpt, `${path}.sourceExcerpt`);
    requireString(change.reason, `${path}.reason`);
    requireEnum(change.status, statuses, `${path}.status`);
    validateApprovalId(change, path, approvals);
    if (formatApprovalIds.has(change.approvalId)) {
      fail(`${path}.approvalId`, 'must be unique per format change; batch-shared format approvals are not allowed');
    }
    formatApprovalIds.add(change.approvalId);
  }
}

/**
 * @brief 校验迁移草稿 JSON 元数据的完整结构与交叉引用一致性。
 * @param {object} draft - 迁移草稿对象，含 sourceSections、outputSections、formatChanges 等。
 * @param {object} [options={}] - 校验选项。
 * @param {string} [options.contentRoot] - 内容根目录，默认 `content/notes`。
 * @param {string} [options.imageRoot] - 图片根目录，默认 `static/images/notes`。
 * @param {string} options.approvalUserId - 审批用户标识，approval 校验必需。
 * @returns {true} 校验通过时返回 true。
 * @note 不校验 Markdown 正文；失败时抛出 Error；contentChanges 须含 frontMatter: true 的非机械变更。
 */
export function validateDraftMetadata(draft, options = {}) {
  requireOnlyKeys(
    draft,
    new Set([
      'sourceSections',
      'outputSections',
      'formatChanges',
      'contentChanges',
      'images',
      'target',
      'approval',
    ]),
    'draft',
  );
  const sourceRefs = validateSourceSections(draft.sourceSections);
  validateOutputSections(draft.outputSections, sourceRefs);
  const contentRoot = options.contentRoot ?? 'content/notes';
  const { expectedImageDir } = validateTarget(draft.target, options);
  const approvals = approvalIndex(draft.approval, options.approvalUserId);

  validateFormatChanges(draft.formatChanges, approvals);

  requireArray(draft.contentChanges, 'contentChanges');
  let hasFrontMatterChange = false;
  for (const [index, change] of draft.contentChanges.entries()) {
    const path = `contentChanges[${index}]`;
    requireOnlyKeys(
      change,
      new Set(['kind', 'reason', 'status', 'sourceSectionRefs', 'frontMatter', 'approvalId']),
      path,
    );
    requireEnum(change.kind, changeKinds, `${path}.kind`);
    requireString(change.reason, `${path}.reason`);
    requireEnum(change.status, statuses, `${path}.status`);
    requireKnownSourceRefs(change.sourceSectionRefs, sourceRefs, `${path}.sourceSectionRefs`);
    if (change.frontMatter !== undefined) {
      if (change.frontMatter !== true) {
        fail(`${path}.frontMatter`, 'must be true when present');
      }
      if (change.kind === 'mechanical') {
        fail(`${path}.frontMatter`, 'must be a non-mechanical content change');
      }
      hasFrontMatterChange = true;
    }
    if (change.kind !== 'mechanical') {
      validateApprovalId(change, path, approvals);
    }
  }
  if (!hasFrontMatterChange) {
    fail('contentChanges', 'must include a non-mechanical Front Matter change with frontMatter: true');
  }

  requireArray(draft.images, 'images');
  const imageApprovalIds = new Set();
  for (const [index, image] of draft.images.entries()) {
    const path = `images[${index}]`;
    requireOnlyKeys(
      image,
      new Set([
        'source',
        'cachePath',
        'finalPath',
        'sourceSectionRef',
        'decision',
        'status',
        'approvalId',
        'expressionForm',
      ]),
      path,
    );
    requireString(image.source, `${path}.source`);
    requireReference(image.sourceSectionRef, `${path}.sourceSectionRef`);
    if (!sourceRefs.has(image.sourceSectionRef)) {
      fail(`${path}.sourceSectionRef`, 'must reference a source section');
    }
    requireEnum(image.decision, imageDecisions, `${path}.decision`);
    requireEnum(image.status, statuses, `${path}.status`);
    validateImagePath(image.finalPath, `${expectedImageDir}/`, `${path}.finalPath`);
    validateCacheImagePath(image.cachePath, draft.target, contentRoot, `${path}.cachePath`);
    validateApprovalId(image, path, approvals);
    if (imageApprovalIds.has(image.approvalId)) {
      fail(`${path}.approvalId`, 'must be unique per image; batch-shared image approvals are not allowed');
    }
    imageApprovalIds.add(image.approvalId);
    if (image.decision === 'alternate-expression') {
      requireString(image.expressionForm, `${path}.expressionForm`);
    } else if (image.expressionForm !== undefined) {
      fail(`${path}.expressionForm`, 'is only allowed when decision is alternate-expression');
    }
  }

  return true;
}

/**
 * @brief 从 Markdown 开头解析 YAML front matter 为字段 Map。
 * @param {string} markdown - 完整 Markdown 文本。
 * @returns {Map<string, string|string[]>} 键为字段名，值为标量字符串或列表项数组。
 * @note 缺少 `---` 包裹块时 fail；支持标量行与 `-` 列表两种 YAML 子集。
 */
function parseFrontMatter(markdown) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  if (!match) {
    fail('front matter', 'must be a YAML block at the start of Markdown');
  }

  const fields = new Map();
  const lines = match[1].split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const field = /^([A-Za-z][A-Za-z0-9_-]*):(?:\s*(.*))?$/.exec(lines[index]);
    if (!field) {
      continue;
    }
    const [, key, value = ''] = field;
    if (value !== '') {
      fields.set(key, value.trim());
      continue;
    }

    const values = [];
    while (index + 1 < lines.length) {
      const item = /^\s*-\s+(.+)$/.exec(lines[index + 1]);
      if (!item) {
        break;
      }
      values.push(item[1].trim());
      index += 1;
    }
    fields.set(key, values);
  }

  return fields;
}

/**
 * @brief 从 front matter 字段 Map 中读取已确认的非空标量值。
 * @param {Map<string, string|string[]>} fields - parseFrontMatter 返回的字段 Map。
 * @param {string} key - front matter 键名。
 * @returns {string} 去空白后的标量字符串。
 * @note 值为数组或空字符串时 fail；用于 title、date、weight 等必填标量。
 */
function requireFrontMatterScalar(fields, key) {
  const value = fields.get(key);
  if (typeof value !== 'string' || value.trim() === '') {
    fail(`front matter.${key}`, 'must be a confirmed non-empty scalar');
  }
  return value;
}

/**
 * @brief 校验 Markdown front matter 与 draft.target 及站点约定一致。
 * @param {string} markdown - 待发布的 Markdown 正文。
 * @param {object} draft - 已通过元数据校验的迁移草稿。
 * @returns {void}
 * @note 校验 title、date、draft:false、categories、tags、type:note、weight、description；与 target 字段对齐。
 */
function validateFrontMatter(markdown, draft) {
  const fields = parseFrontMatter(markdown);
  const title = requireFrontMatterScalar(fields, 'title').replace(/^"(.*)"$/, '$1');
  if (title !== draft.target.title) {
    fail('front matter.title', 'must equal the approved target title');
  }
  requireFrontMatterScalar(fields, 'date');
  if (fields.get('draft') !== 'false') {
    fail('front matter.draft', 'must be false');
  }
  for (const key of ['categories', 'tags']) {
    const value = fields.get(key);
    if (!Array.isArray(value) || value.length === 0) {
      fail(`front matter.${key}`, 'must be a non-empty confirmed list');
    }
  }
  if (fields.get('categories')[0]?.replace(/^"(.*)"$/, '$1') !== draft.target.categorySlug) {
    fail('front matter.categories[0]', 'must equal the approved target category slug');
  }
  if (fields.get('type')?.replace(/^"(.*)"$/, '$1') !== 'note') {
    fail('front matter.type', 'must be note');
  }
  const weight = Number(requireFrontMatterScalar(fields, 'weight'));
  if (!Number.isInteger(weight) || weight < 1) {
    fail('front matter.weight', 'must be a positive integer');
  }
  requireFrontMatterScalar(fields, 'description');
}

/**
 * @brief 校验 Markdown 标题层级与连续编号规则（H2–H4，禁止 H1 与 H5+）。
 * @param {string} markdown - 待校验的 Markdown 正文。
 * @returns {void}
 * @note H2 从 1 递增；H3/H4 须匹配父级前缀且同级序号连续；至少须有一个 H2。
 */
function validateHeadingNumbers(markdown) {
  const nextSection = { value: 1 };
  const subsectionCounts = new Map();
  const subsubsectionCounts = new Map();
  let currentSection;
  let currentSubsection;

  for (const line of markdown.split(/\r?\n/)) {
    if (/^# /.test(line)) {
      fail('markdown', 'must not contain an H1');
    }
    if (/^#{5,} /.test(line)) {
      fail('markdown', 'must not contain headings deeper than H4');
    }
    const heading = /^(##|###|####) (\d+(?:\.\d+){0,2})\. (.+)$/.exec(line);
    if (!heading) {
      if (/^(##|###|####) /.test(line)) {
        fail('markdown heading', 'must use a numbered heading');
      }
      continue;
    }

    const [, level, number] = heading;
    const parts = number.split('.').map(Number);
    if (level === '##') {
      if (parts.length !== 1 || parts[0] !== nextSection.value) {
        fail('markdown heading', 'has a non-consecutive H2 number');
      }
      currentSection = parts[0];
      currentSubsection = undefined;
      nextSection.value += 1;
      continue;
    }
    if (level === '###') {
      const expected = subsectionCounts.get(currentSection) ?? 1;
      if (
        currentSection === undefined
        || parts.length !== 2
        || parts[0] !== currentSection
        || parts[1] !== expected
      ) {
        fail('markdown heading', 'has an invalid H3 parent prefix or sibling number');
      }
      subsectionCounts.set(currentSection, expected + 1);
      currentSubsection = parts[1];
      continue;
    }

    const parentKey = `${currentSection}.${currentSubsection}`;
    const expected = subsubsectionCounts.get(parentKey) ?? 1;
    if (
      currentSection === undefined
      || currentSubsection === undefined
      || parts.length !== 3
      || parts[0] !== currentSection
      || parts[1] !== currentSubsection
      || parts[2] !== expected
    ) {
      fail('markdown heading', 'has an invalid H4 parent prefix or sibling number');
    }
    subsubsectionCounts.set(parentKey, expected + 1);
  }

  if (nextSection.value === 1) {
    fail('markdown heading', 'must contain a numbered H2 heading');
  }
}

/**
 * @brief 要求 draft 中存在指定 category 且已 approved 的 formatChanges 及对应审批。
 * @param {object} draft - 迁移草稿。
 * @param {string} category - formatChanges.category 枚举值，如 `heading-structure`。
 * @param {string} pathLabel - 失败时的逻辑路径标签。
 * @param {string} messageWhenMissing - 缺少 approved 条目时的错误消息。
 * @returns {void}
 * @note 用于格式门禁：检测到问题时须已有用户批准的 formatChange 记录。
 */
function requireApprovedFormatGate(draft, category, pathLabel, messageWhenMissing) {
  const change = draft.formatChanges.find(
    (entry) => entry.category === category && entry.status === 'approved',
  );
  if (!change) {
    fail(pathLabel, messageWhenMissing);
  }
  if (draft.approval.approvals.find((approval) => approval.id === change.approvalId)?.status !== 'approved') {
    fail(
      `formatChanges ${category}.approvalId`,
      `must reference an approved approval object when ${category} issues remain`,
    );
  }
}

/**
 * @brief 若存在未修复的顶层标题结构问题，则要求已批准的 heading-structure 格式变更。
 * @param {string} markdown - Markdown 正文。
 * @param {object} draft - 迁移草稿。
 * @returns {void}
 * @note 覆盖唯一顶层 `##` 与多顶层空壳；有已批准记录即可过门禁（不要求稿已改完）。
 */
function validateTopLevelHeadingStructure(markdown, draft) {
  if (!hasUnfixedTopLevelHeadingShell(markdown)) {
    return;
  }

  requireApprovedFormatGate(
    draft,
    'heading-structure',
    'markdown heading-structure',
    'sole top-level ## or top-level ## shell requires an approved formatChanges entry with category heading-structure',
  );
}

/**
 * @brief 若存在强调语法问题，则要求已批准的 emphasis-syntax 格式变更。
 * @param {string} markdown - Markdown 正文。
 * @param {object} draft - 迁移草稿。
 * @returns {void}
 * @note 检测未闭合强调或标点贴靠标记；无问题时跳过。
 */
function validateEmphasisSyntax(markdown, draft) {
  if (!hasEmphasisSyntaxIssues(markdown)) {
    return;
  }

  requireApprovedFormatGate(
    draft,
    'emphasis-syntax',
    'markdown emphasis-syntax',
    'broken emphasis (punctuation against markers or unclosed * /** / _ / __) requires an approved formatChanges entry with category emphasis-syntax',
  );
}

/**
 * @brief 若存在中文语境下的 ASCII 标点问题，则要求已批准的 chinese-punctuation 格式变更。
 * @param {string} markdown - Markdown 正文。
 * @param {object} draft - 迁移草稿。
 * @returns {void}
 * @note 无问题时跳过；有问题时须已有对应 approved formatChange。
 */
function validateChinesePunctuation(markdown, draft) {
  if (!hasChinesePunctuationIssues(markdown)) {
    return;
  }

  requireApprovedFormatGate(
    draft,
    'chinese-punctuation',
    'markdown chinese-punctuation',
    'ASCII sentence punctuation in Chinese prose requires an approved formatChanges entry with category chinese-punctuation',
  );
}

/**
 * @brief 若代码块内存在类 prose 注释行，则要求已批准的 code-fence-comments 格式变更。
 * @param {string} markdown - Markdown 正文。
 * @param {object} draft - 迁移草稿。
 * @returns {void}
 * @note 无问题时跳过；有问题时须已有对应 approved formatChange。
 */
function validateCodeFenceComments(markdown, draft) {
  if (!hasCodeFenceCommentIssues(markdown)) {
    return;
  }

  requireApprovedFormatGate(
    draft,
    'code-fence-comments',
    'markdown code-fence-comments',
    'prose-like annotation lines inside code fences require an approved formatChanges entry with category code-fence-comments',
  );
}

/**
 * @brief 在元数据校验基础上，校验 Markdown 输出可发布（审批、格式、图片引用一致）。
 * @param {object} draft - 迁移草稿 JSON。
 * @param {string} markdown - 待发布的 Markdown 正文。
 * @param {object} options - 同 validateDraftMetadata 的 options。
 * @returns {true} 全部校验通过时返回 true。
 * @note 要求 approval 及所有非 mechanical 变更均为 approved；Markdown 图片路径须与 draft.images 双向一致。
 */
export function validateDraftOutput(draft, markdown, options) {
  validateDraftMetadata(draft, options);
  requireString(markdown, 'markdown');
  if (draft.approval.status !== 'approved') {
    fail('approval.status', 'must be approved before emitting Markdown');
  }
  for (const [index, change] of draft.formatChanges.entries()) {
    if (change.status !== 'approved') {
      fail(`formatChanges[${index}].status`, 'must be approved before emitting Markdown');
    }
    if (draft.approval.approvals.find((approval) => approval.id === change.approvalId)?.status !== 'approved') {
      fail(`formatChanges[${index}].approvalId`, 'must reference an approved approval object');
    }
  }
  for (const [index, change] of draft.contentChanges.entries()) {
    if (change.kind !== 'mechanical' && change.status !== 'approved') {
      fail(`contentChanges[${index}].status`, 'must be approved before emitting Markdown');
    }
  }
  for (const [index, image] of draft.images.entries()) {
    if (image.status !== 'approved') {
      fail(`images[${index}].status`, 'must be approved before emitting Markdown');
    }
    if (draft.approval.approvals.find((approval) => approval.id === image.approvalId)?.status !== 'approved') {
      fail(`images[${index}].approvalId`, 'must reference an approved approval object');
    }
  }
  validateFrontMatter(markdown, draft);
  if (/<img\b/i.test(markdown)) {
    fail('markdown', 'must not contain HTML img elements');
  }
  validateHeadingNumbers(markdown);
  validateTopLevelHeadingStructure(markdown, draft);
  validateEmphasisSyntax(markdown, draft);
  validateChinesePunctuation(markdown, draft);
  validateCodeFenceComments(markdown, draft);

  const expectedImagePaths = new Set(
    draft.images.map((image) => `/${image.finalPath.slice('static/'.length)}`),
  );
  const markdownImagePaths = [...markdown.matchAll(/!\[[^\]]*]\(([^)\s]+)(?:\s+[^)]*)?\)/g)]
    .map((match) => match[1]);
  for (const imagePath of markdownImagePaths) {
    if (!expectedImagePaths.has(imagePath)) {
      fail('markdown', `references an unapproved image path "${imagePath}"`);
    }
  }
  for (const imagePath of expectedImagePaths) {
    if (!markdownImagePaths.includes(imagePath)) {
      fail('markdown', `does not reference approved image path "${imagePath}"`);
    }
  }

  return true;
}
