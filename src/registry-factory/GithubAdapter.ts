import ConfigService from "../services/ConfigService";
import logger from "../services/LoggerService";
import { ImageRegistryAdapter } from "./ImageRegistryAdapter";
import axios from "axios";

const config = ConfigService.getConfig();

export class GithubAdapter extends ImageRegistryAdapter {
    private tag: string;

    constructor(image: string, tag: string = 'latest') {
        const accessToken =  config?.accessTokens?.github;

        super(image, accessToken);
        this.tag = tag;

        if (!accessToken) {
            logger.error('Github access token is not defined');
        }

    }

    static get displayName() {
        return 'Github Packages';
    }

    static canHandleImage(image: string): boolean {
        try {
            const url = new URL(`https://${image}`);
            const host = url.hostname;

            // check if the host is exactly 'ghcr.io'
            return host === 'ghcr.io';
        } catch (error) {
            // if the image string is not a valid URL, it's not a Github image
            return false;
        }
    }

    private getImageUrl(tag: string = this.tag): string {
        const parts = this.image.split(':')[0].split('/');
        const registry = parts[0];
        const repoPath = parts.slice(1).join('/');
        return `https://${registry}/v2/${repoPath}/manifests/${tag}`;
    }

    private getBlobUrl(digest: string): string {
        const parts = this.image.split(':')[0].split('/');
        const registry = parts[0];
        const repoPath = parts.slice(1).join('/');
        return `https://${registry}/v2/${repoPath}/blobs/${digest}`;
    }

    async checkForNewDigest(): Promise<{ newDigest: string | null; tag?: string; }> {
        const accessTokenSet = !!config?.accessTokens?.github;
        if (accessTokenSet) {
            try {
                this.http.defaults.headers['Accept'] = 'application/vnd.oci.image.index.v1+json';

                const latestReleaseTag = await this.getLatestReleaseImageTag();
                const tag = latestReleaseTag || this.tag;
                const response = await this.http.get(this.getImageUrl(tag));
                const newDigest = this.removeSHA256Prefix(response.headers['docker-content-digest']);

                return { newDigest, tag };
            } catch (error) {
                logger.error(`Failed to check for new Github image digest: ${error}`);
                throw error;
            }
        }

        return { newDigest: null };
    }

    /**
     * Resolves the org.opencontainers.image.version label of the tracked tag
     * by fetching its manifest and config blob
     */
    async getVersionLabel(): Promise<string | null> {
        try {
            const indexResponse = await this.http.get(this.getImageUrl(), {
                headers: { Accept: 'application/json' },
            });

            let configDigest = indexResponse.data?.config?.digest;
            if (!configDigest) return null;

            const configResponse = await this.http.get(this.getBlobUrl(configDigest));
            return configResponse.data?.config?.Labels?.["org.opencontainers.image.version"] ?? null;
        } catch (error) {
            return null;
        }
    }

    private async getLatestReleaseImageTag(): Promise<string | null> {
        if (!this.isSemverTag(this.tag)) {
            return null;
        }

        const githubRepo = this.getGithubRepository();
        if (!githubRepo) {
            return null;
        }

        try {
            const response = await axios.get(`https://api.github.com/repos/${githubRepo}/releases/latest`, {
                headers: { Accept: 'application/vnd.github+json' },
            });
            const releaseTag = response.data?.tag_name;
            if (!releaseTag) {
                return null;
            }

            const imageTag = releaseTag.replace(/^v/i, "");
            if (this.compareSemver(imageTag, this.tag) <= 0) {
                return null;
            }

            return imageTag;
        } catch (error) {
            return null;
        }
    }

    private getGithubRepository(): string | null {
        const parts = this.image.split(':')[0].split('/');
        if (parts.length < 3) {
            return null;
        }

        return `${parts[1]}/${parts[2]}`;
    }

    private isSemverTag(tag: string): boolean {
        return /^v?\d+\.\d+\.\d+([.-].*)?$/.test(tag);
    }

    private compareSemver(a: string, b: string): number {
        const aParts = a.replace(/^v/i, "").split(/[.-]/).slice(0, 3).map(Number);
        const bParts = b.replace(/^v/i, "").split(/[.-]/).slice(0, 3).map(Number);

        for (let i = 0; i < 3; i++) {
            const diff = (aParts[i] || 0) - (bParts[i] || 0);
            if (diff !== 0) {
                return diff;
            }
        }

        return 0;
    }
}
