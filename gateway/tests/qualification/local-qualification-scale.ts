import { Evidence, delay, digestFiles, integer, invariant, percentiles, sha256 } from "./local-qualification-evidence.ts";
import { QualificationRuntime } from "./local-qualification-runtime.ts";

export async function qualifyScale(runtime: QualificationRuntime, evidence: Evidence): Promise<void> {
  const warmups = integer("CCP_BENCH_WARMUPS", 10, 0, 100);
  const rounds = integer("CCP_BENCH_SAMPLES", 100, 1, 200);
  const soakSeconds = integer("CCP_QUAL_SOAK_SECONDS", 1800, 0, 7200);
  const intervalMs = integer("CCP_QUAL_SOAK_INTERVAL_MS", 5000, 1000, 60_000);
  const rssBudget = integer("CCP_QUAL_RSS_MIB", 768, 64, 16_384) * 1024 * 1024;
  const growthBudget = integer("CCP_QUAL_RSS_GROWTH_MIB", 256, 16, 8192) * 1024 * 1024;
  const httpP95Budget = integer("CCP_QUAL_HTTP_P95_MS", 2000, 1, 60_000);
  invariant(runtime.clients.length === 100, "SCALE_REQUIRES_100_DEVICES");
  evidence.emit({ type: "configuration", scenario: "scale", clients: 100, warmups, rounds, soakSeconds, intervalMs, rssBudget, growthBudget,
    gatewayCoreP95BudgetMs: 5, httpP95Budget, admission: runtime.admissionConfig,
    workload: "100-concurrent-devices-one-serialized-mutation-per-device", qualificationProfile: "loopback-capacity-not-LAN-performance" });
  const wave = async (scenario: string, jitter = false) => {
    const before = runtime.requests;
    const settled = await Promise.allSettled(runtime.clients.map(async (client, index) => {
      if (jitter) await delay((index * 37) % 251);
      return runtime.call(client, scenario);
    }));
    invariant(runtime.requests - before === 100, "ONE_POST_PER_DEVICE_VIOLATION");
    invariant(runtime.active === 0, "QUEUE_NOT_DRAINED");
    invariant(settled.every((entry) => entry.status === "fulfilled"), "DEVICE_WAVE_FAILED");
    return settled.flatMap((entry) => entry.status === "fulfilled" ? [entry.value] : []);
  };
  await evidence.scenario("100-device-steady", async () => {
    for (let round = 0; round < warmups; round += 1) await wave("100-device-warmup");
    const total: number[] = []; const gateway: number[] = [];
    for (let round = 0; round < rounds; round += 1) {
      const results = await wave("100-device-steady");
      total.push(...results.map((result) => result.latencyMs));
      gateway.push(...results.map((result) => result.gatewayMs!));
    }
    const latency = percentiles(total); const gatewayCore = percentiles(gateway);
    evidence.emit({ type: "performance-summary", scenario: "100-device-steady", latency, gatewayCore });
    invariant(latency.p95 <= httpP95Budget, "HTTP_P95_BUDGET_EXCEEDED");
    invariant(gatewayCore.p95 <= 5, "GATEWAY_CORE_P95_BUDGET_EXCEEDED");
    return { clients: 100, warmups, rounds, latency, gatewayCore, prescribedSampleCountMet: warmups >= 10 && rounds >= 100 };
  });
  await evidence.scenario("100-device-reconnect", async () => {
    const restartStarted = performance.now();
    const identities = runtime.clients.map((client) => `${client.deviceId}:${client.instanceId}:${client.relay.packageHash}`);
    await runtime.restart();
    const results = await wave("100-device-reconnect", true);
    invariant(runtime.store.counts().activeDevices === 100, "DEVICE_STATE_LOST_ON_RESTART");
    invariant(runtime.clients.every((client, index) => `${client.deviceId}:${client.instanceId}:${client.relay.packageHash}` === identities[index]), "CLIENT_IDENTITY_CHANGED");
    return { clients: 100, restartMs: performance.now() - restartStarted, jitterMaxMs: 250, latency: percentiles(results.map((result) => result.latencyMs)),
      restartBoundary: "real-http-server-and-durable-SQLite-reopen-same-Node-process", sleepResume: "not-exercised" };
  });
  await evidence.scenario("100-device-soak", async () => {
    invariant(soakSeconds > 0, "SOAK_NOT_RUN");
    const started = performance.now(); const baselineRss = process.memoryUsage().rss;
    let rounds = 0; let maxRss = baselineRss; let maxHeap = 0;
    while (performance.now() - started < soakSeconds * 1000) {
      const waveStarted = performance.now();
      await wave("100-device-soak"); rounds += 1;
      const memory = process.memoryUsage(); maxRss = Math.max(maxRss, memory.rss); maxHeap = Math.max(maxHeap, memory.heapUsed);
      evidence.emit({ type: "soak-resource-sample", scenario: "100-device-soak", elapsedMs: performance.now() - started,
        round: rounds, rssBytes: memory.rss, heapBytes: memory.heapUsed, pendingAtWaveEnd: runtime.active,
        maxObservedHttpActive: runtime.maxActive, replayRows: runtime.store.counts().replayRows });
      invariant(memory.rss <= rssBudget, "RSS_ABSOLUTE_BUDGET_EXCEEDED");
      invariant(memory.rss - baselineRss <= growthBudget, "RSS_GROWTH_BUDGET_EXCEEDED");
      invariant(runtime.maxActive <= 100, "UNBOUNDED_HTTP_PENDING");
      const remaining = soakSeconds * 1000 - (performance.now() - started);
      if (remaining > 0) await delay(Math.min(remaining, Math.max(0, intervalMs - (performance.now() - waveStarted))));
    }
    return { durationMs: performance.now() - started, requestedSeconds: soakSeconds, thirtyMinuteGateMet: soakSeconds >= 1800,
      rounds, maxRss, maxHeap, baselineRss, queueMeasurement: "HTTP-inflight-high-water-and-wave-drain-not-private-semaphore-depth" };
  });
}

export async function qualifyWarranty(runtime: QualificationRuntime, evidence: Evidence): Promise<void> {
  await evidence.scenario("ten-unchanged-client-planner-warranty", async () => {
    const clients = runtime.clients.slice(0, 10);
    const paths = ["source/protected/decision-verifier.ts", "source/protected/primitive-executor.ts", "source/protected/protocol.ts",
      "source/protected/value-resolver.ts", "source/protected/schemas.ts"];
    const beforeSource = digestFiles(paths);
    const identities = clients.map((client) => ({ deviceId: client.deviceId, instanceId: client.instanceId, ...client.relay }));
    const beforePosts = runtime.requests;
    runtime.deployPlanner(true);
    try {
      for (const client of clients) {
        const before = await runtime.call(client, "warranty-before-controlled-server-defect");
        invariant(before.nameHash === sha256("Canvas"), "CONTROLLED_PLANNER_DEFECT_NOT_OBSERVED");
      }
      runtime.deployPlanner(false);
      for (const client of clients) {
        const after = await runtime.call(client, "warranty-after-real-planner");
        invariant(after.nameHash === sha256("Qualification Named Node"), "PLANNER_FIX_NOT_OBSERVED");
      }
      invariant(runtime.requests - beforePosts === 20, "WARRANTY_POST_COUNT_MISMATCH");
      invariant(digestFiles(paths) === beforeSource, "CLIENT_SOURCE_CHANGED_DURING_WARRANTY");
      invariant(clients.every((client, index) => JSON.stringify({ deviceId: client.deviceId, instanceId: client.instanceId, ...client.relay }) === JSON.stringify(identities[index])), "WARRANTY_CLIENT_IDENTITY_CHANGED");
      return { clients: identities, sourceSha256: beforeSource, clientReplacements: 0, packageDownloads: 0,
        beforeNameHash: sha256("Canvas"), afterNameHash: sha256("Qualification Named Node"),
        plannerChange: "controlled-server-only-name-provenance-defect-to-existing-production-planner",
        behaviorSurface: "real-relay-executor-to-simulated-Creator-adapter", creatorInstallations: 0 };
    } finally { runtime.deployPlanner(false); }
  });
}
