import { createCloudMiddleware } from './http.ts';
import { LibraryService } from './library/service.ts';
import { createLibraryHandler } from './library/http.ts';
import type { IncomingMessage } from 'node:http';
import type { RemoteSessionBinding } from './http.ts';
import type { LibraryOptions } from './library/service.ts';
import type { PersistenceStore } from './session-memory.ts';

export function createApplication(options: { library?: LibraryOptions; store?: PersistenceStore; authorizeRemote?: (req: IncomingMessage) => RemoteSessionBinding | undefined } = {}) {
  const library = new LibraryService(options.library);
  const middleware = createCloudMiddleware(undefined, Date.now, {
    authorizeRemote: options.authorizeRemote,
    store: options.store,
    library: createLibraryHandler(library),
    // Unavailable audio storage must not prevent account logout or device use.
    onAccountGranted: async account => { await library.grantAccount(account).catch(() => {}); },
    onAccountRevoked: async account => { await library.revokeAccount(account).catch(() => {}); },
  });
  return { middleware, library, close: () => library.close() };
}
