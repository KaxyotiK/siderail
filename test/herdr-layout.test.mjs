import assert from "node:assert/strict";
import test from "node:test";
import { resizeSidebarPane, sidebarResizePlan } from "../src/herdr-layout.mjs";

function layout(paneWidth, splitWidth = 180) {
  return {
    panes: [{ pane_id: "w1:p2", rect: { x: splitWidth - paneWidth, y: 0, width: paneWidth, height: 40 } }],
    splits: [{ direction: "right", rect: { x: 0, y: 0, width: splitWidth, height: 40 } }],
  };
}

test("configured sidebar width shrinks a new right split to exact columns", () => {
  const plan = sidebarResizePlan(layout(90), "w1:p2", 34);
  assert.equal(plan.direction, "right");
  assert.equal(plan.currentWidth, 90);
  assert.equal(plan.targetWidth, 34);
  assert.equal(plan.amount, 56 / 180);
});

test("configured width never takes more than half a narrow split", () => {
  const plan = sidebarResizePlan(layout(20, 40), "w1:p2", 34);
  assert.equal(plan, null);
  const expand = sidebarResizePlan(layout(18, 52), "w1:p2", 34);
  assert.equal(expand.direction, "left");
  assert.equal(expand.targetWidth, 26);
});

test("configured width respects Herdr's minimum split ratio", () => {
  const plan = sidebarResizePlan(layout(250, 500), "w1:p2", 20);
  assert.equal(plan.targetWidth, 50);
});

test("sidebar resize uses Herdr layout and pane APIs without changing focus", async () => {
  const calls = [];
  const run = async (_command, args) => {
    calls.push(args);
    if (args[1] === "layout") return { stdout: JSON.stringify({ result: { layout: layout(90) } }) };
    return { stdout: JSON.stringify({ result: { resize: { changed: true } } }) };
  };
  const plan = await resizeSidebarPane({ herdr: "herdr", paneId: "w1:p2", configuredWidth: 34, run });
  assert.equal(plan.targetWidth, 34);
  assert.deepEqual(calls[1].slice(0, 7), [
    "pane", "resize", "--pane", "w1:p2", "--direction", "right", "--amount",
  ]);
});
