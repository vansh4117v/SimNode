import { Simulation } from "simnode";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const sim = new Simulation({ seed: 0 });

sim.scenario(
  "pg inventory double-spend",
  path.join(__dirname, "scenarios", "pg-race.scenario.js")
);

sim.scenario(
  "redis cache stampede",
  path.join(__dirname, "scenarios", "redis-stampede.scenario.js")
);

sim.scenario(
  "http payment retry under partition",
  path.join(__dirname, "scenarios", "http-retry.scenario.js")
);

sim.scenario(
  "fault injection combo",
  path.join(__dirname, "scenarios", "fault-combo.scenario.js")
);

export default sim;
