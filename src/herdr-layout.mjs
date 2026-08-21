import { runCommand } from "./process.mjs";

function contains(outer, inner) {
  return inner.x >= outer.x
    && inner.y >= outer.y
    && inner.x + inner.width <= outer.x + outer.width
    && inner.y + inner.height <= outer.y + outer.height;
}

export function sidebarResizePlan(layout, paneId, configuredWidth) {
  if (!layout || !Number.isInteger(configuredWidth)) return null;
  const pane = layout.panes?.find((item) => item.pane_id === paneId);
  if (!pane?.rect) return null;
  const split = (layout.splits || [])
    .filter((item) => item.direction === "right" && item.rect && contains(item.rect, pane.rect))
    .sort((left, right) => left.rect.width * left.rect.height - right.rect.width * right.rect.height)[0];
  if (!split || split.rect.width <= 0) return null;

  const currentWidth = pane.rect.width;
  const targetWidth = Math.max(
    Math.ceil(split.rect.width * 0.1),
    Math.min(configuredWidth, Math.floor(split.rect.width / 2)),
  );
  if (currentWidth === targetWidth) return null;
  const paneOnRight = pane.rect.x + pane.rect.width / 2 > split.rect.x + split.rect.width / 2;
  const shrinking = currentWidth > targetWidth;
  const direction = paneOnRight
    ? shrinking ? "right" : "left"
    : shrinking ? "left" : "right";
  return {
    paneId,
    direction,
    amount: Math.abs(currentWidth - targetWidth) / split.rect.width,
    currentWidth,
    targetWidth,
  };
}

export async function resizeSidebarPane({ herdr = "herdr", paneId, configuredWidth, run = runCommand }) {
  const layoutResult = await run(herdr, ["pane", "layout", "--pane", paneId], {
    timeoutMs: 5_000,
    maxOutputBytes: 2 * 1024 * 1024,
  });
  const payload = JSON.parse(layoutResult.stdout);
  const plan = sidebarResizePlan(payload?.result?.layout, paneId, configuredWidth);
  if (!plan) return null;
  await run(herdr, [
    "pane", "resize", "--pane", paneId,
    "--direction", plan.direction,
    "--amount", String(plan.amount),
  ], {
    timeoutMs: 5_000,
    maxOutputBytes: 2 * 1024 * 1024,
  });
  return plan;
}
