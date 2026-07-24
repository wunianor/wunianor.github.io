/**
 * @brief 从 HTML 标签字符串中提取指定属性值。
 * @param {string} tag - 单个 `<img ...>` 标签片段。
 * @param {string} attribute - 属性名（如 `alt`、`src`）。
 * @returns {string} 属性值；缺失时返回空字符串。
 * @note 支持双引号、单引号与无引号属性写法；不解析实体引用。
 */
function getHtmlAttribute(tag, attribute) {
  const match = new RegExp(
    `\\b${attribute}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\\\`]+))`,
    'i',
  ).exec(tag);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? '';
}

/**
 * @brief 判断字符串是否为 http 或 https URL。
 * @param {string} value - 待检测的 URL 字符串。
 * @returns {boolean} 合法 HTTP(S) URL 为 `true`。
 * @note 使用 `URL` 构造器；`file:`、`data:` 等返回 `false`。
 */
function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * @brief 从 Markdown `![alt](url)` 起点解析图片元数据。
 * @param {string} content - 完整正文。
 * @param {number} start - `![` 在正文中的起始索引。
 * @returns {{ alt: string, sourceUrl: string, end: number } | null} 解析结果或无法闭合时 `null`。
 * @note 支持 URL 内嵌套括号；`end` 为匹配结束后的下一个字符索引。
 */
function parseMarkdownImage(content, start) {
  const altEnd = content.indexOf('](', start + 2);
  if (altEnd === -1) {
    return null;
  }

  const urlStart = altEnd + 2;
  let depth = 1;
  for (let index = urlStart; index < content.length; index += 1) {
    if (content[index] === '(') {
      depth += 1;
    } else if (content[index] === ')') {
      depth -= 1;
      if (depth === 0) {
        const value = content.slice(urlStart, index).trim();
        return {
          alt: content.slice(start + 2, altEnd),
          sourceUrl: value.split(/\s+/, 1)[0],
          end: index + 1,
        };
      }
    }
  }

  return null;
}

/**
 * @brief 按出现顺序提取正文中的 HTTP(S) 图片（Markdown 与 HTML）。
 * @param {string} content - HTML 或 Markdown 混合正文。
 * @returns {{ alt: string, sourceUrl: string }[]} 去重后的图片列表，保留首次出现顺序。
 * @note 忽略 `data:`、`file:` 及非 HTTP URL；同一 `sourceUrl` 只保留一条。
 */
export function extractImages(content) {
  const images = [];
  const seenUrls = new Set();
  const starts = /!\[|<img\b/gi;

  for (const match of content.matchAll(starts)) {
    const start = match.index;
    const markdown = match[0] === '![';
    const candidate = markdown
      ? parseMarkdownImage(content, start)
      : (() => {
        const end = content.indexOf('>', start);
        if (end === -1) {
          return null;
        }
        const tag = content.slice(start, end + 1);
        return {
          alt: getHtmlAttribute(tag, 'alt'),
          sourceUrl: getHtmlAttribute(tag, 'src'),
          end: end + 1,
        };
      })();

    if (!candidate) {
      continue;
    }

    if (!isHttpUrl(candidate.sourceUrl) || seenUrls.has(candidate.sourceUrl)) {
      continue;
    }

    seenUrls.add(candidate.sourceUrl);
    images.push({ alt: candidate.alt, sourceUrl: candidate.sourceUrl });
  }

  return images;
}
