jest.mock("../src/index", () => ({
  mqttClient: {
    publish: jest.fn(),
    on: jest.fn(),
    end: jest.fn(),
  },
}));

jest.mock("../src/registry-factory/ImageRegistryAdapterFactory");

jest.mock("axios", () => ({
  __esModule: true,
  default: {
    get: jest.fn(),
  },
}));

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
import axios from "axios";
import DockerService from "../src/services/DockerService";

describe("DockerService.getSourceRepo", () => {
  let originalDocker: any;
  const axiosGet = axios.get as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    DockerService.SourceUrlCache.clear();
    originalDocker = DockerService.docker;
    DockerService.docker = {
      getImage: jest.fn().mockReturnValue({
        inspect: jest.fn().mockResolvedValue({
          Config: {
            Labels: {},
          },
        }),
      }),
    } as any;
  });

  afterEach(() => {
    DockerService.docker = originalDocker;
  });

  it("does not query Docker Hub for images from another registry", async () => {
    const result = await DockerService.getSourceRepo("ghcr.io/blakeblackshear/frigate", "stable");

    expect(result).toBeNull();
    expect(axiosGet).not.toHaveBeenCalled();
  });

  it("parses ordinary GitHub links from Docker Hub descriptions", async () => {
    axiosGet.mockResolvedValue({
      status: 200,
      data: {
        full_description: "Report issues at https://github.com/portainer/portainer/issues/new",
      },
    });

    const result = await DockerService.getSourceRepo("portainer/portainer-ce", "latest");

    expect(result).toBe("https://github.com/portainer/portainer");
    expect(axiosGet).toHaveBeenCalledWith("https://hub.docker.com/v2/repositories/portainer/portainer-ce");
  });

  it("normalizes official Docker Hub image names before lookup", async () => {
    axiosGet.mockResolvedValue({
      status: 200,
      data: {
        full_description: "Maintained at https://github.com/nginxinc/docker-nginx",
      },
    });

    const result = await DockerService.getSourceRepo("nginx", "latest");

    expect(result).toBe("https://github.com/nginxinc/docker-nginx");
    expect(axiosGet).toHaveBeenCalledWith("https://hub.docker.com/v2/repositories/library/nginx");
  });
});

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
    jest.restoreAllMocks();
    DockerService.docker = originalDocker;
  });

  it("waits for pull progress and replacement startup before resolving", async () => {
    let followProgressDone: Function | undefined;
    const updateInfoSpy = jest.spyOn(DockerService, "getImageUpdateInfo").mockResolvedValue({
      newDigest: "sha256:new-image",
      tag: "latest",
    });
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
    await Promise.resolve();

    expect(resolved).toBe(false);
    expect(newContainer.start).not.toHaveBeenCalled();
    expect(DockerService.updatingContainers).toEqual(["old-container"]);

    followProgressDone?.(null);
    await updatePromise;

    expect(oldContainer.stop).toHaveBeenCalled();
    expect(oldContainer.remove).toHaveBeenCalled();
    expect(newContainer.start).toHaveBeenCalled();
    expect(DockerService.docker.pull).toHaveBeenCalledWith("ghcr.io/esphome/esphome:latest", expect.any(Function));
    expect(resolved).toBe(true);
    expect(DockerService.updatingContainers).toEqual([]);
    updateInfoSpy.mockRestore();
  });

  it("pulls the resolved newer release tag when updating a pinned image", async () => {
    let followProgressDone: Function | undefined;
    const updateInfoSpy = jest.spyOn(DockerService, "getImageUpdateInfo").mockResolvedValue({
      newDigest: "sha256:frigate-0.17.2",
      tag: "0.17.2",
    });
    const oldContainer = {
      inspect: jest.fn().mockResolvedValue({
        Id: "frigate-container",
        Image: "sha256:frigate-0.17.1",
        Name: "/frigate",
        Config: {
          Image: "ghcr.io/blakeblackshear/frigate:0.17.1",
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
        Id: "new-frigate-container",
        Name: "/frigate",
        Config: {
          Image: "ghcr.io/blakeblackshear/frigate:0.17.2",
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

    const updatePromise = DockerService.updateContainer("frigate-container");

    await Promise.resolve();
    await Promise.resolve();
    followProgressDone?.(null);
    await updatePromise;

    expect(DockerService.docker.pull).toHaveBeenCalledWith("ghcr.io/blakeblackshear/frigate:0.17.2", expect.any(Function));
    expect(DockerService.docker.createContainer).toHaveBeenCalledWith(expect.objectContaining({
      Image: "ghcr.io/blakeblackshear/frigate:0.17.2",
    }));
    expect(oldContainer.stop).toHaveBeenCalled();
    expect(oldContainer.remove).toHaveBeenCalled();
    expect(newContainer.start).toHaveBeenCalled();
    updateInfoSpy.mockRestore();
  });
});
