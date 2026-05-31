import assert from "node:assert/strict";
import test from "node:test";
import { agentGraphToCanvasHtml } from "../src/orchestration/agent-graph-canvas.ts";
import type { AgentGraphSnapshot } from "../src/orchestration/agent-graph-io.ts";

const snap: AgentGraphSnapshot = {
  source: "config",
  waves: [["a"], ["b"]],
  nodes: [
    { id: "a", providers: "mock", dependsOn: [] },
    { id: "b", providers: "mock", dependsOn: ["a"] },
  ],
};

test("agentGraphToCanvasHtml includes SVG DAG UI", () => {
  const html = agentGraphToCanvasHtml(snap);
  assert.match(html, /dagSvg/);
  assert.match(html, /__agentGraphCanvasInit/);
  assert.match(html, /createElementNS/);
  assert.doesNotMatch(html, /innerHTML/);
  assert.match(html, /viewport/);
  assert.match(html, /localStorage/);
  assert.match(html, /wheel/);
  assert.match(html, /autoLayout/);
  assert.match(html, /exportPng/);
  assert.match(html, /removeEdge/);
  assert.match(html, /undoStack/);
  assert.match(html, /selectedEdge/);
  assert.match(html, /selectedIds/);
  assert.match(html, /guideLines/);
  assert.match(html, /SNAP/);
  assert.match(html, /boxSelect/);
  assert.match(html, /selectionRect/);
  assert.match(html, /alignLeft/);
  assert.match(html, /distributeH/);
  assert.match(html, /nodeMeta/);
  assert.match(html, /selGroup/);
  assert.match(html, /selLocked/);
  assert.match(html, /isLocked/);
  assert.match(html, /groupBounds/);
  assert.match(html, /collapsedGroups/);
  assert.match(html, /toggleGroupCollapse/);
  assert.match(html, /lockGroup/);
  assert.match(html, /isNodeHidden/);
  assert.match(html, /dragIdsForNode/);
  assert.match(html, /alignActiveGroup/);
  assert.match(html, /alignGroupLeft/);
  assert.match(html, /groupKeyForNode/);
  assert.match(html, /parentGroup/);
  assert.match(html, /groupLinks/);
  assert.match(html, /addGroupLink/);
  assert.match(html, /removeGroupLink/);
  assert.match(html, /collapsedParents/);
  assert.match(html, /toggleParentCollapse/);
  assert.match(html, /selectedGroupLink/);
  assert.match(html, /applyGroupLink/);
  assert.match(html, /groupLinksToMermaid/);
  assert.match(html, /groupMermaid/);
  assert.match(html, /copyGroupMermaid/);
  assert.match(html, /startParentGroupDrag/);
  assert.match(html, /nodeIdsInParentGroup/);
  assert.match(html, /fromGroupMermaid/);
  assert.match(html, /importGroupLinksFromMermaid/);
  assert.match(html, /parseGroupLinksFromMermaid/);
  assert.match(html, /findDanglingGroupKeys/);
  assert.match(html, /isPlaceholderNode/);
  assert.match(html, /#fef9c3/);
  assert.match(html, /repairDanglingGroupLinks/);
  assert.match(html, /fixDanglingRemove/);
  assert.match(html, /fixDanglingPlaceholder/);
  assert.match(html, /removePlaceholders/);
  assert.match(html, /removeAllPlaceholderNodes/);
  assert.match(html, /recomputeWavesClient\(snap\.nodes\)/);
  assert.match(html, /snap\.layout = \{\}/);
  assert.match(html, /layoutNodes\(\)/);
  assert.match(html, /Removed .* placeholder/);
  assert.match(html, /undoFooterHint/);
  assert.match(html, /updateUndoFooter/);
  assert.match(html, /undo: .* · redo:/);
  assert.match(html, /\/40/);
  assert.match(html, /MAX_HISTORY/);
  assert.match(html, /canvasFooter/);
  assert.match(html, /undo-stack-full/);
  assert.match(html, /oldest change dropped/);
  assert.match(html, /click to dismiss/);
  assert.match(html, /updateGraphStatus/);
  assert.match(html, /data-kind="warn"/);
});

test("agentGraphToCanvasHtml serializes nodeMeta in initial snapshot", () => {
  const withMeta: AgentGraphSnapshot = {
    ...snap,
    nodeMeta: { a: { group: "g1", locked: true } },
  };
  const html = agentGraphToCanvasHtml(withMeta);
  assert.match(html, /"group":"g1"/);
  assert.match(html, /"locked":true/);
});
