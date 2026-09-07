import Docker from "dockerode";
import {ContainerInspectInfo} from "dockerode";
import {EventEmitter} from 'events';
import {ImageRegistryAdapterFactory} from "../registry-factory/ImageRegistryAdapterFactory";
import logger from "./LoggerService";
import IgnoreService from "./IgnoreService";
import HomeassistantService from "./HomeassistantService";
import DatabaseService from "./DatabaseService";
import axios, { AxiosInstance } from 'axios';
import {mqttClient} from "../index";

/**
 * Represents a Docker service for managing Docker containers and images.
 */
export default class DockerService {
  public static docker = new Docker();
  public static events = new EventEmitter();
  public static updatingContainers: string[] = [];
  /** Source repository URL per image reference; null marks a lookup that found nothing. */
  public static SourceUrlCache = new Map<string, string | null>();
  public static VersionLabelCache = new Map<string, string | null>();

  private static markContainerUpdating(containerId: string): void {
    if (!this.updatingContainers.includes(containerId)) {
      this.updatingContainers.push(containerId);
    }
  }

  private static unmarkContainerUpdating(containerId: string): void {
    this.updatingContainers = this.updatingContainers.filter((id) => id !== containerId);
  }

  public static splitImageReference(reference: string | null | undefined): { image: string; tag: string; digest?: string } {
    if (!reference) {
      return { image: "unknown", tag: "latest" };
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
        ...(digest ? { digest } : {}),
      };
    }

    return {
      image: imageReference,
      tag: "latest",
      ...(digest ? { digest } : {}),
    };
  }

  // Start listening to Docker events
  public static listenToDockerEvents() {
    const handledActions = new Set([
      'create',
      'start',
      'die',
      'health_status',
      'stop',
      'destroy',
      'rename',
      'update',
      'pause',
      'unpause',
      'restart',
    ]);

    DockerService.docker.getEvents({}, (err: any, data: any) => {
      if (err) {
        logger.error('Error while listening to docker events:', err);
        return;
      }

      data.on('data', (chunk: any) => {
        try {
          const event = JSON.parse(chunk.toString());

          if (event.Type === 'container') {
            const containerName = event.Actor.Attributes.name;
            const containerId = event.Actor.ID;

            if (handledActions.has(event.Action)) {
              logger.debug(`${event.Action}: ${containerName}`);
              DockerService.events.emit(event.Action, { containerName, containerId });
            } else {
              logger.debug(`${event.Action}: ${containerName}`);
            }
          }
        } catch (error) {
          logger.error('Error parsing Docker event JSON:', error, 'Chunk:', chunk.toString());
        }
      });

      data.on('error', (error: any) => {
        logger.error('Error while listening to docker events:', error);
      });
    });
  }


  /**
   * Returns a list of inspect information for all containers.
   *
   * @returns A promise that resolves to an array of `ContainerInspectInfo`.
   */
  public static async listContainers(): Promise<ContainerInspectInfo[]> {
    const containers = await DockerService.docker.listContainers({all: true});

    return Promise.all(
      containers.filter((container) => {
        return !(IgnoreService.ignoreContainer(container))
      }).map(async (container) => {
        const containerInfo = await DockerService.docker.getContainer(container.Id).inspect();
        return containerInfo;
      })
    );
  }


  /**
   * Returns the inspect information for a single container, or null if it no
   * longer exists or is excluded by the ignore rules.
   *
   * @param containerId - The ID of the container.
   */
  public static async getMonitoredContainer(containerId: string): Promise<ContainerInspectInfo | null> {
    const [container] = await DockerService.docker.listContainers({all: true, filters: {id: [containerId]}});
    if (!container || IgnoreService.ignoreContainer(container)) {
      return null;
    }

    try {
      return await DockerService.docker.getContainer(container.Id).inspect();
    } catch (err: any) {
      if (err.statusCode === 404) {
        return null;
      }
      throw err;
    }
  }

  /**
   * Gets the Docker image registry for the specified image name.
   *
   * @param imageName - The name of the Docker image.
   * @param tag - The tag of the Docker image.
   * @returns A promise that resolves to an object with the registry name
   */
  public static async getImageRegistryName(imageName: string): Promise<string> {
    return ImageRegistryAdapterFactory.getRegistryName(imageName);
  }

  /**
   * Gets the new docker image digest for the specified image name.
   * @param imageName - The name of the Docker image.
   * @param tag - The tag of the Docker image.
   * @returns A promise that resolves to a string containing the new digest.
   */
  public static async getImageNewDigest(imageName: string, tag: string): Promise<string | null> {
    const updateInfo = await this.getImageUpdateInfo(imageName, tag);
    return updateInfo.newDigest;
  }

  public static async getImageUpdateInfo(imageName: string, tag: string): Promise<{ newDigest: string | null; tag: string }> {
    try {
      let adapter = ImageRegistryAdapterFactory.getAdapter(imageName, tag);
      let response = await adapter.checkForNewDigest();

      return {
        newDigest: response.newDigest,
        tag: response.tag || tag,
      };
      
    } catch (error: any) {
      logger.error(imageName, tag);
      logger.error(error);
      return { newDigest: null, tag };
    }
  }

  /**
   * Gets the version label of the latest available image for the specified image name.
   * @param imageName - The name of the Docker image.
   * @param tag - The tag of the Docker image.
   */
  public static async getImageVersionLabel(imageName: string, tag: string, digest?: string): Promise<string | null> {
    const cacheKey = digest ? `${imageName}@${digest}` : `${imageName}:${tag}`;
    if (DockerService.VersionLabelCache.has(cacheKey)) {
      return DockerService.VersionLabelCache.get(cacheKey) ?? null;
    }

    try {
      let adapter = ImageRegistryAdapterFactory.getAdapter(imageName, tag);
      const versionLabel = await adapter.getVersionLabel();
      DockerService.VersionLabelCache.set(cacheKey, versionLabel);
      return versionLabel;
    } catch (error: any) {
      logger.error(imageName, tag);
      logger.error(error);
      DockerService.VersionLabelCache.set(cacheKey, null);
      return null;
    }
  }


  /**
   * Gets the private registry for the specified image name.
   *
   * @param imageName - The name of the Docker image.
   * @returns The private registry or `null` if it is not found.
   */
  public static getPrivateRegistry(imageName: string): string | null {
    const parts = imageName.split("/");
    if (parts.length >= 2) {
      return parts[0];
    }
    return null;
  }

  /**
   * Determines how the container was created.
   * Returns "Composer" when compose labels are present otherwise "Docker".
   *
   * @param container - Container inspect info
   */
  public static getCreatedBy(container: ContainerInspectInfo): string {
    const labels = container?.Config?.Labels || {};
    return Object.keys(labels).some((label) => label.startsWith("com.docker.compose"))
      ? "Composer"
      : "Docker";
  }

  /**
   * Gets the source repository for the specified Docker image.
   * @param imageName - The name of the Docker image.
   * @param imageTag - The tag of the Docker image.
   * @returns A promise that resolves to the source repository URL.
   * @throws An error if the source repository could not be found.
   */
  public static async getSourceRepo(imageName: string, imageTag: string): Promise<string | null> {
    const imageTagCacheKey = imageName + ":" + imageTag;
    if (DockerService.SourceUrlCache.has(imageTagCacheKey)) {
      return DockerService.SourceUrlCache.get(imageTagCacheKey) ?? null;
    }

    if (DockerService.SourceUrlCache.has(imageName)) {
      return DockerService.SourceUrlCache.get(imageName) ?? null;
    }

    const labels = await DockerService.getImageInfo(imageName + ":" + imageTag).then(
      (info) => info.Config.Labels
    ).catch((error) => {
      logger.error("Error getting image info:", error);
    });

    if (labels && labels["org.opencontainers.image.source"]) {
      const url = this.normalizeGithubUrl(labels["org.opencontainers.image.source"]);
      DockerService.SourceUrlCache.set(imageTagCacheKey, url);
      return url;
    }

    if (!this.isDockerHubImage(imageName)) {
      DockerService.SourceUrlCache.set(imageTagCacheKey, null);
      return null;
    }

    const dockerHubRepo = this.getDockerHubRepositoryPath(imageName);
    const dockerHubUrl = `https://hub.docker.com/v2/repositories/${dockerHubRepo}`;
    const response = await axios.get(dockerHubUrl).catch((error) => {
      if (error.response?.status === 404) {
        logger.debug(`Docker Hub repository not found: ${dockerHubRepo}`);
      } else {
        logger.error("Error accessing Docker Hub API:", error);
      }
    });

    if (response && response.status === 200) {
      const data = response.data;
      const fullDescription = data.full_description || "";

      const metadataUrl = this.normalizeGithubUrl(data.source_url || data.repository_url || "");
      if (metadataUrl) {
        DockerService.SourceUrlCache.set(imageName, metadataUrl);
        return metadataUrl;
      }

      if (!fullDescription.toLowerCase().includes("github")) {
        DockerService.SourceUrlCache.set(imageName, null);
        return null;
      }

      const url = this.parseGithubUrl(fullDescription);
      if (url !== null) {
        DockerService.SourceUrlCache.set(imageName, url);
        return url;
      }
    }

    DockerService.SourceUrlCache.set(imageName, null);
    return null;
  }

  /**
   * Gets the inspect information for the specified Docker image.
   *
   * @param imageId - The ID of the Docker image.
   * @returns A promise that resolves to an `ImageInspectInfo` object.
   */
  public static async getImageInfo(imageId: string): Promise<Docker.ImageInspectInfo> {
    return await DockerService.docker.getImage(imageId).inspect();
  }

  /**
   * Builds the per-network endpoint configuration needed to recreate a
   * container with all of its network attachments (static IPs, aliases,
   * links) intact. Docker's create API only honors a single endpoint in
   * NetworkingConfig, so the primary network (the one matching
   * HostConfig.NetworkMode, or the first attached network) is returned
   * separately; the rest must be reconnected after creation.
   *
   * @param info - The inspect data of the container being recreated.
   * @param containerId - The ID of the old container.
   */
  public static buildNetworkEndpointsConfig(
    info: { NetworkSettings?: any; HostConfig?: any },
    containerId: string
  ): { endpointsConfig: Record<string, any>; primaryNetwork?: string } {
    const oldShortId = containerId.substring(0, 12);
    const endpointsConfig: Record<string, any> = {};
    for (const [networkName, endpoint] of Object.entries<any>(info.NetworkSettings?.Networks ?? {})) {
      endpointsConfig[networkName] = {
        IPAMConfig: endpoint.IPAMConfig ?? undefined,
        Links: endpoint.Links ?? undefined,
        // Docker adds the container's short ID as an implicit alias;
        // drop it so the new container gets its own.
        Aliases: (endpoint.Aliases ?? []).filter((alias: string) => alias !== oldShortId),
      };
    }

    const networkMode = info.HostConfig?.NetworkMode;
    const primaryNetwork = networkMode && endpointsConfig[networkMode]
      ? networkMode
      : Object.keys(endpointsConfig)[0];

    return { endpointsConfig, primaryNetwork };
  }

  /**
   * Connects a recreated container to every network in endpointsConfig
   * except the primary one (already attached at creation). A failed
   * reconnect is logged but does not abort the update.
   */
  public static async reconnectSecondaryNetworks(
    endpointsConfig: Record<string, any>,
    primaryNetwork: string | undefined,
    newContainerId: string,
    containerName: string
  ): Promise<void> {
    for (const networkName of Object.keys(endpointsConfig)) {
      if (networkName === primaryNetwork) continue;
      try {
        await DockerService.docker.getNetwork(networkName).connect({
          Container: newContainerId,
          EndpointConfig: endpointsConfig[networkName],
        });
      } catch (e) {
        logger.error(`Failed to reconnect network ${networkName} to container ${containerName}: ${e}`);
      }
    }
  }

  public static async updateContainer(containerId: string) {
    if (this.updatingContainers.includes(containerId)) {
      logger.warn(`Container ${containerId} is already updating; ignoring duplicate update request`);
      return;
    }

    this.markContainerUpdating(containerId);

    try {
      logger.info(`Updating individual container: ${containerId}`);

      const container = DockerService.docker.getContainer(containerId);
      
      let info = null
      try {
        info = await container.inspect();
      } catch (err: any) {
        if (err.statusCode === 404) {
          logger.warn(`Container ${containerId} no longer exists`);
        } else {
          logger.error(`Failed to inspect container ${containerId}:`, err);
          throw err;
        }
      }

      if (info) {
        const oldImageId = info.Image;
        const image = info.Config.Image;
        let targetImage = image;
        const identity = DockerService.splitImageReference(image);

        if (!identity.digest && identity.image !== "unknown") {
          const updateInfo = await DockerService.getImageUpdateInfo(identity.image, identity.tag);

          if (updateInfo.newDigest && updateInfo.tag !== identity.tag) {
            targetImage = `${identity.image}:${updateInfo.tag}`;
            logger.info(`Resolved update target image: ${targetImage}`);
          }
        }

        // Store layer progress here
        const layerProgress: Record<string, { current: number; total: number }> = {};
        let lastPublishTime = 0;

        await new Promise<void>((resolve, reject) => {
        DockerService.docker.pull(targetImage, async (err: any, stream: any) => {
          logger.info("Pulling image: " + targetImage);
          if (err) {
            logger.error("Pulling Error: " + err);
            reject(err);
            return;
          }

          DockerService.docker.modem.followProgress(
            stream,
            async (err: any) => {
              if (err) {
                logger.error("Stream Error: " + err);
                reject(err);
                return;
              }

              logger.info("Image pulled successfully");

              const { endpointsConfig, primaryNetwork } = DockerService.buildNetworkEndpointsConfig(info, containerId);

              const containerConfig: any = {
                ...info,
                ...info.Config,
                ...info.HostConfig,
                // info.Name includes a leading slash, which causes the name
                // to be dropped when recreating the container. Strip it so the
                // container keeps its original name after an update.
                name: info.Name.startsWith("/") ? info.Name.substring(1) : info.Name,
                Image: targetImage,
              };

              if (primaryNetwork) {
                containerConfig.NetworkingConfig = {
                  EndpointsConfig: { [primaryNetwork]: endpointsConfig[primaryNetwork] },
                };
              }

              // The container will start with a new ID
              containerConfig.Id = "";

              // Mounts need no special handling: info.HostConfig.Binds and
              // info.HostConfig.Mounts are passed through verbatim, which
              // preserves bind mounts, named volumes, tmpfs, and all their
              // flags exactly as the container was created with.

              logger.debug(`Container config prepared for update: ${JSON.stringify(containerConfig, null, 2)}`);


              const wasRunning = info.State?.Running === true;
              let newContainer: Docker.Container | undefined;
              try {
                // Stop the old container, tolerating one that is already
                // stopped (Docker answers 304 in that case).
                try {
                  await container.stop();
                } catch (err: any) {
                  if (err.statusCode !== 304) {
                    throw err;
                  }
                }

                // Rename the old container out of the way instead of removing
                // it, so a failed creation can be rolled back without losing
                // the container.
                const backupName = `${containerConfig.name}_mqdockerup_old`;
                await container.rename({ name: backupName });

                try {
                  newContainer = await DockerService.docker.createContainer(containerConfig);

                  // Reattach the remaining networks before starting so DNS
                  // and service discovery work from the first moment.
                  await DockerService.reconnectSecondaryNetworks(endpointsConfig, primaryNetwork, newContainer.id, containerConfig.name);

                  await newContainer.start();
                } catch (error) {
                  logger.error(`Failed to recreate container ${containerConfig.name}, rolling back to the old container`);
                  try {
                    if (newContainer) {
                      await newContainer.remove({ force: true });
                    }
                    await container.rename({ name: containerConfig.name });
                    if (wasRunning) {
                      await container.start();
                    }
                  } catch (rollbackError) {
                    logger.error(`Rollback of container ${containerConfig.name} failed: ${rollbackError}`);
                  }
                  throw error;
                }

                // The new container is up — the old one can go now. Forget it
                // in the database first: its discovery topics are keyed by
                // container name and live on for the new container, so they
                // must not be cleared when the destroy event arrives.
                await DatabaseService.deleteContainer(containerId);
                await container.remove();

                // Get the new container info for MQTT updates
                const newContainerInfo = await newContainer.inspect();

                // Remove old image
                try {
                  DockerService.docker
                    .getImage(oldImageId)
                    .remove({ force: true }, (err, data) => {
                      if (err) {
                        // Ignore 409 conflict errors - image is still in use by another container
                        if (err.statusCode === 409) {
                          logger.debug("Old image still in use by other containers, skipping removal");
                        } else {
                          logger.error("Error removing old image: " + err);
                        }
                      } else {
                        logger.info("Old image removed successfully");
                      }
                    });
                } catch (e) {
                  logger.error("Error removing old image: " + e);
                }


                // Publish final 100% progress with the NEW container info
                await HomeassistantService.publishUpdateProgressMessage(newContainerInfo, mqttClient, 100, false);

                // Publish the new container under the (unchanged) device name
                // and report it as up-to-date.
                await HomeassistantService.publishContainer(mqttClient, newContainerInfo);
                await HomeassistantService.publishImageUpdateMessage(newContainerInfo, mqttClient);

                resolve();
              } catch (error) {
                logger.error("Error starting container with new image");
                logger.error(error);
                reject(error);
              }
            },
            (event) => {
              logger.debug(`Status: ${event.status}`);

              if (event.id) {
                const layer = layerProgress[event.id] || { current: 0, total: 0 };

                if (event.progressDetail && (event.progressDetail.current || event.progressDetail.total)) {
                  layer.current = event.progressDetail.current || layer.current;
                  layer.total = event.progressDetail.total || layer.total;
                }

                if (["Pull complete", "Download complete", "Already exists"].includes(event.status)) {
                  layer.current = layer.total || layer.current;
                }

                layerProgress[event.id] = layer;

                const totalCurrent = Object.values(layerProgress).reduce((acc, l) => acc + l.current, 0);
                const totalSize = Object.values(layerProgress).reduce((acc, l) => acc + l.total, 0);

                if (totalSize > 0) {
                  const percentage = Math.min(100, Math.round((totalCurrent / totalSize) * 100));
                  logger.debug(`Total progress: ${totalCurrent}/${totalSize} (${percentage}%)`);

                  const now = Date.now();
                  if (now - lastPublishTime >= 1000) {
                    lastPublishTime = now;
                    HomeassistantService.publishUpdateProgressMessage(info, mqttClient, percentage, true);
                  }
                }
              }
            }
          );
        });
        });
      }
    } catch (error: any) {
      logger.error("Error updating container");
      logger.error(error);
      throw error;
    } finally {
      this.unmarkContainerUpdating(containerId);
    }
  }


  /**
   * Stops a Docker container.
   *
   * @param containerId - The ID of the Docker container to stop.
   */
  public static async stopContainer(containerId: string) {
    const container = DockerService.docker.getContainer(containerId);
    await container.stop();
  }

  /**
   * Starts a Docker container.
   *
   * @param containerId - The ID of the Docker container to start.
   */
  public static async startContainer(containerId: string) {
    const container = DockerService.docker.getContainer(containerId);
    await container.start();
  }

  /**
   * Removes a Docker container.
   * @param containerId - The ID of the Docker container to remove.
   */
  public static async removeContainer(containerId: string) {
    const container = DockerService.docker.getContainer(containerId);
    await container.remove();
  }

  /**
   * Pauses a Docker container.
   * @param containerId - The ID of the Docker container to pause.
   * @returns A promise that resolves when the container is paused.
   */
  public static async pauseContainer(containerId: string) {
    const container = DockerService.docker.getContainer(containerId);
    await container.pause();
  }

  /**
   * Unpauses a Docker container.
   * @param containerId - The ID of the Docker container to unpause.
   * @returns A promise that resolves when the container is unpaused.
   */
  public static async unpauseContainer(containerId: string) {
    const container = DockerService.docker.getContainer(containerId);
    await container.unpause();
  }

  /**
   * Restarts a Docker container.
   * @param containerId - The ID of the Docker container to restart.
   * @returns A promise that resolves when the container is restarted.
   */
  public static async restartContainer(containerId: string) {
    const container = DockerService.docker.getContainer(containerId);
    await container.restart();
    await container.wait();
  }

  /**
   * Creates a Docker container.
   * @param imageName - The name of the Docker image to use.
   * @param containerName - The name of the Docker container to create.
   * @param containerConfig - The configuration for the Docker container.
   * @returns A promise that resolves to the new Docker container.
   * @throws An error if the container could not be created.
   */
  public static async createContainer(containerConfig: any): Promise<Docker.Container> {
    const container = await DockerService.docker.createContainer({
      ...containerConfig,
    });

    return container;
  }

  /**
   * Checks if a container exists.
   * @param containerImage - The name of the Docker image to check.
   * @returns A promise that resolves to true if the container exists.
   * TODO: Change to check if container is running by using the container id instead of the image name
   */
  public static async checkIfContainerExists(containerImage: string): Promise<boolean> {
    return DockerService.docker.listContainers({all: true}).then((containers) => {
      const imageWithoutTag = containerImage.replace(/:.*/, "");
      const imageWithAnyTag = new RegExp(`^${imageWithoutTag}(:.*)?$`);

      return containers.some((container) => container.Image.match(imageWithAnyTag));
    });
  }

  /**
   * Parses a GitHub URL from a full description.
   * @param fullDescription - The full description to parse.
   * @returns The GitHub URL or `null` if it could not be parsed.
   */
  private static parseGithubUrl(fullDescription: string): string | null {
    const startIndex = fullDescription.indexOf("[github");
    const endIndex = fullDescription.indexOf("]", startIndex);
    if (startIndex !== -1 && endIndex !== -1) {
      return this.normalizeGithubUrl(fullDescription.slice(startIndex, endIndex).replace("[github]", ""));
    }

    const githubUrlMatch = fullDescription.match(/https:\/\/github\.com\/[^\s)\]]+/i);
    if (githubUrlMatch) {
      return this.normalizeGithubUrl(githubUrlMatch[0]);
    }

    return null;
  }

  private static isDockerHubImage(imageName: string): boolean {
    const firstSegment = imageName.split("/")[0];
    return !firstSegment.includes(".") && !firstSegment.includes(":") && firstSegment !== "localhost";
  }

  private static getDockerHubRepositoryPath(imageName: string): string {
    return imageName.includes("/") ? imageName : `library/${imageName}`;
  }

  private static normalizeGithubUrl(url: string): string | null {
    const match = url.match(/https:\/\/github\.com\/([^/\s)\]]+)\/([^/\s)\]#?]+)/i);
    if (!match) {
      return null;
    }

    const owner = match[1];
    const repo = match[2].replace(/\.git$/i, "");
    return `https://github.com/${owner}/${repo}`;
  }
}
