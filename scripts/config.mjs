import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "node:process";

const file = fileURLToPath(new URL("../.env.local", import.meta.url));
if (existsSync(file)) loadEnvFile(file);
