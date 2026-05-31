import assert from "node:assert/strict";
import test from "node:test";
import type { FederationLease } from "../../src/experimental/a2a/federation-lease.ts";
import {
  buildFederationLeaseBody,
  detectFederationSplitBrain,
  parseFederationLeaseBody,
  type LeaseWitness,
} from "../../src/experimental/a2a/federation-lease-witness.ts";

const leaseA: FederationLease = {
  version: 1,
  holderNodeId: "node-a",
  acquiredAt: "2026-01-01T00:00:00.000Z",
  expiresAt: "2099-01-01T00:00:00.000Z",
  term: 1,
};

const leaseB: FederationLease = {
  ...leaseA,
  holderNodeId: "node-b",
};

test("parseFederationLeaseBody round-trip", () => {
  const body = buildFederationLeaseBody(leaseA);
  assert.deepEqual(parseFederationLeaseBody(body), leaseA);
});

test("detectFederationSplitBrain when holders differ", () => {
  const witnesses: LeaseWitness[] = [
    { peerUrl: "http://b", lease: leaseB, valid: true },
  ];
  const report = detectFederationSplitBrain(leaseA, witnesses);
  assert.equal(report.detected, true);
  assert.deepEqual(report.conflictingHolders.sort(), ["node-a", "node-b"]);
});

test("detectFederationSplitBrain false for single holder", () => {
  const witnesses: LeaseWitness[] = [
    { peerUrl: "http://b", lease: leaseA, valid: true },
  ];
  const report = detectFederationSplitBrain(leaseA, witnesses);
  assert.equal(report.detected, false);
});
