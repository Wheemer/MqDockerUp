export type ContainerCommand =
  | "update"
  | "restart"
  | "start"
  | "stop"
  | "pause"
  | "unpause"
  | "manualUpdate";

export type ContainerCommandTopic = {
  containerTopic: string;
  command: ContainerCommand;
};

export type ContainerCommandPayload = {
  containerId: string;
  image?: string;
  topicName?: string;
};

const containerCommands = [
  "update",
  "restart",
  "start",
  "stop",
  "pause",
  "unpause",
  "manualUpdate",
] as const satisfies readonly ContainerCommand[];

const commands: ReadonlySet<string> = new Set(containerCommands);

export default class MqttCommandService {
  public static getCommandSubscription(topic: string): string {
    return `${topic}/+/command/+`;
  }

  public static parseCommandTopic(rootTopic: string, topic: string): ContainerCommandTopic | null {
    const prefix = `${rootTopic}/`;

    if (!topic.startsWith(prefix)) {
      return null;
    }

    const parts = topic.substring(prefix.length).split("/");

    if (parts.length !== 3 || parts[1] !== "command") {
      return null;
    }

    const [containerTopic, , command] = parts;

    if (!containerTopic || !commands.has(command)) {
      return null;
    }

    return {
      containerTopic,
      command: command as ContainerCommand,
    };
  }

  public static parseCommandPayload(message: Buffer | string): ContainerCommandPayload | null {
    let payload: unknown;

    try {
      payload = JSON.parse(message.toString());
    } catch {
      return null;
    }

    if (!payload || typeof payload !== "object") {
      return null;
    }

    const containerId = (payload as { containerId?: unknown }).containerId;

    if (typeof containerId !== "string" || !containerId) {
      return null;
    }

    const image = (payload as { image?: unknown }).image;
    const topicName = (payload as { topicName?: unknown }).topicName;

    return {
      containerId,
      ...(typeof image === "string" && image ? { image } : {}),
      ...(typeof topicName === "string" && topicName ? { topicName } : {}),
    };
  }
}
