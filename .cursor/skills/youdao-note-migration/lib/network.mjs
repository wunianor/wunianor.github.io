import { isIP } from 'node:net';

/**
 * @brief 将 DNS 答案规范化为可用于路由判断的 IP 字符串。
 * @param {string} address - 原始地址，可含 IPv6 方括号或 `::ffff:` 映射。
 * @returns {string} 规范化后的 IPv4 或 IPv6 字符串。
 * @note 将 IPv4-mapped IPv6 转为点分十进制 IPv4；不验证地址是否可路由。
 */
function normalizedAddress(address) {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '');
  const mappedIpv4 = normalized.match(
    /^::ffff:(\d+\.\d+\.\d+\.\d+|[0-9a-f]{1,4}:[0-9a-f]{1,4})$/,
  )?.[1];
  if (!mappedIpv4) {
    return normalized;
  }
  if (!mappedIpv4.includes(':')) {
    return mappedIpv4;
  }
  return mappedIpv4
    .split(':')
    .map((part) => Number.parseInt(part, 16))
    .flatMap((part) => [Math.floor(part / 256), part % 256])
    .join('.');
}

/**
 * @brief 判断 IPv4 是否属于特殊用途/私网而非全球单播。
 * @param {string} address - 点分十进制 IPv4。
 * @returns {boolean} 全球可路由公网地址为 `true`。
 * @note 覆盖 RFC 特殊段、私网、链路本地、组播等；用于 SSRF 防护。
 */
function isGloballyRoutableIpv4(address) {
  const [first, second, third] = address.split('.').map(Number);

  return !(
    first === 0 ||
    first === 10 ||
    (first === 100 && second >= 64 && second <= 127) ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0 && third === 0) ||
    (first === 192 && second === 0 && third === 2) ||
    (first === 192 && second === 31 && third === 196) ||
    (first === 192 && second === 52 && third === 193) ||
    (first === 192 && second === 88 && third === 99) ||
    (first === 192 && second === 168) ||
    (first === 192 && second === 175 && third === 48) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113) ||
    first >= 224
  );
}

/**
 * @brief 将 IPv6 地址展开为 8 个 16 位分组数值。
 * @param {string} address - 不含方括号的 IPv6 字符串。
 * @returns {number[]} 长度为 8 的分组数组。
 * @note 处理 `::` 压缩写法；用于特殊用途段判断。
 */
function ipv6Groups(address) {
  const [leftPart, rightPart] = address.split('::');
  const left = leftPart === '' ? [] : leftPart.split(':');
  const right = rightPart === undefined || rightPart === '' ? [] : rightPart.split(':');
  return [
    ...left,
    ...Array(8 - left.length - right.length).fill('0'),
    ...right,
  ].map((part) => Number.parseInt(part, 16));
}

/**
 * @brief 判断 IPv6 是否为全球单播公网地址。
 * @param {string} address - IPv6 字符串。
 * @returns {boolean} 全球单播为 `true`。
 * @note 排除文档段、ULA、链路本地、6to4 文档范围等。
 */
function isGloballyRoutableIpv6(address) {
  const [first, second, third] = ipv6Groups(address);
  if (
    (first === 0x2001 && second === 0x0db8) ||
    (first === 0x2001 && second === 0x0002 && third === 0) ||
    (first === 0x2001 && second >= 0x0010 && second <= 0x001f) ||
    first === 0x2002 ||
    (first === 0x3fff && second <= 0x0fff)
  ) {
    return false;
  }
  return (first & 0xe000) === 0x2000;
}

/**
 * @brief 判断 IP 地址是否为全球可路由公网地址。
 * @param {string} address - IPv4 或 IPv6 字符串。
 * @returns {boolean} 公网可路由为 `true`；非字符串或无法解析为 `false`。
 * @note 公共分享与图片下载在 DNS 解析后必须用此函数过滤，防止 SSRF 到内网。
 */
export function isGloballyRoutableAddress(address) {
  if (typeof address !== 'string') {
    return false;
  }
  const normalized = normalizedAddress(address);
  if (isIP(normalized) === 4) {
    return isGloballyRoutableIpv4(normalized);
  }
  return isIP(normalized) === 6 && isGloballyRoutableIpv6(normalized);
}

/**
 * @brief 构造将连接固定到已验证 IP 的自定义 DNS lookup。
 * @param {string} address - 已验证的 IPv4 或 IPv6 字符串。
 * @returns {Function} 兼容 Node `{ all: true }` 与旧式 `(err, address, family)` 的 lookup 回调。
 * @note 空串或非法 IP 抛错；用于 `https` 请求绑定解析后的公网地址，阻断 DNS 重绑定。
 */
export function createPinnedLookup(address) {
  if (typeof address !== 'string' || address.trim() === '') {
    throw new Error('Pinned lookup address must be a non-empty IP string.');
  }
  const family = isIP(address);
  if (family !== 4 && family !== 6) {
    throw new Error(`Pinned lookup address must be a valid IP: ${address}.`);
  }

  return function pinnedLookup(_hostname, options, callback) {
    let cb = callback;
    let opts = options;
    if (typeof options === 'function') {
      cb = options;
      opts = undefined;
    }
    if (typeof cb !== 'function') {
      throw new Error('Pinned lookup requires a callback.');
    }

    if (opts?.all === true) {
      cb(null, [{ address, family }]);
      return;
    }
    cb(null, address, family);
  };
}
