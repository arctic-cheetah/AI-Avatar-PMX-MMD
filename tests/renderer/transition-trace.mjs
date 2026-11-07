// Print smoothness numbers for the issue #54 transition scenarios.
// Run with: node tests/renderer/transition-trace.mjs [--json]
// Synthetic fixtures only, so the output is safe to paste into a PR.
import { FRAME_RATES, SCENARIOS, measure, runScenario } from "./transition-fixtures.mjs";

const rows = [];
for (const scenario of SCENARIOS) {
  for (const fps of FRAME_RATES) {
    const metrics = measure(runScenario(scenario, fps));
    for (const [channel, value] of Object.entries(metrics)) {
      rows.push({ scenario: scenario.name, fps, channel, ...value });
    }
  }
}

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  const fixed = (value) => value.toFixed(3).padStart(8);
  console.log("scenario".padEnd(50), "fps", "channel".padEnd(7), "  maxStep", " peakVel", " velJump", "     min", "     max");
  for (const row of rows) {
    console.log(row.scenario.padEnd(50), String(row.fps).padStart(3), row.channel.padEnd(7),
      fixed(row.maxStep), fixed(row.peakVelocity), fixed(row.maxVelocityJump), fixed(row.min), fixed(row.max));
  }
}
