import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

import { cacheNote, cachePublicShare } from './cache.mjs';
import { validateDraftOutput } from './draft-validator.mjs';
import { extractImages, parseSearchCandidates } from './images.mjs';
import { buildMigrationPaths, loadRules } from './paths.mjs';
import { readPublicShare } from './public-share.mjs';
import {
  assertSafeMarkdownLinks,
  checkGitReadiness,
  checkSite,
  runProcess,
} from './quality-gates.mjs';
import { preflightYoudao, readYoudaoNote, searchYoudao } from './youdao.mjs';

function parseOptions(
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

function writeJson(write, value) {
  write(`${JSON.stringify(value, null, 2)}\n`);
}

function isOutsideRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

function resolveReadPath(repoRoot, relativePath, label) {
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

function resolveRelativePath(repoRoot, relativePath, label) {
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

function readDraftValidationInputs(repoRoot, options) {
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

function requireDirectory(pathInfo, label) {
  if (!statSync(pathInfo.absolutePath).isDirectory()) {
    throw new Error(`${label} must be a directory.`);
  }
}

function resolveRequiredPath(repoRoot, relativePath, label) {
  try {
    return resolveReadPath(repoRoot, relativePath, label);
  } catch {
    throw new Error(`${label} must exist under the repository root.`);
  }
}

function summarizeDraftValidation({ draft, draftPath, markdownPath }) {
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
      contentChanges: draft.contentChanges.length,
      images: draft.images.length,
    },
  };
}

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

function sha256(pathInfo) {
  return createHash('sha256').update(readFileSync(pathInfo.absolutePath)).digest('hex');
}

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

function checkNote(repoRoot, options) {
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

export async function runCli(
  argumentsList,
  {
    repoRoot = process.cwd(),
    dependencies = {},
    write = (value) => process.stdout.write(value),
  } = {},
) {
  const [command, ...argumentsAfterCommand] = argumentsList;
  const services = {
    preflight: dependencies.preflight ?? preflightYoudao,
    search: dependencies.search ?? searchYoudao,
    read: dependencies.read ?? readYoudaoNote,
    cache: dependencies.cache ?? cacheNote,
    readShare: dependencies.readShare ?? readPublicShare,
    cacheShare: dependencies.cacheShare ?? cachePublicShare,
    runProcess: dependencies.runProcess ?? runProcess,
  };

  if (command === 'paths') {
    const options = parseOptions(argumentsAfterCommand, {
      valueFlags: ['--category', '--topic', '--article'],
      usage: 'Usage: paths --category <slug> --topic <slug> --article <slug>',
    });
    const rules = loadRules(repoRoot);
    writeJson(
      write,
      buildMigrationPaths(rules, {
        categorySlug: options['--category'],
        topicSlug: options['--topic'],
        articleSlug: options['--article'],
      }),
    );
    return;
  }

  if (command === 'validate-draft') {
    const options = parseOptions(argumentsAfterCommand, {
      valueFlags: ['--draft', '--markdown'],
      usage: 'Usage: validate-draft --draft <relative-json> --markdown <relative-md>',
    });
    const { draft, draftPath, markdown, markdownPath } = readDraftValidationInputs(repoRoot, options);
    const rules = loadRules(repoRoot);
    validateDraftOutput(draft, markdown, rules);
    writeJson(write, summarizeDraftValidation({ draft, draftPath, markdownPath }));
    return;
  }

  if (command === 'check-note') {
    const usage =
      'Usage: check-note --draft <relative-json> --approved-markdown <relative-md> --category <slug> --topic <slug> --article <slug> [--content-dir <relative-dir>] [--image-dir <relative-dir>]';
    const options = parseOptions(argumentsAfterCommand, {
      valueFlags: ['--draft', '--approved-markdown', '--category', '--topic', '--article'],
      optionalValueFlags: ['--content-dir', '--image-dir'],
      usage,
    });
    writeJson(
      write,
      checkNote(repoRoot, { ...options, '--markdown': options['--approved-markdown'] }),
    );
    return;
  }

  if (command === 'check-site') {
    if (argumentsAfterCommand.length !== 0) {
      throw new Error('Usage: check-site');
    }
    writeJson(write, await checkSite({ repoRoot, run: services.runProcess }));
    return;
  }

  if (command === 'git-readiness') {
    const usage =
      'Usage: git-readiness --category <slug> --topic <slug> --article <slug> [--allow <relative-path> ...]';
    const options = parseOptions(argumentsAfterCommand, {
      valueFlags: ['--category', '--topic', '--article'],
      repeatableValueFlags: ['--allow'],
      usage,
    });
    const rules = loadRules(repoRoot);
    const paths = buildMigrationPaths(rules, {
      categorySlug: options['--category'],
      topicSlug: options['--topic'],
      articleSlug: options['--article'],
    });
    const explicitAllowPaths = new Set(
      (options['--allow'] ?? []).map((allowPath) =>
        resolveRelativePath(repoRoot, allowPath, 'allow'),
      ),
    );
    writeJson(
      write,
      await checkGitReadiness({
        repoRoot,
        categorySlug: options['--category'],
        topicSlug: options['--topic'],
        articleSlug: options['--article'],
        markdownPath: `${paths.contentDir}/${options['--article']}.md`,
        imageDir: paths.imageDir,
        explicitAllowPaths,
        run: services.runProcess,
      }),
    );
    return;
  }

  if (command === 'preflight') {
    if (argumentsAfterCommand.length !== 0) {
      throw new Error('Usage: preflight');
    }

    writeJson(write, await services.preflight());
    return;
  }

  if (command === 'search') {
    const options = parseOptions(argumentsAfterCommand, {
      valueFlags: ['--title'],
      usage: 'Usage: search --title <query>',
    });
    const result = await services.search(options['--title']);
    writeJson(write, parseSearchCandidates(result.stdout));
    return;
  }

  if (command === 'cache') {
    const usage = 'Usage: cache --id <fileId> --category <categorySlug> --topic <topicSlug> --article <articleSlug> --confirmed';
    const options = parseOptions(argumentsAfterCommand, {
      valueFlags: ['--id', '--category', '--topic', '--article'],
      booleanFlags: ['--confirmed'],
      usage,
    });
    if (!options['--confirmed']) {
      throw new Error(usage);
    }

    const rules = loadRules(repoRoot);
    const readNote = await services.read(options['--id']);
    const result = await services.cache({
      repoRoot,
      rules,
      categorySlug: options['--category'],
      topicSlug: options['--topic'],
      articleSlug: options['--article'],
      note: {
        id: options['--id'],
        ...readNote,
      },
    });
    writeJson(write, result);
    return;
  }

  if (command === 'share-info') {
    const options = parseOptions(argumentsAfterCommand, {
      valueFlags: ['--share-id'],
      usage: 'Usage: share-info --share-id <shareId>',
    });
    const share = await services.readShare(options['--share-id']);
    writeJson(write, {
      title: share.title,
      shareId: share.shareId,
      imageCount: extractImages(share.content).length,
    });
    return;
  }

  if (command === 'cache-share') {
    const usage = 'Usage: cache-share --share-id <shareId> --category <categorySlug> --topic <topicSlug> --article <articleSlug> --confirmed';
    const options = parseOptions(argumentsAfterCommand, {
      valueFlags: ['--share-id', '--category', '--topic', '--article'],
      booleanFlags: ['--confirmed'],
      usage,
    });
    if (!options['--confirmed']) {
      throw new Error(usage);
    }

    const rules = loadRules(repoRoot);
    const share = await services.readShare(options['--share-id']);
    const result = await services.cacheShare({
      repoRoot,
      rules,
      categorySlug: options['--category'],
      topicSlug: options['--topic'],
      articleSlug: options['--article'],
      share,
    });
    writeJson(write, result);
    return;
  }

  throw new Error(`Unknown command: ${command ?? '(missing)'}.`);
}
