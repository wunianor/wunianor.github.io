import { lookup } from 'node:dns/promises';
import https from 'node:https';
import { isIP } from 'node:net';

import { createPinnedLookup, isGloballyRoutableAddress } from './network.mjs';

const SHARE_ID_PATTERN = /^[a-f0-9]{32}$/i;
const ALLOWED_SHARE_HOSTS = new Set(['share.note.youdao.com', 'note.youdao.com']);
const MAX_SHARE_REDIRECTS = 3;

/**
 * @brief 校验并规范化有道公开分享 ID 为 32 位小写十六进制。
 * @param {*} shareId - 用户输入的分享 ID。
 * @returns {string} 小写形式的 32 字符 hex shareId。
 * @note 非字符串或格式不符时抛出 Error。
 */
export function assertShareId(shareId) {
  if (typeof shareId !== 'string' || !SHARE_ID_PATTERN.test(shareId)) {
    throw new Error('Public share ID must be a 32-character hexadecimal value.');
  }
  return shareId.toLowerCase();
}

/**
 * @brief 根据 shareId 构建有道公开笔记 JSON API URL。
 * @param {string} shareId - 32 位十六进制分享 ID。
 * @returns {string} HTTPS API 地址，含 editorType 等固定查询参数。
 * @note 内部调用 assertShareId 校验 ID 格式。
 */
export function buildPublicShareUrl(shareId) {
  return `https://note.youdao.com/yws/public/note/${assertShareId(shareId)}?sev=j1&editorType=0`;
}

/**
 * @brief 从有道分享 URL 的 query 或 path 中提取 32 位 shareId。
 * @param {URL} url - 已解析的分享 URL 对象。
 * @returns {string|null} 小写 shareId；无法提取时返回 null。
 * @note 支持 `?id=` 参数及 `/yws/public/note/`、`/noteshare/` 路径模式。
 */
function extractShareIdFromUrl(url) {
  const idParam = url.searchParams.get('id');
  if (typeof idParam === 'string' && SHARE_ID_PATTERN.test(idParam)) {
    return idParam.toLowerCase();
  }

  const notePathMatch = url.pathname.match(/\/(?:yws\/public\/note|noteshare)\/([a-f0-9]{32})\b/i);
  if (notePathMatch) {
    return notePathMatch[1].toLowerCase();
  }

  return null;
}

/**
 * @brief 解析并验证输入为允许的 HTTPS 有道分享链接。
 * @param {string} value - 分享 URL 或相对 Location。
 * @param {string} [baseUrl] - 解析相对 URL 的基址。
 * @returns {URL} 验证通过的 URL 对象。
 * @note 主机须在 ALLOWED_SHARE_HOSTS 内；拒绝凭据与非 HTTPS 协议。
 */
function assertAllowedShareUrl(value, baseUrl) {
  let url;
  try {
    url = new URL(value, baseUrl);
  } catch {
    throw new Error('Share URL must be a valid HTTPS Youdao share link.');
  }

  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
    throw new Error('Share URL must use HTTPS without credentials.');
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!ALLOWED_SHARE_HOSTS.has(hostname)) {
    throw new Error(`Share URL host is not allowed: ${hostname}.`);
  }

  return url;
}

/**
 * @brief 将分享输入（hex ID 或短链/长链 URL）解析为 32 位 shareId。
 * @param {string} input - 32 字符 hex ID，或有道分享 URL（含 `/s/<token>`、`index.html?id=` 等）。
 * @param {object} [options={}] - 解析选项。
 * @param {(hostname: string) => Promise<unknown>} [options.resolveHost] - DNS 解析函数。
 * @param {typeof nodeRequest} [options.requestImpl] - HTTPS 请求实现，用于跟随重定向。
 * @param {number} [options.timeoutMs=10000] - 请求超时毫秒数。
 * @param {number} [options.maxRedirects=3] - 最大重定向跳数。
 * @returns {Promise<string>} 小写 32 位 hex shareId。
 * @note 短链需跟随受控重定向；每跳校验主机与公网地址；超时或无法解析时抛出 Error。
 */
export async function resolveShareInput(
  input,
  {
    resolveHost = (hostname) => lookup(hostname, { all: true, verbatim: true }),
    requestImpl = nodeRequest,
    timeoutMs = 10_000,
    maxRedirects = MAX_SHARE_REDIRECTS,
  } = {},
) {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new Error(
      'Share input must be a 32-character hexadecimal share ID or a Youdao share URL.',
    );
  }

  const trimmed = input.trim();
  if (SHARE_ID_PATTERN.test(trimmed)) {
    return assertShareId(trimmed);
  }

  let currentUrl;
  try {
    currentUrl = assertAllowedShareUrl(trimmed);
  } catch (error) {
    if (error.message.startsWith('Share URL')) {
      throw error;
    }
    throw new Error(
      'Share input must be a 32-character hexadecimal share ID or a Youdao share URL.',
    );
  }

  const directShareId = extractShareIdFromUrl(currentUrl);
  if (directShareId) {
    return directShareId;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    for (let redirects = 0; ; redirects += 1) {
      const address = await resolvePublicAddress(currentUrl.href, resolveHost);
      const response = await requestImpl(currentUrl.href, {
        address,
        signal: controller.signal,
        lookup: () => address,
      });

      if (response.status >= 300 && response.status < 400) {
        response.abort?.();
        if (redirects >= maxRedirects) {
          throw new Error(
            `Share URL redirect rejected after ${maxRedirects} hops.`,
          );
        }
        const location = redirectLocation(response);
        if (!location) {
          throw new Error('Share URL redirect is missing a Location header.');
        }
        currentUrl = assertAllowedShareUrl(location, currentUrl.href);
        const redirectedShareId = extractShareIdFromUrl(currentUrl);
        if (redirectedShareId) {
          return redirectedShareId;
        }
        continue;
      }

      response.abort?.();
      const finalShareId = extractShareIdFromUrl(currentUrl);
      if (finalShareId) {
        return finalShareId;
      }
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`Share URL request failed: HTTP ${response.status}.`);
      }
      throw new Error(
        'Unable to resolve a 32-character share ID from the share URL.',
      );
    }
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Share URL request timed out after ${timeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * @brief 从 HTTP 响应头提取 Location 重定向 URL。
 * @param {{ headers?: Headers|object }} response - fetch 或 Node 响应对象。
 * @returns {string|null|undefined} Location 头值。
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
 * @brief 解析公开分享 API 的 JSON 响应为结构化笔记对象。
 * @param {string} rawJson - API 返回的原始 JSON 字符串。
 * @param {string} shareId - 已校验的 32 位分享 ID。
 * @returns {{ shareId: string, title: string, content: string, rawJson: string }} 笔记标题、HTML 内容与溯源 JSON。
 * @note 要求 JSON 含非空 tl（标题）与 content 字段；JSON 无效或字段缺失时抛出 Error。
 */
export function parsePublicShareResponse(rawJson, shareId) {
  let response;
  try {
    response = JSON.parse(rawJson);
  } catch {
    throw new Error('Public share API response must be valid JSON.');
  }

  if (
    !response ||
    typeof response.tl !== 'string' ||
    response.tl.trim() === '' ||
    typeof response.content !== 'string'
  ) {
    throw new Error('Public share API response requires a title and content.');
  }

  return {
    shareId: assertShareId(shareId),
    title: response.tl,
    content: response.content,
    rawJson,
  };
}

/**
 * @brief 解析分享 API URL 主机并验证其指向公网可路由地址。
 * @param {string} url - 完整 HTTPS URL 字符串。
 * @param {(hostname: string) => Promise<unknown>} resolveHost - DNS 解析函数。
 * @returns {Promise<string>} 首个验证通过的 IP 地址。
 * @note 直连 IP 或 DNS 结果含私网/本地地址时抛出 Error（SSRF 防护）。
 */
async function resolvePublicAddress(url, resolveHost) {
  const hostname = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (isIP(hostname)) {
    if (!isGloballyRoutableAddress(hostname)) {
      throw new Error('Public share API host must resolve to a public address.');
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
    throw new Error('Public share API host must resolve to a public address.');
  }
  return typeof addresses[0] === 'string' ? addresses[0] : addresses[0].address;
}

/**
 * @brief 使用固定 IP 的 Node https 向有道分享 API 发起单次请求。
 * @param {string} urlValue - 完整 HTTPS URL。
 * @param {object} options - 请求选项。
 * @param {string} options.address - 已验证的 pinned IP 地址。
 * @param {(hostname: string) => string} [options.lookup] - 自定义 lookup。
 * @param {AbortSignal} [options.signal] - 超时或取消信号。
 * @returns {Promise<{ status: number, headers: object, stream: IncomingMessage, abort: (error?: Error) => void }>} 响应包装对象。
 * @note Accept 头为 application/json；通过 createPinnedLookup 绑定 DNS。
 */
function nodeRequest(urlValue, { address, lookup: resolvePinnedAddress, signal }) {
  const url = new URL(urlValue);
  const pinnedAddress =
    typeof resolvePinnedAddress === 'function' ? resolvePinnedAddress(url.hostname) : address;
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        path: `${url.pathname}${url.search}`,
        headers: { Host: url.host, Accept: 'application/json' },
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
 * @brief 从 Node HTTP 流式响应读取 UTF-8 文本并校验字节上限。
 * @param {{ headers?: object, stream: AsyncIterable<Uint8Array>, abort?: (error?: Error) => void }} response - Node 响应包装。
 * @param {number} maxResponseBytes - 允许的最大字节数，默认 10MB。
 * @returns {Promise<string>} 响应体 UTF-8 字符串。
 * @note 超限时销毁流并 abort；用于公开分享 API JSON 读取。
 */
async function responseText(response, maxResponseBytes) {
  const contentLength = Number(response.headers?.['content-length']);
  if (Number.isFinite(contentLength) && contentLength > maxResponseBytes) {
    response.abort?.();
    throw new Error('Public share API response is too large.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.stream) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > maxResponseBytes) {
      const error = new Error('Public share API response is too large.');
      response.stream.destroy?.(error);
      response.abort?.(error);
      throw error;
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * @brief 请求有道公开分享 JSON API 并返回原始 JSON 字符串。
 * @param {string} url - buildPublicShareUrl 生成的 API URL。
 * @param {object} [options={}] - 请求选项。
 * @param {(hostname: string) => Promise<unknown>} [options.resolveHost] - DNS 解析。
 * @param {typeof nodeRequest} [options.requestImpl] - HTTPS 请求实现。
 * @param {number} [options.timeoutMs=10000] - 超时毫秒数。
 * @param {number} [options.maxResponseBytes=10485760] - 最大响应字节数，默认 10MB。
 * @returns {Promise<string>} API 响应体 UTF-8 JSON 字符串。
 * @note 非 2xx 状态或超时抛出 Error；须先通过 resolvePublicAddress 校验主机。
 */
export async function requestPublicShareJson(
  url,
  {
    resolveHost = (hostname) => lookup(hostname, { all: true, verbatim: true }),
    requestImpl = nodeRequest,
    timeoutMs = 10_000,
    maxResponseBytes = 10 * 1024 * 1024,
  } = {},
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const address = await resolvePublicAddress(url, resolveHost);
    const response = await requestImpl(url, {
      address,
      signal: controller.signal,
      lookup: () => address,
    });
    if (response.status < 200 || response.status >= 300) {
      response.abort?.();
      throw new Error(`Public share API request failed: HTTP ${response.status}.`);
    }
    return await responseText(response, maxResponseBytes);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Public share API request timed out after ${timeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * @brief 读取并解析指定 shareId 的公开分享笔记完整内容。
 * @param {string} shareId - 32 位十六进制分享 ID。
 * @param {object} [options={}] - 读取选项。
 * @param {typeof requestPublicShareJson} [options.requestJson] - JSON 请求函数，便于测试注入。
 * @param {(hostname: string) => Promise<unknown>} [options.resolveHost] - DNS 解析。
 * @param {typeof nodeRequest} [options.requestImpl] - HTTPS 请求实现。
 * @returns {Promise<{ shareId: string, title: string, content: string, rawJson: string }>} 结构化分享笔记。
 * @note 组合 buildPublicShareUrl、requestPublicShareJson 与 parsePublicShareResponse；shareId 经 assertShareId 校验。
 */
export async function readPublicShare(
  shareId,
  { requestJson = requestPublicShareJson, resolveHost, requestImpl } = {},
) {
  const validatedShareId = assertShareId(shareId);
  const rawJson = await requestJson(buildPublicShareUrl(validatedShareId), { resolveHost, requestImpl });
  return parsePublicShareResponse(rawJson, validatedShareId);
}
