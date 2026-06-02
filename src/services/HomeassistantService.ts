import DockerService from "./DockerService";
import ConfigService from "./ConfigService";
import DatabaseService from "./DatabaseService";
import logger from "./LoggerService"
import {ContainerInspectInfo, ContainerInfo} from "dockerode";
import IgnoreService from "./IgnoreService";
import MqttCommandService, {ContainerCommand} from "./MqttCommandService";

const config = ConfigService.getConfig();
const packageJson = require("../../package");

const haLegacy = ConfigService.autoParseEnvVariable(config.mqtt?.haLegacy)
const suggestedArea = config.mqtt?.suggestedArea ?? "Docker";

type DiscoveryDevice = {
  manufacturer: string;
  model: string;
  name: string;
  sw_version: string;
  sa: string;
  identifiers: string[];
};

type ContainerIdentity = {
  image: string;
  tag: string;
  imageReference: string;
  digest?: string;
  containerName: string;
  topicName: string;
};

export default class HomeassistantService {
  private static readonly safeNameRegex = /[\/.:;,+*?@^$%#!&"'`|<>{}\[\]()-\s\u0000-\u001F\u007F]/g;

  private static formatSafeName(value: string, replacement: string = "_"): string {
    return value.replace(this.safeNameRegex, replacement);
  }

  private static getContainerName(container: ContainerInspectInfo): string {
    return container.Name.startsWith("/") ? container.Name.substring(1) : container.Name;
  }

  private static splitImageReference(reference: string | null | undefined): { image: string; tag: string; digest?: string } {
    if (!reference) {
      return {image: "unknown", tag: "latest"};
    }

    const digestIndex = reference.indexOf("@");
    const imageReference = digestIndex === -1 ? reference : reference.substring(0, digestIndex);
    const digest = digestIndex === -1 ? undefined : reference.substring(digestIndex + 1);
    const lastSlashIndex = imageReference.lastIndexOf("/");
    const lastColonIndex = imageReference.lastIndexOf(":");

    if (lastColonIndex > lastSlashIndex) {
      return {
        image: imageReference.substring(0, lastColonIndex),
        tag: imageReference.substring(lastColonIndex + 1) || "latest",
        ...(digest ? {digest} : {}),
      };
    }

    return {
      image: imageReference,
      tag: "latest",
      ...(digest ? {digest} : {}),
    };
  }

  private static getContainerIdentity(container: ContainerInspectInfo): ContainerIdentity {
    const prefix = config?.main.prefix || "";
    const imageReference = container.Config?.Image || "unknown";
    const {image, tag, digest} = this.splitImageReference(imageReference);
    const containerName = this.getContainerName(container);
    const formattedContainerName = this.formatSafeName(containerName);
    const topicName = prefix ? `${prefix}_${formattedContainerName}` : formattedContainerName;

    return {
      image,
      tag,
      imageReference,
      ...(digest ? {digest} : {}),
      containerName,
      topicName,
    };
  }

  private static getContainerTopicName(container: ContainerInspectInfo): string {
    return this.getContainerIdentity(container).topicName;
  }

  private static getContainerCommandTopic(topicName: string, command: ContainerCommand): string {
    return MqttCommandService.getCommandTopic(config.mqtt.topic, topicName, command);
  }

  private static createDevice(imageReference: string, deviceName: string): DiscoveryDevice {
    return {
      manufacturer: "MqDockerUp",
      model: imageReference,
      name: deviceName,
      sw_version: packageJson.version,
      sa: suggestedArea,
      identifiers: [this.formatSafeName(deviceName)],
    };
  }

  private static createButtonPayload(
    name: string,
    imageReference: string,
    topicName: string,
    command: ContainerCommand,
    containerId: string,
    icon: string,
    payloadPress: string = command,
    uniqueSuffix: string = command
  ): object {
    return {
      name,
      unique_id: `${topicName}_${uniqueSuffix}`,
      command_topic: this.getContainerCommandTopic(topicName, command),
      command_template: JSON.stringify({containerId, topicName}),
      availability: {
        topic: `${config.mqtt.topic}/availability`,
      },
      payload_press: payloadPress,
      device: this.createDevice(imageReference, topicName),
      icon,
    };
  }

  private static async recordDiscoveryTopic(topic: string, containerId: string, currentTopics: string[]): Promise<void> {
    currentTopics.push(topic);
    await DatabaseService.addTopic(topic, containerId);
  }

  private static async removeStaleDiscoveryTopics(client: any, containerId: string, currentTopics: string[]) {
    const currentTopicSet = new Set(currentTopics);
    const storedTopics = await DatabaseService.getTopicsForContainer(containerId);

    for (const {topic} of storedTopics) {
      if (currentTopicSet.has(topic)) {
        continue;
      }

      this.publishMessage(client, topic, "", {retain: true});
      await DatabaseService.deleteTopic(topic, containerId);
    }
  }

  /**
   * Published availability message to the MQTT broker to indicate if the service is online or offline
   * @param client The MQTT client
   * @param online Indicates if the service is online or offline
   */
  public static async publishAvailability(client: any, online: boolean) {
    const payload = online ? "online" : "offline";
    const topic = `${config.mqtt.topic}/availability`;

    this.publishMessage(client, topic, payload, {retain: true});
  }

  /**
   * Publishes the messages to the MQTT broker
   * @param client The MQTT client
   */
  public static async publishConfigMessages(client: any) {
    const containers = await DockerService.listContainers();

    for (const container of containers) {
      const identity = this.getContainerIdentity(container);
      const {image, tag, imageReference, containerName, topicName} = identity;
      const deviceName = topicName;
      const currentTopics: string[] = [];
      let containerIsInDb = false;

      await DatabaseService.containerExists(container.Id).then((exists) => {
        containerIsInDb = exists;
      })

      if (!containerIsInDb) {
        // Save container info to database
        logger.info(`Adding container ${containerName} to database`);
        await DatabaseService.addContainer(container.Id, containerName, image, tag);
      }

      let topic, payload;

      const discoveryPrefix = config?.mqtt?.discoveryPrefix

      // Container Id
      topic = `${discoveryPrefix}/sensor/${topicName}/docker_id/config`;
      payload = this.createPayload("Container ID", imageReference, "dockerId", deviceName, null, "mdi:key-variant");
      this.publishMessage(client, topic, payload, {retain: true});
      await this.recordDiscoveryTopic(topic, container.Id, currentTopics);

      // Container Name
      topic = `${discoveryPrefix}/sensor/${topicName}/docker_name/config`;
      payload = this.createPayload("Container Name", imageReference, "dockerName", deviceName, null, "mdi:label");
      this.publishMessage(client, topic, payload, {retain: true});
      await this.recordDiscoveryTopic(topic, container.Id, currentTopics);

      // Container Status
      topic = `${discoveryPrefix}/sensor/${topicName}/docker_status/config`;
      payload = this.createPayload("Container Status", imageReference, "dockerStatus", deviceName, null, "mdi:checkbox-marked-circle");
      this.publishMessage(client, topic, payload, {retain: true});
      await this.recordDiscoveryTopic(topic, container.Id, currentTopics);

      // Container Uptime
      topic = `${discoveryPrefix}/sensor/${topicName}/docker_uptime/config`;
      payload = this.createPayload("Container Uptime", imageReference, "dockerUptime", deviceName, "timestamp", "mdi:timer-sand");
      this.publishMessage(client, topic, payload, {retain: true});
      await this.recordDiscoveryTopic(topic, container.Id, currentTopics);

      // Container Created
      topic = `${discoveryPrefix}/sensor/${topicName}/docker_created/config`;
      payload = this.createPayload("Container Created", imageReference, "dockerCreated", deviceName, "timestamp", "mdi:calendar-clock");
      this.publishMessage(client, topic, payload, {retain: true});
      await this.recordDiscoveryTopic(topic, container.Id, currentTopics);

      // Container Restart Count
      topic = `${discoveryPrefix}/sensor/${topicName}/docker_restart_count/config`;
      payload = this.createPayload("Container Restart Count", imageReference, "dockerRestartCount", deviceName, null, "mdi:restart");
      this.publishMessage(client, topic, payload, {retain: true});
      await this.recordDiscoveryTopic(topic, container.Id, currentTopics);

      // Container Restart Policy
      topic = `${discoveryPrefix}/sensor/${topicName}/docker_restart_policy/config`;
      payload = this.createPayload("Container Restart Policy", imageReference, "dockerRestartPolicy", deviceName, null, "mdi:restart");
      this.publishMessage(client, topic, payload, {retain: true});
      await this.recordDiscoveryTopic(topic, container.Id, currentTopics);

      // Container Health
      topic = `${discoveryPrefix}/sensor/${topicName}/docker_health/config`;
      payload = this.createPayload("Container Health", imageReference, "dockerHealth", deviceName, null, "mdi:heart-pulse");
      this.publishMessage(client, topic, payload, {retain: true});
      await this.recordDiscoveryTopic(topic, container.Id, currentTopics);

      // Container Ports
      topic = `${discoveryPrefix}/sensor/${topicName}/docker_ports/config`;
      payload = this.createPayload("Exposed Ports", imageReference, "dockerPorts", deviceName, null, "mdi:lan-connect");
      this.publishMessage(client, topic, payload, {retain: true});
      await this.recordDiscoveryTopic(topic, container.Id, currentTopics);

      const buttons = [
        {key: "manual_restart", name: "Manual Restart", command: "restart", icon: "mdi:restart"},
        {key: "manual_start", name: "Start", command: "start", icon: "mdi:play"},
        {key: "manual_stop", name: "Stop", command: "stop", icon: "mdi:stop"},
        {key: "manual_pause", name: "Pause", command: "pause", icon: "mdi:pause"},
        {key: "manual_unpause", name: "Unpause", command: "unpause", icon: "mdi:play-pause"},
      ];

      for (const button of buttons) {
        topic = `${discoveryPrefix}/button/${topicName}/docker_${button.key}/config`;
        payload = this.createButtonPayload(button.name, imageReference, topicName, button.command as ContainerCommand, container.Id, button.icon, button.command, button.key);
        this.publishMessage(client, topic, payload, {retain: true});
        await this.recordDiscoveryTopic(topic, container.Id, currentTopics);
      }

      // Docker Image
      topic = `${discoveryPrefix}/sensor/${topicName}/docker_image/config`;
      payload = this.createPayload("Docker Image", imageReference, "dockerImage", deviceName, null, "mdi:image");
      this.publishMessage(client, topic, payload, {retain: true});
      await this.recordDiscoveryTopic(topic, container.Id, currentTopics);

      // Docker Tag
      topic = `${discoveryPrefix}/sensor/${topicName}/docker_tag/config`;
      payload = this.createPayload("Docker Tag", imageReference, "dockerTag", deviceName, null, "mdi:tag");
      this.publishMessage(client, topic, payload, {retain: true});
      await this.recordDiscoveryTopic(topic, container.Id, currentTopics);

      // Docker Registry
      topic = `${discoveryPrefix}/sensor/${topicName}/docker_registry/config`;
      payload = this.createPayload("Docker Registry", imageReference, "dockerRegistry", deviceName, null, "mdi:database");
      this.publishMessage(client, topic, payload, {retain: true});
      await this.recordDiscoveryTopic(topic, container.Id, currentTopics);

      // Container Created By
      topic = `${discoveryPrefix}/sensor/${topicName}/docker_created_by/config`;
      payload = this.createPayload("Created By", imageReference, "dockerCreatedBy", deviceName, null, "mdi:information");
      this.publishMessage(client, topic, payload, {retain: true});
      await this.recordDiscoveryTopic(topic, container.Id, currentTopics);


      if (!IgnoreService.ignoreUpdates(container)) {
        topic = `${discoveryPrefix}/button/${topicName}/docker_manual_update/config`;
        payload = this.createButtonPayload("Manual Update", imageReference, topicName, "manualUpdate", container.Id, "mdi:arrow-up-bold-circle", "update", "manual_update");
        this.publishMessage(client, topic, payload, {retain: true});
        await this.recordDiscoveryTopic(topic, container.Id, currentTopics);

        // Docker Update
        topic = `${discoveryPrefix}/update/${topicName}/docker_update/config`;
        payload = this.createUpdatePayload("Update", image, imageReference, "dockerUpdate", deviceName, container.Id);
        this.publishMessage(client, topic, payload, {retain: true});
        await this.recordDiscoveryTopic(topic, container.Id, currentTopics);
      }

      await this.removeStaleDiscoveryTopics(client, container.Id, currentTopics);
    }
  }


  /**
   * Publishes the device message to the MQTT broker
   * @param client The MQTT client
   */
  public static async publishContainerMessages(client: any) {
    const containers: ContainerInspectInfo[] = await DockerService.listContainers();

    for (const container of containers) {
      // Publish Device message (for HA)
      await this.publishContainerMessage(container, client);
    }
  }

  /**
   * Publishes update messages to the MQTT broker
   * @param client The MQTT client
   */
  public static async publishImageUpdateMessages(client: any) {
    const containers: ContainerInspectInfo[] = await DockerService.listContainers();

    for (const container of containers) {
      // Publish update message (for HA)
      // await this.publishImageUpdateMessage(container, client);

      if (!IgnoreService.ignoreUpdates(container)) {
        await this.publishImageUpdateMessage(container, client);
      }
    }
  }

  /**
   * Publishes the device message to the MQTT broker
   * @param client The MQTT client
   * @param topic The topic to publish the message to
   * @param payload The payload to publish
   * @param configObject The config object
   */
  public static async publishMessage(client: any, topic: string, payload: object | string, configObject: object) {
    if (typeof payload != "string") {
      payload = JSON.stringify(payload);
    }

    if (payload == "") {
      payload = JSON.stringify({})
    }

    client.publish(topic, payload, configObject);
  }

  public static createPayload(
    name: string,
    imageReference: string,
    valueName: string,
    deviceName: string,
    deviceClass?: string | null,
    icon: string = "mdi:docker"
  ): object {
    const formatedDeviceName = this.formatSafeName(deviceName);
    const formatedName = name.toLowerCase().replace(/[^a-z0-9_]/g, "_");
    const defaultEntityId = `sensor.${formatedDeviceName}_${formatedName}`;

    return {
      default_entity_id: defaultEntityId,
      name: `${name}`,
      unique_id: `${formatedDeviceName} ${name}`,
      state_topic: `${config.mqtt.topic}/${formatedDeviceName}`,
      device_class: deviceClass,
      value_template: `{{ value_json.${valueName} }}`,
      availability:
        {
          topic: `${config.mqtt.topic}/availability`,
        },

      payload_available: "Online",
      payload_not_available: "Offline",
      device: {
        ...this.createDevice(imageReference, formatedDeviceName),
      },
      icon: icon,
    };
  }

  public static createUpdatePayload(
    name: string,
    image: string,
    imageReference: string,
    valueName: string,
    deviceName: string,
    containerId: any
  ): object {
    const formatedDeviceName = this.formatSafeName(deviceName);
    const formatedName = name.toLowerCase().replace(/[^a-z0-9_]/g, "_");
    const defaultEntityId = `update.${formatedDeviceName}_${formatedName}`;

    return {
      default_entity_id: defaultEntityId,
      name: `${name}`,
      unique_id: `${formatedDeviceName} ${name}`,
      state_topic: `${config.mqtt.topic}/${formatedDeviceName}/update`,
      device_class: "firmware",
      availability: [
        {
          topic: `${config.mqtt.topic}/availability`,
        },
      ],
      payload_available: "Online",
      payload_not_available: "Offline",
      device: {
        ...this.createDevice(imageReference, formatedDeviceName),
      },
      icon: "mdi:arrow-up-bold-circle",
      entity_picture: "https://github.com/MichelFR/MqDockerUp/raw/main/assets/logo_200x200.png",
      payload_install: JSON.stringify({containerId: containerId, image: image, topicName: formatedDeviceName}),
      command_topic: this.getContainerCommandTopic(formatedDeviceName, "update"),
    };
  }

  /**
   * Publish update messages to MQTT
   * @param container
   * @param client
   * @param update_percentage
   * @param in_progress
   */
  public static async publishUpdateProgressMessage(container: any, client: any, update_percentage: number | null = null, in_progress: boolean = false) {
    if (typeof container === "string") {
      try {
        container = await DockerService.docker
          .getContainer(container)
          .inspect();
      } catch (error: any) {
        logger.warn(
          `Could not inspect container ${container}: ${error.message || error}`
        );
        return;
      }
    }

    const topicName = this.getContainerTopicName(container);

    // Update entity payload
    const updateTopic = `${config.mqtt.topic}/${topicName}/update`;
    let updatePayload: any;

    updatePayload = {
      update_percentage: null,
      in_progress: false,
    }

    if (update_percentage && in_progress) {
      updatePayload.update_percentage = update_percentage;
      updatePayload.in_progress = in_progress;
    }

    this.publishMessage(client, updateTopic, updatePayload, {retain: false});
  }

  public static async publishAbortUpdateMessage(container: any, client: any) {
    try {
      if (typeof container === "string") {
        container = await DockerService.docker
          .getContainer(container)
          .inspect();
      }
    } catch (error: any) {
      logger.warn(
        `Could not inspect container ${container}: ${error.message || error}`
      );
      return;
    }

    if (!container) {
      logger.error(`ABORT: Failed to find container ${container}`);
      return;
    }

    const topicName = this.getContainerTopicName(container);

    // Update entity payload
    const updateTopic = `${config.mqtt.topic}/${topicName}/update`;
    let updatePayload: any;

    updatePayload = {
      update_percentage: null,
      in_progress: false,
    }

    await this.publishMessage(client, updateTopic, updatePayload, {retain: false});
  }

  /**
   * Publish update messages to MQTT
   * @param container
   * @param client
   */
  public static async publishImageUpdateMessage(container: any, client: any, update_percentage: number | null = null, remaining: number | null = null, state: string | null = null, log: boolean = true) {
    if (typeof container === "string") {
      try {
        container = await DockerService.docker
          .getContainer(container)
          .inspect();
      } catch (error: any) {
        logger.warn(
          `Could not inspect container ${container}: ${error.message || error}`
        );
        return;
      }
    }

    const identity = this.getContainerIdentity(container);
    const {image, tag, imageReference, digest, topicName} = identity;
    const imageInfo = await DockerService.getImageInfo(imageReference);
    const repoDigests = imageInfo?.RepoDigests || [];
    let currentDigest: string | null = null, newDigest: string | null = null;

    if (digest) {
      currentDigest = digest.includes(":") ? digest.split(":").pop() || digest : digest;
      newDigest = currentDigest;
      logger.info(`Using pinned digest for image ${image}:${tag}`);
    } else {
      newDigest = await DockerService.getImageNewDigest(image, tag);
    }

    if (!newDigest) {
      logger.warn(`Failed to find new digest for image ${image}:${tag}`);
    } else if (!digest) {
      if (repoDigests.length > 0) {
        if (repoDigests.some(d => d.endsWith(newDigest))) {
          currentDigest = newDigest;
          logger.info(`Image ${image}:${tag} is up-to-date`);
        } else {
          currentDigest = repoDigests[0].split(":")[1];
          logger.info(`New version available for image ${image}:${tag}`);
        }
      } else {
        currentDigest = "";
        logger.info(`No existing digests found for image ${image}:${tag}`);
      }
    }

      // Update entity payload
      const updateTopic = `${config.mqtt.topic}/${topicName}/update`;
      const sourceRepo = await DockerService.getSourceRepo(image, tag);

      if (sourceRepo) {
        logger.info(`Found source repository: ${sourceRepo}`);
      } else {
        logger.warn(`Could not find source repository for ${image}`);
      }

      let updatePayload: any;
      if (haLegacy) {
        updatePayload = {
          installed_version: `${tag}: ${currentDigest?.substring(0, 12)}`,
          latest_version: newDigest ? `${tag}: ${newDigest?.substring(0, 12)}` : null,
          release_notes: null,
          release_url: null,
          entity_picture: null,
          title: `${image}:${tag}`,
          progress: 0,
          update: {
            state: currentDigest && newDigest && currentDigest !== newDigest ? "available" : "idle",
            installed_version: `${tag}: ${currentDigest?.substring(0, 12)}`,
            latest_version: newDigest ? `${tag}: ${newDigest?.substring(0, 12)}` : null,
            last_check: new Date().toISOString(),
            progress: 0,
            remaining: 0,
          }
        };

        if (update_percentage !== null && remaining !== null) {
          updatePayload.update.progress = update_percentage;
          updatePayload.progress = update_percentage;
          updatePayload.update.remaining = remaining;

          if (state) {
            updatePayload.update.state = state;
          }
        }
      } else {
        updatePayload = {
          installed_version: `${tag}: ${currentDigest?.substring(0, 12)}`,
          latest_version: newDigest ? `${tag}: ${newDigest?.substring(0, 12)}` : null,
          release_summary: "",
          release_url: `${sourceRepo ? sourceRepo : "https://github.com/MichelFR/MqDockerUp"}/releases`,
          entity_picture: "https://raw.githubusercontent.com/MichelFR/MqDockerUp/refs/heads/main/assets/logo_200x200.png",
          title: `${image}:${tag}`,
          in_progress: false,
          update_percentage: null,
        };

        if (update_percentage !== null && remaining !== null) {
          updatePayload.update.update_percentage = update_percentage;
          updatePayload.update_percentage = update_percentage;
          updatePayload.update.remaining = remaining;
        }

      }

      this.publishMessage(client, updateTopic, updatePayload, {retain: true});
  }

  /**
   * Publish device messages to MQTT
   * @param container
   * @param client
   */
  public static async publishContainerMessage(container: ContainerInspectInfo, client: any) {
    const identity = this.getContainerIdentity(container);
    const {image, tag, topicName, containerName} = identity;

    let dockerPorts = "";
    if (container.HostConfig.PortBindings) {
      for (const [key, value] of Object.entries(container.HostConfig.PortBindings)) {
        if (value && Array.isArray(value) && value.length > 0) {
          const hostPort = (value[0] as { HostPort: string }).HostPort;
          dockerPorts += `${key} : ${hostPort}, `;
        }
      }
      // Remove the last comma and space if dockerPorts is not empty
      if (dockerPorts.endsWith(", ")) {
        dockerPorts = dockerPorts.slice(0, -2);
      }
    }

    let registry = await DockerService.getImageRegistryName(image);

    const createdBy = DockerService.getCreatedBy(container);

    const topic = `${config.mqtt.topic}/${topicName}`;
    const payload = {
      dockerImage: image,
      dockerTag: tag,
      dockerName: containerName,
      dockerId: container.Id.substring(0, 12),
      dockerStatus: container.State.Status,
      dockerUptime: container.State.StartedAt,
      dockerCreated: container.Created,
      dockerRestartCount: container.RestartCount,
      dockerRestartPolicy: container?.HostConfig?.RestartPolicy?.Name || "unknown",
      dockerHealth: container.State.Health?.Status || "unknown",
      dockerPorts: dockerPorts,
      dockerRegistry: registry,
      dockerCreatedBy: createdBy,
    };
    this.publishMessage(client, topic, payload, {retain: true});
  }
}

