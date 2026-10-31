// Alchemy modifications are licensed under Apache-2.0.
// Adapted from cloudflare/workers-sdk d8899ac4c85ff839d73daa9055a76a36248cd2e3 (MIT).
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
import { createServer } from "node:net";
import { startGitSidecar, type GitSidecar } from "./git-sidecar.ts";

export interface LocalArtifactsBackend {
  sidecar: GitSidecar;
  port: number;
}

// Runtime binding calls are asynchronous; the backend can share the host event loop.
export class ArtifactsController {
  private backends = new Map<string, Promise<LocalArtifactsBackend>>();

  get(root: string, gitPort?: number): Promise<LocalArtifactsBackend> {
    let backend = this.backends.get(root);
    if (!backend) {
      backend = this.start(root, gitPort);
      this.backends.set(root, backend);
      void backend.catch(() => {
        if (this.backends.get(root) === backend) this.backends.delete(root);
      });
    }
    return backend;
  }

  private async start(root: string, gitPort?: number): Promise<LocalArtifactsBackend> {
    if (gitPort !== undefined && (!Number.isInteger(gitPort) || gitPort < 1 || gitPort > 65535)) {
      throw new Error("Local Artifacts gitPort must be an integer between 1 and 65535");
    }
    const port =
      gitPort ??
      (await new Promise<number>((resolve, reject) => {
        const server = createServer();
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          if (!address || typeof address === "string") {
            server.close();
            reject(new Error("Unable to allocate local Artifacts Git port"));
            return;
          }
          server.close((error) => (error ? reject(error) : resolve(address.port)));
        });
      }));
    return { port, sidecar: await startGitSidecar(root) };
  }

  async dispose(): Promise<void> {
    const backends = [...this.backends.values()];
    this.backends.clear();
    await Promise.all(backends.map(async (backend) => (await backend).sidecar.close()));
  }
}
