import type { Plugin } from "@opencode/plugin/promise/plugin";
import { OpenCodeMemPlugin } from "../index.js";
import { CONFIG } from "../config.js";
import { loadOpencodeProvider } from "../services/ai/opencode-provider-loader.js";
import { registerV2Adapter } from "./adapter.js";
import { createLegacyClient } from "./legacy-client.js";
import { MemToast } from "./toast-rpc.js";

const OpenCodeMemPluginV2: Plugin = {
  id: "opencode-mem",
  async setup(ctx) {
    const toastRpc = await ctx.rpc.register(MemToast, {});
    const legacyClient = createLegacyClient(ctx, toastRpc);
    const legacy = (await OpenCodeMemPlugin({
      client: legacyClient,
      directory: ctx.location.directory,
      worktree: ctx.location.project.directory,
      project: ctx.location.project,
      serverUrl: undefined,
    } as any)) as any;

    const { setV2Client, setStructuredOutputTimeoutConfig } = await loadOpencodeProvider();
    setV2Client(legacyClient);
    setStructuredOutputTimeoutConfig(CONFIG.opencodeTimeoutMs);

    return registerV2Adapter(ctx, legacy);
  },
};

export default OpenCodeMemPluginV2;
