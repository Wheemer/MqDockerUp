jest.mock("../src/index", () => ({
  mqttClient: {
    publish: jest.fn(),
    on: jest.fn(),
    end: jest.fn(),
  },
}));

import DockerService from "../src/services/DockerService";

const CONTAINER_ID = "abcdef123456abcdef123456abcdef123456abcdef123456abcdef123456abcd";
const SHORT_ID = CONTAINER_ID.substring(0, 12);

describe("DockerService.buildNetworkEndpointsConfig", () => {
  test("preserves static IPs, aliases and links for every network", () => {
    const info = {
      HostConfig: { NetworkMode: "ipvlan_custom" },
      NetworkSettings: {
        Networks: {
          ipvlan_custom: {
            IPAMConfig: { IPv4Address: "10.0.0.181" },
            Aliases: ["paperless", SHORT_ID],
            Links: null,
          },
          proxy: {
            IPAMConfig: null,
            Aliases: ["webserver"],
            Links: ["proxy_caddy_1:caddy"],
          },
        },
      },
    };

    const { endpointsConfig, primaryNetwork } = DockerService.buildNetworkEndpointsConfig(info, CONTAINER_ID);

    expect(primaryNetwork).toBe("ipvlan_custom");
    expect(Object.keys(endpointsConfig).sort()).toEqual(["ipvlan_custom", "proxy"]);
    expect(endpointsConfig.ipvlan_custom.IPAMConfig).toEqual({ IPv4Address: "10.0.0.181" });
    expect(endpointsConfig.proxy.Links).toEqual(["proxy_caddy_1:caddy"]);
    expect(endpointsConfig.proxy.Aliases).toEqual(["webserver"]);
  });

  test("drops the old container's implicit short-ID alias", () => {
    const info = {
      HostConfig: { NetworkMode: "bridge" },
      NetworkSettings: {
        Networks: {
          bridge: { Aliases: [SHORT_ID, "myapp"] },
        },
      },
    };

    const { endpointsConfig } = DockerService.buildNetworkEndpointsConfig(info, CONTAINER_ID);

    expect(endpointsConfig.bridge.Aliases).toEqual(["myapp"]);
  });

  test("falls back to the first network when NetworkMode is not an attached network", () => {
    const info = {
      HostConfig: { NetworkMode: "default" },
      NetworkSettings: {
        Networks: {
          compose_default: { Aliases: [] },
          external_net: { Aliases: [] },
        },
      },
    };

    const { primaryNetwork } = DockerService.buildNetworkEndpointsConfig(info, CONTAINER_ID);

    expect(primaryNetwork).toBe("compose_default");
  });

  test("handles containers with no networks", () => {
    const { endpointsConfig, primaryNetwork } = DockerService.buildNetworkEndpointsConfig(
      { HostConfig: { NetworkMode: "none" }, NetworkSettings: { Networks: {} } },
      CONTAINER_ID
    );

    expect(endpointsConfig).toEqual({});
    expect(primaryNetwork).toBeUndefined();
  });

  test("tolerates missing NetworkSettings and endpoint fields", () => {
    const { endpointsConfig, primaryNetwork } = DockerService.buildNetworkEndpointsConfig({}, CONTAINER_ID);
    expect(endpointsConfig).toEqual({});
    expect(primaryNetwork).toBeUndefined();

    const sparse = DockerService.buildNetworkEndpointsConfig(
      { NetworkSettings: { Networks: { net: {} } } },
      CONTAINER_ID
    );
    expect(sparse.endpointsConfig.net).toEqual({
      IPAMConfig: undefined,
      Links: undefined,
      Aliases: [],
    });
    expect(sparse.primaryNetwork).toBe("net");
  });
});

describe("DockerService.reconnectSecondaryNetworks", () => {
  const realDocker = DockerService.docker;
  let connect: jest.Mock;
  let getNetwork: jest.Mock;

  beforeEach(() => {
    connect = jest.fn().mockResolvedValue(undefined);
    getNetwork = jest.fn().mockReturnValue({ connect });
    DockerService.docker = { getNetwork } as any;
  });

  afterEach(() => {
    DockerService.docker = realDocker;
  });

  test("connects every network except the primary, with its endpoint config", async () => {
    const endpointsConfig = {
      primary_net: { Aliases: ["app"] },
      proxy: { Aliases: ["webserver"], IPAMConfig: { IPv4Address: "172.20.0.5" } },
      mcp: { Aliases: [] },
    };

    await DockerService.reconnectSecondaryNetworks(endpointsConfig, "primary_net", "newid123", "myapp");

    expect(getNetwork).toHaveBeenCalledTimes(2);
    expect(getNetwork).toHaveBeenCalledWith("proxy");
    expect(getNetwork).toHaveBeenCalledWith("mcp");
    expect(getNetwork).not.toHaveBeenCalledWith("primary_net");
    expect(connect).toHaveBeenCalledWith({
      Container: "newid123",
      EndpointConfig: endpointsConfig.proxy,
    });
    expect(connect).toHaveBeenCalledWith({
      Container: "newid123",
      EndpointConfig: endpointsConfig.mcp,
    });
  });

  test("does nothing when the only network is the primary", async () => {
    await DockerService.reconnectSecondaryNetworks({ bridge: {} }, "bridge", "newid123", "myapp");
    expect(getNetwork).not.toHaveBeenCalled();
  });

  test("a failed reconnect does not abort the remaining networks", async () => {
    connect
      .mockRejectedValueOnce(new Error("network not found"))
      .mockResolvedValueOnce(undefined);

    await expect(
      DockerService.reconnectSecondaryNetworks(
        { primary: {}, broken: {}, ok: {} },
        "primary",
        "newid123",
        "myapp"
      )
    ).resolves.toBeUndefined();

    expect(connect).toHaveBeenCalledTimes(2);
  });
});
