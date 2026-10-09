export function isEmergencyStopped(): boolean {
  return process.env.CCP_EMERGENCY_STOP === "1";
}
