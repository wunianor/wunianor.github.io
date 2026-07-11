import { createHash, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { lstat, mkdir, readFile, readdir, rename, rm, rmdir, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import path from 'node:path';

import { extractImages } from './images.mjs';
import { isGloballyRoutableAddress } from './network.mjs';
import { buildMigrationPaths } from './paths.mjs';
import { assertShareId } from './public-share.mjs';

export const CACHE_LOCK_TTL_MS = 15 * 60 * 1000;

function isValidOwnerMetadata(owner) {
  return (
    typeof owner?.token === 'string' &&
    owner.token.length > 0 &&
    Number.isSafeInteger(owner.pid) &&
    owner.pid > 0 &&
    (
      (typeof owner.createdAt === 'number' && Number.isFinite(owner.createdAt) && owner.createdAt > 0) ||
      (typeof owner.createdAt === 'string' && !Number.isNaN(Date.parse(owner.createdAt)))
    )
  );
}

function resolveCachePath(repoRoot, relativePath) {
  if (
    path.isAbsolute(relativePath) ||
    path.posix.isAbsolute(relativePath) ||
    path.win32.isAbsolute(relativePath) ||
    relativePath.split(/[\\/]+/).includes('..')
  ) {
    throw new Error('Cache path must be a validated repository-relative path.');
  }

  const root = path.resolve(repoRoot);
  const resolved = path.resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error('Cache path must stay within the repository.');
  }

  return resolved;
}

function toPosixPath(...segments) {
  return path.join(...segments).replaceAll('\\', '/');
}

function imageExtension(sourceUrl) {
  const extension = path.posix.extname(new URL(sourceUrl).pathname).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(extension) ? extension : '.bin';
}

function safeDisplayUrl(sourceUrl) {
  const url = new URL(sourceUrl);
  return `${url.protocol}//${url.host.replace(/^[^@]*@/, '')}${url.pathname}`;
}

async function resolvePublicImageAddress(sourceUrl, resolveHost) {
  const url = new URL(sourceUrl);
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (hostname === 'localhost' || hostname.endsWith('.local') || isIP(hostname)) {
    if (!isGloballyRoutableAddress(hostname)) {
      throw new Error(`Image URL host must resolve to a public address: ${hostname}.`);
    }
    return hostname;
  }

  const results = await resolveHost(hostname);
  const addresses = Array.isArray(results) ? results : [results];
  if (
    addresses.length === 0 ||
    addresses.some(
      (result) => !isGloballyRoutableAddress(typeof result === 'string' ? result : result.address),
    )
  ) {
    throw new Error(`Image URL host must resolve to a public address: ${hostname}.`);
  }
  return typeof addresses[0] === 'string' ? addresses[0] : addresses[0].address;
}

async function responseBytes(response, maxResponseBytes) {
  const contentLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxResponseBytes) {
    throw new Error(`Image response is too large (maximum ${maxResponseBytes} bytes).`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maxResponseBytes) {
    throw new Error(`Image response is too large (maximum ${maxResponseBytes} bytes).`);
  }
  return bytes;
}

async function streamBytes(response, maxResponseBytes) {
  const contentLength = Number(response.headers?.['content-length']);
  if (Number.isFinite(contentLength) && contentLength > maxResponseBytes) {
    response.abort?.();
    throw new Error(`Image response is too large (maximum ${maxResponseBytes} bytes).`);
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of response.stream) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > maxResponseBytes) {
      const error = new Error(`Image response is too large (maximum ${maxResponseBytes} bytes).`);
      response.stream.destroy?.(error);
      response.abort?.(error);
      throw error;
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function redirectLocation(response) {
  const headers = response.headers;
  if (typeof headers?.get === 'function') {
    return headers.get('location');
  }
  return headers?.location;
}

function assertVerifiedPublicHttpUrl(value, baseUrl) {
  let url;
  try {
    url = new URL(value, baseUrl);
  } catch {
    throw new Error('Public image redirect must contain a valid HTTP(S) URL.');
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username !== '' ||
    url.password !== ''
  ) {
    throw new Error('Public image redirect must use an HTTP(S) URL without credentials.');
  }
  return url;
}

function nodeRequest(sourceUrl, { address, lookup: pinnedLookup, signal }) {
  const url = new URL(sourceUrl);
  const transport = url.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const request = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        headers: { Host: url.host },
        servername: url.hostname,
        lookup: (_hostname, _options, callback) => callback(null, pinnedLookup(_hostname), isIP(address)),
        signal,
      },
      (response) =>
        resolve({
          status: response.statusCode,
          headers: response.headers,
          stream: response,
          abort: (error) => request.destroy(error),
        }),
    );
    request.once('error', reject);
    request.end();
  });
}

async function downloadImage(
  sourceUrl,
  fetchImpl,
  {
    resolveHost,
    timeoutMs,
    maxResponseBytes,
    requestImpl,
    redirectPolicy = 'reject',
    maxRedirects = 0,
  },
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    if (requestImpl) {
      let currentUrl = assertVerifiedPublicHttpUrl(sourceUrl);
      for (let redirects = 0; ; redirects += 1) {
        const address = await resolvePublicImageAddress(currentUrl.href, resolveHost);
        const response = await requestImpl(currentUrl.href, {
          address,
          signal: controller.signal,
          lookup: () => address,
        });
        if (response.status >= 300 && response.status < 400) {
          response.abort?.();
          if (redirectPolicy !== 'verified-public' || redirects >= maxRedirects) {
            throw new Error(`Image redirect response rejected for ${safeDisplayUrl(currentUrl.href)}.`);
          }
          const location = redirectLocation(response);
          if (!location) {
            throw new Error(`Image redirect response rejected for ${safeDisplayUrl(currentUrl.href)}.`);
          }
          currentUrl = assertVerifiedPublicHttpUrl(location, currentUrl.href);
          continue;
        }
        if (response.status < 200 || response.status >= 300) {
          response.abort?.();
          throw new Error(`Failed to download image ${safeDisplayUrl(currentUrl.href)}: HTTP ${response.status}.`);
        }
        return await streamBytes(response, maxResponseBytes);
      }
    }
    await resolvePublicImageAddress(sourceUrl, resolveHost);
    const response = await fetchImpl(sourceUrl, { redirect: 'error', signal: controller.signal });
    if (response.status >= 300 && response.status < 400) {
      throw new Error(`Image redirect response rejected for ${safeDisplayUrl(sourceUrl)}.`);
    }
    if (!response.ok) {
      throw new Error(`Failed to download image ${safeDisplayUrl(sourceUrl)}: HTTP ${response.status}.`);
    }

    return await responseBytes(response, maxResponseBytes);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Image download timed out after ${timeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function pathExists(location) {
  try {
    await lstat(location);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return false;
    }

    throw error;
  }
}

export async function acquireCacheLock(
  lockDirectory,
  { topic, article },
  {
    now = Date.now,
    randomUUID: createToken = randomUUID,
    lockTtlMs = CACHE_LOCK_TTL_MS,
    heartbeatIntervalMs = Math.max(1, Math.floor(CACHE_LOCK_TTL_MS / 3)),
    cleanup = (location) => rm(location, { force: true, recursive: true }),
    isProcessAlive = (pid) => {
      try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
    },
  } = {},
) {
  const token = createToken();
  const owner = { token, pid: process.pid, createdAt: now(), topic, article };
  let acquired = false;
  let ownerPath;
  let heartbeat;
  let lost = false;

  try {
    await mkdir(lockDirectory);
    acquired = true;
  } catch (error) {
    if (error.code !== 'EEXIST') {
      throw error;
    }

    let existingOwnerPath;
    try {
      const names = await readdir(lockDirectory);
      existingOwnerPath = path.join(lockDirectory, names.find((name) => name.startsWith('owner-')) ?? '');
    } catch {
      existingOwnerPath = null;
    }
    if (existingOwnerPath) {
      try {
        const existingOwner = JSON.parse(await readFile(existingOwnerPath, 'utf8'));
        if (isValidOwnerMetadata(existingOwner)) {
          if (isProcessAlive(existingOwner.pid)) {
            throw new Error(`Cache write already in progress for ${topic}/${article}.`);
          }
          if (now() - (await stat(existingOwnerPath)).mtimeMs <= lockTtlMs) {
            throw new Error(`Cache write already in progress for ${topic}/${article}.`);
          }
        }
      } catch (readError) {
        if (/already in progress/.test(readError.message)) throw readError;
      }
    }
    const quarantine = `${lockDirectory}.quarantine-${createToken()}`;
    try {
      if (existingOwnerPath) {
        try {
          const recheckedOwner = JSON.parse(await readFile(existingOwnerPath, 'utf8'));
          if (
            isValidOwnerMetadata(recheckedOwner) &&
            (
              isProcessAlive(recheckedOwner.pid) ||
              now() - (await stat(existingOwnerPath)).mtimeMs <= lockTtlMs
            )
          ) {
            throw new Error(`Cache write already in progress for ${topic}/${article}.`);
          }
        } catch (error) {
          if (/already in progress/.test(error.message)) throw error;
        }
      }
      await rename(lockDirectory, quarantine);
      await mkdir(lockDirectory);
      acquired = true;
    } catch (retryError) {
      if (retryError.code === 'EEXIST' || retryError.code === 'ENOENT') {
        throw new Error(`Cache write already in progress for ${topic}/${article}.`);
      }
      throw retryError;
    }
    await rm(quarantine, { force: true, recursive: true });
  }

  ownerPath = path.join(lockDirectory, `owner-${token}.json`);
  await writeFile(ownerPath, `${JSON.stringify(owner)}\n`);
  heartbeat = setInterval(() => {
    utimes(ownerPath, new Date(), new Date()).catch(() => {
      lost = true;
    });
  }, heartbeatIntervalMs);
  return {
    lockPath: lockDirectory,
    ownerPath,
    token,
    async assertOwned() {
      if (lost) throw new Error('Cache lock ownership was lost.');
      try {
        const current = JSON.parse(await readFile(ownerPath, 'utf8'));
        if (current.token !== token) throw new Error('Cache lock ownership was lost.');
      } catch {
        lost = true;
        throw new Error('Cache lock ownership was lost.');
      }
    },
    async release() {
      clearInterval(heartbeat);
      try {
        const ownerValue = JSON.parse(await readFile(ownerPath, 'utf8'));
        if (ownerValue.token !== token) return ['Lock ownership changed; lock was not removed.'];
        if (cleanup) {
          await cleanup(ownerPath);
        } else {
          await unlink(ownerPath);
        }
        try {
          await rmdir(lockDirectory);
        } catch (error) {
          if (error.code !== 'ENOTEMPTY' && error.code !== 'ENOENT') {
            return [`Unable to remove cache lock: ${error.message}`];
          }
        }
        return [];
      } catch (error) {
        return [`Unable to remove cache lock: ${error.message}`];
      }
    },
  };
}

async function assertNoSymlinkPath(repoRoot, location) {
  const root = path.resolve(repoRoot);
  const relativePath = path.relative(root, location);

  if (
    path.isAbsolute(relativePath) ||
    relativePath.split(path.sep).includes('..')
  ) {
    throw new Error('Cache path must stay within the repository.');
  }

  let current = root;
  for (const component of relativePath.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try {
      const details = await lstat(current);
      if (details.isSymbolicLink()) {
        throw new Error(`Cache path contains a symbolic link: ${relativePath}.`);
      }
    } catch (error) {
      if (error.code === 'ENOENT') {
        return;
      }
      throw error;
    }
  }
}

function createStagingDirectory(targetDirectory, label) {
  return path.join(
    path.dirname(targetDirectory),
    `.${path.basename(targetDirectory)}.${label}-${randomUUID()}`,
  );
}

async function rollbackPublishedDirectories(backups) {
  for (const entry of [...backups].reverse()) {
    if (entry.published) {
      await rm(entry.target, { force: true, recursive: true });
    }
    if (entry.hadPrevious) {
      await rename(entry.backup, entry.target);
    }
  }
}

async function publishDirectories(repoRoot, entries, renameImpl) {
  const backups = entries.map((entry) => ({
    ...entry,
    backup: createStagingDirectory(entry.target, 'backup'),
    hadPrevious: false,
    published: false,
  }));

  try {
    for (const entry of backups) {
      await Promise.all([
        assertNoSymlinkPath(repoRoot, entry.staging),
        assertNoSymlinkPath(repoRoot, entry.target),
        assertNoSymlinkPath(repoRoot, entry.backup),
      ]);
    }

    for (const entry of backups) {
      if (await pathExists(entry.target)) {
        await renameImpl(entry.target, entry.backup);
        entry.hadPrevious = true;
      }
    }

    for (const entry of backups) {
      await renameImpl(entry.staging, entry.target);
      entry.published = true;
    }
  } catch (error) {
    await rollbackPublishedDirectories(backups);
    throw error;
  }

  return backups;
}

export async function cacheNote({
  repoRoot,
  rules,
  categorySlug,
  topicSlug,
  articleSlug,
  note,
  fetchImpl,
  resolveHost = (hostname) => lookup(hostname, { all: true, verbatim: true }),
  timeoutMs = 10_000,
  maxResponseBytes = 10 * 1024 * 1024,
  renameImpl = rename,
  cleanupBackup = (location) => rm(location, { force: true, recursive: true }),
  cleanupLock = (location) => rm(location, { force: true, recursive: true }),
  requestImpl = nodeRequest,
  imageRedirectPolicy = 'reject',
  maxImageRedirects = 0,
  clock = Date.now,
  lockTtlMs = CACHE_LOCK_TTL_MS,
  heartbeatMs = Math.max(1, Math.floor(CACHE_LOCK_TTL_MS / 3)),
  isProcessAlive,
}) {
  const isPublicShare = note?.sourceType === 'public-share';
  const sourceFormat = isPublicShare ? 'public-share' : note?.sourceFormat ?? 'json-content';
  const isPlainText = sourceFormat === 'plain-text';
  if (
    typeof note?.id !== 'string' ||
    typeof note.content !== 'string' ||
    (isPlainText ? typeof note.rawText !== 'string' : typeof note.rawJson !== 'string')
  ) {
    throw new Error('Cache input requires a note id, preserved source output, and content.');
  }
  if (!isPublicShare && sourceFormat !== 'json-content' && sourceFormat !== 'plain-text') {
    throw new Error('Private cache source format must be json-content or plain-text.');
  }
  if (isPlainText && note.isRaw !== false) {
    throw new Error('Plain-text cache input must be marked as converted source.');
  }
  if (isPlainText && note.rawText !== note.content) {
    throw new Error('Plain-text cache input requires rawText and content to match exactly.');
  }
  if (!isPlainText && !requestImpl && typeof fetchImpl !== 'function') {
    throw new Error('An image request implementation is required to cache images.');
  }
  if (imageRedirectPolicy !== 'reject' && imageRedirectPolicy !== 'verified-public') {
    throw new Error('Image redirect policy must be reject or verified-public.');
  }
  if (!Number.isInteger(maxImageRedirects) || maxImageRedirects < 0) {
    throw new Error('Maximum image redirects must be a non-negative integer.');
  }
  if (isPublicShare) {
    assertShareId(note.shareId);
    if (typeof note.title !== 'string' || note.title.trim() === '') {
      throw new Error('Public share cache input requires a title.');
    }
    if (imageRedirectPolicy !== 'verified-public') {
      throw new Error('Public share image downloads require verified-public redirects.');
    }
  }

  const paths = buildMigrationPaths(rules, { categorySlug, topicSlug, articleSlug });
  const cacheDirectory = resolveCachePath(repoRoot, paths.cacheContentDir);
  const mirrorDirectory = resolveCachePath(repoRoot, paths.cacheImageDir);
  const stagingCacheDirectory = createStagingDirectory(cacheDirectory, 'staging');
  const stagingMirrorDirectory = createStagingDirectory(mirrorDirectory, 'staging');
  const sourceDirectory = path.join(stagingCacheDirectory, 'source');
  const originalDirectory = path.join(stagingCacheDirectory, 'images', 'original');
  const reportsDirectory = path.join(stagingCacheDirectory, 'reports');
  const provenanceImageDirectory = toPosixPath(paths.cacheContentDir, 'images', 'original');
  const provenancePath = toPosixPath(paths.cacheContentDir, 'reports', 'provenance.json');
  const manifestPath = path.join(cacheDirectory, 'reports', 'cache-manifest.json');
  const mirrorManifestPath = path.join(mirrorDirectory, 'cache-manifest.json');
  const lockDirectory = resolveCachePath(
    repoRoot,
    toPosixPath(paths.cacheRoot, '.locks', `${categorySlug}-${topicSlug}-${articleSlug}.lock`),
  );
  let imageCount = 0;
  let lockAcquired = false;
  let lock;
  const warnings = [];

  await Promise.all(
    [cacheDirectory, mirrorDirectory, stagingCacheDirectory, stagingMirrorDirectory].map(
      (location) => assertNoSymlinkPath(repoRoot, location),
    ),
  );
  await Promise.all([
    mkdir(path.dirname(stagingCacheDirectory), { recursive: true }),
    mkdir(path.dirname(stagingMirrorDirectory), { recursive: true }),
    mkdir(path.dirname(lockDirectory), { recursive: true }),
  ]);

  try {
    await Promise.all([
      assertNoSymlinkPath(repoRoot, stagingCacheDirectory),
      assertNoSymlinkPath(repoRoot, stagingMirrorDirectory),
    ]);
    await assertNoSymlinkPath(repoRoot, lockDirectory);
    lock = await acquireCacheLock(
      lockDirectory,
      { category: categorySlug, topic: topicSlug, article: articleSlug },
      {
      now: clock, lockTtlMs, heartbeatIntervalMs: heartbeatMs, cleanup: cleanupLock, isProcessAlive,
      },
    );
    lockAcquired = true;
    if (await pathExists(mirrorManifestPath)) {
      const mirrorManifest = JSON.parse(await readFile(mirrorManifestPath, 'utf8'));
      if (
        mirrorManifest.categorySlug !== categorySlug
        || mirrorManifest.topicSlug !== topicSlug
      ) {
        throw new Error(
          `Article slug ${articleSlug} is already cached for another category or topic; use a unique article slug.`,
        );
      }
    }
    await Promise.all([
      mkdir(stagingCacheDirectory),
      mkdir(stagingMirrorDirectory),
    ]);
    await Promise.all([
      assertNoSymlinkPath(repoRoot, stagingCacheDirectory),
      assertNoSymlinkPath(repoRoot, stagingMirrorDirectory),
    ]);
    await Promise.all([
      mkdir(sourceDirectory),
      mkdir(originalDirectory, { recursive: true }),
      mkdir(reportsDirectory),
    ]);

    await Promise.all(
      isPublicShare
        ? [
          writeFile(path.join(sourceDirectory, 'share.json'), note.rawJson),
          writeFile(path.join(sourceDirectory, 'content.html'), note.content),
        ]
        : isPlainText
          ? [
            writeFile(path.join(sourceDirectory, 'note.txt'), note.rawText),
            writeFile(path.join(sourceDirectory, 'content.md'), note.content),
          ]
        : [
          writeFile(path.join(sourceDirectory, 'note.json'), note.rawJson),
          writeFile(path.join(sourceDirectory, 'content.md'), note.content),
        ],
    );

    const provenance = {
      schemaVersion: 1,
      source: isPublicShare
        ? {
          type: 'public-share',
          shareId: note.shareId,
          title: note.title,
          fetchedAt: new Date().toISOString(),
        }
        : {
          id: note.id,
          sourceFormat,
          isRaw: isPlainText ? false : note.isRaw ?? true,
          fetchedAt: new Date().toISOString(),
        },
      images: [],
    };
    const images = isPlainText ? [] : extractImages(note.content);

    for (const [offset, image] of images.entries()) {
      const index = offset + 1;
      const filename = `image-${String(index).padStart(3, '0')}${imageExtension(image.sourceUrl)}`;
      const bytes = await downloadImage(image.sourceUrl, fetchImpl, {
        resolveHost,
        timeoutMs,
        maxResponseBytes,
        requestImpl: fetchImpl && imageRedirectPolicy === 'reject' ? undefined : requestImpl,
        redirectPolicy: imageRedirectPolicy,
        maxRedirects: maxImageRedirects,
      });
      const localPath = toPosixPath(provenanceImageDirectory, filename);

      await Promise.all([
        writeFile(path.join(originalDirectory, filename), bytes),
        writeFile(path.join(stagingMirrorDirectory, filename), bytes),
      ]);
      provenance.images.push({
        index,
        alt: image.alt,
        sourceUrl: image.sourceUrl,
        localPath,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
    }
    await lock.assertOwned();

    await writeFile(
      path.join(reportsDirectory, 'provenance.json'),
      `${JSON.stringify(provenance, null, 2)}\n`,
    );
    await writeFile(
      path.join(stagingMirrorDirectory, 'cache-manifest.json'),
      `${JSON.stringify({ categorySlug, topicSlug, articleSlug })}\n`,
    );
    imageCount = provenance.images.length;
    await lock.assertOwned();
    const backups = await publishDirectories(
      repoRoot,
      [
        { staging: stagingCacheDirectory, target: cacheDirectory },
        { staging: stagingMirrorDirectory, target: mirrorDirectory },
      ],
      renameImpl,
    );
    try {
      await lock.assertOwned();
      await writeFile(
        manifestPath,
        `${JSON.stringify({
          schemaVersion: 1,
          complete: true,
          committedAt: new Date().toISOString(),
          mirrorPath: paths.cacheImageDir,
        }, null, 2)}\n`,
      );
    } catch (error) {
      await rollbackPublishedDirectories(backups);
      throw error;
    }
    for (const entry of backups.filter((backup) => backup.hadPrevious)) {
      try {
        await cleanupBackup(entry.backup);
      } catch (error) {
        warnings.push(`Unable to remove cache backup: ${error.message}`);
      }
    }
  } finally {
    await Promise.all([
      rm(stagingCacheDirectory, { force: true, recursive: true }),
      rm(stagingMirrorDirectory, { force: true, recursive: true }),
    ]);
    if (lockAcquired) {
      try {
        const lockWarnings = await lock.release();
        warnings.push(...lockWarnings);
      } catch (error) {
        warnings.push(`Unable to remove cache lock: ${error.message}`);
      }
    }
  }

  return {
    cacheDirectory: paths.cacheContentDir,
    imageCount,
    provenancePath,
    warnings,
  };
}

export async function cachePublicShare({ share, ...options }) {
  const shareId = assertShareId(share?.shareId);
  if (
    typeof share?.title !== 'string' ||
    share.title.trim() === '' ||
    typeof share?.rawJson !== 'string' ||
    typeof share?.content !== 'string'
  ) {
    throw new Error('Public share cache input requires a title, raw JSON, and HTML content.');
  }

  return cacheNote({
    ...options,
    note: {
      id: shareId,
      sourceType: 'public-share',
      shareId,
      title: share.title,
      rawJson: share.rawJson,
      content: share.content,
    },
    imageRedirectPolicy: 'verified-public',
    maxImageRedirects: 3,
  });
}
