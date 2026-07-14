import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { join } from "node:path";

/**
 * PRD 上传归一化：把任意格式的 PRD 落成「工作流 Read 工具可直接读」的文件。
 *
 * 各格式能力（按 CLI 2.x Read 工具实测）：
 * - md / txt   纯文本，直读
 * - pdf        Read 原生按页视觉读取（含扫描件/图表），直通不转换
 * - docx       Read 拒收二进制 → textutil 抽正文 + unzip 提取 word/media/ 内嵌图片，
 *              图片清单附在正文末尾（Read 可视觉读图，原型图/流程图不丢）
 * - doc        老格式非 zip：textutil 抽正文，图片无法提取
 */
export type IntakeResult =
  | { ok: true; path: string; note: string }
  | { ok: false; error: string };

const TEXT_EXT = new Set(["md", "markdown", "txt"]);

// execFile + 参数数组：不经 shell，文件名已 sanitize，无注入面
function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((res, rej) => execFile(cmd, args, (err) => (err ? rej(err) : res())));
}

export async function intakePrd(filename: string, buf: Buffer, dir: string): Promise<IntakeResult> {
  const safeName = String(filename).replace(/[^A-Za-z0-9._-]/g, "_");
  const dest = join(dir, `${Date.now()}-${safeName}`);
  const ext = (safeName.match(/\.([a-z0-9]+)$/i)?.[1] ?? "").toLowerCase();

  if (TEXT_EXT.has(ext)) {
    writeFileSync(dest, buf);
    return { ok: true, path: dest, note: "纯文本，直接可读" };
  }

  if (ext === "pdf") {
    writeFileSync(dest, buf);
    return { ok: true, path: dest, note: "PDF 按页直读（含扫描件与图表）" };
  }

  if (ext === "doc" || ext === "docx") {
    // .docx 必为 zip（PK 魔数）；不是则文件损坏/被改名，textutil 会宽容地转出垃圾，提前拦掉
    if (ext === "docx" && !(buf[0] === 0x50 && buf[1] === 0x4b)) {
      return { ok: false, error: "文件不是有效的 .docx（可能损坏或被改了后缀），请检查后重传" };
    }
    writeFileSync(dest, buf);
    const txt = dest.replace(/\.docx?$/i, ".txt");
    try {
      await run("/usr/bin/textutil", ["-convert", "txt", dest, "-output", txt]);
      if (!existsSync(txt) || !readFileSync(txt, "utf8").trim()) throw new Error("空输出");
    } catch {
      return { ok: false, error: "Word 转文本失败：文件可能加密或损坏，请先手动转成 md/txt，或用「描述内容」" };
    }
    if (ext === "doc") {
      return { ok: true, path: txt, note: "已转纯文本（.doc 老格式无法提取内嵌图片）" };
    }
    const n = await extractDocxImages(dest, txt);
    return { ok: true, path: txt, note: n ? `已转纯文本，提取内嵌图片 ${n} 张` : "已转纯文本（无内嵌图片）" };
  }

  return { ok: false, error: `不支持的格式「.${ext}」：请用 md / txt / pdf / Word` };
}

/** .docx 是 zip：解出 word/media/ 下的图片，清单附到正文末尾，返回图片数。 */
async function extractDocxImages(docxPath: string, txtPath: string): Promise<number> {
  const mediaDir = docxPath.replace(/\.docx$/i, "-media");
  try {
    await run("/usr/bin/unzip", ["-o", "-j", docxPath, "word/media/*", "-d", mediaDir]);
  } catch {
    return 0; // 无内嵌图片（unzip 无匹配会报错）或解包失败：不影响正文
  }
  const imgs = readdirSync(mediaDir)
    .filter((f) => /\.(png|jpe?g|gif|bmp|tiff?)$/i.test(f))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (!imgs.length) return 0;
  appendFileSync(
    txtPath,
    `\n\n---\n【PRD 内嵌图片，共 ${imgs.length} 张，按文档内编号排序。其中可能含原型图/流程图等关键信息，请用 Read 工具逐张查看】\n` +
      imgs.map((f) => join(mediaDir, f)).join("\n") +
      "\n",
    "utf8"
  );
  return imgs.length;
}
