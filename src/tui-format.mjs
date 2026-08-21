export function compactAge(value) {
  const normalized = String(value || "").replace(/ ago$/, "").replace(/^an? /, "1 ");
  if (normalized === "just now") return "now";
  const match = normalized.match(/^(\d+)\s+(second|minute|hour|day|week|month|year)s?/);
  if (!match) return normalized;
  const units = { second: "s", minute: "m", hour: "h", day: "d", week: "w", month: "mo", year: "y" };
  return `${match[1]}${units[match[2]]}`;
}

export function compareFolderGroups([left], [right]) {
  if (!left && right) return 1;
  if (left && !right) return -1;
  return left.localeCompare(right);
}

const DOCUMENT_EXTENSIONS = new Set([".md", ".mdx", ".markdown", ".txt", ".rst", ".adoc", ".pdf"]);
const CONFIG_EXTENSIONS = new Set([".json", ".jsonc", ".toml", ".yaml", ".yml", ".xml", ".ini", ".conf", ".env"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico", ".bmp", ".tiff"]);
const ARCHIVE_EXTENSIONS = new Set([".zip", ".gz", ".bz2", ".xz", ".7z", ".tar", ".tgz", ".rar"]);
const CODE_EXTENSIONS = new Set([
  ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".py", ".rb", ".rs", ".go", ".java", ".kt",
  ".c", ".h", ".cc", ".cpp", ".cs", ".swift", ".sh", ".bash", ".zsh", ".fish", ".lua", ".php",
  ".html", ".css", ".scss", ".sql", ".vue", ".svelte",
]);

export function neutralFileGlyph(file) {
  if (file?.symlink) return "↗";
  if (file?.executable) return "▶";
  const basename = String(file?.path || "").split("/").at(-1)?.toLocaleLowerCase() || "";
  const dot = basename.lastIndexOf(".");
  const extension = dot > 0 ? basename.slice(dot) : "";
  if (DOCUMENT_EXTENSIONS.has(extension)) return "≡";
  if (CONFIG_EXTENSIONS.has(extension) || ["dockerfile", "makefile"].includes(basename)) return "◇";
  if (IMAGE_EXTENSIONS.has(extension)) return "▧";
  if (ARCHIVE_EXTENSIONS.has(extension)) return "▣";
  if (CODE_EXTENSIONS.has(extension)) return "λ";
  return "□";
}
