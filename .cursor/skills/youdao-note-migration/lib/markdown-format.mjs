/**
 * @brief validate-draft 用的确定性 Markdown 格式启发式检测模块。
 * @note 覆盖 emphasis-syntax、chinese-punctuation、code-fence-comments 三类门禁；代码块、行内代码与 URL 区域从 prose 检查中排除；检测器只报告不改写。
 */

const CJK = /[\u4e00-\u9fff\u3400-\u4dbf]/;
const EDGE_PUNCT = /[,.:;?!，。：；？！、]/;
const ASCII_SENTENCE_PUNCT = /[,.;:?!]/;
const URL_PATTERN = /https?:\/\/[^\s)\]>]+|www\.[^\s)\]>]+/gi;

const ANNOTATION_PREFIXES = [
  '作用',
  '参数',
  '返回',
  '返回值',
  '说明',
  '注意',
  '示例',
  '功能',
  '描述',
  '输入',
  '输出',
  '用法',
  '目的',
  '含义',
  '定义',
  '备注',
  '简介',
  '特点',
  '优点',
  '缺点',
  '步骤',
  '结果',
  '原因',
  '条件',
  '范围',
  '格式',
  '类型',
  '字段',
  '成员',
  '属性',
  '方法',
  '接口',
  '约束',
  '要求',
  '前提',
  '后置',
  '副作用',
];

const COMMENT_PREFIX_BY_LANG = {
  c: ['//', '/*', '*'],
  h: ['//', '/*', '*'],
  cpp: ['//', '/*', '*'],
  'c++': ['//', '/*', '*'],
  cc: ['//', '/*', '*'],
  cxx: ['//', '/*', '*'],
  java: ['//', '/*', '*'],
  javascript: ['//', '/*', '*'],
  js: ['//', '/*', '*'],
  typescript: ['//', '/*', '*'],
  ts: ['//', '/*', '*'],
  go: ['//', '/*', '*'],
  rust: ['//', '/*', '*'],
  rs: ['//', '/*', '*'],
  csharp: ['//', '/*', '*'],
  cs: ['//', '/*', '*'],
  'c#': ['//', '/*', '*'],
  kotlin: ['//', '/*', '*'],
  kt: ['//', '/*', '*'],
  swift: ['//', '/*', '*'],
  php: ['//', '#', '/*', '*'],
  python: ['#'],
  py: ['#'],
  ruby: ['#'],
  rb: ['#'],
  shell: ['#'],
  bash: ['#'],
  sh: ['#'],
  zsh: ['#'],
  fish: ['#'],
  yaml: ['#'],
  yml: ['#'],
  toml: ['#'],
  conf: ['#'],
  ini: ['#', ';'],
  makefile: ['#'],
  make: ['#'],
  cmake: ['#'],
  dockerfile: ['#'],
  sql: ['--', '/*'],
  lua: ['--'],
  html: ['<!--'],
  xml: ['<!--'],
  markdown: null,
  md: null,
  text: null,
  txt: null,
  plain: null,
};

const ANNOTATION_LINE = new RegExp(
  `^\\s*(?:${ANNOTATION_PREFIXES.map(escapeRegExp).join('|')})\\s*[:：]`,
);

/**
 * @brief 转义字符串中的正则元字符，供动态 RegExp 构造使用。
 * @param {string} value - 待转义的原始字符串。
 * @returns {string} 可在 RegExp 中安全使用的字面量模式。
 * @note 转义 `. * + ? ^ $ { } ( ) | [ ] \` 等元字符。
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * @brief 按围栏感知将 Markdown 拆分为 prose 与 fence 区域序列。
 * @param {string} markdown - 完整 Markdown 文本。
 * @returns {Array<{ type: 'prose'|'fence', language: string|null, text: string, startLine: number }>} 区域数组，startLine 为 1-based 行号。
 * @note 未闭合围栏视为 fence 直至文末；language 为围栏 info string 小写或空字符串。
 */
export function splitMarkdownRegions(markdown) {
  const lines = markdown.split(/\r?\n/);
  const regions = [];
  let proseLines = [];
  let proseStart = 1;
  let inFence = false;
  let fenceLanguage = null;
  let fenceLines = [];
  let fenceStart = 1;

  /**
   * @brief 将累积的 prose 行刷入 regions 并重置状态。
   * @param {number} endExclusive - 下一区域起始行号（1-based）。
   * @returns {void}
   * @note 仅当 proseLines 非空时 push；proseStart 更新为 endExclusive + 1。
   */
  const flushProse = (endExclusive) => {
    if (proseLines.length === 0) {
      return;
    }
    regions.push({
      type: 'prose',
      language: null,
      text: proseLines.join('\n'),
      startLine: proseStart,
    });
    proseLines = [];
    proseStart = endExclusive + 1;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNumber = index + 1;
    const fenceOpen = /^```\s*([A-Za-z0-9_+#.-]*)\s*$/.exec(line);
    if (fenceOpen) {
      if (!inFence) {
        flushProse(lineNumber);
        inFence = true;
        fenceLanguage = fenceOpen[1] ? fenceOpen[1].toLowerCase() : '';
        fenceLines = [];
        fenceStart = lineNumber + 1;
      } else {
        regions.push({
          type: 'fence',
          language: fenceLanguage,
          text: fenceLines.join('\n'),
          startLine: fenceStart,
        });
        inFence = false;
        fenceLanguage = null;
        fenceLines = [];
        proseStart = lineNumber + 1;
      }
      continue;
    }
    if (inFence) {
      fenceLines.push(line);
    } else {
      if (proseLines.length === 0) {
        proseStart = lineNumber;
      }
      proseLines.push(line);
    }
  }

  if (inFence) {
    regions.push({
      type: 'fence',
      language: fenceLanguage,
      text: fenceLines.join('\n'),
      startLine: fenceStart,
    });
  } else {
    flushProse(lines.length + 1);
  }

  return regions;
}

/**
 * @brief 用等长空格掩蔽行内代码与 URL，保留偏移供后续扫描忽略。
 * @param {string} text - 单行或 prose 区域文本。
 * @returns {string} 掩蔽后的同长度字符串。
 * @note 匹配 `` `...` `` 与 http(s)/www URL；不修改原始文本，仅用于检测。
 */
export function maskInlineCodeAndUrls(text) {
  let masked = text.replace(/`[^`\n]*`/g, (match) => ' '.repeat(match.length));
  masked = masked.replace(URL_PATTERN, (match) => ' '.repeat(match.length));
  return masked;
}

/**
 * @brief 在单行中查找 ** / __ / * / _ 强调 span（长标记优先）。
 * @param {string} line - 已掩蔽行内代码与 URL 的单行文本。
 * @returns {Array<{ marker: string, start: number, end: number, content: string, unclosed?: boolean }>} 强调 span 列表。
 * @note 未找到闭合标记时标记 unclosed:true 且 end 为 -1；空 content 的闭合 span 由调用方忽略。
 */
function findEmphasisSpans(line) {
  const spans = [];
  const markers = ['**', '__', '*', '_'];
  let index = 0;
  while (index < line.length) {
    let matched = null;
    for (const marker of markers) {
      if (line.startsWith(marker, index)) {
        matched = marker;
        break;
      }
    }
    if (!matched) {
      index += 1;
      continue;
    }

    const contentStart = index + matched.length;
    const closeIndex = line.indexOf(matched, contentStart);
    if (closeIndex === -1) {
      spans.push({
        marker: matched,
        start: index,
        end: -1,
        content: line.slice(contentStart),
        unclosed: true,
      });
      break;
    }

    spans.push({
      marker: matched,
      start: index,
      end: closeIndex + matched.length,
      content: line.slice(contentStart, closeIndex),
      unclosed: false,
    });
    index = closeIndex + matched.length;
  }
  return spans;
}

/**
 * @brief 检测 Markdown 中的强调语法问题（未闭合、标点贴靠标记）。
 * @param {string} markdown - 完整 Markdown 文本。
 * @returns {Array<{ line: number, kind: string, detail: string }>} 问题列表，line 为 1-based。
 * @note 仅扫描 prose 区域；kind 含 unclosed-emphasis、punctuation-inside-emphasis。
 */
export function detectEmphasisSyntaxIssues(markdown) {
  const issues = [];
  const regions = splitMarkdownRegions(markdown);

  for (const region of regions) {
    if (region.type !== 'prose') {
      continue;
    }
    const lines = region.text.split(/\n/);
    for (let offset = 0; offset < lines.length; offset += 1) {
      const lineNumber = region.startLine + offset;
      const original = lines[offset];
      if (original.trim() === '') {
        continue;
      }
      const masked = maskInlineCodeAndUrls(original);
      const spans = findEmphasisSpans(masked);
      for (const span of spans) {
        if (span.unclosed) {
          issues.push({
            line: lineNumber,
            kind: 'unclosed-emphasis',
            detail: `unclosed ${span.marker}`,
          });
          continue;
        }
        if (span.content.length === 0) {
          continue;
        }
        const first = span.content[0];
        const last = span.content[span.content.length - 1];
        if (EDGE_PUNCT.test(first) || EDGE_PUNCT.test(last)) {
          issues.push({
            line: lineNumber,
            kind: 'punctuation-inside-emphasis',
            detail: `${span.marker}…${span.marker} has punctuation against the marker`,
          });
        }
      }
    }
  }

  return issues;
}

/**
 * @brief 判断 Markdown 是否含强调语法问题。
 * @param {string} markdown - 完整 Markdown 文本。
 * @returns {boolean} detectEmphasisSyntaxIssues 结果非空时为 true。
 * @note 供 validate-draft 门禁快速判断，不返回具体问题详情。
 */
export function hasEmphasisSyntaxIssues(markdown) {
  return detectEmphasisSyntaxIssues(markdown).length > 0;
}

/**
 * @brief 判断行内某 `.` 是否为小数点或编号点而非句末标点。
 * @param {string} line - 单行文本（通常已掩蔽）。
 * @param {number} index - `.` 字符的索引位置。
 * @returns {boolean} 前后邻字符为数字时视为小数/编号点，返回 true。
 * @note 用于 chinese-punctuation 检测排除合法 ASCII 句点。
 */
function isDecimalOrNumberingDot(line, index) {
  const prev = index > 0 ? line[index - 1] : '';
  const next = index + 1 < line.length ? line[index + 1] : '';
  if (line[index] !== '.') {
    return false;
  }
  if (/\d/.test(prev) || /\d/.test(next)) {
    return true;
  }
  return false;
}

/**
 * @brief 检测中文 prose 中紧邻汉字的 ASCII 句读标点问题。
 * @param {string} markdown - 完整 Markdown 文本。
 * @returns {Array<{ line: number, kind: string, detail: string }>} 问题列表，kind 为 ascii-punctuation-in-chinese。
 * @note 仅扫描含 CJK 的 prose 行；排除小数点与编号点；每行最多报告一个问题。
 */
export function detectChinesePunctuationIssues(markdown) {
  const issues = [];
  const regions = splitMarkdownRegions(markdown);

  for (const region of regions) {
    if (region.type !== 'prose') {
      continue;
    }
    const lines = region.text.split(/\n/);
    for (let offset = 0; offset < lines.length; offset += 1) {
      const lineNumber = region.startLine + offset;
      const original = lines[offset];
      if (!CJK.test(original)) {
        continue;
      }
      const masked = maskInlineCodeAndUrls(original);
      for (let index = 0; index < masked.length; index += 1) {
        const char = masked[index];
        if (!ASCII_SENTENCE_PUNCT.test(char)) {
          continue;
        }
        if (char === '.' && isDecimalOrNumberingDot(masked, index)) {
          continue;
        }
        const prev = index > 0 ? masked[index - 1] : '';
        const next = index + 1 < masked.length ? masked[index + 1] : '';
        if (CJK.test(prev) || CJK.test(next)) {
          issues.push({
            line: lineNumber,
            kind: 'ascii-punctuation-in-chinese',
            detail: `ASCII "${char}" adjacent to Chinese text`,
          });
          break;
        }
      }
    }
  }

  return issues;
}

/**
 * @brief 判断 Markdown 是否含中文语境 ASCII 标点问题。
 * @param {string} markdown - 完整 Markdown 文本。
 * @returns {boolean} detectChinesePunctuationIssues 结果非空时为 true。
 * @note 供 validate-draft chinese-punctuation 门禁使用。
 */
export function hasChinesePunctuationIssues(markdown) {
  return detectChinesePunctuationIssues(markdown).length > 0;
}

/**
 * @brief 根据围栏 language 标签返回该语言的注释前缀列表。
 * @param {string|null|undefined} language - 围栏 info string，已小写或 null。
 * @returns {string[]|null|undefined} 注释前缀数组；null 表示跳过检测；undefined 表示未知语言。
 * @note markdown/md/text 等 prose 类语言返回 null；未知语言返回 undefined 触发通用启发式。
 */
function commentPrefixesForLanguage(language) {
  if (language === null || language === undefined) {
    return null;
  }
  const normalized = language.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(COMMENT_PREFIX_BY_LANG, normalized)) {
    return COMMENT_PREFIX_BY_LANG[normalized];
  }
  return undefined;
}

/**
 * @brief 判断代码行是否以给定语言的任一注释前缀开头。
 * @param {string} line - 围栏内单行代码。
 * @param {string[]} prefixes - 注释前缀列表，如 `['//', '#']`。
 * @returns {boolean} trim 后以任一 prefix 开头则为 true。
 * @note 仅检查行首注释语法，不解析块注释闭合。
 */
function lineHasCommentSyntax(line, prefixes) {
  const trimmed = line.trimStart();
  return prefixes.some((prefix) => trimmed.startsWith(prefix));
}

/**
 * @brief 检测代码围栏内类 prose 注解行是否缺少对应语言的注释语法。
 * @param {string} markdown - 完整 Markdown 文本。
 * @returns {Array<{ line: number, kind: string, detail: string, language: string }>} 问题列表，kind 为 prose-annotation-in-code-fence。
 * @note 匹配 ANNOTATION_PREFIXES 开头的行；未知空 language 标签使用 // # -- /* 通用前缀。
 */
export function detectCodeFenceCommentIssues(markdown) {
  const issues = [];
  const regions = splitMarkdownRegions(markdown);

  for (const region of regions) {
    if (region.type !== 'fence') {
      continue;
    }
    const prefixes = commentPrefixesForLanguage(region.language);
    if (prefixes === null) {
      continue;
    }
    // Unknown language tags: only flag when the fence has a known C-family-ish
    // empty tag treated as generic code that often uses // comments.
    const effectivePrefixes = prefixes === undefined
      ? (region.language === '' ? ['//', '#', '--', '/*'] : null)
      : prefixes;
    if (!effectivePrefixes) {
      continue;
    }

    const lines = region.text === '' ? [] : region.text.split(/\n/);
    for (let offset = 0; offset < lines.length; offset += 1) {
      const line = lines[offset];
      const lineNumber = region.startLine + offset;
      if (!ANNOTATION_LINE.test(line)) {
        continue;
      }
      if (lineHasCommentSyntax(line, effectivePrefixes)) {
        continue;
      }
      issues.push({
        line: lineNumber,
        kind: 'prose-annotation-in-code-fence',
        detail: `annotation-like line lacks comment syntax for language "${region.language || '(none)'}"`,
        language: region.language || '',
      });
    }
  }

  return issues;
}

/**
 * @brief 判断 Markdown 是否含代码围栏注释格式问题。
 * @param {string} markdown - 完整 Markdown 文本。
 * @returns {boolean} detectCodeFenceCommentIssues 结果非空时为 true。
 * @note 供 validate-draft code-fence-comments 门禁使用。
 */
export function hasCodeFenceCommentIssues(markdown) {
  return detectCodeFenceCommentIssues(markdown).length > 0;
}
