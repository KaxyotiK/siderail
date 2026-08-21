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
