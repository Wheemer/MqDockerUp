<center><img alt="image" src="https://github.com/user-attachments/assets/cb264d67-7d72-4527-9a27-4599a6f9d1c2"></center>

<br>

[![Tests](https://github.com/Wheemer/MqDockerUp/actions/workflows/test.yml/badge.svg?branch=main)](https://github.com/Wheemer/MqDockerUp/actions/workflows/test.yml)
[![Release](https://github.com/Wheemer/MqDockerUp/actions/workflows/release.yml/badge.svg)](https://github.com/Wheemer/MqDockerUp/actions/workflows/release.yml)
[![Support](https://img.shields.io/badge/support-PayPal-blue)](https://www.paypal.me/wheemer)

# MqDockerUp Wheemer Edition

MqDockerUp Wheemer Edition is a maintained Home Assistant focused build of MqDockerUp. It monitors Docker containers, publishes container state and update data to MQTT, creates Home Assistant discovery entities, and lets you start, stop, pause, restart, and update containers from MQTT or Home Assistant.

This fork exists because Home Assistant needs stable per-container identity. If several containers use the same image and tag, image-based discovery can collapse them into one device or route commands to the wrong container. This edition scopes discovery, state topics, command topics, and update payloads by container so each container remains distinct and controllable.

## What's awesome here

- Container-scoped Home Assistant discovery for duplicate image/tag deployments.
- Per-container MQTT command topics, with legacy flat command topics kept for compatibility.
- Safer update/install routing so Home Assistant update entities target the intended container.
- Stale discovery cleanup backed by recorded discovery topics.
- Better image reference handling for registry ports and digest-pinned images.
- Home Assistant MQTT discovery payload fixes, including button `payload_press` and matching availability payloads.
- Focused tests for the collision, command-routing, cleanup, legacy payload, and image-reference cases.

## How it works

MqDockerUp uses Docker Registry APIs (DockerHub/GHCR/LSCR) to get information about containers and images. It then checks the latest image metadata and publishes state, discovery, and update changes to the configured MQTT broker.

## How to use

### Standalone application

1. Clone the repository and install dependencies with`npm install`.
2. Change the`config.yaml` file with your desired configuration.
3. Run the project with`npm run start`.

### Docker
 * [`Docker run`](#run)
 * [`Docker Compose/Docker-compose`](#compose)

#### Notable Path/`Binds`/`Volumes`
  * Path required to access the docker API: `/var/run/docker.sock:/var/run/docker.sock` 
  * Path required to store the data (database.db): `your/path/data:/app/data/` 
  * Path required if you want to use yaml config: `your/path/config.yaml:/app/config.yaml`  

## Configuration

The configuration file `config.yaml` (`\app\config.yaml` in docker the container) contains the following sections:

### Main Configuration

The main configuration is specified in the `main` section of `config.yaml`:

|                     Name |     Environmental Variable     | Type     | Default | Description                                                                                                                                                                                                                           |
| -----------------------: | :---------------------------: | :------- | :-----: | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `containerCheckInterval` | `MAIN_CONTAINERCHECKINTERVAL` | `string` | `"5m"`  | The interval at which container are checked and published/republished to the MQTT broker, must be in the format`[number][unit]`, where `[number]` is a positive integer and [`[unit]`](#unit).                                        |
| `containerCheckOnChanges` | `MAIN_CONTAINERCHECKONCHANGES` | `boolean` | `true` | Trigger a container check when Docker emits container lifecycle events (`create`, `start`, `stop`, `destroy`, etc.). Set to `false` to only use the interval check. Recommended for environments with many containers to reduce MQTT message traffic. |
|    `updateCheckInterval` |  `MAIN_UPDATECHECKINTERVAL`   | `string` |  `""`   | The interval at which updates are checked and published/republished to the MQTT broker, must be in the format`[number][unit]`, where `[number]` is a positive integer and [`[unit]`](#unit) <br> (same of containerCheckInterval if `""`). |
|                 `prefix` |         `MAIN_PREFIX`         | `string` |  `""`   | Parameter specifies a prefix to add to the MQTT topic when publishing updates. Enabling you to have multiple instances of MqDockerUp publishing to the same MQTT broker without conflicts.                                            |

> [!WARNING] 
> If you upgrade from version 1.14.0 (or lower), some name are changed:
> * `main.interval`/`MAIN_INTERVAL` is now `main.containerCheckInterval`/`MAIN_CONTAINERCHECKINTERVAL`. 
> * `main.imageUpdateInterval`/`MAIN_IMAGEUPDATEINTERVAL`  is now `main.updateCheckInterval`/`MAIN_UPDATECHECKINTERVAL`. 



### <a name="Unit"></a>`[Unit]`

|    __Unit__ |   `s`   |   `m`   |  `h`  | `d`  |  `w`  |
| ----------: | :-----: | :-----: | :---: | :--: | :---: |
| __Meaning__ | Seconds | Minutes | Hours | Days | Weeks |



### MQTT Configuration

The MQTT configuration is specified in the `mqtt` section of `config.yaml`:

|              Name | Environmental Variable  |   Type    |         Default         | Description                                                                                             |
| ----------------: | :--------------------: | :-------: | :---------------------: | :------------------------------------------------------------------------------------------------------ |
|   `connectionUri` |  `MQTT_CONNECTIONURI`  | `string`  | `mqtt://127.0.0.1:1883` | The URL of the MQTT broker to connect to.                                                               |
|           `topic` |      `MQTT_TOPIC`      | `string`  |      `mqdockerup`       | The MQTT topic to publish updates to.                                                                   |
| `discoveryPrefix` | `MQTT_DISCOVERYPREFIX` | `string`  |     `homeassistant`     | The Prefix chosen in HA as `discovery prefix` (change only if you changed it in HA)                     |
| `suggestedArea` | `MQTT_SUGGESTEDAREA` | `string`  |     `Docker`     | The Home Assistant suggested area to assign to created devices.                     |
|        `clientId` |    `MQTT_CLIENTID`     | `string`  |      `mqdockerup`       | The MQTT client ID to use when connecting to the broker.                                                |
|        `username` |    `MQTT_USERNAME`     | `string`  |          `ha`           | The username to use when connecting to the MQTT broker.                                                 |
|        `password` |    `MQTT_PASSWORD`     | `string`  |          `""`           | The password to use when connecting to the MQTT broker.                                                 |
|        `haLegacy` |    `MQTT_HALEGACY`     | `boolean` |         `false`         | The way MqDockerUp creates the update entity, `false` for HA 2024.11+ and `true` for previous versions. |
|  `connectTimeout` | `MQTT_CONNECTTIMEOUT`  |   `int`   |          `60`           | The maximum time, in seconds, to wait for a successful connection to the MQTT broker.                   |
| `protocolVersion` | `MQTT_PROTOCOLVERSION` |   `int`   |           `5`           | The MQTT protocol version to use when connecting to the broker.                                         |
| `maxReconnectDelay` | `MQTT_MAXRECONNECTDELAY` | `int` |          `300`          | The maximum time, in seconds, between reconnection attempts when disconnected from the MQTT broker.     |




### Access Tokens Configuration

The access tokens configuration is specified in the `accessTokens` section of `config.yaml`:

|        Name |  Environmental Variable   |   Type   | Default | Description                                                                                            |
| ----------: | :----------------------: | :------: | :-----: | :----------------------------------------------------------------------------------------------------- |
| `dockerhub` | `ACCESSTOKENS_DOCKERHUB` | `string` |  `""`   | The Dockerhub token, used to avoid the limitations of the DockerHub API _‼️Still Work In Progress_. |
|    `github` |  `ACCESSTOKENS_GITHUB`   | `string` |  `""`   | The Github token, used to manage images on GitHub (`ghcr.io`) _⚠️Needed for this type of images_.   |

> [!NOTE]
>**To setup GitHub access token:**
>
>Setup a [Fine-grained personal access token](https://github.com/settings/personal-access-tokens) with the following permissions:
> - Repository Access -> All repositories
> - Repository Permissions (Read-Only):
>   - Commit Statuses
>   - Contents
>   - Merge queues
>   - Metadata
>   - Pull requests

### Ignore Configuration

The ignore configuration is specified in the `ignore` section of `config.yaml`:

|         Name | Environmental Variable |   Type   | Default | Description                                                                                                         |
| -----------: | :-------------------: | :------: | :-----: | :------------------------------------------------------------------------------------------------------------------ |
| `containers` |  `IGNORE_CONTAINERS`  | `string` |  `""`   | A comma separated list of container to be ignored in the check, or `*` to ignore all containers .                   |
|    `updates` |   `IGNORE_UPDATES`    | `string` |  `""`   | A comma separated list of container which updates should be ignored in the check, or `*` to ignore all containers . |

### Logs Configuration

The ignore configuration is specified in the `logs` section of `config.yaml`:

|    Name | Environmental Variable |   Type   | Default  | Description                                                                                                     |
| ------: | :-------------------: | :------: | :------: | :-------------------------------------------------------------------------------------------------------------- |
| `level` |     `LOGS_LEVEL`      | `string` | `"info"` | Choose the maximum level of logs to show, in order `error`, `warn`, `info`, `http`, `verbose`, `debug`, `silly` |



## Config Examples

### <a name="yaml"></a> `config.yaml`
Here some examples with all config defaults:
```yaml
main:
  containerCheckInterval: "5m"
  containerCheckOnChanges: true
  updateCheckInterval: ""
  prefix: ""
mqtt:
  connectionUri: "mqtt://127.0.0.1:1883"
  topic: "mqdockerup"
  discoveryPrefix: "homeassistant"
  suggestedArea: "Docker"
  clientId: "mqdockerup"
  username: "ha"
  password: "12345678"
  haLegacy: false
  connectTimeout: 60
  protocolVersion: 5
accessTokens:
  dockerhub: "" 
  github: ""
ignore:
  containers: "some,container"
  updates: "other,container"
logs:
  level: "info"
```
You can also use environment variables to override the values in the config file. The environment variables must have the same name as the config keys, but in uppercase and with underscores instead of dots.
For example, to override the `mqtt.connectionUri` value, you can set the `MQTT_CONNECTIONURI` environment variable. 
Here some examples with all variables defaults:

### <a name="run"></a>Docker run

```bash
docker run -d \
  --restart always \
  --name mqdockerup \
  -e MAIN_CONTAINERCHECKINTERVAL="5m" \
  -e MAIN_CONTAINERCHECKONCHANGES=true \
  -e MAIN_UPDATECHECKINTERVAL="" \
  -e MAIN_PREFIX="" \
  -e MQTT_CONNECTIONURI="mqtt://127.0.0.1:1883" \
  -e MQTT_TOPIC="mqdockerup" \
  -e MQTT_DISCOVERYPREFIX="homeassistant" \
  -e MQTT_SUGGESTEDAREA="Docker" \
  -e MQTT_CLIENTID="mqdockerup" \
  -e MQTT_USERNAME="ha" \
  -e MQTT_PASSWORD="" \
  -e MQTT_HALEGACY=false \
  -e MQTT_CONNECTTIMEOUT=60 \
  -e MQTT_PROTOCOLVERSION=5 \
  -e ACCESSTOKENS_DOCKERHUB="" \
  -e ACCESSTOKENS_GITHUB="" \
  -e IGNORE_CONTAINERS="" \
  -e IGNORE_UPDATES="" \
  -e LOGS_LEVEL="info" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v your/path/data:/app/data/ \
  -v your/path/config.yaml:/app/config.yaml \
  ghcr.io/wheemer/mqdockerup:latest
```

### <a name="compose"></a>Docker Compose

```yaml
services:
  mqdockerup:
    image: ghcr.io/wheemer/mqdockerup:latest
    container_name: mqdockerup
    hostname: mqdockerup
    restart: always
    environment:
      MAIN_CONTAINERCHECKINTERVAL: "5m"
      MAIN_CONTAINERCHECKONCHANGES: true
      MAIN_UPDATECHECKINTERVAL: ""
      MAIN_PREFIX: ""
      MQTT_CONNECTIONURI: "mqtt://127.0.0.1:1883"
      MQTT_TOPIC: "mqdockerup"
      MQTT_DISCOVERYPREFIX: "homeassistant"
      MQTT_SUGGESTEDAREA: "Docker"
      MQTT_CLIENTID: "mqdockerup"
      MQTT_USERNAME: "ha"
      MQTT_PASSWORD: ""
      MQTT_HALEGACY : false
      MQTT_CONNECTTIMEOUT: 60
      MQTT_PROTOCOLVERSION: 5
      ACCESSTOKENS_DOCKERHUB: ""
      ACCESSTOKENS_GITHUB: ""
      IGNORE_CONTAINERS: ""
      IGNORE_UPDATES: ""
      LOGS_LEVEL: "info"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - your/path/data:/app/data/ 
      - your/path/config.yaml:/app/config.yaml 
```

## Labels

You can use some of these labels on individual containers to apply to them the effect written in the description.


|                           Name |   Type    | Default  | Description                                                                               |
| -----------------------------: | :-------: | :------: | :---------------------------------------------------------------------------------------- |
|  `mqdockerup.ignore_container` | `boolean` | Optional | `true` to ignore the container that have this label, `false` to not ignore                |
|    `mqdockerup.ignore_updates` | `boolean` | Optional | `true` to ignore the updates of the container that have this label, `false` to not ignore |


## Screenshots

![image](https://github.com/user-attachments/assets/f6f78bdb-4f7d-4080-8588-63fdaafa1e51)
<img width="600" alt="image" src="https://user-images.githubusercontent.com/7061122/221386530-d5168c26-8ead-4418-9ab4-84ad6ff91ba9.png">

## Contribute

This project is open source and contributions are welcome. If you are running the Wheemer Edition and find a Home Assistant discovery, update, or command-routing issue, please open an issue or pull request here.

## Support

If this fork saves you time or keeps your Home Assistant Docker dashboard sane, you can support the work through PayPal: https://www.paypal.me/wheemer
