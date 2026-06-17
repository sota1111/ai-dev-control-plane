import { getSecret, resetSecretsForTest } from '../config/secrets.js';
import * as runner from '../runner.js';

describe('Secrets Integration', () => {
  const originalApiKey = process.env.LINEAR_API_KEY;

  beforeEach(() => {
    resetSecretsForTest();
  });

  afterAll(() => {
    process.env.LINEAR_API_KEY = originalApiKey;
  });

  test('getSecret returns value from process.env in dotenv mode', () => {
    process.env.LINEAR_API_KEY = 'test-api-key-123';
    expect(getSecret('LINEAR_API_KEY')).toBe('test-api-key-123');
  });

  test('runner.linearQuery uses getSecret for LINEAR_API_KEY', async () => {
    process.env.LINEAR_API_KEY = 'test-api-key-456';
    
    // We don't need to actually call the network, 
    // we can just check if it fails with "LINEAR_API_KEY not set" when it IS unset.
    process.env.LINEAR_API_KEY = '';
    await expect(runner.linearQuery('{ viewer { login } }'))
      .rejects.toThrow('LINEAR_API_KEY not set');

    // When set, it should NOT throw "not set" error 
    // (it will likely throw a network error or something else, but that's fine for this test)
    process.env.LINEAR_API_KEY = 'test-api-key-789';
    try {
      await runner.linearQuery('{ viewer { login } }');
    } catch (err) {
      expect(err.message).not.toBe('LINEAR_API_KEY not set');
    }
  });
});
