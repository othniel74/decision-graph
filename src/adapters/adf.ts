/** Flatten Atlassian Document Format to plain text for term matching. */
type AdfNode = { type?: string; text?: string; content?: AdfNode[]; attrs?: Record<string, unknown> };

const BLOCKS = new Set(['paragraph', 'heading', 'listItem', 'blockquote', 'codeBlock', 'tableRow', 'panel', 'rule']);

export function adfToText(doc: unknown, maxLength = 20000): string {
  if (typeof doc === 'string') return doc.slice(0, maxLength);
  const out: string[] = [];
  let length = 0;
  const walk = (n: AdfNode | undefined, depth: number): void => {
    if (!n || depth > 50 || length >= maxLength) return;
    if (typeof n.text === 'string') {
      out.push(n.text);
      length += n.text.length;
    } else if (n.type === 'mention' && typeof n.attrs?.text === 'string') {
      out.push(n.attrs.text);
    } else if (n.type === 'hardBreak') {
      out.push('\n');
    }
    for (const c of n.content ?? []) walk(c, depth + 1);
    if (n.type && BLOCKS.has(n.type)) out.push('\n');
  };
  walk(doc as AdfNode, 0);
  return out.join('').replace(/\n{3,}/g, '\n\n').trim().slice(0, maxLength);
}

/** Build a minimal ADF document: paragraphs of text with optional user mentions. */
export function adfDoc(paragraphs: Array<Array<{ text: string } | { mention: string }>>): object {
  return {
    type: 'doc',
    version: 1,
    content: paragraphs.map((p) => ({
      type: 'paragraph',
      content: p.map((part) =>
        'mention' in part ? { type: 'mention', attrs: { id: part.mention } } : { type: 'text', text: part.text },
      ),
    })),
  };
}
