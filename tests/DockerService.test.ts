jest.mock("../src/index", () => ({
  mqttClient: {
    publish: jest.fn(),
    on: jest.fn(),
    end: jest.fn(),
  },
}));

jest.mock("../src/registry-factory/ImageRegistryAdapterFactory");

jest.mock("../src/services/HomeassistantService", () => ({
  __esModule: true,
  default: {
    publishUpdateProgressMessage: jest.fn().mockResolvedValue(undefined),
    publishImageUpdateMessage: jest.fn().mockResolvedValue(undefined),
    publishMessage: jest.fn(),
  },
}));

jest.mock("../src/services/DatabaseService", () => ({
  __esModule: true,
  default: {
    getTopics: jest.fn((_containerId: string, cb: Function) => cb(null, [])),
    deleteContainer: jest.fn().mockResolvedValue(undefined),
    addContainer: jest.fn().mockResolvedValue(undefined),
  },
}));

import { ImageRegistryAdapterFactory } from "../src/registry-factory/ImageRegistryAdapterFactory";
import DockerService from "../src/services/DockerService";

describe("DockerService.getImageVersionLabel", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    DockerService.VersionLabelCache.clear();
  });

  it("returns the version label reported by the registry adapter", async () => {
    (ImageRegistryAdapterFactory.getAdapter as jest.Mock).mockReturnValue({
      getVersionLabel: jest.fn().mockResolvedValue("2.15.3"),
    });

    const result = await DockerService.getImageVersionLabel("penpot/backend", "latest");

    expect(result).toBe("2.15.3");
  });

  it("uses the digest cache key when a digest is supplied", async () => {
    const getVersionLabel = jest.fn().mockResolvedValue("2.15.3");
    (ImageRegistryAdapterFactory.getAdapter as jest.Mock).mockReturnValue({ getVersionLabel });

    await DockerService.getImageVersionLabel("penpot/backend", "latest", "abcdef123456");
    const result = await DockerService.getImageVersionLabel("penpot/backend", "latest", "abcdef123456");

    expect(result).toBe("2.15.3");
    expect(getVersionLabel).toHaveBeenCalledTimes(1);
  });

  it("returns null when the adapter throws", async () => {
    (ImageRegistryAdapterFactory.getAdapter as jest.Mock).mockReturnValue({
      getVersionLabel: jest.fn().mockRejectedValue(new Error("network error")),
    });

    const result = await DockerService.getImageVersionLabel("penpot/backend", "latest");

    expect(result).toBeNull();
  });
});

describe("DockerService.updateContainer", () => {
  let originalDocker: any;

  beforeEach(() => {
    jest.clearAllMocks();
    DockerService.updatingContainers = [];
    originalDocker = DockerService.docker;
  });

  afterEach(() => {
    DockerService.docker = originalDocker;
  });

  it("waits for pull progress and replacement startup before resolving", async () => {
    let followProgressDone: Function | undefined;
    const oldContainer = {
      inspect: jest.fn().mockResolvedValue({
        Id: "old-container",
        Image: "sha256:old-image",
        Name: "/esphome",
        Config: {
          Image: "ghcr.io/esphome/esphome:latest",
        },
        HostConfig: {
          Binds: [],
        },
        NetworkSettings: {},
        Mounts: [],
      }),
      stop: jest.fn().mockResolvedValue(undefined),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    const newContainer = {
      start: jest.fn().mockResolvedValue(undefined),
      inspect: jest.fn().mockResolvedValue({
        Id: "new-container",
        Name: "/esphome",
        Config: {
          Image: "ghcr.io/esphome/esphome:latest",
        },
      }),
    };

    DockerService.docker = {
      getContainer: jest.fn().mockReturnValue(oldContainer),
      pull: jest.fn((_image: string, cb: Function) => cb(null, {})),
      modem: {
        followProgress: jest.fn((_stream: any, done: Function) => {
          followProgressDone = done;
        }),
      },
      createContainer: jest.fn().mockResolvedValue(newContainer),
      getImage: jest.fn().mockReturnValue({
        remove: jest.fn((_options: any, cb: Function) => cb(null, {})),
      }),
    } as any;

    let resolved = false;
    const updatePromise = DockerService.updateContainer("old-container").then(() => {
      resolved = true;
    });

    await Promise.resolve();

    expect(resolved).toBe(false);
    expect(newContainer.start).not.toHaveBeenCalled();
    expect(DockerService.updatingContainers).toEqual(["old-container"]);

    followProgressDone?.(null);
    await updatePromise;

    expect(oldContainer.stop).toHaveBeenCalled();
    expect(oldContainer.remove).toHaveBeenCalled();
    expect(newContainer.start).toHaveBeenCalled();
    expect(resolved).toBe(true);
    expect(DockerService.updatingContainers).toEqual([]);
  });
});
