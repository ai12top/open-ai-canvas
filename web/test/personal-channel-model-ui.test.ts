import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("个人渠道模型选择与管理的真实 UI 流程", () => {
    const result = Bun.spawnSync([process.execPath, "test", "./test/fixtures/personal-channel-model-ui.harness.tsx"], {
        cwd: resolve(import.meta.dir, ".."),
        timeout: 30000,
    });
    const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
    expect(result.exitCode, output).toBe(0);
    expect(output).toContain("7 pass");
    expect(output).toContain("0 fail");
}, 31000);
