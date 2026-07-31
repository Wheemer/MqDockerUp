const mockGet = jest.fn();

jest.mock("axios", () => ({
  __esModule: true,
  default: {
    create: jest.fn(() => ({ get: mockGet, defaults: { headers: {} } })),
    get: jest.fn(),
  },
  create: jest.fn(() => ({ get: mockGet, defaults: { headers: {} } })),
  get: jest.fn(),
}));

jest.mock("../src/services/ConfigService", () => ({
  __esModule: true,
  default: {
    getConfig: () => ({
      accessTokens: { github: "test-token" },
    }),
  },
}));

import { GithubAdapter } from "../src/registry-factory/GithubAdapter";
import axios from "axios";

const mockAxiosGet = axios.get as jest.Mock;

describe('GithubAdapter', () => {
  test('canHandleImage should return true for ghcr images', () => {
    expect(GithubAdapter.canHandleImage('ghcr.io/user/image:latest')).toBe(true);
    expect(GithubAdapter.canHandleImage('ghcr.io/user/image')).toBe(true);
  });

  test('canHandleImage should return false for non-ghcr images', () => {
    expect(GithubAdapter.canHandleImage('unsupported.registry.com/user/image')).toBe(false);
  });

  test('canHandleImage should return false for DockerHub images without explicit registry', () => {
    expect(GithubAdapter.canHandleImage('library/image')).toBe(false);
    expect(GithubAdapter.canHandleImage('user/image')).toBe(false);
    expect(GithubAdapter.canHandleImage('image')).toBe(false);
  });

  describe('getImageUrl', () => {
    it('should return the correct URL for a ghcr image', () => {
      const adapter = new GithubAdapter('ghcr.io/user/image');
      const url = adapter['getImageUrl']();

      expect(url).toEqual('https://ghcr.io/v2/user/image/manifests/latest');
    });

    it('should return the correct URL with a custom tag', () => {
      const adapter = new GithubAdapter('ghcr.io/user/image', 'customTag');
      const url = adapter['getImageUrl']();

      expect(url).toEqual('https://ghcr.io/v2/user/image/manifests/customTag');
    });

    it('should return the correct URL with latest tag', () => {
      const adapter = new GithubAdapter('ghcr.io/user/image', 'latest');
      const url = adapter['getImageUrl']();

      expect(url).toEqual('https://ghcr.io/v2/user/image/manifests/latest');
    });

    it('should preserve multi-level repository paths', () => {
      const adapter = new GithubAdapter('ghcr.io/org/team/project/image', 'latest');
      const url = adapter['getImageUrl']();

      expect(url).toEqual('https://ghcr.io/v2/org/team/project/image/manifests/latest');
    });
  });

  describe('getVersionLabel', () => {
    function mockRegistryFlow(version: string | null) {
      mockGet.mockImplementation((url: string) => {
        if (url === 'https://ghcr.io/v2/user/image/manifests/latest') {
          return Promise.resolve({ data: { config: { digest: 'sha256:configdigest' } } });
        }
        if (url === 'https://ghcr.io/v2/user/image/blobs/sha256:configdigest') {
          const labels = version ? { "org.opencontainers.image.version": version } : {};
          return Promise.resolve({ data: { config: { Labels: labels } } });
        }
        return Promise.reject(new Error(`Unexpected URL: ${url}`));
      });
    }

    beforeEach(() => {
      mockGet.mockReset();
    });

    it('resolves newVersion from the config blob', async () => {
      mockRegistryFlow('2.15.3');

      const adapter = new GithubAdapter('ghcr.io/user/image', 'latest');
      const result = await adapter.getVersionLabel();

      expect(result).toBe('2.15.3');
    });

    it('returns null when the config blob has no version label', async () => {
      mockRegistryFlow(null);

      const adapter = new GithubAdapter('ghcr.io/user/image', 'latest');
      const result = await adapter.getVersionLabel();

      expect(result).toBeNull();
    });
  });

  describe('checkForNewDigest', () => {
    beforeEach(() => {
      mockGet.mockReset();
      mockAxiosGet.mockReset();
    });

    it('uses the latest GitHub release tag for semver-pinned GHCR images', async () => {
      mockGet.mockImplementation((url: string) => {
        if (url === 'https://ghcr.io/v2/blakeblackshear/frigate/manifests/0.17.2') {
          return Promise.resolve({ headers: { 'docker-content-digest': 'sha256:newdigest' } });
        }
        return Promise.reject(new Error(`Unexpected URL: ${url}`));
      });
      mockAxiosGet.mockResolvedValue({ data: { tag_name: 'v0.17.2' } });

      const adapter = new GithubAdapter('ghcr.io/blakeblackshear/frigate', '0.17.1');
      const result = await adapter.checkForNewDigest();

      expect(result).toEqual({ newDigest: 'newdigest', tag: '0.17.2' });
      expect(mockAxiosGet).toHaveBeenCalledWith(
        'https://api.github.com/repos/blakeblackshear/frigate/releases/latest',
        { headers: { Accept: 'application/vnd.github+json' } }
      );
    });

    it('keeps non-semver tags on their configured tag', async () => {
      mockGet.mockImplementation((url: string) => {
        if (url === 'https://ghcr.io/v2/blakeblackshear/frigate/manifests/stable') {
          return Promise.resolve({ headers: { 'docker-content-digest': 'sha256:stabledigest' } });
        }
        return Promise.reject(new Error(`Unexpected URL: ${url}`));
      });

      const adapter = new GithubAdapter('ghcr.io/blakeblackshear/frigate', 'stable');
      const result = await adapter.checkForNewDigest();

      expect(result).toEqual({ newDigest: 'stabledigest', tag: 'stable' });
    });
  });
});
