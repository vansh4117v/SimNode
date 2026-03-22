import { Simulation } from "simnode";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const sim = new Simulation({ seed: 0 });

sim.scenario(
  "fault injection combo",
  path.join(__dirname, "scenarios", "fault-combo.scenario.js")
);

export default sim;
