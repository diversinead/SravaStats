// Line-based markdown → HTML for AI response bubbles. Supports headers (##/###/####),
// horizontal rules, unordered lists, blockquotes, paragraphs, plus inline
// bold/italic/code. Kept deliberately small — we control the LLM output format.

export function formatMarkdown(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let inList = false;
  let inBQ = false;
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${para.join(" ")}</p>`);
      para = [];
    }
  };
  const closeList = () => {
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
  };
  const closeBQ = () => {
    if (inBQ) {
      out.push("</blockquote>");
      inBQ = false;
    }
  };
  const closeAll = () => {
    flushPara();
    closeList();
    closeBQ();
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      closeAll();
      continue;
    }
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^####\s+(.*)$/))) {
      closeAll();
      out.push(`<h4>${formatInline(m[1])}</h4>`);
    } else if ((m = line.match(/^###\s+(.*)$/))) {
      closeAll();
      out.push(`<h3>${formatInline(m[1])}</h3>`);
    } else if ((m = line.match(/^##\s+(.*)$/))) {
      closeAll();
      out.push(`<h2>${formatInline(m[1])}</h2>`);
    } else if (/^---+$/.test(line)) {
      closeAll();
      out.push("<hr>");
    } else if ((m = line.match(/^[-*]\s+(.*)$/))) {
      flushPara();
      closeBQ();
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${formatInline(m[1])}</li>`);
    } else if ((m = line.match(/^>\s?(.*)$/))) {
      flushPara();
      closeList();
      if (!inBQ) {
        out.push("<blockquote>");
        inBQ = true;
      }
      out.push(`<p>${formatInline(m[1])}</p>`);
    } else {
      closeList();
      closeBQ();
      para.push(formatInline(line));
    }
  }
  closeAll();
  return out.join("\n");
}

function formatInline(s: string): string {
  return escapeHtml(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
