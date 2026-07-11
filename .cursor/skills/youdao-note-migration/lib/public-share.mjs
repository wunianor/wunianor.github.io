import { lookup } from 'node:dns/promises';
import https from 'node:https';
import { isIP } from 'node:net';

import { isGloballyRoutableAddress } from './network.mjs';

const SHARE_ID_PATTERN = /^[a-f0-9]{32}$/i;

export function assertShareId(shareId) {
  if (typeof shareId !== 'string' || !SHARE_ID_PATTERN.test(shareId)) {
    throw new Error('Public share ID must be a 32-character hexadecimal value.');
  }
  return shareId.toLowerCase();
}

export function buildPublicShareUrl(shareId) {
  return `https://note.youdao.com/yws/public/note/${assertShareId(shareId)}?sev=j1&editorType=0`;
}

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

function nodeRequest(urlValue, { address, lookup: pinnedLookup, signal }) {
  const url = new URL(urlValue);
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        path: `${url.pathname}${url.search}`,
        headers: { Host: url.host, Accept: 'application/json' },
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

export async function readPublicShare(
  shareId,
  { requestJson = requestPublicShareJson, resolveHost, requestImpl } = {},
) {
  const validatedShareId = assertShareId(shareId);
  const rawJson = await requestJson(buildPublicShareUrl(validatedShareId), { resolveHost, requestImpl });
  return parsePublicShareResponse(rawJson, validatedShareId);
}
