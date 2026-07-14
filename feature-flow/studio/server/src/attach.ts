import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { join } from "node:path";

/**
 * 对话框附件归一化：
 * - 图片 → base64 image part（走 SDK 图片块，气泡里可视）
 * - 文本/代码/pdf → 存盘，返回路径，agent 用 Read 读取
 * - doc/docx → textutil 转 txt 后返回 txt 路径
 * 二进制/未知类型一律拒绝。
 */
export type AttachPart =
  | { type: "image"; name: string; mediaType: string; data: string }
  | { type: "file"; name: string; path: string };

const IMG: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
};
// 可当文本读的常见代码/文档后缀
const TEXT_RE =
  /\.(md|markdown|txt|text|csv|tsv|json|ya?ml|xml|html?|css|scss|less|jsx?|tsx?|mjs|cjs|py|go|java|rs|rb|php|c|h|cc|cpp|hpp|sh|bash|zsh|sql|toml|ini|conf|cfg|properties|gradle|kt|swift|vue|svelte|svg|log|diff|patch)$/i;

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((res, rej) => execFile(cmd, args, (e) => (e ? rej(e) : res())));
}

export async function attachFile(
  filename: string,
  buf: Buffer,
  dir: string
): Promise<{ ok: true; part: AttachPart } | { ok: false; error: string }> {
  const safe = String(filename).replace(/[^A-Za-z0-9._-]/g, "_");
  const ext = (safe.match(/\.([a-z0-9]+)$/i)?.[1] ?? "").toLowerCase();

  if (IMG[ext]) {
    return { ok: true, part: { type: "image", name: filename, mediaType: IMG[ext], data: buf.toString("base64") } };
  }

  const dest = join(dir, `${Date.now()}-${safe}`);

  if (ext === "pdf") {
    writeFileSync(dest, buf);
    return { ok: true, part: { type: "file", name: filename, path: dest } };
  }

  if (ext === "doc" || ext === "docx") {
    if (ext === "docx" && !(buf[0] === 0x50 && buf[1] === 0x4b)) {
      return { ok: false, error: "不是有效的 .docx（可能损坏或被改了后缀）" };
    }
    writeFileSync(dest, buf);
    const txt = dest.replace(/\.docx?$/i, ".txt");
    try {
      await run("/usr/bin/textutil", ["-convert", "txt", dest, "-output", txt]);
      if (!existsSync(txt) || !readFileSync(txt, "utf8").trim()) throw new Error("空输出");
    } catch {
      return { ok: false, error: "Word 转文本失败：文件可能加密或损坏" };
    }
    return { ok: true, part: { type: "file", name: filename, path: txt } };
  }

  if (TEXT_RE.test(safe)) {
    writeFileSync(dest, buf);
    return { ok: true, part: { type: "file", name: filename, path: dest } };
  }

  return { ok: false, error: `不支持的文件类型「.${ext || "?"}」：可传图片 / 代码文本 / pdf / Word` };
}
