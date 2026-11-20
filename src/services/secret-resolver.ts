import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";

function expandPath(path: string): string {
  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2));
  }
  if (path === "~") {
    return homedir();
  }
  return path;
}

const GROUP_AND_OTHER_BITS = 0o077;

function checkFilePermissions(filePath: string, platformName: NodeJS.Platform = platform()): void {
  if (platformName === "win32") {
    return;
  }

  try {
    const stats = statSync(filePath);
    const mode = stats.mode & 0o777;

    const exposedBits = mode & GROUP_AND_OTHER_BITS;

    if (exposedBits !== 0) {
      console.warn(
        `Warning: Secret file ${filePath} has permissive permissions (${mode.toString(8).padStart(3, "0")}) granting group/other access. Recommend chmod 600.`
      );
    }
  } catch {
    console.warn(`Warning: Could not check file permissions for ${filePath}`);
  }
}

export function resolveSecretValue(
  value: string | undefined,
  opts?: { platform?: NodeJS.Platform }
): string | undefined {
  if (!value) {
    return undefined;
  }

  if (value.startsWith("file://")) {
    const filePath = expandPath(value.slice(7));

    if (!existsSync(filePath)) {
      throw new Error(`Secret file not found: ${filePath}`);
    }

    try {
      checkFilePermissions(filePath, opts?.platform);

      const content = readFileSync(filePath, "utf-8");
      return content.trim();
    } catch (error) {
      throw new Error(`Failed to read secret file ${filePath}: ${error}`, { cause: error });
    }
  }

  if (value.startsWith("env://")) {
    const envVar = value.slice(6);
    const envValue = process.env[envVar];

    if (!envValue) {
      throw new Error(`Environment variable not found: ${envVar}`);
    }

    return envValue;
  }

  return value;
}
