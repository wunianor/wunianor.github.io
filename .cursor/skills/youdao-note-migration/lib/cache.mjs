import { createHash, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { lstat, mkdir, readFile, readdir, rename, rm, rmdir, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import path from 'node:path';

import { extractImages } from './images.mjs';
import { createPinnedLookup, isGloballyRoutableAddress } from './network.mjs';
import { buildMigrationPaths } from './paths.mjs';
import { assertShareId } from './public-share.mjs';

export const CACHE_LOCK_TTL_MS = 15 * 60 * 1000;

/**
 * @brief 判断锁 owner 元数据是否包含有效 token、pid 与 createdAt。
 * @param {object|null|undefined} owner - 从 owner-*.json 解析出的锁持有者对象。
 * @returns {boolean} 元数据完整且类型合法时为 true。
 * @note 不校验 topic/article 字段；createdAt 可为数字时间戳或 ISO 字符串。
 */
/**
 * @brief 判断锁 owner 元数据是否包含有效 token、pid 与 createdAt。
 * @param {object|null|undefined} owner - 锁 owner JSON 解析后的对象。
 * @returns {boolean} 元数据完整且类型合法时为 true。
 * @note 用于判断现有锁是否仍有效；不校验 topic/article 等业务字段。
 */
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

/**
 * @brief 将仓库相对路径解析为绝对路径并确保不逃逸仓库根目录。
 * @param {string} repoRoot - 仓库根目录绝对路径。
 * @param {string} relativePath - POSIX 或平台相对路径，不得含 `..`。
 * @returns {string} 解析后的绝对路径。
 * @note 拒绝绝对路径与路径遍历；resolved 必须在 repoRoot 子树内。
 */
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

/**
 * @brief 拼接路径段并统一转为 POSIX 斜杠格式。
 * @param {...string} segments - 路径段，传给 path.join。
 * @returns {string} 以 `/` 分隔的相对或绝对路径字符串。
 * @note 用于跨平台一致的 provenance 与 manifest 路径记录。
 */
function toPosixPath(...segments) {
  return path.join(...segments).replaceAll('\\', '/');
}

/**
 * @brief 从图片 URL 路径名提取合法小写扩展名，否则回退 `.bin`。
 * @param {string} sourceUrl - 完整 HTTP(S) 图片 URL。
 * @returns {string} 带点扩展名，如 `.png`、`.jpg` 或 `.bin`。
 * @note 扩展名长度 1–10 且仅含 `[a-z0-9]`；无效时使用 `.bin`。
 */
function imageExtension(sourceUrl) {
  const extension = path.posix.extname(new URL(sourceUrl).pathname).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(extension) ? extension : '.bin';
}

/**
 * @brief 生成用于错误消息的安全显示 URL（隐藏用户凭据）。
 * @param {string} sourceUrl - 完整 HTTP(S) URL。
 * @returns {string} `protocol//host/pathname` 形式，host 中 `@` 前凭据已剥离。
 * @note 仅用于日志与异常消息，不用于实际请求。
 */
function safeDisplayUrl(sourceUrl) {
  const url = new URL(sourceUrl);
  return `${url.protocol}//${url.host.replace(/^[^@]*@/, '')}${url.pathname}`;
}

/**
 * @brief 解析图片 URL 主机并验证其指向公网可路由地址（SSRF 防护）。
 * @param {string} sourceUrl - 完整 HTTP(S) 图片 URL。
 * @param {(hostname: string) => Promise<unknown>} resolveHost - DNS 解析函数，默认 lookup。
 * @returns {Promise<string>} 首个验证通过的 IP 地址字符串。
 * @note localhost、`.local` 与非公网 IP 均拒绝；解析结果为空或含私网地址时抛出 Error。
 */
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

/**
 * @brief 从 fetch Response 读取响应体并校验不超过字节上限。
 * @param {Response} response - fetch API 响应对象。
 * @param {number} maxResponseBytes - 允许的最大字节数。
 * @returns {Promise<Buffer>} 响应体 Buffer。
 * @note 依据 Content-Length 与实读长度双重检查；超限抛出 Error。
 */
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

/**
 * @brief 从 Node HTTP 流式响应逐块读取并校验不超过字节上限。
 * @param {{ headers?: object, stream: AsyncIterable<Uint8Array>, abort?: (error?: Error) => void }} response - Node 请求响应包装。
 * @param {number} maxResponseBytes - 允许的最大字节数。
 * @returns {Promise<Buffer>} 拼接后的响应体 Buffer。
 * @note 超限时销毁流并 abort 请求；适用于 requestImpl 路径。
 */
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

/**
 * @brief 从 HTTP 响应头提取 Location 重定向 URL。
 * @param {{ headers?: Headers|object }} response - fetch 或 Node 响应对象。
 * @returns {string|null|undefined} Location 头值，缺失时 undefined/null。
 * @note 兼容 Headers.get 与 plain object 两种 headers 形态。
 */
function redirectLocation(response) {
  const headers = response.headers;
  if (typeof headers?.get === 'function') {
    return headers.get('location');
  }
  return headers?.location;
}

/**
 * @brief 解析并验证 HTTP(S) 重定向 URL，拒绝凭据与非 HTTP 协议。
 * @param {string} value - Location 头或相对 URL。
 * @param {string} [baseUrl] - 解析相对 URL 的基址。
 * @returns {URL} 验证通过的 URL 对象。
 * @note 仅允许 http:/https: 且无 username/password；无效 URL 抛出 Error。
 */
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

/**
 * @brief 使用固定 IP 的 Node http/https 发起单次 HTTP 请求（SSRF 防护）。
 * @param {string} sourceUrl - 完整请求 URL。
 * @param {object} options - 请求选项。
 * @param {string} options.address - 已验证的 pinned IP 地址。
 * @param {(hostname: string) => string} [options.lookup] - 自定义 lookup，覆盖 address。
 * @param {AbortSignal} [options.signal] - 超时或取消信号。
 * @returns {Promise<{ status: number, headers: object, stream: IncomingMessage, abort: (error?: Error) => void }>} 响应包装对象。
 * @note 通过 createPinnedLookup 绑定 DNS 结果；stream 需调用方消费。
 */
function nodeRequest(sourceUrl, { address, lookup: resolvePinnedAddress, signal }) {
  const url = new URL(sourceUrl);
  const transport = url.protocol === 'https:' ? https : http;
  const pinnedAddress =
    typeof resolvePinnedAddress === 'function' ? resolvePinnedAddress(url.hostname) : address;

  return new Promise((resolve, reject) => {
    const request = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        headers: { Host: url.host },
        servername: url.hostname,
        lookup: createPinnedLookup(pinnedAddress),
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

/**
 * @brief 下载远程图片字节，支持 fetch 或 Node 请求及受控重定向策略。
 * @param {string} sourceUrl - 图片 URL。
 * @param {typeof fetch|undefined} fetchImpl - fetch 实现；与 requestImpl 二选一或组合使用。
 * @param {object} options - 下载选项。
 * @param {(hostname: string) => Promise<unknown>} options.resolveHost - DNS 解析函数。
 * @param {number} options.timeoutMs - 超时毫秒数。
 * @param {number} options.maxResponseBytes - 最大响应字节数。
 * @param {typeof nodeRequest} [options.requestImpl] - Node 请求实现。
 * @param {'reject'|'verified-public'} [options.redirectPolicy='reject'] - 重定向策略。
 * @param {number} [options.maxRedirects=0] - verified-public 模式下最大重定向次数。
 * @returns {Promise<Buffer>} 图片二进制内容。
 * @note 默认拒绝重定向；超时 abort 后抛出明确错误；须先通过公网地址校验。
 */
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

/**
 * @brief 检查文件系统路径是否存在（含符号链接本身）。
 * @param {string} location - 绝对或相对路径。
 * @returns {Promise<boolean>} 存在为 true，ENOENT 为 false。
 * @note 非 ENOENT 的 fs 错误原样抛出。
 */
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

/**
 * @brief 获取笔记缓存目录的互斥写锁，支持过期锁回收与心跳续期。
 * @param {string} lockDirectory - 锁目录绝对路径。
 * @param {{ topic: string, article: string }} context - 锁标识上下文，写入 owner 元数据。
 * @param {object} [options={}] - 锁行为选项。
 * @param {() => number} [options.now=Date.now] - 当前时间毫秒函数。
 * @param {() => string} [options.randomUUID] - UUID 生成函数。
 * @param {number} [options.lockTtlMs=CACHE_LOCK_TTL_MS] - 锁 TTL，默认 15 分钟。
 * @param {number} [options.heartbeatIntervalMs] - owner 文件 mtime 心跳间隔。
 * @param {(location: string) => Promise<void>} [options.cleanup] - 释放锁时的清理函数。
 * @param {(pid: number) => boolean} [options.isProcessAlive] - 检测持有进程是否存活。
 * @returns {Promise<{ lockPath: string, ownerPath: string, token: string, assertOwned: () => Promise<void>, release: () => Promise<string[]> }>} 锁句柄。
 * @note 并发写入同一 topic/article 时抛出 already in progress；release 返回非致命警告字符串数组。
 */
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
    /**
     * @brief 断言当前进程仍持有有效锁 token。
     * @returns {Promise<void>}
     * @note 心跳失败或 owner 文件被替换时抛出 Cache lock ownership was lost。
     */
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
    /**
     * @brief 停止心跳并尝试删除 owner 文件与空锁目录。
     * @returns {Promise<string[]>} 清理过程中的非致命警告消息；成功时通常为空数组。
     * @note token 已变更时不删除锁；ENOTEMPTY 等错误以警告形式返回而非抛出。
     */
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

/**
 * @brief 沿路径分量检查目标位置不在符号链接之后（缓存安全）。
 * @param {string} repoRoot - 仓库根目录。
 * @param {string} location - 待检查的绝对路径。
 * @returns {Promise<void>}
 * @note 路径须在 repoRoot 内；遇到符号链接组件时抛出 Error；ENOENT 末段允许（尚未创建）。
 */
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

/**
 * @brief 在目标目录旁创建带 UUID 的临时 staging/backup 目录路径。
 * @param {string} targetDirectory - 最终发布目录路径。
 * @param {string} label - 目录标签，如 `staging` 或 `backup`。
 * @returns {string} 同级隐藏临时目录绝对路径。
 * @note 用于原子 publish 与 rollback；名称含随机 UUID 避免冲突。
 */
function createStagingDirectory(targetDirectory, label) {
  return path.join(
    path.dirname(targetDirectory),
    `.${path.basename(targetDirectory)}.${label}-${randomUUID()}`,
  );
}

/**
 * @brief 按逆序回滚 publishDirectories 的原子发布操作。
 * @param {Array<{ target: string, backup: string, hadPrevious: boolean, published: boolean }>} backups - publishDirectories 返回的备份条目。
 * @returns {Promise<void>}
 * @note 已 published 的 staging 会被删除；hadPrevious 时从 backup 恢复 target。
 */
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

/**
 * @brief 原子地将 staging 目录 rename 到 target，支持备份旧目录。
 * @param {string} repoRoot - 仓库根，用于符号链接检查。
 * @param {Array<{ staging: string, target: string }>} entries - staging 与 target 路径对。
 * @param {typeof rename} renameImpl - rename 实现，便于测试注入。
 * @returns {Promise<Array<{ staging: string, target: string, backup: string, hadPrevious: boolean, published: boolean }>>} 备份元数据，供后续清理或回滚。
 * @note 任一步失败时自动 rollbackPublishedDirectories；发布前检查 symlink。
 */
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

/**
 * @brief 将有道笔记（私有 JSON/纯文本或公开分享 HTML）写入本地迁移缓存目录。
 * @param {object} params - 缓存参数。
 * @param {string} params.repoRoot - 仓库根目录。
 * @param {object} params.rules - buildMigrationPaths 使用的路径规则。
 * @param {string} params.categorySlug - 分类 slug。
 * @param {string} params.topicSlug - 主题 slug。
 * @param {string} params.articleSlug - 文章 slug。
 * @param {object} params.note - 笔记载荷，含 id、content 及 rawJson/rawText 等。
 * @param {typeof fetch} [params.fetchImpl] - 图片下载 fetch 实现。
 * @param {(hostname: string) => Promise<unknown>} [params.resolveHost] - DNS 解析。
 * @param {number} [params.timeoutMs=10000] - 下载超时。
 * @param {number} [params.maxResponseBytes] - 单图最大字节，默认 10MB。
 * @param {typeof rename} [params.renameImpl] - 原子发布 rename。
 * @param {Function} [params.cleanupBackup] - 备份目录清理。
 * @param {Function} [params.cleanupLock] - 锁目录清理。
 * @param {typeof nodeRequest} [params.requestImpl] - Node HTTP 请求实现。
 * @param {'reject'|'verified-public'} [params.imageRedirectPolicy] - 图片重定向策略。
 * @param {number} [params.maxImageRedirects] - 最大重定向次数。
 * @param {() => number} [params.clock] - 时间源，供锁 TTL 使用。
 * @param {number} [params.lockTtlMs] - 锁 TTL。
 * @param {number} [params.heartbeatMs] - 锁心跳间隔。
 * @param {(pid: number) => boolean} [params.isProcessAlive] - 进程存活检测。
 * @returns {Promise<{ cacheDirectory: string, imageCount: number, provenancePath: string, warnings: string[] }>} 缓存结果摘要。
 * @note 使用 staging + 原子 rename 发布；公开分享须 verified-public 重定向；finally 中清理 staging 并释放锁。
 */
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
  const stagingCacheDirectory = createStagingDirectory(cacheDirectory, 'staging');
  const sourceDirectory = path.join(stagingCacheDirectory, 'source');
  const originalDirectory = path.join(stagingCacheDirectory, 'images', 'original');
  const reportsDirectory = path.join(stagingCacheDirectory, 'reports');
  const provenanceImageDirectory = toPosixPath(paths.cacheContentDir, 'images', 'original');
  const provenancePath = toPosixPath(paths.cacheContentDir, 'reports', 'provenance.json');
  const manifestPath = path.join(cacheDirectory, 'reports', 'cache-manifest.json');
  const lockDirectory = resolveCachePath(
    repoRoot,
    toPosixPath(paths.cacheRoot, '.locks', `${categorySlug}-${topicSlug}-${articleSlug}.lock`),
  );
  let imageCount = 0;
  let lockAcquired = false;
  let lock;
  const warnings = [];

  await Promise.all(
    [cacheDirectory, stagingCacheDirectory].map((location) => assertNoSymlinkPath(repoRoot, location)),
  );
  await Promise.all([
    mkdir(path.dirname(stagingCacheDirectory), { recursive: true }),
    mkdir(path.dirname(lockDirectory), { recursive: true }),
  ]);

  try {
    await assertNoSymlinkPath(repoRoot, stagingCacheDirectory);
    await assertNoSymlinkPath(repoRoot, lockDirectory);
    lock = await acquireCacheLock(
      lockDirectory,
      { category: categorySlug, topic: topicSlug, article: articleSlug },
      {
      now: clock, lockTtlMs, heartbeatIntervalMs: heartbeatMs, cleanup: cleanupLock, isProcessAlive,
      },
    );
    lockAcquired = true;
    await mkdir(stagingCacheDirectory);
    await assertNoSymlinkPath(repoRoot, stagingCacheDirectory);
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

      await writeFile(path.join(originalDirectory, filename), bytes);
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
    imageCount = provenance.images.length;
    await lock.assertOwned();
    const backups = await publishDirectories(
      repoRoot,
      [{ staging: stagingCacheDirectory, target: cacheDirectory }],
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
          imageDir: paths.cacheImageDir,
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
    await rm(stagingCacheDirectory, { force: true, recursive: true });
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

/**
 * @brief 缓存有道公开分享笔记（HTML 内容 + share.json 溯源）。
 * @param {object} params - 参数，含 share 对象及 cacheNote 的其余选项。
 * @param {object} params.share - 公开分享载荷，须含 shareId、title、rawJson、content。
 * @returns {Promise<{ cacheDirectory: string, imageCount: number, provenancePath: string, warnings: string[] }>} 同 cacheNote 返回值。
 * @note 内部固定 imageRedirectPolicy 为 verified-public、maxImageRedirects 为 3；shareId 经 assertShareId 校验。
 */
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
