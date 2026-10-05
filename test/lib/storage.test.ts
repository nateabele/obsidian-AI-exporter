import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getSettings, saveSettings, migrateSettings } from '../../src/lib/storage';
import { DEFAULT_SYNC_SETTINGS } from '../../src/lib/settings-schema';
import {
  DEFAULT_COMPANION_URL,
  DEFAULT_NOTE_SIZE_MIB,
  DEFAULT_SCROLL_IDLE_TIMEOUT_SEC,
  DEFAULT_SCROLL_MAX_TIMEOUT_SEC,
} from '../../src/lib/constants';
import type { SyncSettings } from '../../src/lib/types';

describe('storage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset storage state
    const localStore: Record<string, unknown> = {};
    const syncStore: Record<string, unknown> = {};

    vi.mocked(chrome.storage.local.get).mockImplementation(
      (keys: string | string[] | Record<string, unknown> | null) => {
        if (typeof keys === 'string') {
          return Promise.resolve({ [keys]: localStore[keys] });
        }
        return Promise.resolve(localStore);
      }
    );

    vi.mocked(chrome.storage.local.set).mockImplementation((items: Record<string, unknown>) => {
      Object.assign(localStore, items);
      return Promise.resolve();
    });

    vi.mocked(chrome.storage.sync.get).mockImplementation(
      (keys: string | string[] | Record<string, unknown> | null) => {
        if (typeof keys === 'string') {
          return Promise.resolve({ [keys]: syncStore[keys] });
        }
        return Promise.resolve(syncStore);
      }
    );

    vi.mocked(chrome.storage.sync.set).mockImplementation((items: Record<string, unknown>) => {
      Object.assign(syncStore, items);
      return Promise.resolve();
    });
  });

  describe('getSettings', () => {
    it('returns default settings when storage is empty', async () => {
      const settings = await getSettings();

      expect(settings.obsidianApiKey).toBe('');
      expect(settings.obsidianUrl).toBe('http://127.0.0.1:27123');
      expect(settings.vaultPath).toBe('AI/{platform}');
      expect(settings.templateOptions.messageFormat).toBe('callout');
      expect(settings.enableImageExport).toBe(true);
      expect(settings.imageVaultPath).toBe('AI/{platform}/images');
      expect(settings.flattenLargeCallouts).toBe(true);
      expect(settings.maxCalloutLines).toBe(200);
    });

    it('persists image export settings via saveSettings', async () => {
      await saveSettings({ enableImageExport: false, imageVaultPath: 'Attachments/{platform}' });
      expect(chrome.storage.sync.set).toHaveBeenCalledWith({
        settings: expect.objectContaining({
          enableImageExport: false,
          imageVaultPath: 'Attachments/{platform}',
        }),
      });
    });

    it('returns stored secure settings from local storage', async () => {
      vi.mocked(chrome.storage.local.get).mockResolvedValue({
        secureSettings: { obsidianApiKey: 'test-api-key' },
      });

      const settings = await getSettings();
      expect(settings.obsidianApiKey).toBe('test-api-key');
    });

    it('returns stored sync settings from sync storage', async () => {
      vi.mocked(chrome.storage.sync.get).mockResolvedValue({
        settings: { obsidianUrl: 'https://192.168.1.5:27123', vaultPath: 'Custom/Path' },
      });

      const settings = await getSettings();
      expect(settings.obsidianUrl).toBe('https://192.168.1.5:27123');
      expect(settings.vaultPath).toBe('Custom/Path');
    });

    it('migrates legacy obsidianPort to obsidianUrl', async () => {
      vi.mocked(chrome.storage.sync.get).mockResolvedValue({
        settings: { obsidianPort: 28000 },
      });

      const settings = await getSettings();
      expect(settings.obsidianUrl).toBe('http://127.0.0.1:28000');
    });

    it('prefers obsidianUrl over legacy obsidianPort', async () => {
      vi.mocked(chrome.storage.sync.get).mockResolvedValue({
        settings: { obsidianUrl: 'https://127.0.0.1:27123', obsidianPort: 28000 },
      });

      const settings = await getSettings();
      expect(settings.obsidianUrl).toBe('https://127.0.0.1:27123');
    });

    it('merges template options with defaults', async () => {
      vi.mocked(chrome.storage.sync.get).mockResolvedValue({
        settings: {
          templateOptions: { messageFormat: 'blockquote' },
        },
      });

      const settings = await getSettings();
      expect(settings.templateOptions.messageFormat).toBe('blockquote');
      expect(settings.templateOptions.includeId).toBe(true); // default preserved
    });

    it("defaults filenameScheme to 'title' (matches the migrated vault names)", async () => {
      const settings = await getSettings();
      expect(settings.templateOptions.filenameScheme).toBe('title');
    });

    it('normalizes corrupted sync values to defaults (L-1)', async () => {
      vi.mocked(chrome.storage.sync.get).mockResolvedValue({
        settings: {
          maxCalloutLines: 'not-a-number',
          enableAppendMode: 'yes',
          templateOptions: { messageFormat: 'weird' },
        },
      });

      const settings = await getSettings();
      expect(settings.maxCalloutLines).toBe(200);
      expect(settings.enableAppendMode).toBe(false);
      expect(settings.templateOptions.messageFormat).toBe('callout');
    });

    it('falls back to the legacy sync API key before migration completes (L-2)', async () => {
      // Simulate the race: migration has not yet moved the key to local storage.
      vi.mocked(chrome.storage.local.get).mockResolvedValue({ secureSettings: undefined });
      vi.mocked(chrome.storage.sync.get).mockResolvedValue({
        settings: { obsidianApiKey: 'legacy-sync-key' },
      });

      const settings = await getSettings();
      expect(settings.obsidianApiKey).toBe('legacy-sync-key');
    });

    it('prefers the migrated local API key over any legacy sync value (L-2)', async () => {
      vi.mocked(chrome.storage.local.get).mockResolvedValue({
        secureSettings: { obsidianApiKey: 'local-key' },
      });
      vi.mocked(chrome.storage.sync.get).mockResolvedValue({
        settings: { obsidianApiKey: 'legacy-sync-key' },
      });

      const settings = await getSettings();
      expect(settings.obsidianApiKey).toBe('local-key');
    });

    it('returns an empty API key when neither store has one (L-2)', async () => {
      vi.mocked(chrome.storage.local.get).mockResolvedValue({ secureSettings: undefined });
      vi.mocked(chrome.storage.sync.get).mockResolvedValue({ settings: {} });

      const settings = await getSettings();
      expect(settings.obsidianApiKey).toBe('');
    });

    it('round-trips a stored title-date filenameScheme (#328)', async () => {
      vi.mocked(chrome.storage.sync.get).mockResolvedValue({
        settings: { templateOptions: { filenameScheme: 'title-date' } },
      });
      const settings = await getSettings();
      expect(settings.templateOptions.filenameScheme).toBe('title-date');
      expect(settings.templateOptions.messageFormat).toBe('callout'); // default preserved
    });

    it('returns default enableToolContent false when empty', async () => {
      const settings = await getSettings();
      expect(settings.enableToolContent).toBe(false);
    });

    it('returns default settings on error', async () => {
      vi.mocked(chrome.storage.local.get).mockRejectedValue(new Error('Storage error'));

      const settings = await getSettings();
      expect(settings.obsidianApiKey).toBe('');
      expect(settings.obsidianUrl).toBe('http://127.0.0.1:27123');
    });
  });

  /**
   * Settings written before either side of the 2.14.5 merge added its keys.
   *
   * `normalizeSyncSettings()` is already pinned as total in
   * settings-schema.test.ts (`normalizeSyncSettings({})` equals
   * DEFAULT_SYNC_SETTINGS); what is pinned here is the COMPOSITION in
   * `getSettings()` — that the normaliser is actually applied to the stored sync
   * record, and that `companionToken` gets the same treatment on the separate
   * storage.local path. An undefined reaching the popup from here lands in an
   * <input>, and the next save persists the blank.
   */
  describe('getSettings — keys added after a record was stored', () => {
    /** The shape of a sync record predating both sides' newest keys. */
    const PRE_MERGE_SYNC_RECORD = {
      obsidianUrl: 'http://127.0.0.1:27123',
      vaultPath: 'Vault/Conversations',
    };

    it('fills in both sides new sync keys without dropping what was stored', async () => {
      vi.mocked(chrome.storage.sync.get).mockResolvedValue({
        settings: { ...PRE_MERGE_SYNC_RECORD },
      });

      const settings = await getSettings();

      // Feature-line keys.
      expect(settings.companionUrl).toBe(DEFAULT_COMPANION_URL);
      expect(settings.autoSyncPlatforms).toEqual(DEFAULT_SYNC_SETTINGS.autoSyncPlatforms);
      // Upstream keys.
      expect(settings.maxNoteSizeMiB).toBe(DEFAULT_NOTE_SIZE_MIB);
      expect(settings.scrollIdleTimeoutSec).toBe(DEFAULT_SCROLL_IDLE_TIMEOUT_SEC);
      expect(settings.scrollMaxTimeoutSec).toBe(DEFAULT_SCROLL_MAX_TIMEOUT_SEC);
      // Gap-filling must not overwrite what the user had actually saved.
      expect(settings.vaultPath).toBe(PRE_MERGE_SYNC_RECORD.vaultPath);
    });

    it('leaves no sync key undefined, whichever side added it', async () => {
      vi.mocked(chrome.storage.sync.get).mockResolvedValue({
        settings: { ...PRE_MERGE_SYNC_RECORD },
      });

      const settings = await getSettings();

      // Keyed off the defaults rather than a hand-written list, so a key added
      // by a future merge is covered without this test being edited.
      for (const key of Object.keys(DEFAULT_SYNC_SETTINGS) as (keyof SyncSettings)[]) {
        expect(settings[key], `no default reached ExtensionSettings.${key}`).toBeDefined();
      }
    });

    it('defaults companionToken for a secure record written before it existed', async () => {
      // companionToken is the third key the feature line added and the only one
      // on the storage.local path, so it cannot ride along with the sync
      // normaliser. A pre-companion record holds an API key and nothing else.
      vi.mocked(chrome.storage.local.get).mockResolvedValue({
        secureSettings: { obsidianApiKey: 'legacy-key' },
      });

      const settings = await getSettings();

      expect(settings.obsidianApiKey).toBe('legacy-key');
      // DEFAULT_SECURE_SETTINGS.companionToken (src/lib/storage.ts) — module-
      // private, so its value is restated rather than imported.
      expect(settings.companionToken).toBe('');
    });
  });

  describe('saveSettings', () => {
    it('saves API key to local storage', async () => {
      await saveSettings({ obsidianApiKey: 'new-api-key' });

      expect(chrome.storage.local.set).toHaveBeenCalledWith({
        secureSettings: { obsidianApiKey: 'new-api-key' },
      });
    });

    it('saves obsidianUrl and vaultPath to sync storage', async () => {
      vi.mocked(chrome.storage.sync.get).mockResolvedValue({ settings: {} });

      await saveSettings({ obsidianUrl: 'https://127.0.0.1:27123', vaultPath: 'New/Path' });

      expect(chrome.storage.sync.set).toHaveBeenCalledWith({
        settings: { obsidianUrl: 'https://127.0.0.1:27123', vaultPath: 'New/Path' },
      });
    });

    it('merges template options with current settings', async () => {
      vi.mocked(chrome.storage.local.get).mockResolvedValue({});
      vi.mocked(chrome.storage.sync.get).mockResolvedValue({
        settings: {
          templateOptions: { includeId: true, messageFormat: 'callout' },
        },
      });

      await saveSettings({
        templateOptions: { messageFormat: 'blockquote' } as never,
      });

      expect(chrome.storage.sync.set).toHaveBeenCalled();
      const callArgs = vi.mocked(chrome.storage.sync.set).mock.calls[0][0];
      expect(callArgs.settings.templateOptions.messageFormat).toBe('blockquote');
    });

    it('does not save to sync if only API key is provided', async () => {
      await saveSettings({ obsidianApiKey: 'key' });

      expect(chrome.storage.local.set).toHaveBeenCalled();
      expect(chrome.storage.sync.set).not.toHaveBeenCalled();
    });

    it('throws error on save failure', async () => {
      vi.mocked(chrome.storage.local.set).mockRejectedValue(new Error('Save failed'));

      await expect(saveSettings({ obsidianApiKey: 'key' })).rejects.toThrow('Save failed');
    });

    it('round-trips enableToolContent true', async () => {
      vi.mocked(chrome.storage.sync.get).mockResolvedValue({ settings: {} });

      await saveSettings({ enableToolContent: true });

      expect(chrome.storage.sync.set).toHaveBeenCalled();
      const callArgs = vi.mocked(chrome.storage.sync.set).mock.calls[0][0];
      expect(callArgs.settings.enableToolContent).toBe(true);
    });

    it('merges outputOptions with current settings', async () => {
      vi.mocked(chrome.storage.local.get).mockResolvedValue({});
      vi.mocked(chrome.storage.sync.get).mockResolvedValue({
        settings: {
          outputOptions: { obsidian: true, file: false, clipboard: false },
        },
      });

      await saveSettings({
        outputOptions: { file: true } as never,
      });

      expect(chrome.storage.sync.set).toHaveBeenCalled();
      const callArgs = vi.mocked(chrome.storage.sync.set).mock.calls[0][0];
      expect(callArgs.settings.outputOptions.file).toBe(true);
      expect(callArgs.settings.outputOptions.obsidian).toBe(true);
    });
  });

  describe('migrateSettings', () => {
    it('migrates API key from sync to local storage', async () => {
      vi.mocked(chrome.storage.sync.get).mockResolvedValue({
        settings: { obsidianApiKey: 'old-key', obsidianUrl: 'http://127.0.0.1:27123' },
      });
      vi.mocked(chrome.storage.local.get).mockResolvedValue({
        secureSettings: { obsidianApiKey: 'old-key' },
      });

      await migrateSettings();

      expect(chrome.storage.local.set).toHaveBeenCalledWith({
        secureSettings: { obsidianApiKey: 'old-key' },
      });
    });

    it('removes API key from sync after successful migration', async () => {
      vi.mocked(chrome.storage.sync.get).mockResolvedValue({
        settings: { obsidianApiKey: 'old-key', obsidianUrl: 'http://127.0.0.1:27123' },
      });
      vi.mocked(chrome.storage.local.get).mockResolvedValue({
        secureSettings: { obsidianApiKey: 'old-key' },
      });

      await migrateSettings();

      expect(chrome.storage.sync.set).toHaveBeenCalledWith({
        settings: { obsidianUrl: 'http://127.0.0.1:27123' },
      });
    });

    it('does nothing if no API key in sync storage', async () => {
      vi.mocked(chrome.storage.sync.get).mockResolvedValue({
        settings: { obsidianUrl: 'http://127.0.0.1:27123' },
      });

      await migrateSettings();

      expect(chrome.storage.local.set).not.toHaveBeenCalled();
    });

    it('does not throw on migration failure', async () => {
      vi.mocked(chrome.storage.sync.get).mockResolvedValue({
        settings: { obsidianApiKey: 'old-key' },
      });
      vi.mocked(chrome.storage.local.set).mockRejectedValue(new Error('Write failed'));

      // Should not throw
      await expect(migrateSettings()).resolves.toBeUndefined();
    });

    it('does not remove from sync if verification fails', async () => {
      vi.mocked(chrome.storage.sync.get).mockResolvedValue({
        settings: { obsidianApiKey: 'old-key' },
      });
      vi.mocked(chrome.storage.local.set).mockResolvedValue(undefined);
      vi.mocked(chrome.storage.local.get).mockResolvedValue({
        secureSettings: { obsidianApiKey: 'different-key' },
      });

      await migrateSettings();

      // Should not remove from sync if verification fails
      expect(chrome.storage.sync.set).not.toHaveBeenCalled();
    });
  });
});
