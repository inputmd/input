#!/usr/bin/env node
import { APP_NAME } from "../config.js";
process.title = APP_NAME;
process.emitWarning = (() => { });
await import("./register-bedrock.js");
await import("../cli.js");
//# sourceMappingURL=cli.js.map