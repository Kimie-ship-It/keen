import "./config.mjs";
import { validateHostingConfig } from "./hosting-config.mjs";

try {
  validateHostingConfig();
  console.log("Hosting configuration checks passed; this does not verify a public deployment.");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
