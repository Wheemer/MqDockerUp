jest.mock("../src/index", () => ({
  mqttClient: { publish: jest.fn(), on: jest.fn(), end: jest.fn() },
}));

var mockDb: any;

jest.mock("../src/services/DatabaseService", () => ({
  __esModule: true,
  default: mockDb = {
    containerExists: jest.fn(),
    getTopics: jest.fn(),
    deleteContainer: jest.fn(),
  },
}));

import HomeassistantService from "../src/services/HomeassistantService";

function makeClient() {
  return { publish: jest.fn() };
}

describe("HomeassistantService.publishMessage", () => {
  beforeEach(() => HomeassistantService.resetPublishCache());

  test("skips a retained message identical to the last one on that topic", () => {
    const client = makeClient();

    HomeassistantService.publishMessage(client, "t/state", { a: 1 }, { retain: true });
    HomeassistantService.publishMessage(client, "t/state", { a: 1 }, { retain: true });
    HomeassistantService.publishMessage(client, "t/state", { a: 1 }, { retain: true });

    expect(client.publish).toHaveBeenCalledTimes(1);
    expect(client.publish).toHaveBeenCalledWith("t/state", '{"a":1}', { retain: true });
  });

  test("publishes again when the retained payload changes", () => {
    const client = makeClient();

    HomeassistantService.publishMessage(client, "t/state", { status: "running" }, { retain: true });
    HomeassistantService.publishMessage(client, "t/state", { status: "exited" }, { retain: true });

    expect(client.publish).toHaveBeenCalledTimes(2);
    expect(client.publish).toHaveBeenLastCalledWith("t/state", '{"status":"exited"}', { retain: true });
  });

  test("tracks topics independently", () => {
    const client = makeClient();

    HomeassistantService.publishMessage(client, "t/a", "x", { retain: true });
    HomeassistantService.publishMessage(client, "t/b", "x", { retain: true });

    expect(client.publish).toHaveBeenCalledTimes(2);
  });

  test("never deduplicates non-retained messages", () => {
    const client = makeClient();

    HomeassistantService.publishMessage(client, "t/progress", { p: 50 }, { retain: false });
    HomeassistantService.publishMessage(client, "t/progress", { p: 50 }, { retain: false });

    expect(client.publish).toHaveBeenCalledTimes(2);
  });

  test("an empty retained payload is sent as-is and clears the cache entry", () => {
    const client = makeClient();

    HomeassistantService.publishMessage(client, "t/cfg", { a: 1 }, { retain: true });
    HomeassistantService.publishMessage(client, "t/cfg", "", { retain: true });
    // After clearing, the same config must be publishable again.
    HomeassistantService.publishMessage(client, "t/cfg", { a: 1 }, { retain: true });

    expect(client.publish).toHaveBeenCalledTimes(3);
    expect(client.publish.mock.calls[1]).toEqual(["t/cfg", "", { retain: true }]);
    expect(client.publish.mock.calls[2]).toEqual(["t/cfg", '{"a":1}', { retain: true }]);
  });

  test("resetPublishCache forces everything to be republished", () => {
    const client = makeClient();

    HomeassistantService.publishMessage(client, "t/state", "x", { retain: true });
    HomeassistantService.resetPublishCache();
    HomeassistantService.publishMessage(client, "t/state", "x", { retain: true });

    expect(client.publish).toHaveBeenCalledTimes(2);
  });
});

describe("HomeassistantService.removeContainer", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    HomeassistantService.resetPublishCache();
  });

  test("clears every stored topic with an empty retained payload and deletes the container", async () => {
    mockDb.containerExists.mockResolvedValue(true);
    mockDb.getTopics.mockImplementation((_id: string, cb: Function) =>
      cb(null, [{ topic: "ha/sensor/x/docker_id/config" }, { topic: "ha/button/x/docker_manual_restart/config" }])
    );
    const client = makeClient();

    const removed = await HomeassistantService.removeContainer(client, "c1");

    expect(removed).toBe(true);
    expect(client.publish).toHaveBeenCalledTimes(2);
    expect(client.publish).toHaveBeenCalledWith("ha/sensor/x/docker_id/config", "", { retain: true, qos: 0 });
    expect(client.publish).toHaveBeenCalledWith("ha/button/x/docker_manual_restart/config", "", { retain: true, qos: 0 });
    expect(mockDb.deleteContainer).toHaveBeenCalledWith("c1");
  });

  test("does nothing for a container the database does not know", async () => {
    mockDb.containerExists.mockResolvedValue(false);
    const client = makeClient();

    const removed = await HomeassistantService.removeContainer(client, "unknown");

    expect(removed).toBe(false);
    expect(client.publish).not.toHaveBeenCalled();
    expect(mockDb.getTopics).not.toHaveBeenCalled();
    expect(mockDb.deleteContainer).not.toHaveBeenCalled();
  });
});
