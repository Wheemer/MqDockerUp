import MqttCommandService from "../src/services/MqttCommandService";

describe("MqttCommandService", () => {
  test("builds the scoped command subscription", () => {
    expect(MqttCommandService.getCommandSubscription("mqdockerup_server")).toBe("mqdockerup_server/+/command/+");
  });

  test("parses scoped command topics", () => {
    expect(MqttCommandService.parseCommandTopic("mqdockerup_server", "mqdockerup_server/server_esphome/command/restart")).toEqual({
      containerTopic: "server_esphome",
      command: "restart",
    });
  });

  test("rejects unrelated, malformed, and unknown command topics", () => {
    expect(MqttCommandService.parseCommandTopic("mqdockerup_server", "other/server_esphome/command/restart")).toBeNull();
    expect(MqttCommandService.parseCommandTopic("mqdockerup_server", "mqdockerup_server/server_esphome/restart")).toBeNull();
    expect(MqttCommandService.parseCommandTopic("mqdockerup_server", "mqdockerup_server/server_esphome/command/delete")).toBeNull();
    expect(MqttCommandService.parseCommandTopic("mqdockerup_server", "mqdockerup_server/server_esphome/extra/command/restart")).toBeNull();
  });

  test("parses valid command payloads", () => {
    expect(MqttCommandService.parseCommandPayload(JSON.stringify({
      containerId: "abc123",
      image: "ghcr.io/esphome/esphome",
      topicName: "server_esphome",
    }))).toEqual({
      containerId: "abc123",
      image: "ghcr.io/esphome/esphome",
      topicName: "server_esphome",
    });
  });

  test("rejects invalid command payloads", () => {
    expect(MqttCommandService.parseCommandPayload("{")).toBeNull();
    expect(MqttCommandService.parseCommandPayload("{}")).toBeNull();
    expect(MqttCommandService.parseCommandPayload(JSON.stringify({ containerId: "" }))).toBeNull();
    expect(MqttCommandService.parseCommandPayload(JSON.stringify({ containerId: 42 }))).toBeNull();
  });
});
