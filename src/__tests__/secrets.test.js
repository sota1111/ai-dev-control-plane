import { jest } from '@jest/globals';
import * as secrets from '../config/secrets.js';

describe('secrets', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.resetModules();
    secrets.resetSecretsForTest();
    process.env = { ...originalEnv };
    // Clear relevant env vars to ensure clean state
    delete process.env.SECRETS_BACKEND;
    delete process.env.SECRET_MANAGER_PROJECT_ID;
    delete process.env.GOOGLE_CLOUD_PROJECT;
    delete process.env.SECRET_MANAGER_PREFIX;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('getBackend', () => {
    it('should return dotenv by default', () => {
      expect(secrets.getBackend()).toBe('dotenv');
    });

    it('should return secret-manager if SECRETS_BACKEND is set', () => {
      process.env.SECRETS_BACKEND = 'secret-manager';
      expect(secrets.getBackend()).toBe('secret-manager');
    });

    it('should return dotenv if SECRETS_BACKEND is set to dotenv', () => {
      process.env.SECRETS_BACKEND = 'dotenv';
      expect(secrets.getBackend()).toBe('dotenv');
    });

    it('should return secret-manager if GOOGLE_CLOUD_PROJECT is set', () => {
      process.env.GOOGLE_CLOUD_PROJECT = 'my-project';
      expect(secrets.getBackend()).toBe('secret-manager');
    });

    it('should return secret-manager if SECRET_MANAGER_PROJECT_ID is set', () => {
      process.env.SECRET_MANAGER_PROJECT_ID = 'my-project';
      expect(secrets.getBackend()).toBe('secret-manager');
    });
  });

  describe('dotenv fallback', () => {
    it('should return value from process.env when backend is dotenv', () => {
      process.env.FOO = 'bar';
      expect(secrets.getSecret('FOO')).toBe('bar');
    });

    it('should return undefined for missing secret', () => {
      expect(secrets.getSecret('MISSING_VAR')).toBeUndefined();
    });
  });

  describe('getRequiredSecret', () => {
    it('should return value when present', () => {
      process.env.FOO = 'bar';
      expect(secrets.getRequiredSecret('FOO')).toBe('bar');
    });

    it('should throw error when missing', () => {
      expect(() => secrets.getRequiredSecret('MISSING_VAR')).toThrow('Missing required secret: MISSING_VAR');
    });

    it('should throw error when empty string', () => {
      process.env.FOO = '';
      expect(() => secrets.getRequiredSecret('FOO')).toThrow('Missing required secret: FOO');
    });
  });

  describe('secret-manager dynamic fetch', () => {
    it('should fetch from Secret Manager and override process.env', async () => {
      process.env.SECRETS_BACKEND = 'secret-manager';
      process.env.SECRET_MANAGER_PROJECT_ID = 'proj';
      process.env.FOO = 'env-value';

      const mockClient = {
        access: jest.fn().mockResolvedValue('sm-value')
      };
      secrets.setSecretManagerClientForTest(mockClient);

      await secrets.initSecrets(['FOO']);

      expect(mockClient.access).toHaveBeenCalledWith('FOO');
      expect(secrets.getSecret('FOO')).toBe('sm-value');
    });

    it('should use prefix if configured', async () => {
      process.env.SECRETS_BACKEND = 'secret-manager';
      process.env.SECRET_MANAGER_PROJECT_ID = 'proj';
      process.env.SECRET_MANAGER_PREFIX = 'cp-';

      const mockClient = {
        access: jest.fn().mockResolvedValue('val')
      };
      secrets.setSecretManagerClientForTest(mockClient);

      await secrets.initSecrets(['FOO']);

      expect(mockClient.access).toHaveBeenCalledWith('cp-FOO');
      expect(secrets.getSecret('FOO')).toBe('val');
    });

    it('should cache results and call client only once per init', async () => {
      process.env.SECRETS_BACKEND = 'secret-manager';
      process.env.SECRET_MANAGER_PROJECT_ID = 'proj';

      const mockClient = {
        access: jest.fn().mockResolvedValue('val')
      };
      secrets.setSecretManagerClientForTest(mockClient);

      await secrets.initSecrets(['FOO']);
      expect(mockClient.access).toHaveBeenCalledTimes(1);

      expect(secrets.getSecret('FOO')).toBe('val');
      expect(secrets.getSecret('FOO')).toBe('val');
      
      // Another init call will re-fetch (current implementation allows re-init)
      await secrets.initSecrets(['FOO']);
      expect(mockClient.access).toHaveBeenCalledTimes(2);
    });

    it('should fallback to env if Secret Manager fetch fails', async () => {
      process.env.SECRETS_BACKEND = 'secret-manager';
      process.env.SECRET_MANAGER_PROJECT_ID = 'proj';
      process.env.FOO = 'env-value';

      const mockClient = {
        access: jest.fn().mockRejectedValue(new Error('SM Fail'))
      };
      secrets.setSecretManagerClientForTest(mockClient);

      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      await secrets.initSecrets(['FOO']);

      expect(secrets.getSecret('FOO')).toBe('env-value');
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('failed to fetch FOO from Secret Manager'));
      
      consoleSpy.mockRestore();
    });
  });
});
