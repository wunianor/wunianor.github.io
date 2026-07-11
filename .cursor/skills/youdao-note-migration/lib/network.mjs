import { isIP } from 'node:net';

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
