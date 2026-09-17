export function compactAge(value) {
  const normalized = String(value || "").replace(/ ago$/, "").replace(/^an? /, "1 ");
  if (normalized === "just now") return "now";
  const match = normalized.match(/^(\d+)\s+(second|minute|hour|day|week|month|year)s?/);
  if (!match) return normalized;
  const units = { second: "s", minute: "m", hour: "h", day: "d", week: "w", month: "mo", year: "y" };
  return `${match[1]}${units[match[2]]}`;
}

export function commitAge(commit, now = Date.now()) {
  if (!Number.isFinite(commit.authoredAtMs)) return compactAge(commit.age);
  const seconds = Math.max(0, Math.floor((now - commit.authoredAtMs) / 1_000));
  if (seconds < 60) return "now";
  const units = [[31_536_000, "y"], [2_592_000, "mo"], [604_800, "w"], [86_400, "d"], [3_600, "h"], [60, "m"]];
  const [size, unit] = units.find(([size]) => seconds >= size);
  return `${Math.floor(seconds / size)}${unit}`;
}

export function compareFolderGroups([left], [right]) {
  if (!left && right) return 1;
  if (left && !right) return -1;
  return left.localeCompare(right);
}
