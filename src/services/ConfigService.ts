import yaml from "yaml";
import fs from "fs";
import logger from "./LoggerService";

type ConfigSection = Record<string, unknown>;

export type AppConfig = {
  main: {
    interval: string;
    imageUpdateInterval: string;
    containerCheckInterval: string;
    containerCheckOnChanges: boolean | string;
    updateCheckInterval: string;
    prefix: string;
  };
  mqtt: {
    connectionUri: string;
    topic: string;
    discoveryPrefix: string;
    suggestedArea: string;
    clientId: string;
    username: string;
    password: string;
    haLegacy: boolean | string;
    connectTimeout: number | string;
    protocolVersion: number | string;
    maxReconnectDelay: number | string;
  };
  accessTokens: {
    dockerhub: string;
    github: string;
  };
  ignore: {
    containers: string;
    updates: string;
  };
  logs: {
    level: string;
  };
};

const defaultConfig: AppConfig = {
  main: {
    interval: "",
    imageUpdateInterval: "",
    containerCheckInterval: "5m",
    containerCheckOnChanges: true,
    updateCheckInterval: "",
    prefix: "",
  },
  mqtt: {
    connectionUri: "mqtt://localhost:1883",
    topic: "mqdockerup",
    discoveryPrefix: "homeassistant",
    suggestedArea: "Docker",
    clientId: "mqdockerup",
    username: "ha",
    password: "",
    haLegacy: false,
    connectTimeout: 60,
    protocolVersion: 5,
    maxReconnectDelay: 300,
  },
  accessTokens: {
    dockerhub: "",
    github: "",
  },
  ignore: {
    containers: "",
    updates: "",
  },
  logs: {
    level: "info",
  },
};

/**
 * ConfigService class that provides access to the application configuration settings.
 */
export default class ConfigService {
  private static cachedConfig: AppConfig | null = null;

  private static cloneDefaults(): AppConfig {
    return JSON.parse(JSON.stringify(defaultConfig));
  }

  private static mergeConfig(base: AppConfig, override: Partial<Record<keyof AppConfig, ConfigSection>>): AppConfig {
    for (const sectionName of Object.keys(base) as (keyof AppConfig)[]) {
      const sectionOverride = override?.[sectionName];
      if (!sectionOverride || typeof sectionOverride !== "object") {
        continue;
      }

      base[sectionName] = {
        ...(base[sectionName] as ConfigSection),
        ...sectionOverride,
      } as never;
    }

    return base;
  }

  private static readConfigFile(): Partial<Record<keyof AppConfig, ConfigSection>> {
    if (!fs.existsSync("config.yaml")) {
      logger.warn("config.yaml not found, using defaults and environment variables.");
      return {};
    }

    const parsed = yaml.parse(fs.readFileSync("config.yaml", "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  }

  private static applyEnvironmentOverrides(config: AppConfig) {
    for (const sectionName of Object.keys(defaultConfig) as (keyof AppConfig)[]) {
      const section = config[sectionName] as ConfigSection;

      for (const key of Object.keys(defaultConfig[sectionName])) {
        const envKey = process.env[`${sectionName.toUpperCase()}_${key.toUpperCase()}`];
        if (envKey !== undefined) {
          section[key] = this.autoParseEnvVariable(envKey);
        }
      }
    }
  }

  /**
   * Attempts to automatically parse the given value as a boolean or number.
   * If the value cannot be parsed as either, the original value is returned.
   * @param value The value to parse.
   * @returns The parsed value, or the original value if parsing failed.
   */
  public static autoParseEnvVariable(value: unknown): boolean | number | string | undefined | unknown {
    if (value === undefined) return undefined;

    if (typeof value === "string") {
      // Attempt to convert to boolean
      if (value.toLowerCase() === 'true') return true;
      if (value.toLowerCase() === 'false') return false;
  
      // Attempt to convert to number
      const numberValue = Number(value);
      if (!isNaN(numberValue)) return numberValue;
    }

    // If none of the above work, return the original string
    return value;
  }


  /**
   * Gets the configuration settings.
   * @returns {any} The merged configuration settings.
   */
  public static getConfig(): AppConfig {
    if (this.cachedConfig) {
      return this.cachedConfig;
    }

    try {
      const config = this.mergeConfig(this.cloneDefaults(), this.readConfigFile());
      this.applyEnvironmentOverrides(config);

      // #region "Deprecation Messages"

      if (config.main["interval"] !== undefined) {
        logger.warn("The property `main.interval` is deprecated, please use `main.containerCheckInterval` instead.");
        if (config.main["containerCheckInterval"] === undefined) {
          config.main["containerCheckInterval"] = config.main["interval"];
        }

      }

      if (config.main["imageUpdateInterval"] !== undefined) {
        logger.warn("The property `main.imageUpdateInterval` is deprecated, please use `main.updateCheckInterval` instead.");
        if (config.main["updateCheckInterval"] === undefined) {
          config.main["updateCheckInterval"] = config.main["imageUpdateInterval"];
        }

      }

      // #endregion "Deprecation"

      // Sync intervals if updateCheckInterval is empty
      if (config.main["updateCheckInterval"] === undefined || config.main["updateCheckInterval"] == "") {
        config.main["updateCheckInterval"] = config.main["containerCheckInterval"];
      }

      this.cachedConfig = config;
      return config;
    } catch (e) {
      logger.error(e);
      this.cachedConfig = this.cloneDefaults();
      return this.cachedConfig;
    }
  }
}
