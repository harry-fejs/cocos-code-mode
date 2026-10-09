import { Evidence, errorCode, invariant } from "./local-qualification-evidence.ts";
import { QualificationRuntime } from "./local-qualification-runtime.ts";
import { qualifyScale, qualifyWarranty } from "./local-qualification-scale.ts";
import { qualifyCanary } from "./local-qualification-canary.ts";

// From gateway/: npm run qualify:local
// Default: all scenarios, 100 devices, 10 warmups + 100 rounds, 30-minute
// scale soak, actual 15-minute canary soaks. No installed runtime is touched.
// CCP_QUAL_SCENARIOS=scale,warranty,canary selects explicitly reported scope.
// CCP_QUAL_CANARY_CLOCK=fixture seeds ONLY temporary DB timestamps for fast
// policy logic qualification; it NEVER counts as actual canary elapsed soak.
// CCP_QUAL_SOAK_SECONDS changes the scale duration (default 1800); short runs
// explicitly report thirtyMinuteGateMet=false, not full soak acceptance.
// CCP_QUAL_EVIDENCE selects a new NDJSON file (exclusive creation, 128 MiB cap).
// All keys are generated in memory; only isolated temporary SQLite/update
// state is persisted and deleted. Nonzero exit means a scenario failed.
const evidence = new Evidence();
let runtime: QualificationRuntime | undefined;
try {
  invariant(process.env.CCP_EMERGENCY_STOP !== "1", "INHERITED_EMERGENCY_STOP_ACTIVE");
  const scenarios = (process.env.CCP_QUAL_SCENARIOS ?? "scale,warranty,canary").split(",");
  invariant(scenarios.length > 0 && new Set(scenarios).size === scenarios.length && scenarios.every((name) => ["scale", "warranty", "canary"].includes(name)), "INVALID_SCENARIO_SELECTION");
  evidence.emit({ type: "scope", scenarios, omittedScenarios: ["scale", "warranty", "canary"].filter((name) => !scenarios.includes(name)),
    unexercised: ["actual-Creator", "actual-installation", "artifact-download-staging-activation", "health-rollback", "production-TLS-LAN", "OS-sleep-resume", "external-signer-process"],
    fixtureClockDoesNotProveSoak: true, sourceHarnessDoesNotProveInstalledPackage: true });
  runtime = new QualificationRuntime(evidence, 100);
  await runtime.start();
  evidence.emit({ type: "isolation", storage: "temporary-SQLite-outside-installed-runtime", keys: "fresh-in-memory-separate-member-device-execution-root-target-policy",
    devices: runtime.clients.length, memberJwtVerification: "real-EdDSA-neutral-verifier", admission: { ...runtime.admissionConfig, allowedHosts: [...runtime.admissionConfig.allowedHosts] } });
  if (scenarios.includes("scale")) await qualifyScale(runtime, evidence);
  if (scenarios.includes("warranty")) await qualifyWarranty(runtime, evidence);
  if (scenarios.includes("canary")) await qualifyCanary(runtime, evidence);
} catch (error) {
  evidence.failed += 1;
  evidence.emit({ type: "fatal", pass: false, errorCode: errorCode(error) });
} finally {
  try { if (runtime) await runtime.close(); }
  catch (error) { evidence.failed += 1; evidence.emit({ type: "cleanup", pass: false, errorCode: errorCode(error) }); }
  evidence.close();
}
