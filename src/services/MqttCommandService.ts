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

export type ContainerCommandMessage = {
  command: ContainerCommand;
  payload: ContainerCommandPayload;
  containerTopic?: string;
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

  public static getLegacyCommandSubscriptions(topic: string): string[] {
    return containerCommands.map(command => `${topic}/${command}`);
  }

  public static getCommandTopic(rootTopic: string, containerTopic: string, command: ContainerCommand): string {
    return `${rootTopic}/${containerTopic}/command/${command}`;
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

  public static parseLegacyCommandTopic(rootTopic: string, topic: string): ContainerCommand | null {
    const prefix = `${rootTopic}/`;

    if (!topic.startsWith(prefix)) {
      return null;
    }

    const command = topic.substring(prefix.length);

    return commands.has(command) ? command as ContainerCommand : null;
  }

  public static parseCommandMessage(rootTopic: string, topic: string, message: Buffer | string): ContainerCommandMessage | null {
    const payload = this.parseCommandPayload(message);

    if (!payload) {
      return null;
    }

    const commandTopic = this.parseCommandTopic(rootTopic, topic);

    if (commandTopic) {
      if (!this.payloadMatchesCommandTopic(commandTopic, payload)) {
        return null;
      }

      return {
        ...commandTopic,
        payload,
      };
    }

    const legacyCommand = this.parseLegacyCommandTopic(rootTopic, topic);

    if (!legacyCommand) {
      return null;
    }

    return {
      command: legacyCommand,
      payload,
    };
  }

  public static isCommandTopic(rootTopic: string, topic: string): boolean {
    return this.parseCommandTopic(rootTopic, topic) !== null || this.parseLegacyCommandTopic(rootTopic, topic) !== null;
  }

  public static payloadMatchesCommandTopic(commandTopic: ContainerCommandTopic, payload: ContainerCommandPayload): boolean {
    return payload.topicName === commandTopic.containerTopic;
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
