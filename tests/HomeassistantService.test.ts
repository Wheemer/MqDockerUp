process.env.MAIN_PREFIX = "server";

jest.mock("../src/index", () => ({
  mqttClient: {
    publish: jest.fn(),
    on: jest.fn(),
    end: jest.fn(),
  },
}));

jest.mock("../src/services/DockerService", () => ({
  __esModule: true,
  default: {
    listContainers: jest.fn(),
  },
}));

jest.mock("../src/services/DatabaseService", () => ({
  __esModule: true,
  default: {
    containerExists: jest.fn().mockResolvedValue(false),
    addContainer: jest.fn().mockResolvedValue(undefined),
    addTopic: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock("../src/services/IgnoreService", () => ({
  __esModule: true,
  default: {
    ignoreUpdates: jest.fn().mockReturnValue(false),
  },
}));

import { ContainerInspectInfo } from "dockerode";
import DockerService from "../src/services/DockerService";
import DatabaseService from "../src/services/DatabaseService";
import HomeassistantService from "../src/services/HomeassistantService";

describe("HomeassistantService discovery", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("uses container names for Home Assistant identity when containers share an image", async () => {
    const containers = [
      {
        Id: "container-one",
        Name: "/esphome",
        Config: { Image: "ghcr.io/esphome/esphome:latest" },
      },
      {
        Id: "container-two",
        Name: "/esphomefelishas",
        Config: { Image: "ghcr.io/esphome/esphome:latest" },
      },
    ] as unknown as ContainerInspectInfo[];

    (DockerService.listContainers as jest.Mock).mockResolvedValue(containers);

    const client = { publish: jest.fn() };
    await HomeassistantService.publishConfigMessages(client);

    const messages = client.publish.mock.calls.map(([topic, payload]) => ({
      topic,
      payload: JSON.parse(payload),
    }));

    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          topic: "homeassistant/sensor/server_esphome/docker_id/config",
          payload: expect.objectContaining({
            unique_id: "server_esphome Container ID",
            state_topic: "mqdockerup/server_esphome",
            device: expect.objectContaining({
              identifiers: ["server_esphome"],
            }),
          }),
        }),
        expect.objectContaining({
          topic: "homeassistant/sensor/server_esphomefelishas/docker_id/config",
          payload: expect.objectContaining({
            unique_id: "server_esphomefelishas Container ID",
            state_topic: "mqdockerup/server_esphomefelishas",
            device: expect.objectContaining({
              identifiers: ["server_esphomefelishas"],
            }),
          }),
        }),
        expect.objectContaining({
          topic: "homeassistant/button/server_esphome/docker_manual_restart/config",
          payload: expect.objectContaining({
            command_topic: "mqdockerup/server_esphome/command/restart",
            unique_id: "server_esphome_manual_restart",
            device: expect.objectContaining({
              identifiers: ["server_esphome"],
            }),
          }),
        }),
        expect.objectContaining({
          topic: "homeassistant/button/server_esphomefelishas/docker_manual_restart/config",
          payload: expect.objectContaining({
            command_topic: "mqdockerup/server_esphomefelishas/command/restart",
            unique_id: "server_esphomefelishas_manual_restart",
            device: expect.objectContaining({
              identifiers: ["server_esphomefelishas"],
            }),
          }),
        }),
        expect.objectContaining({
          topic: "homeassistant/update/server_esphome/docker_update/config",
          payload: expect.objectContaining({
            command_topic: "mqdockerup/server_esphome/command/update",
          }),
        }),
        expect.objectContaining({
          topic: "homeassistant/update/server_esphomefelishas/docker_update/config",
          payload: expect.objectContaining({
            command_topic: "mqdockerup/server_esphomefelishas/command/update",
          }),
        }),
      ])
    );
  });

  test("records discovery topics for containers that already exist", async () => {
    const containers = [
      {
        Id: "existing-container",
        Name: "/esphome",
        Config: { Image: "ghcr.io/esphome/esphome:latest" },
      },
    ] as unknown as ContainerInspectInfo[];

    (DockerService.listContainers as jest.Mock).mockResolvedValue(containers);
    (DatabaseService.containerExists as jest.Mock).mockResolvedValue(true);

    const client = { publish: jest.fn() };
    await HomeassistantService.publishConfigMessages(client);

    expect(DatabaseService.addContainer).not.toHaveBeenCalled();
    expect(DatabaseService.addTopic).toHaveBeenCalledWith(
      "homeassistant/sensor/server_esphome/docker_id/config",
      "existing-container"
    );
  });
});
