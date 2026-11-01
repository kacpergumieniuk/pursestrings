/** Load ./.env if present (Node >= 20.12). Never required; every setting has a default. */
import { existsSync } from "node:fs";

if (existsSync(".env") && typeof process.loadEnvFile === "function") process.loadEnvFile(".env");
