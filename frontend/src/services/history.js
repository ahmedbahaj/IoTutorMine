/**
 * Personal extraction history.
 *
 * Stored in this browser's localStorage only. It is NOT synchronised between
 * devices or browsers, and clearing site data removes it. The shared library
 * (All Extractions) is the cross-device surface.
 *
 * Deliberately never stored: raw transcripts, API keys, or any credential.
 *
 * All storage access is wrapped: a disabled, full, or corrupted store degrades
 * to an in-memory session rather than throwing into the UI.
 */

export const STORAGE_KEY = 'iotutormine.extractions.v1';
export const MAX_ENTRIES = 100;

/** An in-memory stand-in used when localStorage is unavailable (private mode, blocked cookies). */
export function createMemoryStorage() {
  const map = new Map();
  return {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: k => map.delete(k)
  };
}

export function resolveStorage() {
  try {
    const probe = '__iotutormine_probe__';
    globalThis.localStorage.setItem(probe, '1');
    globalThis.localStorage.removeItem(probe);
    return globalThis.localStorage;
  } catch {
    return createMemoryStorage();
  }
}

function randomId() {
  try {
    return globalThis.crypto.randomUUID();
  } catch {
    return `x-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

function sanitiseComponents(components) {
  if (!Array.isArray(components)) return [];

  return components
    .filter(c => c && typeof c === 'object' && typeof c.name === 'string' && c.name.trim())
    .map(c => {
      const status = c.status === 'ALTERNATIVE' ? 'ALTERNATIVE' : 'USED';
      const entry = { name: c.name.trim(), status };
      if (status === 'ALTERNATIVE' && typeof c.alternativeTo === 'string' && c.alternativeTo.trim()) {
        entry.alternativeTo = c.alternativeTo.trim();
      }
      return entry;
    });
}

/** Normalise an API result into the stored record shape. Drops anything else. */
export function toRecord(result, { originalUrl = '' } = {}) {
  const components = sanitiseComponents(result?.components);

  return {
    id: randomId(),
    videoId: typeof result?.videoId === 'string' ? result.videoId : null,
    originalUrl: typeof originalUrl === 'string' ? originalUrl.slice(0, 2048) : '',
    canonicalUrl: typeof result?.canonicalUrl === 'string' ? result.canonicalUrl : null,
    title: typeof result?.title === 'string' ? result.title : null,
    channel: typeof result?.channel === 'string' ? result.channel : null,
    durationSeconds: Number.isFinite(result?.durationSeconds) ? result.durationSeconds : null,
    thumbnail: typeof result?.thumbnail === 'string' ? result.thumbnail : null,
    components,
    componentCount: components.length,
    source: result?.source === 'manual-transcript' ? 'manual-transcript' : 'youtube-url',
    model: typeof result?.model === 'string' ? result.model : null,
    specVersion: typeof result?.specVersion === 'string' ? result.specVersion : null,
    sharedId: typeof result?.sharedId === 'string' ? result.sharedId : null,
    published: result?.published === true,
    extractedAt: typeof result?.extractedAt === 'string' ? result.extractedAt : new Date().toISOString(),
    savedAt: new Date().toISOString()
  };
}

function isUsableRecord(entry) {
  return (
    entry &&
    typeof entry === 'object' &&
    typeof entry.id === 'string' &&
    Array.isArray(entry.components)
  );
}

export function createHistory(storage = resolveStorage()) {
  function readAll() {
    let raw;
    try {
      raw = storage.getItem(STORAGE_KEY);
    } catch {
      return [];
    }
    if (!raw) return [];

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Corrupted payload: discard it rather than breaking every page.
      try {
        storage.removeItem(STORAGE_KEY);
      } catch { /* ignore */ }
      return [];
    }

    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isUsableRecord);
  }

  function writeAll(entries) {
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES)));
      return true;
    } catch {
      // Quota exceeded or storage disabled: try once with a trimmed list.
      try {
        storage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(0, 20)));
        return true;
      } catch {
        return false;
      }
    }
  }

  return {
    /** Newest first. */
    list() {
      return readAll().sort((a, b) => String(b.savedAt || '').localeCompare(String(a.savedAt || '')));
    },

    get(id) {
      return readAll().find(e => e.id === id) || null;
    },

    /** Most recent local result for a canonical video id, for the client-side cache check. */
    findByVideoId(videoId) {
      if (!videoId) return null;
      return this.list().find(e => e.videoId === videoId) || null;
    },

    /**
     * Save a result. One entry per (videoId, specVersion) so re-running the
     * same video replaces its entry instead of piling up duplicates. Manual
     * transcript results have no reliable identity and are always appended.
     */
    save(result, options = {}) {
      const record = toRecord(result, options);
      const entries = readAll();

      const existingIndex =
        record.videoId && record.source === 'youtube-url'
          ? entries.findIndex(
              e => e.videoId === record.videoId && e.specVersion === record.specVersion
            )
          : -1;

      if (existingIndex >= 0) {
        record.id = entries[existingIndex].id;
        entries[existingIndex] = record;
      } else {
        entries.unshift(record);
      }

      writeAll(entries);
      return record;
    },

    remove(id) {
      const entries = readAll().filter(e => e.id !== id);
      writeAll(entries);
      return entries;
    },

    clear() {
      try {
        storage.removeItem(STORAGE_KEY);
      } catch { /* ignore */ }
    }
  };
}

/** Default instance bound to this browser's storage. */
export const history = createHistory();
