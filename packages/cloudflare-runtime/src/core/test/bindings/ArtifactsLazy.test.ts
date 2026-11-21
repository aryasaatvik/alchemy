import { expect, it, vi } from "vitest";

const { loadSidecar, close } = vi.hoisted(() => ({
  loadSidecar: vi.fn(),
  close: vi.fn(async () => {}),
}));

vi.mock("../../bindings/artifacts/git-sidecar.ts", () => {
  loadSidecar();
  return { startGitSidecar: async () => ({ close }) };
});

it("loads the Git sidecar only when a local Artifacts backend starts", async () => {
  await import("../../bindings/index.ts");
  expect(loadSidecar).not.toHaveBeenCalled();
  const { ArtifactsController } = await import("../../bindings/artifacts/controller.ts");
  const controller = new ArtifactsController();
  try {
    await controller.get("fixture", 12345);
    expect(loadSidecar).toHaveBeenCalledOnce();
  } finally {
    await controller.dispose();
  }
  expect(close).toHaveBeenCalledOnce();
});
