'use strict';

const http = require('http');
const https = require('https');

/** @type {Map<string, string>} */
const cache = new Map();
let injectedClient = null;
let resolvedBackend = null;

/**
 * Returns the secret value.
 * Cache (Secret Manager) wins over process.env once hydrated.
 * @param {string} name
 * @returns {string|undefined}
 */
function getSecret(name) {
  if (cache.has(name)) {
    return cache.get(name);
  }
  return process.env[name];
}

/**
 * Returns the secret value or throws if missing.
 * @param {string} name
 * @returns {string}
 */
function getRequiredSecret(name) {
  const val = getSecret(name);
  if (val === undefined || val === null || val === '') {
    throw new Error(`Missing required secret: ${name}`);
  }
  return val;
}

/**
 * Resolves the backend from environment variables.
 * @returns {'secret-manager'|'dotenv'}
 */
function getBackend() {
  if (resolvedBackend) return resolvedBackend;

  const envBackend = process.env.SECRETS_BACKEND;
  if (envBackend === 'secret-manager') {
    resolvedBackend = 'secret-manager';
  } else if (envBackend === 'dotenv') {
    resolvedBackend = 'dotenv';
  } else if (process.env.GOOGLE_CLOUD_PROJECT || process.env.SECRET_MANAGER_PROJECT_ID) {
    resolvedBackend = 'secret-manager';
  } else {
    resolvedBackend = 'dotenv';
  }
  return resolvedBackend;
}

/**
 * Default Secret Manager client implementation using raw http/https.
 */
const defaultClient = {
  /**
   * Fetches an access token from the GCP metadata server.
   * @returns {Promise<string>}
   */
  async getAccessToken() {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'metadata.google.internal',
        path: '/computeMetadata/v1/instance/service-accounts/default/token',
        method: 'GET',
        headers: {
          'Metadata-Flavor': 'Google'
        },
        timeout: 5000
      };

      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            return reject(new Error(`Metadata server returned status ${res.statusCode}: ${data}`));
          }
          try {
            const json = JSON.parse(data);
            if (!json.access_token) {
              return reject(new Error('Metadata server response missing access_token'));
            }
            resolve(json.access_token);
          } catch (e) {
            reject(new Error(`Failed to parse metadata server response: ${e.message}`));
          }
        });
      });

      req.on('error', (err) => reject(err));
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Metadata server timeout'));
      });
      req.end();
    });
  },

  /**
   * Fetches a secret from Secret Manager.
   * @param {string} secretId
   * @returns {Promise<string>}
   */
  async access(secretId) {
    const project = process.env.SECRET_MANAGER_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT;
    if (!project) {
      throw new Error('No GCP project ID configured (SECRET_MANAGER_PROJECT_ID or GOOGLE_CLOUD_PROJECT)');
    }

    const token = await this.getAccessToken();

    return new Promise((resolve, reject) => {
      const url = `https://secretmanager.googleapis.com/v1/projects/${project}/secrets/${secretId}/versions/latest:access`;
      const options = {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/json'
        },
        timeout: 10000
      };

      const req = https.request(url, options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            return reject(new Error(`Secret Manager returned status ${res.statusCode}: ${data}`));
          }
          try {
            const json = JSON.parse(data);
            const base64Data = json.payload && json.payload.data;
            if (!base64Data) {
              return reject(new Error('Secret Manager response missing payload data'));
            }
            resolve(Buffer.from(base64Data, 'base64').toString('utf8'));
          } catch (e) {
            reject(new Error(`Failed to parse Secret Manager response: ${e.message}`));
          }
        });
      });

      req.on('error', (err) => reject(err));
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Secret Manager timeout'));
      });
      req.end();
    });
  }
};

/**
 * Hydrates the in-memory cache from Secret Manager if backend is secret-manager.
 * @param {string[]} names
 * @returns {Promise<void>}
 */
async function initSecrets(names = []) {
  if (getBackend() !== 'secret-manager') {
    return;
  }

  const client = injectedClient || defaultClient;
  const prefix = process.env.SECRET_MANAGER_PREFIX || '';

  await Promise.allSettled(names.map(async (name) => {
    try {
      const secretId = prefix + name;
      const value = await client.access(secretId);
      cache.set(name, value);
    } catch (err) {
      console.warn(`[secrets] failed to fetch ${name} from Secret Manager: ${err.message} — falling back to env`);
    }
  }));
}

/**
 * Resets the secrets cache and backend for testing.
 */
function resetSecretsForTest() {
  cache.clear();
  injectedClient = null;
  resolvedBackend = null;
}

/**
 * Injects a fake Secret Manager client for testing.
 * @param {{ access: (secretId: string) => Promise<string> }} client
 */
function setSecretManagerClientForTest(client) {
  injectedClient = client;
}

module.exports = {
  getSecret,
  getRequiredSecret,
  initSecrets,
  loadSecrets: initSecrets, // alias
  getBackend,
  resetSecretsForTest,
  setSecretManagerClientForTest
};
