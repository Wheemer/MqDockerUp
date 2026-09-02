jest.mock("../src/index", () => ({
  mqttClient: { publish: jest.fn(), on: jest.fn(), end: jest.fn() },
}));

const mockAxiosGet = jest.fn();
jest.mock("axios", () => ({
  __esModule: true,
  default: { get: (...args: any[]) => mockAxiosGet(...args) },
}));

import DockerService from "../src/services/DockerService";

describe("DockerService.getSourceRepo", () => {
  const realDocker = DockerService.docker;
  let inspect: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    DockerService.SourceUrlCache.clear();
    inspect = jest.fn();
    DockerService.docker = { getImage: jest.fn().mockReturnValue({ inspect }) } as any;
  });

  afterEach(() => {
    DockerService.docker = realDocker;
  });

  test("uses the OCI source label without asking Docker Hub", async () => {
    inspect.mockResolvedValue({ Config: { Labels: { "org.opencontainers.image.source": "https://github.com/acme/app" } } });

    expect(await DockerService.getSourceRepo("acme/app", "latest")).toBe("https://github.com/acme/app");
    expect(mockAxiosGet).not.toHaveBeenCalled();
  });

  test("caches a miss so Docker Hub is only asked once per image", async () => {
    inspect.mockResolvedValue({ Config: { Labels: {} } });
    mockAxiosGet.mockRejectedValue({ response: { status: 404 } });

    expect(await DockerService.getSourceRepo("acme/app", "latest")).toBeNull();
    expect(await DockerService.getSourceRepo("acme/app", "latest")).toBeNull();
    expect(await DockerService.getSourceRepo("acme/app", "latest")).toBeNull();

    expect(mockAxiosGet).toHaveBeenCalledTimes(1);
    expect(inspect).toHaveBeenCalledTimes(1);
  });

  test("caches a Docker Hub hit", async () => {
    inspect.mockResolvedValue({ Config: { Labels: {} } });
    mockAxiosGet.mockResolvedValue({ status: 200, data: { full_description: "Source code on [GitHub](https://github.com/acme/app), enjoy" } });

    const first = await DockerService.getSourceRepo("acme/app", "latest");
    const second = await DockerService.getSourceRepo("acme/app", "latest");

    expect(first).toBe("https://github.com/acme/app");
    expect(second).toBe(first);
    expect(mockAxiosGet).toHaveBeenCalledTimes(1);
  });

  test("survives a network error without a response object", async () => {
    inspect.mockResolvedValue({ Config: { Labels: {} } });
    mockAxiosGet.mockRejectedValue(new Error("ECONNRESET"));

    await expect(DockerService.getSourceRepo("acme/app", "latest")).resolves.toBeNull();
  });
});
