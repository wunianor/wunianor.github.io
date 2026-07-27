/**
 * 顶层标题结构检测（协议 4D）。
 * - 空壳：某 `##` 下恰好一个 `###`，且该 `###` 下还有更深层标题。
 * - 唯一顶层：全文只有一个 `##`（含其下无 `###`、只有正文的情况）。
 * `###` 及更深的单子嵌套不检（除非因唯一 `##` 整篇取消顶层）。
 */

const NUMBERED_HEADING = /^(##|###|####) (\d+(?:\.\d+){0,2})\. (.+)$/;

/**
 * @brief 解析 Markdown 中带编号的 `##`/`###`/`####` 标题行。
 * @param {string} markdown - 候选 Markdown 全文。
 * @returns {{ level: number, number: string, title: string, line: number }[]} 标题对象列表，行号为 1-based。
 * @note 跳过围栏代码块内行；只匹配 `N.` / `N.M.` / `N.M.P.` 编号格式。
 */
export function parseNumberedHeadings(markdown) {
  const headings = [];
  let inFence = false;
  const lines = markdown.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }
    const match = NUMBERED_HEADING.exec(line);
    if (!match) {
      continue;
    }
    headings.push({
      level: match[1].length,
      number: match[2],
      title: match[3],
      line: index + 1,
    });
  }
  return headings;
}

/**
 * @brief 判断全文是否恰好只有一个编号顶层 `##`。
 * @param {string} markdown - 候选 Markdown 全文。
 * @returns {boolean} 唯一顶层 `##` 时为 `true`。
 * @note 用于「唯一顶层须取消并重排」门禁启发式。
 */
export function hasSoleTopLevelHeading(markdown) {
  const h2s = parseNumberedHeadings(markdown).filter((heading) => heading.level === 2);
  return h2s.length === 1;
}

/**
 * @brief 检测未扁平化的顶层 `##` 空壳章节。
 * @param {string} markdown - 候选 Markdown 全文。
 * @returns {{ h2Number: string, h2Title: string, h3Number: string, h3Title: string, line: number }[]}
 * @note 全文不足两个 `##` 时不报告空壳（唯一 `##` 由 `hasSoleTopLevelHeading` 覆盖）。
 */
export function detectTopLevelHeadingShells(markdown) {
  const headings = parseNumberedHeadings(markdown);
  const h2s = headings.filter((heading) => heading.level === 2);
  if (h2s.length < 2) {
    return [];
  }

  const shells = [];
  for (let index = 0; index < h2s.length; index += 1) {
    const h2 = h2s[index];
    const sectionEnd = index + 1 < h2s.length ? h2s[index + 1].line : Number.POSITIVE_INFINITY;
    const h3Children = headings.filter(
      (heading) => heading.level === 3 && heading.line > h2.line && heading.line < sectionEnd,
    );
    if (h3Children.length !== 1) {
      continue;
    }

    const onlyH3 = h3Children[0];
    const hasFurtherSubheadings = headings.some(
      (heading) => heading.level >= 4 && heading.line > onlyH3.line && heading.line < sectionEnd,
    );
    if (!hasFurtherSubheadings) {
      continue;
    }

    shells.push({
      h2Number: h2.number,
      h2Title: h2.title,
      h3Number: onlyH3.number,
      h3Title: onlyH3.title,
      line: h2.line,
    });
  }

  return shells;
}

/**
 * @brief 判断候选 Markdown 是否仍含未修复的顶层标题结构问题。
 * @param {string} markdown - 候选 Markdown 全文。
 * @returns {boolean} 存在唯一顶层 `##` 或空壳时为 `true`。
 * @note `validate-draft` 在无已批准 `heading-structure` 记录时据此失败（选项 A：有批准可通过）。
 */
export function hasUnfixedTopLevelHeadingShell(markdown) {
  return hasSoleTopLevelHeading(markdown) || detectTopLevelHeadingShells(markdown).length > 0;
}
