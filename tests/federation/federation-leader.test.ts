import assert from "node:assert/strict";
import test from "node:test";
import {
  electFederationLeaderNodeId,
  nodeIdFromPeerUrl,
  resolveFederationLeaderRole,
} from "../../src/experimental/a2a/federation-leader.ts";

test("electFederationLeaderNodeId picks lexicographic min", () => {
  assert.equal(electFederationLeaderNodeId(["node-b", "node-a", "node-c"]), "node-a");
});

test("nodeIdFromPeerUrl uses hostname", () => {
  assert.equal(nodeIdFromPeerUrl("http://peer-a.example:9400"), "peer-a.example");
});

test("resolveFederationLeaderRole marks local leader when smallest id", async () => {
  const role = await resolveFederationLeaderRole({
    nodeId: "aaa",
    peerUrls: [],
  });
  assert.equal(role.isLeader, true);
  assert.equal(role.leaderNodeId, "aaa");
});
