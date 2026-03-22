import { Simulation } from "simnode";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const sim = new Simulation({ seed: 0 });

sim.scenario(
  "pg minimal query",
  path.join(__dirname, "scenarios", "pg-minimal.scenario.js")
);

export default sim;
