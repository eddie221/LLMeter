import React from 'react';

export function parseInlineMarkdown(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\(https?:\/\/[^)\s]+\))/g;
  let lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
    const token = match[0];
    if (token.startsWith('`')) parts.push(<code key={parts.length}>{token.slice(1, -1)}</code>);
    else if (token.startsWith('**')) parts.push(<strong key={parts.length}>{token.slice(2, -2)}</strong>);
    else if (token.startsWith('*')) parts.push(<em key={parts.length}>{token.slice(1, -1)}</em>);
    else {
      const link = token.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/);
      parts.push(link ? <a key={parts.length} href={link[2]} target="_blank" rel="noreferrer">{link[1]}</a> : token);
    }
    lastIndex = match.index + token.length;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts;
}

function displayChatContent(content: string) {
  return content.replace(/data:[^\s;]+\/[^\s;]+;base64,[A-Za-z0-9+/=]+/g, '[base64 attachment data hidden in chat view]');
}

export function MarkdownView({ content }: { content: string }) {
  const clean = displayChatContent(content);
  const lines = clean.split('\n');
  const blocks: React.ReactNode[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];
  let code: string[] | undefined;
  const flushParagraph = () => {
    if (paragraph.length) {
      blocks.push(<p key={blocks.length}>{parseInlineMarkdown(paragraph.join(' '))}</p>);
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list.length) {
      blocks.push(<ul key={blocks.length}>{list.map((item, index) => <li key={index}>{parseInlineMarkdown(item)}</li>)}</ul>);
      list = [];
    }
  };
  lines.forEach(line => {
    if (line.trim().startsWith('```')) {
      if (code !== undefined) {
        blocks.push(<pre key={blocks.length}><code>{code.join('\n')}</code></pre>);
        code = undefined;
      } else {
        flushParagraph();
        flushList();
        code = [];
      }
      return;
    }
    if (code !== undefined) {
      code.push(line);
      return;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length;
      if (level === 1) blocks.push(<h1 key={blocks.length}>{parseInlineMarkdown(heading[2])}</h1>);
      else if (level === 2) blocks.push(<h2 key={blocks.length}>{parseInlineMarkdown(heading[2])}</h2>);
      else blocks.push(<h3 key={blocks.length}>{parseInlineMarkdown(heading[2])}</h3>);
      return;
    }
    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    if (bullet) {
      flushParagraph();
      list.push(bullet[1]);
      return;
    }
    if (!line.trim()) {
      flushParagraph();
      flushList();
      return;
    }
    flushList();
    paragraph.push(line.trim());
  });
  if (code !== undefined) blocks.push(<pre key={blocks.length}><code>{code.join('\n')}</code></pre>);
  flushParagraph();
  flushList();
  return <div className="chatMarkdown">{blocks}</div>;
}
