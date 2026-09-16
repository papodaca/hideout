import { getConfig } from "./config.js";
import { chat } from "./llm.js";
import { formatHit, type Hit, rrf } from "./search.js";

export function promptMessages(
  question: string,
  hits: Hit[],
): { role: string; content: string }[] {
  const blocks: string[] = [];
  hits.forEach((hit, i) => {
    const c = hit.chunk;
    const section = [c.chapter, ...c.headings].join(" > ");
    const parts = [c.book, c.file, section];
    if (c.page) {
      let page = `PDF page ${c.page}`;
      if (c.printed != null) page += `, printed ${c.printed}`;
      parts.push(page);
    }
    blocks.push(`[${i + 1}] ${parts.join(" | ")}\n${c.text}`);
  });
  const context = blocks.join("\n\n----\n\n");
  return [
    { role: "system", content: getConfig().systemPrompt },
    { role: "user", content: `Excerpts:\n\n${context}\n\nQuestion: ${question}` },
  ];
}

export async function ask(
  question: string,
  opts: {
    k?: number;
    onToken?: (token: string) => void;
    books?: Iterable<string> | null;
  } = {},
): Promise<[string, Hit[]]> {
  const hits = await rrf(question, { k: opts.k ?? 8, books: opts.books });
  if (!hits.length) {
    const msg = "No matching excerpts in the index.";
    opts.onToken?.(msg);
    return [msg, []];
  }
  const parts: string[] = [];
  for await (const piece of chat(promptMessages(question, hits), true)) {
    parts.push(piece);
    opts.onToken?.(piece);
  }
  return [parts.join("").trim(), hits];
}

export function printHits(hits: Hit[]): void {
  hits.forEach((hit, i) => {
    console.log(`--- ${i + 1} ---`);
    console.log(formatHit(hit));
    console.log();
  });
}
