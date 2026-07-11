function getHtmlAttribute(tag, attribute) {
  const match = new RegExp(
    `\\b${attribute}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\\\`]+))`,
    'i',
  ).exec(tag);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? '';
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function parseSearchCandidates(output) {
  return output
    .split(/\r?\n/)
    .flatMap((line) => {
      const match = /^📄 ([^\t\s]+)\t(.+)$/.exec(line);
      if (!match || match[2].trim() === '') {
        return [];
      }

      return [{ id: match[1], title: match[2] }];
    });
}

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
