function fail(path, message) {
  throw new Error(`${path} ${message}`);
}

const statuses = new Set(['pending', 'approved', 'rejected', 'blocked']);
const changeKinds = new Set(['mechanical', 'structural', 'factual', 'image']);
const imageDecisions = new Set([
  'preserve-original',
  'markdown-transcription',
  'redraw-candidate',
  'blocked',
]);
const referencePattern = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function requireObject(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(path, 'must be an object');
  }
}

function requireOnlyKeys(value, allowedKeys, path) {
  requireObject(value, path);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      fail(`${path}.${key}`, 'is not allowed');
    }
  }
}

function requireString(value, path) {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(path, 'must be a non-empty string');
  }
}

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

function requireArray(value, path) {
  if (!Array.isArray(value)) {
    fail(path, 'must be an array');
  }
}

function requireEnum(value, allowedValues, path) {
  requireString(value, path);
  if (!allowedValues.has(value)) {
    fail(path, `must be one of: ${[...allowedValues].join(', ')}`);
  }
}

function requireReference(value, path) {
  requireString(value, path);
  if (!referencePattern.test(value)) {
    fail(path, 'must match the configured reference pattern');
  }
}

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
  const expectedImageDir = `${imageRoot}/${target.categorySlug}/${target.articleSlug}`;
  if (target.markdownPath !== expectedMarkdownPath) {
    fail('target.markdownPath', `must equal "${expectedMarkdownPath}"`);
  }
  if (target.imageDir !== expectedImageDir) {
    fail('target.imageDir', `must equal "${expectedImageDir}"`);
  }

  return { expectedImageDir };
}

export function validateDraftMetadata(draft, options = {}) {
  requireOnlyKeys(
    draft,
    new Set([
      'sourceSections',
      'outputSections',
      'contentChanges',
      'images',
      'target',
      'approval',
    ]),
    'draft',
  );
  const sourceRefs = validateSourceSections(draft.sourceSections);
  validateOutputSections(draft.outputSections, sourceRefs);
  const { expectedImageDir } = validateTarget(draft.target, options);
  const approvals = approvalIndex(draft.approval, options.approvalUserId);

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
    validateImagePath(image.cachePath, `.tmp/${expectedImageDir}/`, `${path}.cachePath`);
    validateApprovalId(image, path, approvals);
  }

  return true;
}

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

function requireFrontMatterScalar(fields, key) {
  const value = fields.get(key);
  if (typeof value !== 'string' || value.trim() === '') {
    fail(`front matter.${key}`, 'must be a confirmed non-empty scalar');
  }
  return value;
}

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

export function validateDraftOutput(draft, markdown, options) {
  validateDraftMetadata(draft, options);
  requireString(markdown, 'markdown');
  if (draft.approval.status !== 'approved') {
    fail('approval.status', 'must be approved before emitting Markdown');
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
